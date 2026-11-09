import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { UpdateAsset, UpdateManifest, UpdatePackageKind } from '../shared/update-types'

export interface ReadyUpdate { path: string; asset: UpdateAsset; manifest: UpdateManifest }
export interface InstallationOptions {
  packageKind: UpdatePackageKind
  cacheDirectory: string
  portableTarget?: string
  setupTarget?: string
  currentVersion?: string
  parentPid?: number
  healthTimeoutMs?: number
}
export interface InstallationPlan { helperPath: string; arguments: string[]; launch(): Promise<void> }

const HELPER_DIAGNOSTICS = new Set([
  'installer.packageVerification', 'installer.portableMetadata', 'installer.pathCanonicalization',
  'installer.portableHash', 'installer.parentExit', 'installer.packageChanged', 'installer.setupLaunch',
  'installer.replacementPath', 'installer.copyVerification', 'installer.atomicReplace', 'installer.restart',
  'installer.receiptVerification'
])

class UpdateLaunchError extends Error {
  readonly diagnosticCode: string
  constructor(diagnosticCode: string) {
    super('update.installLaunch')
    this.diagnosticCode = diagnosticCode
  }
}

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
    info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size !== ready.asset.size || await fileHash(source) !== ready.asset.sha256) {
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
  const requestedTarget = options.packageKind === 'portable' ? options.portableTarget : options.setupTarget
  if (options.packageKind === 'portable' || requestedTarget !== undefined) {
    if (!requestedTarget || !isAbsolute(requestedTarget)) throw new Error('update.portableTarget')
    target = await realpath(requestedTarget)
    const targetInfo = await lstat(requestedTarget)
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 1 || !target.toLowerCase().endsWith('.exe') || target.toLowerCase() === source.toLowerCase()) {
      throw new Error('update.portableTarget')
    }
    originalHash = await fileHash(target)
  }
  const parentPid = options.parentPid ?? process.pid
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error('update.installLaunch')
  const identifier = randomUUID()
  const helperDirectory = join(cache, 'installer')
  await mkdir(helperDirectory, { recursive: true })
  if ((await realpath(helperDirectory)).toLowerCase() !== helperDirectory.toLowerCase() || (await lstat(helperDirectory)).isSymbolicLink()) {
    throw new Error('update.cacheInvalid')
  }
  const targetInInstaller = target ? relative(helperDirectory, target) : '..'
  if (target && !isAbsolute(targetInInstaller) && targetInInstaller !== '..' && !targetInInstaller.startsWith('..\\')) throw new Error('update.portableTarget')
  const helperPath = join(helperDirectory, `${identifier}.ps1`)
  const acknowledgmentPath = join(helperDirectory, `${identifier}.ready`)
  const resultPath = join(helperDirectory, `${identifier}.result.json`)
  const transactionPath = join(helperDirectory, `${identifier}.transaction.json`)
  const backupPath = options.packageKind === 'portable' ? join(dirname(target), `${basename(target, target.slice(-4))}.previous-${identifier.replaceAll('-', '')}.exe`) : null
  const healthTimeoutMs = options.healthTimeoutMs ?? 90_000
  if (!Number.isInteger(healthTimeoutMs) || healthTimeoutMs < 100 || healthTimeoutMs > 90_000) throw new Error('update.installLaunch')
  await writeFile(helperPath, `\uFEFF${INSTALLER_SCRIPT}`, { encoding: 'utf8', flag: 'wx' })
  if (target) await writeFile(transactionPath, JSON.stringify({ schema: 1, id: identifier, kind: options.packageKind,
    version: ready.manifest.version, source, expectedHash: ready.asset.sha256, expectedSize: ready.asset.size,
    target, originalHash, backup: backupPath, phase: 'prepared' }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const parameters: Record<string, string> = {
    Source: source, ExpectedHash: ready.asset.sha256, ExpectedSize: String(ready.asset.size),
    Kind: options.packageKind, ParentProcessId: String(parentPid), Acknowledgment: acknowledgmentPath, ResultFile: resultPath,
    CacheDirectory: cache, ReceiptId: identifier, Version: ready.manifest.version, HealthTimeoutMs: String(healthTimeoutMs),
    HelperHash: await fileHash(helperPath)
  }
  if (target) { parameters.Target = target; parameters.OriginalHash = originalHash; parameters.TransactionFile = transactionPath }
  if (backupPath) parameters.BackupTarget = backupPath
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
    } catch { throw new UpdateLaunchError('installer.brokerSpawn') }
    child.unref()
    const acknowledgmentDeadline = Date.now() + 30_000
    while (Date.now() < acknowledgmentDeadline) {
      try { if (await readFile(acknowledgmentPath, 'utf8') === 'ready') return } catch { /* Await the helper's validation. */ }
      let helperFailure: string | null = null
      try {
        const result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/u, '')) as { status?: unknown; code?: unknown }
        if (result.status === 'failed') helperFailure = typeof result.code === 'string' && HELPER_DIAGNOSTICS.has(result.code) ? result.code : 'installer.helperFailed'
      } catch { /* The helper has not completed. */ }
      if (helperFailure) throw new UpdateLaunchError(helperFailure)
      if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) throw new UpdateLaunchError('installer.brokerExit')
      await new Promise(done => setTimeout(done, 100))
    }
    throw new UpdateLaunchError('installer.ackTimeout')
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
  [Parameter(Mandatory=$true)][string]$CacheDirectory,
  [Parameter(Mandatory=$true)][string]$ReceiptId,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$HelperHash,
  [int]$HealthTimeoutMs = 90000,
  [string]$Target,
  [string]$OriginalHash,
  [string]$TransactionFile,
  [string]$BackupTarget
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class XiaoLanUpdatePath {
  [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetLongPathName(string path, StringBuilder buffer, uint capacity);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder buffer, uint capacity, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, uint size);
  private static bool Same(string left, string right) { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }
  public static string Canonicalize(string path) {
    string full = Path.GetFullPath(path);
    if (full.Length < 3 || full[1] != ':' || full[2] != '\\') throw new IOException("Non-local update path");
    var buffer = new StringBuilder(32768);
    uint length = GetLongPathName(full, buffer, (uint)buffer.Capacity);
    if (length == 0 || length >= buffer.Capacity) throw new IOException("Path canonicalization failed");
    return Path.GetFullPath(buffer.ToString());
  }
  private static string Final(SafeFileHandle file) {
    var buffer = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(file, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity) throw new IOException("Final path unavailable");
    string value = buffer.ToString();
    if (value.StartsWith(@"\\?\")) value = value.Substring(4);
    return Path.GetFullPath(value);
  }
  private static FileInformation Information(SafeFileHandle file) {
    FileInformation value;
    if (!GetFileInformationByHandle(file, out value)) throw new IOException("File identity unavailable");
    return value;
  }
  private static SafeFileHandle OpenChecked(string path, uint access, uint share, bool directory) {
    string expected = Canonicalize(path);
    SafeFileHandle file = CreateFile(expected, access, share, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try {
      if (file.IsInvalid) throw new IOException("Update file unavailable");
      FileInformation info = Information(file);
      if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || !Same(Final(file), expected)) throw new IOException("Update path changed");
      return file;
    } catch { file.Dispose(); throw; }
  }
  private static string Hash(SafeFileHandle file) {
    using (var stream = new FileStream(file, FileAccess.Read))
    using (var algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
  }
  public static string VerifiedHash(string path) {
    using (var file = OpenChecked(path, 0x80000000, 1, false)) {
      FileInformation info = Information(file);
      if (info.Links != 1) throw new IOException("Update hardlink refused");
      return Hash(file);
    }
  }
  public static void ReplaceWithoutBackup(string source, string target) { File.Replace(source, target, null, true); }
  public static void DeleteExpected(string path, string parent, string expectedHash, long expectedSize) {
    string expected = Canonicalize(path), expectedParent = Canonicalize(parent);
    if (!Same(Path.GetDirectoryName(expected), expectedParent)) throw new IOException("Unexpected cleanup directory");
    using (var directory = OpenChecked(expectedParent, 0, 3, true))
    using (var file = OpenChecked(expected, 0x80010000, 1, false)) {
      FileInformation before = Information(file);
      long size = ((long)before.SizeHigh << 32) | before.SizeLow;
      if (before.Links != 1 || (expectedSize >= 0 && size != expectedSize)) throw new IOException("Cleanup identity mismatch");
      string digest;
      using (var algorithm = SHA256.Create()) {
        using (var view = new FileStream(new SafeFileHandle(file.DangerousGetHandle(), false), FileAccess.Read))
          digest = BitConverter.ToString(algorithm.ComputeHash(view)).Replace("-", "").ToLowerInvariant();
      }
      FileInformation after = Information(file);
      if (after.Links != 1 || before.Volume != after.Volume || before.IndexHigh != after.IndexHigh || before.IndexLow != after.IndexLow ||
          before.SizeHigh != after.SizeHigh || before.SizeLow != after.SizeLow || !Same(digest, expectedHash) || !Same(Final(file), expected) || !Same(Final(directory), expectedParent))
        throw new IOException("Cleanup file changed");
      var disposition = new Disposition { Delete = true };
      if (!SetFileInformationByHandle(file, 4, ref disposition, (uint)Marshal.SizeOf(typeof(Disposition)))) throw new IOException("Cleanup file remains busy");
    }
  }
}
'@
function Get-VerifiedFileHash([string]$Path) {
  return [XiaoLanUpdatePath]::VerifiedHash($Path)
}
function Write-AtomicReceipt([object]$Receipt) {
  $temporary = $TransactionFile + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Receipt | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  [XiaoLanUpdatePath]::ReplaceWithoutBackup($temporary, $TransactionFile)
}
function Read-OwnedReceipt([string]$Phase) {
  $file = Get-Item -LiteralPath $TransactionFile
  if ($file.Length -gt 32768 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid receipt' }
  $receipt = ([IO.File]::ReadAllText($TransactionFile) | ConvertFrom-Json)
  $keys = @('schema','id','kind','version','source','expectedHash','expectedSize','target','originalHash','backup','phase')
  if (@($receipt.PSObject.Properties).Count -ne $keys.Count -or @($receipt.PSObject.Properties.Name | Where-Object { $_ -notin $keys }).Count -ne 0 -or
      $receipt.schema -ne 1 -or $receipt.id -cne $ReceiptId -or $receipt.kind -cne $Kind -or $receipt.version -cne $Version -or $receipt.phase -cne $Phase -or
      $receipt.source -cne $Source -or $receipt.target -cne $Target -or $receipt.expectedHash -cne $ExpectedHash -or $receipt.expectedSize -ne $ExpectedSize -or
      $receipt.originalHash -cne $OriginalHash -or ($Kind -eq 'portable' -and $receipt.backup -cne $BackupTarget) -or ($Kind -eq 'setup' -and $null -ne $receipt.backup)) { throw 'Receipt changed' }
  return $receipt
}
function Test-HealthAcknowledgment {
  try {
    $file = Get-Item -LiteralPath $healthPath
    if ($file.Length -gt 32768 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $health = ([IO.File]::ReadAllText($healthPath) | ConvertFrom-Json)
    $keys = @('schema','id','version','kind','target','targetHash')
    if (@($health.PSObject.Properties).Count -ne $keys.Count -or @($health.PSObject.Properties.Name | Where-Object { $_ -notin $keys }).Count -ne 0 -or
        $health.schema -ne 1 -or $health.id -cne $ReceiptId -or $health.version -cne $Version -or $health.kind -cne $Kind -or
        $health.target -cne $Target -or $health.targetHash -notmatch '^[0-9a-f]{64}$' -or
        [XiaoLanUpdatePath]::Canonicalize($health.target) -cne $Target) { return $false }
    $actualHash = Get-VerifiedFileHash $Target
    return $actualHash -ceq $health.targetHash -and ($Kind -ne 'portable' -or $actualHash -ceq $ExpectedHash)
  } catch { return $false }
}
function Remove-OwnedFile([string]$Path, [string]$Directory, [string]$Hash, [long]$Size) {
  if ([String]::Equals([IO.Path]::GetFullPath($Path), $Target, [StringComparison]::OrdinalIgnoreCase)) { throw 'Current executable is excluded' }
  if (-not (Test-Path -LiteralPath $Path)) { return }
  [XiaoLanUpdatePath]::DeleteExpected($Path, $Directory, $Hash, $Size)
}
$failureCode = 'installer.packageVerification'
try {
  if ($ReceiptId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $Version -notmatch '^\d+\.\d+\.\d+$' -or $HealthTimeoutMs -lt 100 -or $HealthTimeoutMs -gt 90000) { throw 'Invalid update transaction' }
  $installerDirectory = [XiaoLanUpdatePath]::Canonicalize((Split-Path -Parent $ResultFile))
  $cache = [XiaoLanUpdatePath]::Canonicalize($CacheDirectory)
  if ($installerDirectory -cne (Join-Path $cache 'installer') -or $Acknowledgment -cne (Join-Path $installerDirectory ($ReceiptId + '.ready')) -or
      $ResultFile -cne (Join-Path $installerDirectory ($ReceiptId + '.result.json'))) { throw 'Invalid helper directory' }
  $Source = [XiaoLanUpdatePath]::Canonicalize($Source)
  if (-not $Source.StartsWith($cache.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package directory' }
  $sourceFile = Get-Item -LiteralPath $Source
  if ($sourceFile.Length -ne $ExpectedSize -or (Get-VerifiedFileHash $Source) -ne $ExpectedHash) { throw 'Package verification failed' }
  $receiptEnabled = -not [String]::IsNullOrEmpty($TransactionFile)
  if ($receiptEnabled) {
    $failureCode = 'installer.portableMetadata'
    $targetFile = Get-Item -LiteralPath $Target
    $allowedProducts = @('小蓝Steam工具箱', 'XiaoLan Steam Toolbox', 'Steam Friend Commenter')
    if ($targetFile.VersionInfo.ProductName -notin $allowedProducts -or $targetFile.VersionInfo.CompanyName -ne 'XiaoLan9999') { throw 'Invalid portable program' }
    $failureCode = 'installer.pathCanonicalization'
    $targetDirectory = [XiaoLanUpdatePath]::Canonicalize((Resolve-Path -LiteralPath $targetFile.DirectoryName).ProviderPath)
    $resolvedTarget = [XiaoLanUpdatePath]::Canonicalize((Resolve-Path -LiteralPath $Target).ProviderPath)
    if ([IO.Path]::GetDirectoryName($resolvedTarget) -ne $targetDirectory -or $resolvedTarget -ceq $Source) { throw 'Portable directory changed' }
    $Target = $resolvedTarget
    $originalSize = $targetFile.Length
    $failureCode = 'installer.portableHash'
    if ((Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
    $failureCode = 'installer.receiptVerification'
    if ($TransactionFile -cne (Join-Path $installerDirectory ($ReceiptId + '.transaction.json'))) { throw 'Invalid receipt path' }
    $receipt = Read-OwnedReceipt 'prepared'
    $healthPath = Join-Path $installerDirectory ($ReceiptId + '.healthy.json')
    if ($Kind -eq 'portable') {
      $plannedBackup = Join-Path $targetDirectory ([IO.Path]::GetFileNameWithoutExtension($Target) + '.previous-' + $ReceiptId.Replace('-', '') + '.exe')
      if ($BackupTarget -cne $plannedBackup -or (Test-Path -LiteralPath $BackupTarget)) { throw 'Invalid backup path' }
    }
  }
  [IO.File]::WriteAllText($Acknowledgment, 'ready')
  $parentProcess = $null
  try { $parentProcess = [Diagnostics.Process]::GetProcessById($ParentProcessId) } catch {}
  $failureCode = 'installer.parentExit'
  if ($parentProcess -and -not $parentProcess.WaitForExit(60000)) { throw 'Application has not exited' }
  $failureCode = 'installer.packageChanged'
  if ((Get-VerifiedFileHash $Source) -ne $ExpectedHash) { throw 'Package changed before installation' }
  if ($Kind -eq 'setup') {
    $failureCode = 'installer.setupLaunch'
    if ($receiptEnabled) { $receipt.phase = 'setup-started'; Write-AtomicReceipt $receipt }
    Start-Process -FilePath $Source -ArgumentList @('/S','--updated','--force-run') -WindowStyle Hidden
  } else {
    $failureCode = 'installer.portableHash'
    if ((Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
    $suffix = $ReceiptId.Replace('-', '')
    $temporaryTarget = Join-Path $targetDirectory ('.xiaolan-update-' + $suffix + '.exe')
    $failureCode = 'installer.replacementPath'
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporaryTarget)) -ne $targetDirectory -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($BackupTarget)) -ne $targetDirectory -or
        (Test-Path -LiteralPath $temporaryTarget) -or (Test-Path -LiteralPath $BackupTarget)) { throw 'Invalid replacement path' }
    Copy-Item -LiteralPath $Source -Destination $temporaryTarget
    $failureCode = 'installer.copyVerification'
    if ((Get-VerifiedFileHash $temporaryTarget) -ne $ExpectedHash) { throw 'Replacement verification failed' }
    $replaced = $false
    $failureCode = 'installer.atomicReplace'
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        if ((Get-VerifiedFileHash $Target) -ne $OriginalHash) { throw 'Portable program changed' }
        if (Test-Path -LiteralPath $BackupTarget) { throw 'Backup path changed' }
        [IO.File]::Replace($temporaryTarget, $Target, $BackupTarget, $true); $replaced = $true; break
      } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $replaced) { throw 'Portable replacement failed' }
    $failureCode = 'installer.receiptVerification'
    $receipt.phase = 'replaced'; Write-AtomicReceipt $receipt
    $failureCode = 'installer.restart'
    try { Start-Process -FilePath $Target -ArgumentList @('--updated', ('--update-receipt=' + $ReceiptId)) } catch {
      if ((Get-VerifiedFileHash $Target) -eq $ExpectedHash -and (Get-VerifiedFileHash $BackupTarget) -eq $OriginalHash) {
        $rollbackTarget = Join-Path $targetDirectory ('.xiaolan-rollback-' + $suffix + '.exe')
        if (-not (Test-Path -LiteralPath $rollbackTarget)) {
          Copy-Item -LiteralPath $BackupTarget -Destination $rollbackTarget
          if ((Get-VerifiedFileHash $rollbackTarget) -eq $OriginalHash) { [XiaoLanUpdatePath]::ReplaceWithoutBackup($rollbackTarget, $Target) }
        }
      }
      throw
    }
  }
  $result = @{status='launched';kind=$Kind}
  if ($receiptEnabled) {
    $result.cleanup = 'health-unconfirmed'
    $deadline = [DateTime]::UtcNow.AddMilliseconds($HealthTimeoutMs)
    $healthy = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-HealthAcknowledgment) { $healthy = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if ($healthy) {
      try {
        $phase = if ($Kind -eq 'portable') { 'replaced' } else { 'setup-started' }
        $null = Read-OwnedReceipt $phase
        if (-not (Test-HealthAcknowledgment)) { throw 'Health acknowledgment changed' }
        if ($Kind -eq 'portable' -and ((Get-VerifiedFileHash $BackupTarget) -cne $OriginalHash -or (Get-Item -LiteralPath $BackupTarget).Length -ne $originalSize)) { throw 'Backup changed' }
        if ((Get-VerifiedFileHash $Source) -cne $ExpectedHash -or (Get-Item -LiteralPath $Source).Length -ne $ExpectedSize) { throw 'Package changed' }
        $metadata = @($Acknowledgment, $TransactionFile, $healthPath, $PSCommandPath)
        $metadataHashes = @{}
        $metadataSizes = @{}
        foreach ($path in $metadata) {
          if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -cne $installerDirectory) { throw 'Invalid metadata directory' }
          if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path
            if ($item.Length -gt 262144) { throw 'Invalid metadata size' }
            $hash = if ($path -ceq $PSCommandPath) { $HelperHash } else { Get-VerifiedFileHash $path }
            if ($path -ceq $PSCommandPath -and (Get-VerifiedFileHash $path) -cne $HelperHash) { throw 'Helper changed' }
            $metadataHashes[$path] = $hash
            $metadataSizes[$path] = $item.Length
          }
        }
        Remove-OwnedFile $Source (Split-Path -Parent $Source) $ExpectedHash $ExpectedSize
        if ($Kind -eq 'portable') { Remove-OwnedFile $BackupTarget $targetDirectory $OriginalHash $originalSize }
        foreach ($path in $metadata) {
          if ($metadataHashes.ContainsKey($path)) { Remove-OwnedFile $path $installerDirectory $metadataHashes[$path] $metadataSizes[$path] }
        }
        $result.status = 'cleaned'; $result.cleanup = 'complete'
      } catch { $result.cleanup = 'pending' }
    }
  }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
} catch {
  @{status='failed';message='update.installLaunch';code=$failureCode} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
  exit 1
}
`
