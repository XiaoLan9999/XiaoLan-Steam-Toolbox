import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'

const CLIENT_HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const STEAM_ID_BASE = 76_561_197_960_265_728n
const samePath = (a: string, b: string): boolean => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const ticks = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{1,18}$/.test(value)
const individual = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > STEAM_ID_BASE && BigInt(value) <= STEAM_ID_BASE + 0xffffffffn
const unavailable = (): DomainError => new DomainError('SCREENSHOT_ACTIVE_USER_UNAVAILABLE', '无法可靠核实当前 Steam 账号，未写入截图；请保持 Steam 已登录后重试')
const execute = promisify(execFile)
const activeReads = new Set<ChildProcessWithoutNullStreams>()
let reading = false
let revision = 0

export interface ScreenshotActiveUser {
  steamPath: string
  steamExe: string
  steamPid: number
  steamStartTicks: string
  steamId: string
  clientSha256: string
}
export interface ScreenshotActiveProcess {
  steamExe: string; registryExe: string; steamPid: number; steamStartTicks: string; ownerPid: number; ownerStartTicks: string
}
type FileStat = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'dev' | 'ino' | 'size' | 'mtimeMs'>
export interface ScreenshotActiveUserDependencies {
  platform: NodeJS.Platform
  arch: string
  ownerPid: number
  inspect(): Promise<unknown>
  lstat(path: string): Promise<FileStat>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
  digest(bytes: Buffer): string
  spawn(worker: string, args: string[]): ChildProcessWithoutNullStreams
  timeoutMs: number
  exitTimeoutMs: number
}

async function inspectProcess(): Promise<unknown> {
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$registeredExe=Get-ItemPropertyValue -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -Name SteamExe
$all=@(Get-Process -Name steam -ErrorAction Stop)
if($all.Count -ne 1){throw 'Steam instance unavailable'}
$steam=$all[0]
$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$steam.Id) -Property ExecutablePath).ExecutablePath
if(!$image -or !$registeredExe){throw 'Steam executable unavailable'}
$owner=Get-Process -Id ${process.pid}
@{steamExe=$image;registryExe=[string]$registeredExe;steamPid=$steam.Id;steamStartTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();ownerPid=$owner.Id;ownerStartTicks=$owner.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress -Depth 3`
  const powershell = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 8000, maxBuffer: 32 * 1024, encoding: 'utf8', shell: false })
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as unknown
}

function checkedProcess(value: unknown, root: string, ownerPid: number): ScreenshotActiveProcess {
  const state = value as Partial<ScreenshotActiveProcess> | null
  if (!state || typeof state !== 'object' || typeof state.steamExe !== 'string' || typeof state.registryExe !== 'string' ||
    !pid(state.steamPid) || state.ownerPid !== ownerPid || state.steamPid === ownerPid || !ticks(state.steamStartTicks) || !ticks(state.ownerStartTicks) ||
    !samePath(state.steamExe, state.registryExe) || !samePath(win32.dirname(state.steamExe), root) || win32.basename(state.steamExe).toLowerCase() !== 'steam.exe') throw unavailable()
  return state as ScreenshotActiveProcess
}

function isX64Pe(bytes: Buffer): boolean {
  if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) return false
  const pe = bytes.readUInt32LE(60)
  return pe >= 64 && pe <= bytes.length - 26 && bytes.readUInt32LE(pe) === 0x4550 && bytes.readUInt16LE(pe + 4) === 0x8664 && bytes.readUInt16LE(pe + 24) === 0x20b
}

function readIdentity(worker: string, context: ScreenshotActiveProcess, dll: string, deps: ScreenshotActiveUserDependencies): Promise<string> {
  return new Promise((accept, decline) => {
    const child = deps.spawn(worker, ['--read-current-user', dll, CLIENT_HASH, String(context.steamPid), context.steamStartTicks, String(context.ownerPid), context.ownerStartTicks])
    activeReads.add(child)
    let text = '', stdoutBytes = 0, stderrBytes = 0, identity: string | undefined, cleanup = false, failed = false, settled = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (value?: string): void => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(exitTimer)
      if (value) accept(value); else decline(unavailable())
    }
    const fault = (): void => {
      if (failed || settled) return
      failed = true
      try { child.kill() } catch { /* Only the owned helper is targeted; an actual close remains necessary. */ }
      if (settled) return
      exitTimer = setTimeout(() => settle(), deps.exitTimeoutMs)
      exitTimer.unref?.()
    }
    const timer = setTimeout(fault, deps.timeoutMs); timer.unref?.()
    child.stdout.on('data', bytes => {
      if (failed || settled) return
      stdoutBytes += Buffer.byteLength(bytes)
      text += String(bytes)
      if (stdoutBytes > 32 * 1024) { fault(); return }
      let newline: number
      while ((newline = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, newline).replace(/\r$/, ''); text = text.slice(newline + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line) as Record<string, unknown>
          if (frame.v !== 1 || typeof frame.op !== 'string') throw new Error()
          if (frame.op === 'identity') {
            if (identity || cleanup || frame.protocol !== 1 || frame.readOnly !== true || !individual(frame.steamId) || frame.steamPid !== context.steamPid || frame.steamStartTicks !== context.steamStartTicks) throw new Error()
            identity = frame.steamId
          } else if (frame.op === 'lifecycle') {
            if (!identity || cleanup || frame.stage !== 'cleanup' || ['userReleased', 'pipeReleased', 'threadMemoryReleased', 'libraryReleased'].some(key => frame[key] !== true)) throw new Error()
            cleanup = true
          } else throw new Error()
        } catch { fault(); return }
      }
    })
    child.stderr.on('data', bytes => { stderrBytes += Buffer.byteLength(bytes); if (stderrBytes > 32 * 1024) fault() })
    child.stdin.on('error', fault)
    child.on('error', fault)
    child.on('close', (code: number | null) => {
      activeReads.delete(child)
      settle(!failed && code === 0 && !text.trim() && cleanup ? identity : undefined)
    })
    child.stdin.end()
  })
}

export function hasScreenshotIdentityWork(): boolean { return reading || activeReads.size > 0 }

export async function shutdownScreenshotIdentityReads(): Promise<void> {
  revision++
  await Promise.all([...activeReads].map(child => new Promise<void>((accept, decline) => {
    const timer = setTimeout(() => { child.off('close', closed); decline(unavailable()) }, 4000)
    timer.unref?.()
    const closed = (): void => { clearTimeout(timer); accept() }
    child.once('close', closed)
    try { child.kill() } catch { /* No actual close means the helper remains in activeReads. */ }
  })))
}

export async function readScreenshotActiveUser(steamPath: string, workerPath: string,
  overrides: Partial<ScreenshotActiveUserDependencies> = {}): Promise<ScreenshotActiveUser> {
  if (reading || activeReads.size) throw unavailable()
  reading = true
  const generation = revision
  const deps: ScreenshotActiveUserDependencies = { platform: process.platform, arch: process.arch, ownerPid: process.pid,
    inspect: inspectProcess, lstat, realpath, readFile, digest: bytes => createHash('sha256').update(bytes).digest('hex'),
    spawn: (worker, args) => spawn(worker, args, { windowsHide: true, stdio: 'pipe', shell: false }), timeoutMs: 8000, exitTimeoutMs: 4000, ...overrides }
  try {
    if (deps.platform !== 'win32' || deps.arch !== 'x64' || !pid(deps.ownerPid) || typeof steamPath !== 'string' || !win32.isAbsolute(steamPath) || steamPath.startsWith('\\\\') || steamPath.includes('\0') ||
      typeof workerPath !== 'string' || !isAbsolute(workerPath) || workerPath.includes('\0')) throw unavailable()
    const root = win32.normalize(steamPath)
    const context = checkedProcess(await deps.inspect(), root, deps.ownerPid)
    const steamExe = win32.normalize(context.steamExe), dll = win32.join(root, 'steamclient64.dll'), worker = resolve(workerPath)
    for (const [path, directory] of [[root, true], [steamExe, false], [dll, false], [worker, false]] as const) {
      const info = await deps.lstat(path)
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || !samePath(await deps.realpath(path), path)) throw unavailable()
    }
    const before = await deps.lstat(dll)
    if (before.size < 256 || before.size > 128 * 1024 * 1024) throw unavailable()
    const bytes = await deps.readFile(dll), after = await deps.lstat(dll)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || !isX64Pe(bytes) || deps.digest(bytes) !== CLIENT_HASH) throw unavailable()
    const workerInfo = await deps.lstat(worker)
    if (workerInfo.size < 256 || workerInfo.size > 2 * 1024 * 1024) throw unavailable()
    const workerBytes = await deps.readFile(worker), currentWorker = await deps.lstat(worker)
    if (workerBytes.length !== workerInfo.size || workerInfo.dev !== currentWorker.dev || workerInfo.ino !== currentWorker.ino || workerInfo.mtimeMs !== currentWorker.mtimeMs || workerInfo.size !== currentWorker.size || !isX64Pe(workerBytes)) throw unavailable()
    if (generation !== revision) throw unavailable()
    const steamId = await readIdentity(worker, context, dll, deps)
    const current = checkedProcess(await deps.inspect(), root, deps.ownerPid)
    if (generation !== revision || current.steamPid !== context.steamPid || current.steamStartTicks !== context.steamStartTicks || !samePath(current.steamExe, steamExe) || current.ownerStartTicks !== context.ownerStartTicks) throw unavailable()
    return { steamPath: root, steamExe, steamPid: context.steamPid, steamStartTicks: context.steamStartTicks, steamId, clientSha256: CLIENT_HASH }
  } catch { throw unavailable() }
  finally { reading = false }
}
