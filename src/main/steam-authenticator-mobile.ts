import { randomUUID } from 'node:crypto'
import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType, ESessionPersistence } from 'steam-session'
import { DomainError } from '../shared/domain'
import { LoginApiTransport } from './login-api-transport'
import type { EnrollmentSession, EnrollmentLoginResult, EnrollmentPhoneResult, EnrollmentIssuedMaterialRescue, EnrollmentAddNotSubmitted, SteamAuthenticatorEnrollmentBackend, SteamAuthenticatorEnrollmentCandidate } from './steam-authenticator-enrollment'

export interface SteamAuthenticatorMobileNetwork { fetch: typeof fetch; dispose(): void }
export interface SteamAuthenticatorMobileLoginSession {
  steamID: { getSteamID64(): string } | null
  accountName: string
  accessToken: string
  refreshToken: string
  loginTimeout: number
  on(event: string, listener: (...values: any[]) => void): this
  removeAllListeners(event?: string): this
  startWithCredentials(input: { accountName: string; password: string; persistence: ESessionPersistence }): Promise<{ actionRequired: boolean; validActions?: Array<{ type: EAuthSessionGuardType; detail?: string }> }>
  submitSteamGuardCode(code: string): Promise<void>
  refreshAccessToken(): Promise<void>
  cancelLoginAttempt(): void
}
export interface SteamAuthenticatorMobileOptions {
  createNetwork(): SteamAuthenticatorMobileNetwork
  createSession?(transport: LoginApiTransport): SteamAuthenticatorMobileLoginSession
  now?(): number
  loginTimeoutMs?: number
  requestTimeoutMs?: number
}

type MobileCode = 'INVALID' | 'CANCELLED' | 'AUTH_REQUIRED' | 'LOGIN_FAILED' | 'GUARD_INVALID' | 'PHONE_REQUIRED' |
  'PHONE_VERIFY_FAILED' | 'RATE_LIMITED' | 'AUTHENTICATOR_PRESENT' | 'ADD_FAILED' | 'ADD_UNCERTAIN' |
  'ACTIVATION_INVALID' | 'CODE_INVALID' | 'FINALIZE_FAILED' | 'STATUS_INVALID' | 'TIME_UNAVAILABLE' | 'NETWORK_FAILED'
const fail = (code: MobileCode): DomainError => new DomainError(`AUTH_ENROLL_MOBILE_${code}`, `AUTH_ENROLL_MOBILE_${code}`)
const MOBILE_CODES = new Set<MobileCode>(['INVALID', 'CANCELLED', 'AUTH_REQUIRED', 'LOGIN_FAILED', 'GUARD_INVALID', 'PHONE_REQUIRED', 'PHONE_VERIFY_FAILED', 'RATE_LIMITED', 'AUTHENTICATOR_PRESENT', 'ADD_FAILED', 'ADD_UNCERTAIN', 'ACTIVATION_INVALID', 'CODE_INVALID', 'FINALIZE_FAILED', 'STATUS_INVALID', 'TIME_UNAVAILABLE', 'NETWORK_FAILED'])
const safeFailure = (failure: unknown, fallback: MobileCode): DomainError => {
  const code = failure instanceof DomainError && failure.code.startsWith('AUTH_ENROLL_MOBILE_') ? failure.code.slice('AUTH_ENROLL_MOBILE_'.length) : ''
  return fail(MOBILE_CODES.has(code as MobileCode) ? code as MobileCode : fallback)
}
const owner = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > 76561197960265728n && BigInt(value) <= 76561197960265728n + 0xffffffffn
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.@+\-]{1,127}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const device = (value: unknown): value is string => typeof value === 'string' && /^android:[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(value)
const positiveTime = (value: unknown): number => {
  const number = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(number) || Number(number) < 1) throw fail('INVALID')
  return Number(number)
}
const integer = (value: unknown, maximum = 0xffffffff): number => {
  const number = typeof value === 'string' && /^(0|[1-9]\d{0,9})$/.test(value) ? Number(value) : value
  if (!Number.isInteger(number) || Number(number) < 0 || Number(number) > maximum) throw fail('INVALID')
  return Number(number)
}
const decimal = (value: unknown): string => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,19}$/.test(text) || BigInt(text) > 0xffffffffffffffffn) throw fail('INVALID')
  return text
}
const text = (value: unknown, maximum = 256): string => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw fail('INVALID')
  return value
}
const secret = (value: unknown, bytes = 20): string => {
  const source = text(value, 512)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw fail('INVALID')
  const decoded = Buffer.from(source, 'base64')
  try { if (decoded.length !== bytes || decoded.toString('base64') !== source) throw fail('INVALID'); return source }
  finally { decoded.fill(0) }
}
const auxiliarySecret = (value: unknown): string => {
  const source = text(value, 256)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw fail('INVALID')
  const decoded = Buffer.from(source, 'base64')
  try { if (!decoded.length || decoded.length > 128 || decoded.toString('base64') !== source) throw fail('INVALID'); return source }
  finally { decoded.fill(0) }
}
function token(value: unknown, steamId: string, refresh: boolean, now: number): string {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw fail('AUTH_REQUIRED')
  try {
    const decoded = JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!object(decoded) || decoded.sub !== steamId || !Array.isArray(decoded.aud) || !decoded.aud.includes('mobile') ||
      decoded.aud.includes('derive') !== refresh || !Number.isFinite(decoded.exp) || Number(decoded.exp) <= now / 1000 + 15) throw fail('AUTH_REQUIRED')
    return value
  } catch { throw fail('AUTH_REQUIRED') }
}
function mobileSession(value: EnrollmentSession, now: number): { steamId: string; accountName: string; refreshToken: string; accessToken?: string } {
  if (!object(value) || value.schema !== 1 || value.platform !== 'mobile' || !owner(value.steamId) || !name(value.accountName)) throw fail('AUTH_REQUIRED')
  const refreshToken = token(value.refreshToken, value.steamId, true, now)
  let accessToken: string | undefined
  try { accessToken = token(value.accessToken, value.steamId, false, now) } catch { /* A mobile refresh can replace an expired access token. */ }
  return { steamId: value.steamId, accountName: value.accountName, refreshToken, accessToken }
}
function jsonWithoutIntegerLoss(source: string): unknown {
  let result = '', quoted = false, escaped = false
  for (let index = 0; index < source.length;) {
    const character = source[index]!
    if (quoted) { result += character; if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; index++; continue }
    if (character === '"') { quoted = true; result += character; index++; continue }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) { const raw = number[0]; result += /^\d+$/.test(raw) && !Number.isSafeInteger(Number(raw)) ? JSON.stringify(raw) : raw; index += raw.length; continue }
    result += character; index++
  }
  return JSON.parse(result)
}
function emailHint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 254) return undefined
  const matched = value.match(/^([^@\s])[^@\s]*@([A-Za-z0-9.-]+)$/)
  return matched ? `${matched[1]}***@${matched[2]}` : undefined
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('CANCELLED'))
    if (signal.aborted) { void pending.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  })
}
interface LoginAttempt {
  id: string; accountName: string; session: SteamAuthenticatorMobileLoginSession; network: SteamAuthenticatorMobileNetwork
  transport: LoginApiTransport; signal: AbortSignal; abort(): void; timer: ReturnType<typeof setTimeout>
  done: Promise<EnrollmentLoginResult>; complete(result: EnrollmentLoginResult): void; reject(error: unknown): void
  result?: EnrollmentLoginResult; failed?: DomainError; guardType?: 'email' | 'device' | 'confirmation'; hint?: string
  retired?: boolean
}
const ROUTES = new Set([
  'IPhoneService/AccountPhoneStatus', 'IPhoneService/SetAccountPhoneNumber', 'IPhoneService/IsAccountWaitingForEmailConfirmation',
  'IPhoneService/SendPhoneVerificationCode', 'IPhoneService/VerifyAccountPhoneWithCode',
  'ITwoFactorService/AddAuthenticator', 'ITwoFactorService/FinalizeAddAuthenticator', 'ITwoFactorService/QueryStatus', 'ITwoFactorService/QueryTime'
])

export class SteamAuthenticatorMobileAdapter implements SteamAuthenticatorEnrollmentBackend {
  private attempts = new Map<string, LoginAttempt>()
  private addAttempts = new Set<string>()
  private lifetime = new AbortController()
  constructor(private readonly options: SteamAuthenticatorMobileOptions) {}
  dispose(): void { this.lifetime.abort(); for (const attempt of [...this.attempts.values()]) this.retire(attempt) }
  private now(): number { return (this.options.now ?? Date.now)() }
  private signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.lifetime.signal]) }
  private sdk(transport: LoginApiTransport): SteamAuthenticatorMobileLoginSession {
    const session = this.options.createSession?.(transport) ?? new LoginSession(EAuthTokenPlatformType.MobileApp, { transport }) as unknown as SteamAuthenticatorMobileLoginSession
    session.removeAllListeners('debug'); session.removeAllListeners('debug-handler')
    return session
  }
  private network(code: MobileCode): SteamAuthenticatorMobileNetwork {
    try { return this.options.createNetwork() } catch { throw fail(code) }
  }
  private retire(attempt: LoginAttempt): void {
    if (attempt.retired) return
    attempt.retired = true
    if (!attempt.result && !attempt.failed) { attempt.failed = fail('AUTH_REQUIRED'); attempt.reject(attempt.failed) }
    this.attempts.delete(attempt.id); clearTimeout(attempt.timer); attempt.signal.removeEventListener('abort', attempt.abort)
    try { attempt.session.cancelLoginAttempt() } catch {}
    attempt.transport.close(); attempt.network.dispose()
  }
  private async completed(attempt: LoginAttempt): Promise<EnrollmentLoginResult> {
    try { return await abortable(attempt.done, attempt.signal) }
    finally { this.retire(attempt) }
  }
  async login(input: { accountName: string; password?: string; code?: string; resume?: EnrollmentSession }, inherited: AbortSignal): Promise<EnrollmentLoginResult> {
    const signal = this.signal(inherited)
    if (signal.aborted) throw fail('CANCELLED')
    if (!input || !name(input.accountName)) throw fail('INVALID')
    if (input.resume) {
      const handle = input.resume.authHandle
      const attempt = typeof handle === 'string' ? this.attempts.get(handle) : undefined
      if (!attempt || attempt.accountName.toLowerCase() !== input.accountName.toLowerCase() || attempt.signal.aborted) throw fail('AUTH_REQUIRED')
      if (attempt.result || attempt.failed) return this.completed(attempt)
      if (input.code !== undefined) {
        if (!/^[A-Za-z0-9]{5,8}$/.test(input.code) || !['email', 'device'].includes(attempt.guardType ?? '')) throw fail('GUARD_INVALID')
        try { await abortable(attempt.session.submitSteamGuardCode(input.code), signal) }
        catch { if (signal.aborted) { this.retire(attempt); throw fail('CANCELLED') }; throw fail('GUARD_INVALID') }
        return this.completed(attempt)
      }
      return { kind: 'guard', guardType: attempt.guardType!, resume: { authHandle: attempt.id }, ...(attempt.hint ? { hint: attempt.hint } : {}) }
    }
    if (typeof input.password !== 'string' || !input.password || Buffer.byteLength(input.password) > 1024 || input.password.includes('\0')) throw fail('INVALID')
    for (const attempt of [...this.attempts.values()]) if (attempt.accountName.toLowerCase() === input.accountName.toLowerCase()) this.retire(attempt)
    if (this.attempts.size >= 8) throw fail('LOGIN_FAILED')
    const network = this.network('LOGIN_FAILED'), transport = new LoginApiTransport({ fetchImpl: network.fetch, signal })
    let session: SteamAuthenticatorMobileLoginSession
    try { session = this.sdk(transport); session.loginTimeout = Math.max(30000, Math.min(180000, this.options.loginTimeoutMs ?? 120000)) }
    catch { transport.close(); network.dispose(); throw fail('LOGIN_FAILED') }
    let complete!: (value: EnrollmentLoginResult) => void, reject!: (failure: unknown) => void
    const done = new Promise<EnrollmentLoginResult>((resolve, fail) => { complete = resolve; reject = fail }); void done.catch(() => {})
    const attempt = { id: randomUUID(), accountName: input.accountName, network, transport, session, signal, done, complete, reject,
      abort: () => { attempt.failed = fail('CANCELLED'); attempt.reject(attempt.failed); this.retire(attempt) },
      timer: setTimeout(() => { attempt.failed = fail('AUTH_REQUIRED'); attempt.reject(attempt.failed); this.retire(attempt) }, session.loginTimeout + 10000) } as LoginAttempt
    attempt.timer.unref?.(); this.attempts.set(attempt.id, attempt); signal.addEventListener('abort', attempt.abort, { once: true })
    session.on('error', () => { attempt.failed = fail('LOGIN_FAILED'); attempt.reject(attempt.failed); this.retire(attempt) })
    session.on('timeout', () => { attempt.failed = fail('AUTH_REQUIRED'); attempt.reject(attempt.failed); this.retire(attempt) })
    session.on('authenticated', () => {
      if (attempt.retired || signal.aborted || this.attempts.get(attempt.id) !== attempt) return
      try {
        const steamId = session.steamID?.getSteamID64(), accountName = session.accountName
        if (!owner(steamId) || !name(accountName) || accountName.toLowerCase() !== attempt.accountName.toLowerCase()) throw fail('AUTH_REQUIRED')
        const authenticated: EnrollmentSession = { schema: 1, platform: 'mobile', steamId, accountName,
          accessToken: token(session.accessToken, steamId, false, this.now()), refreshToken: token(session.refreshToken, steamId, true, this.now()) }
        attempt.result = { kind: 'authenticated', name: accountName, steamId, session: authenticated }; attempt.complete(attempt.result)
      } catch { attempt.failed = fail('AUTH_REQUIRED'); attempt.reject(attempt.failed) }
    })
    try {
      const started = await abortable(session.startWithCredentials({ accountName: input.accountName, password: input.password, persistence: ESessionPersistence.Persistent }), signal)
      if (attempt.result || attempt.failed || !started.actionRequired) return await this.completed(attempt)
      const actions = started.validActions ?? []
      if (actions.some(value => value.type === EAuthSessionGuardType.EmailCode)) attempt.guardType = 'email'
      else if (actions.some(value => value.type === EAuthSessionGuardType.DeviceCode)) attempt.guardType = 'device'
      else if (actions.some(value => value.type === EAuthSessionGuardType.DeviceConfirmation || value.type === EAuthSessionGuardType.EmailConfirmation)) attempt.guardType = 'confirmation'
      else throw fail('LOGIN_FAILED')
      attempt.hint = actions.find(value => value.type === EAuthSessionGuardType.EmailCode)?.detail?.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 128)
      return { kind: 'guard', guardType: attempt.guardType, resume: { authHandle: attempt.id }, ...(attempt.hint ? { hint: attempt.hint } : {}) }
    } catch (failure) { this.retire(attempt); throw signal.aborted ? fail('CANCELLED') : safeFailure(failure, 'LOGIN_FAILED') }
  }
  private async access(session: EnrollmentSession, signal: AbortSignal): Promise<{ steamId: string; accountName: string; accessToken: string }> {
    if (signal.aborted) throw fail('CANCELLED')
    const current = mobileSession(session, this.now())
    if (current.accessToken) return { ...current, accessToken: current.accessToken }
    const network = this.network('AUTH_REQUIRED'), transport = new LoginApiTransport({ fetchImpl: network.fetch, signal })
    try {
      const sdk = this.sdk(transport)
      sdk.refreshToken = current.refreshToken
      await abortable(sdk.refreshAccessToken(), signal)
      if (signal.aborted) throw fail('CANCELLED')
      const accessToken = token(sdk.accessToken, current.steamId, false, this.now())
      session.accessToken = accessToken
      return { steamId: current.steamId, accountName: current.accountName, accessToken }
    } catch { throw signal.aborted ? fail('CANCELLED') : fail('AUTH_REQUIRED') }
    finally { transport.close(); network.dispose() }
  }
  private async api(route: string, fields: Record<string, string>, signal: AbortSignal, accessToken?: string, beforeDispatch?: () => void): Promise<Record<string, unknown>> {
    if (!ROUTES.has(route)) throw fail('INVALID')
    if (signal.aborted) throw fail('CANCELLED')
    const network = this.network('NETWORK_FAILED')
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), Math.max(1000, Math.min(30000, this.options.requestTimeoutMs ?? 15000)))
    timer.unref?.()
    const combined = AbortSignal.any([signal, timeout.signal])
    try {
      const url = new URL(`https://api.steampowered.com/${route}/v1/`)
      if (accessToken) url.searchParams.set('access_token', accessToken)
      if (combined.aborted) throw fail('CANCELLED')
      beforeDispatch?.()
      const pending = network.fetch(url, { method: 'POST', body: new URLSearchParams(fields), signal: combined, credentials: 'omit', redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': 'okhttp/4.9.2' } })
      void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
      const response = await abortable(pending, combined)
      if (response.redirected || response.url && (new URL(response.url).origin !== url.origin || new URL(response.url).pathname !== url.pathname)) throw fail('NETWORK_FAILED')
      if (response.status === 429) throw fail('RATE_LIMITED')
      if (response.status === 401 || response.status === 403) throw fail('AUTH_REQUIRED')
      if (!response.ok || !/^application\/(?:json|[^;\s]+\+json)\b/i.test(response.headers.get('content-type') ?? '')) throw fail('NETWORK_FAILED')
      const result = response.headers.get('x-eresult')
      if (result && result !== '1') throw fail(result === '84' ? 'RATE_LIMITED' : result === '15' ? 'AUTH_REQUIRED' : 'NETWORK_FAILED')
      const chunks: Buffer[] = []; let size = 0
      const length = response.headers.get('content-length')
      if (length && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) throw fail('NETWORK_FAILED')
      if (!response.body) throw fail('NETWORK_FAILED')
      const reader = response.body.getReader()
      try {
        for (;;) { const part = await abortable(reader.read(), combined); if (part.done) break; size += part.value.byteLength; if (size > 1024 * 1024) throw fail('NETWORK_FAILED'); chunks.push(Buffer.from(part.value)) }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      const parsed = jsonWithoutIntegerLoss(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
      if (!object(parsed) || !object(parsed.response) || parsed.response.success === false && !route.endsWith('/FinalizeAddAuthenticator') && !route.endsWith('/AddAuthenticator')) throw fail('NETWORK_FAILED')
      return parsed.response
    } catch (failure) {
      if (signal.aborted) throw fail('CANCELLED')
      throw safeFailure(failure, 'NETWORK_FAILED')
    } finally { clearTimeout(timer); network.dispose() }
  }
  private async phoneState(accessToken: string, signal: AbortSignal): Promise<boolean> {
    const response = await this.api('IPhoneService/AccountPhoneStatus', {}, signal, accessToken)
    if (typeof response.verified_phone !== 'boolean') throw fail('PHONE_VERIFY_FAILED')
    return response.verified_phone
  }
  async phone(session: EnrollmentSession, input: { op: 'status' | 'begin' | 'send-sms' | 'submit-sms'; phoneNumber?: string; countryCode?: string; code?: string; resume?: EnrollmentSession }, inherited: AbortSignal): Promise<EnrollmentPhoneResult> {
    if (!input || !['status', 'begin', 'send-sms', 'submit-sms'].includes(input.op)) throw fail('INVALID')
    if (input.op === 'begin' && (typeof input.phoneNumber !== 'string' || !/^\+[1-9]\d{5,14}$/.test(input.phoneNumber) || typeof input.countryCode !== 'string' || !/^[1-9]\d{0,3}$/.test(input.countryCode))) throw fail('INVALID')
    if (input.op === 'submit-sms' && (typeof input.code !== 'string' || !/^[0-9]{4,10}$/.test(input.code))) throw fail('INVALID')
    const signal = this.signal(inherited), current = await this.access(session, signal)
    if (input.resume?.steamId && input.resume.steamId !== current.steamId) throw fail('INVALID')
    if (await this.phoneState(current.accessToken, signal)) return { status: 'ready' }
    const pending = await this.api('IPhoneService/IsAccountWaitingForEmailConfirmation', {}, signal, current.accessToken)
    if (typeof pending.awaiting_email_confirmation !== 'boolean') throw fail('PHONE_VERIFY_FAILED')
    const wait = pending.seconds_to_wait === undefined ? 0 : integer(pending.seconds_to_wait, 86400) * 1000
    if (pending.awaiting_email_confirmation) return { status: 'email-required', resume: { steamId: current.steamId, step: 'email' }, ...(wait ? { retryAfterMs: wait } : {}) }
    const priorPhoneStep = input.resume?.step === 'email' || input.resume?.step === 'sms'
    if (wait) return { status: priorPhoneStep ? 'sms-required' : 'phone-needed', ...(priorPhoneStep ? { resume: { steamId: current.steamId, step: input.resume!.step! } } : {}), retryAfterMs: wait }
    if (input.op === 'status') return { status: priorPhoneStep ? 'sms-required' : 'phone-needed', ...(priorPhoneStep ? { resume: { steamId: current.steamId, step: input.resume!.step! } } : {}) }
    if (input.op === 'begin') {
      const response = await this.api('IPhoneService/SetAccountPhoneNumber', { phone_number: input.phoneNumber!, phone_country_code: input.countryCode! }, signal, current.accessToken)
      const hint = emailHint(response.confirmation_email_address)
      if (!hint) throw fail('PHONE_VERIFY_FAILED')
      return { status: 'email-required', resume: { steamId: current.steamId, step: 'email' }, hint }
    }
    if (input.op === 'send-sms') {
      await this.api('IPhoneService/SendPhoneVerificationCode', {}, signal, current.accessToken)
      return { status: 'sms-required', resume: { steamId: current.steamId, step: 'sms' } }
    }
    await this.api('IPhoneService/VerifyAccountPhoneWithCode', { code: input.code! }, signal, current.accessToken)
    if (!await this.phoneState(current.accessToken, signal)) throw fail('PHONE_VERIFY_FAILED')
    return { status: 'ready' }
  }
  async addAuthenticator(session: EnrollmentSession, input: { deviceId: string; attemptId: string }, inherited: AbortSignal, lifecycle?: { onDispatch(): void }): Promise<SteamAuthenticatorEnrollmentCandidate | EnrollmentIssuedMaterialRescue | EnrollmentAddNotSubmitted> {
    const signal = this.signal(inherited)
    if (object(session) && owner(session.steamId) && input && opaqueId(input.attemptId) && this.addAttempts.has(`${session.steamId}:${input.attemptId}`)) throw fail('ADD_UNCERTAIN')
    if (!input || !device(input.deviceId) || !opaqueId(input.attemptId)) return { kind: 'not-submitted', reason: 'invalid-input', proof: 'request-not-sent' }
    let current: Awaited<ReturnType<SteamAuthenticatorMobileAdapter['access']>>
    try { current = await this.access(session, signal) }
    catch (failure) { return { kind: 'not-submitted', reason: safeFailure(failure, 'NETWORK_FAILED').code === 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' ? 'login-required' : 'unavailable', proof: 'request-not-sent' } }
    const attempt = `${current.steamId}:${input.attemptId}`
    if (this.addAttempts.has(attempt)) throw fail('ADD_UNCERTAIN')
    let submitted = false, response: Record<string, unknown>
    try {
      response = await this.api('ITwoFactorService/AddAuthenticator', { steamid: current.steamId, authenticator_type: '1', device_identifier: input.deviceId, sms_phone_id: '1', version: '2' }, signal, current.accessToken,
        () => { lifecycle?.onDispatch(); this.addAttempts.add(attempt); submitted = true })
    } catch (failure) {
      if (submitted) throw failure
      return { kind: 'not-submitted', reason: safeFailure(failure, 'NETWORK_FAILED').code === 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' ? 'login-required' : 'unavailable', proof: 'request-not-sent' }
    }
    let metadataIncomplete = false
    const filtered = <T,>(value: unknown, parser: (input: unknown) => T, required = false): T | undefined => {
      if (value === undefined) { if (required) metadataIncomplete = true; return undefined }
      try { return parser(value) } catch { metadataIncomplete = true; return undefined }
    }
    const sharedSecret = filtered(response.shared_secret, secret, true), identitySecret = filtered(response.identity_secret, secret, true)
    const revocationCode = filtered(response.revocation_code, value => { const code = text(value, 32); if (!/^R[A-Z0-9]{5,31}$/.test(code)) throw fail('INVALID'); return code }, true)
    const tokenGid = filtered(response.token_gid, decimal, true), serialNumber = filtered(response.serial_number, decimal), secret1 = filtered(response.secret_1, auxiliarySecret)
    const material = { ...(sharedSecret ? { sharedSecret } : {}), ...(identitySecret ? { identitySecret } : {}), ...(revocationCode ? { revocationCode } : {}),
      ...(tokenGid ? { tokenGid } : {}), ...(serialNumber ? { serialNumber } : {}), ...(secret1 ? { secret1 } : {}) }
    const receivedSteamId = owner(response.steamid) ? response.steamid : undefined
    const ownerMismatch = response.steamid !== undefined && receivedSteamId !== current.steamId || response.account_name !== undefined && (typeof response.account_name !== 'string' || response.account_name.toLowerCase() !== current.accountName.toLowerCase())
    let status: number | undefined
    try { status = integer(response.status) } catch {}
    const acceptedStatus = status === 1 && (response.success === undefined || response.success === true)
    if (ownerMismatch || !sharedSecret || !identitySecret || !revocationCode || !acceptedStatus) {
      if (Object.keys(material).length) return { kind: 'rescue', expectedSteamId: current.steamId, ...(receivedSteamId ? { receivedSteamId } : {}),
        name: current.accountName, deviceId: input.deviceId, ...material,
        reason: ownerMismatch ? 'owner-mismatch' : !acceptedStatus ? 'status-uncertain' : 'required-material-invalid' }
      if (status === 29) throw fail('AUTHENTICATOR_PRESENT')
      if (status === 2) {
        const issuedEvidence = ['shared_secret', 'identity_secret', 'revocation_code', 'token_gid', 'serial_number', 'secret_1']
          .some(field => response[field] !== undefined && response[field] !== null && response[field] !== '')
        if (issuedEvidence) throw fail('ADD_UNCERTAIN')
        return { kind: 'not-submitted', reason: 'phone-needed', proof: 'authoritative-phone-rejection' }
      }
      throw fail('ADD_FAILED')
    }
    let confirmType: SteamAuthenticatorEnrollmentCandidate['confirmType'] = 'unknown'
    if (tokenGid) {
      const confirm = filtered(response.confirm_type, integer, true)
      confirmType = confirm === 1 ? 'sms' : confirm === 3 ? 'email' : 'unknown'
    }
    if (confirmType === 'unknown') metadataIncomplete = true
    return { name: current.accountName, steamId: current.steamId, deviceId: input.deviceId, fullyEnrolled: false,
      ...material, sharedSecret, identitySecret, revocationCode, confirmType, ...(metadataIncomplete ? { metadataIncomplete: true } : {}) }
  }
  async finalize(session: EnrollmentSession, candidate: SteamAuthenticatorEnrollmentCandidate, input: { activationCode: string; authCode: string; authenticatorTime: number }, inherited: AbortSignal, lifecycle?: { onDispatch(): void }): Promise<{ success: boolean; wantMore: boolean; retryAfterMs?: number }> {
    const signal = this.signal(inherited), current = await this.access(session, signal)
    if (!candidate || candidate.steamId !== current.steamId || candidate.fullyEnrolled !== false || !['sms', 'email'].includes(candidate.confirmType) || !device(candidate.deviceId) ||
      !input || typeof input.activationCode !== 'string' || !/^[A-Za-z0-9]{4,12}$/.test(input.activationCode) || typeof input.authCode !== 'string' || !/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/.test(input.authCode)) throw fail('INVALID')
    const response = await this.api('ITwoFactorService/FinalizeAddAuthenticator', { steamid: current.steamId, authenticator_code: input.authCode,
      authenticator_time: String(positiveTime(input.authenticatorTime)), activation_code: input.activationCode, validate_sms_code: '1' }, signal, current.accessToken, () => lifecycle?.onDispatch())
    const status = integer(response.status)
    if (status === 89) throw fail('ACTIVATION_INVALID')
    if (status === 88) throw fail('CODE_INVALID')
    if (status !== 1 || typeof response.success !== 'boolean' || response.want_more !== undefined && typeof response.want_more !== 'boolean') throw fail('FINALIZE_FAILED')
    return { success: response.success, wantMore: response.want_more === true, ...(response.want_more === true ? { retryAfterMs: 30000 } : {}) }
  }
  async queryStatus(session: EnrollmentSession, candidate: SteamAuthenticatorEnrollmentCandidate | null, inherited: AbortSignal): Promise<{ steamId: string; active: boolean; matchesCandidate: boolean; hasToken: boolean }> {
    const signal = this.signal(inherited), current = await this.access(session, signal)
    if (candidate && candidate.steamId !== current.steamId) throw fail('STATUS_INVALID')
    const response = await this.api('ITwoFactorService/QueryStatus', { steamid: current.steamId, include: '0' }, signal, current.accessToken)
    if (response.steamid !== undefined && String(response.steamid) !== current.steamId) throw fail('STATUS_INVALID')
    const state = integer(response.state)
    if (state > 0 && (response.authenticator_type === undefined || response.inactivation_reason === undefined)) throw fail('STATUS_INVALID')
    const type = integer(response.authenticator_type ?? 0), inactive = integer(response.inactivation_reason ?? 0)
    const gid = response.token_gid === undefined || response.token_gid === '' || response.token_gid === '0' ? null : decimal(response.token_gid)
    const active = state > 0 && type === 1 && inactive === 0
    if (!candidate && !(state > 0 || type > 0 || gid !== null) && (response.authenticator_allowed === false || response.allow_external_authenticator === false)) throw fail('ADD_FAILED')
    return { steamId: current.steamId, active, hasToken: state > 0 || type > 0 || gid !== null,
      matchesCandidate: Boolean(active && candidate?.tokenGid && gid === candidate.tokenGid && (response.device_identifier === undefined || response.device_identifier === candidate.deviceId)) }
  }
  async steamTime(inherited: AbortSignal): Promise<number> {
    try { return positiveTime((await this.api('ITwoFactorService/QueryTime', {}, this.signal(inherited))).server_time) }
    catch { throw inherited.aborted || this.lifetime.signal.aborted ? fail('CANCELLED') : fail('TIME_UNAVAILABLE') }
  }
}
