import { execFile, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { win32 as path } from 'node:path'
import { promisify } from 'node:util'
import type { Stats } from 'node:fs'
import { DomainError } from '../shared/domain'
import { isSteamClientRunning } from './steam-screenshot-runtime'

export interface ScreenshotSteamClient { executable: string; pid: number; startTicks: string }
export interface ScreenshotSteamRuntime {
  isRunning(): Promise<boolean>
  resolveRunningClient(steamPath: string): Promise<ScreenshotSteamClient>
  requestShutdown(client: ScreenshotSteamClient): Promise<void>
  start(client: ScreenshotSteamClient): Promise<void>
}

type FileStat = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'dev' | 'ino' | 'size' | 'mtimeMs'>
export interface ScreenshotSteamRuntimeDependencies {
  platform: NodeJS.Platform
  isRunning(): Promise<boolean>
  inspect(): Promise<unknown>
  realpath(file: string): Promise<string>
  lstat(file: string): Promise<FileStat>
  shutdown(executable: string): Promise<void>
  launch(executable: string): Promise<void>
}
interface Inspection {
  executable: string
  registryExecutable: string
  pid: number
  startTicks: string
  steamPids: number[]
  runningAppId: number
  runningAppIds: number[]
}
interface Provenance { root: string; file: FileStat }
const execute = promisify(execFile)
const safePid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const safeAppId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
const equalPath = (a: string, b: string): boolean => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
const sameFile = (a: FileStat, b: FileStat): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
const failure = (code: string, message: string): DomainError => new DomainError(`SCREENSHOT_STEAM_${code}`, message)

const inspectionScript = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$config=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam'
$all=@(Get-Process -Name steam -ErrorAction SilentlyContinue)
if($all.Count -ne 1){throw 'Steam instance unavailable'}
$steam=$all[0]
$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$steam.Id)).ExecutablePath
if(!$image -or !$config.SteamExe){throw 'Steam executable unavailable'}
$runningAppId=0
if($null -ne $config.RunningAppID){$runningAppId=[long]$config.RunningAppID}
$appsPath='HKCU:\\Software\\Valve\\Steam\\Apps'
$keys=@(if(Test-Path -LiteralPath $appsPath){Get-ChildItem -LiteralPath $appsPath -ErrorAction Stop})
if($keys.Count -gt 4096){throw 'Steam activity unavailable'}
$running=@(foreach($key in $keys){$item=Get-ItemProperty -LiteralPath $key.PSPath;if($null -ne $item.Running -and [long]$item.Running -ne 0){if($key.PSChildName -notmatch '^[0-9]+$'){throw 'Steam activity unavailable'};[long]$key.PSChildName}})
@{executable=$image;registryExecutable=[string]$config.SteamExe;pid=$steam.Id;startTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();steamPids=@($all|ForEach-Object{$_.Id});runningAppId=$runningAppId;runningAppIds=@($running)}|ConvertTo-Json -Compress -Depth 4`

async function inspectSteam(): Promise<unknown> {
  const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspectionScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' })
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as unknown
}

async function shutdownSteam(executable: string): Promise<void> {
  await execute(executable, ['-shutdown'], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, shell: false })
}

function launchSteam(executable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: path.dirname(executable), detached: true, windowsHide: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function checkedInspection(value: unknown): Inspection {
  const item = value as Partial<Inspection> | null
  if (!item || typeof item !== 'object' || !safePid(item.pid) || typeof item.startTicks !== 'string' || !/^[1-9]\d{1,18}$/.test(item.startTicks) ||
    typeof item.executable !== 'string' || typeof item.registryExecutable !== 'string' ||
    !Array.isArray(item.steamPids) || item.steamPids.length !== 1 || item.steamPids[0] !== item.pid ||
    !safeAppId(item.runningAppId) || !Array.isArray(item.runningAppIds) || item.runningAppIds.length > 4096 || !item.runningAppIds.every(safeAppId)) {
    throw failure('CLIENT_UNVERIFIED', '无法可靠核实正在运行的 Steam 客户端，未请求退出')
  }
  return item as Inspection
}

export function createScreenshotSteamRuntime(overrides: Partial<ScreenshotSteamRuntimeDependencies> = {}): ScreenshotSteamRuntime {
  const dependencies: ScreenshotSteamRuntimeDependencies = {
    platform: process.platform, isRunning: isSteamClientRunning, inspect: inspectSteam,
    realpath, lstat, shutdown: shutdownSteam, launch: launchSteam, ...overrides
  }
  const provenance = new WeakMap<ScreenshotSteamClient, Provenance>()
  const requireWindows = (): void => {
    if (dependencies.platform !== 'win32') throw failure('RESTART_UNSUPPORTED', '自动退出并重启 Steam 目前仅支持 Windows，请手动退出后导入')
  }
  const validatePath = async (root: string, executable: string): Promise<FileStat> => {
    if (!path.isAbsolute(root) || !path.isAbsolute(executable) || root.includes('\0') || executable.includes('\0') ||
      path.basename(executable).toLowerCase() !== 'steam.exe' || !equalPath(path.dirname(executable), root)) {
      throw failure('CLIENT_UNVERIFIED', '当前 Steam 安装目录与截图目标不一致，未请求退出')
    }
    const directory = await dependencies.lstat(root)
    const file = await dependencies.lstat(executable)
    if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() ||
      !equalPath(await dependencies.realpath(root), root) || !equalPath(await dependencies.realpath(executable), executable)) {
      throw failure('CLIENT_UNVERIFIED', 'Steam 路径包含重解析路径或无效文件，未执行客户端操作')
    }
    return file
  }
  const resolveRunningClient = async (steamPath: string): Promise<ScreenshotSteamClient> => {
    requireWindows()
    try {
      if (typeof steamPath !== 'string' || !path.isAbsolute(steamPath) || steamPath.includes('\0')) throw failure('CLIENT_UNVERIFIED', '请选择有效的 Steam 安装目录')
      const root = path.normalize(steamPath)
      const inspection = checkedInspection(await dependencies.inspect())
      if (!equalPath(inspection.executable, inspection.registryExecutable)) throw failure('CLIENT_UNVERIFIED', 'Steam 注册路径与实际运行进程不一致，未请求退出')
      const file = await validatePath(root, inspection.executable)
      if (inspection.runningAppId !== 0 || inspection.runningAppIds.some(appId => appId !== 0)) {
        throw failure('GAME_RUNNING', 'Steam 仍有正在运行的游戏或应用，请先正常退出游戏，再导入截图')
      }
      const client = Object.freeze({ executable: path.normalize(inspection.executable), pid: inspection.pid, startTicks: inspection.startTicks })
      provenance.set(client, { root, file })
      return client
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw failure('CLIENT_UNVERIFIED', '无法可靠核实正在运行的 Steam 客户端，未请求退出')
    }
  }
  const knownClient = (client: ScreenshotSteamClient): Provenance => {
    const known = client && typeof client === 'object' ? provenance.get(client) : undefined
    if (!known) throw failure('CLIENT_CHANGED', 'Steam 客户端已变化或未完成核实，请刷新后重试')
    return known
  }
  return {
    isRunning: () => dependencies.isRunning(),
    resolveRunningClient,
    async requestShutdown(client) {
      requireWindows()
      const known = knownClient(client)
      const current = await resolveRunningClient(known.root)
      if (current.pid !== client.pid || current.startTicks !== client.startTicks || !equalPath(current.executable, client.executable) ||
        !sameFile(knownClient(current).file, known.file)) {
        throw failure('CLIENT_CHANGED', 'Steam 客户端已变化，未请求退出；请刷新后重试')
      }
      try { await dependencies.shutdown(client.executable) }
      catch { throw failure('SHUTDOWN_FAILED', '未能正常请求 Steam 退出；不会强制结束进程，请手动退出后重试') }
    },
    async start(client) {
      requireWindows()
      const known = knownClient(client)
      try {
        const file = await validatePath(known.root, client.executable)
        if (!sameFile(file, known.file)) {
          throw failure('CLIENT_CHANGED', 'Steam 可执行文件已变化，请手动重新打开 Steam')
        }
        if (await dependencies.isRunning()) return
        await dependencies.launch(client.executable)
      } catch (error) {
        if (error instanceof DomainError) throw error
        throw failure('START_FAILED', '未能重新启动 Steam；已导入的截图不会撤销，请手动打开 Steam')
      }
    }
  }
}
