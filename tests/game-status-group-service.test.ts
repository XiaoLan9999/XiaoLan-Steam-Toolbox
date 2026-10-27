import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, type GameStatusSteamClient } from '../src/main/game-status-service'
import { LocalAppSimulationService, type LocalAppSimulationHost, type LocalAppSimulationRead } from '../src/main/local-app-simulation'
import type { LocalAppSimulationContext } from '../src/main/local-app-simulation-context'
import type { GameStatusAppInfo, GameStatusDraft } from '../src/shared/game-status'
import type { LocalAppSimulationStartInput } from '../src/shared/local-app-simulation'
import { GROUP_SIZE_KEY, MAX_GROUP_SIZE } from '../src/shared/game-status-group'
import { gameStatusTemplatesFromTokens, sanitizeGameStatusPresence } from '../src/shared/game-status-presence'

const SELF = { id: 'group-fixture', steamId: '76561198000000001' }
const GROUP_ID = 'fixture-opaque-group-id-not-for-renderer'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers() })

class Host implements LocalAppSimulationHost {
  fields: Record<string, string> = {}
  writes: Array<Record<string, string | null>> = []
  starts = 0
  async begin() { this.starts++; return this.result() }
  async apply(changes: Record<string, string | null>) { this.writes.push({ ...changes }); for (const [key, value] of Object.entries(changes)) { if (value === null) delete this.fields[key]; else this.fields[key] = value }; return this.result() }
  async read() { return this.result() }
  private result(): LocalAppSimulationRead { return { fields: { ...this.fields }, localizedString: null, verificationSource: 'local-cache' } }
  stop() {}
  async shutdown() {}
}
function simulation(catalog: Record<string, string> = { '#Fixture': '%status%' }) {
  const host = new Host()
  const info: GameStatusAppInfo = { appId: 730, name: 'Fixture game', iconUrl: null, language: 'english', templates: gameStatusTemplatesFromTokens(catalog), templateStatus: 'available' }
  const context: LocalAppSimulationContext = { appId: 0, activeAppIds: [], steamId: SELF.steamId, steamPid: 100, steamStartTicks: '638965000000000001', steamExe: 'D:/Steam/steam.exe', ownerPid: 101, ownerStartTicks: '638965000000000002' }
  const service = new LocalAppSimulationService({ getActiveAccount: () => SELF, getWorkerPath: () => 'D:/fixture/worker.exe', host, readContext: async () => ({ ...context }), readMetadata: async () => info })
  cleanups.push(() => service.shutdown())
  return { service, host, action: () => ({ accountId: SELF.id, sessionId: service.state().sessionId }) }
}

class LiveClient extends EventEmitter implements GameStatusSteamClient {
  readonly presenceSource = 'local-cache' as const
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: 730 }
  raw: Record<string, string> = { desc: 'Fixture game', steam_player_group: GROUP_ID, [GROUP_SIZE_KEY]: '2' }
  logOn() { this.steamID = { getSteamID64: () => SELF.steamId }; this.emit('loggedOn'); this.emit('playingState', true, 730) }
  logOff() { this.steamID = null }
  setPersona(): never { throw new Error('No personal CM') }
  gamesPlayed(): never { throw new Error('No personal CM') }
  uploadRichPresence(): never { throw new Error('No CM upload') }
  async requestRichPresence(_app: number, ids: string[]) { return { users: { [ids[0]!]: { richPresence: { ...this.raw }, localizedString: 'Players: 2', displayTokenReadable: false } } } }
}
function live() {
  const client = new LiveClient(); const writes: Array<Record<string, string | null>> = []; const snapshots: unknown[] = []
  const service = new GameStatusService({ getActiveAccount: () => SELF, createLocalClient: () => client, onChange: state => snapshots.push(state), nativeWriter: {
    stop() {}, async apply(_context, changes) { writes.push({ ...changes }); for (const [key, value] of Object.entries(changes)) { if (value === null) delete client.raw[key]; else client.raw[key] = value } }
  } })
  cleanups.push(() => service.dispose())
  const action = () => ({ accountId: SELF.id, sessionId: service.snapshot().sessionId })
  service.connectLocal(action())
  return { service, client, writes, snapshots, action }
}

describe('dedicated local simulation group-size field', () => {
  it.each([1, 2, MAX_GROUP_SIZE])('merges canonical size %s separately from ordinary templates', async groupSize => {
    const f = simulation(); const state = await f.service.start({ ...f.action(), appId: 730, groupSize })
    expect(f.host.writes).toEqual([{ [GROUP_SIZE_KEY]: String(groupSize) }])
    expect(state.fields[GROUP_SIZE_KEY]).toBe(String(groupSize)); expect(JSON.stringify(state)).not.toContain('steam_player_group"')
  })
  it.each([0, -1, 1.5, MAX_GROUP_SIZE + 1, NaN, Infinity, '2', '02', true, {}])('rejects invalid size %j before starting a helper', async groupSize => {
    const f = simulation()
    await expect(f.service.start({ ...f.action(), appId: 730, groupSize } as LocalAppSimulationStartInput)).rejects.toMatchObject({ code: 'LOCAL_APP_INVALID_INPUT' })
    expect(f.host.starts).toBe(0); expect(f.host.writes).toEqual([])
  })
  it.each([undefined, null])('removes only the previously owned size when cleared with %s', async groupSize => {
    const f = simulation(); await f.service.start({ ...f.action(), appId: 730, groupSize: 2 })
    const state = await f.service.start({ ...f.action(), appId: 730, groupSize })
    expect(f.host.starts).toBe(1); expect(f.host.writes.at(-1)).toEqual({ [GROUP_SIZE_KEY]: null }); expect(state.fields).toEqual({})
  })
  it('merges size with published template fields, and changing size does not resend unchanged text', async () => {
    const f = simulation(); await f.service.inspect({ ...f.action(), appId: 730 })
    const presence = { displayToken: '#Fixture', values: { status: 'Fixture' } }
    await f.service.start({ ...f.action(), appId: 730, presence, groupSize: 2 })
    expect(f.host.writes[0]).toEqual({ status: 'Fixture', [GROUP_SIZE_KEY]: '2', steam_display: '#Fixture' })
    await f.service.start({ ...f.action(), appId: 730, presence, groupSize: 3 })
    expect(f.host.writes.at(-1)).toEqual({ [GROUP_SIZE_KEY]: '3' }); expect(f.host.starts).toBe(1)
  })
  it('reserves one of Steam\'s twenty fields for the worker-owned opaque group ID', async () => {
    const variables = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`value_${index}`, 'fixture']))
    const f = simulation({ '#Fixture': Object.keys(variables).map(key => `%${key}%`).join(' ') })
    await f.service.inspect({ ...f.action(), appId: 730 })
    await expect(f.service.start({ ...f.action(), appId: 730, groupSize: 2, presence: { displayToken: '#Fixture', values: variables } })).rejects.toMatchObject({ code: 'LOCAL_APP_INVALID_INPUT' })
    expect(f.host.starts).toBe(0)
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: variables } }); expect(f.host.starts).toBe(1)
  })
})

describe('observed real-game group size without exposing its group ID', () => {
  it('shows a size-only RP result as editable rather than empty', async () => {
    const f = live(); f.client.raw = { [GROUP_SIZE_KEY]: '2', steam_player_group: GROUP_ID }
    const state = await f.service.observeLive(f.action())
    expect(state.live?.fields).toEqual({ [GROUP_SIZE_KEY]: '2' }); expect(state.live?.editableKeys).toEqual([GROUP_SIZE_KEY])
    expect(state.live?.localizedString).toBe('Players: 2'); expect(JSON.stringify(f.snapshots)).not.toContain(GROUP_ID)
  })
  it('patches and restores only the observed size, preserving private group identity', async () => {
    const f = live(); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { [GROUP_SIZE_KEY]: '3' } })
    await f.service.restoreLive(f.action())
    expect(f.writes).toEqual([{ [GROUP_SIZE_KEY]: '3' }, { [GROUP_SIZE_KEY]: '2' }]); expect(f.client.raw.steam_player_group).toBe(GROUP_ID)
    expect(JSON.stringify(f.snapshots)).not.toContain(GROUP_ID)
  })
  it('locks and safely restores the size without inventing or updating a group ID', async () => {
    vi.useFakeTimers(); const f = live(); const observed = await f.service.observeLive(f.action())
    const locked = await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { [GROUP_SIZE_KEY]: '4' } })
    expect(locked.liveLock?.desired).toEqual({ [GROUP_SIZE_KEY]: '4' }); await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    await f.service.unlockLive({ ...f.action(), restore: true })
    expect(f.writes).toEqual([{ [GROUP_SIZE_KEY]: '4' }, { [GROUP_SIZE_KEY]: '2' }]); expect(JSON.stringify(f.snapshots)).not.toContain(GROUP_ID)
  })
  it.each(['', '0', '-1', '+2', '02', '2.0', ' 2', '2147483648', '2\n'])('rejects noncanonical live size %j', async value => {
    const f = live(); const observed = await f.service.observeLive(f.action())
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { [GROUP_SIZE_KEY]: value } })).rejects.toThrow()
    expect(f.writes).toEqual([])
  })
  it('still requires an observed size field and rejects every other group key', async () => {
    const f = live(); delete f.client.raw[GROUP_SIZE_KEY]; const observed = await f.service.observeLive(f.action())
    for (const key of [GROUP_SIZE_KEY, 'steam_player_group', 'steam_player_group_size_extra', 'Steam_Player_Group_Size', 'groupid']) {
      await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { [key]: '2' } })).rejects.toThrow()
    }
    expect(f.writes).toEqual([])
  })
  it('does not expose a malformed size as an editable field', async () => {
    const f = live(); f.client.raw[GROUP_SIZE_KEY] = '02'; const state = await f.service.observeLive(f.action())
    expect(state.live?.fields).not.toHaveProperty(GROUP_SIZE_KEY); expect(state.live?.editableKeys).not.toContain(GROUP_SIZE_KEY)
  })
})

describe('group-size drafts remain numeric and contain no group identity', () => {
  it('saves/loads only the user-entered integer and strips unrelated identity properties', async () => {
    const f = live(); const draft = { displayKind: 'app', appId: 730, gameName: '', details: '', groupSize: 2, steam_player_group: GROUP_ID } as GameStatusDraft
    expect(await f.service.saveDraft({ ...f.action(), draft })).toEqual({ displayKind: 'app', appId: 730, gameName: '', details: '', groupSize: 2 })
    expect(await f.service.loadDraft(f.action())).toEqual({ displayKind: 'app', appId: 730, gameName: '', details: '', groupSize: 2 })
    expect(JSON.stringify(f.snapshots)).not.toContain(GROUP_ID)
  })
  it.each([0, -1, 1.5, MAX_GROUP_SIZE + 1, '2'])('rejects invalid draft size %j', async groupSize => {
    const f = live()
    await expect(f.service.saveDraft({ ...f.action(), draft: { displayKind: 'app', appId: 730, gameName: '', details: '', groupSize } as GameStatusDraft })).rejects.toThrow()
  })
  it('does not allow ordinary template input to smuggle in a group ID or size', () => {
    for (const key of ['steam_player_group', GROUP_SIZE_KEY, 'Steam_Player_Group_Size']) {
      expect(() => sanitizeGameStatusPresence({ displayToken: '#Fixture', values: { [key]: '2' } })).toThrow()
      expect(gameStatusTemplatesFromTokens({ '#Fixture': `%${key}%` })).toEqual([])
    }
  })
})
