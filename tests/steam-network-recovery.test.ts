import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSteamNetworkRecovery, getSteamNetworkResponseTiming, type SteamNetworkRecoveryOptions, type SteamNetworkRecoveryRoute,
  type SteamNetworkRouteKind } from '../src/main/steam-network-recovery'
import type { SteamNetworkDiagnostic } from '../src/shared/steam-network-diagnostics'

const community = 'https://steamcommunity.com/profiles/76561198000000001/edit/info'
const api = 'https://api.steampowered.com/IAuthenticationService/GetPasswordRSAPublicKey/v1/?input_protobuf_encoded=synthetic'
const closed = () => Object.assign(new Error('synthetic-private-network-error'), { code: 'ERR_CONNECTION_CLOSED' })
const reset = () => Object.assign(new Error('synthetic-private-network-error'), { code: 'ECONNRESET' })
const pending = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const resources: Array<{ dispose(): void }> = []
function fixture(options: Partial<Omit<SteamNetworkRecoveryOptions, 'createRoute' | 'onDiagnostic'>> = {}) {
  const events: SteamNetworkDiagnostic[] = []
  const kinds: SteamNetworkRouteKind[] = []
  const routes = new Map<SteamNetworkRouteKind, SteamNetworkRecoveryRoute & {
    fetch: ReturnType<typeof vi.fn<typeof fetch>>; dispose: ReturnType<typeof vi.fn<SteamNetworkRecoveryRoute['dispose']>>;
    resolveProxy: ReturnType<typeof vi.fn<SteamNetworkRecoveryRoute['resolveProxy']>>
  }>()
  for (const kind of ['system', 'fresh-system', 'direct', 'node-direct'] as const) {
    routes.set(kind, { fetch: vi.fn<typeof fetch>().mockImplementation(async () => new Response(kind)),
      dispose: vi.fn<SteamNetworkRecoveryRoute['dispose']>(), resolveProxy: vi.fn<SteamNetworkRecoveryRoute['resolveProxy']>().mockResolvedValue('DIRECT') })
  }
  const createRoute = vi.fn((kind: SteamNetworkRouteKind) => { kinds.push(kind); return routes.get(kind)! })
  const recovery = createSteamNetworkRecovery({ createRoute, nodeDirectAllowed: () => true,
    onDiagnostic: event => events.push(event), ...options })
  resources.push(recovery)
  return { recovery, events, createRoute, kinds, routes, route: (kind: SteamNetworkRouteKind) => routes.get(kind)! }
}
afterEach(() => { for (const resource of resources.splice(0)) resource.dispose(); vi.useRealTimers() })

describe('bounded Steam network route recovery', () => {
  it.each(['ajaxop', 'multiajaxop'])('does not replay a state-changing mobile confirmation GET %s', async endpoint => {
    const f = fixture(); f.route('system').fetch.mockRejectedValue(reset())
    await expect(f.recovery.fetch(`https://steamcommunity.com/mobileconf/${endpoint}?op=allow`)).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(f.kinds).toEqual(['system']); expect(f.route('system').fetch).toHaveBeenCalledOnce()
  })
  it('keeps healthy routes sticky per host instead of letting a successful API call reset Community', async () => {
    const f = fixture()
    f.route('system').fetch.mockImplementation(async input => {
      if (String(input).startsWith('https://steamcommunity.com/')) throw closed()
      return new Response('system-api')
    })
    expect(await (await f.recovery.fetch(community)).text()).toBe('fresh-system')
    expect(await (await f.recovery.fetch(community + '?synthetic=2')).text()).toBe('fresh-system')
    expect(await (await f.recovery.fetch(api)).text()).toBe('system-api')
    expect(f.route('system').fetch).toHaveBeenCalledTimes(2)
    expect(f.route('fresh-system').fetch).toHaveBeenCalledTimes(2)
    expect(f.kinds).toEqual(['system', 'fresh-system'])
    expect(f.events.filter(event => event.stage === 'route-success').map(event => event.route))
      .toEqual(['fresh-system', 'fresh-system', 'system'])
    expect(JSON.stringify(f.events)).not.toMatch(/7656119|input_protobuf|synthetic-private/)
  })

  it('uses four separate routes only after prior safe attempts have stopped', async () => {
    const f = fixture()
    for (const kind of ['system', 'fresh-system', 'direct'] as const) f.route(kind).fetch.mockRejectedValue(closed())
    expect(await (await f.recovery.fetch(community)).text()).toBe('node-direct')
    expect(f.kinds).toEqual(['system', 'fresh-system', 'direct', 'node-direct'])
    expect(f.route('system').resolveProxy.mock.calls.every(([url]) => url === community)).toBe(true)
    const requests = f.events.filter(event => event.stage === 'route-request')
    expect(requests.map(event => event.attempt)).toEqual([1, 2, 3, 4])
    expect(requests.map(event => event.route)).toEqual(f.kinds)
  })

  it.each(['PROXY synthetic.invalid:8080', 'SOCKS5 synthetic.invalid:1080', 'DIRECT; PROXY synthetic.invalid:8080', '', 'direct'])(
    'does not bypass a system proxy decision %s', async proxy => {
      const f = fixture()
      f.route('system').fetch.mockRejectedValue(closed())
      f.route('fresh-system').fetch.mockRejectedValue(closed())
      f.route('system').resolveProxy.mockResolvedValue(proxy)
      await expect(f.recovery.fetch(community)).rejects.toMatchObject({ code: 'ERR_CONNECTION_CLOSED' })
      expect(f.kinds).toEqual(['system', 'fresh-system'])
      expect(f.events.at(-1)).toMatchObject({ stage: 'route-skipped', route: 'direct', proxyMode: 'proxy' })
      expect(JSON.stringify(f.events)).not.toContain('synthetic.invalid')
    })

  it('fails closed when system proxy resolution fails or environment proxy rules block Node', async () => {
    const f = fixture({ nodeDirectAllowed: () => false })
    for (const kind of ['system', 'fresh-system', 'direct'] as const) f.route(kind).fetch.mockRejectedValue(closed())
    await expect(f.recovery.fetch(community)).rejects.toMatchObject({ code: 'ERR_CONNECTION_CLOSED' })
    expect(f.kinds).toEqual(['system', 'fresh-system', 'direct'])
    expect(f.events.at(-1)).toMatchObject({ stage: 'route-skipped', route: 'node-direct' })
    const other = fixture()
    other.route('system').fetch.mockRejectedValue(reset())
    other.route('fresh-system').fetch.mockRejectedValue(reset())
    other.route('system').resolveProxy.mockRejectedValue(new Error('synthetic-private-proxy'))
    await expect(other.recovery.fetch(community)).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(other.kinds).toEqual(['system', 'fresh-system'])
    expect(other.events.at(-1)).toMatchObject({ stage: 'route-skipped', proxyMode: 'unknown' })
  })

  it('rechecks proxy rules before reusing a direct route and follows a newly configured system proxy', async () => {
    const f = fixture()
    f.route('system').fetch.mockRejectedValue(closed())
    f.route('fresh-system').fetch.mockRejectedValueOnce(closed())
    expect(await (await f.recovery.fetch(community)).text()).toBe('direct')
    f.route('system').resolveProxy.mockResolvedValue('PROXY synthetic.invalid:8080')
    const directCalls = f.route('direct').fetch.mock.calls.length
    expect(await (await f.recovery.fetch(community)).text()).toBe('fresh-system')
    expect(f.route('direct').fetch).toHaveBeenCalledTimes(directCalls)
    expect(f.route('node-direct').fetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://steamcommunity.com/comment/Profile/post/76561198000000002/-1/',
    'https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaCredentials/v1/',
    'https://api.steampowered.com/IAuthenticationService/UpdateAuthSessionWithSteamGuardCode/v1/',
    'https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaQR/v1/'
  ])('does not replay unsafe POST %s even when it fails before headers', async url => {
    const f = fixture()
    f.route('system').fetch.mockRejectedValue(reset())
    await expect(f.recovery.fetch(url, { method: 'POST', body: 'synthetic' })).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(f.route('system').fetch).toHaveBeenCalledOnce()
    expect(f.kinds).toEqual(['system'])
  })

  it('preserves the old unsafe POST deadline instead of cutting it off after 12 seconds', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const reply = pending<Response>()
    f.route('system').fetch.mockReturnValue(reply.promise)
    const request = f.recovery.fetch('https://steamcommunity.com/comment/Profile/post/76561198000000002/-1/', { method: 'POST', body: 'synthetic' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.route('system').fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false)
    reply.resolve(new Response('synthetic-post-result'))
    expect(await (await request).text()).toBe('synthetic-post-result')
    expect(f.kinds).toEqual(['system'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    'https://login.steampowered.com/jwt/finalizelogin', 'https://steamcommunity.com/login/settoken',
    'https://steamcommunity.com/login/transfer',
    'https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1/'
  ])('can replay the same finite authentication payload only for %s', async url => {
    const f = fixture()
    f.route('system').fetch.mockRejectedValueOnce(closed())
    const body = new FormData()
    body.set('nonce', 'synthetic-private-nonce')
    await (await f.recovery.fetch(url, { method: 'POST', body,
      headers: { 'Content-Type': 'multipart/form-data; boundary=wrong' } })).text()
    const first = f.route('system').fetch.mock.calls[0]![1]!
    const second = f.route('fresh-system').fetch.mock.calls[0]![1]!
    expect(Buffer.from(first.body as Uint8Array).equals(Buffer.from(second.body as Uint8Array))).toBe(true)
    expect(new Headers(first.headers).get('content-type')).toBe(new Headers(second.headers).get('content-type'))
    expect(new Headers(first.headers).get('content-type')).not.toContain('boundary=wrong')
    expect(Buffer.from(second.body as Uint8Array).toString()).toContain('synthetic-private-nonce')
    expect(JSON.stringify(f.events)).not.toContain('synthetic-private-nonce')
  })

  it.each([403, 429, 500])('returns HTTP %s without a different route or a replay', async status => {
    const f = fixture()
    f.route('system').fetch.mockImplementation(async () => new Response('synthetic-http-denial', { status }))
    const response = await f.recovery.fetch(community)
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('synthetic-http-denial')
    expect(f.kinds).toEqual(['system'])
  })

  it.each(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO'])(
    'does not treat the TLS failure %s as permission to switch routes', async code => {
      const f = fixture()
      f.route('system').fetch.mockRejectedValue(Object.assign(new Error('synthetic-tls'), { code }))
      await expect(f.recovery.fetch(community)).rejects.toMatchObject({ code })
      expect(f.kinds).toEqual(['system'])
    })

  it('recovers a safe response-body reset only after cancelling the previous attempt', async () => {
    const f = fixture()
    let aborted = false
    f.route('system').fetch.mockImplementation(async (_url, init) => {
      init!.signal!.addEventListener('abort', () => { aborted = true })
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(reset()) } }))
    })
    f.route('fresh-system').fetch.mockImplementation(async () => {
      expect(aborted).toBe(true)
      return new Response('synthetic-recovered')
    })
    expect(await (await f.recovery.fetch(community)).text()).toBe('synthetic-recovered')
    expect(f.kinds).toEqual(['system', 'fresh-system'])
  })

  it('does not replay a non-success HTTP response whose body later breaks', async () => {
    const f = fixture()
    f.route('system').fetch.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(reset()) }
    }), { status: 403 }))
    const response = await f.recovery.fetch(community)
    await expect(response.text()).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(f.kinds).toEqual(['system'])
  })

  it('preserves response cookies and logical URL after a successful bounded safe read', async () => {
    const f = fixture()
    const headers = new Headers()
    headers.append('set-cookie', 'synthetic-one=one; Expires=Tue, 01 Jan 2030 00:00:00 GMT')
    headers.append('set-cookie', 'synthetic-two=two')
    f.route('system').fetch.mockImplementation(async () => {
      const response = new Response('synthetic', { headers })
      Object.defineProperty(response, 'url', { value: community })
      return response
    })
    const response = await f.recovery.fetch(community)
    expect(response.url).toBe(community)
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(await response.text()).toBe('synthetic')
  })

  it('retains actual header timing while buffering a delayed body, without exposing a mutable timing setter', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'))
    const f = fixture()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const native = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller
      controller.enqueue(new TextEncoder().encode('synthetic-first'))
    } }))
    f.route('system').fetch.mockResolvedValue(native)
    const request = f.recovery.fetch(community)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(250)
    stream.enqueue(new TextEncoder().encode('-last'))
    stream.close()
    const response = await request
    const timing = getSteamNetworkResponseTiming(response)!
    expect(timing.receivedAt).toBe(Date.parse('2026-11-08T00:00:00.000Z'))
    expect(Date.now() - timing.receivedAt).toBe(250)
    expect(Number.isFinite(timing.receivedMonotonic)).toBe(true)
    timing.receivedAt = 0
    expect(getSteamNetworkResponseTiming(response)!.receivedAt).not.toBe(0)
    expect(getSteamNetworkResponseTiming(native)).toBeUndefined()
    expect(getSteamNetworkResponseTiming(new Response('synthetic-forged'))).toBeUndefined()
    expect(await response.text()).toBe('synthetic-first-last')
    expect(Object.keys(response)).not.toContain('receivedMonotonic')
  })

  it('does not attach buffered timing to an unsafe streaming POST response', async () => {
    const f = fixture()
    const native = new Response('synthetic-comment-result')
    f.route('system').fetch.mockResolvedValue(native)
    const response = await f.recovery.fetch('https://steamcommunity.com/comment/Profile/post/76561198000000002/-1/', {
      method: 'POST', body: 'synthetic-comment'
    })
    expect(response).toBe(native)
    expect(response.bodyUsed).toBe(false)
    expect(getSteamNetworkResponseTiming(response)).toBeUndefined()
  })

  it('does not start a new attempt while the previous fetch ignores cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture({ attemptTimeoutMs: 10, stopTimeoutMs: 5 })
    f.route('system').fetch.mockReturnValue(new Promise(() => undefined))
    const request = f.recovery.fetch(community)
    const checked = expect(request).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(20)
    await checked
    expect(f.kinds).toEqual(['system'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors external cancellation and disposal without sending a fallback request', async () => {
    const f = fixture()
    f.route('system').fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(reset()), { once: true })
    }))
    const controller = new AbortController()
    const request = f.recovery.fetch(community, { signal: controller.signal })
    const checked = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.route('system').fetch).toHaveBeenCalledOnce())
    controller.abort()
    await checked
    expect(f.kinds).toEqual(['system'])
    f.recovery.dispose()
    f.recovery.dispose()
    expect(f.route('system').dispose).toHaveBeenCalledOnce()
    await expect(f.recovery.fetch(community)).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
  })

  it('keeps the combined safe-request budget bounded across all fallback attempts', async () => {
    vi.useFakeTimers()
    const f = fixture({ budgetMs: 250, attemptTimeoutMs: 100, stopTimeoutMs: 5 })
    for (const route of f.routes.values()) route.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    const request = f.recovery.fetch(community)
    const checked = expect(request).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(300)
    await checked
    expect(f.kinds).toEqual(['system', 'fresh-system', 'direct'])
    expect(f.route('node-direct').fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects unsupported origins, protocols, credentials and methods before any request', async () => {
    const f = fixture()
    for (const input of ['http://steamcommunity.com/', 'https://untrusted.invalid/',
      'https://private:secret@steamcommunity.com/', 'https://steamcommunity.com:444/']) {
      await expect(f.recovery.fetch(input)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    }
    await expect(f.recovery.fetch(community, { method: 'DELETE' })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    await expect(f.recovery.fetch(community, { redirect: 'follow' })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.route('system').fetch).not.toHaveBeenCalled()
  })

  it('freezes the validated URL and payload before a safe retry, even if caller-owned objects change', async () => {
    const f = fixture()
    const url = new URL('https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1/')
    const original = url.href
    const headers = new Headers({ 'x-synthetic': 'original' })
    const body = new FormData()
    body.set('input_protobuf_encoded', 'synthetic-original')
    f.route('system').fetch.mockImplementation(async (_input, init) => {
      url.href = 'https://steamcommunity.com/comment/Profile/post/76561198000000002/-1/'
      headers.set('x-synthetic', 'changed')
      body.set('input_protobuf_encoded', 'changed')
      ;(init!.headers as Headers).set('x-synthetic', 'route-mutated')
      ;(init!.body as Uint8Array).fill(0)
      throw reset()
    })
    await f.recovery.fetch(url, { method: 'POST', headers, body })
    const [target, sent] = f.route('fresh-system').fetch.mock.calls[0]!
    expect(target).toBe(original)
    expect(new Headers(sent!.headers).get('x-synthetic')).toBe('original')
    expect(Buffer.from(sent!.body as Uint8Array).toString()).toContain('synthetic-original')
    expect(Buffer.from(sent!.body as Uint8Array).toString()).not.toContain('changed')
  })

  it('preserves original Request method and headers and rejects an implicit streaming Request body', async () => {
    const f = fixture()
    const get = new Request(community, { redirect: 'manual', headers: { 'x-synthetic': 'original' } })
    await f.recovery.fetch(get)
    expect(f.route('system').fetch.mock.calls[0]![0]).toBe(community)
    expect(f.route('system').fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(f.route('system').fetch.mock.calls[0]![1]!.headers).get('x-synthetic')).toBe('original')
    const post = new Request('https://steamcommunity.com/comment/Profile/post/76561198000000002/-1/', {
      method: 'POST', body: 'synthetic', redirect: 'manual'
    })
    await expect(f.recovery.fetch(post)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    await expect(f.recovery.fetch(new Request(community))).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.route('system').fetch).toHaveBeenCalledOnce()
  })
})
