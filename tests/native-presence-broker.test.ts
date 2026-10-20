import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverNativePresenceBinding, mergeNativePresenceProcessLists, nativePresencePeArchitecture, NativePresenceBroker, NativePresenceError, type NativePresenceBinding, type NativePresenceContext, type NativePresenceProcessList } from '../src/main/native-presence-broker'

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
  const root = await mkdtemp(join(tmpdir(), 'native-presence-'))
  folders.push(root)
  const steam = join(root, 'Steam')
  const installed = join(steam, 'steamapps', 'common', 'Fixture Game')
  const workerDirectory = join(root, 'resources', 'native-presence')
  await mkdir(installed, { recursive: true }); await mkdir(workerDirectory, { recursive: true })
  const gameExe = join(installed, 'FixtureGame.exe')
  const dllPath = join(installed, arch === 'x86' ? 'steam_api.dll' : 'steam_api64.dll')
  await writeFile(gameExe, pe(arch)); await writeFile(dllPath, pe(arch))
  for (const value of ['x86', 'x64'] as const) await writeFile(join(workerDirectory, `worker-${value}.exe`), pe(value))
  const manifest = join(steam, 'steamapps', `appmanifest_${context.appId}.acf`)
  await writeFile(manifest, `"AppState" { "appid" "${context.appId}" "installdir" "Fixture Game" }`)
  const binding: NativePresenceBinding = { gamePid: GAME_PID, gameStartTicks: START, gameExe, dllPath, dllSha256: createHash('sha256').update(pe(arch)).digest('hex'), arch, parentPid: process.pid, parentStartTicks: PARENT_START }
  const processes: NativePresenceProcessList = { parentPid: process.pid, parentStartTicks: PARENT_START, processes: [{ pid: GAME_PID, startTicks: START, exe: gameExe, modules: [dllPath] }] }
  return { root, steam, installed, workerDirectory, manifest, binding, processes }
}

class FakeWorker extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  requests: Array<Record<string, unknown>> = []
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
  reply(request: Record<string, unknown>) { this.send({ v: 1, requestId: request.requestId, op: 'applied', ok: true, acceptedKeys: Object.keys(request.changes as object), mayHaveWritten: true }) }
  finish(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('close', code) }
  child() { return this as unknown as ChildProcessWithoutNullStreams }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

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

  it('reads only the selected AppID manifest, including an explicitly configured library', async () => {
    const f = await fixture()
    const launcher = join(f.root, 'Launcher')
    await mkdir(join(launcher, 'steamapps'), { recursive: true })
    await writeFile(join(launcher, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${f.steam.replaceAll('\\', '\\\\')}" } }`)
    await writeFile(join(f.steam, 'steamapps', 'appmanifest_999999.acf'), 'not valid VDF and must never be read')
    expect(await discoverNativePresenceBinding(context, { platform: 'win32', steamRoots: async () => [launcher], queryProcesses: async () => f.processes })).toEqual(f.binding)
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
})

describe('owned native worker lifecycle and local acceptance protocol', () => {
  async function setup(workerOptions: { startup?: Record<string, unknown> | null; noise?: string; requestTimeoutMs?: number; stopTimeoutMs?: number; arch?: 'x86' | 'x64'; onContextLost?: () => void } = {}) {
    const f = await fixture(workerOptions.arch)
    const children: FakeWorker[] = []
    const spawn = vi.fn((_worker: string, _args: string[]) => { const child = new FakeWorker(workerOptions.startup, workerOptions.noise); children.push(child); return child.child() })
    const discover = vi.fn(async () => f.binding)
    const broker = new NativePresenceBroker({ workerDirectory: f.workerDirectory, discover, spawn, platform: 'win32', requestTimeoutMs: workerOptions.requestTimeoutMs ?? 1000, stopTimeoutMs: workerOptions.stopTimeoutMs ?? 5, onContextLost: workerOptions.onContextLost })
    brokers.push(broker)
    return { ...f, children, spawn, discover, broker }
  }

  it('passes only fixed binding arguments and sends one key at a time with display token last', async () => {
    const f = await setup()
    await f.broker.apply(context, { steam_display: '#Status_Game', desc: 'Fixture room', status: null }, () => true)
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(join(f.workerDirectory, 'worker-x86.exe'), [f.binding.dllPath, f.binding.dllSha256, String(context.appId), context.steamId, String(GAME_PID), START, String(process.pid), PARENT_START])
    expect(f.children[0]!.requests.map(request => request.changes)).toEqual([{ desc: 'Fixture room' }, { status: '' }, { steam_display: '#Status_Game' }])
    expect(f.children[0]!.requests.every(request => request.v === 1 && typeof request.requestId === 'string')).toBe(true)
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

  it.each([{}, { desc: 'x'.repeat(256) }, { ['k'.repeat(64)]: 'Value' }, { desc: 'Value\n' }])('rejects invalid changes before discovery: %j', async changes => {
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
})
