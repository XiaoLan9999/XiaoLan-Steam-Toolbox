import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import { detectNativeGameStatusContext, type NativeGameStatusContext } from './native-game-status-client'

interface Options {
  detectContext?(): Promise<NativeGameStatusContext>
  queryActivity?(): Promise<{ gameActive: boolean }>
}
const execute = promisify(execFile)
const unavailable = () => new DomainError('GAME_STATUS_SIMULATION_CONTEXT_UNAVAILABLE',
  '无法核对本机 Steam 的账号和游戏状态，未提交模拟。')

async function queryActivity(): Promise<{ gameActive: boolean }> {
  if (process.platform !== 'win32') throw unavailable()
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$keys = @(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\Apps' -ErrorAction Stop)
if ($keys.Count -gt 4096) { throw 'Steam activity unavailable' }
$running = $false
foreach ($key in $keys) {
  $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
  if ($null -ne $item.Running -and [long]$item.Running -ne 0) { $running = $true; break }
}
@{gameActive=$running} | ConvertTo-Json -Compress`
  const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8' })
  const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as { gameActive: boolean }
  if (!value || typeof value.gameActive !== 'boolean') throw unavailable()
  return { gameActive: value.gameActive }
}

export async function readLocalSimulationContext(options: Options = {}): Promise<{ steamId: string; appId: number; gameActive: boolean }> {
  try {
    const detect = options.detectContext ?? detectNativeGameStatusContext
    const before = await detect()
    if (before.appId !== 0) return { steamId: before.steamId, appId: before.appId, gameActive: true }
    const activity = await (options.queryActivity ?? queryActivity)()
    if (!activity || typeof activity.gameActive !== 'boolean') throw unavailable()
    const after = await detect()
    if (before.steamId !== after.steamId || before.steamPid !== after.steamPid || before.steamStartTicks !== after.steamStartTicks ||
      before.steamExe.toLowerCase() !== after.steamExe.toLowerCase()) throw unavailable()
    return { steamId: after.steamId, appId: after.appId, gameActive: activity.gameActive || after.appId !== 0 }
  } catch { throw unavailable() }
}
