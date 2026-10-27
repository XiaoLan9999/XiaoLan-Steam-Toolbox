import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameStatusService, LIVE_LOCK_INTERVAL_MS, LIVE_RESTORE_TTL_MS, type GameStatusSteamClient } from '../src/main/game-status-service'
import type { GameStatusAction } from '../src/shared/game-status'

const ACCOUNT = { id: 'lock-lifetime-A', steamId: '76561198000000001' }
const OTHER = { id: 'lock-lifetime-B', steamId: '76561198000000002' }
const APP = 1329410
const ORIGINAL = 'Original game description'
const DESIRED = 'Locked game description'
const services: GameStatusService[] = []

class Client extends EventEmitter implements GameStatusSteamClient {
  readonly presenceSource = 'local-cache' as const
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  rp: Record<string, string> = { desc: ORIGINAL, steam_display: '#Original_Game_Template' }
  failReads = false
  logOn(): void { this.steamID = { getSteamID64: () => ACCOUNT.steamId }; this.emit('loggedOn') }
  logOff(): void { this.steamID = null }
  setPersona(): never { throw new Error('Persona writes are forbidden') }
  gamesPlayed(): never { throw new Error('Game takeover is forbidden') }
  uploadRichPresence(): never { throw new Error('CM writes are forbidden') }
  async requestRichPresence(): ReturnType<GameStatusSteamClient['requestRichPresence']> {
    if (this.failReads) throw new Error('Synthetic read unavailable')
    return { users: { [ACCOUNT.steamId]: { richPresence: { desc: this.rp.desc! }, localizedString: this.rp.desc, displayTokenReadable: false } } }
  }
}

function fixture() {
  let account = ACCOUNT
  const client = new Client()
  const writes: Array<Record<string, string | null>> = []
  let failReadbackAfterWrite = false
  const service = new GameStatusService({
    getActiveAccount: () => account,
    createLocalClient: () => client,
    nativeWriter: {
      stop() {},
      async apply(_context, changes, permitted) {
        if (!permitted()) throw new Error('Synthetic write cancelled')
        writes.push({ ...changes })
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) delete client.rp[key]
          else client.rp[key] = value
        }
        if (failReadbackAfterWrite) client.failReads = true
      }
    }
  })
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: account.id, sessionId: service.state().sessionId })
  service.connectLocal(action())
  const start = async (lock = true) => {
    const live = (await service.observeLive(action())).live!
    const input = { ...action(), snapshotId: live.snapshotId, changes: { desc: DESIRED } }
    return lock ? service.lockLive(input) : service.patchLive(input)
  }
  return { service, client, writes, action, start, select(other: typeof ACCOUNT) { account = other }, failNextReadback() { failReadbackAfterWrite = true } }
}

afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('safe restoration lifetime during a continuously confirmed local lock', () => {
  it('restores after hours of confirmed reads without additional writes or touching steam_display', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(f.service.state().liveLock).toMatchObject({ status: 'locked', matched: true })
    expect(f.writes).toEqual([{ desc: DESIRED }])
    const state = await f.service.unlockLive({ ...f.action(), restore: true })
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'matched' })
    expect(f.writes).toEqual([{ desc: DESIRED }, { desc: ORIGINAL }])
    expect(f.client.rp).toEqual({ desc: ORIGINAL, steam_display: '#Original_Game_Template' })
    expect(state.live?.patchActive).toBe(false)
  })

  it('does not renew a one-shot patch that has no active lock', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start(false)
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS)
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_RESTORE_EXPIRED' })
    expect(f.writes).toEqual([{ desc: DESIRED }])
  })

  it('keeps the original expiry after a failed readback of a native reassertion', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    f.client.rp.desc = 'New native game value'; f.failNextReadback()
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS + 1)
    expect(f.service.state().liveLock?.status).toBe('paused')
    expect(f.writes).toEqual([{ desc: DESIRED }, { desc: DESIRED }])
    await expect(f.service.unlockLive({ ...f.action(), restore: true })).rejects.toMatchObject({ code: 'GAME_STATUS_RESTORE_EXPIRED' })
    expect(f.writes).toHaveLength(2)
  })

  it('does not renew through failed checks or a manual read while the lock is paused', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    f.client.failReads = true
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS + 1)
    expect(f.service.state().liveLock?.status).toBe('paused')
    f.client.failReads = false
    const observed = await f.service.observeLive(f.action())
    expect(observed.live?.patchActive).toBe(true)
    expect(observed.lastOperation?.message).toContain('未丢弃本地记录')
    expect(observed.lastOperation?.message).not.toContain('可重新编辑')
    await expect(f.service.unlockLive({ ...f.action(), restore: true })).rejects.toMatchObject({ code: 'GAME_STATUS_RESTORE_EXPIRED' })
    expect(f.writes).toEqual([{ desc: DESIRED }])
  })

  it('does not renew after unlocking even if manual observations continue to match', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(LIVE_LOCK_INTERVAL_MS)
    await f.service.unlockLive({ ...f.action(), restore: false })
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS - 1)
    await f.service.observeLive(f.action())
    await vi.advanceTimersByTimeAsync(2)
    await expect(f.service.restoreLive(f.action())).rejects.toMatchObject({ code: 'GAME_STATUS_RESTORE_EXPIRED' })
    expect(f.writes).toEqual([{ desc: DESIRED }])
  })

  it('does not claim that a paused lock discarded a superseded recovery record', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    f.client.failReads = true
    await vi.advanceTimersByTimeAsync(90000)
    expect(f.service.state().liveLock?.status).toBe('paused')
    f.client.failReads = false; f.client.rp.desc = 'New game-owned value'
    const state = await f.service.observeLive(f.action())
    expect(state.live?.patchActive).toBe(true)
    expect(state.lastOperation?.message).toContain('安全恢复记录仍然保留')
    expect(state.lastOperation?.message).not.toContain('已丢弃')
    expect(state.lastOperation?.message).not.toContain('可重新编辑')
    await expect(f.service.patchLive({ ...f.action(), snapshotId: state.live!.snapshotId, changes: { desc: 'Do not overlap' } })).rejects.toThrow()
    expect(f.writes).toEqual([{ desc: DESIRED }])
  })

  it('still refuses to overwrite a game-owned third value after a long confirmed lock', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS * 2)
    await f.service.unlockLive({ ...f.action(), restore: false })
    f.client.rp.desc = 'Game-owned third value'
    const state = await f.service.restoreLive(f.action())
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'conflict' })
    expect(f.client.rp.desc).toBe('Game-owned third value')
    expect(f.writes).toEqual([{ desc: DESIRED }])
  })

  it.each(['account', 'game', 'dispose'] as const)('does not renew or restore after the %s context is invalidated', async kind => {
    vi.useFakeTimers()
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS * 2)
    if (kind === 'account') { f.select(OTHER); f.service.invalidate() }
    else if (kind === 'game') f.client.emit('playingState', true, 730)
    else f.service.dispose()
    await vi.advanceTimersByTimeAsync(LIVE_RESTORE_TTL_MS * 2)
    await expect(f.service.restoreLive(f.action())).rejects.toThrow()
    expect(f.writes).toEqual([{ desc: DESIRED }])
    expect(f.service.state().live).toBeNull()
  })
})
