import { createHash } from 'node:crypto'
import { execFile, spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import { GROUP_SIZE_KEY, readGroupSize } from '../shared/game-status-group'
import { richPresenceContract as contract, isRichPresenceParameter, isWellFormedPresenceText, richPresenceDisplayToken } from '../shared/rich-presence-contract'
import { findDefaultSteamPaths } from './steam-screenshots'
import { parseScreenshotVdf, vdfChild } from './steam-screenshot-vdf'

export interface NativePresenceContext { appId: number; steamId: string; accountId?: string; steamPid?: number; steamStartTicks?: string }
export interface NativePresenceBinding {
  gamePid: number
  gameStartTicks: string
  gameExe: string
  transport?: 'loaded-api' | 'public-client'
  dllPath?: string
  dllSha256?: string
  clientDllPath: string
  clientDllSha256: string
  arch: 'x86' | 'x64'
  parentPid: number
  parentStartTicks: string
  steamPid: number
  steamStartTicks: string
}
export interface NativePresenceProcess {
  pid: number
  startTicks: string
  exe: string
  modules: string[]
  modulesUnavailable?: boolean
}
export interface NativePresenceSteamProcess { pid: number; startTicks: string; exe: string }
export interface NativePresenceProcessList { parentPid: number; parentStartTicks: string; processes: NativePresenceProcess[]; steamProcess?: NativePresenceSteamProcess }
export interface NativePresenceRead {
  fields: Record<string, string>
  localizedString: string | null
  displayTokenReadable: boolean
  verificationSource: 'local-cache'
  keyCount: number
}
export type NativePresenceCleanupStage = 'release-user-start' | 'release-user-returned' | 'release-pipe-start' | 'release-pipe-returned' | 'free-api-library' | 'free-client-library' | 'cleanup-complete'
export type NativePresenceLifecycleStage = NativePresenceCleanupStage | 'worker-started' | 'stop-requested' | 'forced-kill' | 'worker-closed' | 'retire-timeout'
export interface NativePresenceLifecycleEvent {
  stage: NativePresenceLifecycleStage
  ok?: boolean | null
  elapsedMs?: number
  helperPid?: number
}
export interface NativePresenceCleanupSummary {
  pipeReleased: boolean | null
  userReleased: boolean | null
  complete: boolean // The worker reported cleanup completion, not absence of Steam-side effects.
  cleanupReported: boolean
  forced: boolean
  exitConfirmed: boolean
  exitCode: number | null
  retireTimedOut: boolean
  helperPid?: number
}
export interface NativePresenceDiagnostics {
  active: boolean
  ageMs: number
  completedRequests: number
  rotationDue: boolean
  retiringCount: number
  lastCleanup: NativePresenceCleanupSummary | null
  history: NativePresenceLifecycleEvent[]
}
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
  onLifecycle?: (event: NativePresenceLifecycleEvent) => void
}

const MAX_LINE_BYTES = contract.transport.ordinaryFrameBytes
const MAX_NATIVE_NOISE_BYTES = 128 * 1024
const MAX_LIFECYCLE_HISTORY = 32
const CLEANUP_STAGES = new Set<NativePresenceCleanupStage>(['release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned', 'free-api-library', 'free-client-library', 'cleanup-complete'])
const LIFECYCLE_MESSAGE_KEYS = new Set(['v', 'requestId', 'op', 'stage', 'ok', 'elapsedMs'])
const PUBLIC_NATIVE_KEYS = new Set(contract.fieldPolicy.nativeReadableKeys)
const writableKey = (key: string): boolean => key === 'steam_display' || key === GROUP_SIZE_KEY || isRichPresenceParameter(key)
const PUBLIC_CLIENT_SHA256S = new Set([
  'e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e',
  '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
])
const execute = promisify(execFile)
const ticks = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{1,18}$/.test(value)
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const WORKER_ERROR_CODES = new Set(['NATIVE_ARGUMENTS_INVALID', 'NATIVE_DLL_INVALID', 'NATIVE_LOAD_FAILED', 'NATIVE_EXPORT_MISSING', 'NATIVE_INIT_FAILED', 'NATIVE_CONTEXT_CHANGED', 'NATIVE_CONTEXT_UNAVAILABLE', 'NATIVE_EXITED', 'NATIVE_PROTOCOL_INVALID', 'NATIVE_PUBLIC_READ_INVALID', 'NATIVE_SET_REJECTED', 'NATIVE_INTERNAL_ERROR'])
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
  NATIVE_CONTEXT_UNAVAILABLE: '暂时无法核实本机 Steam 或游戏，已停止自动维持并保留恢复记录。',
  NATIVE_PROTOCOL_INVALID: '本机游戏状态组件响应异常，已停止操作。',
  NATIVE_PUBLIC_READ_INVALID: '本机游戏公开状态格式无效，未继续修改。',
  NATIVE_SET_REJECTED: 'Steam 本机接口未接受全部状态字段，需要重新读取核对。',
  NATIVE_INTERNAL_ERROR: '本机游戏状态组件未完成操作，请重新读取核对。',
  NATIVE_BUSY: '上一个本机游戏状态操作尚未结束。',
  NATIVE_CANCELLED: '本机游戏状态操作已取消，未继续提交其他字段。',
  NATIVE_TIMEOUT: '本机游戏状态组件响应超时，请重新读取核对。',
  NATIVE_EXITED: '本机游戏状态连接已结束，请保持游戏运行后重新读取。'
}

function publicCode(code: string): string {
  if (code === 'NATIVE_CONTEXT_UNAVAILABLE') return 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE'
  if (code === 'NATIVE_TIMEOUT') return 'GAME_STATUS_NATIVE_TIMEOUT'
  if (['NATIVE_CONTEXT_CHANGED', 'NATIVE_CANCELLED', 'NATIVE_EXITED'].includes(code)) return 'GAME_STATUS_NATIVE_CONTEXT'
  if (['NATIVE_ARGUMENTS_INVALID', 'NATIVE_PROTOCOL_INVALID', 'NATIVE_PUBLIC_READ_INVALID'].includes(code)) return 'GAME_STATUS_NATIVE_PROTOCOL'
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
  if ((context.steamPid !== undefined || context.steamStartTicks !== undefined) && (!pid(context.steamPid) || !ticks(context.steamStartTicks))) throw new NativePresenceError('NATIVE_ARGUMENTS_INVALID')
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
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PresenceProcessImage {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Read(int pid) {
    IntPtr handle=OpenProcess(0x1000, false, pid); if(handle==IntPtr.Zero)return null;
    try { StringBuilder path=new StringBuilder(32768); uint size=(uint)path.Capacity;
      return QueryFullProcessImageNameW(handle,0,path,ref size)?path.ToString():null;
    } finally { CloseHandle(handle); }
  }
}
'@
$parent = Get-Process -Id ${parentPid}
$active = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess'
$steam = Get-Process -Id ([int]$active.pid)
if ($steam.ProcessName -ine 'steam') { throw 'Steam process unavailable' }
$steamImage = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $steam.Id)).ExecutablePath
if (!$steamImage) { throw 'Steam image unavailable' }
$items = @()
foreach ($item in Get-Process) {
  try {
    $image = $null
    try { $image = $item.Path } catch { }
    $limitedImage = !$image
    if ($limitedImage) { $image = [PresenceProcessImage]::Read($item.Id) }
    if (!$image) { continue }
    $inside = $false
    foreach ($directory in $dirs) {
      $prefix = $directory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      if ($image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break }
    }
    if (!$inside) { continue }
    $modulesUnavailable = $limitedImage
    $modules = @()
    if (!$limitedImage) { try {
      $loaded = $item.Modules
      $modulesUnavailable = $null -eq $loaded
      $modules = @($loaded | Where-Object { $null -ne $_ -and $_.ModuleName -imatch '^(steam_api(?:64)?|steamclient(?:64)?)\\.dll$' } | ForEach-Object { $_.FileName })
    } catch { $modulesUnavailable = $true; $modules = @() } }
    $items += @{pid=$item.Id;startTicks=$item.StartTime.ToUniversalTime().Ticks.ToString();exe=$image;modules=$modules;modulesUnavailable=$modulesUnavailable}
  } catch { }
}
@{parentPid=$parent.Id;parentStartTicks=$parent.StartTime.ToUniversalTime().Ticks.ToString();steamProcess=@{pid=$steam.Id;startTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();exe=$steamImage};processes=$items} | ConvertTo-Json -Compress -Depth 5`
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
  let steamProcess: NativePresenceSteamProcess | undefined
  const processes = new Map<number, NativePresenceProcess>()
  for (const list of lists) {
    if (list.parentPid !== parentPid || !ticks(parentStartTicks) || list.parentStartTicks !== parentStartTicks || !Array.isArray(list.processes) || list.processes.length > 128) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    if (list.steamProcess) {
      const active = list.steamProcess
      if (!pid(active.pid) || !ticks(active.startTicks) || typeof active.exe !== 'string' || !isAbsolute(active.exe)) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      if (steamProcess && (active.pid !== steamProcess.pid || active.startTicks !== steamProcess.startTicks || active.exe.toLowerCase() !== steamProcess.exe.toLowerCase())) throw new NativePresenceError('NATIVE_CONTEXT_CHANGED')
      steamProcess = { ...active }
    }
    for (const item of list.processes) {
      if (!item || !pid(item.pid) || !ticks(item.startTicks) || typeof item.exe !== 'string' || !Array.isArray(item.modules) || item.modules.length > 16 || item.modules.some(value => typeof value !== 'string') || (item.modulesUnavailable !== undefined && typeof item.modulesUnavailable !== 'boolean')) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      const old = processes.get(item.pid)
      if (old && (old.startTicks !== item.startTicks || old.exe.toLowerCase() !== item.exe.toLowerCase())) throw new NativePresenceError('NATIVE_CONTEXT_CHANGED')
      const modules = new Map([...(old?.modules ?? []), ...item.modules].map(value => [value.toLowerCase(), value]))
      const { modulesUnavailable: _unavailable, ...identity } = item
      const unavailable = item.modulesUnavailable === true && (!old || old.modulesUnavailable === true)
      processes.set(item.pid, { ...identity, modules: [...modules.values()], ...(unavailable && modules.size === 0 ? { modulesUnavailable: true } : {}) })
    }
  }
  return { parentPid, parentStartTicks, processes: [...processes.values()], ...(steamProcess ? { steamProcess } : {}) }
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
    const steamRoots = new Set<string>()
    for (const root of roots) {
      if (typeof root !== 'string' || !isAbsolute(root)) continue
      const canonicalRoot = await realpath(root).catch(() => resolve(root))
      steamRoots.add(canonicalRoot)
      libraries.add(canonicalRoot)
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
    const steam = processes.steamProcess
    if (!steam || !pid(steam.pid) || !ticks(steam.startTicks) || !isAbsolute(steam.exe)) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    const steamExe = await realpath(steam.exe)
    if (basename(steamExe).toLowerCase() !== 'steam.exe' || ![...steamRoots].some(root => dirname(steamExe).toLowerCase() === root.toLowerCase())) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
    const activeSteamRoot = dirname(steamExe)
    const candidates: NativePresenceBinding[] = []
    for (const item of processes.processes) {
      if (!item || !pid(item.pid) || item.pid === parentPid || !ticks(item.startTicks) || !isAbsolute(item.exe) || !Array.isArray(item.modules) || item.modules.length > 16 || (item.modulesUnavailable !== undefined && typeof item.modulesUnavailable !== 'boolean')) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      const image = await realpath(item.exe)
      const installation = [...installations].find(value => contained(value, image))
      if (!installation || !/\.exe$/i.test(image)) throw new NativePresenceError('NATIVE_DISCOVERY_FAILED')
      if (item.modules.some(value => typeof value !== 'string' || !isAbsolute(value) || !/^(steam_api(?:64)?|steamclient(?:64)?)\.dll$/i.test(basename(value)))) throw new NativePresenceError('NATIVE_DLL_INVALID')
      const apiModules = [...new Map(item.modules.filter(value => /^steam_api(?:64)?\.dll$/i.test(basename(value))).map(value => [value.toLowerCase(), value])).values()]
      const clientModules = [...new Map(item.modules.filter(value => /^steamclient(?:64)?\.dll$/i.test(basename(value))).map(value => [value.toLowerCase(), value])).values()]
      if (!apiModules.length) {
        if (!item.modulesUnavailable) continue
        const imageContent = await boundedFile(image, 256 * 1024 * 1024)
        if (nativePresencePeArchitecture(imageContent) !== 'x64') continue
        const clientDllPath = await realpath(join(activeSteamRoot, 'steamclient64.dll'))
        if (!contained(activeSteamRoot, clientDllPath)) throw new NativePresenceError('NATIVE_DLL_INVALID')
        const clientContent = await boundedFile(clientDllPath, 64 * 1024 * 1024)
        const clientDllSha256 = createHash('sha256').update(clientContent).digest('hex')
        if (nativePresencePeArchitecture(clientContent) !== 'x64' || !PUBLIC_CLIENT_SHA256S.has(clientDllSha256)) throw new NativePresenceError('NATIVE_DLL_INVALID')
        candidates.push({ transport: 'public-client', gamePid: item.pid, gameStartTicks: item.startTicks, gameExe: image, clientDllPath, clientDllSha256, arch: 'x64', parentPid, parentStartTicks: processes.parentStartTicks, steamPid: steam.pid, steamStartTicks: steam.startTicks })
        continue
      }
      if (apiModules.length !== 1 || clientModules.length !== 1) throw new NativePresenceError('NATIVE_GAME_AMBIGUOUS')
      for (const modulePath of apiModules) {
        const dllPath = await realpath(modulePath)
        if (!contained(installation, dllPath)) throw new NativePresenceError('NATIVE_DLL_INVALID')
        const content = await boundedFile(dllPath, 32 * 1024 * 1024)
        const arch = nativePresencePeArchitecture(content)
        const clientDllPath = await realpath(clientModules[0]!)
        if (!contained(activeSteamRoot, clientDllPath) || basename(clientDllPath).toLowerCase() !== (arch === 'x86' ? 'steamclient.dll' : 'steamclient64.dll')) throw new NativePresenceError('NATIVE_DLL_INVALID')
        const clientContent = await boundedFile(clientDllPath, 64 * 1024 * 1024)
        if (nativePresencePeArchitecture(clientContent) !== arch) throw new NativePresenceError('NATIVE_DLL_INVALID')
        candidates.push({ gamePid: item.pid, gameStartTicks: item.startTicks, gameExe: image, dllPath, dllSha256: createHash('sha256').update(content).digest('hex'), clientDllPath, clientDllSha256: createHash('sha256').update(clientContent).digest('hex'), arch, parentPid, parentStartTicks: processes.parentStartTicks, steamPid: steam.pid, steamStartTicks: steam.startTicks })
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
  binding: NativePresenceBinding
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
  startedAt: number
  completedRequests: number
  droppingLine: boolean
  cleanup: NativePresenceCleanupSummary
  cleanupFailed: boolean
  cleanupStages: Set<NativePresenceCleanupStage>
}

export class NativePresenceBroker {
  private generation = 0
  private sequence = 0
  private session: Session | null = null
  private busy: object | null = null
  private retiring = new Set<{ promise: Promise<void> }>()
  private contextLostListeners = new Set<(error: NativePresenceError) => void>()
  private anchor: { context: NativePresenceContext; binding: NativePresenceBinding } | null = null
  private lifecycleHistory: NativePresenceLifecycleEvent[] = []
  private lastCleanup: NativePresenceCleanupSummary | null = null
  private shutdownFlight: Promise<void> | null = null
  constructor(private readonly options: NativePresenceBrokerOptions = {}) {}

  diagnostics(): NativePresenceDiagnostics {
    const session = this.session
    const ageMs = session ? Math.max(0, Date.now() - session.startedAt) : 0
    return { active: !!session && !session.closing, ageMs, completedRequests: session?.completedRequests ?? 0, rotationDue: ageMs >= 15 * 60 * 1000,
      retiringCount: this.retiring.size, lastCleanup: this.lastCleanup ? { ...this.lastCleanup } : null, history: this.lifecycleHistory.map(event => ({ ...event })) }
  }
  private lifecycle(session: Session, event: Pick<NativePresenceLifecycleEvent, 'stage' | 'ok' | 'elapsedMs'>): void {
    if (event.stage === 'forced-kill') session.cleanup.forced = true
    if (event.stage === 'retire-timeout') session.cleanup.retireTimedOut = true
    const value: NativePresenceLifecycleEvent = { ...event, ...(pid(session.child.pid) ? { helperPid: session.child.pid } : {}) }
    if (event.stage !== 'worker-started') this.lastCleanup = { ...session.cleanup }
    this.lifecycleHistory.push({ ...value })
    if (this.lifecycleHistory.length > MAX_LIFECYCLE_HISTORY) this.lifecycleHistory.splice(0, this.lifecycleHistory.length - MAX_LIFECYCLE_HISTORY)
    try { this.options.onLifecycle?.({ ...value }) } catch { /* Diagnostics cannot interrupt native retirement. */ }
  }
  private receiveLifecycle(session: Session, message: Record<string, unknown>): void {
    if (message.requestId !== 'lifecycle' || message.op !== 'lifecycle' || typeof message.stage !== 'string' || !CLEANUP_STAGES.has(message.stage as NativePresenceCleanupStage)
      || (message.ok !== true && message.ok !== false && message.ok !== null) || !Number.isSafeInteger(message.elapsedMs) || Number(message.elapsedMs) < 0
      || Object.keys(message).some(key => !LIFECYCLE_MESSAGE_KEYS.has(key))) return
    const stage = message.stage as NativePresenceCleanupStage
    const starting = stage === 'release-user-start' || stage === 'release-pipe-start'
    if (starting ? message.ok !== null : typeof message.ok !== 'boolean') return
    if (session.cleanupStages.has(stage)) return
    session.cleanupStages.add(stage)
    if (stage === 'release-user-returned') session.cleanup.userReleased = message.ok
    if (stage === 'release-pipe-returned') session.cleanup.pipeReleased = message.ok
    if (message.ok === false) { session.cleanupFailed = true; session.cleanup.complete = false }
    if (stage === 'cleanup-complete') {
      session.cleanup.cleanupReported = true
      session.cleanup.complete = message.ok === true && !session.cleanupFailed
    }
    this.lifecycle(session, { stage, ok: message.ok, elapsedMs: Number(message.elapsedMs) })
  }
  onContextLost(listener: (error: NativePresenceError) => void): () => void { this.contextLostListeners.add(listener); return () => this.contextLostListeners.delete(listener) }
  beginContext(): void { this.stop(); this.anchor = null }
  private notifyContextLost(error: NativePresenceError): void {
    try { this.options.onContextLost?.() } catch { /* Service cleanup cannot interrupt retirement. */ }
    for (const listener of this.contextLostListeners) { try { listener(error) } catch { /* Consumers cannot interrupt retirement. */ } }
  }

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
    session.pending.clear()
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
      killTimer = setTimeout(() => { if (!session.closed) {
        this.lifecycle(session, { stage: 'forced-kill', elapsedMs: Math.max(0, Date.now() - session.startedAt) })
        try { session.child.kill() } catch { /* A failed kill must not permit a replacement writer. */ }
      } }, delay)
      finalTimer = setTimeout(() => { if (!session.closed) {
        this.lifecycle(session, { stage: 'retire-timeout', elapsedMs: Math.max(0, Date.now() - session.startedAt) })
        reject(this.error('NATIVE_TIMEOUT'))
      } }, delay * 2)
      killTimer.unref?.(); finalTimer.unref?.()
    }) }
    this.retiring.add(retired)
    void retired.promise.catch(() => {})
    const completed = () => { session.closed = true; session.buffer = Buffer.alloc(0); finish(); this.retiring.delete(retired) }
    if (session.closed) completed()
    else session.child.once('close', completed)
    if (!session.closed) this.lifecycle(session, { stage: 'stop-requested', elapsedMs: Math.max(0, Date.now() - session.startedAt) })
    try { session.child.stdin.write(JSON.stringify({ v: 1, requestId: 'stop', op: 'stop' }) + '\n') } catch { /* Parent/game watchdog also retires the helper. */ }
    if (notify && session.readyConfirmed && !session.contextLostNotified) {
      session.contextLostNotified = true
      this.notifyContextLost(error)
    }
  }
  stop(): void {
    this.generation++; this.busy = null
    const session = this.session; this.session = null
    if (session) this.close(session, this.error('NATIVE_CANCELLED'), false)
  }
  shutdown(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight
    this.stop()
    const pending = (async () => {
      while (this.retiring.size) {
        const settled = await Promise.allSettled([...this.retiring].map(value => value.promise))
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) throw failed.reason
      }
    })()
    this.shutdownFlight = pending
    void pending.finally(() => { if (this.shutdownFlight === pending) this.shutdownFlight = null }).catch(() => {})
    return pending
  }
  private wait(session: Session, requestId: string, submitted: boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(session, this.error('NATIVE_TIMEOUT', submitted)), this.options.requestTimeoutMs ?? 15_000)
      timer.unref?.()
      session.pending.set(requestId, { resolve, reject, timer, submitted })
    })
  }
  private receive(session: Session, chunk: Buffer): void {
    if (session.closed) return
    if (!Buffer.isBuffer(chunk) || session.buffer.length + chunk.length > MAX_LINE_BYTES * 2) {
      session.buffer = Buffer.alloc(0)
      session.droppingLine = Buffer.isBuffer(chunk) && chunk.at(-1) !== 10
      if (!session.closing) this.close(session, this.error('NATIVE_PROTOCOL_INVALID'))
      return
    }
    if (session.droppingLine) {
      const end = chunk.indexOf(10)
      if (end < 0) return
      session.droppingLine = false; chunk = chunk.subarray(end + 1)
    }
    session.buffer = Buffer.concat([session.buffer, chunk])
    for (;;) {
      const end = session.buffer.indexOf(10)
      if (end < 0) {
        if (session.buffer.length > MAX_LINE_BYTES) { session.buffer = Buffer.alloc(0); session.droppingLine = true; if (!session.closing) this.close(session, this.error('NATIVE_PROTOCOL_INVALID')) }
        return
      }
      if (end > MAX_LINE_BYTES) {
        session.buffer = session.buffer.subarray(end + 1)
        if (!session.closing) this.close(session, this.error('NATIVE_PROTOCOL_INVALID'))
        continue
      }
      const line = session.buffer.subarray(0, end); session.buffer = session.buffer.subarray(end + 1)
      try {
        // Valve's DLL can print native diagnostics. Never forward or retain them.
        if (!/^\s*\{\s*"v"\s*:/.test(line.toString('latin1'))) {
          if (!session.closing) { session.noiseBytes += line.length; if (session.noiseBytes > MAX_NATIVE_NOISE_BYTES) throw new Error() }
          continue
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
        const message = JSON.parse(text) as Record<string, unknown>
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.v !== 1 || typeof message.requestId !== 'string') throw new Error()
        if (message.requestId === 'lifecycle' && message.op === 'lifecycle') { this.receiveLifecycle(session, message); continue }
        if (session.closing) continue
        const pending = session.pending.get(message.requestId)
        if (!pending || (message.op !== 'ready' && message.op !== 'applied' && message.op !== 'read' && message.op !== 'error')) throw new Error()
        session.pending.delete(message.requestId); clearTimeout(pending.timer)
        if (message.op === 'error') {
          const code = typeof message.code === 'string' && WORKER_ERROR_CODES.has(message.code) ? message.code : 'NATIVE_PROTOCOL_INVALID'
          const keys = Array.isArray(message.acceptedKeys) && message.acceptedKeys.length <= contract.presence.maxKeys && message.acceptedKeys.every(value => typeof value === 'string' && writableKey(value)) ? message.acceptedKeys as string[] : []
          pending.reject(this.error(code, pending.submitted || message.mayHaveWritten === true, keys))
        } else {
          if (message.op === 'ready' && message.requestId === 'startup' && message.ok === true && message.mayHaveWritten === false) session.readyConfirmed = true
          if (message.op === 'read' || message.op === 'applied') session.completedRequests++
          pending.resolve(message)
        }
      } catch { if (!session.closing) this.close(session, this.error('NATIVE_PROTOCOL_INVALID')) }
    }
  }
  private async start(context: NativePresenceContext, generation: number, canSubmit: () => boolean | void): Promise<Session> {
    while (this.retiring.size) {
      await Promise.all([...this.retiring].map(value => value.promise))
      this.guard(generation, canSubmit, false, [])
    }
    const binding = await (this.options.discover ?? (value => discoverNativePresenceBinding(value, this.options)))(context)
    this.guard(generation, canSubmit, false, [])
    const publicClient = binding?.transport === 'public-client'
    const apiValid = publicClient
      ? binding.arch === 'x64' && binding.dllPath === undefined && binding.dllSha256 === undefined && PUBLIC_CLIENT_SHA256S.has(binding.clientDllSha256)
      : (binding?.transport === undefined || binding.transport === 'loaded-api') && typeof binding.dllPath === 'string' && isAbsolute(binding.dllPath) && typeof binding.dllSha256 === 'string' && /^[a-f0-9]{64}$/.test(binding.dllSha256)
    if (!binding || !apiValid || !pid(binding.gamePid) || !pid(binding.parentPid) || !pid(binding.steamPid) || binding.parentPid !== (this.options.parentPid ?? process.pid) || binding.gamePid === binding.parentPid || binding.steamPid === binding.gamePid || binding.steamPid === binding.parentPid || !ticks(binding.gameStartTicks) || !ticks(binding.parentStartTicks) || !ticks(binding.steamStartTicks) || typeof binding.clientDllPath !== 'string' || !isAbsolute(binding.clientDllPath) || typeof binding.gameExe !== 'string' || !isAbsolute(binding.gameExe) || !/^[a-f0-9]{64}$/.test(binding.clientDllSha256) || !['x86', 'x64'].includes(binding.arch)) throw this.error('NATIVE_DISCOVERY_FAILED')
    if (context.steamPid !== undefined && (binding.steamPid !== context.steamPid || binding.steamStartTicks !== context.steamStartTicks)) throw this.error('NATIVE_CONTEXT_CHANGED')
    const anchored = this.anchor
    if (anchored && anchored.context.appId === context.appId && anchored.context.steamId === context.steamId && anchored.context.accountId === context.accountId && (anchored.binding.transport !== binding.transport || anchored.binding.steamPid !== binding.steamPid || anchored.binding.steamStartTicks !== binding.steamStartTicks || anchored.binding.gamePid !== binding.gamePid || anchored.binding.gameStartTicks !== binding.gameStartTicks || anchored.binding.gameExe.toLowerCase() !== binding.gameExe.toLowerCase() || anchored.binding.dllPath?.toLowerCase() !== binding.dllPath?.toLowerCase() || anchored.binding.dllSha256 !== binding.dllSha256 || anchored.binding.clientDllPath.toLowerCase() !== binding.clientDllPath.toLowerCase() || anchored.binding.clientDllSha256 !== binding.clientDllSha256)) {
      const error = this.error('NATIVE_CONTEXT_CHANGED')
      this.notifyContextLost(error)
      throw error
    }
    const workerDirectory = this.options.workerDirectory ?? fileURLToPath(new URL('../../resources/native-presence/', import.meta.url))
    let worker: string
    try {
      worker = join(await realpath(workerDirectory), `worker-${binding.arch}.exe`)
      if (await realpath(worker) !== worker || nativePresencePeArchitecture(await boundedFile(worker, 8 * 1024 * 1024)) !== binding.arch) throw new Error()
    } catch { throw this.error('NATIVE_WORKER_MISSING') }
    this.guard(generation, canSubmit, false, [])
    this.anchor = { context: { ...context }, binding: { ...binding } }
    const args = publicClient
      ? ['--public-client', binding.clientDllPath, binding.clientDllSha256, String(context.appId), context.steamId, String(binding.gamePid), binding.gameStartTicks, binding.gameExe, String(binding.parentPid), binding.parentStartTicks, String(binding.steamPid), binding.steamStartTicks]
      : [binding.dllPath!, binding.dllSha256!, binding.clientDllPath, binding.clientDllSha256, String(context.appId), context.steamId, String(binding.gamePid), binding.gameStartTicks, String(binding.parentPid), binding.parentStartTicks, String(binding.steamPid), binding.steamStartTicks]
    let child: ChildProcessWithoutNullStreams
    try { child = (this.options.spawn ?? ((file, values) => spawnProcess(file, values, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SteamAppId: String(context.appId), SteamGameId: String(context.appId) } })))(worker, args) } catch { throw this.error('NATIVE_LOAD_FAILED') }
    const session: Session = { context: { ...context }, binding: { ...binding }, child, generation, ready: Promise.resolve({}), pending: new Map(), buffer: Buffer.alloc(0), noiseBytes: 0, closing: false, closed: false, readyConfirmed: false, contextLostNotified: false, startedAt: Date.now(), completedRequests: 0,
      droppingLine: false, cleanup: { pipeReleased: null, userReleased: null, complete: false, cleanupReported: false, forced: false, exitConfirmed: false, exitCode: null, retireTimedOut: false, ...(pid(child.pid) ? { helperPid: child.pid } : {}) }, cleanupFailed: false, cleanupStages: new Set() }
    this.session = session
    session.ready = this.wait(session, 'startup', false)
    child.stdout.on('data', chunk => this.receive(session, chunk))
    child.stderr.resume()
    child.on('error', () => this.close(session, this.error('NATIVE_LOAD_FAILED')))
    child.stdin.on('error', () => this.close(session, this.error('NATIVE_EXITED')))
    child.once('close', (code: number | null) => {
      session.closed = true; session.cleanup.exitConfirmed = true; session.cleanup.exitCode = Number.isSafeInteger(code) && Number(code) >= 0 && Number(code) <= 0xffffffff ? code : null
      this.lifecycle(session, { stage: 'worker-closed', ok: code === null ? null : code === 0, elapsedMs: Math.max(0, Date.now() - session.startedAt) })
      this.close(session, this.error(code === 70 ? 'NATIVE_CONTEXT_CHANGED' : code === 72 ? 'NATIVE_PROTOCOL_INVALID' : code === 73 ? 'NATIVE_CONTEXT_UNAVAILABLE' : 'NATIVE_EXITED'))
    })
    this.lifecycle(session, { stage: 'worker-started', elapsedMs: 0 })
    return session
  }
  private async currentSession(context: NativePresenceContext, generation: number, canSubmit: () => boolean | void): Promise<Session> {
    this.guard(generation, canSubmit, false, [])
    let session = this.session
    if (session && context.steamPid !== undefined && (session.binding.steamPid !== context.steamPid || session.binding.steamStartTicks !== context.steamStartTicks)) {
      const error = this.error('NATIVE_CONTEXT_CHANGED')
      this.close(session, error)
      throw error
    }
    if (session && (session.context.appId !== context.appId || session.context.steamId !== context.steamId || session.context.accountId !== context.accountId)) { this.close(session, this.error('NATIVE_CONTEXT_CHANGED'), false); session = null }
    session ??= await this.start(context, generation, canSubmit)
    try {
      const ready = await session.ready
      this.guard(generation, canSubmit, false, [])
      if (session.closing || this.session !== session) throw this.error('NATIVE_EXITED')
      if (ready.op !== 'ready' || ready.requestId !== 'startup' || ready.ok !== true || ready.mayHaveWritten !== false) throw this.error('NATIVE_PROTOCOL_INVALID')
      return session
    } catch (error) {
      this.close(session, this.error(error instanceof NativePresenceError ? error.nativeCode : 'NATIVE_INTERNAL_ERROR'), !(error instanceof NativePresenceError && error.nativeCode === 'NATIVE_CANCELLED'))
      throw error
    }
  }
  async read(context: NativePresenceContext, canSubmit: () => boolean | void): Promise<NativePresenceRead> {
    validContext(context)
    if ((this.options.platform ?? process.platform) !== 'win32') throw this.error('NATIVE_UNSUPPORTED')
    if (this.busy) throw this.error('NATIVE_BUSY')
    const token = {}; const generation = this.generation; this.busy = token
    let session: Session | null = null
    try {
      session = await this.currentSession(context, generation, canSubmit)
      this.guard(generation, canSubmit, false, [])
      const requestId = `read_${++this.sequence}`
      const pending = this.wait(session, requestId, false)
      try { session.child.stdin.write(JSON.stringify({ v: 1, requestId, op: 'read' }) + '\n') } catch { this.close(session, this.error('NATIVE_EXITED')) }
      const response = await pending
      this.guard(generation, canSubmit, false, [])
      if (response.op !== 'read' || response.ok !== true || response.mayHaveWritten !== false || !Array.isArray(response.acceptedKeys) || response.acceptedKeys.length !== 0 || response.identityMatch !== true || response.appMatch !== true || response.loggedOn !== true || response.gameStillSame !== true || response.verificationSource !== 'local-cache' || typeof response.displayTokenReadable !== 'boolean' || !Number.isInteger(response.keyCount) || Number(response.keyCount) < 0 || Number(response.keyCount) > contract.presence.maxKeys || !response.fields || typeof response.fields !== 'object' || Array.isArray(response.fields)) throw this.error('NATIVE_PROTOCOL_INVALID')
      const fields = response.fields as Record<string, unknown>
      const entries = Object.entries(fields)
      if (entries.length > Number(response.keyCount) || entries.some(([key, value]) => !PUBLIC_NATIVE_KEYS.has(key) || typeof value !== 'string' || Buffer.byteLength(value) > contract.presence.valueUtf8Bytes || !isWellFormedPresenceText(value) || key === GROUP_SIZE_KEY && readGroupSize(value) === null)) throw this.error('NATIVE_PROTOCOL_INVALID')
      if ((response.displayTokenReadable && (typeof fields.steam_display !== 'string' || !richPresenceDisplayToken.test(fields.steam_display))) || (!response.displayTokenReadable && Object.hasOwn(fields, 'steam_display'))) throw this.error('NATIVE_PROTOCOL_INVALID')
      if (response.localizedString !== null && (typeof response.localizedString !== 'string' || Buffer.byteLength(response.localizedString) > contract.presence.localizedReadUtf8Bytes || !isWellFormedPresenceText(response.localizedString))) throw this.error('NATIVE_PROTOCOL_INVALID')
      return { fields: Object.fromEntries(entries) as Record<string, string>, localizedString: response.localizedString as string | null, displayTokenReadable: response.displayTokenReadable, verificationSource: 'local-cache', keyCount: Number(response.keyCount) }
    } catch (error) {
      if (session) this.close(session, this.error(error instanceof NativePresenceError ? error.nativeCode : 'NATIVE_INTERNAL_ERROR'), !(error instanceof NativePresenceError && error.nativeCode === 'NATIVE_CANCELLED'))
      if (error instanceof NativePresenceError) throw error
      throw this.error('NATIVE_INTERNAL_ERROR')
    } finally { if (this.busy === token) this.busy = null }
  }
  async apply(context: NativePresenceContext, changes: Record<string, string | null>, canSubmit: () => boolean | void): Promise<void> {
    validContext(context)
    if ((this.options.platform ?? process.platform) !== 'win32') throw this.error('NATIVE_UNSUPPORTED')
    if (this.busy) throw this.error('NATIVE_BUSY')
    const entries = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : []
    if (!entries.length || entries.length > contract.presence.maxKeys || new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length || entries.some(([key, value]) => !writableKey(key) || (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > contract.presence.valueUtf8Bytes || !isWellFormedPresenceText(value))) || key === GROUP_SIZE_KEY && value !== null && readGroupSize(value) === null || key === 'steam_display' && value !== null && value !== '' && !richPresenceDisplayToken.test(value))) throw this.error('NATIVE_ARGUMENTS_INVALID')
    entries.sort(([a], [b]) => Number(a === 'steam_display') - Number(b === 'steam_display'))
    const token = {}; const generation = this.generation; this.busy = token
    const accepted: string[] = []; let submitted = false; let session: Session | null = null
    try {
      session = await this.currentSession(context, generation, canSubmit)
      for (const [key, value] of entries) {
        this.guard(generation, canSubmit, submitted, accepted)
        if (session.closing || this.session !== session) throw this.error('NATIVE_EXITED', submitted, accepted)
        const requestId = `apply_${++this.sequence}`
        const response = this.wait(session, requestId, true)
        submitted = true
        try { session.child.stdin.write(JSON.stringify({ v: 1, requestId, op: 'apply', changes: { [key]: key === GROUP_SIZE_KEY ? value : value ?? '' } }) + '\n') } catch { this.close(session, this.error('NATIVE_EXITED', true, accepted)) }
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
