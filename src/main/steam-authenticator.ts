import { createHash, createHmac, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DomainError } from '../shared/domain'
import type { SteamAuthenticatorCapabilities, SteamAuthenticatorImportPreview, SteamAuthenticatorSnapshot } from '../shared/steam-authenticator'
import type { SecretCipher } from './store'
import type { EnrollmentIssuedMaterialRescue } from './steam-authenticator-enrollment'

export const MAX_MAFILE_BYTES = 64 * 1024
const MAX_VAULT_BYTES = 512 * 1024
const MAX_ENTRIES = 200
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_NAME = /^[A-Za-z0-9_.@-]{1,64}$/
const STEAM_ID_BASE = 76_561_197_960_265_728n
const fail = (suffix: string): DomainError => new DomainError(`AUTHENTICATOR_${suffix}`, `AUTHENTICATOR_${suffix}`)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const samePath = (left: string, right: string): boolean => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function checkedLocalPath(value: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || value.startsWith('\\\\') || /[\x00-\x1f\x7f-\x9f]/.test(value)
    || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) throw fail('PATH_INVALID')
  const parts = process.platform === 'win32' ? value.slice(3).split(/[\\/]/) : value.slice(1).split('/')
  for (const part of parts) {
    const stem = part.split('.')[0]!.replace(/ +$/, '')
    if (!part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[ .]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/i.test(stem)) throw fail('PATH_INVALID')
  }
}

class JsonNumber { constructor(readonly source: string) {} }

// Preserve integer lexemes: SDA may serialize SteamID64 as a JSON ulong, beyond JS safe integers.
function strictJson(text: string): unknown {
  let at = 0
  const whitespace = (): void => { while (/[ \t\r\n]/.test(text[at] ?? '\0')) at++ }
  const invalid = (): never => { throw fail('JSON_INVALID') }
  const string = (): string => {
    if (text[at++] !== '"') return invalid()
    const start = at - 1
    while (at < text.length) {
      const next = text[at++]!
      if (next === '\\') { at++; continue }
      if (next === '"') {
        let value: unknown
        try { value = JSON.parse(text.slice(start, at)) } catch { return invalid() }
        if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) return invalid()
        return value
      }
    }
    return invalid()
  }
  const value = (depth: number): unknown => {
    if (depth > 12) return invalid()
    whitespace()
    if (text[at] === '"') return string()
    if (text[at] === '{') {
      at++; whitespace()
      const output: Record<string, unknown> = Object.create(null)
      if (text[at] === '}') { at++; return output }
      for (;;) {
        const key = string()
        if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(output, key)) return invalid()
        whitespace(); if (text[at++] !== ':') return invalid()
        output[key] = value(depth + 1); whitespace()
        const next = text[at++]
        if (next === '}') return output
        if (next !== ',') return invalid()
        whitespace()
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); const output: unknown[] = []
      if (text[at] === ']') { at++; return output }
      for (;;) {
        if (output.length >= 1024) return invalid()
        output.push(value(depth + 1)); whitespace()
        const next = text[at++]
        if (next === ']') return output
        if (next !== ',') return invalid()
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0]
    if (!number || number.length > 64 || !Number.isFinite(Number(number))) return invalid()
    at += number.length; return new JsonNumber(number)
  }
  const result = value(0); whitespace()
  if (at !== text.length) return invalid()
  return result
}

function steamId(value: unknown): string {
  const text = value instanceof JsonNumber ? value.source : value
  if (typeof text !== 'string' || !/^\d{17}$/.test(text) || BigInt(text) <= STEAM_ID_BASE || BigInt(text) > STEAM_ID_BASE + 0xffff_ffffn) throw fail('IDENTITY_INVALID')
  return text
}

function secretBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value)) throw fail('SECRET_INVALID')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 20 || decoded.toString('base64') !== value) { decoded.fill(0); throw fail('SECRET_INVALID') }
  return decoded
}

interface SdaBackup {
  identitySecret?: string
  deviceId?: string
  revocationCode?: string
  fullyEnrolled?: boolean
  serialNumber?: string
  tokenGid?: string
  secret1?: string
}
interface ParsedAuthenticator { name: string; steamId: string | null; sharedSecret: string; backup?: SdaBackup }
interface VaultEntry extends ParsedAuthenticator { id: string }

export interface SteamAuthenticatorImportOptions { retainSdaBackup?: boolean }

// Main-only input, supplied only after enrollment finalization and status verification.
export interface SteamAuthenticatorEnrolledMaterial {
  name: string
  steamId: string
  sharedSecret: string
  identitySecret: string
  deviceId: string
  revocationCode: string
  fullyEnrolled: true
  serialNumber?: string
  tokenGid?: string
  secret1?: string
}

const BACKUP_FIELDS = {
  identity_secret: 'identitySecret', device_id: 'deviceId', revocation_code: 'revocationCode', fully_enrolled: 'fullyEnrolled',
  serial_number: 'serialNumber', token_gid: 'tokenGid', secret_1: 'secret1'
} as const
const BACKUP_KEYS: ReadonlySet<string> = new Set(Object.values(BACKUP_FIELDS))

function backupFields(input: Record<string, unknown>): SdaBackup | undefined {
  const backup: Record<string, string | boolean> = {}
  for (const [source, target] of Object.entries(BACKUP_FIELDS)) {
    let value = input[source]
    if (value === undefined || value === null || value === '') continue
    if (source === 'fully_enrolled') {
      if (typeof value !== 'boolean') throw fail('BACKUP_INVALID')
      backup[target] = value; continue
    }
    if (value instanceof JsonNumber && (source === 'serial_number' || source === 'token_gid')) value = value.source
    if (typeof value !== 'string' || value.length > 256 || /[^\x21-\x7e]/.test(value)) throw fail('BACKUP_INVALID')
    if (source === 'identity_secret') { const bytes = secretBytes(value); bytes.fill(0) }
    else if (source === 'device_id' && !/^android:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw fail('BACKUP_INVALID')
    else if (source === 'revocation_code' && !/^R[A-Z0-9]{5,31}$/.test(value)) throw fail('BACKUP_INVALID')
    else if ((source === 'serial_number' || source === 'token_gid') && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw fail('BACKUP_INVALID')
    else if (source === 'secret_1') {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('BACKUP_INVALID')
      const bytes = Buffer.from(value, 'base64')
      try { if (!bytes.length || bytes.length > 128 || bytes.toString('base64') !== value) throw fail('BACKUP_INVALID') }
      finally { bytes.fill(0) }
    }
    backup[target] = value
  }
  return Object.keys(backup).length ? backup as SdaBackup : undefined
}

function checkedBackup(value: unknown): SdaBackup {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(key => !BACKUP_KEYS.has(key))) throw fail('VAULT_INVALID')
  const input: Record<string, unknown> = {}
  for (const [source, target] of Object.entries(BACKUP_FIELDS)) if (Object.hasOwn(value, target)) input[source] = value[target]
  const checked = backupFields(input)
  if (!checked || Object.keys(checked).length !== Object.keys(value).length) throw fail('VAULT_INVALID')
  return checked
}

function capabilities(entry: ParsedAuthenticator): SteamAuthenticatorCapabilities {
  const backup = entry.backup
  const hasConfirmations = Boolean(entry.steamId && backup?.identitySecret && backup.deviceId && backup.fullyEnrolled === true)
  return { hasConfirmations, fullBackup: Boolean(hasConfirmations && backup?.revocationCode && backup.serialNumber && backup.tokenGid && backup.secret1),
    ...(backup?.revocationCode ? { hasRecoveryCode: true } : {}) }
}

export function parseSdaMaFile(text: string, options: SteamAuthenticatorImportOptions = {}): ParsedAuthenticator {
  if (options.retainSdaBackup !== undefined && typeof options.retainSdaBackup !== 'boolean') throw fail('IMPORT_OPTIONS_INVALID')
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MAFILE_BYTES) throw fail('FILE_TOO_LARGE')
  text = text.replace(/^\uFEFF/, '')
  if (!text.trimStart().startsWith('{')) throw fail('ENCRYPTED_UNSUPPORTED')
  const input = strictJson(text)
  if (!record(input) || input.encrypted === true || Object.hasOwn(input, 'ciphertext')) throw fail('ENCRYPTED_UNSUPPORTED')
  const secret = secretBytes(input.shared_secret); secret.fill(0)
  if (input.Session !== undefined && input.Session !== null && !record(input.Session)) throw fail('IDENTITY_INVALID')
  const ids = [input.SteamID, input.steamid, record(input.Session) ? input.Session.SteamID : undefined]
    .filter(value => value !== undefined && value !== null && value !== '').map(steamId)
  if (new Set(ids).size > 1) throw fail('IDENTITY_INVALID')
  const id = ids[0] ?? null
  if (input.account_name !== undefined && (typeof input.account_name !== 'string' || !ACCOUNT_NAME.test(input.account_name))) throw fail('NAME_INVALID')
  const name = typeof input.account_name === 'string' ? input.account_name : id
  if (!name) throw fail('NAME_INVALID')
  let backup: SdaBackup | undefined
  if (options.retainSdaBackup === true) {
    try { backup = backupFields(input) } catch { throw fail('BACKUP_INVALID') }
  }
  return { name, steamId: id, sharedSecret: input.shared_secret as string, ...(backup ? { backup } : {}) }
}

export function generateSteamGuardCode(sharedSecret: string, unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0 || unixSeconds > 8_639_999_999_999) throw fail('TIME_INVALID')
  const key = secretBytes(sharedSecret), counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)))
  let digest: Buffer | undefined
  try {
    // Algorithm parameters cross-checked against geel9/SteamAuth SteamGuardAccount.cs; independent implementation.
    digest = createHmac('sha1', key).update(counter).digest()
    let value = digest.readUInt32BE(digest[19]! & 15) & 0x7fff_ffff
    const alphabet = '23456789BCDFGHJKMNPQRTVWXY'
    const letters = Array.from({ length: 5 }, () => { const letter = alphabet[value % alphabet.length]!; value = Math.floor(value / alphabet.length); return letter })
    return letters.join('')
  } finally { key.fill(0); counter.fill(0); digest?.fill(0) }
}

interface FileProof { dev: number; ino: number; size: number; mtimeMs: number; hash: string }
const matches = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
const proof = (info: Stats, bytes: Buffer): FileProof => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, hash: createHash('sha256').update(bytes).digest('hex') })
const sameProof = (left: FileProof | null, right: FileProof | null): boolean => left === null || right === null ? left === right : Object.keys(left).every(key => left[key as keyof FileProof] === right[key as keyof FileProof])

async function checkedDirectory(directory: string, create: boolean): Promise<string> {
  if (!isAbsolute(directory) || directory.startsWith('\\\\') || /[\x00-\x1f]/.test(directory)) throw fail('PATH_INVALID')
  if (create) {
    for (let current = resolve(directory); ; current = dirname(current)) {
      let info: Stats | undefined
      try { info = await lstat(current) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw fail('PATH_INVALID')
      }
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw fail('PATH_INVALID')
      if (dirname(current) === current) break
    }
  }
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let current = resolve(directory); ; current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PATH_INVALID')
    if (dirname(current) === current) break
  }
  return realpath(directory)
}

async function boundedFile(path: string, maximum: number, missing = false): Promise<{ bytes: Buffer; proof: FileProof } | null> {
  let before: Stats
  try { before = await lstat(path) } catch (error) {
    if (missing && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw fail('FILE_UNAVAILABLE')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw fail('FILE_INVALID')
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    if (!matches(before, await handle.stat())) throw fail('FILE_CHANGED')
    const bytes = Buffer.alloc(before.size + 1); let read = 0
    while (read < bytes.length) { const result = await handle.read(bytes, read, bytes.length - read, read); if (!result.bytesRead) break; read += result.bytesRead }
    const after = await lstat(path)
    if (read !== before.size || !matches(before, after) || !matches(before, await handle.stat()) || after.isSymbolicLink() || after.nlink !== 1) throw fail('FILE_CHANGED')
    const content = bytes.subarray(0, read)
    return { bytes: content, proof: proof(after, content) }
  } finally { await handle.close() }
}

function decode(bytes: Buffer): string { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw fail('JSON_INVALID') } }
function duplicates(entries: VaultEntry[], candidate: ParsedAuthenticator): VaultEntry | undefined {
  const found = entries.filter(entry => candidate.steamId !== null && entry.steamId === candidate.steamId || entry.name.toLowerCase() === candidate.name.toLowerCase())
  if (found.length > 1 || found.some(entry => entry.steamId !== null && candidate.steamId !== null && entry.steamId !== candidate.steamId)) throw fail('IDENTITY_INVALID')
  return found[0]
}

export interface SteamAuthenticatorOptions {
  vaultPath: string
  cipher: SecretCipher
  now?: () => number
  monotonicNow?: () => number
  querySteamTime?: (signal?: AbortSignal) => Promise<number>
  fetchImpl?: typeof fetch
}

// Main-process encrypted state primitive, shared by the crash-resumable enrollment manager.
// It is intentionally absent from renderer/shared APIs.
export class EncryptedAuthenticatorStateStore {
  private known: FileProof | null | undefined
  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}
  private async location(): Promise<string> {
    checkedLocalPath(this.path)
    return join(await checkedDirectory(dirname(this.path), true), basename(this.path))
  }
  async read(): Promise<unknown | null> {
    if (!this.cipher.isAvailable()) throw fail('STORAGE_UNAVAILABLE')
    const file = await boundedFile(await this.location(), MAX_VAULT_BYTES, true)
    this.known = file?.proof ?? null
    if (!file) return null
    try {
      const envelope = strictJson(decode(file.bytes))
      if (!record(envelope) || !exactKeys(envelope, ['schema', 'ciphertext']) || !(envelope.schema instanceof JsonNumber) || envelope.schema.source !== '1' || typeof envelope.ciphertext !== 'string') throw fail('STATE_INVALID')
      const encrypted = Buffer.from(envelope.ciphertext, 'base64')
      if (!encrypted.length || encrypted.toString('base64') !== envelope.ciphertext) throw fail('STATE_INVALID')
      let plain: string
      try { plain = this.cipher.decrypt(encrypted) } finally { encrypted.fill(0) }
      if (Buffer.byteLength(plain) > MAX_VAULT_BYTES) throw fail('STATE_INVALID')
      strictJson(plain)
      return JSON.parse(plain) as unknown
    } catch { throw fail('STATE_INVALID') }
  }
  async write(value: unknown): Promise<void> {
    if (!this.cipher.isAvailable()) throw fail('STORAGE_UNAVAILABLE')
    if (this.known === undefined) await this.read()
    const plain = JSON.stringify(value)
    if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_VAULT_BYTES / 2) throw fail('STATE_INVALID')
    strictJson(plain)
    const encrypted = this.cipher.encrypt(plain)
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_VAULT_BYTES / 2) throw fail('STORAGE_FAILED')
    const bytes = Buffer.from(JSON.stringify({ schema: 1, ciphertext: encrypted.toString('base64') })); encrypted.fill(0)
    const path = await this.location(), directory = dirname(path), parent = await lstat(directory), temporary = join(directory, `.enrollment-${randomUUID()}.tmp`)
    let created = false
    try {
      const output = await open(temporary, 'wx', 0o600); created = true
      let stagedProof: FileProof
      try { await output.writeFile(bytes); await output.sync(); stagedProof = proof(await output.stat(), bytes) } finally { await output.close() }
      const current = await boundedFile(path, MAX_VAULT_BYTES, true), staged = await boundedFile(temporary, MAX_VAULT_BYTES), after = await lstat(directory)
      if (!sameProof(this.known ?? null, current?.proof ?? null) || !sameProof(stagedProof, staged?.proof ?? null) || parent.dev !== after.dev || parent.ino !== after.ino || after.isSymbolicLink()
        || !samePath(await checkedDirectory(directory, false), directory)) throw fail('VAULT_CHANGED')
      await rename(temporary, path); created = false
      const saved = await boundedFile(path, MAX_VAULT_BYTES)
      if (!saved || saved.proof.hash !== stagedProof.hash) throw fail('STATE_INVALID')
      this.known = saved.proof
      const reread = await this.read()
      if (JSON.stringify(reread) !== plain) throw fail('STATE_INVALID')
    } finally { bytes.fill(0); if (created) await unlink(temporary).catch(() => undefined) }
  }
}

export class SteamAuthenticatorService {
  private tail: Promise<unknown> = Promise.resolve()
  private pending: { preview: SteamAuthenticatorImportPreview; candidate: ParsedAuthenticator; proof: FileProof | null; expires: number } | null = null
  private calibrated: { offsetMs: number; wall: number; monotonic: number } | null = null
  private syncFailed = false
  constructor(private readonly options: SteamAuthenticatorOptions) {}
  private now(): number { const now = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0 || now > 8_639_999_999_990_000) throw fail('TIME_INVALID'); return now }
  private monotonic(): number {
    const value = (this.options.monotonicNow ?? (() => performance.now()))()
    if (!Number.isFinite(value) || value < 0) throw fail('TIME_INVALID')
    return value
  }
  private available(): boolean { try { return this.options.cipher.isAvailable() === true } catch { return false } }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(action).catch(error => { if (error instanceof DomainError && error.code.startsWith('AUTHENTICATOR_')) throw error; throw fail('STORAGE_FAILED') })
    this.tail = task.catch(() => undefined); return task
  }
  private async vaultPath(): Promise<string> {
    checkedLocalPath(this.options.vaultPath)
    return join(await checkedDirectory(dirname(this.options.vaultPath), true), basename(this.options.vaultPath))
  }
  private async load(): Promise<{ path: string; entries: VaultEntry[]; proof: FileProof | null }> {
    if (!this.available()) throw fail('STORAGE_UNAVAILABLE')
    const path = await this.vaultPath(), file = await boundedFile(path, MAX_VAULT_BYTES, true)
    if (!file) return { path, entries: [], proof: null }
    try {
      const envelope = strictJson(decode(file.bytes))
      if (!record(envelope) || !exactKeys(envelope, ['schema', 'ciphertext']) || !(envelope.schema instanceof JsonNumber) || !['1', '2'].includes(envelope.schema.source)
        || typeof envelope.ciphertext !== 'string') throw fail('VAULT_INVALID')
      const encrypted = Buffer.from(envelope.ciphertext, 'base64')
      if (!encrypted.length || encrypted.toString('base64') !== envelope.ciphertext) throw fail('VAULT_INVALID')
      let plain: string
      try { plain = this.options.cipher.decrypt(encrypted) } finally { encrypted.fill(0) }
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_VAULT_BYTES) throw fail('VAULT_INVALID')
      const vault = strictJson(plain)
      if (!record(vault) || !exactKeys(vault, ['schema', 'entries']) || !(vault.schema instanceof JsonNumber) || vault.schema.source !== envelope.schema.source || !Array.isArray(vault.entries) || vault.entries.length > MAX_ENTRIES) throw fail('VAULT_INVALID')
      const entries: VaultEntry[] = []
      for (const value of vault.entries) {
        const keys = record(value) && Object.hasOwn(value, 'backup') && vault.schema.source === '2' ? ['id', 'name', 'steamId', 'sharedSecret', 'backup'] : ['id', 'name', 'steamId', 'sharedSecret']
        if (!record(value) || !exactKeys(value, keys) || typeof value.id !== 'string' || !ID.test(value.id)
          || typeof value.name !== 'string' || !ACCOUNT_NAME.test(value.name) || value.steamId !== null && steamId(value.steamId) !== value.steamId
          || typeof value.sharedSecret !== 'string' || entries.some(entry => entry.id === value.id)) throw fail('VAULT_INVALID')
        const entry: VaultEntry = { id: value.id, name: value.name, steamId: value.steamId as string | null, sharedSecret: value.sharedSecret,
          ...(Object.hasOwn(value, 'backup') ? { backup: checkedBackup(value.backup) } : {}) }
        const key = secretBytes(entry.sharedSecret); key.fill(0)
        if (duplicates(entries, entry)) throw fail('VAULT_INVALID')
        entries.push(entry)
      }
      return { path, entries, proof: file.proof }
    } catch { throw fail('VAULT_INVALID') }
  }
  private async save(current: Awaited<ReturnType<SteamAuthenticatorService['load']>>, entries: VaultEntry[]): Promise<void> {
    const encrypted = this.options.cipher.encrypt(JSON.stringify({ schema: 2, entries }))
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_VAULT_BYTES / 2) throw fail('STORAGE_FAILED')
    const bytes = Buffer.from(JSON.stringify({ schema: 2, ciphertext: encrypted.toString('base64') })); encrypted.fill(0)
    const directory = dirname(current.path), before = await lstat(directory), temporary = join(directory, `.authenticator-${randomUUID()}.tmp`)
    let created = false
    let temporaryProof: FileProof | undefined
    try {
      const output = await open(temporary, 'wx', 0o600); created = true
      try { await output.writeFile(bytes); await output.sync(); temporaryProof = proof(await output.stat(), bytes) } finally { await output.close() }
      const latest = await boundedFile(current.path, MAX_VAULT_BYTES, true)
      const staged = await boundedFile(temporary, MAX_VAULT_BYTES)
      const after = await lstat(directory)
      if (!temporaryProof || !sameProof(temporaryProof, staged?.proof ?? null) || !sameProof(current.proof, latest?.proof ?? null) || before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()
        || !samePath(await checkedDirectory(directory, false), directory)) throw fail('VAULT_CHANGED')
      await rename(temporary, current.path); created = false
    } finally { bytes.fill(0); if (created) await unlink(temporary).catch(() => undefined) }
  }
  private async snapshot(): Promise<SteamAuthenticatorSnapshot> {
    const available = this.available()
    const entries = available ? (await this.load()).entries : []
    const now = this.now(), monotonic = this.monotonic()
    if (this.pending && now > this.pending.expires) this.pending = null
    if (this.calibrated && (monotonic - this.calibrated.monotonic < 0 || monotonic - this.calibrated.monotonic > 30 * 60 * 1000
      || Math.abs((now - this.calibrated.wall) - (monotonic - this.calibrated.monotonic)) > 5000)) this.calibrated = null
    const timeSource = this.calibrated ? 'steam' : 'local'
    const common = { secretStorageAvailable: available, timeSource, clockWarning: this.calibrated ? null : this.syncFailed ? 'steam-time-unavailable' : 'local-clock' } as const
    if (!common.secretStorageAvailable) return { ...common, entries: [] }
    const effective = now + (this.calibrated?.offsetMs ?? 0)
    const expiresAt = Math.ceil(now + (Math.floor(effective / 30000) + 1) * 30000 - effective)
    return { ...common, entries: entries.map(entry => ({ id: entry.id, name: entry.name, steamId: entry.steamId,
      code: generateSteamGuardCode(entry.sharedSecret, Math.floor(effective / 1000)), expiresAt, timeSource, capabilities: capabilities(entry) })) }
  }
  state(): Promise<SteamAuthenticatorSnapshot> { return this.serial(() => this.snapshot()) }
  prepareImport(filePath: string, options: SteamAuthenticatorImportOptions = {}): Promise<SteamAuthenticatorImportPreview> {
    return this.serial(async () => {
      this.pending = null
      checkedLocalPath(filePath)
      if (!/\.mafile$/i.test(filePath)) throw fail('PATH_INVALID')
      const directory = await checkedDirectory(dirname(filePath), false)
      const current = await this.load(), file = await boundedFile(join(directory, basename(filePath)), MAX_MAFILE_BYTES)
      if (!file) throw fail('FILE_UNAVAILABLE')
      let candidate: ParsedAuthenticator
      try { candidate = parseSdaMaFile(decode(file.bytes), options) } finally { file.bytes.fill(0) }
      const existing = duplicates(current.entries, candidate)
      if (!existing && current.entries.length >= MAX_ENTRIES) throw fail('VAULT_FULL')
      const preview = { id: randomUUID(), name: candidate.name, steamId: candidate.steamId ?? existing?.steamId ?? null, replacesId: existing?.id ?? null }
      candidate.steamId = preview.steamId
      this.pending = { preview, candidate, proof: current.proof, expires: this.now() + 5 * 60 * 1000 }
      return { ...preview }
    })
  }
  confirmImport(input: { id: string; replace: boolean }): Promise<SteamAuthenticatorSnapshot> {
    return this.serial(async () => {
      const pending = this.pending; this.pending = null
      if (!input || !ID.test(input.id) || typeof input.replace !== 'boolean' || !pending || pending.preview.id !== input.id || this.now() > pending.expires) throw fail('IMPORT_EXPIRED')
      const current = await this.load()
      if (!sameProof(current.proof, pending.proof)) throw fail('VAULT_CHANGED')
      const existing = duplicates(current.entries, pending.candidate)
      if ((existing?.id ?? null) !== pending.preview.replacesId) throw fail('VAULT_CHANGED')
      if (existing && !input.replace) throw fail('REPLACE_REQUIRED')
      const entries = current.entries.filter(entry => entry.id !== existing?.id)
      entries.push({ id: existing?.id ?? randomUUID(), ...pending.candidate })
      await this.save(current, entries)
      return this.snapshot()
    })
  }
  cancelImport(id: string): void { if (this.pending?.preview.id === id) this.pending = null }
  private entry(entries: VaultEntry[], id: string): VaultEntry {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('ENTRY_NOT_FOUND')
    const entry = entries.find(value => value.id === id)
    if (!entry) throw fail('ENTRY_NOT_FOUND')
    return entry
  }
  // Main-process only: never expose this result through shared DTOs, IPC or diagnostics.
  confirmationMaterial(id: string): Promise<{ steamId: string; name: string; identitySecret: string; deviceId: string }> {
    return this.serial(async () => {
      const entry = this.entry((await this.load()).entries, id)
      if (!capabilities(entry).hasConfirmations) throw fail('CONFIRMATIONS_UNAVAILABLE')
      return { steamId: entry.steamId!, name: entry.name, identitySecret: entry.backup!.identitySecret!, deviceId: entry.backup!.deviceId! }
    })
  }
  recoveryMaterial(id: string): Promise<{ name: string; steamId: string | null; revocationCode: string }> {
    return this.serial(async () => {
      const entry = this.entry((await this.load()).entries, id)
      if (!entry.backup?.revocationCode) throw fail('RECOVERY_NOT_AVAILABLE')
      return { name: entry.name, steamId: entry.steamId, revocationCode: entry.backup.revocationCode }
    })
  }
  saveEnrolled(material: SteamAuthenticatorEnrolledMaterial, options: { replaceId?: string } = {}): Promise<{ id: string }> {
    return this.serial(async () => {
      if (!material || material.fullyEnrolled !== true) throw fail('BACKUP_INVALID')
      const candidate = parseSdaMaFile(JSON.stringify({ account_name: material.name, SteamID: material.steamId, shared_secret: material.sharedSecret,
        identity_secret: material.identitySecret, device_id: material.deviceId, revocation_code: material.revocationCode, fully_enrolled: true,
        serial_number: material.serialNumber, token_gid: material.tokenGid, secret_1: material.secret1 }), { retainSdaBackup: true })
      if (!capabilities(candidate).hasConfirmations || !candidate.backup?.revocationCode) throw fail('BACKUP_INVALID')
      const current = await this.load(), existing = duplicates(current.entries, candidate)
      if (existing && JSON.stringify({ name: existing.name, steamId: existing.steamId, sharedSecret: existing.sharedSecret, backup: existing.backup }) === JSON.stringify(candidate)) return { id: existing.id }
      if (existing && options.replaceId !== existing.id) throw fail('REPLACE_REQUIRED')
      if (!existing && options.replaceId !== undefined) throw fail('VAULT_CHANGED')
      if (!existing && current.entries.length >= MAX_ENTRIES) throw fail('VAULT_FULL')
      const id = existing?.id ?? randomUUID()
      await this.save(current, [...current.entries.filter(entry => entry.id !== existing?.id), { id, ...candidate }])
      return { id }
    })
  }
  exportTo(id: string, destination: string): Promise<{ kind: 'codes-only' | 'sda-backup' }> {
    return this.serial(async () => {
      const current = await this.load(), entry = this.entry(current.entries, id)
      const result = await this.exportMaterial(entry, destination, current.path)
      return { kind: result.kind }
    })
  }
  // Enrollment-only export. It does not make a pending authenticator an enrolled vault entry.
  exportPendingMaterialTo(material: Omit<SteamAuthenticatorEnrolledMaterial, 'fullyEnrolled'> & { fullyEnrolled: false }, destination: string): Promise<{ path: string; sha256: string }> {
    return this.serial(async () => {
      if (!this.available()) throw fail('STORAGE_UNAVAILABLE')
      if (!material || material.fullyEnrolled !== false) throw fail('BACKUP_INVALID')
      const entry = parseSdaMaFile(JSON.stringify({ account_name: material.name, SteamID: material.steamId, shared_secret: material.sharedSecret,
        identity_secret: material.identitySecret, device_id: material.deviceId, revocation_code: material.revocationCode, fully_enrolled: false,
        serial_number: material.serialNumber, token_gid: material.tokenGid, secret_1: material.secret1 }), { retainSdaBackup: true })
      if (!entry.steamId || !entry.backup?.identitySecret || !entry.backup.deviceId || !entry.backup.revocationCode) throw fail('BACKUP_INVALID')
      const result = await this.exportMaterial(entry, destination, await this.vaultPath())
      return { path: result.path, sha256: result.sha256 }
    })
  }
  private async exportMaterial(entry: ParsedAuthenticator, destination: string, protectedPath: string): Promise<{ kind: 'codes-only' | 'sda-backup'; path: string; sha256: string }> {
      const exported: Record<string, unknown> = { account_name: entry.name, shared_secret: entry.sharedSecret }
      if (entry.steamId) exported.Session = { SteamID: entry.steamId }
      if (entry.backup) for (const [field, key] of Object.entries(BACKUP_FIELDS)) {
        const value = entry.backup[key as keyof SdaBackup]
        if (value !== undefined) exported[field] = value
      }
      return this.exportJsonValue(exported, destination, protectedPath, 'mafile', entry.backup ? 'sda-backup' : 'codes-only')
  }
  exportIsolatedRescueTo(material: EnrollmentIssuedMaterialRescue, destination: string): Promise<{ path: string; sha256: string }> {
    return this.serial(async () => {
      if (!this.available()) throw fail('STORAGE_UNAVAILABLE')
      const allowed = ['kind', 'expectedSteamId', 'receivedSteamId', 'name', 'deviceId', 'reason', 'sharedSecret', 'identitySecret', 'revocationCode', 'tokenGid', 'serialNumber', 'secret1']
      if (!material || Object.keys(material).some(key => !allowed.includes(key)) || material.kind !== 'rescue' || !ACCOUNT_NAME.test(material.name)
        || !['owner-mismatch', 'required-material-invalid', 'status-uncertain'].includes(material.reason)) throw fail('BACKUP_INVALID')
      steamId(material.expectedSteamId)
      if (material.receivedSteamId !== undefined) steamId(material.receivedSteamId)
      if (!/^android:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(material.deviceId)) throw fail('BACKUP_INVALID')
      const issued: Record<string, string> = {}
      for (const key of ['sharedSecret', 'identitySecret', 'revocationCode', 'tokenGid', 'serialNumber', 'secret1'] as const) {
        const value = material[key]
        if (value !== undefined) {
          if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[^\x21-\x7e]/.test(value)) throw fail('BACKUP_INVALID')
          issued[key] = value
        }
      }
      const result = await this.exportJsonValue({ format: 'xiaolan-steam-enrollment-isolated-rescue-v1', notAnAuthenticator: true,
        expectedSteamId: material.expectedSteamId, receivedSteamId: material.receivedSteamId ?? null, name: material.name, deviceId: material.deviceId,
        reason: material.reason, issued }, destination, await this.vaultPath(), 'json', 'sda-backup')
      return { path: result.path, sha256: result.sha256 }
    })
  }
  private async exportJsonValue(exported: Record<string, unknown>, destination: string, protectedPath: string, extension: 'mafile' | 'json', kind: 'codes-only' | 'sda-backup'): Promise<{ kind: 'codes-only' | 'sda-backup'; path: string; sha256: string }> {
      checkedLocalPath(destination)
      if (!new RegExp(`\\.${extension}$`, 'i').test(destination)) throw fail('PATH_INVALID')
      const directory = await checkedDirectory(dirname(destination), false), target = join(directory, basename(destination))
      if (samePath(target, protectedPath)) throw fail('PATH_INVALID')
      const absent = async (): Promise<void> => {
        try { await lstat(target) } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
          throw fail('EXPORT_FAILED')
        }
        throw fail('EXPORT_EXISTS')
      }
      await absent()
      const bytes = Buffer.from(JSON.stringify(exported, null, 2) + '\n')
      if (bytes.length > MAX_MAFILE_BYTES) { bytes.fill(0); throw fail('EXPORT_FAILED') }
      const before = await lstat(directory), temporary = join(directory, `.authenticator-export-${randomUUID()}.tmp`)
      let created = false
      try {
        const output = await open(temporary, 'wx', 0o600); created = true
        let expected: FileProof
        try { await output.writeFile(bytes); await output.sync(); expected = proof(await output.stat(), bytes) }
        finally { await output.close() }
        const staged = await boundedFile(temporary, MAX_MAFILE_BYTES), after = await lstat(directory)
        if (!sameProof(expected, staged?.proof ?? null) || before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()
          || !samePath(await checkedDirectory(directory, false), directory)) throw fail('EXPORT_CHANGED')
        await absent()
        // A same-directory hardlink publishes the complete file atomically and fails if target exists.
        // Never fall back to rename/copy overwrite on a filesystem without this capability.
        try { await link(temporary, target) } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw fail('EXPORT_EXISTS')
          throw fail('EXPORT_FAILED')
        }
        await unlink(temporary); created = false
        const published = await boundedFile(target, MAX_MAFILE_BYTES)
        if (!sameProof(expected, published?.proof ?? null)) throw fail('EXPORT_CHANGED')
        return { kind, path: target, sha256: expected.hash }
      } finally { bytes.fill(0); if (created) await unlink(temporary).catch(() => undefined) }
  }
  remove(input: { id: string } | string): Promise<SteamAuthenticatorSnapshot> {
    return this.serial(async () => {
      const id = typeof input === 'string' ? input : input?.id
      if (typeof id !== 'string' || !ID.test(id)) throw fail('ENTRY_NOT_FOUND')
      const current = await this.load()
      if (!current.entries.some(entry => entry.id === id)) throw fail('ENTRY_NOT_FOUND')
      await this.save(current, current.entries.filter(entry => entry.id !== id))
      return this.snapshot()
    })
  }
  syncTime(): Promise<SteamAuthenticatorSnapshot> {
    return this.serial(async () => {
      const started = this.now(), controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const query = this.options.querySteamTime ?? (signal => queryAnonymousSteamTime(this.options.fetchImpl ?? fetch, signal))
        const seconds = await Promise.race([query(controller.signal), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(fail('TIME_UNAVAILABLE')) }, 8000); timer.unref?.()
        })])
        const ended = this.now()
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 8_639_999_999_990 || ended < started || ended - started > 8000) throw fail('TIME_INVALID')
        this.calibrated = { offsetMs: seconds * 1000 - (started + ended) / 2, wall: ended, monotonic: this.monotonic() }
        this.syncFailed = false
      } catch { this.calibrated = null; this.syncFailed = true }
      finally { clearTimeout(timer); controller.abort() }
      return this.snapshot()
    })
  }
}

export async function queryAnonymousSteamTime(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<number> {
  let response: Response
  try {
    response = await fetchImpl('https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', {
      method: 'POST', body: 'steamid=0', credentials: 'omit', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
  } catch { throw fail('TIME_UNAVAILABLE') }
  try {
    if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > 16384 || !response.body) throw fail('TIME_UNAVAILABLE')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 16384 || signal?.aborted) throw fail('TIME_UNAVAILABLE'); chunks.push(item.value) } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const result = strictJson(decode(Buffer.concat(chunks)))
    const time = record(result) && record(result.response) ? result.response.server_time : undefined
    const text = time instanceof JsonNumber ? time.source : time
    if (typeof text !== 'string' || !/^\d{1,13}$/.test(text) || !Number.isSafeInteger(Number(text))) throw fail('TIME_UNAVAILABLE')
    return Number(text)
  } catch { throw fail('TIME_UNAVAILABLE') }
  finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined) }
}
