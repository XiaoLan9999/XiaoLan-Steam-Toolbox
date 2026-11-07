import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAppHostBroker, type LocalAppHostBrokerOptions } from '../src/main/local-app-simulation'
import type { LocalAppSimulationContext } from '../src/main/local-app-simulation-context'
import type { LocalAppDiagnosticEvent } from '../src/shared/local-app-diagnostics'

const CONTEXT: LocalAppSimulationContext = {
  appId: 0, activeAppIds: [], steamId: '76561198000000001', steamPid: 1234,
  steamStartTicks: '638965000000000001', steamExe: 'D:/Steam/steam.exe', ownerPid: 5678,
  ownerStartTicks: '638965000000000002'
}
const READ = { fields: {}, keyCount: 0, localizedString: null, verificationSource: 'local-cache' }
const INTERFACES = { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' }
const cleanups: Array<() => Promise<void>> = []

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 12345
  commands: Array<Record<string, unknown>> = []
  autoClose = true
  autoRead = true
  autoPong = true
  killed = 0
  constructor() {
    super()
    this.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk)) as Record<string, unknown>
      this.commands.push(request)
      if (request.op === 'stop') { if (this.autoClose) queueMicrotask(() => this.emit('close', 0, null)); return }
      if (request.op === 'read' && !this.autoRead || request.op === 'ping' && !this.autoPong) return
      queueMicrotask(() => this.frame({ v: 1, requestId: request.requestId,
        op: request.op === 'ping' ? 'pong' : request.op === 'apply' ? 'applied' : request.op,
        ok: true, acceptedKeys: Object.keys((request.changes as object | undefined) ?? {}),
        mayHaveWritten: request.op === 'apply', ...(request.op === 'read' ? READ : {}) }))
    })
  }
  frame(value: object) { this.stdout.write(JSON.stringify(value) + '\n') }
  ready() { this.frame({ v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [],
    mayHaveWritten: false, identityMatch: true, appMatch: true, licensed: true, selectedInterfaces: INTERFACES }) }
  terminal(patch: Record<string, unknown> = {}) { this.frame({ v: 1, requestId: 'invalid', op: 'error',
    ok: false, mayHaveWritten: false, acceptedKeys: [], code: 'LOCAL_APP_TIMEOUT', ...patch }) }
  kill() { this.killed++; return true }
}

function fixture(options: Partial<LocalAppHostBrokerOptions> = {}, ready?: (child: Child) => void) {
  let now = 0
  const children: Child[] = []
  const diagnostics: LocalAppDiagnosticEvent[] = []
  const observer = options.onDiagnostic
  const spawn = vi.fn(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => ready ? ready(child) : child.ready())
    return child as unknown as ChildProcessWithoutNullStreams
  })
  const broker = new LocalAppHostBroker({ getWorkerPath: () => 'D:/synthetic/local-app-host.exe',
    discover: async () => ({ worker: 'D:/synthetic/local-app-host.exe', clientDll: 'D:/Steam/steamclient64.dll', clientSha256: 'a'.repeat(64) }),
    spawn, now: () => now, ...options,
    onDiagnostic: event => { diagnostics.push(event); observer?.(event) } })
  const exited = vi.fn()
  broker.onExit(exited)
  cleanups.push(async () => { for (const child of children) child.emit('close', 0, null); await broker.shutdown() })
  return { broker, diagnostics, exited, children, spawn, time(value: number) { now = value },
    async begin() { return broker.begin(CONTEXT, 4000, () => true) } }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
})

describe('long-running local AppID broker reliability', () => {
  it.each(['stdout', 'stderr'] as const)('does not accumulate ordinary %s noise over a healthy multi-window session', async channel => {
    const f = fixture()
    await f.begin()
    const child = f.children[0]!
    for (let index = 0; index < 256; index++) {
      f.time(index * 1000)
      child[channel].write('x'.repeat(1024) + (channel === 'stdout' ? '\n' : ''))
      await expect(f.broker.read(() => true)).resolves.toMatchObject({ fields: {}, verificationSource: 'local-cache' })
    }
    expect(f.spawn).toHaveBeenCalledOnce()
    expect(f.exited).not.toHaveBeenCalled()
    expect(child.commands.filter(command => command.op === 'stop')).toHaveLength(0)
    expect(f.diagnostics.some(event => event.stage === 'noise-limit')).toBe(false)
  })

  it('keeps a shared rolling noise cap even when valid RPCs are interleaved', async () => {
    const f = fixture()
    await f.begin()
    const child = f.children[0]!
    child.stdout.write('x'.repeat(64 * 1024) + '\n')
    await f.broker.read(() => true)
    child.stderr.write('x'.repeat(64 * 1024))
    await f.broker.read(() => true)
    expect(f.exited).not.toHaveBeenCalled()
    child.stderr.write('x')
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_PROTOCOL_INVALID' }))
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ stage: 'noise-limit', noiseBytes: 128 * 1024 + 1 }))
    expect(child.commands.filter(command => command.op === 'stop')).toHaveLength(1)
  })

  it('expires noise exactly after its rolling window, not after a successful response', async () => {
    const f = fixture()
    await f.begin()
    f.children[0]!.stderr.write('x'.repeat(128 * 1024))
    f.time(30_000)
    f.children[0]!.stderr.write('x')
    await expect(f.broker.read(() => true)).resolves.toMatchObject({ fields: {} })
    expect(f.exited).not.toHaveBeenCalled()
  })

  it('does not let a wall-clock rollback disable the next bounded noise window', async () => {
    const f = fixture()
    await f.begin()
    f.time(90_000)
    f.children[0]!.stderr.write('x'.repeat(128 * 1024))
    f.time(89_000)
    f.children[0]!.stderr.write('x')
    expect(f.exited).not.toHaveBeenCalled()
    f.children[0]!.stderr.write('x'.repeat(128 * 1024))
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_PROTOCOL_INVALID' }))
  })

  it('counts empty stdout lines against the bounded noise budget', async () => {
    const f = fixture()
    await f.begin()
    f.children[0]!.stdout.write('\n'.repeat(128 * 1024 + 1))
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_PROTOCOL_INVALID' }))
  })

  it('still rejects malformed JSON immediately rather than treating it as permitted noise', async () => {
    const f = fixture()
    await f.begin()
    f.children[0]!.stdout.write('{invalid-json}\n')
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_PROTOCOL_INVALID' }))
  })

  it.each(['LOCAL_APP_TIMEOUT', 'LOCAL_APP_CONTEXT_CHANGED', 'LOCAL_APP_CONTEXT_UNAVAILABLE',
    'LOCAL_APP_IDENTITY_MISMATCH', 'LOCAL_APP_APP_MISMATCH', 'LOCAL_APP_NOT_LICENSED'])('preserves a no-write native idle terminal error %s', async code => {
    const f = fixture()
    await f.begin()
    const child = f.children[0]!
    child.terminal({ code })
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }))
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ stage: 'worker-terminal', code }))
    expect(child.commands.filter(command => command.op === 'stop')).toHaveLength(1)
    await Promise.resolve()
    child.emit('close', 70, null)
    expect(f.exited).toHaveBeenCalledOnce()
  })

  it('preserves an idle terminal error while an RPC is waiting instead of changing it to a protocol error', async () => {
    const f = fixture()
    await f.begin()
    const child = f.children[0]!
    child.autoRead = false
    const read = f.broker.read(() => true)
    const rejected = expect(read).rejects.toMatchObject({ code: 'LOCAL_APP_TIMEOUT' })
    child.terminal()
    await rejected
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_TIMEOUT' }))
  })

  it('keeps the original terminal reason if it follows startup-ready in the same stdout chunk', async () => {
    const f = fixture({}, child => { child.ready(); child.terminal() })
    await expect(f.begin()).rejects.toMatchObject({ code: 'LOCAL_APP_TIMEOUT' })
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_TIMEOUT' }))
  })

  it.each([
    { requestId: 'unrelated-request' }, { code: 'LOCAL_APP_PRIVATE_SECRET' }, { mayHaveWritten: true },
    { acceptedKeys: ['desc'] }, { acceptedKeys: {} }, { ok: true }, { op: 'read' }, { v: 2 }
  ])('does not accept an unrelated, malformed or write-bearing terminal envelope %j', async patch => {
    const f = fixture()
    await f.begin()
    f.children[0]!.terminal(patch)
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'LOCAL_APP_PROTOCOL_INVALID' }))
    expect(f.diagnostics.some(event => event.stage === 'worker-terminal')).toBe(false)
  })

  it('records only safe lifecycle metadata and ignores observer failures', async () => {
    const f = fixture({ onDiagnostic: () => { throw new Error('private-observer-secret') } })
    await expect(f.begin()).resolves.toMatchObject({ fields: {} })
    await expect(f.broker.apply({ desc: 'private-presence-secret' }, () => true)).resolves.toMatchObject({ fields: {} })
    await f.broker.shutdown()
    expect(f.diagnostics.map(event => event.stage)).toEqual(['worker-started', 'worker-ready', 'stop-requested', 'worker-exited'])
    expect(f.diagnostics[0]).toMatchObject({ helperPid: 12345, elapsedMs: 0 })
    expect(f.diagnostics.at(-1)).toMatchObject({ exitCode: 0, signal: null, ok: true })
    expect(JSON.stringify(f.diagnostics)).not.toMatch(/private-|7656119|steam\.exe|steamclient/)
  })

  it('records an RPC timeout operation without changing the existing deadline', async () => {
    vi.useFakeTimers()
    const f = fixture({ requestTimeoutMs: 100 })
    await f.begin()
    f.children[0]!.autoRead = false
    const read = f.broker.read(() => true)
    const rejected = expect(read).rejects.toMatchObject({ code: 'LOCAL_APP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ stage: 'request-timeout', operation: 'read', code: 'LOCAL_APP_TIMEOUT' }))
  })

  it('does not notify a new session when an already retired child closes again', async () => {
    const f = fixture()
    await f.begin()
    const old = f.children[0]!
    await f.broker.shutdown()
    await f.broker.begin(CONTEXT, 4000, () => true)
    old.emit('close', 70, 'SIGTERM')
    expect(f.exited).not.toHaveBeenCalled()
    await expect(f.broker.read(() => true)).resolves.toMatchObject({ fields: {} })
  })

  it('reports an unconfirmed retirement once and retains the no-replacement safety boundary', async () => {
    vi.useFakeTimers()
    const f = fixture({ stopTimeoutMs: 10, retireTimeoutMs: 20 })
    await f.begin()
    f.children[0]!.autoClose = false
    const stopping = f.broker.shutdown()
    const rejected = expect(stopping).rejects.toMatchObject({ code: 'LOCAL_APP_STOP_FAILED' })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(f.diagnostics.filter(event => event.stage === 'retire-timeout')).toHaveLength(1)
    await expect(f.broker.begin(CONTEXT, 4000, () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_STOP_FAILED' })
    expect(f.spawn).toHaveBeenCalledOnce()
  })
})
