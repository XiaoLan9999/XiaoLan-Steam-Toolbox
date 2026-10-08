import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { UpdateAsset, UpdateManifest, UpdatePackageKind } from '../shared/update-types'

export interface ReadyUpdate { path: string; asset: UpdateAsset; manifest: UpdateManifest }
export interface InstallationOptions { packageKind: UpdatePackageKind; cacheDirectory: string; portableTarget?: string; parentPid?: number }
export interface InstallationPlan { helperPath: string; arguments: string[]; launch(): Promise<void> }

export function powershellPath(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function prepareWindowsUpdate(ready: ReadyUpdate, options: InstallationOptions): Promise<InstallationPlan> {
  if (process.platform !== 'win32') throw new Error('update.installPlatform')
  if (ready.asset.kind !== options.packageKind) throw new Error('update.installLaunch')
  const cache = await realpath(options.cacheDirectory)
  const source = await realpath(ready.path)
  const fromCache = relative(cache, source)
  const info = await lstat(ready.path)
  if (isAbsolute(fromCache) || fromCache === '..' || fromCache.startsWith('..\\') ||
    info.isSymbolicLink() || !info.isFile() || info.size !== ready.asset.size || await fileHash(source) !== ready.asset.sha256) {
    throw new Error('update.cacheInvalid')
  }
  const handle = await open(source, 'r')
  try {
    const header = Buffer.alloc(2)
    await handle.read(header, 0, 2, 0)
    if (header.toString('ascii') !== 'MZ') throw new Error('update.installLaunch')
  } finally { await handle.close() }
  let target = ''
  let originalHash = ''
  if (options.packageKind === 'portable') {
    if (!options.portableTarget || !isAbsolute(options.portableTarget)) throw new Error('update.portableTarget')
    target = await realpath(options.portableTarget)
    const targetInfo = await lstat(options.portableTarget)
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || !target.toLowerCase().endsWith('.exe') || target === source) {
      throw new Error('update.portableTarget')
    }
    originalHash = await fileHash(target)
  }
  const parentPid = options.parentPid ?? process.pid
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error('update.installLaunch')
  const identifier = randomUUID()
  const helperDirectory = join(cache, 'installer')
  await mkdir(helperDirectory, { recursive: true })
  const helperPath = join(helperDirectory, `${identifier}.ps1`)
  const acknowledgmentPath = join(helperDirectory, `${identifier}.ready`)
  const resultPath = join(helperDirectory, `${identifier}.result.json`)
  await writeFile(helperPath, `\uFEFF${INSTALLER_SCRIPT}`, { encoding: 'utf8', flag: 'wx' })
  const parameters: Record<string, string> = {
    Source: source, ExpectedHash: ready.asset.sha256, ExpectedSize: String(ready.asset.size),
    Kind: options.packageKind, ParentProcessId: String(parentPid), Acknowledgment: acknowledgmentPath, ResultFile: resultPath
  }
  if (target) { parameters.Target = target; parameters.OriginalHash = originalHash }
  const parameterScript = Object.entries(parameters).map(([name, value]) => `${name}=${powershellLiteral(value)}`).join(';')
  const helperCommand = `$updateParameters=@{${parameterScript}}; & ${powershellLiteral(helperPath)} @updateParameters`
  const encodedHelper = Buffer.from(helperCommand, 'utf16le').toString('base64')
  const launcherCommand = `Start-Process -FilePath ${powershellLiteral(powershellPath())} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedHelper}') -WindowStyle Hidden`
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(launcherCommand, 'utf16le').toString('base64')]
  return { helperPath, arguments: args, launch: async () => {
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'psmodulepath') delete environment[key]
    }
    environment.PSModulePath = join(dirname(powershellPath()), 'Modules')
    // Start-Process gives the helper its own hidden console, which survives the application's exit.
    const child = spawn(powershellPath(), args, { windowsHide: true, stdio: 'ignore', env: environment })
    try {
      await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail) })
    } catch { throw new Error('update.installLaunch') }
    child.unref()
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if (await readFile(acknowledgmentPath, 'utf8') === 'ready') return } catch { /* Await the helper's validation. */ }
      let helperFailed = false
      try { helperFailed = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/u, '')).status === 'failed' } catch { /* The helper has not completed. */ }
      if (helperFailed || (child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) throw new Error('update.installLaunch')
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error('update.installLaunch')
  } }
}

const INSTALLER_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$ExpectedHash,
  [Parameter(Mandatory=$true)][long]$ExpectedSize,
  [Parameter(Mandatory=$true)][ValidateSet('setup','portable')][string]$Kind,
  [Parameter(Mandatory=$true)][int]$ParentProcessId,
  [Parameter(Mandatory=$true)][string]$Acknowledgment,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [string]$Target,
  [string]$OriginalHash
)
$ErrorActionPreference = 'Stop'
function Get-VerifiedFileHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
try {
  $sourceFile = Get-Item -LiteralPath $Source
  if ($sourceFile.Length -ne $ExpectedSize -or (Get-VerifiedFileHash $Source) -ne $ExpectedHash) { throw 'Package verification failed' }
  if ($Kind -eq 'portable') {
    $targetFile = Get-Item -LiteralPath $Target
    $allowedProducts = @('小蓝Steam工具箱', 'XiaoLan Steam Toolbox', 'Steam Friend Commenter')
    if ($targetFile.VersionInfo.ProductName -notin $allowedProducts -or $targetFile.VersionInfo.CompanyName -ne 'XiaoLan9999') { throw 'Invalid portable program' }
    $targetDirectory = (Resolve-Path -LiteralPath $targetFile.DirectoryName).Path
    $resolvedTarget = (Resolve-Path -LiteralPath $Target).Path
    if ([IO.Path]::GetDirectoryName($resolvedTarget) -ne $targetDirectory -or (Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
  }
  [IO.File]::WriteAllText($Acknowledgment, 'ready')
  $parentProcess = $null
  try { $parentProcess = [Diagnostics.Process]::GetProcessById($ParentProcessId) } catch {}
  if ($parentProcess -and -not $parentProcess.WaitForExit(60000)) { throw 'Application has not exited' }
  if ((Get-VerifiedFileHash $Source) -ne $ExpectedHash) { throw 'Package changed before installation' }
  if ($Kind -eq 'setup') {
    Start-Process -FilePath $Source -ArgumentList @('/S','--updated','--force-run') -WindowStyle Hidden
  } else {
    if ((Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
    $suffix = [Guid]::NewGuid().ToString('N')
    $temporaryTarget = Join-Path $targetDirectory ('.xiaolan-update-' + $suffix + '.exe')
    $backupTarget = Join-Path $targetDirectory ([IO.Path]::GetFileNameWithoutExtension($Target) + '.previous-' + $suffix + '.exe')
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporaryTarget)) -ne $targetDirectory -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($backupTarget)) -ne $targetDirectory) { throw 'Invalid replacement path' }
    Copy-Item -LiteralPath $Source -Destination $temporaryTarget
    if ((Get-VerifiedFileHash $temporaryTarget) -ne $ExpectedHash) { throw 'Replacement verification failed' }
    $replaced = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        if ((Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
        [IO.File]::Replace($temporaryTarget, $Target, $backupTarget, $true); $replaced = $true; break
      } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $replaced) { throw 'Portable replacement failed' }
    try { Start-Process -FilePath $Target -ArgumentList @('--updated') } catch {
      if ((Get-VerifiedFileHash $Target) -eq $ExpectedHash -and (Get-VerifiedFileHash $backupTarget) -eq $OriginalHash) { [IO.File]::Replace($backupTarget, $Target, $null, $true) }
      throw
    }
  }
  @{status='launched';kind=$Kind} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
} catch {
  @{status='failed';message='update.installLaunch'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
  exit 1
}
`
