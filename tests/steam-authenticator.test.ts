import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSteamGuardCode, MAX_MAFILE_BYTES, parseSdaMaFile, queryAnonymousSteamTime, SteamAuthenticatorService } from '../src/main/steam-authenticator'
import type { SteamAuthenticatorOptions } from '../src/main/steam-authenticator'
import type { SecretCipher } from '../src/main/store'

const secret = Buffer.from(Array.from({ length: 20 }, (_, index) => index)).toString('base64')
const otherSecret = Buffer.alloc(20, 231).toString('base64')
const steamId = '76561198000000001'
const identitySecret = Buffer.alloc(20, 17).toString('base64')
const sdaBackup = { identity_secret: identitySecret, device_id: 'android:11111111-2222-4333-8444-555555555555',
  revocation_code: 'R12345', fully_enrolled: true, serial_number: '12345678901234567890', token_gid: '98765432109876543210',
  secret_1: Buffer.alloc(20, 31).toString('base64') }
const roots: string[] = []
afterEach(async () => {
  const parent = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    const target = await realpath(root)
    if (dirname(target) !== parent || target !== resolve(root) || !basename(target).startsWith('steam-authenticator-test-')) throw new Error('Unsafe authenticator fixture cleanup')
    await rm(target, { recursive: true, force: true })
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('original Steam Guard algorithm implementation with synthetic keys', () => {
  it.each([[0, 'YFG53'], [29, 'YFG53'], [30, 'YH76M'], [59, 'YH76M'], [60, '23MGH'], [1700000000, '7MQGM'], [2147483647, '4HG73']] as const)(
    'matches independently checked SteamAuth-compatible vector at %s', (seconds, expected) => {
      expect(generateSteamGuardCode(secret, seconds)).toBe(expected)
    })
  it('uses a full 64-bit counter and produces five Steam alphabet characters', () => {
    const value = generateSteamGuardCode(secret, 200_000_000_000)
    expect(value).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/)
    expect(value).not.toBe(generateSteamGuardCode(secret, 0))
  })
  it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid time %s without echoing input secrets', time => {
    expect(() => generateSteamGuardCode(secret, time)).toThrow('AUTHENTICATOR_TIME_INVALID')
  })
  it.each(['', 'bad-secret', secret.replace('=', ''), secret + '\n', Buffer.alloc(19).toString('base64'), secret.slice(0, -2) + 'B='])(
    'rejects malformed or noncanonical shared-secret encoding', value => {
      expect(() => generateSteamGuardCode(value, 0)).toThrow('AUTHENTICATOR_SECRET_INVALID')
    })
})

describe('strict SDA selected-field parser', () => {
  it('preserves a JSON ulong SteamID exactly and discards all session and confirmation credentials', () => {
    const parsed = parseSdaMaFile(`{"account_name":"Synthetic_Account","shared_secret":"${secret}","identity_secret":"DO_NOT_COPY_IDENTITY",
      "revocation_code":"DO_NOT_COPY_REVOCATION","Session":{"SteamID":${steamId},"AccessToken":"DO_NOT_COPY_ACCESS","RefreshToken":"DO_NOT_COPY_REFRESH"}}`)
    expect(parsed).toEqual({ name: 'Synthetic_Account', steamId, sharedSecret: secret })
    expect(Object.keys(parsed).sort()).toEqual(['name', 'sharedSecret', 'steamId'])
  })
  it('accepts normal JSON escaping and an UTF-8 BOM but never applies a second unescape transform', () => {
    expect(parseSdaMaFile('\uFEFF' + JSON.stringify({ account_name: 'fixture', shared_secret: secret, SteamID: steamId }))).toMatchObject({ steamId, sharedSecret: secret })
    expect(() => parseSdaMaFile(JSON.stringify({ account_name: 'fixture', shared_secret: '\\u0041'.repeat(28) }))).toThrow('AUTHENTICATOR_SECRET_INVALID')
  })
  it('can label a file by SteamID if account_name is absent and can retain account-name-only older exports', () => {
    expect(parseSdaMaFile(JSON.stringify({ SteamID: steamId, shared_secret: secret }))).toMatchObject({ name: steamId, steamId })
    expect(parseSdaMaFile(JSON.stringify({ account_name: 'legacy', shared_secret: secret }))).toMatchObject({ name: 'legacy', steamId: null })
  })
  it.each([
    `{"account_name":"fixture","shared_secret":"${secret}","shared_secret":"${otherSecret}"}`,
    `{"account_name":"fixture","shared_secret":"${secret}","__proto__":{"polluted":true}}`,
    `{"account_name":"fixture","shared_secret":"${secret}"} trailing`,
    `{"account_name":"fixture","shared_secret":"${secret}",}`,
    `{"account_name":"fixture","shared_secret":"${secret}","Session":{"SteamID":76561198000000001,"SteamID":76561198000000002}}`,
    '{"account_name":"\\ud800"}',
    '{"a":' + '['.repeat(20) + '0' + ']'.repeat(20) + '}'
  ])('rejects duplicate keys, prototype keys, invalid Unicode, depth and malformed JSON', text => {
    expect(() => parseSdaMaFile(text)).toThrow('AUTHENTICATOR_JSON_INVALID')
  })
  it.each(['76561198000000001.0', '7.6561198000000001e16', '0', '18446744073709551615'])(
    'rejects fractional, noncanonical, or invalid numeric SteamID %s', value => {
      expect(() => parseSdaMaFile(`{"account_name":"fixture","shared_secret":"${secret}","SteamID":${value}}`)).toThrow('AUTHENTICATOR_IDENTITY_INVALID')
    })
  it('never collapses neighboring valid SteamIDs through floating-point conversion', () => {
    const value = (id: string) => parseSdaMaFile(`{"account_name":"fixture","shared_secret":"${secret}","SteamID":${id}}`).steamId
    expect(value(steamId)).toBe(steamId)
    expect(value('76561198000000000')).toBe('76561198000000000')
    expect(value(steamId)).not.toBe(value('76561198000000000'))
  })
  it('rejects conflicting identity claims instead of silently choosing one', () => {
    expect(() => parseSdaMaFile(JSON.stringify({ account_name: 'fixture', shared_secret: secret, SteamID: steamId,
      Session: { SteamID: '76561198000000002' } }))).toThrow('AUTHENTICATOR_IDENTITY_INVALID')
  })
  it.each(['aGVsbG8=', 'not JSON', JSON.stringify({ encrypted: true, ciphertext: 'abc' })])('does not guess passwords for encrypted or unsupported files', value => {
    expect(() => parseSdaMaFile(value)).toThrow('AUTHENTICATOR_ENCRYPTED_UNSUPPORTED')
  })
  it('rejects oversized text and unsafe account labels', () => {
    expect(() => parseSdaMaFile('x'.repeat(MAX_MAFILE_BYTES + 1))).toThrow('AUTHENTICATOR_FILE_TOO_LARGE')
    expect(() => parseSdaMaFile(JSON.stringify({ account_name: '../escape', shared_secret: secret }))).toThrow('AUTHENTICATOR_NAME_INVALID')
  })
})

describe('encrypted authenticator vault, with disposable files only', () => {
  it('previews without codes or secrets, persists only encrypted selected fields and survives a fresh instance', async () => {
    const f = await fixture()
    const input = await f.mafile({ identity_secret: 'PRIVATE_IDENTITY_SECRET', Session: { SteamID: steamId, AccessToken: 'PRIVATE_ACCESS', RefreshToken: 'PRIVATE_REFRESH' }, revocation_code: 'PRIVATE_REVOCATION' })
    const original = await readFile(input)
    const preview = await f.service.prepareImport(input)
    expect(preview).toMatchObject({ name: 'Synthetic_Account', steamId, replacesId: null })
    expect(Object.keys(preview).sort()).toEqual(['id', 'name', 'replacesId', 'steamId'])
    await expect(readFile(f.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const snapshot = await f.service.confirmImport({ id: preview.id, replace: false })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({ name: 'Synthetic_Account', steamId, code: 'YFG53', expiresAt: 30000, timeSource: 'local' })
    expect(Object.keys(snapshot.entries[0]!).sort()).toEqual(['capabilities', 'code', 'expiresAt', 'id', 'name', 'steamId', 'timeSource'])
    expect(snapshot.entries[0]!.capabilities).toEqual({ hasConfirmations: false, fullBackup: false })
    const encrypted = await readFile(f.vaultPath, 'utf8')
    const clear = f.encrypt.mock.calls.map(call => call[0]).join(' ')
    for (const value of [secret, 'Synthetic_Account', steamId, 'PRIVATE_IDENTITY_SECRET', 'PRIVATE_ACCESS', 'PRIVATE_REFRESH', 'PRIVATE_REVOCATION']) expect(encrypted).not.toContain(value)
    for (const value of ['PRIVATE_IDENTITY_SECRET', 'PRIVATE_ACCESS', 'PRIVATE_REFRESH', 'PRIVATE_REVOCATION', 'identity_secret', 'Session']) expect(clear).not.toContain(value)
    expect(await readFile(input)).toEqual(original)
    expect((await new SteamAuthenticatorService(f.options).state()).entries).toEqual(snapshot.entries)
    expect((await readdir(dirname(f.vaultPath))).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('requires explicit confirmation to replace a duplicate account and keeps its stable entry id', async () => {
    const f = await fixture()
    const first = await f.import()
    const file = await f.mafile({ shared_secret: otherSecret, account_name: 'synthetic_account' })
    const preview = await f.service.prepareImport(file)
    expect(preview.replacesId).toBe(first.entries[0]!.id)
    await expect(f.service.confirmImport({ id: preview.id, replace: false })).rejects.toMatchObject({ code: 'AUTHENTICATOR_REPLACE_REQUIRED' })
    expect((await f.service.state()).entries).toEqual(first.entries)
    const again = await f.service.prepareImport(file)
    const updated = await f.service.confirmImport({ id: again.id, replace: true })
    expect(updated.entries).toHaveLength(1)
    expect(updated.entries[0]!.id).toBe(first.entries[0]!.id)
    expect(updated.entries[0]!.code).toBe(generateSteamGuardCode(otherSecret, 0))
  })
  it('deduplicates a renamed SteamID but refuses the same name claiming another SteamID', async () => {
    const f = await fixture(); const first = await f.import()
    const preview = await f.service.prepareImport(await f.mafile({ account_name: 'renamed' }))
    expect(preview.replacesId).toBe(first.entries[0]!.id)
    await expect(f.service.prepareImport(await f.mafile({ Session: { SteamID: '76561198000000002' } }))).rejects.toMatchObject({ code: 'AUTHENTICATOR_IDENTITY_INVALID' })
  })
  it('cancels and expires pending imports without writing any vault', async () => {
    const f = await fixture()
    const preview = await f.service.prepareImport(await f.mafile())
    f.service.cancelImport(preview.id)
    await expect(f.service.confirmImport({ id: preview.id, replace: false })).rejects.toMatchObject({ code: 'AUTHENTICATOR_IMPORT_EXPIRED' })
    const second = await f.service.prepareImport(await f.mafile())
    f.time.value = 300001
    await expect(f.service.confirmImport({ id: second.id, replace: false })).rejects.toMatchObject({ code: 'AUTHENTICATOR_IMPORT_EXPIRED' })
    await expect(readFile(f.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('removes only the selected local token and never makes a network call', async () => {
    const fetch = vi.fn(async () => { throw new Error('Forbidden synthetic network call') })
    const f = await fixture({ fetchImpl: fetch })
    const snapshot = await f.import()
    const mafile = await f.mafile()
    expect((await f.service.remove({ id: snapshot.entries[0]!.id })).entries).toEqual([])
    expect(await readFile(mafile, 'utf8')).toContain(secret)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses unavailable encryption without persisting plaintext', async () => {
    const f = await fixture(); f.available.value = false
    expect(await f.service.state()).toMatchObject({ entries: [], secretStorageAvailable: false })
    await expect(f.service.prepareImport(await f.mafile())).rejects.toMatchObject({ code: 'AUTHENTICATOR_STORAGE_UNAVAILABLE' })
    await expect(readFile(f.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves a corrupt or undecryptable vault instead of overwriting it', async () => {
    const f = await fixture(); await f.import()
    const changed = '{"schema":1,"ciphertext":"YWJj"}'
    await writeFile(f.vaultPath, changed)
    await expect(f.service.state()).rejects.toMatchObject({ code: 'AUTHENTICATOR_VAULT_INVALID' })
    await expect(f.service.prepareImport(await f.mafile())).rejects.toMatchObject({ code: 'AUTHENTICATOR_VAULT_INVALID' })
    expect(await readFile(f.vaultPath, 'utf8')).toBe(changed)
  })
  it('detects vault changes while an import confirmation is open', async () => {
    const f = await fixture(); await f.import()
    const preview = await f.service.prepareImport(await f.mafile({ shared_secret: otherSecret }))
    const file = await readFile(f.vaultPath)
    await writeFile(f.vaultPath, Buffer.concat([file, Buffer.from(' ')]))
    const after = await readFile(f.vaultPath)
    await expect(f.service.confirmImport({ id: preview.id, replace: true })).rejects.toMatchObject({ code: 'AUTHENTICATOR_VAULT_CHANGED' })
    expect(await readFile(f.vaultPath)).toEqual(after)
  })
  it('keeps the previous vault intact when encryption fails before atomic replacement', async () => {
    const f = await fixture(); await f.import()
    const original = await readFile(f.vaultPath)
    const preview = await f.service.prepareImport(await f.mafile({ shared_secret: otherSecret }))
    f.encrypt.mockImplementationOnce(() => { throw new Error(`Must not leak ${secret}`) })
    await expect(f.service.confirmImport({ id: preview.id, replace: true })).rejects.toThrow('AUTHENTICATOR_STORAGE_FAILED')
    expect(await readFile(f.vaultPath)).toEqual(original)
  })
  it('rejects oversized files, wrong extensions and hardlinked imports', async () => {
    const f = await fixture(), big = join(f.root, 'too-big.maFile')
    await writeFile(big, Buffer.alloc(MAX_MAFILE_BYTES + 1))
    await expect(f.service.prepareImport(big)).rejects.toMatchObject({ code: 'AUTHENTICATOR_FILE_INVALID' })
    await expect(f.service.prepareImport(join(f.root, 'not-selected.txt'))).rejects.toMatchObject({ code: 'AUTHENTICATOR_PATH_INVALID' })
    const file = await f.mafile(); await link(file, join(f.root, 'alias.maFile'))
    await expect(f.service.prepareImport(file)).rejects.toMatchObject({ code: 'AUTHENTICATOR_FILE_INVALID' })
  })
  it('rejects a linked vault parent before creating any child directory through it', async () => {
    const f = await fixture(), outside = join(f.root, 'outside'), linked = join(f.root, 'linked')
    await mkdir(outside)
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const service = new SteamAuthenticatorService({ ...f.options, vaultPath: join(linked, 'must-not-create', 'vault.json') })
    await expect(service.state()).rejects.toMatchObject({ code: 'AUTHENTICATOR_PATH_INVALID' })
    await expect(lstat(join(outside, 'must-not-create'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a hardlinked vault before any local mutation', async () => {
    const f = await fixture(); const snapshot = await f.import()
    await link(f.vaultPath, join(f.root, 'unrelated-copy.json'))
    const before = await readFile(f.vaultPath)
    await expect(f.service.remove(snapshot.entries[0]!.id)).rejects.toMatchObject({ code: 'AUTHENTICATOR_FILE_INVALID' })
    expect(await readFile(f.vaultPath)).toEqual(before)
  })
})

describe('vault v2 opt-in SDA materials and exclusive native-file export', () => {
  async function fullImport(f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}) {
    const file = await f.mafile({ ...sdaBackup, Session: { SteamID: steamId, SessionID: 'NEVER_SAVE_SESSION', AccessToken: 'NEVER_SAVE_ACCESS', RefreshToken: 'NEVER_SAVE_REFRESH', OAuthToken: 'NEVER_SAVE_OAUTH' }, ...patch })
    const preview = await f.service.prepareImport(file, { retainSdaBackup: true })
    const snapshot = await f.service.confirmImport({ id: preview.id, replace: false })
    return { file, snapshot, id: snapshot.entries[0]!.id }
  }

  it('retains only the opted-in allowlist under encryption and exposes capability flags, never secret DTO fields', async () => {
    const f = await fixture(), imported = await fullImport(f)
    expect(imported.snapshot.entries[0]!.capabilities).toEqual({ hasConfirmations: true, fullBackup: true, hasRecoveryCode: true })
    const publicText = JSON.stringify(imported.snapshot)
    const disk = await readFile(f.vaultPath, 'utf8'), envelope = JSON.parse(disk)
    expect(envelope.schema).toBe(2)
    const plain = f.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64'))
    const stored = JSON.parse(plain)
    expect(stored.schema).toBe(2)
    expect(stored.entries[0].backup).toMatchObject({ identitySecret, deviceId: sdaBackup.device_id, revocationCode: sdaBackup.revocation_code, fullyEnrolled: true,
      serialNumber: sdaBackup.serial_number, tokenGid: sdaBackup.token_gid, secret1: sdaBackup.secret_1 })
    for (const secret of [identitySecret, sdaBackup.device_id, sdaBackup.revocation_code, sdaBackup.secret_1]) {
      expect(disk).not.toContain(secret); expect(publicText).not.toContain(secret)
    }
    for (const discarded of ['NEVER_SAVE_SESSION', 'NEVER_SAVE_ACCESS', 'NEVER_SAVE_REFRESH', 'NEVER_SAVE_OAUTH', 'Session', 'AccessToken', 'RefreshToken', 'OAuthToken']) expect(plain).not.toContain(discarded)
    expect(await f.service.confirmationMaterial(imported.id)).toEqual({ steamId, name: 'Synthetic_Account', identitySecret, deviceId: sdaBackup.device_id })
    expect((await new SteamAuthenticatorService(f.options).state()).entries[0]!.capabilities.fullBackup).toBe(true)
  })

  it('keeps default imports codes-only even when a file contains all extra secret material', async () => {
    const f = await fixture(), file = await f.mafile(sdaBackup), preview = await f.service.prepareImport(file)
    const snapshot = await f.service.confirmImport({ id: preview.id, replace: false })
    expect(snapshot.entries[0]!.capabilities).toEqual({ hasConfirmations: false, fullBackup: false })
    await expect(f.service.confirmationMaterial(snapshot.entries[0]!.id)).rejects.toMatchObject({ code: 'AUTHENTICATOR_CONFIRMATIONS_UNAVAILABLE' })
    expect(f.encrypt.mock.calls.at(-1)![0]).not.toContain(identitySecret)
  })

  it('reads an existing v1 vault without fabricating confirmation keys and upgrades only on an explicit local mutation', async () => {
    const f = await fixture(), id = '11111111-1111-4111-8111-111111111111'
    const legacy = { schema: 1, entries: [{ id, name: 'legacy', steamId, sharedSecret: secret }] }
    await mkdir(dirname(f.vaultPath), { recursive: true })
    await writeFile(f.vaultPath, JSON.stringify({ schema: 1, ciphertext: f.cipher.encrypt(JSON.stringify(legacy)).toString('base64') }))
    const before = await readFile(f.vaultPath)
    const snapshot = await f.service.state()
    expect(snapshot.entries[0]).toMatchObject({ id, code: 'YFG53', capabilities: { hasConfirmations: false, fullBackup: false } })
    expect(await readFile(f.vaultPath)).toEqual(before)
    const destination = join(f.root, 'legacy-backup.maFile')
    expect(await f.service.exportTo(id, destination)).toEqual({ kind: 'codes-only' })
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({ account_name: 'legacy', shared_secret: secret, Session: { SteamID: steamId } })
    expect(await readFile(f.vaultPath)).toEqual(before)
    await f.service.remove(id)
    expect(JSON.parse(await readFile(f.vaultPath, 'utf8')).schema).toBe(2)
  })

  it('exports a complete opted-in maFile with only a safe SteamID session stub, leaving source and vault untouched', async () => {
    const f = await fixture(), imported = await fullImport(f)
    const source = await readFile(imported.file), vault = await readFile(f.vaultPath), destination = join(f.root, 'exported.maFile')
    expect(await f.service.exportTo(imported.id, destination)).toEqual({ kind: 'sda-backup' })
    const output = JSON.parse(await readFile(destination, 'utf8'))
    expect(output).toEqual({ account_name: 'Synthetic_Account', shared_secret: secret, Session: { SteamID: steamId }, ...sdaBackup })
    expect(Object.keys(output.Session)).toEqual(['SteamID'])
    expect(await readFile(imported.file)).toEqual(source)
    expect(await readFile(f.vaultPath)).toEqual(vault)
    expect((await readdir(f.root)).some(name => name.startsWith('.authenticator-export-'))).toBe(false)
    expect((await lstat(destination)).nlink).toBe(1)
    const roundTrip = parseSdaMaFile(await readFile(destination, 'utf8'), { retainSdaBackup: true })
    expect(roundTrip.backup).toMatchObject({ identitySecret, deviceId: sdaBackup.device_id, fullyEnrolled: true })
  })

  it('preserves partial metadata honestly and does not invent missing recovery or confirmation fields', async () => {
    const f = await fixture()
    const file = await f.mafile({ identity_secret: identitySecret, device_id: sdaBackup.device_id, fully_enrolled: true })
    const preview = await f.service.prepareImport(file, { retainSdaBackup: true })
    const snapshot = await f.service.confirmImport({ id: preview.id, replace: false })
    expect(snapshot.entries[0]!.capabilities).toEqual({ hasConfirmations: true, fullBackup: false })
    const destination = join(f.root, 'partial.maFile')
    await f.service.exportTo(snapshot.entries[0]!.id, destination)
    const output = JSON.parse(await readFile(destination, 'utf8'))
    expect(output.identity_secret).toBe(identitySecret)
    expect(output.revocation_code).toBeUndefined(); expect(output.serial_number).toBeUndefined(); expect(output.secret_1).toBeUndefined()
  })

  it('does not make an unfinished authenticator available for confirmations', async () => {
    const f = await fixture(), imported = await fullImport(f, { fully_enrolled: false })
    expect(imported.snapshot.entries[0]!.capabilities).toEqual({ hasConfirmations: false, fullBackup: false, hasRecoveryCode: true })
    await expect(f.service.confirmationMaterial(imported.id)).rejects.toMatchObject({ code: 'AUTHENTICATOR_CONFIRMATIONS_UNAVAILABLE' })
  })

  it.each([
    { identity_secret: 'wrong' }, { device_id: 'android:invalid' }, { revocation_code: 'arbitrary\nsecret' }, { fully_enrolled: 'true' },
    { serial_number: 'serial\nnumber' }, { token_gid: {} }, { secret_1: 'non canonical base64' }
  ])('rejects malformed opted-in SDA fields without exposing their content', async patch => {
    const f = await fixture(), file = await f.mafile({ ...sdaBackup, ...patch })
    await expect(f.service.prepareImport(file, { retainSdaBackup: true })).rejects.toThrow('AUTHENTICATOR_BACKUP_INVALID')
    await expect(readFile(f.vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite an existing destination, including the original imported maFile', async () => {
    const f = await fixture(), imported = await fullImport(f)
    const original = await readFile(imported.file), output = join(f.root, 'existing.maFile')
    await writeFile(output, 'KEEP_EXISTING_FILE')
    await expect(f.service.exportTo(imported.id, output)).rejects.toMatchObject({ code: 'AUTHENTICATOR_EXPORT_EXISTS' })
    await expect(f.service.exportTo(imported.id, imported.file)).rejects.toMatchObject({ code: 'AUTHENTICATOR_EXPORT_EXISTS' })
    expect(await readFile(imported.file)).toEqual(original)
    expect(await readFile(output, 'utf8')).toBe('KEEP_EXISTING_FILE')
  })

  it('publishes at most one complete file when two export requests target the same name', async () => {
    const f = await fixture(), imported = await fullImport(f), output = join(f.root, 'exclusive.maFile')
    const results = await Promise.allSettled([f.service.exportTo(imported.id, output), f.service.exportTo(imported.id, output)])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(JSON.parse(await readFile(output, 'utf8')).shared_secret).toBe(secret)
    expect((await readdir(f.root)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('rejects a linked export directory and leaves its actual target empty', async () => {
    const f = await fixture(), imported = await fullImport(f), actual = join(f.root, 'actual'), alias = join(f.root, 'alias')
    await mkdir(actual); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.service.exportTo(imported.id, join(alias, 'secret.maFile'))).rejects.toMatchObject({ code: 'AUTHENTICATOR_PATH_INVALID' })
    expect(await readdir(actual)).toEqual([])
  })

  it.each(['other.txt:secret.maFile', 'CON.maFile', 'aux .maFile', 'LPT1.maFile', 'COM¹.maFile', 'CONIN$.maFile', 'trailing.maFile.', 'space.maFile ', 'wild?.maFile', 'pipe|.maFile', 'quote".maFile'])(
    'rejects ADS, device names and ambiguous Windows file names before import or export: %s', async name => {
      const f = await fixture(), imported = await fullImport(f), destination = join(f.root, name)
      await expect(f.service.exportTo(imported.id, destination)).rejects.toMatchObject({ code: 'AUTHENTICATOR_PATH_INVALID' })
      await expect(f.service.prepareImport(destination)).rejects.toMatchObject({ code: 'AUTHENTICATOR_PATH_INVALID' })
    })

  it('validates metadata inside encrypted v2 and never accepts a hidden login-session payload', async () => {
    const f = await fixture(), imported = await fullImport(f), snapshot = imported.snapshot.entries[0]!
    const payload = { schema: 2, entries: [{ id: snapshot.id, name: snapshot.name, steamId, sharedSecret: secret,
      backup: { identitySecret, deviceId: sdaBackup.device_id, fullyEnrolled: true, Session: { AccessToken: 'FORBIDDEN' } } }] }
    await writeFile(f.vaultPath, JSON.stringify({ schema: 2, ciphertext: f.cipher.encrypt(JSON.stringify(payload)).toString('base64') }))
    await expect(f.service.state()).rejects.toMatchObject({ code: 'AUTHENTICATOR_VAULT_INVALID' })
  })

  it('can persist verified enrollment materials idempotently without returning secrets or requiring a second vault write', async () => {
    const f = await fixture()
    const material = { name: 'new_enrollment', steamId, sharedSecret: secret, identitySecret, deviceId: sdaBackup.device_id,
      revocationCode: sdaBackup.revocation_code, fullyEnrolled: true as const, serialNumber: sdaBackup.serial_number,
      tokenGid: sdaBackup.token_gid, secret1: sdaBackup.secret_1 }
    const first = await f.service.saveEnrolled(material)
    expect(Object.keys(first)).toEqual(['id'])
    const before = await readFile(f.vaultPath)
    expect(await f.service.saveEnrolled(material)).toEqual(first)
    expect(await readFile(f.vaultPath)).toEqual(before)
    expect((await f.service.state()).entries[0]!.capabilities).toEqual({ hasConfirmations: true, fullBackup: true, hasRecoveryCode: true })
    await expect(f.service.saveEnrolled({ ...material, sharedSecret: otherSecret })).rejects.toMatchObject({ code: 'AUTHENTICATOR_REPLACE_REQUIRED' })
    expect(await f.service.saveEnrolled({ ...material, sharedSecret: otherSecret }, { replaceId: first.id })).toEqual(first)
  })
})

describe('optional anonymous Steam time calibration', () => {
  it('does not query on state/import; adjusts codes and returns a local countdown deadline only after explicit sync', async () => {
    const query = vi.fn(async () => 60)
    const f = await fixture({ querySteamTime: query })
    await f.import(); expect(query).not.toHaveBeenCalled()
    f.time.value = 1000
    const state = await f.service.syncTime()
    expect(state).toMatchObject({ timeSource: 'steam', clockWarning: null })
    expect(state.entries[0]).toMatchObject({ code: '23MGH', expiresAt: 31000, timeSource: 'steam' })
    expect(query).toHaveBeenCalledOnce()
  })
  it('falls back with a local-clock warning on failed or malformed time responses, without leaking the error', async () => {
    const f = await fixture({ querySteamTime: async () => { throw new Error(`private payload ${secret}`) } })
    await f.import()
    const value = await f.service.syncTime()
    expect(value).toMatchObject({ timeSource: 'local', clockWarning: 'steam-time-unavailable' })
    expect(JSON.stringify(value)).not.toContain(secret)
  })
  it('invalidates a calibration after a wall-clock jump and does not silently query again', async () => {
    let monotonic = 0
    const query = vi.fn(async () => 60), f = await fixture({ querySteamTime: query, monotonicNow: () => monotonic })
    await f.import(); await f.service.syncTime()
    monotonic = 1000; f.time.value = 31000
    expect(await f.service.state()).toMatchObject({ timeSource: 'local', clockWarning: 'local-clock' })
    expect(query).toHaveBeenCalledOnce()
  })
  it('bounds an unresponsive time provider and aborts only its anonymous request', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const f = await fixture({ querySteamTime: current => { signal = current; return new Promise(() => undefined) } })
    const syncing = f.service.syncTime()
    await vi.advanceTimersByTimeAsync(8000)
    expect(await syncing).toMatchObject({ timeSource: 'local', clockWarning: 'steam-time-unavailable' })
    expect(signal!.aborted).toBe(true)
  })
  it('requests only the fixed anonymous time endpoint without session credentials or redirects', async () => {
    const fetch = vi.fn(async () => Response.json({ response: { server_time: '1700000000' } }))
    expect(await queryAnonymousSteamTime(fetch)).toBe(1700000000)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', expect.objectContaining({
      method: 'POST', body: 'steamid=0', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }))
  })
  it('sanitizes transport exceptions even when the time helper is used directly', async () => {
    const query = queryAnonymousSteamTime(vi.fn(async () => { throw new Error(`private transport context ${secret}`) }))
    await expect(query).rejects.toThrow('AUTHENTICATOR_TIME_UNAVAILABLE')
    await expect(query).rejects.not.toThrow(secret)
  })
  it.each([Response.json({ response: { server_time: '1e9' } }), Response.json({ response: {} }), new Response('x'.repeat(16385)), new Response('', { status: 403 })])(
    'rejects malformed, oversized or refused anonymous time responses', async response => {
      await expect(queryAnonymousSteamTime(vi.fn(async () => response))).rejects.toThrow('AUTHENTICATOR_TIME_UNAVAILABLE')
    })
})

async function fixture(extra: Partial<SteamAuthenticatorOptions> = {}) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'steam-authenticator-test-'))); roots.push(root)
  const vaultPath = join(root, 'vault', 'authenticator.json'), key = randomBytes(32), available = { value: true }, time = { value: 0 }
  const encrypt = vi.fn((value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  })
  const cipher: SecretCipher = { isAvailable: () => available.value, backend: () => 'synthetic-aes', encrypt,
    decrypt: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') } }
  const options = { vaultPath, cipher, now: () => time.value, monotonicNow: () => time.value, ...extra }
  const service = new SteamAuthenticatorService(options)
  let fileCounter = 0
  const mafile = async (patch: Record<string, unknown> = {}) => {
    const path = join(root, `synthetic-${++fileCounter}.maFile`)
    await writeFile(path, JSON.stringify({ account_name: 'Synthetic_Account', shared_secret: secret, Session: { SteamID: steamId }, ...patch }))
    return path
  }
  return { root, vaultPath, service, cipher, encrypt, options, available, time, mafile,
    async import() { const preview = await service.prepareImport(await mafile()); return service.confirmImport({ id: preview.id, replace: false }) } }
}
