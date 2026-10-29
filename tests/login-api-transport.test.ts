import { afterEach, describe, expect, it, vi } from 'vitest'
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session'
import type { ApiRequest } from 'steam-session'
import { LoginApiTransport, type LoginApiDiagnostic } from '../src/main/login-api-transport'

const request = (apiMethod = 'PollAuthSessionStatus'): ApiRequest => ({
  apiInterface: 'Authentication', apiMethod, apiVersion: 1, requestData: Buffer.from([8, 123])
})
const response = (body: BodyInit | null = new Uint8Array([8, 1]), headers: HeadersInit = {}): Response =>
  new Response(body, { headers: { 'x-eresult': '1', 'content-type': 'application/octet-stream', ...headers } })
const reset = (): Error => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET', message: 'private-cookie' } })

afterEach(() => vi.useRealTimers())

describe('bounded Steam authentication API transport', () => {
  it('preserves the SDK POST protobuf multipart and browser headers on the fixed official endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    const transport = new LoginApiTransport({ fetchImpl })
    const result = await transport.sendRequest({ ...request('BeginAuthSessionViaQR'),
      headers: { origin: 'https://steamcommunity.com', 'user-agent': 'Synthetic browser', referer: 'https://steamcommunity.com' } })
    expect(result).toEqual({ result: 1, responseData: Buffer.from([8, 1]) })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaQR/v1/')
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) })
    expect((init!.body as FormData).get('input_protobuf_encoded')).toBe(Buffer.from([8, 123]).toString('base64'))
    expect((init!.headers as Headers).get('origin')).toBe('https://steamcommunity.com')
    expect((init!.headers as Headers).get('user-agent')).toBe('Synthetic browser')
  })

  it('preserves RSA GET protobuf query and access token without putting the payload in a body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    const transport = new LoginApiTransport({ fetchImpl })
    await transport.sendRequest({ ...request('GetPasswordRSAPublicKey'), accessToken: 'synthetic-access',
      headers: { cookie: 'mobileClientVersion=synthetic' } })
    const [url, init] = fetchImpl.mock.calls[0]!
    const parsed = new URL(String(url))
    expect(parsed.origin).toBe('https://api.steampowered.com')
    expect(parsed.searchParams.get('input_protobuf_encoded')).toBe('CHs=')
    expect(parsed.searchParams.get('access_token')).toBe('synthetic-access')
    expect(parsed.searchParams.get('origin')).toBe('SteamMobile')
    expect(init!.method).toBe('GET')
    expect(init!.body).toBeUndefined()
  })

  it('returns the SDK JSON and text response representations and fixed EResult headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response('{"response":{"synthetic":true}}', { 'content-type': 'application/json', 'x-eresult': '5', 'x-error_message': 'Synthetic rejection' }))
      .mockResolvedValueOnce(response('text-response', { 'content-type': 'text/plain' }))
    const transport = new LoginApiTransport({ fetchImpl })
    expect(await transport.sendRequest(request())).toEqual({ result: 5, errorMessage: 'Synthetic rejection', responseData: { response: { synthetic: true } } })
    expect(await transport.sendRequest(request())).toEqual({ result: 1, responseData: 'text-response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries only the same poll payload, with bounded delays and no credential data in diagnostics', async () => {
    vi.useFakeTimers()
    const events: LoginApiDiagnostic[] = []
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(reset()).mockRejectedValueOnce(reset()).mockResolvedValueOnce(response())
    const transport = new LoginApiTransport({ fetchImpl, onDiagnostic: event => events.push(event) })
    const result = transport.sendRequest(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1499)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ result: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toBe('https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1/')
      expect((init!.body as FormData).get('input_protobuf_encoded')).toBe('CHs=')
    }
    expect(events.map(event => event.outcome)).toEqual(['started', 'failed', 'started', 'failed', 'started', 'response'])
    expect(events.filter(event => event.outcome === 'failed')).toEqual([
      expect.objectContaining({ endpoint: 'poll', reason: 'network', networkCode: 'ECONNRESET' }),
      expect.objectContaining({ endpoint: 'poll', reason: 'network', networkCode: 'ECONNRESET' })
    ])
    expect(JSON.stringify(events)).not.toMatch(/private-cookie|input_protobuf|https:|CHs=/)
  })

  it('stops after two extra poll retries', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(reset())
    const result = new LoginApiTransport({ fetchImpl }).sendRequest(request())
    const rejection = expect(result).rejects.toMatchObject({ cause: { code: 'ECONNRESET' } })
    await vi.advanceTimersByTimeAsync(2000)
    await rejection
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it.each(['BeginAuthSessionViaQR', 'BeginAuthSessionViaCredentials', 'UpdateAuthSessionWithSteamGuardCode', 'GetPasswordRSAPublicKey', 'GenerateAccessTokenForApp'])(
    'does not replay %s after transport failure', async apiMethod => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(reset())
      await expect(new LoginApiTransport({ fetchImpl }).sendRequest(request(apiMethod))).rejects.toThrow('fetch failed')
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

  it.each([403, 429, 500, 302])('does not retry HTTP %s or follow redirects', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('untrusted-body', { status, headers: { location: 'https://untrusted.invalid/' } }))
    const events: LoginApiDiagnostic[] = []
    await expect(new LoginApiTransport({ fetchImpl, onDiagnostic: event => events.push(event) }).sendRequest(request()))
      .rejects.toMatchObject({ code: status })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ outcome: 'failed', httpStatus: status })
    expect(JSON.stringify(events)).not.toMatch(/untrusted|https:/)
  })

  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND'])('does not retry a persistent certificate or DNS error %s', async code => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code } }))
    await expect(new LoginApiTransport({ fetchImpl }).sendRequest(request())).rejects.toThrow('fetch failed')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('allows cancellation during retry delay without a new request or aborting a shared owner', async () => {
    vi.useFakeTimers()
    const owner = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(reset())
    const transport = new LoginApiTransport({ signal: owner.signal, fetchImpl })
    const result = transport.sendRequest(request())
    const rejection = expect(result).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    await vi.advanceTimersByTimeAsync(0)
    transport.close()
    await rejection
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(owner.signal.aborted).toBe(false)
    fetchImpl.mockResolvedValue(response())
    await expect(transport.sendRequest(request('GetPasswordRSAPublicKey'))).resolves.toMatchObject({ result: 1 })
  })

  it('cancels an in-flight fetch even if an injected implementation ignores the signal', async () => {
    const owner = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined))
    const transport = new LoginApiTransport({ signal: owner.signal, fetchImpl })
    const result = transport.sendRequest(request('BeginAuthSessionViaQR'))
    const rejection = expect(result).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    transport.close()
    await rejection
    owner.abort()
    await expect(transport.sendRequest(request())).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('enforces the 30-second deadline through a stalled response body', async () => {
    vi.useFakeTimers()
    const events: LoginApiDiagnostic[] = []
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: cancelled })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(stream))
    const result = new LoginApiTransport({ fetchImpl, onDiagnostic: event => events.push(event) }).sendRequest(request('BeginAuthSessionViaQR'))
    const rejection = expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection
    expect(cancelled).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ outcome: 'failed', reason: 'timeout', networkCode: 'ETIMEDOUT' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each(['header', 'stream'])('rejects an oversized %s response without retrying', async kind => {
    const big = new Uint8Array(1024 * 1024 + 1)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(big, kind === 'header' ? { 'content-length': String(big.length) } : {}))
    await expect(new LoginApiTransport({ fetchImpl }).sendRequest(request())).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects unsupported method, request type, version and oversized protobuf before any network', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const transport = new LoginApiTransport({ fetchImpl })
    for (const invalid of [
      { ...request(), apiInterface: 'Private' }, { ...request(), apiMethod: '../Private' },
      { ...request(), apiVersion: 2 }, { ...request(), requestData: 'private-token' },
      { ...request(), requestData: Buffer.alloc(1024 * 1024 + 1) }
    ]) await expect(transport.sendRequest(invalid)).rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not let diagnostic observer errors affect the transport', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    await expect(new LoginApiTransport({ fetchImpl, onDiagnostic: () => { throw new Error('synthetic observer') } })
      .sendRequest(request())).resolves.toMatchObject({ result: 1 })
  })

  it('keeps a real SDK QR attempt alive after one failed poll without reissuing the QR request', async () => {
    vi.useFakeTimers()
    const challenge = Buffer.from('https://example.invalid/synthetic-challenge')
    const interval = Buffer.alloc(5)
    interval[0] = 0x25
    interval.writeFloatLE(5, 1)
    const qr = Buffer.concat([
      Buffer.from([8, 123, 0x12, challenge.length]), challenge,
      Buffer.from([0x1a, 2, 1, 2]), interval,
      Buffer.from([0x2a, 2, 8, EAuthSessionGuardType.DeviceConfirmation])
    ])
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(qr))
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(response(new Uint8Array([0x28, 1])))
    const transport = new LoginApiTransport({ fetchImpl })
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, { transport })
    const errors = vi.fn()
    const interacted = vi.fn()
    session.on('error', errors)
    session.on('remoteInteraction', interacted)
    try {
      const qrResult = await session.startWithQR()
      expect(qrResult.qrChallengeUrl).toBe(challenge.toString('utf8'))
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(interacted).toHaveBeenCalledOnce()
      expect(errors).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(3)
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('BeginAuthSessionViaQR'))).toHaveLength(1)
      const polls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('PollAuthSessionStatus'))
      expect((polls[0]![1]!.body as FormData).get('input_protobuf_encoded'))
        .toBe((polls[1]![1]!.body as FormData).get('input_protobuf_encoded'))
    } finally {
      session.cancelLoginAttempt()
      transport.close()
      await vi.advanceTimersByTimeAsync(2000)
    }
  })
})
