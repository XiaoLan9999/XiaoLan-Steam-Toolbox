import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

interface WorkerMetadata { architecture: 'x86' | 'x64'; bytes: number; sha256: string; fileName?: string }
interface BuildOptions { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; run?: typeof spawnSync }
interface BuildModule {
  inspectNativeWorker(binary: Buffer, architecture: string): WorkerMetadata
  nativePresenceBuildPlan(options?: BuildOptions): { source: string; publicSource: string; profileSource: string; output: string; compiler: string; workers: Array<{ architecture: string; fileName: string }> }
  buildNativePresence(options?: BuildOptions): WorkerMetadata[]
}
interface Reply { v: number; requestId: string; op: string; ok: boolean; acceptedKeys: string[]; mayHaveWritten: boolean; code?: string; keyCount?: number; fields?: Record<string, string>; localizedString?: string | null; displayTokenReadable?: boolean; verificationSource?: string }
interface LifecycleReply { v: 1; requestId: 'lifecycle'; op: 'lifecycle'; stage: string; ok: boolean | null; elapsedMs: number }

const project = fileURLToPath(new URL('../', import.meta.url))
const { inspectNativeWorker, nativePresenceBuildPlan, buildNativePresence } = await import(new URL('../scripts/build-native-presence.mjs', import.meta.url).href) as BuildModule
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const folders: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'native-presence-test-'))
  folders.push(root)
  return root
}
function clean() {
  for (const root of folders.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
}
function pe(architecture: string) {
  const bytes = Buffer.alloc(256)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(architecture === 'x86' ? 0x14c : 0x8664, 68)
  bytes.writeUInt16LE(architecture === 'x86' ? 0x10b : 0x20b, 88)
  return bytes
}
function buildFixture() {
  const root = temporary()
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'native-presence-worker.cs'), 'fixture-source')
  writeFileSync(join(root, 'scripts', 'native-presence-public-backend.cs'), 'fixture-public-source')
  writeFileSync(join(root, 'scripts', 'steam-public-interface-profiles.cs'), 'fixture-profile-source')
  mkdirSync(join(root, 'src', 'shared'), { recursive: true })
  writeFileSync(join(root, 'src', 'shared', 'rich-presence-contract.json'), readFileSync(join(project, 'src', 'shared', 'rich-presence-contract.json')))
  writeFileSync(join(root, 'scripts', 'rich-presence-contract.generated.cs'), readFileSync(join(project, 'scripts', 'rich-presence-contract.generated.cs')))
  const csc = join(root, 'fixture-csc.exe')
  writeFileSync(csc, 'fixture-compiler')
  return { root, platform: 'win32', windowsDirectory: root, compiler: csc }
}
function compileFixture(_command: string, args: readonly string[]) {
  const architecture = args.find(argument => argument.startsWith('/platform:'))!.slice('/platform:'.length)
  const target = args.find(argument => argument.startsWith('/out:'))!.slice('/out:'.length)
  writeFileSync(target, pe(architecture))
  return { status: 0 }
}
afterAll(clean)

describe('source-built native presence workers', () => {
  it('uses only direct, bound public interfaces with no initialization or callback fallback', () => {
    const source = readFileSync(join(project, 'scripts', 'native-presence-worker.cs'), 'utf8') + readFileSync(join(project, 'scripts', 'native-presence-public-backend.cs'), 'utf8')
    for (const forbidden of ['SteamAPI_Init', 'SteamAPI_Shutdown', 'SteamAPI_RunCallbacks', 'SteamAPI_ManualDispatch', 'SteamInternal_CreateInterface', 'Steam_ReleaseThreadLocalMemory', 'SteamAPI_ReleaseCurrentThreadMemory', 'RequestFriendRichPresence', 'ClearRichPresence', 'RestartAppIfNecessary', 'BShutdownIfAllPipesClosed']) expect(source).not.toContain(forbidden)
    expect(source).toContain('args.Length != 12')
    expect(source).toContain('args[10]')
    expect(source).toContain('args[11]')
    expect(source).toContain('value.SteamImage = Path.Combine(Path.GetDirectoryName(value.ClientDll), "steam.exe")')
    expect(source).toContain('ProcessState(SteamPid, SteamTicks, SteamImage)')
    expect(source).toContain('Registry.CurrentUser.OpenSubKey(@"Software\\Valve\\Steam\\ActiveProcess", false)')
    expect(source).toContain('active.GetValue("pid"')
    expect(source).toContain('active.GetValue("ActiveUser"')
    expect(source).toContain('int code = binding.ContextCode()')
    expect(source).toContain('OpenProcess(0x1000u, false, processId)')
    expect(source).toContain('QueryFullProcessImageNameW(process, 0, image, ref size)')
    expect(source).toContain('finally { CloseHandle(process); }')
    for (const forbidden of ['MainModule', 'ReadProcessMemory', 'PROCESS_VM_READ', 'SetValue(', 'CreateSubKey(', 'EnvironmentVariableTarget.User', 'EnvironmentVariableTarget.Machine']) expect(source).not.toContain(forbidden)
    expect(source).toContain('CreateInterfaceCall(IntPtr version, IntPtr returnCode)')
    expect(source).toContain('clientLibrary.Require<CreateInterfaceCall>("CreateInterface")')
    expect(source).toContain('CString("SteamClient021")')
    expect(source).toContain('releaseUser(client, pipe, ownUser)')
    expect(source).toContain('releasePipe(client, pipe)')
    expect(source).toContain('public bool HasExport(string name) { return GetProcAddress(Handle, name) != IntPtr.Zero; }')
    expect(source).toContain('number <= 999')
    expect(source).toContain('selectedInterfaces = SelectInterfaces(apiLibrary.HasExport)')
    expect(source.indexOf('selectedInterfaces = SelectInterfaces(apiLibrary.HasExport)')).toBeLessThan(source.indexOf('pipe = createPipe(client)'))
    expect(source).toContain('RequireUserInterface("SteamAPI_ISteamClient_GetISteamFriends", selectedInterfaces.Friends)')
    expect(source).toContain('RequireUserInterface("SteamAPI_ISteamClient_GetISteamUser", selectedInterfaces.User)')
    expect(source).toContain('RequirePipeInterface("SteamAPI_ISteamClient_GetISteamUtils", selectedInterfaces.Utils)')
    expect(source).not.toContain('params string[] versions')
    expect(source).not.toContain('D:\\Steam')
    expect(source).not.toContain('SteamNoOverlayUI')
  })
  it('creates the agreed separate x86/x64 resource names without a Valve dependency', () => {
    const fixture = buildFixture()
    const plan = nativePresenceBuildPlan(fixture)
    expect(plan.output).toBe(join(fixture.root, 'resources', 'native-presence'))
    expect(plan.workers).toEqual([{ architecture: 'x86', fileName: 'worker-x86.exe' }, { architecture: 'x64', fileName: 'worker-x64.exe' }])
    expect(plan.source).toBe(join(fixture.root, 'scripts', 'native-presence-worker.cs'))
    expect(plan.publicSource).toBe(join(fixture.root, 'scripts', 'native-presence-public-backend.cs'))
    expect(plan.profileSource).toBe(join(fixture.root, 'scripts', 'steam-public-interface-profiles.cs'))
  })
  it('refuses unsupported hosts instead of silently packaging a missing worker', () => {
    expect(() => nativePresenceBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
  })
  it('requires absolute compiler and root paths', () => {
    expect(() => nativePresenceBuildPlan({ ...buildFixture(), root: 'relative' })).toThrow('absolute')
    expect(() => nativePresenceBuildPlan({ ...buildFixture(), compiler: 'relative' })).toThrow('not found')
  })
  it('compiles both architectures with no shell and validates the PE header before publishing', () => {
    const fixture = buildFixture()
    const run = vi.fn(compileFixture)
    const workers = buildNativePresence({ ...fixture, run: run as unknown as typeof spawnSync })
    expect(workers.map(worker => worker.fileName)).toEqual(['worker-x86.exe', 'worker-x64.exe'])
    expect(workers.every(worker => worker.bytes === 256 && /^[a-f0-9]{64}$/.test(worker.sha256))).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    for (const call of run.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>) {
      expect(call[2]).toMatchObject({ windowsHide: true, cwd: fixture.root, timeout: 120000 })
      expect(call[2].shell).toBeUndefined()
      expect(call[1]).toContain('/warnaserror+')
      expect(call[1]).not.toContain('/define:NATIVE_PRESENCE_TEST')
      expect(call[1]).toContain(join(fixture.root, 'scripts', 'native-presence-public-backend.cs'))
      expect(call[1]).toContain(join(fixture.root, 'scripts', 'steam-public-interface-profiles.cs'))
    }
    expect(readdirSync(join(fixture.root, 'resources', 'native-presence')).sort()).toEqual(['worker-x64.exe', 'worker-x86.exe'])
    expect(JSON.stringify(workers)).not.toContain(fixture.root)
  })
  it('keeps old packaged workers if either staged compilation fails, without exposing compiler output', () => {
    const fixture = buildFixture()
    const output = join(fixture.root, 'resources', 'native-presence')
    mkdirSync(output, { recursive: true })
    for (const architecture of ['x86', 'x64']) writeFileSync(join(output, `worker-${architecture}.exe`), 'previous-worker')
    const run = (command: string, args: readonly string[]) => args.includes('/platform:x64') ? { status: 1, stdout: 'must-not-expose-sensitive-compiler-output' } : compileFixture(command, args)
    expect(() => buildNativePresence({ ...fixture, run: run as unknown as typeof spawnSync })).toThrow('Native presence x64 compilation failed')
    for (const architecture of ['x86', 'x64']) expect(readFileSync(join(output, `worker-${architecture}.exe`), 'utf8')).toBe('previous-worker')
    expect(readdirSync(output).sort()).toEqual(['worker-x64.exe', 'worker-x86.exe'])
  })
  it.each(['x86', 'x64'])('recognizes %s PE output and rejects cross-architecture output', architecture => {
    expect(inspectNativeWorker(pe(architecture), architecture)).toMatchObject({ architecture, bytes: 256 })
    expect(() => inspectNativeWorker(pe(architecture === 'x86' ? 'x64' : 'x86'), architecture)).toThrow('architecture mismatch')
  })
  it.each([Buffer.alloc(0), Buffer.alloc(256), Buffer.alloc(2 * 1024 * 1024 + 1)])('rejects malformed or oversized compiler output', bytes => {
    expect(() => inspectNativeWorker(bytes, 'x86')).toThrow('Invalid native presence worker')
  })
  it('rejects overflowing PE offsets without an out-of-bounds read', () => {
    const bytes = pe('x86')
    bytes.writeUInt32LE(0xffffffff, 0x3c)
    expect(() => inspectNativeWorker(bytes, 'x86')).toThrow('architecture mismatch')
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('compiled worker protocol with test-only fake API', () => {
  let testExe = ''
  let testExe64 = ''
  beforeAll(() => {
    const folder = temporary()
    testExe = join(folder, 'test-worker-x86.exe'); testExe64 = join(folder, 'test-worker-x64.exe')
    for (const architecture of ['x86', 'x64']) {
      const file = architecture === 'x86' ? testExe : testExe64
      const result = spawnSync(compiler, ['/nologo', `/platform:${architecture}`, '/target:exe', '/optimize+', '/warnaserror+', '/define:NATIVE_PRESENCE_TEST', `/out:${file}`, join(project, 'scripts', 'native-presence-worker.cs'), join(project, 'scripts', 'native-presence-public-backend.cs'), join(project, 'scripts', 'rich-presence-contract.generated.cs'), join(project, 'scripts', 'steam-public-interface-profiles.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(inspectNativeWorker(readFileSync(file), architecture).bytes).toBeGreaterThan(1000)
    }
  })
  afterEach(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    children.clear()
  })
  function once(line: string, rejectAt = 0, guardAt = 0, profile = 0): { response: Reply; stdout: string } {
    const result = spawnSync(testExe, ['--test-once', line, String(rejectAt), String(guardAt), String(profile)], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\{"v":1,/)
    expect(result.stderr).toBe('')
    return { response: JSON.parse(result.stdout.trim()) as Reply, stdout: result.stdout }
  }
  const request = (op: string, changes?: unknown) => JSON.stringify({ v: 1, requestId: 'fixture_request', op, ...(changes !== undefined ? { changes } : {}) })
  function interfaceProfile(profile: string) {
    const result = spawnSync(testExe, ['--test-interface-profile', profile], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    return JSON.parse(result.stdout) as { ok: boolean; code?: string; selectedInterfaces?: { friends: string; user: string; utils: string }; requested: string[] }
  }
  function cleanupProfile(profile: string) {
    const result = spawnSync(testExe, ['--test-cleanup', profile], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const values = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    const metadata = values.pop() as { fixtureCalls: number; afterSecondDisposeCalls: number; constructionFailed: boolean; fixtureOrder: string[] }
    const events = values as LifecycleReply[]
    const allowed = ['release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned', 'free-api-library', 'free-client-library', 'cleanup-complete']
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['elapsedMs', 'ok', 'op', 'requestId', 'stage', 'v'])
      expect(event).toMatchObject({ v: 1, requestId: 'lifecycle', op: 'lifecycle' })
      expect(allowed).toContain(event.stage)
      expect(Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= 0x7fffffff).toBe(true)
      expect([null, true, false]).toContain(event.ok)
    }
    expect(events.map(event => event.elapsedMs)).toEqual(events.map(event => event.elapsedMs).sort((a, b) => a - b))
    for (const forbidden of ['SYNTHETIC_PRIVATE_RELEASE_EXCEPTION_NEVER_OUTPUT', 'steamId', 'pipe":', 'user":', 'Handle', 'token', 'path', 'fields']) expect(result.stdout).not.toContain(forbidden)
    return { events, metadata, stages: events.map(event => event.stage) }
  }
  it('reports ordered cleanup results from synthetic delegates without repeating disposal', () => {
    const result = cleanupProfile('success')
    expect(result.stages).toEqual(['release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned', 'free-api-library', 'free-client-library', 'cleanup-complete'])
    expect(result.events.map(event => event.ok)).toEqual([null, true, null, true, true, true, true])
    expect(result.metadata).toEqual({ fixtureCalls: 4, afterSecondDisposeCalls: 4, constructionFailed: false,
      fixtureOrder: ['release-user', 'release-pipe', 'free-api-library', 'free-client-library'] })
  })
  it.each([
    ['throw-user', 'release-user-returned'], ['throw-pipe', 'release-pipe-returned'], ['false-pipe', 'release-pipe-returned'],
    ['false-api', 'free-api-library'], ['throw-api', 'free-api-library'], ['false-client', 'free-client-library'], ['throw-client', 'free-client-library']
  ])('continues remaining releases after %s and marks cleanup incomplete', (profile, failedStage) => {
    const result = cleanupProfile(profile)
    expect(result.metadata.fixtureOrder).toEqual(['release-user', 'release-pipe', 'free-api-library', 'free-client-library'])
    expect(result.metadata.fixtureCalls).toBe(4)
    expect(result.metadata.afterSecondDisposeCalls).toBe(4)
    expect(result.events.filter(event => event.ok === false).map(event => event.stage)).toEqual([failedStage, 'cleanup-complete'])
  })
  it('reports every failed synthetic release rather than only the last failure', () => {
    const result = cleanupProfile('all-fail')
    expect(result.events.map(event => event.ok)).toEqual([null, false, null, false, false, false, false])
    expect(result.metadata.afterSecondDisposeCalls).toBe(4)
  })
  it.each(['constructor-failure', 'constructor-failure-free-false'])('records acquired API cleanup when %s prevents instance assignment', profile => {
    const result = cleanupProfile(profile)
    const success = profile === 'constructor-failure'
    expect(result.stages).toEqual(['free-api-library', 'cleanup-complete'])
    expect(result.events.map(event => event.ok)).toEqual([success, success])
    expect(result.metadata).toEqual({ fixtureCalls: 1, afterSecondDisposeCalls: 1, constructionFailed: true, fixtureOrder: ['free-api-library'] })
  })
  it.each(['client-construction-failure', 'client-construction-failure-free-false'])('preserves nested constructor disposal order for %s', profile => {
    const result = cleanupProfile(profile)
    const success = profile === 'client-construction-failure'
    expect(result.stages).toEqual(['free-client-library', 'free-api-library', 'cleanup-complete'])
    expect(result.events.map(event => event.ok)).toEqual([success, true, success])
    expect(result.metadata).toEqual({ fixtureCalls: 2, afterSecondDisposeCalls: 2, constructionFailed: true,
      fixtureOrder: ['free-client-library', 'free-api-library'] })
  })
  it('reports an empty ownership ledger once without inventing native release calls', () => {
    const result = cleanupProfile('empty')
    expect(result.stages).toEqual(['cleanup-complete'])
    expect(result.events[0]!.ok).toBe(true)
    expect(result.metadata.fixtureCalls).toBe(0)
    expect(result.metadata.afterSecondDisposeCalls).toBe(0)
  })
  it.each([
    { profile: 'mahjong', friends: 'SteamFriends018', user: 'SteamUser023', utils: 'SteamUtils010' },
    { profile: 'l4d2', friends: 'SteamFriends017', user: 'SteamUser021', utils: 'SteamUtils010' },
    { profile: 'legacy020', friends: 'SteamFriends017', user: 'SteamUser020', utils: 'SteamUtils009' },
    { profile: 'legacy022', friends: 'SteamFriends018', user: 'SteamUser022', utils: 'SteamUtils010' }
  ])('requests only the unique flat ABI family from synthetic $profile exports', ({ profile, friends, user, utils }) => {
    expect(interfaceProfile(profile)).toEqual({ ok: true, selectedInterfaces: { friends, user, utils }, requested: [friends, user, utils] })
  })
  it.each(['none', 'missing-friends', 'missing-user', 'missing-utils', 'multiple-friends', 'multiple-user', 'multiple-utils', 'unknown-friends', 'unknown-user', 'unknown-utils', 'known-unknown-friends', 'known-unknown-user', 'known-unknown-utils'])(
    'rejects synthetic %s exports before requesting any interface', profile => {
      expect(interfaceProfile(profile)).toEqual({ ok: false, code: 'NATIVE_EXPORT_MISSING', requested: [] })
    }
  )
  it('fails without falling back when the exact matching interface is rejected', () => {
    expect(interfaceProfile('rejected-friends')).toEqual({ ok: false, code: 'NATIVE_EXPORT_MISSING', requested: ['SteamFriends017'] })
  })
  it.each(['x86', 'x64'])('compiles the production %s worker without running it', architecture => {
    const file = join(temporary(), `production-worker-${architecture}.exe`)
    const result = spawnSync(compiler, ['/nologo', `/platform:${architecture}`, '/target:exe', '/optimize+', '/warnaserror+', `/out:${file}`, join(project, 'scripts', 'native-presence-worker.cs'), join(project, 'scripts', 'native-presence-public-backend.cs'), join(project, 'scripts', 'rich-presence-contract.generated.cs'), join(project, 'scripts', 'steam-public-interface-profiles.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(inspectNativeWorker(readFileSync(file), architecture).bytes).toBeGreaterThan(1000)
  })
  it.each([
    { name: 'matching session', pid: '1234', user: '1', account: 1n, code: 0 },
    { name: 'unsigned DWORD account', pid: '1234', user: '-2147483647', account: 0x80000001n, code: 0 },
    { name: 'changed active PID', pid: '2345', user: '1', account: 1n, code: 70 },
    { name: 'changed account', pid: '1234', user: '2', account: 1n, code: 70 },
    { name: 'changed unsigned DWORD account', pid: '1234', user: '-2147483646', account: 0x80000001n, code: 70 },
    { name: 'missing active PID', pid: 'missing', user: '1', account: 1n, code: 73 },
    { name: 'missing active account', pid: '1234', user: 'missing', account: 1n, code: 73 },
    { name: 'zero active PID', pid: '0', user: '1', account: 1n, code: 73 },
    { name: 'zero active account', pid: '1234', user: '0', account: 1n, code: 73 },
    { name: 'wrong active PID type', pid: 'wrong-type', user: '1', account: 1n, code: 73 },
    { name: 'wrong active account type', pid: '1234', user: 'wrong-type', account: 1n, code: 73 },
    { name: 'proved PID change despite unavailable account', pid: '2345', user: 'missing', account: 1n, code: 70 },
    { name: 'proved account change despite unavailable PID', pid: 'missing', user: '2', account: 1n, code: 70 }
  ])('classifies $name without reading the real registry or calling Steam', ({ pid, user, account, code }) => {
    const self = (0x0110000100000000n + account).toString()
    const result = spawnSync(testExe, ['--test-registry-identity', '1234', self, pid, user], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ identityCode: code })
  })
  it('reads only strictly public values and labels local cache rather than server confirmation', () => {
    const result = once(request('read'))
    expect(result.response).toMatchObject({ v: 1, requestId: 'fixture_request', op: 'read', ok: true, keyCount: 10, acceptedKeys: [], mayHaveWritten: false, fields: { desc: '\u9b42\u5929\u795e\u793e\u5185', 'game:map': 'Fixture map', status: 'Fixture status', matchgrouploc: 'Fixture room' }, localizedString: '\u9b42\u5929\u795e\u793e\u5185', displayTokenReadable: false, verificationSource: 'local-cache' })
    expect(result.response.fields).not.toHaveProperty('version')
    expect(result.response.fields).not.toHaveProperty('steam_display')
    for (const privateKey of ['connect', 'session', 'unknown_public_candidate', 'steam_player_group']) expect(result.stdout).not.toContain(privateKey)
    expect(result.stdout).not.toContain('confirmed')
  })
  it('distinguishes a raw display token from localized display text', () => {
    expect(once(request('read'), 0, 0, 1).response).toMatchObject({ fields: { steam_display: '#Fixture' }, localizedString: null, displayTokenReadable: true, verificationSource: 'local-cache' })
  })
  it.each([19, 21])('reads canonical group size without fetching or exposing the raw group ID (%i)', profile => {
    const result = once(request('read'), 0, 0, profile)
    expect(result.response.fields?.steam_player_group_size).toBe(profile === 21 ? '2147483647' : '3')
    expect(result.response.fields).not.toHaveProperty('steam_player_group')
    expect(result.stdout).not.toContain('NATIVE_PRIVATE_VALUE_READ')
  })
  it.each([20, 22, 23])('does not emit noncanonical group size from the local cache (%i)', profile => {
    const result = once(request('read'), 0, 0, profile)
    expect(result.response).toMatchObject({ ok: false, code: 'NATIVE_PUBLIC_READ_INVALID' })
    expect(result.response.fields).toBeUndefined()
  })
  it.each([8, 9])('does not fabricate a raw display token when the display entry is absent or empty (%i)', profile => {
    const result = once(request('read'), 0, 0, profile).response
    expect(result).toMatchObject({ ok: true, localizedString: null, displayTokenReadable: false })
    expect(result.fields).not.toHaveProperty('steam_display')
  })
  it.each([2, 3, 4, 5, 6, 7, 10, 12, 14])('fails closed on malformed public native-cache fixture %i without exposing values', profile => {
    const result = once(request('read'), 0, 0, profile)
    expect(result.response).toMatchObject({ ok: false, code: 'NATIVE_PUBLIC_READ_INVALID', acceptedKeys: [], mayHaveWritten: false })
    expect(result.response.fields).toBeUndefined()
    expect(result.stdout).not.toContain('private')
  })
  it.each([15, 16, 17])('never fetches values from noncanonical or unapproved game keys (%i)', profile => {
    const result = once(request('read'), 0, 0, profile).response
    expect(result.ok).toBe(true)
    expect(result.fields).not.toHaveProperty('DESC')
    expect(result.fields).not.toHaveProperty('game:server')
    expect(result.fields).not.toHaveProperty('game:connect')
  })
  it('guards the native read before and after field access', () => {
    for (const guardAt of [1, 2, 3, 8, 12]) expect(once(request('read'), 0, guardAt).response).toMatchObject({ ok: false, code: 'NATIVE_CONTEXT_CHANGED', mayHaveWritten: false })
  })
  it('sets only requested fields, applies steam_display last, and exposes no values', () => {
    const result = once(request('apply', { steam_display: '#Fixture', status: 'must-not-expose-status', desc: 'must-not-expose-desc' }))
    expect(result.response).toMatchObject({ op: 'applied', ok: true, acceptedKeys: ['desc', 'status', 'steam_display'], mayHaveWritten: true })
    expect(result.stdout).not.toContain('#Fixture')
    expect(result.stdout).not.toContain('must-not-expose')
    expect(result.stdout).not.toContain('confirmed')
  })
  it('handles Chinese UTF-8 values and an empty string single-key removal without clearing other keys', () => {
    expect(once(request('apply', { desc: '\u738b\u5ea7\u4e4b\u95f4 \u56db\u4eba\u4e1c' })).response.acceptedKeys).toEqual(['desc'])
    expect(once(request('apply', { desc: '' })).response.acceptedKeys).toEqual(['desc'])
  })
  it.each(['1', '2147483647', null])('permits canonical size %j only when an existing group key is present', value => {
    expect(once(request('apply', { steam_player_group_size: value })).response).toMatchObject({ ok: true, acceptedKeys: ['steam_player_group_size'], mayHaveWritten: true })
    expect(once(request('apply', { desc: 'Must remain untouched', steam_player_group_size: value }), 0, 0, 18).response).toMatchObject({ ok: false, code: 'NATIVE_SET_REJECTED', acceptedKeys: [], mayHaveWritten: false })
  })
  it('preflights peak RP key capacity for the full real-game change set', () => {
    expect(once(request('apply', { desc: 'Untouched', steam_player_group_size: '3' }), 0, 0, 24).response).toMatchObject({ code: 'NATIVE_SET_REJECTED', acceptedKeys: [], mayHaveWritten: false })
    expect(once(request('apply', { activity: 'New activity', steam_player_group_size: null }), 0, 0, 26).response).toMatchObject({ ok: true, acceptedKeys: ['steam_player_group_size', 'activity'] })
  })
  it('checks that the real group still exists immediately before the size write', () => {
    expect(once(request('apply', { desc: 'One change', steam_player_group_size: '3' }), 0, 0, 25).response).toMatchObject({ code: 'NATIVE_SET_REJECTED', acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each(['0', '00', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '2147483648', '9999999999999', '\u0661', 1, false])('rejects noncanonical or non-string size %j before any write', value => {
    expect(once(request('apply', { desc: 'Must remain untouched', steam_player_group_size: value })).response).toMatchObject({ ok: false, code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it('reports a rejected first Set as potentially written, not successful', () => {
    expect(once(request('apply', { desc: 'fixture' }), 1).response).toMatchObject({ op: 'error', code: 'NATIVE_SET_REJECTED', ok: false, acceptedKeys: [], mayHaveWritten: true })
  })
  it('preserves exact partial-acceptance keys when the second Set fails', () => {
    expect(once(request('apply', { desc: 'fixture', steam_display: '#Fixture' }), 2).response).toMatchObject({ code: 'NATIVE_SET_REJECTED', acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each([1, 2])('does zero Set calls when context guard %i fails before writing', guardAt => {
    expect(once(request('apply', { desc: 'fixture' }), 0, guardAt).response).toMatchObject({ code: 'NATIVE_CONTEXT_CHANGED', acceptedKeys: [], mayHaveWritten: false })
  })
  it('does not write the next key after context changes during an apply', () => {
    expect(once(request('apply', { desc: 'fixture', steam_display: '#Fixture' }), 0, 3).response).toMatchObject({ code: 'NATIVE_CONTEXT_CHANGED', acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each(['connect', 'session', 'lobby', 'authToken', '__proto__', 'constructor', 'steam_player_group', 'version', 'server:ip'])('rejects unsafe key %s before writing', key => {
    expect(once(request('apply', { [key]: 'fixture' })).response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it('accepts safe custom write parameters without allowing their private-cache readback', () => {
    expect(once(request('apply', { 'game:objective': 'Public objective', custom_state: 'Ready' })).response).toMatchObject({ ok: true, acceptedKeys: ['custom_state', 'game:objective'] })
    expect(once(request('read')).response.fields).not.toHaveProperty('unknown_public_candidate')
  })
  it.each(['#Status.Game:mode-1', '#' + 'x'.repeat(127)])('accepts full shared display-token syntax %s', token => {
    expect(once(request('apply', { steam_display: token })).response).toMatchObject({ ok: true, acceptedKeys: ['steam_display'] })
  })
  it.each([null, {}, { desc: null }, { desc: 1 }, { desc: 'x'.repeat(256) }, { ['k'.repeat(64)]: 'v' }, { desc: '\n' }, { steam_display: 'arbitrary text' }, { desc: 'a', DESC: 'b' }])('rejects invalid changes without coercion: %j', changes => {
    expect(once(request('apply', changes)).response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it.each([
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"a","desc":"b"}}',
    '{"v":1,"requestId":"fixture","op":"read","op":"apply"}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"\\ud800"}}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"\\u12zz"}}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"x"},"unknown":"must-not-expose"}',
    '{"v":1,"requestId":"startup","op":"read"}',
    '{"v":2,"requestId":"fixture","op":"read"}',
    '{"v":1,"requestId":"fixture","op":"read"} trailing',
    '{"v":1,"requestId":"fixture","op":"read","changes":{}}',
    '{"v":1,"requestId":"fixture","op":"restart"}'
  ])('fails closed on malformed or ambiguous JSONL without echoing payload: %s', line => {
    const result = once(line)
    expect(result.response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
    expect(result.stdout).not.toContain('must-not-expose')
  })
  it('measures value limits in UTF-8 bytes and bounds changes to 20 keys', () => {
    expect(once(request('apply', { desc: '\u4e00'.repeat(85) })).response.ok).toBe(true)
    expect(once(request('apply', { desc: '\u4e00'.repeat(86) })).response.code).toBe('NATIVE_PROTOCOL_INVALID')
    expect(once(request('apply', Object.fromEntries(Array.from({ length: 20 }, (_, index) => ['field' + index, 'v'])))).response.acceptedKeys).toHaveLength(20)
    expect(once(request('apply', Object.fromEntries(Array.from({ length: 21 }, (_, index) => ['field' + index, 'v'])))).response.code).toBe('NATIVE_PROTOCOL_INVALID')
  })
  it('acknowledges stop without touching native presence', () => {
    expect(once(request('stop')).response).toMatchObject({ op: 'stopped', ok: true, acceptedKeys: [], mayHaveWritten: false })
  })
  it.each(['read', 'apply'])('does not misclassify a closed or invalid owner pipe as a changed game during %s', op => {
    for (const [state, code] of [['closed', 'NATIVE_EXITED'], ['invalid', 'NATIVE_PROTOCOL_INVALID']] as const) {
      const result = spawnSync(testExe, ['--test-input-once', request(op, op === 'apply' ? { desc: 'Never written' } : undefined), state], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ op: 'error', code, mayHaveWritten: false, acceptedKeys: [] })
      expect(result.stdout).not.toContain('Never written')
    }
  })

  function session(args = ['--test-loop'], executable = testExe) {
    const child = spawn(executable, args, { stdio: 'pipe', windowsHide: true })
    children.add(child)
    let buffer = ''
    const lines: Reply[] = []
    const waiters: Array<(line: Reply) => void> = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, index)) as Reply
        buffer = buffer.slice(index + 1)
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else lines.push(line)
      }
    })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    const next = () => lines.length ? Promise.resolve(lines.shift()!) : new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture worker response timed out')), 3000)
      waiters.push(line => { clearTimeout(timeout); resolve(line) })
    })
    return { child, next, exited }
  }
  it('supports owned JSONL request/reply and graceful stop', async () => {
    const worker = session()
    expect(await worker.next()).toMatchObject({ requestId: 'startup', op: 'ready', ok: true })
    worker.child.stdin.write(request('read') + '\n')
    expect(await worker.next()).toMatchObject({ requestId: 'fixture_request', op: 'read', keyCount: 10, verificationSource: 'local-cache' })
    worker.child.stdin.write(JSON.stringify({ v: 1, requestId: 'stop_request', op: 'stop' }) + '\n')
    expect(await worker.next()).toMatchObject({ op: 'stopped' })
    expect(await worker.exited).toBe(0)
  })
  it('shuts down in less than one second after owned stdin closes', async () => {
    const worker = session()
    await worker.next()
    const started = Date.now()
    worker.child.stdin.end()
    expect(await worker.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('acknowledges an already queued stop before owned stdin EOF', async () => {
    const worker = session()
    await worker.next()
    worker.child.stdin.end(JSON.stringify({ v: 1, requestId: 'stop_before_eof', op: 'stop' }) + '\n')
    expect(await worker.next()).toMatchObject({ requestId: 'stop_before_eof', op: 'stopped', ok: true, mayHaveWritten: false })
    expect(await worker.exited).toBe(0)
  })
  it('rejects duplicate request IDs without repeating a Set', async () => {
    const worker = session()
    await worker.next()
    const line = request('apply', { desc: 'must-not-expose' }) + '\n'
    worker.child.stdin.write(line)
    expect(await worker.next()).toMatchObject({ op: 'applied', acceptedKeys: ['desc'] })
    worker.child.stdin.write(line)
    expect(await worker.next()).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
    expect(await worker.exited).toBe(0)
  })
  it('bounds incomplete stdin lines before a newline and rejects invalid UTF-8', async () => {
    for (const input of [Buffer.from('x'.repeat(16385)), Buffer.from([255, 10])]) {
      const worker = session()
      await worker.next()
      worker.child.stdin.write(input)
      expect(await worker.next()).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', mayHaveWritten: false })
      expect(await worker.exited).toBe(0)
    }
  })
  it.each(['parent', 'game', 'steam'])('independently exits only the blocked worker when its bound %s fixture exits', async binding => {
    const fixture = session(['--test-fixture-child'])
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    expect(info.fixturePid).toBe(fixture.child.pid)
    const worker = session([`--test-watchdog-${binding}`, String(info.fixturePid), info.fixtureTicks])
    expect(await worker.next()).toMatchObject({ op: 'ready' })
    const started = Date.now()
    fixture.child.kill()
    await fixture.exited
    expect(await worker.exited).toBe(70)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it.each(['parent', 'game', 'steam'])('detects a bound %s instance start-time mismatch without stopping the live fixture', async binding => {
    const fixture = session(['--test-fixture-child'])
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    const worker = session([`--test-watchdog-${binding}`, String(info.fixturePid), String(BigInt(info.fixtureTicks) + 1n)])
    await worker.next()
    expect(await worker.exited).toBe(70)
    expect(fixture.child.exitCode).toBeNull()
    expect(fixture.child.signalCode).toBeNull()
  })
  it('detects a bound Steam image mismatch without stopping the live fixture', async () => {
    const fixture = session(['--test-fixture-child'])
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    const worker = session(['--test-watchdog-steam-image', String(info.fixturePid), info.fixtureTicks])
    await worker.next()
    expect(await worker.exited).toBe(70)
    expect(fixture.child.exitCode).toBeNull()
    expect(fixture.child.signalCode).toBeNull()
  })
  it('checks x64 fixture image metadata from an x86 worker without process-memory access', async () => {
    const fixture = session(['--test-fixture-child'], testExe64)
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    const worker = session(['--test-watchdog-steam', String(info.fixturePid), info.fixtureTicks])
    await worker.next()
    await new Promise<void>(resolve => setTimeout(resolve, 500))
    expect(worker.child.exitCode).toBeNull()
    expect(worker.child.signalCode).toBeNull()
    fixture.child.kill(); await fixture.exited
    expect(await worker.exited).toBe(70)
  })
  it('independently exits a blocked worker within one second after owned stdin EOF', async () => {
    const worker = session(['--test-watchdog-eof'])
    await worker.next()
    const started = Date.now()
    worker.child.stdin.end()
    expect(await worker.exited).toBe(71)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('classifies an invalid blocked owner pipe separately from a changed game', async () => {
    const worker = session(['--test-watchdog-eof'])
    await worker.next(); worker.child.stdin.write(Buffer.from([255, 10]))
    expect(await worker.exited).toBe(72)
  })
  it('classifies an inability to inspect liveness separately from a proved instance change', async () => {
    const worker = session(['--test-watchdog-unavailable'])
    await worker.next()
    expect(await worker.exited).toBe(73)
  })
})
