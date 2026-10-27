import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeGameStatusClient, type NativeGameStatusContext, type NativeGameStatusBroker } from '../src/main/native-game-status-client'
import { NativePresenceError, type NativePresenceContext, type NativePresenceRead } from '../src/main/native-presence-broker'
import { GameStatusService, type GameStatusSteamClient } from '../src/main/game-status-service'

const SELF = '76561198000000001'
const OTHER = '76561198000000002'
const APP = 1329410
const NATIVE: NativeGameStatusContext = { appId: APP, steamId: SELF, steamPid: 1234, steamStartTicks: '638964000000000001', steamExe: 'D:/Steam/steam.exe' }
const PUBLIC: NativePresenceRead = { fields: { desc: 'Native fixture room' }, localizedString: 'Native fixture room', displayTokenReadable: false, verificationSource: 'local-cache', keyCount: 3 }
const clients: NativeGameStatusClient[] = []
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }

class Broker implements NativeGameStatusBroker {
  calls: Array<{ context: NativePresenceContext; permitted: () => boolean }> = []
  stops = 0
  beginnings = 0
  listeners = new Set<(error: NativePresenceError) => void>()
  result = PUBLIC
  gate: ReturnType<typeof deferred<NativePresenceRead>> | null = null
  async read(context: NativePresenceContext, permitted: () => boolean) {
    this.calls.push({ context: { ...context }, permitted })
    if (!permitted()) throw new NativePresenceError('NATIVE_CANCELLED')
    return this.gate ? await this.gate.promise : { ...this.result, fields: { ...this.result.fields } }
  }
  stop() { this.stops++ }
  beginContext() { this.beginnings++; this.stop() }
  onContextLost(listener: (error: NativePresenceError) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  lose(code: string) { for (const listener of this.listeners) listener(new NativePresenceError(code)) }
}
class Metadata extends EventEmitter implements GameStatusSteamClient {
  steamID = null
  calls: Array<Record<string, unknown>> = []
  stopped = 0
  gate: ReturnType<typeof deferred<unknown>> | null = null
  logOn(details: Record<string, unknown>) { this.calls.push({ ...details }); queueMicrotask(() => this.emit('loggedOn')) }
  logOff() { this.stopped++ }
  setPersona(): never { throw new Error('No persona allowed') }
  gamesPlayed(): never { throw new Error('No playing state allowed') }
  uploadRichPresence(): never { throw new Error('No CM writes allowed') }
  async requestRichPresence(): ReturnType<GameStatusSteamClient['requestRichPresence']> { throw new Error('No personal readback allowed') }
  async getProductInfo(apps: number[], packages: number[], includeTokens?: boolean): Promise<unknown> {
    this.calls.push({ apps, packages, includeTokens })
    return this.gate ? await this.gate.promise : { apps: { [APP]: { appinfo: { common: { name: 'Anonymous fixture game', icon: 'a'.repeat(40) } } } } }
  }
}
function fixture() {
  let context = { ...NATIVE }
  const broker = new Broker()
  const detector = vi.fn(async () => ({ ...context }))
  const metadata = new Metadata()
  const createMetadataClient = vi.fn(() => metadata)
  const client = new NativeGameStatusClient({ broker, steamId: SELF, detectContext: detector, createMetadataClient })
  clients.push(client)
  const errors: Error[] = []; const playing: unknown[][] = []; const loggedOn = vi.fn()
  client.on('error', error => errors.push(error)); client.on('playingState', (...args) => playing.push(args)); client.on('loggedOn', loggedOn)
  return { client, broker, detector, metadata, createMetadataClient, errors, playing, loggedOn, setContext(next: Partial<NativeGameStatusContext>) { context = { ...context, ...next } } }
}
afterEach(() => { for (const client of clients.splice(0)) client.logOff(); vi.useRealTimers() })

describe('local Steam presence attachment without a personal CM session', () => {
  it('attaches through a native identity read before emitting loggedOn and never requests metadata credentials', async () => {
    const f = fixture(); const gate = deferred<NativePresenceRead>(); f.broker.gate = gate
    const pending = f.client.logOn({ steamID: SELF }); await flush()
    expect(f.loggedOn).not.toHaveBeenCalled(); expect(f.client.steamID).toBeNull()
    expect(f.broker.calls).toHaveLength(1); expect(f.broker.beginnings).toBe(1)
    expect(f.broker.calls[0]!.context).toEqual({ appId: APP, steamId: SELF, steamPid: NATIVE.steamPid, steamStartTicks: NATIVE.steamStartTicks })
    expect(f.createMetadataClient).not.toHaveBeenCalled()
    gate.resolve(PUBLIC); await pending
    expect(f.client.presenceSource).toBe('local-cache'); expect(f.client.steamID?.getSteamID64()).toBe(SELF)
    expect(f.loggedOn).toHaveBeenCalledTimes(1); expect(f.playing).toEqual([[true, APP]])
    expect(f.client.playingState).toEqual({ blocked: true, appid: APP })
  })

  it('does not consider a stale native attachment successful after logOff', async () => {
    const f = fixture(); const gate = deferred<NativePresenceRead>(); f.broker.gate = gate
    const pending = f.client.logOn({}); const rejected = expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    await flush(); f.client.logOff(); expect(f.broker.calls[0]!.permitted()).toBe(false)
    gate.resolve(PUBLIC); await rejected
    expect(f.client.steamID).toBeNull(); expect(f.loggedOn).not.toHaveBeenCalled()
    expect(f.playing).toEqual([])
  })

  it('rejects a duplicate in-flight attachment without opening a second native connection', async () => {
    const f = fixture(); const gate = deferred<NativePresenceRead>(); f.broker.gate = gate
    const first = f.client.logOn({}); await flush()
    await expect(f.client.logOn({})).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.broker.calls).toHaveLength(1); expect(f.broker.beginnings).toBe(1)
    gate.resolve(PUBLIC); await first
    expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ appId: 0 }, 'GAME_STATUS_NO_LIVE_GAME'],
    [{ steamId: OTHER }, 'GAME_STATUS_IDENTITY_MISMATCH'],
    [{ steamPid: 0 }, 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE'],
    [{ steamStartTicks: '' }, 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE'],
    [{ steamExe: 'D:/Steam/not-steam.exe' }, 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE']
  ] as const)('refuses an invalid initial local context %# without touching native APIs', async (changes, code) => {
    const f = fixture(); f.setContext(changes)
    await f.client.logOn({})
    expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatchObject({ code })
    expect(f.broker.calls).toEqual([]); expect(f.loggedOn).not.toHaveBeenCalled(); expect(f.client.steamID).toBeNull()
  })

  it('rejects mismatched caller identity before even reading the registry detector', async () => {
    const f = fixture()
    await expect(f.client.logOn({ steamID: OTHER })).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    expect(f.detector).not.toHaveBeenCalled(); expect(f.broker.calls).toEqual([])
  })

  it('returns only the current account and app public cache, with localized text not mistaken for a raw token', async () => {
    const f = fixture(); await f.client.logOn({})
    const result = await f.client.requestRichPresence(APP, [SELF])
    expect(result).toEqual({ users: { [SELF]: { richPresence: { desc: 'Native fixture room' }, localizedString: 'Native fixture room', displayTokenReadable: false, verificationSource: 'local-cache' } } })
    expect(result.users[SELF]!.richPresence).not.toHaveProperty('steam_display')
    for (const [app, ids] of [[730, [SELF]], [APP, [OTHER]], [APP, [SELF, OTHER]], [APP, []]] as const) await expect(f.client.requestRichPresence(app, [...ids])).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.broker.calls).toHaveLength(2); expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('rejects fake persona, gamesPlayed, and CM upload operations locally', async () => {
    const f = fixture(); await f.client.logOn({})
    for (const action of [() => f.client.setPersona(), () => f.client.gamesPlayed(), () => f.client.uploadRichPresence()]) expect(action).toThrow()
    expect(f.broker.calls).toHaveLength(1); expect(f.createMetadataClient).not.toHaveBeenCalled()
  })

  it.each([
    { appId: 730 }, { steamId: OTHER }, { steamPid: 1235 }, { steamStartTicks: '638964000000000002' }, { steamExe: 'E:/Other/steam.exe' }, { appId: 0, steamId: OTHER }, { appId: 0, steamPid: 1235 }
  ])('polling stops the old connection on local Steam/game context change %# without automatic replay', async changed => {
    vi.useFakeTimers(); const f = fixture(); await f.client.logOn({})
    f.setContext(changed); await vi.advanceTimersByTimeAsync(1000); await flush()
    expect(f.client.steamID).toBeNull(); expect(f.errors).toHaveLength(1)
    expect(f.playing.at(-1)).toEqual([false, 0]); expect(f.broker.calls).toHaveLength(1)
    const detections = f.detector.mock.calls.length
    f.setContext(NATIVE); await vi.advanceTimersByTimeAsync(30000)
    expect(f.detector).toHaveBeenCalledTimes(detections); expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect or access presence APIs during an unchanged one-second poll', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.logOn({})
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.detector).toHaveBeenCalledTimes(16); expect(f.broker.calls).toHaveLength(1)
    expect(f.loggedOn).toHaveBeenCalledTimes(1); expect(f.broker.beginnings).toBe(1)
  })

  it('a read detects identity changes before sending another native request', async () => {
    const f = fixture(); await f.client.logOn({}); f.setContext({ steamId: OTHER })
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    expect(f.broker.calls).toHaveLength(1); expect(f.client.steamID).toBeNull()
  })

  it.each(['NATIVE_EXITED', 'NATIVE_TIMEOUT', 'NATIVE_PROTOCOL_INVALID', 'NATIVE_SET_REJECTED'])('does not discard the service recovery ledger by retiring the client for %s', async code => {
    const f = fixture(); await f.client.logOn({}); const stops = f.broker.stops
    f.broker.lose(code)
    expect(f.errors).toEqual([]); expect(f.client.steamID?.getSteamID64()).toBe(SELF); expect(f.broker.stops).toBe(stops)
    await f.client.requestRichPresence(APP, [SELF])
    expect(f.loggedOn).toHaveBeenCalledTimes(1); expect(f.broker.calls).toHaveLength(2)
  })

  it('retires immediately only when the native provider proves its original game/identity context changed', async () => {
    const f = fixture(); await f.client.logOn({})
    f.broker.lose('NATIVE_CONTEXT_CHANGED')
    expect(f.errors[0]).toMatchObject({ code: 'GAME_STATUS_NATIVE_CONTEXT' }); expect(f.client.steamID).toBeNull()
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toThrow()
    expect(f.broker.calls).toHaveLength(1)
  })

  it.each(['detector-rejection', 'invalid-pid', 'invalid-app', 'invalid-path', 'zero-app'] as const)('pauses on %s without claiming proven context change or reopening automatically', async kind => {
    vi.useFakeTimers(); const f = fixture(); const unavailable = vi.fn(); f.client.on('nativeContextUnavailable', unavailable)
    await f.client.logOn({})
    if (kind === 'detector-rejection') f.detector.mockRejectedValueOnce(new Error('FAKE_PRIVATE_DETECTOR_FAILURE'))
    else if (kind === 'invalid-pid') f.setContext({ steamPid: 0 })
    else if (kind === 'invalid-app') f.setContext({ appId: Number.NaN })
    else if (kind === 'zero-app') f.setContext({ appId: 0 })
    else f.setContext({ steamExe: 'invalid-relative-image' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(unavailable).toHaveBeenCalledTimes(1); expect(unavailable.mock.calls[0]![0]).toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.client.steamID?.getSteamID64()).toBe(SELF); expect(f.errors).toEqual([]); expect(f.playing).toEqual([[true, APP]])
    const calls = f.detector.mock.calls.length; f.setContext(NATIVE)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.detector).toHaveBeenCalledTimes(calls); expect(f.broker.calls).toHaveLength(1)
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.broker.calls).toHaveLength(1)
    await f.client.revalidateContext()
    expect(f.broker.calls).toHaveLength(2); expect(f.broker.beginnings).toBe(1)
    await f.client.requestRichPresence(APP, [SELF]); expect(f.broker.calls).toHaveLength(3)
    expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('only an explicit successful revalidation clears a paused native detector gate', async () => {
    const f = fixture(); const unavailable = vi.fn(); f.client.on('nativeContextUnavailable', unavailable)
    await f.client.logOn({}); f.detector.mockRejectedValueOnce(new Error('FAKE_PRIVATE_READ_FAILURE'))
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.errors).toEqual([]); expect(unavailable).toHaveBeenCalledTimes(1)
    f.detector.mockRejectedValueOnce(new Error('Still unavailable'))
    await expect(f.client.revalidateContext()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.broker.calls).toHaveLength(1)
    await f.client.revalidateContext(); expect(f.broker.calls).toHaveLength(2)
    expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('treats a proven mismatch after a detector pause as fatal without permitting another native read', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.logOn({})
    f.detector.mockRejectedValueOnce(new Error('Unavailable')); await vi.advanceTimersByTimeAsync(1000)
    f.setContext({ steamId: OTHER })
    await expect(f.client.revalidateContext()).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    expect(f.client.steamID).toBeNull(); expect(f.errors).toHaveLength(1); expect(f.broker.calls).toHaveLength(1)
  })

  it('suspends rather than retiring when the worker cannot verify liveness', async () => {
    const f = fixture(); const unavailable = vi.fn(); f.client.on('nativeContextUnavailable', unavailable)
    await f.client.logOn({}); f.broker.lose('NATIVE_CONTEXT_UNAVAILABLE')
    expect(unavailable).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([])
    expect(f.client.steamID?.getSteamID64()).toBe(SELF)
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.broker.calls).toHaveLength(1)
  })

  it('keeps a zero-app read paused until an explicit nonzero revalidation of the original context', async () => {
    vi.useFakeTimers(); const f = fixture(); const unavailable = vi.fn(); f.client.on('nativeContextUnavailable', unavailable)
    await f.client.logOn({}); f.setContext({ appId: 0 })
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.client.steamID?.getSteamID64()).toBe(SELF); expect(f.errors).toEqual([]); expect(f.playing).toEqual([[true, APP]])
    await expect(f.client.revalidateContext()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.broker.calls).toHaveLength(1); expect(f.broker.beginnings).toBe(1)
    f.setContext({ appId: APP }); await vi.advanceTimersByTimeAsync(15000)
    expect(f.broker.calls).toHaveLength(1)
    await expect(f.client.requestRichPresence(APP, [SELF])).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    await f.client.revalidateContext(); expect(f.broker.calls).toHaveLength(2)
    expect(unavailable).toHaveBeenCalledTimes(1); expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('preserves a locked edit through RunningAppID zero and permits manual restore without resurrecting the lock', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.metadata.logOn = details => { f.metadata.calls.push(details); f.metadata.emit('loggedOn') }
    const writes: Array<Record<string, string | null>> = []
    const service = new GameStatusService({
      getActiveAccount: () => ({ id: 'zero-app-fixture', steamId: SELF }),
      createLocalClient: () => f.client,
      nativeWriter: {
        stop: () => f.broker.stop(),
        apply: async (_context, changes, permitted) => {
          if (!permitted()) throw new Error('Synthetic cancelled write')
          writes.push({ ...changes })
          const fields = { ...f.broker.result.fields }
          for (const [key, value] of Object.entries(changes)) { if (value === null) delete fields[key]; else fields[key] = value }
          f.broker.result = { ...f.broker.result, fields, localizedString: fields.desc ?? null }
        }
      }
    })
    const action = () => ({ accountId: 'zero-app-fixture', sessionId: service.state().sessionId })
    try {
      service.connectLocal(action()); await flush()
      const live = (await service.observeLive(action())).live!
      await service.lockLive({ ...action(), snapshotId: live.snapshotId, changes: { desc: 'Fixture locked description' } })
      expect(writes).toHaveLength(1)
      f.setContext({ appId: 0 }); await vi.advanceTimersByTimeAsync(1000)
      expect(service.state()).toMatchObject({ connected: true, live: { patchActive: true }, liveLock: { status: 'stopped', nextCheckAt: null }, failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' } })
      await expect(service.observeLive(action())).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
      expect(service.state().live?.patchActive).toBe(true)
      f.setContext({ appId: APP }); await vi.advanceTimersByTimeAsync(15000)
      expect(writes).toHaveLength(1)
      await service.observeLive(action()); await vi.advanceTimersByTimeAsync(15000)
      expect(service.state().liveLock?.status).toBe('stopped'); expect(writes).toHaveLength(1)
      const restored = await service.restoreLive(action())
      expect(restored.live?.patchActive).toBe(false); expect(writes).toEqual([{ desc: 'Fixture locked description' }, { desc: PUBLIC.fields.desc }])
      expect(f.loggedOn).toHaveBeenCalledTimes(1); expect(f.broker.beginnings).toBe(1)
    } finally { service.dispose() }
  })
})

describe('anonymous product metadata is separate from local presence', () => {
  it('creates the optional metadata client lazily, logs on anonymously, and reuses it', async () => {
    const f = fixture(); await f.client.logOn({})
    expect(f.createMetadataClient).not.toHaveBeenCalled()
    const info = await f.client.getProductInfo([APP], [], true)
    expect(info).toMatchObject({ apps: { [APP]: { appinfo: { common: { name: 'Anonymous fixture game' } } } } })
    await f.client.getProductInfo([APP], [], true)
    expect(f.createMetadataClient).toHaveBeenCalledTimes(1)
    expect(f.metadata.calls[0]).toEqual({ anonymous: true })
    expect(f.metadata.calls.filter(value => Object.hasOwn(value, 'anonymous'))).toHaveLength(1)
    expect(f.broker.calls).toHaveLength(1)
    expect('getAppRichPresenceLocalization' in f.client).toBe(false)
    f.client.logOff(); expect(f.metadata.stopped).toBeGreaterThan(0)
  })

  it('fails a metadata login without attempting personal token fallback or retiring native presence', async () => {
    const f = fixture(); await f.client.logOn({})
    f.metadata.logOn = details => { f.metadata.calls.push(details); queueMicrotask(() => f.metadata.emit('error', new Error('FAKE_PRIVATE_NEVER_SURFACE'))) }
    await expect(f.client.getProductInfo([APP], [], true)).rejects.toMatchObject({ code: 'GAME_STATUS_APP_LOOKUP_TIMEOUT' })
    expect(f.errors).toEqual([]); expect(f.client.steamID?.getSteamID64()).toBe(SELF)
    expect(f.metadata.calls).toEqual([{ anonymous: true }])
  })

  it('discards a late metadata response after context retirement', async () => {
    const f = fixture(); await f.client.logOn({}); const gate = deferred<unknown>(); f.metadata.gate = gate
    const pending = f.client.getProductInfo([APP], [], true)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    await flush(); f.client.logOff(); gate.resolve({ apps: {} }); await rejected
    expect(f.client.steamID).toBeNull(); expect(f.metadata.stopped).toBeGreaterThan(0)
  })

  it('stops pending anonymous login on logOff and never lets late loggedOn reopen it', async () => {
    const f = fixture(); await f.client.logOn({}); f.metadata.logOn = details => { f.metadata.calls.push(details) }
    const pending = f.client.getProductInfo([APP], [], true)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    await flush(); f.client.logOff(); await rejected; f.metadata.emit('loggedOn')
    expect(f.client.steamID).toBeNull(); expect(f.metadata.stopped).toBeGreaterThan(0)
  })

  it('times out a silent anonymous metadata login without retrying it as the current user', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.logOn({})
    f.metadata.logOn = details => { f.metadata.calls.push(details) }
    const pending = f.client.getProductInfo([APP], [], true)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_APP_LOOKUP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(12000); await rejected
    expect(f.metadata.calls).toEqual([{ anonymous: true }]); expect(f.client.steamID?.getSteamID64()).toBe(SELF)
    expect(f.errors).toEqual([])
  })

  it('retires a disconnected anonymous metadata client without disconnecting local game presence', async () => {
    const f = fixture(); await f.client.logOn({}); await f.client.getProductInfo([APP], [], true)
    f.metadata.emit('disconnected')
    expect(f.metadata.stopped).toBeGreaterThan(0); expect(f.errors).toEqual([])
    expect(f.client.steamID?.getSteamID64()).toBe(SELF)
    expect(f.loggedOn).toHaveBeenCalledTimes(1)
  })

  it('rejects unexpected package or invalid app metadata queries before anonymous login', async () => {
    const f = fixture(); await f.client.logOn({})
    await expect(f.client.getProductInfo([APP], [1])).rejects.toThrow()
    await expect(f.client.getProductInfo([0], [])).rejects.toThrow()
    expect(f.createMetadataClient).not.toHaveBeenCalled()
  })
})
