import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, LIVE_RESTORE_TTL_MS, type GameStatusServiceOptions, type GameStatusSteamClient } from '../src/main/game-status-service'
import type { GameStatusAction, GameStatusSnapshot } from '../src/shared/game-status'

const ACCOUNT = { id: 'native-writer-fixture-A', steamId: '76561198000000001' }
const OTHER = { id: 'native-writer-fixture-B', steamId: '76561198000000002' }
const APP = 1329410
const PRIVATE = 'FAKE-native-writer-private-nonce-connect-never-expose'
type NativeContext = { appId: number; steamId: string }
type NativeChanges = Record<string, string | null>
type NativeCall = { context: NativeContext; changes: NativeChanges; canSubmit(): boolean }
type NativeWriter = { apply(context: NativeContext, changes: NativeChanges, canSubmit: () => boolean): Promise<void>; stop(): void }
const services: GameStatusService[] = []

class Client extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  rp: Record<string, string> = { steam_display: '#NativeDescription', desc: 'Original description', status: 'Original status', connect: PRIVATE, unknown: 'Keep game-owned value' }
  reads = 0
  cmWrites: Array<Record<string, string>> = []
  onRead: (() => Promise<unknown>) | null = null
  logOn(): void {}
  logOff(): void { this.steamID = null }
  gamesPlayed(): void { throw new Error('The native writer must not take over the running game') }
  setPersona(): void { throw new Error('The native writer must not change persona') }
  uploadRichPresence(_app: number, raw: Record<string, string>): void { this.cmWrites.push({ ...raw }); throw new Error('CM writes are forbidden when the native writer is configured') }
  async getProductInfo(): Promise<unknown> { return { apps: { [APP]: { appinfo: { common: { name: 'Synthetic native-writer game' } } } } } }
  async getAppRichPresenceLocalization(): Promise<unknown> { return { tokens: { '#NativeDescription': '%desc%', '#NativeMode': '%mode%' } } }
  response(): unknown { return { users: { [ACCOUNT.steamId]: { richPresence: { ...this.rp }, localizedString: this.rp.steam_display === '#NativeMode' ? this.rp.mode ?? '' : this.rp.desc ?? '' } } } }
  async requestRichPresence(): ReturnType<GameStatusSteamClient['requestRichPresence']> {
    this.reads++
    return (this.onRead ? await this.onRead() : this.response()) as Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>>
  }
}

class Writer implements NativeWriter {
  calls: NativeCall[] = []
  stops = 0
  onApply: ((call: NativeCall) => Promise<void>) | null = null
  constructor(private client: Client) {}
  assign(changes: NativeChanges): void { for (const [key, value] of Object.entries(changes)) { if (value === null) delete this.client.rp[key]; else this.client.rp[key] = value } }
  async apply(context: NativeContext, changes: NativeChanges, canSubmit: () => boolean): Promise<void> {
    const call = { context: { ...context }, changes: { ...changes }, canSubmit }
    this.calls.push(call)
    if (this.onApply) return this.onApply(call)
    if (!canSubmit()) throw new Error('Synthetic native operation was cancelled')
    this.assign(changes)
  }
  stop(): void { this.stops++ }
}

function fixture() {
  let account = ACCOUNT
  const client = new Client()
  const writer = new Writer(client)
  const changes: GameStatusSnapshot[] = []
  const options: GameStatusServiceOptions & { nativeWriter: NativeWriter } = { getActiveAccount: () => account, createClient: () => client, nativeWriter: writer, onChange: value => changes.push(value) }
  const service = new GameStatusService(options)
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: account.id, sessionId: service.state().sessionId })
  service.connect({ ...action(), accountName: 'synthetic-native-user', password: 'FAKE-native-fixture-password' })
  client.steamID = { getSteamID64: () => account.steamId }; client.emit('loggedOn')
  return { client, writer, service, changes, action, select(next: typeof ACCOUNT) { account = next } }
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function flush(): Promise<void> { for (let index = 0; index < 40; index++) await Promise.resolve() }
const safe = (value: unknown): void => { expect(JSON.stringify(value)).not.toContain(PRIVATE) }
const observe = async (f: ReturnType<typeof fixture>) => (await f.service.observeLive(f.action())).live!

function deferWriter(f: ReturnType<typeof fixture>) {
  const gate = deferred<void>()
  f.writer.onApply = async call => {
    await gate.promise
    if (!call.canSubmit()) throw new Error('Synthetic native operation was cancelled')
    f.writer.assign(call.changes)
  }
  return gate
}

afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('async native writes remain narrow and independently verified', () => {
  it('passes only changed public keys, bound identity and a live submission guard, never the merged private map', async () => {
    const f = fixture(); const observed = await observe(f)
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Native edited description' } })
    expect(f.writer.calls).toHaveLength(1)
    expect(f.writer.calls[0]!.context).toEqual({ appId: APP, steamId: ACCOUNT.steamId })
    expect(f.writer.calls[0]!.changes).toEqual({ desc: 'Native edited description' })
    expect(typeof f.writer.calls[0]!.canSubmit).toBe('function')
    expect(f.client.cmWrites).toEqual([])
    expect(f.client.rp).toMatchObject({ connect: PRIVATE, unknown: 'Keep game-owned value', status: 'Original status' })
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'matched' })
    safe([state, f.changes, f.writer.calls])
  })

  it('awaits the native result before CM readback and does not report a pending write as matched', async () => {
    const f = fixture(); const observed = await observe(f); const gate = deferWriter(f)
    const pending = f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Awaited native description' } })
    await flush()
    expect(f.writer.calls).toHaveLength(1); expect(f.client.reads).toBe(2)
    expect(f.service.state().busy).toBe(true); expect(f.service.state().live?.patchActive).toBe(true)
    expect(f.service.state().lastOperation?.kind).toBe('observe')
    gate.resolve(); const state = await pending
    expect(f.client.reads).toBe(3); expect(state.busy).toBe(false)
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'matched' })
    expect(f.client.cmWrites).toEqual([])
  })

  it('submits only the published display token and parameters when applying a native template', async () => {
    const f = fixture(); const observed = await observe(f)
    const state = await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.snapshotId, lock: false, presence: { displayToken: '#NativeMode', values: { mode: 'Synthetic room' } } })
    expect(f.writer.calls[0]!.changes).toEqual({ steam_display: '#NativeMode', mode: 'Synthetic room' })
    expect(f.client.rp.connect).toBe(PRIVATE); expect(f.client.rp.desc).toBe('Original description')
    expect(state.lastOperation?.outcome).toBe('matched'); expect(f.client.cmWrites).toEqual([])
    safe([state, f.changes, f.writer.calls])
  })

  it('does not apply the native-cache readable-field restriction to a server-backed template lock', async () => {
    vi.useFakeTimers()
    const f = fixture()
    vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockResolvedValue({ tokens: { '#Minutes': '%minutes% minutes' } })
    const observed = await observe(f)
    const state = await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.snapshotId, lock: true, presence: { displayToken: '#Minutes', values: { minutes: '5' } } })
    expect(f.writer.calls.map(call => call.changes)).toEqual([{ steam_display: '#Minutes', minutes: '5' }])
    expect(state.liveLock).toMatchObject({ status: 'locked', matched: true, desired: { steam_display: '#Minutes', minutes: '5' } })
    expect(state.lastOperation).toMatchObject({ kind: 'lock', outcome: 'matched', verificationSource: 'server' })
    expect(f.client.cmWrites).toEqual([])
  })

  it('restores an originally absent template parameter with null, not a full clear or an omitted delete', async () => {
    const f = fixture(); const observed = await observe(f)
    await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.snapshotId, lock: false, presence: { displayToken: '#NativeMode', values: { mode: 'Temporary room' } } })
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls).toHaveLength(2)
    expect(f.writer.calls[1]!.changes).toEqual({ steam_display: '#NativeDescription', mode: null })
    expect(f.client.rp).not.toHaveProperty('mode')
    expect(f.client.rp).toMatchObject({ steam_display: '#NativeDescription', connect: PRIVATE, unknown: 'Keep game-owned value' })
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(state.live?.patchActive).toBe(false); expect(f.client.cmWrites).toEqual([])
  })

  it('retains submitted=yes and an unverified result when CM readback fails after native acceptance', async () => {
    const f = fixture(); const observed = await observe(f)
    f.client.onRead = async () => { if (f.writer.calls.length) throw new Error(PRIVATE); return f.client.response() }
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Accepted native change' } })
    expect(f.writer.calls).toHaveLength(1); expect(f.client.rp.desc).toBe('Accepted native change')
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'unverified' })
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'readback', submitted: 'yes' })
    expect(state.live?.patchActive).toBe(true); safe([state, f.changes])
  })

  it('does not call a successful native API write matched when the server still reports the old value', async () => {
    const f = fixture(); const observed = await observe(f); f.writer.onApply = async () => undefined
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Not yet observed by server' } })
    expect(f.writer.calls).toHaveLength(1)
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'unverified' })
    expect(state.live?.patchActive).toBe(true); expect(f.client.rp.desc).toBe('Original description')
  })
})

describe('native partial-write recovery never overwrites third-party changes', () => {
  it('records recovery before a partial native failure and restores only keys still equal to toolbox values', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async call => { expect(f.service.state().live?.patchActive).toBe(true); f.writer.assign({ desc: call.changes.desc! }); throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Partially written desc', status: 'Not written status' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED', submitted: 'unknown' })
    expect(f.service.state().live?.patchActive).toBe(true)
    expect(f.client.rp).toMatchObject({ desc: 'Partially written desc', status: 'Original status' })
    f.writer.onApply = null
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls[1]!.changes).toEqual({ desc: 'Original description' })
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(state.live?.patchActive).toBe(false); safe([state, f.changes])
  })

  it('preserves a pre-write failure ledger until a read proves all original values already remain', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async () => { throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Not written' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    expect(f.service.state().live?.patchActive).toBe(true)
    f.writer.onApply = null
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls).toHaveLength(1)
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(state.live?.patchActive).toBe(false); expect(f.client.rp.desc).toBe('Original description')
  })

  it('finishes an already-original restore from its first read without a phantom submission or redundant failing readback', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async () => { throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Not written' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    f.writer.onApply = null
    let recoveryReads = 0
    f.client.onRead = async () => { recoveryReads++; if (recoveryReads > 1) throw new Error(PRIVATE); return f.client.response() }
    const state = await f.service.restoreLive(f.action())
    expect(recoveryReads).toBe(1); expect(f.writer.calls).toHaveLength(1)
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(state.failure).toBeNull(); expect(state.live?.patchActive).toBe(false)
    safe([state, f.changes])
  })

  it('clears the ledger when a typed native identity refusal proves no key could have been written', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async () => { throw Object.assign(new Error(PRIVATE), { code: 'GAME_STATUS_NATIVE_IDENTITY', mayHaveWritten: false }) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Not permitted' } })).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_IDENTITY' })
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_NATIVE_IDENTITY', submitted: 'no' })
    expect(f.service.state().live?.patchActive).toBe(false)
    expect(f.client.rp.desc).toBe('Original description'); expect(f.client.cmWrites).toEqual([])
    safe([f.service.state(), f.changes])
  })

  it('keeps an uncertain mixed-result ledger after an explicit read and does not permit a new overlapping edit', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async call => { f.writer.assign({ desc: call.changes.desc! }); throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Partially accepted', status: 'Not accepted' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    const reread = await f.service.observeLive(f.action())
    expect(reread.live?.patchActive).toBe(true)
    expect(reread.live?.fields).toMatchObject({ desc: 'Partially accepted', status: 'Original status' })
    await expect(f.service.patchLive({ ...f.action(), snapshotId: reread.live!.snapshotId, changes: { desc: 'Do not overwrite recovery' } })).rejects.toThrow()
    expect(f.writer.calls).toHaveLength(1)
    f.writer.onApply = null
    const restored = await f.service.restoreLive(f.action())
    expect(f.writer.calls[1]!.changes).toEqual({ desc: 'Original description' })
    expect(restored.lastOperation?.outcome).toBe('matched'); expect(restored.live?.patchActive).toBe(false)
  })

  it('refuses all restore writes if any tracked key has an independent third value', async () => {
    const f = fixture(); const observed = await observe(f)
    f.writer.onApply = async call => { f.writer.assign({ desc: call.changes.desc! }); throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Toolbox partial value', status: 'Toolbox status' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    f.client.rp.status = 'New game-owned third value'; f.writer.onApply = null
    const state = await f.service.restoreLive(f.action())
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'conflict' })
    expect(f.writer.calls).toHaveLength(1)
    expect(f.client.rp).toMatchObject({ desc: 'Toolbox partial value', status: 'New game-owned third value' })
  })

  it('keeps an unconfirmed restore ledger and recovers a mixture of already-original and still-toolbox values', async () => {
    const f = fixture(); const observed = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Toolbox desc', status: 'Toolbox status' } })
    f.writer.onApply = async call => { f.writer.assign({ desc: call.changes.desc! }) }
    const unverified = await f.service.restoreLive(f.action())
    expect(unverified.lastOperation).toMatchObject({ kind: 'restore', outcome: 'unverified' })
    expect(unverified.live?.patchActive).toBe(true)
    expect(f.client.rp).toMatchObject({ desc: 'Original description', status: 'Toolbox status' })
    f.writer.onApply = null
    const verified = await f.service.restoreLive(f.action())
    expect(f.writer.calls[2]!.changes).toEqual({ status: 'Original status' })
    expect(verified.lastOperation?.outcome).toBe('matched'); expect(verified.live?.patchActive).toBe(false)
  })

  it('does not discard restoration evidence solely because CM readback failed', async () => {
    const f = fixture(); const observed = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Toolbox desc' } })
    f.client.onRead = async () => { if (f.writer.calls.length >= 2) throw new Error(PRIVATE); return f.client.response() }
    const state = await f.service.restoreLive(f.action())
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'unverified' })
    expect(state.failure).toMatchObject({ stage: 'readback', submitted: 'yes' })
    expect(state.live?.patchActive).toBe(true)
    f.client.onRead = null
    const confirmed = await f.service.restoreLive(f.action())
    expect(f.writer.calls).toHaveLength(2)
    expect(confirmed.lastOperation?.outcome).toBe('matched'); expect(confirmed.live?.patchActive).toBe(false)
    safe([state, confirmed, f.changes])
  })
})

describe('native writes cannot revive retired account, game or lock state', () => {
  it.each(['account', 'game', 'dispose'] as const)('cancels an in-flight native operation on %s change', async kind => {
    const f = fixture(); const observed = await observe(f); const gate = deferWriter(f)
    const pending = f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Must not revive' } })
    const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }))
    await flush(); expect(f.writer.calls).toHaveLength(1)
    const stops = f.writer.stops
    if (kind === 'account') { f.select(OTHER); f.service.invalidate() }
    else if (kind === 'game') f.client.emit('playingState', true, 730)
    else f.service.dispose()
    const clean = f.service.state()
    expect(f.writer.stops).toBeGreaterThan(stops); expect(f.writer.calls[0]!.canSubmit()).toBe(false)
    gate.resolve(); expect((await settled).rejected).toBe(true); await flush()
    expect(f.service.state()).toEqual({ ...clean, busy: false })
    expect(f.service.state().live).toBeNull(); expect(f.service.state().liveLock == null).toBe(true)
    expect(f.writer.calls).toHaveLength(1); expect(f.client.cmWrites).toEqual([])
    expect(f.client.rp.desc).toBe('Original description'); safe([f.service.state(), f.changes])
  })

  it('unlock without restore cancels initial native lock submission and cannot install the late lock', async () => {
    const f = fixture(); const observed = await observe(f); const gate = deferWriter(f)
    const pending = f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Cancelled initial lock' } })
    const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }))
    await flush(); expect(f.writer.calls).toHaveLength(1)
    const stops = f.writer.stops
    await f.service.unlockLive({ ...f.action(), restore: false })
    expect(f.writer.stops).toBeGreaterThan(stops); expect(f.writer.calls[0]!.canSubmit()).toBe(false)
    gate.resolve(); expect((await settled).rejected).toBe(true); await flush()
    expect(f.service.state().liveLock == null || f.service.state().liveLock?.status === 'stopped').toBe(true)
    expect(f.service.state().lastOperation?.kind).toBe('unlock')
    expect(f.client.rp.desc).toBe('Original description'); expect(f.writer.calls).toHaveLength(1)
  })

  it.each(['account', 'game', 'dispose'] as const)('cancels an in-flight native restore on %s change without reviving its recovery record', async kind => {
    const f = fixture(); const observed = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Previous accepted patch' } })
    const gate = deferWriter(f)
    const pending = f.service.restoreLive(f.action())
    const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }))
    await flush(); expect(f.writer.calls).toHaveLength(2)
    const stops = f.writer.stops
    if (kind === 'account') { f.select(OTHER); f.service.invalidate() }
    else if (kind === 'game') f.client.emit('playingState', true, 730)
    else f.service.dispose()
    const clean = f.service.state()
    expect(f.writer.stops).toBeGreaterThan(stops); expect(f.writer.calls[1]!.canSubmit()).toBe(false)
    gate.resolve(); expect((await settled).rejected).toBe(true); await flush()
    expect(f.service.state()).toEqual({ ...clean, busy: false })
    expect(f.service.state().live).toBeNull(); expect(f.service.state().liveLock == null).toBe(true)
    expect(f.client.rp.desc).toBe('Previous accepted patch'); expect(f.client.cmWrites).toEqual([])
    safe([f.service.state(), f.changes])
  })

  it('unlock cancels an in-flight lock reassertion and prevents future native retries', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Locked description' } })
    f.client.rp.desc = 'Fresh game update'; const gate = deferWriter(f)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS); await flush()
    expect(f.writer.calls).toHaveLength(2); expect(f.service.state().liveLock?.status).toBe('checking')
    await f.service.unlockLive({ ...f.action(), restore: false })
    expect(f.writer.calls[1]!.canSubmit()).toBe(false)
    gate.resolve(); await flush(); await vi.advanceTimersByTimeAsync(30000)
    expect(f.writer.calls).toHaveLength(2)
    expect(f.service.state().liveLock?.status).toBe('stopped'); expect(f.service.state().liveLock?.nextCheckAt).toBeNull()
    expect(f.service.state().lastOperation?.kind).toBe('unlock')
    expect(f.client.rp.desc).toBe('Fresh game update'); expect(f.client.cmWrites).toEqual([])
  })

  it('refreshes safe restoration while the same lock keeps returning matched fields', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Long-running synthetic lock' } })
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS + 1)
    expect(f.service.state().liveLock?.matched).toBe(true)
    const writes = f.writer.calls.length
    const state = await f.service.unlockLive({ ...f.action(), restore: true })
    expect(f.writer.calls).toHaveLength(writes + 1)
    expect(f.service.state().liveLock?.status).toBe('stopped')
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(f.client.rp.desc).toBe('Original description')
  })
})

describe('native helper exit invalidates a live writer without discarding guarded recovery', () => {
  it('stops an already matched lock and does not restart its timer after live-context invalidation', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Matched before helper exit' } })
    expect(f.service.state().liveLock?.status).toBe('locked')
    const stops = f.writer.stops
    f.service.invalidateLiveContext()
    expect(f.writer.stops).toBeGreaterThan(stops)
    expect(f.writer.calls[0]!.canSubmit()).toBe(false)
    expect(f.service.state().liveLock).toMatchObject({ status: 'stopped', nextCheckAt: null })
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_NATIVE_CONTEXT', stage: 'context', appId: APP, submitted: 'unknown' })
    expect(f.service.state().live?.patchActive).toBe(true)
    f.client.rp.desc = 'Changed while helper was gone'
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 8)
    expect(f.writer.calls).toHaveLength(1)
    expect(f.service.state().liveLock?.status).toBe('stopped')
    expect(f.client.rp.desc).toBe('Changed while helper was gone')
    expect(f.client.cmWrites).toEqual([]); safe([f.service.state(), f.changes])
  })

  it('cancels a pending partial write while retaining its ledger for a read and narrow safe restoration', async () => {
    const f = fixture(); const observed = await observe(f); const gate = deferred<void>()
    f.writer.onApply = async call => {
      f.writer.assign({ desc: call.changes.desc! })
      await gate.promise
      if (!call.canSubmit()) throw new Error('Synthetic helper context was invalidated')
      f.writer.assign({ status: call.changes.status! })
    }
    const pending = f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Partial value before exit', status: 'Must not write after exit' } })
    const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }))
    await flush(); expect(f.writer.calls).toHaveLength(1)
    expect(f.client.rp).toMatchObject({ desc: 'Partial value before exit', status: 'Original status' })
    const stops = f.writer.stops
    f.service.invalidateLiveContext()
    expect(f.writer.stops).toBeGreaterThan(stops); expect(f.writer.calls[0]!.canSubmit()).toBe(false)
    gate.resolve(); expect((await settled).rejected).toBe(true); await flush()
    expect(f.service.state().liveLock == null || f.service.state().liveLock?.status === 'stopped').toBe(true)
    expect(f.service.state().live?.patchActive).toBe(true)
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_NATIVE_CONTEXT', submitted: 'unknown' })
    const reread = await f.service.observeLive(f.action())
    expect(reread.live?.patchActive).toBe(true)
    expect(reread.live?.fields).toMatchObject({ desc: 'Partial value before exit', status: 'Original status' })
    f.writer.onApply = null
    const restored = await f.service.restoreLive(f.action())
    expect(f.writer.calls[1]!.changes).toEqual({ desc: 'Original description' })
    expect(restored.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(restored.live?.patchActive).toBe(false)
    expect(f.client.rp).toMatchObject({ desc: 'Original description', status: 'Original status', connect: PRIVATE })
    expect(f.client.cmWrites).toEqual([]); safe([restored, f.changes])
  })

  it('does not resume the old lock when a restarted game reports the same AppID with new presence', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Old-process locked value' } })
    f.service.invalidateLiveContext()
    f.client.rp.desc = 'New-process published value'
    f.client.emit('playingState', true, APP)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 8)
    expect(f.writer.calls).toHaveLength(1); expect(f.client.rp.desc).toBe('New-process published value')
    expect(f.service.state().blockingAppId).toBe(APP)
    expect(f.service.state().liveLock).toMatchObject({ status: 'stopped', nextCheckAt: null })
    const reread = await f.service.observeLive(f.action())
    expect(reread.live?.fields.desc).toBe('New-process published value')
    expect(reread.live?.patchActive).toBe(false)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 8)
    expect(f.writer.calls).toHaveLength(1); expect(f.client.cmWrites).toEqual([])
    safe([reread, f.changes])
  })
})

describe('native acceptance waits for independent CM projection without resubmitting', () => {
  it('confirms a delayed projection after one native apply and cancels another pending readback when unlocked', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f); const before = f.client.response()
    let projectionReads = 0
    f.client.onRead = async () => {
      if (!f.writer.calls.length) return f.client.response()
      projectionReads++
      return projectionReads === 1 ? before : f.client.response()
    }
    const pending = f.service.patchLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Delayed CM projection' } })
    await flush()
    expect(projectionReads).toBe(1); expect(f.writer.calls).toHaveLength(1)
    expect(f.service.state().busy).toBe(true); expect(f.service.state().lastOperation?.kind).toBe('observe')
    await vi.advanceTimersByTimeAsync(250)
    const confirmed = await pending
    expect(projectionReads).toBe(2); expect(f.writer.calls).toHaveLength(1)
    expect(confirmed.lastOperation).toMatchObject({ kind: 'patch', outcome: 'matched' })
    expect(confirmed.live?.fields.desc).toBe('Delayed CM projection'); expect(f.client.cmWrites).toEqual([])

    const cancelled = fixture(); const old = await observe(cancelled); const oldProjection = cancelled.client.response()
    cancelled.client.onRead = async () => cancelled.writer.calls.length ? oldProjection : cancelled.client.response()
    const locking = cancelled.service.lockLive({ ...cancelled.action(), snapshotId: old.snapshotId, changes: { desc: 'Accepted but pending verification' } })
    const settled = locking.then(() => ({ rejected: false }), () => ({ rejected: true }))
    await flush()
    expect(cancelled.writer.calls).toHaveLength(1); expect(cancelled.client.reads).toBe(3)
    await cancelled.service.unlockLive({ ...cancelled.action(), restore: false })
    expect(cancelled.writer.calls[0]!.canSubmit()).toBe(false)
    await vi.advanceTimersByTimeAsync(30000)
    expect((await settled).rejected).toBe(true)
    expect(cancelled.writer.calls).toHaveLength(1); expect(cancelled.client.reads).toBe(3)
    expect(cancelled.service.state().liveLock == null || cancelled.service.state().liveLock?.status === 'stopped').toBe(true)
    expect(cancelled.service.state().lastOperation?.kind).toBe('unlock')
    expect(cancelled.service.state().busy).toBe(false); expect(cancelled.client.cmWrites).toEqual([])
    safe([confirmed, f.changes, cancelled.service.state(), cancelled.changes])
  })

  it('replaces an initial unverified lock operation with matched after a later read-only check succeeds', async () => {
    vi.useFakeTimers()
    const f = fixture(); const observed = await observe(f); const before = f.client.response()
    f.client.onRead = async () => f.writer.calls.length ? before : f.client.response()
    const pending = f.service.lockLive({ ...f.action(), snapshotId: observed.snapshotId, changes: { desc: 'Eventually projected lock' } })
    await flush(); await vi.advanceTimersByTimeAsync(250 + 750 + 1500)
    const initial = await pending
    expect(initial.lastOperation).toMatchObject({ kind: 'lock', outcome: 'unverified' })
    expect(initial.liveLock).toMatchObject({ status: 'retrying', matched: false })
    expect(f.writer.calls).toHaveLength(1)
    f.client.onRead = null
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    const verified = f.service.state()
    expect(verified.liveLock).toMatchObject({ status: 'locked', matched: true })
    expect(verified.lastOperation).toMatchObject({ kind: 'lock', outcome: 'matched' })
    expect(verified.live?.fields.desc).toBe('Eventually projected lock')
    expect(verified.failure).toBeNull(); expect(verified.lastOperation?.at).not.toBe(initial.lastOperation?.at)
    expect(f.writer.calls).toHaveLength(1); expect(f.client.cmWrites).toEqual([])
    safe([initial, verified, f.changes])
  })
})
