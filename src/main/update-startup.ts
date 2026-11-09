import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath, rename, type FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { UpdatePackageKind } from '../shared/update-types'
import { validateVersion } from './update-security'

export interface ConfirmUpdateStartupOptions {
  cacheDirectory: string
  currentVersion: string
  packageKind: UpdatePackageKind
  currentExecutable: string
  transactionId?: string
}

interface Transaction {
  schema: 1
  id: string
  kind: UpdatePackageKind
  version: string
  source: string
  expectedHash: string
  expectedSize: number
  target: string
  originalHash: string
  backup: string | null
  phase: 'prepared' | 'replaced' | 'setup-started'
}

interface HealthyReceipt {
  schema: 1
  id: string
  version: string
  kind: UpdatePackageKind
  target: string
  targetHash: string
}

interface PathEntry { path: string; stat: BigIntStats }
interface InputEntry extends PathEntry { canonical: string; file: boolean }
interface InputProof { path: string; entries: InputEntry[]; canonicalEntries: PathEntry[]; kind: 'file' | 'directory' }
interface FileProof { path: string; handle: FileHandle; entries: PathEntry[]; hash: string; size: number; bytes?: Buffer }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[a-f0-9]{64}$/
const TRANSACTION = /^([0-9a-f-]+)\.transaction\.json$/
const RECORD_LIMIT = 16 * 1024
const EXECUTABLE_LIMIT = 512 * 1024 * 1024
const RECEIPT_KEYS = ['schema', 'id', 'kind', 'version', 'source', 'expectedHash', 'expectedSize', 'target', 'originalHash', 'backup', 'phase']
const HEALTH_KEYS = ['schema', 'id', 'version', 'kind', 'target', 'targetHash']
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const invalid = (): never => { throw new Error('update.startupUnconfirmed') }

function fullPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32767 || !isAbsolute(value) || /[\x00-\x1f]/.test(value)
    || value.startsWith('\\\\') || value.slice(parse(value).root.length).includes(':')
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')) return invalid()
  return resolve(value)
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function identityMatches(a: BigIntStats, b: BigIntStats, file: boolean): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs
    && (!file || a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)
}

async function inspectPath(path: string, kind: 'file' | 'directory'): Promise<PathEntry[]> {
  const root = parse(path).root
  const components = relative(root, path).split(sep).filter(Boolean)
  let current = root
  const entries: PathEntry[] = []
  for (let index = -1; index < components.length; index++) {
    if (index >= 0) current = join(current, components[index]!)
    const stat = await lstat(current, { bigint: true })
    const file = kind === 'file' && index === components.length - 1
    if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
      || !samePath(await realpath(current), current)) return invalid()
    entries.push({ path: current, stat })
  }
  return entries
}

async function checkEntries(entries: PathEntry[], kind: 'file' | 'directory'): Promise<void> {
  const current = await inspectPath(entries.at(-1)!.path, kind)
  if (current.length !== entries.length || current.some((entry, index) =>
    !samePath(entry.path, entries[index]!.path) || !identityMatches(entry.stat, entries[index]!.stat, kind === 'file' && index === current.length - 1))) return invalid()
}

async function canonicalInput(value: string, kind: 'file' | 'directory'): Promise<InputProof> {
  const path = fullPath(value), root = parse(path).root
  const components = relative(root, path).split(sep).filter(Boolean)
  let current = root
  const entries: InputEntry[] = []
  for (let index = -1; index < components.length; index++) {
    if (index >= 0) current = join(current, components[index]!)
    const file = kind === 'file' && index === components.length - 1
    const stat = await lstat(current, { bigint: true })
    if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) return invalid()
    const canonical = fullPath(await realpath(current))
    const actual = await lstat(canonical, { bigint: true })
    if (!samePath(parse(canonical).root, root) || actual.isSymbolicLink()
      || (file ? !actual.isFile() || actual.nlink !== 1n : !actual.isDirectory())
      || !identityMatches(stat, actual, file) || !samePath(current, canonical) && stat.ino === 0n) return invalid()
    entries.push({ path: current, canonical, file, stat })
  }
  const canonical = entries.at(-1)!.canonical
  return { path: canonical, entries, canonicalEntries: await inspectPath(canonical, kind), kind }
}

async function checkInput(proof: InputProof): Promise<void> {
  for (const entry of proof.entries) {
    const stat = await lstat(entry.path, { bigint: true })
    if (stat.isSymbolicLink() || (entry.file ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
      || !identityMatches(stat, entry.stat, entry.file) || !samePath(fullPath(await realpath(entry.path)), entry.canonical)) return invalid()
    const canonical = await lstat(entry.canonical, { bigint: true })
    if (canonical.isSymbolicLink() || !identityMatches(stat, canonical, entry.file)) return invalid()
  }
  await checkEntries(proof.canonicalEntries, proof.kind)
}

async function readProof(proof: FileProof, limit: number, collect: boolean): Promise<{ hash: string; size: number; bytes?: Buffer }> {
  const before = await proof.handle.stat({ bigint: true })
  if (!identityMatches(before, proof.entries.at(-1)!.stat, true) || !before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) return invalid()
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of proof.handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 })) {
    size += chunk.length
    if (size > limit) return invalid()
    hash.update(chunk)
    if (collect) chunks.push(chunk)
  }
  if (size !== Number(before.size) || !identityMatches(before, await proof.handle.stat({ bigint: true }), true)) return invalid()
  await checkEntries(proof.entries, 'file')
  return { hash: hash.digest('hex'), size, ...(collect ? { bytes: Buffer.concat(chunks, size) } : {}) }
}

async function proveFile(path: string, limit: number, proofs: FileProof[], executable = false): Promise<FileProof> {
  if (executable && extname(path).toLowerCase() !== '.exe') return invalid()
  const entries = await inspectPath(path, 'file')
  if (entries.at(-1)!.stat.size > BigInt(limit)) return invalid()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const proof: FileProof = { path, handle, entries, hash: '', size: 0 }
  proofs.push(proof)
  const result = await readProof(proof, limit, !executable)
  Object.assign(proof, result)
  if (executable) {
    const header = Buffer.alloc(2)
    const read = await handle.read(header, 0, 2, 0)
    if (read.bytesRead !== 2 || header.toString('ascii') !== 'MZ') return invalid()
  }
  return proof
}

// Receipts are flat primitive-only records; reject duplicate JSON keys instead of accepting the last one.
function flatRecord(bytes: Buffer, fields: readonly string[]): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let cursor = 0
  const whitespace = (): void => { while (/[ \t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor++ }
  const take = (value: string): void => { whitespace(); if (text[cursor++] !== value) invalid() }
  const string = (): string => {
    whitespace()
    const start = cursor
    if (text[cursor++] !== '"') return invalid()
    while (cursor < text.length) {
      const value = text[cursor++]
      if (value === '\\') { cursor++; continue }
      if (value === '"') return JSON.parse(text.slice(start, cursor)) as string
    }
    return invalid()
  }
  const result: Record<string, unknown> = Object.create(null)
  take('{'); whitespace()
  if (text[cursor] !== '}') for (;;) {
    const key = string()
    if (!fields.includes(key) || Object.hasOwn(result, key)) return invalid()
    take(':'); whitespace()
    if (text[cursor] === '"') result[key] = string()
    else {
      const value = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor))?.[0]
      if (!value) return invalid()
      cursor += value.length; result[key] = JSON.parse(value)
    }
    whitespace()
    if (text[cursor] !== ',') break
    cursor++
  }
  take('}'); whitespace()
  if (cursor !== text.length || Object.keys(result).length !== fields.length) return invalid()
  return result
}

function transaction(proof: FileProof): Transaction {
  const value = flatRecord(proof.bytes!, RECEIPT_KEYS)
  if (value.schema !== 1 || typeof value.id !== 'string' || !UUID.test(value.id)
    || !validateVersion(value.version) || !['portable', 'setup'].includes(value.kind as string)
    || typeof value.expectedHash !== 'string' || !HASH.test(value.expectedHash)
    || typeof value.originalHash !== 'string' || !HASH.test(value.originalHash)
    || !Number.isSafeInteger(value.expectedSize) || Number(value.expectedSize) < 2 || Number(value.expectedSize) > EXECUTABLE_LIMIT
    || !['prepared', 'replaced', 'setup-started'].includes(value.phase as string)) return invalid()
  fullPath(value.source); fullPath(value.target)
  if (value.backup !== null) fullPath(value.backup)
  return value as unknown as Transaction
}

async function findTransaction(options: ConfirmUpdateStartupOptions, directory: string, target: string,
  proofs: FileProof[]): Promise<{ value: Transaction; proof: FileProof } | undefined> {
  if (options.transactionId !== undefined) {
    if (!UUID.test(options.transactionId)) return undefined
    const proof = await proveFile(join(directory, `${options.transactionId}.transaction.json`), RECORD_LIMIT, proofs)
    const value = transaction(proof)
    return value.id === options.transactionId ? { value, proof } : undefined
  }
  if (options.packageKind !== 'setup') return undefined
  const candidates: Array<{ value: Transaction; proof: FileProof }> = []
  let total = 0, count = 0
  for await (const entry of await opendir(directory, { bufferSize: 32 })) {
    if (++total > 512) return invalid()
    const match = TRANSACTION.exec(entry.name)
    if (!match || !UUID.test(match[1]!)) continue
    if (++count > 32) return invalid()
    if (!entry.isFile() || entry.isSymbolicLink()) return invalid()
    try {
      const proof = await proveFile(join(directory, entry.name), RECORD_LIMIT, proofs)
      const value = transaction(proof)
      if (value.id !== match[1]) return invalid()
      if (value.kind === 'setup' && value.phase === 'setup-started' && value.version === options.currentVersion && samePath(fullPath(value.target), target)) candidates.push({ value, proof })
    } catch { /* A malformed unrelated historical receipt is not a matching update. */ }
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function healthy(value: Record<string, unknown>, expected: HealthyReceipt): boolean {
  return HEALTH_KEYS.every(key => value[key] === expected[key as keyof HealthyReceipt])
}

/** Confirmation means a valid health receipt was published, not that installer cleanup completed. */
export async function confirmUpdateStartup(options: ConfirmUpdateStartupOptions): Promise<{ confirmed: boolean }> {
  const proofs: FileProof[] = []
  let temporary: FileHandle | undefined
  try {
    if (!options || !validateVersion(options.currentVersion) || !['portable', 'setup'].includes(options.packageKind)
      || options.packageKind === 'portable' && options.transactionId === undefined
      || options.transactionId !== undefined && (typeof options.transactionId !== 'string' || !UUID.test(options.transactionId))) return { confirmed: false }
    const cacheInput = await canonicalInput(options.cacheDirectory, 'directory')
    const targetInput = await canonicalInput(options.currentExecutable, 'file')
    const cache = cacheInput.path, target = targetInput.path
    const installer = join(cache, 'installer')
    const cacheEntries = await inspectPath(cache, 'directory'), installerEntries = await inspectPath(installer, 'directory')
    if (samePath(target, installer) || contained(installer, target)) return { confirmed: false }
    const found = await findTransaction(options, installer, target, proofs)
    if (!found) return { confirmed: false }
    const { value, proof: receipt } = found
    const source = fullPath(value.source), recordedTarget = fullPath(value.target)
    const acknowledgment = join(installer, `${value.id}.healthy.json`)
    if (value.version !== options.currentVersion || value.kind !== options.packageKind || !samePath(recordedTarget, target)
      || value.phase !== (value.kind === 'portable' ? 'replaced' : 'setup-started') || !contained(cache, source)
      || contained(installer, source) || samePath(source, target) || samePath(source, receipt.path) || samePath(source, acknowledgment)) return { confirmed: false }
    if (value.kind === 'portable') {
      const backup = join(dirname(target), `${basename(target, extname(target))}.previous-${value.id.replaceAll('-', '')}.exe`)
      if (value.backup === null || !samePath(fullPath(value.backup), backup) || [source, target, receipt.path, acknowledgment].some(path => samePath(path, backup))) return { confirmed: false }
    } else if (value.backup !== null) return { confirmed: false }
    const sourceProof = await proveFile(source, EXECUTABLE_LIMIT, proofs, true)
    const targetProof = await proveFile(target, EXECUTABLE_LIMIT, proofs, true)
    if (sourceProof.size !== value.expectedSize || sourceProof.hash !== value.expectedHash
      || value.kind === 'portable' && targetProof.hash !== value.expectedHash) return { confirmed: false }
    const ack: HealthyReceipt = { schema: 1, id: value.id, version: value.version, kind: value.kind, target: recordedTarget, targetHash: targetProof.hash }
    for (const proof of [receipt, sourceProof, targetProof]) {
      const current = await readProof(proof, proof === receipt ? RECORD_LIMIT : EXECUTABLE_LIMIT, false)
      if (current.hash !== proof.hash || current.size !== proof.size) return { confirmed: false }
    }
    await checkInput(cacheInput); await checkInput(targetInput)
    await checkEntries(cacheEntries, 'directory'); await checkEntries(installerEntries, 'directory')
    try {
      const existing = await proveFile(acknowledgment, RECORD_LIMIT, proofs)
      await checkInput(cacheInput); await checkInput(targetInput)
      return { confirmed: healthy(flatRecord(existing.bytes!, HEALTH_KEYS), ack) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { confirmed: false }
    }
    const temporaryPath = join(installer, `${value.id}.healthy.json.${randomUUID()}.tmp`)
    const serialized = JSON.stringify(ack)
    temporary = await open(temporaryPath, 'wx', 0o600)
    await temporary.writeFile(serialized, 'utf8'); await temporary.sync()
    const temporaryEntries = await inspectPath(temporaryPath, 'file')
    if (!identityMatches(await temporary.stat({ bigint: true }), temporaryEntries.at(-1)!.stat, true)) return { confirmed: false }
    const temporaryProof = await proveFile(temporaryPath, RECORD_LIMIT, proofs)
    if (temporaryProof.hash !== createHash('sha256').update(serialized).digest('hex')) return { confirmed: false }
    await checkEntries(cacheEntries, 'directory'); await checkEntries(installerEntries, 'directory')
    for (const proof of [receipt, sourceProof, targetProof]) await checkEntries(proof.entries, 'file')
    await checkInput(cacheInput); await checkInput(targetInput)
    await temporary.close(); temporary = undefined
    await checkEntries(temporaryEntries, 'file')
    await checkEntries(temporaryProof.entries, 'file')
    try { await lstat(acknowledgment); return { confirmed: false } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { confirmed: false } }
    await rename(temporaryPath, acknowledgment)
    try {
      const written = await proveFile(acknowledgment, RECORD_LIMIT, proofs)
      if (written.hash !== temporaryProof.hash || !healthy(flatRecord(written.bytes!, HEALTH_KEYS), ack)) return { confirmed: false }
    } catch (error) {
      // The installer may consume its source, transaction and health receipt immediately after publication.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { await lstat(acknowledgment); return { confirmed: false } }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') return { confirmed: false } }
      }
    }
    await checkEntries(cacheEntries, 'directory'); await checkEntries(installerEntries, 'directory')
    await checkInput(cacheInput); await checkInput(targetInput)
    const currentTarget = await readProof(targetProof, EXECUTABLE_LIMIT, false)
    return { confirmed: currentTarget.hash === targetProof.hash && currentTarget.size === targetProof.size }
  } catch { return { confirmed: false } }
  finally {
    if (temporary) await temporary.close().catch(() => undefined)
    await Promise.all(proofs.map(proof => proof.handle.close().catch(() => undefined)))
  }
}
