import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sanitizeDiagnosticRecord, sanitizeDiagnosticVersion, type DiagnosticRecord } from '../shared/diagnostics'

export const MAX_DIAGNOSTIC_FILE_BYTES = 1_048_576
export const MAX_DIAGNOSTIC_RECORDS = 5_000
const MAX_DIAGNOSTIC_LINE_BYTES = 16_384
const logNames = ['runtime-previous.jsonl', 'runtime-current.jsonl'] as const

export interface DiagnosticReportOptions {
  userDataDirectory: string
  diagnosticsDirectory: string
  appVersion: string
  electronVersion?: string
  nodeVersion?: string
  chromiumVersion?: string
  now?: () => Date
}

export interface DiagnosticReport {
  schemaVersion: 1
  generatedAt: string
  application: { version: string }
  runtime: { electron: string; node: string; chromium: string }
  system: { platform: string; architecture: string; release: string }
  records: DiagnosticRecord[]
}

export interface DiagnosticReportSummary {
  path: string
  records: number
}

export class DiagnosticReportError extends Error {
  constructor(readonly code: 'UNSAFE_PATH' | 'DESTINATION_EXISTS' | 'READ_FAILED' | 'WRITE_FAILED') {
    super({ UNSAFE_PATH: 'Unsafe diagnostic report path', DESTINATION_EXISTS: 'Diagnostic report destination already exists',
      READ_FAILED: 'Could not read diagnostic records', WRITE_FAILED: 'Could not write diagnostic report' }[code])
    this.name = 'DiagnosticReportError'
  }
}

const failure = (code: DiagnosticReportError['code']): DiagnosticReportError => new DiagnosticReportError(code)
const errorCode = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
export function sameDiagnosticFileIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function containedBy(directory: string, file: string): boolean {
  const difference = relative(directory, file)
  return difference === '' || difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

async function safeDirectory(directory: string): Promise<{ path: string; info: BigIntStats }> {
  if (!isAbsolute(directory)) throw failure('UNSAFE_PATH')
  const absolute = resolve(directory)
  const info = await lstat(absolute, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw failure('UNSAFE_PATH')
  return { path: absolute, info }
}

async function readDiagnosticFile(directory: string, name: typeof logNames[number], retry = true): Promise<DiagnosticRecord[]> {
  const file = join(directory, name)
  try {
    await safeDirectory(directory)
    const before = await lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await realpath(file), file)) throw failure('UNSAFE_PATH')
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.nlink > 1n) throw failure('UNSAFE_PATH')
      if (opened.nlink === 0n || !sameDiagnosticFileIdentity(before, opened)) return retry ? readDiagnosticFile(directory, name, false) : []
      await safeDirectory(directory)
      if (!samePath(await realpath(file), file)) throw failure('UNSAFE_PATH')
      if (opened.size < 0n || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('READ_FAILED')
      const size = Number(opened.size)
      const start = Math.max(0, size - MAX_DIAGNOSTIC_FILE_BYTES)
      const buffer = Buffer.alloc(Math.min(size, MAX_DIAGNOSTIC_FILE_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const contents = buffer.subarray(0, bytesRead).toString('utf8')
      const first = start > 0 ? contents.indexOf('\n') + 1 : 0
      const last = contents.lastIndexOf('\n')
      if (last < first) return []
      const records: DiagnosticRecord[] = []
      for (const line of contents.slice(first, last).split('\n')) {
        if (!line || Buffer.byteLength(line) > MAX_DIAGNOSTIC_LINE_BYTES) continue
        try {
          const record = sanitizeDiagnosticRecord(JSON.parse(line))
          if (record) records.push(record)
        } catch {
          // Partial writes and historical malformed lines are intentionally discarded.
        }
      }
      return records.slice(-MAX_DIAGNOSTIC_RECORDS)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    if (error instanceof DiagnosticReportError) throw error
    throw failure('READ_FAILED')
  }
}

function reportMetadata(options: DiagnosticReportOptions, records: DiagnosticRecord[]): DiagnosticReport {
  const operatingSystemRelease = /^\d{1,6}(?:\.\d{1,6}){0,3}/.exec(release())?.[0] ?? 'unknown'
  const runtimeVersion = (value: unknown): string => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){2,3}$/.test(value) ? value : 'unknown'
  return { schemaVersion: 1, generatedAt: (options.now?.() ?? new Date()).toISOString(),
    application: { version: sanitizeDiagnosticVersion(options.appVersion) ?? 'unknown' },
    runtime: { electron: runtimeVersion(options.electronVersion ?? process.versions.electron),
      node: runtimeVersion(options.nodeVersion ?? process.versions.node),
      chromium: runtimeVersion(options.chromiumVersion ?? process.versions.chrome) },
    system: { platform: ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'].includes(platform()) ? platform() : 'unknown',
      architecture: ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'].includes(arch()) ? arch() : 'unknown',
      release: operatingSystemRelease }, records }
}

async function validateDestination(destination: string, userData: string): Promise<{ path: string; parent: BigIntStats }> {
  if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.json' ||
      /[<>:"|?*\x00-\x1f]/.test(basename(destination)) || /[. ]$/.test(basename(destination)) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename(destination))) throw failure('UNSAFE_PATH')
  const absolute = resolve(destination)
  if (containedBy(userData, absolute)) throw failure('UNSAFE_PATH')
  const parent = await safeDirectory(dirname(absolute))
  if (containedBy(userData, join(parent.path, basename(absolute)))) throw failure('UNSAFE_PATH')
  try {
    await lstat(absolute)
    throw failure('DESTINATION_EXISTS')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  return { path: absolute, parent: parent.info }
}

export async function writeDiagnosticReport(destination: string, options: DiagnosticReportOptions): Promise<DiagnosticReportSummary> {
  let target: { path: string; parent: BigIntStats }
  let contents: string
  let recordCount: number
  try {
    const userData = await safeDirectory(options.userDataDirectory)
    target = await validateDestination(destination, userData.path)
    if (!isAbsolute(options.diagnosticsDirectory) || !containedBy(userData.path, resolve(options.diagnosticsDirectory))) throw failure('UNSAFE_PATH')
    const previous = await readDiagnosticFile(options.diagnosticsDirectory, logNames[0])
    const current = await readDiagnosticFile(options.diagnosticsDirectory, logNames[1])
    const records = [...previous, ...current].slice(-MAX_DIAGNOSTIC_RECORDS)
    recordCount = records.length
    contents = JSON.stringify(reportMetadata(options, records), null, 2) + '\n'
  } catch (error) {
    if (error instanceof DiagnosticReportError) throw error
    throw failure('UNSAFE_PATH')
  }

  let created: BigIntStats | undefined
  try {
    const parent = await safeDirectory(dirname(target.path))
    if (!sameDiagnosticFileIdentity(parent.info, target.parent)) throw failure('UNSAFE_PATH')
    const handle = await open(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      created = await handle.stat({ bigint: true })
      const named = await lstat(target.path, { bigint: true })
      const after = await safeDirectory(dirname(target.path))
      if (!created.isFile() || created.nlink !== 1n || named.isSymbolicLink() || !sameDiagnosticFileIdentity(named, created) ||
          !sameDiagnosticFileIdentity(after.info, target.parent) || !samePath(await realpath(target.path), target.path)) throw failure('UNSAFE_PATH')
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { path: target.path, records: recordCount }
  } catch (error) {
    if (created) {
      try {
        const parent = await safeDirectory(dirname(target.path))
        const current = await lstat(target.path, { bigint: true })
        if (sameDiagnosticFileIdentity(parent.info, target.parent) && current.isFile() && !current.isSymbolicLink() && sameDiagnosticFileIdentity(current, created)) await unlink(target.path)
      } catch {}
    }
    if (error instanceof DiagnosticReportError) throw error
    throw failure(errorCode(error) === 'EEXIST' ? 'DESTINATION_EXISTS' : 'WRITE_FAILED')
  }
}
