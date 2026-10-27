import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolboxStatusCopyBackend, type StatusCopyToolboxClient } from '../src/main/status-copy-toolbox'
import type { StatusCopyBackendContext, StatusCopyLocalContext } from '../src/main/status-copy-backend'
import type { StatusCopySettingsInput } from '../src/shared/status-copy'

const TARGET = '76561198000000001', SOURCE = '76561198000000002', OTHER = '76561198000000003'
const settings: StatusCopySettingsInput = { mode: 'toolbox', sourceSteamId: SOURCE, intervalSeconds: 5, copyGroupSize: false, persona: 'away' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
class Client extends EventEmitter {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: false, appid: 0 }
  myFriends: Record<string, number> = { [SOURCE]: 3 }
  readonly calls: Array<{ op: string; args: unknown[] }> = []
  sourceApp = 730
  raw: Record<string, string> = { steam_display: '#Playing', map: 'Office', steam_player_group: 'private-source-group', steam_player_group_size: '3', connect: 'private-join' }
  target: Record<string, string> = {}
  identity = TARGET
  automatic = true
  emitPlaying = true
  emitFriends = true
  catalog = true
  catalogTokens: Record<string, string> = { '#Playing': 'Playing %map%' }
  onSource: (() => Promise<void>) | null = null
  failUpload = false
  closes = true
  logOn(details: Record<string, unknown>) {
    this.calls.push({ op: 'logOn', args: [details] })
    if (this.automatic) queueMicrotask(() => {
      this.steamID = { getSteamID64: () => this.identity }
      if (this.emitPlaying) this.emit('playingState', this.playingState.blocked, this.playingState.appid)
      if (this.emitFriends) this.emit('friendsList')
      this.emit('loggedOn')
    })
  }
  logOff() { this.calls.push({ op: 'logOff', args: [] }); if (this.closes) { this.emit('disconnected'); this.steamID = null } }
  setPersona(value: number) { this.calls.push({ op: 'persona', args: [value] }) }
  gamesPlayed(games: number[], force?: boolean) { this.calls.push({ op: 'games', args: [games, force] }) }
  uploadRichPresence(app: number, fields: Record<string, string>) {
    this.calls.push({ op: 'upload', args: [app, { ...fields }] })
    this.target = { ...fields }; if (this.failUpload && Object.keys(fields).length) throw new Error('raw SDK secret')
  }
  async requestRichPresence(app: number, ids: string[]) {
    this.calls.push({ op: 'read', args: [app, ids] })
    if (ids[0] === SOURCE) await this.onSource?.()
    return { users: { [ids[0]!]: { richPresence: { ...(ids[0] === SOURCE ? this.raw : this.target) } } } }
  }
  async getPersonas() { return { personas: { [SOURCE]: { gameid: String(this.sourceApp) } } } }
  async getProductInfo() { return { apps: { [this.sourceApp]: { appinfo: { common: { name: 'Fixture game' } } } } } }
  async getAppRichPresenceLocalization() { return { tokens: this.catalog ? this.catalogTokens : {} } }
}
function fixture() {
  const client = new Client()
  let local: StatusCopyLocalContext = { steamId: SOURCE, appId: 730, steamPid: 8, steamStartTicks: '100' }
  const controller = new AbortController()
  const context: StatusCopyBackendContext = {
    target: { accountId: 'target', steamId: TARGET }, sourceSteamId: SOURCE, signal: controller.signal,
    assertCurrent: () => { if (controller.signal.aborted) throw Object.assign(new Error(), { code: 'COPY_SESSION_CHANGED' }) },
    checkLocal: async () => ({ ...local })
  }
  const login = vi.fn(async () => ({ steamId: TARGET, accountName: 'fixture-account', webLogonToken: 'fixture-nonce' }))
  const create = vi.fn((_options: Record<string, unknown>) => client as unknown as StatusCopyToolboxClient)
  const stopReader = vi.fn(async () => ({ ...local }))
  const backend = new ToolboxStatusCopyBackend({ getToolboxLogin: login, createClient: create, readLocalContext: stopReader, loginTimeoutMs: 1000, requestTimeoutMs: 1000, retireTimeoutMs: 30 })
  return { backend, client, context, controller, login, create, stopReader, local: () => local, setLocal: (next: Partial<StatusCopyLocalContext>) => { local = { ...local, ...next } } }
}
afterEach(() => { vi.useRealTimers() })
describe('toolbox copy backend with no live connections', () => {
  it.each(['#State.Menu:Ready-1', `#${'a'.repeat(127)}`])('uses the shared display grammar for %s', async token => {
    const f = fixture(); f.client.raw.steam_display = token; f.client.catalogTokens = { [token]: 'Playing %map%' }
    const result = await f.backend.start(f.context, settings)
    expect(result.source?.fields).toEqual({ steam_display: token, map: 'Office' })
    expect(result.warnings).toEqual([])
    await f.backend.stop()
  })
  it('copies only the active safe branch instead of unrelated published fields', async () => {
    const f = fixture()
    f.client.raw = { steam_display: '#Display', mode: 'Menu', map: 'Office', connect: 'private join' }
    f.client.catalogTokens = { '#Display': '{#Mode_%mode%}', '#Mode_Menu': 'Menu', '#Mode_Match': 'Playing %map%' }
    const result = await f.backend.start(f.context, settings)
    expect(result.source?.fields).toEqual({ steam_display: '#Display', mode: 'Menu' })
    expect(result.warnings).toEqual([])
    await f.backend.stop()
  })
  it('does not let an inactive unsupported copy branch hide a supported sibling', async () => {
    const f = fixture()
    f.client.raw = { steam_display: '#Display', mode: 'Menu', customvalue: 'not copied' }
    f.client.catalogTokens = { '#Display': '{#Mode_%mode%}', '#Mode_Menu': 'Menu', '#Mode_Match': 'Playing %customvalue%' }
    const result = await f.backend.start(f.context, settings)
    expect(result.source?.fields).toEqual({ steam_display: '#Display', mode: 'Menu' })
    expect(result.warnings).toEqual([])
    expect(JSON.stringify(result)).not.toContain('not copied')
    await f.backend.stop()
  })
  it('previews through target-only login and never writes persona, game or RP', async () => {
    const f = fixture(); const report = await f.backend.preview(f.context, settings)
    expect(f.client.calls.filter(c => ['persona', 'games', 'upload'].includes(c.op))).toEqual([])
    expect(f.client.calls.find(c => c.op === 'logOn')!.args[0]).toMatchObject({ steamID: TARGET, webLogonToken: 'fixture-nonce' })
    expect(f.create.mock.calls[0]![0]).toMatchObject({ autoRelogin: false, dataDirectory: null, renewRefreshTokens: false, saveAppTickets: false })
    expect(report.source).toMatchObject({ steamId: SOURCE, appId: 730, authority: 'local-source-session', fields: { steam_display: '#Playing', map: 'Office' }, groupSize: 3 })
    expect(JSON.stringify(report)).not.toMatch(/private-source-group|private-join|fixture-nonce/)
    await f.backend.stop()
  })
  it('rejects target local before retrieving a nonce or creating CM', async () => {
    const f = fixture(); f.setLocal({ steamId: TARGET })
    await expect(f.backend.start(f.context, settings)).rejects.toMatchObject({ code: 'COPY_TARGET_IS_LOCAL' })
    expect(f.login).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
  })
  it('rejects native switch while nonce is pending without creating CM', async () => {
    const f = fixture(); const wait = deferred<{ steamId: string; accountName: string; webLogonToken: string }>()
    f.login.mockImplementationOnce(() => wait.promise)
    const pending = f.backend.start(f.context, settings)
    await vi.waitFor(() => expect(f.login).toHaveBeenCalled())
    f.setLocal({ steamId: TARGET }); wait.resolve({ steamId: TARGET, accountName: 'a', webLogonToken: 'n' })
    await expect(pending).rejects.toMatchObject({ code: 'COPY_TARGET_IS_LOCAL' }); expect(f.create).not.toHaveBeenCalled()
  })
  it('rejects wrong nonce identity and logged-on native identity separately', async () => {
    const a = fixture(); a.login.mockResolvedValueOnce({ steamId: OTHER, accountName: 'a', webLogonToken: 'n' })
    await expect(a.backend.start(a.context, settings)).rejects.toMatchObject({ code: 'COPY_IDENTITY_MISMATCH' }); expect(a.create).not.toHaveBeenCalled()
    const b = fixture(); b.client.identity = OTHER
    await expect(b.backend.start(b.context, settings)).rejects.toMatchObject({ code: 'COPY_IDENTITY_MISMATCH' }); await b.backend.stop()
  })
  it('starts only after real playing-state and never force-kicks', async () => {
    const f = fixture(); const report = await f.backend.start(f.context, settings)
    expect(report.verification).toBe('target-readback')
    expect(f.client.calls.filter(c => c.op === 'games').map(c => c.args)).toEqual([[[730], false]])
    expect(f.client.calls.find(c => c.op === 'persona')!.args).toEqual([3])
    await f.backend.stop()
  })
  it('does not treat the SDK default unblocked value as permission', async () => {
    vi.useFakeTimers(); const f = fixture(); f.client.emitPlaying = false
    const pending = f.backend.start(f.context, settings).catch(e => e)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toMatchObject({ code: 'COPY_REQUEST_FAILED' })
    expect(f.client.calls.some(c => ['persona', 'games', 'upload'].includes(c.op))).toBe(false)
    await f.backend.stop()
  })
  it('blocks publishing when playingState says another target session is occupied', async () => {
    const f = fixture(); f.client.playingState = { blocked: true, appid: 440 }
    await expect(f.backend.start(f.context, settings)).rejects.toMatchObject({ code: 'COPY_PLAYING_BLOCKED' })
    expect(f.client.calls.some(c => ['persona', 'games', 'upload'].includes(c.op))).toBe(false); await f.backend.stop()
  })
  it('waits for the initial friend roster rather than calling a missing source a non-friend', async () => {
    const f = fixture(); f.client.emitFriends = false; f.client.myFriends = {}
    expect(await f.backend.start(f.context, settings)).toMatchObject({ waiting: true, warnings: ['COPY_SOURCE_UNAVAILABLE'] })
    f.client.emit('friendsList')
    await expect(f.backend.tick(f.context, settings)).rejects.toMatchObject({ code: 'COPY_SOURCE_NOT_FRIEND' }); await f.backend.stop()
  })
  it('reads a fresh persona for an external friend but never relies on its cached users object', async () => {
    const f = fixture(); f.setLocal({ steamId: OTHER, appId: 550 })
    expect(await f.backend.preview(f.context, settings)).toMatchObject({ source: { authority: 'friend-presence', appId: 730 } })
    await f.backend.stop()
  })
  it('does not use local RunningAppID as proof of server-visible RP', async () => {
    const f = fixture(); f.client.requestRichPresence = async () => ({ users: {} })
    expect(await f.backend.start(f.context, settings)).toMatchObject({ waiting: true, warnings: ['COPY_SOURCE_UNAVAILABLE'] })
    expect(f.client.calls.some(c => ['persona', 'games', 'upload'].includes(c.op))).toBe(false); await f.backend.stop()
  })
  it('does not publish a response returned after local source app changes', async () => {
    const f = fixture(); f.client.onSource = async () => { f.setLocal({ appId: 440 }) }
    await expect(f.backend.start(f.context, settings)).rejects.toMatchObject({ code: 'COPY_SOURCE_STALE' })
    expect(f.client.calls.some(c => c.op === 'upload')).toBe(false); await f.backend.stop()
  })
  it('falls back to game only when raw token or its actual published template is unavailable', async () => {
    for (const raw of ['Rendered text', '#Unpublished']) {
      const f = fixture(); f.client.raw.steam_display = raw
      const report = await f.backend.start(f.context, settings)
      expect(report.warnings).toContain('COPY_TEMPLATE_UNAVAILABLE'); expect(report.source!.fields).toEqual({})
      expect(report.verification).toBe('not-verified')
      expect(f.client.calls.find(c => c.op === 'upload')!.args[1]).toEqual({}); await f.backend.stop()
    }
  })
  it('deduplicates identical published state while refreshing source observation time', async () => {
    const f = fixture(); await f.backend.start(f.context, settings)
    const writes = f.client.calls.filter(c => ['persona', 'games', 'upload'].includes(c.op)).length
    const report = await f.backend.tick(f.context, settings)
    expect(report.source!.observedAt).toBeTruthy(); expect(f.client.calls.filter(c => ['persona', 'games', 'upload'].includes(c.op))).toHaveLength(writes)
    await f.backend.stop()
  })
  it('ignores safe-but-unreferenced raw fields when validating a healthy published template', async () => {
    const f = fixture(); f.client.raw.version = '1'; f.client.raw.status = 'Other text'; f.client.raw['game:server'] = 'private-endpoint'
    const result = await f.backend.start(f.context, settings)
    expect(result.warnings).toEqual([]); expect(result.source!.fields).toEqual({ map: 'Office', steam_display: '#Playing' })
    expect(JSON.stringify(result)).not.toContain('private-endpoint'); await f.backend.stop()
  })
  it('clears its old target game when the source no longer supplies readable status', async () => {
    const f = fixture(); await f.backend.start(f.context, settings); f.setLocal({ appId: 0 })
    const result = await f.backend.tick(f.context, settings)
    expect(result).toMatchObject({ waiting: true, source: null, targetAppId: null, appliedAt: null })
    expect(f.client.calls.filter(c => c.op === 'upload').at(-1)!.args).toEqual([730, {}])
    expect(f.client.calls.filter(c => c.op === 'games').at(-1)!.args).toEqual([[], false]); await f.backend.stop()
  })
  it('does not miss playing-state arriving during the permission check before its wait', async () => {
    const f = fixture(); f.client.emitPlaying = false
    const initial = f.context.checkLocal
    let checks = 0
    f.context.checkLocal = async () => { checks++; if (checks === 15) f.client.emit('playingState', false, 0); return initial() }
    // Deliver after the first readonly sample, before the continuation installs its waiter.
    const original = f.client.getAppRichPresenceLocalization.bind(f.client)
    f.client.getAppRichPresenceLocalization = async () => { const value = await original(); queueMicrotask(() => f.client.emit('playingState', false, 0)); return value }
    expect(await f.backend.start(f.context, settings)).toMatchObject({ waiting: false, targetAppId: 730 }); await f.backend.stop()
  })
  it('switches source app by clearing only the previously owned app before publishing the new one', async () => {
    const f = fixture(); await f.backend.start(f.context, settings); f.setLocal({ appId: 440 }); f.client.sourceApp = 440
    await f.backend.tick(f.context, settings)
    const uploads = f.client.calls.filter(c => c.op === 'upload')
    expect(uploads.map(c => c.args[0])).toEqual([730, 730, 440]); expect(uploads[1]!.args[1]).toEqual({})
    await f.backend.stop()
  })
  it('uses an isolated owned group ID only when requested and never returns it', async () => {
    const f = fixture(); const report = await f.backend.start(f.context, { ...settings, copyGroupSize: true })
    const sent = f.client.calls.find(c => c.op === 'upload')!.args[1] as Record<string, string>
    expect(sent.steam_player_group).toMatch(/^[a-f0-9]{32}$/); expect(sent.steam_player_group).not.toBe(f.client.raw.steam_player_group)
    expect(sent.steam_player_group_size).toBe('3'); expect(JSON.stringify(report)).not.toContain(sent.steam_player_group!)
    await f.backend.stop()
  })
  it('does not retry after a potentially partial upload and still retires the owned CM', async () => {
    const f = fixture(); f.client.failUpload = true
    await expect(f.backend.start(f.context, settings)).rejects.toMatchObject({ code: 'COPY_REQUEST_FAILED' })
    f.setLocal({ steamId: TARGET }); await f.backend.stop()
    expect(f.client.calls.filter(c => c.op === 'upload')).toHaveLength(1); expect(f.client.calls.filter(c => c.op === 'logOff')).toHaveLength(1)
  })
  it('only logs off on a native switch back to target, without clearing its game/RP', async () => {
    const f = fixture(); await f.backend.start(f.context, settings); const before = f.client.calls.length
    f.setLocal({ steamId: TARGET }); await f.backend.stop(); await f.backend.stop()
    expect(f.client.calls.slice(before).map(c => c.op)).toEqual(['logOff'])
  })
  it.each(['blocked', 'disconnected', 'identity'] as const)('does not clear RP after %s changes during asynchronous stop permission checking', async changed => {
    const f = fixture(); await f.backend.start(f.context, settings)
    const wait = deferred<StatusCopyLocalContext>(); f.stopReader.mockImplementationOnce(() => wait.promise)
    const before = f.client.calls.length; const stopping = f.backend.stop()
    await vi.waitFor(() => expect(f.stopReader).toHaveBeenCalledOnce())
    if (changed === 'blocked') { f.client.playingState.blocked = true; f.client.emit('playingState', true, 440) }
    if (changed === 'disconnected') f.client.emit('disconnected')
    if (changed === 'identity') f.client.identity = OTHER
    wait.resolve(f.local()); await stopping
    expect(f.client.calls.slice(before).map(call => call.op)).toEqual(['logOff'])
  })
  it('keeps retirement unknown until a real disconnect is observed', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.backend.start(f.context, settings); f.client.closes = false
    const pending = f.backend.stop().catch(e => e); await vi.advanceTimersByTimeAsync(31)
    expect(await pending).toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    await expect(f.backend.stop()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    f.client.emit('disconnected'); await expect(f.backend.stop()).resolves.toBeUndefined()
  })
  it('cancels a late nonce on stop without constructing any connection', async () => {
    const f = fixture(); const wait = deferred<{ steamId: string; accountName: string; webLogonToken: string }>(); f.login.mockImplementationOnce(() => wait.promise)
    const pending = f.backend.start(f.context, settings).catch(e => e)
    await vi.waitFor(() => expect(f.login).toHaveBeenCalled()); await f.backend.stop()
    wait.resolve({ steamId: TARGET, accountName: 'a', webLogonToken: 'n' })
    expect(await pending).toMatchObject({ code: 'COPY_SESSION_CHANGED' }); expect(f.create).not.toHaveBeenCalled()
  })
})
