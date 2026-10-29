import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SteamService } from '../src/main/steam-service'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AccountRecord, AppEvent } from '../src/shared/types'
import { emptyCommentProfile } from './helpers/comment-baseline'

const mocks = vi.hoisted(() => ({
  nextAccount: '',
  sessions: [] as Array<{
    accountId: string
    refreshToken: string
    emit(event: string): boolean
  }>,
  webCookies: vi.fn<(accountId: string) => Promise<string[]>>()
}))

vi.mock('steam-session', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    EAuthSessionGuardType: {}, EAuthTokenPlatformType: { WebBrowser: 2 }, ESessionPersistence: { Persistent: 1 },
    LoginSession: class extends EventEmitter {
      accountId = mocks.nextAccount
      accountName = 'Synthetic account'
      refreshToken = `synthetic-refresh-${this.accountId}`
      loginTimeout = 0
      steamID = { getSteamID64: () => this.accountId }
      cancelLoginAttempt = vi.fn()
      constructor() {
        super()
        mocks.sessions.push(this)
      }
      async startWithQR(): Promise<{ qrChallengeUrl: string }> {
        return { qrChallengeUrl: 'https://example.invalid/synthetic-qr' }
      }
      async getWebCookies(): Promise<string[]> { return mocks.webCookies(this.accountId) }
    }
  }
})

vi.mock('../src/main/community-web-session', () => ({
  getCommunityWebCookies: (accountId: string) => mocks.webCookies(accountId)
}))

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const friendIds = ['76561198000000101', '76561198000000102', '76561198000000103']
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString()
}

interface Fixture {
  directory: string
  store: SqliteStore
  service: SteamService
  queue: BatchQueue
  events: AppEvent[]
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  postReplies: Array<Response | Promise<Response>>
  closed: boolean
}
const fixtures: Fixture[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  mocks.sessions.splice(0)
  mocks.nextAccount = accountA
  mocks.webCookies.mockReset()
  mocks.webCookies.mockImplementation(async id => cookies(id, 'initial'))
})

afterEach(async () => {
  for (const fixture of fixtures) {
    fixture.queue.shutdown()
    fixture.service.dispose()
  }
  await flush()
  for (const fixture of fixtures.splice(0)) {
    if (!fixture.closed) fixture.store.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('real login, community client and persistent queue integration', () => {
  it.each([200, 403])('categorizes a real HTTP %s explicit permission denial and continues despite the pause policy', async status => {
    const fixture = await createFixture()
    const verify = vi.spyOn(fixture.service, 'reconcileProfileComment')
    fixture.postReplies.push(new Response(JSON.stringify({ success: 2,
      error: 'Your account does not have permission to post comments.' }),
    { status, headers: { Date: new Date().toUTCString(), 'Content-Type': 'application/json' } }), success('101'), success('102'))
    const batch = fixture.queue.start({ accountId: accountA, friendSteamIds: friendIds,
      messageTemplate: 'Synthetic comment', delayMs: 100, autoRetryEnabled: true,
      failurePolicy: { definiteFailure: 'pause', uncertainResult: 'verify_then_pause' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', pending: 0,
      failedCount: status === 200 ? 1 : 0, uncertain: status === 403 ? 1 : 0, sentVerified: 2,
      accessDeniedCount: 0, nextRetryAt: null })
    const denied = /\/post\/(7656119\d{10})\//.exec(String(posts(fixture)[0]![0]))![1]!
    expect(posts(fixture).filter(([url]) => String(url).includes(`/post/${denied}/`))).toHaveLength(1)
    const readbacks = fixture.fetch.mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === 'GET' &&
      new URL(String(input)).pathname === `/profiles/${denied}/`)
    expect(readbacks).toHaveLength(status === 403 ? 2 : 1)
    expect(verify).not.toHaveBeenCalled()
    expect(fixture.store.getFriendPolicies(accountA).find(item => item.steamId === denied)?.commentStatus).toBe('blocked')
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'friendPolicyChanged',
      policy: expect.objectContaining({ steamId: denied, commentStatus: 'blocked' }) }))
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
  })

  it.each(['baseline', 'post'] as const)('continues after a real %s network failure without repeating that recipient or reading it back', async stage => {
    const fixture = await createFixture()
    const original = fixture.fetch.getMockImplementation()!
    let failedTarget: string | null = null
    let failedTargetReads = 0
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      const target = /^\/profiles\/(7656119\d{10})\/$/.exec(url.pathname)?.[1]
      if ((init?.method ?? 'GET') === 'GET' && target) {
        failedTarget ??= target
        if (target === failedTarget) {
          failedTargetReads++
          if (stage === 'baseline') throw new TypeError('fetch failed')
        }
      }
      if (init?.method === 'POST' && url.pathname === `/comment/Profile/post/${failedTarget}/-1/`) throw new TypeError('fetch failed')
      return original(input, init)
    })
    const verification = vi.spyOn(fixture.service, 'reconcileProfileComment')
    fixture.postReplies.push(success('101'), success('102'))
    const batch = fixture.queue.start({ accountId: accountA, friendSteamIds: friendIds,
      messageTemplate: 'Synthetic comment', delayMs: 100, autoRetryEnabled: true,
      failurePolicy: { definiteFailure: 'pause', uncertainResult: 'verify_then_pause' } })
    await vi.advanceTimersByTimeAsync(99)
    expect(posts(fixture)).toHaveLength(stage === 'post' ? 1 : 0)
    await vi.advanceTimersByTimeAsync(101)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', sentVerified: 2,
      failedCount: stage === 'baseline' ? 1 : 0, uncertain: stage === 'post' ? 1 : 0,
      pending: 0, nextRetryAt: null, retryCount: 0 })
    expect(posts(fixture)).toHaveLength(stage === 'post' ? 3 : 2)
    expect(posts(fixture).filter(([url]) => new URL(String(url)).pathname === `/comment/Profile/post/${failedTarget}/-1/`))
      .toHaveLength(stage === 'post' ? 1 : 0)
    expect(failedTargetReads).toBe(1)
    expect(verification).not.toHaveBeenCalled()
    expect(fixture.store.getFriendPolicies(accountA).find(item => item.steamId === failedTarget))
      .toMatchObject({ commentStatus: 'unknown' })
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'friendPolicyChanged',
      policy: expect.objectContaining({ steamId: failedTarget, commentStatus: 'unknown' }) }))
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing', 'skip'], ['incomplete', 'skip'], ['missing', 'pause'], ['incomplete', 'pause']
  ] as const)('handles a %s authenticated comment baseline with the %s policy without submitting to that friend', async (shape, definiteFailure) => {
    const fixture = await createFixture()
    const original = fixture.fetch.getMockImplementation()!
    let unreadableTarget: string | null = null
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if ((init?.method ?? 'GET') === 'GET') unreadableTarget ??= /^\/profiles\/(7656119\d{10})\/$/.exec(url.pathname)?.[1] ?? null
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === `/profiles/${unreadableTarget}/`) {
        return new Response(`<script>g_steamID="${accountA}";</script>` + (shape === 'incomplete'
          ? `<div id="commentthread_Profile_${unreadableTarget}_area" class="commentthread_area"></div>` : ''))
      }
      return original(input, init)
    })
    fixture.postReplies.push(success('101'), success('102'))
    const batch = fixture.queue.start({ accountId: accountA, friendSteamIds: friendIds,
      messageTemplate: 'Synthetic comment', delayMs: 100, autoRetryEnabled: false,
      failurePolicy: { definiteFailure, uncertainResult: 'verify_then_skip' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: definiteFailure === 'skip' ? 'completed' : 'paused',
      failedCount: definiteFailure === 'skip' ? 1 : 0, uncertain: 0, sentVerified: definiteFailure === 'skip' ? 2 : 0,
      pending: definiteFailure === 'skip' ? 0 : 3, nextRetryAt: null, accessDeniedCount: 0 })
    const unreadable = fixture.store.getBatch(batch.id)!.deliveries.find(item => item.friendSteamId === unreadableTarget)!
    expect(unreadable.status).toBe(definiteFailure === 'skip' ? 'failed' : 'pending')
    if (definiteFailure === 'skip') expect(unreadable.error).toMatch(/^已跳过（未发送）：/)
    expect(fixture.store.getDeliveryCommentEvidence(unreadable.id)).toBeNull()
    expect(posts(fixture)).toHaveLength(definiteFailure === 'skip' ? 2 : 0)
    expect(posts(fixture).some(([url]) => new URL(String(url)).pathname === `/comment/Profile/post/${unreadableTarget}/-1/`)).toBe(false)
    expect(new Set(posts(fixture).map(([url]) => String(url))).size).toBe(posts(fixture).length)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
  })

  it.each(['skip', 'pause'] as const)('handles a real private-profile preflight with the %s policy and no POST to that friend', async definiteFailure => {
    const fixture = await createFixture()
    const original = fixture.fetch.getMockImplementation()!
    let first: string | null = null
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if ((init?.method ?? 'GET') === 'GET') first ??= /^\/profiles\/(7656119\d{10})\/$/.exec(url.pathname)?.[1] ?? null
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === `/profiles/${first}/`) {
        return new Response(`<html><body class="profile_page private_profile responsive_page"><div class="responsive_page_frame"><div class="responsive_page_content"><div id="responsive_page_template_content" class="responsive_page_template_content"><div class="profile_page private_profile"></div><script>g_rgProfileData={"steamid":"${first}"};g_steamID="${accountA}";</script></div></div></div></body></html>`)
      }
      return original(input, init)
    })
    fixture.postReplies.push(success('101'), success('102'))
    const batch = fixture.queue.start({ accountId: accountA, friendSteamIds: friendIds,
      messageTemplate: 'Synthetic comment', delayMs: 100, autoRetryEnabled: false,
      failurePolicy: { definiteFailure, uncertainResult: 'verify_then_skip' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed',
      failedCount: 1, uncertain: 0, sentVerified: 2, pending: 0 })
    const privateDelivery = fixture.store.getBatch(batch.id)!.deliveries.find(item => item.friendSteamId === first)!
    expect(privateDelivery).toMatchObject({ status: 'failed', error: expect.stringContaining('私密') })
    expect(fixture.store.getDeliveryCommentEvidence(privateDelivery.id)).toBeNull()
    expect(posts(fixture)).toHaveLength(2)
    expect(posts(fixture).some(([url]) => new URL(String(url)).pathname === `/comment/Profile/post/${first}/-1/`)).toBe(false)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
    expect(fixture.store.getFriendPolicies(accountA).find(item => item.steamId === first)?.commentStatus).toBe('blocked')
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'friendPolicyChanged',
      policy: expect.objectContaining({ accountId: accountA, steamId: first, commentStatus: 'blocked' }) }))
  })

  it.each([403, 429])('handles HTTP %s without expiring the QR login or replaying the affected POST', async status => {
    const fixture = await createFixture()
    fixture.postReplies.push(success('100'), new Response('Request denied', { status }), success('300'), success('400'))
    const batch = start(fixture)
    await vi.advanceTimersByTimeAsync(100)

    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: status === 403 ? 'running' : 'paused', succeeded: 1,
      failed: 1, pending: 1, uncertain: status === 403 ? 1 : 0, failedCount: status === 403 ? 0 : 1,
      stopCode: status === 403 ? null : 'RATE_LIMITED', nextRetryAt: null })
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
    expect(posts(fixture)).toHaveLength(2)
    if (status === 403) {
      expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ accessDeniedCount: 0,
        verification: { state: 'unresolved', attempt: 1 } })
    } else {
      await vi.advanceTimersByTimeAsync(5000)
      expect(posts(fixture)).toHaveLength(2)
      fixture.queue.resume(batch.id)
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed',
      succeeded: 2, failed: 1, uncertain: status === 403 ? 1 : 0 })
    expect(posts(fixture)).toHaveLength(3)
    expect(new Set(posts(fixture).map(([url]) => String(url))).size).toBe(3)
  })

  it('persists evidence and confirms a delayed profile read through the real client before continuing', async () => {
    const fixture = await createFixture()
    fixture.postReplies.push(success('100'), new Response('Synthetic response refusal', { status: 403 }), success('300'))
    const original = fixture.fetch.getMockImplementation()!
    let deniedTarget: string | null = null
    let readbacks = 0
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === `/profiles/${deniedTarget}/` && ++readbacks >= 2) {
        return new Response(`<script>g_steamID="${accountA}";</script>` +
          `<div id="commentthread_Profile_${deniedTarget}_area" class="commentthread_area">` +
          `<div id="commentthread_Profile_${deniedTarget}_posts" class="commentthread_comments">` +
          `<div id="comment_7001" class="commentthread_comment">` +
          `<a class="commentthread_author_link" href="https://steamcommunity.com/profiles/${accountA}">Sender</a>` +
          `<span class="commentthread_comment_timestamp" data-timestamp="${Math.floor(Date.now() / 1000)}"></span>` +
          '<div class="commentthread_comment_text">Synthetic comment</div></div></div></div>',
        { headers: { Date: new Date().toUTCString() } })
      }
      const response = await original(input, init)
      response.headers.set('Date', new Date().toUTCString())
      if (init?.method === 'POST' && response.status === 403) deniedTarget = url.pathname.split('/')[4]!
      return response
    })
    const batch = start(fixture)
    await vi.advanceTimersByTimeAsync(200)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', sentVerified: 3,
      uncertain: 0, pending: 0, verification: { state: 'confirmed', attempt: 1 } })
    expect(readbacks).toBe(2)
    expect(posts(fixture)).toHaveLength(3)
    expect(new Set(posts(fixture).map(([url]) => String(url))).size).toBe(3)
    const reconciled = fixture.store.getBatch(batch.id)!.deliveries.find(item => item.remoteCommentId === '7001')!
    expect(fixture.store.getDeliveryCommentEvidence(reconciled.id)).toMatchObject({ baselineIds: [],
      serverWindow: { earliest: expect.any(Number), latest: expect.any(Number) } })
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
  })

  it.each([
    ['HTTP 401', () => new Response('Not authenticated', { status: 401 })],
    ['NotLoggedOn 21', () => Response.json({ success: 21 })]
  ])('recovers cookies after %s but leaves the durable task paused until an explicit resume', async (_label, rejected) => {
    const fixture = await createFixture()
    const refreshed = deferred<string[]>()
    mocks.webCookies.mockImplementationOnce(() => refreshed.promise)
    fixture.postReplies.push(success('100'), rejected(), success('300'))
    const batch = start(fixture)
    await vi.advanceTimersByTimeAsync(100)

    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', succeeded: 1, failed: 1, pending: 1 })
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(posts(fixture)).toHaveLength(2)
    refreshed.resolve(cookies(accountA, 'recovered'))
    await flush()
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(fixture.store.getBatchSummary(batch.id)?.status).toBe('paused')
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts(fixture)).toHaveLength(2)

    fixture.queue.resume(batch.id)
    await flush()
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', succeeded: 2, failed: 1 })
    const sent = posts(fixture)
    expect(new Set(sent.map(([url]) => String(url))).size).toBe(3)
    expect(new Headers(sent[2]![1]?.headers).get('Cookie')).toContain('recovered')
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
  })

  it('retains pending recipients when automatic authentication recovery is rejected', async () => {
    const fixture = await createFixture()
    mocks.webCookies.mockRejectedValueOnce(Object.assign(new Error('Synthetic revoked credential'), { eresult: 5 }))
    fixture.postReplies.push(success('100'), new Response('', { status: 401 }))
    const batch = start(fixture)
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', completed: 2, pending: 1, succeeded: 1, failed: 1 })
    expect(fixture.service.getAccountViews().find(account => account.id === accountA)?.sessionState).toBe('expired')
    expect(() => fixture.queue.resume(batch.id)).toThrow(/必须登录/)
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts(fixture)).toHaveLength(2)
    expect(fixture.store.getBatchSummary(batch.id)?.pending).toBe(1)
  })

  it('records an old in-flight 200 POST after a same-account background cookie refresh', async () => {
    const fixture = await createFixture(100)
    const posted = deferred<Response>()
    const refreshed = deferred<string[]>()
    fixture.postReplies.push(posted.promise)
    mocks.webCookies.mockImplementationOnce(() => refreshed.promise)
    const batch = start(fixture)
    await flush()
    expect(posts(fixture)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.webCookies).toHaveBeenCalledTimes(2)
    fixture.queue.pause(batch.id)
    refreshed.resolve(cookies(accountA, 'renewed'))
    await flush()
    posted.resolve(success('100'))
    await flush()

    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', succeeded: 1, uncertain: 0, pending: 2 })
    expect(posts(fixture)).toHaveLength(1)
  })

  it('discards a late recovery after switching accounts without changing the new account or old task', async () => {
    const fixture = await createFixture()
    const refreshed = deferred<string[]>()
    mocks.webCookies.mockImplementationOnce(() => refreshed.promise)
    fixture.postReplies.push(new Response('', { status: 401 }))
    const batch = start(fixture)
    await flush()
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', pending: 2 })
    const priorToken = fixture.store.getRefreshToken(accountA)
    mocks.sessions[0]!.refreshToken = 'synthetic-late-rotation'
    mocks.nextAccount = accountB
    await fixture.service.activateAccount(accountB)
    expect(fixture.service.isAuthenticated(accountB)).toBe(true)
    refreshed.resolve(cookies(accountA, 'obsolete'))
    await flush()

    expect(fixture.store.getActiveAccountId()).toBe(accountB)
    expect(fixture.service.isAuthenticated(accountB)).toBe(true)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.store.getRefreshToken(accountA)).toBe(priorToken)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', pending: 2 })
    expect(posts(fixture)).toHaveLength(1)
  })

  it('settles a late recovery after shutdown without reading or writing the closed database', async () => {
    const fixture = await createFixture()
    const refreshed = deferred<string[]>()
    mocks.webCookies.mockImplementationOnce(() => refreshed.promise)
    fixture.postReplies.push(new Response('', { status: 401 }))
    start(fixture)
    await flush()
    fixture.queue.shutdown()
    fixture.service.dispose()
    const read = vi.spyOn(fixture.store, 'getAccount')
    const persist = vi.spyOn(fixture.store, 'saveRefreshToken')
    const closedEvents = fixture.events.length
    fixture.store.close()
    fixture.closed = true
    refreshed.resolve(cookies(accountA, 'obsolete'))
    await flush()

    expect(read).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(fixture.events).toHaveLength(closedEvents)
    expect(posts(fixture)).toHaveLength(1)
  })
})

async function createFixture(keepAliveMs = 60_000): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'session-queue-integration-'))
  const store = new SqliteStore(join(directory, 'synthetic.sqlite3'), cipher)
  store.upsertAccount(account(accountA), 'synthetic-token-a')
  store.upsertAccount(account(accountB), 'synthetic-token-b')
  const events: AppEvent[] = []
  const postReplies: Fixture['postReplies'] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://steamcommunity.com') throw new Error('Real network access prohibited by fixture')
    if (init?.method === 'POST') {
      const next = postReplies.shift()
      if (!next || !url.pathname.startsWith('/comment/Profile/post/')) throw new Error('Unexpected synthetic POST')
      return next
    }
    if (url.pathname.endsWith('/edit/info')) {
      const id = url.pathname.split('/')[2]
      return new Response(`<script>g_steamID = "${id}";</script>`)
    }
    const commentTarget = /^\/profiles\/(7656119\d{10})\/$/.exec(url.pathname)?.[1]
    if (commentTarget && url.search === '?l=english') {
      const sender = /(?:^|;\s*)steamLoginSecure=(7656119\d{10})%7C/i.exec(new Headers(init?.headers).get('Cookie') ?? '')?.[1]
      if (!sender) throw new Error('Synthetic baseline has no authenticated sender')
      return emptyCommentProfile(sender, commentTarget)
    }
    if (url.searchParams.get('xml') === '1') {
      return new Response('<profile><steamID>Synthetic account</steamID><onlineState>online</onlineState></profile>')
    }
    if (url.pathname === '/textfilter/ajaxgetfriendslist') {
      return Response.json({ success: 1, friendslist: { friends: friendIds.map(ulfriendid => ({ ulfriendid, efriendrelationship: 3 })) } })
    }
    if (url.pathname.endsWith('/friends/')) {
      return new Response(friendIds.map(id => `<div class="friend_block_v2 online" data-steamid="${id}"><div class="friend_block_content">Synthetic friend</div></div>`).join(''))
    }
    if (url.pathname === '/actions/EmoticonList') return Response.json([])
    throw new Error(`Unexpected synthetic GET ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetch)
  let queue!: BatchQueue
  const service = new SteamService(store, event => events.push(event), id => queue.pauseForSessionExpiry(id), {
    keepAliveMs, retryDelaysMs: [60_000]
  })
  queue = new BatchQueue(store, service, event => events.push(event))
  const fixture: Fixture = { directory, store, service, queue, events, fetch, postReplies, closed: false }
  fixtures.push(fixture)
  const qr = await service.startQrLogin()
  mocks.sessions.at(-1)!.emit('authenticated')
  await flush()
  expect(events).toContainEqual(expect.objectContaining({ type: 'authFinished', loginId: qr.loginId, accountId: accountA }))
  expect(service.isAuthenticated(accountA)).toBe(true)
  expect(store.getFriends(accountA)).toHaveLength(3)
  return fixture
}

function start(fixture: Fixture) {
  return fixture.queue.start({ accountId: accountA, friendSteamIds: friendIds, messageTemplate: 'Synthetic comment', delayMs: 100, autoRetryEnabled: false })
}

function posts(fixture: Fixture) {
  return fixture.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
}

function success(id: string): Response {
  return Response.json({ success: true, comments_html: `<div id="comment_${id}"></div>` })
}

function cookies(accountId: string, suffix: string): string[] {
  return [`steamLoginSecure=${accountId}%7C%7Csynthetic-${suffix}; Path=/; Secure`, `sessionid=synthetic-${suffix}; Path=/; Secure`]
}

function account(id: string): AccountRecord {
  const now = new Date().toISOString()
  return { id, steamId: id, accountName: 'Synthetic account', displayName: 'Synthetic account', avatarUrl: '',
    createdAt: now, lastLoginAt: now, lastFriendSyncAt: now, lastEmoticonSyncAt: now }
}

async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
