import { randomBytes } from 'node:crypto'
import type { LoginDiagnosticEvent } from '../shared/diagnostics'
import { DomainError } from '../shared/domain'
import { loginDiagnosticElapsed, loginDiagnosticFailure } from './login-diagnostic'
import { STEAM_WEB_USER_AGENT } from './steam-user-agent'

export interface CommunityWebSessionDiagnostic {
  outcome: 'started' | 'response' | 'failed' | 'cancelled'
  endpoint: 'finalize' | 'community-transfer'
  reason?: LoginDiagnosticEvent['reason']
  networkCode?: LoginDiagnosticEvent['networkCode']
  httpStatus?: number
  eresult?: number
  elapsedMs: number
}

export interface CommunityWebSessionOptions {
  signal: AbortSignal
  fetchImpl?: typeof fetch
  onDiagnostic?: (event: CommunityWebSessionDiagnostic) => void
}

const FINALIZE_URL = 'https://login.steampowered.com/jwt/finalizelogin'
const COMMUNITY_ORIGIN = 'https://steamcommunity.com'
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_DELAYS_MS = [500, 1000] as const
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_SOCKET_CLOSED',
  'ERR_CONNECTION_CLOSED', 'ERR_HTTP_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])

type JsonObject = Record<string, unknown>
interface Transfer { url: string; params: Record<string, string> }
interface JsonResponse { body: JsonObject; cookies: string[] }

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null

function invalidResponse(): DomainError {
  return new DomainError('SESSION_CHECK_FAILED', 'Steam Community login returned an invalid response')
}

function cancelled(): DomainError {
  return new DomainError('SESSION_CHANGED', 'Steam login was cancelled')
}

function signalFailure(signal: AbortSignal): DomainError {
  return signal.reason instanceof DomainError && ['SESSION_CHANGED', 'LOGIN_ATTEMPT_TIMEOUT'].includes(signal.reason.code)
    ? signal.reason : cancelled()
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signalFailure(signal)
}

function observe(options: CommunityWebSessionOptions, event: CommunityWebSessionDiagnostic): void {
  try { options.onDiagnostic?.(event) }
  catch { /* Diagnostics must not affect authentication. */ }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  const lateValue = (value: T): void => {
    try { onLateValue?.(value) } catch { /* A cancelled request cannot resume authentication. */ }
  }
  if (signal.aborted) {
    void operation.then(lateValue, () => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    let interrupted = false
    const aborted = (): void => { interrupted = true; reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(value => {
      signal.removeEventListener('abort', aborted)
      if (interrupted) lateValue(value)
      else resolve(value)
    }, error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  checkSignal(signal)
  return new Promise((resolve, reject) => {
    const aborted = (): void => { clearTimeout(timer); reject(signalFailure(signal)) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

function statusError(status: number): Error {
  const code = status === 429 ? 'RATE_LIMITED' : status === 403 ? 'COMMUNITY_ACCESS_DENIED' : 'LOGIN_HTTP_ERROR'
  return Object.assign(new DomainError(code, `Steam Community login HTTP error ${status}`), { statusCode: status })
}

function resultError(value: unknown, errorField = false): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) throw invalidResponse()
  if (value !== (errorField ? 0 : 1)) {
    throw Object.assign(new Error('Steam rejected the Community login request'), { eresult: value })
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<JsonObject> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw invalidResponse()
  if (!response.body) throw invalidResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let completed = false
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) { completed = true; break }
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse()
      chunks.push(chunk.value)
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
    catch { throw invalidResponse() }
    const body = object(value)
    if (!body) throw invalidResponse()
    return body
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function requestJson(url: string, form: FormData, endpoint: CommunityWebSessionDiagnostic['endpoint'],
  options: CommunityWebSessionOptions): Promise<JsonResponse> {
  checkSignal(options.signal)
  const startedAt = Date.now()
  const timeout = new AbortController()
  const timeoutError = Object.assign(new Error('Steam login network request timed out'), { code: 'ETIMEDOUT' })
  const timer = setTimeout(() => timeout.abort(timeoutError), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  const signal = AbortSignal.any([options.signal, timeout.signal])
  const event = (outcome: CommunityWebSessionDiagnostic['outcome'], detail: Partial<CommunityWebSessionDiagnostic> = {}): void =>
    observe(options, { outcome, endpoint, elapsedMs: loginDiagnosticElapsed(startedAt, Date.now()), ...detail })
  let response: Response | undefined
  event('started')
  try {
    response = await abortable((options.fetchImpl ?? fetch)(url, {
      method: 'POST', body: form, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { 'User-Agent': STEAM_WEB_USER_AGENT, Accept: 'application/json, text/plain, */*',
        Origin: COMMUNITY_ORIGIN, Referer: `${COMMUNITY_ORIGIN}/`,
        'sec-fetch-site': endpoint === 'finalize' ? 'cross-site' : 'same-origin',
        'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
    }), signal, lateResponse => { if (lateResponse.body) void lateResponse.body.cancel().catch(() => undefined) })
    checkSignal(options.signal)
    if (response.redirected || (response.url && response.url !== url)) throw invalidResponse()
    event('response', { httpStatus: response.status })
    if (response.status < 200 || response.status >= 300) throw statusError(response.status)
    const body = await readJson(response, signal)
    resultError(body.error, true)
    resultError(body.result)
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 100 || cookies.some(cookie => cookie.length > 16_384)) throw invalidResponse()
    return { body, cookies }
  } catch (error) {
    const failure = options.signal.aborted ? signalFailure(options.signal) : timeout.signal.aborted ? timeoutError : error
    event(failure instanceof DomainError && failure.code === 'SESSION_CHANGED' ? 'cancelled' : 'failed', loginDiagnosticFailure(failure))
    throw failure
  } finally {
    clearTimeout(timer)
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => undefined)
  }
}

function communityTransfer(body: JsonObject, steamId: string): Transfer {
  if (body.steamID !== undefined && body.steamID !== steamId) throw invalidResponse()
  if (!Array.isArray(body.transfer_info) || body.transfer_info.length === 0 || body.transfer_info.length > 32) throw invalidResponse()
  let transfer: Transfer | undefined
  for (const value of body.transfer_info) {
    const entry = object(value)
    if (!entry || typeof entry.url !== 'string' || entry.url.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(entry.url)) throw invalidResponse()
    let url: URL
    try { url = new URL(entry.url) } catch { throw invalidResponse() }
    if (url.hostname !== 'steamcommunity.com') continue
    if (!/^https:\/\/steamcommunity\.com(?::443)?\/login\/(?:settoken|transfer)$/.test(entry.url) ||
      url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || transfer) throw invalidResponse()
    const params = object(entry.params)
    if (!params || !Object.hasOwn(params, 'nonce') || !Object.hasOwn(params, 'auth')) throw invalidResponse()
    const accepted: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (key === 'steamID' && value === steamId) continue
      if (!['nonce', 'auth'].includes(key) || typeof value !== 'string' || !value || value.length > 16_384 ||
        /[^\x21-\x7e]/.test(value)) throw invalidResponse()
      accepted[key] = value
    }
    transfer = { url: url.href, params: accepted }
  }
  if (!transfer) throw invalidResponse()
  return transfer
}

function secureCommunityCookie(lines: string[], steamId: string): string {
  let accepted: string | undefined
  let acceptedExpiry: number | null = null
  for (const line of lines) {
    if (!line.startsWith('steamLoginSecure=')) continue
    if (/[\u0000-\u001f\u007f]/.test(line)) throw invalidResponse()
    const parts = line.split(';').map(part => part.trim())
    const value = parts.shift()!.slice('steamLoginSecure='.length)
    if (!value || /[\s,;"\\]/.test(value)) throw invalidResponse()
    const attributes = new Map<string, string>()
    for (const part of parts) {
      if (!part) continue
      const index = part.indexOf('=')
      const name = (index < 0 ? part : part.slice(0, index)).toLowerCase()
      if (attributes.has(name)) throw invalidResponse()
      attributes.set(name, index < 0 ? '' : part.slice(index + 1))
    }
    const domain = attributes.get('domain')?.replace(/^\./, '').toLowerCase()
    if ((domain !== undefined && domain !== 'steamcommunity.com') || (attributes.get('path') ?? '/') !== '/' ||
      !attributes.has('secure') || attributes.get('secure') !== '') throw invalidResponse()
    let decoded: string
    try { decoded = decodeURIComponent(value) } catch { throw invalidResponse() }
    if (!decoded.startsWith(`${steamId}||`) || decoded.length <= steamId.length + 2 ||
      /[\s\u0000-\u001f\u007f;]/.test(decoded)) throw invalidResponse()
    let expiresAt: number | null = null
    if (attributes.has('max-age')) {
      const age = attributes.get('max-age')!
      if (!/^\d+$/.test(age) || !Number.isSafeInteger(Number(age)) || Number(age) <= 0) throw invalidResponse()
      expiresAt = Date.now() + Math.min(Number(age), 400 * 86_400) * 1000
    } else if (attributes.has('expires')) {
      const expiry = Date.parse(attributes.get('expires')!)
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw invalidResponse()
      expiresAt = expiry
    }
    if (accepted !== undefined && accepted !== value) throw invalidResponse()
    if (expiresAt !== null && (acceptedExpiry === null || expiresAt < acceptedExpiry)) acceptedExpiry = expiresAt
    accepted = value
  }
  if (accepted === undefined) throw invalidResponse()
  return `steamLoginSecure=${accepted}; Path=/; Secure; HttpOnly; SameSite=None; Domain=steamcommunity.com${
    acceptedExpiry === null ? '' : `; Expires=${new Date(acceptedExpiry).toUTCString()}`}`
}

export async function getCommunityWebCookies(steamId: string, refreshToken: string,
  options: CommunityWebSessionOptions): Promise<string[]> {
  checkSignal(options.signal)
  if (typeof steamId !== 'string' || !/^\d{17}$/.test(steamId) || typeof refreshToken !== 'string' ||
    !refreshToken || refreshToken.length > 32_768 || /[^\x21-\x7e]/.test(refreshToken)) throw invalidResponse()
  const sessionId = randomBytes(12).toString('hex')
  const form = new FormData()
  form.set('nonce', refreshToken)
  form.set('sessionid', sessionId)
  form.set('redir', `${COMMUNITY_ORIGIN}/login/home/?goto=`)
  const finalize = await requestJson(FINALIZE_URL, form, 'finalize', options)
  const transfer = communityTransfer(finalize.body, steamId)
  for (let attempt = 0; ; attempt += 1) {
    checkSignal(options.signal)
    const transferForm = new FormData()
    transferForm.set('steamID', steamId)
    for (const [key, value] of Object.entries(transfer.params)) transferForm.set(key, value)
    try {
      const result = await requestJson(transfer.url, transferForm, 'community-transfer', options)
      return [secureCommunityCookie(result.cookies, steamId),
        `sessionid=${sessionId}; Path=/; Secure; SameSite=None; Domain=steamcommunity.com`]
    } catch (error) {
      checkSignal(options.signal)
      const failure = loginDiagnosticFailure(error)
      const delay = TRANSFER_DELAYS_MS[attempt]
      if (delay === undefined || !failure.networkCode || !TRANSIENT_CODES.has(failure.networkCode) ||
        failure.httpStatus !== undefined || failure.eresult !== undefined) throw error
      await wait(delay, options.signal)
    }
  }
}
