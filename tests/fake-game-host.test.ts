import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface Metadata { architecture: string; bytes: number; sha256: string; fileName: string }
interface Options { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; outputDirectory?: string; run?: typeof spawnSync }
interface Builder {
  inspectFakeGameHost(bytes: Buffer): Metadata
  fakeGameHostBuildPlan(options?: Options): { source: string; outputDirectory: string; compiler: string; fileName: string }
  buildFakeGameHost(options?: Options): Metadata
}
const { inspectFakeGameHost, fakeGameHostBuildPlan, buildFakeGameHost } = await import(new URL('../scripts/build-fake-game-host.mjs', import.meta.url).href) as Builder
const project = fileURLToPath(new URL('../', import.meta.url))
const source = join(project, 'scripts', 'fake-game-host.cs')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const folders: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'fake-game-host-tests-')); folders.push(root); return root }
afterAll(() => { for (const root of folders) { expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true); rmSync(root, { recursive: true, force: true }) } })

function image() {
  const bytes = Buffer.alloc(256); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x14c, 68); bytes.writeUInt16LE(0x10b, 88); bytes.writeUInt16LE(2, 156)
  return bytes
}
function fixture() {
  const root = temporary(); mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts', 'fake-game-host.cs'), 'fixture')
  const csc = join(root, 'fake-csc.exe'); writeFileSync(csc, 'fixture')
  return { root, platform: 'win32', windowsDirectory: root, compiler: csc }
}

describe('fake-game host build and production boundaries', () => {
  it('has no Steam API, network transport, remote memory access or external process termination', () => {
    const code = readFileSync(source, 'utf8').replace(/#if FAKE_GAME_HOST_TEST[\s\S]*?#else\n([\s\S]*?)#endif/g, '$1').replace(/#if FAKE_GAME_HOST_TEST[\s\S]*?#endif/g, '')
    for (const forbidden of ['SteamAPI', 'steam_api', 'steam_appid', 'steamclient', 'LoadLibrary', 'MainModule', 'ReadProcessMemory', 'OpenProcess', 'TcpClient', 'HttpClient', 'WebSocket', '.Kill(', 'Process.Start(']) expect(code).not.toContain(forbidden)
    expect(code.match(/DllImport\(/g)).toHaveLength(1); expect(code).toContain('GetNamedPipeClientProcessId')
    expect(code).toContain('process.StartTime.ToUniversalTime().Ticks == ticks')
    expect(code).toContain('security.SetAccessRuleProtection(true, false)'); expect(code).toContain('WellKnownSidType.NetworkSid')
    expect(code).toContain('clientPid != (uint)binding.OwnerPid')
    expect(code).toContain('binding.Token = null; hello.Token = null')
    expect(code).toContain('ConnectTimeoutMs = 15000'); expect(code).toContain('HeartbeatTimeoutMs = 15000')
    expect(code).not.toContain('Console.WriteLine'); expect(code).not.toContain('Environment.SetEnvironmentVariable')
  })
  it('defaults to an ignored build folder without touching packaging or Steam', () => {
    const f = fixture(); const plan = fakeGameHostBuildPlan(f)
    expect(plan.outputDirectory).toBe(join(f.root, 'out', 'fake-game-host')); expect(plan.fileName).toBe('fake-game-host.exe')
    expect(plan.source).toBe(join(f.root, 'scripts', 'fake-game-host.cs'))
  })
  it('refuses unsupported and relative build paths', () => {
    expect(() => fakeGameHostBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
    expect(() => fakeGameHostBuildPlan({ ...fixture(), root: 'relative' })).toThrow('absolute')
    expect(() => fakeGameHostBuildPlan({ ...fixture(), compiler: 'relative' })).toThrow('not found')
    expect(() => fakeGameHostBuildPlan({ ...fixture(), outputDirectory: 'relative' })).toThrow('absolute')
  })
  it('builds GUI AnyCPU with csc only and validates before atomic publish', () => {
    const f = fixture(); const run = vi.fn((_compiler: string, args: readonly string[]) => { writeFileSync(args.find(value => value.startsWith('/out:'))!.slice(5), image()); return { status: 0 } })
    const metadata = buildFakeGameHost({ ...f, run: run as unknown as typeof spawnSync })
    expect(metadata).toMatchObject({ architecture: 'anycpu', fileName: 'fake-game-host.exe' }); expect(metadata.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['/platform:anycpu', '/target:winexe', '/warnaserror+', '/reference:System.Web.Extensions.dll']))
    expect(readFileSync(join(f.root, 'out', 'fake-game-host', metadata.fileName))).toEqual(image())
  })
  it('does not publish invalid compiler output or disclose compiler errors', () => {
    const f = fixture(); const run = vi.fn(() => ({ status: 1, stderr: 'fixture-private-error' }))
    expect(() => buildFakeGameHost({ ...f, run: run as unknown as typeof spawnSync })).toThrow('Fake game host compilation failed')
    expect(existsSync(join(f.root, 'out', 'fake-game-host', 'fake-game-host.exe'))).toBe(false)
    expect(() => inspectFakeGameHost(Buffer.alloc(256))).toThrow('Invalid')
    const wrong = image(); wrong.writeUInt16LE(3, 156); expect(() => inspectFakeGameHost(wrong)).toThrow('GUI')
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('private managed fixtures (never a user Steam process)', () => {
  let executable = ''
  beforeAll(() => {
    const output = temporary(); executable = join(output, 'fake-host-fixture.exe')
    const built = spawnSync(compiler, ['/nologo', '/platform:anycpu', '/target:exe', '/define:FAKE_GAME_HOST_TEST', '/optimize+', '/debug-', '/warnaserror+', '/reference:System.Web.Extensions.dll', `/out:${executable}`, source], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    expect(built.status, built.stdout + built.stderr).toBe(0)
  })
  it('compiles the real host as a GUI binary without executing it', () => {
    const outputDirectory = temporary(); const metadata = buildFakeGameHost({ outputDirectory })
    expect(metadata.architecture).toBe('anycpu'); expect(metadata.bytes).toBeGreaterThan(1000)
  })
  it.each([
    ['success', 0], ['long-lived', 0], ['owner-exit', 70], ['steam-exit', 70], ['owner-reused', 70], ['steam-reused', 70],
    ['wrong-client', 65], ['wrong-token', 65], ['before-hello', 65], ['replay-hello', 65], ['extra-key', 65], ['duplicate-key', 65], ['unknown-op', 65], ['malformed', 65], ['oversized', 65],
    ['connect-timeout', 75], ['hello-timeout', 76], ['heartbeat-timeout', 76], ['disconnect', 74]
  ])('handles %s without touching any external process (host exit %s)', (scenario, code) => {
    const result = spawnSync(executable, ['--test-scenario', String(scenario)], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(JSON.parse(result.stdout.trim())).toEqual({ exitCode: code })
  })
  it.each([{ args: [] }, { args: ['--pipe', '../unsafe'] }, { args: ['--test-not-a-production-operation'] }])('rejects invalid argument shape without opening a pipe: %j', ({ args }) => {
    const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 4000 })
    expect(result.status).toBe(64); expect(result.stdout + result.stderr).toBe('')
  })
})
