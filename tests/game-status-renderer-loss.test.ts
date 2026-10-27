import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, type GameStatusSteamClient } from '../src/main/game-status-service'
import type { GameStatusAction } from '../src/shared/game-status'

const ACCOUNT = { id: 'renderer-loss-fixture', steamId: '76561198000000001' }
const APP = 1329410
const services: GameStatusService[] = []
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }

class Client extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  rp = { desc: 'Original native value' }
  reads = 0
  onRead: (() => Promise<unknown>) | null = null
  logOff = vi.fn(() => { this.steamID = null })
  setPersona = vi.fn((_value: number) => {})
  gamesPlayed = vi.fn((_value: string | number[]) => {})
  uploadRichPresence = vi.fn((_app: number, _fields: Record<string, string>) => {})
  constructor(readonly presenceSource: 'local-cache' | 'server' = 'local-cache') { super() }
  logOn(): void { this.steamID = { getSteamID64: () => ACCOUNT.steamId }; this.emit('loggedOn') }
  response() { return { users: { [ACCOUNT.steamId]: { richPresence: { ...this.rp }, localizedString: this.rp.desc, displayTokenReadable: false } } } }
  async requestRichPresence(): ReturnType<GameStatusSteamClient['requestRichPresence']> {
    this.reads++
    return this.onRead ? await this.onRead() as Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>> : this.response()
  }
}

function fixture() {
  const client = new Client()
  const calls: Array<{ changes: Record<string, string | null>; permitted(): boolean }> = []
  let gate: ReturnType<typeof deferred<void>> | null = null
  const stop = vi.fn()
  const createLocal = vi.fn(() => client)
  const service = new GameStatusService({ getActiveAccount: () => ACCOUNT, createLocalClient: createLocal,
    nativeWriter: { stop, async apply(_context, changes, permitted) {
      calls.push({ changes: { ...changes }, permitted })
      if (gate) await gate.promise
      if (!permitted()) throw new Error('Cancelled synthetic native operation')
      client.rp.desc = changes.desc!
    } }
  })
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: ACCOUNT.id, sessionId: service.state().sessionId })
  service.connectLocal(action())
  const observe = async () => (await service.observeLive(action())).live!
  const lock = async () => { const live = await observe(); return service.lockLive({ ...action(), snapshotId: live.snapshotId, changes: { desc: 'Locked synthetic value' } }) }
  return { client, service, calls, stop, createLocal, action, observe, lock, gateWrite() { gate = deferred<void>(); return gate } }
}

afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('renderer loss retires game state without restoration writes', () => {
  it('stops lock timers, closes the owned session and never reconnects on later state reads', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.lock()
    const oldSession = f.service.state().sessionId
    const reads = f.client.reads; const stops = f.stop.mock.calls.length
    f.service.invalidateForRendererLoss()
    expect(f.service.state()).toMatchObject({ connected: false, status: 'logged_out', live: null, liveLock: null, busy: false })
    expect(f.service.state().sessionId).not.toBe(oldSession)
    expect(f.stop.mock.calls.length).toBeGreaterThan(stops)
    expect(f.client.logOff).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    f.service.state(); f.service.snapshot()
    expect(f.client.reads).toBe(reads)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.permitted()).toBe(false)
    expect(f.client.rp.desc).toBe('Locked synthetic value')
    expect(f.createLocal).toHaveBeenCalledOnce()
  })

  it('discards a late lock check read and cannot install another timer after renderer loss', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.lock()
    const gate = deferred<unknown>(); f.client.onRead = () => gate.promise
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(f.service.state().liveLock?.status).toBe('checking')
    f.service.invalidateForRendererLoss()
    const empty = f.service.state()
    gate.resolve(f.client.response()); await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.state()).toEqual(empty)
    expect(f.calls).toHaveLength(1)
    expect(f.client.logOff).toHaveBeenCalledOnce()
  })

  it.each(['initial', 'reassert'] as const)('invalidates an in-flight %s native write before its late completion', async kind => {
    vi.useFakeTimers()
    const f = fixture()
    if (kind === 'reassert') { await f.lock(); f.client.rp.desc = 'Fresh game-owned value' }
    const gate = f.gateWrite()
    let settled: Promise<boolean> | null = null
    if (kind === 'initial') settled = f.lock().then(() => false, () => true)
    else await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    await flush()
    expect(f.calls).toHaveLength(kind === 'initial' ? 1 : 2)
    const active = f.calls.at(-1)!
    expect(active.permitted()).toBe(true)
    f.service.invalidateForRendererLoss()
    expect(active.permitted()).toBe(false)
    const empty = f.service.state()
    gate.resolve(); if (settled) expect(await settled).toBe(true)
    await flush(); await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.state()).toEqual(empty)
    expect(f.client.rp.desc).toBe(kind === 'initial' ? 'Original native value' : 'Fresh game-owned value')
    expect(f.client.uploadRichPresence).not.toHaveBeenCalled()
  })

  it('retires a late loggedOn event rather than reviving the invisible session', async () => {
    const f = fixture(); await f.lock()
    const old = f.action()
    f.service.invalidateForRendererLoss()
    f.client.steamID = { getSteamID64: () => ACCOUNT.steamId }; f.client.emit('loggedOn')
    expect(f.client.logOff).toHaveBeenCalledTimes(2)
    expect(f.service.state().connected).toBe(false)
    await expect(f.service.observeLive(old)).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.createLocal).toHaveBeenCalledOnce()
  })

  it('does not explicitly clear CM simulation while the renderer has no recoverable UI state', () => {
    const client = new Client('server'); client.playingState = { blocked: false, appid: 0 }
    const service = new GameStatusService({ getActiveAccount: () => ACCOUNT, createClient: () => client })
    services.push(service)
    service.connect({ accountId: ACCOUNT.id, sessionId: service.state().sessionId, accountName: 'synthetic', password: 'fixture-only' })
    client.emit('playingState', false, 0)
    service.play({ accountId: ACCOUNT.id, sessionId: service.state().sessionId, displayKind: 'custom', gameName: 'Synthetic game', details: '' })
    const played = client.gamesPlayed.mock.calls.length
    expect(played).toBeGreaterThan(0)
    service.invalidateForRendererLoss()
    expect(client.gamesPlayed.mock.calls).toHaveLength(played)
    expect(client.uploadRichPresence).not.toHaveBeenCalled()
    expect(client.logOff).toHaveBeenCalledOnce()
  })
})
