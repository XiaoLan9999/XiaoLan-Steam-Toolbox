import { Readable } from 'node:stream'
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron'
import { DomainError } from '../shared/domain'

export type SteamRequestFactory = (options: ClientRequestConstructorOptions) => Pick<ClientRequest, 'on' | 'end' | 'abort' | 'write'>

export const STEAM_NETWORK_REQUEST_LIMIT = 2 * 1024 * 1024
export const STEAM_NETWORK_RESPONSE_LIMIT = 8 * 1024 * 1024
export const STEAM_NETWORK_TIMEOUT_MS = 55_000
const HOSTS = new Set(['api.steampowered.com', 'login.steampowered.com', 'steamcommunity.com'])
const ERROR_CODES: Record<string, string> = {
  ERR_CONNECTION_RESET: 'ECONNRESET', ERR_CONNECTION_REFUSED: 'ECONNREFUSED',
  ERR_CONNECTION_ABORTED: 'ECONNABORTED', ERR_CONNECTION_CLOSED: 'ERR_CONNECTION_CLOSED',
  ERR_TIMED_OUT: 'ETIMEDOUT', ERR_CONNECTION_TIMED_OUT: 'ETIMEDOUT',
  ERR_NAME_NOT_RESOLVED: 'ENOTFOUND', ERR_DNS_TIMED_OUT: 'EAI_AGAIN',
  ERR_INTERNET_DISCONNECTED: 'ENETDOWN', ERR_ADDRESS_UNREACHABLE: 'EHOSTUNREACH',
  ERR_NETWORK_CHANGED: 'ECONNRESET', ERR_EMPTY_RESPONSE: 'ERR_SOCKET_CLOSED',
  ERR_SSL_PROTOCOL_ERROR: 'EPROTO', ERR_SSL_VERSION_OR_CIPHER_MISMATCH: 'EPROTO',
  ERR_CERT_AUTHORITY_INVALID: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ERR_CERT_COMMON_NAME_INVALID: 'ERR_TLS_CERT_ALTNAME_INVALID', ERR_CERT_DATE_INVALID: 'CERT_HAS_EXPIRED',
  ERR_PROXY_CONNECTION_FAILED: 'ERR_PROXY_CONNECTION_FAILED', ERR_TUNNEL_CONNECTION_FAILED: 'ERR_TUNNEL_CONNECTION_FAILED'
}
const SAFE_CODES = new Set([...Object.values(ERROR_CODES), 'ENETUNREACH', 'EPIPE'])

function invalid(): DomainError { return new DomainError('SESSION_CHECK_FAILED', 'Invalid Steam network request or response') }
function cancelled(): DOMException { return new DOMException('Steam network request cancelled', 'AbortError') }
function timeout(): Error { return Object.assign(new Error('Steam network request timed out'), { code: 'ETIMEDOUT' }) }
function networkError(error: unknown): Error {
  let code: unknown, message: unknown
  try {
    if (error && typeof error === 'object') {
      code = (error as { code?: unknown }).code
      message = (error as { message?: unknown }).message
    }
  } catch { /* Native errors are projected to fixed public categories only. */ }
  const nativeCode = typeof code === 'string' && SAFE_CODES.has(code) ? code
    : typeof code === 'string' && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code]
      : typeof message === 'string' ? /\b(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1] : undefined
  const safeCode = nativeCode && SAFE_CODES.has(nativeCode) ? nativeCode
    : nativeCode && Object.hasOwn(ERROR_CODES, nativeCode) ? ERROR_CODES[nativeCode] : undefined
  const result = new Error('Steam network request failed')
  return safeCode ? Object.assign(result, { code: safeCode }) : result
}

function headersForResponse(values: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  let count = 0
  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (++count > 256 || typeof entry !== 'string' || entry.length > 32_768) throw invalid()
      headers.append(name, entry)
    }
  }
  return headers
}

function limitedBody(body: BodyInit | null | undefined): void {
  if (body === undefined || body === null) return
  let size: number
  if (typeof body === 'string') size = Buffer.byteLength(body)
  else if (body instanceof URLSearchParams) size = Buffer.byteLength(body.toString())
  else if (body instanceof Blob) size = body.size
  else if (body instanceof ArrayBuffer) size = body.byteLength
  else if (ArrayBuffer.isView(body)) size = body.byteLength
  else if (body instanceof FormData) {
    size = 0
    let entries = 0
    for (const [name, value] of body.entries()) {
      if (++entries > 1024) throw invalid()
      size += Buffer.byteLength(name) + (typeof value === 'string' ? Buffer.byteLength(value) : value.size)
      if (size > STEAM_NETWORK_REQUEST_LIMIT) throw invalid()
    }
  } else throw invalid()
  if (size > STEAM_NETWORK_REQUEST_LIMIT) throw invalid()
}

async function readEncodedBody(request: Request, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let length = 0, complete = false
  try {
    for (;;) {
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = (): void => reject(signal.reason)
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        void reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
      })
      if (result.done) { complete = true; break }
      length += result.value.byteLength
      if (length > STEAM_NETWORK_REQUEST_LIMIT) throw invalid()
      chunks.push(Buffer.from(result.value))
    }
    return Buffer.concat(chunks, length)
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

// The factory must bind an isolated in-memory Session; never use a browser cookie jar.
export function createSteamNetworkFetch(requestFactory: SteamRequestFactory): typeof fetch {
  return async (input, init): Promise<Response> => {
    const original = input instanceof Request ? input : null
    let url: URL
    try { url = new URL(original?.url ?? String(input)) } catch { throw invalid() }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw invalid()
    const method = (init?.method ?? original?.method ?? 'GET').toUpperCase()
    const redirect = init?.redirect ?? (original ? original.redirect : 'error')
    if (!['GET', 'POST'].includes(method) || !['manual', 'error'].includes(redirect)) throw invalid()
    const parent = init?.signal ?? original?.signal
    if (parent?.aborted) throw cancelled()
    limitedBody(init?.body)
    // Request streams cannot establish a finite upload size before sending credentials.
    if (original?.body && init?.body === undefined) throw invalid()
    let headers: Headers
    try { headers = new Headers(init?.headers ?? original?.headers) } catch { throw invalid() }
    for (const name of ['authorization', 'proxy-authorization', 'cookie2', 'host', 'content-length',
      'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']) headers.delete(name)
    if (url.hostname !== 'steamcommunity.com') headers.delete('cookie')
    if ((headers.get('cookie')?.length ?? 0) > 32_768) throw invalid()
    if (init?.body instanceof FormData) headers.delete('content-type')
    const deadline = new AbortController()
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal
    const timer = setTimeout(() => deadline.abort(timeout()), STEAM_NETWORK_TIMEOUT_MS)
    timer.unref?.()
    let encoded: Request, upload: Buffer | undefined
    try {
      encoded = new Request(original?.url ?? url.href, { ...init, method, headers, signal, redirect: 'manual', credentials: 'omit' })
      upload = await readEncodedBody(encoded, signal)
      if (signal.aborted) throw signal.reason
    } catch (error) {
      clearTimeout(timer)
      if (parent?.aborted) throw cancelled()
      if (deadline.signal.aborted) throw timeout()
      throw error instanceof DomainError ? error : invalid()
    }

    return new Promise<Response>((resolve, reject) => {
      let request: ReturnType<SteamRequestFactory> | undefined
      let finished = false, receivedHeaders = false, responseBytes = 0
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
      const abortRequest = (): void => { try { request?.abort() } catch { /* The request may already be closed. */ } }
      const fail = (error: Error): void => {
        if (finished) return
        finished = true
        cleanup()
        if (controller) controller.error(error)
        if (!receivedHeaders) reject(error)
        abortRequest()
        if (reader) void reader.cancel().catch(() => undefined)
      }
      const onAbort = (): void => fail(parent?.aborted ? cancelled() : timeout())
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      try {
        request = requestFactory({ url: url.href, method, redirect: 'manual', credentials: 'omit',
          useSessionCookies: false, headers: Object.fromEntries(encoded.headers.entries()) })
        request.on('error', error => fail(networkError(error)))
        request.on('abort', () => fail(networkError({ code: 'ECONNABORTED' })))
        request.on('login', (_info, callback) => {
          try { callback() } catch (error) { fail(networkError(error)) }
        })
        request.on('redirect', (status, _nextMethod, location, values) => {
          if (finished) return
          if (redirect === 'error') { fail(invalid()); return }
          try {
            const responseHeaders = headersForResponse(values)
            if (!responseHeaders.has('location')) responseHeaders.set('location', location)
            const response = new Response(null, { status, headers: responseHeaders })
            Object.defineProperty(response, 'url', { value: url.href })
            finished = true
            receivedHeaders = true
            cleanup()
            resolve(response)
            abortRequest()
          } catch { fail(invalid()) }
        })
        request.on('response', (incoming: IncomingMessage) => {
          incoming.on('error', error => fail(networkError(error)))
          incoming.on('aborted', () => fail(networkError({ code: 'ECONNABORTED' })))
          if (finished) { abortRequest(); return }
          try {
            const responseHeaders = headersForResponse(incoming.headers)
            const length = responseHeaders.get('content-length')
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > STEAM_NETWORK_RESPONSE_LIMIT)) throw invalid()
            reader = (Readable.toWeb(incoming as unknown as Readable, {
              strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength }
            }) as ReadableStream<Uint8Array>).getReader()
            const body = new ReadableStream<Uint8Array>({
              start(value) { controller = value },
              async pull(value) {
                try {
                  const chunk = await reader!.read()
                  if (finished) return
                  if (chunk.done) { finished = true; cleanup(); value.close(); return }
                  if (!(chunk.value instanceof Uint8Array)) throw invalid()
                  responseBytes += chunk.value.byteLength
                  if (responseBytes > STEAM_NETWORK_RESPONSE_LIMIT) throw invalid()
                  value.enqueue(chunk.value)
                } catch (error) { fail(error instanceof DomainError ? error : networkError(error)) }
              },
              async cancel() {
                if (finished) return
                finished = true
                cleanup()
                abortRequest()
                await reader!.cancel().catch(() => undefined)
              }
            }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength })
            if (redirect === 'error' && incoming.statusCode >= 300 && incoming.statusCode < 400) throw invalid()
            const response = new Response([204, 205, 304].includes(incoming.statusCode) ? null : body, {
              status: incoming.statusCode, statusText: incoming.statusMessage, headers: responseHeaders
            })
            Object.defineProperty(response, 'url', { value: url.href })
            receivedHeaders = true
            resolve(response)
            if (response.body === null) { finished = true; cleanup(); abortRequest(); void reader.cancel().catch(() => undefined) }
          } catch { fail(invalid()) }
        })
        if (signal.aborted) { abortRequest(); onAbort(); return }
        if (upload?.length) request.write(upload)
        if (!finished) request.end()
      } catch (error) { fail(networkError(error)) }
    })
  }
}
