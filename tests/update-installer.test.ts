import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWindowsUpdate, type ReadyUpdate } from '../src/main/update-installer'
import { UPDATE_REPOSITORY } from '../src/shared/update-types'

const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Windows update installation', () => {
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
      JSON.stringify({ packageKind: 'portable', cacheDirectory: cache, portableTarget: target })], { windowsHide: true }).catch(error => {
        const diagnostic = typeof error.stderr === 'string' ? error.stderr.match(/installer\.[A-Za-z]+/u)?.[0] : null
        throw new Error(`Native portable helper launch failed (${diagnostic ?? 'installer.unknown'})`)
      })
    expect(stdout.trim()).toBe('acknowledged')
    await until(async () => (await readFile(join(directory, 'started.txt'), 'utf8')) === 'new:--updated')
    expect(await readFile(target)).toEqual(await readFile(source))
    const { readdir } = await import('node:fs/promises')
    const backup = (await readdir(directory)).find(name => name.includes('.previous-') && name.endsWith('.exe'))!
    expect(await readFile(join(directory, backup))).toEqual(oldBytes)
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

async function compile(path: string, label: string) {
  const code = `using System; using System.IO; using System.Reflection;
[assembly: AssemblyCompany("XiaoLan9999")]
[assembly: AssemblyProduct("\\u5c0f\\u84ddSteam\\u5de5\\u5177\\u7bb1")]
public static class Program { public static void Main(string[] args) {
File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "started.txt"), "${label}:" + string.Join("|", args)); } }`
  const source = `${path}.cs`
  await writeFile(source, code)
  await run(join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:winexe', `/out:${path}`, source], { windowsHide: true })
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
  throw new Error('Fixture program did not restart')
}
