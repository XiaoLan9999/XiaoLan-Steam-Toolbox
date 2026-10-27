import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const project = fileURLToPath(new URL('../', import.meta.url))
const profileSource = join(project, 'scripts', 'steam-public-interface-profiles.cs')
const source = readFileSync(profileSource, 'utf8')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canCompile = process.platform === 'win32' && existsSync(compiler)
const methods = [
  'CreatePipe', 'ReleasePipe', 'ConnectUser', 'ReleaseUser', 'GetUser', 'GetFriends', 'GetUtils', 'GetGeneric', 'GetApps',
  'LoggedOn', 'SteamId', 'GetAppId', 'SubscribedApp', 'SetPresence', 'GetPresence', 'CountPresence', 'IndexPresence',
  'SendMethod', 'ResponseInfo', 'ResponseData', 'ReleaseMethod', 'SendNotification'
] as const
type Method = typeof methods[number]
type Entry = readonly [Method, number, number, number]

const profiles: { name: string; hash: string; version: string; entries: Entry[] }[] = [
  {
    name: 'legacy', hash: 'e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e', version: '11.12.30.07', entries: [
      ['CreatePipe', 0x130c398, 0, 0x516230],
      ['ReleasePipe', 0x130c398, 1, 0x7202a0],
      ['ConnectUser', 0x130c398, 2, 0x71ff40],
      ['ReleaseUser', 0x130c398, 4, 0x71ff90],
      ['GetUser', 0x130c398, 5, 0x71ffd0],
      ['GetFriends', 0x130c398, 8, 0x720070],
      ['GetUtils', 0x130c398, 9, 0x720090],
      ['GetGeneric', 0x130c398, 12, 0x7201a0],
      ['GetApps', 0x130c398, 15, 0x7200e0],
      ['LoggedOn', 0x13193c8, 1, 0x71e550],
      ['SteamId', 0x13193c8, 2, 0x722bc0],
      ['GetAppId', 0x131aab0, 9, 0x72e210],
      ['SubscribedApp', 0x130b018, 6, 0x71e810],
      ['SetPresence', 0x130e640, 41, 0x7233c0],
      ['GetPresence', 0x130e640, 43, 0x722f80],
      ['CountPresence', 0x130e640, 44, 0x723000],
      ['IndexPresence', 0x130e640, 45, 0x722fc0],
      ['SendMethod', 0x130aa78, 0, 0x71e540],
      ['ResponseInfo', 0x130aa78, 1, 0x71e520],
      ['ResponseData', 0x130aa78, 2, 0x71e500],
      ['ReleaseMethod', 0x130aa78, 3, 0x71e530],
      ['SendNotification', 0x130aa78, 4, 0x71e550]
    ]
  },
  {
    name: 'current', hash: '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc', version: '11.15.70.27', entries: [
      ['CreatePipe', 0x130c7d8, 0, 0x5162f0],
      ['ReleasePipe', 0x130c7d8, 1, 0x720360],
      ['ConnectUser', 0x130c7d8, 2, 0x720000],
      ['ReleaseUser', 0x130c7d8, 4, 0x720050],
      ['GetUser', 0x130c7d8, 5, 0x720090],
      ['GetFriends', 0x130c7d8, 8, 0x720130],
      ['GetUtils', 0x130c7d8, 9, 0x720150],
      ['GetGeneric', 0x130c7d8, 12, 0x720260],
      ['GetApps', 0x130c7d8, 15, 0x7201a0],
      ['LoggedOn', 0x1319808, 1, 0x71e610],
      ['SteamId', 0x1319808, 2, 0x722c80],
      ['GetAppId', 0x131aef0, 9, 0x72e2d0],
      ['SubscribedApp', 0x130b458, 6, 0x71e8d0],
      ['SetPresence', 0x130ea80, 41, 0x723480],
      ['GetPresence', 0x130ea80, 43, 0x723040],
      ['CountPresence', 0x130ea80, 44, 0x7230c0],
      ['IndexPresence', 0x130ea80, 45, 0x723080],
      ['SendMethod', 0x130aeb8, 0, 0x71e600],
      ['ResponseInfo', 0x130aeb8, 1, 0x71e5e0],
      ['ResponseData', 0x130aeb8, 2, 0x71e5c0],
      ['ReleaseMethod', 0x130aeb8, 3, 0x71e5f0],
      ['SendNotification', 0x130aeb8, 4, 0x71e610]
    ]
  }
]

const fixtureSource = `using System;
using System.Globalization;
internal static class ProfileFixture
{
    private static IntPtr At(IntPtr module, int offset) { return new IntPtr(module.ToInt64() + offset); }
    public static int Main(string[] args)
    {
        if (args[0] == "enum") { Console.WriteLine(String.Join("|", Enum.GetNames(typeof(SteamPublicMethod)))); return 0; }
        SteamPublicProfile profile;
        string hash = args[1] == "<null>" ? null : args[1];
        bool selected = SteamPublicProfile.TrySelect(hash, out profile);
        if (args[0] == "select")
        {
            Console.WriteLine(selected + "|" + (profile == null ? "<null>" : profile.Hash + "|" + profile.FileVersion) + "|" + SteamPublicProfile.IsSupported(hash));
            return 0;
        }
        if (!selected) return 2;
        SteamPublicProfile other = null;
        if (args[0] == "matches" && !SteamPublicProfile.TrySelect(args[2], out other)) return 3;
        foreach (SteamPublicMethod method in Enum.GetValues(typeof(SteamPublicMethod)))
        {
            SteamPublicProfile.Call call = profile.Get(method);
            if (args[0] == "table")
            {
                Console.WriteLine(call.Method + "|" + call.VtableRva.ToString(CultureInfo.InvariantCulture) + "|" + call.Slot.ToString(CultureInfo.InvariantCulture) + "|" + call.FunctionRva.ToString(CultureInfo.InvariantCulture));
            }
            else if (args[0] == "matches")
            {
                // Synthetic addresses are compared as integers and are never dereferenced.
                IntPtr module = new IntPtr(1000000000L);
                SteamPublicProfile.Call cross = other.Get(method);
                Console.WriteLine(method + "|" +
                    SteamPublicProfile.Matches(module, At(module, call.VtableRva), At(module, call.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(module, At(module, cross.VtableRva), At(module, call.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(module, At(module, call.VtableRva), At(module, cross.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(module, At(module, cross.VtableRva), At(module, cross.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(IntPtr.Zero, new IntPtr(call.VtableRva), new IntPtr(call.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(module, At(module, call.VtableRva + 1), At(module, call.FunctionRva), call) + "|" +
                    SteamPublicProfile.Matches(module, At(module, call.VtableRva), At(module, call.FunctionRva + 1), call));
            }
            else return 4;
        }
        return 0;
    }
}`

let temporary: string | undefined
let fixture: string
const tables = new Map<string, string[][]>()
const matches = new Map<string, string[][]>()

function run(...args: string[]) {
  const result = spawnSync(fixture, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return result.stdout.trim()
}

beforeAll(() => {
  if (!canCompile) return
  temporary = mkdtempSync(join(tmpdir(), 'steam-public-profiles-test-'))
  const main = join(temporary, 'fixture.cs')
  fixture = join(temporary, 'fixture.exe')
  writeFileSync(main, fixtureSource)
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/warnaserror+', '/main:ProfileFixture', `/out:${fixture}`, profileSource, main], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  for (const profile of profiles) {
    tables.set(profile.hash, run('table', profile.hash).split(/\r?\n/).map(line => line.split('|')))
    matches.set(profile.hash, run('matches', profile.hash, profiles.find(other => other !== profile)!.hash).split(/\r?\n/).map(line => line.split('|')))
  }
})

afterAll(() => {
  if (!temporary) return
  const target = resolve(temporary)
  expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true)
  rmSync(target, { recursive: true, force: true })
})

describe('public interface profile pure-source boundaries', () => {
  it('contains no DLL loader, native binding, process, registry or memory-reader execution', () => {
    for (const forbidden of ['DllImport', 'LoadLibrary', 'NativeLibrary', 'GetDelegateForFunctionPointer', 'Marshal.', 'Process.', 'Registry.', 'ReadProcessMemory', 'SteamAPI_', 'steam_api']) expect(source).not.toContain(forbidden)
  })
  it('uses exact ordinal hash matching with no version or case fallback', () => {
    expect(source.match(/StringComparison\.Ordinal\)/g)).toHaveLength(2)
    expect(source).not.toContain('OrdinalIgnoreCase')
    expect(source).not.toContain('ToLower')
    expect(source).not.toContain('ToUpper')
    expect(source).toContain('profile = null; return false;')
  })
  it.each(['build-native-presence.mjs', 'build-local-app-host.mjs'])('includes the shared profile in %s build inputs and compiler arguments', file => {
    const build = readFileSync(join(project, 'scripts', file), 'utf8')
    expect(build).toContain("'scripts', 'steam-public-interface-profiles.cs'")
    expect(build).toMatch(/\[[^\]]*plan\.source[^\]]*plan\.profileSource[^\]]*plan\.compiler[^\]]*\]/)
    expect(build).toMatch(/run\(plan\.compiler,\s*\[[^\]]*plan\.profileSource\]/)
  })
  it('uses the same exact two hashes for broker discovery and helper launch validation', () => {
    const broker = readFileSync(join(project, 'src', 'main', 'native-presence-broker.ts'), 'utf8')
    const declared = broker.match(/const PUBLIC_CLIENT_SHA256S = new Set\(\[([\s\S]*?)\]\)/)
    expect(declared).not.toBeNull()
    expect([...declared![1]!.matchAll(/'([a-f0-9]{64})'/g)].map(match => match[1])).toEqual(profiles.map(profile => profile.hash))
    expect(broker).toContain('PUBLIC_CLIENT_SHA256S.has(clientDllSha256)')
    expect(broker).toContain('PUBLIC_CLIENT_SHA256S.has(binding.clientDllSha256)')
    expect([...source.matchAll(/"([a-f0-9]{64})"/g)].map(match => match[1])).toEqual(profiles.map(profile => profile.hash))
  })
})

describe.skipIf(!canCompile)('standalone public interface profile pure fixtures', () => {
  it('exposes exactly all 22 audited methods with no omitted enum entry', () => {
    expect(run('enum').split('|')).toEqual(methods)
    expect(methods).toHaveLength(22)
  })
  for (const profile of profiles) {
    describe(profile.name, () => {
      it('selects only its exact SHA256 and reports the audited file version', () => {
        expect(run('select', profile.hash)).toBe(`True|${profile.hash}|${profile.version}|True`)
        expect(tables.get(profile.hash)).toHaveLength(22)
        expect(tables.get(profile.hash)!.map(row => row[0])).toEqual(methods)
      })
      it.each(profile.entries)('pins %s to audited vtable %i, slot %i and function %i', (method, vtable, slot, fn) => {
        expect(tables.get(profile.hash)!.find(row => row[0] === method)).toEqual([method, String(vtable), String(slot), String(fn)])
      })
      it.each(methods)('accepts only the matching module-relative addresses for %s', method => {
        expect(matches.get(profile.hash)!.find(row => row[0] === method)).toEqual([method, 'True', 'False', 'False', 'False', 'False', 'False', 'False'])
      })
    })
  }
  it.each([
    '<null>', '', 'unknown', '0'.repeat(64), 'f'.repeat(64),
    ...profiles.flatMap(profile => [profile.hash.toUpperCase(), ` ${profile.hash}`, `${profile.hash} `, profile.hash.slice(0, -1), `${profile.hash}0`, `${profile.hash.slice(0, -1)}0`, profile.version])
  ])('fails closed for unsupported or noncanonical hash %j', hash => {
    expect(run('select', hash)).toBe('False|<null>|False')
  })
})
