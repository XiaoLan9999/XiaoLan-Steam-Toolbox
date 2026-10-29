import { describe, expect, it } from 'vitest'
import { loginDiagnosticElapsed, loginDiagnosticEndpoint, loginDiagnosticFailure } from '../src/main/login-diagnostic'
import { DomainError } from '../src/shared/domain'

describe('safe login diagnostics', () => {
  it.each([
    ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ECONNRESET', 'network'],
    ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ETIMEDOUT', 'timeout'], ['ERR_TLS_HANDSHAKE_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout']
  ])('classifies the allowlisted network code %s without error text', (code, reason) => {
    const error = Object.assign(new Error('password=private-user-secret https://example.invalid/?token=private-token'), {
      cause: { code, message: 'sessionid=private-cookie', responseBody: 'private-body' }
    })
    expect(loginDiagnosticFailure(error)).toEqual({ reason, networkCode: code })
  })

  it.each([403, 429])('recognizes SDK numeric HTTP code %s without exposing its payload', code => {
    expect(loginDiagnosticFailure(Object.assign(new Error(`WebAPI error ${code}`), {
      code, responseBody: { token: 'private-token' }
    }))).toEqual({ reason: code === 403 ? 'access-denied' : 'rate-limited', httpStatus: code })
    expect(loginDiagnosticFailure(new Error(`WebAPI error ${code}`))).toEqual({
      reason: code === 403 ? 'access-denied' : 'rate-limited', httpStatus: code
    })
  })

  it('drops arbitrary codes, unsafe fields, malformed status numbers and credential-shaped messages', () => {
    const error = Object.assign(new Error('private-username/private-password/private-cookie'), {
      code: 'private-token', statusCode: 700, eresult: 256, headers: { cookie: 'private-cookie' }
    })
    expect(loginDiagnosticFailure(error)).toEqual({ reason: 'unknown' })
    expect(loginDiagnosticFailure({ code: 403.5, statusCode: '429', eresult: '27' })).toEqual({ reason: 'unknown' })
    expect(loginDiagnosticFailure({ eresult: 27 })).toEqual({ reason: 'credentials-rejected', eresult: 27 })
    expect(loginDiagnosticFailure({ eresult: 15 })).toEqual({ reason: 'access-denied', eresult: 15 })
  })

  it('bounds cyclic causes and tolerates throwing error fields', () => {
    const error: { cause?: unknown } = {}
    error.cause = error
    expect(loginDiagnosticFailure(error)).toEqual({ reason: 'unknown' })
    expect(loginDiagnosticFailure(Object.defineProperty({}, 'code', { get: () => { throw new Error('private') } })))
      .toEqual({ reason: 'unknown' })
    expect(loginDiagnosticFailure(Object.assign(new DomainError('RATE_LIMITED', 'private-message'), {
      cause: { code: 'ECONNRESET' }
    }))).toEqual({ reason: 'rate-limited', networkCode: 'ECONNRESET' })
  })

  it.each([
    ['BeginAuthSessionViaQR', 'qr-begin'], ['BeginAuthSessionViaCredentials', 'credentials-begin'],
    ['PollAuthSessionStatus', 'poll'], ['UpdateAuthSessionWithSteamGuardCode', 'guard'],
    ['GetPasswordRSAPublicKey', 'rsa'], ['GenerateAccessTokenForApp', 'access-token']
  ])('maps the fixed API method %s without preserving its query', (method, endpoint) => {
    expect(loginDiagnosticEndpoint({ hostname: 'api.steampowered.com',
      path: `/IAuthenticationService/${method}/v1/?access_token=private-token` })).toBe(endpoint)
    expect(loginDiagnosticEndpoint({ hostname: 'untrusted.invalid', path: `/IAuthenticationService/${method}/v1/` })).toBe('other')
  })

  it('maps only fixed finalize and transfer paths on known hosts', () => {
    expect(loginDiagnosticEndpoint({ host: 'login.steampowered.com:443', path: '/jwt/finalizelogin?token=private' })).toBe('finalize')
    expect(loginDiagnosticEndpoint({ host: 'steamcommunity.com', path: '/login/settoken' })).toBe('community-transfer')
    expect(loginDiagnosticEndpoint({ host: 'store.steampowered.com', path: '/login/settoken' })).toBe('store-transfer')
    expect(loginDiagnosticEndpoint({ host: 'help.steampowered.com', path: '/login/settoken' })).toBe('help-transfer')
    expect(loginDiagnosticEndpoint({ host: 'checkout.steampowered.com', path: '/login/settoken' })).toBe('checkout-transfer')
    expect(loginDiagnosticEndpoint({ host: 'private-user.invalid', path: '/login/settoken' })).toBe('other')
    expect(loginDiagnosticEndpoint({ host: 'api.steampowered.com', path: 'toString' })).toBe('other')
    expect(loginDiagnosticEndpoint({ host: 'api.steampowered.com', path: '/private-token' })).toBe('other')
  })

  it('bounds elapsed time', () => {
    expect(loginDiagnosticElapsed(100, 50)).toBe(0)
    expect(loginDiagnosticElapsed(100, 125.9)).toBe(25)
    expect(loginDiagnosticElapsed(0, 900_000)).toBe(600_000)
    expect(loginDiagnosticElapsed(0, Number.NaN)).toBe(0)
  })
})
