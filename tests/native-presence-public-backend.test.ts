import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const project = fileURLToPath(new URL('../', import.meta.url))
const backend = join(project, 'scripts', 'native-presence-public-backend.cs')
const worker = join(project, 'scripts', 'native-presence-worker.cs')
const profileSource = join(project, 'scripts', 'steam-public-interface-profiles.cs')
const source = readFileSync(backend, 'utf8')
const profileHash = 'e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e'
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canCompile = process.platform === 'win32' && existsSync(compiler)
let temporary: string | undefined
let fixture: string

const fixtureSource = `using System;
using System.Globalization;
using System.Reflection;
internal static class PublicBackendFixture
{
    private static readonly Type Worker = typeof(PublicBackendFixture).Assembly.GetType("NativePresenceWorker");
    private static object Call(string name, params object[] arguments)
    {
        return Worker.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, arguments);
    }
    private static string Field(object value, string name)
    {
        object result = value.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance).GetValue(value);
        return result == null ? "<null>" : Convert.ToString(result, CultureInfo.InvariantCulture);
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args[0] == "binding")
            {
                string[] values = new string[args.Length - 1]; Array.Copy(args, 1, values, 0, values.Length);
                object value = Call("ParsePublicBindingArguments", new object[] { values });
                string[] names = { "PublicClient", "Dll", "Hash", "ClientDll", "ClientHash", "App", "Self", "GamePid", "GameTicks", "GameImage", "ParentPid", "ParentTicks", "SteamPid", "SteamTicks", "SteamImage" };
                Console.Write("ok"); foreach (string name in names) Console.Write("|" + Field(value, name)); Console.WriteLine();
            }
            else if (args[0] == "registry")
            {
                object current = args[1] == "missing" ? null : args[1] == "int" ? (object)Int32.Parse(args[2], CultureInfo.InvariantCulture) : (object)args[2];
                Console.WriteLine(Call("PublicRunningAppState", current, UInt32.Parse(args[3], CultureInfo.InvariantCulture)));
            }
            else if (args[0] == "pointers")
            {
                long address = Int64.Parse(args[1], CultureInfo.InvariantCulture);
                int vt = Int32.Parse(args[2], CultureInfo.InvariantCulture), fn = Int32.Parse(args[3], CultureInfo.InvariantCulture);
                int vtDifference = Int32.Parse(args[4], CultureInfo.InvariantCulture), fnDifference = Int32.Parse(args[5], CultureInfo.InvariantCulture);
                Call("VerifyPublicMethodAddresses", new IntPtr(address), new IntPtr(address + vt + vtDifference), new IntPtr(address + fn + fnDifference), vt, fn);
                Console.WriteLine("ok");
            }
            else throw new InvalidOperationException();
            return 0;
        }
        catch (TargetInvocationException error)
        {
            FieldInfo code = error.InnerException.GetType().GetField("Code", BindingFlags.Public | BindingFlags.Instance);
            Console.WriteLine(code == null ? "unexpected" : "error|" + code.GetValue(error.InnerException)); return 0;
        }
    }
}`

beforeAll(() => {
  if (!canCompile) return
  temporary = mkdtempSync(join(tmpdir(), 'native-public-backend-test-'))
  const main = join(temporary, 'fixture.cs')
  fixture = join(temporary, 'fixture.exe')
  writeFileSync(main, fixtureSource)
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/warnaserror+', '/main:PublicBackendFixture', `/out:${fixture}`, worker, backend, join(project, 'scripts', 'rich-presence-contract.generated.cs'), profileSource, main], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
})

afterAll(() => {
  if (!temporary) return
  const target = resolve(temporary)
  expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true)
  rmSync(target, { recursive: true, force: true })
})

function run(...args: string[]) {
  const result = spawnSync(fixture, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return result.stdout.trim()
}

function validArguments() {
  return ['--public-client', 'C:\\fixture\\steamclient64.dll', profileHash, '438100', '76561198000000001', '21', '638000000000000001', 'C:\\fixture\\VRChat\\VRChat.exe', '22', '638000000000000002', '23', '638000000000000003']
}

describe('public-client presence backend static boundaries', () => {
  it('uses only exact audited x64 client profiles without a game SDK fallback', () => {
    expect(readFileSync(profileSource, 'utf8')).toContain(profileHash)
    expect(source).toContain('IntPtr.Size != 8')
    expect(source).toContain('SteamPublicProfile.TrySelect(binding.ClientHash, out profile)')
    expect(source).toContain('SteamPublicProfile.IsSupported(args[2])')
    expect(source).toContain('value.Dll = null; value.Hash = null;')
    expect(source).toContain('new NativeLibrary(binding.ClientDll, profile.Hash')
    for (const forbidden of ['steam_api', 'apiLibrary', '.Modules', 'MainModule', 'ReadProcessMemory', 'PROCESS_VM_READ', 'SteamAPI_Init', 'SteamAPI_Shutdown', 'SteamAPI_RunCallbacks', 'RequestFriendRichPresence', 'ClearRichPresence', 'SteamNoOverlayUI']) expect(source).not.toContain(forbidden)
  })
  it('checks exact public vptr and function addresses before binding delegates', () => {
    expect(source).toContain('IntPtr actualVtable = Marshal.ReadIntPtr(instance)')
    expect(source).toContain('if (actualVtable != expectedVtable)')
    expect(source).toContain('VerifyPublicMethodAddresses(clientLibrary.Handle, actualVtable, function, expected.VtableRva, expected.FunctionRva)')
    expect(source.indexOf('VerifyPublicMethodAddresses(clientLibrary.Handle')).toBeLessThan(source.indexOf('Marshal.GetDelegateForFunctionPointer(function'))
    expect(source).toContain('SteamPublicProfile.Call expected = profile.Get(method)')
  })
  it.each([
    'Method<PublicReleaseUser>(client, SteamPublicMethod.ReleaseUser)',
    'Method<PublicReleasePipe>(client, SteamPublicMethod.ReleasePipe)',
    'Method<PublicCreatePipe>(client, SteamPublicMethod.CreatePipe)',
    'Method<PublicConnectUser>(client, SteamPublicMethod.ConnectUser)',
    'UserInterface(SteamPublicMethod.GetUser, "SteamUser023")',
    'Method<PublicLoggedOn>(user, SteamPublicMethod.LoggedOn)',
    'Method<PublicSteamId>(user, SteamPublicMethod.SteamId)',
    'Method<PublicPipeInterface>(client, SteamPublicMethod.GetUtils)',
    'Method<PublicAppId>(utils, SteamPublicMethod.GetAppId)',
    'UserInterface(SteamPublicMethod.GetFriends, "SteamFriends018")',
    'Method<PublicSet>(friends, SteamPublicMethod.SetPresence)',
    'Method<PublicValue>(friends, SteamPublicMethod.GetPresence)',
    'Method<PublicCount>(friends, SteamPublicMethod.CountPresence)',
    'Method<PublicIndex>(friends, SteamPublicMethod.IndexPresence)'
  ])('pins the audited public call %s', call => {
    expect(source).toContain(call)
  })
  it('uses an explicit eight-byte x64 CSteamID sret, not a scalar-return guess', () => {
    expect(source).toContain('delegate IntPtr PublicSteamId(IntPtr self, IntPtr result)')
    expect(source).toContain('IntPtr result = Marshal.AllocHGlobal(8)')
    expect(source).toContain('getSteamId(user, result) != result')
    expect(source).toContain('Marshal.ReadInt64(result)')
    expect(source).not.toContain('delegate ulong PublicSteamId')
  })
  it('binds expected real game path and checks the registry app in each bound guard', () => {
    expect(source).toContain('value.GameImage = Path.GetFullPath(args[7])')
    expect(source).toContain('actual = ProcessImage(value.GamePid)')
    expect(source).toContain('String.Equals(actual, value.GameImage, StringComparison.OrdinalIgnoreCase)')
    expect(source).toContain('value.AssertAlive()')
    expect(source).toContain('GetValue("RunningAppID", null, RegistryValueOptions.DoNotExpandEnvironmentNames)')
    expect(source).toContain('AssertPublicBinding(binding)')
    expect(source).toContain('EnvironmentVariableTarget.Process')
    expect(source).not.toContain('SetValue(')
  })
  it('provides a registry-only context code for the shared idle watchdog without recursive guards', () => {
    const method = source.slice(source.indexOf('private static int PublicRunningAppContextCode'), source.indexOf('private static void AssertPublicBinding'))
    expect(method).toContain('Registry.CurrentUser.OpenSubKey')
    expect(method).toContain('PublicRunningAppState(')
    expect(method).toContain('expected)')
    expect(method).toContain('catch { return 73; }')
    for (const forbidden of ['AssertAlive(', 'AssertPublicBinding(', 'ContextCode(', 'Guard(', 'ProcessImage(', 'NativeLibrary']) expect(method.slice(method.indexOf('{'))).not.toContain(forbidden)
  })
  it('includes the public app guard in the shared binding context used by the idle watchdog', () => {
    const shared = readFileSync(worker, 'utf8')
    expect(shared).toContain('return identity != 0 ? identity : PublicClient ? PublicRunningAppContextCode(App) : 0;')
    expect(shared).toContain('new LivenessWatchdog(delegate { int code = binding.ContextCode();')
  })
  it('uses shared read/preflight contracts and requires the native group without reading its ID value', () => {
    expect(source).toContain('ReadPublic(this, Guard)')
    expect(source).toContain('PreflightRealGroupChanges(this, Guard, changes)')
    expect(source).toContain('if (!GroupSizeValueValid(value))')
    expect(source).toContain('RequireExistingGroup(this, Guard)')
    expect(source).toContain('valueMemory = value == null ? IntPtr.Zero : CString(value)')
    expect(source).not.toContain('Value(GroupIdKey')
    expect(source).not.toContain('Value("steam_player_group"')
  })
  it('binds release methods before pipe allocation and retires only owned resources in order', () => {
    expect(source.indexOf('releasePipe = Method')).toBeLessThan(source.indexOf('pipe = Method<PublicCreatePipe>'))
    expect(source).toContain('catch { Dispose(); throw; }')
    const dispose = source.slice(source.lastIndexOf('public void Dispose()'))
    expect(dispose).toContain('if (disposed) return; disposed = true;')
    expect(dispose.indexOf('releaseUser(client, pipe, ownUser)')).toBeLessThan(dispose.indexOf('releasePipe(client, pipe)'))
    expect(dispose.indexOf('releasePipe(client, pipe)')).toBeLessThan(dispose.indexOf('clientLibrary.Dispose()'))
    expect(dispose).toContain('cleanup.Complete()')
  })
})

describe.skipIf(!canCompile)('public-client production compile and pure fixtures without native calls', () => {
  it('parses the exact twelve-position public-client binding without probing processes or loading a DLL', () => {
    const fields = run('binding', ...validArguments()).split('|')
    expect(fields).toEqual(['ok', 'True', '<null>', '<null>', 'C:\\fixture\\steamclient64.dll', profileHash, '438100', '76561198000000001', '21', '638000000000000001', 'C:\\fixture\\VRChat\\VRChat.exe', '22', '638000000000000002', '23', '638000000000000003', 'C:\\fixture\\steam.exe'])
  })
  it.each([
    [0, '--other'], [1, 'relative\\steamclient64.dll'], [1, 'C:\\fixture\\steamclient.dll'],
    [1, '\\\\server\\steamclient64.dll'], [2, 'not-a-hash'], [3, '0'], [3, '16777216'],
    [3, '-1'], [4, '0'], [4, (0x110000100000000n).toString()], [4, (0x110000100000000n + (1n << 32n)).toString()],
    [5, '0'], [6, '0'], [7, 'relative.exe'], [7, 'C:\\fixture\\game.dll'],
    [7, '\\\\server\\game.exe'], [8, '21'], [9, '0'], [10, '21'], [10, '22'], [11, '0'],
    [7, 'C:\\fixture\\steam.exe']
  ])('rejects invalid binding position %i with value %s before any native or process operation', (position, value) => {
    const args = validArguments(); args[Number(position)] = String(value)
    expect(run('binding', ...args)).toBe('error|NATIVE_ARGUMENTS_INVALID')
  })
  it('rejects unknown client profiles instead of falling back to a nearby ABI', () => {
    const args = validArguments(); args[2] = 'a'.repeat(64)
    expect(run('binding', ...args)).toBe('error|NATIVE_EXPORT_MISSING')
  })
  it('accepts the separately audited current profile without any process query', () => {
    const args = validArguments(); args[2] = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
    expect(run('binding', ...args).split('|')[5]).toBe(args[2])
  })
  it('rejects incomplete and extra command-line arguments', () => {
    expect(run('binding', ...validArguments().slice(0, -1))).toBe('error|NATIVE_ARGUMENTS_INVALID')
    expect(run('binding', ...validArguments(), 'extra')).toBe('error|NATIVE_ARGUMENTS_INVALID')
  })
  it.each([
    ['missing', '0', '438100', '73'], ['string', '438100', '438100', '73'],
    ['int', '438100', '438100', '0'], ['int', '1329410', '438100', '70'], ['int', '0', '438100', '70']
  ])('distinguishes missing registry context from an actual app switch (%s %s)', (kind, value, app, expected) => {
    expect(run('registry', kind, value, app)).toBe(expected)
  })
  it.each([[0, 0, 'ok'], [8, 0, 'error|NATIVE_EXPORT_MISSING'], [0, 8, 'error|NATIVE_EXPORT_MISSING']])('checks exact synthetic public vptr/function offsets (%i, %i)', (vtableDifference, functionDifference, expected) => {
    expect(run('pointers', '1000000', String(0x130e640), String(0x7233c0), String(vtableDifference), String(functionDifference))).toBe(expected)
  })
  it('rejects a missing synthetic module', () => {
    expect(run('pointers', '0', String(0x130e640), String(0x7233c0), '0', '0')).toBe('error|NATIVE_EXPORT_MISSING')
  })
})
