import { createHash } from 'node:crypto'
import { execFile, spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import { findDefaultSteamPaths } from './steam-screenshots'
import { parseScreenshotVdf, vdfChild } from './steam-screenshot-vdf'

export interface NativePresenceContext { appId: number; steamId: string; accountId?: string }
export interface NativePresenceBinding {
  gamePid: number
  gameStartTicks: string
  gameExe: string
  dllPath: string
  dllSha256: string
  arch: 'x86' | 'x64'
  parentPid: number
  parentStartTicks: string
}
export interface NativePresenceProcess {
  pid: number
  startTicks: string
  exe: string
  modules: string[]
}
export interface NativePresenceProcessList { parentPid: number; parentStartTicks: string; processes: NativePresenceProcess[] }
export interface NativePresenceDiscoveryOptions {
  platform?: NodeJS.Platform
  parentPid?: number
  steamRoots?: () => Promise<string[]>
  queryProcesses?: (directories: string[], parentPid: number) => Promise<NativePresenceProcessList>
}
export interface NativePresenceBrokerOptions extends NativePresenceDiscoveryOptions {
  workerDirectory?: string
  discover?: (context: NativePresenceContext) => Promise<NativePresenceBinding>
  spawn?: (worker: string, args: string[]) => ChildProcessWithoutNullStreams
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  onContextLost?: () => void
}

const MAX_LINE_BYTES = 32 * 1024
const MAX_NATIVE_NOISE_BYTES = 128 * 1024
const execute = promisify(execFile)
const ticks = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{1,18}$/.test(value)
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const WORKER_ERROR_CODES = new Set(['NATIVE_ARGUMENTS_INVALID', 'NATIVE_DLL_INVALID', 'NATIVE_LOAD_FAILED', 'NATIVE_EXPORT_MISSING', 'NATIVE_INIT_FAILED', 'NATIVE_CONTEXT_CHANGED', 'NATIVE_PROTOCOL_INVALID', 'NATIVE_SET_REJECTED', 'NATIVE_INTERNAL_ERROR'])
const messages: Record<string, string> = {
  NATIVE_UNSUPPORTED: '真实游戏状态修改目前需要 Windows 和本机正在运行的 Steam 游戏。',
  NATIVE_GAME_NOT_FOUND: '没有找到当前游戏正在使用的 Steam API，请保持游戏运行后重试。',
  NATIVE_GAME_AMBIGUOUS: '发现多个游戏进程，暂未安全确定要连接的游戏。',
  NATIVE_DISCOVERY_FAILED: '无法核实本机游戏进程，请检查权限后重试。',
  NATIVE_WORKER_MISSING: '本机游戏状态组件缺失或架构不符，请重新安装完整更新。',
  NATIVE_ARGUMENTS_INVALID: '本机游戏状态参数不符合要求，未继续写入。',
  NATIVE_DLL_INVALID: '无法安全核实游戏正在使用的 Steam API。',
  NATIVE_LOAD_FAILED: '无法加载游戏的 Steam API，请检查游戏与工具箱的权限。',
  NATIVE_EXPORT_MISSING: '这个游戏的 Steam API 版本暂不支持本机状态修改。',
  NATIVE_INIT_FAILED: '无法连接本机 Steam 游戏会话，请保持 Steam 和游戏运行。',
  NATIVE_CONTEXT_CHANGED: '账号或真实游戏已经变化，已停止本机状态修改。',
  NATIVE_PROTOCOL_INVALID: '本机游戏状态组件响应异常，已停止操作。',
  NATIVE_SET_REJECTED: 'Steam 本机接口未接受全部状态字段，需要重新读取核对。',
  NATIVE_INTERNAL_ERROR: '本机游戏状态组件未完成操作，请重新读取核对。',
  NATIVE_BUSY: '上一个本机游戏状态操作尚未结束。',
  NATIVE_CANCELLED: '本机游戏状态操作已取消，未继续提交其他字段。',
  NATIVE_TIMEOUT: '本机游戏状态组件响应超时，请重新读取核对。',
  NATIVE_EXITED: '本机游戏状态连接已结束，请保持游戏运行后重新读取。'
}

function publicCode(code: string): string {
  if (code === 'NATIVE_TIMEOUT') return 'GAME_STATUS_NATIVE_TIMEOUT'
  if (['NATIVE_CONTEXT_CHANGED', 'NATIVE_CANCELLED', 'NATIVE_EXITED'].includes(code)) return 'GAME_STATUS_NATIVE_CONTEXT'
  if (['NATIVE_ARGUMENTS_INVALID', 'NATIVE_PROTOCOL_INVALID'].includes(code)) return 'GAME_STATUS_NATIVE_PROTOCOL'
  if (['NATIVE_SET_REJECTED', 'NATIVE_INTERNAL_ERROR'].includes(code) || !Object.hasOwn(messages, code)) return 'GAME_STATUS_NATIVE_WRITE_FAILED'
  return 'GAME_STATUS_NATIVE_UNAVAILABLE'
}
export class NativePresenceError extends DomainError {
  readonly nativeCode: string
  constructor(code: string, public readonly mayHaveWritten = false, public readonly acceptedKeys: string[] = []) {
    super(publicCode(code), messages[code] ?? messages.NATIVE_INTERNAL_ERROR!)
    this.nativeCode = Object.hasOwn(messages, code) ? code : 'NATIVE_INTERNAL_ERROR'
    this.name = 'NativePresenceError'
  }
}

function validContext(context: NativePresenceContext): void {
  if (!context || !Number.isInteger(context.appId) || context.appId < 1 || context.appId > 0xffffff || typeof context.steamId !== 'string' || !/^[0-9]{17}$/.test(context.steamId)) throw new NativePresenceError('NATIVE_ARGUMENTS_INVALID')
}
function contained(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path))
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new NativePresenceError('NATIVE_DLL_INVALID')
  const content = await readFile(path)
  const after = await lstat(path)
  if (content.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new NativePresenceError('NATIVE_DLL_INVALID')
  return content
}
export function nativePresencePeArchitecture(bytes: Buffer): 'x86' | 'x64' {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new NativePresenceError('NATIVE_DLL_INVALID')
  const offset = bytes.readUInt32LE(60)
  if (offset > 1024 * 1024 || offset + 26 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new NativePresenceError('NATIVE_DLL_INVALID')
  const machine = bytes.readUInt16LE(offset + 4)
  const magic = bytes.readUInt16LE(offset + 24)
  if (machine === 0x14c && magic === 0x10b) return 'x86'
  if (machine === 0x8664 && magic === 0x20b) return 'x64'
  throw new NativePresenceError('NATIVE_DLL_INVALID')
}

async function optionalVdf(path: string) {
  try { return parseScreenshotVdf((await boundedFile(path, 1024 * 1024)).toString('utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function windowsProcesses(directories: string[], parentPid: number): Promise<NativePresenceProcessList> {
  const encoded = Buffer.from(JSON.stringify(directories), 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dirs = @(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))
$parent = Get-Process -Id ${parentPid}
$items = @()
foreach ($item in Get-Process) {
  try {
    $image = $item.Path
    if (!$image) { continue }
    $inside = $false
    foreach ($directory in $dirs) {
      $prefix = $directory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      if ($image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break }
    }
    if (!$inside) { continue }
    $modules = @($item.Modules | Where-Object { $_.ModuleName -ieq 'steam_api.dll' -or $_.ModuleName -ieq 'steam_api64.dll' } | ForEach-Object { $_.FileName })
    if ($modules.Count -eq 0) { continue }
    $items += @{pid=$item.Id;startTicks=$item.StartTime.ToUniversalTime().Ticks.ToString();exe=$image;modules=$modules}
  } catch { }
}
@{parentPid=$parent.Id;parentStartTicks=$parent.StartTime.ToUniversalTime().Ticks.ToString();processes=$items} | ConvertTo-Json -Compress -Depth 5`
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  // Framework Process.Modules omits x86 modules from a 64-bit host. Query both
  // fixed system hosts; never replace a missing loaded module with a disk search.
  const results = await Promise.all(['System32', 'SysWOW64'].map(async architecture => {
    try {
      const executable = join(process.env.SystemRoot ?? 'C:/Windows', architecture, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const { stdout } = await execute(executable, args, { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, encoding: 'utf8' })
      return JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as NativePresenceProcessList
    } catch { return null }
  }))
  return mergeNativePresenceProcessLists(results.filter((value): value is NativePresenceProcessList => value !== null), parentPid)
}

export function mergeNativePresenceProcessLists(lists: NativePresenceProcessList[], parentPid: number): NativePresenceProcessList {
  if (!lists.length) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
  const parentStartTicks = lists[0]!.parentStartTicks
  const processes = new Map<number, NativePresenceProcess>()
  for (const list of lists) {
    if (list.parentPid !== parentPid || !ticks(parentStartTicks) || list.parentStartTicks !== parentStartTicks || !Array.isArray(list.processes) || list.processes.length > 128) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    for (const item of list.processes) {
      if (!item || !pid(item.pid) || !ticks(item.startTicks) || typeof item.exe !== 'string' || !Array.isArray(item.modules) || item.modules.length > 16 || item.modules.some(value => typeof value !== 'string')) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      const old = processes.get(item.pid)
      if (old && (old.startTicks !== item.startTicks || old.exe.toLowerCase() !== item.exe.toLowerCase())) throw new NativePresenceError('NATIVE_CONTEXT_CHANGED')
      const modules = new Map([...(old?.modules ?? []), ...item.modules].map(value => [value.toLowerCase(), value]))
      processes.set(item.pid, { ...item, modules: [...modules.values()] })
    }
  }
  return { parentPid, parentStartTicks, processes: [...processes.values()] }
}

export async function discoverNativePresenceBinding(context: NativePresenceContext, options: NativePresenceDiscoveryOptions = {}): Promise<NativePresenceBinding> {
  validContext(context)
  if ((options.platform ?? process.platform) !== 'win32') throw new NativePresenceError('NATIVE_UNSUPPORTED')
  const parentPid = options.parentPid ?? process.pid
  if (!pid(parentPid)) throw new NativePresenceError('NATIVE_ARGUMENTS_INVALID')
  try {
    const roots = await (options.steamRoots ?? findDefaultSteamPaths)()
    if (!Array.isArray(roots) || roots.length > 64) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    const libraries = new Set<string>()
    for (const root of roots) {
      if (typeof root !== 'string' || !isAbsolute(root)) continue
      libraries.add(await realpath(root).catch(() => resolve(root)))
      const catalog = await optionalVdf(join(root, 'steamapps', 'libraryfolders.vdf'))
      for (const library of vdfChild(catalog ?? undefined, 'libraryfolders')?.children ?? []) {
        if (!/^\d+$/.test(library.key)) continue
        const path = vdfChild(library.children, 'path')?.value ?? library.value
        if (path && isAbsolute(path)) libraries.add(await realpath(path).catch(() => resolve(path)))
      }
    }
    if (libraries.size > 64) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    const installations = new Set<string>()
    for (const library of libraries) {
      const manifest = await optionalVdf(join(library, 'steamapps', `appmanifest_${context.appId}.acf`))
      if (!manifest) continue
      const state = vdfChild(manifest, 'AppState')
      const app = vdfChild(state?.children, 'appid')?.value
      const directory = vdfChild(state?.children, 'installdir')?.value
      if (app !== String(context.appId) || !directory || isAbsolute(directory) || /[\x00-\x1f]/.test(directory) || directory.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      const common = await realpath(join(library, 'steamapps', 'common'))
      const installed = await realpath(resolve(common, directory))
      if (!contained(common, installed) || !(await lstat(installed)).isDirectory()) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      installations.add(installed)
    }
    if (!installations.size) throw new NativePresenceError('NATIVE_GAME_NOT_FOUND')
    const processes = await (options.queryProcesses ?? windowsProcesses)([...installations], parentPid)
    if (!processes || processes.parentPid !== parentPid || !ticks(processes.parentStartTicks) || !Array.isArray(processes.processes) || processes.processes.length > 128) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    const candidates: NativePresenceBinding[] = []
    for (const item of processes.processes) {
      if (!item || !pid(item.pid) || item.pid === parentPid || !ticks(item.startTicks) || !isAbsolute(item.exe) || !Array.isArray(item.modules) || item.modules.length > 16) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      const image = await realpath(item.exe)
      const installation = [...installations].find(value => contained(value, image))
      if (!installation || !/\.exe$/i.test(image)) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      for (const modulePath of item.modules) {
        if (typeof modulePath !== 'string' || !isAbsolute(modulePath) || !/^steam_api(?:64)?\.dll$/i.test(basename(modulePath))) throw new NativePresenceError('NATIVE_DLL_INVALID')
        const dllPath = await realpath(modulePath)
        if (!contained(installation, dllPath)) throw new NativePresenceError('NATIVE_DLL_INVALID')
        const content = await boundedFile(dllPath, 32 * 1024 * 1024)
        candidates.push({ gamePid: item.pid, gameStartTicks: item.startTicks, gameExe: image, dllPath, dllSha256: createHash('sha256').update(content).digest('hex'), arch: nativePresencePeArchitecture(content), parentPid, parentStartTicks: processes.parentStartTicks })
      }
    }
    if (!candidates.length) throw new NativePresenceError('NATIVE_GAME_NOT_FOUND')
    if (candidates.length !== 1) throw new NativePresenceError('NATIVE_GAME_AMBIGUOUS')
    return candidates[0]!
  } catch (error) {
    if (error instanceof NativePresenceError) throw error
    throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
  }
}

interface Pending {
  resolve(message: Record<string, unknown>): void
  reject(error: NativePresenceError): void
  timer: ReturnType<typeof setTimeout>
  submitted: boolean
}
interface Session {
  context: NativePresenceContext
  child: ChildProcessWithoutNullStreams
  generation: number
  ready: Promise<Record<string, unknown>>
  pending: Map<string, Pending>
  buffer: Buffer
  noiseBytes: number
  closing: boolean
  closed: boolean
  readyConfirmed: boolean
  contextLostNotified: boolean
}

export class NativePresenceBroker {
  private generation = 0
  private sequence = 0
  private session: Session | null = null
  private busy: object | null = null
  private retiring = new Set<{ promise: Promise<void> }>()
  constructor(private readonly options: NativePresenceBrokerOptions = {}) {}

  private error(code: string, submitted = false, acceptedKeys: string[] = []): NativePresenceError { return new NativePresenceError(code, submitted, [...acceptedKeys]) }
  private guard(generation: number, canSubmit: () => boolean | void, submitted: boolean, accepted: string[]): void {
    let allowed = false
    try { allowed = this.generation === generation && canSubmit() !== false } catch { /* The caller owns account and game epoch validation. */ }
    if (!allowed) throw this.error('NATIVE_CANCELLED', submitted, accepted)
  }
  private close(session: Session, error: NativePresenceError, notify = true): void {
    if (session.closing) return
    session.closing = true
    if (this.session === session) this.session = null
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(this.error(error.nativeCode, error.mayHaveWritten || pending.submitted, error.acceptedKeys)) }
    session.pending.clear(); session.buffer = Buffer.alloc(0)
    let finished = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let finalTimer: ReturnType<typeof setTimeout> | null = null
    let finish!: () => void
    const retired = { promise: new Promise<void>((resolve, reject) => {
      finish = () => {
        if (finished) return
        finished = true
        if (killTimer) clearTimeout(killTimer)
        if (finalTimer) clearTimeout(finalTimer)
        resolve()
      }
      const delay = this.options.stopTimeoutMs ?? 2500
      killTimer = setTimeout(() => { if (!session.closed) { try { session.child.kill() } catch { /* A failed kill must not permit a replacement writer. */ } } }, delay)
      finalTimer = setTimeout(() => { if (!session.closed) reject(this.error('NATIVE_TIMEOUT')) }, delay * 2)
      killTimer.unref?.(); finalTimer.unref?.()
    }) }
    this.retiring.add(retired)
    void retired.promise.catch(() => {})
    const completed = () => { session.closed = true; finish(); this.retiring.delete(retired) }
    if (session.closed) completed()
    else session.child.once('close', completed)
    try { session.child.stdin.end(JSON.stringify({ v: 1, requestId: 'stop', op: 'stop' }) + '\n') } catch { /* Parent/game watchdog also retires the helper. */ }
    if (notify && session.readyConfirmed && !session.contextLostNotified) {
      session.contextLostNotified = true
      try { this.options.onContextLost?.() } catch { /* UI or service observers cannot interrupt worker retirement. */ }
    }
  }
  stop(): void {
    this.generation++; this.busy = null
    const session = this.session; this.session = null
    if (session) this.close(session, this.error('NATIVE_CANCELLED'), false)
  }
  private wait(session: Session, requestId: string, submitted: boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(session, this.error('NATIVE_TIMEOUT', submitted)), this.options.requestTimeoutMs ?? 15_000)
      timer.unref?.()
      session.pending.set(requestId, { resolve, reject, timer, submitted })
    })
  }
  private receive(session: Session, chunk: Buffer): void {
    if (session.closing) return
    if (!Buffer.isBuffer(chunk) || session.buffer.length + chunk.length > MAX_LINE_BYTES * 2) { this.close(session, this.error('NATIVE_PROTOCOL_INVALID')); return }
    session.buffer = Buffer.concat([session.buffer, chunk])
    for (;;) {
      const end = session.buffer.indexOf(10)
      if (end < 0) { if (session.buffer.length > MAX_LINE_BYTES) this.close(session, this.error('NATIVE_PROTOCOL_INVALID')); return }
      if (end > MAX_LINE_BYTES) { this.close(session, this.error('NATIVE_PROTOCOL_INVALID')); return }
      const line = session.buffer.subarray(0, end); session.buffer = session.buffer.subarray(end + 1)
      try {
        // Valve's DLL can print native diagnostics. Never forward or retain them.
        if (!/^\s*\{\s*"v"\s*:/.test(line.toString('latin1'))) {
          session.noiseBytes += line.length
          if (session.noiseBytes > MAX_NATIVE_NOISE_BYTES) throw new Error()
          continue
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
        const message = JSON.parse(text) as Record<string, unknown>
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.v !== 1 || typeof message.requestId !== 'string') throw new Error()
        const pending = session.pending.get(message.requestId)
        if (!pending || (message.op !== 'ready' && message.op !== 'applied' && message.op !== 'error')) throw new Error()
        session.pending.delete(message.requestId); clearTimeout(pending.timer)
        if (message.op === 'error') {
          const code = typeof message.code === 'string' && WORKER_ERROR_CODES.has(message.code) ? message.code : 'NATIVE_PROTOCOL_INVALID'
          const keys = Array.isArray(message.acceptedKeys) && message.acceptedKeys.length <= 20 && message.acceptedKeys.every(value => typeof value === 'string' && !!value && Buffer.byteLength(value) <= 63 && !/[\x00-\x1f\x7f]/.test(value)) ? message.acceptedKeys as string[] : []
          pending.reject(this.error(code, pending.submitted || message.mayHaveWritten === true, keys))
        } else {
          if (message.op === 'ready' && message.requestId === 'startup' && message.ok === true && message.mayHaveWritten === false) session.readyConfirmed = true
          pending.resolve(message)
        }
      } catch { this.close(session, this.error('NATIVE_PROTOCOL_INVALID')); return }
    }
  }
  private async start(context: NativePresenceContext, generation: number, canSubmit: () => boolean | void): Promise<Session> {
    while (this.retiring.size) {
      await Promise.all([...this.retiring].map(value => value.promise))
      this.guard(generation, canSubmit, false, [])
    }
    const binding = await (this.options.discover ?? (value => discoverNativePresenceBinding(value, this.options)))(context)
    this.guard(generation, canSubmit, false, [])
    if (!binding || !pid(binding.gamePid) || !pid(binding.parentPid) || binding.parentPid !== (this.options.parentPid ?? process.pid) || binding.gamePid === binding.parentPid || !ticks(binding.gameStartTicks) || !ticks(binding.parentStartTicks) || !isAbsolute(binding.dllPath) || !isAbsolute(binding.gameExe) || !/^[a-f0-9]{64}$/.test(binding.dllSha256) || !['x86', 'x64'].includes(binding.arch)) throw this.error('NATIVE_DISCOVERY_FAILED')
    const workerDirectory = this.options.workerDirectory ?? fileURLToPath(new URL('../../resources/native-presence/', import.meta.url))
    let worker: string
    try {
      worker = join(await realpath(workerDirectory), `worker-${binding.arch}.exe`)
      if (await realpath(worker) !== worker || nativePresencePeArchitecture(await boundedFile(worker, 8 * 1024 * 1024)) !== binding.arch) throw new Error()
    } catch { throw this.error('NATIVE_WORKER_MISSING') }
    this.guard(generation, canSubmit, false, [])
    const args = [binding.dllPath, binding.dllSha256, String(context.appId), context.steamId, String(binding.gamePid), binding.gameStartTicks, String(binding.parentPid), binding.parentStartTicks]
    let child: ChildProcessWithoutNullStreams
    try { child = (this.options.spawn ?? ((file, values) => spawnProcess(file, values, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SteamAppId: String(context.appId), SteamGameId: String(context.appId) } })))(worker, args) } catch { throw this.error('NATIVE_LOAD_FAILED') }
    const session: Session = { context: { ...context }, child, generation, ready: Promise.resolve({}), pending: new Map(), buffer: Buffer.alloc(0), noiseBytes: 0, closing: false, closed: false, readyConfirmed: false, contextLostNotified: false }
    this.session = session
    session.ready = this.wait(session, 'startup', false)
    child.stdout.on('data', chunk => this.receive(session, chunk))
    child.stderr.resume()
    child.on('error', () => this.close(session, this.error('NATIVE_LOAD_FAILED')))
    child.stdin.on('error', () => this.close(session, this.error('NATIVE_EXITED')))
    child.once('close', (code: number | null) => { session.closed = true; this.close(session, this.error(code === 70 ? 'NATIVE_CONTEXT_CHANGED' : 'NATIVE_EXITED')) })
    return session
  }
  async apply(context: NativePresenceContext, changes: Record<string, string | null>, canSubmit: () => boolean | void): Promise<void> {
    validContext(context)
    if ((this.options.platform ?? process.platform) !== 'win32') throw this.error('NATIVE_UNSUPPORTED')
    if (this.busy) throw this.error('NATIVE_BUSY')
    const entries = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : []
    if (!entries.length || entries.length > 20 || entries.some(([key, value]) => !key || Buffer.byteLength(key) > 63 || /[\x00-\x1f\x7f]/.test(key) || (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 255 || /[\x00-\x1f\x7f]/.test(value))))) throw this.error('NATIVE_ARGUMENTS_INVALID')
    entries.sort(([a], [b]) => Number(a === 'steam_display') - Number(b === 'steam_display'))
    const token = {}; const generation = this.generation; this.busy = token
    const accepted: string[] = []; let submitted = false; let session: Session | null = null
    try {
      this.guard(generation, canSubmit, false, [])
      session = this.session
      if (session && (session.context.appId !== context.appId || session.context.steamId !== context.steamId || session.context.accountId !== context.accountId)) { this.close(session, this.error('NATIVE_CONTEXT_CHANGED'), false); session = null }
      session ??= await this.start(context, generation, canSubmit)
      const ready = await session.ready
      if (ready.op !== 'ready' || ready.requestId !== 'startup' || ready.ok !== true || ready.mayHaveWritten !== false) throw this.error('NATIVE_PROTOCOL_INVALID')
      for (const [key, value] of entries) {
        this.guard(generation, canSubmit, submitted, accepted)
        if (session.closing || this.session !== session) throw this.error('NATIVE_EXITED', submitted, accepted)
        const requestId = `apply_${++this.sequence}`
        const response = this.wait(session, requestId, true)
        submitted = true
        try { session.child.stdin.write(JSON.stringify({ v: 1, requestId, op: 'apply', changes: { [key]: value ?? '' } }) + '\n') } catch { this.close(session, this.error('NATIVE_EXITED', true, accepted)) }
        const result = await response
        if (result.op !== 'applied' || result.ok !== true || result.mayHaveWritten !== true || !Array.isArray(result.acceptedKeys) || result.acceptedKeys.length !== 1 || result.acceptedKeys[0] !== key) throw this.error('NATIVE_PROTOCOL_INVALID', true, accepted)
        accepted.push(key)
        this.guard(generation, canSubmit, true, accepted)
      }
    } catch (error) {
      if (session) this.close(session, this.error(error instanceof NativePresenceError ? error.nativeCode : 'NATIVE_INTERNAL_ERROR', submitted, accepted), !(error instanceof NativePresenceError && error.nativeCode === 'NATIVE_CANCELLED'))
      if (error instanceof NativePresenceError) throw this.error(error.nativeCode, submitted || error.mayHaveWritten, [...new Set([...accepted, ...error.acceptedKeys])])
      throw this.error('NATIVE_INTERNAL_ERROR', submitted, accepted)
    } finally { if (this.busy === token) this.busy = null }
  }
}
