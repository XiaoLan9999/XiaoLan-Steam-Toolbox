import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasScreenshotIdentityWork, readScreenshotActiveUser, type ScreenshotActiveUserDependencies } from '../src/main/screenshot-active-user'
import { createVerifiedNativeContextDetector } from '../src/main/native-context-resolver'

const ROOT = 'D:\\Steam'
const WORKER = resolve('fixture-screenshot-cancel.exe')
const HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const SELF = '76561198000000001'
const state = () => ({ steamExe: `${ROOT}\\steam.exe`, registryExe: `${ROOT}\\steam.exe`, steamPid: 1234,
  steamStartTicks: '638965000000000001', ownerPid: 9876, ownerStartTicks: '638965000000000002' })
const identity = () => ({ v: 1, op: 'identity', protocol: 1, readOnly: true, steamId: SELF,
  steamPid: 1234, steamStartTicks: state().steamStartTicks })
const cleanup = () => ({ v: 1, op: 'lifecycle', stage: 'cleanup', userReleased: true,
  pipeReleased: true, threadMemoryReleased: true, libraryReleased: true })
function pe(): Buffer {
  const bytes = Buffer.alloc(256)
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88)
  return bytes
}
const file = (directory = false) => ({ isFile: () => !directory, isDirectory: () => directory,
  isSymbolicLink: () => false, dev: 1, ino: directory ? 10 : 11, size: directory ? 0 : 256, mtimeMs: 123456 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function flush(): Promise<void> { for (let index = 0; index < 80; index++) await Promise.resolve() }

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  killCalls = 0; closed = false; closeOnKill = true
  reply(value: object): void { this.stdout.write(JSON.stringify(value) + '\n') }
  close(code = 0): void { if (!this.closed) { this.closed = true; this.emit('close', code) } }
  kill(): boolean { this.killCalls++; if (this.closeOnKill) queueMicrotask(() => this.close(1)); return true }
}
const children: Child[] = []

function fixture(autoComplete = true) {
  const child = new Child(); children.push(child)
  const controller = new AbortController()
  const deps: ScreenshotActiveUserDependencies & { signal?: AbortSignal } = {
    platform: 'win32', arch: 'x64', ownerPid: 9876, signal: controller.signal,
    inspect: vi.fn(async () => state()), lstat: vi.fn(async path => file(path.toLowerCase() === ROOT.toLowerCase())),
    realpath: vi.fn(async path => path), readFile: vi.fn(async () => pe()), digest: vi.fn(() => HASH),
    spawn: vi.fn(() => {
      if (autoComplete) queueMicrotask(() => { child.reply(identity()); child.reply(cleanup()); child.close() })
      return child as unknown as ChildProcessWithoutNullStreams
    }), timeoutMs: 1000, exitTimeoutMs: 10
  }
  return { child, controller, deps, read: () => readScreenshotActiveUser(ROOT, WORKER, deps) }
}

afterEach(async () => {
  for (const child of children.splice(0)) child.close(1)
  await flush()
  vi.useRealTimers()
})

describe('owned cancellation of the real screenshot/native identity provider with only synthetic dependencies', () => {
  it('does not inspect, read files or spawn when the caller is already cancelled', async () => {
    const f = fixture()
    f.controller.abort(new Error('synthetic-private-cancellation'))
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.deps.inspect).not.toHaveBeenCalled()
    expect(f.deps.lstat).not.toHaveBeenCalled()
    expect(f.deps.readFile).not.toHaveBeenCalled()
    expect(f.deps.spawn).not.toHaveBeenCalled()
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it.each(['inspect', 'lstat', 'realpath', 'client-read', 'worker-read'] as const)
  ('never spawns a late helper after cancellation during %s preflight', async phase => {
    const f = fixture()
    const gate = deferred<void>()
    const entered = deferred<void>()
    if (phase === 'inspect') vi.mocked(f.deps.inspect).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return state()
    })
    if (phase === 'lstat') vi.mocked(f.deps.lstat).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return file(true)
    })
    if (phase === 'realpath') vi.mocked(f.deps.realpath).mockImplementationOnce(async path => {
      entered.resolve(); await gate.promise; return path
    })
    if (phase === 'client-read' || phase === 'worker-read') {
      let calls = 0
      vi.mocked(f.deps.readFile).mockImplementation(async () => {
        if (++calls === (phase === 'client-read' ? 1 : 2)) { entered.resolve(); await gate.promise }
        return pe()
      })
    }
    const result = f.read()
    const rejected = expect(result).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await entered.promise
    expect(f.deps.spawn).not.toHaveBeenCalled()
    f.controller.abort()
    gate.resolve()
    await rejected
    await flush()
    expect(f.deps.spawn).not.toHaveBeenCalled()
    expect(f.child.killCalls).toBe(0)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('kills only the owned in-flight identity child, never an unrelated screenshot helper', async () => {
    const f = fixture(false)
    const unrelated = new Child(); children.push(unrelated)
    const result = f.read()
    const rejected = expect(result).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await flush()
    expect(f.deps.spawn).toHaveBeenCalledOnce()
    expect(hasScreenshotIdentityWork()).toBe(true)
    f.child.reply(identity())
    f.controller.abort()
    await rejected
    expect(f.child.killCalls).toBe(1)
    expect(f.child.closed).toBe(true)
    expect(unrelated.killCalls).toBe(0)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('does not accept late valid identity/cleanup frames after cancellation', async () => {
    const f = fixture(false)
    f.child.closeOnKill = false
    const result = f.read()
    const rejected = expect(result).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await flush()
    f.controller.abort()
    f.child.reply(identity()); f.child.reply(cleanup()); f.child.close(0)
    await rejected
    expect(f.child.killCalls).toBe(1)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('keeps an unconfirmed cancelled child in the ownership ledger and blocks a replacement', async () => {
    vi.useFakeTimers()
    const f = fixture(false)
    f.child.closeOnKill = false
    const result = f.read()
    const rejected = expect(result).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await flush()
    f.controller.abort()
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(f.child.killCalls).toBe(1)
    expect(hasScreenshotIdentityWork()).toBe(true)
    const next = fixture()
    await expect(next.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(next.deps.spawn).not.toHaveBeenCalled()
    f.child.close(1)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('rejects cancellation during the final process recheck instead of returning a late proof', async () => {
    const f = fixture()
    const gate = deferred<void>(), entered = deferred<void>()
    vi.mocked(f.deps.inspect).mockResolvedValueOnce(state()).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return state()
    })
    const result = f.read()
    const rejected = expect(result).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await entered.promise
    expect(f.child.closed).toBe(true)
    f.controller.abort()
    gate.resolve()
    await rejected
    expect(f.deps.spawn).toHaveBeenCalledOnce()
    expect(f.child.killCalls).toBe(0)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('removes completed child cancellation ownership and preserves calls without a signal', async () => {
    const f = fixture()
    expect((await f.read()).steamId).toBe(SELF)
    f.controller.abort()
    await flush()
    expect(f.child.killCalls).toBe(0)
    expect(hasScreenshotIdentityWork()).toBe(false)
    const legacy = fixture()
    delete legacy.deps.signal
    expect((await legacy.read()).steamId).toBe(SELF)
    expect(legacy.child.killCalls).toBe(0)
  })

  it('forwards resolver cancellation through the real provider preflight instead of spawning after account retirement', async () => {
    const f = fixture()
    const gate = deferred<void>(), entered = deferred<void>()
    vi.mocked(f.deps.inspect).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return state()
    })
    const steam = { pid: state().steamPid, startTicks: state().steamStartTicks, exe: state().steamExe }
    const game = { pid: 4567, startTicks: '638965000000000003', exe: `${ROOT}\\steamapps\\common\\GTFO\\GTFO.exe` }
    const detect = createVerifiedNativeContextDetector(SELF, WORKER, {
      platform: 'win32',
      inspect: async () => ({ registryExe: steam.exe, steamProcesses: [steam], runningAppId: 0, runningAppIds: [493520],
        activeProcess: { pid: 999, activeUser: 2 }, gameProcess: game }),
      discover: async () => ({ gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe,
        identitySource: 'native-user', dllPath: `${ROOT}\\steamapps\\common\\GTFO\\steam_api64.dll`, dllSha256: 'a'.repeat(64),
        clientDllPath: `${ROOT}\\steamclient64.dll`, clientDllSha256: HASH, arch: 'x64',
        parentPid: state().ownerPid, parentStartTicks: state().ownerStartTicks, steamPid: steam.pid, steamStartTicks: steam.startTicks }),
      realpath: async path => win32.normalize(path),
      readIdentity: (root: string, worker: string, options?: { signal?: AbortSignal }) => readScreenshotActiveUser(root, worker, { ...f.deps, ...options })
    })
    const pending = detect()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    await entered.promise
    detect.cancel()
    await rejected
    gate.resolve()
    await flush()
    expect(f.deps.spawn).not.toHaveBeenCalled()
    expect(hasScreenshotIdentityWork()).toBe(false)
  })
})
