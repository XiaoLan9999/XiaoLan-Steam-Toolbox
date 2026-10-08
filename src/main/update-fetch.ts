import { Readable } from 'node:stream'
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron'

export type UpdateRequestFactory = (options: ClientRequestConstructorOptions) => Pick<ClientRequest, 'on' | 'end' | 'abort'>

function interrupted(): Error { return new Error('update.downloadInterrupted') }
function cancelled(): DOMException { return new DOMException('update.cancelled', 'AbortError') }

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    if (name.toLowerCase() === 'set-cookie') continue
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry)
  }
  return headers
}

export function createUpdateFetch(requestFactory: UpdateRequestFactory): typeof fetch {
  return async (input, init): Promise<Response> => {
    const original = input instanceof Request ? input : null
    let url: URL
    try { url = new URL(original?.url ?? String(input)) } catch { throw new Error('update.redirectInvalid') }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('update.redirectInvalid')
    if ((init?.method ?? original?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body || original?.body ||
      (init?.redirect !== undefined && init.redirect !== 'manual')) throw new Error('update.invalidResponse')
    const signal = init?.signal ?? original?.signal
    if (signal?.aborted) throw cancelled()
    let headers: Headers
    try { headers = new Headers(init?.headers ?? original?.headers) } catch { throw new Error('update.invalidResponse') }
    for (const name of ['cookie', 'cookie2', 'authorization', 'proxy-authorization']) headers.delete(name)

    return new Promise<Response>((resolve, reject) => {
      let request: ReturnType<UpdateRequestFactory>
      try {
        request = requestFactory({ url: url.href, method: 'GET', redirect: 'manual', credentials: 'omit',
          useSessionCookies: false, headers: Object.fromEntries(headers.entries()) })
      } catch { reject(interrupted()); return }
      let finished = false
      let receivedHeaders = false
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
      const abortRequest = (): void => { try { request.abort() } catch { /* The request may already be closed. */ } }
      const fail = (error: Error): void => {
        if (finished) return
        finished = true
        cleanup()
        if (controller) controller.error(error)
        if (!receivedHeaders) reject(error)
        abortRequest()
        if (reader) void reader.cancel().catch(() => undefined)
      }
      const onAbort = (): void => fail(cancelled())
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('error', () => fail(interrupted()))
      request.on('abort', () => fail(interrupted()))
      request.on('login', (_info, callback) => callback())
      request.on('redirect', (status, _method, location, values) => {
        if (finished) return
        try {
          const redirectedHeaders = responseHeaders(values)
          if (!redirectedHeaders.has('location')) redirectedHeaders.set('location', location)
          const response = new Response(null, { status, headers: redirectedHeaders })
          Object.defineProperty(response, 'url', { value: url.href })
          receivedHeaders = true
          finished = true
          cleanup()
          resolve(response)
        } catch { fail(new Error('update.invalidResponse')) }
        abortRequest()
      })
      request.on('response', (incoming: IncomingMessage) => {
        if (finished) { abortRequest(); return }
        try {
          // Electron's IncomingMessage is a Node Readable; toWeb preserves network backpressure.
          reader = (Readable.toWeb(incoming as unknown as Readable, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength }
          }) as ReadableStream<Uint8Array>).getReader()
          const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value },
            async pull(value) {
              try {
                const chunk = await reader!.read()
                if (finished) return
                if (chunk.done) { finished = true; cleanup(); value.close() }
                else value.enqueue(chunk.value)
              } catch { fail(interrupted()) }
            },
            async cancel() {
              if (finished) return
              finished = true
              cleanup()
              abortRequest()
              await reader!.cancel().catch(() => undefined)
            }
          }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength })
          const response = new Response([204, 205, 304].includes(incoming.statusCode) ? null : body, {
            status: incoming.statusCode, statusText: incoming.statusMessage, headers: responseHeaders(incoming.headers)
          })
          Object.defineProperty(response, 'url', { value: url.href })
          receivedHeaders = true
          resolve(response)
          if (response.body === null) { finished = true; cleanup(); abortRequest(); void reader.cancel().catch(() => undefined) }
        } catch { fail(new Error('update.invalidResponse')) }
      })
      if (signal?.aborted) { onAbort(); return }
      try { request.end() } catch { fail(interrupted()) }
    })
  }
}
