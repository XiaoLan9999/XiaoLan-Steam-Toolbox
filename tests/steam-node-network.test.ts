import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import type { RequestOptions } from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  agents: [] as Array<{ options: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }>
}))
vi.mock('node:https', () => ({
  Agent: class {
    destroy = vi.fn()
    constructor(readonly options: Record<string, unknown>) { mocks.agents.push(this) }
  },
  request: mocks.request
}))

import { createNodeSteamNetwork, isNodeSteamNetworkAllowed } from '../src/main/steam-node-network'

const community = 'https://steamcommunity.com/login/settoken'
const api = 'https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1/'
const login = 'https://login.steampowered.com/jwt/finalizelogin'
const networks: Array<ReturnType<typeof createNodeSteamNetwork>> = []

class FakeRequest extends EventEmitter {
  chunks: Buffer[] = []
  aborted = false
  followRedirect = vi.fn()
  start: (() => void) | undefined
  write = vi.fn((chunk: Buffer | string): void => { this.chunks.push(Buffer.from(chunk)) })
  end = vi.fn((): this => { this.start?.(); return this })
  abort = vi.fn((): void => { this.aborted = true; this.emit('abort'); this.emit('close') })
}

function incoming(body = 'synthetic-body', options: { statusCode?: number; headers?: Record<string, string | string[]> } = {}): Readable {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: options.statusCode ?? 200,
    statusMessage: 'Synthetic',
    headers: options.headers ?? { 'content-type': 'text/plain' }
  })
}

function issuedRequests(start?: (request: FakeRequest) => void): FakeRequest[] {
  const issued: FakeRequest[] = []
  mocks.request.mockImplementation((_url: string, _options: RequestOptions) => {
    const request = new FakeRequest()
    request.start = () => start?.(request)
    issued.push(request)
    return request
  })
  return issued
}

function network(): ReturnType<typeof createNodeSteamNetwork> {
  const value = createNodeSteamNetwork()
  networks.push(value)
  return value
}

function options(index = 0): RequestOptions {
  return mocks.request.mock.calls[index]![1] as RequestOptions
}

function headers(index = 0): Headers {
  return new Headers(options(index).headers as Record<string, string>)
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.agents.length = 0
  for (const key of Object.keys(process.env)) if (/^(?:https?|all)_proxy$/i.test(key)) vi.stubEnv(key, undefined)
})

afterEach(() => {
  for (const value of networks.splice(0)) value.dispose()
  vi.unstubAllEnvs()
})

describe('dedicated Node Steam fallback HTTPS transport', () => {
  it.each([api, login, community])('only submits approved HTTPS requests, with explicit certificate verification and a private bounded agent: %s', async url => {
    issuedRequests(request => request.emit('response', incoming()))
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const client = network()
    expect(await (await client.fetch(url)).text()).toBe('synthetic-body')
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
      method: 'GET', agent: mocks.agents[0], rejectUnauthorized: true
    }))
    expect(mocks.agents).toHaveLength(1)
    expect(mocks.agents[0]!.options).toEqual({ keepAlive: false, maxSockets: 4, maxTotalSockets: 4, timeout: 12_000 })
    expect(options()).not.toHaveProperty('session')
    expect(options()).not.toHaveProperty('auth')
    expect(options()).not.toHaveProperty('proxy')
    expect(options()).not.toHaveProperty('proxyEnv')
  })

  it('does not reuse another instance or ambient global-agent configuration', async () => {
    issuedRequests(request => request.emit('response', incoming()))
    const first = network(), second = network()
    await (await first.fetch(api)).text()
    await (await first.fetch(login)).text()
    await (await second.fetch(api)).text()
    expect(mocks.agents).toHaveLength(2)
    expect(options(0).agent).toBe(mocks.agents[0])
    expect(options(1).agent).toBe(mocks.agents[0])
    expect(options(2).agent).toBe(mocks.agents[1])
    expect(options(0).agent).not.toBe(options(2).agent)
  })

  it.each([api, login, community])('scopes explicit cookies to Steam Community and strips proxy/authentication headers: %s', async url => {
    issuedRequests(request => request.emit('response', incoming()))
    const client = network()
    await (await client.fetch(url, { headers: {
      Cookie: 'sessionid=explicit-synthetic-cookie', Cookie2: 'synthetic-private-cookie2',
      Authorization: 'Bearer synthetic-private-auth', 'Proxy-Authorization': 'Basic synthetic-private-proxy',
      Host: 'untrusted.invalid', Connection: 'upgrade', 'Proxy-Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked', 'Content-Length': '123', 'User-Agent': 'Synthetic Steam client'
    } })).text()
    expect(headers().get('cookie')).toBe(url === community ? 'sessionid=explicit-synthetic-cookie' : null)
    expect(headers().get('user-agent')).toBe('Synthetic Steam client')
    for (const key of ['cookie2', 'authorization', 'proxy-authorization', 'host', 'connection', 'proxy-connection', 'transfer-encoding', 'content-length']) {
      expect(headers().has(key)).toBe(false)
    }
    expect(JSON.stringify(options())).not.toContain('synthetic-private')
  })

  it('never creates or reads a cookie jar and never replays a Set-Cookie value implicitly', async () => {
    const cookies = ['steamLoginSecure=synthetic-private-login; Path=/; Secure', 'sessionid=synthetic-private-session; Path=/']
    issuedRequests(request => request.emit('response', incoming('synthetic', { headers: { 'set-cookie': cookies } })))
    const client = network()
    const first = await client.fetch(community)
    expect(first.headers.getSetCookie()).toEqual(cookies)
    await first.text()
    await (await client.fetch(community, { credentials: 'include' })).text()
    expect(headers(0).has('cookie')).toBe(false)
    expect(headers(1).has('cookie')).toBe(false)
    expect(options(0)).not.toHaveProperty('cookieJar')
    expect(options(1)).not.toHaveProperty('cookieJar')
  })

  it('declines an authentication challenge without supplying proxy credentials', async () => {
    const authenticate = vi.fn()
    issuedRequests(request => {
      request.emit('login', { isProxy: true, host: 'synthetic-private-proxy.invalid' }, authenticate)
      request.emit('response', incoming('Proxy authentication required', { statusCode: 407 }))
    })
    const client = network()
    const response = await client.fetch(api)
    expect(response.status).toBe(407)
    await response.text()
    expect(authenticate).toHaveBeenCalledExactlyOnceWith()
    expect(headers().has('proxy-authorization')).toBe(false)
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it.each([
    'http://steamcommunity.com/', 'http://api.steampowered.com/', 'https://untrusted.invalid/',
    'https://steamcommunity.com.untrusted.invalid/', 'https://subdomain.steamcommunity.com/',
    'https://steamcommunity.com./', 'https://steamcommunity.com:444/', 'https://secret:password@steamcommunity.com/',
    'file:///synthetic-private-path', 'data:text/plain,synthetic', 'not a URL'
  ])('rejects non-HTTPS or non-whitelisted targets before issuing a request: %s', async url => {
    issuedRequests()
    const client = network()
    await expect(client.fetch(url)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('does not follow redirects or transfer a POST body/cookies to their destinations', async () => {
    const issued = issuedRequests(request => request.emit('response', incoming('Redirect response', {
      statusCode: 307, headers: { location: 'https://untrusted.invalid/collect', 'set-cookie': ['sessionid=synthetic-redirect-cookie'] }
    })))
    const client = network()
    const response = await client.fetch(community, { method: 'POST', body: 'synthetic-secret-body', redirect: 'manual',
      headers: { Cookie: 'sessionid=synthetic-explicit-cookie' } })
    expect(response.status).toBe(307)
    expect(response.url).toBe(community)
    expect(response.headers.get('location')).toBe('https://untrusted.invalid/collect')
    expect(response.headers.getSetCookie()).toEqual(['sessionid=synthetic-redirect-cookie'])
    expect(await response.text()).toBe('Redirect response')
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.request.mock.calls[0]![0]).toBe(community)
    expect(Buffer.concat(issued[0]!.chunks).toString()).toBe('synthetic-secret-body')
    expect(issued[0]!.followRedirect).not.toHaveBeenCalled()
  })

  it('rejects redirect responses in error mode and rejects follow mode before making a request', async () => {
    const issued = issuedRequests(request => request.emit('response', incoming('', { statusCode: 302, headers: { location: login } })))
    const client = network()
    await expect(client.fetch(api, { redirect: 'error' })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(issued[0]!.aborted).toBe(true)
    expect(issued[0]!.followRedirect).not.toHaveBeenCalled()
    await expect(client.fetch(api, { redirect: 'follow' })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])('does not bypass a nonempty %s environment proxy, even with NO_PROXY=*', async key => {
    issuedRequests()
    const client = network()
    vi.stubEnv(key, 'http://synthetic-private-proxy.invalid:8080')
    vi.stubEnv('NO_PROXY', '*')
    expect(isNodeSteamNetworkAllowed()).toBe(false)
    await expect(client.fetch(api)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED',
      message: 'Direct Steam fallback is unavailable with a configured proxy' })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('checks environment proxies again for every request rather than only at construction', async () => {
    issuedRequests(request => request.emit('response', incoming()))
    const client = network()
    await (await client.fetch(api)).text()
    vi.stubEnv('HTTPS_PROXY', 'socks5://synthetic-private-proxy.invalid:1080')
    await expect(client.fetch(api)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(mocks.request).toHaveBeenCalledOnce()
    vi.stubEnv('HTTPS_PROXY', '  ')
    await (await client.fetch(api)).text()
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('recognizes all proxy environment names case-insensitively without treating NO_PROXY or empty values as routes', () => {
    expect(isNodeSteamNetworkAllowed({ hTtPs_PrOxY: 'synthetic-proxy' })).toBe(false)
    expect(isNodeSteamNetworkAllowed({ HTTP_PROXY: '\t proxy \n' })).toBe(false)
    expect(isNodeSteamNetworkAllowed({ NO_PROXY: '*', HTTP_PROXY: 'proxy' })).toBe(false)
    expect(isNodeSteamNetworkAllowed({ HTTP_PROXY: '', https_proxy: ' \t\n', ALL_PROXY: undefined, NO_PROXY: '*' })).toBe(true)
    expect(isNodeSteamNetworkAllowed({ npm_config_proxy: 'not-a-node-route-setting' })).toBe(true)
  })

  it('aborts only its owned in-flight requests and destroys its dedicated agent exactly once', async () => {
    const issued = issuedRequests()
    const first = network(), second = network()
    const firstResult = first.fetch(api), secondResult = second.fetch(login)
    const firstRejected = expect(firstResult).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(issued).toHaveLength(2))
    first.dispose()
    first.dispose()
    await firstRejected
    expect(issued[0]!.aborted).toBe(true)
    expect(issued[0]!.abort).toHaveBeenCalledOnce()
    expect(issued[1]!.aborted).toBe(false)
    expect(mocks.agents[0]!.destroy).toHaveBeenCalledOnce()
    expect(mocks.agents[1]!.destroy).not.toHaveBeenCalled()
    issued[1]!.emit('response', incoming('other instance remains active'))
    expect(await (await secondResult).text()).toBe('other instance remains active')
    await expect(first.fetch(api)).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('disposes while a response body is being consumed rather than allowing it to outlive the owned lifetime', async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 200, statusMessage: 'OK', headers: {} })
    const issued = issuedRequests(request => request.emit('response', stream))
    const client = network()
    const response = await client.fetch(api)
    const reader = response.body!.getReader()
    stream.write(Buffer.from('first'))
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('first')
    const rejected = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    client.dispose()
    await rejected
    expect(issued[0]!.aborted).toBe(true)
    expect(mocks.agents[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('supports a caller abort without disposing the agent or canceling other calls from the same instance', async () => {
    const issued = issuedRequests()
    const client = network()
    const caller = new AbortController()
    const firstResult = client.fetch(api, { signal: caller.signal })
    const secondResult = client.fetch(login)
    const rejected = expect(firstResult).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(issued).toHaveLength(2))
    caller.abort(new Error('synthetic-private-caller-reason'))
    await rejected
    expect(issued[0]!.aborted).toBe(true)
    expect(issued[1]!.aborted).toBe(false)
    expect(mocks.agents[0]!.destroy).not.toHaveBeenCalled()
    issued[1]!.emit('response', incoming('same instance remains active'))
    expect(await (await secondResult).text()).toBe('same instance remains active')
  })

  it('honors already-aborted callers and a signal inherited from a Request without making an extra network call', async () => {
    const issued = issuedRequests()
    const client = network()
    const before = new AbortController()
    before.abort()
    await expect(client.fetch(api, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.request).not.toHaveBeenCalled()
    const caller = new AbortController()
    const result = client.fetch(new Request(community, { redirect: 'manual', signal: caller.signal }))
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(issued).toHaveLength(1))
    caller.abort()
    await rejected
    expect(issued[0]!.aborted).toBe(true)
    expect(mocks.agents[0]!.destroy).not.toHaveBeenCalled()
  })

  it('sanitizes Node transport failures without retaining URLs, credentials or native messages', async () => {
    const issued = issuedRequests(request => request.emit('error', Object.assign(new Error('synthetic-private-token-and-path'), { code: 'ECONNRESET' })))
    const client = network()
    await expect(client.fetch(api)).rejects.toMatchObject({ message: 'Steam network request failed', code: 'ECONNRESET' })
    expect(issued[0]!.aborted).toBe(true)
    expect(mocks.request).toHaveBeenCalledOnce()
  })
})
