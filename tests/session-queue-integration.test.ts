import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SteamService } from '../src/main/steam-service'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AccountRecord, AppEvent } from '../src/shared/types'

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
  it.each([403, 429])('pauses an HTTP %s delivery without expiring the QR login or resending its POST', async status => {
    const fixture = await createFixture()
    fixture.postReplies.push(success('100'), new Response('Request denied', { status }), success('300'), success('400'))
    const batch = start(fixture)
    await vi.advanceTimersByTimeAsync(100)

    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', succeeded: 1,
      failed: status === 403 ? 0 : 1, pending: status === 403 ? 2 : 1 })
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(mocks.webCookies).toHaveBeenCalledTimes(1)
    expect(posts(fixture)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts(fixture)).toHaveLength(2)

    if (status === 403) {
      expect(() => fixture.queue.resume(batch.id)).toThrow('HTTP 403 冷却尚未结束')
      await vi.advanceTimersByTimeAsync(300_000)
    }
    fixture.queue.resume(batch.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed',
      succeeded: status === 403 ? 3 : 2, failed: status === 403 ? 0 : 1 })
    expect(new Set(posts(fixture).map(([url]) => String(url))).size).toBe(3)
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
