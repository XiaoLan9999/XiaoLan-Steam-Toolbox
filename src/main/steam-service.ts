import { randomUUID } from 'node:crypto'
import { Agent } from 'node:https'
import type { ClientRequest, RequestOptions } from 'node:http'
import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  ESessionPersistence,
  LoginSession
} from 'steam-session'
import { DomainError } from '../shared/domain'
import {
  AccountRecord,
  AccountView,
  AppEvent,
  AuthStartResult,
  CommentCheckResult,
  FriendRecord,
  GuardType,
  SessionState
} from '../shared/types'
import { SqliteStore } from './store'
import { SteamCommunityClient } from './community-client'
import type { CommunityDiagnosticEvent } from './community-client'
import type { ProfileBackgroundCatalog } from '../shared/profile-backgrounds'

interface RuntimeSession {
  accountId: string
  loginSession: LoginSession
  community: SteamCommunityClient
  cookies: string[]
  refreshAt: number
  refreshFailures: number
  refresh: Promise<string[]> | null
  recovering: boolean
}

export interface SteamServiceOptions {
  keepAliveMs?: number
  retryDelaysMs?: readonly number[]
  now?: () => number
  onDiagnostic?: (event: CommunityDiagnosticEvent | {
    phase: 'restore' | 'refresh' | 'recover'
    outcome: 'success' | 'transient' | 'expired'
    reason: string
  }) => void
}

const KEEP_ALIVE_MS = 10 * 60 * 1000
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000]
const LOGIN_REQUEST_TIMEOUT_MS = 30_000

interface SessionStatus {
  state: SessionState
  message: string | null
}

interface ProfileSummary {
  steamId: string
  displayName: string
  avatarUrl: string
  onlineState: FriendRecord['onlineState']
}

type Emit = (event: AppEvent) => void

export class SteamService {
  private runtime: RuntimeSession | null = null
  private readonly pendingLogins = new Map<string, LoginSession>()
  private readonly completingLogins = new Set<string>()
  private readonly statuses = new Map<string, SessionStatus>()
  private generation = 0
  private disposed = false
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly loginAgents = new Map<LoginSession, Agent>()
  private readonly restorationFailures = new Map<string, number>()
  private readonly friendSyncs = new Map<
    string,
    { community: SteamCommunityClient; promise: Promise<number> }
  >()

  constructor(
    private readonly store: SqliteStore,
    private readonly emit: Emit,
    private readonly onSessionExpired: (accountId: string) => void,
    private readonly options: SteamServiceOptions = {}
  ) {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.clearKeepAliveTimer()
    this.runtime = null
    for (const loginId of [...this.pendingLogins.keys()]) this.cancelLogin(loginId)
    for (const [session, agent] of this.loginAgents) {
      session.cancelLoginAttempt?.()
      agent.destroy()
    }
    this.loginAgents.clear()
    this.restorationFailures.clear()
  }

  getAccountViews(): AccountView[] {
    const activeAccountId = this.store.getActiveAccountId()
    return this.store.getAccounts().map((account) => {
      const status = this.statuses.get(account.id) ?? {
        state: account.id === activeAccountId ? 'offline' : 'offline',
        message: null
      }
      return { ...account, sessionState: status.state, sessionMessage: status.message }
    })
  }

  async restoreActiveAccount(): Promise<void> {
    const accountId = this.store.getActiveAccountId()
    if (!accountId) return
    await this.activateAccount(accountId, false)
  }

  async activateAccount(accountId: string, persistSelection = true): Promise<void> {
    this.requireOpen()
    const account = this.store.getAccount(accountId)
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在')
    if (this.runtime?.accountId === accountId) {
      if (this.runtime.recovering) await this.refreshWebSession(this.runtime)
      return
    }

    const generation = this.beginSessionTransition()
    for (const knownAccount of this.store.getAccounts()) {
      this.setStatus(knownAccount.id, 'offline', null, false)
    }
    if (persistSelection) this.store.setActiveAccountId(accountId)
    this.setStatus(accountId, 'restoring', '正在恢复 Steam 会话')

    let refreshToken: string | null
    try {
      refreshToken = this.store.getRefreshToken(accountId)
    } catch (error) {
      this.setStatus(accountId, 'error', publicErrorMessage(error))
      throw error
    }
    if (!refreshToken) {
      this.setStatus(accountId, 'expired', '没有可用的自动登录令牌，请重新登录')
      return
    }

    const session = this.createLoginSession()
    try {
      session.refreshToken = refreshToken
      const cookies = await session.getWebCookies()
      if (!this.isCurrentTransition(generation, accountId)) return
      const community = this.createCommunity(accountId, cookies)
      await community.verifySession()
      if (!this.isCurrentTransition(generation, accountId)) return
      this.persistChangedToken(accountId, session)
      this.restorationFailures.delete(accountId)
      const runtime = this.makeRuntime(accountId, session, community, community.getCookies())
      this.runtime = runtime
      const profile = await this.tryGetProfile(community, accountId)
      if (this.runtime !== runtime || !this.isCurrentTransition(generation, accountId)) return
      this.store.updateAccountProfile(accountId, {
        accountName: account.accountName,
        displayName: profile?.displayName ?? account.displayName,
        avatarUrl: profile?.avatarUrl ?? account.avatarUrl
      })
      if (!runtime.recovering) {
        this.setStatus(accountId, 'authenticated', '已自动登录')
        this.diagnostic('restore', 'success', 'verified')
        this.scheduleKeepAlive(runtime)
      }
      void this.refreshStaleAccountData(accountId)
    } catch (error) {
      if (!this.isCurrentTransition(generation, accountId)) return
      this.runtime = null
      if (isDefinitiveAuthenticationError(error)) {
        this.setStatus(accountId, 'expired', '自动登录令牌已失效，请重新登录')
        this.diagnostic('restore', 'expired', 'credentials_rejected')
      } else {
        this.setStatus(accountId, 'error', 'Steam 自动登录暂时失败，将稍后重试；无需反复扫码')
        const failures = this.restorationFailures.get(accountId) ?? 0
        this.restorationFailures.set(accountId, failures + 1)
        this.keepAliveTimer = setTimeout(() => {
          this.keepAliveTimer = null
          if (this.isCurrentTransition(generation, accountId)) void this.activateAccount(accountId, false)
        }, this.retryDelay(failures))
        this.keepAliveTimer.unref?.()
        this.diagnostic('restore', 'transient', error instanceof DomainError ? safeDiagnosticReason(error.code) : 'network_or_service')
      }
      this.emit({ type: 'notice', level: 'warning', message: publicErrorMessage(error) })
    } finally {
      if (this.runtime?.loginSession !== session) this.releaseLoginSession(session)
    }
  }

  async startQrLogin(): Promise<AuthStartResult> {
    this.requireOpen()
    this.prepareManualLogin()
    const loginId = randomUUID()
    const session = this.createLoginSession()
    this.attachPendingLogin(loginId, session)
    try {
      const response = await session.startWithQR()
      if (!response.qrChallengeUrl) {
        throw new DomainError('QR_UNAVAILABLE', 'Steam 未返回二维码登录地址')
      }
      return {
        loginId,
        mode: 'qr',
        qrChallengeUrl: response.qrChallengeUrl,
        actionRequired: true,
        guardTypes: mapGuardTypes(response.validActions?.map((item) => item.type) ?? [])
      }
    } catch (error) {
      this.cancelLogin(loginId)
      throw error
    }
  }

  async startCredentialsLogin(accountName: string, password: string): Promise<AuthStartResult> {
    this.requireOpen()
    const normalizedName = accountName.trim()
    if (!normalizedName || !password) {
      throw new DomainError('MISSING_CREDENTIALS', '请输入 Steam 登录名和密码')
    }
    this.prepareManualLogin()
    const loginId = randomUUID()
    const session = this.createLoginSession()
    this.attachPendingLogin(loginId, session)
    try {
      const response = await session.startWithCredentials({
        accountName: normalizedName,
        password,
        persistence: ESessionPersistence.Persistent
      })
      const actions = response.validActions ?? []
      return {
        loginId,
        mode: 'credentials',
        actionRequired: response.actionRequired,
        guardTypes: mapGuardTypes(actions.map((item) => item.type)),
        guardDetail: actions.find((item) => item.detail)?.detail
      }
    } catch (error) {
      this.cancelLogin(loginId)
      throw error
    }
  }

  async submitSteamGuard(loginId: string, code: string): Promise<void> {
    const session = this.pendingLogins.get(loginId)
    if (!session) throw new DomainError('LOGIN_NOT_FOUND', '登录请求已失效，请重新开始')
    const normalizedCode = code.trim()
    if (!normalizedCode) throw new DomainError('EMPTY_GUARD_CODE', '请输入 Steam Guard 验证码')
    await session.submitSteamGuardCode(normalizedCode)
  }

  cancelLogin(loginId: string): void {
    const session = this.pendingLogins.get(loginId)
    if (!session) return
    this.pendingLogins.delete(loginId)
    this.releaseLoginSession(session)
  }

  removeAccount(accountId: string): void {
    if (this.runtime?.accountId === accountId || this.store.getActiveAccountId() === accountId) {
      this.beginSessionTransition()
    } else this.cancelPendingLogins()
    this.statuses.delete(accountId)
    this.restorationFailures.delete(accountId)
    this.store.deleteAccount(accountId)
    this.emit({ type: 'snapshotChanged' })
  }

  async syncFriends(accountId: string): Promise<number> {
    const community = this.requireActiveCommunity(accountId)
    const existing = this.friendSyncs.get(accountId)
    if (existing?.community === community) return existing.promise

    const promise = this.performFriendSync(accountId, community).finally(() => {
      if (this.friendSyncs.get(accountId)?.promise === promise) {
        this.friendSyncs.delete(accountId)
      }
    })
    this.friendSyncs.set(accountId, { community, promise })
    return promise
  }

  private async performFriendSync(
    accountId: string,
    community: SteamCommunityClient
  ): Promise<number> {
    const relationships = await community.getFriendRelationships()
    this.requireCurrentSyncSession(accountId, community)
    const friendIds = Object.entries(relationships)
      .filter(([, relationship]) => relationship === 3)
      .map(([steamId]) => steamId)
    const cached = new Map(this.store.getFriends(accountId).map((friend) => [friend.steamId, friend]))
    const { profiles: resolvedProfiles, error } = await community.getProfileSummaries(friendIds)
    this.requireCurrentSyncSession(accountId, community)
    if (error instanceof DomainError && error.code === 'SESSION_EXPIRED') throw error
    const profileFailures = friendIds.filter((steamId) => !resolvedProfiles.has(steamId)).length
    const summaries = friendIds.map((steamId) => {
      const profile = resolvedProfiles.get(steamId)
      if (profile) return profile
      const previous = cached.get(steamId)
      return {
        steamId,
        displayName: previous?.displayName ?? steamId,
        avatarUrl: previous?.avatarUrl ?? '',
        onlineState: previous?.onlineState ?? 'unknown'
      } satisfies ProfileSummary
    })

    const syncedAt = new Date().toISOString()
    this.store.replaceFriends(
      accountId,
      summaries.map((profile) => ({
        accountId,
        steamId: profile.steamId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: `https://steamcommunity.com/profiles/${profile.steamId}`,
        onlineState: profile.onlineState,
        syncedAt
      })),
      { verifiedNameIds: new Set(friendIds.filter((steamId) => resolvedProfiles.has(steamId))) }
    )
    this.emit({ type: 'snapshotChanged' })
    if (profileFailures > 0) {
      this.emit({
        type: 'notice',
        level: 'warning',
        message:
          `好友列表已更新（${friendIds.length} 位），但 ${profileFailures} 位资料暂未刷新，` +
          `已保留缓存或 SteamID。原因：${error ? publicErrorMessage(error) : 'Steam 未返回完整好友资料'}`
      })
    } else {
      this.emit({
        type: 'notice',
        level: 'success',
        message: `已同步 ${friendIds.length} 位好友及资料`
      })
    }
    return friendIds.length
  }

  private requireCurrentSyncSession(accountId: string, community: SteamCommunityClient): void {
    if (
      this.runtime?.community !== community ||
      this.runtime.accountId !== accountId ||
      this.store.getActiveAccountId() !== accountId ||
      !this.store.getAccount(accountId)
    ) {
      throw new DomainError('SYNC_CANCELLED', '账号或登录会话已变更，本次好友同步已取消')
    }
  }

  async syncEmoticons(accountId: string): Promise<number> {
    const community = this.requireActiveCommunity(accountId)
    const emoticons = await community.getEmoticons()
    this.requireCurrentSyncSession(accountId, community)
    this.store.replaceEmoticons(accountId, emoticons)
    this.emit({ type: 'snapshotChanged' })
    return emoticons.length
  }

  async postProfileComment(
    accountId: string,
    friendSteamId: string,
    message: string
  ): Promise<{ commentId: string | null }> {
    let community = this.requireActiveCommunity(accountId)
    if (!this.store.hasActiveFriend(accountId, friendSteamId)) {
      throw new DomainError('FRIEND_NOT_FOUND', '该用户不在当前账号已同步的好友列表中')
    }
    if (this.store.isBlacklisted(accountId, friendSteamId)) {
      throw new DomainError('FRIEND_BLACKLISTED', '该好友在当前账号黑名单中，已阻止留言')
    }
    try {
      await this.ensureSessionFresh(accountId)
      community = this.requireActiveCommunity(accountId)
    } catch (error) {
      throw new DomainError('SESSION_PREPARATION_FAILED',
        `Steam 会话准备失败，尚未提交留言。原因：${publicErrorMessage(error)}`,
        true, error instanceof DomainError ? error.retryAfterMs : undefined)
    }
    if (!this.store.hasActiveFriend(accountId, friendSteamId)) {
      throw new DomainError('FRIEND_NOT_FOUND', '该用户不在当前账号已同步的好友列表中')
    }
    if (this.store.isBlacklisted(accountId, friendSteamId)) {
      throw new DomainError('FRIEND_BLACKLISTED', '该好友在当前账号黑名单中，已阻止留言')
    }
    return community.postProfileComment(friendSteamId, message)
  }

  async checkCommentEligibility(accountId: string, steamId: string): Promise<CommentCheckResult> {
    const community = this.requireActiveCommunity(accountId)
    if (!this.store.getFriend(accountId, steamId)) {
      throw new DomainError('FRIEND_NOT_FOUND', '该用户不在当前账号已同步的好友列表中')
    }
    const result = await community.checkCommentEligibility(steamId)
    if (
      this.runtime?.community !== community ||
      this.runtime.accountId !== accountId ||
      this.store.getActiveAccountId() !== accountId ||
      !this.store.getAccount(accountId) ||
      !this.store.getFriend(accountId, steamId)
    ) {
      throw new DomainError('CHECK_CANCELLED', '账号、会话或好友关系已变更，本次检查结果已取消')
    }
    return result
  }

  async verifyCommentSession(accountId: string): Promise<void> {
    const community = this.requireActiveCommunity(accountId)
    await community.verifySession()
    if (this.runtime?.community !== community || this.store.getActiveAccountId() !== accountId
      || !this.isAuthenticated(accountId)) {
      throw new DomainError('SESSION_CHANGED', '账号或会话已变更，本次留言恢复核验已取消')
    }
  }

  isAuthenticated(accountId: string): boolean {
    return !this.disposed && this.runtime?.accountId === accountId && !this.runtime.recovering
  }

  async ensureSessionFresh(accountId: string): Promise<void> {
    this.requireOpen()
    this.requireActiveCommunity(accountId)
    const runtime = this.runtime!
    if (runtime.refresh) {
      await runtime.refresh
    } else if (runtime.recovering || (Number.isFinite(runtime.refreshAt) && this.now() >= runtime.refreshAt)) {
      await this.refreshWebSession(runtime)
    }
    if (this.runtime !== runtime || !this.isAuthenticated(accountId)) {
      throw new DomainError('SESSION_PREPARATION_FAILED', 'Steam 会话准备失败，尚未发送留言；任务已暂停，请稍后继续')
    }
  }

  async getArtworkWebCookies(accountId: string): Promise<string[]> {
    this.requireActiveCommunity(accountId)
    const runtime = this.runtime!
    let cookies: string[]
    try {
      cookies = await this.refreshWebSession(runtime)
    } catch {
      if (this.runtime !== runtime || this.store.getActiveAccountId() !== accountId) {
        throw new DomainError('ARTWORK_SESSION_CHANGED', '账号或登录会话已变更，请重新打开艺术作品工具')
      }
      throw new DomainError('ARTWORK_AUTH_FAILED', '无法准备 Steam 艺术作品会话，请确认网络后重新登录')
    }
    if (this.runtime !== runtime || this.store.getActiveAccountId() !== accountId) {
      throw new DomainError('ARTWORK_SESSION_CHANGED', '账号或登录会话已变更，请重新打开艺术作品工具')
    }
    return [...cookies]
  }

  async getProfileBackgrounds(accountId: string, permitted: () => boolean = () => true): Promise<ProfileBackgroundCatalog> {
    const community = this.requireActiveCommunity(accountId)
    const runtime = this.runtime!
    const current = (): boolean => permitted() && this.runtime === runtime && this.store.getActiveAccountId() === accountId
    if (!current()) throw new DomainError('ARTWORK_SESSION_CHANGED', '账号或登录会话已变更，请重新打开艺术作品工具')
    const catalog = await community.getProfileBackgrounds(current)
    if (!current()) throw new DomainError('ARTWORK_SESSION_CHANGED', '账号或登录会话已变更，请重新打开艺术作品工具')
    return catalog
  }

  private createLoginSession(): LoginSession {
    const agent = new BoundedLoginAgent(LOGIN_REQUEST_TIMEOUT_MS)
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, { agent })
    session.loginTimeout = 5 * 60 * 1000
    this.loginAgents.set(session, agent)
    return session
  }

  private attachPendingLogin(loginId: string, session: LoginSession): void {
    this.pendingLogins.set(loginId, session)
    session.on('authenticated', () => {
      void this.finishPendingLogin(loginId, session)
    })
    session.on('remoteInteraction', () => {
      this.emit({ type: 'authRemoteInteraction', loginId })
    })
    session.on('timeout', () => {
      this.failPendingLogin(loginId, 'Steam 登录确认超时，请重新生成二维码')
    })
    session.on('error', (error: Error) => {
      this.failPendingLogin(loginId, publicErrorMessage(error))
    })
  }

  private async finishPendingLogin(loginId: string, session: LoginSession): Promise<void> {
    if (!this.pendingLogins.has(loginId) || this.completingLogins.has(loginId)) return
    this.completingLogins.add(loginId)
    const generation = this.generation
    const current = (): boolean => !this.disposed && this.generation === generation && this.pendingLogins.get(loginId) === session
    try {
      const accountId = session.steamID.getSteamID64()
      const cookies = await session.getWebCookies()
      if (!current()) return
      const community = this.createCommunity(accountId, cookies)
      await community.verifySession()
      if (!current()) return
      const existing = this.store.getAccount(accountId)
      const profile = await this.tryGetProfile(community, accountId, true)
      if (!current()) return
      const timestamp = new Date().toISOString()
      const account: AccountRecord = {
        id: accountId,
        steamId: accountId,
        accountName: session.accountName || existing?.accountName || accountId,
        displayName: profile?.displayName || existing?.displayName || session.accountName || accountId,
        avatarUrl: profile?.avatarUrl || existing?.avatarUrl || '',
        createdAt: existing?.createdAt ?? timestamp,
        lastLoginAt: timestamp,
        lastFriendSyncAt: existing?.lastFriendSyncAt ?? null,
        lastEmoticonSyncAt: existing?.lastEmoticonSyncAt ?? null
      }
      const canPersist = this.store.getSecretStorageInfo().available
      this.store.upsertAccount(account, canPersist ? session.refreshToken : undefined)
      this.restorationFailures.delete(accountId)
      this.clearKeepAliveTimer()
      if (this.runtime?.loginSession !== session && this.runtime) this.releaseLoginSession(this.runtime.loginSession)
      this.generation += 1
      this.runtime = this.makeRuntime(accountId, session, community, community.getCookies())
      for (const knownAccount of this.store.getAccounts()) {
        this.setStatus(knownAccount.id, knownAccount.id === accountId ? 'authenticated' : 'offline', null, false)
      }
      this.pendingLogins.delete(loginId)
      this.emit({ type: 'authFinished', loginId, accountId })
      this.emit({ type: 'snapshotChanged' })
      this.scheduleKeepAlive(this.runtime)
      if (!canPersist) {
        this.emit({
          type: 'notice',
          level: 'warning',
          message: 'Windows 安全存储不可用，本次会话不会自动登录'
        })
      }
      void this.refreshStaleAccountData(accountId, true)
    } catch (error) {
      this.failPendingLogin(loginId, publicErrorMessage(error))
    } finally {
      this.completingLogins.delete(loginId)
      if (this.runtime?.loginSession !== session) this.releaseLoginSession(session)
    }
  }

  private failPendingLogin(loginId: string, message: string): void {
    const session = this.pendingLogins.get(loginId)
    if (!session) return
    this.pendingLogins.delete(loginId)
    this.completingLogins.delete(loginId)
    this.releaseLoginSession(session)
    this.emit({ type: 'authFailed', loginId, message })
  }

  private createCommunity(accountId: string, cookies: string[]): SteamCommunityClient {
    const community = new SteamCommunityClient(accountId, cookies, () => {
      if (this.runtime?.community !== community) return
      const runtime = this.runtime
      if (!runtime.recovering) {
        runtime.recovering = true
        this.setStatus(accountId, 'restoring', 'Steam 网页会话已失效，正在自动恢复；任务保持暂停')
        this.onSessionExpired(accountId)
      }
      void this.refreshWebSession(runtime).catch(() => undefined)
    }, event => this.options.onDiagnostic?.(event))
    return community
  }

  private makeRuntime(accountId: string, loginSession: LoginSession, community: SteamCommunityClient, cookies: string[]): RuntimeSession {
    return { accountId, loginSession, community, cookies: [...cookies], refreshAt: this.now() + this.keepAliveMs(),
      refreshFailures: 0, refresh: null, recovering: false }
  }

  private refreshWebSession(runtime: RuntimeSession): Promise<string[]> {
    if (runtime.refresh) return runtime.refresh
    if (!this.isCurrentRuntime(runtime)) {
      return Promise.reject(new DomainError('SESSION_CHANGED', 'Steam 账号或会话已变更'))
    }
    this.clearKeepAliveTimer()
    const phase = runtime.recovering ? 'recover' : 'refresh'
    let request: Promise<string[]>
    try {
      request = runtime.loginSession.getWebCookies()
    } catch (error) {
      request = Promise.reject(error)
    }
    let operation!: Promise<string[]>
    operation = (async (): Promise<string[]> => {
      try {
        // WebBrowser tokens must use finalizelogin; refreshAccessToken is not supported for this platform.
        const cookies = await request
        if (!this.isCurrentRuntime(runtime)) throw new DomainError('SESSION_CHANGED', 'Steam 账号或会话已变更')
        const candidate = this.createCommunity(runtime.accountId, cookies)
        await candidate.verifySession()
        if (!this.isCurrentRuntime(runtime)) throw new DomainError('SESSION_CHANGED', 'Steam 账号或会话已变更')
        this.persistChangedToken(runtime.accountId, runtime.loginSession)
        const verifiedCookies = candidate.getCookies()
        runtime.community.replaceCookies(verifiedCookies)
        runtime.cookies = [...verifiedCookies]
        runtime.refreshFailures = 0
        runtime.refreshAt = this.now() + this.keepAliveMs()
        const recovered = runtime.recovering
        runtime.recovering = false
        if (recovered) {
          this.setStatus(runtime.accountId, 'authenticated', 'Steam 会话已自动恢复，请查看任务的恢复状态')
          this.emit({ type: 'notice', level: 'success', message: 'Steam 会话已自动恢复，请在任务列表查看继续安排' })
        }
        this.diagnostic(phase, 'success', 'verified')
        return [...verifiedCookies]
      } catch (error) {
        if (!this.isCurrentRuntime(runtime)) throw error
        if (isDefinitiveAuthenticationError(error)) {
          const alreadyPaused = runtime.recovering
          this.runtime = null
          this.releaseLoginSession(runtime.loginSession)
          this.setStatus(runtime.accountId, 'expired', 'Steam 自动登录令牌已失效，请重新登录；原任务保持暂停')
          if (!alreadyPaused) this.onSessionExpired(runtime.accountId)
          this.diagnostic(phase, 'expired', 'credentials_rejected')
        } else {
          if (error instanceof DomainError && error.code === 'SESSION_EXPIRED' && !runtime.recovering) {
            runtime.recovering = true
            this.onSessionExpired(runtime.accountId)
          }
          runtime.refreshAt = this.now() + this.retryDelay(runtime.refreshFailures++)
          if (runtime.recovering) {
            this.setStatus(runtime.accountId, 'restoring', 'Steam 会话恢复暂时失败，将稍后重试；原任务保持暂停')
          }
          this.diagnostic(phase, 'transient', error instanceof DomainError ? safeDiagnosticReason(error.code) : 'network_or_service')
        }
        throw error
      } finally {
        if (runtime.refresh === operation) runtime.refresh = null
        if (this.isCurrentRuntime(runtime)) this.scheduleKeepAlive(runtime)
      }
    })()
    runtime.refresh = operation
    return operation
  }

  private persistChangedToken(accountId: string, session: LoginSession): void {
    if (!session.refreshToken || !this.store.getSecretStorageInfo().available) return
    if (this.store.getRefreshToken(accountId) !== session.refreshToken) {
      this.store.saveRefreshToken(accountId, session.refreshToken)
    }
  }

  private scheduleKeepAlive(runtime: RuntimeSession): void {
    this.clearKeepAliveTimer()
    if (!this.isCurrentRuntime(runtime)) return
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = null
      if (this.isCurrentRuntime(runtime)) void this.refreshWebSession(runtime).catch(() => undefined)
    }, Math.max(1, runtime.refreshAt - this.now()))
    this.keepAliveTimer.unref?.()
  }

  private clearKeepAliveTimer(): void {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  private beginSessionTransition(): number {
    this.generation += 1
    this.clearKeepAliveTimer()
    if (this.runtime) this.releaseLoginSession(this.runtime.loginSession)
    this.runtime = null
    this.cancelPendingLogins()
    for (const session of [...this.loginAgents.keys()]) this.releaseLoginSession(session)
    return this.generation
  }

  private cancelPendingLogins(): void {
    for (const loginId of [...this.pendingLogins.keys()]) this.cancelLogin(loginId)
  }

  private prepareManualLogin(): void {
    this.cancelPendingLogins()
    // A delayed automatic restore must never cancel or overwrite a new manual login.
    if (!this.runtime) {
      this.generation += 1
      this.clearKeepAliveTimer()
      for (const session of [...this.loginAgents.keys()]) this.releaseLoginSession(session)
    }
  }

  private releaseLoginSession(session: LoginSession | undefined): void {
    if (!session) return
    session.cancelLoginAttempt?.()
    this.loginAgents.get(session)?.destroy()
    this.loginAgents.delete(session)
  }

  private isCurrentTransition(generation: number, accountId: string): boolean {
    return !this.disposed && this.generation === generation && this.store.getActiveAccountId() === accountId && !!this.store.getAccount(accountId)
  }

  private isCurrentRuntime(runtime: RuntimeSession): boolean {
    return !this.disposed && this.runtime === runtime && this.store.getActiveAccountId() === runtime.accountId && !!this.store.getAccount(runtime.accountId)
  }

  private requireOpen(): void {
    if (this.disposed) throw new DomainError('STEAM_SERVICE_CLOSED', 'Steam 服务已关闭')
  }

  private now(): number { return (this.options.now ?? Date.now)() }
  private keepAliveMs(): number { return this.options.keepAliveMs ?? KEEP_ALIVE_MS }
  private retryDelay(failures: number): number {
    const delays = this.options.retryDelaysMs?.length ? this.options.retryDelaysMs : RETRY_DELAYS_MS
    return delays[Math.min(failures, delays.length - 1)]!
  }

  private diagnostic(phase: 'restore' | 'refresh' | 'recover', outcome: 'success' | 'transient' | 'expired', reason: string): void {
    this.options.onDiagnostic?.({ phase, outcome, reason })
  }

  private requireActiveCommunity(accountId: string): SteamCommunityClient {
    if (this.store.getActiveAccountId() !== accountId) {
      throw new DomainError('WRONG_ACCOUNT', '请先切换到这个 Steam 账号')
    }
    if (!this.runtime || this.runtime.accountId !== accountId) {
      throw new DomainError('NOT_AUTHENTICATED', '当前 Steam 账号尚未登录')
    }
    return this.runtime.community
  }

  private async tryGetProfile(
    community: SteamCommunityClient,
    steamId: string,
    rejectExpired = false
  ): Promise<ProfileSummary | null> {
    try {
      return await community.getProfileSummary(steamId)
    } catch (error) {
      if (rejectExpired && error instanceof DomainError && error.code === 'SESSION_EXPIRED') throw error
      return null
    }
  }

  private setStatus(
    accountId: string,
    state: SessionState,
    message: string | null,
    notify = true
  ): void {
    this.statuses.set(accountId, { state, message })
    if (notify) this.emit({ type: 'snapshotChanged' })
  }

  private async refreshStaleAccountData(accountId: string, force = false): Promise<void> {
    const runtime = this.runtime
    if (!runtime || !this.isCurrentRuntime(runtime) || !this.isAuthenticated(accountId)) return
    const account = this.store.getAccount(accountId)
    if (!account) return
    const staleBefore = Date.now() - 6 * 60 * 60 * 1000
    const friendsStale =
      force || !account.lastFriendSyncAt || Date.parse(account.lastFriendSyncAt) < staleBefore
    const emoticonsStale =
      force || !account.lastEmoticonSyncAt || Date.parse(account.lastEmoticonSyncAt) < staleBefore
    if (friendsStale) {
      try {
        await this.syncFriends(accountId)
      } catch (error) {
        if (!this.isCurrentRuntime(runtime)) return
        this.emit({ type: 'notice', level: 'warning', message: `好友同步失败：${publicErrorMessage(error)}` })
      }
    }
    if (!this.isCurrentRuntime(runtime)) return
    if (emoticonsStale && this.isAuthenticated(accountId)) {
      try {
        await this.syncEmoticons(accountId)
      } catch (error) {
        if (!this.isCurrentRuntime(runtime)) return
        this.emit({ type: 'notice', level: 'warning', message: `表情同步失败：${publicErrorMessage(error)}` })
      }
    }
  }
}

export class BoundedLoginAgent extends Agent {
  private closed = false
  constructor(private readonly requestTimeoutMs: number) {
    super({ keepAlive: true })
  }

  addRequest(request: ClientRequest, options: RequestOptions): void {
    if (this.closed) {
      queueMicrotask(() => request.destroy(new Error('Steam login request cancelled')))
      return
    }
    const timer = setTimeout(() => request.destroy(new Error('Steam login network request timed out')), this.requestTimeoutMs)
    timer.unref?.()
    request.once('close', () => clearTimeout(timer))
    const parent = Agent.prototype as Agent & { addRequest(request: ClientRequest, options: RequestOptions): void }
    try {
      parent.addRequest.call(this, request, options)
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  override destroy(): void {
    this.closed = true
    super.destroy()
  }
}

function isDefinitiveAuthenticationError(error: unknown): boolean {
  if (error instanceof DomainError) return false
  if (!error || typeof error !== 'object' || !('eresult' in error)) return false
  // AccessDenied alone may be a temporary endpoint denial, not a revoked refresh token.
  return [5, 21, 26, 27, 121, 126].includes(Number(error.eresult))
}

function safeDiagnosticReason(code: string): string {
  return ['RATE_LIMITED', 'COMMUNITY_ACCESS_DENIED', 'SESSION_CHECK_FAILED', 'SESSION_CHANGED'].includes(code)
    ? code.toLowerCase() : 'network_or_service'
}

function mapGuardTypes(types: EAuthSessionGuardType[]): GuardType[] {
  return [...new Set(types.map(mapGuardType))]
}

function mapGuardType(type: EAuthSessionGuardType): GuardType {
  switch (type) {
    case EAuthSessionGuardType.EmailCode:
      return 'emailCode'
    case EAuthSessionGuardType.DeviceCode:
      return 'deviceCode'
    case EAuthSessionGuardType.DeviceConfirmation:
      return 'deviceConfirmation'
    case EAuthSessionGuardType.EmailConfirmation:
      return 'emailConfirmation'
    default:
      return 'unknown'
  }
}

export function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[token]')
    .replace(/steamLoginSecure=[^\s;]+/gi, 'steamLoginSecure=[redacted]')
    .slice(0, 300)
}
