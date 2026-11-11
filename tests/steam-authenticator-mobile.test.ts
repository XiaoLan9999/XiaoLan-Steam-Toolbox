import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EAuthSessionGuardType } from 'steam-session'
import { LoginApiTransport } from '../src/main/login-api-transport'
import { SteamAuthenticatorMobileAdapter, type SteamAuthenticatorMobileLoginSession } from '../src/main/steam-authenticator-mobile'
import type { EnrollmentSession, SteamAuthenticatorEnrollmentCandidate } from '../src/main/steam-authenticator-enrollment'

const OWNER = '76561198000000001', OTHER = '76561198000000002', NOW = 1700000000000
const SECRET = Buffer.from('0123456789abcdefghij').toString('base64')
const DEVICE = 'android:00000000-0000-4000-8000-000000000001'
const PRIVATE = 'PRIVATE_MOBILE_AUTH_ERROR_NEVER_RENDER'
const adapters: SteamAuthenticatorMobileAdapter[] = []
const jwt = (id = OWNER, audience = ['web', 'mobile'], expiry = NOW / 1000 + 3600) => `${Buffer.from('{"alg":"synthetic"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, aud: audience, exp: expiry })).toString('base64url')}.synthetic-signature`
const session = (overrides: EnrollmentSession = {}): EnrollmentSession => ({ schema: 1, platform: 'mobile', steamId: OWNER, accountName: 'fixture_user', accessToken: jwt(), refreshToken: jwt(OWNER, ['web', 'mobile', 'derive']), ...overrides })
const candidate = (overrides: Partial<SteamAuthenticatorEnrollmentCandidate> = {}): SteamAuthenticatorEnrollmentCandidate => ({ name: 'fixture_user', steamId: OWNER, sharedSecret: SECRET, identitySecret: SECRET, deviceId: DEVICE, revocationCode: 'R123456', tokenGid: '18446744073709551614', fullyEnrolled: false, confirmType: 'sms', ...overrides })
const addResponse = () => ({ status: 1, account_name: 'fixture_user', shared_secret: SECRET, identity_secret: SECRET, revocation_code: 'R123456', token_gid: '18446744073709551614', serial_number: '18446744073709551613', confirm_type: 1 })
const signal = () => new AbortController().signal
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve() }

class FakeSession extends EventEmitter implements SteamAuthenticatorMobileLoginSession {
  steamID = { getSteamID64: () => OWNER }
  accountName = 'fixture_user'
  accessToken = jwt()
  refreshToken = jwt(OWNER, ['web', 'mobile', 'derive'])
  loginTimeout = 0
  cancelled = 0
  start = vi.fn(async (_input: Parameters<SteamAuthenticatorMobileLoginSession['startWithCredentials']>[0]) => { queueMicrotask(() => this.emit('authenticated')); return { actionRequired: false, validActions: [] as Array<{ type: EAuthSessionGuardType; detail?: string }> } })
  guard = vi.fn(async (_code: string) => { queueMicrotask(() => this.emit('authenticated')) })
  refresh = vi.fn(async () => {})
  startWithCredentials(input: Parameters<SteamAuthenticatorMobileLoginSession['startWithCredentials']>[0]): ReturnType<SteamAuthenticatorMobileLoginSession['startWithCredentials']> { return this.start(input) }
  submitSteamGuardCode(code: string): Promise<void> { return this.guard(code) }
  refreshAccessToken(): Promise<void> { return this.refresh() }
  cancelLoginAttempt(): void { this.cancelled++ }
}

function fixture() {
  const sdk = new FakeSession()
  const responses = new Map<string, unknown>([
    ['IPhoneService/AccountPhoneStatus', { verified_phone: true }],
    ['IPhoneService/IsAccountWaitingForEmailConfirmation', { awaiting_email_confirmation: false, seconds_to_wait: 0 }],
    ['IPhoneService/SetAccountPhoneNumber', { confirmation_email_address: 'fixture@example.invalid', phone_number_formatted: '+86 13800000000' }],
    ['IPhoneService/SendPhoneVerificationCode', {}], ['IPhoneService/VerifyAccountPhoneWithCode', {}],
    ['ITwoFactorService/AddAuthenticator', addResponse()], ['ITwoFactorService/FinalizeAddAuthenticator', { status: 1, success: true }],
    ['ITwoFactorService/QueryStatus', { state: 0, authenticator_type: 0, inactivation_reason: 0 }], ['ITwoFactorService/QueryTime', { server_time: '1700000123' }]
  ])
  const requests: Array<{ url: URL; init: RequestInit; fields: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), route = url.pathname.replace(/^\//, '').replace(/\/v1\/$/, '')
    if (url.origin !== 'https://api.steampowered.com' || !responses.has(route)) throw new Error('No real network is allowed')
    requests.push({ url, init: init!, fields: Object.fromEntries(init!.body as URLSearchParams) })
    const value = responses.get(route)
    if (value instanceof Error) throw value
    if (value instanceof Response) return value
    if (typeof value === 'function') return (value as () => Response | Promise<Response>)()
    return Response.json({ response: value })
  })
  const dispose = vi.fn(), createNetwork = vi.fn(() => ({ fetch: fetchImpl as typeof fetch, dispose }))
  const createSession = vi.fn((transport: LoginApiTransport) => { expect(transport).toBeInstanceOf(LoginApiTransport); return sdk })
  const adapter = new SteamAuthenticatorMobileAdapter({ createNetwork, createSession, now: () => NOW })
  adapters.push(adapter)
  const set = (route: string, value: unknown) => responses.set(route, value)
  const count = (route: string) => requests.filter(value => value.url.pathname.includes(`/${route}/`)).length
  return { adapter, sdk, set, requests, fetchImpl, createNetwork, createSession, dispose, count }
}

afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); vi.useRealTimers() })

describe('independent mobile role and process-only Guard handles', () => {
  it('has no network or login side effects until explicitly called', () => {
    const f = fixture(); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.createSession).not.toHaveBeenCalled()
  })

  it('returns only main-only mobile opaque session data and never persists the supplied password', async () => {
    const f = fixture(); const result = await f.adapter.login({ accountName: 'fixture_user', password: PRIVATE }, signal())
    expect(result).toMatchObject({ kind: 'authenticated', steamId: OWNER, session: { schema: 1, platform: 'mobile', steamId: OWNER } })
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    expect(f.sdk.start).toHaveBeenCalledExactlyOnceWith({ accountName: 'fixture_user', password: PRIVATE, persistence: 1 })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([['email', EAuthSessionGuardType.EmailCode], ['device', EAuthSessionGuardType.DeviceCode], ['confirmation', EAuthSessionGuardType.DeviceConfirmation]] as const)('keeps a %s guard in a private process handle and completes the same attempt', async (guardType, type) => {
    const f = fixture(); f.sdk.start.mockImplementationOnce(async () => ({ actionRequired: true, validActions: [{ type, detail: 'example.invalid' }] }))
    const result = await f.adapter.login({ accountName: 'fixture_user', password: PRIVATE }, signal())
    expect(result).toMatchObject({ kind: 'guard', guardType })
    if (result.kind !== 'guard') throw new Error('Fixture guard expected')
    expect(Object.keys(result.resume)).toEqual(['authHandle']); expect(JSON.stringify(result)).not.toContain(PRIVATE)
    if (guardType === 'confirmation') { f.sdk.emit('authenticated') }
    const done = await f.adapter.login({ accountName: 'fixture_user', resume: result.resume, ...(guardType !== 'confirmation' ? { code: 'ABCDE' } : {}) }, signal())
    expect(done.kind).toBe('authenticated'); expect(f.sdk.start).toHaveBeenCalledTimes(1)
  })

  it('does not generate a new login or email after an invalid Guard code', async () => {
    const f = fixture(); f.sdk.start.mockResolvedValueOnce({ actionRequired: true, validActions: [{ type: EAuthSessionGuardType.EmailCode }] })
    const started = await f.adapter.login({ accountName: 'fixture_user', password: PRIVATE }, signal())
    if (started.kind !== 'guard') throw new Error('Fixture guard expected')
    f.sdk.guard.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.adapter.login({ accountName: 'fixture_user', resume: started.resume, code: 'ABCDE' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_GUARD_INVALID', message: 'AUTH_ENROLL_MOBILE_GUARD_INVALID' })
    expect(f.sdk.start).toHaveBeenCalledTimes(1)
    expect((await f.adapter.login({ accountName: 'fixture_user', resume: started.resume, code: 'BCDEF' }, signal())).kind).toBe('authenticated')
  })

  it('requires a fresh mobile login after a Guard handle was lost instead of treating it as a session token', async () => {
    const f = fixture()
    await expect(f.adapter.login({ accountName: 'fixture_user', resume: { authHandle: 'lost-process-handle', refreshToken: jwt() } }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' })
    expect(f.createNetwork).not.toHaveBeenCalled()
  })

  it('cancels Guard polling on lifecycle abort and ignores a late authenticated event', async () => {
    const f = fixture(); f.sdk.start.mockResolvedValueOnce({ actionRequired: true, validActions: [{ type: EAuthSessionGuardType.DeviceConfirmation }] })
    const controller = new AbortController(); const started = await f.adapter.login({ accountName: 'fixture_user', password: PRIVATE }, controller.signal)
    controller.abort(); f.sdk.emit('authenticated')
    expect(f.sdk.cancelled).toBeGreaterThan(0); expect(f.dispose).toHaveBeenCalled()
    await expect(f.adapter.login({ accountName: 'fixture_user', resume: started.kind === 'guard' ? started.resume : {} }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' })
  })

  it('removes SDK debug consumers before tokens are negotiated', async () => {
    const f = fixture(); const log = vi.fn(); f.sdk.on('debug', log); f.sdk.on('debug-handler', log)
    await f.adapter.login({ accountName: 'fixture_user', password: PRIVATE }, signal())
    f.sdk.emit('debug', PRIVATE); f.sdk.emit('debug-handler', PRIVATE); expect(log).not.toHaveBeenCalled()
  })

  it.each([['web-refresh', { refreshToken: jwt(OWNER, ['web', 'derive']) }], ['wrong-owner', { refreshToken: jwt(OTHER, ['web', 'mobile', 'derive']) }], ['expired-refresh', { refreshToken: jwt(OWNER, ['web', 'mobile', 'derive'], NOW / 1000 - 1) }], ['browser-role', { platform: 'web' }]] as const)('refuses %s before accessing a protected endpoint', async (_label, overrides) => {
    const f = fixture()
    await expect(f.adapter.queryStatus(session(overrides), null, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes only an existing valid mobile refresh token, never upgrades a browser token', async () => {
    const f = fixture(); const value = session({ accessToken: jwt(OWNER, ['web']) })
    await f.adapter.queryStatus(value, null, signal())
    expect(f.sdk.refresh).toHaveBeenCalledOnce(); expect(value.accessToken).toBe(jwt())
    expect(f.sdk.start).not.toHaveBeenCalled()
  })
})

describe('explicit phone binding steps and mandatory verified-state readback', () => {
  it('returns ready for an already verified phone without sending SMS or replacing it', async () => {
    const f = fixture(); expect(await f.adapter.phone(session(), { op: 'status' }, signal())).toEqual({ status: 'ready' })
    expect(f.count('IPhoneService/AccountPhoneStatus')).toBe(1)
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0); expect(f.count('IPhoneService/SetAccountPhoneNumber')).toBe(0)
  })

  it('performs a read-only phone status query without implicitly sending verification', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false })
    const first = await f.adapter.phone(session(), { op: 'status' }, signal())
    expect(first).toEqual({ status: 'phone-needed' })
    expect(await f.adapter.phone(session(), { op: 'status', resume: first.resume }, signal())).toEqual({ status: 'phone-needed' })
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
  })

  it('uses the numeric calling code and returns only a masked email hint after SetNumber', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false })
    const result = await f.adapter.phone(session(), { op: 'begin', phoneNumber: '+8613800000000', countryCode: '86' }, signal())
    expect(result).toMatchObject({ status: 'email-required', hint: 'f***@example.invalid' })
    expect(f.requests.find(value => value.url.pathname.includes('SetAccountPhoneNumber'))?.fields).toEqual({ phone_number: '+8613800000000', phone_country_code: '86' })
    expect(JSON.stringify(result)).not.toContain('+8613800000000'); expect(JSON.stringify(result)).not.toContain('fixture@example.invalid')
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
  })

  it('does not resend SetNumber while account email confirmation is still pending', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false }); f.set('IPhoneService/IsAccountWaitingForEmailConfirmation', { awaiting_email_confirmation: true, seconds_to_wait: 60 })
    expect(await f.adapter.phone(session(), { op: 'begin', phoneNumber: '+8613800000000', countryCode: '86' }, signal())).toMatchObject({ status: 'email-required', retryAfterMs: 60000 })
    expect(f.count('IPhoneService/SetAccountPhoneNumber')).toBe(0); expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
  })

  it('requires an explicit send-SMS operation after email confirmation and respects the server wait', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false })
    const resume = { steamId: OWNER, step: 'email' }
    expect(await f.adapter.phone(session(), { op: 'status', resume }, signal())).toMatchObject({ status: 'sms-required' })
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
    f.set('IPhoneService/IsAccountWaitingForEmailConfirmation', { awaiting_email_confirmation: false, seconds_to_wait: 45 })
    expect(await f.adapter.phone(session(), { op: 'send-sms', resume }, signal())).toMatchObject({ status: 'sms-required', retryAfterMs: 45000 })
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
    f.set('IPhoneService/IsAccountWaitingForEmailConfirmation', { awaiting_email_confirmation: false, seconds_to_wait: 0 })
    expect(await f.adapter.phone(session(), { op: 'send-sms', resume }, signal())).toMatchObject({ status: 'sms-required' })
    expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(1)
  })

  it('does not accept an empty successful Verify response without a verified phone readback', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false })
    await expect(f.adapter.phone(session(), { op: 'submit-sms', code: '123456' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_PHONE_VERIFY_FAILED' })
    expect(f.count('IPhoneService/VerifyAccountPhoneWithCode')).toBe(1); expect(f.count('IPhoneService/AccountPhoneStatus')).toBe(2)
  })

  it('marks the phone ready only after its state readback actually changes', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false })
    f.set('IPhoneService/VerifyAccountPhoneWithCode', () => { f.set('IPhoneService/AccountPhoneStatus', { verified_phone: true }); return Response.json({ response: {} }) })
    expect(await f.adapter.phone(session(), { op: 'submit-sms', code: '123456' }, signal())).toEqual({ status: 'ready' })
  })

  it.each(['CN', '0', '+86'])('rejects a nonnumeric or invalid calling code %s without a request', async countryCode => {
    const f = fixture()
    await expect(f.adapter.phone(session(), { op: 'begin', phoneNumber: '+8613800000000', countryCode }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_INVALID' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('single-attempt Add and strict Finalize outcomes', () => {
  it('returns a pending candidate with complete core recovery material, never a fully enrolled vault entry', async () => {
    const f = fixture(); const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ steamId: OWNER, sharedSecret: SECRET, identitySecret: SECRET, revocationCode: 'R123456', tokenGid: '18446744073709551614', deviceId: DEVICE, fullyEnrolled: false, confirmType: 'sms' })
    expect(f.requests.find(value => value.url.pathname.includes('/AddAuthenticator/'))?.fields).toEqual({ steamid: OWNER, authenticator_type: '1', device_identifier: DEVICE, sms_phone_id: '1', version: '2' })
  })

  it('preserves numeric uint64 token and serial identifiers without JSON rounding', async () => {
    const f = fixture(); const body = JSON.stringify({ response: addResponse() }).replace('"18446744073709551614"', '18446744073709551614').replace('"18446744073709551613"', '18446744073709551613')
    f.set('ITwoFactorService/AddAuthenticator', new Response(body, { headers: { 'content-type': 'application/json' } }))
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toHaveProperty('tokenGid', '18446744073709551614'); expect(result).toHaveProperty('serialNumber', '18446744073709551613')
  })

  it.each([[1, 'sms'], [3, 'email'], [99, 'unknown']] as const)('keeps confirmation type %s as %s without discarding newly issued recovery material', async (confirm_type, kind) => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), confirm_type })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ confirmType: kind, sharedSecret: SECRET })
  })

  it.each([{ serial_number: { unsafe: PRIVATE } }, { serial_number: '18446744073709551616' }, { secret_1: PRIVATE }])('does not discard mandatory secrets because optional metadata is malformed', async invalid => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), ...invalid })
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ sharedSecret: SECRET, identitySecret: SECRET, revocationCode: 'R123456', fullyEnrolled: false, confirmType: 'sms', metadataIncomplete: true })
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    if ('secret_1' in invalid) expect(result).not.toHaveProperty('secret1')
    else expect(result).not.toHaveProperty('serialNumber')
  })

  it('keeps canonical optional secret metadata that can be safely parsed again by the vault', async () => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), secret_1: SECRET })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ secret1: SECRET, serialNumber: '18446744073709551613' })
  })

  it.each([undefined, '18446744073709551616', 'not-a-token'])('retains core secrets with unknown confirmation mode when token identity cannot be trusted', async token_gid => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), token_gid })
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ sharedSecret: SECRET, identitySecret: SECRET, revocationCode: 'R123456', confirmType: 'unknown', metadataIncomplete: true })
    expect(result).not.toHaveProperty('tokenGid')
  })

  it('does not invent a uint64 identifier from rounded exponential JSON', async () => {
    const f = fixture(); const body = JSON.stringify({ response: addResponse() }).replace('"18446744073709551614"', '1.8446744073709552e19')
    f.set('ITwoFactorService/AddAuthenticator', new Response(body, { headers: { 'content-type': 'application/json' } }))
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ sharedSecret: SECRET, confirmType: 'unknown', metadataIncomplete: true }); expect(result).not.toHaveProperty('tokenGid')
  })

  it.each([{ identity_secret: PRIVATE }, { shared_secret: PRIVATE }, { revocation_code: 'invalid-code' }])('quarantines valid portions of issued material if any mandatory material is invalid', async invalid => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), ...invalid, session: { access_token: PRIVATE }, url: PRIVATE })
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ kind: 'rescue', expectedSteamId: OWNER, reason: 'required-material-invalid', deviceId: DEVICE })
    expect(result).not.toHaveProperty('fullyEnrolled'); expect(result).not.toHaveProperty('confirmType')
    expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(result).not.toHaveProperty('session'); expect(result).not.toHaveProperty('url')
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_ADD_UNCERTAIN' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it.each([{ steamid: OTHER }, { account_name: 'unexpected_account' }, { steamid: PRIVATE }])('quarantines otherwise valid issued material when response ownership mismatches', async mismatch => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), ...mismatch })
    const result = await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())
    expect(result).toMatchObject({ kind: 'rescue', expectedSteamId: OWNER, sharedSecret: SECRET, identitySecret: SECRET, revocationCode: 'R123456', reason: 'owner-mismatch' })
    if (mismatch.steamid === OTHER) expect(result).toHaveProperty('receivedSteamId', OTHER)
    else expect(result).not.toHaveProperty('receivedSteamId')
    expect(result).not.toHaveProperty('steamId'); expect(JSON.stringify(result)).not.toContain(PRIVATE)
  })

  it.each([{ status: 91 }, { status: PRIVATE }, { status: 1, success: false }])('retains issued secrets even if the Add status is not a definite acceptance', async status => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), ...status })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ kind: 'rescue', sharedSecret: SECRET, revocationCode: 'R123456', reason: 'status-uncertain' })
    expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(0)
  })

  it('rejects a noncanonical device id before making an irreversible Add request', async () => {
    const f = fixture()
    expect(await f.adapter.addAuthenticator(session(), { deviceId: 'android:00000000000000000000000000000001', attemptId: 'add-attempt-1' }, signal())).toEqual({ kind: 'not-submitted', reason: 'invalid-input', proof: 'request-not-sent' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
  })

  it.each([[29, 'AUTHENTICATOR_PRESENT'], [91, 'ADD_FAILED']] as const)('rejects Add status %s without attempting Remove', async (status, code) => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { status })
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: `AUTH_ENROLL_MOBILE_${code}` })
    expect(f.requests.some(value => /Remove|Revoke/i.test(value.url.pathname))).toBe(false)
  })

  it('does not replay Add after an uncertain network failure, even if the same attempt is submitted again', async () => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', Object.assign(new Error(PRIVATE), { code: 'ECONNRESET' }))
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED', message: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED' })
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_ADD_UNCERTAIN' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it('permits an explicit email-capable Add without making phone verification a client-side prerequisite', async () => {
    const f = fixture(); f.set('IPhoneService/AccountPhoneStatus', { verified_phone: false }); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), confirm_type: 3 })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ fullyEnrolled: false, confirmType: 'email' })
    expect(f.count('IPhoneService/AccountPhoneStatus')).toBe(0); expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it('distinguishes an authoritative no-phone rejection from an uncertain issued token', async () => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { status: 2 })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toEqual({ kind: 'not-submitted', reason: 'phone-needed', proof: 'authoritative-phone-rejection' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1); expect(f.count('IPhoneService/SendPhoneVerificationCode')).toBe(0)
  })

  it('does not classify a no-phone status carrying valid issued secrets as safely unsubmitted', async () => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { ...addResponse(), status: 2 })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ kind: 'rescue', reason: 'status-uncertain', sharedSecret: SECRET })
  })

  it.each(['shared_secret', 'identity_secret', 'revocation_code', 'token_gid', 'secret_1'])('does not mistake invalid nonempty %s material for proof that nothing was issued', async field => {
    const f = fixture(); f.set('ITwoFactorService/AddAuthenticator', { status: 2, [field]: PRIVATE })
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_ADD_UNCERTAIN' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it('proves that a mobile authentication failure happened before any Add request', async () => {
    const f = fixture()
    expect(await f.adapter.addAuthenticator(session({ refreshToken: jwt(OWNER, ['web', 'derive']) }), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toEqual({ kind: 'not-submitted', reason: 'login-required', proof: 'request-not-sent' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ fullyEnrolled: false })
  })

  it('returns an exact pre-submit result if its network factory fails before the Add fetch exists', async () => {
    const f = fixture(); f.createNetwork.mockImplementationOnce(() => { throw new Error(PRIVATE) })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toEqual({ kind: 'not-submitted', reason: 'unavailable', proof: 'request-not-sent' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ fullyEnrolled: false })
  })

  it('marks Add critical synchronously immediately before its single fetch, not during access preflight', async () => {
    const f = fixture(); const onDispatch = vi.fn(() => { expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0) })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal(), { onDispatch })).toMatchObject({ fullyEnrolled: false })
    expect(onDispatch).toHaveBeenCalledOnce(); expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it('does not mark Add critical if mobile authorization never reached dispatch', async () => {
    const f = fixture(), onDispatch = vi.fn()
    expect(await f.adapter.addAuthenticator(session({ platform: 'web' }), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal(), { onDispatch })).toMatchObject({ kind: 'not-submitted', proof: 'request-not-sent' })
    expect(onDispatch).not.toHaveBeenCalled(); expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
  })

  it('honors a throwing shutdown gate before Add without consuming the attempt or issuing a request', async () => {
    const f = fixture(); const onDispatch = vi.fn(() => { throw new Error(PRIVATE) })
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal(), { onDispatch })).toEqual({ kind: 'not-submitted', reason: 'unavailable', proof: 'request-not-sent' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).toMatchObject({ fullyEnrolled: false })
  })

  it.each(['sms', 'email'] as const)('submits %s finalization with the exact code timestamp and verification flag used by the primary flow', async kind => {
    const f = fixture(); const result = await f.adapter.finalize(session(), candidate({ confirmType: kind }), { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal())
    expect(result).toEqual({ success: true, wantMore: false })
    expect(f.requests[0]?.fields).toEqual({ steamid: OWNER, authenticator_code: 'BCDFG', authenticator_time: '1700000100', activation_code: '123456', validate_sms_code: '1' })
    expect(f.count('ITwoFactorService/QueryTime')).toBe(0)
  })

  it('returns want_more as pending and does not loop or mark the candidate fully enrolled', async () => {
    const f = fixture(); f.set('ITwoFactorService/FinalizeAddAuthenticator', { status: 1, success: true, want_more: true }); const value = candidate()
    expect(await f.adapter.finalize(session(), value, { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal())).toEqual({ success: true, wantMore: true, retryAfterMs: 30000 })
    expect(value.fullyEnrolled).toBe(false); expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(1)
  })

  it.each([[89, 'ACTIVATION_INVALID'], [88, 'CODE_INVALID']] as const)('classifies known code rejection %s without sending another finalization', async (status, code) => {
    const f = fixture(); f.set('ITwoFactorService/FinalizeAddAuthenticator', { status, success: false })
    await expect(f.adapter.finalize(session(), candidate(), { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal())).rejects.toMatchObject({ code: `AUTH_ENROLL_MOBILE_${code}` })
    expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(1)
  })

  it('refuses unsupported confirmation kinds before any finalization request', async () => {
    const f = fixture()
    await expect(f.adapter.finalize(session(), candidate({ confirmType: 'unknown' }), { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_INVALID' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('marks Finalize critical only immediately before its single finalization fetch', async () => {
    const f = fixture(); const onDispatch = vi.fn(() => { expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(0) })
    expect(await f.adapter.finalize(session(), candidate(), { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal(), { onDispatch })).toEqual({ success: true, wantMore: false })
    expect(onDispatch).toHaveBeenCalledOnce(); expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(1)
  })

  it('honors a throwing shutdown gate before Finalize without submitting any finalization', async () => {
    const f = fixture(); const onDispatch = vi.fn(() => { throw new Error(PRIVATE) })
    await expect(f.adapter.finalize(session(), candidate(), { activationCode: '123456', authCode: 'BCDFG', authenticatorTime: 1700000100 }, signal(), { onDispatch })).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED', message: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED' })
    expect(onDispatch).toHaveBeenCalledOnce(); expect(f.count('ITwoFactorService/FinalizeAddAuthenticator')).toBe(0)
  })
})

describe('read-only status, anonymous Steam clock and safe transport failure boundaries', () => {
  it.each([[0, 0, 0, undefined, false, false], [0, 1, 0, '123', false, true], [1, 1, 0, '18446744073709551614', true, true], [1, 1, 3, '18446744073709551614', false, true]] as const)('keeps state/type/inactivation/token conditions distinct', async (state, authenticator_type, inactivation_reason, token_gid, active, hasToken) => {
    const f = fixture(); f.set('ITwoFactorService/QueryStatus', { state, authenticator_type, inactivation_reason, token_gid })
    const result = await f.adapter.queryStatus(session(), candidate(), signal())
    expect(result).toMatchObject({ steamId: OWNER, active, hasToken, matchesCandidate: active && token_gid === candidate().tokenGid })
    expect(f.requests[0]?.fields).toEqual({ steamid: OWNER, include: '0' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
  })

  it.each([['123', DEVICE], ['18446744073709551614', 'android:00000000-0000-4000-8000-000000000002']])('does not mistake a different token or device for the newly stored candidate', async (token_gid, device_identifier) => {
    const f = fixture(); f.set('ITwoFactorService/QueryStatus', { state: 1, authenticator_type: 1, inactivation_reason: 0, token_gid, device_identifier })
    expect(await f.adapter.queryStatus(session(), candidate(), signal())).toMatchObject({ active: true, matchesCandidate: false })
  })

  it.each(['authenticator_type', 'inactivation_reason'])('never commits an active candidate when the explicit %s status evidence is missing', async field => {
    const f = fixture(); const response: Record<string, unknown> = { state: 1, authenticator_type: 1, inactivation_reason: 0, token_gid: candidate().tokenGid }; delete response[field]
    f.set('ITwoFactorService/QueryStatus', response)
    await expect(f.adapter.queryStatus(session(), candidate(), signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_STATUS_INVALID' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(0)
  })

  it('accepts the protobuf zero-default no-token preflight only as inactive', async () => {
    const f = fixture(); f.set('ITwoFactorService/QueryStatus', { state: 0 })
    expect(await f.adapter.queryStatus(session(), null, signal())).toMatchObject({ active: false, hasToken: false, matchesCandidate: false })
  })

  it('queries time anonymously without sending mobile tokens or creating a login', async () => {
    const f = fixture(); expect(await f.adapter.steamTime(signal())).toBe(1700000123)
    expect(f.requests[0]?.url.searchParams.has('access_token')).toBe(false)
    expect(new Headers(f.requests[0]?.init.headers).has('cookie')).toBe(false)
    expect(f.createSession).not.toHaveBeenCalled()
  })

  it.each([0, -1, 'invalid', 1.5])('rejects invalid server time %s without a local-clock fallback', async server_time => {
    const f = fixture(); f.set('ITwoFactorService/QueryTime', { server_time })
    await expect(f.adapter.steamTime(signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_TIME_UNAVAILABLE' })
  })

  it('does not send any request after lifecycle cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort()
    expect(await f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, controller.signal)).toEqual({ kind: 'not-submitted', reason: 'unavailable', proof: 'request-not-sent' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('does not invoke a protected fetch if the lifecycle is aborted while its network is created', async () => {
    const f = fixture(), controller = new AbortController(), network = f.createNetwork()
    f.createNetwork.mockImplementationOnce(() => { controller.abort(); return network })
    await expect(f.adapter.steamTime(controller.signal)).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_CANCELLED' })
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('sanitizes a network factory failure without exposing its private text', async () => {
    const f = fixture(); f.createNetwork.mockImplementationOnce(() => { throw new Error(PRIVATE) })
    await expect(f.adapter.queryStatus(session(), null, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED', message: 'AUTH_ENROLL_MOBILE_NETWORK_FAILED' })
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('treats a paused in-flight Add as uncertain and never sends it twice', async () => {
    const f = fixture(); const gate = deferred<Response>(); f.set('ITwoFactorService/AddAuthenticator', () => gate.promise)
    const controller = new AbortController(), pending = f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_CANCELLED' })
    await flush(); controller.abort(); await rejected; gate.resolve(Response.json({ response: addResponse() })); await flush()
    await expect(f.adapter.addAuthenticator(session(), { deviceId: DEVICE, attemptId: 'add-attempt-1' }, signal())).rejects.toMatchObject({ code: 'AUTH_ENROLL_MOBILE_ADD_UNCERTAIN' })
    expect(f.count('ITwoFactorService/AddAuthenticator')).toBe(1)
  })

  it.each([302, 403, 429, 500])('does not follow or retry HTTP %s responses and exposes no access-token URL', async status => {
    const f = fixture(); f.set('ITwoFactorService/QueryStatus', new Response(PRIVATE, { status, headers: { location: 'https://untrusted.example/' } }))
    const failure = await f.adapter.queryStatus(session(), null, signal()).catch(value => value)
    expect(failure.message).toMatch(/^AUTH_ENROLL_MOBILE_/)
    expect(failure.message).not.toContain(PRIVATE); expect(failure.message).not.toContain('access_token'); expect(failure.message).not.toContain(jwt())
    expect(f.count('ITwoFactorService/QueryStatus')).toBe(1)
    expect(f.requests[0]?.init).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'POST' })
  })
})
