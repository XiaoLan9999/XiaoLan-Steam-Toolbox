import type { RequestOptions } from 'node:http'
import { LOGIN_NETWORK_CODES } from '../shared/diagnostics'
import type { LoginDiagnosticEvent, LoginNetworkCode } from '../shared/diagnostics'

type Failure = Pick<LoginDiagnosticEvent, 'reason' | 'networkCode' | 'httpStatus' | 'eresult'>

const NETWORK_CODES: ReadonlySet<string> = new Set(LOGIN_NETWORK_CODES)

function property(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return (value as Record<string, unknown>)[name] }
  catch { return undefined }
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value : undefined
}

export function loginDiagnosticElapsed(startedAt: number, now: number): number {
  return Math.min(600_000, Math.max(0, Math.floor(Number.isFinite(now - startedAt) ? now - startedAt : 0)))
}

export function loginDiagnosticFailure(error: unknown): Failure {
  const result: Failure = { reason: 'unknown' }
  let domainReason: LoginDiagnosticEvent['reason']
  let source: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; source && depth < 4 && !seen.has(source); depth += 1) {
    seen.add(source)
    const code = property(source, 'code')
    const status = integer(property(source, 'statusCode'), 100, 599)
      ?? integer(property(source, 'status'), 100, 599) ?? integer(code, 100, 599)
    const eresult = integer(property(source, 'eresult'), 0, 255)
    if (status !== undefined && result.httpStatus === undefined) result.httpStatus = status
    if (eresult !== undefined && result.eresult === undefined) result.eresult = eresult
    if (typeof code === 'string' && NETWORK_CODES.has(code) && !result.networkCode) {
      result.networkCode = code as LoginNetworkCode
    }
    if (!domainReason) {
      if (code === 'LOGIN_ATTEMPT_TIMEOUT') domainReason = 'timeout'
      else if (code === 'SESSION_CHANGED') domainReason = 'cancelled'
      else if (code === 'RATE_LIMITED') domainReason = 'rate-limited'
      else if (code === 'COMMUNITY_ACCESS_DENIED') domainReason = 'access-denied'
      else if (code === 'QR_UNAVAILABLE' || code === 'SESSION_CHECK_FAILED') domainReason = 'invalid-response'
    }
    source = property(source, 'cause')
  }
  // SDK errors sometimes expose HTTP status only in a fixed-format message.
  const message = property(error, 'message')
  if (typeof message === 'string') {
    const match = /\b(?:HTTP(?: error)?|WebAPI error) ([1-5]\d\d)\b/i.exec(message)
    if (result.httpStatus === undefined && match) result.httpStatus = Number(match[1])
  }
  if (result.httpStatus === 429) result.reason = 'rate-limited'
  else if (result.httpStatus === 403 || result.eresult === 15) result.reason = 'access-denied'
  else if (result.eresult !== undefined && [5, 21, 26, 27, 121, 126].includes(result.eresult)) result.reason = 'credentials-rejected'
  else if (domainReason) result.reason = domainReason
  else if (result.networkCode === 'ENOTFOUND' || result.networkCode === 'EAI_AGAIN') result.reason = 'dns'
  else if (result.networkCode && /TIMEOUT|TIMEDOUT/.test(result.networkCode)) result.reason = 'timeout'
  else if (result.networkCode && /TLS|SSL|CERT|VERIFY|ISSUER/.test(result.networkCode)) result.reason = 'tls'
  else if (result.networkCode) result.reason = 'network'
  else if (typeof message === 'string') {
    if (/timeout|timed out/i.test(message)) result.reason = 'timeout'
    else if (/\bTLS\b|\bSSL\b|certificate/i.test(message)) result.reason = 'tls'
    else if (/network|fetch failed|socket|connection/i.test(message)) result.reason = 'network'
  }
  return result
}

export function loginDiagnosticEndpoint(options: RequestOptions): NonNullable<LoginDiagnosticEvent['endpoint']> {
  const host = typeof options.hostname === 'string' ? options.hostname : options.host
  const hostname = typeof host === 'string' ? host.toLowerCase().replace(/:443$/, '') : ''
  const path = typeof options.path === 'string' ? options.path.split('?', 1)[0]!.replace(/\/$/, '') : ''
  if (hostname === 'api.steampowered.com') {
    const endpoints: Record<string, NonNullable<LoginDiagnosticEvent['endpoint']>> = {
      '/IAuthenticationService/BeginAuthSessionViaQR/v1': 'qr-begin',
      '/IAuthenticationService/BeginAuthSessionViaCredentials/v1': 'credentials-begin',
      '/IAuthenticationService/PollAuthSessionStatus/v1': 'poll',
      '/IAuthenticationService/UpdateAuthSessionWithSteamGuardCode/v1': 'guard',
      '/IAuthenticationService/GetPasswordRSAPublicKey/v1': 'rsa',
      '/IAuthenticationService/GenerateAccessTokenForApp/v1': 'access-token'
    }
    return Object.hasOwn(endpoints, path) ? endpoints[path]! : 'other'
  }
  if (hostname === 'login.steampowered.com' && path === '/jwt/finalizelogin') return 'finalize'
  if (['steamcommunity.com', 'store.steampowered.com', 'help.steampowered.com', 'checkout.steampowered.com'].includes(hostname)
    && ['/login/settoken', '/login/transfer'].includes(path)) return 'transfer'
  return 'other'
}
