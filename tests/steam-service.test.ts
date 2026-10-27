import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundedLoginAgent, SteamService } from '../src/main/steam-service'
import type { SteamServiceOptions } from '../src/main/steam-service'
import { DomainError } from '../src/shared/domain'
import { EventEmitter } from 'node:events'
import type { ClientRequest, RequestOptions } from 'node:http'
import { Agent } from 'node:https'
import { SecretCipher, SqliteStore } from '../src/main/store'
import { AccountRecord, AppEvent, FriendRecord } from '../src/shared/types'
import { STEAM_WEB_USER_AGENT } from '../src/main/steam-user-agent'

const mocks = vi.hoisted(() => ({
  relationships: vi.fn(),
  summaries: vi.fn(),
  profile: vi.fn(),
  webCookies: vi.fn(),
  backgrounds: vi.fn(),
  gameStatusLogin: vi.fn(),
  verify: vi.fn(),
  replaceCookies: vi.fn(),
  post: vi.fn(),
  reconcile: vi.fn(),
  emoticons: vi.fn(),
  sessionOptions: [] as Array<{ platform: number; options: { userAgent?: string; agent?: Agent } }>,
  sessions: [] as Array<{refreshToken: string; emit: (event: string) => void}>,
  instances: [] as Array<{ accountId: string; expire: () => void }>
}))

vi.mock('steam-session', async () => {
  const { EventEmitter: MockEmitter } = await import('node:events')
  return {
  EAuthSessionGuardType: {},
  EAuthTokenPlatformType: { WebBrowser: 2 },
  ESessionPersistence: { Persistent: 1 },
  LoginSession: class extends MockEmitter {
    constructor(platform: number, options: { userAgent?: string; agent?: Agent }) {
      super()
      mocks.sessions.push(this)
      mocks.sessionOptions.push({ platform, options })
    }
    refreshToken = ''
    loginTimeout = 0
    async getWebCookies(): Promise<string[]> {
      return mocks.webCookies()
    }
    cancelLoginAttempt = vi.fn()
    startWithQR = vi.fn(async () => ({ qrChallengeUrl: 'https://example.invalid/qr' }))
    startWithCredentials = vi.fn(async () => ({ actionRequired: true, validActions: [] }))
    submitSteamGuardCode = vi.fn(async () => undefined)
    steamID = { getSteamID64: () => accountA }
    accountName = 'Fixture account'
  }
  }
})

vi.mock('../src/main/community-client', () => ({
  SteamCommunityClient: class {
    constructor(accountId: string, private cookies: string[], expire: () => void) {
      mocks.instances.push({ accountId, expire })
    }
    getCookies(): string[] { return [...this.cookies] }
    getFriendRelationships = mocks.relationships
    getProfileSummaries = mocks.summaries
    getProfileSummary = mocks.profile
    getProfileBackgrounds = mocks.backgrounds
    getGameStatusLogin = mocks.gameStatusLogin
    verifySession = mocks.verify
    replaceCookies = mocks.replaceCookies
    postProfileComment = mocks.post
    reconcileProfileComment = mocks.reconcile
    getEmoticons = mocks.emoticons
  }
}))

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const friendA = '76561198000000101'
const friendB = '76561198000000102'
const friendC = '76561198000000103'
const fixtures: Array<{ directory: string; store: SqliteStore; service: SteamService }> = []

type Profile = Pick<FriendRecord, 'steamId' | 'displayName' | 'avatarUrl' | 'onlineState'>
type ProfilesResult = { profiles: Map<string, Profile>; error: Error | null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.instances.splice(0)
  mocks.sessions.splice(0)
  mocks.sessionOptions.splice(0)
  mocks.profile.mockResolvedValue(null)
  mocks.webCookies.mockResolvedValue(['sessionid=test-session'])
  mocks.backgrounds.mockResolvedValue({ accountId: accountA, items: [], issues: [], ownedComplete: true, fetchedAt: new Date().toISOString() })
  mocks.relationships.mockResolvedValue({ [friendA]: 3 })
  mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Updated friend')]))
  mocks.verify.mockResolvedValue(undefined)
  mocks.gameStatusLogin.mockResolvedValue({ steamId: accountA, accountName: 'fixture-user', webLogonToken: 'fixture-nonce' })
  mocks.emoticons.mockResolvedValue([])
  mocks.reconcile.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' })
})

afterEach(() => {
  for (const { directory, store, service } of fixtures.splice(0)) {
    service.dispose()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('SteamService web-session lifecycle', () => {
  it('passes the optional durable evidence callback through without changing the original POST API', async () => {
    const { service, store } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendA, 'Synthetic friend')])
    const evidence = { baselineIds: ['1001'], serverWindow: null, submittedAt: new Date().toISOString() }
    const saved = vi.fn()
    mocks.post.mockImplementationOnce(async (_friend, _message, guard, onEvidence) => {
      guard()
      onEvidence(evidence)
      return { commentId: '1002' }
    })
    await expect(service.postProfileComment(accountA, friendA, 'Synthetic text', () => true, saved)).resolves.toEqual({ commentId: '1002' })
    expect(saved).toHaveBeenCalledExactlyOnceWith(evidence)
  })

  it('only invokes the read-only client reconciliation for the current account', async () => {
    const { service } = await createService()
    const evidence = { baselineIds: ['1001'], serverWindow: null, submittedAt: new Date().toISOString() }
    await expect(service.reconcileProfileComment(accountA, friendA, 'Synthetic text', evidence)).resolves.toEqual({ status: 'unresolved', reason: 'no-new-matching-comment' })
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(friendA, 'Synthetic text', evidence, expect.any(Function))
    expect(mocks.post).not.toHaveBeenCalled()
    await expect(service.reconcileProfileComment(accountB, friendA, 'Synthetic text', evidence)).rejects.toThrow()
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })

  it.each(['removed', 'blacklisted'] as const)('allows read-only reconciliation after the recipient was %s', async policy => {
    const { service, store } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendA, 'Synthetic friend')])
    if (policy === 'removed') store.replaceFriends(accountA, [])
    else store.setBlacklist(accountA, [friendA], true)
    await expect(service.reconcileProfileComment(accountA, friendA, 'Synthetic text', null)).resolves.toMatchObject({ status: 'unresolved' })
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('does not even start a read-only check when the caller has cancelled its task', async () => {
    const { service } = await createService()
    await expect(service.reconcileProfileComment(accountA, friendA, 'Synthetic text', null, () => false)).rejects.toMatchObject({ code: 'CHECK_CANCELLED' })
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it.each(['account', 'task', 'shutdown'] as const)('discards a confirmed read-only result after %s changes', async change => {
    const { service } = await createService()
    let current = true
    const pending = deferred<{ status: 'confirmed'; commentId: string; postedAtSeconds: number }>()
    mocks.reconcile.mockReturnValueOnce(pending.promise)
    const verification = service.reconcileProfileComment(accountA, friendA, 'Synthetic text', null, () => current)
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce())
    if (change === 'account') await service.activateAccount(accountB)
    else if (change === 'shutdown') service.dispose()
    else current = false
    pending.resolve({ status: 'confirmed', commentId: '1002', postedAtSeconds: 1_792_281_600 })
    await expect(verification).rejects.toMatchObject({ code: 'CHECK_CANCELLED' })
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('reuses the current verified web login for game status without creating another login session', async () => {
    const { service } = await createService()
    await expect(service.getGameStatusLogin(accountA)).resolves.toMatchObject({ steamId: accountA, webLogonToken: 'fixture-nonce' })
    expect(mocks.gameStatusLogin).toHaveBeenCalledOnce()
    expect(mocks.sessions).toHaveLength(1)
    await expect(service.getGameStatusLogin(accountB)).rejects.toThrow()
  })

  it('discards a game-status credential returned after switching accounts', async () => {
    const { service } = await createService()
    const pending = deferred<{ steamId: string; accountName: string; webLogonToken: string }>()
    mocks.gameStatusLogin.mockReturnValueOnce(pending.promise)
    const login = service.getGameStatusLogin(accountA)
    await vi.waitFor(() => expect(mocks.gameStatusLogin).toHaveBeenCalledOnce())
    await service.activateAccount(accountB)
    pending.resolve({ steamId: accountA, accountName: 'fixture-user', webLogonToken: 'fixture-nonce' })
    await expect(login).rejects.toMatchObject({ code: 'GAME_STATUS_SESSION_CHANGED' })
  })

  it('rejects a reused web credential with a different Steam identity', async () => {
    const { service } = await createService()
    mocks.gameStatusLogin.mockResolvedValueOnce({ steamId: accountB, accountName: 'other', webLogonToken: 'fixture-nonce' })
    await expect(service.getGameStatusLogin(accountA)).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
  })

  it('refreshes expired web cookies once before obtaining a new game-status credential', async () => {
    const { service } = await createService()
    mocks.gameStatusLogin.mockRejectedValueOnce(new DomainError('SESSION_EXPIRED', 'fixture-expired'))
    await expect(service.getGameStatusLogin(accountA)).resolves.toMatchObject({ steamId: accountA })
    expect(mocks.gameStatusLogin).toHaveBeenCalledTimes(2)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    expect(mocks.sessions).toHaveLength(1)
  })

  it.each(['restore', 'qr', 'credentials'] as const)('uses the Community browser identity for %s authentication and cookie renewal', async mode => {
    const { service } = await createService(false)
    if (mode === 'qr') await service.startQrLogin()
    else if (mode === 'credentials') await service.startCredentialsLogin('fixture', 'fixture-only')
    const config = mocks.sessionOptions.at(-1)!
    expect(config.platform).toBe(2)
    expect(config.options).toMatchObject({ userAgent: STEAM_WEB_USER_AGENT, agent: expect.any(BoundedLoginAgent) })
    expect(config.options.userAgent).not.toMatch(/toolbox|xiaolan|Chrome\/136\./i)
    if (mode === 'restore') {
      await service.getArtworkWebCookies(accountA)
      expect(mocks.sessionOptions).toHaveLength(1)
      expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    }
  })

  it.each(['friends', 'emoticons'] as const)('ignores QR background %s results after shutdown without events or closed-store reads', async phase => {
    const { service, store, events } = await createService()
    const friends = deferred<Record<string, number>>()
    const emoticons = deferred<[]>()
    if (phase === 'friends') mocks.relationships.mockReturnValueOnce(friends.promise)
    else mocks.emoticons.mockReturnValueOnce(emoticons.promise)
    await service.startQrLogin()
    mocks.sessions.at(-1)!.emit('authenticated')
    await vi.waitFor(() => expect(phase === 'friends' ? mocks.relationships : mocks.emoticons).toHaveBeenCalledTimes(1))
    service.dispose()
    const close = vi.spyOn(store, 'close')
    store.close()
    close.mockImplementation(() => undefined)
    const reads = [vi.spyOn(store, 'getActiveAccountId'), vi.spyOn(store, 'getAccount'), vi.spyOn(store, 'getLanguage')]
    const eventCount = events.length
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      if (phase === 'friends') friends.resolve({ [friendA]: 3 })
      else emoticons.resolve([])
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(events).toHaveLength(eventCount)
      for (const read of reads) expect(read).not.toHaveBeenCalled()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does not show an old account background-sync failure after switching accounts', async () => {
    const { service, events } = await createService()
    const pending = deferred<Record<string, number>>()
    mocks.relationships.mockReturnValueOnce(pending.promise)
    await service.startQrLogin()
    mocks.sessions.at(-1)!.emit('authenticated')
    await vi.waitFor(() => expect(mocks.relationships).toHaveBeenCalledTimes(1))
    await service.activateAccount(accountB)
    const eventCount = events.length
    pending.resolve({ [friendA]: 3 })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events).toHaveLength(eventCount)
    expect(mocks.emoticons).not.toHaveBeenCalled()
  })

  it('backs initial restore failures off progressively and resets the backoff after success', async () => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 10_000, retryDelaysMs: [100, 200, 500] })
    mocks.webCookies.mockRejectedValue(new Error('network failed'))
    await service.activateAccount(accountB)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.webCookies).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(199)
    expect(mocks.webCookies).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.webCookies).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.webCookies).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.webCookies).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.webCookies).toHaveBeenCalledTimes(5)
    mocks.webCookies.mockResolvedValue(['sessionid=recovered'])
    await vi.advanceTimersByTimeAsync(1)
    expect(service.isAuthenticated(accountB)).toBe(true)
    await service.activateAccount(accountA)
    mocks.webCookies.mockRejectedValue(new Error('network failed again'))
    await service.activateAccount(accountB)
    const beforeRetry = mocks.webCookies.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.webCookies).toHaveBeenCalledTimes(beforeRetry + 1)
  })

  it('automatically restores a saved token after startup TLS failures with one controlled notice and a visible retry plan', async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()
    const { service, store, events } = await createService(false, { keepAliveMs: 60_000, onDiagnostic: diagnostic })
    const tls = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' })
    mocks.webCookies.mockRejectedValue(tls)
    await service.activateAccount(accountB)
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({
      sessionState: 'restoring', sessionRetryAt: new Date(Date.now() + 5000).toISOString(), sessionRetryAttempt: 1 })
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryBlocked).not.toBe(true)
    expect(store.getRefreshToken(accountB)).toBe('test-token-b')
    expect(notices(events)).toEqual([expect.objectContaining({ message: 'Steam 登录连接暂时中断，已保留登录信息，正在自动重连；无需重新扫码' })])
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(3)
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({
      sessionState: 'restoring', sessionRetryAt: new Date(Date.now() + 15000).toISOString(), sessionRetryAttempt: 2 })
    expect(notices(events)).toHaveLength(1)
    expect(diagnostic).toHaveBeenCalledWith({ phase: 'restore', outcome: 'transient', reason: 'network' })
    expect(JSON.stringify(events)).not.toContain('secure TLS')
    mocks.webCookies.mockResolvedValue(['sessionid=recovered'])
    await vi.advanceTimersByTimeAsync(15000)
    expect(service.isAuthenticated(accountB)).toBe(true)
    expect(service.getAccountViews().find(account => account.id === accountB)).not.toHaveProperty('sessionRetryAt')
    expect(store.getRefreshToken(accountB)).toBe('test-token-b')
  })

  it('coalesces an in-flight same-account activation without destroying its login transport', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const first = service.activateAccount(accountB)
    const agent = mocks.sessionOptions.at(-1)!.options.agent!
    const destroyed = vi.spyOn(agent, 'destroy')
    const second = service.activateAccount(accountB)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    expect(destroyed).not.toHaveBeenCalled()
    pending.resolve(['sessionid=shared-restore'])
    await Promise.all([first, second])
    expect(service.isAuthenticated(accountB)).toBe(true)
    expect(destroyed).not.toHaveBeenCalled()
  })

  it('allows an explicit status refresh during network retry waiting without interrupting an in-flight connection', async () => {
    vi.useFakeTimers()
    const { service, store } = await createService(false, { keepAliveMs: 60_000 })
    mocks.webCookies.mockRejectedValueOnce(new Error('network failed'))
    await service.activateAccount(accountB)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryAt).toBeTruthy()
    await expect(service.refreshAccountStatus(accountB)).resolves.toMatchObject({ sessionState: 'authenticated', statusCheckState: 'verified' })
    expect(store.getRefreshToken(accountB)).toBe('test-token-b')
    const calls = mocks.webCookies.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)

    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const restore = service.activateAccount(accountA)
    const beforeCheck = mocks.webCookies.mock.calls.length
    await expect(service.refreshAccountStatus(accountA)).resolves.toMatchObject({ sessionState: 'restoring', statusCheckState: 'unverified',
      statusCheckMessage: '账号正在登录或恢复，请稍后检查' })
    expect(mocks.webCookies).toHaveBeenCalledTimes(beforeCheck)
    pending.resolve(['sessionid=connected'])
    await restore
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('bounds the entire startup cookie stage, destroys its dedicated agent and ignores late cookies before retrying', async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()
    const { service, store } = await createService(false, { keepAliveMs: 60_000, retryDelaysMs: [200], loginAttemptTimeoutMs: 100, onDiagnostic: diagnostic })
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const restore = service.activateAccount(accountB)
    const oldAgent = mocks.sessionOptions.at(-1)!.options.agent!
    const destroyed = vi.spyOn(oldAgent, 'destroy')
    await vi.advanceTimersByTimeAsync(99)
    expect(destroyed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await restore
    expect(destroyed).toHaveBeenCalledTimes(1)
    expect(store.getRefreshToken(accountB)).toBe('test-token-b')
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({ sessionState: 'restoring', sessionRetryAttempt: 1 })
    expect(diagnostic).toHaveBeenCalledWith({ phase: 'restore', outcome: 'transient', reason: 'timeout' })
    pending.resolve(['sessionid=late-expired-attempt'])
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.sessionOptions.at(-1)!.options.agent).not.toBe(oldAgent)
    expect(service.isAuthenticated(accountB)).toBe(true)
    expect(mocks.verify).toHaveBeenCalledTimes(2)
  })

  it.each(['switch', 'dispose', 'manual-login'] as const)('cancels a hanging startup attempt immediately on %s', async action => {
    vi.useFakeTimers()
    const { service, events } = await createService(false, { keepAliveMs: 60_000, loginAttemptTimeoutMs: 100 })
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const restore = service.activateAccount(accountB)
    if (action === 'switch') await service.activateAccount(accountA)
    if (action === 'dispose') service.dispose()
    if (action === 'manual-login') await service.startQrLogin()
    await restore
    const before = mocks.webCookies.mock.calls.length
    pending.resolve(['sessionid=cancelled-startup'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(before)
    expect(service.isAuthenticated(accountB)).toBe(false)
    expect(notices(events)).toHaveLength(0)
  })

  it.each(['RATE_LIMITED', 'COMMUNITY_ACCESS_DENIED'])('honors startup %s cooldowns even when asked to reconnect immediately', async code => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 300_000 })
    mocks.verify.mockRejectedValueOnce(new DomainError(code, 'Synthetic endpoint restriction', true, 90_000))
    await service.activateAccount(accountB)
    const calls = mocks.webCookies.mock.calls.length
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({ sessionState: 'restoring',
      sessionRetryAt: new Date(Date.now() + 90_000).toISOString(), sessionRetryBlocked: true })
    await service.refreshAccountStatus(accountB)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls + 1)
    expect(service.isAuthenticated(accountB)).toBe(true)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryBlocked).not.toBe(true)
  })

  it.each(['RATE_LIMITED', 'COMMUNITY_ACCESS_DENIED'])('keeps the normal lower retry bound for %s without a server hint', async code => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 300_000, retryDelaysMs: [1] })
    mocks.verify.mockRejectedValueOnce(new DomainError(code, 'Synthetic endpoint restriction', true))
    await service.activateAccount(accountB)
    const calls = mocks.webCookies.mock.calls.length
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({
      sessionRetryAt: new Date(Date.now() + 60_000).toISOString(), sessionRetryBlocked: true })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(service.isAuthenticated(accountB)).toBe(true)
  })

  it.each([Number.MAX_SAFE_INTEGER, Infinity])('blocks unbounded server retry hints (%s) without a timer or an early manual request', async retryAfterMs => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 300_000 })
    mocks.verify.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic long server wait', true, retryAfterMs))
    await service.activateAccount(accountB)
    const calls = mocks.webCookies.mock.calls.length
    expect(vi.getTimerCount()).toBe(0)
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({ sessionState: 'error',
      sessionMessage: 'Steam 登录服务要求的等待时间超出可自动处理范围，已停止本次重连；登录信息仍保留', sessionRetryBlocked: true })
    await service.activateAccount(accountB)
    await service.refreshAccountStatus(accountB)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
    expect(service.getAccountViews().find(account => account.id === accountB)).not.toHaveProperty('sessionRetryAt')
  })

  it('clears a cancelled automatic retry countdown when switching to manual sign-in', async () => {
    vi.useFakeTimers()
    const { service, store } = await createService(false, { keepAliveMs: 60_000 })
    mocks.webCookies.mockRejectedValueOnce(new Error('network failed'))
    await service.activateAccount(accountB)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryAt).toBeTruthy()
    const login = await service.startQrLogin()
    expect(service.getAccountViews().find(account => account.id === accountB)).toMatchObject({ sessionState: 'offline',
      sessionMessage: '已切换为手动登录，自动重连已停止；保存的登录信息未删除' })
    expect(service.getAccountViews().find(account => account.id === accountB)).not.toHaveProperty('sessionRetryAt')
    service.cancelLogin(login.loginId)
    const calls = mocks.webCookies.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(calls)
    expect(store.getRefreshToken(accountB)).toBe('test-token-b')
  })

  it('clears the long-wait block only after a newly confirmed manual sign-in', async () => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 300_000 })
    mocks.verify.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic long wait', true, Number.MAX_SAFE_INTEGER))
    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    await service.activateAccount(accountB)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryBlocked).toBe(true)
    await service.startQrLogin()
    const manual = mocks.sessions.at(-1)! as typeof mocks.sessions[number] & { steamID: { getSteamID64(): string } }
    manual.steamID = { getSteamID64: () => accountB }
    manual.emit('authenticated')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.isAuthenticated(accountB)).toBe(true)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionRetryBlocked).not.toBe(true)
  })

  it.each(['qr', 'credentials'] as const)('keeps a new %s login valid after an automatic restore retry deadline', async mode => {
    vi.useFakeTimers()
    const { service, events } = await createService(false, { keepAliveMs: 10_000, retryDelaysMs: [100] })
    mocks.webCookies.mockRejectedValueOnce(new Error('network failed'))
    await service.activateAccount(accountB)
    const result = mode === 'qr' ? await service.startQrLogin() : await service.startCredentialsLogin('fixture', 'fixture-only')
    const manualSession = mocks.sessions.at(-1)!
    const beforeWait = mocks.webCookies.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.webCookies).toHaveBeenCalledTimes(beforeWait)
    await expect(service.submitSteamGuard(result.loginId, 'fixture')).resolves.toBeUndefined()
    manualSession.emit('authenticated')
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'authFinished', loginId: result.loginId }))
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it.each(['qr', 'credentials'] as const)('does not let an in-flight automatic restore overwrite a newer %s login', async mode => {
    vi.useFakeTimers()
    const { service, store, events } = await createService(false, { keepAliveMs: 10_000 })
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const oldRestore = service.activateAccount(accountB)
    const result = mode === 'qr' ? await service.startQrLogin() : await service.startCredentialsLogin('fixture', 'fixture-only')
    mocks.sessions.at(-1)!.emit('authenticated')
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'authFinished', loginId: result.loginId }))
    pending.resolve(['sessionid=late-restore-b'])
    await oldRestore
    expect(store.getActiveAccountId()).toBe(accountA)
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(service.isAuthenticated(accountB)).toBe(false)
  })

  it('refreshes periodically without logging out a trusted current session and disposes its timer', async () => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 100 })
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.replaceCookies).toHaveBeenCalledTimes(1)
    expect(service.isAuthenticated(accountA)).toBe(true)
    service.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
  })

  it('shares one renewal across the timer, preflight and artwork instead of overlapping requests', async () => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 100 })
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(100)
    const first = service.ensureSessionFresh(accountA)
    const second = service.ensureSessionFresh(accountA)
    const artwork = service.getArtworkWebCookies(accountA)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    pending.resolve(['sessionid=updated'])
    await Promise.all([first, second, artwork])
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    expect(mocks.replaceCookies).toHaveBeenCalledExactlyOnceWith(['sessionid=updated'])
  })

  it.each([new Error('HTTP 429'), new Error('HTTP 503'), Object.assign(new Error('AccessDenied'), { eresult: 15 })])(
    'keeps a trusted login on transient renewal failure and backs off without clearing tokens: %s', async error => {
      vi.useFakeTimers()
      const { service, store } = await createService(false, { keepAliveMs: 100, retryDelaysMs: [200, 400] })
      mocks.webCookies.mockRejectedValueOnce(error)
      await vi.advanceTimersByTimeAsync(100)
      expect(service.isAuthenticated(accountA)).toBe(true)
      expect(store.getRefreshToken(accountA)).toBe('test-token-a')
      expect(mocks.replaceCookies).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(199)
      expect(mocks.webCookies).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.webCookies).toHaveBeenCalledTimes(3)
    }
  )

  it('pauses once on confirmed cookie expiry and restores without automatically resuming any task', async () => {
    const { service, onExpired } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    mocks.instances[0]!.expire()
    mocks.instances[0]!.expire()
    expect(onExpired).toHaveBeenCalledExactlyOnceWith(accountA)
    expect(service.isAuthenticated(accountA)).toBe(false)
    pending.resolve(['sessionid=recovered'])
    await service.ensureSessionFresh(accountA)
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(service.getAccountViews().find(account => account.id === accountA)?.sessionMessage).toContain('恢复状态')
  })

  it('retains a recovering session over network failure and recovers on its bounded retry timer', async () => {
    vi.useFakeTimers()
    const { service, onExpired } = await createService(false, { keepAliveMs: 1000, retryDelaysMs: [200] })
    mocks.webCookies.mockRejectedValueOnce(new Error('fetch failed'))
    mocks.instances[0]!.expire()
    await vi.advanceTimersByTimeAsync(0)
    expect(service.isAuthenticated(accountA)).toBe(false)
    expect(service.getAccountViews().find(account => account.id === accountA)?.sessionState).toBe('restoring')
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('does not treat rejected candidate cookies as proof the refresh token was revoked', async () => {
    vi.useFakeTimers()
    const { service, store, onExpired } = await createService(false, { keepAliveMs: 100, retryDelaysMs: [200] })
    mocks.verify.mockRejectedValueOnce(new DomainError('SESSION_EXPIRED', 'fixture guest'))
    await vi.advanceTimersByTimeAsync(100)
    expect(service.isAuthenticated(accountA)).toBe(false)
    expect(service.getAccountViews().find(account => account.id === accountA)?.sessionState).toBe('restoring')
    expect(store.getRefreshToken(accountA)).toBe('test-token-a')
    expect(onExpired).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('does not overwrite recovery state when an optional profile request expires during restore', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.profile.mockImplementationOnce(async () => {
      mocks.webCookies.mockReturnValueOnce(pending.promise)
      mocks.instances.at(-1)!.expire()
      throw new DomainError('SESSION_EXPIRED', 'fixture expired profile')
    })
    await service.activateAccount(accountB)
    expect(service.isAuthenticated(accountB)).toBe(false)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionState).toBe('restoring')
    pending.resolve(['sessionid=recovered'])
    await service.ensureSessionFresh(accountB)
    expect(service.isAuthenticated(accountB)).toBe(true)
  })

  it.each([27, 26, 126])('requires login only for a definitive refresh-token rejection (%s)', async eresult => {
    vi.useFakeTimers()
    const { service, onExpired, store } = await createService(false, { keepAliveMs: 100 })
    mocks.webCookies.mockRejectedValueOnce(Object.assign(new Error('Rejected'), { eresult }))
    await vi.advanceTimersByTimeAsync(100)
    expect(service.isAuthenticated(accountA)).toBe(false)
    expect(service.getAccountViews().find(account => account.id === accountA)?.sessionState).toBe('expired')
    expect(onExpired).toHaveBeenCalledExactlyOnceWith(accountA)
    expect(store.getRefreshToken(accountA)).toBe('test-token-a')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
  })

  it('persists a changed refresh token through encrypted storage without changing the selected account', async () => {
    vi.useFakeTimers()
    const { service, store } = await createService(false, { keepAliveMs: 100 })
    const save = vi.spyOn(store, 'saveRefreshToken')
    mocks.webCookies.mockImplementationOnce(async () => {
      mocks.sessions[0]!.refreshToken = 'rotated-token'
      return ['sessionid=rotated']
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(save).toHaveBeenCalledExactlyOnceWith(accountA, 'rotated-token')
    expect(store.getRefreshToken(accountA)).toBe('rotated-token')
    expect(store.getActiveAccountId()).toBe(accountA)
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('never applies a late renewal or token change after switching accounts', async () => {
    const { service, store } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const old = service.getArtworkWebCookies(accountA)
    const rejected = expect(old).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await Promise.resolve()
    await service.activateAccount(accountB)
    mocks.sessions[0]!.refreshToken = 'stale-token'
    pending.resolve(['sessionid=stale'])
    await rejected
    expect(mocks.replaceCookies).not.toHaveBeenCalled()
    expect(store.getRefreshToken(accountA)).toBe('test-token-a')
    expect(service.isAuthenticated(accountB)).toBe(true)
  })

  it('ignores an old automatic login that completes after switching back to the original account', async () => {
    const { service, store } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const oldRestore = service.activateAccount(accountB)
    await service.activateAccount(accountA)
    pending.resolve(['sessionid=late-account-b'])
    await oldRestore
    expect(store.getActiveAccountId()).toBe(accountA)
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(service.isAuthenticated(accountB)).toBe(false)
    expect(service.getAccountViews().find(account => account.id === accountB)?.sessionState).toBe('offline')
  })

  it('disposes an in-flight renewal without committing cookies or scheduling another timer', async () => {
    vi.useFakeTimers()
    const { service } = await createService(false, { keepAliveMs: 100 })
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(100)
    service.dispose()
    pending.resolve(['sessionid=late-disposed'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(service.isAuthenticated(accountA)).toBe(false)
    expect(mocks.replaceCookies).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards a completed QR login after cancellation instead of resurrecting the removed intent', async () => {
    const { service, events } = await createService()
    const result = await service.startQrLogin()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    mocks.sessions[1]!.emit('authenticated')
    service.cancelLogin(result.loginId)
    pending.resolve(['sessionid=cancelled'])
    await Promise.resolve()
    await Promise.resolve()
    expect(events.some(event => event.type === 'authFinished')).toBe(false)
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('does not finish QR login with cookies rejected by the later optional profile request', async () => {
    const { service, events } = await createService()
    const result = await service.startQrLogin()
    mocks.profile.mockRejectedValueOnce(new DomainError('SESSION_EXPIRED', 'fixture guest profile'))
    mocks.sessions[1]!.emit('authenticated')
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'authFailed', loginId: result.loginId })))
    expect(events.some(event => event.type === 'authFinished')).toBe(false)
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('does not submit a comment if its final session preparation fails', async () => {
    let now = 0
    const { service, store } = await createService(false, { now: () => now, keepAliveMs: 100 })
    store.replaceFriends(accountA, [friend(accountA, friendA, 'Fixture friend')])
    now = 100
    mocks.webCookies.mockRejectedValueOnce(new Error('network failed'))
    await expect(service.postProfileComment(accountA, friendA, 'Unsent')).rejects.toMatchObject({ code: 'COMMENT_PREFLIGHT_FAILED',
      interruption: { code: 'NETWORK_ERROR', rejectedBeforeAcceptance: true } })
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('read-only comment recovery identity checks', () => {
  it('coalesces explicit account status checks and records actual web identity verification', async () => {
    const { service } = await createService()
    mocks.verify.mockClear()
    mocks.webCookies.mockClear()
    const pending = deferred<void>()
    mocks.verify.mockReturnValueOnce(pending.promise)
    const first = service.refreshAccountStatus(accountA)
    const second = service.refreshAccountStatus(accountA)
    expect(first).toBe(second)
    expect(service.getAccountViews().find(account => account.id === accountA)?.statusCheckState).toBe('checking')
    pending.resolve()
    expect(await first).toMatchObject({ id: accountA, sessionState: 'authenticated', statusCheckState: 'verified',
      statusCheckedAt: expect.any(String) })
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(mocks.webCookies).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('records an unverified 403 without falsely expiring a valid login or posting a comment', async () => {
    const { service } = await createService()
    mocks.verify.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic status check 403'))
    expect(await service.refreshAccountStatus(accountA)).toMatchObject({ sessionState: 'authenticated',
      statusCheckState: 'unverified', statusCheckMessage: 'Synthetic status check 403' })
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it.each(['switch', 'dispose'] as const)('does not publish a stale status check after %s', async action => {
    const { service, events } = await createService()
    const pending = deferred<void>()
    mocks.verify.mockReturnValueOnce(pending.promise)
    const checking = service.refreshAccountStatus(accountA)
    const result = expect(checking).rejects.toMatchObject({ code: 'STATUS_CHECK_ACCOUNT_CHANGED' })
    await Promise.resolve()
    if (action === 'switch') await service.activateAccount(accountB)
    else service.dispose()
    const count = events.length
    pending.resolve()
    await result
    expect(events).toHaveLength(count)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('does not activate a different account just to check its status', async () => {
    const { service } = await createService()
    expect(() => service.refreshAccountStatus(accountB)).toThrow('请先切换')
    expect(service.isAuthenticated(accountA)).toBe(true)
  })

  it('uses the current Community session without renewing credentials or sending comments', async () => {
    const { service } = await createService()
    mocks.verify.mockClear()
    mocks.webCookies.mockClear()
    await service.verifyCommentSession(accountA)
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(mocks.webCookies).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('preserves the original 403 Retry-After without turning it into expired credentials', async () => {
    const { service } = await createService()
    mocks.verify.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic check 403', true, 1_200_000))
    await expect(service.verifyCommentSession(accountA)).rejects.toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED', retryAfterMs: 1_200_000 })
    expect(service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('rejects an identity check that finishes after the account changes', async () => {
    const { service } = await createService()
    const pending = deferred<void>()
    mocks.verify.mockReturnValueOnce(pending.promise)
    const check = service.verifyCommentSession(accountA)
    const checked = expect(check).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    await service.activateAccount(accountB)
    pending.resolve()
    await checked
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('Steam login request timeout', () => {
  it('destroys a stalled request at its wall deadline and clears completed request timers', async () => {
    vi.useFakeTimers()
    const prototype = Agent.prototype as Agent & { addRequest(request: ClientRequest, options: RequestOptions): void }
    const native = vi.spyOn(prototype, 'addRequest').mockImplementation(() => undefined)
    const agent = new BoundedLoginAgent(100)
    try {
      const stalled = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      agent.addRequest(stalled as unknown as ClientRequest, {})
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(stalled.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Steam login network request timed out' }))
      stalled.emit('close')
      const done = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      agent.addRequest(done as unknown as ClientRequest, {})
      done.emit('close')
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(done.destroy).not.toHaveBeenCalled()
      agent.destroy()
      const cancelled = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      agent.addRequest(cancelled as unknown as ClientRequest, {})
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelled.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Steam login request cancelled' }))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      native.mockRestore()
      agent.destroy()
    }
  })
})

describe('SteamService artwork sessions', () => {
  it('reads backgrounds only from the active account and enforces the transition guard', async () => {
    const { service } = await createService()
    await expect(service.getProfileBackgrounds(accountB)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' })
    await expect(service.getProfileBackgrounds(accountA, () => false)).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(mocks.backgrounds).not.toHaveBeenCalled()
    expect((await service.getProfileBackgrounds(accountA)).accountId).toBe(accountA)
  })

  it('rejects old background results even after returning to the same account', async () => {
    const { service } = await createService()
    const pending = deferred<unknown>()
    mocks.backgrounds.mockReturnValueOnce(pending.promise)
    const opening = service.getProfileBackgrounds(accountA)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    pending.resolve({ accountId: accountA, items: [], issues: [], ownedComplete: true, fetchedAt: new Date().toISOString() })
    await rejected
  })
  it('keeps web cookies in the main process and returns an independent array', async () => {
    const { service, events } = await createService()
    const cookies = ['steamLoginSecure=artwork-test', 'sessionid=artwork-session']
    mocks.webCookies.mockResolvedValueOnce(cookies)
    const result = await service.getArtworkWebCookies(accountA)
    expect(result).toEqual(cookies)
    expect(result).not.toBe(cookies)
    expect(JSON.stringify(events)).not.toContain('artwork-session')
    await expect(service.getArtworkWebCookies(accountB)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' })
  })

  it('rejects cookies fetched across an account switch or removal', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const opening = service.getArtworkWebCookies(accountA)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await service.activateAccount(accountB)
    pending.resolve(['sessionid=stale-session'])
    await rejected
    service.removeAccount(accountB)
    await expect(service.getArtworkWebCookies(accountB)).rejects.toThrow()
  })

  it('rejects an old login session even after switching back to the same account', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const opening = service.getArtworkWebCookies(accountA)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    pending.resolve(['sessionid=old-session'])
    await rejected
  })

  it('does not expose native cookie or token diagnostics on authentication failure', async () => {
    const { service } = await createService()
    mocks.webCookies.mockRejectedValueOnce(new Error('sessionid=private-cookie steamLoginSecure=private-token'))
    await expect(service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    expect(service.isAuthenticated(accountA)).toBe(true)
  })
})

describe('SteamService friend synchronization', () => {
  it.each(['switch', 'remove', 'dispose'] as const)('discards emoticons returned after session %s', async transition => {
    const { service, store } = await createService()
    const pending = deferred<[]>()
    mocks.emoticons.mockReturnValueOnce(pending.promise)
    const write = vi.spyOn(store, 'replaceEmoticons')
    const syncing = service.syncEmoticons(accountA)
    const rejected = expect(syncing).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    if (transition === 'switch') await service.activateAccount(accountB)
    else if (transition === 'remove') service.removeAccount(accountA)
    else service.dispose()
    pending.resolve([])
    await rejected
    expect(write).not.toHaveBeenCalled()
  })

  it('records only newly resolved nickname changes and preserves the baseline across failed lookups', async () => {
    const { service, store } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendA, 'Original name')])
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'New name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toEqual([
      expect.objectContaining({ steamId: friendA, oldName: 'Original name', newName: 'New name' })
    ])
    mocks.summaries.mockResolvedValue(profileResult([], new Error('HTTP 503')))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(1)
    expect(store.getFriend(accountA, friendA)?.displayName).toBe('New name')
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Original name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(2)
    expect(store.getFriendNameChanges(accountA)[0]).toMatchObject({ oldName: 'New name', newName: 'Original name' })
  })

  it('does not count an initial SteamID placeholder becoming a resolved name as a rename', async () => {
    const { service, store } = await createService()
    mocks.summaries.mockResolvedValue(profileResult([], new Error('HTTP 429')))
    await service.syncFriends(accountA)
    expect(store.getFriend(accountA, friendA)?.displayName).toBe(friendA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(0)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'First resolved name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(0)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Second name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)[0]).toMatchObject({
      oldName: 'First resolved name', newName: 'Second name'
    })
  })

  it('reports complete success only after all friend profiles are refreshed', async () => {
    const { service, store, events } = await createService()
    mocks.relationships.mockResolvedValue({ [friendA]: 3, [friendB]: 2 })

    expect(await service.syncFriends(accountA)).toBe(1)

    expect(mocks.summaries).toHaveBeenCalledWith([friendA])
    expect(store.getFriends(accountA)).toEqual([
      expect.objectContaining({ steamId: friendA, displayName: 'Updated friend' })
    ])
    expect(notices(events)).toEqual([
      { type: 'notice', level: 'success', message: '已同步 1 位好友及资料' }
    ])
  })

  it('retains successful profiles, cached missing profiles and account-scoped groups on partial failure', async () => {
    const { service, store, events } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendB, 'Cached friend')])
    store.replaceFriends(accountB, [friend(accountB, friendA, 'Other account name')])
    const group = store.createGroup(accountA, 'Local group', '#66c0f4')
    store.setFriendGroups(accountA, [friendB], [group.id])
    mocks.relationships.mockResolvedValue({ [friendA]: 3, [friendB]: 3, [friendC]: 3 })
    mocks.summaries.mockResolvedValue(
      profileResult([profile(friendA, 'Fresh friend')], new Error('HTTP 429 eyJsecret-token'))
    )

    expect(await service.syncFriends(accountA)).toBe(3)

    const friends = new Map(store.getFriends(accountA).map((item) => [item.steamId, item]))
    expect(friends.get(friendA)?.displayName).toBe('Fresh friend')
    expect(friends.get(friendB)).toMatchObject({
      displayName: 'Cached friend',
      avatarUrl: 'https://example.invalid/cached-avatar.jpg',
      groupIds: [group.id]
    })
    expect(friends.get(friendC)).toMatchObject({ displayName: friendC, onlineState: 'unknown' })
    expect(store.getFriends(accountB)[0]?.displayName).toBe('Other account name')
    expect(notices(events)).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('3 位），但 2 位资料暂未刷新')
      })
    ])
    expect(notices(events)[0]?.message).toContain('HTTP 429 [token]')
    expect(notices(events)[0]?.message).not.toContain('eyJsecret-token')
  })

  it('reports missing profiles without falsely claiming complete success', async () => {
    const { service, events } = await createService()
    mocks.summaries.mockResolvedValue(profileResult([]))

    await service.syncFriends(accountA)

    expect(notices(events)).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('Steam 未返回完整好友资料')
      })
    ])
  })

  it('coalesces concurrent manual syncs and allows another sync after completion', async () => {
    const { service, events } = await createService()
    const pending = deferred<Record<string, number>>()
    mocks.relationships.mockReturnValueOnce(pending.promise)

    const first = service.syncFriends(accountA)
    const second = service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(1)
    pending.resolve({ [friendA]: 3 })
    expect(await Promise.all([first, second])).toEqual([1, 1])
    expect(mocks.summaries).toHaveBeenCalledTimes(1)
    expect(notices(events)).toHaveLength(1)

    await service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })

  it('coalesces login-triggered automatic sync with a manual sync', async () => {
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const { service, events } = await createService(true)

    const manual = service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(1)
    pending.resolve(profileResult([profile(friendA, 'Fresh friend')]))
    expect(await manual).toBe(1)
    expect(mocks.summaries).toHaveBeenCalledTimes(1)
    expect(notices(events)).toHaveLength(1)
  })

  it('does not replace cached data when relationships fail, and clears the in-flight request', async () => {
    const { service, store, events } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendB, 'Cached friend')])
    mocks.relationships.mockRejectedValueOnce(new Error('HTTP 503'))

    await expect(service.syncFriends(accountA)).rejects.toThrow('HTTP 503')

    expect(store.getFriends(accountA)[0]?.displayName).toBe('Cached friend')
    expect(mocks.summaries).not.toHaveBeenCalled()
    expect(notices(events)).toHaveLength(0)
    expect(await service.syncFriends(accountA)).toBe(1)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })

  it('does not fetch profiles after the account was switched while relationships were loading', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<Record<string, number>>()
    mocks.relationships.mockReturnValueOnce(pending.promise)
    const sync = service.syncFriends(accountA)
    const rejection = expect(sync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })

    await service.activateAccount(accountB)
    pending.resolve({ [friendA]: 3 })
    await rejection

    expect(mocks.summaries).not.toHaveBeenCalled()
    expect(store.getFriends(accountA)).toHaveLength(0)
    expect(notices(events)).toHaveLength(0)
  })

  it('does not write profiles after the account was removed', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const sync = service.syncFriends(accountA)
    const rejection = expect(sync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    await vi.waitFor(() => expect(mocks.summaries).toHaveBeenCalledTimes(1))

    service.removeAccount(accountA)
    pending.resolve(profileResult([profile(friendA, 'Stale friend')]))
    await rejection

    expect(store.getAccount(accountA)).toBeNull()
    expect(store.getFriends(accountA)).toHaveLength(0)
    expect(notices(events)).toHaveLength(0)
  })

  it('does not reuse, overwrite or expire a newer session with results from an old session', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const oldSync = service.syncFriends(accountA)
    const rejection = expect(oldSync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    await vi.waitFor(() => expect(mocks.summaries).toHaveBeenCalledTimes(1))
    const oldClient = mocks.instances[0]!

    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Current friend')]))
    expect(await service.syncFriends(accountA)).toBe(1)
    oldClient.expire()
    expect(service.isAuthenticated(accountA)).toBe(true)
    pending.resolve(profileResult([profile(friendA, 'Stale friend')]))
    await rejection

    expect(store.getFriends(accountA)[0]?.displayName).toBe('Current friend')
    expect(notices(events)).toHaveLength(1)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })
})

const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => value.toString()
}

async function createService(autoSync = false, options: SteamServiceOptions = {}): Promise<{
  service: SteamService
  store: SqliteStore
  events: AppEvent[]
  onExpired: ReturnType<typeof vi.fn>
}> {
  const directory = mkdtempSync(join(tmpdir(), 'steam-service-test-'))
  const store = new SqliteStore(join(directory, 'test.sqlite3'), fakeCipher)
  store.upsertAccount(account(accountA, autoSync), 'test-token-a')
  store.upsertAccount(account(accountB), 'test-token-b')
  const events: AppEvent[] = []
  const onExpired = vi.fn()
  const service = new SteamService(store, (event) => events.push(event), onExpired, options)
  fixtures.push({ directory, store, service })
  await service.activateAccount(accountA)
  return { service, store, events, onExpired }
}

function account(id: string, autoSync = false): AccountRecord {
  const now = new Date().toISOString()
  return {
    id,
    steamId: id,
    accountName: id,
    displayName: id,
    avatarUrl: '',
    createdAt: now,
    lastLoginAt: now,
    lastFriendSyncAt: autoSync ? null : now,
    lastEmoticonSyncAt: now
  }
}

function profile(steamId: string, displayName: string): Profile {
  return { steamId, displayName, avatarUrl: '', onlineState: 'online' }
}

function profileResult(profiles: Profile[], error: Error | null = null): ProfilesResult {
  return { profiles: new Map(profiles.map((item) => [item.steamId, item])), error }
}

function friend(accountId: string, steamId: string, displayName: string): Omit<FriendRecord, 'groupIds'> {
  return {
    accountId,
    steamId,
    displayName,
    avatarUrl: 'https://example.invalid/cached-avatar.jpg',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline',
    syncedAt: new Date().toISOString()
  }
}

function notices(events: AppEvent[]): Array<Extract<AppEvent, { type: 'notice' }>> {
  return events.filter((event) => event.type === 'notice')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
