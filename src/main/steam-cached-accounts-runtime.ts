import { execFile, spawn } from 'node:child_process'
import { dirname, win32 } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'

const execute = promisify(execFile)
const unavailable = (): DomainError => new DomainError('STEAM_CACHE_UNAVAILABLE', 'STEAM_CACHE_UNAVAILABLE')
export function steamCachedRegistryScript(operation: 'path' | 'read' | 'write', value?: string | null): string {
  const common = `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\n$key=Get-Item -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop\n`
  if (operation === 'path') return common + `@{value=$key.GetValue('SteamExe',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}|ConvertTo-Json -Compress`
  if (operation === 'read') return common + `if(($key.GetValueNames() -contains 'AutoLoginUser') -and $key.GetValueKind('AutoLoginUser') -ne [Microsoft.Win32.RegistryValueKind]::String){throw 'Unsupported login selector kind'}\n@{value=$key.GetValue('AutoLoginUser',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}|ConvertTo-Json -Compress`
  if (value !== null && (typeof value !== 'string' || value.length > 256 || /[\0\r\n]/.test(value))) throw unavailable()
  if (value === null) return common + `if($key.GetValueNames() -contains 'AutoLoginUser'){Remove-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -Name AutoLoginUser -ErrorAction Stop}`
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  return common + `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\nSet-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -Name AutoLoginUser -Value $value -Type String -ErrorAction Stop`
}
async function run(script: string): Promise<string> {
  if (process.platform !== 'win32') throw unavailable()
  const powershell = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: 'utf8' })
    return stdout.trim().replace(/^\uFEFF/, '')
  } catch { throw unavailable() }
}
export async function readSteamCachedRoot(): Promise<string> {
  const state = JSON.parse(await run(steamCachedRegistryScript('path'))) as { value?: unknown }
  if (typeof state.value !== 'string' || !win32.isAbsolute(state.value) || win32.basename(state.value).toLowerCase() !== 'steam.exe') throw unavailable()
  return win32.dirname(state.value)
}
export async function readSteamAutoLogin(): Promise<string | null> {
  const state = JSON.parse(await run(steamCachedRegistryScript('read'))) as { value?: unknown }
  if (state.value === null) return null
  if (typeof state.value !== 'string' || state.value.length > 256 || /[\0\r\n]/.test(state.value)) throw unavailable()
  return state.value
}
export async function writeSteamAutoLogin(value: string | null): Promise<void> { await run(steamCachedRegistryScript('write', value)) }
export const steamCachedActivityScript = `$ErrorActionPreference='Stop'
$key=Get-Item -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop
if($key.GetValueNames() -notcontains 'RunningAppID'){throw 'Activity unknown'}
$running=$key.GetValue('RunningAppID',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if(($running -isnot [int] -and $running -isnot [long]) -or [long]$running -lt 0 -or [long]$running -gt 4294967295){throw 'Activity unknown'}
$active=([long]$running -ne 0)
$apps=Get-Item -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\Apps' -ErrorAction Stop
$names=@($apps.GetSubKeyNames())
if($names.Count -gt 4096){throw 'Activity unknown'}
foreach($name in $names){
 if($name -notmatch '^[0-9]+$'){throw 'Activity unknown'}
 $child=$apps.OpenSubKey($name,$false)
 if($null -eq $child){throw 'Activity unknown'}
 try { $value=$child.GetValue('Running',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if($null -ne $value){if(($value -isnot [int] -and $value -isnot [long]) -or [long]$value -lt 0){throw 'Activity unknown'};if([long]$value -ne 0){$active=$true}}
 } finally { $child.Dispose() }
}
@{active=$active}|ConvertTo-Json -Compress`
export async function assertSteamCachedGamesIdle(): Promise<void> {
  let state: { active?: unknown }
  try { state = JSON.parse(await run(steamCachedActivityScript)) as { active?: unknown } }
  catch { throw new DomainError('STEAM_CACHE_ACTIVITY_UNAVAILABLE', 'STEAM_CACHE_ACTIVITY_UNAVAILABLE') }
  if (typeof state.active !== 'boolean') throw new DomainError('STEAM_CACHE_ACTIVITY_UNAVAILABLE', 'STEAM_CACHE_ACTIVITY_UNAVAILABLE')
  if (state.active) throw new DomainError('STEAM_CACHE_GAME_RUNNING', 'STEAM_CACHE_GAME_RUNNING')
}
export async function launchSteamCachedAccount(executable: string, _accountName: string): Promise<void> {
  if (process.platform !== 'win32' || !win32.isAbsolute(executable) || win32.basename(executable).toLowerCase() !== 'steam.exe') throw unavailable()
  await new Promise<void>((accept, reject) => {
    const child = spawn(executable, ['-silent'], { cwd: dirname(executable), shell: false, windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', () => reject(new DomainError('STEAM_CACHE_LAUNCH_FAILED', 'STEAM_CACHE_LAUNCH_FAILED')))
    child.once('spawn', () => { child.unref(); accept() })
  })
}
