import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, type GameStatusSteamClient } from '../src/main/game-status-service'

const ACCOUNT = { id: 'boundary-fixture', steamId: '76561198000000001' }
const APP = 1329410
const PRIVATE = 'FAKE-private-join-value-never-forward'
const services: GameStatusService[] = []

class Client extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  // These are synthetic templates, not observed Mahjong Soul localization data.
  tokens: Record<string, string> = { '#SyntheticRoom': '%room% / %players%', '#SyntheticStatus': '%status%' }
  rp: Record<string, string> = { steam_display: '#SyntheticRoom', room: 'Synthetic Room', players: 'Four players', status: 'Ready', connect: PRIVATE }
  localizedString: string | null = 'Synthetic Room / Four players'
  localizedByLanguage: Partial<Record<'schinese' | 'english', string | null>> = {}
  readLanguages: Array<string | undefined> = []
  writes: Array<Record<string, string>> = []
  games: unknown[] = []
  personas: number[] = []
  logOn(): void {}
  logOff(): void { this.steamID = null }
  gamesPlayed(value: unknown): void { this.games.push(value) }
  setPersona(value: number): void { this.personas.push(value) }
  uploadRichPresence(_app: number, value: Record<string, string>): void { this.writes.push(structuredClone(value)); this.rp = structuredClone(value) }
  async getProductInfo(): Promise<unknown> { return { apps: { [APP]: { appinfo: { common: { name: 'Synthetic game', icon: '0123456789abcdef0123456789abcdef01234567' } } } } } }
  async getAppRichPresenceLocalization(_app: number, _language: string): Promise<unknown> { return { tokens: { ...this.tokens } } }
  async requestRichPresence(_app: number, ids: string[], language?: 'schinese' | 'english'): Promise<{ users: Record<string, { richPresence: Record<string, string>; localizedString: string | null }> }> {
    this.readLanguages.push(language)
    const localizedString = language && Object.hasOwn(this.localizedByLanguage, language) ? this.localizedByLanguage[language]! : this.localizedString
    return { users: { [ids[0]!]: { richPresence: { ...this.rp }, localizedString } } }
  }
}

function fixture(): { client: Client; service: GameStatusService; action(): { accountId: string; sessionId: string } } {
  const client = new Client()
  const service = new GameStatusService({ getActiveAccount: () => ACCOUNT, createClient: () => client })
  services.push(service)
  const action = () => ({ accountId: ACCOUNT.id, sessionId: service.state().sessionId })
  service.connect({ ...action(), accountName: 'synthetic', password: 'FAKE-fixture-password' })
  client.steamID = { getSteamID64: () => ACCOUNT.steamId }
  client.emit('loggedOn')
  return { client, service, action }
}

afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('SDK rich-presence readback must have a safe published explanation', () => {
  it('accepts the exact SDK string from published non-legacy parameters on the first observation', async () => {
    const f = fixture(); const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBe(f.client.localizedString)
    expect(result.live!.fields).toMatchObject({ room: 'Synthetic Room', players: 'Four players' })
    expect(result.live!.editableKeys).toContain('room')
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    expect(f.client.writes).toEqual([]); expect(f.client.games).toEqual([]); expect(f.client.personas).toEqual([])
  })
  it('never substitutes a local preview for absent or mismatched SDK text', async () => {
    const f = fixture(); f.client.localizedString = 'Different SDK string'
    expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
    f.client.localizedString = null
    expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
  })
  it('withholds text when the published localization catalog is unavailable', async () => {
    const f = fixture(); vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockRejectedValue(new Error('FAKE-private-network-error'))
    const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBeNull(); expect(result.live!.game!.name).toBe('Synthetic game')
    expect(result.live!.fields.status).toBe('Ready'); expect(JSON.stringify(result)).not.toContain(PRIVATE)
  })
  it.each(['unknown_field', 'j'])('withholds an unpublished private field named %s even if its name passes the generic parameter syntax', async key => {
    const f = fixture(); f.client.rp[key] = PRIVATE; f.client.localizedString = `Joined ${PRIVATE}`
    const result = await f.service.observeLive(f.action())
    expect(result.live!.fields).not.toHaveProperty(key); expect(result.live!.localizedString).toBeNull()
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
  })
  it('withholds private-token derived SDK strings that do not contain the original raw token', async () => {
    const f = fixture(); f.client.rp.connect = '#SyntheticPrivateLabel'; f.client.tokens['#SyntheticPrivateLabel'] = 'FAKE-derived-private-value'; f.client.localizedString = 'FAKE-derived-private-value'
    const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBeNull()
    expect(result.live!.fields).not.toHaveProperty('connect')
  })
  it('keeps the known-private-value check as an extra defense despite a matching safe template', async () => {
    const f = fixture(); f.client.rp.steam_display = '#SyntheticStatus'; f.client.rp.status = PRIVATE; f.client.localizedString = PRIVATE
    expect((await f.service.observeLive(f.action())).live!.localizedString).toBeNull()
  })
  it('never exposes a template that needs a sensitive parameter', async () => {
    const f = fixture(); f.client.tokens['#Unsafe'] = '%connect%'; f.client.rp.steam_display = '#Unsafe'; f.client.localizedString = PRIVATE
    const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBeNull()
    expect(result.live!.fields).not.toHaveProperty('connect')
  })
  it('permits editing an observed published room without accepting an unpublished unknown field', async () => {
    const f = fixture(); f.client.rp.unpublished = 'hidden'; const result = await f.service.observeLive(f.action())
    await expect(f.service.patchLive({ ...f.action(), snapshotId: result.live!.snapshotId, changes: { unpublished: 'no' } })).rejects.toThrow()
    await f.service.patchLive({ ...f.action(), snapshotId: result.live!.snapshotId, changes: { room: 'Edited room' } })
    expect(f.client.rp.room).toBe('Edited room'); expect(f.client.rp.connect).toBe(PRIVATE); expect(f.client.rp.unpublished).toBe('hidden')
    expect(f.client.writes).toHaveLength(1); expect(f.client.games).toEqual([]); expect(f.client.personas).toEqual([])
  })
})

describe('full merged Steam rich-presence payload limits', () => {
  it('refuses a template merge above twenty keys without deleting any existing private or unknown fields', async () => {
    const f = fixture(); f.client.rp = { steam_display: '#SyntheticStatus', status: 'Ready', connect: PRIVATE, ...Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`unknown_${index}`, 'keep'])) }
    const original = structuredClone(f.client.rp); const observed = await f.service.observeLive(f.action())
    await expect(f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.live!.snapshotId, lock: true, presence: { displayToken: '#SyntheticRoom', values: { room: 'New room', players: 'Four' } } })).rejects.toThrow('完整游戏详细状态')
    expect(f.client.writes).toEqual([]); expect(f.client.rp).toEqual(original); expect(f.service.state().liveLock).toBeNull()
  })
  it.each(['key', 'value'] as const)('refuses an oversized inherited %s in the full map before any upload', async kind => {
    const f = fixture(); if (kind === 'key') f.client.rp['x'.repeat(64)] = 'keep'; else f.client.rp.unknown = 'x'.repeat(256)
    const original = structuredClone(f.client.rp); const observed = await f.service.observeLive(f.action())
    await expect(f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Edited' } })).rejects.toThrow('完整游戏详细状态')
    expect(f.client.writes).toEqual([]); expect(f.client.rp).toEqual(original)
  })
  it('preserves private and unknown game fields when the full map fits the protocol', async () => {
    const f = fixture(); f.client.rp.unknown_field = 'Keep latest value'; const observed = await f.service.observeLive(f.action())
    await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.live!.snapshotId, lock: false, presence: { displayToken: '#SyntheticStatus', values: { status: 'Edited public status' } } })
    expect(f.client.writes).toHaveLength(1)
    expect(f.client.writes[0]).toMatchObject({ connect: PRIVATE, unknown_field: 'Keep latest value', steam_display: '#SyntheticStatus', status: 'Edited public status' })
    expect(JSON.stringify(f.service.state())).not.toContain(PRIVATE)
  })
  it('a later game expansion cannot make a lock upload an oversized map', async () => {
    vi.useFakeTimers(); const f = fixture(); const observed = await f.service.observeLive(f.action())
    await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Locked' } })
    const writes = f.client.writes.length; f.client.rp.status = 'Game update'
    Object.assign(f.client.rp, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`unknown_${index}`, 'keep'])))
    const original = structuredClone(f.client.rp)
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    expect(f.client.writes).toHaveLength(writes); expect(f.client.rp).toEqual(original)
    expect(f.service.state().liveLock!.status).toBe('retrying'); expect(f.service.state().liveLock!.matched).toBe(false)
  })
})

describe('application catalog language and successful-inspection ordering', () => {
  it('uses a newly inspected English catalog after the earlier Chinese lookup failed', async () => {
    const f = fixture(); let initiallyUnavailable = true
    const lookup = vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockImplementation(async (_app, language) => {
      if (initiallyUnavailable || language === 'schinese') throw new Error('Synthetic localization unavailable')
      return { tokens: { ...f.client.tokens } }
    })
    const observed = await f.service.observeLive(f.action())
    expect(observed.live!.localizedString).toBeNull()
    initiallyUnavailable = false
    const english = await f.service.inspectApp({ ...f.action(), appId: APP, language: 'english' })
    expect(english.templateStatus).toBe('available'); expect(english.language).toBe('english')
    const before = lookup.mock.calls.length
    const result = await f.service.setLiveDisplay({ ...f.action(), snapshotId: observed.live!.snapshotId, lock: false, presence: { displayToken: '#SyntheticRoom', values: { room: 'Edited room', players: 'Four players' } } })
    expect(result.lastOperation!.outcome).toBe('matched')
    expect(f.client.writes).toHaveLength(1); expect(f.client.writes[0]).toMatchObject({ steam_display: '#SyntheticRoom', room: 'Edited room', players: 'Four players' })
    expect(lookup.mock.calls).toHaveLength(before)
    expect(f.client.readLanguages.slice(-2)).toEqual(['english', 'english'])
  })
  it('uses the last successful refresh even when the same catalog key is updated in the same millisecond', async () => {
    vi.useFakeTimers(); const f = fixture(); let english = 'First English'
    vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockImplementation(async (_app, language) => ({ tokens: { '#SyntheticStatus': `${language === 'english' ? english : 'Chinese'}: %status%` } }))
    await f.service.inspectApp({ ...f.action(), appId: APP, language: 'english' })
    await f.service.inspectApp({ ...f.action(), appId: APP, language: 'schinese' })
    english = 'Refreshed English'
    await f.service.inspectApp({ ...f.action(), appId: APP, language: 'english' })
    f.client.emit('playingState', false, 0)
    const result = await f.service.play({ ...f.action(), displayKind: 'app', appId: APP, gameName: '', details: '', presence: { displayToken: '#SyntheticStatus', values: { status: 'Ready' } } })
    expect(result.playing!.preview).toBe('Refreshed English: Ready')
  })
  it('does not let a newer unavailable language lookup hide an existing verified catalog', async () => {
    const f = fixture(); await f.service.inspectApp({ ...f.action(), appId: APP, language: 'english' })
    vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockRejectedValue(new Error('Synthetic unavailable'))
    const unavailable = await f.service.inspectApp({ ...f.action(), appId: APP, language: 'schinese' })
    expect(unavailable.templateStatus).toBe('unavailable')
    const result = await f.service.observeLive(f.action())
    expect(result.live!.localizedString).toBe('Synthetic Room / Four players')
    expect(f.client.readLanguages.at(-1)).toBe('english')
  })
  it('requests actual SDK readback in the same effective language as its published catalog', async () => {
    const f = fixture(); f.client.rp.steam_display = '#SyntheticStatus'
    vi.spyOn(f.client, 'getAppRichPresenceLocalization').mockImplementation(async (_app, language) => ({ tokens: { '#SyntheticStatus': `${language === 'schinese' ? 'Chinese' : 'English'}: %status%` } }))
    f.client.localizedByLanguage = { schinese: 'Chinese: Ready', english: 'English: Ready' }
    const chinese = await f.service.observeLive(f.action())
    expect(chinese.live!.localizedString).toBe('Chinese: Ready'); expect(f.client.readLanguages.at(-1)).toBe('schinese')
    await f.service.inspectApp({ ...f.action(), appId: APP, language: 'english' })
    const english = await f.service.observeLive(f.action())
    expect(english.live!.localizedString).toBe('English: Ready'); expect(f.client.readLanguages.at(-1)).toBe('english')
    expect(f.client.writes).toEqual([]); expect(f.client.games).toEqual([]); expect(f.client.personas).toEqual([])
  })
})
