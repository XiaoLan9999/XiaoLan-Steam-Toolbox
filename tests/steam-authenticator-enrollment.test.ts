import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import { SteamAuthenticatorService, generateSteamGuardCode } from '../src/main/steam-authenticator'
import { SteamAuthenticatorEnrollmentService } from '../src/main/steam-authenticator-enrollment'
import { SteamAuthenticatorMobileAdapter } from '../src/main/steam-authenticator-mobile'
import type { SteamAuthenticatorEnrollmentBackend, SteamAuthenticatorEnrollmentCandidate, SteamAuthenticatorEnrollmentOptions } from '../src/main/steam-authenticator-enrollment'
import type { SecretCipher } from '../src/main/store'

const steamId = '76561198000000001', otherId = '76561198000000002'
const sharedSecret = Buffer.alloc(20, 3).toString('base64'), identitySecret = Buffer.alloc(20, 7).toString('base64')
const roots: string[] = []
afterEach(async () => {
  const parent = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    const path = await realpath(root)
    if (dirname(path) !== parent || path !== resolve(root) || !basename(path).startsWith('auth-enrollment-test-')) throw new Error('Unsafe enrollment fixture cleanup')
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'auth-enrollment-test-'))); roots.push(root)
  const key = randomBytes(32), now = { value: 0 }, pendingPath = join(root, 'pending.json')
  const encrypt = vi.fn((plain: string) => {
    const iv = randomBytes(12), aes = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([aes.update(plain, 'utf8'), aes.final()])
    return Buffer.concat([iv, aes.getAuthTag(), body])
  })
  const cipher: SecretCipher = { isAvailable: () => true, backend: () => 'synthetic-aes', encrypt,
    decrypt: bytes => { const aes = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); aes.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([aes.update(bytes.subarray(28)), aes.final()]).toString('utf8') } }
  const vault = new SteamAuthenticatorService({ vaultPath: join(root, 'vault.json'), cipher, now: () => now.value })
  const server = { active: false, hasToken: false }
  const session = { schema: 1, platform: 'mobile', steamId, accountName: 'fixture', accessToken: 'SYNTHETIC_ACCESS_TOKEN', refreshToken: 'SYNTHETIC_REFRESH_TOKEN' }
  const backend = {
    login: vi.fn<SteamAuthenticatorEnrollmentBackend['login']>(async () => ({ kind: 'authenticated', name: 'fixture', steamId, session })),
    phone: vi.fn<SteamAuthenticatorEnrollmentBackend['phone']>(async () => ({ status: 'ready' })),
    addAuthenticator: vi.fn<SteamAuthenticatorEnrollmentBackend['addAuthenticator']>(async (_session, input, _signal, lifecycle) => {
      lifecycle?.onDispatch()
      return { name: 'fixture', steamId, sharedSecret, identitySecret, deviceId: input.deviceId,
        revocationCode: 'R12345', fullyEnrolled: false, confirmType: 'sms', serialNumber: '123456', tokenGid: '987654', secret1: Buffer.alloc(20, 9).toString('base64') }
    }),
    finalize: vi.fn<SteamAuthenticatorEnrollmentBackend['finalize']>(async (_session, _candidate, _input, _signal, lifecycle) => { lifecycle?.onDispatch(); server.active = true; return { success: true, wantMore: false } }),
    queryStatus: vi.fn<SteamAuthenticatorEnrollmentBackend['queryStatus']>(async (_session, candidate) => ({ steamId, active: server.active, hasToken: server.hasToken, matchesCandidate: Boolean(candidate && server.active) })),
    steamTime: vi.fn<SteamAuthenticatorEnrollmentBackend['steamTime']>(async () => 1700000000 + Math.floor(now.value / 1000))
  } satisfies SteamAuthenticatorEnrollmentBackend
  const confirmAdd = vi.fn(async () => true), confirmRecoverySaved = vi.fn(async () => true)
  const snapshots: unknown[] = []
  const options: SteamAuthenticatorEnrollmentOptions = { pendingPath, cipher, vault, backend, confirmAdd, confirmRecoverySaved, now: () => now.value, onChange: state => snapshots.push(state) }
  const manager = new SteamAuthenticatorEnrollmentService(options)
  const raw = async () => { const outer = JSON.parse(await readFile(pendingPath, 'utf8')); return JSON.parse(cipher.decrypt(Buffer.from(outer.ciphertext, 'base64'))) }
  const writeRaw = async (value: unknown) => writeFile(pendingPath, JSON.stringify({ schema: 1, ciphertext: cipher.encrypt(JSON.stringify(value)).toString('base64') }))
  const login = () => manager.login({ accountName: 'fixture', password: 'NEVER_PERSIST_PASSWORD', expectedSteamId: steamId })
  const add = async () => { const state = await login(); return manager.add({ id: state.id! }) }
  const backup = async () => {
    const state = await add(), output = join(root, 'pending.maFile')
    await manager.exportPendingBackup(state.id!, output)
    return manager.acknowledgeRecoverySaved({ id: state.id! })
  }
  return { root, manager, options, backend, vault, cipher, encrypt, server, now, pendingPath, confirmAdd, confirmRecoverySaved, snapshots, raw, writeRaw, login, add, backup }
}

describe('crash-resumable mobile enrollment with fake backend and disposable encrypted files only', () => {
  it('does not log in, query Steam or request enrollment when merely reading state', async () => {
    const f = await fixture()
    for (let index = 0; index < 3; index++) expect((await f.manager.state()).phase).toBe('idle')
    for (const method of Object.values(f.backend)) expect(method).not.toHaveBeenCalled()
  })

  it('completes only after mobile identity, explicit Add, durable secret backup, native recovery confirmation, Finalize and matched QueryStatus', async () => {
    const f = await fixture()
    f.backend.addAuthenticator.mockImplementationOnce(async (_session, input) => {
      const persisted = await f.raw()
      expect(persisted.phase).toBe('adding'); expect(persisted.attemptId).toBe(input.attemptId); expect(persisted.candidate).toBeUndefined()
      return { name: 'fixture', steamId, sharedSecret, identitySecret, deviceId: input.deviceId, revocationCode: 'R12345', fullyEnrolled: false, confirmType: 'sms', tokenGid: '987654', serialNumber: '123456', secret1: Buffer.alloc(20, 9).toString('base64') }
    })
    const ready = await f.backup()
    expect(ready).toMatchObject({ phase: 'ready-to-finalize', backupExported: true, backupAcknowledged: true, busy: false })
    const done = await f.manager.finalize({ id: ready.id!, activationCode: '123456' })
    expect(done).toMatchObject({ phase: 'complete', busy: false })
    expect(f.confirmAdd).toHaveBeenCalledOnce(); expect(f.confirmRecoverySaved).toHaveBeenCalledOnce()
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce(); expect(f.backend.finalize).toHaveBeenCalledOnce()
    const finalInput = f.backend.finalize.mock.calls[0]![2]
    expect(finalInput).toEqual({ activationCode: '123456', authenticatorTime: 1700000000, authCode: generateSteamGuardCode(sharedSecret, 1700000000) })
    expect((await f.vault.state()).entries[0]!.capabilities).toMatchObject({ hasConfirmations: true, hasRecoveryCode: true, fullBackup: true })
    expect((await f.raw()).session).toBeUndefined()
    const publicText = JSON.stringify(f.snapshots)
    for (const value of [sharedSecret, identitySecret, 'R12345', 'NEVER_PERSIST_PASSWORD', '123456', 'SYNTHETIC_ACCESS_TOKEN', 'SYNTHETIC_REFRESH_TOKEN']) expect(publicText).not.toContain(value)
    const disk = await readFile(f.pendingPath, 'utf8')
    for (const value of [sharedSecret, identitySecret, 'R12345', 'NEVER_PERSIST_PASSWORD', 'SYNTHETIC_ACCESS_TOKEN']) expect(disk).not.toContain(value)
    const encryptedInputs = f.encrypt.mock.calls.map(call => call[0]).join(' ')
    expect(encryptedInputs).not.toContain('NEVER_PERSIST_PASSWORD')
    expect(encryptedInputs).not.toContain('"activationCode"')
    await f.manager.resume({ id: done.id! })
    await expect(f.manager.acknowledgeRecoverySaved({ id: done.id! })).rejects.toBeInstanceOf(DomainError)
    expect(f.backend.finalize).toHaveBeenCalledOnce()
  })

  it('supports guard refresh without storing the password or starting enrollment prematurely', async () => {
    const f = await fixture()
    f.backend.login.mockResolvedValueOnce({ kind: 'guard', guardType: 'confirmation', resume: { loginId: 'local-handle', accountName: 'fixture' } })
    const waiting = await f.login()
    expect(waiting.phase).toBe('guard-required'); expect(f.backend.phone).not.toHaveBeenCalled()
    await f.manager.refreshLogin({ id: waiting.id! })
    expect(f.backend.login.mock.calls[1]![0]).toEqual({ accountName: 'fixture', resume: { loginId: 'local-handle', accountName: 'fixture' } })
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    expect(f.encrypt.mock.calls.map(call => call[0]).join('')).not.toContain('NEVER_PERSIST_PASSWORD')
  })

  it('requires explicit phone actions and honors server waiting periods without status calls sending SMS', async () => {
    const f = await fixture()
    f.backend.phone.mockResolvedValueOnce({ status: 'phone-needed' }).mockResolvedValueOnce({ status: 'email-required', resume: { phone: 'server-reference' }, retryAfterMs: 30000 })
    const state = await f.login()
    const email = await f.manager.phone({ id: state.id!, op: 'begin', phoneNumber: '13800138000', countryCode: '86' })
    expect(email).toMatchObject({ phase: 'email-required', retryAt: 30000 })
    await expect(f.manager.phone({ id: state.id!, op: 'send-sms' })).rejects.toThrow('COOLDOWN')
    expect(f.backend.phone.mock.calls.map(call => call[1].op)).toEqual(['status', 'begin'])
    f.backend.phone.mockResolvedValueOnce({ status: 'sms-required' })
    await f.manager.phone({ id: state.id!, op: 'status' })
    f.backend.phone.mockResolvedValueOnce({ status: 'sms-required' })
    await f.manager.phone({ id: state.id!, op: 'send-sms' })
    await f.manager.phone({ id: state.id!, op: 'submit-sms', code: '123456' })
    expect(f.backend.phone.mock.calls.map(call => call[1].op)).toEqual(['status', 'begin', 'status', 'send-sms', 'submit-sms'])
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    expect(f.encrypt.mock.calls.map(call => call[0]).join('')).not.toContain('"code":"123456"')
  })

  it.each(['active', 'pending'] as const)('never Add/removes when server preflight finds an %s authenticator', async kind => {
    const f = await fixture()
    if (kind === 'active') f.server.active = true; else f.server.hasToken = true
    await expect(f.login()).rejects.toThrow('AUTHENTICATOR_PRESENT')
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled(); expect(f.confirmAdd).not.toHaveBeenCalled()
  })

  it('does not send Add when the native user declines', async () => {
    const f = await fixture(); f.confirmAdd.mockResolvedValueOnce(false)
    const result = await f.add()
    expect(result.phase).toBe('ready-to-add'); expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    expect((await f.raw()).attemptId).toBeUndefined()
  })

  it('cannot send Add unless the durable attempt marker is successfully saved first', async () => {
    const f = await fixture(), ready = await f.login()
    f.encrypt.mockImplementationOnce(() => { throw new Error('synthetic disk protection failure') })
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('PERSISTENCE_FAILED')
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
  })

  it('restores an adding crash as uncertain and never silently retries Add, even after login', async () => {
    const f = await fixture(), ready = await f.login()
    await f.writeRaw({ ...await f.raw(), phase: 'adding', attemptId: '11111111-1111-4111-8111-111111111111' })
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    expect(await restored.state()).toMatchObject({ id: ready.id, phase: 'add-uncertain' })
    await expect(restored.add({ id: ready.id! })).rejects.toThrow('ADD_FORBIDDEN')
    await expect(restored.resume({ id: ready.id! })).rejects.toThrow('ADD_UNCERTAIN')
    await restored.login({ accountName: 'fixture', password: 'NEVER_PERSIST_PASSWORD' })
    expect((await restored.state()).phase).toBe('add-uncertain')
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
  })

  it('persists an unknown Add result before reporting it, without losing the irreversible marker', async () => {
    const f = await fixture(), ready = await f.login()
    f.backend.addAuthenticator.mockRejectedValueOnce(new DomainError('AUTH_ENROLL_MOBILE_ADD_UNCERTAIN', 'AUTH_ENROLL_MOBILE_ADD_UNCERTAIN'))
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('ADD_UNCERTAIN')
    expect((await f.raw()).phase).toBe('add-uncertain')
    expect((await new SteamAuthenticatorEnrollmentService(f.options).state()).phase).toBe('add-uncertain')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('keeps the pending identity and device when a proven unsent Add requires a fresh Mobile login', async () => {
    const f = await fixture(), ready = await f.login(), before = await f.raw()
    f.backend.addAuthenticator.mockResolvedValueOnce({ kind: 'not-submitted', reason: 'login-required', proof: 'request-not-sent' })
    const stopped = await f.manager.add({ id: ready.id! })
    expect(stopped).toMatchObject({ id: ready.id, phase: 'login-required', error: 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED' })
    expect(await f.raw()).toMatchObject({ id: before.id, deviceId: before.deviceId })
    expect((await f.raw()).attemptId).toBeUndefined(); expect((await f.raw()).session).toBeUndefined()
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    const loggedIn = await restored.login({ accountName: 'fixture', password: 'NEVER_PERSIST_PASSWORD', expectedSteamId: steamId })
    expect(loggedIn).toMatchObject({ id: ready.id, phase: 'ready-to-add' })
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
    await restored.add({ id: ready.id! })
    expect(f.backend.addAuthenticator.mock.calls.map(call => call[1].deviceId)).toEqual([before.deviceId, before.deviceId])
    expect(f.backend.addAuthenticator.mock.calls[0]![1].attemptId).not.toBe(f.backend.addAuthenticator.mock.calls[1]![1].attemptId)
    expect(f.confirmAdd).toHaveBeenCalledTimes(2)
  })

  it('releases only a definitive empty phone rejection for another explicit Add, without automatically sending SMS or repeating Add', async () => {
    const f = await fixture(), ready = await f.login(), before = await f.raw()
    f.backend.addAuthenticator.mockResolvedValueOnce({ kind: 'not-submitted', reason: 'phone-needed', proof: 'authoritative-phone-rejection' })
    expect(await f.manager.add({ id: ready.id! })).toMatchObject({ phase: 'phone-needed', error: 'AUTH_ENROLL_MOBILE_PHONE_REQUIRED' })
    expect((await f.raw()).attemptId).toBeUndefined(); expect((await f.raw()).deviceId).toBe(before.deviceId)
    await f.manager.state()
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
    expect(f.backend.phone.mock.calls.map(call => call[1].op)).toEqual(['status'])
    expect((await f.manager.add({ id: ready.id! })).phase).toBe('backup-required')
    expect(f.backend.addAuthenticator).toHaveBeenCalledTimes(2); expect(f.confirmAdd).toHaveBeenCalledTimes(2)
    expect(f.backend.addAuthenticator.mock.calls[1]![1].deviceId).toBe(before.deviceId)
  })

  it.each(['invalid-input', 'unavailable'] as const)('retains the previous Add stage after a proven unsent %s failure', async reason => {
    const f = await fixture(), ready = await f.login(), before = await f.raw()
    f.backend.addAuthenticator.mockResolvedValueOnce({ kind: 'not-submitted', reason, proof: 'request-not-sent' })
    expect((await f.manager.add({ id: ready.id! })).phase).toBe('ready-to-add')
    expect((await f.raw()).attemptId).toBeUndefined(); expect((await f.raw()).deviceId).toBe(before.deviceId)
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('does not release an Add marker for malformed rejection proof or a rejection carrying issued material', async () => {
    const f = await fixture(), ready = await f.login()
    f.backend.addAuthenticator.mockResolvedValueOnce({ kind: 'not-submitted', reason: 'phone-needed', proof: 'authoritative-phone-rejection', sharedSecret } as never)
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('STATE_INVALID')
    expect((await f.raw()).attemptId).toBeTruthy(); expect((await f.manager.state()).phase).toBe('add-uncertain')
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('ADD_FORBIDDEN')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('allows one explicit Steam-approved email enrollment attempt without forcing any phone mutation', async () => {
    const f = await fixture(), original = f.backend.addAuthenticator.getMockImplementation()!
    f.backend.phone.mockResolvedValueOnce({ status: 'phone-needed' })
    f.backend.addAuthenticator.mockImplementationOnce(async (...args) => ({ ...await original(...args), confirmType: 'email' } as SteamAuthenticatorEnrollmentCandidate))
    const loggedIn = await f.login()
    expect(loggedIn.phase).toBe('phone-needed'); expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    const added = await f.manager.add({ id: loggedIn.id! })
    expect(added).toMatchObject({ phase: 'backup-required', confirmationKind: 'email' })
    await f.manager.exportPendingBackup(added.id!, join(f.root, 'email-pending.maFile'))
    await f.manager.acknowledgeRecoverySaved({ id: added.id! })
    expect((await f.manager.finalize({ id: added.id!, activationCode: 'EMAIL123' })).phase).toBe('complete')
    expect(f.backend.phone.mock.calls.map(call => call[1].op)).toEqual(['status'])
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce(); expect(f.backend.finalize).toHaveBeenCalledOnce()
  })

  it('restores received secrets after restart but refuses Finalize until a real backup and native recovery acknowledgment exist', async () => {
    const f = await fixture(), added = await f.add(), restored = new SteamAuthenticatorEnrollmentService(f.options)
    expect((await restored.state()).phase).toBe('backup-required')
    expect(await restored.recoveryMaterial(added.id!)).toEqual({ name: 'fixture', steamId, revocationCode: 'R12345' })
    await expect(restored.finalize({ id: added.id!, activationCode: '123456' })).rejects.toThrow('BACKUP_REQUIRED')
    await expect(restored.acknowledgeRecoverySaved({ id: added.id! })).rejects.toThrow('BACKUP_REQUIRED')
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it('validates that the exported pending file still exists and has not changed before acknowledging or finalizing', async () => {
    const f = await fixture(), added = await f.add(), output = join(f.root, 'pending.maFile')
    await f.manager.exportPendingBackup(added.id!, output)
    expect(JSON.parse(await readFile(output, 'utf8')).fully_enrolled).toBe(false)
    await writeFile(output, 'CHANGED_FILE')
    await expect(f.manager.acknowledgeRecoverySaved({ id: added.id! })).rejects.toThrow('BACKUP_UNAVAILABLE')
    expect(f.confirmRecoverySaved).not.toHaveBeenCalled()
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it('does not count native recovery acknowledgment as accepted when the user declines', async () => {
    const f = await fixture(), added = await f.add()
    await f.manager.exportPendingBackup(added.id!, join(f.root, 'pending.maFile'))
    f.confirmRecoverySaved.mockResolvedValueOnce(false)
    expect((await f.manager.acknowledgeRecoverySaved({ id: added.id! })).backupAcknowledged).toBe(false)
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it('keeps unknown confirmation types backed up but never guesses an activation route', async () => {
    const f = await fixture(), original = f.backend.addAuthenticator.getMockImplementation()!
    f.backend.addAuthenticator.mockImplementationOnce(async (...args) => ({ ...await original(...args), confirmType: 'unknown' }))
    const ready = await f.backup()
    expect(ready).toMatchObject({ phase: 'backup-required', confirmationKind: 'unknown', backupAcknowledged: true })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('CONFIRM_TYPE_UNSUPPORTED')
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it('persists wantMore and retryAt, never stores activation input and waits for another explicit finalize', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockResolvedValueOnce({ success: false, wantMore: true, retryAfterMs: 30000 })
    const waiting = await f.manager.finalize({ id: ready.id!, activationCode: '123456' })
    expect(waiting).toMatchObject({ phase: 'finalize-wait', retryAt: 30000 })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('INVALID')
    expect(f.backend.finalize).toHaveBeenCalledOnce()
    f.now.value = 30000
    expect((await f.manager.finalize({ id: ready.id!, activationCode: '654321' })).phase).toBe('complete')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
    expect(f.encrypt.mock.calls.map(call => call[0]).join('')).not.toContain('"activationCode"')
  })

  it('resolves an unknown Finalize through read-only QueryStatus, never by repeating Finalize', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockImplementationOnce(async (_session, _candidate, _input, _signal, lifecycle) => { lifecycle!.onDispatch(); f.server.active = true; throw new DomainError('AUTH_ENROLL_MOBILE_NETWORK_FAILED', 'AUTH_ENROLL_MOBILE_NETWORK_FAILED') })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('NETWORK_FAILED')
    expect((await f.raw()).phase).toBe('verifying')
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    expect((await restored.resume({ id: ready.id! })).phase).toBe('complete')
    expect(f.backend.finalize).toHaveBeenCalledOnce(); expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('does not mark success from Finalize alone when the final token status cannot match this candidate', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.queryStatus.mockResolvedValueOnce({ steamId, active: true, matchesCandidate: false })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('STATUS_UNCONFIRMED')
    expect((await f.vault.state()).entries).toEqual([])
    expect((await f.manager.state()).phase).toBe('verifying')
  })

  it('rejects a WebBrowser or different-account session without any phone or binding mutation', async () => {
    const f = await fixture()
    f.backend.login.mockResolvedValueOnce({ kind: 'authenticated', name: 'fixture', steamId, session: { platform: 'web', steamId } })
    await expect(f.login()).rejects.toThrow('IDENTITY')
    f.backend.login.mockResolvedValueOnce({ kind: 'authenticated', name: 'fixture', steamId: otherId, session: { platform: 'mobile', steamId: otherId } })
    await expect(f.login()).rejects.toThrow('IDENTITY')
    expect(f.backend.phone).not.toHaveBeenCalled(); expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
  })

  it('requires login again when a restored guard handle no longer belongs to this process', async () => {
    const f = await fixture()
    f.backend.login.mockResolvedValueOnce({ kind: 'guard', guardType: 'device', resume: { loginId: 'process-local' } })
    const waiting = await f.login(), restored = new SteamAuthenticatorEnrollmentService(f.options)
    f.backend.login.mockRejectedValueOnce(new DomainError('AUTH_ENROLL_MOBILE_AUTH_REQUIRED', 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED'))
    await expect(restored.refreshLogin({ id: waiting.id! })).rejects.toThrow('AUTH_REQUIRED')
    expect((await restored.state()).phase).toBe('login-required')
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
  })

  it('refuses any password or input verification code accidentally placed in persisted opaque session data', async () => {
    const f = await fixture()
    f.backend.login.mockResolvedValueOnce({ kind: 'guard', guardType: 'email', resume: { loginId: 'handle', password: 'MUST_NOT_PERSIST' } })
    await expect(f.login()).rejects.toThrow('STATE_INVALID')
    expect(f.encrypt.mock.calls.map(call => call[0]).join('')).not.toContain('MUST_NOT_PERSIST')
  })

  it('restores an interrupted Finalize marker by querying status instead of resubmitting activation input', async () => {
    const f = await fixture(), ready = await f.backup()
    await f.writeRaw({ ...await f.raw(), phase: 'finalizing' })
    f.server.active = true
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    expect((await restored.state()).phase).toBe('verifying')
    expect((await restored.resume({ id: ready.id! })).phase).toBe('complete')
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it('can recover an Add response kept in memory after a persistence error without making another Add call', async () => {
    const f = await fixture(), ready = await f.login(), encrypt = f.encrypt.getMockImplementation()!
    f.encrypt.mockImplementation(plain => {
      if (JSON.parse(plain).phase === 'backup-required') throw new Error('Synthetic disk full after Add')
      return encrypt(plain)
    })
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('PERSISTENCE_FAILED')
    expect(await f.manager.recoveryMaterial(ready.id!)).toMatchObject({ revocationCode: 'R12345' })
    expect((await f.raw()).phase).toBe('adding')
    expect((await new SteamAuthenticatorEnrollmentService(f.options).state()).phase).toBe('add-uncertain')
    f.encrypt.mockImplementation(encrypt)
    // Use the original live manager for emergency backup. A restored manager must not invent the lost response.
    // The second instance above changed the file, so the old instance must refuse an unsafe overwrite.
    await expect(f.manager.exportPendingBackup(ready.id!, join(f.root, 'emergency.maFile'))).rejects.toThrow('PERSISTENCE_FAILED')
    expect(JSON.parse(await readFile(join(f.root, 'emergency.maFile'), 'utf8')).revocation_code).toBe('R12345')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it.each(['candidate', 'rescue'] as const)('reports unpersisted issued %s material to the main-process quit guard until encrypted storage succeeds', async kind => {
    const f = await fixture(), ready = await f.login(), encrypt = f.encrypt.getMockImplementation()!
    expect(f.manager.hasUnpersistedIssuedMaterial()).toBe(false)
    if (kind === 'rescue') f.backend.addAuthenticator.mockImplementationOnce(async (_session, input, _signal, lifecycle) => {
      lifecycle!.onDispatch()
      return { kind: 'rescue', name: 'fixture', expectedSteamId: steamId, deviceId: input.deviceId, sharedSecret, revocationCode: 'R12345', reason: 'required-material-invalid' }
    })
    f.encrypt.mockImplementation(plain => {
      if (JSON.parse(plain)[kind]) throw new Error('Synthetic encrypted pending storage unavailable')
      return encrypt(plain)
    })
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('PERSISTENCE_FAILED')
    expect(f.manager.hasUnpersistedIssuedMaterial()).toBe(true)
    expect((await f.raw()).phase).toBe('adding')
    expect(JSON.stringify(await f.manager.state())).not.toContain('hasUnpersistedIssuedMaterial')
    const destination = join(f.root, kind === 'rescue' ? 'unpersisted-rescue.json' : 'unpersisted-pending.maFile')
    await expect(f.manager.exportPendingBackup(ready.id!, destination)).rejects.toThrow('PERSISTENCE_FAILED')
    expect(f.manager.hasUnpersistedIssuedMaterial()).toBe(true)
    expect(await readFile(destination, 'utf8')).toContain('R12345')
    f.encrypt.mockImplementation(encrypt)
    expect(await f.manager.exportPendingBackup(ready.id!, join(f.root, kind === 'rescue' ? 'durable-rescue.json' : 'durable-pending.maFile'))).toEqual({ exported: true })
    expect(f.manager.hasUnpersistedIssuedMaterial()).toBe(false)
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('does not cross native Add consent after pause has cancelled its generation', async () => {
    const f = await fixture(), ready = await f.login()
    let confirm!: (value: boolean) => void
    f.confirmAdd.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    const adding = f.manager.add({ id: ready.id! })
    const rejected = expect(adding).rejects.toThrow('CANCELLED')
    await vi.waitFor(() => expect(f.confirmAdd).toHaveBeenCalledOnce())
    const pausing = f.manager.pause({ id: ready.id! })
    confirm(true)
    await rejected; await pausing
    expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    expect((await f.manager.state()).phase).toBe('paused')
  })

  it('saves a late successful Add response before pausing so its secrets are not dropped', async () => {
    const f = await fixture(), ready = await f.login(), original = f.backend.addAuthenticator.getMockImplementation()!
    let respond!: () => void
    f.backend.addAuthenticator.mockImplementationOnce((...args) => { const issued = original(...args); return new Promise(resolve => { respond = () => { void issued.then(resolve) } }) })
    const adding = f.manager.add({ id: ready.id! }), rejected = expect(adding).rejects.toThrow('CANCELLED')
    await vi.waitFor(() => expect(f.backend.addAuthenticator).toHaveBeenCalledOnce())
    const pausing = f.manager.pause({ id: ready.id! })
    respond(); await rejected; await pausing
    expect((await f.raw()).candidate.revocationCode).toBe('R12345')
    expect((await f.manager.state()).phase).toBe('paused')
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body'] as const)('drains a dispatched Add through the actual Mobile adapter %s abort handling before graceful pause', async stage => {
    const f = await fixture(), epoch = 1700000000000
    const jwt = (derive = false) => `${Buffer.from('{"alg":"synthetic"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: steamId, aud: derive ? ['mobile', 'derive'] : ['mobile'], exp: epoch / 1000 + 3600 })).toString('base64url')}.synthetic`
    f.backend.login.mockResolvedValueOnce({ kind: 'authenticated', name: 'fixture', steamId,
      session: { schema: 1, platform: 'mobile', steamId, accountName: 'fixture', accessToken: jwt(), refreshToken: jwt(true) } })
    let release!: () => void, requestSignal: AbortSignal | undefined, cancelled = false
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/ITwoFactorService/AddAuthenticator/v1/')) throw new Error('Synthetic Add only; real network forbidden')
      requestSignal = init!.signal!
      const text = () => JSON.stringify({ response: { status: 1, account_name: 'fixture', shared_secret: sharedSecret, identity_secret: identitySecret,
        revocation_code: 'R12345', token_gid: '987654', confirm_type: 3 } })
      if (stage === 'headers') return new Promise((resolve, reject) => {
        const aborted = () => { cancelled = true; reject(new Error('synthetic fetch abort')) }
        requestSignal!.addEventListener('abort', aborted, { once: true })
        release = () => { requestSignal!.removeEventListener('abort', aborted); resolve(Response.json(JSON.parse(text()))) }
      })
      return new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(text())); controller.close() } },
        cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
    })
    const adapter = new SteamAuthenticatorMobileAdapter({ createNetwork: () => ({ fetch: fetchImpl as typeof fetch, dispose() {} }), now: () => epoch })
    try {
      f.backend.addAuthenticator.mockImplementationOnce((...args) => adapter.addAuthenticator(...args))
      const ready = await f.login(), adding = f.manager.add({ id: ready.id! }), rejected = expect(adding).rejects.toThrow('CANCELLED')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      const pausing = f.manager.pause({ id: ready.id! })
      expect(requestSignal!.aborted).toBe(false)
      release(); await rejected; await pausing
      expect((await f.raw()).candidate).toMatchObject({ sharedSecret, identitySecret, revocationCode: 'R12345', confirmType: 'email' })
      expect((await f.manager.state()).phase).toBe('paused')
      expect(cancelled).toBe(false); expect(fetchImpl).toHaveBeenCalledOnce(); expect(f.backend.finalize).not.toHaveBeenCalled()
    } finally { adapter.dispose() }
  })

  it('stores a dispatched Finalize result before pausing, and verifies success only on an explicit resume', async () => {
    const f = await fixture(), ready = await f.backup()
    let respond!: () => void, signal!: AbortSignal
    f.backend.finalize.mockImplementationOnce(async (_session, _candidate, _input, inherited, lifecycle) => {
      lifecycle!.onDispatch(); signal = inherited
      return new Promise((resolve, reject) => {
        inherited.addEventListener('abort', () => reject(new DomainError('AUTH_ENROLL_MOBILE_CANCELLED', 'AUTH_ENROLL_MOBILE_CANCELLED')), { once: true })
        respond = () => { f.server.active = true; resolve({ success: true, wantMore: false }) }
      })
    })
    const activating = f.manager.finalize({ id: ready.id!, activationCode: '123456' }), rejected = expect(activating).rejects.toThrow('CANCELLED')
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    const queries = f.backend.queryStatus.mock.calls.length, pausing = f.manager.pause({ id: ready.id! })
    expect(signal.aborted).toBe(false)
    respond(); await rejected; await pausing
    expect(await f.raw()).toMatchObject({ phase: 'paused', resumePhase: 'verifying', verificationRequired: true })
    expect(f.backend.queryStatus).toHaveBeenCalledTimes(queries)
    expect((await f.manager.resume({ id: ready.id! })).phase).toBe('complete')
    expect(f.backend.finalize).toHaveBeenCalledOnce(); expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('cancels an unsubmitted native consent prompt instead of waiting indefinitely for a user response', async () => {
    const f = await fixture(), ready = await f.login()
    let promptSignal!: AbortSignal
    f.confirmAdd.mockImplementationOnce((_account?: unknown, signal?: AbortSignal) => new Promise(resolve => {
      promptSignal = signal!; signal!.addEventListener('abort', () => resolve(false), { once: true })
    }))
    const adding = f.manager.add({ id: ready.id! })
    await vi.waitFor(() => expect(promptSignal).toBeInstanceOf(AbortSignal))
    await f.manager.pause({ id: ready.id! }); await adding
    expect(promptSignal.aborted).toBe(true); expect(f.backend.addAuthenticator).not.toHaveBeenCalled()
    expect((await f.raw()).attemptId).toBeUndefined(); expect((await f.manager.state()).phase).toBe('paused')
  })

  it('bounds graceful shutdown when an already dispatched provider does not finish before its allowed deadline', async () => {
    const f = await fixture(), ready = await f.login()
    f.options.shutdownTimeoutMs = 10
    let dispatched = false, requestSignal!: AbortSignal
    f.backend.addAuthenticator.mockImplementationOnce(async (_session, _input, signal, lifecycle) => {
      lifecycle!.onDispatch(); dispatched = true; requestSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DomainError('AUTH_ENROLL_MOBILE_CANCELLED', 'AUTH_ENROLL_MOBILE_CANCELLED')), { once: true }))
    })
    const adding = f.manager.add({ id: ready.id! }), rejected = expect(adding).rejects.toThrow('CANCELLED')
    await vi.waitFor(() => expect(dispatched).toBe(true))
    await f.manager.shutdown(); await rejected
    expect(requestSignal.aborted).toBe(true)
    expect(await f.raw()).toMatchObject({ phase: 'add-uncertain' })
    expect((await f.raw()).attemptId).toBeTruthy(); expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('allows another explicit activation attempt after a definitive code rejection but never repeats Add', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockImplementationOnce(async (_session, _candidate, _input, _signal, lifecycle) => { lifecycle!.onDispatch(); throw new DomainError('AUTH_ENROLL_MOBILE_CODE_INVALID', 'AUTH_ENROLL_MOBILE_CODE_INVALID') })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('CODE_INVALID')
    expect((await f.manager.state()).phase).toBe('ready-to-finalize')
    expect((await f.manager.finalize({ id: ready.id!, activationCode: '654321' })).phase).toBe('complete')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('preserves unknown Finalize history through expired mobile sessions and relogin, requiring QueryStatus instead of a second Finalize', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockImplementationOnce(async (_session, _candidate, _input, _signal, lifecycle) => { lifecycle!.onDispatch(); throw new DomainError('AUTH_ENROLL_MOBILE_NETWORK_FAILED', 'AUTH_ENROLL_MOBILE_NETWORK_FAILED') })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('NETWORK_FAILED')
    expect((await f.raw()).verificationRequired).toBe(true)
    f.backend.queryStatus.mockRejectedValueOnce(new DomainError('AUTH_ENROLL_MOBILE_AUTH_REQUIRED', 'AUTH_ENROLL_MOBILE_AUTH_REQUIRED'))
    await expect(f.manager.resume({ id: ready.id! })).rejects.toThrow('AUTH_REQUIRED')
    expect((await f.manager.state()).phase).toBe('login-required')
    expect((await f.raw()).verificationRequired).toBe(true)
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    await expect(restored.login({ accountName: 'fixture', password: 'NEVER_PERSIST_PASSWORD' })).rejects.toThrow('STATUS_UNCONFIRMED')
    expect((await restored.state()).phase).toBe('verifying')
    await expect(restored.finalize({ id: ready.id!, activationCode: '654321' })).rejects.toThrow('FINALIZE_UNCERTAIN')
    f.server.active = true
    expect((await restored.resume({ id: ready.id! })).phase).toBe('complete')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
    expect(f.backend.finalize).toHaveBeenCalledOnce()
  })

  it.each(['AUTH_REQUIRED', 'NETWORK_FAILED'] as const)('does not manufacture an unknown Finalize after a proven pre-dispatch %s failure', async reason => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockRejectedValueOnce(new DomainError(`AUTH_ENROLL_MOBILE_${reason}`, `AUTH_ENROLL_MOBILE_${reason}`))
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow(reason)
    expect(await f.raw()).toMatchObject({ verificationRequired: false, phase: reason === 'AUTH_REQUIRED' ? 'login-required' : 'ready-to-finalize' })
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    if (reason === 'AUTH_REQUIRED') {
      expect((await restored.login({ accountName: 'fixture', password: 'NEVER_PERSIST_PASSWORD' })).phase).toBe('ready-to-finalize')
    }
    expect(f.backend.finalize).toHaveBeenCalledOnce()
    expect((await restored.finalize({ id: ready.id!, activationCode: '654321' })).phase).toBe('complete')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce()
  })

  it('preserves critical materials when optional metadata is incomplete, without inventing a token id or activation route', async () => {
    const f = await fixture(), original = f.backend.addAuthenticator.getMockImplementation()!
    f.backend.addAuthenticator.mockImplementationOnce(async (...args) => {
      const candidate = await original(...args) as SteamAuthenticatorEnrollmentCandidate
      return { ...candidate, tokenGid: undefined, serialNumber: undefined, secret1: undefined, confirmType: 'unknown', metadataIncomplete: true }
    })
    const state = await f.add()
    expect(state).toMatchObject({ phase: 'backup-required', metadataIncomplete: true, confirmationKind: 'unknown' })
    expect((await f.raw()).candidate.sharedSecret).toBe(sharedSecret)
    expect((await f.raw()).candidate.tokenGid).toBeUndefined()
    await f.manager.exportPendingBackup(state.id!, join(f.root, 'incomplete.maFile'))
    expect(JSON.parse(await readFile(join(f.root, 'incomplete.maFile'), 'utf8')).shared_secret).toBe(sharedSecret)
    await f.manager.acknowledgeRecoverySaved({ id: state.id! })
    await expect(f.manager.finalize({ id: state.id!, activationCode: '123456' })).rejects.toThrow('CONFIRM_TYPE_UNSUPPORTED')
    expect(f.backend.finalize).not.toHaveBeenCalled()
  })

  it.each(['required-material-invalid', 'owner-mismatch', 'status-uncertain'] as const)('durably isolates a %s Add response and exports rescue JSON without treating it as a valid authenticator', async reason => {
    const f = await fixture()
    f.backend.addAuthenticator.mockImplementationOnce(async (_session, input) => ({ kind: 'rescue', expectedSteamId: steamId,
      ...(reason === 'owner-mismatch' ? { receivedSteamId: otherId } : {}), name: 'fixture', deviceId: input.deviceId, sharedSecret,
      revocationCode: 'R12345', reason }))
    const state = await f.add()
    expect(state).toMatchObject({ phase: 'add-uncertain', hasRescueMaterials: true })
    expect(JSON.stringify(state)).not.toContain(sharedSecret); expect(JSON.stringify(state)).not.toContain('R12345')
    expect((await f.raw()).rescue.sharedSecret).toBe(sharedSecret)
    expect((await f.raw()).candidate).toBeUndefined()
    expect(await readFile(f.pendingPath, 'utf8')).not.toContain(sharedSecret)
    const restored = new SteamAuthenticatorEnrollmentService(f.options)
    expect((await restored.state()).hasRescueMaterials).toBe(true)
    expect(await restored.recoveryMaterial(state.id!)).toMatchObject({ revocationCode: 'R12345', isolated: true })
    const destination = join(f.root, 'isolated-rescue.json')
    expect(await restored.exportPendingBackup(state.id!, destination)).toEqual({ exported: true })
    const exported = JSON.parse(await readFile(destination, 'utf8'))
    expect(exported).toMatchObject({ format: 'xiaolan-steam-enrollment-isolated-rescue-v1', notAnAuthenticator: true,
      expectedSteamId: steamId, reason, issued: { sharedSecret, revocationCode: 'R12345' } })
    expect(exported.shared_secret).toBeUndefined(); expect(exported.Session).toBeUndefined()
    expect((await restored.state()).phase).toBe('add-uncertain')
    await expect(restored.finalize({ id: state.id!, activationCode: '123456' })).rejects.toThrow('BACKUP_REQUIRED')
    await expect(restored.add({ id: state.id! })).rejects.toThrow('ADD_FORBIDDEN')
    await expect(restored.resume({ id: state.id! })).rejects.toThrow('ADD_UNCERTAIN')
    expect(f.backend.addAuthenticator).toHaveBeenCalledOnce(); expect(f.backend.finalize).not.toHaveBeenCalled()
    expect((await f.vault.state()).entries).toEqual([])
  })

  it('cannot include arbitrary response, session or token fields in isolated rescue storage or export', async () => {
    const f = await fixture(), ready = await f.login()
    f.backend.addAuthenticator.mockImplementationOnce(async (_session, input) => ({ kind: 'rescue', expectedSteamId: steamId, name: 'fixture', deviceId: input.deviceId,
      sharedSecret, reason: 'required-material-invalid', Session: { AccessToken: 'FORBIDDEN_TOKEN' } } as any))
    await expect(f.manager.add({ id: ready.id! })).rejects.toThrow('MATERIAL_INVALID')
    expect((await f.raw()).phase).toBe('add-uncertain')
    expect(JSON.stringify(await f.raw())).not.toContain('FORBIDDEN_TOKEN')
    expect((await f.raw()).rescue).toBeUndefined()
  })

  it('does not downgrade verification history or clear backup acknowledgment when exporting another backup after unknown Finalize', async () => {
    const f = await fixture(), ready = await f.backup()
    f.backend.finalize.mockImplementationOnce(async (_session, _candidate, _input, _signal, lifecycle) => { lifecycle!.onDispatch(); throw new DomainError('AUTH_ENROLL_MOBILE_NETWORK_FAILED', 'AUTH_ENROLL_MOBILE_NETWORK_FAILED') })
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('NETWORK_FAILED')
    await f.manager.exportPendingBackup(ready.id!, join(f.root, 'another-pending.maFile'))
    expect(await f.manager.state()).toMatchObject({ phase: 'verifying', backupAcknowledged: true })
    expect((await f.raw()).verificationRequired).toBe(true)
    await expect(f.manager.finalize({ id: ready.id!, activationCode: '123456' })).rejects.toThrow('FINALIZE_UNCERTAIN')
    expect(f.backend.finalize).toHaveBeenCalledOnce()
  })
})
