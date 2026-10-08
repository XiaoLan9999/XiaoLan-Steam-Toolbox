import { randomUUID } from 'node:crypto'
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

interface RuntimeSession {
  accountId: string
  loginSession: LoginSession
  community: SteamCommunityClient
}

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
  private readonly friendSyncs = new Map<
    string,
    { community: SteamCommunityClient; promise: Promise<number> }
  >()

  constructor(
    private readonly store: SqliteStore,
    private readonly emit: Emit,
    private readonly onSessionExpired: (accountId: string) => void
  ) {}

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
    const account = this.store.getAccount(accountId)
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在')
    if (this.runtime?.accountId === accountId) return

    this.runtime = null
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
      const community = this.createCommunity(accountId, cookies)
      this.runtime = { accountId, loginSession: session, community }
      const profile = await this.tryGetProfile(community, accountId)
      this.store.updateAccountProfile(accountId, {
        accountName: account.accountName,
        displayName: profile?.displayName ?? account.displayName,
        avatarUrl: profile?.avatarUrl ?? account.avatarUrl
      })
      this.setStatus(accountId, 'authenticated', '已自动登录')
      void this.refreshStaleAccountData(accountId)
    } catch (error) {
      this.runtime = null
      this.setStatus(accountId, 'expired', '自动登录失败，请重新登录')
      this.emit({ type: 'notice', level: 'warning', message: publicErrorMessage(error) })
    }
  }

  async startQrLogin(): Promise<AuthStartResult> {
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
      this.pendingLogins.delete(loginId)
      throw error
    }
  }

  async startCredentialsLogin(accountName: string, password: string): Promise<AuthStartResult> {
    const normalizedName = accountName.trim()
    if (!normalizedName || !password) {
      throw new DomainError('MISSING_CREDENTIALS', '请输入 Steam 登录名和密码')
    }
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
      this.pendingLogins.delete(loginId)
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
    session.cancelLoginAttempt()
    this.pendingLogins.delete(loginId)
  }

  removeAccount(accountId: string): void {
    if (this.runtime?.accountId === accountId) this.runtime = null
    this.statuses.delete(accountId)
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
    this.store.replaceEmoticons(accountId, emoticons)
    this.emit({ type: 'snapshotChanged' })
    return emoticons.length
  }

  async postProfileComment(
    accountId: string,
    friendSteamId: string,
    message: string
  ): Promise<{ commentId: string | null }> {
    const community = this.requireActiveCommunity(accountId)
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

  isAuthenticated(accountId: string): boolean {
    return this.runtime?.accountId === accountId
  }

  private createLoginSession(): LoginSession {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser)
    session.loginTimeout = 5 * 60 * 1000
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
    try {
      const accountId = session.steamID.getSteamID64()
      const cookies = await session.getWebCookies()
      const community = this.createCommunity(accountId, cookies)
      const existing = this.store.getAccount(accountId)
      const profile = await this.tryGetProfile(community, accountId)
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
      this.runtime = { accountId, loginSession: session, community }
      for (const knownAccount of this.store.getAccounts()) {
        this.setStatus(knownAccount.id, knownAccount.id === accountId ? 'authenticated' : 'offline', null, false)
      }
      this.pendingLogins.delete(loginId)
      this.emit({ type: 'authFinished', loginId, accountId })
      this.emit({ type: 'snapshotChanged' })
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
    }
  }

  private failPendingLogin(loginId: string, message: string): void {
    if (!this.pendingLogins.has(loginId)) return
    this.pendingLogins.delete(loginId)
    this.completingLogins.delete(loginId)
    this.emit({ type: 'authFailed', loginId, message })
  }

  private createCommunity(accountId: string, cookies: string[]): SteamCommunityClient {
    const community = new SteamCommunityClient(accountId, cookies, () => {
      if (this.runtime?.community !== community) return
      this.runtime = null
      this.setStatus(accountId, 'expired', 'Steam 会话已过期，请重新登录')
      this.onSessionExpired(accountId)
    })
    return community
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
    steamId: string
  ): Promise<ProfileSummary | null> {
    try {
      return await community.getProfileSummary(steamId)
    } catch {
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
    const account = this.store.getAccount(accountId)
    if (!account || !this.isAuthenticated(accountId)) return
    const staleBefore = Date.now() - 6 * 60 * 60 * 1000
    const friendsStale =
      force || !account.lastFriendSyncAt || Date.parse(account.lastFriendSyncAt) < staleBefore
    const emoticonsStale =
      force || !account.lastEmoticonSyncAt || Date.parse(account.lastEmoticonSyncAt) < staleBefore
    if (friendsStale) {
      try {
        await this.syncFriends(accountId)
      } catch (error) {
        this.emit({ type: 'notice', level: 'warning', message: `好友同步失败：${publicErrorMessage(error)}` })
      }
    }
    if (emoticonsStale && this.isAuthenticated(accountId)) {
      try {
        await this.syncEmoticons(accountId)
      } catch (error) {
        this.emit({ type: 'notice', level: 'warning', message: `表情同步失败：${publicErrorMessage(error)}` })
      }
    }
  }
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
