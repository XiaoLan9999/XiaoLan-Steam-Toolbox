import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverNativePresenceBinding, mergeNativePresenceProcessLists, nativePresencePeArchitecture, NativePresenceBroker, NativePresenceError, type NativePresenceBinding, type NativePresenceContext, type NativePresenceLifecycleEvent, type NativePresenceProcessList } from '../src/main/native-presence-broker'
import { richPresenceContract } from '../src/shared/rich-presence-contract'

const context: NativePresenceContext = { appId: 1329410, steamId: '76561198000000001' }
const GAME_PID = 2147483001
const START = '638965000000000001'
const PARENT_START = '638964000000000001'
const folders: string[] = []
const brokers: NativePresenceBroker[] = []

function pe(arch: 'x86' | 'x64' = 'x86') {
  const bytes = Buffer.alloc(256)
  bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(arch === 'x86' ? 0x14c : 0x8664, 132)
  bytes.writeUInt16LE(arch === 'x86' ? 0x10b : 0x20b, 152)
  return bytes
}
async function fixture(arch: 'x86' | 'x64' = 'x86') {
  const created = await mkdtemp(join(tmpdir(), 'native-presence-'))
  folders.push(created)
  const root = await realpath(created)
  const steam = join(root, 'Steam')
  const installed = join(steam, 'steamapps', 'common', 'Fixture Game')
  const workerDirectory = join(root, 'resources', 'native-presence')
  await mkdir(installed, { recursive: true }); await mkdir(workerDirectory, { recursive: true })
  const gameExe = join(installed, 'FixtureGame.exe')
  const dllPath = join(installed, arch === 'x86' ? 'steam_api.dll' : 'steam_api64.dll')
  const clientDllPath = join(steam, arch === 'x86' ? 'steamclient.dll' : 'steamclient64.dll')
  const steamExe = join(steam, 'steam.exe')
  await writeFile(gameExe, pe(arch)); await writeFile(dllPath, pe(arch))
  await writeFile(clientDllPath, pe(arch)); await writeFile(steamExe, pe('x64'))
  for (const value of ['x86', 'x64'] as const) await writeFile(join(workerDirectory, `worker-${value}.exe`), pe(value))
  const manifest = join(steam, 'steamapps', `appmanifest_${context.appId}.acf`)
  await writeFile(manifest, `"AppState" { "appid" "${context.appId}" "installdir" "Fixture Game" }`)
  const binding: NativePresenceBinding = { gamePid: GAME_PID, gameStartTicks: START, gameExe, dllPath, dllSha256: createHash('sha256').update(pe(arch)).digest('hex'), clientDllPath, clientDllSha256: createHash('sha256').update(pe(arch)).digest('hex'), arch, parentPid: process.pid, parentStartTicks: PARENT_START, steamPid: GAME_PID - 2, steamStartTicks: PARENT_START }
  const processes: NativePresenceProcessList = { parentPid: process.pid, parentStartTicks: PARENT_START, steamProcess: { pid: GAME_PID - 2, startTicks: PARENT_START, exe: steamExe }, processes: [{ pid: GAME_PID, startTicks: START, exe: gameExe, modules: [dllPath, clientDllPath] }] }
  return { root, steam, installed, workerDirectory, manifest, binding, processes }
}

class FakeWorker extends EventEmitter {
  pid = 40000
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  requests: Array<Record<string, unknown>> = []
  readResult: Record<string, unknown> = { fields: { desc: 'Fixture native description' }, localizedString: 'Fixture native description', displayTokenReadable: false, verificationSource: 'local-cache', keyCount: 3 }
  stopCloses = true
  handler: ((request: Record<string, unknown>) => void) | null = null
  stdin: Writable
  kill = vi.fn(() => { this.finish(); return true })
  constructor(startup: Record<string, unknown> | null = { v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [], mayHaveWritten: false }, noise = '') {
    super()
    let buffer = ''
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>
        buffer = buffer.slice(end + 1)
        this.requests.push(request)
        if (request.op === 'stop') { if (this.stopCloses) this.finish() }
        else if (this.handler) this.handler(request)
        else this.reply(request)
      }
      done()
    } })
    queueMicrotask(() => { if (noise) this.stdout.write(noise); if (startup) this.send(startup) })
  }
  send(message: Record<string, unknown>) { this.stdout.write(Buffer.from(JSON.stringify(message) + '\n')) }
  reply(request: Record<string, unknown>) {
    if (request.op === 'read') this.send({ v: 1, requestId: request.requestId, op: 'read', ok: true, acceptedKeys: [], mayHaveWritten: false, identityMatch: true, appMatch: true, loggedOn: true, gameStillSame: true, ...this.readResult })
    else this.send({ v: 1, requestId: request.requestId, op: 'applied', ok: true, acceptedKeys: Object.keys(request.changes as object), mayHaveWritten: true })
  }
  finish(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('close', code) }
  child() { return this as unknown as ChildProcessWithoutNullStreams }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const lifecycle = (stage: string, ok: boolean | null = true, elapsedMs = 0): Record<string, unknown> => ({ v: 1, requestId: 'lifecycle', op: 'lifecycle', stage, ok, elapsedMs })

afterEach(async () => {
  for (const broker of brokers.splice(0)) broker.stop()
  for (const root of folders.splice(0)) { expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true); await rm(root, { recursive: true, force: true }) }
})

describe('scoped native game discovery', () => {
  it.each(['x86', 'x64'] as const)('binds only an installed running game and its actually loaded %s DLL', async arch => {
    const f = await fixture(arch)
    const queryProcesses = vi.fn(async () => f.processes)
    const result = await discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses })
    expect(result).toEqual(f.binding)
    expect(queryProcesses).toHaveBeenCalledExactlyOnceWith([f.installed], process.pid)
  })

  it('rejects unsupported OS without discovering files or processes', async () => {
    const steamRoots = vi.fn(async () => [])
    await expect(discoverNativePresenceBinding(context, { platform: 'linux', steamRoots })).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_UNAVAILABLE', nativeCode: 'NATIVE_UNSUPPORTED' })
    expect(steamRoots).not.toHaveBeenCalled()
  })

  it('does not substitute a DLL found on disk when no running process has loaded it', async () => {
    const f = await fixture()
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => ({ ...f.processes, processes: [] }) })).rejects.toMatchObject({ nativeCode: 'NATIVE_GAME_NOT_FOUND' })
  })

  it('keeps module-query failure separate from a process that simply has no Steam API', async () => {
    const f = await fixture('x64')
    const restricted = { ...f.processes, processes: [{ ...f.processes.processes[0]!, modules: [], modulesUnavailable: true }] }
    expect(mergeNativePresenceProcessLists([restricted, restricted], process.pid).processes[0]!.modulesUnavailable).toBe(true)
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => restricted })).rejects.toMatchObject({ nativeCode: 'NATIVE_DLL_INVALID' })
    const ordinary = { ...restricted, processes: [{ ...restricted.processes[0]!, modulesUnavailable: false }] }
    for (const sources of [[restricted, ordinary], [ordinary, restricted]]) {
      expect(mergeNativePresenceProcessLists(sources, process.pid).processes[0]!.modulesUnavailable).not.toBe(true)
    }
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => ordinary })).rejects.toMatchObject({ nativeCode: 'NATIVE_GAME_NOT_FOUND' })
  })

  it('reads only the selected AppID manifest, including an explicitly configured library', async () => {
    const f = await fixture()
    const launcher = join(f.root, 'Launcher')
    await mkdir(join(launcher, 'steamapps'), { recursive: true })
    await writeFile(join(launcher, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${f.steam.replaceAll('\\', '\\\\')}" } }`)
    await writeFile(join(f.steam, 'steamapps', 'appmanifest_999999.acf'), 'not valid VDF and must never be read')
    expect(await discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [launcher, f.steam], queryProcesses: async () => f.processes })).toEqual(f.binding)
  })

  it.each(['../Fixture Game', 'nested/../Fixture Game', '.', ''])('rejects unsafe install directory %j', async directory => {
    const f = await fixture()
    await writeFile(f.manifest, `"AppState" { "appid" "${context.appId}" "installdir" "${directory}" }`)
    const queryProcesses = vi.fn(async () => f.processes)
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses })).rejects.toMatchObject({ nativeCode: 'NATIVE_DISCOVERY_FAILED' })
    expect(queryProcesses).not.toHaveBeenCalled()
  })

  it('rejects a mismatched AppID even when the filename is correct', async () => {
    const f = await fixture()
    await writeFile(f.manifest, '"AppState" { "appid" "730" "installdir" "Fixture Game" }')
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => f.processes })).rejects.toMatchObject({ nativeCode: 'NATIVE_DISCOVERY_FAILED' })
  })

  it('rejects unrelated process images, modules outside the game, and ambiguous processes', async () => {
    const f = await fixture()
    const outsider = join(f.root, 'steam_api.dll')
    const outsideExe = join(f.root, 'Unrelated.exe')
    await writeFile(outsider, pe()); await writeFile(outsideExe, pe())
    for (const processes of [
      [{ ...f.processes.processes[0]!, exe: outsideExe }],
      [{ ...f.processes.processes[0]!, modules: [outsider] }],
      [f.processes.processes[0]!, { ...f.processes.processes[0]!, pid: GAME_PID - 1 }]
    ]) {
      await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => ({ ...f.processes, processes }) })).rejects.toBeInstanceOf(NativePresenceError)
    }
  })

  it('validates parent identity and ticks as strings, never rounded JavaScript timestamps', async () => {
    const f = await fixture()
    for (const processes of [{ ...f.processes, parentPid: process.pid + 1 }, { ...f.processes, parentStartTicks: '' }, { ...f.processes, processes: [{ ...f.processes.processes[0]!, startTicks: '' }] }]) {
      await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => processes })).rejects.toMatchObject({ nativeCode: 'NATIVE_DISCOVERY_FAILED' })
    }
  })

  it('rejects non-PE and mismatched PE headers without loading native code', () => {
    expect(nativePresencePeArchitecture(pe('x86'))).toBe('x86')
    expect(nativePresencePeArchitecture(pe('x64'))).toBe('x64')
    const mismatch = pe('x86'); mismatch.writeUInt16LE(0x20b, 152)
    const outside = pe(); outside.writeUInt32LE(0xffffffff, 60)
    for (const value of [Buffer.alloc(2), Buffer.alloc(256), mismatch, outside]) expect(() => nativePresencePeArchitecture(value)).toThrow(NativePresenceError)
  })

  it('merges x86 module results omitted by the x64 Framework host without duplicate candidates', async () => {
    const f = await fixture()
    const empty = { ...f.processes, processes: [] }
    expect(mergeNativePresenceProcessLists([empty, f.processes], process.pid)).toEqual(f.processes)
    expect(mergeNativePresenceProcessLists([f.processes, f.processes], process.pid)).toEqual(f.processes)
    expect(mergeNativePresenceProcessLists([f.processes], process.pid)).toEqual(f.processes)
  })

  it('rejects PID reuse, conflicting parent ticks, and zero successful architecture queries', async () => {
    const f = await fixture()
    expect(() => mergeNativePresenceProcessLists([], process.pid)).toThrow(NativePresenceError)
    expect(() => mergeNativePresenceProcessLists([f.processes, { ...f.processes, parentStartTicks: '638964000000000002' }], process.pid)).toThrow(NativePresenceError)
    expect(() => mergeNativePresenceProcessLists([f.processes, { ...f.processes, processes: [{ ...f.processes.processes[0]!, startTicks: '638965000000000002' }] }], process.pid)).toThrow(NativePresenceError)
  })

  it('merges API and client modules as one game candidate, not two DLL candidates', async () => {
    const f = await fixture()
    const from64 = { ...f.processes, processes: [{ ...f.processes.processes[0]!, modules: [f.binding.clientDllPath] }] }
    const from32 = { ...f.processes, processes: [{ ...f.processes.processes[0]!, modules: [f.binding.dllPath!] }] }
    const merged = mergeNativePresenceProcessLists([from64, from32, from32], process.pid)
    expect(merged.processes[0]!.modules).toHaveLength(2)
    expect(await discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => merged })).toEqual(f.binding)
  })

  it('requires the loaded client DLL and a canonical active Steam executable in a known Steam root', async () => {
    const f = await fixture()
    const outside = join(f.root, 'steamclient.dll'); await writeFile(outside, pe())
    const outsideExe = join(f.root, 'steam.exe'); await writeFile(outsideExe, pe('x64'))
    for (const processList of [
      { ...f.processes, steamProcess: undefined },
      { ...f.processes, steamProcess: { ...f.processes.steamProcess!, exe: outsideExe } },
      { ...f.processes, processes: [{ ...f.processes.processes[0]!, modules: [f.binding.dllPath!] }] },
      { ...f.processes, processes: [{ ...f.processes.processes[0]!, modules: [f.binding.dllPath!, outside] }] }
    ]) await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => processList })).rejects.toBeInstanceOf(NativePresenceError)
  })

  it('rejects a loaded client/API architecture mismatch and Steam PID reuse between architecture queries', async () => {
    const f = await fixture()
    await writeFile(f.binding.clientDllPath, pe('x64'))
    await expect(discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [f.steam], queryProcesses: async () => f.processes })).rejects.toMatchObject({ nativeCode: 'NATIVE_DLL_INVALID' })
    expect(() => mergeNativePresenceProcessLists([f.processes, { ...f.processes, steamProcess: { ...f.processes.steamProcess!, startTicks: '638964000000000002' } }], process.pid)).toThrow(NativePresenceError)
  })
})

describe('owned native worker lifecycle and local acceptance protocol', () => {
  async function setup(workerOptions: { startup?: Record<string, unknown> | null; noise?: string; requestTimeoutMs?: number; stopTimeoutMs?: number; arch?: 'x86' | 'x64'; onContextLost?: () => void; onLifecycle?: (event: NativePresenceLifecycleEvent) => void } = {}) {
    const f = await fixture(workerOptions.arch)
    const children: FakeWorker[] = []
    const spawn = vi.fn((_worker: string, _args: string[]) => { const child = new FakeWorker(workerOptions.startup, workerOptions.noise); children.push(child); return child.child() })
    const discover = vi.fn(async () => f.binding)
    const broker = new NativePresenceBroker({ workerDirectory: f.workerDirectory, discover, spawn, platform: 'win32', requestTimeoutMs: workerOptions.requestTimeoutMs ?? 1000, stopTimeoutMs: workerOptions.stopTimeoutMs ?? 5, onContextLost: workerOptions.onContextLost, onLifecycle: workerOptions.onLifecycle })
    brokers.push(broker)
    return { ...f, children, spawn, discover, broker }
  }

  it('passes only fixed binding arguments and sends one key at a time with display token last', async () => {
    const f = await setup()
    await f.broker.apply(context, { steam_display: '#Status_Game', desc: 'Fixture room', status: null }, () => true)
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(join(f.workerDirectory, 'worker-x86.exe'), [f.binding.dllPath, f.binding.dllSha256, f.binding.clientDllPath, f.binding.clientDllSha256, String(context.appId), context.steamId, String(GAME_PID), START, String(process.pid), PARENT_START, String(f.binding.steamPid), f.binding.steamStartTicks])
    expect(f.children[0]!.requests.map(request => request.changes)).toEqual([{ desc: 'Fixture room' }, { status: '' }, { steam_display: '#Status_Game' }])
    expect(f.children[0]!.requests.every(request => request.v === 1 && typeof request.requestId === 'string')).toBe(true)
  })

  it.each(['e9045710ec7ee47d7b7488d1c5dda2d933dec7e251e965967a5c48f4df68eb4e', '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'])('uses the audited public-client transport %s without pretending to load a game API DLL', async clientDllSha256 => {
    const f = await setup({ arch: 'x64' })
    const { dllPath: _dll, dllSha256: _sha, ...base } = f.binding
    const binding: NativePresenceBinding = { ...base, transport: 'public-client', clientDllSha256 }
    f.discover.mockResolvedValueOnce(binding)
    await f.broker.read(context, () => true)
    expect(f.spawn.mock.calls[0]![1]).toEqual(['--public-client', binding.clientDllPath, binding.clientDllSha256, String(context.appId), context.steamId, String(binding.gamePid), binding.gameStartTicks, binding.gameExe, String(binding.parentPid), binding.parentStartTicks, String(binding.steamPid), binding.steamStartTicks])
    expect(f.spawn.mock.calls[0]![1]).not.toContain(_dll)
  })
  it('does not spawn the public-client worker for an unknown client hash', async () => {
    const f = await setup({ arch: 'x64' })
    const { dllPath: _dll, dllSha256: _sha, ...base } = f.binding
    f.discover.mockResolvedValueOnce({ ...base, transport: 'public-client', clientDllSha256: 'a'.repeat(64) })
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_DISCOVERY_FAILED' })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('reads only a canonical group-size field and permits its dedicated numeric change', async () => {
    const f = await setup()
    await f.broker.read(context, () => true)
    f.children[0]!.readResult = { ...f.children[0]!.readResult, fields: { steam_player_group_size: '4' }, keyCount: 2 }
    expect((await f.broker.read(context, () => true)).fields).toEqual({ steam_player_group_size: '4' })
    await f.broker.apply(context, { steam_player_group_size: '6' }, () => true)
    expect(f.children[0]!.requests.at(-1)!.changes).toEqual({ steam_player_group_size: '6' })
    await f.broker.apply(context, { steam_player_group_size: null }, () => true)
    expect(f.children[0]!.requests.at(-1)!.changes).toEqual({ steam_player_group_size: null })
  })
  it('writes shared-policy safe custom public parameters without expanding native read access', async () => {
    const f = await setup()
    await f.broker.apply(context, { 'game:objective': 'Public objective', custom_state: 'Ready' }, () => true)
    expect(f.children[0]!.requests.map(request => request.changes)).toEqual([{ 'game:objective': 'Public objective' }, { custom_state: 'Ready' }])
    expect(f.children[0]!.requests.every(request => request.op === 'apply')).toBe(true)
    f.children[0]!.readResult = { fields: { 'game:objective': 'Public objective' }, localizedString: null, displayTokenReadable: false, verificationSource: 'local-cache', keyCount: 1 }
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_PROTOCOL_INVALID' })
    expect(richPresenceContract.fieldPolicy.nativeReadableKeys).not.toContain('game:objective')
  })
  it.each(['connect', 'invite', 'lobby', 'ticket', 'steamid', 'userid', 'server', 'url', 'endpoint', 'version', 'steam_player_group', '__proto__', 'constructor', 'desc\n', 'status\r'])('rejects protected native write key %j before discovery', async key => {
    const f = await setup()
    await expect(f.broker.apply(context, { [key]: 'Private' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_ARGUMENTS_INVALID', mayHaveWritten: false })
    expect(f.discover).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '01', '1.5', '2147483648'])('does not spawn or write for invalid group count %s', async value => {
    const f = await setup()
    await expect(f.broker.apply(context, { steam_player_group_size: value }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_ARGUMENTS_INVALID' })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('never allows a raw group identifier as an external write', async () => {
    const f = await setup()
    await expect(f.broker.apply(context, { steam_player_group: 'PRIVATE_IDENTIFIER' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_ARGUMENTS_INVALID' })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('selects the worker matching the DLL architecture and reuses only the same bound context', async () => {
    const f = await setup({ arch: 'x64' })
    await f.broker.apply(context, { desc: 'First' }, () => true)
    await f.broker.apply(context, { desc: 'Second' }, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.spawn.mock.calls[0]![0]).toBe(join(f.workerDirectory, 'worker-x64.exe'))
    await f.broker.apply({ ...context, accountId: 'another-binding' }, { desc: 'Third' }, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.children[0]!.requests.at(-1)!.op).toBe('stop')
  })

  it('reads a public local-cache snapshot without applying or starting a second helper', async () => {
    const f = await setup()
    const result = await f.broker.read(context, () => true)
    expect(result).toEqual({ fields: { desc: 'Fixture native description' }, localizedString: 'Fixture native description', displayTokenReadable: false, verificationSource: 'local-cache', keyCount: 3 })
    await f.broker.apply(context, { desc: 'Edited fixture' }, () => true)
    await f.broker.read(context, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.discover).toHaveBeenCalledTimes(1)
    expect(f.children[0]!.requests.map(value => value.op)).toEqual(['read', 'apply', 'read'])
    expect(f.broker.diagnostics()).toMatchObject({ active: true, completedRequests: 3, rotationDue: false })
    f.broker.stop()
    expect(f.children[0]!.requests.at(-1)!.op).toBe('stop')
    expect(f.children[0]!.stdin.writableEnded).toBe(false)
  })

  it('accepts an actual raw display token only when the worker explicitly distinguishes it', async () => {
    const f = await setup(); await f.broker.read(context, () => true)
    f.children[0]!.readResult = { fields: { steam_display: '#Fixture', desc: 'Fixture' }, localizedString: 'Fixture', displayTokenReadable: true, verificationSource: 'local-cache', keyCount: 3 }
    expect((await f.broker.read(context, () => true)).fields.steam_display).toBe('#Fixture')
  })
  it.each(['#Status.Game:mode-1', '#' + 'x'.repeat(127)])('accepts the shared full display token syntax for read and write: %s', async token => {
    const f = await setup()
    await f.broker.apply(context, { steam_display: token }, () => true)
    expect(f.children[0]!.requests.at(-1)!.changes).toEqual({ steam_display: token })
    f.children[0]!.readResult = { fields: { steam_display: token }, localizedString: null, displayTokenReadable: true, verificationSource: 'local-cache', keyCount: 1 }
    expect((await f.broker.read(context, () => true)).fields.steam_display).toBe(token)
  })
  it.each(['#Ready\n', '#Ready\r', '#Ready\r\n', '#' + 'x'.repeat(128), 'Not a token'])('rejects a malformed display token before write and on read: %j', async token => {
    const f = await setup()
    await expect(f.broker.apply(context, { steam_display: token }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_ARGUMENTS_INVALID', mayHaveWritten: false })
    expect(f.spawn).not.toHaveBeenCalled()
    await f.broker.read(context, () => true)
    f.children[0]!.readResult = { fields: { steam_display: token }, localizedString: null, displayTokenReadable: true, verificationSource: 'local-cache', keyCount: 1 }
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_PROTOCOL_INVALID' })
  })

  it.each([
    { fields: { connect: 'FAKE_PRIVATE_NEVER_SURFACE' } },
    { fields: { 'game:secret': 'FAKE_PRIVATE_NEVER_SURFACE' } },
    { fields: { unknown: 'FAKE_PRIVATE_NEVER_SURFACE' } },
    { fields: { version: 'Not editable metadata' } },
    { fields: { steam_display: 'Localized text is not a token' }, displayTokenReadable: false },
    { fields: { steam_display: 'Not_a_token' }, displayTokenReadable: true },
    { fields: { desc: 'bad\u0085value' } },
    { fields: { desc: '\ud800' } },
    { fields: { desc: 'x'.repeat(256) } },
    { fields: { desc: 12 } },
    { fields: [] },
    { keyCount: 21 },
    { keyCount: -1 },
    { keyCount: 0 },
    { localizedString: 'bad\nvalue' },
    { verificationSource: 'server' },
    { identityMatch: false },
    { gameStillSame: false },
    { mayHaveWritten: true }
  ])('fails closed on malformed or private native read fields %#', async invalid => {
    const f = await setup(); await f.broker.read(context, () => true)
    f.children[0]!.readResult = { ...f.children[0]!.readResult, ...invalid }
    const error = await f.broker.read(context, () => true).catch(value => value as NativePresenceError)
    expect(error).toMatchObject({ nativeCode: 'NATIVE_PROTOCOL_INVALID', mayHaveWritten: false })
    expect(String(error)).not.toContain('FAKE_PRIVATE')
    expect(f.children[0]!.requests.at(-1)!.op).toBe('stop')
  })

  it('permits an empty public cache without inventing fields or a server confirmation', async () => {
    const f = await setup(); await f.broker.read(context, () => true)
    f.children[0]!.readResult = { fields: {}, localizedString: null, displayTokenReadable: false, verificationSource: 'local-cache', keyCount: 0 }
    expect(await f.broker.read(context, () => true)).toEqual(f.children[0]!.readResult)
  })

  it('serializes reads against writes and cancels late read responses without claiming a submission', async () => {
    const f = await setup(); await f.broker.read(context, () => true)
    let request: Record<string, unknown> | null = null
    f.children[0]!.handler = value => { request = value }
    const pending = f.broker.read(context, () => true)
    const rejected = expect(pending).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED', mayHaveWritten: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(f.broker.apply(context, { desc: 'Never concurrent' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_BUSY' })
    f.broker.stop(); await rejected
    if (request) f.children[0]!.reply(request)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.broker.diagnostics().active).toBe(false)
  })

  it('keeps the first game instance anchored across helper stops until an explicit new attachment', async () => {
    const f = await setup(); const lost = vi.fn(); f.broker.onContextLost(lost)
    await f.broker.read(context, () => true); f.broker.stop()
    f.discover.mockResolvedValue({ ...f.binding, gameStartTicks: '638965000000000002' })
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_CONTEXT_CHANGED' })
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(lost).toHaveBeenCalledTimes(1)
    f.broker.beginContext()
    await f.broker.read(context, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it.each([{ steamPid: GAME_PID - 3 }, { steamStartTicks: '638964000000000002' }])('keeps the original Steam instance anchored after a helper stop %#', async changed => {
    const f = await setup(); const lost = vi.fn(); f.broker.onContextLost(lost)
    await f.broker.read(context, () => true); f.broker.stop()
    f.discover.mockResolvedValue({ ...f.binding, ...changed })
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_CONTEXT_CHANGED' })
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(lost).toHaveBeenCalledTimes(1)
    f.broker.beginContext()
    await f.broker.read(context, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it.each([{ steamPid: GAME_PID - 3 }, { steamStartTicks: '638964000000000002' }])('refuses a discovery that raced past the caller Steam instance %#', async changed => {
    const f = await setup()
    const expected = { ...context, steamPid: f.binding.steamPid, steamStartTicks: f.binding.steamStartTicks, ...changed }
    await expect(f.broker.read(expected, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_CONTEXT_CHANGED', mayHaveWritten: false })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('refuses reusing a helper for a different expected Steam instance', async () => {
    const f = await setup(); const lost = vi.fn(); f.broker.onContextLost(lost)
    const expected = { ...context, steamPid: f.binding.steamPid, steamStartTicks: f.binding.steamStartTicks }
    await f.broker.read(expected, () => true)
    await expect(f.broker.apply({ ...expected, steamStartTicks: '638964000000000002' }, { desc: 'Never submitted' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_CONTEXT_CHANGED', mayHaveWritten: false })
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(lost).toHaveBeenCalledTimes(1)
    expect(f.children[0]!.requests.map(value => value.op)).toEqual(['read', 'stop'])
  })

  it.each([{ steamPid: 1 }, { steamStartTicks: PARENT_START }, { steamPid: 0, steamStartTicks: PARENT_START }])('requires a complete valid expected Steam instance %#', async invalid => {
    const f = await setup()
    await expect(f.broker.read({ ...context, ...invalid }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_ARGUMENTS_INVALID' })
    expect(f.discover).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled()
  })

  it('allows an explicit read to rebuild the same game after a non-identity helper failure', async () => {
    const f = await setup(); const lost = vi.fn(); f.broker.onContextLost(lost)
    await f.broker.read(context, () => true)
    f.children[0]!.finish(1)
    expect(lost.mock.calls[0]![0]).toMatchObject({ nativeCode: 'NATIVE_EXITED' })
    await f.broker.read(context, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.children[1]!.requests.map(value => value.op)).toEqual(['read'])
  })
  it.each([[70, 'NATIVE_CONTEXT_CHANGED'], [71, 'NATIVE_EXITED'], [72, 'NATIVE_PROTOCOL_INVALID'], [73, 'NATIVE_CONTEXT_UNAVAILABLE']] as const)('classifies worker exit %i as %s without inventing game identity evidence', async (exit, code) => {
    const f = await setup(); const lost = vi.fn(); f.broker.onContextLost(lost)
    await f.broker.read(context, () => true); f.children[0]!.finish(exit)
    expect(lost).toHaveBeenCalledTimes(1); expect(lost.mock.calls[0]![0]).toMatchObject({ nativeCode: code })
    expect(f.broker.diagnostics().active).toBe(false)
  })

  it('discards native DLL console diagnostics without exposing them or confusing readiness', async () => {
    const secret = 'FIXTURE-NATIVE-DIAGNOSTIC-76561198000000001'
    const f = await setup({ noise: '[S_API] ' + secret + '\n' })
    await f.broker.apply(context, { desc: 'Fixture' }, () => true)
    expect(f.children[0]!.requests).toHaveLength(1)
    expect(JSON.stringify(f.children[0]!.requests)).not.toContain(secret)
  })

  it('bounds native noise and protocol line length without echoing raw contents', async () => {
    for (const noise of ['x'.repeat(32769) + '\n', Array.from({ length: 40 }, () => 'FIXTURE-NOISE'.repeat(300) + '\n').join('')]) {
      const f = await setup({ noise })
      await expect(f.broker.apply(context, { desc: 'Fixture' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_PROTOCOL', mayHaveWritten: false })
    }
  })

  it.each([
    { v: 2, requestId: 'startup', op: 'ready', ok: true, mayHaveWritten: false },
    { v: 1, requestId: 'different', op: 'ready', ok: true, mayHaveWritten: false },
    { v: 1, requestId: 'startup', op: 'ready', ok: false, mayHaveWritten: false }
  ])('fails closed on invalid startup protocol: %j', async startup => {
    const f = await setup({ startup })
    await expect(f.broker.apply(context, { desc: 'Fixture' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_PROTOCOL', mayHaveWritten: false })
    expect(f.children[0]!.requests.filter(value => value.op === 'apply')).toHaveLength(0)
  })

  it('does not spawn after a late discovery result from a stopped generation', async () => {
    const f = await setup()
    const pending = deferred<NativePresenceBinding>()
    const spawn = vi.fn(() => new FakeWorker().child())
    const broker = new NativePresenceBroker({ workerDirectory: f.workerDirectory, discover: () => pending.promise, spawn, platform: 'win32' })
    brokers.push(broker)
    const action = broker.apply(context, { desc: 'Never submitted' }, () => true)
    const rejected = expect(action).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED', mayHaveWritten: false })
    broker.stop(); pending.resolve(f.binding); await rejected
    expect(spawn).not.toHaveBeenCalled()
  })

  it('checks caller permission after readiness and after every locally accepted field', async () => {
    const f = await setup()
    let allowed = true
    const originalSpawn = f.spawn
    originalSpawn.mockImplementation(() => {
      const child = new FakeWorker(); f.children.push(child)
      child.handler = request => { child.reply(request); allowed = false }
      return child.child()
    })
    await expect(f.broker.apply(context, { desc: 'First', status: 'Must not submit', steam_display: '#Token' }, () => allowed)).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED', mayHaveWritten: true, acceptedKeys: ['desc'] })
    expect(f.children[0]!.requests.filter(value => value.op === 'apply').map(value => value.changes)).toEqual([{ desc: 'First' }])
  })

  it('tracks partial acceptance and does not continue after a worker rejection', async () => {
    const f = await setup()
    f.spawn.mockImplementation(() => {
      const child = new FakeWorker(); f.children.push(child)
      child.handler = request => {
        if (Object.hasOwn(request.changes as object, 'status')) child.send({ v: 1, requestId: request.requestId, op: 'error', code: 'NATIVE_SET_REJECTED', mayHaveWritten: true, acceptedKeys: [] })
        else child.reply(request)
      }
      return child.child()
    })
    await expect(f.broker.apply(context, { desc: 'First', status: 'Rejected', steam_display: '#Token' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_WRITE_FAILED', nativeCode: 'NATIVE_SET_REJECTED', mayHaveWritten: true, acceptedKeys: ['desc'] })
    expect(f.children[0]!.requests.filter(value => value.op === 'apply')).toHaveLength(2)
  })

  it('treats lost/invalid apply replies as possibly written, never as a clean no-op', async () => {
    const f = await setup()
    f.spawn.mockImplementation(() => {
      const child = new FakeWorker(); f.children.push(child)
      child.handler = request => child.send({ v: 1, requestId: request.requestId, op: 'applied', ok: true, mayHaveWritten: true, acceptedKeys: ['wrong-field'] })
      return child.child()
    })
    await expect(f.broker.apply(context, { desc: 'Fixture' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_PROTOCOL', mayHaveWritten: true, acceptedKeys: [] })
  })

  it('stop immediately cancels an in-flight apply and closes only the owned worker', async () => {
    const f = await setup()
    f.spawn.mockImplementation(() => { const child = new FakeWorker(); f.children.push(child); child.handler = () => {}; return child.child() })
    const action = f.broker.apply(context, { desc: 'Possibly submitted' }, () => true)
    const rejected = expect(action).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED', mayHaveWritten: true })
    await vi.waitFor(() => expect(f.children[0]?.requests.some(value => value.op === 'apply')).toBe(true))
    f.broker.stop(); await rejected
    expect(f.children[0]!.requests.at(-1)!.op).toBe('stop')
    expect(f.children[0]!.kill).not.toHaveBeenCalled()
  })

  it('bounds startup and apply waits and kills only an unresponsive owned child after graceful stop', async () => {
    const f = await setup({ startup: null, requestTimeoutMs: 10 })
    f.spawn.mockImplementation(() => { const child = new FakeWorker(null); child.stopCloses = false; f.children.push(child); return child.child() })
    await expect(f.broker.apply(context, { desc: 'Not submitted' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_TIMEOUT', mayHaveWritten: false })
    await vi.waitFor(() => expect(f.children[0]!.kill).toHaveBeenCalledTimes(1))
  })

  it('fails closed when worker resources are missing or do not match the discovered DLL architecture', async () => {
    const f = await setup()
    await writeFile(join(f.workerDirectory, 'worker-x86.exe'), pe('x64'))
    await expect(f.broker.apply(context, { desc: 'Fixture' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_WORKER_MISSING', mayHaveWritten: false })
    expect(f.spawn).not.toHaveBeenCalled()
    await rm(f.workerDirectory, { recursive: true })
    await expect(f.broker.apply(context, { desc: 'Fixture' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_WORKER_MISSING' })
  })

  it.each([{}, { desc: 'x'.repeat(256) }, { ['k'.repeat(64)]: 'Value' }, { desc: 'Value\n' }, { desc: '\ud800' }, { desc: 'One', DESC: 'Two' }] as Array<Record<string, string | null>>)('rejects invalid changes before discovery: %j', async changes => {
    const f = await setup()
    await expect(f.broker.apply(context, changes, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_PROTOCOL', mayHaveWritten: false })
    expect(f.discover).not.toHaveBeenCalled()
  })

  it('returns only fixed errors and never native raw messages or paths', async () => {
    const f = await setup({ startup: { v: 1, requestId: 'startup', op: 'error', code: 'arbitrary-native-text', message: 'FIXTURE-PRIVATE-DIAGNOSTIC', mayHaveWritten: false, acceptedKeys: [] } })
    const error = await f.broker.apply(context, { desc: 'Fixture' }, () => true).catch(value => value as NativePresenceError)
    expect(error).toMatchObject({ code: 'GAME_STATUS_NATIVE_PROTOCOL', nativeCode: 'NATIVE_PROTOCOL_INVALID' })
    expect(JSON.stringify(error)).not.toContain('FIXTURE-PRIVATE-DIAGNOSTIC')
    expect(String(error)).not.toContain(f.root)
  })

  it('does not spawn a replacement writer before the old owned child actually closes', async () => {
    const f = await setup({ stopTimeoutMs: 100 })
    await f.broker.apply(context, { desc: 'First' }, () => true)
    f.children[0]!.stopCloses = false
    f.broker.stop()
    const next = f.broker.apply(context, { desc: 'Second' }, () => true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.spawn).toHaveBeenCalledTimes(1)
    f.children[0]!.finish()
    await next
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('does not permit a new writer after kill fails to produce a close event', async () => {
    const f = await setup({ stopTimeoutMs: 5 })
    await f.broker.apply(context, { desc: 'First' }, () => true)
    const old = f.children[0]!
    old.stopCloses = false; old.kill.mockImplementation(() => true)
    f.broker.stop()
    await expect(f.broker.apply(context, { desc: 'Must not start' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_TIMEOUT', mayHaveWritten: false })
    expect(old.kill).toHaveBeenCalledTimes(1)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    await expect(f.broker.apply(context, { desc: 'Still blocked' }, () => true)).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_TIMEOUT' })
    expect(f.spawn).toHaveBeenCalledTimes(1)
    old.finish()
    await f.broker.apply(context, { desc: 'Safe after actual close' }, () => true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('notifies once when a ready worker loses its game context, with no automatic respawn', async () => {
    const onContextLost = vi.fn()
    const f = await setup({ onContextLost })
    await f.broker.apply(context, { desc: 'First' }, () => true)
    f.children[0]!.finish(70)
    expect(onContextLost).toHaveBeenCalledTimes(1)
    f.children[0]!.emit('error', new Error('Fixture late callback'))
    expect(onContextLost).toHaveBeenCalledTimes(1)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not notify context loss for manual stop, rejected startup, or caller cancellation', async () => {
    const onContextLost = vi.fn()
    const f = await setup({ onContextLost })
    await f.broker.apply(context, { desc: 'First' }, () => true)
    f.broker.stop()
    expect(onContextLost).not.toHaveBeenCalled()
    const failed = await setup({ onContextLost, startup: { v: 1, requestId: 'startup', op: 'error', code: 'NATIVE_INIT_FAILED', acceptedKeys: [], mayHaveWritten: false } })
    await expect(failed.broker.apply(context, { desc: 'Not sent' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_INIT_FAILED' })
    expect(onContextLost).not.toHaveBeenCalled()
    let allowed = true
    f.spawn.mockImplementation(() => { const child = new FakeWorker(); f.children.push(child); child.handler = request => { child.reply(request); allowed = false }; return child.child() })
    await expect(f.broker.apply(context, { desc: 'First', status: 'Never next' }, () => allowed)).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED' })
    expect(onContextLost).not.toHaveBeenCalled()
  })

  it('preserves uncertainty and notifies when a game watchdog exit interrupts an apply', async () => {
    const onContextLost = vi.fn()
    const f = await setup({ onContextLost })
    f.spawn.mockImplementation(() => { const child = new FakeWorker(); f.children.push(child); child.handler = () => child.finish(70); return child.child() })
    await expect(f.broker.apply(context, { desc: 'Possibly submitted' }, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_CONTEXT_CHANGED', mayHaveWritten: true })
    expect(onContextLost).toHaveBeenCalledTimes(1)
  })

  it('observes cleanup after stop without equating inactive, API cleanup and confirmed process exit', async () => {
    const onLifecycle = vi.fn()
    const f = await setup({ onLifecycle, stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false
    f.broker.stop()
    expect(f.broker.diagnostics()).toMatchObject({ active: false, retiringCount: 1, lastCleanup: { helperPid: child.pid, pipeReleased: null, complete: false, exitConfirmed: false, exitCode: null } })
    for (const [index, [stage, ok]] of ([['release-user-start', null], ['release-user-returned', true], ['release-pipe-start', null], ['release-pipe-returned', true], ['free-api-library', true], ['free-client-library', true], ['cleanup-complete', true]] as const).entries()) child.send(lifecycle(stage, ok, index))
    expect(f.broker.diagnostics()).toMatchObject({ active: false, retiringCount: 1, lastCleanup: { userReleased: true, pipeReleased: true, cleanupReported: true, complete: true, forced: false, exitConfirmed: false } })
    child.finish(0)
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 0, lastCleanup: { pipeReleased: true, complete: true, exitConfirmed: true, exitCode: 0 } })
    expect(onLifecycle.mock.calls.map(([event]) => event.stage)).toEqual(['worker-started', 'stop-requested', 'release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned', 'free-api-library', 'free-client-library', 'cleanup-complete', 'worker-closed'])
    expect(onLifecycle.mock.calls.every(([event]) => event.helperPid === child.pid)).toBe(true)
    const snapshot = f.broker.diagnostics()
    snapshot.lastCleanup!.pipeReleased = false; snapshot.history[0]!.stage = 'forced-kill'
    expect(f.broker.diagnostics().lastCleanup?.pipeReleased).toBe(true)
    expect(f.broker.diagnostics().history[0]?.stage).toBe('worker-started')
  })

  it('keeps an ordinary successful exit unknown when the helper did not report cleanup APIs', async () => {
    const f = await setup()
    await f.broker.read(context, () => true); f.children[0]!.finish(0)
    expect(f.broker.diagnostics()).toMatchObject({ active: false, retiringCount: 0, lastCleanup: { pipeReleased: null, userReleased: null, complete: false, cleanupReported: false, forced: false, exitConfirmed: true, exitCode: 0 } })
  })

  it('preserves a false release result even if a later complete message incorrectly claims success', async () => {
    const f = await setup({ stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; f.broker.stop()
    child.send(lifecycle('release-user-returned', true, 1)); child.send(lifecycle('release-pipe-returned', false, 2)); child.send(lifecycle('cleanup-complete', true, 3)); child.finish()
    expect(f.broker.diagnostics().lastCleanup).toMatchObject({ userReleased: true, pipeReleased: false, cleanupReported: true, complete: false, exitConfirmed: true })
  })

  it('ignores late operation replies in the same closing chunk while still accepting cleanup evidence', async () => {
    const onLifecycle = vi.fn(); const onContextLost = vi.fn()
    const f = await setup({ onLifecycle, onContextLost, stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; child.handler = () => {}
    const pending = f.broker.apply(context, { desc: 'PRIVATE_LATE_FIELD_TEXT' }, () => true)
    const rejected = expect(pending).rejects.toMatchObject({ nativeCode: 'NATIVE_CANCELLED', mayHaveWritten: true, acceptedKeys: [] })
    await vi.waitFor(() => expect(child.requests.at(-1)?.op).toBe('apply'))
    const requestId = child.requests.at(-1)!.requestId
    f.broker.stop()
    child.stdout.write(Buffer.from([
      { v: 1, requestId, op: 'applied', ok: true, acceptedKeys: ['desc'], mayHaveWritten: true },
      { v: 1, requestId: 'late-read', op: 'read', ok: true, fields: { desc: 'PRIVATE_LATE_FIELD_TEXT' } },
      { v: 1, requestId: 'stop', op: 'stopped', ok: true },
      lifecycle('release-pipe-returned', false, 4), lifecycle('cleanup-complete', false, 5)
    ].map(value => JSON.stringify(value)).join('\n') + '\n'))
    await rejected
    expect(f.broker.diagnostics().lastCleanup).toMatchObject({ pipeReleased: false, cleanupReported: true, complete: false, forced: false })
    expect(child.requests.filter(value => value.op === 'stop')).toHaveLength(1)
    expect(child.kill).not.toHaveBeenCalled(); expect(onContextLost).not.toHaveBeenCalled()
    expect(JSON.stringify([f.broker.diagnostics(), onLifecycle.mock.calls])).not.toContain('PRIVATE_LATE_FIELD_TEXT')
    child.finish()
  })

  it('retains a bounded partial lifecycle frame across a manual stop', async () => {
    const f = await setup({ stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false
    const frame = JSON.stringify(lifecycle('release-pipe-returned', true, 3)) + '\n'
    child.stdout.write(Buffer.from(frame.slice(0, 30))); f.broker.stop(); child.stdout.write(Buffer.from(frame.slice(30)))
    expect(f.broker.diagnostics().lastCleanup?.pipeReleased).toBe(true)
    child.finish()
  })

  it('accepts cleanup from failed construction before any ready acknowledgement', async () => {
    const onLifecycle = vi.fn(); const onContextLost = vi.fn()
    const f = await setup({ startup: null, onLifecycle, onContextLost, stopTimeoutMs: 1000 })
    f.spawn.mockImplementation(() => { const child = new FakeWorker(null); child.stopCloses = false; f.children.push(child); return child.child() })
    const pending = f.broker.read(context, () => true)
    const rejected = expect(pending).rejects.toMatchObject({ nativeCode: 'NATIVE_INIT_FAILED' })
    await vi.waitFor(() => expect(f.children).toHaveLength(1))
    const child = f.children[0]!
    child.stdout.write(Buffer.from([
      { v: 1, requestId: 'startup', op: 'error', code: 'NATIVE_INIT_FAILED', acceptedKeys: [], mayHaveWritten: false },
      lifecycle('free-client-library', true, 1), lifecycle('cleanup-complete', true, 2)
    ].map(value => JSON.stringify(value)).join('\n') + '\n'))
    await rejected
    expect(f.broker.diagnostics().lastCleanup).toMatchObject({ pipeReleased: null, complete: true, cleanupReported: true, exitConfirmed: false })
    expect(onLifecycle.mock.calls.map(([event]) => event.stage)).toContain('cleanup-complete')
    expect(onContextLost).not.toHaveBeenCalled(); expect(child.requests.every(value => value.op === 'stop')).toBe(true)
    child.finish(73)
  })

  it('does not turn a forced owned-worker exit into a successful pipe release', async () => {
    const f = await setup({ stopTimeoutMs: 5 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; f.broker.stop()
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1))
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 0, lastCleanup: { forced: true, exitConfirmed: true, exitCode: 0, pipeReleased: null, complete: false, cleanupReported: false } })
  })

  it('reports a stuck retirement once without changing the existing no-replacement waiting policy', async () => {
    const onLifecycle = vi.fn()
    const f = await setup({ stopTimeoutMs: 5, onLifecycle })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; child.kill.mockImplementation(() => true)
    f.broker.stop(); f.broker.stop(); f.broker.stop()
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_TIMEOUT' })
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 1, lastCleanup: { forced: true, retireTimedOut: true, exitConfirmed: false, exitCode: null, pipeReleased: null, complete: false } })
    for (const stage of ['stop-requested', 'forced-kill', 'retire-timeout']) expect(onLifecycle.mock.calls.filter(([event]) => event.stage === stage)).toHaveLength(1)
    expect(child.requests.filter(value => value.op === 'stop')).toHaveLength(1); expect(f.spawn).toHaveBeenCalledTimes(1)
    child.finish(71)
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 0, lastCleanup: { exitConfirmed: true, exitCode: 71, pipeReleased: null } })
  })

  it('bounds history across retired sessions and isolates observer failures and mutations', async () => {
    const onLifecycle = vi.fn((event: NativePresenceLifecycleEvent) => { event.stage = 'forced-kill'; throw new Error('PRIVATE_OBSERVER_FAILURE') })
    const f = await setup({ onLifecycle })
    for (let i = 0; i < 12; i++) { await f.broker.read(context, () => true); f.broker.stop() }
    const diagnostics = f.broker.diagnostics()
    expect(diagnostics.history).toHaveLength(32)
    expect(diagnostics.history.some(event => event.stage === 'forced-kill')).toBe(false)
    expect(diagnostics.lastCleanup).toMatchObject({ forced: false, pipeReleased: null, exitConfirmed: true })
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_OBSERVER_FAILURE')
    expect(f.spawn).toHaveBeenCalledTimes(12)
  })

  it('never records malformed, duplicate, oversized or private telemetry, and drains closing noise safely', async () => {
    const onLifecycle = vi.fn()
    const f = await setup({ onLifecycle, stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; f.broker.stop()
    const before = onLifecycle.mock.calls.length
    for (const message of [
      lifecycle('PRIVATE_PATH_OR_STAGE'), { ...lifecycle('release-pipe-returned'), ok: 'true' },
      lifecycle('release-user-start', true), lifecycle('release-pipe-start', false), lifecycle('release-pipe-returned', null),
      lifecycle('free-client-library', null), lifecycle('cleanup-complete', null),
      lifecycle('release-pipe-returned', true, -1), lifecycle('release-pipe-returned', true, 1.5),
      { ...lifecycle('release-pipe-returned'), elapsedMs: '2' }, { ...lifecycle('release-pipe-returned'), private: 'PRIVATE_ACCOUNT_DATA' },
      { ...lifecycle('release-pipe-returned'), v: 2 }, { ...lifecycle('release-pipe-returned'), requestId: 'other' }
    ]) child.send(message)
    child.stdout.write(Buffer.from('PRIVATE_NATIVE_NOISE\n{bad-json}\n'))
    child.stdout.write(Buffer.concat([Buffer.from('{"v":1,"requestId":"lifecycle","op":"lifecycle","stage":"'), Buffer.from([0xff]), Buffer.from('","ok":true,"elapsedMs":1}\n')]))
    expect(onLifecycle).toHaveBeenCalledTimes(before)
    expect(f.broker.diagnostics().lastCleanup).toMatchObject({ cleanupReported: false, pipeReleased: null })
    child.send(lifecycle('release-user-start', null, 1))
    child.stdout.write(Buffer.from('x'.repeat(32769) + '\n' + JSON.stringify(lifecycle('release-pipe-returned', false, 2)) + '\n'))
    child.send(lifecycle('release-pipe-returned', true, 3))
    child.stdout.write(Buffer.from('x'.repeat(32769)))
    child.stdout.write(Buffer.from('trailing-noise\n' + JSON.stringify(lifecycle('free-client-library', true, 4)) + '\n'))
    child.stdout.write(Buffer.from('x'.repeat(65536) + '\n'))
    child.send(lifecycle('cleanup-complete', false, 5))
    expect(f.broker.diagnostics().lastCleanup).toMatchObject({ pipeReleased: false, cleanupReported: true, complete: false, forced: false })
    expect(onLifecycle.mock.calls.filter(([event]) => event.stage === 'release-pipe-returned')).toHaveLength(1)
    expect(onLifecycle.mock.calls.filter(([event]) => event.stage === 'release-user-start')).toHaveLength(1)
    expect(onLifecycle.mock.calls.every(([event]) => Object.keys(event).every(key => ['stage', 'ok', 'elapsedMs', 'helperPid'].includes(key)))).toBe(true)
    expect(JSON.stringify([f.broker.diagnostics(), onLifecycle.mock.calls])).not.toMatch(/PRIVATE_|trailing-noise/)
    child.finish()
    const closedCount = onLifecycle.mock.calls.length
    child.send(lifecycle('release-user-returned', true, 6))
    expect(onLifecycle).toHaveBeenCalledTimes(closedCount)
  })

  it('shares an empty shutdown without spawning a helper or changing the synchronous stop API', async () => {
    const f = await setup()
    const first = f.broker.shutdown(); const second = f.broker.shutdown()
    expect(second).toBe(first)
    await first
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.broker.stop()).toBeUndefined()
    await f.broker.shutdown()
    expect(f.broker.diagnostics()).toMatchObject({ active: false, retiringCount: 0, lastCleanup: null, history: [] })
  })

  it('keeps shutdown pending after successful cleanup telemetry until the owned child actually closes', async () => {
    const f = await setup({ stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false
    let resolved = false
    const first = f.broker.shutdown(); const second = f.broker.shutdown()
    void first.then(() => { resolved = true })
    expect(second).toBe(first)
    child.send(lifecycle('release-pipe-returned', true, 1)); child.send(lifecycle('cleanup-complete', true, 2))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(resolved).toBe(false)
    expect(f.broker.diagnostics()).toMatchObject({ active: false, retiringCount: 1, lastCleanup: { pipeReleased: true, complete: true, exitConfirmed: false } })
    expect(child.requests.filter(value => value.op === 'stop')).toHaveLength(1); expect(child.kill).not.toHaveBeenCalled()
    child.finish()
    await Promise.all([first, second])
    expect(resolved).toBe(true)
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 0, lastCleanup: { exitConfirmed: true, exitCode: 0 } })
  })

  it('drains an already stopped helper without a duplicate stop request or forced kill', async () => {
    const f = await setup({ stopTimeoutMs: 1000 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; f.broker.stop()
    const pending = f.broker.shutdown()
    expect(f.broker.shutdown()).toBe(pending)
    expect(child.requests.filter(value => value.op === 'stop')).toHaveLength(1)
    child.finish()
    await pending
    expect(child.kill).not.toHaveBeenCalled()
    expect(f.broker.diagnostics().retiringCount).toBe(0)
  })

  it('rejects shutdown on the existing retirement timeout without erasing unknown cleanup or bypassing its barrier', async () => {
    const f = await setup({ stopTimeoutMs: 5 })
    await f.broker.read(context, () => true)
    const child = f.children[0]!; child.stopCloses = false; child.kill.mockImplementation(() => true)
    const first = f.broker.shutdown(); const second = f.broker.shutdown()
    expect(second).toBe(first)
    await expect(first).rejects.toMatchObject({ nativeCode: 'NATIVE_TIMEOUT' })
    await expect(f.broker.read(context, () => true)).rejects.toMatchObject({ nativeCode: 'NATIVE_TIMEOUT' })
    await expect(f.broker.shutdown()).rejects.toMatchObject({ nativeCode: 'NATIVE_TIMEOUT' })
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 1, lastCleanup: { pipeReleased: null, userReleased: null, complete: false, forced: true, exitConfirmed: false, exitCode: null, retireTimedOut: true } })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.requests.filter(value => value.op === 'stop')).toHaveLength(1)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    child.finish(71)
    await f.broker.shutdown()
    expect(f.broker.diagnostics()).toMatchObject({ retiringCount: 0, lastCleanup: { pipeReleased: null, complete: false, exitConfirmed: true, exitCode: 71 } })
  })
})
