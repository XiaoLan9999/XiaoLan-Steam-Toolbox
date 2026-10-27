import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, createGameStatusSteamClient, GAME_STATUS_CLIENT_OPTIONS, GAME_STATUS_APP_INFO_TTL_MS, LIVE_LOCK_INTERVAL_MS, LIVE_LOCK_MAX_FAILURES, LIVE_OBSERVATION_TTL_MS, LIVE_RESTORE_TTL_MS, type GameStatusSteamClient, type GameStatusServiceOptions } from '../src/main/game-status-service'
import type { GameStatusAction, GameStatusDraft, GameStatusSnapshot } from '../src/shared/game-status'

const A = { id: 'selected-A', steamId: '76561198000000001' }
const B = { id: 'selected-B', steamId: '76561198000000002' }
const PASSWORD = 'FAKE-password-never-persist'
const SECRET = 'FAKE-join-secret-never-expose'
type Call = { method: string; app?: number; value?: unknown; force?: boolean }

class FakeClient extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: false, appid: 0 }
  calls: Call[] = []
  rp: Record<string, string> = { status: 'Playing map', steam_display: '#GameMap', 'game:map': 'map_old', 'game:score': '1:2', connect: SECRET, steam_player_group: SECRET, 'game:lobby': SECRET, unknown_token: SECRET }
  acceptWrites = true
  localizedString: string | null = 'Localized fixture state'
  onRead: (() => Promise<Record<string, string>>) | null = null
  logOn(value?: Record<string, unknown>): void { this.calls.push({ method: 'logOn', value: value ? structuredClone(value) : undefined }) }
  logOff(): void { this.calls.push({ method: 'logOff' }); this.steamID = null; this.emit('disconnected') }
  setPersona(value: number): void { this.calls.push({ method: 'setPersona', value }) }
  gamesPlayed(value: string | number[], force?: boolean): void { this.calls.push({ method: 'gamesPlayed', value, force }) }
  uploadRichPresence(app: number, value: Record<string, string>): void { this.calls.push({ method: 'upload', app, value: structuredClone(value) }); if (this.acceptWrites) this.rp = structuredClone(value) }
  async getProductInfo(apps: number[]): Promise<unknown> { return { apps: Object.fromEntries(apps.map(app => [app, { appinfo: { common: { name: `Fixture game ${app}`, icon: 'a'.repeat(40) } } }])) } }
  async getAppRichPresenceLocalization(): Promise<unknown> { return { tokens: { '#Fixture': '%status%', '#FixtureActivity': '%activity%' } } }
  async requestRichPresence(app: number, steamIds: string[]): Promise<{ users: Record<string, { richPresence: Record<string, string>; localizedString: string | null }> }> {
    this.calls.push({ method: 'read', app, value: [...steamIds] })
    const raw = this.onRead ? await this.onRead() : structuredClone(this.rp)
    return { users: { [steamIds[0]!]: { richPresence: raw, localizedString: this.localizedString } } }
  }
  login(steamId = A.steamId): void { this.steamID = { getSteamID64: () => steamId }; this.emit('loggedOn', {}) }
  external(blocked = true, app = 730): void { this.playingState = { blocked, appid: app }; this.emit('playingState', blocked, app) }
}

const services: GameStatusService[] = []
const folders: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  for (const folder of folders.splice(0)) { expect(resolve(folder).startsWith(resolve(tmpdir()) + '\\') || resolve(folder).startsWith(resolve(tmpdir()) + '/')).toBe(true); await rm(folder, { recursive: true, force: true }) }
})

function fixture(draftPath?: string, getToolboxLogin?: GameStatusServiceOptions['getToolboxLogin']) {
  let selected: { id: string; steamId: string } | null = { ...A }
  const clients: FakeClient[] = []; const states: GameStatusSnapshot[] = []; const options: Record<string, unknown>[] = []
  const service = new GameStatusService({ getActiveAccount: () => selected, getToolboxLogin, onChange: state => states.push(state), draftPath, createClient: value => { options.push(value); const client = new FakeClient(); clients.push(client); return client } })
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: selected!.id, sessionId: service.snapshot().sessionId })
  function login(live = false): FakeClient { service.connect({ ...action(), accountName: 'fake-user', password: PASSWORD }); const client = clients.at(-1)!; client.login(selected!.steamId); client.external(live, live ? 730 : 0); return client }
  return { service, action, login, clients, options, states, select(value: typeof selected) { selected = value } }
}
const mutations = (client: FakeClient) => client.calls.filter(call => ['gamesPlayed', 'setPersona', 'upload'].includes(call.method))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('existing toolbox login yields a fresh server-only web logon nonce', () => {
  const nonce = 'FAKE-web-logon-nonce-never-expose'
  const credentials = () => ({ steamId: A.steamId, accountName: 'toolbox-account', webLogonToken: nonce })

  it('immediately rotates the session while preparing, then sends exactly the three documented nonce fields', async () => {
    const getter = vi.fn(async () => credentials()); const f = fixture(undefined, getter); const previous = f.action()
    const pending = f.service.connectWithToolbox(previous)
    expect(f.service.state().sessionId).not.toBe(previous.sessionId); expect(f.service.state().status).toBe('connecting'); expect(f.service.state().busy).toBe(true)
    const state = await pending
    expect(getter).toHaveBeenCalledExactlyOnceWith(A.id); expect(f.clients).toHaveLength(1)
    expect(f.clients[0]!.calls[0]).toEqual({ method: 'logOn', value: { accountName: 'toolbox-account', steamID: A.steamId, webLogonToken: nonce } })
    expect(state.busy).toBe(false); expect(mutations(f.clients[0]!)).toEqual([])
    expect(JSON.stringify([state, ...f.states])).not.toContain(nonce)
    f.clients[0]!.login(); expect(f.service.state().status).toBe('logged_on')
  })
  it('rejects a mismatched toolbox identity before constructing any CM client', async () => {
    const f = fixture(undefined, async () => ({ ...credentials(), steamId: B.steamId }))
    const state = await f.service.connectWithToolbox(f.action())
    expect(state.status).toBe('error'); expect(state.error).toContain('工具箱'); expect(f.clients).toHaveLength(0)
    expect(JSON.stringify(f.states)).not.toContain(nonce)
  })
  it('still rejects the actual logged-on SteamID when it differs from the selected toolbox account', async () => {
    const f = fixture(undefined, async () => credentials()); await f.service.connectWithToolbox(f.action()); const client = f.clients[0]!
    client.login(B.steamId); expect(f.service.state().status).toBe('error'); expect(f.service.state().error).toContain('工具箱账号页面重新登录')
    expect(mutations(client)).toEqual([]); expect(client.calls.at(-1)!.method).toBe('logOff')
  })
  it('discards a nonce after account switch even if the caller forgot the normal invalidate notification', async () => {
    const available = deferred<ReturnType<typeof credentials>>(); const f = fixture(undefined, () => available.promise)
    const pending = f.service.connectWithToolbox(f.action()); const rejected = expect(pending).rejects.toThrow('变化')
    await Promise.resolve(); f.select(B); available.resolve(credentials()); await rejected
    expect(f.clients).toHaveLength(0); expect(f.service.state().status).toBe('logged_out')
  })
  it('logout while a nonce is pending immediately cancels it and cannot revive the same account later', async () => {
    const available = deferred<ReturnType<typeof credentials>>(); const f = fixture(undefined, () => available.promise)
    const pending = f.service.connectWithToolbox(f.action()); const rejected = expect(pending).rejects.toThrow('已经变化')
    await Promise.resolve(); f.service.logout(f.action()); const loggedOut = f.service.state(); await rejected
    available.resolve(credentials()); await Promise.resolve(); await Promise.resolve()
    expect(f.clients).toHaveLength(0); expect(f.service.state()).toEqual(loggedOut)
  })
  it('an explicit account-switch invalidation cancels pending toolbox login without applying its late token', async () => {
    const available = deferred<ReturnType<typeof credentials>>(); const f = fixture(undefined, () => available.promise)
    const pending = f.service.connectWithToolbox(f.action()); const rejected = expect(pending).rejects.toThrow('已经变化')
    await Promise.resolve(); f.select(B); f.service.invalidate(); await rejected; available.resolve(credentials()); await Promise.resolve()
    expect(f.clients).toHaveLength(0); expect(f.service.state().accountId).toBeNull()
  })
  it('repeated current-session preparation is busy without replacing its nonce request', async () => {
    const first = deferred<ReturnType<typeof credentials>>()
    const getter = vi.fn().mockImplementationOnce(() => first.promise)
    const f = fixture(undefined, getter); const original = f.action(); const old = f.service.connectWithToolbox(original)
    await vi.waitFor(() => expect(getter).toHaveBeenCalledTimes(1))
    await expect(f.service.connectWithToolbox(original)).rejects.toThrow('会话已经变化')
    await expect(f.service.connectWithToolbox(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_BUSY' })
    first.resolve(credentials()); await old
    expect(f.clients).toHaveLength(1); expect(getter).toHaveBeenCalledTimes(1)
  })
  it('validates account/session before asking the toolbox for any login capability', async () => {
    const getter = vi.fn(async () => credentials()); const f = fixture(undefined, getter); const initial = f.service.state()
    await expect(f.service.connectWithToolbox({ accountId: B.id, sessionId: initial.sessionId })).rejects.toThrow()
    await expect(f.service.connectWithToolbox({ accountId: A.id, sessionId: 'old' })).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled(); expect(f.service.state()).toEqual(initial)
  })
  it('sanitizes callback rejection and missing/invalid capability without disclosing secrets', async () => {
    const f = fixture(undefined, async () => { throw new Error(`${nonce} ${PASSWORD} cookie=FAKE`) })
    expect((await f.service.connectWithToolbox(f.action())).error).toContain('工具箱账号页面重新登录')
    expect(JSON.stringify(f.states)).not.toContain(nonce); expect(JSON.stringify(f.states)).not.toContain(PASSWORD)
    const missing = fixture(); expect((await missing.service.connectWithToolbox(missing.action())).status).toBe('error')
    for (const webLogonToken of ['', ' ', 'bad\nvalue']) {
      const invalid = fixture(undefined, async () => ({ ...credentials(), webLogonToken }))
      expect((await invalid.service.connectWithToolbox(invalid.action())).status).toBe('error'); expect(invalid.clients).toHaveLength(0)
    }
  })
  it('nonce Guard requests do not prompt for a second password/code and tell the user to reauthenticate in the toolbox', async () => {
    const f = fixture(undefined, async () => credentials()); await f.service.connectWithToolbox(f.action()); const client = f.clients[0]!
    let answered = false; client.emit('steamGuard', 'example.test', () => { answered = true }, false)
    expect(answered).toBe(false); expect(f.service.state().guard).toBeNull(); expect(f.service.state().status).toBe('error')
    expect(f.service.state().error).toContain('工具箱账号页面重新登录'); expect(mutations(client)).toEqual([])
    expect(client.calls.at(-1)!.method).toBe('logOff')
  })
  it('preparation timeout ends busy state and late capabilities cannot start a CM client', async () => {
    vi.useFakeTimers(); const available = deferred<ReturnType<typeof credentials>>(); const f = fixture(undefined, () => available.promise)
    const pending = f.service.connectWithToolbox(f.action()); await Promise.resolve(); await vi.advanceTimersByTimeAsync(120000)
    const timedOut = await pending; expect(timedOut.status).toBe('error'); expect(timedOut.busy).toBe(false); expect(timedOut.error).toContain('工具箱')
    available.resolve(credentials()); await Promise.resolve(); expect(f.clients).toHaveLength(0); expect(f.service.state()).toEqual(timedOut)
  })
  it('nonce is never persisted in offline draft files or returned as draft data', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'game-status-tests-')); folders.push(folder); const path = join(folder, 'draft.json')
    const f = fixture(path, async () => credentials()); await f.service.connectWithToolbox(f.action())
    const saved = await f.service.saveDraft({ ...f.action(), draft: { displayKind: 'custom', gameName: 'Fixture game', details: 'Local draft' } })
    expect(JSON.stringify(saved)).not.toContain(nonce); expect(await readFile(path, 'utf8')).not.toContain(nonce)
    expect(JSON.stringify(f.service.state())).not.toContain(nonce)
  })
})

describe('game status CM login is isolated and bound to the selected toolbox account', () => {
  it('constructs the real SDK without logging in, web-cookie requests, disk storage or network', () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('Network forbidden') })
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Network forbidden') })
    const secureRequest = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Network forbidden') })
    try {
      const client = createGameStatusSteamClient() as GameStatusSteamClient & { options: Record<string, unknown>; storage?: unknown; webLogOn(): void }
      for (const [key, value] of Object.entries(GAME_STATUS_CLIENT_OPTIONS)) expect(client.options[key]).toBe(value)
      expect(client.storage).toBeUndefined(); expect(client.steamID).toBeNull(); expect(() => client.webLogOn()).not.toThrow()
      client.logOff(); expect(connect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(secureRequest).not.toHaveBeenCalled()
    } finally { connect.mockRestore(); request.mockRestore(); secureRequest.mockRestore() }
  })
  it('starts without creating a client or requiring a web/browser token', () => {
    const f = fixture(); expect(f.service.state().status).toBe('logged_out'); expect(f.clients).toHaveLength(0)
  })
  it('uses privacy options and does not force persona during login', () => {
    const f = fixture(); const client = f.login(true)
    expect(f.options[0]).toEqual(GAME_STATUS_CLIENT_OPTIONS); expect(f.service.state().steamId).toBe(A.steamId)
    expect(mutations(client)).toEqual([])
  })
  it('rejects CM login identity mismatch before any game/persona write', () => {
    const f = fixture(); f.service.connect({ ...f.action(), accountName: 'fake-other', password: PASSWORD }); const client = f.clients[0]!
    client.login(B.steamId); expect(f.service.state().status).toBe('error'); expect(f.service.state().connected).toBe(false)
    expect(mutations(client)).toEqual([]); expect(client.calls.some(call => call.method === 'logOff')).toBe(true)
  })
  it('requires account and session binding for every simulation and live action', async () => {
    const f = fixture(); const client = f.login(true); const wrong = { accountId: B.id, sessionId: f.service.state().sessionId }
    expect(() => f.service.play({ ...wrong, displayKind: 'custom', gameName: 'fake', details: '' })).toThrow()
    expect(() => f.service.stop(wrong)).toThrow(); expect(() => f.service.logout(wrong)).toThrow()
    await expect(f.service.observeLive(wrong)).rejects.toThrow(); await expect(f.service.restoreLive(wrong)).rejects.toThrow()
    expect(mutations(client)).toEqual([])
  })
  it('rejects stale session IDs even when the selected toolbox account is unchanged', async () => {
    const f = fixture(); const previous = f.action(); const client = f.login(true)
    expect(() => f.service.connect({ ...previous, accountName: 'fake', password: PASSWORD })).toThrow()
    expect(() => f.service.stop(previous)).toThrow(); expect(() => f.service.logout(previous)).toThrow()
    await expect(f.service.observeLive(previous)).rejects.toThrow(); await expect(f.service.loadDraft(previous)).rejects.toThrow()
    expect(mutations(client)).toEqual([])
  })
  it('makes old login callbacks and guard challenges inert after invalidation/account switch', () => {
    const f = fixture(); f.service.connect({ ...f.action(), accountName: 'fake', password: PASSWORD }); const old = f.clients[0]!
    let codes = 0; old.emit('steamGuard', null, () => codes++, false); const oldState = f.service.state(); const callback = old.listeners('loggedOn')[0]!
    f.select(B); f.service.invalidate(); const fresh = f.service.state()
    callback(); old.emit('error', new Error(PASSWORD)); old.emit('refreshToken', SECRET)
    expect(f.service.state()).toEqual(fresh)
    expect(() => f.service.respondGuard({ accountId: A.id, sessionId: oldState.sessionId, challengeId: oldState.guard!.challengeId, code: 'ABCDE' })).toThrow()
    expect(codes).toBe(0)
  })
  it('supports one-use Guard callback and does not expose passwords/tokens/errors', () => {
    const f = fixture(); f.service.connect({ ...f.action(), accountName: 'fake', password: PASSWORD }); const client = f.clients[0]!
    const codes: string[] = []; client.emit('steamGuard', 'example.test', (code: string) => codes.push(code), false)
    const challenge = f.service.state().guard!; f.service.respondGuard({ ...f.action(), challengeId: challenge.challengeId, code: 'abcde' })
    expect(codes).toEqual(['ABCDE']); expect(() => f.service.respondGuard({ ...f.action(), challengeId: challenge.challengeId, code: 'ABCDE' })).toThrow()
    client.emit('webSession', SECRET, [SECRET]); client.emit('refreshToken', SECRET); client.emit('error', new Error(`${PASSWORD} ${SECRET}`))
    expect(JSON.stringify(f.states)).not.toContain(PASSWORD); expect(JSON.stringify(f.states)).not.toContain(SECRET)
  })
})

describe('simulation remains explicit and never takes over an occupied account', () => {
  it('merges custom text into a single non-Steam game name and uses force=false', async () => {
    const f = fixture(); const client = f.login(); const result = await f.service.play({ ...f.action(), displayKind: 'custom', gameName: '雀魂', details: '正在打牌' })
    expect(client.calls.at(-1)).toEqual({ method: 'gamesPlayed', value: '雀魂 · 正在打牌', force: false }); expect(result.limitations.join('')).toContain('合并')
  })
  it('official simulation sends a published display template and clears own RP/game on stop', async () => {
    const f = fixture(); const client = f.login(); await f.service.inspectApp({ ...f.action(), appId: 730 })
    const state = await f.service.play({ ...f.action(), displayKind: 'app', gameName: 'Example', details: 'Fake map', appId: 730, presence: { displayToken: '#Fixture', values: { status: 'Fake map' } } })
    expect(client.calls.at(-1)).toEqual({ method: 'upload', app: 730, value: { steam_display: '#Fixture', status: 'Fake map' } }); expect(state.playing!.displayName).toBe('Fixture game 730'); expect(state.playing!.preview).toBe('Fake map'); f.service.stop(f.action())
    expect(client.calls.slice(-2)).toEqual([{ method: 'upload', app: 730, value: {} }, { method: 'gamesPlayed', value: [], force: false }])
  })
  it('rejects the legacy status-only text before any simulation write', () => {
    const f = fixture(); const client = f.login()
    expect(() => f.service.play({ ...f.action(), displayKind: 'app', gameName: 'Example', details: 'Invisible text', appId: 730 })).toThrow('显示模板')
    expect(mutations(client)).toEqual([])
  })
  it('rejects over-limit Unicode/control text and invalid app IDs before writes', () => {
    const f = fixture(); const client = f.login()
    for (const extra of [{ gameName: '界'.repeat(43) }, { gameName: 'x\ny' }, { gameName: 'x', details: '\t' }]) expect(() => f.service.play({ ...f.action(), displayKind: 'custom', details: '', ...extra })).toThrow()
    expect(() => f.service.play({ ...f.action(), displayKind: 'app', gameName: '', details: '', appId: 0 })).toThrow(); expect(mutations(client)).toEqual([])
  })
  it('blocked simulation/stop/logout never sends gamesPlayed or persona or clears live RP', () => {
    const f = fixture(); const client = f.login(true)
    expect(() => f.service.play({ ...f.action(), displayKind: 'custom', gameName: 'Fake', details: '' })).toThrow()
    f.service.stop(f.action()); f.service.logout(f.action()); expect(mutations(client)).toEqual([])
  })
})

describe('real game state observes once and never exposes or edits joining tokens', () => {
  it('requires an actual external game and requests RP only for the bound owner', async () => {
    const f = fixture(); const client = f.login(); await expect(f.service.observeLive(f.action())).rejects.toThrow()
    client.external(); const state = await f.service.observeLive(f.action())
    expect(client.calls.at(-1)).toEqual({ method: 'read', app: 730, value: [A.steamId] })
    expect(state.live!.fields['game:map']).toBe('map_old'); expect(state.live!.readOnlyKeys).toContain('steam_display')
    expect(JSON.stringify(state)).not.toContain(SECRET); expect(mutations(client)).toEqual([])
  })
  it('only patches observed public editable keys and refuses tokens/new keys', async () => {
    const f = fixture(); const client = f.login(true); const state = await f.service.observeLive(f.action())
    for (const key of ['connect', 'game:lobby', 'steam_player_group', 'steam_display', 'new_field', '__proto__']) await expect(f.service.patchLive({ ...f.action(), snapshotId: state.live!.snapshotId, changes: Object.fromEntries([[key, 'bad']]) })).rejects.toThrow()
    expect(mutations(client)).toEqual([])
  })
  it('rereads before patch and preserves fresh protected tokens and unrelated game changes', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    client.rp.connect = 'FAKE-new-join'; client.rp['game:score'] = '9:9'
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { 'game:map': 'map_custom' } })
    const uploaded = client.calls.find(call => call.method === 'upload')!.value as Record<string, string>
    expect(uploaded.connect).toBe('FAKE-new-join'); expect(uploaded['game:score']).toBe('9:9'); expect(uploaded['game:map']).toBe('map_custom')
    expect(state.lastOperation!.outcome).toBe('matched'); expect(state.lastOperation!.message).toContain('好友'); expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(client.calls.filter(call => ['gamesPlayed', 'setPersona'].includes(call.method))).toEqual([])
  })
  it('refuses changed target keys through optimistic conflict detection without upload', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); client.rp['game:map'] = 'map_game_changed'
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { 'game:map': 'map_custom' } })
    expect(state.lastOperation!.outcome).toBe('conflict'); expect(mutations(client)).toEqual([])
  })
  it('calls a nonmatching readback unverified and never loops/reasserts', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); client.acceptWrites = false
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'New fake status' } })
    expect(state.lastOperation!.outcome).toBe('unverified'); expect(client.calls.filter(call => call.method === 'upload')).toHaveLength(1)
    expect(state.live!.patchActive).toBe(true)
  })
  it('does not send a second patch while a previous patch is pending restoration', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const patched = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Changed' } })
    await expect(f.service.patchLive({ ...f.action(), snapshotId: patched.live!.snapshotId, changes: { status: 'Changed again' } })).rejects.toThrow()
    expect(client.calls.filter(call => call.method === 'upload')).toHaveLength(1)
  })
  it('restores only tool-changed keys while preserving new fields and latest join tokens', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Custom status' } })
    client.rp.connect = 'FAKE-rotated-token'; client.rp['game:score'] = '8:7'; client.rp.new_unknown_field = 'Keep new field'
    const state = await f.service.restoreLive(f.action())
    expect(client.rp.status).toBe('Playing map'); expect(client.rp.connect).toBe('FAKE-rotated-token'); expect(client.rp['game:score']).toBe('8:7'); expect(client.rp.new_unknown_field).toBe('Keep new field')
    expect(state.lastOperation!.outcome).toBe('matched'); expect(state.live!.patchActive).toBe(false)
    expect(client.calls.filter(call => ['gamesPlayed', 'setPersona'].includes(call.method))).toEqual([])
  })
  it('refuses restore when the game has overwritten a patched key', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Custom status' } }); client.rp.status = 'Game advanced'
    const before = mutations(client).length; const result = await f.service.restoreLive(f.action())
    expect(result.lastOperation!.outcome).toBe('conflict'); expect(mutations(client)).toHaveLength(before); expect(client.rp.status).toBe('Game advanced')
  })
  it('manual refresh after a restore conflict retires only local history and permits a new one-shot patch', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Custom status' } })
    client.rp.status = 'Game advanced'; expect((await f.service.restoreLive(f.action())).lastOperation!.outcome).toBe('conflict')
    const before = mutations(client).length; const refreshed = await f.service.observeLive(f.action())
    expect(mutations(client)).toHaveLength(before); expect(refreshed.live!.patchActive).toBe(false); expect(refreshed.live!.fields.status).toBe('Game advanced')
    expect(refreshed.lastOperation!.message).toContain('旧修补')
    const patched = await f.service.patchLive({ ...f.action(), snapshotId: refreshed.live!.snapshotId, changes: { status: 'Second custom' } })
    expect(patched.lastOperation!.outcome).toBe('matched'); expect(client.calls.filter(call => call.method === 'upload')).toHaveLength(2)
  })
  it('manual refresh preserves a still-matching patch so its original fields remain restorable', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Custom status' } })
    const before = mutations(client).length; const refreshed = await f.service.observeLive(f.action())
    expect(refreshed.live!.patchActive).toBe(true); expect(mutations(client)).toHaveLength(before)
    expect((await f.service.restoreLive(f.action())).lastOperation!.outcome).toBe('matched'); expect(client.rp.status).toBe('Playing map')
  })
  it('invalidates read results after game exit/app switch/account change', async () => {
    for (const change of ['exit', 'app', 'account'] as const) {
      const f = fixture(); const client = f.login(true); const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise
      const action = f.action(); const reading = f.service.observeLive(action)
      if (change === 'exit') client.external(false, 0)
      else if (change === 'app') client.external(true, 570)
      else { f.select(B); f.service.invalidate() }
      pending.resolve({ ...client.rp }); await expect(reading).rejects.toThrow(); expect(f.service.state().live).toBeNull(); expect(mutations(client)).toEqual([])
    }
  })
  it('invalidates a pending patch even if the same app resumes under a new game epoch', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise
    const patch = f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'custom' } })
    client.external(false, 0); client.external(true, 730); pending.resolve({ ...client.rp })
    await expect(patch).rejects.toThrow(); expect(mutations(client)).toEqual([])
  })
  it('expired observations and restores never upload', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    vi.advanceTimersByTime(LIVE_OBSERVATION_TTL_MS)
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'new' } })).rejects.toThrow('过期')
    expect(mutations(client)).toEqual([])
    const fresh = await f.service.observeLive(f.action()); await f.service.patchLive({ ...f.action(), snapshotId: fresh.live!.snapshotId, changes: { status: 'new' } })
    const count = mutations(client).length; vi.advanceTimersByTime(LIVE_RESTORE_TTL_MS)
    await expect(f.service.restoreLive(f.action())).rejects.toThrow('过期'); expect(mutations(client)).toHaveLength(count)
  })
  it('manual refresh retires an expired still-matching restore record without writes and allows a new patch', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const first = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'First custom status' } })
    vi.advanceTimersByTime(LIVE_RESTORE_TTL_MS)
    const before = mutations(client).length
    await expect(f.service.restoreLive(f.action())).rejects.toThrow('过期')
    expect(mutations(client)).toHaveLength(before); expect(client.rp.status).toBe('First custom status')
    const refreshed = await f.service.observeLive(f.action())
    expect(mutations(client)).toHaveLength(before); expect(client.rp.status).toBe('First custom status')
    expect(refreshed.live!.patchActive).toBe(false); expect(refreshed.live!.snapshotId).not.toBe(first.live!.snapshotId)
    expect(refreshed.lastOperation!.message).toContain('过期'); expect(refreshed.lastOperation!.message).toContain('重新建立')
    const second = await f.service.patchLive({ ...f.action(), snapshotId: refreshed.live!.snapshotId, changes: { status: 'Second custom status' } })
    expect(second.lastOperation!.outcome).toBe('matched'); expect(client.rp.status).toBe('Second custom status')
    expect(client.calls.filter(call => call.method === 'upload')).toHaveLength(2)
    expect(client.calls.filter(call => ['gamesPlayed', 'setPersona'].includes(call.method))).toEqual([])
  })
  it('crossing observation expiry while the fresh read waits is rejected before upload', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise
    const patch = f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'new' } })
    vi.advanceTimersByTime(LIVE_OBSERVATION_TTL_MS); pending.resolve({ ...client.rp }); await expect(patch).rejects.toThrow('过期'); expect(mutations(client)).toEqual([])
  })
  it('crossing restore expiry during a fresh read is rejected without upload', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'new' } })
    const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise; const count = mutations(client).length
    const restoring = f.service.restoreLive(f.action()); vi.advanceTimersByTime(LIVE_RESTORE_TTL_MS); pending.resolve({ ...client.rp })
    await expect(restoring).rejects.toThrow('过期'); expect(mutations(client)).toHaveLength(count)
  })
  it('an unreadable restore verification never fabricates an observed original value', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const patched = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Custom status' } })
    let reads = 0; client.onRead = async () => { if (++reads === 2) throw new Error(SECRET); return { ...client.rp } }
    const restored = await f.service.restoreLive(f.action())
    expect(restored.lastOperation!.outcome).toBe('unverified'); expect(restored.live!.snapshotId).toBe(patched.live!.snapshotId)
    expect(restored.live!.fields.status).toBe('Custom status'); expect(JSON.stringify(restored)).not.toContain(SECRET)
  })
  it('logout/dispose after a real patch does not clear RP, games, persona or force a restore', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'new' } })
    const count = mutations(client).length; f.service.dispose(); expect(mutations(client)).toHaveLength(count); expect(client.calls.at(-1)!.method).toBe('logOff')
  })
})

describe('published game metadata and localized display', () => {
  it('refreshes explicit inspection while retaining at most twenty expiring application catalogs', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(); const product = vi.spyOn(client, 'getProductInfo')
    const first = await f.service.inspectApp({ ...f.action(), appId: 730 })
    expect(first.name).toBe('Fixture game 730'); expect(first.iconUrl).toContain('730/'); expect(first.templates.map(template => template.token)).toContain('#Fixture')
    await f.service.inspectApp({ ...f.action(), appId: 730 }); expect(product).toHaveBeenCalledTimes(2)
    for (let appId = 100; appId < 120; appId++) await f.service.inspectApp({ ...f.action(), appId })
    const play = () => f.service.play({ ...f.action(), displayKind: 'app', appId: 730, gameName: '', details: '', presence: { displayToken: '#Fixture', values: { status: 'Fixture' } } })
    expect(play).toThrow('读取'); await f.service.inspectApp({ ...f.action(), appId: 730 }); expect(product).toHaveBeenCalledTimes(23)
    vi.advanceTimersByTime(GAME_STATUS_APP_INFO_TTL_MS)
    expect(play).toThrow('读取'); await f.service.inspectApp({ ...f.action(), appId: 730 }); expect(product).toHaveBeenCalledTimes(24)
    expect(mutations(client)).toEqual([])
  })
  it('deduplicates concurrent catalog reads and discards a late old-account response', async () => {
    const f = fixture(); const client = f.login(); const pending = deferred<unknown>(); const product = vi.spyOn(client, 'getProductInfo').mockImplementation(() => pending.promise)
    const first = f.service.inspectApp({ ...f.action(), appId: 730 }); const second = f.service.inspectApp({ ...f.action(), appId: 730 })
    const firstRejected = expect(first).rejects.toThrow('变化'); const secondRejected = expect(second).rejects.toThrow('变化')
    await Promise.resolve()
    f.select(B); f.service.invalidate(); pending.resolve({ apps: {} }); await firstRejected; await secondRejected
    expect(product).toHaveBeenCalledTimes(1); expect(f.service.state().appInfo).toBeNull(); expect(mutations(client)).toEqual([])
  })
  it('catalog-only names/icons are not mistaken for a confirmed remote display', async () => {
    const f = fixture(); const client = f.login(); await f.service.inspectApp({ ...f.action(), appId: 730 })
    const result = await f.service.play({ ...f.action(), displayKind: 'app', appId: 730, gameName: 'Wrong local label', details: '' })
    expect(result.playing!.game!.name).toBe('Fixture game 730'); expect(result.playing!.game!.iconUrl).toMatch(/^https:/)
    expect(result.playing!.delivery).toBe('submitted'); expect(result.playing!.preview).toBeNull(); expect(client.calls.filter(call => call.method === 'upload')).toEqual([])
  })
  it('a missing/expired catalog or unpublished display token cannot send an arbitrary steam_display', async () => {
    const f = fixture(); const client = f.login(); const input = { ...f.action(), displayKind: 'app' as const, appId: 730, gameName: '', details: '', presence: { displayToken: '#NotPublished', values: {} } }
    expect(() => f.service.play(input)).toThrow('读取')
    await f.service.inspectApp({ ...f.action(), appId: 730 }); expect(() => f.service.play(input)).toThrow()
    expect(mutations(client)).toEqual([])
  })
  it('preserves real game fields but withholds unverified localized text when the published catalog fails', async () => {
    const f = fixture(); const client = f.login(true); client.localizedString = 'Game server rendered state'
    vi.spyOn(client, 'getAppRichPresenceLocalization').mockRejectedValue(new Error(SECRET))
    const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBeNull(); expect(result.live!.fields.status).toBe('Playing map'); expect(JSON.stringify(result)).not.toContain(SECRET)
    client.localizedString = null; expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
    client.localizedString = 'bad\ncontrol'; expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
    client.localizedString = `Status contains ${SECRET}`; expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
  })
  it('confirms localized text using only the selected branch while preserving other game-owned fields', async () => {
    const f = fixture(); const client = f.login(true)
    vi.spyOn(client, 'getAppRichPresenceLocalization').mockResolvedValue({ tokens: { '#Display': '{#Mode_%mode%}', '#Mode_Menu': 'At menu', '#Mode_Match': 'Playing %map%' } })
    client.rp = { steam_display: '#Display', mode: 'Menu', map: 'Retained match map', connect: SECRET }
    client.localizedString = 'At menu'
    const state = await f.service.observeLive(f.action())
    expect(state.live?.localizedString).toBe('At menu')
    expect(state.live?.fields).toMatchObject({ mode: 'Menu', map: 'Retained match map' })
    expect(client.rp.map).toBe('Retained match map'); expect(mutations(client)).toEqual([])
    const pending = f.service.setLiveDisplay({ ...f.action(), snapshotId: state.live!.snapshotId, lock: false, presence: { displayToken: '#Display', values: { mode: 'Menu', map: 'Still not authorized for Menu' } } })
    await expect(pending).rejects.toThrow()
    expect(mutations(client)).toEqual([])
  })
  it('rejects an oversized full-map merge without dropping unknown or joining fields', async () => {
    const f = fixture(); const client = f.login(true)
    for (let index = 0; index < 13; index++) client.rp[`extra_${index}`] = `Keep ${index}`
    const original = { ...client.rp }; const observed = await f.service.observeLive(f.action())
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'New status' } })).rejects.toThrow('协议限制')
    expect(mutations(client)).toEqual([]); expect(client.rp).toEqual(original)
  })
  it('only accepts a published display template for real games and restores newly added fields by omission', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const input = { ...f.action(), snapshotId: observed.live!.snapshotId, lock: false }
    await expect(f.service.setLiveDisplay({ ...input, presence: { displayToken: '#Arbitrary', values: {} } })).rejects.toThrow()
    expect(mutations(client)).toEqual([])
    const state = await f.service.setLiveDisplay({ ...input, presence: { displayToken: '#FixtureActivity', values: { activity: 'Custom real status' } } })
    expect(state.lastOperation!.outcome).toBe('matched'); expect(client.rp.steam_display).toBe('#FixtureActivity'); expect(client.rp.activity).toBe('Custom real status'); expect(client.rp.connect).toBe(SECRET)
    await f.service.restoreLive(f.action()); expect(client.rp.steam_display).toBe('#GameMap'); expect(Object.hasOwn(client.rp, 'activity')).toBe(false)
    expect(client.calls.filter(call => ['gamesPlayed', 'setPersona'].includes(call.method))).toEqual([])
  })
})

describe('real game public-field locking is bounded, single-flight and session scoped', () => {
  async function locked() {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const state = await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Locked fixture' } })
    return { ...f, client, state }
  }
  it('rechecks matching fields without uploading and keeps raw matches distinct from localized display', async () => {
    vi.useFakeTimers(); const f = await locked(); f.client.localizedString = null
    expect(f.state.liveLock!.status).toBe('locked'); expect(f.state.lastOperation!.message).toContain('不代表好友')
    const writes = mutations(f.client).length; const reads = f.client.calls.filter(call => call.method === 'read').length
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(mutations(f.client)).toHaveLength(writes); expect(f.client.calls.filter(call => call.method === 'read')).toHaveLength(reads + 1)
    expect(f.service.state().liveLock).toMatchObject({ status: 'locked', matched: true, localizedString: null, consecutiveFailures: 0 })
    expect(f.service.state().liveLock!.nextCheckAt).not.toBeNull()
  })
  it('reasserts only selected fields, preserves fresh game tokens, and restores the newest game bottom value', async () => {
    vi.useFakeTimers(); const f = await locked()
    f.client.rp.status = 'Game advanced'; f.client.rp.connect = 'FAKE-rotated-join'; f.client.rp['game:score'] = '8:9'; f.client.rp.new_field = 'untouched'
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(f.client.rp).toMatchObject({ status: 'Locked fixture', connect: 'FAKE-rotated-join', 'game:score': '8:9', new_field: 'untouched' })
    const restored = await f.service.unlockLive({ ...f.action(), restore: true })
    expect(restored.lastOperation!.outcome).toBe('matched'); expect(f.client.rp.status).toBe('Game advanced'); expect(f.client.rp.connect).toBe('FAKE-rotated-join')
    expect(f.client.calls.filter(call => ['gamesPlayed', 'setPersona'].includes(call.method))).toEqual([])
    const writes = mutations(f.client).length; await vi.advanceTimersByTimeAsync(60000); expect(mutations(f.client)).toHaveLength(writes)
  })
  it('can lock an already matching observed value without a redundant initial upload', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    const state = await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: client.rp.status! } })
    expect(state.liveLock!.status).toBe('locked'); expect(mutations(client)).toEqual([])
  })
  it('conflicts before the first write when the target key changes after observation', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); client.rp.status = 'New game state'
    const state = await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Locked' } })
    expect(state.lastOperation!.outcome).toBe('conflict'); expect(state.liveLock).toBeNull(); expect(mutations(client)).toEqual([])
  })
  it('locks a validated display template but refuses ordinary patch access to steam_display', async () => {
    vi.useFakeTimers(); const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action())
    await expect(f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { steam_display: '#Fixture' } })).rejects.toThrow()
    const state = await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.live!.snapshotId, lock: true, presence: { displayToken: '#Fixture', values: { status: 'Rendered desired text' } } })
    expect(state.liveLock!.desired).toEqual({ steam_display: '#Fixture', status: 'Rendered desired text' })
    client.rp.steam_display = '#GameMap'; client.rp.status = 'Game status'; await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(client.rp.steam_display).toBe('#Fixture'); expect(client.rp.status).toBe('Rendered desired text')
  })
  it('never overlaps a slow read and unlock immediately invalidates its late result', async () => {
    vi.useFakeTimers(); const f = await locked(); const pending = deferred<Record<string, string>>(); f.client.onRead = () => pending.promise
    const reads = f.client.calls.filter(call => call.method === 'read').length; const writes = mutations(f.client).length
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS); await vi.advanceTimersByTimeAsync(30000)
    expect(f.client.calls.filter(call => call.method === 'read')).toHaveLength(reads + 1); expect(f.service.state().busy).toBe(true)
    await f.service.unlockLive(f.action()); expect(f.service.state().liveLock!.status).toBe('stopped')
    pending.resolve({ ...f.client.rp, status: 'Late game overwrite' }); await vi.advanceTimersByTimeAsync(60000)
    expect(mutations(f.client)).toHaveLength(writes); expect(f.service.state().busy).toBe(false); expect(f.service.state().liveLock!.nextCheckAt).toBeNull()
  })
  it('unlock cancels a lock still preparing its initial baseline before any upload', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise
    const locking = f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Do not send' } }); const rejected = expect(locking).rejects.toThrow('取消')
    await f.service.unlockLive(f.action()); pending.resolve({ ...client.rp }); await rejected
    expect(mutations(client)).toEqual([]); expect(f.service.state().liveLock).toBeNull()
  })
  it('unlock cancels a display-template lock awaiting its initial game read', async () => {
    const f = fixture(); const client = f.login(true); const observed = await f.service.observeLive(f.action()); const pending = deferred<Record<string, string>>(); client.onRead = () => pending.promise
    const locking = f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.live!.snapshotId, lock: true, presence: { displayToken: '#Fixture', values: { status: 'Do not send' } } }); const rejected = expect(locking).rejects.toThrow('取消')
    await Promise.resolve(); await f.service.unlockLive(f.action()); pending.resolve({ ...client.rp }); await rejected
    expect(mutations(client)).toEqual([]); expect(f.service.state().liveLock).toBeNull()
  })
  it('unlock with restore drains a pending check without allowing a late reassertion', async () => {
    vi.useFakeTimers(); const f = await locked(); const pending = deferred<Record<string, string>>(); f.client.onRead = () => pending.promise
    const writes = mutations(f.client).length; await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    const unlocking = f.service.unlockLive({ ...f.action(), restore: true })
    expect(f.service.state().liveLock!.status).toBe('stopped'); f.client.onRead = null; pending.resolve({ ...f.client.rp })
    const state = await unlocking
    expect(state.lastOperation!.outcome).toBe('matched'); expect(f.client.rp.status).toBe('Playing map'); expect(mutations(f.client)).toHaveLength(writes + 1)
  })
  it('unlock restoration refuses a newer game-owned value instead of rolling it back', async () => {
    vi.useFakeTimers(); const f = await locked(); f.client.rp.status = 'Newest game state'; const writes = mutations(f.client).length
    const state = await f.service.unlockLive({ ...f.action(), restore: true })
    expect(state.lastOperation!.outcome).toBe('conflict'); expect(f.client.rp.status).toBe('Newest game state'); expect(mutations(f.client)).toHaveLength(writes)
  })
  it.each(['exit', 'app', 'logout', 'dispose', 'account'] as const)('stops on %s and discards pending callbacks', async change => {
    vi.useFakeTimers(); const f = await locked(); const pending = deferred<Record<string, string>>(); f.client.onRead = () => pending.promise
    const writes = mutations(f.client).length; await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    if (change === 'exit') { f.client.external(false, 0); f.client.external(true, 730) }
    else if (change === 'app') f.client.external(true, 440)
    else if (change === 'logout') f.service.logout(f.action())
    else if (change === 'dispose') f.service.dispose()
    else { f.select(B); f.service.invalidate() }
    pending.resolve({ ...f.client.rp, status: 'Late overwrite' }); await vi.advanceTimersByTimeAsync(120000)
    expect(mutations(f.client)).toHaveLength(writes); expect(f.service.state().liveLock).toBeNull()
  })
  it('stops even when account selection changes without the normal invalidate notification', async () => {
    vi.useFakeTimers(); const f = await locked(); const writes = mutations(f.client).length; f.select(B)
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.service.state().liveLock!.status).toBe('stopped'); expect(mutations(f.client)).toHaveLength(writes); expect(f.service.state().liveLock!.nextCheckAt).toBeNull()
  })
  it('backs off failed reads and pauses after a bounded number without exposing SDK errors', async () => {
    vi.useFakeTimers(); const f = await locked(); f.client.onRead = async () => { throw new Error(SECRET) }
    const waits = [5000, 5000, 10000, 20000, 30000]
    for (let index = 0; index < waits.length; index++) {
      await vi.advanceTimersByTimeAsync(waits[index]!)
      expect(f.service.state().liveLock!.consecutiveFailures).toBe(index + 1)
    }
    expect(f.service.state().liveLock).toMatchObject({ status: 'paused', matched: false, nextCheckAt: null, consecutiveFailures: LIVE_LOCK_MAX_FAILURES })
    const reads = f.client.calls.filter(call => call.method === 'read').length; await vi.advanceTimersByTimeAsync(120000)
    expect(f.client.calls.filter(call => call.method === 'read')).toHaveLength(reads); expect(JSON.stringify(f.service.state())).not.toContain(SECRET)
  })
  it('also bounds accepted uploads whose readback never matches', async () => {
    vi.useFakeTimers(); const f = await locked(); f.client.acceptWrites = false; f.client.rp.status = 'Game refuses desired value'
    const before = f.client.calls.filter(call => call.method === 'upload').length
    for (const wait of [5000, 5000, 10000, 20000, 30000]) await vi.advanceTimersByTimeAsync(wait)
    expect(f.service.state().liveLock!.status).toBe('paused'); expect(f.client.calls.filter(call => call.method === 'upload')).toHaveLength(before + LIVE_LOCK_MAX_FAILURES)
    await vi.advanceTimersByTimeAsync(120000); expect(f.client.calls.filter(call => call.method === 'upload')).toHaveLength(before + LIVE_LOCK_MAX_FAILURES)
  })
  it('requires unlocking before the legacy restore action, leaving the game untouched', async () => {
    vi.useFakeTimers(); const f = await locked(); const before = mutations(f.client).length
    await expect(f.service.restoreLive(f.action())).rejects.toThrow('解除锁定'); expect(mutations(f.client)).toHaveLength(before)
  })
})

describe('offline drafts remain per-account and contain no login secrets', () => {
  it('saves/loads without a CM client and strips unknown credential fields', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'game-status-tests-')); folders.push(folder); const path = join(folder, 'drafts.json'); const f = fixture(path)
    const value = { displayKind: 'custom', gameName: '雀魂', details: '离线草稿', password: PASSWORD, refreshToken: SECRET } as GameStatusDraft
    await f.service.saveDraft({ ...f.action(), draft: value }); expect(await f.service.loadDraft(f.action())).toEqual({ displayKind: 'custom', gameName: '雀魂', details: '离线草稿' })
    const disk = await readFile(path, 'utf8'); expect(disk).not.toContain(PASSWORD); expect(disk).not.toContain(SECRET); expect(f.clients).toHaveLength(0)
  })
  it('preserves other accounts drafts across fresh service instances and mode changes', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'game-status-tests-')); folders.push(folder); const path = join(folder, 'drafts.json')
    const one = fixture(path); await one.service.saveDraft({ ...one.action(), draft: { displayKind: 'custom', gameName: 'A draft', details: '' } })
    const two = fixture(path); two.select(B); await two.service.saveDraft({ ...two.action(), draft: { displayKind: 'app', gameName: 'B draft', details: '', appId: 730 } })
    expect((await one.service.loadDraft(one.action()))!.gameName).toBe('A draft'); expect((await two.service.loadDraft(two.action()))!.gameName).toBe('B draft')
  })
})
