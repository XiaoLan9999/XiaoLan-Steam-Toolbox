import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface Metadata { architecture: string; fileName: string; bytes: number; sha256: string }
interface Options { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; outputDirectory?: string; run?: typeof spawnSync }
interface Build {
  inspectScreenshotImportHost(bytes: Buffer): Metadata
  screenshotImportHostBuildPlan(options?: Options): { source: string; outputDirectory: string; fileName: string }
  buildScreenshotImportHost(options?: Options): Metadata
}
const { inspectScreenshotImportHost, screenshotImportHostBuildPlan, buildScreenshotImportHost } = await import(new URL('../scripts/build-screenshot-import-host.mjs', import.meta.url).href) as Build
const project = fileURLToPath(new URL('../', import.meta.url))
const source = join(project, 'scripts', 'screenshot-import-host.cs')
const code = readFileSync(source, 'utf8')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const directories: string[] = []
function temporary(): string { const path = mkdtempSync(join(tmpdir(), 'screenshot-import-host-test-')); directories.push(path); return path }
afterAll(() => {
  for (const path of directories) {
    expect(resolve(path).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    expect(basename(path).startsWith('screenshot-import-host-test-')).toBe(true)
    rmSync(path, { recursive: true, force: true })
  }
})
function pe(): Buffer {
  const bytes = Buffer.alloc(256)
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88)
  return bytes
}

describe('screenshot native host build and static safety', () => {
  it('pins the successful public-client screenshot ABI and only the reviewed DLL', () => {
    expect(code).toContain('253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc')
    expect(code).toContain('args.Length == 9')
    expect(code).toContain('args[1] == SupportedHash && Hash(b.Dll) == SupportedHash')
    expect(code).toContain('b.ValidateDll()')
    expect(code).toContain('Marshal.ReadIntPtr(instance) == Address(vtableRva)')
    expect(code).toContain('pointer == Address(functionRva)')
    expect(code).toContain('STEAMSCREENSHOTS_INTERFACE_VERSION003')
    expect(code).toContain('0x130c7d8, 12, 0x720260')
    expect(code).toContain('0x130c7d8, 18, 0x7203d0')
    expect(code).toContain('0x1315640, 1, 0x729900')
    expect(code).toContain('"Steam_BGetCallback", 0x984d00')
    expect(code).toContain('"Steam_FreeLastCallback", 0x984d30')
    expect(code).toContain('"Steam_ReleaseThreadLocalMemory", 0x984db0')
  })

  it('uses only local process environment and validates the exact owner, Steam instance, identity and license', () => {
    expect(code).toContain('ProcessMatches(OwnerPid, OwnerStart, null)')
    expect(code).toContain('ProcessMatches(SteamPid, SteamStart, SteamExe)')
    expect(code).toContain('steamId(user, result) == result')
    expect(code).toContain('Marshal.ReadInt64(result)) == binding.Expected')
    expect(code).toContain('appId(utils) == binding.Target')
    expect(code).toContain('licensed(apps, binding.Target)')
    expect(code.match(/Environment\.SetEnvironmentVariable/g)).toHaveLength(4)
    expect(code.match(/EnvironmentVariableTarget\.Process/g)).toHaveLength(4)
    for (const forbidden of ['SteamAPI_Init', 'SteamAPI_Shutdown', 'SteamAPI_RunCallbacks', 'SteamAPI_ManualDispatch', 'GetFriends', 'SetPresence', 'SetRichPresence', 'HookScreenshots', 'TriggerScreenshot', 'SetValue(', 'CreateSubKey(', 'DeleteValue(', 'File.Write', 'File.Move', 'File.Delete', 'Directory.Create', 'Process.Start', '.Kill(', 'TcpClient', 'HttpClient', 'ReadProcessMemory', 'CLIENTENGINE_', 'screenshots.vdf']) expect(code).not.toContain(forbidden)
  })

  it('has a separate AppID-zero identity path without game interfaces, activity gating, or screenshot submission', () => {
    const begin = code.indexOf('private sealed class NativeIdentity')
    const end = code.indexOf('private sealed class NativeSession', begin)
    const identity = code.slice(begin, end)
    expect(begin).toBeGreaterThan(0)
    expect(code).toContain('args.Length == 7 && args[0] == "--read-current-user"')
    expect(code).toContain('return RunIdentity(new NativeIdentity(Binding.ParseIdentity(args), output), output)')
    expect(identity).toContain('Environment.SetEnvironmentVariable("SteamAppId", "0", EnvironmentVariableTarget.Process)')
    expect(identity).toContain('Environment.SetEnvironmentVariable("SteamGameId", "0", EnvironmentVariableTarget.Process)')
    expect(identity).toContain('"SteamUser023"')
    expect(identity).toContain('0x1319808, 2, 0x722c80')
    expect(identity).toContain('steamId(user, result) == result')
    for (const forbidden of ['CheckActivity', 'SteamUtils', 'STEAMAPPS', 'SteamFriends', 'SCREENSHOTS', 'AddScreenshot', 'ImageSource', 'licensed(', 'nextCallback', 'add(']) expect(identity).not.toContain(forbidden)
    expect(code).toContain('first == second && first > SteamIdBase')
    expect(code).toContain('{ "readOnly", true }')
  })

  it('rechecks game activity before connecting and after source hash validation, without polling registry during callback waits', () => {
    expect(code).toContain('Registry.CurrentUser.OpenSubKey(@"Software\\Valve\\Steam", false)')
    expect(code).toContain('Registry.CurrentUser.OpenSubKey(@"Software\\Valve\\Steam\\Apps", false)')
    expect(code).toContain('RegistryValueOptions.DoNotExpandEnvironmentNames')
    expect(code).toContain('b.Check(); b.CheckActivity(); userHandle =')
    expect(code).toContain('binding.CheckActivity(); Check(); submitting(); attempted = true;')
    expect(code).not.toMatch(/ActiveProcess|ActiveUser/)
    const loop = code.slice(code.indexOf('while (clock.ElapsedMilliseconds < 15000)'), code.indexOf('return new Result("uncertain", true, handle'))
    expect(loop).not.toContain('CheckActivity')
  })

  it('bounds an idle session at 60 seconds from the last completed request', () => {
    expect(code).toContain('IdleTimeoutMilliseconds = 60000')
    expect(code).toContain('now() - lastCompleted >= idleTimeoutMs')
    expect(code).toContain('lastCompleted = now();')
    expect(code).toContain('"reason", "IDLE_TIMEOUT"')
  })

  it('checks a confined regular JPEG and holds a read-only non-delete-sharing stream through native completion', () => {
    expect(code).toContain('path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)')
    expect(code).toContain('FileAttributes.ReparsePoint')
    expect(code).toContain('FileMode.Open, FileAccess.Read, FileShare.Read')
    expect(code).toContain('Hash(stream) == request.Sha256')
    expect(code).toContain('image.RawFormat.Guid == ImageFormat.Jpeg.Guid')
    expect(code).toContain('image.Width == request.Width && image.Height == request.Height')
    expect(code).toContain('32L * 1024 * 1024')
    expect(code).toContain('using (FileStream source = ImageSource(request))')
    expect(code).toContain('IntPtr.Zero, request.Width, request.Height')
  })

  it('submits once and correlates exact callback user, handle, size and success result before confirming', () => {
    expect(code.match(/uint handle = add\(/g)).toHaveLength(1)
    expect(code).toContain('submitting(); attempted = true;')
    expect(code).toContain('if (handle == 0) return new Result("rejected", true, 0')
    expect(code).toContain('Marshal.AllocHGlobal(24)')
    expect(code).toContain('if (kind != 2301) continue')
    expect(code).toContain('Require(bytes == 8')
    expect(code).toContain('if (received != handle) continue')
    expect(code).toContain('Require(target == userHandle')
    expect(code).toContain('result == 1 ? "confirmed" : "rejected"')
    expect(code).toContain('finally { freeCallback(pipe); }')
    expect(code).toContain('clock.ElapsedMilliseconds < 15000')
    expect(code).toContain('new Result("uncertain", true, handle, null, "CALLBACK_TIMEOUT")')
    expect(code).toContain('attempted ? "uncertain" : "rejected"')
  })

  it('releases the user before its pipe, thread memory and library and never starts another session automatically', () => {
    const dispose = code.slice(code.indexOf('public void Dispose()\n        {', code.indexOf('private sealed class NativeSession')))
    expect(dispose.indexOf('releaseUser(client, pipe, userHandle)')).toBeLessThan(dispose.indexOf('releasePipe(client, pipe)'))
    expect(dispose.indexOf('releasePipe(client, pipe)')).toBeLessThan(dispose.indexOf('releaseThread(false)'))
    expect(dispose.indexOf('releaseThread(false)')).toBeLessThan(dispose.indexOf('FreeLibrary(module)'))
    expect(code).toContain('MaximumBatch = 100')
    expect(code).toContain('MaximumLineBytes = 8192')
    expect(code).toContain('new BlockingCollection<Frame>(2)')
    expect(code).toContain('session.CheckOwner()')
  })

  it('builds a bounded x64 PE with only the expected framework references and no execution', () => {
    const root = temporary(); mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'screenshot-import-host.cs'), 'fixture source')
    const csc = join(root, 'fixture-csc.exe'); writeFileSync(csc, 'fixture compiler; never execute')
    const run = vi.fn((_compiler: string, args: readonly string[]) => { writeFileSync(args.find(value => value.startsWith('/out:'))!.slice(5), pe()); return { status: 0 } })
    const options = { root, platform: 'win32', windowsDirectory: root, compiler: csc, run: run as unknown as typeof spawnSync }
    const plan = screenshotImportHostBuildPlan(options)
    expect(plan.source).toBe(join(root, 'scripts', 'screenshot-import-host.cs'))
    expect(plan.outputDirectory).toBe(join(root, 'resources', 'screenshot-import'))
    expect(plan.fileName).toBe('screenshot-import-host-x64.exe')
    expect(buildScreenshotImportHost(options)).toMatchObject({ architecture: 'x64', bytes: 256, fileName: plan.fileName })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['/platform:x64', '/target:exe', '/warnaserror+', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll']))
    expect(readdirSync(plan.outputDirectory)).toEqual([plan.fileName])
  })

  it('rejects unsafe output formats and unsupported build environments', () => {
    expect(() => inspectScreenshotImportHost(Buffer.alloc(256))).toThrow('Invalid')
    expect(() => inspectScreenshotImportHost(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow('Invalid')
    const x86 = pe(); x86.writeUInt16LE(0x14c, 68); expect(() => inspectScreenshotImportHost(x86)).toThrow('x64')
    const broken = pe(); broken.writeUInt32LE(254, 0x3c); expect(() => inspectScreenshotImportHost(broken)).toThrow('x64')
    expect(() => screenshotImportHostBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
    expect(() => screenshotImportHostBuildPlan({ root: project, platform: 'win32', windowsDirectory: project, compiler: compiler, outputDirectory: 'relative' })).toThrow('absolute')
  })
})

const fixtureSource = `using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
internal static class ScreenshotHostFixture
{
    private sealed class FakeIdentity : ScreenshotImportHost.IIdentitySession
    {
        private readonly bool changes; private readonly ScreenshotImportHost.Protocol output;
        internal int Calls; internal bool Disposed;
        internal FakeIdentity(bool changes, ScreenshotImportHost.Protocol output) { this.changes = changes; this.output = output; }
        public ulong Read() { Calls++; return 76561198000000001UL + (changes && Calls > 1 ? 1UL : 0UL); }
        public int SteamPid { get { return 1234; } }
        public string SteamStartTicks { get { return "638965000000000001"; } }
        public void Dispose() { Disposed = true; output.Emit("lifecycle", null, new Dictionary<string, object> { { "stage", "cleanup" }, { "userReleased", true }, { "pipeReleased", true }, { "threadMemoryReleased", true }, { "libraryReleased", true } }); }
    }
    private sealed class Fake : ScreenshotImportHost.IImportSession
    {
        internal readonly string Mode; internal int Calls, Checks; internal bool Disposed, Completed;
        internal Fake(string mode) { Mode = mode; }
        public void CheckOwner() { Checks++; if (Mode == "owner-lost") throw new ScreenshotImportHost.Failure("CONTEXT_CHANGED"); }
        public ScreenshotImportHost.Result Add(ScreenshotImportHost.Request request, Action submitting, Action<uint> submitted)
        {
            Calls++; if (Mode == "idle-after-add") Completed = true;
            if (Mode == "throw-before") throw new ScreenshotImportHost.Failure("IMAGE_CHANGED");
            if (Mode == "reject-before") return new ScreenshotImportHost.Result("rejected", false, null, null, "IMAGE_INVALID");
            submitting();
            if (Mode == "zero") return new ScreenshotImportHost.Result("rejected", true, 0, null, "INVALID_SCREENSHOT_HANDLE");
            uint handle = (uint)(600 + Calls); submitted(handle);
            if (Mode == "throw-after") throw new ScreenshotImportHost.Failure("CONTEXT_CHANGED");
            if (Mode == "unexpected-after") throw new Exception("private fixture path secret");
            if (Mode == "uncertain") return new ScreenshotImportHost.Result("uncertain", true, handle, null, "CALLBACK_TIMEOUT");
            if (Mode == "reject-native") return new ScreenshotImportHost.Result("rejected", true, handle, 2, "STEAM_REJECTED");
            return new ScreenshotImportHost.Result("confirmed", true, handle, 1, null);
        }
        public void Dispose() { Disposed = true; }
    }
    private sealed class PrefixThenBlock : TextReader
    {
        private readonly string prefix; private int position;
        internal PrefixThenBlock(string prefix) { this.prefix = prefix; }
        public override int Read() { if (position < prefix.Length) return prefix[position++]; Thread.Sleep(Timeout.Infinite); return -1; }
    }
    public static int Main(string[] args)
    {
        if (args[0] == "identity" || args[0] == "identity-change")
        {
            ScreenshotImportHost.Protocol identityOutput = new ScreenshotImportHost.Protocol(Console.Out);
            FakeIdentity identity = new FakeIdentity(args[0] == "identity-change", identityOutput); int identityStatus;
            try { identityStatus = ScreenshotImportHost.RunIdentity(identity, identityOutput); }
            catch (ScreenshotImportHost.Failure) { identityStatus = 1; }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "op", "fixture-summary" }, { "calls", identity.Calls }, { "disposed", identity.Disposed }, { "nativeSteamCalls", 0 } }));
            return identityStatus;
        }
        if (args[0] == "activity-pure")
        {
            List<uint> excessive = new List<uint>(); for (int index = 0; index < 4097; index++) excessive.Add(0);
            Dictionary<string, object> cases = new Dictionary<string, object> {
                { "idle", ScreenshotImportHost.ActivityAllows(730, 0, new uint[0]) },
                { "own-context", ScreenshotImportHost.ActivityAllows(730, 730, new uint[] { 0, 730 }) },
                { "other-primary", ScreenshotImportHost.ActivityAllows(730, 1329410, new uint[0]) },
                { "other-app", ScreenshotImportHost.ActivityAllows(730, 0, new uint[] { 730, 1329410 }) },
                { "unknown-app", ScreenshotImportHost.ActivityAllows(730, UInt32.MaxValue, new uint[0]) },
                { "invalid-target", ScreenshotImportHost.ActivityAllows(480, 0, new uint[0]) },
                { "excessive", ScreenshotImportHost.ActivityAllows(730, 0, excessive) }
            };
            Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "op", "fixture-summary" }, { "cases", cases }, { "nativeSteamCalls", 0 }, { "disposed", true } }));
            return 0;
        }
        Fake fake = new Fake(args[0]); int status;
        int afterReads = 0; long idleClock = 0;
        if (args[0] == "idle" || args[0] == "idle-after-add")
        {
            TextReader blocked = new PrefixThenBlock(Console.In.ReadToEnd());
            Func<long> clock = delegate() { if (args[0] == "idle") return idleClock += 60001; if (!fake.Completed) return 0; afterReads++; return afterReads == 1 ? 120000 : 180001; };
            using (fake) status = new ScreenshotImportHost.Protocol(Console.Out, clock, 60000, 1).Run(blocked, fake);
        }
        else using (fake) status = new ScreenshotImportHost.Protocol(Console.Out).Run(Console.In, fake);
        Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "op", "fixture-summary" }, { "calls", fake.Calls }, { "checks", fake.Checks }, { "disposed", fake.Disposed }, { "nativeSteamCalls", 0 }, { "afterReads", afterReads } }));
        return status;
    }
}`
const request = (id = 'one', extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, requestId: id, op: 'add', path: 'D:\\fixture-staging\\sample.jpg', width: 640, height: 360, sha256: 'a'.repeat(64), ...extra })
const stop = (id = 'stop') => JSON.stringify({ v: 1, requestId: id, op: 'stop' })

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('compiled native-host protocol with fake interfaces only', () => {
  let fixture = ''
  beforeAll(() => {
    const directory = temporary(); fixture = join(directory, 'fixture.exe')
    const harness = join(directory, 'fixture.cs'); writeFileSync(harness, fixtureSource)
    const result = spawnSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/main:ScreenshotHostFixture', '/optimize+', '/debug-', '/warnaserror+', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', `/out:${fixture}`, source, harness], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
  function run(mode = 'confirmed', lines: string[] = []) {
    const result = spawnSync(fixture, [mode], { input: lines.length ? lines.join('\n') + '\n' : '', windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 })
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe('')
    const frames = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const summary = frames.find(frame => frame.op === 'fixture-summary')!
    expect(summary).toMatchObject({ nativeSteamCalls: 0, disposed: true })
    return { status: result.status, frames, summary, text: result.stdout }
  }
  it('compiles the production binary without executing its entrypoint', () => {
    expect(buildScreenshotImportHost({ outputDirectory: temporary() })).toMatchObject({ architecture: 'x64', fileName: 'screenshot-import-host-x64.exe' })
  })
  it('emits a pure correlated identity and cleanup without screenshot methods', () => {
    const result = run('identity')
    expect(result.status).toBe(0)
    expect(result.frames[0]).toMatchObject({ v: 1, op: 'identity', protocol: 1, readOnly: true, steamId: '76561198000000001', steamPid: 1234, steamStartTicks: '638965000000000001' })
    expect(result.frames[1]).toMatchObject({ op: 'lifecycle', stage: 'cleanup', userReleased: true, pipeReleased: true })
    expect(result.summary.calls).toBe(2)
    expect(result.frames.some(frame => frame.op === 'submitting' || frame.op === 'submitted' || frame.op === 'result')).toBe(false)
  })
  it('rejects changing identity while still disposing the read-only session', () => {
    const result = run('identity-change')
    expect(result.status).toBe(1)
    expect(result.summary.calls).toBe(2)
    expect(result.frames.some(frame => frame.op === 'identity')).toBe(false)
    expect(result.frames[0]).toMatchObject({ op: 'lifecycle', stage: 'cleanup' })
  })
  it('allows only idle or the same target context through the pure activity gate', () => {
    const result = run('activity-pure')
    expect(result.status).toBe(0)
    expect(result.summary.cases).toEqual({ idle: true, 'own-context': true, 'other-primary': false, 'other-app': false, 'unknown-app': false, 'invalid-target': false, excessive: false })
  })
  it('exits an idle blocked input session without a native call', () => {
    const result = run('idle')
    expect(result.status).toBe(0)
    expect(result.frames[0]).toMatchObject({ op: 'stopped', reason: 'IDLE_TIMEOUT' })
    expect(result.summary.calls).toBe(0)
  })
  it('starts its idle window after a completed add rather than at the beginning of native processing', () => {
    const result = run('idle-after-add', [request()])
    expect(result.status).toBe(0)
    expect(result.summary.calls).toBe(1)
    expect(result.summary.afterReads).toBe(2)
    expect(result.frames.at(-2)).toMatchObject({ op: 'stopped', reason: 'IDLE_TIMEOUT' })
  })
  it('reuses one session for two images and returns a correlated graceful stop', () => {
    const result = run('confirmed', [request('first'), request('second'), stop('bye')])
    expect(result.status).toBe(0)
    expect(result.frames.slice(0, 7)).toEqual([
      { v: 1, op: 'submitting', requestId: 'first' }, { v: 1, op: 'submitted', requestId: 'first', handle: 601 },
      { v: 1, op: 'result', requestId: 'first', status: 'confirmed', mayHaveSubmitted: true, handle: 601, result: 1 },
      { v: 1, op: 'submitting', requestId: 'second' }, { v: 1, op: 'submitted', requestId: 'second', handle: 602 },
      { v: 1, op: 'result', requestId: 'second', status: 'confirmed', mayHaveSubmitted: true, handle: 602, result: 1 },
      { v: 1, op: 'stopped', requestId: 'bye' }
    ])
    expect(result.summary.calls).toBe(2)
  })
  it('accepts EOF and an explicit stop without adding a screenshot', () => {
    expect(run().summary.calls).toBe(0)
    const stopped = run('confirmed', [stop(), request()])
    expect(stopped.summary.calls).toBe(0)
    expect(stopped.frames[0]).toMatchObject({ op: 'stopped', requestId: 'stop' })
  })
  it.each(['throw-before', 'reject-before'])('preserves a definite pre-submission rejection in %s', mode => {
    const result = run(mode, [request()])
    expect(result.frames[0]).toMatchObject({ op: 'result', status: 'rejected', mayHaveSubmitted: false })
    expect(result.frames.some(frame => frame.op === 'submitting')).toBe(false)
  })
  it('distinguishes a zero native handle from ambiguous completion', () => {
    const result = run('zero', [request()])
    expect(result.frames[1]).toMatchObject({ op: 'result', status: 'rejected', mayHaveSubmitted: true, handle: 0, code: 'INVALID_SCREENSHOT_HANDLE' })
    expect(result.summary.calls).toBe(1)
  })
  it('preserves an explicit failed native callback as rejection, not a resend or fabricated success', () => {
    const result = run('reject-native', [request()])
    expect(result.frames[2]).toMatchObject({ op: 'result', status: 'rejected', mayHaveSubmitted: true, handle: 601, result: 2, code: 'STEAM_REJECTED' })
    expect(result.summary.calls).toBe(1)
  })
  it.each(['throw-after', 'unexpected-after', 'uncertain'])('does not resend after uncertain native completion in %s', mode => {
    const result = run(mode, [request()])
    expect(result.frames[2]).toMatchObject({ op: 'result', status: 'uncertain', mayHaveSubmitted: true, handle: 601 })
    expect(result.summary.calls).toBe(1)
    expect(result.text).not.toContain('private fixture')
  })
  it('never calls add after owner identity has been lost', () => {
    const result = run('owner-lost', [request()])
    expect(result.status).toBe(1)
    expect(result.frames[0]).toMatchObject({ op: 'error', code: 'CONTEXT_CHANGED' })
    expect(result.summary.calls).toBe(0)
  })
  it.each([
    { width: 0 }, { width: -1 }, { width: 1.5 }, { width: '640' }, { height: 16001 },
    { width: 16000, height: 16000 }, { sha256: 'A'.repeat(64) }, { sha256: 'not a hash' },
    { path: '' }, { path: 'bad\0path.jpg' }, { unexpected: true }
  ])('rejects malformed add fields before any native invocation %j', extra => {
    const result = run('confirmed', [request('invalid', extra)])
    expect(result.frames[0]).toMatchObject({ op: 'result', requestId: 'invalid', status: 'rejected', mayHaveSubmitted: false })
    expect(result.summary.calls).toBe(0)
  })
  it.each([
    '{', JSON.stringify({ v: 2, requestId: 'one', op: 'add' }), JSON.stringify({ v: 1, requestId: '../unsafe', op: 'add' }),
    JSON.stringify({ v: 1, requestId: 'one', op: 'upload' }), JSON.stringify({ v: 1, requestId: 'one', op: 'stop', extra: true })
  ])('terminates malformed transport without exposing or processing input %s', line => {
    const result = run('confirmed', [line])
    expect(result.status).toBe(1)
    expect(result.frames[0]).toMatchObject({ op: 'error' })
    expect(result.summary.calls).toBe(0)
  })
  it.each(['x'.repeat(8193), JSON.stringify({ v: 1, requestId: 'one', op: 'add', path: '界'.repeat(3000) })])('bounds both character and UTF-8 byte lengths before processing', line => {
    const result = run('confirmed', [line])
    expect(result.status).toBe(1)
    expect(result.frames[0]).toMatchObject({ op: 'error', code: 'FRAME_TOO_LARGE' })
    expect(result.summary.calls).toBe(0)
  })
  it('limits a persistent helper to 100 submissions without replaying the remaining requests', () => {
    const result = run('confirmed', Array.from({ length: 102 }, (_, index) => request(`image_${index}`)))
    expect(result.status).toBe(0)
    expect(result.summary.calls).toBe(100)
    expect(result.frames.filter(frame => frame.op === 'result')).toHaveLength(100)
    expect(result.frames.at(-2)).toMatchObject({ op: 'stopped', reason: 'BATCH_LIMIT' })
  })
})
