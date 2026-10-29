import type { ApiRequest, ApiResponse, ITransport } from 'steam-session'
import { DomainError } from '../shared/domain'
import type { LoginDiagnosticEvent } from '../shared/diagnostics'
import { loginDiagnosticElapsed, loginDiagnosticEndpoint, loginDiagnosticFailure } from './login-diagnostic'
import { STEAM_WEB_USER_AGENT } from './steam-user-agent'

export type LoginApiDiagnostic = Pick<LoginDiagnosticEvent,
  'outcome' | 'endpoint' | 'reason' | 'networkCode' | 'httpStatus' | 'eresult' | 'elapsedMs'>

export interface LoginApiTransportOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onDiagnostic?: (event: LoginApiDiagnostic) => void
}

const MAX_BODY_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const POLL_RETRY_DELAYS_MS = [500, 1500]
const METHODS = new Set([
  'BeginAuthSessionViaQR', 'BeginAuthSessionViaCredentials', 'PollAuthSessionStatus',
  'UpdateAuthSessionWithSteamGuardCode', 'GetPasswordRSAPublicKey', 'GenerateAccessTokenForApp'
])
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'ERR_SOCKET_CLOSED', 'ERR_CONNECTION_CLOSED', 'ERR_HTTP_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
])

function cancelled(): DomainError {
  return new DomainError('SESSION_CHANGED', 'Steam login request cancelled')
}

function invalidResponse(): DomainError {
  return new DomainError('SESSION_CHECK_FAILED', 'Invalid Steam login response')
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? cancelled())
    if (signal.aborted) {
      operation.catch(() => undefined)
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined)
  })
}

async function readBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length && (/^\d+$/.test(length) ? Number(length) > MAX_BODY_BYTES : true)) {
    void response.body?.cancel().catch(() => undefined)
    throw invalidResponse()
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let complete = false
  try {
    while (true) {
      const result = await abortable(reader.read(), signal)
      if (result.done) { complete = true; break }
      size += result.value.byteLength
      if (size > MAX_BODY_BYTES) throw invalidResponse()
      chunks.push(Buffer.from(result.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function retryable(error: unknown): boolean {
  const failure = loginDiagnosticFailure(error)
  return !failure.httpStatus && failure.eresult === undefined && !!failure.networkCode
    && TRANSIENT_NETWORK_CODES.has(failure.networkCode)
}

// Uses the SDK's public transport contract with bounded, cancellable poll recovery.
export class LoginApiTransport implements ITransport {
  private readonly fetchImpl: typeof fetch
  private readonly operations = new Set<AbortController>()

  constructor(private readonly options: LoginApiTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async sendRequest(request: ApiRequest): Promise<ApiResponse> {
    if (request.apiInterface !== 'Authentication' || request.apiVersion !== 1 || !METHODS.has(request.apiMethod)) {
      throw new DomainError('SESSION_CHECK_FAILED', 'Unsupported Steam login method')
    }
    if (this.options.signal?.aborted) throw cancelled()
    if (request.requestData !== undefined && !Buffer.isBuffer(request.requestData) && !(request.requestData instanceof Uint8Array)) {
      throw new DomainError('SESSION_CHECK_FAILED', 'Invalid Steam login request')
    }
    const data = request.requestData === undefined ? Buffer.alloc(0) : Buffer.from(request.requestData as Uint8Array)
    if (data.length > MAX_BODY_BYTES) throw new DomainError('SESSION_CHECK_FAILED', 'Steam login request is too large')
    const method = request.apiMethod === 'GetPasswordRSAPublicKey' ? 'GET' : 'POST'
    const url = new URL(`https://api.steampowered.com/IAuthenticationService/${request.apiMethod}/v1/`)
    if (request.accessToken) url.searchParams.set('access_token', request.accessToken)
    const headers = new Headers({
      accept: 'application/json, text/plain, */*',
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      'user-agent': STEAM_WEB_USER_AGENT
    })
    if (request.headers) new Headers(request.headers as HeadersInit).forEach((value, name) => headers.set(name, value))
    if (method === 'GET') {
      if (data.length) url.searchParams.set('input_protobuf_encoded', data.toString('base64'))
      if (headers.get('cookie')?.includes('mobileClientVersion=')) url.searchParams.set('origin', 'SteamMobile')
    }
    const endpoint = loginDiagnosticEndpoint({ hostname: url.hostname, path: url.pathname })
    const operation = new AbortController()
    this.operations.add(operation)
    const signal = this.options.signal ? AbortSignal.any([operation.signal, this.options.signal]) : operation.signal
    const maxRetries = request.apiMethod === 'PollAuthSessionStatus' ? POLL_RETRY_DELAYS_MS.length : 0
    try {
      for (let attempt = 0; ; attempt += 1) {
        signal.throwIfAborted()
        try {
          return await this.request(url, method, headers, data, endpoint, signal)
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? cancelled()
          if (attempt >= maxRetries || !retryable(error)) throw error
          await this.delay(POLL_RETRY_DELAYS_MS[attempt]!, signal)
        }
      }
    } finally {
      this.operations.delete(operation)
    }
  }

  close(): void {
    // The SDK closes after successful authentication, and may reuse a transport later.
    for (const operation of this.operations) operation.abort(cancelled())
  }

  private async request(
    url: URL, method: 'GET' | 'POST', headers: Headers, data: Buffer,
    endpoint: LoginDiagnosticEvent['endpoint'], parentSignal: AbortSignal
  ): Promise<ApiResponse> {
    const startedAt = Date.now()
    const timeout = new AbortController()
    const signal = AbortSignal.any([parentSignal, timeout.signal])
    const timer = setTimeout(() => {
      timeout.abort(Object.assign(new Error('Steam login request timed out'), { code: 'ETIMEDOUT' }))
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    const record = (outcome: LoginApiDiagnostic['outcome'], detail: Partial<LoginApiDiagnostic> = {}): void => {
      try { this.options.onDiagnostic?.({ outcome, endpoint, elapsedMs: loginDiagnosticElapsed(startedAt, Date.now()), ...detail }) }
      catch { /* Diagnostics must not affect authentication. */ }
    }
    record('started')
    try {
      let body: FormData | undefined
      if (method === 'POST' && data.length) {
        body = new FormData()
        body.set('input_protobuf_encoded', data.toString('base64'))
      }
      const pending = this.fetchImpl(url, { method, headers, body, signal, credentials: 'omit', redirect: 'error' })
      // A custom fetch implementation might ignore AbortSignal and resolve after cancellation.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined) }, () => undefined)
      const response = await abortable(pending, signal)
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => undefined)
        throw Object.assign(new Error(`WebAPI error ${response.status}`), { code: response.status })
      }
      const raw = await readBody(response, signal)
      const result: ApiResponse = {}
      const eresult = response.headers.get('x-eresult')
      if (eresult && /^\d{1,3}$/.test(eresult) && Number(eresult) <= 255) result.result = Number(eresult)
      const errorMessage = response.headers.get('x-error_message')
      if (errorMessage) result.errorMessage = errorMessage
      if (raw.length) {
        const contentType = response.headers.get('content-type') ?? ''
        if (/\b(?:application\/json|[^;\s]+\+json)\b/i.test(contentType)) {
          try { result.responseData = JSON.parse(raw.toString('utf8')) as unknown }
          catch { throw invalidResponse() }
        } else if (/^text\//i.test(contentType)) result.responseData = raw.toString('utf8')
        else result.responseData = raw
      }
      record('response', { httpStatus: response.status, ...(result.result !== undefined ? { eresult: result.result } : {}) })
      return result
    } catch (error) {
      if (parentSignal.aborted) {
        record('cancelled', { reason: 'cancelled' })
        throw parentSignal.reason ?? cancelled()
      }
      const failure = timeout.signal.aborted ? timeout.signal.reason : error
      record('failed', loginDiagnosticFailure(failure))
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  private delay(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal.reason ?? cancelled()) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
      timer.unref?.()
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
}
