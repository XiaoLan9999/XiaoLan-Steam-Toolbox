import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient, type CommunityDiagnosticEvent } from '../src/main/community-client'
import { DomainError } from '../src/shared/domain'
import { emptyCommentProfile } from './helpers/comment-baseline'

const account = '76561198000000001'
const recipient = '76561198000000002'
const privateText = 'synthetic-private-diagnostic-canary'
const encoded = new TextEncoder()
type Reply = Response | (() => Response | Promise<Response>)

function fixture(reply: Reply, observer?: (event: CommunityDiagnosticEvent) => void) {
  const events: CommunityDiagnosticEvent[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    if (init?.method === 'POST') return typeof reply === 'function' ? reply() : reply
    return emptyCommentProfile(account, recipient)
  })
  const client = new SteamCommunityClient(account, [
    `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
    'sessionid=synthetic-session; Path=/; Secure; Domain=steamcommunity.com'
  ], () => undefined, event => { events.push(event); observer?.(event) }, fetch)
  return { client, events, fetch, post: () => client.postProfileComment(recipient, ':synthetic:') }
}

function failure(events: CommunityDiagnosticEvent[]) {
  return events.filter(event => event.phase === 'community-request' && event.outcome === 'request-failed')
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('safe Community request-stage diagnostics', () => {
  it('marks only the profile comment POST as an XMLHttpRequest without changing its form fields', async () => {
    const f = fixture(Response.json({ success: true, comments_html: '<div id="comment_101"></div>' }))
    await expect(f.post()).resolves.toEqual({ commentId: '101' })
    const posts = f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    const init = posts[0]![1]!
    const headers = new Headers(init.headers)
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest')
    expect(headers.has('x-prototype-version')).toBe(false)
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      comment: ':synthetic:', count: '6', sessionid: 'synthetic-session', feature2: '-1'
    })
    for (const [, get] of f.fetch.mock.calls.filter(([, options]) => options?.method !== 'POST')) {
      expect(new Headers(get?.headers).has('x-requested-with')).toBe(false)
    }
  })

  it('records a pre-header reset with an endpoint and safe code but no invented HTTP response', async () => {
    const error = Object.assign(new Error(privateText), { cause: { code: 'ECONNRESET', url: privateText } })
    const f = fixture(() => Promise.reject(error))
    await expect(f.post()).rejects.toBe(error)
    expect(failure(f.events)).toEqual([expect.objectContaining({ reason: 'transport-error',
      method: 'POST', endpoint: 'profile-comment', requestStage: 'request', networkCode: 'ECONNRESET' })])
    expect(failure(f.events)[0]).not.toHaveProperty('httpStatus')
    expect(failure(f.events)[0]!.elapsedMs).toEqual(expect.any(Number))
    expect(JSON.stringify(f.events)).not.toContain(privateText)
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('does not misclassify a complete HTTP 502 as a transport failure', async () => {
    const f = fixture(new Response(privateText, { status: 502 }))
    await expect(f.post()).rejects.toThrow('Steam HTTP error 502')
    expect(failure(f.events)).toEqual([expect.objectContaining({ reason: 'http-error',
      method: 'POST', endpoint: 'profile-comment', requestStage: 'validation', httpStatus: 502 })])
    expect(failure(f.events)[0]).not.toHaveProperty('networkCode')
    expect(JSON.stringify(f.events)).not.toContain(privateText)
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('distinguishes a body interruption after real response headers from a connect failure', async () => {
    const error = Object.assign(new Error(privateText), { code: 'ERR_CONNECTION_CLOSED' })
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoded.encode('{"success":'))
      controller.error(error)
    } })
    const f = fixture(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(f.post()).rejects.toThrow('Steam response interrupted')
    expect(failure(f.events)).toEqual([expect.objectContaining({ reason: 'response-read-error',
      method: 'POST', endpoint: 'profile-comment', requestStage: 'body', httpStatus: 200,
      networkCode: 'ERR_CONNECTION_CLOSED' })])
    expect(JSON.stringify(f.events)).not.toContain(privateText)
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('logs invalid JSON outside requestText using its actual status and parse stage', async () => {
    const f = fixture(new Response(privateText, { status: 201 }))
    await expect(f.post()).rejects.toThrow('Steam returned invalid JSON')
    expect(failure(f.events)).toEqual([expect.objectContaining({ reason: 'invalid-json',
      method: 'POST', endpoint: 'profile-comment', requestStage: 'parse-response', httpStatus: 201 })])
    expect(failure(f.events)[0]).not.toHaveProperty('networkCode')
    expect(JSON.stringify(f.events)).not.toContain(privateText)
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('recognizes its own 50-second deadline even when the transport replaces the abort reason', async () => {
    vi.useFakeTimers()
    const events: CommunityDiagnosticEvent[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method !== 'POST') return emptyCommentProfile(account, recipient)
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic generic cancellation', 'AbortError')), { once: true })
      })
    })
    const client = new SteamCommunityClient(account, [
      `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
      'sessionid=synthetic-session; Path=/; Secure; Domain=steamcommunity.com'
    ], () => undefined, event => events.push(event), fetch)
    const operation = client.postProfileComment(recipient, ':synthetic:')
    const checked = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(50_000)
    await checked
    expect(failure(events)).toEqual([expect.objectContaining({ reason: 'timeout', requestStage: 'request',
      endpoint: 'profile-comment', method: 'POST', networkCode: 'ETIMEDOUT', elapsedMs: expect.any(Number) })])
    expect(failure(events)[0]).not.toHaveProperty('httpStatus')
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('does not label an unrelated transport cancellation as the local timeout', async () => {
    const f = fixture(() => Promise.reject(new DOMException('Synthetic external cancellation', 'AbortError')))
    await expect(f.post()).rejects.toMatchObject({ name: 'AbortError' })
    expect(failure(f.events)[0]).toMatchObject({ reason: 'transport-error', requestStage: 'request' })
    expect(failure(f.events)[0]).not.toHaveProperty('networkCode')
    expect(failure(f.events)[0]).not.toHaveProperty('httpStatus')
  })

  it('preserves unknown network failures without disclosing private codes or error text', async () => {
    const error = Object.assign(new Error(privateText), { code: privateText, status: 500 })
    const f = fixture(() => Promise.reject(error))
    await expect(f.post()).rejects.toBe(error)
    const event = failure(f.events)[0]!
    expect(event).toMatchObject({ reason: 'transport-error', requestStage: 'request', endpoint: 'profile-comment' })
    expect(event).not.toHaveProperty('networkCode')
    expect(event).not.toHaveProperty('httpStatus')
    expect(JSON.stringify(f.events)).not.toContain(privateText)
  })

  it('records a response processing failure after headers without labelling it a connect failure', async () => {
    const f = fixture(new Response('{"success":1}'))
    const error = new Error(privateText)
    const internal = f.client as unknown as { requestText(path: string, init: RequestInit, redirects: number,
      current: () => void, validate: () => void, onResponse: () => void): Promise<string> }
    await expect(internal.requestText('/comment/Profile/post/' + recipient + '/-1/', { method: 'POST' }, 0,
      () => undefined, () => undefined, () => { throw error })).rejects.toBe(error)
    expect(failure(f.events)).toEqual([expect.objectContaining({ reason: 'response-processing-error',
      requestStage: 'headers', httpStatus: 200, endpoint: 'profile-comment' })])
    expect(JSON.stringify(f.events)).not.toContain(privateText)
  })

  it('preserves an explicit DomainError and does not alter success when an observer throws', async () => {
    const domain = new DomainError('SESSION_CHANGED', privateText)
    const rejected = fixture(() => Promise.reject(domain))
    await expect(rejected.post()).rejects.toBe(domain)
    expect(failure(rejected.events)).toEqual([])
    const successful = fixture(Response.json({ success: true, comments_html: '<div id="comment_101"></div>' }), () => { throw new Error(privateText) })
    await expect(successful.client.verifySession()).resolves.toBeUndefined()
    await expect(successful.post()).resolves.toEqual({ commentId: '101' })
    expect(successful.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('does not let a failing diagnostic observer replace the actual request failure', async () => {
    const error = Object.assign(new Error('Synthetic reset'), { code: 'ECONNRESET' })
    const f = fixture(() => Promise.reject(error), () => { throw new Error(privateText) })
    await expect(f.post()).rejects.toBe(error)
    expect(failure(f.events)).toHaveLength(1)
  })

  it('does not log a permitted same-origin redirect twice when only its final request fails', async () => {
    const events: CommunityDiagnosticEvent[] = []
    const error = Object.assign(new Error('Synthetic reset'), { code: 'ECONNRESET' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('', {
      status: 302, headers: { location: '/synthetic-destination' }
    })).mockRejectedValueOnce(error)
    const client = new SteamCommunityClient(account, [
      `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
      'sessionid=synthetic-session; Path=/; Secure; Domain=steamcommunity.com'
    ], () => undefined, event => events.push(event), fetch)
    const internal = client as unknown as { requestText(path: string, init: RequestInit, redirects: number): Promise<string> }
    await expect(internal.requestText('/synthetic-start', {}, 1)).rejects.toBe(error)
    expect(failure(events)).toHaveLength(1)
    expect(failure(events)[0]).toMatchObject({ reason: 'transport-error', requestStage: 'request', endpoint: 'other', networkCode: 'ECONNRESET' })
    expect(failure(events)[0]).not.toHaveProperty('httpStatus')
  })
})
