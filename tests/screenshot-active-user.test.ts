import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasScreenshotIdentityWork, readScreenshotActiveUser, shutdownScreenshotIdentityReads, type ScreenshotActiveUserDependencies } from '../src/main/screenshot-active-user'

const ROOT = 'D:\\Steam'
const WORKER = resolve('fixture-screenshot-identity.exe')
const HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const SELF = '76561198000000001'
const state = () => ({ steamExe: `${ROOT}\\steam.exe`, registryExe: `${ROOT}\\steam.exe`, steamPid: 1234, steamStartTicks: '638965000000000001', ownerPid: 9876, ownerStartTicks: '638965000000000002' })
const identity = () => ({ v: 1, op: 'identity', protocol: 1, readOnly: true, steamId: SELF, steamPid: 1234, steamStartTicks: state().steamStartTicks })
const cleanup = () => ({ v: 1, op: 'lifecycle', stage: 'cleanup', userReleased: true, pipeReleased: true, threadMemoryReleased: true, libraryReleased: true })
function pe() { const bytes = Buffer.alloc(256); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88); return bytes }
const file = (directory = false) => ({ isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, dev: 1, ino: directory ? 10 : 11, size: directory ? 0 : 256, mtimeMs: 123456 })
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); killCalls = 0; closed = false; closeOnKill = true
  reply(value: object) { this.stdout.write(JSON.stringify(value) + '\n') }
  close(code = 0) { if (!this.closed) { this.closed = true; this.emit('close', code) } }
  kill() { this.killCalls++; if (this.closeOnKill) queueMicrotask(() => this.close(1)); return true }
}
const children: Child[] = []
afterEach(() => { for (const child of children.splice(0)) child.close(1); vi.useRealTimers() })
function fixture(frames: unknown[] = [identity(), cleanup()], autoClose = true) {
  const child = new Child(); children.push(child)
  const deps: ScreenshotActiveUserDependencies = {
    platform: 'win32', arch: 'x64', ownerPid: 9876, inspect: vi.fn(async () => state()),
    lstat: vi.fn(async path => file(path.toLowerCase() === ROOT.toLowerCase())), realpath: vi.fn(async path => path),
    readFile: vi.fn(async () => pe()), digest: vi.fn(() => HASH),
    spawn: vi.fn(() => { queueMicrotask(() => { for (const value of frames) { if (typeof value === 'string') child.stdout.write(value); else child.reply(value as object) }; if (autoClose) child.close() }); return child as unknown as ChildProcessWithoutNullStreams }),
    timeoutMs: 1000, exitTimeoutMs: 1000
  }
  return { child, deps, read: () => readScreenshotActiveUser(ROOT, WORKER, deps) }
}

describe('read-only actual Steam user provider', () => {
  it('returns only verified native identity after cleanup and actual helper exit', async () => {
    const f = fixture()
    expect(await f.read()).toEqual({ steamPath: ROOT, steamExe: `${ROOT}\\steam.exe`, steamPid: 1234, steamStartTicks: state().steamStartTicks, steamId: SELF, clientSha256: HASH })
    expect(f.deps.inspect).toHaveBeenCalledTimes(2)
    expect(f.deps.spawn).toHaveBeenCalledExactlyOnceWith(WORKER, ['--read-current-user', `${ROOT}\\steamclient64.dll`, HASH, '1234', state().steamStartTicks, '9876', state().ownerStartTicks])
    expect(f.child.killCalls).toBe(0)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('uses API identity rather than unrelated stale registry PID/user records', async () => {
    const f = fixture()
    vi.mocked(f.deps.inspect).mockResolvedValue({ ...state(), recordedPid: 4321, recordedUser: '76561198000000002' })
    expect((await f.read()).steamId).toBe(SELF)
  })

  it('does not reject an identity read merely because a real game is running', async () => {
    const f = fixture(); vi.mocked(f.deps.inspect).mockResolvedValue({ ...state(), runningAppId: 730, activeApps: [730] })
    expect((await f.read()).steamId).toBe(SELF)
  })

  it.each([
    { platform: 'linux' as const }, { arch: 'ia32' }, { ownerPid: 0 },
    { digest: () => '0'.repeat(64) }, { readFile: async () => Buffer.alloc(256) }
  ])('fails closed before spawning for unsupported environment or image %#', async overrides => {
    const f = fixture(); Object.assign(f.deps, overrides)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.deps.spawn).not.toHaveBeenCalled()
  })

  it.each([null, {}, { ...state(), steamPid: 0 }, { ...state(), ownerPid: 1234 }, { ...state(), steamStartTicks: '' }, { ...state(), steamExe: 'D:\\Other\\steam.exe' }, { ...state(), registryExe: 'D:\\Other\\steam.exe' }])('rejects incomplete or conflicting process evidence %#', async value => {
    const f = fixture(); vi.mocked(f.deps.inspect).mockResolvedValue(value)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.deps.spawn).not.toHaveBeenCalled()
  })

  it('rejects filesystem links or redirected roots', async () => {
    const f = fixture(); vi.mocked(f.deps.realpath).mockImplementation(async path => path === ROOT ? 'D:\\Redirect' : path)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.deps.spawn).not.toHaveBeenCalled()
  })

  it('rechecks Steam PID and start time after native probe exit', async () => {
    const f = fixture(); vi.mocked(f.deps.inspect).mockResolvedValueOnce(state()).mockResolvedValueOnce({ ...state(), steamPid: 5678 })
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
  })

  it.each([
    [identity()], [cleanup(), identity()], [identity(), cleanup(), identity()],
    [{ ...identity(), steamId: String(0x0110000100000000n) }, cleanup()], [{ ...identity(), steamPid: 5678 }, cleanup()],
    [{ ...identity(), steamStartTicks: '638965000000000099' }, cleanup()], [{ ...identity(), readOnly: false }, cleanup()],
    [identity(), { ...cleanup(), pipeReleased: false }], [identity(), { ...cleanup(), libraryReleased: false }],
    [{ v: 1, op: 'ready', steamId: SELF }, cleanup()], ['invalid json\n'], [' '.repeat(32 * 1024 + 1)]
  ].map(frames => ({ frames })))('rejects unverified, failed, malformed or oversized native evidence %#', async ({ frames }) => {
    const f = fixture(frames)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
  })

  it('does not equate identity/cleanup acknowledgement with actual process exit', async () => {
    const f = fixture([identity(), cleanup()], false)
    const pending = f.read(); await vi.waitFor(() => expect(f.deps.spawn).toHaveBeenCalledTimes(1))
    expect(hasScreenshotIdentityWork()).toBe(true)
    f.child.close()
    expect((await pending).steamId).toBe(SELF)
  })

  it('prevents simultaneous probes, including during slow discovery', async () => {
    const f = fixture(); let resume!: () => void
    vi.mocked(f.deps.inspect).mockImplementationOnce(async () => { await new Promise<void>(done => { resume = done }); return state() })
    const pending = f.read(); await vi.waitFor(() => expect(f.deps.inspect).toHaveBeenCalledTimes(1))
    expect(hasScreenshotIdentityWork()).toBe(true)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    resume(); expect((await pending).steamId).toBe(SELF)
  })

  it('does not expose helper errors or private stderr to the caller', async () => {
    const f = fixture([{ v: 1, op: 'error', code: 'PRIVATE_SECRET_PATH' }])
    f.child.stderr.write('private source path, password, cookie')
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE', message: expect.not.stringContaining('PRIVATE_SECRET_PATH') })
  })

  it('drains only the owned identity helper and requires its actual close', async () => {
    const f = fixture([], false)
    const pending = f.read(); const rejected = expect(pending).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await vi.waitFor(() => expect(f.deps.spawn).toHaveBeenCalledTimes(1))
    await shutdownScreenshotIdentityReads(); await rejected
    expect(f.child.killCalls).toBe(1)
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('cancels discovery without creating a helper after shutdown has begun', async () => {
    const f = fixture(); let resume!: () => void
    vi.mocked(f.deps.inspect).mockImplementationOnce(async () => { await new Promise<void>(done => { resume = done }); return state() })
    const pending = f.read(); const rejected = expect(pending).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await vi.waitFor(() => expect(f.deps.inspect).toHaveBeenCalledTimes(1))
    await shutdownScreenshotIdentityReads()
    resume(); await rejected
    expect(f.deps.spawn).not.toHaveBeenCalled()
    expect(hasScreenshotIdentityWork()).toBe(false)
  })

  it('keeps an unconfirmed exit visible and blocks new probes until close arrives', async () => {
    vi.useFakeTimers()
    const f = fixture([], false); f.child.closeOnKill = false; f.deps.timeoutMs = 8000
    const pending = f.read(); const rejected = expect(pending).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await vi.waitFor(() => expect(f.deps.spawn).toHaveBeenCalledTimes(1))
    const draining = shutdownScreenshotIdentityReads(); const failed = expect(draining).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(4001); await failed
    expect(hasScreenshotIdentityWork()).toBe(true)
    await expect(f.read()).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    f.child.close(1); await rejected
    expect(hasScreenshotIdentityWork()).toBe(false)
  })
})
