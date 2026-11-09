import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWindowsUpdate, type InstallationPlan, type ReadyUpdate } from '../src/main/update-installer'
import { confirmUpdateStartup } from '../src/main/update-startup'
import { UPDATE_REPOSITORY } from '../src/shared/update-types'

const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('xiaolan-installer-test-')) {
      throw new Error('Refusing to remove a path outside the installer fixture directory')
    }
    // started.txt is written before Windows releases the fixture EXE.
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 10_000)

describe.skipIf(process.platform !== 'win32')('Windows update installation', () => {
  it('accepts the real startup confirmer acknowledgment and then cleans only the isolated transaction files', async () => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'confirmed portable.exe'), source = join(cache, 'confirmed new.exe')
    await compile(target, 'old')
    await compile(source, 'new')
    const newBytes = await readFile(source)
    const antiRollback = join(cache, 'highest-manifest.json')
    await writeFile(antiRollback, 'synthetic anti-rollback marker')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, currentVersion: '0.3.0', parentPid: 2147483647, healthTimeoutMs: 8000 })
    const receipt = await transaction(plan)
    await plan.launch()
    await until(async () => (await readFile(join(directory, 'started.txt'), 'utf8')).startsWith('new:--updated'))
    expect(await confirmUpdateStartup({ cacheDirectory: cache, currentVersion: '0.4.0', packageKind: 'portable',
      currentExecutable: target, transactionId: receipt.id })).toEqual({ confirmed: true })
    await until(async () => (await result(plan)).status === 'cleaned')
    expect(await readFile(target)).toEqual(newBytes)
    expect(await readFile(antiRollback, 'utf8')).toBe('synthetic anti-rollback marker')
    for (const removed of [source, receipt.backup!]) await expect(readFile(removed)).rejects.toThrow()
  }, 60_000)

  it('atomically replaces a verified portable program after its real parent exits, retaining the old backup and restarting', async () => {
    const { directory, cache } = await fixture()
    const target = join(directory, "\u7528\u6237's renamed app.exe")
    const source = join(cache, "\u65b0\u7248's portable.exe")
    await compile(target, 'old')
    await compile(source, 'new')
    const oldBytes = await readFile(target)
    const ready = await readyUpdate(source, 'portable')
    const launcher = `
      const { prepareWindowsUpdate } = await import(process.argv[1]);
      const plan = await prepareWindowsUpdate(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
      try { await plan.launch(); } catch (error) {
        console.error(error.diagnosticCode || 'installer.unknown');
        process.exit(1);
      }
      console.log('acknowledged');
      process.exit(0);
    `
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', launcher,
      new URL('../src/main/update-installer.ts', import.meta.url).href, JSON.stringify(ready),
      JSON.stringify({ packageKind: 'portable', cacheDirectory: cache, portableTarget: target, healthTimeoutMs: 500 })], { windowsHide: true }).catch(error => {
        const diagnostic = typeof error.stderr === 'string' ? error.stderr.match(/installer\.[A-Za-z]+/u)?.[0] : null
        throw new Error(`Native portable helper launch failed (${diagnostic ?? 'installer.unknown'})`)
      })
    expect(stdout.trim()).toBe('acknowledged')
    await until(async () => /^new:--updated\|--update-receipt=[a-f0-9-]+$/.test(await readFile(join(directory, 'started.txt'), 'utf8')))
    expect(await readFile(target)).toEqual(await readFile(source))
    const { readdir } = await import('node:fs/promises')
    const backup = (await readdir(directory)).find(name => name.includes('.previous-') && name.endsWith('.exe'))!
    expect(await readFile(join(directory, backup))).toEqual(oldBytes)
    await until(async () => {
      const files = await readdir(join(cache, 'installer'))
      const result = files.find(name => name.endsWith('.result.json'))
      return !!result && JSON.parse((await readFile(join(cache, 'installer', result), 'utf8')).replace(/^\uFEFF/, '')).cleanup === 'health-unconfirmed'
    })
  }, 60_000)

  it('starts the verified NSIS package with update/restart arguments after the parent exits', async () => {
    const { cache } = await fixture()
    const source = join(cache, 'setup-new.exe')
    await compile(source, 'setup')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'setup'), {
      packageKind: 'setup', cacheDirectory: cache, parentPid: 2147483647
    })
    await plan.launch()
    await until(async () => (await readFile(join(cache, 'started.txt'), 'utf8')) === 'setup:/S|--updated|--force-run')
  }, 60_000)

  it('cleans only its exact old backup and downloaded package after the new portable fixture confirms health', async () => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'portable.exe'), source = join(cache, 'new.exe')
    await compile(target, 'old')
    const oldBytes = await readFile(target)
    await compile(source, 'new', { healthCache: cache })
    const newBytes = await readFile(source)
    const unrelatedBackup = join(directory, 'portable.previous-unrelated.exe')
    const task = join(directory, 'tasks.sqlite3'), log = join(directory, 'diagnostic.log')
    await writeFile(unrelatedBackup, oldBytes)
    await writeFile(task, 'synthetic task data')
    await writeFile(log, 'synthetic diagnostic log')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, currentVersion: '0.3.0', parentPid: 2147483647, healthTimeoutMs: 3000 })
    const receipt = await transaction(plan)
    expect(receipt.backup).toBe(join(directory, `portable.previous-${receipt.id.replaceAll('-', '')}.exe`))
    expect(receipt).toMatchObject({ schema: 1, kind: 'portable', version: '0.4.0', phase: 'prepared', source, target })
    await plan.launch()
    await until(async () => (await result(plan)).status === 'cleaned')
    expect(await readFile(target)).toEqual(newBytes)
    for (const removed of [source, receipt.backup!, plan.helperPath, receiptPath(plan), healthyPath(plan), plan.helperPath.replace(/\.ps1$/, '.ready')]) {
      await expect(readFile(removed)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(unrelatedBackup)).toEqual(oldBytes)
    expect(await readFile(task, 'utf8')).toBe('synthetic task data')
    expect(await readFile(log, 'utf8')).toBe('synthetic diagnostic log')
  }, 60_000)

  it('preserves the running portable target even when its original path is inside an older cache-version directory', async () => {
    const { cache } = await fixture()
    await mkdir(join(cache, 'v0.3.0'))
    await mkdir(join(cache, 'v0.4.0'))
    const target = join(cache, 'v0.3.0', 'old-name.exe'), source = join(cache, 'v0.4.0', 'new.exe')
    await compile(target, 'old')
    await compile(source, 'new', { healthCache: cache })
    const bytes = await readFile(source)
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, parentPid: 2147483647, healthTimeoutMs: 3000 })
    await plan.launch()
    await until(async () => (await result(plan)).status === 'cleaned')
    expect(await readFile(target)).toEqual(bytes)
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('cleans the known setup package after a fixture installer replaces the known target and the installed fixture confirms health', async () => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'installed.exe'), source = join(cache, 'setup-new.exe')
    await compile(target, 'old')
    await compile(source, 'setup', { healthCache: cache, installTarget: target })
    const bytes = await readFile(source)
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'setup'), { packageKind: 'setup', cacheDirectory: cache,
      setupTarget: target, currentVersion: '0.3.0', parentPid: 2147483647, healthTimeoutMs: 3000 })
    expect(await transaction(plan)).toMatchObject({ kind: 'setup', target, backup: null, phase: 'prepared' })
    await plan.launch()
    await until(async () => (await result(plan)).status === 'cleaned')
    expect(await readFile(target)).toEqual(bytes)
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each(['version', 'id', 'kind', 'target', 'targetHash'] as const)('retains both programs when the health acknowledgment has a wrong %s', async field => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'portable.exe'), source = join(cache, 'new.exe')
    await compile(target, 'old')
    await compile(source, 'new')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, parentPid: 2147483647, healthTimeoutMs: 1000 })
    await plan.launch()
    await until(async () => (await transaction(plan)).phase === 'replaced')
    const receipt = await transaction(plan)
    const ack = await health(receipt)
    if (field === 'version') ack.version = '0.5.0'
    if (field === 'id') ack.id = '11111111-1111-4111-8111-111111111111'
    if (field === 'kind') ack.kind = 'setup'
    if (field === 'target') ack.target = source
    if (field === 'targetHash') ack.targetHash = '0'.repeat(64)
    await writeFile(healthyPath(plan), JSON.stringify(ack))
    await until(async () => (await result(plan)).cleanup === 'health-unconfirmed')
    expect((await readFile(source)).length).toBeGreaterThan(0)
    expect((await readFile(receipt.backup!)).length).toBeGreaterThan(0)
    expect((await transaction(plan)).phase).toBe('replaced')
  }, 60_000)

  it.each(['source hash', 'backup hash', 'backup hardlink', 'receipt path'] as const)('treats %s cleanup failure as a pending cleanup, preserving the backup and source', async issue => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'portable.exe'), source = join(cache, 'new.exe')
    await compile(target, 'old')
    await compile(source, 'new')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, parentPid: 2147483647, healthTimeoutMs: 3000 })
    await plan.launch()
    await until(async () => (await transaction(plan)).phase === 'replaced')
    const receipt = await transaction(plan)
    if (issue === 'source hash' || issue === 'backup hash') {
      const changed = issue === 'source hash' ? source : receipt.backup!
      const bytes = await readFile(changed)
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
      await writeFile(changed, bytes)
    }
    if (issue === 'backup hardlink') await link(receipt.backup!, join(directory, 'other-hardlink.exe'))
    if (issue === 'receipt path') await writeFile(receiptPath(plan), JSON.stringify({ ...receipt, backup: join(directory, 'unrelated.exe') }))
    await writeFile(healthyPath(plan), JSON.stringify(await health(receipt)))
    await until(async () => (await result(plan)).cleanup === 'pending')
    expect((await result(plan)).status).toBe('launched')
    expect((await readFile(source)).length).toBeGreaterThan(0)
    expect((await readFile(receipt.backup!)).length).toBeGreaterThan(0)
  }, 60_000)

  it('restores the old portable on launch failure while retaining the exact backup and source for recovery', async () => {
    const { directory, cache } = await fixture()
    const target = join(directory, 'portable.exe'), source = join(cache, 'invalid-new.exe')
    await compile(target, 'old')
    const old = await readFile(target)
    await writeFile(source, 'MZnot-an-executable')
    const plan = await prepareWindowsUpdate(await readyUpdate(source, 'portable'), { packageKind: 'portable', cacheDirectory: cache,
      portableTarget: target, parentPid: 2147483647, healthTimeoutMs: 500 })
    const receipt = await transaction(plan)
    await plan.launch()
    await until(async () => (await result(plan)).status === 'failed')
    expect((await result(plan)).code).toBe('installer.restart')
    expect(await readFile(target)).toEqual(old)
    expect(await readFile(receipt.backup!)).toEqual(old)
    expect(await readFile(source, 'utf8')).toBe('MZnot-an-executable')
  }, 60_000)

  it('rejects files outside the update cache and catches tampering both before and after launch preparation', async () => {
    const { directory, cache } = await fixture()
    const source = join(cache, 'new.exe')
    await writeFile(source, 'MZoriginal-package')
    const ready = await readyUpdate(source, 'setup')
    await writeFile(source, 'MZtampered-package')
    await expect(prepareWindowsUpdate(ready, { packageKind: 'setup', cacheDirectory: cache })).rejects.toThrow('update.cacheInvalid')
    const outside = join(directory, 'outside.exe')
    await writeFile(outside, 'MZoutside')
    await expect(prepareWindowsUpdate(await readyUpdate(outside, 'setup'), { packageKind: 'setup', cacheDirectory: cache })).rejects.toThrow('update.cacheInvalid')
    const compiled = join(cache, 'verified-new.exe')
    await compile(compiled, 'must-not-run')
    const plan = await prepareWindowsUpdate(await readyUpdate(compiled, 'setup'), { packageKind: 'setup', cacheDirectory: cache, parentPid: 2147483647 })
    const tamperedBytes = await readFile(compiled)
    tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 1
    await writeFile(compiled, tamperedBytes)
    await expect(plan.launch()).rejects.toThrow('update.installLaunch')
    await expect(readFile(join(cache, 'started.txt'))).rejects.toThrow()
  }, 60_000)
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolan-installer-test-'))
  directories.push(directory)
  const cache = join(directory, 'cache')
  await mkdir(cache)
  return { directory, cache }
}

async function compile(path: string, label: string, options: { healthCache?: string; installTarget?: string } = {}) {
  const installed = options.installTarget ? `if(!String.Equals(Assembly.GetExecutingAssembly().Location, ${JSON.stringify(options.installTarget)}, StringComparison.OrdinalIgnoreCase)) {
File.Copy(Assembly.GetExecutingAssembly().Location, ${JSON.stringify(options.installTarget)}, true);
System.Diagnostics.Process.Start(${JSON.stringify(options.installTarget)}, "--updated"); return; }` : ''
  const healthy = options.healthCache ? `string id = null;
foreach(string argument in args) if(argument.StartsWith("--update-receipt=")) id = argument.Substring(17);
string installer = Path.Combine(${JSON.stringify(options.healthCache)}, "installer");
string receiptFile = id == null ? Directory.GetFiles(installer, "*.transaction.json")[0] : Path.Combine(installer, id + ".transaction.json");
var json = new System.Web.Script.Serialization.JavaScriptSerializer();
var receipt = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(receiptFile));
id = (string)receipt["id"];
string target = (string)receipt["target"], digest;
using(var hash = System.Security.Cryptography.SHA256.Create()) using(var input = File.OpenRead(target)) digest = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
var ack = new System.Collections.Generic.Dictionary<string, object> { {"schema",1},{"id",id},{"version",receipt["version"]},{"kind",receipt["kind"]},{"target",target},{"targetHash",digest} };
string healthy = Path.Combine(installer, id + ".healthy.json");
File.WriteAllText(healthy + ".tmp", json.Serialize(ack), new System.Text.UTF8Encoding(false)); File.Move(healthy + ".tmp", healthy);` : ''
  const code = `using System; using System.IO; using System.Reflection;
[assembly: AssemblyCompany("XiaoLan9999")]
[assembly: AssemblyProduct("\\u5c0f\\u84ddSteam\\u5de5\\u5177\\u7bb1")]
[assembly: AssemblyFileVersion("${label === 'old' ? '0.3.0.0' : '0.4.0.0'}")]
[assembly: AssemblyInformationalVersion("${label === 'old' ? '0.3.0' : '0.4.0'}")]
public static class Program { public static void Main(string[] args) {
${installed}
File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "started.txt"), "${label}:" + string.Join("|", args));
${healthy}
} }`
  const source = `${path}.cs`
  await writeFile(source, code)
  await run(join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:winexe', '/reference:System.Web.Extensions.dll', `/out:${path}`, source], { windowsHide: true })
}

interface Transaction { schema: number; id: string; kind: 'portable' | 'setup'; version: string; source: string; target: string; expectedHash: string; backup: string | null; phase: string }
function receiptPath(plan: InstallationPlan): string { return plan.helperPath.replace(/\.ps1$/, '.transaction.json') }
function healthyPath(plan: InstallationPlan): string { return plan.helperPath.replace(/\.ps1$/, '.healthy.json') }
async function transaction(plan: InstallationPlan): Promise<Transaction> { return JSON.parse(await readFile(receiptPath(plan), 'utf8')) as Transaction }
async function result(plan: InstallationPlan): Promise<{ status: string; cleanup?: string; code?: string }> {
  return JSON.parse((await readFile(plan.helperPath.replace(/\.ps1$/, '.result.json'), 'utf8')).replace(/^\uFEFF/, '')) as { status: string; cleanup?: string; code?: string }
}
async function health(receipt: Transaction): Promise<{ schema: number; id: string; version: string; kind: string; target: string; targetHash: string }> {
  return { schema: 1, id: receipt.id, version: receipt.version, kind: receipt.kind, target: receipt.target,
    targetHash: createHash('sha256').update(await readFile(receipt.target)).digest('hex') }
}

async function readyUpdate(path: string, kind: 'setup' | 'portable'): Promise<ReadyUpdate> {
  const bytes = await readFile(path)
  const asset = { kind, fileName: `XiaoLan-Steam-Toolbox-${kind === 'setup' ? 'Setup' : 'Portable'}-0.4.0-x64.exe`,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    downloadUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.4.0/example.exe` }
  return { path, asset, manifest: { schema: 1, repository: UPDATE_REPOSITORY, version: '0.4.0',
    publishedAt: new Date().toISOString(), releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v0.4.0`, assets: [asset] } }
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const restartDeadline = Date.now() + 20_000
  while (Date.now() < restartDeadline) {
    try { if (await condition()) return } catch { /* Wait for the isolated fixture process. */ }
    await new Promise(done => setTimeout(done, 100))
  }
  const diagnostics: unknown[] = []
  for (const directory of directories) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xiaolan-installer-test-')) continue
    const installer = join(directory, 'cache', 'installer')
    for (const file of await readdir(installer).catch(() => [])) {
      if (file.endsWith('.result.json')) diagnostics.push(JSON.parse((await readFile(join(installer, file), 'utf8')).replace(/^\uFEFF/, '')))
    }
  }
  throw new Error(`Fixture program did not reach the expected state: ${JSON.stringify(diagnostics)}`)
}
