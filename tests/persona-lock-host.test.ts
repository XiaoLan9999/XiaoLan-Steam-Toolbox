import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface Metadata { architecture: string; fileName: string; bytes: number; sha256: string }
interface Options { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; outputDirectory?: string; run?: typeof spawnSync }
interface Build {
  inspectPersonaLockHost(bytes: Buffer): Metadata
  personaLockHostBuildPlan(options?: Options): { source: string; outputDirectory: string; fileName: string }
  buildPersonaLockHost(options?: Options): Metadata
}
const { inspectPersonaLockHost, personaLockHostBuildPlan, buildPersonaLockHost } = await import(new URL('../scripts/build-persona-lock-host.mjs', import.meta.url).href) as Build
const project = fileURLToPath(new URL('../', import.meta.url)), source = join(project, 'scripts', 'persona-lock-host.cs')
const code = readFileSync(source, 'utf8')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const directories: string[] = []
function temporary(): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'persona-lock-host-test-')))
  directories.push(directory)
  return directory
}
afterAll(() => {
  const root = realpathSync(tmpdir())
  for (const directory of directories) {
    const target = realpathSync(directory)
    expect(dirname(target).toLowerCase()).toBe(root.toLowerCase())
    expect(target.toLowerCase()).toBe(resolve(directory).toLowerCase())
    expect(basename(target).startsWith('persona-lock-host-test-')).toBe(true)
    rmSync(target, { recursive: true, force: true })
  }
})
function pe(): Buffer {
  const value = Buffer.alloc(256)
  value.writeUInt16LE(0x5a4d); value.writeUInt32LE(64, 0x3c); value.writeUInt32LE(0x4550, 64)
  value.writeUInt16LE(0x8664, 68); value.writeUInt16LE(0x20b, 88)
  return value
}

describe('persona native helper static boundary and reproducible build', () => {
  it('pins the reviewed public old-version setter without private-engine or raw CM fallbacks', () => {
    expect(code).toContain('253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc')
    expect(code).toContain('Hash(library) == SupportedHash')
    expect(code).toContain('"SteamFriends002"')
    expect(code).toContain('0x130d468, 2, 0x71e610')
    expect(code).toContain('0x130d468, 3, 0x723460')
    expect(code).toContain('Marshal.ReadIntPtr(instance) == Address(table)')
    expect(code).toContain('pointer == Address(function)')
    expect(code).toContain('args.Length == 8 && args[0] == "--persona-session"')
    expect(code).toContain('new FileStream(binding.Dll, FileMode.Open, FileAccess.Read, FileShare.Read)')
    for (const forbidden of ['SteamAPI_Init', 'SteamAPI_Shutdown', 'SteamAPI_RunCallbacks', 'SteamAPI_ManualDispatch', 'SetRichPresence', 'ClearRichPresence', 'RequestFriendRichPresence', 'GamesPlayed', 'CLIENTENGINE_', 'IClientFriends', 'SetPersonaStateFlags', 'SetCurrentUIMode', 'SteamDeck', 'SetValue(', 'CreateSubKey(', 'File.Write', 'Process.Start', '.Kill(', 'ReadProcessMemory', 'TcpClient', 'HttpClient']) expect(code).not.toContain(forbidden)
  })

  it('uses an AppID-zero owned pipe and checks identity, process image and owner around state operations', () => {
    expect(code).toContain('Environment.SetEnvironmentVariable("SteamAppId", "0", EnvironmentVariableTarget.Process)')
    expect(code).toContain('Environment.SetEnvironmentVariable("SteamGameId", "0", EnvironmentVariableTarget.Process)')
    expect(code).toContain('Method<CreatePipe>(client, 0x130c7d8, 0, 0x5162f0)')
    expect(code).toContain('Method<ConnectUser>(client, 0x130c7d8, 2, 0x720000)')
    expect(code).toContain('ProcessMatches(OwnerPid, OwnerTicks, null)')
    expect(code).toContain('ProcessMatches(SteamPid, SteamTicks, SteamExe)')
    expect(code).toContain('unchecked((ulong)Marshal.ReadInt64(result)) == binding.Expected')
    expect(code).toContain('public int ReadState() { CheckIdentity();')
    expect(code).toContain('"PERSONA_STATE_INVALID"); CheckIdentity();')
    expect(code).toContain('releaseUser(client, pipe, ownUser)')
    expect(code.indexOf('releaseUser(client, pipe, ownUser)')).toBeLessThan(code.indexOf('releasePipe(client, pipe)'))
    expect(code.indexOf('releasePipe(client, pipe)')).toBeLessThan(code.indexOf('releaseThread(false)'))
    expect(code.indexOf('releaseThread(false)')).toBeLessThan(code.indexOf('FreeLibrary(module)'))
  })

  it('builds only the new standalone x64 helper and refuses unsupported hosts and malformed output', () => {
    const root = temporary(); mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'persona-lock-host.cs'), 'synthetic source')
    const csc = join(root, 'fixture-csc.exe'); writeFileSync(csc, 'synthetic compiler')
    const run = vi.fn((_compiler: string, args: readonly string[]) => { writeFileSync(args.find(value => value.startsWith('/out:'))!.slice(5), pe()); return { status: 0 } })
    const options = { root, platform: 'win32', windowsDirectory: root, compiler: csc, run: run as unknown as typeof spawnSync }
    expect(personaLockHostBuildPlan(options)).toMatchObject({ source: join(root, 'scripts', 'persona-lock-host.cs'), fileName: 'persona-lock-host-x64.exe', outputDirectory: join(root, 'resources', 'persona-lock') })
    expect(buildPersonaLockHost(options)).toMatchObject({ architecture: 'x64', bytes: 256, fileName: 'persona-lock-host-x64.exe' })
    expect(run).toHaveBeenCalledOnce()
    expect(readdirSync(join(root, 'resources', 'persona-lock'))).toEqual(['persona-lock-host-x64.exe'])
    expect(() => personaLockHostBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
    expect(() => inspectPersonaLockHost(Buffer.alloc(20))).toThrow()
    const x86 = pe(); x86.writeUInt16LE(0x14c, 68)
    expect(() => inspectPersonaLockHost(x86)).toThrow('x64')
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('persona helper isolated managed fake sessions, never loading Steam', () => {
  let fake: string
  beforeAll(() => {
    const directory = temporary(), fixture = join(directory, 'fixture.cs')
    fake = join(directory, 'fixture.exe')
    writeFileSync(fixture, fixtureCode)
    const built = spawnSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/main:Fixture', '/warnaserror+', '/r:System.Web.Extensions.dll', `/out:${fake}`, source, fixture], { windowsHide: true, encoding: 'utf8' })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    const metadata = buildPersonaLockHost({ outputDirectory: join(directory, 'built') })
    expect(metadata.architecture).toBe('x64')
  })
  function run(mode: string, commands: Array<string | object> = []) {
    const result = spawnSync(fake, [mode], { windowsHide: true, encoding: 'utf8', input: commands.map(command => typeof command === 'string' ? command : JSON.stringify(command)).join('\n') + (commands.length ? '\n' : ''), timeout: 5000 })
    expect(result.error).toBeUndefined()
    const frames = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(value => JSON.parse(value) as Record<string, unknown>)
    const stats = frames.find(frame => frame.op === 'stats')!
    return { exit: result.status, frames, stats, results: frames.filter(frame => frame.op === 'result') }
  }
  const command = (op: string) => ({ v: 1, requestId: '11111111-1111-4111-8111-111111111111', op })

  it('defaults to read-only and never changes persona until an explicit lock', () => {
    const result = run('normal', [command('read'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.frames[0]).toMatchObject({ op: 'ready', currentState: 1, originalState: null, locked: false })
    expect(result.stats).toMatchObject({ writes: [], state: 1, disposed: 1 })
  })
  it('locks only Snooze, coalesces repeated locks and restores the original on explicit stop', () => {
    const result = run('normal', [command('lock'), command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[0]).toMatchObject({ currentState: 4, originalState: 1, locked: true })
    expect(result.results[2]).toMatchObject({ currentState: 1, originalState: null, locked: false, restored: true })
    expect(result.stats).toMatchObject({ writes: [4, 1], state: 1, disposed: 1, restored: true })
  })
  it.each(['privacy0', 'privacy7'])('does not change or restore private initial state %s', mode => {
    const result = run(mode, [command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[0]).toMatchObject({ locked: false, originalState: null, restored: false })
    expect(result.stats.writes).toEqual([])
  })
  it.each(['become0', 'become7'])('abandons a live lock on %s without overriding or restoring it', mode => {
    const result = run(mode, [command('lock'), command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[1]).toMatchObject({ locked: false, originalState: null, restored: false })
    expect(result.stats.writes).toEqual([4])
  })
  it('preserves an externally changed non-private state instead of blindly restoring the baseline', () => {
    const result = run('become-away', [command('lock'), command('unlock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[1]).toMatchObject({ currentState: 3, locked: false, restored: false })
    expect(result.stats.writes).toEqual([4])
  })
  it('restores on EOF and on the single-threaded idle watchdog', () => {
    expect(run('normal', [command('lock')]).stats).toMatchObject({ writes: [4, 1], state: 1, disposed: 1 })
    expect(run('idle', []).stats).toMatchObject({ writes: [4, 1], state: 1, disposed: 1 })
  })
  it.each(['identity-lost', 'owner-lost'])('does not relax identity guards to restore after %s', mode => {
    const result = run(mode, [command('lock'), command('read')])
    expect(result.exit).toBe(1)
    expect(result.stats).toMatchObject({ writes: [4], disposed: 1 })
    expect(result.frames.some(frame => frame.op === 'error')).toBe(true)
  })
  it('does not silently report a rejected setter as a successful lock', () => {
    const result = run('rejected', [command('lock')])
    expect(result.exit).toBe(1)
    expect(result.frames.find(frame => frame.op === 'error')).toMatchObject({ code: 'PERSONA_SET_REJECTED' })
    expect(result.stats).toMatchObject({ writes: [4], state: 1, disposed: 1 })
  })
  it('waits for a delayed setter readback without sending Snooze more than once', () => {
    const result = run('delayed-set', [command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[0]).toMatchObject({ currentState: 4, originalState: 1, locked: true })
    expect(result.stats).toMatchObject({ writes: [4, 1], state: 1, restored: true })
  })
  it('waits for a delayed restoration readback without resending the baseline', () => {
    const result = run('delayed-restore', [command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results[1]).toMatchObject({ currentState: 1, locked: false, restored: true })
    expect(result.stats).toMatchObject({ writes: [4, 1], state: 1, restored: true })
  })
  it.each(['privacy-during-set', 'privacy-during-restore'])('stops polling on %s and never writes through a new private state', mode => {
    const result = run(mode, [command('lock'), command('stop')])
    expect(result.exit).toBe(0)
    expect(result.results.at(-1)).toMatchObject({ currentState: mode === 'privacy-during-set' ? 7 : 0, locked: false, originalState: null, restored: false })
    expect(result.stats.writes).toEqual(mode === 'privacy-during-set' ? [4] : [4, 1])
  })
  it('bounds a persistently rejected setter at two seconds and does not retry the write', () => {
    const started = performance.now()
    const result = run('rejected', [command('lock')])
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(1900)
    expect(elapsed).toBeLessThan(4000)
    expect(result.exit).toBe(1)
    expect(result.stats).toMatchObject({ writes: [4], state: 1, restored: false })
  })
  it('bounds a persistently rejected restoration without resending it or claiming recovery', () => {
    const result = run('rejected-restore', [command('lock'), command('stop')])
    expect(result.exit).toBe(1)
    expect(result.frames.find(frame => frame.op === 'error')).toMatchObject({ code: 'PERSONA_RESTORE_REJECTED' })
    expect(result.stats).toMatchObject({ writes: [4, 1], state: 4, restored: false })
  })
  it('never changes an already Snoozing baseline or restores it to an unrelated state', () => {
    expect(run('already4', [command('lock'), command('stop')]).stats).toMatchObject({ writes: [], state: 4, disposed: 1, restored: true })
  })
  it.each(['{"v":1}', '{bad-json}', JSON.stringify({ ...command('lock'), state: 7 }), JSON.stringify({ ...command('read'), requestId: 'invalid' }), 'x'.repeat(5000)])('fails closed on malformed input without any persona mutation', input => {
    const result = run('normal', [input])
    expect(result.exit).toBe(1)
    expect(result.stats).toMatchObject({ writes: [], disposed: 1 })
  })
})

const fixtureCode = `using System; using System.Collections.Generic; using System.IO; using System.Threading;
public static class Fixture {
  sealed class Fake : PersonaLockHost.ISession {
    internal int State=1, Sets, Reads, Disposed, PendingReads; internal int? Pending; internal readonly List<int> Writes=new List<int>(); internal readonly string Mode;
    internal Fake(string mode) { Mode=mode; if(mode=="privacy0") State=0; if(mode=="privacy7") State=7; if(mode=="already4") State=4; }
    public string SteamId { get { return "76561198000000001"; } } public int SteamPid { get { return 410; } } public string SteamStartTicks { get { return "639000000000000001"; } }
    public bool? Restored { get; set; }
    public void CheckOwner() { if(Mode=="owner-lost" && Sets>0 && Reads>=2) throw new PersonaLockHost.Failure("PERSONA_CONTEXT_CHANGED"); }
    public int ReadState() {
      Reads++; if(Mode=="identity-lost" && Sets>0 && Reads>=3) throw new PersonaLockHost.Failure("PERSONA_IDENTITY_MISMATCH");
      if(Pending.HasValue) {
        if(Mode=="privacy-during-set" && Pending==4 && PendingReads==2) { Pending=null; State=7; }
        else if(Mode=="privacy-during-restore" && Pending==1 && PendingReads==2) { Pending=null; State=0; }
        else if(--PendingReads<=0) { State=Pending.Value; Pending=null; }
      }
      if(Sets>0 && Reads>=4) { if(Mode=="become0") State=0; if(Mode=="become7") State=7; if(Mode=="become-away") State=3; }
      return State;
    }
    public void SetState(int state) {
      CheckOwner(); Sets++; Writes.Add(state);
      if(Mode=="rejected" || Mode=="rejected-restore" && state==1) return;
      if((Mode=="delayed-set" || Mode=="privacy-during-set") && state==4 || (Mode=="delayed-restore" || Mode=="privacy-during-restore") && state==1) { Pending=state; PendingReads=3; }
      else State=state;
    }
    public void Dispose() { Disposed++; }
  }
  sealed class IdleInput : StringReader {
    private int at; private readonly string frame="{\\"v\\":1,\\"requestId\\":\\"11111111-1111-4111-8111-111111111111\\",\\"op\\":\\"lock\\"}\\n";
    internal IdleInput():base(""){}
    public override int Read() { if(at<frame.Length) return frame[at++]; Thread.Sleep(1000); return -1; }
  }
  public static int Main(string[] args) {
    Fake fake=new Fake(args[0]); int result;
    if(args[0]=="idle") {
      var input=new IdleInput();
      result=PersonaLockHost.Run(input,Console.Out,fake,20,2);
    } else result=PersonaLockHost.Run(Console.In,Console.Out,fake,30000,2);
    PersonaLockHost.Emit(Console.Out,"stats",null,new Dictionary<string,object>{{"writes",fake.Writes},{"state",fake.State},{"disposed",fake.Disposed},{"restored",fake.Restored}}); return result;
  }
}`
