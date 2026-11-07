import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SteamService } from '../src/main/steam-service'
import type { SteamServiceOptions } from '../src/main/steam-service'
import type { SqliteStore } from '../src/main/store'
import type { AccountRecord, AppEvent } from '../src/shared/types'
import type { LoginDiagnosticEvent } from '../src/shared/diagnostics'

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const services: SteamService[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected real network access') }))
})

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('account recovery with synthetic Steam responses only', () => {
  it('keeps candidate cookies and one private network through two temporary identity GET failures', async () => {
    const fixture = createFixture()
    fixture.probe.mockResolvedValueOnce(new Response('<html>Temporary incomplete page</html>'))
      .mockRejectedValueOnce(networkError())
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(900)
    await restoring
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(fixture.probe).toHaveBeenCalledTimes(3)
    expect(fixture.networks).toHaveLength(1)
    expect(fixture.networks[0]!.dispose).not.toHaveBeenCalled()
    expect(fixture.calls.filter(call => call.method === 'POST').map(call => call.path))
      .toEqual(['/jwt/finalizelogin', '/login/settoken'])
    const probeCookies = fixture.calls.filter(call => call.path.endsWith('/edit/info')).map(call => call.cookie)
    expect(new Set(probeCookies).size).toBe(1)
    expect(probeCookies[0]).toContain('synthetic-cookie-1')
    expect(fixture.diagnostics.filter(event => event.stage === 'session-verify' && event.outcome === 'failed')).toHaveLength(2)
    expect(fixture.calls.some(call => call.path.includes('/comment/'))).toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('stops fast verification after three attempts and preserves credentials for the outer retry', async () => {
    const fixture = createFixture()
    fixture.probe.mockRejectedValue(networkError())
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(1200)
    await restoring
    expect(fixture.probe).toHaveBeenCalledTimes(3)
    expect(fixture.networks).toHaveLength(1)
    expect(fixture.networks[0]!.dispose).toHaveBeenCalledOnce()
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.service.getAccountViews()[0]).toMatchObject({ sessionState: 'restoring', sessionRetryAttempt: 1 })
    expect(fixture.store.getRefreshToken(accountA)).toBe(fixture.tokens.get(accountA))
    await vi.advanceTimersByTimeAsync(4999)
    expect(fixture.networks).toHaveLength(1)
    expect(fixture.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  })

  it.each([
    ['403', () => Promise.resolve(new Response('{}', { status: 403 }))],
    ['429', () => Promise.resolve(new Response('', { status: 429 }))],
    ['expired cookie', () => Promise.resolve(new Response('', { status: 401 }))],
    ['identity mismatch', () => Promise.resolve(identity(accountB))],
    ['explicit rejection', () => Promise.reject(Object.assign(new Error('Synthetic refusal'), { eresult: 15 }))],
    ['certificate failure', () => Promise.reject(Object.assign(new Error('Synthetic certificate failure'), { code: 'CERT_HAS_EXPIRED' }))],
    ['protocol failure', () => Promise.reject(Object.assign(new Error('Synthetic protocol failure'), { code: 'EPROTO' }))]
  ] as const)('does not fast retry %s', async (_name, response) => {
    const fixture = createFixture()
    fixture.probe.mockImplementationOnce(response)
    await fixture.service.restoreActiveAccount()
    expect(fixture.probe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1200)
    expect(fixture.probe).toHaveBeenCalledOnce()
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.store.getRefreshToken(accountA)).toBe(fixture.tokens.get(accountA))
  })

  it.each(['dispose', 'switch'] as const)('cancels verification backoff immediately on %s', async change => {
    const fixture = createFixture()
    fixture.probe.mockRejectedValueOnce(networkError())
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    if (change === 'dispose') fixture.service.dispose()
    else await fixture.service.activateAccount(accountB)
    await restoring
    const probes = fixture.probe.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.probe).toHaveBeenCalledTimes(probes)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.networks[0]!.dispose).toHaveBeenCalledOnce()
    if (change === 'switch') expect(fixture.service.isAuthenticated(accountB)).toBe(true)
    else expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cookie exchange and identity verification by one deadline and ignores late GET success', async () => {
    const fixture = createFixture({ loginAttemptTimeoutMs: 500 })
    const finalize = deferred<Response>()
    const probe = deferred<Response>()
    fixture.finalize.mockReturnValueOnce(finalize.promise)
    fixture.probe.mockReturnValueOnce(probe.promise)
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(400)
    finalize.resolve(finalizeResponse(accountA))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.probe).toHaveBeenCalledOnce()
    const signal = fixture.probe.mock.calls[0]![1].signal!
    await vi.advanceTimersByTimeAsync(99)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await restoring
    expect(signal.aborted).toBe(true)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.networks[0]!.dispose).toHaveBeenCalledOnce()
    expect(fixture.diagnostics.filter(event => ['failed', 'timeout', 'cancelled'].includes(event.stage)))
      .toEqual([expect.objectContaining({ stage: 'timeout', outcome: 'failed', elapsedMs: 500 })])
    probe.resolve(identity(accountA))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  })

  it('cancels an in-flight identity GET on account switch without waiting for its adapter', async () => {
    const fixture = createFixture()
    const pending = deferred<Response>()
    fixture.probe.mockReturnValueOnce(pending.promise)
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(0)
    const signal = fixture.probe.mock.calls[0]![1].signal!
    await fixture.service.activateAccount(accountB)
    await restoring
    expect(signal.aborted).toBe(true)
    pending.resolve(identity(accountA))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.service.isAuthenticated(accountB)).toBe(true)
    expect(fixture.networks[0]!.dispose).toHaveBeenCalledOnce()
    expect(fixture.diagnostics.filter(event => event.attempt === 1 && event.stage === 'completed')).toHaveLength(0)
  })

  it.each([502, 503, 504])('respects a short Retry-After on read-only HTTP %s', async status => {
    const fixture = createFixture()
    fixture.probe.mockResolvedValueOnce(new Response('', { status, headers: { 'retry-after': '2' } }))
    const restoring = fixture.service.restoreActiveAccount()
    await vi.advanceTimersByTimeAsync(1999)
    expect(fixture.probe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await restoring
    expect(fixture.probe).toHaveBeenCalledTimes(2)
    expect(fixture.networks).toHaveLength(1)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
  })

  it('preserves a server cooldown longer than the current deadline instead of starting a fresh exchange early', async () => {
    const fixture = createFixture()
    fixture.probe.mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '90' } }))
    await fixture.service.restoreActiveAccount()
    expect(fixture.probe).toHaveBeenCalledOnce()
    expect(fixture.service.getAccountViews()[0]).toMatchObject({ sessionState: 'restoring', sessionRetryBlocked: true,
      sessionRetryAt: new Date(Date.now() + 90_000).toISOString() })
    await fixture.service.activateAccount(accountA)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(fixture.networks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.networks).toHaveLength(2)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
  })

  it('keeps the existing verified runtime and its cookies after candidate renewal GET failures', async () => {
    const fixture = createFixture()
    await fixture.service.restoreActiveAccount()
    fixture.probe.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError())
    const renewal = fixture.service.getArtworkWebCookies(accountA)
    const failed = expect(renewal).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    await vi.advanceTimersByTimeAsync(1200)
    await failed
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(fixture.expired).not.toHaveBeenCalled()
    expect(fixture.networks).toHaveLength(1)
    expect(fixture.networks[0]!.dispose).not.toHaveBeenCalled()
    await fixture.service.verifyCommentSession(accountA)
    expect(fixture.calls.at(-1)!.cookie).toContain('synthetic-cookie-1')
    expect(fixture.calls.filter(call => call.path.endsWith('/edit/info'))[1]!.cookie).toContain('synthetic-cookie-2')
    expect(fixture.store.getRefreshToken(accountA)).toBe(fixture.tokens.get(accountA))
    expect(fixture.calls.some(call => call.path.includes('/comment/'))).toBe(false)
  })

  it('keeps trusted renewal cookies during an interrupted candidate verification and cancels it on disposal', async () => {
    const fixture = createFixture()
    await fixture.service.restoreActiveAccount()
    const pending = deferred<Response>()
    fixture.probe.mockReturnValueOnce(pending.promise)
    const renewal = fixture.service.getArtworkWebCookies(accountA)
    const failed = expect(renewal).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    const signal = fixture.probe.mock.calls.at(-1)![1].signal!
    fixture.service.dispose()
    await failed
    expect(signal.aborted).toBe(true)
    pending.resolve(new Response(null))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.service.isAuthenticated(accountA)).toBe(false)
    expect(fixture.networks[0]!.dispose).toHaveBeenCalledOnce()
    // The real SDK defers its transport close by two seconds after cancellation.
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors long renewal Retry-After without discarding the trusted runtime or exchanging cookies early', async () => {
    const fixture = createFixture({ keepAliveMs: 300_000 })
    await fixture.service.restoreActiveAccount()
    fixture.probe.mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '90' } }))
    await expect(fixture.service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    await expect(fixture.service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    await fixture.service.activateAccount(accountA)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(fixture.finalize).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.finalize).toHaveBeenCalledTimes(3)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
  })

  it('does not bypass a renewal cooldown after a subsequently confirmed cookie expiry', async () => {
    const fixture = createFixture({ keepAliveMs: 300_000 })
    await fixture.service.restoreActiveAccount()
    fixture.probe.mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '90' } }))
    await expect(fixture.service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    fixture.probe.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(fixture.service.verifyCommentSession(accountA)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    await expect(fixture.service.activateAccount(accountA)).rejects.toMatchObject({ code: 'SESSION_RETRY_COOLDOWN' })
    expect(fixture.finalize).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fixture.finalize).toHaveBeenCalledTimes(3)
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
  })

  it('blocks an unbounded renewal wait without a timer, a revoked token or an early explicit retry', async () => {
    const fixture = createFixture()
    await fixture.service.restoreActiveAccount()
    fixture.probe.mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '999999999999999999999' } }))
    await expect(fixture.service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    expect(fixture.service.isAuthenticated(accountA)).toBe(true)
    expect(fixture.service.getAccountViews()[0]).toMatchObject({ sessionRetryBlocked: true, sessionMessage: expect.stringContaining('等待时间超出') })
    expect(vi.getTimerCount()).toBe(0)
    await expect(fixture.service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    await fixture.service.activateAccount(accountA)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fixture.finalize).toHaveBeenCalledTimes(2)
    expect(fixture.store.getRefreshToken(accountA)).toBe(fixture.tokens.get(accountA))
  })

  it.each(['finalize', 'transfer'] as const)('distinguishes explicit %s rejection from refresh-token rejection', async stage => {
    const fixture = createFixture()
    const reject = () => Promise.resolve(Response.json({ result: 21 }))
    if (stage === 'finalize') fixture.finalize.mockImplementationOnce(reject)
    else fixture.transfer.mockImplementationOnce(reject)
    await fixture.service.restoreActiveAccount()
    expect(fixture.service.getAccountViews()[0]!.sessionState).toBe(stage === 'finalize' ? 'expired' : 'restoring')
    expect(fixture.probe).not.toHaveBeenCalled()
    expect(fixture.store.getRefreshToken(accountA)).toBe(fixture.tokens.get(accountA))
  })
})

function networkError(): Error { return Object.assign(new Error('Synthetic connection reset'), { code: 'ECONNRESET' }) }
function identity(accountId: string): Response { return new Response(`<script>g_steamID="${accountId}";</script>`) }
function finalizeResponse(accountId: string): Response {
  return Response.json({ steamID: accountId, transfer_info: [{ url: 'https://steamcommunity.com/login/settoken',
    params: { auth: 'synthetic-auth', nonce: 'synthetic-nonce' } }] })
}

function createFixture(options: SteamServiceOptions = {}) {
  const tokens = new Map([accountA, accountB].map(id => [id, [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, aud: ['derive', 'web'], exp: 4_000_000_000 })).toString('base64url'),
    Buffer.from('synthetic-signature').toString('base64url')].join('.')]))
  const timestamp = new Date().toISOString()
  const accounts = [accountA, accountB].map(id => ({ id, steamId: id, accountName: 'Synthetic', displayName: 'Synthetic',
    avatarUrl: '', createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: timestamp } satisfies AccountRecord))
  let active = accountA
  const store = {
    getActiveAccountId: () => active,
    setActiveAccountId: (id: string) => { active = id },
    getAccount: (id: string) => accounts.find(account => account.id === id) ?? null,
    getAccounts: () => accounts,
    getRefreshToken: (id: string) => tokens.get(id) ?? null,
    getSecretStorageInfo: () => ({ available: false, backend: 'synthetic' }),
    updateAccountProfile: vi.fn()
  } as unknown as SqliteStore
  const probe = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(async url => identity(url.pathname.split('/')[2]!))
  const finalize = vi.fn<(accountId: string) => Promise<Response>>(async id => finalizeResponse(id))
  let cookieSequence = 0
  const transfer = vi.fn<(accountId: string) => Promise<Response>>(async id => Response.json({ result: 1 }, { headers: {
    'set-cookie': `steamLoginSecure=${id}%7C%7Csynthetic-cookie-${++cookieSequence}; Path=/; Secure; Domain=steamcommunity.com`
  } }))
  const calls: Array<{ method: string; path: string; cookie: string | null }> = []
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init.method ?? 'GET'
    calls.push({ method, path: url.pathname, cookie: new Headers(init.headers).get('cookie') })
    if (url.href === 'https://login.steampowered.com/jwt/finalizelogin') {
      const token = (init.body as FormData).get('nonce')
      return finalize(token === tokens.get(accountB) ? accountB : accountA)
    }
    if (url.href === 'https://steamcommunity.com/login/settoken') return transfer(String((init.body as FormData).get('steamID')))
    if (url.origin === 'https://steamcommunity.com' && url.pathname.endsWith('/edit/info') && method === 'GET') return probe(url, init)
    if (url.origin === 'https://steamcommunity.com' && url.searchParams.get('xml') === '1' && method === 'GET') {
      return new Response('<profile><steamID>Synthetic</steamID><onlineState>online</onlineState></profile>')
    }
    throw new Error('Unexpected synthetic route; external networking forbidden')
  }
  const events: AppEvent[] = []
  const diagnostics: LoginDiagnosticEvent[] = []
  const expired = vi.fn()
  const networks: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const service = new SteamService(store, event => events.push(event), expired, {
    ...options,
    onLoginDiagnostic: event => diagnostics.push(event),
    createNetwork: () => {
      const network = { fetch: fetchImpl, transport: 'chromium' as const, dispose: vi.fn() }
      networks.push(network)
      return network
    }
  })
  services.push(service)
  return { service, store, tokens, probe, finalize, transfer, networks, calls, events, diagnostics, expired }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
