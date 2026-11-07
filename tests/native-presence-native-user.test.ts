import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const project = fileURLToPath(new URL('../', import.meta.url))
const worker = readFileSync(join(project, 'scripts', 'native-presence-worker.cs'), 'utf8')
const backend = readFileSync(join(project, 'scripts', 'native-presence-public-backend.cs'), 'utf8')
const currentHash = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const previousHash = 'e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e'
const self = '76561198000000001'
const accountId = String(BigInt(self) - 0x0110000100000000n)
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canCompile = process.platform === 'win32' && existsSync(compiler)
let directory: string | undefined
const executables = new Map<string, string>()

const fixtureSource = `using System;
using System.Globalization;
using System.Reflection;
internal static class NativeUserFixture
{
    private static readonly Type Worker = typeof(NativeUserFixture).Assembly.GetType("NativePresenceWorker");
    private static object Call(string name, params object[] args)
    {
        return Worker.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
    }
    private static object Hint(string text)
    {
        if (text == "missing") return null;
        if (text.StartsWith("string:", StringComparison.Ordinal)) return text.Substring(7);
        if (text.StartsWith("long:", StringComparison.Ordinal)) return Int64.Parse(text.Substring(5), CultureInfo.InvariantCulture);
        return Int32.Parse(text, CultureInfo.InvariantCulture);
    }
    private static string Field(object value, string name)
    {
        return Convert.ToString(value.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance).GetValue(value), CultureInfo.InvariantCulture);
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args[0] == "loaded" || args[0] == "public")
            {
                string[] input = new string[args.Length - 1]; Array.Copy(args, 1, input, 0, input.Length);
                object result = args[0] == "public" ? Call("ParsePublicBindingArguments", new object[] { input })
                    : Worker.GetNestedType("Binding", BindingFlags.NonPublic).GetMethod("ParseArguments", BindingFlags.Public | BindingFlags.Static).Invoke(null, new object[] { input });
                Console.WriteLine("ok|" + Field(result, "NativeUserIdentity") + "|" + Field(result, "ClientHash") + "|" + Field(result, "SteamPid") + "|" + Field(result, "SteamTicks"));
            }
            else if (args[0] == "hint")
            {
                Type binding = Worker.GetNestedType("Binding", BindingFlags.NonPublic);
                object[] input = { Hint(args[1]), Hint(args[2]), Int32.Parse(args[3], CultureInfo.InvariantCulture), UInt64.Parse(args[4], CultureInfo.InvariantCulture) };
                object native = binding.GetMethod("NativeIdentityHintState", BindingFlags.Public | BindingFlags.Static).Invoke(null, input);
                object legacy = binding.GetMethod("RegistryIdentityState", BindingFlags.Public | BindingFlags.Static).Invoke(null, input);
                Console.WriteLine("ok|" + native + "|" + legacy);
            }
            else if (args[0] == "identity")
                Console.WriteLine("ok|" + Call("NativeIdentityMatches", Boolean.Parse(args[1]), UInt64.Parse(args[2], CultureInfo.InvariantCulture), UInt32.Parse(args[3], CultureInfo.InvariantCulture), UInt64.Parse(args[4], CultureInfo.InvariantCulture), UInt32.Parse(args[5], CultureInfo.InvariantCulture)));
            else throw new InvalidOperationException();
            return 0;
        }
        catch (TargetInvocationException error)
        {
            FieldInfo code = error.InnerException.GetType().GetField("Code", BindingFlags.Public | BindingFlags.Instance);
            Console.WriteLine(code == null ? "unexpected" : "error|" + code.GetValue(error.InnerException));
            return 0;
        }
    }
}`

beforeAll(() => {
  if (!canCompile) return
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-presence-user-fixture-')))
  const main = join(directory, 'fixture.cs')
  writeFileSync(main, fixtureSource)
  for (const arch of ['x86', 'x64']) {
    const executable = join(directory, `fixture-${arch}.exe`)
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/platform:${arch}`, '/warnaserror+', '/main:NativeUserFixture',
      `/out:${executable}`, join(project, 'scripts', 'native-presence-worker.cs'), join(project, 'scripts', 'native-presence-public-backend.cs'),
      join(project, 'scripts', 'rich-presence-contract.generated.cs'), join(project, 'scripts', 'steam-public-interface-profiles.cs'), main],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    executables.set(arch, executable)
  }
})

afterAll(() => {
  if (!directory) return
  if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('native-presence-user-fixture-') ||
    realpathSync(directory) !== directory || resolve(directory) !== directory) throw new Error('Unsafe native identity fixture cleanup')
  rmSync(directory, { recursive: true, force: true })
})

function run(kind: string, args: string[], arch = 'x64'): string {
  const result = spawnSync(executables.get(arch)!, [kind, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return result.stdout.trim()
}

function loadedArgs(arch = 'x64', hash = currentHash): string[] {
  return ['C:\\fixture\\GTFO_Data\\Plugins\\steam_api64.dll', 'a'.repeat(64),
    `C:\\fixture\\${arch === 'x64' ? 'steamclient64.dll' : 'steamclient.dll'}`, hash,
    '493520', self, '21', '638000000000000001', '22', '638000000000000002', '23', '638000000000000003']
}

function publicArgs(hash = currentHash): string[] {
  return ['--public-client', 'C:\\fixture\\steamclient64.dll', hash, '493520', self,
    '21', '638000000000000001', 'C:\\fixture\\GTFO\\GTFO.exe', '22', '638000000000000002', '23', '638000000000000003']
}

describe('native-user fallback source safety boundaries', () => {
  it('keeps process liveness before hints and keeps all native calls off the watchdog hint path', () => {
    const context = worker.slice(worker.indexOf('public int ContextCode()'), worker.indexOf('public void AssertAlive()'))
    expect(context.indexOf('LivenessCode()')).toBeLessThan(context.indexOf('Registry.CurrentUser.OpenSubKey'))
    expect(context).toContain('if (alive != 0) return alive')
    expect(context).toContain('if (NativeUserIdentity) return NativeIdentityHintState(')
    expect(context).toContain('return identity != 0 ? identity : PublicClient ? PublicRunningAppContextCode(App) : 0;')
    expect(context.indexOf('if (NativeUserIdentity)')).toBeLessThan(context.indexOf('PublicRunningAppContextCode'))
    for (const token of ['loggedOn(', 'getSteamId(', 'getAppId(', 'Guard(', 'NativeIdentityMatches(']) expect(context).not.toContain(token)
    expect(worker).toContain('new LivenessWatchdog(delegate { int code = binding.ContextCode();')
    for (const token of ['ProcessState(ParentPid, ParentTicks, null)', 'ProcessState(SteamPid, SteamTicks, SteamImage)', 'ProcessState(GamePid, GameTicks, GameImage)']) expect(worker).toContain(token)
  })

  it('preserves actual online, user and app checks on both backends before readiness and around each write', () => {
    const loaded = worker.slice(worker.indexOf('private sealed class NativePresence :'), worker.indexOf('#if NATIVE_PRESENCE_TEST', worker.indexOf('private sealed class NativePresence :')))
    for (const source of [loaded, backend]) {
      const guard = source.slice(source.indexOf('public bool Guard()'), source.indexOf('public PresenceRead Read()'))
      expect(guard).toContain('bool online = loggedOn(user); Bound();')
      expect(guard).toContain('if (!online) throw new Failure("NATIVE_CONTEXT_UNAVAILABLE")')
      expect(guard).toContain('getSteamId(user')
      expect(guard).toContain('uint app = getAppId(utils); Bound();')
      expect(guard).toContain('NativeIdentityMatches(online, self, app, binding.Self, binding.App)')
      expect(source).toContain('ReadPublic(this, Guard)')
      expect(source).toContain('PreflightRealGroupChanges(this, Guard, changes)')
      expect(source.indexOf('if (!Guard()) throw new Failure("NATIVE_CONTEXT_CHANGED")')).toBeLessThan(source.indexOf('public bool Guard()'))
      const set = source.slice(source.indexOf('public bool Set('), source.indexOf('public void Dispose()'))
      const write = set.indexOf('bool result = set(')
      expect(write).toBeGreaterThan(0)
      expect(set.indexOf('if (!Guard())')).toBeLessThan(write)
      expect(set.indexOf('if (!Guard())', write)).toBeGreaterThan(write)
    }
    const handle = worker.slice(worker.indexOf('private static bool Handle('), worker.indexOf('private sealed class Input'))
    expect(handle.indexOf('if (!api.Guard())')).toBeLessThan(handle.indexOf('api.Preflight('))
    expect(handle).toMatch(/foreach \(string key in keys\)[\s\S]*?if \(!api.Guard\(\)\)[\s\S]*?mayHaveWritten = true;[\s\S]*?api.Set\(/)
  })

  it('keeps interface allowlists, full-path loading, no global initialization, and no registry writes', () => {
    expect(worker).toContain('new string[] { "SteamFriends017", "SteamFriends018" }')
    expect(worker).toContain('new string[] { "SteamUser020", "SteamUser021", "SteamUser022", "SteamUser023" }')
    expect(worker).toContain('new string[] { "SteamUtils009", "SteamUtils010" }')
    expect(worker).toContain('value.Dll = Path.GetFullPath(args[0])')
    expect(worker).toContain('new NativeLibrary(binding.Dll, binding.Hash')
    expect(worker).toContain('LoadLibraryExW(path, IntPtr.Zero, 0x100u | 0x800u)')
    for (const text of [worker, backend]) {
      for (const forbidden of ['SteamAPI_Init', 'SetValue(', 'CreateSubKey(', 'SteamAPI_RunCallbacks']) expect(text).not.toContain(forbidden)
    }
  })
})

describe.skipIf(!canCompile)('compiled pure native-user binding and identity policies without Steam or HKCU access', () => {
  it.each(['loaded', 'public'])('accepts only an explicit final native-user flag while retaining the legacy %s binding', kind => {
    const args = kind === 'loaded' ? loadedArgs() : publicArgs()
    expect(run(kind, args)).toBe(`ok|False|${currentHash}|23|638000000000000003`)
    expect(run(kind, [...args, '--native-user'])).toBe(`ok|True|${currentHash}|23|638000000000000003`)
    for (const invalid of [[], args.slice(0, -1), [...args, 'extra'], [...args, '--NATIVE-USER'], [...args, '--native-user', '--native-user'], ['--native-user', ...args]]) {
      expect(run(kind, invalid)).toBe('error|NATIVE_ARGUMENTS_INVALID')
    }
  })

  it.each([currentHash, previousHash])('requires an exactly audited client hash for native-user mode: %s', hash => {
    expect(run('loaded', [...loadedArgs('x64', hash), '--native-user'])).toContain('ok|True|')
    expect(run('public', [...publicArgs(hash), '--native-user'])).toContain('ok|True|')
  })

  it('preserves legacy loaded-api support while rejecting unknown native-user client profiles', () => {
    expect(run('loaded', loadedArgs('x64', 'b'.repeat(64)))).toContain('ok|False|')
    expect(run('loaded', [...loadedArgs('x64', 'b'.repeat(64)), '--native-user'])).toBe('error|NATIVE_EXPORT_MISSING')
    expect(run('public', [...publicArgs('b'.repeat(64)), '--native-user'])).toBe('error|NATIVE_EXPORT_MISSING')
  })

  it('keeps ordinary x86 loaded bindings but refuses native-user mode on x86', () => {
    expect(run('loaded', loadedArgs('x86'), 'x86')).toContain('ok|False|')
    expect(run('loaded', [...loadedArgs('x86'), '--native-user'], 'x86')).toBe('error|NATIVE_ARGUMENTS_INVALID')
    expect(run('public', [...publicArgs(), '--native-user'], 'x86')).toBe('error|NATIVE_ARGUMENTS_INVALID')
  })

  it.each([
    ['23', accountId, 0, 0], ['23', String(Number(accountId) + 1), 70, 70],
    ['24492', accountId, 0, 70], ['24492', String(Number(accountId) + 1), 0, 70],
    ['missing', accountId, 0, 73], ['23', 'missing', 0, 73], ['0', '0', 0, 73],
    ['string:23', accountId, 0, 73], ['23', `long:${accountId}`, 0, 73],
    ['23', '0', 0, 73], ['missing', 'missing', 0, 73]
  ])('treats PID=%s user=%s as a hint only in native mode without weakening legacy rules', (pid, user, native, legacy) => {
    expect(run('hint', [String(pid), String(user), '23', self])).toBe(`ok|${native}|${legacy}`)
  })

  it('handles signed registry DWORD accounts without inventing a mismatch', () => {
    const signedSelf = (0x0110000100000000n + 0x80000001n).toString()
    expect(run('hint', ['23', '-2147483647', '23', signedSelf])).toBe('ok|0|0')
    expect(run('hint', ['23', '-2147483646', '23', signedSelf])).toBe('ok|70|70')
  })

  it.each([
    ['True', self, '493520', 'ok|True'], ['True', '76561198000000002', '493520', 'ok|False'],
    ['True', self, '730', 'ok|False'], ['False', self, '493520', 'error|NATIVE_CONTEXT_UNAVAILABLE'],
    ['True', '0', '493520', 'error|NATIVE_CONTEXT_UNAVAILABLE'], ['True', self, '0', 'error|NATIVE_CONTEXT_UNAVAILABLE']
  ])('still requires actual online/user/app identity (%s, %s, %s)', (online, actualSelf, app, expected) => {
    expect(run('identity', [online, actualSelf, app, self, '493520'])).toBe(expected)
  })
})
