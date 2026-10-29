import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCommunityWebCookies, type CommunityWebSessionDiagnostic } from '../src/main/community-web-session'
import { SteamCommunityClient } from '../src/main/community-client'
import { STEAM_WEB_USER_AGENT } from '../src/main/steam-user-agent'
import { DomainError } from '../src/shared/domain'

const steamId = '76561198000000001'
const otherSteamId = '76561198000000002'
const refreshToken = 'synthetic-refresh-token'
const finalizeUrl = 'https://login.steampowered.com/jwt/finalizelogin'
const transferUrl = 'https://steamcommunity.com/login/settoken'
const secureCookie = `steamLoginSecure=${steamId}%7C%7Csynthetic-cookie; Path=/; Secure; Domain=steamcommunity.com`
const communityTransfer = () => ({ url: transferUrl, params: { nonce: 'synthetic-nonce', auth: 'synthetic-auth' } })
const finalizeBody = () => ({ steamID: steamId, transfer_info: [communityTransfer()] })
const json = (body: unknown, cookies: string[] = [], status = 200): Response => {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(body), { status, headers })
}
const reset = () => Object.assign(new Error('synthetic network failure'), { cause: { code: 'ECONNRESET' } })

function fixture(responses: Array<Response | Error | ((init: RequestInit) => Response | Promise<Response>)>) {
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const next = responses.shift()
    if (!next) throw new Error('Unexpected request; real networking is disabled')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(init!) : next
  })
  const controller = new AbortController()
  const events: CommunityWebSessionDiagnostic[] = []
  const run = () => getCommunityWebCookies(steamId, refreshToken, {
    signal: controller.signal, fetchImpl: fetchImpl as typeof fetch, onDiagnostic: event => events.push(event)
  })
  return { run, fetchImpl, controller, events }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Community-only WebBrowser session', () => {
  it('posts the official finalize and Community transfer only, then supplies one consistent local sessionid', async () => {
    const f = fixture([
      json({ ...finalizeBody(), transfer_info: [
        { url: 'https://store.steampowered.com/login/settoken', params: { nonce: 'synthetic-store', auth: 'synthetic-store' } },
        communityTransfer(),
        { url: 'https://help.steampowered.com/login/settoken', params: { nonce: 'synthetic-help', auth: 'synthetic-help' } },
        { url: 'https://checkout.steampowered.com/login/settoken', params: { nonce: 'synthetic-checkout', auth: 'synthetic-checkout' } }
      ] }, ['steamRefresh_steam=synthetic-refresh; Domain=login.steampowered.com; Secure']),
      json({ result: 1 }, [secureCookie, 'sessionid=server-session; Path=/; Secure; Domain=steamcommunity.com',
        'tracking=synthetic-tracking; Path=/; Secure; Domain=steamcommunity.com'])
    ])
    const cookies = await f.run()
    expect(f.fetchImpl.mock.calls.map(([input]) => input)).toEqual([finalizeUrl, transferUrl])
    const first = f.fetchImpl.mock.calls[0]![1]!
    expect(first.body).toBeInstanceOf(FormData)
    const form = first.body as FormData
    expect(form.get('nonce')).toBe(refreshToken)
    expect(form.get('redir')).toBe('https://steamcommunity.com/login/home/?goto=')
    expect(form.get('sessionid')).toMatch(/^[a-f0-9]{24}$/)
    const transferForm = f.fetchImpl.mock.calls[1]![1]!.body as FormData
    expect(Object.fromEntries(transferForm.entries())).toEqual({ steamID: steamId, nonce: 'synthetic-nonce', auth: 'synthetic-auth' })
    for (const [, init] of f.fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' })
      expect(init!.signal).toBeInstanceOf(AbortSignal)
      const headers = new Headers(init!.headers)
      expect(headers.get('user-agent')).toBe(STEAM_WEB_USER_AGENT)
      expect(headers.get('cookie')).toBeNull()
      expect(headers.get('authorization')).toBeNull()
    }
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain(`steamLoginSecure=${steamId}%7C%7Csynthetic-cookie`)
    expect(cookies[1]).toContain(`sessionid=${form.get('sessionid')}`)
    expect(cookies.every(cookie => cookie.includes('Domain=steamcommunity.com'))).toBe(true)
    expect(cookies.join(';')).not.toMatch(/synthetic-refresh|tracking|server-session/)
    expect(() => new SteamCommunityClient(steamId, cookies, vi.fn())).not.toThrow()
    expect(f.events.map(event => `${event.endpoint}:${event.outcome}`)).toEqual([
      'finalize:started', 'finalize:response', 'community-transfer:started', 'community-transfer:response'
    ])
  })

  it.each(['/login/settoken', '/login/transfer'])('accepts the exact Community endpoint %s with default HTTPS port', async path => {
    const f = fixture([json({ transfer_info: [{ ...communityTransfer(), url: `https://steamcommunity.com:443${path}` }] }),
      json({ result: 1 }, [secureCookie.replace('; Domain=steamcommunity.com', '')])])
    expect(await f.run()).toHaveLength(2)
    expect(f.fetchImpl.mock.calls[1]![0]).toBe(`https://steamcommunity.com${path}`)
  })

  it('uses the global fetch implementation when not explicitly injected', async () => {
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [secureCookie])])
    vi.stubGlobal('fetch', f.fetchImpl)
    expect(await getCommunityWebCookies(steamId, refreshToken, { signal: f.controller.signal })).toHaveLength(2)
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    'http://steamcommunity.com/login/settoken', 'https://steamcommunity.com:444/login/settoken',
    'https://steamcommunity.com/login/settoken?token=synthetic', 'https://steamcommunity.com/login/settoken#fragment',
    'https://steamcommunity.com/login/settoken/', 'https://steamcommunity.com/login/other',
    'https://user:password@steamcommunity.com/login/settoken', 'https://steamcommunity.com/other/../login/settoken',
    'https://steamcommunity.com/login/%73ettoken', 'https://steamcommunity.com\\@untrusted.invalid/login/settoken'
  ])('rejects non-canonical Community transfer target %s before forwarding any params', async url => {
    const f = fixture([json({ transfer_info: [{ ...communityTransfer(), url }] })])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://steamcommunity.com.untrusted.invalid/login/settoken', 'https://untrusted.invalid/login/settoken',
    'https://steamcommunity.com./login/settoken', 'https://store.steampowered.com/login/settoken'
  ])('does not forward credentials to an unneeded target %s', async url => {
    const f = fixture([json({ transfer_info: [{ ...communityTransfer(), url }] })])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    {}, { transfer_info: [] }, { transfer_info: 'invalid' }, { transfer_info: [null] },
    { transfer_info: [{ url: 42 }] }, { transfer_info: [communityTransfer(), communityTransfer()] },
    { steamID: otherSteamId, transfer_info: [communityTransfer()] },
    { transfer_info: Array.from({ length: 33 }, () => communityTransfer()) }
  ])('fails closed for malformed finalize response %#', async body => {
    const f = fixture([json(body)])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    null, [], {}, { nonce: 'synthetic' }, { nonce: 'synthetic', auth: '' },
    { nonce: 'synthetic', auth: 1 }, { nonce: 'synthetic', auth: 'synthetic', steamID: otherSteamId },
    { nonce: 'synthetic', auth: 'synthetic', redir: 'https://untrusted.invalid' },
    { nonce: 'synthetic', auth: 'synthetic\r\nheader' }, { nonce: 'synthetic', auth: 'x'.repeat(16_385) },
    JSON.parse('{"nonce":"synthetic","auth":"synthetic","__proto__":"synthetic"}')
  ].map(params => ({ params })))('rejects invalid or unsupported transfer params %#', async ({ params }) => {
    const f = fixture([json({ transfer_info: [{ ...communityTransfer(), params }] })])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('allows only an identical explicit steamID field from finalize params', async () => {
    const f = fixture([json({ transfer_info: [{ ...communityTransfer(),
      params: { ...communityTransfer().params, steamID: steamId } }] }), json({ result: 1 }, [secureCookie])])
    await f.run()
    expect((f.fetchImpl.mock.calls[1]![1]!.body as FormData).getAll('steamID')).toEqual([steamId])
  })

  it.each([
    [], [secureCookie.replace(steamId, otherSteamId)], [secureCookie.replace('synthetic-cookie', '')],
    [secureCookie.replace('%7C%7Csynthetic-cookie', '%zz')],
    [secureCookie.replace('Domain=steamcommunity.com', 'Domain=store.steampowered.com')],
    [secureCookie.replace('Domain=steamcommunity.com', 'Domain=steamcommunity.com.untrusted.invalid')],
    [secureCookie.replace('Path=/', 'Path=/login')], [secureCookie.replace('; Secure', '')],
    [`${secureCookie}; Secure`], [`${secureCookie}; Max-Age=0`], [`${secureCookie}; Max-Age=-1`],
    [`${secureCookie}; Max-Age=not-a-number`], [`${secureCookie}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`],
    [`${secureCookie}; Expires=invalid`], [`${secureCookie}\r\nsynthetic`],
    [secureCookie, secureCookie.replace('synthetic-cookie', 'different-cookie')]
  ].map(cookies => ({ cookies })))('does not accept missing, conflicting, expired, malformed or mismatched Community cookies %#', async ({ cookies }) => {
    const response = json({ result: 1 })
    vi.spyOn(response.headers, 'getSetCookie').mockReturnValue(cookies)
    const f = fixture([json(finalizeBody()), response])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('accepts an identical duplicate cookie and a leading-dot Community domain', async () => {
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [secureCookie,
      secureCookie.replace('Domain=steamcommunity.com', 'Domain=.steamcommunity.com')])])
    expect(await f.run()).toHaveLength(2)
  })

  it('preserves a validated absolute Cookie expiry rather than silently creating a session cookie', async () => {
    const expiry = new Date(Date.now() + 3_600_000).toUTCString()
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [`${secureCookie}; Expires=${expiry}`])])
    expect((await f.run())[0]).toContain(`; Expires=${expiry}`)
  })

  it('keeps the earliest duplicate expiry and gives Max-Age precedence over Expires', async () => {
    vi.useFakeTimers()
    const expiry = new Date(Date.now() + 60_000).toUTCString()
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [secureCookie,
      `${secureCookie}; Max-Age=120; Expires=Thu, 01 Jan 1970 00:00:00 GMT`, `${secureCookie}; Max-Age=60`])])
    expect((await f.run())[0]).toContain(`; Expires=${expiry}`)
  })

  it.each([403, 429, 500, 302])('does not retry HTTP %s or mistake it for cookie success', async status => {
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [secureCookie], status)])
    await expect(f.run()).rejects.toMatchObject({ statusCode: status })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(f.events.at(-1)).toMatchObject({ endpoint: 'community-transfer', outcome: 'failed', httpStatus: status })
  })

  it.each([5, 15, 27, 84])('preserves explicit Steam EResult %s without retrying or ignoring it', async eresult => {
    const f = fixture([json(finalizeBody()), json({ result: eresult }, [secureCookie])])
    await expect(f.run()).rejects.toMatchObject({ eresult })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(f.events.at(-1)).toMatchObject({ outcome: 'failed', eresult })
  })

  it('honors finalize error before submitting any Community transfer', async () => {
    const f = fixture([json({ ...finalizeBody(), error: 15 })])
    await expect(f.run()).rejects.toMatchObject({ eresult: 15 })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['1', null, 1.5, -1, 256])('does not silently accept malformed Steam result %#', async result => {
    const f = fixture([json(finalizeBody()), json({ result }, [secureCookie])])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries only the same pinned Community transfer after a transient reset, without re-finalizing', async () => {
    vi.useFakeTimers()
    const f = fixture([json(finalizeBody()), reset(), reset(), json({ result: 1 }, [secureCookie])])
    const promise = f.run()
    const checked = expect(promise).resolves.toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1500)
    await checked
    expect(f.fetchImpl.mock.calls.map(([input]) => input)).toEqual([finalizeUrl, transferUrl, transferUrl, transferUrl])
    const forms = f.fetchImpl.mock.calls.slice(1).map(([, init]) => Object.fromEntries((init!.body as FormData).entries()))
    expect(forms[0]).toEqual(forms[1])
    expect(forms[1]).toEqual(forms[2])
    expect(f.events.filter(event => event.outcome === 'failed')).toEqual([
      expect.objectContaining({ endpoint: 'community-transfer', networkCode: 'ECONNRESET' }),
      expect.objectContaining({ endpoint: 'community-transfer', networkCode: 'ECONNRESET' })
    ])
  })

  it('gives up after three transfer attempts, preserving only safe diagnostic codes', async () => {
    vi.useFakeTimers()
    const f = fixture([json(finalizeBody()), reset(), reset(), reset()])
    const checked = expect(f.run()).rejects.toMatchObject({ cause: { code: 'ECONNRESET' } })
    await vi.advanceTimersByTimeAsync(1500)
    await checked
    expect(f.fetchImpl).toHaveBeenCalledTimes(4)
    const encoded = JSON.stringify(f.events)
    expect(encoded).not.toMatch(/synthetic|steamcommunity|76561198|https|nonce|cookie|auth/)
  })

  it.each(['CERT_HAS_EXPIRED', 'ENOTFOUND', 'arbitrary-error'])('does not retry non-transient code %s', async code => {
    const f = fixture([json(finalizeBody()), Object.assign(new Error('synthetic'), { code })])
    await expect(f.run()).rejects.toMatchObject({ code })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry finalize resets automatically', async () => {
    const f = fixture([reset()])
    await expect(f.run()).rejects.toMatchObject({ cause: { code: 'ECONNRESET' } })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels before touching the transport', async () => {
    const f = fixture([])
    f.controller.abort(new Error('synthetic-private-abort-reason'))
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels an in-flight request even if an injected transport does not honor AbortSignal', async () => {
    const f = fixture([() => new Promise(() => undefined)])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    f.controller.abort(new Error('synthetic-private-abort-reason'))
    await checked
    expect(f.events.at(-1)).toMatchObject({ outcome: 'cancelled', reason: 'cancelled' })
    expect(JSON.stringify(f.events)).not.toContain('synthetic-private-abort-reason')
  })

  it('preserves the enclosing login deadline as timeout rather than misreporting user cancellation', async () => {
    const f = fixture([() => new Promise(() => undefined)])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_TIMEOUT' })
    f.controller.abort(new DomainError('LOGIN_ATTEMPT_TIMEOUT', 'Steam login timed out'))
    await checked
    expect(f.events.at(-1)).toMatchObject({ outcome: 'failed', reason: 'timeout' })
  })

  it('preserves the enclosing login deadline during retry backoff', async () => {
    vi.useFakeTimers()
    const f = fixture([json(finalizeBody()), reset()])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    f.controller.abort(new DomainError('LOGIN_ATTEMPT_TIMEOUT', 'Steam login timed out'))
    await checked
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a synchronous abort-and-reject transport without an unhandled rejection', async () => {
    const f = fixture([() => {
      f.controller.abort()
      return Promise.reject(reset())
    }])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels a late response body instead of resuming a cancelled login', async () => {
    let resolve!: (response: Response) => void
    const f = fixture([() => new Promise<Response>(done => { resolve = done })])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    f.controller.abort()
    await checked
    const cancel = vi.fn()
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await Promise.resolve()
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels during retry backoff and never performs the next transfer', async () => {
    vi.useFakeTimers()
    const f = fixture([json(finalizeBody()), reset()])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    await vi.advanceTimersByTimeAsync(100)
    f.controller.abort()
    await checked
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds each request at 30 seconds even for an unresponsive transport', async () => {
    vi.useFakeTimers()
    const f = fixture([() => new Promise(() => undefined)])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(30_000)
    await checked
    expect(f.events.at(-1)).toMatchObject({ endpoint: 'finalize', reason: 'timeout', networkCode: 'ETIMEDOUT' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds body reading with the same request deadline and cancels the stalled reader', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const f = fixture([new Response(body)])
    const checked = expect(f.run()).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(30_000)
    await checked
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    new Response('invalid-json'), new Response('[]'), new Response('null'),
    new Response(new Uint8Array([0xff])), new Response('{}', { headers: { 'content-length': '1048577' } }),
    new Response('{}', { headers: { 'content-length': '-1' } })
  ])('rejects invalid or oversized response framing %#', async response => {
    const f = fixture([response])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('limits streaming responses without trusting their missing or forged Content-Length', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)) }, cancel
    })
    const f = fixture([new Response(body, { headers: { 'content-length': '2' } })])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['redirected', 'url'])('rejects a transport response that violates redirect policy via %s', async property => {
    const response = json(finalizeBody())
    Object.defineProperty(response, property, { value: property === 'redirected' ? true : 'https://untrusted.invalid/' })
    const f = fixture([response])
    await expect(f.run()).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not let diagnostics callbacks break a valid login', async () => {
    const f = fixture([json(finalizeBody()), json({ result: 1 }, [secureCookie])])
    expect(await getCommunityWebCookies(steamId, refreshToken, { signal: f.controller.signal,
      fetchImpl: f.fetchImpl as typeof fetch, onDiagnostic: () => { throw new Error('synthetic observer failure') } })).toHaveLength(2)
  })

  it.each([
    ['', refreshToken], ['not-an-id', refreshToken], [steamId, ''], [steamId, 'synthetic\r\nheader'],
    [steamId, 'x'.repeat(32_769)]
  ])('rejects invalid inputs before networking %#', async (id, token) => {
    const f = fixture([])
    await expect(getCommunityWebCookies(id, token, { signal: f.controller.signal,
      fetchImpl: f.fetchImpl as typeof fetch })).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
})
