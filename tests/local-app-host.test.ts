import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LocalAppHostBroker } from '../src/main/local-app-simulation'
import { richPresenceContract } from '../src/shared/rich-presence-contract'

interface Metadata { architecture: string; fileName: string; bytes: number; sha256: string }
interface Options { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; outputDirectory?: string; run?: typeof spawnSync }
interface Build { inspectLocalAppHost(bytes: Buffer): Metadata; localAppHostBuildPlan(options?: Options): { source: string; contractSource: string; profileSource: string; outputDirectory: string; fileName: string }; buildLocalAppHost(options?: Options): Metadata }
const { inspectLocalAppHost, localAppHostBuildPlan, buildLocalAppHost } = await import(new URL('../scripts/build-local-app-host.mjs', import.meta.url).href) as Build
const project = fileURLToPath(new URL('../', import.meta.url)); const source = join(project, 'scripts', 'local-app-host.cs')
const profileSource = join(project, 'scripts', 'steam-public-interface-profiles.cs')
const contractSource = join(project, 'scripts', 'rich-presence-contract.generated.cs')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const folders: string[] = []; const children = new Set<ChildProcessWithoutNullStreams>()
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'local-app-host-test-')); folders.push(path); return path }
afterEach(async () => { for (const child of children) { child.stdin.end(); if (child.exitCode === null) { await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(null) }, 1500); child.once('close', () => { clearTimeout(timer); resolve(null) }) }) } }; children.clear() })
afterAll(() => { for (const path of folders) { expect(resolve(path).startsWith(resolve(tmpdir()) + sep)).toBe(true); rmSync(path, { recursive: true, force: true }) } })
const rpc = (requestId: string, op: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, requestId, op, ...extra })
function pe() { const bytes = Buffer.alloc(256); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88); return bytes }
async function readNativeFrameThroughBroker(frame: Record<string, unknown>) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { queueMicrotask(() => child.emit('close', 0)); return true } })
  child.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk))
    if (request.op === 'stop') { queueMicrotask(() => child.emit('close', 0)); return }
    queueMicrotask(() => child.stdout.write(JSON.stringify({ ...frame, requestId: request.requestId }) + '\n'))
  })
  const broker = new LocalAppHostBroker({ getWorkerPath: () => '', discover: async () => ({ worker: 'D:/fixture/host.exe', clientDll: 'D:/Steam/steamclient64.dll', clientSha256: 'a'.repeat(64) }), spawn: () => {
    queueMicrotask(() => child.stdout.write(JSON.stringify({ v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [], mayHaveWritten: false, identityMatch: true, appMatch: true, licensed: true, selectedInterfaces: { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' } }) + '\n'))
    return child as unknown as ChildProcessWithoutNullStreams
  } })
  try { return await broker.begin({ appId: 0, activeAppIds: [], steamId: '76561198000000001', steamPid: 1, steamStartTicks: '123', steamExe: 'D:/Steam/steam.exe', ownerPid: 2, ownerStartTicks: '456' }, 1329410, () => true) }
  finally { await broker.shutdown() }
}

describe('local app host build and static ABI safety', () => {
  it('does not initialize Steam API, create files, log on to CM or query other friends', () => {
    const enabled = [true]; const production: string[] = []
    for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('#if LOCAL_APP_HOST_TEST')) enabled.push(false)
      else if (line.startsWith('#else')) enabled[enabled.length - 1] = !enabled.at(-1)
      else if (line.startsWith('#endif')) enabled.pop()
      else if (enabled.every(Boolean)) production.push(line)
    }
    const code = production.join('\n')
    for (const forbidden of ['SteamAPI_Init', 'SteamAPI_Shutdown', 'SteamAPI_RunCallbacks', 'steam_appid', 'ClearRichPresence', 'RequestFriendRichPresence', 'SetPersona', 'ReadProcessMemory', 'MainModule', 'Process.Start', '.Kill(', 'TcpClient', 'WebSocket', 'File.Write', 'SetValue(']) expect(code).not.toContain(forbidden)
    expect(code).toContain('EnvironmentVariableTarget.Process'); expect(code).toContain('ProcessMatches(OwnerPid, OwnerStart, null)')
    expect(code).toContain('ProcessMatches(SteamPid, SteamStart, SteamExe)'); expect(code).toContain('Registry.CurrentUser.OpenSubKey')
    expect(code).toContain('binding.ValidateDll()'); expect(code).toContain('result.AppId == 480')
    expect(code).toContain('private delegate IntPtr SteamId(IntPtr self, IntPtr result)'); expect(code).toContain('steamId(user, result) != result')
    expect(code).toContain('Marshal.ReadIntPtr(instance) != Address(expected.VtableRva)'); expect(code).toContain('SteamPublicProfile.Matches(module, Marshal.ReadIntPtr(instance), function, expected)')
    expect(code).toContain('SteamPublicProfile.TrySelect(binding.Hash, out profile)'); expect(code).toContain('SteamPublicProfile.IsSupported(Hash)')
    for (const method of ['SteamId', 'SetPresence', 'SubscribedApp', 'SendMethod']) expect(code).toContain(`SteamPublicMethod.${method}`)
    const profiles = readFileSync(profileSource, 'utf8')
    expect(profiles).toContain('e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e')
    expect(profiles).toContain('253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc')
    expect(code).toContain('Community.GetAppRichPresenceLocalization#1'); expect(code).toContain('STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001')
    expect(code).not.toContain('CLIENTENGINE_'); expect(code).not.toContain('GetIClient')
    expect(code).toContain('displayTokenReadable\\\":false'); expect(code).toContain('if (key == "steam_display")')
  })
  it('builds only the x64 host with csc and validates the compiled image', () => {
    const root = temporary(); mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts', 'local-app-host.cs'), 'fixture')
    writeFileSync(join(root, 'scripts', 'steam-public-interface-profiles.cs'), 'fixture-profile')
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    writeFileSync(join(root, 'src', 'shared', 'rich-presence-contract.json'), readFileSync(join(project, 'src', 'shared', 'rich-presence-contract.json')))
    writeFileSync(join(root, 'scripts', 'rich-presence-contract.generated.cs'), readFileSync(contractSource))
    const csc = join(root, 'csc-fixture.exe'); writeFileSync(csc, 'fixture')
    const run = vi.fn((_compiler: string, args: readonly string[]) => { writeFileSync(args.find(value => value.startsWith('/out:'))!.slice(5), pe()); return { status: 0 } })
    const options = { root, platform: 'win32', windowsDirectory: root, compiler: csc, run: run as unknown as typeof spawnSync }
    const plan = localAppHostBuildPlan(options); expect(plan.outputDirectory).toBe(join(root, 'resources', 'local-app-simulation')); expect(plan.fileName).toBe('local-app-host-x64.exe')
    expect(plan.profileSource).toBe(join(root, 'scripts', 'steam-public-interface-profiles.cs'))
    expect(buildLocalAppHost(options)).toMatchObject({ architecture: 'x64', fileName: plan.fileName })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['/platform:x64', '/target:exe', '/warnaserror+']))
    expect(run.mock.calls[0]![1]).toContain(plan.profileSource)
    expect(run.mock.calls[0]![1]).toContain(plan.contractSource)
    expect(() => inspectLocalAppHost(Buffer.alloc(256))).toThrow('Invalid')
    const x86 = pe(); x86.writeUInt16LE(0x14c, 68); expect(() => inspectLocalAppHost(x86)).toThrow('x64')
    expect(() => localAppHostBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
    expect(() => localAppHostBuildPlan({ ...options, outputDirectory: 'relative' })).toThrow('absolute')
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('managed fake interfaces only (never loads Steam)', () => {
  let fixture = ''
  beforeAll(() => {
    fixture = join(temporary(), 'fixture.exe')
    const compiled = spawnSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/define:LOCAL_APP_HOST_TEST', '/optimize+', '/debug-', '/warnaserror+', `/out:${fixture}`, source, contractSource, profileSource], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0)
  })
  function run(mode: string, lines: string[] = []) {
    const result = spawnSync(fixture, ['--test-fake', mode], { input: lines.length ? lines.join('\n') + '\n' : '', windowsHide: true, encoding: 'utf8', timeout: 5000 })
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe('')
    return { status: result.status, frames: result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, any>) }
  }
  it('compiles a production x64 binary without executing it', () => { expect(buildLocalAppHost({ outputDirectory: temporary() }).architecture).toBe('x64') })
  it('reports verified startup facts without claiming a friend display', () => {
    const result = run('success', [rpc('1', 'ping'), rpc('2', 'stop')]); expect(result.status).toBe(0)
    expect(result.frames[0]).toEqual({ v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [], mayHaveWritten: false, identityMatch: true, appMatch: true, licensed: true, selectedInterfaces: { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' } })
    expect(result.frames[1]).toMatchObject({ op: 'pong', requestId: '1' }); expect(result.frames[2]).toMatchObject({ op: 'stopped' })
  })
  it('submits all safe parameters before steam_display and reads only public local-cache data', () => {
    const result = run('success', [rpc('1', 'apply', { changes: { steam_display: '#Fixture', desc: '王座之间 四人东', status: 'Ready' } }), rpc('2', 'read'), rpc('3', 'stop')])
    expect(result.status).toBe(0); expect(result.frames[1]).toMatchObject({ acceptedKeys: ['desc', 'status', 'steam_display'], mayHaveWritten: true, op: 'applied' })
    expect(result.frames[2]).toMatchObject({ op: 'read', fields: { desc: '王座之间 四人东', status: 'Ready' }, verificationSource: 'local-cache', displayTokenReadable: false, localizedString: 'Fixture localized state' })
    expect(result.frames[2]!.fields).not.toHaveProperty('steam_display')
  })
  it('serializes a legal escaped maximum read through native C# and the broker without the old 16 KiB rejection', async () => {
    const result = run('read-frame-boundary', [rpc('1', 'read'), rpc('2', 'stop')])
    expect(result.status).toBe(0)
    const frame = result.frames.find(frame => frame.op === 'read')!
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeGreaterThan(richPresenceContract.transport.requestLineBytes)
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(richPresenceContract.transport.ordinaryFrameBytes)
    expect(await readNativeFrameThroughBroker(frame)).toEqual({ fields: frame.fields, localizedString: frame.localizedString, verificationSource: 'local-cache' })
  })
  it('can remove an explicitly selected field without clearing unknown RP', () => {
    const result = run('success', [rpc('1', 'apply', { changes: { desc: null } }), rpc('2', 'read')])
    expect(result.frames[1]).toMatchObject({ acceptedKeys: ['desc'] }); expect(result.frames[2]!.fields).toEqual({})
  })
  it.each(['1', '2147483647'])('owns a private group internally for canonical visible size %s', size => {
    const result = run('success', [rpc('1', 'apply', { changes: { steam_player_group_size: size } }), rpc('2', 'read')])
    expect(result.frames[1]).toMatchObject({ ok: true, acceptedKeys: ['steam_player_group_size'] })
    expect(result.frames[2]!.fields).toMatchObject({ steam_player_group_size: size, desc: 'Fixture baseline' })
    expect(result.frames[2]!.fields).not.toHaveProperty('steam_player_group')
    expect(JSON.stringify(result.frames)).not.toContain('FAKE_EXTERNAL_GROUP_NEVER_OUTPUT')
  })
  it('removes only its owned group when size is explicitly removed', () => {
    const result = run('success', [rpc('1', 'apply', { changes: { steam_player_group_size: '3' } }), rpc('2', 'apply', { changes: { steam_player_group_size: null } }), rpc('3', 'read')])
    expect(result.frames[2]).toMatchObject({ ok: true, acceptedKeys: ['steam_player_group_size'] })
    expect(result.frames[3]!.fields).toEqual({ desc: 'Fixture baseline' })
  })
  it('reads the public size but never emits an external raw group ID', () => {
    const result = run('size-read', [rpc('1', 'read')])
    expect(result.frames[1]!.fields.steam_player_group_size).toBe('3')
    expect(result.frames[1]!.fields).not.toHaveProperty('steam_player_group')
    expect(JSON.stringify(result.frames)).not.toContain('FAKE_EXTERNAL_GROUP_NEVER_OUTPUT')
    expect(run('size-invalid', [rpc('1', 'read')]).frames[1]).toMatchObject({ code: 'LOCAL_APP_READ_FAILED' })
  })
  it.each(['3', null])('preflights an external group conflict before all other writes (size %j)', size => {
    const result = run('group-external', [rpc('1', 'apply', { changes: { desc: 'Must remain untouched', steam_player_group_size: size } })])
    expect(result.frames[1]).toMatchObject({ code: 'LOCAL_APP_SET_REJECTED', acceptedKeys: [], mayHaveWritten: false })
    expect(JSON.stringify(result.frames)).not.toContain('FAKE_EXTERNAL_GROUP_NEVER_OUTPUT')
  })
  it('does not overwrite a group replaced after its first owned update', () => {
    const result = run('group-conflict-after-read', [rpc('1', 'apply', { changes: { steam_player_group_size: '3' } }), rpc('2', 'read'), rpc('3', 'apply', { changes: { steam_player_group_size: '4', desc: 'Must remain untouched' } })])
    expect(result.frames[1]).toMatchObject({ ok: true, acceptedKeys: ['steam_player_group_size'] })
    expect(result.frames[3]).toMatchObject({ code: 'LOCAL_APP_SET_REJECTED', acceptedKeys: [], mayHaveWritten: false })
  })
  it('reserves the extra internal group key within the total 20-key limit before writes', () => {
    expect(run('group-full', [rpc('1', 'apply', { changes: { desc: 'Untouched', steam_player_group_size: '3' } })]).frames[1]).toMatchObject({ code: 'LOCAL_APP_SET_REJECTED', acceptedKeys: [], mayHaveWritten: false })
    const cleared = run('group-full', [rpc('1', 'apply', { changes: { field0: null, field1: null, steam_player_group_size: '3' } })])
    expect(cleared.frames[1]).toMatchObject({ ok: true, acceptedKeys: ['field0', 'field1', 'steam_player_group_size'] })
  })
  it.each(['0', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '2147483648', '\u0661', 1, false])('rejects noncanonical size %j and keeps raw group ID externally read-only', size => {
    expect(run('success', [rpc('1', 'apply', { changes: { steam_player_group_size: size } })]).frames[1]).toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it.each(['injected', null])('rejects generic raw group ID input %j', value => {
    expect(run('success', [rpc('1', 'apply', { changes: { steam_player_group: value } })]).frames[1]).toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it.each([
    ['owned', false, false, false, 2, 2], ['remove', false, false, false, 2, 2],
    ['external', true, true, true, 0, 0], ['conflict', true, true, true, 1, 1], ['context', true, true, false, 1, 1],
    ['reject-size', false, false, false, 2, 2], ['appearance', true, false, true, 0, 0], ['replacement', true, false, true, 1, 0]
  ])('cleans private owned state safely on %s without changing unrelated RP', (mode, groupPresent, sizePresent, externalPreserved, groupWrites, sizeWrites) => {
    const result = spawnSync(fixture, ['--test-group-cleanup', String(mode)], { windowsHide: true, encoding: 'utf8', timeout: 4000 })
    expect(result.status).toBe(0)
    const frames = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(frames.at(-1)).toMatchObject({ fixtureGroup: true, groupPresent, sizePresent, externalPreserved, unrelatedPreserved: true, groupWrites, sizeWrites })
    expect(result.stdout).not.toContain('FAKE_EXTERNAL_GROUP_NEVER_OUTPUT')
  })
  it.each(['identity', 'app', 'license', 'init-failed'])('fails closed at startup on %s and exposes no private SDK error', mode => {
    const result = run(mode); const failed = result.frames.find(frame => frame.requestId === 'startup')!
    expect(result.status).not.toBe(0); expect(failed.ok).toBe(false); expect(failed.mayHaveWritten).toBe(false)
    expect(result.frames.some(frame => frame.op === 'applied')).toBe(false)
  })
  it.each([
    ['reject-second', 'LOCAL_APP_SET_REJECTED'], ['context-after-write', 'LOCAL_APP_CONTEXT_CHANGED']
  ])('reports partial/uncertain writes for %s and never retries', (mode, code) => {
    const result = run(mode, [rpc('1', 'apply', { changes: { desc: 'One', status: 'Two', steam_display: '#Fixture' } })])
    expect(result.status).not.toBe(0); expect(result.frames[1]).toMatchObject({ code, acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each(['release-user-failed', 'release-pipe-failed', 'unload-failed', 'release-user-exception', 'release-pipe-exception', 'unload-exception'])('continues all release steps after %s and reports false cleanup', mode => {
    const result = run(mode, [rpc('1', 'stop')]); expect(result.status).toBe(74)
    expect(result.frames.filter(frame => frame.op === 'lifecycle').map(frame => frame.stage)).toEqual(['release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned', 'free-client-library', 'cleanup-complete'])
    expect(result.frames.at(-1)).toMatchObject({ stage: 'cleanup-complete', ok: false })
  })
  it('keeps lifecycle frames at the exact safe six-key contract', () => {
    for (const frame of run('success').frames.filter(frame => frame.op === 'lifecycle')) { expect(Object.keys(frame).sort()).toEqual(['elapsedMs', 'ok', 'op', 'requestId', 'stage', 'v']); expect(Number.isSafeInteger(frame.elapsedMs)).toBe(true); expect(frame.elapsedMs).toBeGreaterThanOrEqual(0) }
  })
  it.each([
    rpc('x', 'apply', { changes: { connect: 'private' } }), rpc('x', 'apply', { changes: { desc: 'x', Desc: 'y' } }), rpc('x', 'apply', { changes: { version: 'fake' } }),
    rpc('x', 'apply', { changes: { steam_display: 'not-a-template' } }), rpc('x', 'apply', { changes: { desc: 'x\ny' } }), rpc('x', 'apply', { changes: { desc: '蓝'.repeat(86) } }),
    rpc('x', 'apply', { changes: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field${index}`, 'x'])) }),
    rpc('x', 'ping', { extra: 'unknown' }), '{"v":1,"requestId":"x","op":"ping","op":"ping"}', rpc('x', 'catalog', { language: 'unknown' }), rpc('startup', 'ping')
  ])('validates the entire request before any mutation: %s', line => {
    const result = run('success', [line]); expect(result.status).not.toBe(0)
    expect(result.frames.find(frame => frame.op === 'error')).toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it('rejects duplicate request IDs without imposing a total-session command budget', () => {
    const result = run('success', [rpc('x', 'ping'), rpc('x', 'ping')]); expect(result.frames.find(frame => frame.op === 'error')).toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID' })
  })
  it.each(['catalog-timeout', 'catalog-unavailable'])('does not terminate the idle app on ordinary %s', mode => {
    const result = run(mode, [rpc('1', 'catalog', { language: 'english' }), rpc('2', 'ping'), rpc('3', 'stop')])
    expect(result.status).toBe(0); expect(result.frames[1]).toMatchObject({ op: 'catalog', ok: true, available: false, tokens: {}, mayHaveWritten: false }); expect(result.frames[2]).toMatchObject({ op: 'pong' })
  })
  it('reports a bounded Steam result separately from an empty published catalog', () => {
    const result = run('catalog-denied', [rpc('1', 'catalog', { language: 'english' }), rpc('2', 'ping'), rpc('3', 'stop')])
    expect(result.status).toBe(0); expect(result.frames[1]).toMatchObject({ op: 'catalog', available: false, tokens: {}, code: 'LOCAL_APP_CATALOG_UNAVAILABLE', steamResult: 15 }); expect(result.frames[2]).toMatchObject({ op: 'pong' })
  })
  it('expires an unresponsive parent heartbeat but has no total-session lifetime', async () => {
    const child = spawn(fixture, ['--test-fake', 'success'], { windowsHide: true, stdio: 'pipe' }); children.add(child)
    let buffer = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { buffer += value })
    await vi.waitFor(() => expect(buffer).toContain('"op":"ready"'))
    for (let index = 0; index < 4; index++) { child.stdin.write(rpc(String(index), 'ping') + '\n'); await new Promise(resolve => setTimeout(resolve, 250)) }
    expect(child.exitCode).toBeNull()
    const exit = await new Promise<number | null>(resolve => child.once('close', resolve)); expect(exit).not.toBe(0); expect(buffer).toContain('LOCAL_APP_TIMEOUT'); children.delete(child)
  })
})

function varint(input: number) { const result: number[] = []; do { const value = input & 127; input >>>= 7; result.push(value | (input ? 128 : 0)) } while (input); return Buffer.from(result) }
const field = (id: number, value: Buffer) => Buffer.concat([varint(id * 8 + 2), varint(value.length), value])
function catalog(app = 1329410, language = 'english', tokens: Array<[string, string]> = [['#Fixture', '%desc%']]) {
  return Buffer.concat([Buffer.from([8]), varint(app), languageCatalog(language, tokens)])
}
function languageCatalog(language: string, tokens: Array<[string, string]>) {
  const entries = tokens.map(([name, value]) => field(2, Buffer.concat([field(1, Buffer.from(name)), field(2, Buffer.from(value))])))
  return field(2, Buffer.concat([field(1, Buffer.from(language)), ...entries]))
}
describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('bounded pure protobuf localization fixtures', () => {
  let fixture = ''
  beforeAll(() => {
    fixture = join(temporary(), 'proto-fixture.exe'); const result = spawnSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/define:LOCAL_APP_HOST_TEST', '/optimize+', '/debug-', '/warnaserror+', `/out:${fixture}`, source, contractSource, profileSource], { windowsHide: true, encoding: 'utf8', timeout: 30000 }); expect(result.status, result.stdout + result.stderr).toBe(0)
  })
  function parse(bytes: Buffer) { const result = spawnSync(fixture, ['--test-proto', '1329410', 'english'], { input: bytes.toString('base64'), windowsHide: true, encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 }); expect(result.error).toBeUndefined(); return { status: result.status, frame: JSON.parse(result.stdout.trim().split(/\r?\n/)[0]!) } }
  it('parses only the matching app and language into actual public tokens', () => { expect(parse(catalog()).frame).toMatchObject({ op: 'catalog', available: true, tokens: { '#Fixture': '%desc%' } }); expect(parse(catalog(730)).frame).toMatchObject({ available: false, code: 'LOCAL_APP_CATALOG_APP_MISMATCH' }); expect(parse(catalog(1329410, 'schinese')).frame).toMatchObject({ available: false, code: 'LOCAL_APP_CATALOG_LANGUAGE_MISSING' }) })
  it('keeps a successful matching empty publication distinct from a missing language or malformed response', () => {
    expect(parse(catalog(1329410, 'english', [])).frame).toEqual({ v: 1, requestId: 'fixture', op: 'catalog', ok: true, acceptedKeys: [], mayHaveWritten: false, available: true, tokens: {} })
    expect(parse(Buffer.from([8, ...varint(1329410)])).frame).toMatchObject({ available: false, code: 'LOCAL_APP_CATALOG_LANGUAGE_MISSING' })
    expect(parse(languageCatalog('english', [])).frame).toMatchObject({ available: false, code: 'LOCAL_APP_CATALOG_RESPONSE_INVALID' })
  })
  it.each([256, 257, 1024])('accepts a bounded published directory with %i tokens', count => {
    const tokens = Array.from({ length: count }, (_, index) => [`#F${index}`, 'Ready'] as [string, string]); const result = parse(catalog(1329410, 'english', tokens))
    expect(result.status).toBe(0); expect(result.frame.available).toBe(true); expect(Object.keys(result.frame.tokens)).toHaveLength(count)
  })
  it('accepts bounded catalogs beyond the old 64 KiB limit and raw 4096-byte values', () => {
    const tokens = Array.from({ length: 127 }, (_, index) => [`#F${index}`, 'x'.repeat(4096)] as [string, string]); const result = parse(catalog(1329410, 'english', tokens))
    expect(result.status).toBe(0); expect(result.frame.tokens['#F126']).toHaveLength(4096)
  })
  it.each([-1, 0, 1])('uses exactly the same raw JSON-byte boundary through native protobuf output and the broker (%i)', async offset => {
    const maximum = richPresenceContract.catalog.jsonBytes + offset
    const entries: Array<[string, string]> = Array.from({ length: 63 }, (_, index) => [`#F${index}`, '\\'.repeat(4096)])
    entries.push(['#Boundary', ''])
    const remaining = maximum - Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)))
    entries[entries.length - 1]![1] = '\\'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2)
    expect(Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)))).toBe(maximum)
    const result = parse(catalog(1329410, 'english', entries))
    if (offset > 0) { expect(result.status).not.toBe(0); return }
    expect(result.status).toBe(0); expect(result.frame.available).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.frame.tokens))).toBe(maximum)
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { queueMicrotask(() => child.emit('close', 0)); return true } })
    child.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk))
      if (request.op === 'stop') { queueMicrotask(() => child.emit('close', 0)); return }
      const frame = request.op === 'catalog' ? { ...result.frame, requestId: request.requestId } : { v: 1, requestId: request.requestId, op: request.op, ok: true, acceptedKeys: [], mayHaveWritten: false, keyCount: 0, fields: {}, localizedString: null, verificationSource: 'local-cache' }
      queueMicrotask(() => child.stdout.write(JSON.stringify(frame) + '\n'))
    })
    const broker = new LocalAppHostBroker({ getWorkerPath: () => '', discover: async () => ({ worker: 'D:/fixture/host.exe', clientDll: 'D:/Steam/steamclient64.dll', clientSha256: 'a'.repeat(64) }), spawn: () => {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [], mayHaveWritten: false, identityMatch: true, appMatch: true, licensed: true, selectedInterfaces: { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' } }) + '\n'))
      return child as unknown as ChildProcessWithoutNullStreams
    } })
    try {
      await broker.begin({ appId: 0, activeAppIds: [], steamId: '76561198000000001', steamPid: 1, steamStartTicks: '123', steamExe: 'D:/Steam/steam.exe', ownerPid: 2, ownerStartTicks: '456' }, 1329410, () => true)
      expect(await broker.catalog('english', () => true)).toEqual({ available: true, tokens: result.frame.tokens })
    } finally { await broker.shutdown() }
  })
  it('ignores unrelated language token counts and contents, including entries before its language field', () => {
    const foreign = languageCatalog('schinese', Array.from({ length: 1200 }, (_, index) => [`#F${index}`, 'x'] as [string, string]))
    const malformedForeign = field(2, Buffer.concat([field(2, Buffer.from([0])), field(1, Buffer.from('french'))]))
    const invalidUtf8Foreign = field(2, Buffer.concat([field(1, Buffer.from('german')), field(2, Buffer.from([10, 1, 255]))]))
    const result = parse(Buffer.concat([catalog(), foreign, malformedForeign, invalidUtf8Foreign]))
    expect(result.status).toBe(0); expect(result.frame.tokens).toEqual({ '#Fixture': '%desc%' })
  })
  it('accepts up to 64 bounded language tables regardless of their order', () => {
    const others = Array.from({ length: 63 }, (_, index) => languageCatalog(`fixture${index}`, []))
    expect(parse(Buffer.concat([Buffer.from([8]), varint(1329410), ...others, languageCatalog('english', [['#Ready', 'Ready']])])).frame).toMatchObject({ available: true, tokens: { '#Ready': 'Ready' } })
    expect(parse(Buffer.concat([catalog(), ...others, languageCatalog('extra', [])])).status).not.toBe(0)
  })
  it.each([Buffer.from([0]), Buffer.from([8, 128]), catalog(1329410, 'english', [['#A', '1'], ['#A', '2']]), catalog(1329410, 'english', Array.from({ length: 1025 }, (_, index) => [`#F${index}`, 'x'] as [string, string])), catalog(1329410, 'english', [['#Big', 'x'.repeat(4097)]]), catalog(1329410, 'english', Array.from({ length: 128 }, (_, index) => [`#F${index}`, 'x'.repeat(4096)] as [string, string])), Buffer.concat([catalog(), field(3, Buffer.alloc(4 * 1024 * 1024))]), Buffer.concat([catalog(), languageCatalog('english', [])])])('rejects malformed, duplicate or independently excessive selected data', bytes => { expect(parse(bytes).status).not.toBe(0) })
})
