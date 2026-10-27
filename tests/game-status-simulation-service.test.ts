import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, GAME_STATUS_CM_RETIRE_TIMEOUT_MS, type GameStatusServiceOptions, type GameStatusSteamClient } from '../src/main/game-status-service'

const ACCOUNT = { id: 'simulation-fixture', steamId: '76561198000000001' }
const OTHER = { id: 'other-fixture', steamId: '76561198000000002' }
const SECRET = 'fixture-only-nonce-do-not-log'
const CUSTOM = { displayKind: 'custom' as const, gameName: 'Fixture custom', details: 'One' }
const idle = () => Promise.resolve({ steamId: ACCOUNT.steamId, appId: 0 })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

class Client extends EventEmitter implements GameStatusSteamClient {
  constructor(readonly presenceSource: 'server' | 'local-cache' = 'server') { super() }
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: false, appid: 0 }
  calls: Array<{ method: string; value?: unknown; appId?: number; force?: boolean }> = []
  deferDisconnect = false
  throwLogoff = false
  onMutation: ((method: string) => void) | null = null
  raw: Record<string, string> = { status: 'Initial', steam_display: '#Fixture' }
  logOn(value: Record<string, unknown>): void { this.calls.push({ method: 'logOn', value }) }
  logOff(): void {
    this.calls.push({ method: 'logOff' })
    if (this.throwLogoff) throw new Error(SECRET)
    this.steamID = null
    if (!this.deferDisconnect) this.emit('disconnected')
  }
  login(): void { this.steamID = { getSteamID64: () => ACCOUNT.steamId }; this.emit('loggedOn', {}) }
  playing(blocked = false, appId = 0): void { this.playingState = { blocked, appid: appId }; this.emit('playingState', blocked, appId) }
  setPersona(value: number): void { this.calls.push({ method: 'persona', value }); this.onMutation?.('persona') }
  gamesPlayed(value: string | number[], force?: boolean): void { this.calls.push({ method: 'games', value, force }); this.onMutation?.('games') }
  uploadRichPresence(appId: number, value: Record<string, string>): void { this.calls.push({ method: 'upload', appId, value: structuredClone(value) }); this.raw = structuredClone(value); this.onMutation?.('upload') }
  async requestRichPresence(_appId: number, steamIds: string[]) { return { users: { [steamIds[0]!]: { richPresence: structuredClone(this.raw), localizedString: 'Fixture' } } } }
  async getProductInfo(apps: number[]) { return { apps: Object.fromEntries(apps.map(app => [app, { appinfo: { common: { name: `Fixture ${app}` } } }])) } }
  async getAppRichPresenceLocalization() { return { tokens: { '#Fixture': '%status%' } } }
}

const owned: Array<ReturnType<typeof fixture>> = []
function fixture(extra: Partial<GameStatusServiceOptions> = {}) {
  let selected: typeof ACCOUNT | null = ACCOUNT
  const clients: Client[] = []; const locals: Client[] = []
  const login = vi.fn(async () => ({ steamId: ACCOUNT.steamId, accountName: 'fixture-account', webLogonToken: SECRET }))
  const diagnostic = vi.fn()
  const localFactory = vi.fn(() => { const client = new Client('local-cache'); locals.push(client); return client })
  const service = new GameStatusService({ getActiveAccount: () => selected, getToolboxLogin: login, onDiagnostic: diagnostic,
    createClient: () => { const client = new Client(); clients.push(client); return client }, createLocalClient: localFactory, ...extra })
  const action = () => ({ accountId: selected!.id, sessionId: service.state().sessionId })
  const connect = async () => { await service.connectWithToolbox(action()); const client = clients.at(-1)!; client.login(); await flush(); return client }
  return { service, action, clients, locals, login, diagnostic, localFactory, connect, select(account: typeof selected) { selected = account } }
}
function setup(extra: Partial<GameStatusServiceOptions> = {}) { const value = fixture(extra); owned.push(value); return value }
const mutations = (client: Client) => client.calls.filter(call => ['persona', 'games', 'upload'].includes(call.method))
afterEach(() => { for (const f of owned.splice(0)) { f.service.dispose(); for (const client of f.clients) client.emit('disconnected') }; vi.useRealTimers() })

describe('CM simulation connection ownership', () => {
  it('reuses the authenticated same-account CM without another nonce, logoff or identity rotation', async () => {
    const f = setup(); const client = await f.connect(); const before = f.service.state()
    await f.service.connectWithToolbox(f.action())
    expect(f.service.state().sessionId).toBe(before.sessionId); expect(f.login).toHaveBeenCalledTimes(1)
    expect(f.clients).toHaveLength(1); expect(client.calls.filter(call => call.method === 'logOff')).toHaveLength(0)
    expect(f.diagnostic.mock.calls.at(-1)![0].stage).toBe('connect-reused')
    await expect(f.service.connectWithToolbox({ ...f.action(), accountId: OTHER.id })).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
  })
  it('rejects repeat preparation and connecting requests without replacing the original operation', async () => {
    const pending = deferred<{ steamId: string; accountName: string; webLogonToken: string }>()
    const getter = vi.fn(() => pending.promise); const f = setup({ getToolboxLogin: getter })
    const connecting = f.service.connectWithToolbox(f.action()); await flush()
    await expect(f.service.connectWithToolbox(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_BUSY' })
    expect(getter).toHaveBeenCalledTimes(1)
    pending.resolve({ steamId: ACCOUNT.steamId, accountName: 'fixture', webLogonToken: SECRET }); await connecting
    await expect(f.service.connectWithToolbox(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_BUSY' })
    expect(f.clients).toHaveLength(1)
  })
  it('waits for native shutdown before asking for a CM capability', async () => {
    const stopped = deferred<void>(); const shutdown = vi.fn(() => stopped.promise)
    const f = setup({ nativeWriter: { stop() {}, async apply() {}, shutdown } })
    const connecting = f.service.connectWithToolbox(f.action()); await flush()
    expect(shutdown).toHaveBeenCalledTimes(1); expect(f.login).not.toHaveBeenCalled(); expect(f.clients).toHaveLength(0)
    stopped.resolve(); await connecting; expect(f.login).toHaveBeenCalledTimes(1)
  })
  it('fails closed before nonce acquisition when native cleanup fails', async () => {
    const f = setup({ nativeWriter: { stop() {}, async apply() {}, async shutdown() { throw new Error(SECRET) } } })
    const state = await f.service.connectWithToolbox(f.action())
    expect(state.failure?.code).toBe('GAME_STATUS_CM_RETIRE_FAILED'); expect(f.login).not.toHaveBeenCalled(); expect(JSON.stringify(state)).not.toContain(SECRET)
  })
  it('defers local construction until authenticated CM disconnect is confirmed', async () => {
    const f = setup(); const client = await f.connect(); client.deferDisconnect = true
    expect(f.service.connectLocal(f.action())).toMatchObject({ connectionKind: 'local', status: 'connecting', busy: true })
    expect(f.localFactory).not.toHaveBeenCalled(); expect(client.calls.at(-1)?.method).toBe('logOff')
    client.emit('disconnected'); await flush(); expect(f.localFactory).toHaveBeenCalledTimes(1); expect(f.locals[0]!.calls[0]?.method).toBe('logOn')
  })
  it('does not construct native after an account switch while CM retirement is pending', async () => {
    const f = setup(); const client = await f.connect(); client.deferDisconnect = true; f.service.connectLocal(f.action())
    f.select(OTHER); client.emit('disconnected'); await flush(); expect(f.localFactory).not.toHaveBeenCalled()
  })
  it('blocks a new CM until an old explicitly logged-out CM confirms its disconnect', async () => {
    const f = setup(); const client = await f.connect(); client.deferDisconnect = true; f.service.logout(f.action())
    const connecting = f.service.connectWithToolbox(f.action()); await flush(); expect(f.login).toHaveBeenCalledTimes(1)
    client.emit('disconnected'); await connecting; expect(f.login).toHaveBeenCalledTimes(2); expect(f.clients).toHaveLength(2)
  })
  it('does not wait for a second disconnected event when the active CM already disconnected', async () => {
    const f = setup(); const client = await f.connect(); client.deferDisconnect = true
    client.emit('disconnected'); expect(f.service.state().status).toBe('disconnected')
    await f.service.connectWithToolbox(f.action()); expect(f.login).toHaveBeenCalledTimes(2); expect(f.clients).toHaveLength(2)
  })
  it.each(['timeout', 'throw'] as const)('fails closed on CM retirement %s, but accepts a later confirmed disconnect', async mode => {
    vi.useFakeTimers(); const f = setup(); const client = await f.connect(); client.deferDisconnect = true; client.throwLogoff = mode === 'throw'
    f.service.connectLocal(f.action()); await vi.advanceTimersByTimeAsync(GAME_STATUS_CM_RETIRE_TIMEOUT_MS)
    expect(f.service.state().failure?.code).toBe('GAME_STATUS_CM_RETIRE_FAILED'); expect(f.localFactory).not.toHaveBeenCalled()
    await f.service.connectWithToolbox(f.action()); expect(f.login).toHaveBeenCalledTimes(1)
    client.emit('disconnected'); client.throwLogoff = false
    await f.service.connectWithToolbox(f.action()); expect(f.login).toHaveBeenCalledTimes(2)
  })
  it('shutdown waits for both native cleanup and authenticated CM retirement', async () => {
    const native = deferred<void>(); const f = setup({ nativeWriter: { stop() {}, async apply() {}, shutdown: () => native.promise } })
    native.resolve(); const client = await f.connect(); client.deferDisconnect = true
    let done = false; const closing = f.service.shutdown().then(() => { done = true }); await flush(); expect(done).toBe(false)
    client.emit('disconnected'); await closing; expect(done).toBe(true); expect(f.service.state().status).toBe('logged_out')
  })
})

describe('simulation permission and differential submission', () => {
  it('does not treat SDK default false as a server confirmation', async () => {
    const f = setup(); const client = await f.connect()
    expect(f.service.state()).toMatchObject({ playingStateConfirmed: false, simulationReady: false })
    expect(() => f.service.play({ ...f.action(), ...CUSTOM })).toThrowError(expect.objectContaining({ code: 'GAME_STATUS_PLAYING_STATE_UNCONFIRMED' }))
    expect(mutations(client)).toEqual([]); client.playing()
    expect(f.service.state()).toMatchObject({ playingStateConfirmed: true, simulationReady: true })
    f.service.play({ ...f.action(), ...CUSTOM }); expect(mutations(client)).toHaveLength(2)
  })
  it('allows checked local idle without pretending to have received a server event', async () => {
    const check = vi.fn(idle); const f = setup({ checkSimulationContext: check }); const client = await f.connect()
    expect(check).toHaveBeenCalledTimes(3); expect(f.service.state()).toMatchObject({ playingStateConfirmed: false, simulationReady: true })
    const state = await f.service.play({ ...f.action(), ...CUSTOM }); expect(state.busy).toBe(false); expect(state).toEqual(f.service.state())
    await f.service.play({ ...f.action(), ...CUSTOM })
    expect(check).toHaveBeenCalledTimes(5); expect(mutations(client)).toHaveLength(2)
    expect(f.diagnostic.mock.calls.at(-1)![0].stage).toBe('simulation-noop')
  })
  it.each([{ appId: 730 }, { appId: 0, gameActive: true }, { appId: 0, gameId: '15190414816125648896' }])('rejects active local context before fetching a nonce: %j', async context => {
    const f = setup({ checkSimulationContext: async () => ({ steamId: ACCOUNT.steamId, ...context }) })
    expect((await f.service.connectWithToolbox(f.action())).failure?.code).toBe('GAME_STATUS_SIMULATION_GAME_ACTIVE')
    expect(f.login).not.toHaveBeenCalled(); expect(f.clients).toHaveLength(0)
  })
  it('rejects wrong identity or failed local evidence without leaking the provider error', async () => {
    for (const check of [async () => ({ steamId: OTHER.steamId, appId: 0 }), async () => { throw new Error(SECRET) }]) {
      const f = setup({ checkSimulationContext: check }); const state = await f.service.connectWithToolbox(f.action())
      expect(state.failure?.code).toBe('GAME_STATUS_SIMULATION_CONTEXT_UNAVAILABLE'); expect(JSON.stringify(state)).not.toContain(SECRET); expect(f.login).not.toHaveBeenCalled()
    }
  })
  it('rechecks local context after authentication and retires CM if a real game appeared', async () => {
    let active = false; const f = setup({ checkSimulationContext: async () => ({ steamId: ACCOUNT.steamId, appId: active ? 730 : 0 }) })
    await f.service.connectWithToolbox(f.action()); active = true; const client = f.clients[0]!; client.login(); await flush()
    expect(f.service.state().failure?.code).toBe('GAME_STATUS_SIMULATION_GAME_ACTIVE'); expect(mutations(client)).toEqual([]); expect(client.calls.at(-1)?.method).toBe('logOff')
  })
  it('rechecks readiness after server unblock and reuses a session to recover a failed local check', async () => {
    let failing = false; const check = vi.fn(async () => { if (failing) throw new Error(SECRET); return idle() })
    const f = setup({ checkSimulationContext: check }); const client = await f.connect(); client.playing(true, 730)
    failing = true; client.playing(false, 0); await flush(); expect(f.service.state().simulationReady).toBe(false)
    expect(f.service.state().connected).toBe(true); expect(f.login).toHaveBeenCalledTimes(1)
    failing = false; await f.service.connectWithToolbox(f.action())
    expect(f.service.state().simulationReady).toBe(true); expect(f.login).toHaveBeenCalledTimes(1); expect(mutations(client)).toEqual([])
  })
  it('rechecks even identical payloads and does not override server blocked=true with idle OS evidence', async () => {
    let appId = 0; const f = setup({ checkSimulationContext: async () => ({ steamId: ACCOUNT.steamId, appId }) }); const client = await f.connect()
    await f.service.play({ ...f.action(), ...CUSTOM }); const count = mutations(client).length; appId = 730
    await expect(f.service.play({ ...f.action(), ...CUSTOM })).rejects.toMatchObject({ code: 'GAME_STATUS_SIMULATION_GAME_ACTIVE' })
    expect(mutations(client)).toHaveLength(count); appId = 0; client.playing(true, 730)
    expect(() => f.service.play({ ...f.action(), ...CUSTOM })).toThrowError(expect.objectContaining({ code: 'GAME_STATUS_SIMULATION_GAME_ACTIVE' }))
  })
  it.each(['stop', 'logout', 'account', 'block'] as const)('invalidates a pending local check on %s and submits nothing', async kind => {
    const check = vi.fn(idle); const f = setup({ checkSimulationContext: check }); const client = await f.connect(); const pending = deferred<{ steamId: string; appId: number }>()
    check.mockImplementationOnce(() => pending.promise)
    const playing = f.service.play({ ...f.action(), ...CUSTOM }); const rejected = expect(playing).rejects.toThrow()
    expect(() => f.service.play({ ...f.action(), ...CUSTOM })).toThrowError(expect.objectContaining({ code: 'GAME_STATUS_BUSY' }))
    if (kind === 'stop') f.service.stop(f.action())
    else if (kind === 'logout') f.service.logout(f.action())
    else if (kind === 'account') f.select(OTHER)
    else client.playing(true, 730)
    const stopped = f.service.state()
    pending.resolve({ steamId: ACCOUNT.steamId, appId: 0 }); await rejected; expect(mutations(client)).toEqual([])
    if (kind === 'stop') expect(f.service.state()).toEqual(stopped)
  })
  it('renames custom simulation without an empty game or repeated persona, including after stop', async () => {
    const f = setup(); const client = await f.connect(); client.playing()
    f.service.play({ ...f.action(), ...CUSTOM }); f.service.play({ ...f.action(), ...CUSTOM, gameName: 'Renamed' }); f.service.play({ ...f.action(), ...CUSTOM, gameName: 'Renamed' })
    expect(mutations(client)).toEqual([{ method: 'persona', value: 1 }, { method: 'games', value: 'Fixture custom · One', force: false }, { method: 'games', value: 'Renamed · One', force: false }])
    f.service.stop(f.action()); f.service.play({ ...f.action(), ...CUSTOM }); expect(client.calls.filter(call => call.method === 'persona')).toHaveLength(1)
  })
  it('replaces a same-AppID template with one RP upload, and clears only a departed owned app', async () => {
    const f = setup(); const client = await f.connect(); client.playing(); await f.service.inspectApp({ ...f.action(), appId: 730 })
    const payload = { displayKind: 'app' as const, appId: 730, gameName: '', details: '', presence: { displayToken: '#Fixture', values: { status: 'One' } } }
    f.service.play({ ...f.action(), ...payload }); const before = client.calls.length
    f.service.play({ ...f.action(), ...payload, presence: { displayToken: '#Fixture', values: { status: 'Two' } } })
    expect(client.calls.slice(before)).toEqual([{ method: 'upload', appId: 730, value: { steam_display: '#Fixture', status: 'Two' } }])
    const renamed = client.calls.length; f.service.play({ ...f.action(), ...CUSTOM })
    expect(client.calls.slice(renamed)).toEqual([{ method: 'upload', appId: 730, value: {} }, { method: 'games', value: 'Fixture custom · One', force: false }])
    expect(client.calls.filter(call => call.method === 'games' && Array.isArray(call.value) && call.value.length === 0)).toHaveLength(0)
  })
  it('does not retain a complete canonical payload after a partially failed switch', async () => {
    const f = setup(); const client = await f.connect(); client.playing(); await f.service.inspectApp({ ...f.action(), appId: 730 })
    const app = { displayKind: 'app' as const, appId: 730, gameName: '', details: '', presence: { displayToken: '#Fixture', values: { status: 'Original' } } }
    f.service.play({ ...f.action(), ...app })
    client.onMutation = method => { if (method === 'games') throw new Error(SECRET) }
    expect(() => f.service.play({ ...f.action(), ...CUSTOM })).toThrow('提交模拟游戏状态失败')
    expect(client.raw).toEqual({}); expect(f.service.state().playing).toBeNull(); client.onMutation = null
    const before = client.calls.length; f.service.play({ ...f.action(), ...app })
    expect(client.calls.slice(before)).toContainEqual({ method: 'games', value: [730], force: false })
    expect(client.calls.slice(before)).toContainEqual({ method: 'upload', appId: 730, value: { steam_display: '#Fixture', status: 'Original' } })
  })
  it('honors a synchronously delivered blocked event between mutations', async () => {
    const f = setup(); const client = await f.connect(); client.playing(); client.onMutation = method => { if (method === 'persona') client.playing(true, 730) }
    f.service.play({ ...f.action(), ...CUSTOM }); expect(mutations(client)).toEqual([{ method: 'persona', value: 1 }])
  })
  it('does not revive an old permission check after blocked true then false', async () => {
    const check = vi.fn(idle); const f = setup({ checkSimulationContext: check }); const client = await f.connect()
    const pending = deferred<{ steamId: string; appId: number }>(); check.mockImplementationOnce(() => pending.promise)
    const playing = f.service.play({ ...f.action(), ...CUSTOM }); const rejected = expect(playing).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    client.playing(true, 730); client.playing(false, 0); await flush()
    pending.resolve({ steamId: ACCOUNT.steamId, appId: 0 }); await rejected; expect(mutations(client)).toEqual([])
    expect(f.service.state().busy).toBe(false); expect(f.service.state().simulationReady).toBe(true)
  })
  it.each([false, true])('does not let delayed idle permission overwrite a newer active result (blocked transition %s)', async transition => {
    const check = vi.fn(idle); const f = setup({ checkSimulationContext: check }); const client = await f.connect()
    const old = deferred<{ steamId: string; appId: number }>(); check.mockImplementationOnce(() => old.promise)
    const playing = f.service.play({ ...f.action(), ...CUSTOM }); const rejected = expect(playing).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    check.mockImplementationOnce(async () => ({ steamId: ACCOUNT.steamId, appId: 730 }))
    if (transition) client.playing(true, 730)
    client.playing(false, 0); await flush(); const newer = f.service.state()
    expect(newer.failure?.code).toBe('GAME_STATUS_SIMULATION_GAME_ACTIVE'); expect(newer.simulationReady).toBe(false)
    old.resolve({ steamId: ACCOUNT.steamId, appId: 0 }); await rejected
    expect(f.service.state().failure).toEqual(newer.failure); expect(f.service.state().simulationReady).toBe(false); expect(mutations(client)).toEqual([])
  })
  it('does not continue synchronous mutation steps after a transient blocked event', async () => {
    const f = setup(); const client = await f.connect(); client.playing()
    client.onMutation = method => { if (method === 'persona') { client.playing(true, 730); client.playing(false, 0) } }
    f.service.play({ ...f.action(), ...CUSTOM }); expect(mutations(client)).toEqual([{ method: 'persona', value: 1 }])
  })
  it('does not discard a live patch or lock when simulation connection is requested', async () => {
    const client = new Client('local-cache')
    const f = setup({ createLocalClient: () => client, nativeWriter: { stop() {}, async apply(_context, changes) { for (const [key, value] of Object.entries(changes)) { if (value === null) delete client.raw[key]; else client.raw[key] = value } } } })
    f.service.connectLocal(f.action()); client.login(); client.playing(true, 730)
    const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Edited' } })
    const before = f.service.state(); const logoffs = client.calls.filter(call => call.method === 'logOff').length
    await expect(f.service.connectWithToolbox(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_SIMULATION_SWITCH_REQUIRES_RESTORE' })
    expect(f.service.state().live).toEqual(before.live); expect(client.calls.filter(call => call.method === 'logOff')).toHaveLength(logoffs)
  })
  it('emits only fixed safe diagnostic keys and values', async () => {
    const f = setup(); const client = await f.connect(); client.playing(); f.service.play({ ...f.action(), ...CUSTOM }); f.service.stop(f.action()); f.service.logout(f.action())
    for (const [event] of f.diagnostic.mock.calls) { expect(Object.keys(event).sort()).toEqual(['connectionKind', 'generation', 'stage']); expect(Number.isSafeInteger(event.generation)).toBe(true) }
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(SECRET); expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(ACCOUNT.steamId); expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(CUSTOM.gameName)
  })
})
