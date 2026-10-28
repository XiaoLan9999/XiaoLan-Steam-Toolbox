import { execFile, spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'

const CLIENT_HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const STEAM_ID_BASE = 76_561_197_960_265_728n
const MAX_FRAME = 16 * 1024
const MAX_NOISE = 64 * 1024
const noop = (): void => {}
const executeFile = promisify(execFile)
const unavailable = (): DomainError => new DomainError('SCREENSHOT_LIVE_UNAVAILABLE', '当前 Steam 无法安全使用免重启截图接口，可改用退出后导入')
const stoppedError = (): DomainError => new DomainError('SCREENSHOT_LIVE_STOP_FAILED', '尚未确认截图辅助进程已退出，已停止后续导入')
const samePath = (a: string, b: string): boolean => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const ticks = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{1,18}$/.test(value)
const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
const individual = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > STEAM_ID_BASE && BigInt(value) <= STEAM_ID_BASE + 0xffffffffn

export interface ScreenshotApiContext {
  steamExe: string
  clientDll: string
  clientSha256: string
  steamPid: number
  steamStartTicks: string
  steamId: string
  appId: number
  ownerPid: number
  ownerStartTicks: string
}

type FileStat = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'dev' | 'ino' | 'size' | 'mtimeMs'>
export interface ScreenshotApiDiscoveryDependencies {
  platform: NodeJS.Platform
  arch: string
  ownerPid: number
  execute(command: string, args: string[], options: { windowsHide: boolean; timeout: number; maxBuffer: number; encoding: 'utf8'; shell: false }): Promise<{ stdout: string }>
  lstat(path: string): Promise<FileStat>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
  digest(bytes: Buffer): string
}

export async function discoverScreenshotApiContext(steamPath: string, userId: string, requestedAppId: string | number,
  overrides: Partial<ScreenshotApiDiscoveryDependencies> = {}): Promise<ScreenshotApiContext> {
  const deps: ScreenshotApiDiscoveryDependencies = { platform: process.platform, arch: process.arch, ownerPid: process.pid,
    execute: async (command, args, options) => ({ stdout: (await executeFile(command, args, options)).stdout }),
    lstat, realpath, readFile, digest: bytes => createHash('sha256').update(bytes).digest('hex'), ...overrides }
  try {
    const appText = String(requestedAppId)
    if (deps.platform !== 'win32' || deps.arch !== 'x64' || !pid(deps.ownerPid) || typeof steamPath !== 'string' ||
      !win32.isAbsolute(steamPath) || steamPath.startsWith('\\\\') || steamPath.includes('\0') ||
      typeof userId !== 'string' || !/^[1-9]\d{0,9}$/.test(userId) || BigInt(userId) > 0xffffffffn ||
      !/^[1-9]\d{0,7}$/.test(appText) || Number(appText) > 0xffffff || Number(appText) === 480) throw unavailable()
    const root = win32.normalize(steamPath)
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$config=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam'
$all=@(Get-Process -Name steam -ErrorAction Stop)
if($all.Count -ne 1){throw 'Steam instance unavailable'}
$steam=$all[0]
$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$steam.Id)).ExecutablePath
if(!$image -or !$config.SteamExe){throw 'Steam executable unavailable'}
$owner=Get-Process -Id ${deps.ownerPid}
$runningAppId=0
if($null -ne $config.RunningAppID){$runningAppId=[long]$config.RunningAppID}
$apps='HKCU:\\Software\\Valve\\Steam\\Apps'
$keys=@(if(Test-Path -LiteralPath $apps){Get-ChildItem -LiteralPath $apps -ErrorAction Stop})
if($keys.Count -gt 4096){throw 'Steam activity unavailable'}
$running=@(foreach($key in $keys){$item=Get-ItemProperty -LiteralPath $key.PSPath;if($null -ne $item.Running -and [long]$item.Running -ne 0){if($key.PSChildName -notmatch '^[0-9]+$'){throw 'Steam activity unavailable'};[long]$key.PSChildName}})
@{steamExe=$image;registryExe=[string]$config.SteamExe;steamPid=$steam.Id;steamStartTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();ownerPid=$owner.Id;ownerStartTicks=$owner.StartTime.ToUniversalTime().Ticks.ToString();runningAppId=$runningAppId;runningAppIds=@($running)}|ConvertTo-Json -Compress -Depth 4`
    const powershell = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await deps.execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024, encoding: 'utf8', shell: false })
    const state: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    if (!object(state) || typeof state.steamExe !== 'string' || typeof state.registryExe !== 'string' || !pid(state.steamPid) ||
      state.ownerPid !== deps.ownerPid || state.steamPid === deps.ownerPid || !ticks(state.steamStartTicks) || !ticks(state.ownerStartTicks) ||
      state.runningAppId !== 0 || !Array.isArray(state.runningAppIds) || state.runningAppIds.length > 4096 ||
      state.runningAppIds.some(id => id !== 0) || !samePath(state.steamExe, state.registryExe) ||
      !samePath(win32.dirname(state.steamExe), root) || win32.basename(state.steamExe).toLowerCase() !== 'steam.exe') throw unavailable()
    const steamExe = win32.normalize(state.steamExe)
    const clientDll = win32.join(root, 'steamclient64.dll')
    for (const [path, directory] of [[root, true], [steamExe, false], [clientDll, false]] as const) {
      const file = await deps.lstat(path)
      if (file.isSymbolicLink() || (directory ? !file.isDirectory() : !file.isFile()) || !samePath(await deps.realpath(path), path)) throw unavailable()
    }
    const before = await deps.lstat(clientDll)
    if (before.size < 256 || before.size > 128 * 1024 * 1024) throw unavailable()
    const bytes = await deps.readFile(clientDll)
    const after = await deps.lstat(clientDll)
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d || pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550 ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b || deps.digest(bytes) !== CLIENT_HASH) throw unavailable()
    return { steamExe, clientDll, clientSha256: CLIENT_HASH, steamPid: state.steamPid, steamStartTicks: state.steamStartTicks,
      steamId: String(STEAM_ID_BASE + BigInt(userId)), appId: Number(appText), ownerPid: deps.ownerPid, ownerStartTicks: state.ownerStartTicks }
  } catch { throw unavailable() }
}

export interface ScreenshotApiImage { path: string; width: number; height: number; sha256: string }
export interface ScreenshotApiOutcome { status: 'confirmed' | 'rejected' | 'uncertain'; mayHaveSubmitted: boolean; code?: string; handle?: number; result?: number }
interface PendingAdd {
  id: string; written: boolean; submitting: boolean; handle?: number
  resolve(value: ScreenshotApiOutcome): void
  timer: ReturnType<typeof setTimeout>
}
interface Session {
  child: ChildProcessWithoutNullStreams; context: ScreenshotApiContext; root: string
  decoder: StringDecoder; buffer: string; noise: number; ready: boolean; closed: boolean; closing: boolean
  startup: { resolve(): void; reject(error: DomainError): void; timer: ReturnType<typeof setTimeout> } | null
  pending: PendingAdd | null; stopId?: string; stopped: boolean
  exit: Promise<void>; resolveExit(): void; rejectExit(error: DomainError): void
  killTimer?: ReturnType<typeof setTimeout>; retireTimer?: ReturnType<typeof setTimeout>
}
export interface ScreenshotApiHostOptions {
  workerPath(): string
  spawn?(worker: string, args: string[]): ChildProcessWithoutNullStreams
  readyTimeoutMs?: number
  addTimeoutMs?: number
  stopTimeoutMs?: number
  retireTimeoutMs?: number
}

export class ScreenshotApiHost {
  private session: Session | null = null
  private readonly retiring = new Set<Session>()
  private starting = false
  private adding = false
  private revision = 0
  private sequence = 0
  constructor(private readonly options: ScreenshotApiHostOptions) {}
  hasClientWork(): boolean { return this.starting || this.adding || this.session !== null || this.retiring.size > 0 }

  private async regular(path: string, directory: boolean): Promise<string> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw unavailable()
    const normalized = resolve(path)
    const file = await lstat(normalized)
    if (file.isSymbolicLink() || (directory ? !file.isDirectory() : !file.isFile()) || (await realpath(normalized)).toLowerCase() !== normalized.toLowerCase()) throw unavailable()
    return normalized
  }

  async start(context: ScreenshotApiContext, stageRoot: string): Promise<void> {
    if (this.starting || this.adding) throw new DomainError('SCREENSHOT_LIVE_BUSY', '截图接口正在处理另一项操作')
    this.starting = true
    const stopping = this.shutdown()
    const revision = this.revision
    try {
      await stopping
      if (!context || !pid(context.steamPid) || !pid(context.ownerPid) || context.steamPid === context.ownerPid || !ticks(context.steamStartTicks) || !ticks(context.ownerStartTicks) ||
        !individual(context.steamId) || !Number.isInteger(context.appId) || context.appId <= 0 || context.appId > 0xffffff || context.appId === 480 ||
        context.clientSha256 !== CLIENT_HASH || !win32.isAbsolute(context.clientDll) || !win32.isAbsolute(context.steamExe) ||
        !samePath(win32.dirname(context.clientDll), win32.dirname(context.steamExe)) || win32.basename(context.clientDll).toLowerCase() !== 'steamclient64.dll' || win32.basename(context.steamExe).toLowerCase() !== 'steam.exe') throw unavailable()
      const worker = await this.regular(this.options.workerPath(), false)
      const workerInfo = await lstat(worker)
      if (workerInfo.size < 256 || workerInfo.size > 2 * 1024 * 1024) throw unavailable()
      const root = await this.regular(stageRoot, true)
      if (revision !== this.revision) throw unavailable()
      const args = [context.clientDll, context.clientSha256, String(context.steamPid), context.steamStartTicks, String(context.appId),
        context.steamId, String(context.ownerPid), context.ownerStartTicks, root]
      const child = (this.options.spawn ?? ((executable, values) => spawnProcess(executable, values, { windowsHide: true, stdio: 'pipe', shell: false })))(worker, args)
      let resolveReady!: () => void, rejectReady!: (error: DomainError) => void
      const ready = new Promise<void>((done, fail) => { resolveReady = done; rejectReady = fail })
      let resolveExit!: () => void, rejectExit!: (error: DomainError) => void
      const exit = new Promise<void>((done, fail) => { resolveExit = done; rejectExit = fail }); void exit.catch(noop)
      const timer = setTimeout(() => this.fault(session, 'READY_TIMEOUT'), this.options.readyTimeoutMs ?? 10_000); timer.unref?.()
      const session: Session = { child, context: structuredClone(context), root, decoder: new StringDecoder('utf8'), buffer: '', noise: 0,
        ready: false, closed: false, closing: false, startup: { resolve: resolveReady, reject: rejectReady, timer }, pending: null,
        stopped: false, exit, resolveExit, rejectExit }
      this.session = session
      child.stdout.on('data', chunk => this.receive(session, chunk))
      child.stderr.on('data', chunk => { session.noise += Buffer.byteLength(chunk); if (session.noise > MAX_NOISE) this.fault(session, 'PROTOCOL_INVALID') })
      child.stdin.on('error', () => this.fault(session, 'WORKER_EXITED'))
      child.on('error', () => this.fault(session, 'WORKER_EXITED'))
      child.on('close', () => this.closed(session))
      await ready
      if (revision !== this.revision || this.session !== session || session.closed || session.closing) throw unavailable()
    } catch (error) {
      if (this.session) this.retire(this.session)
      throw error instanceof DomainError ? error : unavailable()
    } finally { this.starting = false }
  }

  private settle(session: Session, value: ScreenshotApiOutcome): void {
    const pending = session.pending
    if (!pending) return
    clearTimeout(pending.timer); session.pending = null; pending.resolve(value)
  }
  private fault(session: Session, code: string): void {
    if (session.closed) return
    if (session.startup) { clearTimeout(session.startup.timer); session.startup.reject(unavailable()); session.startup = null }
    if (session.pending) this.settle(session, { status: session.pending.written ? 'uncertain' : 'rejected', mayHaveSubmitted: session.pending.written,
      code, ...(session.pending.handle === undefined ? {} : { handle: session.pending.handle }) })
    this.retire(session)
  }
  private closed(session: Session): void {
    if (session.closed) return
    session.closed = true
    if (session.startup) { clearTimeout(session.startup.timer); session.startup.reject(unavailable()); session.startup = null }
    if (session.pending) this.settle(session, { status: 'uncertain', mayHaveSubmitted: true, code: 'WORKER_EXITED',
      ...(session.pending.handle === undefined ? {} : { handle: session.pending.handle }) })
    clearTimeout(session.killTimer); clearTimeout(session.retireTimer)
    this.retiring.delete(session); session.resolveExit()
    if (this.session === session) this.session = null
  }
  private retire(session: Session): void {
    if (session.closed || session.closing) return
    session.closing = true
    if (session.pending) this.settle(session, { status: 'uncertain', mayHaveSubmitted: true, code: 'STOP_REQUESTED',
      ...(session.pending.handle === undefined ? {} : { handle: session.pending.handle }) })
    this.retiring.add(session)
    session.stopId = `stop_${++this.sequence}`
    try { session.child.stdin.write(JSON.stringify({ v: 1, requestId: session.stopId, op: 'stop' }) + '\n') } catch { /* Actual close is still required. */ }
    session.killTimer = setTimeout(() => { if (!session.closed) { try { session.child.kill() } catch { /* A failed kill is not an exit. */ } } }, this.options.stopTimeoutMs ?? 3_000)
    session.retireTimer = setTimeout(() => { if (!session.closed) session.rejectExit(stoppedError()) }, this.options.retireTimeoutMs ?? 5_000)
    session.killTimer.unref?.(); session.retireTimer.unref?.()
  }
  async shutdown(): Promise<void> {
    this.revision++
    if (this.session) this.retire(this.session)
    for (const session of [...this.retiring]) await session.exit
  }

  private receive(session: Session, chunk: Buffer | string): void {
    if (session.closed) return
    session.buffer += typeof chunk === 'string' ? chunk : session.decoder.write(chunk)
    if (Buffer.byteLength(session.buffer) > MAX_FRAME * 4) { this.fault(session, 'PROTOCOL_INVALID'); return }
    let newline: number
    while ((newline = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, newline).replace(/\r$/, ''); session.buffer = session.buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_FRAME) { this.fault(session, 'PROTOCOL_INVALID'); return }
      if (!line.startsWith('{')) { session.noise += Buffer.byteLength(line); if (session.noise > MAX_NOISE) this.fault(session, 'PROTOCOL_INVALID'); continue }
      try {
        const message: unknown = JSON.parse(line)
        if (!object(message) || message.v !== 1 || typeof message.op !== 'string') throw new Error()
        if (message.op === 'lifecycle') {
          if (message.stage !== 'cleanup' || ['userReleased', 'pipeReleased', 'threadMemoryReleased', 'libraryReleased'].some(key => typeof message[key] !== 'boolean')) throw new Error()
          continue
        }
        if (message.op === 'stopped') {
          const correlated = session.stopId !== undefined && message.requestId === session.stopId
          const automatic = message.requestId === undefined && ['EOF', 'BATCH_LIMIT', 'IDLE_TIMEOUT'].includes(String(message.reason))
          if (!correlated && !automatic) throw new Error()
          session.stopped = true
          continue
        }
        if (session.closing) continue
        if (message.op === 'ready') {
          if (!session.startup || session.ready || message.protocol !== 1 || message.steamId !== session.context.steamId || message.appId !== session.context.appId ||
            message.screenshotsVersion !== 'STEAMSCREENSHOTS_INTERFACE_VERSION003' || message.getter !== undefined && !['generic12', 'screenshots18'].includes(String(message.getter))) throw new Error()
          clearTimeout(session.startup.timer); session.ready = true; session.startup.resolve(); session.startup = null; continue
        }
        if (message.op === 'error') { if (!safeCode(message.code)) throw new Error(); this.fault(session, message.code); return }
        const pending = session.pending
        if (!pending || !session.ready || message.requestId !== pending.id) throw new Error()
        if (message.op === 'submitting') { if (pending.submitting || pending.handle !== undefined) throw new Error(); pending.submitting = true; continue }
        if (message.op === 'submitted') {
          if (!pending.submitting || pending.handle !== undefined || !Number.isInteger(message.handle) || Number(message.handle) <= 0 || Number(message.handle) > 0xffffffff) throw new Error()
          pending.handle = Number(message.handle); continue
        }
        if (message.op !== 'result' || !['confirmed', 'rejected', 'uncertain'].includes(String(message.status)) || typeof message.mayHaveSubmitted !== 'boolean' ||
          message.code !== undefined && !safeCode(message.code) || message.handle !== undefined && (!Number.isInteger(message.handle) || Number(message.handle) < 0 || Number(message.handle) > 0xffffffff) ||
          message.result !== undefined && (!Number.isInteger(message.result) || Number(message.result) < 0 || Number(message.result) > 10000) ||
          pending.handle !== undefined && message.handle !== pending.handle || message.mayHaveSubmitted && !pending.submitting || !message.mayHaveSubmitted && pending.submitting ||
          message.status === 'confirmed' && (message.result !== 1 || !pending.handle || message.mayHaveSubmitted !== true) ||
          message.status === 'uncertain' && message.mayHaveSubmitted !== true || message.status === 'rejected' && message.result === 1) throw new Error()
        const outcome: ScreenshotApiOutcome = { status: message.status as ScreenshotApiOutcome['status'], mayHaveSubmitted: message.mayHaveSubmitted,
          ...(message.code === undefined ? {} : { code: message.code as string }), ...(message.handle === undefined ? {} : { handle: message.handle as number }),
          ...(message.result === undefined ? {} : { result: message.result as number }) }
        this.settle(session, outcome)
        if (outcome.status === 'uncertain') this.retire(session)
      } catch { this.fault(session, 'PROTOCOL_INVALID'); return }
    }
  }

  async add(image: ScreenshotApiImage): Promise<ScreenshotApiOutcome> {
    if (this.adding || this.starting) throw new DomainError('SCREENSHOT_LIVE_BUSY', '截图接口正在处理另一张图片')
    const session = this.session
    if (!session?.ready || session.closed || session.closing) throw unavailable()
    this.adding = true
    try {
      if (!image || typeof image.path !== 'string' || image.path.length > 4096 || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) ||
        !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || image.width > 16000 || image.height > 16000 || image.width * image.height > 26210175) throw unavailable()
      const path = await this.regular(image.path, false)
      const inside = relative(session.root, path)
      if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside) || !path.toLowerCase().endsWith('.jpg')) throw unavailable()
      const file = await lstat(path)
      if (file.size <= 4 || file.size > 32 * 1024 * 1024 || this.session !== session || session.closing || session.closed || session.pending) throw unavailable()
      const id = `add_${++this.sequence}`
      const frame = JSON.stringify({ v: 1, requestId: id, op: 'add', path, width: image.width, height: image.height, sha256: image.sha256 })
      if (Buffer.byteLength(frame) > 8_192) throw unavailable()
      let done!: (value: ScreenshotApiOutcome) => void
      const answer = new Promise<ScreenshotApiOutcome>(resolveOutcome => { done = resolveOutcome })
      const timer = setTimeout(() => this.fault(session, 'WORKER_TIMEOUT'), this.options.addTimeoutMs ?? 20_000); timer.unref?.()
      session.pending = { id, written: true, submitting: false, resolve: done, timer }
      try { session.child.stdin.write(frame + '\n') }
      catch { this.fault(session, 'WORKER_EXITED') }
      return await answer
    } catch (error) { throw error instanceof DomainError ? error : unavailable() }
    finally { this.adding = false }
  }
}
