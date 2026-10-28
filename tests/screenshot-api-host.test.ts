import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverScreenshotApiContext, ScreenshotApiHost, type ScreenshotApiContext, type ScreenshotApiDiscoveryDependencies } from '../src/main/screenshot-api-host'

const HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const ROOT = 'D:\\Steam'
const EXE = `${ROOT}\\steam.exe`
const DLL = `${ROOT}\\steamclient64.dll`
const CONTEXT: ScreenshotApiContext = { steamExe: EXE, clientDll: DLL, clientSha256: HASH, steamPid: 1234, steamStartTicks: '638964000000000001',
  steamId: '76561198000000001', appId: 730, ownerPid: 5678, ownerStartTicks: '638964000000000002' }
const cleanups: Array<() => Promise<void>> = []
const directories: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('screenshot-api-host-')) throw new Error('Unsafe fixture cleanup')
    await fs.rm(directory, { recursive: true, force: true })
  }
})

function pe(): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88)
  return bytes
}
const stat = (directory: boolean) => ({ isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, dev: 1, ino: directory ? 10 : 11, size: directory ? 0 : 512, mtimeMs: 123 })
function discoveryFixture() {
  let state: unknown = { steamExe: EXE, registryExe: EXE, steamPid: CONTEXT.steamPid, steamStartTicks: CONTEXT.steamStartTicks,
    ownerPid: CONTEXT.ownerPid, ownerStartTicks: CONTEXT.ownerStartTicks, runningAppId: 0, runningAppIds: [], staleRegistryPid: 9999 }
  const deps: ScreenshotApiDiscoveryDependencies = { platform: 'win32', arch: 'x64', ownerPid: CONTEXT.ownerPid,
    execute: vi.fn(async () => ({ stdout: JSON.stringify(state) })), lstat: vi.fn(async path => stat(path === ROOT)),
    realpath: vi.fn(async path => path), readFile: vi.fn(async () => pe()), digest: vi.fn(() => HASH) }
  return { deps, discover: (root = ROOT, user = '39734273', app: string | number = '730') => discoverScreenshotApiContext(root, user, app, deps),
    setState(value: unknown) { state = value }, snapshot: () => structuredClone(state) as Record<string, unknown> }
}

describe('screenshot API context discovery without stale ActiveProcess identity', () => {
  it('uses the unique actual client process and derives expected account from the selected userdata', async () => {
    const f = discoveryFixture()
    expect(await f.discover()).toEqual(CONTEXT)
    const args = vi.mocked(f.deps.execute).mock.calls[0]!
    expect(args[2]).toMatchObject({ shell: false, windowsHide: true, timeout: 10000, maxBuffer: 131072 })
    const encoded = args[1].at(-1)!
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('Get-Process -Name steam')
    expect(script).toContain('Get-CimInstance Win32_Process')
    expect(script).not.toMatch(/ActiveProcess|ActiveUser|SteamAPI|Set-ItemProperty/)
  })

  it('supports the complete uint32 account-ID range and canonical numeric App IDs', async () => {
    const f = discoveryFixture()
    expect((await f.discover(ROOT, '4294967295', 730)).steamId).toBe(String(76_561_197_960_265_728n + 0xffffffffn))
  })

  it.each([
    ['Steam', '39734273', '730'], ['D:\\Steam\0bad', '39734273', '730'], [ROOT, '0', '730'], [ROOT, '039734273', '730'],
    [ROOT, '4294967296', '730'], [ROOT, '39734273', '0'], [ROOT, '39734273', '480'], [ROOT, '39734273', '0730'],
    [ROOT, '39734273', '1e3'], [ROOT, '39734273', '16777216']
  ])('rejects malformed or unsupported context input %j/%j/%j', async (root, user, app) => {
    const f = discoveryFixture()
    await expect(f.discover(root, user, app)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.deps.execute).not.toHaveBeenCalled()
  })

  it.each([
    { steamPid: 0 }, { steamPid: 5678 }, { steamStartTicks: '' }, { ownerStartTicks: 'invalid' }, { ownerPid: 123 },
    { steamExe: 'D:\\Other\\steam.exe' }, { registryExe: 'D:\\Other\\steam.exe' }, { runningAppId: 730 }, { runningAppIds: [1329410] },
    { runningAppIds: [null] }, { runningAppIds: Array.from({ length: 4097 }, () => 0) }
  ])('fails closed for wrong identity, path or a running game %#', async changes => {
    const f = discoveryFixture(); f.setState({ ...f.snapshot(), ...changes })
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
  })

  it.each(['linux', 'darwin'] as const)('does not inspect unsupported platform %s', async platform => {
    const f = discoveryFixture(); f.deps.platform = platform
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.deps.execute).not.toHaveBeenCalled()
  })

  it.each([ROOT, EXE, DLL])('rejects redirects or links at %s', async target => {
    const f = discoveryFixture(); vi.mocked(f.deps.realpath).mockImplementation(async path => path === target ? 'D:\\Redirected' : path)
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
  })

  it('rejects an unsupported DLL, wrong architecture, and a changed image while hashing', async () => {
    const f = discoveryFixture(); vi.mocked(f.deps.digest).mockReturnValue('a'.repeat(64))
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    vi.mocked(f.deps.digest).mockReturnValue(HASH)
    vi.mocked(f.deps.readFile).mockImplementation(async () => { const bytes = pe(); bytes.writeUInt16LE(0x14c, 68); return bytes })
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    vi.mocked(f.deps.readFile).mockImplementation(async () => pe())
    let count = 0
    vi.mocked(f.deps.lstat).mockImplementation(async path => ({ ...stat(path === ROOT), mtimeMs: path === DLL && ++count > 2 ? 456 : 123 }))
    await expect(f.discover()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
  })

  it('sanitizes inspection errors without exposing command output, credentials or private paths', async () => {
    const f = discoveryFixture(); vi.mocked(f.deps.execute).mockRejectedValue(new Error('D:\\private\\secret token'))
    await expect(f.discover()).rejects.not.toThrow('private')
  })
})

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 9999
  commands: Record<string, unknown>[] = []
  autoClose = true
  killed = 0
  onAdd: ((request: Record<string, unknown>) => void) | null = null
  constructor() {
    super()
    this.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk)) as Record<string, unknown>; this.commands.push(request)
      if (request.op === 'stop') { this.reply({ v: 1, op: 'stopped', requestId: request.requestId }); if (this.autoClose) queueMicrotask(() => this.emit('close', 0)); return }
      if (request.op === 'add') this.onAdd?.(request)
    })
  }
  reply(value: object) { this.stdout.write(JSON.stringify(value) + '\n') }
  ready(changes: object = {}) { this.reply({ v: 1, op: 'ready', steamId: CONTEXT.steamId, appId: CONTEXT.appId, protocol: 1, screenshotsVersion: 'STEAMSCREENSHOTS_INTERFACE_VERSION003', getter: 'generic12', ...changes }) }
  confirmed(request: Record<string, unknown>, handle = 7) {
    this.reply({ v: 1, op: 'submitting', requestId: request.requestId })
    this.reply({ v: 1, op: 'submitted', requestId: request.requestId, handle })
    this.reply({ v: 1, op: 'result', requestId: request.requestId, status: 'confirmed', mayHaveSubmitted: true, handle, result: 1 })
  }
  kill() { this.killed++; return true }
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(resolve(tmpdir()), 'screenshot-api-host-')))
  directories.push(root)
  const stage = join(root, 'stage'); await fs.mkdir(stage)
  const worker = join(root, 'worker.exe'); await fs.writeFile(worker, Buffer.alloc(512))
  const path = join(stage, 'test.jpg'); await fs.writeFile(path, Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]))
  const children: Child[] = []
  const spawn = vi.fn((_worker: string, _args: string[]) => {
    const child = new Child(); children.push(child); queueMicrotask(() => child.ready()); return child as unknown as ChildProcessWithoutNullStreams
  })
  const host = new ScreenshotApiHost({ workerPath: () => worker, spawn, readyTimeoutMs: 100, addTimeoutMs: 100, stopTimeoutMs: 20, retireTimeoutMs: 40 })
  cleanups.push(async () => { for (const child of children) { child.autoClose = true; child.emit('close', 0) }; await host.shutdown() })
  return { root, stage, worker, path, children, spawn, host, image: { path, width: 640, height: 480, sha256: 'a'.repeat(64) } }
}

describe('persistent screenshot API worker broker', () => {
  it('passes only the nine pinned context arguments and imports multiple images through one worker', async () => {
    const f = await fixture(); expect(f.host.hasClientWork()).toBe(false)
    const starting = f.host.start(CONTEXT, f.stage)
    expect(f.host.hasClientWork()).toBe(true)
    await starting
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(f.worker, [DLL, HASH, '1234', CONTEXT.steamStartTicks, '730', CONTEXT.steamId, '5678', CONTEXT.ownerStartTicks, f.stage])
    const child = f.children[0]!; child.onAdd = request => child.confirmed(request)
    expect(await f.host.add(f.image)).toEqual({ status: 'confirmed', mayHaveSubmitted: true, handle: 7, result: 1 })
    expect(await f.host.add(f.image)).toMatchObject({ status: 'confirmed' })
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(child.commands.filter(command => command.op === 'add')).toHaveLength(2)
    await f.host.shutdown()
    expect(f.host.hasClientWork()).toBe(false)
    expect(child.killed).toBe(0)
  })

  it.each([{ steamId: '76561198000000002' }, { appId: 4000 }, { protocol: 2 }, { screenshotsVersion: 'unsupported' }, { getter: 'internal' }])('rejects a mismatched ready identity/ABI %# before any add', async changes => {
    const f = await fixture()
    f.spawn.mockImplementationOnce(() => { const child = new Child(); f.children.push(child); queueMicrotask(() => child.ready(changes)); return child as unknown as ChildProcessWithoutNullStreams })
    await expect(f.host.start(CONTEXT, f.stage)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.children[0]!.commands.some(command => command.op === 'add')).toBe(false)
  })

  it('rejects startup errors without leaking private child stderr or sending images', async () => {
    const f = await fixture()
    f.spawn.mockImplementationOnce(() => { const child = new Child(); f.children.push(child); queueMicrotask(() => { child.stderr.write('private local path'); child.reply({ v: 1, op: 'error', code: 'NOT_LICENSED' }) }); return child as unknown as ChildProcessWithoutNullStreams })
    await expect(f.host.start(CONTEXT, f.stage)).rejects.not.toThrow('private')
    expect(f.children[0]!.commands.filter(command => command.op === 'add')).toHaveLength(0)
  })

  it('accepts explicit pre-call rejection without claiming the image was submitted', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.onAdd = request => child.reply({ v: 1, op: 'result', requestId: request.requestId, status: 'rejected', mayHaveSubmitted: false, code: 'IMAGE_CHANGED' })
    expect(await f.host.add(f.image)).toEqual({ status: 'rejected', mayHaveSubmitted: false, code: 'IMAGE_CHANGED' })
  })

  it('preserves an INVALID_SCREENSHOT_HANDLE without inventing a successful callback', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.onAdd = request => {
      child.reply({ v: 1, op: 'submitting', requestId: request.requestId })
      child.reply({ v: 1, op: 'result', requestId: request.requestId, status: 'rejected', mayHaveSubmitted: true, handle: 0, code: 'INVALID_SCREENSHOT_HANDLE' })
    }
    expect(await f.host.add(f.image)).toMatchObject({ status: 'rejected', mayHaveSubmitted: true, handle: 0 })
  })

  it.each(['disconnect', 'timeout', 'malformed', 'wrong-id', 'wrong-handle', 'private-code', 'inconsistent-result'])('returns uncertain after stdin submission on %s and never retries', async mode => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!
    child.onAdd = request => {
      if (mode === 'disconnect') { child.emit('close', 1); return }
      if (mode === 'timeout') return
      if (mode === 'malformed') { child.stdout.write('{not json}\n'); return }
      if (mode === 'wrong-id') { child.reply({ v: 1, op: 'submitting', requestId: 'different' }); return }
      child.reply({ v: 1, op: 'submitting', requestId: request.requestId })
      child.reply({ v: 1, op: 'submitted', requestId: request.requestId, handle: 7 })
      child.reply({ v: 1, op: 'result', requestId: request.requestId, status: 'confirmed', mayHaveSubmitted: mode !== 'inconsistent-result',
        handle: mode === 'wrong-handle' ? 8 : 7, result: 1, ...(mode === 'private-code' ? { code: 'private C:/secret' } : {}) })
    }
    expect(await f.host.add(f.image)).toMatchObject({ status: 'uncertain', mayHaveSubmitted: true })
    expect(child.commands.filter(command => command.op === 'add')).toHaveLength(1)
  })

  it('retains the native uncertain outcome and retires the worker without resubmitting', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.onAdd = request => {
      child.reply({ v: 1, op: 'submitting', requestId: request.requestId }); child.reply({ v: 1, op: 'submitted', requestId: request.requestId, handle: 12 })
      child.reply({ v: 1, op: 'result', requestId: request.requestId, status: 'uncertain', mayHaveSubmitted: true, handle: 12, code: 'CALLBACK_TIMEOUT' })
    }
    expect(await f.host.add(f.image)).toEqual({ status: 'uncertain', mayHaveSubmitted: true, handle: 12, code: 'CALLBACK_TIMEOUT' })
    expect(child.commands.filter(command => command.op === 'add')).toHaveLength(1)
    await f.host.shutdown()
  })

  it('accepts split JSON frames and bounded cleanup lifecycle messages', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.onAdd = request => {
      child.stdout.write('ignored Steam log\n')
      const frames = [JSON.stringify({ v: 1, op: 'submitting', requestId: request.requestId }), JSON.stringify({ v: 1, op: 'submitted', requestId: request.requestId, handle: 7 }), JSON.stringify({ v: 1, op: 'result', requestId: request.requestId, status: 'confirmed', mayHaveSubmitted: true, handle: 7, result: 1 })].join('\n') + '\n'
      for (let offset = 0; offset < frames.length; offset += 7) child.stdout.write(Buffer.from(frames.slice(offset, offset + 7)))
      child.reply({ v: 1, op: 'lifecycle', stage: 'cleanup', userReleased: true, pipeReleased: true, threadMemoryReleased: true, libraryReleased: true })
    }
    expect(await f.host.add(f.image)).toMatchObject({ status: 'confirmed' })
  })

  it('bounds malformed output and stderr without exposing the discarded bytes', async () => {
    for (const channel of ['stdout', 'stderr'] as const) {
      const f = await fixture(); await f.host.start(CONTEXT, f.stage)
      const child = f.children[0]!; child.onAdd = () => child[channel].write('private'.repeat(20000))
      expect(await f.host.add(f.image)).toEqual({ status: 'uncertain', mayHaveSubmitted: true, code: 'PROTOCOL_INVALID' })
    }
  })

  it('does not admit a concurrent add or start during an active image call', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const pending = f.host.add(f.image)
    await vi.waitFor(() => expect(f.children[0]!.commands.some(command => command.op === 'add')).toBe(true))
    await expect(f.host.add(f.image)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_BUSY' })
    await expect(f.host.start(CONTEXT, f.stage)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_BUSY' })
    await f.host.shutdown()
    expect(await pending).toMatchObject({ status: 'uncertain', mayHaveSubmitted: true })
  })

  it('rejects an image outside the per-operation staging directory before stdin submission', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const outside = join(f.root, 'outside.jpg'); await fs.writeFile(outside, Buffer.alloc(10))
    await expect(f.host.add({ ...f.image, path: outside })).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.children[0]!.commands.filter(command => command.op === 'add')).toHaveLength(0)
  })

  it('sanitizes missing source-file errors before submission', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const missing = join(f.stage, 'private-missing.jpg')
    await expect(f.host.add({ ...f.image, path: missing })).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    await expect(f.host.add({ ...f.image, path: missing })).rejects.not.toThrow('private-missing')
    expect(f.children[0]!.commands.filter(command => command.op === 'add')).toHaveLength(0)
  })

  it.each([{ width: 0 }, { height: 16001 }, { width: 8000, height: 8000 }, { width: 1.5 }, { sha256: 'A'.repeat(64) }, { path: 'relative.jpg' }])('rejects invalid image geometry, digest or path before stdin submission %#', async changes => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    await expect(f.host.add({ ...f.image, ...changes })).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.children[0]!.commands.filter(command => command.op === 'add')).toHaveLength(0)
  })

  it('requires actual process close after a stopped acknowledgement and reports unconfirmed shutdown', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.autoClose = false
    await expect(f.host.shutdown()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_STOP_FAILED' })
    expect(child.killed).toBe(1)
    expect(f.host.hasClientWork()).toBe(true)
    child.emit('close', 0)
    expect(f.host.hasClientWork()).toBe(false)
  })

  it('accepts a bounded native idle self-exit but still waits for actual close', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!
    child.reply({ v: 1, op: 'stopped', reason: 'IDLE_TIMEOUT' })
    expect(f.host.hasClientWork()).toBe(true)
    child.emit('close', 0)
    expect(f.host.hasClientWork()).toBe(false)
    await f.host.shutdown()
  })

  it('blocks a new worker while an old process has unconfirmed exit', async () => {
    const f = await fixture(); await f.host.start(CONTEXT, f.stage)
    const child = f.children[0]!; child.autoClose = false
    await expect(f.host.shutdown()).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_STOP_FAILED' })
    await expect(f.host.start(CONTEXT, f.stage)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_STOP_FAILED' })
    expect(f.spawn).toHaveBeenCalledTimes(1)
    child.emit('close', 0)
  })

  it('rejects redirected stage roots and workers without launching a child', async () => {
    const f = await fixture(); const alias = join(f.root, 'alias')
    await fs.symlink(f.stage, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.host.start(CONTEXT, alias)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNAVAILABLE' })
    expect(f.spawn).not.toHaveBeenCalled()
  })
})
