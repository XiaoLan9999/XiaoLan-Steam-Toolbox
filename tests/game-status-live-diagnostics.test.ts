import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { GameStatusService, type GameStatusSteamClient } from '../src/main/game-status-service'
import { DomainError } from '../src/shared/domain'
import type { GameStatusAction, GameStatusSnapshot } from '../src/shared/game-status'
import { gameStatusFailureMessage } from '../src/shared/game-status-errors'

const ACCOUNT = { id: 'diagnostic-account-A', steamId: '76561198000000001' }
const OTHER = { id: 'diagnostic-account-B', steamId: '76561198000000002' }
const APP = 1329410
const PRIVATE = 'FAKE-private-nonce-and-connect-diagnostic-secret'
type Response = Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>>
const services: GameStatusService[] = []

class Client extends EventEmitter implements GameStatusSteamClient {
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: true, appid: APP }
  rp = { steam_display: '#DiagnosticStatus', status: 'Synthetic status', connect: PRIVATE }
  readCount = 0
  writes: Array<Record<string, string>> = []
  onRead: (() => Promise<unknown>) | null = null
  logOn(): void {}
  logOff(): void { this.steamID = null }
  setPersona(): void { throw new Error('A diagnostic read must not change persona') }
  gamesPlayed(): void { throw new Error('A diagnostic read must not replace the real game') }
  uploadRichPresence(_app: number, value: Record<string, string>): void { this.writes.push({ ...value }); this.rp = { ...value } as typeof this.rp }
  async getProductInfo(): Promise<unknown> { return { apps: { [APP]: { appinfo: { common: { name: 'Synthetic diagnostic game' } } } } } }
  async getAppRichPresenceLocalization(): Promise<unknown> { return { tokens: { '#DiagnosticStatus': '%status%' } } }
  response(raw: unknown = this.rp): unknown { return { users: { [ACCOUNT.steamId]: { richPresence: raw, localizedString: 'Synthetic status' } } } }
  async requestRichPresence(): Promise<Response> { this.readCount++; return (this.onRead ? await this.onRead() : this.response()) as Response }
}

function fixture(connected = true, live = true) {
  let account = ACCOUNT
  const client = new Client()
  const changes: GameStatusSnapshot[] = []
  const service = new GameStatusService({ getActiveAccount: () => account, createClient: () => client, onChange: value => changes.push(value) })
  services.push(service)
  const action = (): GameStatusAction => ({ accountId: account.id, sessionId: service.state().sessionId })
  if (connected) {
    service.connect({ ...action(), accountName: 'synthetic-diagnostic', password: 'FAKE-fixture-password' })
    client.playingState = { blocked: live, appid: live ? APP : 0 }
    client.steamID = { getSteamID64: () => account.steamId }
    client.emit('loggedOn')
  }
  return { service, client, changes, action, select(next: typeof ACCOUNT) { account = next } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function reachedRead(client: Client): Promise<void> {
  for (let index = 0; index < 30 && !client.readCount; index++) await Promise.resolve()
  expect(client.readCount).toBeGreaterThan(0)
}

async function failure(pending: Promise<unknown>, code: string): Promise<DomainError> {
  try { await pending } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain(PRIVATE)
    return error as DomainError
  }
  throw new Error(`Expected ${code}`)
}

function expectSafe(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(PRIVATE)
  expect(serialized).not.toContain('webLogonToken=')
  expect(serialized).not.toContain('steam://joinlobby/')
}

afterEach(() => { for (const service of services.splice(0)) service.dispose() })

describe('safe live-game read diagnostics', () => {
  it.each([
    { users: {} },
    { users: { [OTHER.steamId]: { richPresence: { connect: PRIVATE } } } }
  ])('classifies an absent self response as RP_EMPTY with bounded counts only: %j', async response => {
    const f = fixture(); f.client.onRead = async () => response
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_EMPTY')
    const state = f.service.state()
    expect(state.connected).toBe(true); expect(state.blocked).toBe(true); expect(state.blockingAppId).toBe(APP)
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_EMPTY', stage: 'read_presence', appId: APP, submitted: 'no' })
    expect(state.presenceRead).toMatchObject({ appId: APP, usersCount: Object.keys(response.users).length, selfPresent: false, presenceKind: 'missing', valueCount: 0, nonStringValues: 0 })
    expect(Object.keys(state.presenceRead!).sort()).toEqual(['appId', 'at', 'nonStringValues', 'presenceKind', 'selfPresent', 'usersCount', 'valueCount'])
    expect(Number.isFinite(Date.parse(state.presenceRead!.at))).toBe(true)
    expect(state.live).toBeNull(); expect(f.client.writes).toEqual([]); expectSafe([state, f.changes])
  })

  it.each([undefined, null])('classifies missing richPresence %s separately from invalid typed values', async raw => {
    const f = fixture(); f.client.onRead = async () => ({ users: { [ACCOUNT.steamId]: { richPresence: raw, nonce: PRIVATE } } })
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_EMPTY')
    expect(f.service.state().presenceRead).toMatchObject({ usersCount: 1, selfPresent: true, presenceKind: 'missing', valueCount: 0 })
    expectSafe([f.service.state(), f.changes])
  })

  it('rejects non-string rich-presence entries without forwarding key names, nonce or private joining values', async () => {
    const f = fixture()
    const raw = { steam_display: '#DiagnosticStatus', status: 'Synthetic status', connect: PRIVATE, webLogonToken: PRIVATE, [PRIVATE]: { join: `steam://joinlobby/${PRIVATE}` } }
    f.client.onRead = async () => f.client.response(raw)
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_INVALID')
    const state = f.service.state()
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_INVALID', stage: 'read_presence', submitted: 'no' })
    expect(state.presenceRead).toMatchObject({ usersCount: 1, selfPresent: true, presenceKind: 'object', valueCount: 5, nonStringValues: 1 })
    expect(state.live).toBeNull(); expect(f.client.writes).toEqual([]); expectSafe([state, f.changes])
  })

  it.each([['array', [PRIVATE]], ['other', 123], ['other', PRIVATE]] as const)('classifies malformed presence kind %s without echoing its value', async (kind, raw) => {
    const f = fixture(); f.client.onRead = async () => f.client.response(raw)
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_INVALID')
    expect(f.service.state().presenceRead).toMatchObject({ presenceKind: kind, valueCount: 0, nonStringValues: 0 })
    expectSafe([f.service.state(), f.changes])
  })

  it('turns a private SDK rejection into a fixed RP_READ_FAILED error without claiming expired sign-in', async () => {
    const f = fixture(); f.client.onRead = async () => { throw new Error(`webLogonToken=${PRIVATE} connect=steam://joinlobby/${PRIVATE}`) }
    const error = await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_READ_FAILED')
    expect(error.message).toBe(gameStatusFailureMessage('GAME_STATUS_RP_READ_FAILED', zh => zh))
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'read_presence', submitted: 'no', appId: APP })
    expect(f.service.state().connected).toBe(true); expect(f.service.state().status).toBe('logged_on')
    expect(f.service.state().presenceRead == null).toBe(true)
    expect(f.client.writes).toEqual([]); expectSafe([f.service.state(), f.changes])
  })

  it('clears old read counts before an RPC that fails so previous success is not shown as current evidence', async () => {
    const f = fixture(); await f.service.observeLive(f.action())
    expect(f.service.state().presenceRead).toMatchObject({ selfPresent: true, usersCount: 1 })
    f.client.onRead = async () => { throw new Error(PRIVATE) }
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_READ_FAILED')
    expect(f.service.state().presenceRead).toBeNull()
    expectSafe([f.service.state(), f.changes])
  })

  it('clears a previous error after a new successful read without exposing private fields', async () => {
    const f = fixture(); f.client.onRead = async () => ({ users: {} })
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_EMPTY')
    f.client.onRead = null
    const state = await f.service.observeLive(f.action())
    expect(state.failure).toBeNull(); expect(state.lastOperation?.outcome).toBe('observed')
    expect(state.live?.fields).toMatchObject({ status: 'Synthetic status' })
    expect(state.live?.fields).not.toHaveProperty('connect'); expectSafe([state, f.changes])
  })
})

describe('exact precondition codes without real-game mutations', () => {
  it('distinguishes a disconnected status session from missing live-game presence', async () => {
    const f = fixture(false)
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_NOT_CONNECTED')
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_NOT_CONNECTED', stage: 'session', submitted: 'no' })
    expect(f.client.readCount).toBe(0); expect(f.client.writes).toEqual([])
  })

  it('distinguishes no live game while retaining a healthy CM connection', async () => {
    const f = fixture(true, false)
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_NO_LIVE_GAME')
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_NO_LIVE_GAME', stage: 'playing_state', submitted: 'no' })
    expect(f.service.state().connected).toBe(true); expect(f.client.readCount).toBe(0); expect(f.client.writes).toEqual([])
  })

  it('reports BUSY for a concurrent operation and does not start a second RPC', async () => {
    const f = fixture(); const waiting = deferred<unknown>(); f.client.onRead = () => waiting.promise
    const pending = f.service.observeLive(f.action()); await reachedRead(f.client)
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_BUSY')
    expect(f.service.state().failure).toMatchObject({ code: 'GAME_STATUS_BUSY', stage: 'operation', submitted: 'no', appId: APP })
    expect(f.client.readCount).toBe(1); expect(f.client.writes).toEqual([])
    waiting.resolve(f.client.response()); await pending
    expect(f.service.state().busy).toBe(false); expect(f.service.state().failure).toBeNull()
  })
})

describe('game and account changes retire old diagnostics', () => {
  it('clears previous error and response counts when the running game changes', async () => {
    const f = fixture(); f.client.onRead = async () => ({ users: {} })
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_EMPTY')
    f.client.emit('playingState', true, 730)
    expect(f.service.state().blockingAppId).toBe(730)
    expect(f.service.state().failure).toBeNull(); expect(f.service.state().presenceRead).toBeNull()
  })

  it('rejects a late response from the previous game without assigning its counts or failure', async () => {
    const f = fixture(); const waiting = deferred<unknown>(); f.client.onRead = () => waiting.promise
    const pending = f.service.observeLive(f.action()); await reachedRead(f.client)
    f.client.emit('playingState', true, 730)
    waiting.resolve(f.client.response({ connect: PRIVATE, nonce: { secret: PRIVATE } }))
    await failure(pending, 'GAME_STATUS_CONTEXT_CHANGED')
    expect(f.service.state().failure).toBeNull(); expect(f.service.state().presenceRead).toBeNull()
    expect(f.service.state().blockingAppId).toBe(730); expectSafe([f.service.state(), f.changes])
  })

  it('clears old diagnostics on account invalidation and ignores a late private result', async () => {
    const f = fixture(); f.client.onRead = async () => ({ users: {} })
    await failure(f.service.observeLive(f.action()), 'GAME_STATUS_RP_EMPTY')
    const waiting = deferred<unknown>(); f.client.onRead = () => waiting.promise
    const oldReadCount = f.client.readCount; const pending = f.service.observeLive(f.action())
    for (let index = 0; index < 30 && f.client.readCount === oldReadCount; index++) await Promise.resolve()
    expect(f.client.readCount).toBe(oldReadCount + 1)
    f.select(OTHER); f.service.invalidate()
    const clean = f.service.state()
    waiting.resolve({ users: { [ACCOUNT.steamId]: { richPresence: { connect: PRIVATE, nonce: { value: PRIVATE } } } } })
    await failure(pending, 'GAME_STATUS_CONTEXT_CHANGED')
    expect(f.service.state()).toEqual(clean)
    expect(f.service.state().failure == null).toBe(true); expect(f.service.state().presenceRead == null).toBe(true)
    expect(f.service.state().accountId).toBeNull(); expectSafe([f.service.state(), f.changes])
  })
})

describe('post-submission diagnostic truthfulness', () => {
  it.each(['throw', 'empty', 'invalid'] as const)('retains submitted=yes on final one-time patch readback failure: %s', async kind => {
    const f = fixture(); const observed = await f.service.observeLive(f.action())
    f.client.onRead = async () => {
      if (!f.client.writes.length) return f.client.response()
      if (kind === 'throw') throw new Error(PRIVATE)
      return kind === 'empty' ? { users: {} } : f.client.response({ connect: PRIVATE, nonce: { secret: PRIVATE } })
    }
    const state = await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Edited synthetic status' } })
    expect(f.client.writes).toHaveLength(1)
    expect(state.lastOperation).toMatchObject({ kind: 'patch', outcome: 'unverified' })
    expect(state.failure).toMatchObject({ code: kind === 'throw' ? 'GAME_STATUS_RP_READ_FAILED' : kind === 'empty' ? 'GAME_STATUS_RP_EMPTY' : 'GAME_STATUS_RP_INVALID', stage: 'readback', submitted: 'yes', appId: APP })
    expect(state.busy).toBe(false); expect(state.connected).toBe(true)
    expect(gameStatusFailureMessage(state.failure!.code, (_zh, en) => en)).not.toMatch(/no changes were submitted|No status changes were submitted/)
    expectSafe([state, f.changes])
  })

  it('retains the actual readback failure on a newly scheduled lock without claiming matched status', async () => {
    const f = fixture(); const observed = await f.service.observeLive(f.action())
    f.client.onRead = async () => { if (f.client.writes.length) throw new Error(PRIVATE); return f.client.response() }
    const state = await f.service.lockLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Locked synthetic status' } })
    expect(state.lastOperation).toMatchObject({ kind: 'lock', outcome: 'unverified' })
    expect(state.liveLock).toMatchObject({ status: 'retrying', matched: false })
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'readback', submitted: 'yes' })
    expect(f.client.writes).toHaveLength(1); expectSafe([state, f.changes])
  })

  it('keeps restore submission distinct from an unconfirmed readback', async () => {
    const f = fixture(); const observed = await f.service.observeLive(f.action())
    await f.service.patchLive({ ...f.action(), snapshotId: observed.live!.snapshotId, changes: { status: 'Edited synthetic status' } })
    f.client.onRead = async () => { if (f.client.writes.length >= 2) throw new Error(PRIVATE); return f.client.response() }
    const state = await f.service.restoreLive(f.action())
    expect(f.client.writes).toHaveLength(2)
    expect(state.lastOperation).toMatchObject({ kind: 'restore', outcome: 'unverified' })
    expect(state.failure).toMatchObject({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'readback', submitted: 'yes' })
    expect(state.live?.patchActive).toBe(true); expectSafe([state, f.changes])
  })
})
