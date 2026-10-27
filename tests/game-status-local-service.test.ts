import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, type GameStatusServiceOptions, type GameStatusSteamClient } from '../src/main/game-status-service'
import type { GameStatusAction, GameStatusSnapshot } from '../src/shared/game-status'

const ACCOUNT = { id: 'local-presence-fixture-A', steamId: '76561198000000001' }
const OTHER = { id: 'local-presence-fixture-B', steamId: '76561198000000002' }
const APP = 1329410
const TEMPLE = '魂天神社内'
const EDITED = '王座之间 四人东'
const PRIVATE = 'SYNTHETIC_LOCAL_PRIVATE_JOIN_VALUE_NEVER_EXPOSE'
const services: GameStatusService[] = []
type NativeCall = { context: { appId: number; steamId: string }; changes: Record<string, string | null>; canSubmit(): boolean }

class Client extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  rp: Record<string, string> = { desc: TEMPLE, status: 'Original status', connect: PRIVATE, unknown_private: PRIVATE }
  displayTokenReadable = false
  identity = ACCOUNT.steamId
  loginCalls: Record<string, unknown>[] = []
  logoutCalls = 0
  reads = 0
  cmWrites: Record<string, string>[] = []
  personaCalls: number[] = []
  playedCalls: Array<string | number[]> = []
  onRead: (() => Promise<unknown>) | null = null
  product = vi.fn(async () => ({ apps: { [APP]: { appinfo: { common: { name: 'Synthetic local game', icon: 'a'.repeat(40) } } } } }))
  localization = vi.fn(async () => ({ tokens: {} }))
  revalidate = vi.fn(async () => {})
  constructor(readonly presenceSource: 'local-cache' | 'server' = 'local-cache') { super() }
  logOn(details: Record<string, unknown>): void {
    this.loginCalls.push({ ...details })
    this.steamID = { getSteamID64: () => this.identity }
    this.emit('loggedOn')
  }
  logOff(): void { this.logoutCalls++; this.steamID = null }
  setPersona(value: number): void { this.personaCalls.push(value) }
  gamesPlayed(value: string | number[]): void { this.playedCalls.push(value) }
  uploadRichPresence(_app: number, raw: Record<string, string>): void { this.cmWrites.push({ ...raw }) }
  getProductInfo(): Promise<unknown> { return this.product() }
  getAppRichPresenceLocalization(): Promise<unknown> { return this.localization() }
  revalidateContext(): Promise<void> { return this.revalidate() }
  response(): unknown {
    return { users: { [ACCOUNT.steamId]: { richPresence: { ...this.rp, steam_display: this.presenceSource === 'local-cache' && !this.displayTokenReadable ? this.rp.desc : this.rp.steam_display ?? '#Status_Game' }, localizedString: this.rp.desc, displayTokenReadable: this.displayTokenReadable } } }
  }
  async requestRichPresence(): ReturnType<GameStatusSteamClient['requestRichPresence']> {
    this.reads++
    return (this.onRead ? await this.onRead() : this.response()) as Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>>
  }
}

class Writer {
  calls: NativeCall[] = []
  stops = 0
  onApply: ((call: NativeCall) => Promise<void>) | null = null
  constructor(private client: Client) {}
  assign(changes: Record<string, string | null>): void {
    for (const [key, value] of Object.entries(changes)) { if (value === null) delete this.client.rp[key]; else this.client.rp[key] = value }
  }
  async apply(context: NativeCall['context'], changes: NativeCall['changes'], canSubmit: () => boolean): Promise<void> {
    const call = { context: { ...context }, changes: { ...changes }, canSubmit }
    this.calls.push(call)
    if (this.onApply) return this.onApply(call)
    if (!canSubmit()) throw new Error('Synthetic operation cancelled')
    this.assign(changes)
  }
  stop(): void { this.stops++ }
}

function fixture(options: { connect?: boolean; localFactory?: boolean; identity?: string; paused?: boolean } = {}) {
  let account = ACCOUNT
  const local = new Client()
  const cm = new Client('server')
  if (options.identity) local.identity = options.identity
  cm.playingState = { blocked: false, appid: 0 }
  const writer = new Writer(local)
  const changes: GameStatusSnapshot[] = []
  const nonce = vi.fn(async () => ({ steamId: ACCOUNT.steamId, accountName: 'Synthetic CM account', webLogonToken: 'SYNTHETIC_NONCE_NOT_USED_BY_LOCAL' }))
  const createCM = vi.fn(() => cm)
  const createLocal = vi.fn((_steamId: string) => local)
  const serviceOptions: GameStatusServiceOptions = {
    localConnectionPaused: options.paused,
    getActiveAccount: () => account,
    getToolboxLogin: nonce,
    createClient: createCM,
    nativeWriter: writer,
    onChange: state => changes.push(state),
    ...(options.localFactory === false ? {} : { createLocalClient: createLocal })
  }
  const service = new GameStatusService(serviceOptions)
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: account.id, sessionId: service.state().sessionId })
  if (options.connect !== false) service.connectLocal(action())
  return { service, local, cm, writer, changes, nonce, createCM, createLocal, action, select(next: typeof ACCOUNT) { account = next } }
}

type Fixture = ReturnType<typeof fixture>
const observe = async (f: Fixture) => (await f.service.observeLive(f.action())).live!
const safe = (value: unknown): void => { expect(JSON.stringify(value)).not.toContain(PRIVATE) }
const assertNoCM = (f: Fixture): void => { expect(f.nonce).not.toHaveBeenCalled(); expect(f.createCM).not.toHaveBeenCalled(); expect(f.local.cmWrites).toEqual([]) }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const flush = async (): Promise<void> => { for (let index = 0; index < 40; index++) await Promise.resolve() }

afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('local Steam connection never creates a personal CM login', () => {
  it('blocks a known unsafe production attachment before any factory or session retirement', () => {
    const f = fixture({ connect: false, paused: true })
    const before = f.service.state()
    expect(before.localConnectionAvailable).toBe(false)
    expect(() => f.service.connectLocal(f.action())).toThrow(expect.objectContaining({ code: 'GAME_STATUS_LOCAL_CONNECTION_PAUSED' }))
    expect(f.createLocal).not.toHaveBeenCalled(); expect(f.local.loginCalls).toEqual([])
    expect(f.local.logoutCalls).toBe(0); expect(f.writer.stops).toBe(0)
    expect(f.service.state()).toMatchObject({ sessionId: before.sessionId, connected: false, localConnectionAvailable: false })
    expect(f.writer.calls).toEqual([]); assertNoCM(f)
  })
  it('uses only the bound local factory and an empty local logon action', () => {
    const f = fixture()
    expect(f.createLocal).toHaveBeenCalledExactlyOnceWith(ACCOUNT.steamId)
    expect(f.local.loginCalls).toEqual([{}])
    expect(f.service.state()).toMatchObject({ connectionKind: 'local', connected: true, status: 'logged_on', steamId: ACCOUNT.steamId, blockingAppId: APP })
    expect(f.local.personaCalls).toEqual([]); expect(f.local.playedCalls).toEqual([])
    assertNoCM(f); safe(f.changes)
  })

  it('rejects a mismatched native identity instead of falling back to account credentials', () => {
    const f = fixture({ identity: OTHER.steamId })
    expect(f.service.state()).toMatchObject({ connectionKind: 'local', connected: false, status: 'error', failure: { code: 'GAME_STATUS_IDENTITY_MISMATCH' } })
    expect(f.local.logoutCalls).toBeGreaterThan(0)
    assertNoCM(f)
  })

  it('reports an unavailable local factory without calling the personal CM factory or nonce getter', () => {
    const f = fixture({ connect: false })
    f.createLocal.mockImplementationOnce(() => { throw new Error(PRIVATE) })
    const state = f.service.connectLocal(f.action())
    expect(state).toMatchObject({ connected: false, status: 'error', failure: { code: 'GAME_STATUS_NATIVE_UNAVAILABLE', submitted: 'no' } })
    assertNoCM(f); safe([state, f.changes])
  })

  it('validates the selected account before opening a native connection', () => {
    const f = fixture({ connect: false })
    expect(() => f.service.connectLocal({ ...f.action(), accountId: OTHER.id })).toThrow()
    expect(f.createLocal).not.toHaveBeenCalled(); assertNoCM(f)
  })

  it('rejects an obsolete UI session before opening a native connection', () => {
    const f = fixture({ connect: false })
    expect(() => f.service.connectLocal({ ...f.action(), sessionId: 'retired-session' })).toThrow()
    expect(f.createLocal).not.toHaveBeenCalled(); assertNoCM(f)
  })

  it('does not re-login when refreshing state or reading an already connected game', async () => {
    const f = fixture()
    f.service.state(); await observe(f); await observe(f)
    expect(f.createLocal).toHaveBeenCalledTimes(1); expect(f.local.loginCalls).toEqual([{}])
    assertNoCM(f)
  })
})

describe('native cache provenance and template boundaries', () => {
  it('exposes editable desc without any published template and excludes private fields', async () => {
    const f = fixture(); const live = await observe(f)
    expect(live.fields).toMatchObject({ desc: TEMPLE, steam_display: TEMPLE })
    expect(live.editableKeys).toContain('desc'); expect(live.readOnlyKeys).toContain('steam_display')
    expect(live.fields).not.toHaveProperty('connect'); expect(live.fields).not.toHaveProperty('unknown_private')
    expect(f.local.localization).toHaveBeenCalled(); safe([live, f.changes])
  })

  it('marks local reads as cached and explicitly marks the display text as not a raw token', async () => {
    const f = fixture(); const state = await f.service.observeLive(f.action())
    expect(state.live).toMatchObject({ verificationSource: 'local-cache', displayTokenReadable: false, localizedString: TEMPLE })
    expect(state.live?.fields.steam_display).toBe(TEMPLE)
    expect(state.live?.fields.steam_display).not.toBe('#Status_Game')
    expect(state.lastOperation).toMatchObject({ kind: 'observe', outcome: 'observed', verificationSource: 'local-cache' })
    assertNoCM(f)
  })

  it('rejects template submission before another metadata request or native write when no raw token is available', async () => {
    const f = fixture(); const live = await observe(f)
    const lookups = f.local.localization.mock.calls.length
    await expect(f.service.setLiveDisplay({ ...f.action(), snapshotId: live.snapshotId, lock: true, presence: { displayToken: '#Status_Game', values: { desc: EDITED } } })).rejects.toMatchObject({ code: 'GAME_STATUS_LOCAL_TEMPLATE_UNAVAILABLE' })
    expect(f.local.localization).toHaveBeenCalledTimes(lookups)
    expect(f.writer.calls).toEqual([]); expect(f.local.cmWrites).toEqual([])
    expect(f.service.state().live?.patchActive).toBe(false)
  })

  it('locks a published template when all fields can be read through the native interface', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.local.displayTokenReadable = true; f.local.rp.steam_display = '#Description'
    f.local.localization.mockResolvedValue({ tokens: { '#Description': '%desc%' } })
    const live = await observe(f)
    const state = await f.service.setLiveDisplay({ ...f.action(), snapshotId: live.snapshotId, lock: true, presence: { displayToken: '#Description', values: { desc: EDITED } } })
    expect(f.writer.calls.map(call => call.changes)).toEqual([{ steam_display: '#Description', desc: EDITED }])
    expect(state.liveLock).toMatchObject({ status: 'locked', matched: true, desired: { steam_display: '#Description', desc: EDITED } })
    expect(state.liveLock?.nextCheckAt).not.toBeNull()
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(f.writer.calls).toHaveLength(1)
    assertNoCM(f)
  })

  it('rejects an unreadable native template lock before any write, recovery record, readback or timer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.local.displayTokenReadable = true; f.local.rp.steam_display = '#Minutes'
    f.local.localization.mockResolvedValue({ tokens: { '#Minutes': '%minutes% minutes' } })
    const live = await observe(f); const reads = f.local.reads; const timers = vi.getTimerCount()
    await expect(f.service.setLiveDisplay({ ...f.action(), snapshotId: live.snapshotId, lock: true, presence: { displayToken: '#Minutes', values: { minutes: '5' } } })).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_LOCK_UNREADABLE' })
    expect(f.service.state()).toMatchObject({ liveLock: null, live: { patchActive: false }, failure: { code: 'GAME_STATUS_NATIVE_LOCK_UNREADABLE', stage: 'app_info', submitted: 'no' } })
    expect(f.local.reads).toBe(reads); expect(f.writer.calls).toEqual([]); expect(vi.getTimerCount()).toBe(timers)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 3)
    expect(f.local.reads).toBe(reads); expect(f.writer.calls).toEqual([])
    assertNoCM(f)
  })

  it.each([false, true])('allows a single published-field attempt but never claims unreadable native fields are verified (unexpected echo: %s)', async unexpectedEcho => {
    vi.useFakeTimers()
    const f = fixture()
    f.local.displayTokenReadable = true; f.local.rp.steam_display = '#Minutes'
    f.local.localization.mockResolvedValue({ tokens: { '#Minutes': '%minutes% minutes' } })
    if (!unexpectedEcho) f.local.onRead = async () => ({ users: { [ACCOUNT.steamId]: { richPresence: { desc: f.local.rp.desc!, steam_display: f.local.rp.steam_display! }, localizedString: f.local.rp.desc, displayTokenReadable: true } } })
    const live = await observe(f)
    const state = await f.service.setLiveDisplay({ ...f.action(), snapshotId: live.snapshotId, lock: false, presence: { displayToken: '#Minutes', values: { minutes: '5' } } })
    expect(f.writer.calls.map(call => call.changes)).toEqual([{ steam_display: '#Minutes', minutes: '5' }])
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'unverified', verificationSource: 'local-cache' })
    expect(state.liveLock).toBeNull(); expect(state.live?.patchActive).toBe(true)
    expect(f.local.reads).toBe(3)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 3)
    expect(f.local.reads).toBe(3); expect(f.writer.calls).toHaveLength(1)
    assertNoCM(f)
  })

  it.each(['steam_display', 'connect', 'unknown_private', 'unobserved'])('rejects direct editing of %s without submitting', async key => {
    const f = fixture(); const live = await observe(f)
    await expect(f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { [key]: 'Not permitted' } })).rejects.toThrow()
    expect(f.writer.calls).toEqual([]); assertNoCM(f)
  })

  it('passes only desc and the bound native context, never the localized display or private merged map', async () => {
    const f = fixture(); const live = await observe(f)
    const state = await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    expect(f.writer.calls).toHaveLength(1)
    expect(f.writer.calls[0]?.context).toEqual({ appId: APP, steamId: ACCOUNT.steamId })
    expect(f.writer.calls[0]?.changes).toEqual({ desc: EDITED })
    expect(f.writer.calls[0]?.canSubmit()).toBe(true)
    expect(f.local.rp).toMatchObject({ desc: EDITED, connect: PRIVATE, unknown_private: PRIVATE })
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'matched', verificationSource: 'local-cache' })
    expect(state.lastOperation?.message).toContain('尚未独立确认')
    expect(state.live?.verificationSource).toBe('local-cache')
    safe([state, f.changes, f.writer.calls]); assertNoCM(f)
  })

  it('keeps restore narrow and marks its matched result as local-cache rather than server verification', async () => {
    const f = fixture(); const live = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls.map(call => call.changes)).toEqual([{ desc: EDITED }, { desc: TEMPLE }])
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched', verificationSource: 'local-cache' })
    expect(state.live).toMatchObject({ verificationSource: 'local-cache', displayTokenReadable: false, patchActive: false })
    expect(f.local.rp.desc).toBe(TEMPLE); assertNoCM(f)
  })

  it('does not treat native acceptance alone as a cache match or erase a failed readback ledger', async () => {
    const f = fixture(); const live = await observe(f)
    f.local.onRead = async () => { if (f.writer.calls.length) throw new Error(PRIVATE); return f.local.response() }
    const state = await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'unverified', verificationSource: 'local-cache' })
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'readback', submitted: 'yes' })
    expect(state.live?.patchActive).toBe(true)
    safe([state, f.changes]); assertNoCM(f)
  })
})

describe('local locks reuse their connection and preserve guarded recovery', () => {
  it('does not start a restore apply when detector suspension arrives before its pre-read resolves', async () => {
    vi.useFakeTimers()
    const f = fixture(); const live = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    await f.service.unlockLive({ ...f.action(), restore: false })
    const before = f.writer.calls.length
    f.local.onRead = async () => { const response = f.local.response(); f.local.emit('nativeContextUnavailable'); return response }
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.writer.calls.slice(before)).toEqual([])
    expect(f.service.state()).toMatchObject({ live: { patchActive: true }, liveLock: { status: 'stopped', nextCheckAt: null }, failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' } })
    expect(f.local.rp.desc).toBe(EDITED); expect(f.local.revalidate).not.toHaveBeenCalled()
    f.local.onRead = null
    const reads = f.local.reads
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.local.reads).toBe(reads); expect(f.writer.calls.slice(before)).toEqual([])
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.writer.calls.slice(before)).toEqual([]); expect(f.local.revalidate).not.toHaveBeenCalled()
    await observe(f)
    expect(f.local.revalidate).toHaveBeenCalledOnce(); expect(f.service.state().live?.patchActive).toBe(true)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.writer.calls.slice(before)).toEqual([]); expect(f.service.state().liveLock?.status).toBe('stopped')
    const restored = await f.service.restoreLive(f.action())
    expect(f.writer.calls.slice(before).map(call => call.changes)).toEqual([{ desc: TEMPLE }])
    expect(restored.live?.patchActive).toBe(false); assertNoCM(f)
  })

  it('cancels a restore pre-read invalidated by helper-context loss even without detector suspension', async () => {
    const f = fixture(); const live = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const before = f.writer.calls.length
    f.local.onRead = async () => { const response = f.local.response(); f.service.invalidateLiveContext(); return response }
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.writer.calls.slice(before)).toEqual([])
    expect(f.service.state()).toMatchObject({ live: { patchActive: true }, failure: { code: 'GAME_STATUS_NATIVE_CONTEXT' } })
    expect(f.local.rp.desc).toBe(EDITED); assertNoCM(f)
  })

  it('retains an unknown restore ledger when suspension interrupts an already attempted native restore', async () => {
    const f = fixture(); const live = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    f.writer.onApply = async call => { f.writer.assign(call.changes); f.local.emit('nativeContextUnavailable'); if (!call.canSubmit()) throw new Error('Synthetic restore cancellation') }
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.service.state()).toMatchObject({ live: { patchActive: true }, failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', submitted: 'unknown' } })
    expect(f.local.rp.desc).toBe(TEMPLE)
    const before = f.writer.calls.length
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.writer.calls).toHaveLength(before)
    f.writer.onApply = null; await observe(f)
    expect(f.service.state().live?.patchActive).toBe(true)
    const restored = await f.service.restoreLive(f.action())
    expect(f.writer.calls).toHaveLength(before); expect(restored.live?.patchActive).toBe(false)
    safe([restored, f.changes]); assertNoCM(f)
  })

  it('pauses detector uncertainty without clearing recovery or automatically revalidating a lock', async () => {
    vi.useFakeTimers()
    const f = fixture(); const live = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    f.local.emit('nativeContextUnavailable')
    expect(f.service.state()).toMatchObject({ connected: true, status: 'logged_on', failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', stage: 'context' }, live: { patchActive: true }, liveLock: { status: 'stopped', nextCheckAt: null } })
    expect(f.writer.calls[0]!.canSubmit()).toBe(false)
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.writer.calls).toHaveLength(1); expect(f.local.revalidate).not.toHaveBeenCalled()
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.local.revalidate).not.toHaveBeenCalled(); expect(f.service.state().live?.patchActive).toBe(true)
    const reads = f.local.reads
    f.local.revalidate.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.service.observeLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.local.reads).toBe(reads); expect(f.service.state().live?.patchActive).toBe(true)
    const refreshed = await observe(f)
    expect(f.local.revalidate).toHaveBeenCalledTimes(2)
    expect(refreshed.patchActive).toBe(true); expect(refreshed.snapshotId).not.toBe(live.snapshotId)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.writer.calls).toHaveLength(1); expect(f.service.state().liveLock?.status).toBe('stopped')
    const restored = await f.service.restoreLive(f.action())
    expect(restored.live?.patchActive).toBe(false); expect(f.writer.calls[1]!.changes).toEqual({ desc: TEMPLE })
    safe([f.service.state(), f.changes]); assertNoCM(f)
  })

  it('retains an uncertain partial write when detector failure interrupts a native submission', async () => {
    const f = fixture(); const live = await observe(f)
    f.writer.onApply = async call => { f.writer.assign({ desc: call.changes.desc! }); f.local.emit('nativeContextUnavailable'); if (!call.canSubmit()) throw new Error('Synthetic cancellation') }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED, status: 'Never submitted' } })).rejects.toThrow()
    expect(f.service.state()).toMatchObject({ connected: true, live: { patchActive: true }, failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' } })
    expect(f.local.rp).toMatchObject({ desc: EDITED, status: 'Original status' })
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.writer.calls).toHaveLength(1)
    f.writer.onApply = null; await observe(f)
    const restored = await f.service.restoreLive(f.action())
    expect(restored.live?.patchActive).toBe(false); expect(f.writer.calls[1]!.changes).toEqual({ desc: TEMPLE })
    assertNoCM(f)
  })

  it('maintains desc every five seconds without new logins, metadata login, or CM uploads', async () => {
    vi.useFakeTimers()
    const f = fixture(); const live = await observe(f)
    const state = await f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    expect(state.lastOperation).toMatchObject({ kind: 'lock', outcome: 'matched', verificationSource: 'local-cache' })
    f.local.rp.desc = 'New game-owned scene'
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS - 1)
    expect(f.writer.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.writer.calls).toHaveLength(2); expect(f.writer.calls[1]?.changes).toEqual({ desc: EDITED })
    expect(f.local.rp.desc).toBe(EDITED)
    expect(f.service.state().lastOperation).toMatchObject({ kind: 'lock', outcome: 'matched', verificationSource: 'local-cache' })
    expect(f.createLocal).toHaveBeenCalledTimes(1); expect(f.local.loginCalls).toEqual([{}])
    assertNoCM(f)
  })

  it('performs matched lock checks as reads, not redundant writes or repeated sign-ins', async () => {
    vi.useFakeTimers()
    const f = fixture(); const live = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const reads = f.local.reads
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS * 4)
    expect(f.local.reads).toBe(reads + 4); expect(f.writer.calls).toHaveLength(1)
    expect(f.service.state().liveLock).toMatchObject({ status: 'locked', matched: true })
    expect(f.service.state().live?.verificationSource).toBe('local-cache')
    expect(f.local.loginCalls).toHaveLength(1); assertNoCM(f)
  })

  it('unlocks and safely restores only desc, without trying to restore localized text as a raw token', async () => {
    const f = fixture(); const live = await observe(f)
    await f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const state = await f.service.unlockLive({ ...f.action(), restore: true })
    expect(f.writer.calls[1]?.changes).toEqual({ desc: TEMPLE })
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched', verificationSource: 'local-cache' })
    expect(state.liveLock?.status).toBe('stopped'); expect(state.live?.patchActive).toBe(false)
    assertNoCM(f)
  })

  it('does not overwrite a game-owned third value during restore', async () => {
    const f = fixture(); const live = await observe(f)
    await f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    f.local.rp.desc = 'Independent game update'
    const state = await f.service.restoreLive(f.action())
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'conflict', verificationSource: 'local-cache' })
    expect(f.writer.calls).toHaveLength(1); expect(f.local.rp.desc).toBe('Independent game update')
  })

  it('retains a partial-write ledger and restores only the keys that were actually changed', async () => {
    const f = fixture(); const live = await observe(f)
    f.writer.onApply = async call => { expect(f.service.state().live?.patchActive).toBe(true); f.writer.assign({ desc: call.changes.desc! }); throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED, status: 'Not accepted' } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    expect(f.service.state().live?.patchActive).toBe(true)
    const reread = await observe(f)
    expect(reread.patchActive).toBe(true)
    await expect(f.service.patchLive({ ...f.action(), snapshotId: reread.snapshotId, changes: { desc: 'Do not overlap' } })).rejects.toThrow()
    f.writer.onApply = null
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls[1]?.changes).toEqual({ desc: TEMPLE })
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched', verificationSource: 'local-cache' })
    expect(state.live?.patchActive).toBe(false)
    safe([state, f.changes]); assertNoCM(f)
  })

  it('clears the ledger only when a typed refusal proves nothing could have been written', async () => {
    const f = fixture(); const live = await observe(f)
    f.writer.onApply = async () => { throw Object.assign(new Error(PRIVATE), { code: 'GAME_STATUS_NATIVE_IDENTITY', mayHaveWritten: false }) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_IDENTITY' })
    expect(f.service.state().failure).toMatchObject({ submitted: 'no' })
    expect(f.service.state().live?.patchActive).toBe(false); expect(f.local.rp.desc).toBe(TEMPLE)
  })

  it('retains uncertainty for an unknown pre-write failure until a read proves original values remain', async () => {
    const f = fixture(); const live = await observe(f)
    f.writer.onApply = async () => { throw new Error(PRIVATE) }
    await expect(f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })).rejects.toMatchObject({ code: 'GAME_STATUS_UPLOAD_FAILED' })
    expect(f.service.state().failure?.submitted).toBe('unknown'); expect(f.service.state().live?.patchActive).toBe(true)
    f.writer.onApply = null
    const state = await f.service.restoreLive(f.action())
    expect(f.writer.calls).toHaveLength(1)
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched', verificationSource: 'local-cache' })
    expect(state.live?.patchActive).toBe(false)
  })

  it.each(['account', 'game', 'dispose'] as const)('invalidates an in-flight local write guard after %s changes', async kind => {
    const f = fixture(); const live = await observe(f); const gate = deferred()
    f.writer.onApply = async call => { await gate.promise; if (!call.canSubmit()) throw new Error('Cancelled'); f.writer.assign(call.changes) }
    const pending = f.service.patchLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const settled = pending.then(() => false, () => true)
    await flush(); expect(f.writer.calls).toHaveLength(1)
    if (kind === 'account') { f.select(OTHER); f.service.invalidate() }
    else if (kind === 'game') f.local.emit('playingState', true, 730)
    else f.service.dispose()
    expect(f.writer.calls[0]?.canSubmit()).toBe(false)
    gate.resolve(); expect(await settled).toBe(true)
    expect(f.local.rp.desc).toBe(TEMPLE); expect(f.service.state().live).toBeNull()
    assertNoCM(f)
  })

  it('cancels a pending initial lock when unlocked and never installs a late controller', async () => {
    const f = fixture(); const live = await observe(f); const gate = deferred()
    f.writer.onApply = async call => { await gate.promise; if (!call.canSubmit()) throw new Error('Cancelled'); f.writer.assign(call.changes) }
    const pending = f.service.lockLive({ ...f.action(), snapshotId: live.snapshotId, changes: { desc: EDITED } })
    const settled = pending.then(() => false, () => true)
    await flush(); await f.service.unlockLive({ ...f.action(), restore: false })
    expect(f.writer.calls[0]?.canSubmit()).toBe(false)
    gate.resolve(); expect(await settled).toBe(true)
    expect(f.service.state().liveLock == null || f.service.state().liveLock?.status === 'stopped').toBe(true)
    expect(f.local.rp.desc).toBe(TEMPLE); assertNoCM(f)
  })
})

describe('CM simulation is explicit and cannot act as a production live-game fallback', () => {
  it('still allows an explicitly requested CM simulation session', async () => {
    const f = fixture({ connect: false })
    const connected = await f.service.connectWithToolbox(f.action())
    expect(connected).toMatchObject({ connectionKind: 'cm', status: 'logged_on', connected: true })
    expect(f.nonce).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id); expect(f.createCM).toHaveBeenCalledTimes(1)
    expect(f.createLocal).not.toHaveBeenCalled()
    f.cm.emit('playingState', false, 0)
    const state = await f.service.play({ ...f.action(), displayKind: 'custom', gameName: 'Synthetic non-Steam title', details: '' })
    expect(state.playing?.displayName).toBe('Synthetic non-Steam title')
    expect(f.cm.playedCalls).toContain('Synthetic non-Steam title')
  })

  it.each(['observe', 'patch', 'lock', 'display', 'restore'] as const)('rejects %s on a personal CM session when production has a local factory', async kind => {
    const f = fixture({ connect: false }); await f.service.connectWithToolbox(f.action())
    f.cm.emit('playingState', true, APP)
    const action = f.action()
    const pending = kind === 'observe' ? f.service.observeLive(action)
      : kind === 'patch' ? f.service.patchLive({ ...action, snapshotId: 'not-local', changes: { desc: EDITED } })
        : kind === 'lock' ? f.service.lockLive({ ...action, snapshotId: 'not-local', changes: { desc: EDITED } })
          : kind === 'display' ? f.service.setLiveDisplay({ ...action, snapshotId: 'not-local', lock: true, presence: { displayToken: '#Status_Game', values: { desc: EDITED } } })
            : f.service.restoreLive(action)
    await expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_LOCAL_CONNECTION_REQUIRED' })
    expect(f.cm.reads).toBe(0); expect(f.cm.cmWrites).toEqual([]); expect(f.writer.calls).toEqual([])
    expect(f.createLocal).not.toHaveBeenCalled()
  })

  it('retains the legacy non-production CM test path when no local factory is configured', async () => {
    const f = fixture({ connect: false, localFactory: false }); await f.service.connectWithToolbox(f.action())
    f.cm.emit('playingState', true, APP)
    const state = await f.service.observeLive(f.action())
    expect(state.live?.verificationSource).toBe('server')
    expect(state.lastOperation).toMatchObject({ kind: 'observe', outcome: 'observed', verificationSource: 'server' })
    expect(f.cm.reads).toBe(1)
  })
})
