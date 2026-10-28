import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'
import { LocalAppHostBroker, LocalAppSimulationService, type LocalAppSimulationHost, type LocalAppSimulationRead } from '../src/main/local-app-simulation'
import type { LocalAppSimulationContext } from '../src/main/local-app-simulation-context'
import { readLocalAppMetadata, type AnonymousAppMetadataClient } from '../src/main/local-app-simulation-metadata'

const ACCOUNT = { id: 'local-app-fixture', steamId: '76561198000000001' }
const CONTEXT: LocalAppSimulationContext = { appId: 0, steamId: ACCOUNT.steamId, steamPid: 1234, steamStartTicks: '638965000000000001', steamExe: 'D:/Steam/steam.exe', ownerPid: 5678, ownerStartTicks: '638965000000000002', activeAppIds: [] }
const INFO: GameStatusAppInfo = { appId: 730, name: 'Fixture game', iconUrl: null, language: 'schinese', templates: [{ token: '#Fixture', text: '%status%', parameters: ['status'] }], templateStatus: 'available' }
const READ: LocalAppSimulationRead = { fields: {}, localizedString: null, verificationSource: 'local-cache' }
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const cleanups: Array<() => void | Promise<void>> = []
const preciseWorkerCodes = ['LOCAL_APP_PROFILE_UNSUPPORTED', 'LOCAL_APP_NOT_LICENSED', 'LOCAL_APP_INIT_FAILED', 'LOCAL_APP_IDENTITY_MISMATCH', 'LOCAL_APP_APP_MISMATCH', 'LOCAL_APP_DLL_INVALID'] as const
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers() })

class Host implements LocalAppSimulationHost {
  calls: Array<{ op: string; appId?: number; changes?: Record<string, string | null>; permitted?: () => boolean }> = []
  fields: Record<string, string> = {}
  gate: ReturnType<typeof deferred<void>> | null = null
  listener: ((error: DomainError) => void) | null = null
  onExit(listener: (error: DomainError) => void) { this.listener = listener; return () => { this.listener = null } }
  async begin(_context: LocalAppSimulationContext, appId: number, permitted: () => boolean) { if (!permitted()) throw new Error(); this.calls.push({ op: 'begin', appId, permitted }); return { ...READ, fields: { ...this.fields } } }
  async apply(changes: Record<string, string | null>, permitted: () => boolean) { if (!permitted()) throw new Error(); this.calls.push({ op: 'apply', changes }); for (const [key, value] of Object.entries(changes)) { if (value === null) delete this.fields[key]; else this.fields[key] = value }; return this.read(permitted) }
  async read(permitted: () => boolean) { if (!permitted()) throw new Error(); this.calls.push({ op: 'read' }); return { ...READ, fields: { ...this.fields } } }
  stop() { this.calls.push({ op: 'stop' }) }
  async shutdown() { this.calls.push({ op: 'shutdown' }); await this.gate?.promise }
}
function fixture() {
  const host = new Host(); let account: typeof ACCOUNT | null = ACCOUNT; let context = structuredClone(CONTEXT)
  const before = vi.fn(async () => {}); const metadata = vi.fn(async (appId: number) => ({ ...INFO, appId }))
  const detector = vi.fn(async () => structuredClone(context))
  const service = new LocalAppSimulationService({ getActiveAccount: () => account, getWorkerPath: () => 'D:/fixture/local-app-host-x64.exe', host, beforeStart: before, readContext: detector, readMetadata: metadata })
  cleanups.push(() => { host.gate?.resolve(); return service.shutdown() })
  return { service, host, before, metadata, detector, action: () => ({ accountId: ACCOUNT.id, sessionId: service.state().sessionId }), setAccount(value: typeof account) { account = value }, setContext(value: Partial<LocalAppSimulationContext>) { context = { ...context, ...value } } }
}

describe('local AppID simulation without personal CM or CEF', () => {
  it('reports hidden client retirement work even after the public snapshot has reset to idle', async () => {
    const f = fixture()
    expect(f.service.hasClientWork()).toBe(false)
    f.host.gate = deferred<void>()
    const retiring = f.service.invalidate()
    expect(f.service.state().status).toBe('idle')
    expect(f.service.hasClientWork()).toBe(true)
    f.host.gate.resolve()
    await retiring
    expect(f.service.hasClientWork()).toBe(false)
  })

  it('keeps unconfirmed broker sessions visible to the screenshot-restart guard', () => {
    const f = fixture()
    Object.assign(f.host, { hasClientWork: () => true })
    expect(f.service.hasClientWork()).toBe(true)
  })

  it('passes AppID 4000 directly to the host without installation metadata or a target game-directory dependency', async () => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 4000 })
    expect(f.host.calls.find(call => call.op === 'begin')?.appId).toBe(4000)
    expect(f.metadata).not.toHaveBeenCalled(); expect(f.service.state()).toMatchObject({ status: 'running', appId: 4000 })
  })
  it.each(preciseWorkerCodes)('preserves sanitized host failure %s through the service', async code => {
    const f = fixture(); f.host.begin = vi.fn(async () => { throw new DomainError(code, 'private-file-path SDK secret') })
    await expect(f.service.start({ ...f.action(), appId: 4000 })).rejects.toMatchObject({ code })
    expect(f.service.state().error?.code).toBe(code); expect(JSON.stringify(f.service.state())).not.toContain('private-file-path')
  })
  it('inspects while idle without a helper or local Steam connection', async () => {
    const f = fixture(); expect(await f.service.inspect({ ...f.action(), appId: 730 })).toEqual(INFO)
    expect(f.host.calls).toEqual([]); expect(f.detector).not.toHaveBeenCalled(); expect(f.service.state()).toMatchObject({ status: 'idle', busy: false, appInfo: INFO })
  })
  it('waits for mode retirement before local checks and helper creation', async () => {
    const f = fixture(); const gate = deferred<void>(); f.before.mockImplementationOnce(() => gate.promise)
    const pending = f.service.start({ ...f.action(), appId: 730 }); await flush()
    expect(f.detector).not.toHaveBeenCalled(); expect(f.host.calls).toEqual([])
    gate.resolve(); const state = await pending
    expect(state).toMatchObject({ status: 'running', busy: false, appId: 730, verificationSource: 'local-cache', localizedString: null })
    expect(f.host.calls.some(call => call.op === 'begin')).toBe(true)
    expect(f.host.calls.find(call => call.op === 'begin')!.permitted!()).toBe(true)
  })
  it('preserves a safe-restore guard failure without creating a helper', async () => {
    const f = fixture(); f.before.mockRejectedValueOnce(new DomainError('LOCAL_APP_LIVE_RESTORE_REQUIRED', 'fixture'))
    await expect(f.service.start({ ...f.action(), appId: 730 })).rejects.toMatchObject({ code: 'LOCAL_APP_LIVE_RESTORE_REQUIRED' })
    expect(f.host.calls.filter(call => call.op === 'begin')).toHaveLength(0)
  })
  it.each([{ appId: 550 }, { activeAppIds: [550] }, { activeAppIds: [0] }, { appId: 550, activeAppIds: [0, 550] }])('allows another real game or shortcut: %j', async context => {
    const f = fixture(); f.setContext(context)
    expect(await f.service.start({ ...f.action(), appId: 730 })).toMatchObject({ status: 'running', appId: 730 })
    expect(f.host.calls.filter(call => call.op === 'begin')).toHaveLength(1)
    expect(f.detector).toHaveBeenCalledTimes(2)
  })
  it.each([{ appId: 730 }, { activeAppIds: [730] }, { appId: 550, activeAppIds: [0, 550, 730] }])('refuses an already running target game: %j', async context => {
    const f = fixture(); f.setContext(context)
    await expect(f.service.start({ ...f.action(), appId: 730 })).rejects.toMatchObject({ code: 'LOCAL_APP_GAME_ACTIVE' })
    expect(f.host.calls.some(call => call.op === 'begin')).toBe(false)
  })
  it.each([{ appId: 730 }, { appId: 550, activeAppIds: [550, 730] }])('refuses a target game that appears between startup checks: %j', async context => {
    const f = fixture()
    f.detector.mockResolvedValueOnce({ ...CONTEXT, appId: 550, activeAppIds: [550] }).mockResolvedValueOnce({ ...CONTEXT, ...context })
    await expect(f.service.start({ ...f.action(), appId: 730 })).rejects.toMatchObject({ code: 'LOCAL_APP_GAME_ACTIVE' })
    expect(f.detector).toHaveBeenCalledTimes(2)
    expect(f.host.calls.some(call => call.op === 'begin' || call.op === 'apply')).toBe(false)
  })
  it('does not resume an old start after account change or explicit stop', async () => {
    for (const kind of ['account', 'stop']) {
      const f = fixture(); const gate = deferred<void>(); f.before.mockImplementationOnce(() => gate.promise)
      const pending = f.service.start({ ...f.action(), appId: 730 }); const rejected = expect(pending).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_CHANGED' }); await flush()
      if (kind === 'account') f.setAccount(null); else await f.service.stop(f.action())
      gate.resolve(); await rejected; expect(f.host.calls.some(call => call.op === 'begin')).toBe(false)
    }
  })
  it('updates the same helper and deduplicates identical template fields', async () => {
    const f = fixture(); await f.service.inspect({ ...f.action(), appId: 730 })
    const input = { ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'One' } } }
    await f.service.start(input); f.setContext({ appId: 730, activeAppIds: [730] }); await f.service.start(input)
    expect(f.host.calls.filter(call => call.op === 'begin')).toHaveLength(1)
    expect(f.host.calls.filter(call => call.op === 'apply')).toHaveLength(1)
    await f.service.start({ ...input, presence: { displayToken: '#Fixture', values: { status: 'Two' } } })
    expect(f.host.calls.filter(call => call.op === 'apply').at(-1)!.changes).toEqual({ status: 'Two' })
  })
  it('updates substatus without stopping or changing other games', async () => {
    const f = fixture(); await f.service.inspect({ ...f.action(), appId: 730 })
    const input = { ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'One' } } }
    f.setContext({ appId: 550, activeAppIds: [0, 550] }); await f.service.start(input)
    const activity = { appId: 570, activeAppIds: [0, 570, 730] }
    f.setContext(activity)
    const before = f.host.calls.length
    expect(await f.service.start({ ...input, presence: { displayToken: '#Fixture', values: { status: 'Two' } } })).toMatchObject({ status: 'running', appId: 730, fields: { status: 'Two' } })
    expect(f.host.calls.slice(before).map(call => call.op)).toEqual(['read', 'apply', 'read'])
    expect(f.host.calls.filter(call => call.op === 'begin').map(call => call.appId)).toEqual([730])
    expect(await f.detector()).toMatchObject(activity)
  })
  it('clears only fields previously set by this simulation when the template is removed', async () => {
    const f = fixture(); await f.service.inspect({ ...f.action(), appId: 730 })
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'One' } } })
    f.setContext({ appId: 730 }); await f.service.start({ ...f.action(), appId: 730 })
    expect(f.host.calls.filter(call => call.op === 'apply').at(-1)!.changes).toEqual({ steam_display: null, status: null })
  })
  it('waits for the previous helper to close before changing AppID', async () => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 730 }); const gate = deferred<void>(); f.host.gate = gate
    const pending = f.service.start({ ...f.action(), appId: 550 }); await flush()
    expect(f.host.calls.filter(call => call.op === 'begin')).toHaveLength(1)
    gate.resolve(); await pending; expect(f.host.calls.filter(call => call.op === 'begin').map(call => call.appId)).toEqual([730, 550])
  })
  it.each([{ appId: 550 }, { appId: 730, activeAppIds: [730, 550] }])('refuses switching simulation to a target game that is already running: %j', async context => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 730 })
    f.setContext(context)
    await expect(f.service.start({ ...f.action(), appId: 550 })).rejects.toMatchObject({ code: 'LOCAL_APP_GAME_ACTIVE' })
    expect(f.host.calls.filter(call => call.op === 'begin').map(call => call.appId)).toEqual([730])
    expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_GAME_ACTIVE' } })
  })
  it('refuses arbitrary presence and templates not obtained from official metadata', async () => {
    const f = fixture()
    await expect(f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fake', values: {} } })).rejects.toMatchObject({ code: 'LOCAL_APP_TEMPLATE_UNAVAILABLE' })
    await f.service.inspect({ ...f.action(), appId: 730 })
    await expect(f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fake', values: {} } })).rejects.toMatchObject({ code: 'LOCAL_APP_INVALID_INPUT' })
    expect(f.host.calls).toEqual([])
  })
  it('submits explicitly experimental public fields without metadata or a catalog dependency', async () => {
    const f = fixture(); const catalog = vi.fn(async () => { throw new Error('must not fetch') }); Object.assign(f.host, { catalog })
    const state = await f.service.start({ ...f.action(), appId: 2507950, unverifiedPresence: { Desc: 'Synthetic scene', STATUS: 'Synthetic activity' } })
    expect(f.metadata).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled()
    expect(f.host.calls.find(call => call.op === 'apply')?.changes).toEqual({ desc: 'Synthetic scene', status: 'Synthetic activity' })
    expect(state).toMatchObject({ status: 'running', appId: 2507950, submissionMode: 'experimental', verificationSource: 'local-cache', localizedString: null })
    expect(state.fields).not.toHaveProperty('steam_display')
  })
  it('writes an explicit experimental display token last without claiming template validation', async () => {
    const f = fixture()
    const state = await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { steam_display: '#Unknown:Game-v1.0', desc: 'Synthetic' } })
    const changes = f.host.calls.find(call => call.op === 'apply')!.changes!
    expect(Object.keys(changes)).toEqual(['desc', 'steam_display'])
    expect(state.submissionMode).toBe('experimental'); expect(state.appInfo).toBeNull()
  })
  it.each<{ unverifiedPresence: Record<string, string>; presence?: GameStatusPresence }>([
    { unverifiedPresence: {} },
    { unverifiedPresence: { desc: 'a', DESC: 'b' } },
    { unverifiedPresence: { desc: '' } },
    { unverifiedPresence: { connect: 'blocked' } },
    { unverifiedPresence: { steam_player_group: 'blocked' } },
    { unverifiedPresence: { private_state: 'blocked' } },
    { unverifiedPresence: { steam_display: 'arbitrary text' } },
    { unverifiedPresence: { desc: '界'.repeat(86) } },
    { unverifiedPresence: { desc: 'hidden\ncontrol' } },
    { unverifiedPresence: { desc: 'text' }, presence: { displayToken: '#Fixture', values: { status: 'One' } } }
  ])('rejects malformed or conflicting experimental input before retiring other modes: %j', async input => {
    const f = fixture()
    await expect(f.service.start({ ...f.action(), appId: 730, ...input })).rejects.toMatchObject({ code: 'LOCAL_APP_INVALID_INPUT' })
    expect(f.before).not.toHaveBeenCalled(); expect(f.detector).not.toHaveBeenCalled(); expect(f.host.calls).toEqual([])
  })
  it('reserves two Steam entries for the generated group and size in experimental mode', async () => {
    const f = fixture(); const fields = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`field${index}`, 'value']))
    const state = await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: fields, groupSize: 3 })
    expect(state.submissionMode).toBe('experimental'); expect(Object.keys(state.fields)).toHaveLength(19)
    expect(state.fields.steam_player_group_size).toBe('3')
    f.setContext({ appId: 730 })
    const before = f.host.calls.length
    await expect(f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { ...fields, extra: 'invalid' }, groupSize: 3 })).rejects.toMatchObject({ code: 'LOCAL_APP_INVALID_INPUT' })
    expect(f.host.calls).toHaveLength(before)
  })
  it('clears obsolete owned fields when changing between experimental and published-template modes', async () => {
    const f = fixture(); await f.service.inspect({ ...f.action(), appId: 730 })
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'One' } } })
    expect(f.service.state().submissionMode).toBe('published-template')
    f.setContext({ appId: 730 })
    const before = f.host.calls.length
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { desc: 'Raw scene' } })
    expect(f.host.calls.slice(before).filter(call => call.op === 'apply').map(call => call.changes)).toEqual([{ status: null, steam_display: null }, { desc: 'Raw scene' }])
    expect(f.service.state().fields).toEqual({ desc: 'Raw scene' })
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'Two' } } })
    expect(f.service.state()).toMatchObject({ submissionMode: 'published-template', fields: { status: 'Two', steam_display: '#Fixture' } })
    expect(f.service.state().fields).not.toHaveProperty('desc')
    await f.service.start({ ...f.action(), appId: 730 })
    expect(f.service.state().submissionMode).toBeUndefined()
  })
  it.each([false, true])('frees old slots before replacing a full template with full experimental fields and back, group=%s', async withGroup => {
    const f = fixture(); const limit = withGroup ? 17 : 19
    const values = Object.fromEntries(Array.from({ length: limit }, (_, index) => [`field${index}`, 'v']))
    const template = { ...INFO, templates: [{ token: '#Full', text: Object.keys(values).map(key => `%${key}%`).join(' '), parameters: Object.keys(values) }] }
    f.metadata.mockResolvedValue(template)
    const apply = f.host.apply.bind(f.host)
    const slotCounts: number[] = []
    f.host.apply = vi.fn(async (changes: Record<string, string | null>, permitted: () => boolean) => {
      const interim = { ...f.host.fields }
      const entries = Object.entries(changes).sort(([left], [right]) => Number(left === 'steam_display') - Number(right === 'steam_display'))
      for (const [key, value] of entries) {
        if (value === null) delete interim[key]; else interim[key] = value
        const count = Object.keys(interim).length + (Object.hasOwn(interim, 'steam_player_group_size') ? 1 : 0)
        slotCounts.push(count)
        if (count > 20) throw new DomainError('LOCAL_APP_SET_REJECTED', 'native capacity')
      }
      return apply(changes, permitted)
    })
    await f.service.inspect({ ...f.action(), appId: 730 })
    const group = withGroup ? { groupSize: 3 } : {}
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Full', values }, ...group })
    f.setContext({ appId: 730 })
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { ...values, replacement: 'v' }, ...group })
    expect(f.service.state().submissionMode).toBe('experimental'); expect(f.service.state().fields).not.toHaveProperty('steam_display')
    await f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Full', values }, ...group })
    expect(f.service.state().submissionMode).toBe('published-template'); expect(f.service.state().fields).not.toHaveProperty('replacement')
    expect(Math.max(...slotCounts)).toBe(20)
    const groups = f.host.calls.filter(call => call.op === 'apply').map(call => Object.values(call.changes!))
    expect(groups.every(values => values.every(value => value === null) || values.every(value => value !== null))).toBe(true)
  })
  it('frees two slots before enabling a generated group at capacity, and clears the group before adding replacements', async () => {
    const f = fixture(); const all = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'v']))
    const reduced = Object.fromEntries(Object.entries(all).slice(0, 18))
    const apply = f.host.apply.bind(f.host)
    f.host.apply = vi.fn(async (changes: Record<string, string | null>, permitted: () => boolean) => {
      const interim = { ...f.host.fields }
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete interim[key]; else interim[key] = value
        if (Object.keys(interim).length + (Object.hasOwn(interim, 'steam_player_group_size') ? 1 : 0) > 20) throw new DomainError('LOCAL_APP_SET_REJECTED', 'native capacity')
      }
      return apply(changes, permitted)
    })
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: all }); f.setContext({ appId: 730 })
    const before = f.host.calls.length
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: reduced, groupSize: 3 })
    expect(f.host.calls.slice(before).filter(call => call.op === 'apply').map(call => call.changes)).toEqual([{ field18: null, field19: null }, { steam_player_group_size: '3' }])
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: all })
    expect(f.service.state().fields).toEqual(all); expect(f.service.state().status).toBe('running')
  })
  it('keeps account, target-game and safe-restore guards for experimental submission', async () => {
    const input = { appId: 730, unverifiedPresence: { desc: 'Synthetic' } }
    const account = fixture(); account.setAccount(null)
    await expect(account.service.start({ ...account.action(), ...input })).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_CHANGED' })
    expect(account.host.calls.some(call => call.op === 'begin')).toBe(false)
    const game = fixture(); game.setContext({ appId: 730 })
    await expect(game.service.start({ ...game.action(), ...input })).rejects.toMatchObject({ code: 'LOCAL_APP_GAME_ACTIVE' })
    expect(game.host.calls.some(call => call.op === 'apply')).toBe(false)
    const restore = fixture(); restore.before.mockRejectedValueOnce(new DomainError('LOCAL_APP_LIVE_RESTORE_REQUIRED', 'fixture'))
    await expect(restore.service.start({ ...restore.action(), ...input })).rejects.toMatchObject({ code: 'LOCAL_APP_LIVE_RESTORE_REQUIRED' })
    expect(restore.host.calls.some(call => call.op === 'begin')).toBe(false)
  })
  it('clears the experimental indicator on stop or worker failure and never persists the manual form', async () => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { desc: 'Synthetic' } })
    await f.service.stop(f.action()); expect(f.service.state().submissionMode).toBeUndefined()
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { desc: 'Synthetic' } })
    f.host.listener!(new DomainError('LOCAL_APP_EXITED', 'fixture')); expect(f.service.state().submissionMode).toBeUndefined()
    await f.service.invalidate(); expect(f.service.state().fields).toEqual({}); expect(f.service.state().submissionMode).toBeUndefined()
  })
  it('keeps its helper running when other games start, switch and exit', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start({ ...f.action(), appId: 730 })
    for (const context of [{ appId: 550, activeAppIds: [550, 730] }, { appId: 570, activeAppIds: [0, 570, 730] }, { appId: 730, activeAppIds: [730] }, { appId: 0, activeAppIds: [] }]) {
      f.setContext(context); await vi.advanceTimersByTimeAsync(3000)
      expect(f.service.state()).toMatchObject({ status: 'running', appId: 730, error: null, verificationSource: 'local-cache' })
    }
    expect(f.detector).toHaveBeenCalledTimes(6)
    expect(f.host.calls.some(call => call.op === 'stop')).toBe(false)
  })
  it.each([{ steamId: '76561198000000002' }, { steamPid: 1235 }, { steamStartTicks: '638965000000000003' }, { steamExe: 'E:/Steam/steam.exe' }, { ownerPid: 5679 }, { ownerStartTicks: '638965000000000003' }])('stops its helper if the Steam or owner identity changes: %j', async context => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start({ ...f.action(), appId: 730 })
    f.setContext({ appId: 550, activeAppIds: [550, 730], ...context }); await vi.advanceTimersByTimeAsync(3000)
    expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_CONTEXT_CHANGED' }, verificationSource: null })
    expect(f.host.calls.at(-1)!.op).toBe('stop')
  })
  it('stops its helper if the selected account changes while another game runs', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start({ ...f.action(), appId: 730 })
    const owned = f.host.calls.find(call => call.op === 'begin')!.permitted!
    f.setContext({ appId: 550, activeAppIds: [550, 730] }); f.setAccount({ ...ACCOUNT, id: 'new-account' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(owned()).toBe(false)
    expect(f.host.calls.some(call => call.op === 'stop')).toBe(true)
    expect(f.service.state()).toMatchObject({ status: 'idle', accountId: 'new-account' })
  })
  it('stops only the owned host without changing another real game or restoring its fields', async () => {
    const f = fixture(); const activity = { appId: 550, activeAppIds: [550] }; f.setContext(activity)
    await f.service.start({ ...f.action(), appId: 730, unverifiedPresence: { desc: 'Synthetic' } })
    const before = f.host.calls.length
    expect(await f.service.stop(f.action())).toMatchObject({ status: 'idle', appId: null, fields: {} })
    expect(f.host.calls.slice(before)).toEqual([{ op: 'shutdown' }])
    expect(await f.detector()).toMatchObject(activity)
  })
  it('keeps the Steam identity guard active while anonymous metadata inspection is waiting', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start({ ...f.action(), appId: 730 })
    const gate = deferred<GameStatusAppInfo>(); f.metadata.mockImplementationOnce(() => gate.promise)
    const inspecting = f.service.inspect({ ...f.action(), appId: 730 }); const rejected = expect(inspecting).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_CHANGED' })
    f.setContext({ appId: 550, steamPid: 1235 }); await vi.advanceTimersByTimeAsync(3000)
    expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_CONTEXT_CHANGED' } })
    expect(f.host.calls.at(-1)!.op).toBe('stop'); gate.resolve(INFO); await rejected
    expect(f.service.state().error?.code).toBe('LOCAL_APP_CONTEXT_CHANGED')
  })
  it('invalidates immediately but waits for cleanup, and shutdown is permanent', async () => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 730 }); const gate = deferred<void>(); f.host.gate = gate
    let done = false; const invalidating = f.service.invalidate().then(() => { done = true }); await flush()
    expect(f.service.state().status).toBe('idle'); expect(done).toBe(false)
    gate.resolve(); await invalidating; await f.service.shutdown()
    await expect(f.service.start({ ...f.action(), appId: 730 })).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_CHANGED' })
  })
  it('fetches real catalog tokens only through its already-running local helper', async () => {
    const f = fixture(); f.metadata.mockResolvedValue({ ...INFO, templates: [], templateStatus: 'unavailable' })
    const catalog = vi.fn(async (_language: 'schinese' | 'english') => ({ tokens: { '#Fixture': '%status%' } })); Object.assign(f.host, { catalog })
    expect((await f.service.inspect({ ...f.action(), appId: 730 })).templateStatus).toBe('unavailable'); expect(catalog).not.toHaveBeenCalled()
    const state = await f.service.start({ ...f.action(), appId: 730 })
    expect(state.appInfo?.templateStatus).toBe('available'); expect(catalog.mock.calls.map(call => call[0])).toEqual(['schinese', 'english'])
  })
  it('does not pretend an inaccessible local catalog is a published empty catalog', async () => {
    const f = fixture(); Object.assign(f.host, { catalog: vi.fn(async () => ({ available: false, tokens: {} })) })
    const state = await f.service.start({ ...f.action(), appId: 730 })
    expect(state.status).toBe('running'); expect(state.appInfo?.templateStatus).toBe('unavailable')
    await expect(f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: {} } })).rejects.toMatchObject({ code: 'LOCAL_APP_TEMPLATE_UNAVAILABLE' })
  })
  it('preserves fixed catalog diagnostics without ending the running simulation', async () => {
    const f = fixture(); Object.assign(f.host, { catalog: vi.fn(async () => ({ available: false, tokens: {}, code: 'LOCAL_APP_CATALOG_UNAVAILABLE', steamResult: 15 })) })
    const state = await f.service.start({ ...f.action(), appId: 730 })
    expect(state).toMatchObject({ status: 'running', error: null, appInfo: { templateStatus: 'unavailable', templateDiagnostics: { reason: 'lookup-unavailable', lookupCode: 'unavailable', steamResult: 15 } } })
    expect(f.host.calls.some(call => call.op === 'begin')).toBe(true); expect(f.host.calls.some(call => call.op === 'stop')).toBe(false)
  })
  it('keeps a verified empty local publication distinct from an unavailable response', async () => {
    const f = fixture(); Object.assign(f.host, { catalog: vi.fn(async () => ({ available: true, tokens: {} })) })
    expect(await f.service.start({ ...f.action(), appId: 730 })).toMatchObject({ status: 'running', appInfo: { templateStatus: 'empty', templateDiagnostics: { reason: 'empty', rawTokenCount: 0 } } })
  })
  it('keeps usable templates when an unrelated raw token exceeds shared template text limits', async () => {
    const f = fixture(); Object.assign(f.host, { catalog: vi.fn(async () => ({ available: true, tokens: { '#Ready': 'Ready', '#TooLongToRender': 'x'.repeat(4096) } })) })
    const state = await f.service.start({ ...f.action(), appId: 730 })
    expect(state.appInfo).toMatchObject({ templateStatus: 'available', templates: [{ token: '#Ready', text: 'Ready', parameters: [] }] })
  })
  it('does not allow start or inspect to overtake a pending stop', async () => {
    const f = fixture(); await f.service.start({ ...f.action(), appId: 730 }); const gate = deferred<void>(); f.host.gate = gate
    const stopping = f.service.stop(f.action())
    await expect(f.service.start({ ...f.action(), appId: 550 })).rejects.toMatchObject({ code: 'LOCAL_APP_BUSY' })
    await expect(f.service.inspect({ ...f.action(), appId: 550 })).rejects.toMatchObject({ code: 'LOCAL_APP_BUSY' })
    gate.resolve(); await stopping; expect(f.host.calls.filter(call => call.op === 'begin')).toHaveLength(1)
  })
  it('stops after a rejected/partial apply without replaying it or exposing raw errors', async () => {
    const f = fixture(); await f.service.inspect({ ...f.action(), appId: 730 })
    f.host.apply = vi.fn(async () => { throw new DomainError('LOCAL_APP_SET_REJECTED', 'fixture-private-payload') })
    await expect(f.service.start({ ...f.action(), appId: 730, presence: { displayToken: '#Fixture', values: { status: 'Fixture' } } })).rejects.toMatchObject({ code: 'LOCAL_APP_SET_REJECTED' })
    expect(f.host.apply).toHaveBeenCalledTimes(1); expect(f.host.calls.at(-1)!.op).toBe('stop')
    expect(f.service.state()).toMatchObject({ status: 'error', fields: {}, verificationSource: null })
    expect(JSON.stringify(f.service.state())).not.toContain('fixture-private-payload')
  })
})

class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough(); pid = 9999; killed = 0
  autoClose = true
  autoPong = true
  catalogResponse: object = { available: true, tokens: {} }
  readResponse: object = { fields: {}, keyCount: 0, localizedString: null, verificationSource: 'local-cache', displayTokenReadable: false }
  commands: Record<string, unknown>[] = []
  failureResponse: Record<string, unknown> | null = null
  constructor() { super(); this.stdin.on('data', bytes => {
    const request = JSON.parse(String(bytes)); this.commands.push(request)
    if (request.op === 'stop') { if (this.autoClose) queueMicrotask(() => this.emit('close', 0)); return }
    if (this.failureResponse) { queueMicrotask(() => this.reply({ v: 1, requestId: request.requestId, op: 'error', ok: false, acceptedKeys: [], mayHaveWritten: false, ...this.failureResponse })); return }
    if (request.op === 'ping' && !this.autoPong) return
    queueMicrotask(() => this.reply({ v: 1, requestId: request.requestId, op: request.op === 'ping' ? 'pong' : request.op === 'apply' ? 'applied' : request.op, ok: true, acceptedKeys: Object.keys(request.changes ?? {}), mayHaveWritten: request.op === 'apply', ...(request.op === 'read' ? this.readResponse : {}), ...(request.op === 'catalog' ? this.catalogResponse : {}) }))
  }) }
  reply(value: object) { this.stdout.write(JSON.stringify(value) + '\n') }
  ready(patch = {}) { this.reply({ v: 1, requestId: 'startup', op: 'ready', ok: true, acceptedKeys: [], mayHaveWritten: false, identityMatch: true, appMatch: true, licensed: true, selectedInterfaces: { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' }, ...patch }) }
  kill() { this.killed++; return true }
}
function brokerFixture() {
  const children: Child[] = []; const spawn = vi.fn((_worker: string, _args: string[]) => { const child = new Child(); children.push(child); queueMicrotask(() => child.ready()); return child as unknown as ChildProcessWithoutNullStreams })
  const broker = new LocalAppHostBroker({ getWorkerPath: () => 'D:/fixture/worker.exe', discover: async () => ({ worker: 'D:/fixture/worker.exe', clientDll: 'D:/Steam/steamclient64.dll', clientSha256: 'a'.repeat(64) }), spawn, stopTimeoutMs: 20, retireTimeoutMs: 40 })
  cleanups.push(async () => { for (const child of children) child.emit('close', 0); await broker.shutdown() })
  return { broker, children, spawn }
}
describe('direct stdio local-AppID broker', () => {
  it('binds the requested simulated AppID through the real broker while another AppID is active', async () => {
    const f = brokerFixture()
    const context = { ...CONTEXT, appId: 550, activeAppIds: [0, 550] }
    const service = new LocalAppSimulationService({ getActiveAccount: () => ACCOUNT,
      getWorkerPath: () => 'D:/fixture/worker.exe', host: f.broker, readContext: async () => structuredClone(context) })
    cleanups.push(() => service.shutdown())
    const action = { accountId: ACCOUNT.id, sessionId: service.state().sessionId }
    expect(await service.start({ ...action, appId: 4000 })).toMatchObject({ status: 'running', appId: 4000 })
    const args = f.spawn.mock.calls[0]![1]
    expect(args[args.indexOf('--app-id') + 1]).toBe('4000')
    expect(f.children).toHaveLength(1)
    expect(await service.stop(action)).toMatchObject({ status: 'idle', appId: null })
    expect(f.children[0]!.commands.at(-1)!.op).toBe('stop')
    expect(f.children[0]!.killed).toBe(0)
    expect(context).toMatchObject({ appId: 550, activeAppIds: [0, 550] })
  })

  it.each(preciseWorkerCodes)('preserves startup %s rather than reporting a generic missing component', async code => {
    const f = brokerFixture()
    f.spawn.mockImplementationOnce(() => {
      const child = new Child(); f.children.push(child)
      queueMicrotask(() => { child.stderr.write('private local path and SDK detail'); child.ready({ ok: false, code }) })
      return child as unknown as ChildProcessWithoutNullStreams
    })
    await expect(f.broker.begin(CONTEXT, 4000, () => true)).rejects.toMatchObject({ code })
    expect(f.children[0]!.commands.every(command => command.op === 'stop')).toBe(true)
  })
  it.each(preciseWorkerCodes)('accepts an associated error-op response and preserves %s on read', async code => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 4000, () => true)
    f.children[0]!.failureResponse = { code }
    await expect(f.broker.read(() => true)).rejects.toMatchObject({ code })
  })
  it('preserves a correlated partial apply rejection without retrying its changes', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 4000, () => true)
    const child = f.children[0]!; child.failureResponse = { code: 'LOCAL_APP_SET_REJECTED', acceptedKeys: ['desc'], mayHaveWritten: true }
    await expect(f.broker.apply({ desc: 'One', status: 'Two' }, () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_SET_REJECTED' })
    expect(child.commands.filter(command => command.op === 'apply')).toHaveLength(1)
  })
  it.each([
    { requestId: 'unrelated-request', code: 'LOCAL_APP_NOT_LICENSED' },
    { op: 'applied', code: 'LOCAL_APP_NOT_LICENSED' },
    { op: 'error', ok: true, code: 'LOCAL_APP_NOT_LICENSED' },
    { code: 'LOCAL_APP_UNTRUSTED_PRIVATE_ERROR' },
    { code: 'LOCAL_APP_NOT_LICENSED', acceptedKeys: ['desc'] },
    { code: 'LOCAL_APP_NOT_LICENSED', mayHaveWritten: true }
  ])('rejects an unassociated or invalid negative/success envelope %j', async patch => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 4000, () => true)
    f.children[0]!.failureResponse = patch
    await expect(f.broker.read(() => true)).rejects.toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID' })
  })
  it('rejects accepted keys outside the correlated apply request', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 4000, () => true)
    f.children[0]!.failureResponse = { code: 'LOCAL_APP_SET_REJECTED', acceptedKeys: ['map'], mayHaveWritten: true }
    await expect(f.broker.apply({ desc: 'Fixture' }, () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID' })
  })
  it('passes only the pinned DLL/process/AppID binding and supports a heartbeat after ready', async () => {
    vi.useFakeTimers(); const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    const args = f.spawn.mock.calls[0]![1]; expect(args).toHaveLength(16); expect(args).toContain('--client-sha256'); expect(args).toContain('--owner-start'); expect(args.join(' ')).not.toContain('webLogonToken')
    await vi.advanceTimersByTimeAsync(5000); expect(f.children[0]!.commands.some(command => command.op === 'ping')).toBe(true)
  })
  it('does not spawn after the asynchronous binding was cancelled', async () => {
    const binding = deferred<{ worker: string; clientDll: string; clientSha256: string }>(); const spawn = vi.fn()
    const broker = new LocalAppHostBroker({ getWorkerPath: () => '', discover: () => binding.promise, spawn })
    const pending = broker.begin(CONTEXT, 730, () => true); const rejected = expect(pending).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_CHANGED' }); broker.stop()
    binding.resolve({ worker: 'D:/fixture/worker.exe', clientDll: 'D:/Steam/steamclient64.dll', clientSha256: 'a'.repeat(64) }); await rejected; expect(spawn).not.toHaveBeenCalled()
  })
  it('waits for close, ignores late responses while stopping and never overlaps helpers', async () => {
    const f = brokerFixture(); expect(f.broker.hasClientWork()).toBe(false)
    await f.broker.begin(CONTEXT, 730, () => true); const first = f.children[0]!; first.autoClose = false
    expect(f.broker.hasClientWork()).toBe(true)
    let done = false; const stopping = f.broker.shutdown().then(() => { done = true }); await flush(); first.reply({ v: 1, requestId: 'late', op: 'applied', ok: true }); expect(done).toBe(false)
    const replacement = f.broker.begin(CONTEXT, 550, () => true); await flush(); expect(f.children).toHaveLength(1)
    expect(f.broker.hasClientWork()).toBe(true)
    first.emit('close', 0); await stopping; await replacement; expect(f.children).toHaveLength(2)
    await f.broker.shutdown(); expect(f.broker.hasClientWork()).toBe(false)
  })
  it('refuses a replacement after an unconfirmed forced exit', async () => {
    vi.useFakeTimers(); const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true); const first = f.children[0]!; first.autoClose = false
    const closing = f.broker.shutdown(); const rejected = expect(closing).rejects.toMatchObject({ code: 'LOCAL_APP_STOP_FAILED' }); await vi.advanceTimersByTimeAsync(45); await rejected
    expect(first.killed).toBe(1); await expect(f.broker.begin(CONTEXT, 550, () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_STOP_FAILED' }); expect(f.children).toHaveLength(1)
    expect(f.broker.hasClientWork()).toBe(true)
  })
  it('rejects an identity or interface mismatch before any RPC writes', async () => {
    const f = brokerFixture(); f.spawn.mockImplementationOnce(() => { const child = new Child(); f.children.push(child); queueMicrotask(() => child.ready({ identityMatch: false })); return child as unknown as ChildProcessWithoutNullStreams })
    await expect(f.broker.begin(CONTEXT, 730, () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID' })
    expect(f.children[0]!.commands.every(command => command.op === 'stop')).toBe(true)
  })
  it('waits for an in-flight lease ping instead of failing a user read as busy', async () => {
    vi.useFakeTimers(); const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true); const child = f.children[0]!; child.autoPong = false
    await vi.advanceTimersByTimeAsync(5000); const ping = child.commands.at(-1)!
    const read = f.broker.read(() => true); await flush(); expect(child.commands.at(-1)).toBe(ping)
    child.reply({ v: 1, requestId: ping.requestId, op: 'pong', ok: true, acceptedKeys: [], mayHaveWritten: false })
    await expect(read).resolves.toEqual(READ)
  })
  it('supports a bounded catalog larger than a regular RPC frame and keeps availability explicit', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true); const child = f.children[0]!
    const tokens = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`#Fixture${i}`, 'x'.repeat(1600)]))
    child.catalogResponse = { available: true, tokens }; expect(await f.broker.catalog('schinese', () => true)).toEqual({ available: true, tokens })
    child.catalogResponse = { available: false, tokens: {}, code: 'LOCAL_APP_CATALOG_UNAVAILABLE' }
    expect(await f.broker.catalog('english', () => true)).toEqual({ available: false, tokens: {}, code: 'LOCAL_APP_CATALOG_UNAVAILABLE' })
  })
  it.each([256, 257, 1024])('accepts %i bounded raw catalog entries for shared template selection', async count => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    const tokens = Object.fromEntries(Array.from({ length: count }, (_, index) => [`#Fixture${index}`, 'Ready']))
    f.children[0]!.catalogResponse = { available: true, tokens }
    expect(await f.broker.catalog('english', () => true)).toEqual({ available: true, tokens })
  })
  it('keeps a 4096-byte raw value or invalid template content isolated for shared per-template filtering', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    const tokens = { '#Ready': 'Ready', '#Long': 'x'.repeat(4096), '#Multiline': 'Line one\nline two', 'not-a-display-token': 'Unused raw catalog record' }
    f.children[0]!.catalogResponse = { available: true, tokens }
    expect(await f.broker.catalog('english', () => true)).toEqual({ available: true, tokens })
  })
  it('preserves only fixed lookup codes and bounded Steam results without closing the simulation', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    for (const code of ['LOCAL_APP_CATALOG_UNAVAILABLE', 'LOCAL_APP_CATALOG_TIMEOUT', 'LOCAL_APP_CATALOG_RESPONSE_INVALID', 'LOCAL_APP_CATALOG_CANCELLED', 'LOCAL_APP_CATALOG_LANGUAGE_MISSING', 'LOCAL_APP_CATALOG_APP_MISMATCH']) {
      f.children[0]!.catalogResponse = { available: false, tokens: {}, code, steamResult: 15 }
      expect(await f.broker.catalog('english', () => true)).toEqual({ available: false, tokens: {}, code, steamResult: 15 })
    }
    f.children[0]!.catalogResponse = { available: true, tokens: {} }
    expect(await f.broker.catalog('english', () => true)).toEqual({ available: true, tokens: {} })
    expect(await f.broker.read(() => true)).toEqual(READ)
  })
  it.each([
    { available: false, tokens: {}, code: 'private-file-path secret' },
    { available: false, tokens: {}, steamResult: '15' },
    { available: false, tokens: {}, steamResult: 256 },
    { available: false, tokens: {}, steamResult: -1 },
    { available: false, tokens: {}, steamResult: 1.5 },
    { available: true, tokens: {}, code: 'LOCAL_APP_CATALOG_UNAVAILABLE' },
    { available: false, tokens: { '#Partial': 'Unverified' } },
    { available: true, tokens: { '#Big': 'x'.repeat(4097) } },
    { available: true, tokens: { ['#' + 'x'.repeat(128)]: 'Oversized name' } },
    { available: true, tokens: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`#F${index}`, 'x'])) },
    { available: true, tokens: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`#F${index}`, 'x'.repeat(4096)])) }
  ])('rejects unsafe or excessive raw catalog envelopes', async response => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    f.children[0]!.catalogResponse = response
    await expect(f.broker.catalog('english', () => true)).rejects.toMatchObject({ code: 'LOCAL_APP_PROTOCOL_INVALID' })
  })
  it('accepts localized readback separately from an unreadable raw display token', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    const localizedString = 'x'.repeat(1024)
    f.children[0]!.readResponse = { fields: { desc: 'Fixture room' }, keyCount: 2, localizedString, displayTokenReadable: false, verificationSource: 'local-cache' }
    expect(await f.broker.read(() => true)).toEqual({ fields: { desc: 'Fixture room' }, localizedString, verificationSource: 'local-cache' })
  })
  it('accepts a legal maximally escaped public read larger than a request line', async () => {
    const f = brokerFixture(); await f.broker.begin(CONTEXT, 730, () => true)
    const fields = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [('field' + index).padEnd(63, '_'), '"'.repeat(255)]))
    const localizedString = '\\'.repeat(4096)
    f.children[0]!.readResponse = { fields, keyCount: 20, localizedString, displayTokenReadable: false, verificationSource: 'local-cache' }
    expect(Buffer.byteLength(JSON.stringify(f.children[0]!.readResponse))).toBeGreaterThan(16 * 1024)
    expect(await f.broker.read(() => true)).toEqual({ fields, localizedString, verificationSource: 'local-cache' })
  })
})

describe('short-lived anonymous metadata boundary', () => {
  it('defaults to public name/icon only rather than retrying known unauthorized anonymous RP access', async () => {
    class Metadata extends EventEmitter implements AnonymousAppMetadataClient {
      logOn() { queueMicrotask(() => this.emit('loggedOn')) }
      logOff() {}
      async getProductInfo() { return { apps: { 730: { appinfo: { common: { name: 'Public fixture' } } } } } }
      getAppRichPresenceLocalization = vi.fn(async () => { throw new Error('Must not request anonymous RP') })
    }
    const client = new Metadata(); const info = await readLocalAppMetadata(730, 'schinese', { createClient: () => client })
    expect(info).toMatchObject({ name: 'Public fixture', templateStatus: 'unavailable', templates: [] }); expect(client.getAppRichPresenceLocalization).not.toHaveBeenCalled()
  })
  it('uses anonymous:true and public PICS, really requests localization and closes on completion', async () => {
    class Metadata extends EventEmitter implements AnonymousAppMetadataClient {
      calls: unknown[] = []; stopped = 0
      logOn(details: { anonymous: true }) { this.calls.push(details); queueMicrotask(() => this.emit('loggedOn')) }
      logOff() { this.stopped++ }
      async getProductInfo(_apps: number[], _packages: number[], tokens?: boolean) { this.calls.push({ tokens }); return { apps: { 730: { appinfo: { common: { name: 'Public fixture' } } } } } }
      async getAppRichPresenceLocalization(appId: number, language: string) { this.calls.push({ appId, language }); return { tokens: { '#Fixture': '%status%' } } }
    }
    const client = new Metadata(); const info = await readLocalAppMetadata(730, 'schinese', { createClient: () => client, includeLocalization: true })
    expect(client.calls).toEqual([{ anonymous: true }, { tokens: false }, { appId: 730, language: 'schinese' }, { appId: 730, language: 'english' }]); expect(info.templateStatus).toBe('available'); expect(client.stopped).toBe(1)
  })
  it('does not invent templates when localization is inaccessible', async () => {
    class Metadata extends EventEmitter implements AnonymousAppMetadataClient {
      logOn() { queueMicrotask(() => this.emit('loggedOn')) }
      logOff() {}
      async getProductInfo() { return { apps: { 730: { appinfo: { common: { name: 'Public fixture' } } } } } }
      async getAppRichPresenceLocalization() { throw new Error('fixture private error') }
    }
    const info = await readLocalAppMetadata(730, 'schinese', { createClient: () => new Metadata(), includeLocalization: true })
    expect(info).toMatchObject({ name: 'Public fixture', templates: [], templateStatus: 'unavailable' })
  })
})
