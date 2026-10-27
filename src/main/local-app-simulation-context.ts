import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { NativeGameStatusContext } from './native-game-status-client'

export interface LocalAppSimulationContext extends NativeGameStatusContext {
  activeAppIds: number[]
  ownerPid: number
  ownerStartTicks: string
}
const execute = promisify(execFile)
export function validLocalAppContext(value: LocalAppSimulationContext): boolean {
  return !!value && /^\d{17}$/.test(value.steamId) && Number.isInteger(value.appId) && value.appId >= 0 && value.appId <= 0xffffff &&
    [value.steamPid, value.ownerPid].every(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff) && value.steamPid !== value.ownerPid &&
    [value.steamStartTicks, value.ownerStartTicks].every(ticks => typeof ticks === 'string' && /^[1-9]\d{1,18}$/.test(ticks)) &&
    typeof value.steamExe === 'string' && isAbsolute(value.steamExe) && basename(value.steamExe).toLowerCase() === 'steam.exe' &&
    Array.isArray(value.activeAppIds) && value.activeAppIds.length <= 4096 && value.activeAppIds.every(app => Number.isSafeInteger(app) && app >= 0 && app <= 0xffffffff)
}
export function sameLocalAppSteam(a: LocalAppSimulationContext, b: LocalAppSimulationContext): boolean {
  return a.steamId === b.steamId && a.steamPid === b.steamPid && a.steamStartTicks === b.steamStartTicks &&
    a.steamExe.toLowerCase() === b.steamExe.toLowerCase() && a.ownerPid === b.ownerPid && a.ownerStartTicks === b.ownerStartTicks
}
export async function readLocalAppSimulationContext(): Promise<LocalAppSimulationContext> {
  if (process.platform !== 'win32') throw new Error('Local app simulation requires Windows')
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$config=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam'
$active=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess'
$steam=Get-Process -Id ([int]$active.pid)
$owner=Get-Process -Id ${process.pid}
if($steam.ProcessName -ine 'steam' -or $null -eq $config.RunningAppID){throw 'Steam unavailable'}
$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$steam.Id)).ExecutablePath
if(!$image -or !$config.SteamExe -or ![IO.Path]::GetFullPath($image).Equals([IO.Path]::GetFullPath([string]$config.SteamExe),[StringComparison]::OrdinalIgnoreCase)){throw 'Steam identity unavailable'}
$account=[long]$active.ActiveUser
if($account -lt 0){$account+=4294967296}
if($account -le 0 -or $account -gt [uint32]::MaxValue){throw 'Steam user unavailable'}
$keys=@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\Apps' -ErrorAction Stop)
if($keys.Count -gt 4096){throw 'Activity unavailable'}
$running=@(foreach($key in $keys){$item=Get-ItemProperty -LiteralPath $key.PSPath;if($null -ne $item.Running -and [long]$item.Running -ne 0){if($key.PSChildName -notmatch '^[0-9]+$'){throw 'Activity unavailable'};[long]$key.PSChildName}})
@{appId=[int]$config.RunningAppID;steamId=([uint64]0x0110000100000000+[uint64]$account).ToString();steamPid=$steam.Id;steamStartTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();steamExe=$image;activeAppIds=@($running);ownerPid=$owner.Id;ownerStartTicks=$owner.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress -Depth 4`
  const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8' })
  const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as LocalAppSimulationContext
  if (!validLocalAppContext(value) || value.ownerPid !== process.pid) throw new Error('Local app context unavailable')
  return { ...value, steamExe: await realpath(value.steamExe) }
}
