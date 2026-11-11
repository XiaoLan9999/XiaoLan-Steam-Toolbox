import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonaLockService, type PersonaReadback, type PersonaSession } from '../src/main/persona-lock-service'
import { hasNativePersonaWork, NativePersonaSession, readPersonaFrame } from '../src/main/persona-lock-client'
import { sanitizeDiagnosticRecord } from '../src/shared/diagnostics'

afterEach(() => vi.useRealTimers())
const account = { id: 'fixture-account', steamId: '76561198000000001' }
function fixture() {
  let selected: typeof account | null = account
  let current = 1, original: number | null = null, locked = false
  const native: PersonaSession = {
    ready: { currentState: 1, originalState: null, locked: false, restored: null },
    request: vi.fn(async op => {
      let restored: boolean | null = null
      if (op === 'lock') {
        if (current === 0 || current === 7) { locked = false; original = null }
        else { if (!locked) original = current; current = 4; locked = true }
      }
      if (op === 'stop') { if (locked && current === 4 && original !== null) { current = original; restored = true } locked = false }
      return { currentState: current, originalState: original, locked, restored }
    }),
    close: vi.fn(async () => {})
  }
  const connect = vi.fn(async () => native)
  const service = new PersonaLockService({ enableWrites: true, getActiveAccount: () => selected, connect, now: () => 100000 })
  return { service, native, connect, input: () => ({ accountId: account.id, sessionId: service.state().sessionId, mode: 'snooze' as const }),
    select: (value: typeof account | null) => { selected = value }, setState: (value: number) => { current = value } }
}

describe('local persona lock', () => {
  it('disables production writes by default after live verification failed', async () => {
    const connect = vi.fn()
    const service = new PersonaLockService({ getActiveAccount: () => account, connect })
    expect(service.state().available).toBe(false)
    await expect(service.start({ accountId: account.id, sessionId: service.state().sessionId, mode: 'snooze' })).rejects.toMatchObject({ code: 'PERSONA_UNAVAILABLE' })
    expect(connect).not.toHaveBeenCalled()
  })
  it('does not connect or write when constructed or queried', () => {
    const f = fixture(); expect(f.service.state().status).toBe('idle'); expect(f.connect).not.toHaveBeenCalled()
  })
  it('rejects stale contexts and unsupported modes before connecting', async () => {
    const f = fixture()
    await expect(f.service.start({ ...f.input(), sessionId: 'stale' })).rejects.toMatchObject({ code: 'PERSONA_CONTEXT_CHANGED' })
    await expect(f.service.start({ ...f.input(), mode: 'deck' as 'snooze' })).rejects.toMatchObject({ code: 'PERSONA_UNAVAILABLE' })
    expect(f.connect).not.toHaveBeenCalled()
  })
  it('locks persona only, checks in the main process and explicitly restores once', async () => {
    vi.useFakeTimers(); const f = fixture()
    const state = await f.service.start(f.input())
    expect(state).toMatchObject({ status: 'locked', currentState: 4, originalState: 1, busy: false })
    f.setState(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.native.request).toHaveBeenCalledTimes(2)
    const done = await f.service.stop(f.input())
    expect(done).toMatchObject({ status: 'idle', currentState: 1, restored: true })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.native.request).toHaveBeenCalledTimes(3)
    expect(f.native.close).toHaveBeenCalledTimes(1)
  })
  it.each([0, 7])('does not override privacy state %s', async privacy => {
    vi.useFakeTimers(); const f = fixture(); f.setState(privacy)
    expect(await f.service.start(f.input())).toMatchObject({ status: 'error', error: 'PERSONA_PRIVATE_STATE', currentState: privacy })
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.native.request).toHaveBeenCalledTimes(1)
  })
  it('stops on account changes without a new connection or another lock write', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input()); f.select({ ...account, id: 'other' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.service.state()).toMatchObject({ status: 'error', error: 'PERSONA_CONTEXT_CHANGED' })
    expect(f.native.request).toHaveBeenCalledTimes(1); expect(f.connect).toHaveBeenCalledTimes(1)
    expect(f.native.close).toHaveBeenCalledOnce()
  })
  it('cancels a connection still starting and never writes after cancellation', async () => {
    const f = fixture(); let finish!: (session: PersonaSession) => void
    f.connect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const start = f.service.start(f.input()), stop = f.service.shutdown()
    finish(f.native); await start; await stop
    expect(f.native.request).not.toHaveBeenCalled(); expect(f.native.close).toHaveBeenCalledOnce()
  })
  it('waits for the current lock request before a verified stop, without reconnecting', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input())
    let finish!: (value: PersonaReadback) => void
    vi.mocked(f.native.request).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(5000)
    const stop = f.service.shutdown()
    finish({ currentState: 4, originalState: 1, locked: true, restored: null }); await stop
    expect(f.service.state()).toMatchObject({ status: 'idle', restored: true })
    expect(f.connect).toHaveBeenCalledOnce()
  })
  it('keeps failed restoration unconfirmed instead of claiming success', async () => {
    const f = fixture(); await f.service.start(f.input())
    vi.mocked(f.native.request).mockRejectedValueOnce(new Error('fixture failure'))
    expect(await f.service.stop(f.input())).toMatchObject({ status: 'error', error: 'PERSONA_UNCONFIRMED', restored: null })
  })
  it('exports only allowlisted persona diagnostics, not account data or raw errors', () => {
    expect(sanitizeDiagnosticRecord({ event: 'persona-lock', stage: 'locked', currentState: 4, restored: true,
      steamId: account.steamId, accountId: account.id, cookie: 'fixture-secret', code: 'raw private message', nativeCode: 'raw private message' }))
      .toEqual({ event: 'persona-lock', stage: 'locked', currentState: 4, restored: true })
    expect(sanitizeDiagnosticRecord({ event: 'persona-lock', stage: 'error', nativeCode: 'PERSONA_SET_REJECTED' }))
      .toEqual({ event: 'persona-lock', stage: 'error', nativeCode: 'PERSONA_SET_REJECTED' })
  })
})

function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  const signal = new AbortController()
  const session = new NativePersonaSession(child as unknown as ChildProcessWithoutNullStreams, account.steamId, 9001, '638900000000000000', signal.signal)
  const send = (frame: object) => child.stdout.write(JSON.stringify({ v: 1, ...frame }) + '\n')
  const ready = () => send({ op: 'ready', steamId: account.steamId, steamPid: 9001, steamStartTicks: '638900000000000000', currentState: 1, originalState: null, locked: false })
  const exit = (code = 0) => { send({ op: 'lifecycle', stage: 'cleanup', userReleased: true, pipeReleased: true, threadMemoryReleased: true, libraryReleased: true, restored: null }); child.emit('close', code) }
  return { child, signal, session, send, ready, exit }
}
describe('persona helper transport', () => {
  it('validates readback without pretending an active lease always matches the current state', () => {
    expect(readPersonaFrame({ currentState: 3, originalState: 1, locked: true, restored: null }).currentState).toBe(3)
    expect(() => readPersonaFrame({ currentState: 4, originalState: null, locked: true, restored: null })).toThrow()
    expect(() => readPersonaFrame({ currentState: 99, originalState: 1, locked: false, restored: false })).toThrow()
  })
  it('binds ready identity and correlates request IDs, including cleanup and actual exit', async () => {
    const f = childFixture(); f.ready(); await f.session.initialized()
    f.child.stdin.on('data', bytes => {
      const request = JSON.parse(String(bytes)); f.send({ op: 'result', requestId: request.requestId, currentState: 4, originalState: 1, locked: true, restored: null })
    })
    expect(await f.session.request('lock')).toMatchObject({ currentState: 4, locked: true })
    expect(hasNativePersonaWork()).toBe(true)
    f.exit(); await f.session.close(); expect(hasNativePersonaWork()).toBe(false)
  })
  it('does not accumulate a lifetime output budget that disconnects long-running locks', async () => {
    const f = childFixture(); f.ready(); await f.session.initialized()
    f.child.stdin.on('data', bytes => { const request = JSON.parse(String(bytes)); f.send({ op: 'result', requestId: request.requestId, currentState: 4, originalState: 1, locked: true, restored: null }) })
    for (let i = 0; i < 8000; i++) await f.session.request('lock')
    expect(hasNativePersonaWork()).toBe(true); f.exit(); await f.session.close()
  })
  it('retains ownership after a kill request until actual process close', async () => {
    vi.useFakeTimers(); const f = childFixture(); f.ready(); await f.session.initialized()
    const closing = f.session.close(); const failed = expect(closing).rejects.toMatchObject({ code: 'PERSONA_UNCONFIRMED' })
    await vi.advanceTimersByTimeAsync(8000); await failed
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(hasNativePersonaWork()).toBe(true)
    f.exit(1); expect(hasNativePersonaWork()).toBe(false)
  })
  it.each(['PERSONA_IDENTITY_MISMATCH', 'PERSONA_CONTEXT_CHANGED'])('preserves the helper context failure code %s', async code => {
    const f = childFixture(); f.ready(); await f.session.initialized()
    const read = f.session.request('read')
    f.send({ op: 'error', code })
    await expect(read).rejects.toMatchObject({ code: 'PERSONA_CONTEXT_CHANGED', nativeCode: code })
    f.exit(1); await expect(f.session.close()).rejects.toMatchObject({ code: 'PERSONA_UNCONFIRMED' })
  })
  it('keeps an unsolicited context-loss reason for the next main-process check', async () => {
    const f = childFixture(); f.ready(); await f.session.initialized()
    f.send({ op: 'error', code: 'PERSONA_CONTEXT_CHANGED' }); f.exit(1)
    await expect(f.session.request('lock')).rejects.toMatchObject({ code: 'PERSONA_CONTEXT_CHANGED' })
    await expect(f.session.close()).rejects.toMatchObject({ code: 'PERSONA_UNCONFIRMED' })
  })
  it('does not accept a cleanup frame contradicting the reported restoration', async () => {
    const f = childFixture(); f.ready(); await f.session.initialized()
    f.child.stdin.on('data', bytes => { const request = JSON.parse(String(bytes)); f.send({ op: 'result', requestId: request.requestId, currentState: 1, originalState: null, locked: false, restored: true }) })
    await f.session.request('stop')
    f.send({ op: 'lifecycle', stage: 'cleanup', userReleased: true, pipeReleased: true, threadMemoryReleased: true, libraryReleased: true, restored: false }); f.child.emit('close', 0)
    await expect(f.session.close()).rejects.toMatchObject({ code: 'PERSONA_UNCONFIRMED' })
  })
})
