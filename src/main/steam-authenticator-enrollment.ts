import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DomainError } from '../shared/domain'
import { EncryptedAuthenticatorStateStore, generateSteamGuardCode, parseSdaMaFile } from './steam-authenticator'
import type { SteamAuthenticatorEnrolledMaterial, SteamAuthenticatorService } from './steam-authenticator'
import type { SecretCipher } from './store'
import type { SteamAuthenticatorEnrollmentPhase, SteamAuthenticatorEnrollmentSnapshot } from '../shared/steam-authenticator-enrollment'

export type EnrollmentJson = null | boolean | number | string | EnrollmentJson[] | { [key: string]: EnrollmentJson }
export type EnrollmentSession = { [key: string]: EnrollmentJson }
export interface SteamAuthenticatorEnrollmentCandidate extends Omit<SteamAuthenticatorEnrolledMaterial, 'fullyEnrolled'> {
  fullyEnrolled: false
  confirmType: 'sms' | 'email' | 'unknown'
  metadataIncomplete?: boolean
}
export interface EnrollmentIssuedMaterialRescue {
  kind: 'rescue'
  expectedSteamId: string
  receivedSteamId?: string
  name: string
  deviceId: string
  sharedSecret?: string
  identitySecret?: string
  revocationCode?: string
  tokenGid?: string
  serialNumber?: string
  secret1?: string
  reason: 'owner-mismatch' | 'required-material-invalid' | 'status-uncertain'
}
export interface EnrollmentAddNotSubmitted {
  kind: 'not-submitted'
  reason: 'login-required' | 'phone-needed' | 'invalid-input' | 'unavailable'
  proof: 'request-not-sent' | 'authoritative-phone-rejection'
}
export type EnrollmentLoginResult = {
  kind: 'guard'
  guardType: 'email' | 'device' | 'confirmation'
  resume: EnrollmentSession
  hint?: string
} | {
  kind: 'authenticated'
  name: string
  steamId: string
  session: EnrollmentSession
}
export interface EnrollmentPhoneResult {
  status: 'phone-needed' | 'email-required' | 'sms-required' | 'ready'
  resume?: EnrollmentSession
  hint?: string
  retryAfterMs?: number
}
export interface EnrollmentMutationLifecycle { onDispatch(): void }
export interface SteamAuthenticatorEnrollmentBackend {
  login(input: { accountName: string; password?: string; code?: string; resume?: EnrollmentSession }, signal: AbortSignal): Promise<EnrollmentLoginResult>
  phone(session: EnrollmentSession, input: { op: 'status' | 'begin' | 'send-sms' | 'submit-sms'; phoneNumber?: string; countryCode?: string; code?: string; resume?: EnrollmentSession }, signal: AbortSignal): Promise<EnrollmentPhoneResult>
  addAuthenticator(session: EnrollmentSession, input: { deviceId: string; attemptId: string }, signal: AbortSignal, lifecycle?: EnrollmentMutationLifecycle): Promise<SteamAuthenticatorEnrollmentCandidate | EnrollmentIssuedMaterialRescue | EnrollmentAddNotSubmitted>
  finalize(session: EnrollmentSession, candidate: SteamAuthenticatorEnrollmentCandidate, input: { activationCode: string; authCode: string; authenticatorTime: number }, signal: AbortSignal, lifecycle?: EnrollmentMutationLifecycle): Promise<{ success: boolean; wantMore: boolean; retryAfterMs?: number }>
  queryStatus(session: EnrollmentSession, candidate: SteamAuthenticatorEnrollmentCandidate | null, signal: AbortSignal): Promise<{ steamId: string; active: boolean; matchesCandidate: boolean; hasToken?: boolean }>
  steamTime(signal: AbortSignal): Promise<number>
}
export interface SteamAuthenticatorEnrollmentOptions {
  pendingPath: string
  cipher: SecretCipher
  vault: Pick<SteamAuthenticatorService, 'saveEnrolled' | 'exportPendingMaterialTo' | 'exportIsolatedRescueTo'>
  backend: SteamAuthenticatorEnrollmentBackend
  confirmAdd(account: { name: string; steamId: string }, signal?: AbortSignal): Promise<boolean>
  confirmRecoverySaved(account: { name: string; steamId: string }, signal?: AbortSignal): Promise<boolean>
  shutdownTimeoutMs?: number
  now?: () => number
  onChange?(snapshot: SteamAuthenticatorEnrollmentSnapshot): void
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NAME = /^[A-Za-z0-9_.@-]{1,64}$/
const BASE = 76_561_197_960_265_728n
const phases: SteamAuthenticatorEnrollmentPhase[] = ['idle', 'login-required', 'guard-required', 'phone-needed', 'email-required', 'sms-required', 'ready-to-add', 'adding', 'add-uncertain', 'backup-required', 'ready-to-finalize', 'finalizing', 'finalize-wait', 'verifying', 'complete', 'paused', 'error']
const mobileCodes = new Set(['AUTH_REQUIRED', 'LOGIN_FAILED', 'GUARD_INVALID', 'PHONE_REQUIRED', 'PHONE_VERIFY_FAILED', 'RATE_LIMITED', 'AUTHENTICATOR_PRESENT', 'ADD_FAILED', 'ADD_UNCERTAIN', 'ACTIVATION_INVALID', 'CODE_INVALID', 'FINALIZE_FAILED', 'STATUS_INVALID', 'TIME_UNAVAILABLE', 'INVALID', 'CANCELLED', 'NETWORK_FAILED'].map(value => `AUTH_ENROLL_MOBILE_${value}`))
const failure = (code: string): DomainError => new DomainError(`AUTHENTICATOR_ENROLLMENT_${code}`, `AUTHENTICATOR_ENROLLMENT_${code}`)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validSteamId = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > BASE && BigInt(value) <= BASE + 0xffff_ffffn
const ownError = (error: unknown): string => error instanceof DomainError && (error.code.startsWith('AUTHENTICATOR_ENROLLMENT_') || mobileCodes.has(error.code)) ? error.code : 'AUTHENTICATOR_ENROLLMENT_UNAVAILABLE'
const hint = (value: unknown): string | null => typeof value === 'string' && value.length <= 160 && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value) ? value : null

interface PendingEnrollment {
  schema: 1
  id: string
  phase: SteamAuthenticatorEnrollmentPhase
  accountName: string
  steamId: string | null
  expectedSteamId?: string
  session?: EnrollmentSession
  guardResume?: EnrollmentSession
  guardType?: 'email' | 'device' | 'confirmation'
  phoneResume?: EnrollmentSession
  hint?: string
  deviceId: string
  attemptId?: string
  candidate?: SteamAuthenticatorEnrollmentCandidate
  rescue?: EnrollmentIssuedMaterialRescue
  exportProof?: { path: string; sha256: string }
  recoveryAcknowledged: boolean
  verificationRequired?: boolean
  retryAt?: number
  entryId?: string
  error?: string
  resumePhase?: SteamAuthenticatorEnrollmentPhase
}

function opaque(value: unknown): EnrollmentSession {
  const walk = (item: unknown, depth: number): void => {
    if (depth > 10) throw failure('STATE_INVALID')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') { if (item.length > 16384 || /[\uD800-\uDFFF]/u.test(item)) throw failure('STATE_INVALID'); return }
    if (typeof item === 'number') { if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) throw failure('STATE_INVALID'); return }
    if (Array.isArray(item)) { if (item.length > 128) throw failure('STATE_INVALID'); for (const child of item) walk(child, depth + 1); return }
    if (!object(item) || Object.keys(item).length > 64) throw failure('STATE_INVALID')
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || /password|passwd|guardcode|smscode|emailcode|activationcode|authcode|sharedsecret|identitysecret|revocationcode/.test(key.replace(/[^a-z]/gi, '').toLowerCase())) throw failure('STATE_INVALID')
      walk(child, depth + 1)
    }
  }
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 65536) throw failure('STATE_INVALID')
  walk(value, 0)
  return JSON.parse(JSON.stringify(value)) as EnrollmentSession
}

function checkedCandidate(value: unknown): SteamAuthenticatorEnrollmentCandidate {
  if (!object(value) || value.fullyEnrolled !== false || !['sms', 'email', 'unknown'].includes(String(value.confirmType))
    || value.metadataIncomplete !== undefined && typeof value.metadataIncomplete !== 'boolean') throw failure('MATERIAL_INVALID')
  const parsed = parseSdaMaFile(JSON.stringify({ account_name: value.name, SteamID: value.steamId, shared_secret: value.sharedSecret,
    identity_secret: value.identitySecret, device_id: value.deviceId, revocation_code: value.revocationCode, fully_enrolled: false,
    serial_number: value.serialNumber, token_gid: value.tokenGid, secret_1: value.secret1 }), { retainSdaBackup: true })
  if (!parsed.steamId || !parsed.backup?.identitySecret || !parsed.backup.deviceId || !parsed.backup.revocationCode) throw failure('MATERIAL_INVALID')
  return { name: parsed.name, steamId: parsed.steamId, sharedSecret: parsed.sharedSecret, identitySecret: parsed.backup.identitySecret,
    deviceId: parsed.backup.deviceId, revocationCode: parsed.backup.revocationCode, fullyEnrolled: false, confirmType: value.confirmType as 'sms' | 'email' | 'unknown',
    ...(parsed.backup.serialNumber ? { serialNumber: parsed.backup.serialNumber } : {}), ...(parsed.backup.tokenGid ? { tokenGid: parsed.backup.tokenGid } : {}), ...(parsed.backup.secret1 ? { secret1: parsed.backup.secret1 } : {}),
    ...(value.metadataIncomplete ? { metadataIncomplete: true } : {}) }
}

function checkedRescue(value: unknown): EnrollmentIssuedMaterialRescue {
  const keys = ['kind', 'expectedSteamId', 'receivedSteamId', 'name', 'deviceId', 'sharedSecret', 'identitySecret', 'revocationCode', 'tokenGid', 'serialNumber', 'secret1', 'reason']
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || value.kind !== 'rescue' || !validSteamId(value.expectedSteamId)
    || value.receivedSteamId !== undefined && !validSteamId(value.receivedSteamId) || typeof value.name !== 'string' || !NAME.test(value.name)
    || typeof value.deviceId !== 'string' || !/^android:[0-9a-f-]{36}$/i.test(value.deviceId)
    || !['owner-mismatch', 'required-material-invalid', 'status-uncertain'].includes(String(value.reason))) throw failure('MATERIAL_INVALID')
  for (const key of ['sharedSecret', 'identitySecret', 'revocationCode', 'tokenGid', 'serialNumber', 'secret1']) {
    const item = value[key]
    if (item !== undefined && (typeof item !== 'string' || !item.length || item.length > 512 || /[^\x21-\x7e]/.test(item))) throw failure('MATERIAL_INVALID')
  }
  return { ...value } as unknown as EnrollmentIssuedMaterialRescue
}

function checkedNotSubmitted(value: unknown): EnrollmentAddNotSubmitted {
  if (!object(value) || Object.keys(value).length !== 3 || !['kind', 'reason', 'proof'].every(key => Object.hasOwn(value, key))
    || value.kind !== 'not-submitted' || !['login-required', 'phone-needed', 'invalid-input', 'unavailable'].includes(String(value.reason))
    || !['request-not-sent', 'authoritative-phone-rejection'].includes(String(value.proof))
    || value.proof === 'authoritative-phone-rejection' && value.reason !== 'phone-needed') throw failure('STATE_INVALID')
  return value as unknown as EnrollmentAddNotSubmitted
}

function checkedPending(value: unknown): PendingEnrollment {
  const keys = ['schema', 'id', 'phase', 'accountName', 'steamId', 'expectedSteamId', 'session', 'guardResume', 'guardType', 'phoneResume', 'hint', 'deviceId', 'attemptId', 'candidate', 'rescue', 'exportProof', 'recoveryAcknowledged', 'verificationRequired', 'retryAt', 'entryId', 'error', 'resumePhase']
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || value.schema !== 1 || typeof value.id !== 'string' || !ID.test(value.id)
    || !phases.includes(value.phase as SteamAuthenticatorEnrollmentPhase) || typeof value.accountName !== 'string' || !NAME.test(value.accountName)
    || value.steamId !== null && !validSteamId(value.steamId) || value.expectedSteamId !== undefined && !validSteamId(value.expectedSteamId)
    || typeof value.deviceId !== 'string' || !/^android:[0-9a-f-]{36}$/.test(value.deviceId) || typeof value.recoveryAcknowledged !== 'boolean'
    || value.verificationRequired !== undefined && typeof value.verificationRequired !== 'boolean'
    || value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !ID.test(value.attemptId))
    || value.entryId !== undefined && (typeof value.entryId !== 'string' || !ID.test(value.entryId))
    || value.retryAt !== undefined && (!Number.isSafeInteger(value.retryAt) || Number(value.retryAt) < 0)
    || value.resumePhase !== undefined && !phases.includes(value.resumePhase as SteamAuthenticatorEnrollmentPhase)
    || value.guardType !== undefined && !['email', 'device', 'confirmation'].includes(String(value.guardType))
    || value.hint !== undefined && hint(value.hint) === null || value.error !== undefined && (typeof value.error !== 'string' || !/^[A-Z][A-Z0-9_]{1,95}$/.test(value.error))) throw failure('STATE_INVALID')
  const result = { ...value } as unknown as PendingEnrollment
  for (const key of ['session', 'guardResume', 'phoneResume'] as const) if (value[key] !== undefined) result[key] = opaque(value[key])
  if (value.candidate !== undefined) {
    result.candidate = checkedCandidate(value.candidate)
    if (!value.attemptId || result.candidate.steamId !== value.steamId || result.candidate.deviceId !== value.deviceId) throw failure('STATE_INVALID')
  }
  if (value.rescue !== undefined) {
    result.rescue = checkedRescue(value.rescue)
    if (result.candidate || !value.attemptId || result.rescue.expectedSteamId !== value.steamId || result.rescue.deviceId !== value.deviceId
      || !['add-uncertain', 'paused', 'login-required', 'guard-required', 'error'].includes(String(value.phase))) throw failure('STATE_INVALID')
  }
  if (value.exportProof !== undefined && (!object(value.exportProof) || Object.keys(value.exportProof).length !== 2 || typeof value.exportProof.path !== 'string' || !isAbsolute(value.exportProof.path)
    || typeof value.exportProof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.exportProof.sha256))) throw failure('STATE_INVALID')
  if (value.recoveryAcknowledged && (!result.candidate || !value.exportProof)) throw failure('STATE_INVALID')
  if (value.verificationRequired && !result.candidate) throw failure('STATE_INVALID')
  if (['adding', 'add-uncertain', 'backup-required', 'ready-to-finalize', 'finalizing', 'finalize-wait', 'verifying', 'complete'].includes(result.phase)
    && (!result.steamId || !result.attemptId)) throw failure('STATE_INVALID')
  if (['backup-required', 'ready-to-finalize', 'finalizing', 'finalize-wait', 'verifying', 'complete'].includes(result.phase) && !result.candidate) throw failure('STATE_INVALID')
  if (result.phase === 'complete' && !result.entryId) throw failure('STATE_INVALID')
  return result
}

export class SteamAuthenticatorEnrollmentService {
  private readonly store: EncryptedAuthenticatorStateStore
  private readonly initialized: Promise<void>
  private value: PendingEnrollment | null = null
  private operation: Promise<unknown> | null = null
  private controller = new AbortController()
  private generation = 0
  private durableCandidate = true
  private mutationDispatched = false
  private stopRequested = false
  private pausing: Promise<SteamAuthenticatorEnrollmentSnapshot> | null = null
  constructor(private readonly options: SteamAuthenticatorEnrollmentOptions) {
    this.store = new EncryptedAuthenticatorStateStore(options.pendingPath, options.cipher)
    this.initialized = this.restore()
    void this.initialized.catch(() => undefined)
  }
  private now(): number { const value = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) throw failure('TIME_INVALID'); return value }
  private async restore(): Promise<void> {
    const saved = await this.store.read()
    if (saved === null) return
    this.value = checkedPending(saved)
    if (this.value.phase === 'adding') await this.persist({ ...this.value, phase: 'add-uncertain', error: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN' })
    else if (this.value.phase === 'finalizing' || this.value.phase === 'verifying') await this.persist({ ...this.value, phase: 'verifying', verificationRequired: true, error: 'AUTHENTICATOR_ENROLLMENT_FINALIZE_UNCERTAIN' })
  }
  private snapshot(): SteamAuthenticatorEnrollmentSnapshot {
    const value = this.value
    return { id: value?.id ?? null, phase: value?.phase ?? 'idle', accountName: value?.accountName ?? null, steamId: value?.steamId ?? null,
      guardType: value?.guardType ?? null, confirmationKind: value?.candidate?.confirmType ?? null, hint: value?.hint ?? null,
      backupExported: Boolean(value?.exportProof), backupAcknowledged: value?.recoveryAcknowledged ?? false, retryAt: value?.retryAt ?? null,
      entryId: value?.entryId ?? null, error: value?.error ?? null, busy: this.operation !== null,
      ...(value?.candidate?.metadataIncomplete ? { metadataIncomplete: true } : {}), ...(value?.rescue ? { hasRescueMaterials: true } : {}) }
  }
  private changed(): void { try { this.options.onChange?.(this.snapshot()) } catch { /* Observer errors do not own enrollment. */ } }
  private async persist(value: PendingEnrollment): Promise<void> {
    const next = checkedPending(JSON.parse(JSON.stringify(value)))
    try { await this.store.write(next) } catch { throw failure('PERSISTENCE_FAILED') }
    this.value = next; this.durableCandidate = true; this.changed()
  }
  state(): Promise<SteamAuthenticatorEnrollmentSnapshot> { return this.initialized.then(() => this.snapshot()) }
  private require(id: string): PendingEnrollment {
    if (!this.value || !ID.test(id) || this.value.id !== id) throw failure('CHANGED')
    return this.value
  }
  private signal(generation: number): AbortSignal { if (this.stopRequested || generation !== this.generation || this.controller.signal.aborted) throw failure('CANCELLED'); return this.controller.signal }
  private dispatched(generation: number): void { this.signal(generation); this.mutationDispatched = true }
  private run(action: (generation: number) => Promise<void>): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    if (this.operation || this.stopRequested) return Promise.reject(failure('BUSY'))
    const generation = this.generation
    const operation = (async () => {
      await this.initialized
      if (this.controller.signal.aborted) this.controller = new AbortController()
      try { this.signal(generation); await action(generation) }
      catch (error) {
        if (this.value) {
          const code = ownError(error)
          this.value = { ...this.value, error: code,
            ...(this.value.phase === 'adding' ? { phase: 'add-uncertain' as const } : {}),
            ...(this.value.phase === 'finalizing' ? ['AUTH_ENROLL_MOBILE_ACTIVATION_INVALID', 'AUTH_ENROLL_MOBILE_CODE_INVALID'].includes(code)
              ? { phase: 'ready-to-finalize' as const, verificationRequired: false } : { phase: 'verifying' as const, verificationRequired: true } : {}) }
          if (code === 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' || code === 'AUTHENTICATOR_ENROLLMENT_LOGIN_REQUIRED') this.value = { ...this.value, phase: 'login-required', session: undefined, guardResume: undefined }
          try { if (this.durableCandidate) await this.persist(this.value) } catch { this.value.error = 'AUTHENTICATOR_ENROLLMENT_PERSISTENCE_FAILED' }
          this.changed()
        }
        const code = ownError(error)
        throw new DomainError(code, code)
      }
    })()
    this.operation = operation; this.changed()
    return operation.finally(() => { if (this.operation === operation) this.operation = null; this.mutationDispatched = false; this.changed() }).then(() => this.snapshot())
  }
  private session(value: PendingEnrollment): EnrollmentSession { if (!value.session || !value.steamId) throw failure('LOGIN_REQUIRED'); return value.session }
  private async loginResult(result: EnrollmentLoginResult, generation: number): Promise<void> {
    this.signal(generation); const value = this.value!
    if (result.kind === 'guard') {
      if (!['email', 'device', 'confirmation'].includes(result.guardType)) throw failure('STATE_INVALID')
      await this.persist({ ...value, phase: 'guard-required', guardType: result.guardType, guardResume: opaque(result.resume), hint: hint(result.hint) ?? undefined, error: undefined })
      return
    }
    if (result.kind !== 'authenticated' || !NAME.test(result.name) || !validSteamId(result.steamId)
      || value.expectedSteamId && value.expectedSteamId !== result.steamId || value.steamId && value.steamId !== result.steamId) throw failure('IDENTITY')
    const session = opaque(result.session)
    if (session.platform !== 'mobile' || session.steamId !== result.steamId) throw failure('IDENTITY')
    await this.persist({ ...value, accountName: result.name, steamId: result.steamId, session, guardResume: undefined, guardType: undefined,
      phase: value.candidate ? value.verificationRequired ? 'verifying' : value.recoveryAcknowledged ? 'ready-to-finalize' : 'backup-required' : value.attemptId ? 'add-uncertain' : 'phone-needed', error: undefined })
    if (value.candidate && value.verificationRequired) { await this.verifyAndCommit(generation); return }
    if (!value.candidate && !value.attemptId) {
      const status = await this.options.backend.queryStatus(this.value!.session!, null, this.signal(generation))
      this.signal(generation)
      if (status.steamId !== result.steamId) throw failure('IDENTITY')
      if (status.active || status.hasToken) throw failure('AUTHENTICATOR_PRESENT')
      await this.phoneResult(await this.options.backend.phone(this.value!.session!, { op: 'status' }, this.signal(generation)), generation)
    }
  }
  login(input: { accountName: string; password: string; expectedSteamId?: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      if (!input || !NAME.test(input.accountName) || typeof input.password !== 'string' || !input.password.length || input.password.length > 1024
        || input.expectedSteamId !== undefined && !validSteamId(input.expectedSteamId)) throw failure('INVALID')
      const old = this.value
      if (old && old.phase !== 'complete' && (old.candidate || old.attemptId) && old.accountName.toLowerCase() !== input.accountName.toLowerCase()) throw failure('BUSY')
      const samePendingAccount = old && old.phase !== 'complete' && old.accountName.toLowerCase() === input.accountName.toLowerCase()
      if (samePendingAccount && input.expectedSteamId && (old.expectedSteamId && old.expectedSteamId !== input.expectedSteamId || old.steamId && old.steamId !== input.expectedSteamId)) throw failure('IDENTITY')
      const next: PendingEnrollment = samePendingAccount ? { ...old, expectedSteamId: input.expectedSteamId ?? old.expectedSteamId, phase: 'login-required', session: undefined, guardResume: undefined }
        : { schema: 1, id: randomUUID(), phase: 'login-required', accountName: input.accountName, steamId: null, expectedSteamId: input.expectedSteamId,
          deviceId: `android:${randomUUID()}`, recoveryAcknowledged: false }
      await this.persist(next)
      await this.loginResult(await this.options.backend.login({ accountName: input.accountName, password: input.password }, this.signal(generation)), generation)
    })
  }
  submitGuard(input: { id: string; code: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (value.phase !== 'guard-required' || !value.guardResume || !/^[A-Za-z0-9]{4,32}$/.test(input.code)) throw failure('INVALID')
      await this.loginResult(await this.options.backend.login({ accountName: value.accountName, code: input.code, resume: value.guardResume }, this.signal(generation)), generation)
    })
  }
  refreshLogin(input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (value.phase !== 'guard-required' || !value.guardResume) throw failure('LOGIN_REQUIRED')
      await this.loginResult(await this.options.backend.login({ accountName: value.accountName, resume: value.guardResume }, this.signal(generation)), generation)
    })
  }
  private async phoneResult(result: EnrollmentPhoneResult, generation: number): Promise<void> {
    this.signal(generation)
    if (!['phone-needed', 'email-required', 'sms-required', 'ready'].includes(result.status)) throw failure('STATE_INVALID')
    if (result.retryAfterMs !== undefined && (!Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 0 || result.retryAfterMs > 7 * 24 * 60 * 60 * 1000)) throw failure('STATE_INVALID')
    await this.persist({ ...this.value!, phase: result.status === 'ready' ? 'ready-to-add' : result.status, phoneResume: result.resume ? opaque(result.resume) : undefined,
      hint: hint(result.hint) ?? undefined, retryAt: result.retryAfterMs ? this.now() + result.retryAfterMs : undefined, error: undefined })
  }
  phone(input: { id: string; op: 'status' | 'begin' | 'send-sms' | 'submit-sms'; phoneNumber?: string; countryCode?: string; code?: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (value.candidate || value.attemptId || !['phone-needed', 'email-required', 'sms-required', 'ready-to-add', 'error'].includes(value.phase)) throw failure('INVALID')
      if (input.op !== 'status' && value.retryAt && this.now() < value.retryAt) throw failure('COOLDOWN')
      if (!['status', 'begin', 'send-sms', 'submit-sms'].includes(input.op) || input.op === 'begin' && (!/^\+?\d{4,20}$/.test(input.phoneNumber ?? '') || !/^\d{1,4}$/.test(input.countryCode ?? ''))
        || input.op === 'submit-sms' && !/^\d{4,12}$/.test(input.code ?? '')) throw failure('INVALID')
      await this.phoneResult(await this.options.backend.phone(this.session(value), { op: input.op, phoneNumber: input.phoneNumber, countryCode: input.countryCode, code: input.code, resume: value.phoneResume }, this.signal(generation)), generation)
    })
  }
  add(input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (!['ready-to-add', 'phone-needed'].includes(value.phase) || value.attemptId || value.candidate) throw failure('ADD_FORBIDDEN')
      if (value.retryAt && this.now() < value.retryAt) throw failure('COOLDOWN')
      const session = this.session(value), status = await this.options.backend.queryStatus(session, null, this.signal(generation))
      this.signal(generation)
      if (status.steamId !== value.steamId) throw failure('IDENTITY')
      if (status.active || status.hasToken) throw failure('AUTHENTICATOR_PRESENT')
      if (!await this.options.confirmAdd({ name: value.accountName, steamId: value.steamId! }, this.signal(generation))) return
      this.signal(generation)
      const attemptId = randomUUID()
      await this.persist({ ...value, attemptId, phase: 'adding', error: undefined })
      const issued = await this.options.backend.addAuthenticator(session, { deviceId: value.deviceId, attemptId }, this.signal(generation), { onDispatch: () => this.dispatched(generation) })
      if (object(issued) && issued.kind === 'not-submitted') {
        const safe = checkedNotSubmitted(issued)
        const phase = safe.reason === 'login-required' || safe.reason === 'phone-needed' ? safe.reason : value.phase
        const error = safe.reason === 'login-required' ? 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' : safe.reason === 'phone-needed' ? 'AUTH_ENROLL_MOBILE_PHONE_REQUIRED'
          : safe.reason === 'invalid-input' ? 'AUTH_ENROLL_MOBILE_INVALID' : 'AUTH_ENROLL_MOBILE_NETWORK_FAILED'
        // Only adapter proof of no Add, or a definitive phone rejection without issued material, can release this attempt.
        await this.persist({ ...value, phase, error, ...(safe.reason === 'login-required' ? { session: undefined, guardResume: undefined } : {}) })
        this.signal(generation); return
      }
      if (object(issued) && issued.kind === 'rescue') {
        const rescue = checkedRescue(issued)
        if (rescue.expectedSteamId !== value.steamId || rescue.deviceId !== value.deviceId) throw failure('IDENTITY')
        const saved: PendingEnrollment = { ...this.value!, rescue, phase: 'add-uncertain', error: rescue.reason === 'owner-mismatch'
          ? 'AUTHENTICATOR_ENROLLMENT_RESCUE_OWNER_MISMATCH' : 'AUTHENTICATOR_ENROLLMENT_RESCUE_MATERIAL_INVALID' }
        try { await this.persist(saved) }
        catch { this.value = { ...saved, error: 'AUTHENTICATOR_ENROLLMENT_PERSISTENCE_FAILED' }; this.durableCandidate = false; throw failure('PERSISTENCE_FAILED') }
        this.signal(generation); return
      }
      const candidate = checkedCandidate(issued)
      if (candidate.steamId !== value.steamId || candidate.deviceId !== value.deviceId) throw failure('IDENTITY')
      const saved: PendingEnrollment = { ...this.value!, candidate, phase: 'backup-required', error: candidate.confirmType === 'unknown' ? 'AUTHENTICATOR_ENROLLMENT_CONFIRM_TYPE_UNSUPPORTED' : undefined }
      try { await this.persist(saved) }
      catch { this.value = { ...saved, error: 'AUTHENTICATOR_ENROLLMENT_PERSISTENCE_FAILED' }; this.durableCandidate = false; throw failure('PERSISTENCE_FAILED') }
      this.signal(generation)
    })
  }
  recoveryMaterial(id: string): Promise<{ name: string; steamId: string; revocationCode: string; isolated?: boolean; receivedSteamId?: string }> {
    return this.initialized.then(() => {
      const value = this.require(id)
      if (value.rescue?.revocationCode) return { name: value.rescue.name, steamId: value.rescue.expectedSteamId, revocationCode: value.rescue.revocationCode,
        isolated: true, ...(value.rescue.receivedSteamId ? { receivedSteamId: value.rescue.receivedSteamId } : {}) }
      if (!value.candidate) throw failure('MATERIAL_UNAVAILABLE')
      return { name: value.candidate.name, steamId: value.candidate.steamId, revocationCode: value.candidate.revocationCode }
    })
  }
  exportPendingBackup(id: string, destination: string): Promise<{ exported: boolean }> {
    let exported = false
    return this.run(async () => {
      const value = this.require(id)
      if (value.rescue) {
        const saved = await this.options.vault.exportIsolatedRescueTo(value.rescue, destination)
        await this.persist({ ...value, exportProof: saved }); exported = true; return
      }
      if (!value.candidate || value.phase === 'complete') throw failure('MATERIAL_UNAVAILABLE')
      const saved = await this.options.vault.exportPendingMaterialTo(value.candidate, destination)
      await this.verifyBackup(saved)
      await this.persist({ ...value, exportProof: saved, ...(value.error === 'AUTHENTICATOR_ENROLLMENT_PERSISTENCE_FAILED' ? { error: undefined } : {}) })
      exported = true
    }).then(() => ({ exported }))
  }
  private async verifyBackup(proof: { path: string; sha256: string }): Promise<void> {
    if (!isAbsolute(proof.path) || !/^[a-f0-9]{64}$/.test(proof.sha256)) throw failure('BACKUP_UNAVAILABLE')
    const before = await lstat(proof.path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 65536 || (await realpath(proof.path)).toLowerCase() !== proof.path.toLowerCase()) throw failure('BACKUP_UNAVAILABLE')
    const handle = await open(proof.path, 'r')
    try {
      const bytes = Buffer.alloc(before.size + 1), read = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat(), current = await lstat(proof.path)
      try {
        if (read.bytesRead !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.size !== before.size
          || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs
          || (await realpath(proof.path)).toLowerCase() !== proof.path.toLowerCase()
          || createHash('sha256').update(bytes.subarray(0, read.bytesRead)).digest('hex') !== proof.sha256) throw failure('BACKUP_UNAVAILABLE')
        const candidate = this.value?.candidate, parsed = parseSdaMaFile(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)), { retainSdaBackup: true })
        if (!candidate || parsed.steamId !== candidate.steamId || parsed.sharedSecret !== candidate.sharedSecret || parsed.backup?.identitySecret !== candidate.identitySecret
          || parsed.backup.deviceId !== candidate.deviceId || parsed.backup.revocationCode !== candidate.revocationCode || parsed.backup.fullyEnrolled !== false) throw failure('BACKUP_UNAVAILABLE')
      } finally { bytes.fill(0) }
    } finally { await handle.close() }
  }
  acknowledgeRecoverySaved(input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (!value.candidate || !value.exportProof || !this.durableCandidate) throw failure('BACKUP_REQUIRED')
      if (value.phase === 'complete' || !['backup-required', 'ready-to-finalize', 'finalize-wait'].includes(value.phase)) throw failure('INVALID')
      if (value.recoveryAcknowledged) return
      await this.verifyBackup(value.exportProof)
      if (!await this.options.confirmRecoverySaved({ name: value.accountName, steamId: value.steamId! }, this.signal(generation))) return
      this.signal(generation)
      await this.persist({ ...value, recoveryAcknowledged: true, phase: value.candidate.confirmType === 'unknown' ? 'backup-required' : 'ready-to-finalize',
        error: value.candidate.confirmType === 'unknown' ? 'AUTHENTICATOR_ENROLLMENT_CONFIRM_TYPE_UNSUPPORTED' : undefined })
    })
  }
  private async verifyAndCommit(generation: number): Promise<void> {
    const value = this.value!, candidate = value.candidate
    if (!candidate) throw failure('MATERIAL_UNAVAILABLE')
    const status = await this.options.backend.queryStatus(this.session(value), candidate, this.signal(generation))
    this.signal(generation)
    if (status.steamId !== value.steamId) throw failure('IDENTITY')
    if (!status.active || !status.matchesCandidate) throw failure('STATUS_UNCONFIRMED')
    const saved = await this.options.vault.saveEnrolled({ ...candidate, fullyEnrolled: true })
    await this.persist({ ...this.value!, phase: 'complete', entryId: saved.id, verificationRequired: false, session: undefined, guardResume: undefined, phoneResume: undefined, retryAt: undefined, error: undefined })
  }
  finalize(input: { id: string; activationCode: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (!value.candidate || !this.durableCandidate || !value.recoveryAcknowledged || !value.exportProof) throw failure('BACKUP_REQUIRED')
      if (value.verificationRequired) throw failure('FINALIZE_UNCERTAIN')
      if (value.candidate.confirmType === 'unknown') throw failure('CONFIRM_TYPE_UNSUPPORTED')
      if (!['ready-to-finalize', 'finalize-wait'].includes(value.phase) || value.retryAt && this.now() < value.retryAt || !/^[A-Za-z0-9]{4,32}$/.test(input.activationCode)) throw failure('INVALID')
      const session = this.session(value)
      await this.verifyBackup(value.exportProof)
      const seconds = await this.options.backend.steamTime(this.signal(generation))
      this.signal(generation)
      const authCode = generateSteamGuardCode(value.candidate.sharedSecret, seconds)
      await this.persist({ ...value, phase: 'finalizing', verificationRequired: true, retryAt: undefined, error: undefined })
      let dispatched = false, result: Awaited<ReturnType<SteamAuthenticatorEnrollmentBackend['finalize']>>
      try {
        result = await this.options.backend.finalize(session, value.candidate, { activationCode: input.activationCode, authCode, authenticatorTime: seconds }, this.signal(generation),
          { onDispatch: () => { this.dispatched(generation); dispatched = true } })
      } catch (error) {
        // The provider must call the synchronous hook immediately before its only Finalize fetch.
        if (!dispatched) await this.persist({ ...this.value!, phase: 'ready-to-finalize', verificationRequired: false })
        throw error
      }
      if (!result || typeof result.success !== 'boolean' || typeof result.wantMore !== 'boolean') throw failure('STATE_INVALID')
      if (result.wantMore) {
        const delay = result.retryAfterMs ?? 30000
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > 300000) throw failure('STATE_INVALID')
        await this.persist({ ...this.value!, phase: 'finalize-wait', verificationRequired: false, retryAt: this.now() + Math.max(1000, delay), error: undefined }); this.signal(generation); return
      }
      if (!result.success) { await this.persist({ ...this.value!, phase: 'ready-to-finalize', verificationRequired: false, error: 'AUTHENTICATOR_ENROLLMENT_ACTIVATION_REJECTED' }); this.signal(generation); return }
      await this.persist({ ...this.value!, phase: 'verifying', error: undefined })
      this.signal(generation)
      await this.verifyAndCommit(generation)
    })
  }
  resume(input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    return this.run(async generation => {
      const value = this.require(input.id)
      if (value.phase === 'complete') return
      if (value.phase === 'add-uncertain' || value.attemptId && !value.candidate) throw failure('ADD_UNCERTAIN')
      if (!value.session) { await this.persist({ ...value, phase: 'login-required' }); return }
      if (value.candidate && (value.verificationRequired || ['verifying', 'finalizing'].includes(value.phase === 'paused' ? value.resumePhase ?? '' : value.phase))) { await this.verifyAndCommit(generation); return }
      if (value.candidate) { await this.persist({ ...value, phase: value.recoveryAcknowledged ? 'ready-to-finalize' : 'backup-required', error: undefined }); return }
      await this.phoneResult(await this.options.backend.phone(value.session, { op: 'status', resume: value.phoneResume }, this.signal(generation)), generation)
    })
  }
  private waitForOperation(operation: Promise<unknown> | null, milliseconds: number): Promise<boolean> {
    if (!operation) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), milliseconds)
      void operation.then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(true) })
    })
  }
  async pause(input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> {
    await this.initialized
    this.require(input.id)
    if (this.pausing) return this.pausing
    this.stopRequested = true
    if (!this.mutationDispatched) { this.generation++; this.controller.abort() }
    const operation = (async () => {
      // Do not abort a dispatched response before issued secrets can be encrypted and reread.
      const requested = this.options.shutdownTimeoutMs ?? 70000
      const timeout = Number.isFinite(requested) ? Math.max(1, Math.min(70000, Math.floor(requested))) : 70000
      let settled = await this.waitForOperation(this.operation, timeout)
      this.generation++; this.controller.abort()
      if (!settled) settled = await this.waitForOperation(this.operation, 1000)
      const value = this.require(input.id)
      if (!settled) {
        this.value = { ...value, ...(value.phase === 'adding' ? { phase: 'add-uncertain' as const, error: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN' } : {}),
          ...(value.phase === 'finalizing' ? { phase: 'verifying' as const, verificationRequired: true, error: 'AUTHENTICATOR_ENROLLMENT_FINALIZE_UNCERTAIN' } : {}) }
        this.changed(); return this.snapshot()
      }
      if (value.phase === 'complete' || value.phase === 'add-uncertain') return this.snapshot()
      await this.persist({ ...value, resumePhase: value.phase, phase: 'paused' })
      return this.snapshot()
    })()
    this.pausing = operation
    try { return await operation } finally { this.stopRequested = false; if (this.pausing === operation) this.pausing = null }
  }
  isBusy(): boolean { return this.operation !== null }
  hasUnpersistedIssuedMaterial(): boolean { return Boolean((this.value?.candidate || this.value?.rescue) && !this.durableCandidate) }
  async shutdown(): Promise<void> {
    try { await this.initialized } catch { this.controller.abort(); return }
    if (this.value) await this.pause({ id: this.value.id })
    else this.controller.abort()
  }
}
