import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientRequestConstructorOptions, IncomingMessage } from 'electron'
import { createSteamNetworkFetch, STEAM_NETWORK_REQUEST_LIMIT, STEAM_NETWORK_RESPONSE_LIMIT,
  STEAM_NETWORK_TIMEOUT_MS, type SteamRequestFactory } from '../src/main/steam-network-fetch'

class FakeRequest extends EventEmitter {
  aborted = false
  followRedirect = vi.fn()
  chunks: Buffer[] = []
  start: (() => void) | null = null
  write(chunk: Buffer | string): void { this.chunks.push(Buffer.from(chunk)) }
  end(): this { this.start?.(); return this }
  abort(): void { this.aborted = true; this.emit('abort'); this.emit('close') }
}

function fixture(start?: (request: FakeRequest) => void) {
  const request = new FakeRequest()
  request.start = () => start?.(request)
  const factory = vi.fn((_options: ClientRequestConstructorOptions) => request)
  return { request, factory, fetch: createSteamNetworkFetch(factory as unknown as SteamRequestFactory) }
}
function incoming(chunks: Iterable<Buffer> | AsyncIterable<Buffer> = [Buffer.from('{"result":1}')],
  fields: { statusCode?: number; headers?: Record<string, string | string[]> } = {}): IncomingMessage & Readable {
  return Object.assign(Readable.from(chunks), {
    statusCode: fields.statusCode ?? 200, statusMessage: 'OK', headers: fields.headers ?? { 'content-type': 'application/json' }
  }) as unknown as IncomingMessage & Readable
}
function outgoingHeaders(options: ClientRequestConstructorOptions): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry)
  }
  return headers
}
const api = 'https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1/'
const community = 'https://steamcommunity.com/login/settoken'
const reset = () => new Error('net::ERR_CONNECTION_RESET token=synthetic-private-value')
afterEach(() => vi.useRealTimers())

describe('isolated Chromium Steam fetch adapter', () => {
  it('encodes POST multipart bodies with the actual boundary and preserves distinct Set-Cookie values', async () => {
    const cookies = ['steamLoginSecure=synthetic-cookie; Path=/; Secure',
      'sessionid=synthetic-session; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/']
    const f = fixture(request => request.emit('response', incoming(undefined, { headers: { 'set-cookie': cookies } })))
    const form = new FormData()
    form.set('nonce', 'synthetic-nonce')
    form.set('steamID', '76561198000000001')
    const response = await f.fetch(community, { method: 'POST', redirect: 'error', body: form,
      headers: { 'Content-Type': 'multipart/form-data; boundary=wrong', 'User-Agent': 'synthetic-browser' } })
    expect(response.url).toBe(community)
    expect(response.headers.getSetCookie()).toEqual(cookies)
    expect(await response.json()).toEqual({ result: 1 })
    const options = f.factory.mock.calls[0]![0]
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit', useSessionCookies: false })
    const headers = outgoingHeaders(options)
    const boundary = headers.get('content-type')!.split('boundary=')[1]
    expect(boundary).toBeTruthy()
    expect(boundary).not.toBe('wrong')
    const bytes = Buffer.concat(f.request.chunks).toString('utf8')
    expect(bytes).toContain(`--${boundary}`)
    expect(bytes).toContain('name="nonce"\r\n\r\nsynthetic-nonce')
    expect(bytes).toContain('name="steamID"\r\n\r\n76561198000000001')
    expect(headers.get('user-agent')).toBe('synthetic-browser')
  })

  it.each([
    ['string', 'synthetic-body'], ['buffer', Buffer.from('synthetic-body')],
    ['parameters', new URLSearchParams({ nonce: 'synthetic-body' })]
  ])('supports finite %s POST payloads', async (_name, body) => {
    const f = fixture(request => request.emit('response', incoming()))
    await (await f.fetch(community, { method: 'POST', redirect: 'error', body: body as BodyInit })).text()
    expect(Buffer.concat(f.request.chunks).toString()).toContain('synthetic-body')
  })

  it.each([api, 'https://login.steampowered.com/jwt/finalizelogin', community])('never requests ambient cookies or forwards authentication headers to %s', async url => {
    const f = fixture(request => request.emit('response', incoming()))
    await (await f.fetch(url, { redirect: 'error', headers: {
      Cookie: 'sessionid=explicit-synthetic-cookie', Cookie2: 'private', Authorization: 'Bearer private',
      'Proxy-Authorization': 'private-proxy', Host: 'untrusted.invalid', 'Content-Length': '123', Connection: 'upgrade'
    } })).text()
    const options = f.factory.mock.calls[0]![0]
    expect(options).toMatchObject({ url, useSessionCookies: false, credentials: 'omit' })
    const headers = outgoingHeaders(options)
    expect(headers.get('cookie')).toBe(url === community ? 'sessionid=explicit-synthetic-cookie' : null)
    for (const name of ['cookie2', 'authorization', 'proxy-authorization', 'host', 'content-length', 'connection']) expect(headers.has(name)).toBe(false)
  })

  it('cancels a proxy authentication challenge without looking up or submitting credentials', async () => {
    const callback = vi.fn()
    const f = fixture(request => { request.emit('login', { isProxy: true }, callback); request.emit('response', incoming(undefined, { statusCode: 407 })) })
    const response = await f.fetch(api)
    expect(response.status).toBe(407)
    await response.text()
    expect(callback).toHaveBeenCalledExactlyOnceWith()
  })

  it('contains a failed native authentication callback rather than throwing from its event handler', async () => {
    const f = fixture(request => request.emit('login', { isProxy: true }, () => { throw reset() }))
    await expect(f.fetch(api)).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(f.request.aborted).toBe(true)
  })

  it('returns manual redirects and their cookies without following or uploading to the destination', async () => {
    const f = fixture(request => request.emit('redirect', 307, 'POST', 'https://untrusted.invalid/collect', {
      'set-cookie': ['sessionid=synthetic-one', 'synthetic-two=value'], location: ['https://untrusted.invalid/collect']
    }))
    const response = await f.fetch(community, { method: 'POST', body: 'synthetic-nonce', redirect: 'manual' })
    expect(response.status).toBe(307)
    expect(response.url).toBe(community)
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(response.headers.get('location')).toBe('https://untrusted.invalid/collect')
    expect(response.body).toBeNull()
    expect(f.request.followRedirect).not.toHaveBeenCalled()
    expect(f.request.aborted).toBe(true)
    expect(f.factory).toHaveBeenCalledOnce()
  })

  it('rejects redirects in error mode before following them', async () => {
    const f = fixture(request => request.emit('redirect', 302, 'GET', '/next', {}))
    await expect(f.fetch(community, { redirect: 'error' })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.request.followRedirect).not.toHaveBeenCalled()
    expect(f.request.aborted).toBe(true)
  })

  it.each([
    'http://steamcommunity.com/', 'https://untrusted.invalid/', 'https://steamcommunity.com.untrusted.invalid/',
    'https://steamcommunity.com:444/', 'https://user:secret@steamcommunity.com/', 'file:///private',
    'https://steamcommunity.com./'
  ])('rejects an untrusted URL before creating a request: %s', async url => {
    const f = fixture()
    await expect(f.fetch(url)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it('rejects unsupported methods, automatic redirects and unbounded or oversized uploads before network access', async () => {
    const f = fixture()
    const form = new FormData()
    form.set('nonce', 'x'.repeat(STEAM_NETWORK_REQUEST_LIMIT + 1))
    const attempts: RequestInit[] = [
      { method: 'PUT' }, { redirect: 'follow' }, { method: 'POST', body: new ReadableStream() },
      { method: 'POST', body: 'x'.repeat(STEAM_NETWORK_REQUEST_LIMIT + 1) }, { method: 'POST', body: form },
      { method: 'GET', body: 'not-allowed' }
    ]
    for (const init of attempts) await expect(f.fetch(community, init)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    await expect(f.fetch(new Request(community, { method: 'POST', body: 'synthetic', redirect: 'error' })))
      .rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it.each([
    ['ERR_CONNECTION_RESET', 'ECONNRESET'], ['ERR_CONNECTION_TIMED_OUT', 'ETIMEDOUT'],
    ['ERR_NAME_NOT_RESOLVED', 'ENOTFOUND'], ['ERR_PROXY_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED'],
    ['ERR_TUNNEL_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'],
    ['ERR_CERT_AUTHORITY_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
  ])('maps Chromium %s into a fixed safe code without retaining native details', async (native, code) => {
    const f = fixture(request => request.emit('error', new Error(`net::${native} https://private.invalid/?token=synthetic-private-value`)))
    await expect(f.fetch(api)).rejects.toMatchObject({ message: 'Steam network request failed', code })
    try { await f.fetch(api) } catch (error) { expect(JSON.stringify(error)).not.toContain('synthetic-private-value') }
  })

  it('sanitizes network errors while reading a response body', async () => {
    const f = fixture(request => request.emit('response', incoming((async function* () { yield Buffer.from('first'); throw reset() })())))
    const response = await f.fetch(api)
    await expect(response.arrayBuffer()).rejects.toMatchObject({ message: 'Steam network request failed', code: 'ECONNRESET' })
    expect(f.request.aborted).toBe(true)
  })

  it('does not invent a retryable socket code for unknown certificate or native failures', async () => {
    for (const message of ['net::ERR_CERT_REVOKED synthetic-private-value', 'Unknown native error synthetic-private-value']) {
      const f = fixture(request => request.emit('error', new Error(message)))
      try {
        await f.fetch(api)
        throw new Error('Expected a safe transport failure')
      } catch (error) {
        expect(error).toMatchObject({ message: 'Steam network request failed' })
        expect(error).not.toHaveProperty('code')
        expect(error).not.toHaveProperty('cause')
      }
    }
  })

  it('supports caller abort before headers and during a response body', async () => {
    const before = new AbortController()
    before.abort()
    const f = fixture()
    await expect(f.fetch(api, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.factory).not.toHaveBeenCalled()
    const waiting = new AbortController()
    const request = f.fetch(api, { signal: waiting.signal })
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce())
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    waiting.abort()
    await rejected
    expect(f.request.aborted).toBe(true)
    const body = new AbortController()
    const stream = fixture(request => request.emit('response', incoming((async function* () { yield Buffer.from('first'); await new Promise(() => undefined) })())))
    const response = await stream.fetch(api, { signal: body.signal })
    const reader = response.body!.getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('first')
    const pending = reader.read()
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    body.abort()
    await checked
    expect(stream.request.aborted).toBe(true)
  })

  it('closes a request whose factory synchronously aborts its caller signal', async () => {
    const signal = new AbortController()
    const request = new FakeRequest()
    const factory = vi.fn(() => { signal.abort(); return request })
    const fetch = createSteamNetworkFetch(factory as unknown as SteamRequestFactory)
    await expect(fetch(api, { signal: signal.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(request.aborted).toBe(true)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('enforces its own deadline before headers even when no caller signal is supplied', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = f.fetch(api)
    const checked = expect(request).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(STEAM_NETWORK_TIMEOUT_MS)
    await checked
    expect(f.request.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active through body consumption', async () => {
    vi.useFakeTimers()
    const f = fixture(request => request.emit('response', incoming((async function* () { yield Buffer.from('first'); await new Promise(() => undefined) })())))
    const response = await f.fetch(api)
    const reader = response.body!.getReader()
    await reader.read()
    const checked = expect(reader.read()).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(STEAM_NETWORK_TIMEOUT_MS)
    await checked
    expect(f.request.aborted).toBe(true)
  })

  it('cancels the native request when the consumer discards the response body', async () => {
    const f = fixture(request => request.emit('response', incoming((async function* () { yield Buffer.alloc(100); await new Promise(() => undefined) })())))
    const response = await f.fetch(api)
    await response.body!.cancel()
    expect(f.request.aborted).toBe(true)
  })

  it('does not buffer an unconsumed large response without backpressure', async () => {
    let produced = 0
    const f = fixture(request => request.emit('response', incoming((function* () {
      for (let index = 0; index < 1000; index++) { produced++; yield Buffer.alloc(65536) }
    })())))
    const response = await f.fetch(api)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(produced).toBeLessThanOrEqual(5)
    expect(produced).toBeGreaterThan(0)
    await response.body!.cancel()
  })

  it.each(['header', 'stream'])('rejects an oversized response %s and closes the request', async mode => {
    const f = fixture(request => request.emit('response', incoming([Buffer.alloc(STEAM_NETWORK_RESPONSE_LIMIT + 1)],
      mode === 'header' ? { headers: { 'content-length': String(STEAM_NETWORK_RESPONSE_LIMIT + 1) } } : {})))
    const checked = async () => (await f.fetch(api)).arrayBuffer()
    await expect(checked()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.request.aborted).toBe(true)
  })

  it('does not treat a writable-side close before headers as response failure', async () => {
    const f = fixture(request => { request.emit('close'); request.emit('response', incoming()) })
    expect(await (await f.fetch(api)).json()).toEqual({ result: 1 })
  })
})
