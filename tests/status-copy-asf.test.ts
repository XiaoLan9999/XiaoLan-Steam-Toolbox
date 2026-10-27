import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsfStatusCopyBackend } from '../src/main/status-copy-asf'
import type { StatusCopyBackendContext, StatusCopyLocalContext } from '../src/main/status-copy-backend'
import type { StatusCopySettingsInput } from '../src/shared/status-copy'

const sourceId = '76561198000000001'
const targetId = '76561198000000002'
const otherId = '76561198000000003'
type Config = { MainBot: string; SourceBots: string[]; AllowedApps: number[]; StartupMode: string; PollIntervalSeconds: number }
const emptyConfig = (): Config => ({ MainBot: '', SourceBots: [], AllowedApps: [730], StartupMode: 'Observe', PollIntervalSeconds: 15 })
const oldConfig = (mode = 'Off'): Config => ({ MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [570], StartupMode: mode, PollIntervalSeconds: 30 })
function fixture() {
  let now = Date.parse('2026-10-22T12:00:00Z')
  const controller = new AbortController()
  const local: StatusCopyLocalContext = { steamId: sourceId, appId: 730, steamPid: 123, steamStartTicks: '638900000000000000' }
  let valid = true
  const context: StatusCopyBackendContext = {
    target: { accountId: 'target-account', steamId: targetId }, sourceSteamId: sourceId, signal: controller.signal,
    assertCurrent() { if (!valid) throw new Error('fixture invalidated') }, checkLocal: vi.fn(async () => ({ ...local }))
  }
  const settings: StatusCopySettingsInput = { mode: 'asf', sourceSteamId: sourceId, intervalSeconds: 15, copyGroupSize: false, persona: 'away', asf: { url: 'https://asf.example.test', botName: 'Target', password: 'fixture-ipc-secret' } }
  const data = {
    config: emptyConfig(), selected: 'Source', fields: { desc: 'In menu', steam_display: '#Status', connect: 'private-connect', steam_player_group: 'private-group', steam_player_group_size: '4', auth_token: 'private-token' } as Record<string, string>,
    observed: new Date(now).toISOString() as string | null, upload: null as string | null, available: true,
    bots: { Target: { SteamID: targetId, IsConnectedAndLoggedOn: true }, Source: { SteamID: sourceId, IsConnectedAndLoggedOn: true }, Other: { SteamID: otherId, IsConnectedAndLoggedOn: true } } as Record<string, Record<string, unknown>>,
    before: null as ((command: string | null, route: string) => Promise<Response | void> | Response | void) | null,
    after: null as ((command: string | null, route: string) => Promise<Response | void> | Response | void) | null
  }
  const commands: string[] = []
  const requests: Array<{ url: string; init: RequestInit }> = []
  const respond = (result: unknown): Response => new Response(JSON.stringify({ Success: true, Result: result }), { headers: { 'Content-Type': 'application/json' } })
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); const route = new URL(url).pathname
    const command = init.body ? (JSON.parse(String(init.body)) as { Command: string }).Command : null
    requests.push({ url, init }); if (command) commands.push(command)
    const before = await data.before?.(command, route)
    if (before) return before
    let result: unknown
    if (route.endsWith('/Api/Bot/ASF')) result = data.bots
    else if (command === 'RPRELAY COPYCAPS') result = JSON.stringify({ protocol: 1, safeFields: true, groupIdentifiers: false, groupSize: false, sources: 'registered-bots' })
    else if (command === 'RPRELAY CONFIG') result = JSON.stringify(data.config)
    else if (command === 'RPRELAY STATE') result = JSON.stringify({ Mode: data.config.StartupMode, MainBot: data.config.MainBot, SelectedSourceBot: data.selected, ActiveAppId: data.config.StartupMode === 'On' ? data.config.AllowedApps[0] : 0, MainAvailable: data.available, ObservedAt: data.observed, LastUploadAt: data.upload, RichPresence: data.fields, Detail: 'private-sdk-error-token' })
    else if (command?.startsWith('RPRELAY APPLY ')) {
      data.config = JSON.parse(Buffer.from(command.slice('RPRELAY APPLY '.length), 'base64').toString()) as Config
      data.observed = new Date(now).toISOString()
      result = 'ASFStatusRelay: configuration saved and applied.'
    } else if (command === 'RPRELAY ON' || command === 'RPRELAY OFF') {
      data.config.StartupMode = command === 'RPRELAY ON' ? 'On' : 'Off'
      data.observed = new Date(now).toISOString()
      if (command === 'RPRELAY ON') data.upload = new Date(now).toISOString()
      result = 'ASFStatusRelay: mode applied.'
    } else throw new Error('unexpected-command')
    return await data.after?.(command, route) || respond(result)
  }) as unknown as typeof fetch
  const backend = new AsfStatusCopyBackend({ fetch: fetcher, now: () => now })
  return { backend, context, settings, data, commands, requests, controller, local, respond, fetcher, invalidate: () => { valid = false; controller.abort() }, advance: (ms: number) => { now += ms } }
}
const mutations = (commands: string[]) => commands.filter(value => !['RPRELAY CONFIG', 'RPRELAY STATE', 'RPRELAY COPYCAPS'].includes(value))
afterEach(() => { vi.useRealTimers() })

describe('ASF status copy fixed protocol', () => {
  it.each(['start', 'preview'] as const)('refuses an old 0.2 plugin without COPYCAPS before any %s mutation', async operation => {
    const f = fixture()
    f.data.before = command => command === 'RPRELAY COPYCAPS' ? f.respond('ASFStatusRelay: unknown command') : undefined
    await expect(operation === 'start' ? f.backend.start(f.context, f.settings, true) : f.backend.preview(f.context, f.settings)).rejects.toMatchObject({ code: 'COPY_ASF_INCOMPATIBLE' })
    expect(f.commands).toEqual(['RPRELAY COPYCAPS'])
    await f.backend.stop(); expect(mutations(f.commands)).toEqual([])
  })

  it.each([
    {}, { protocol: 1, safeFields: false, groupIdentifiers: false, groupSize: false, sources: 'registered-bots' },
    { protocol: 2, safeFields: true, groupIdentifiers: false, groupSize: false, sources: 'registered-bots' },
    { protocol: 1, safeFields: true, groupIdentifiers: true, groupSize: false, sources: 'registered-bots' },
    { protocol: 1, safeFields: true, groupIdentifiers: false, groupSize: true, sources: 'registered-bots' },
    { protocol: 1, safeFields: true, groupIdentifiers: false, groupSize: false, sources: 'friends' },
    { protocol: 1, safeFields: true, groupIdentifiers: false, groupSize: false, sources: 'registered-bots', unexpected: true }
  ])('rejects incompatible capability JSON %#', async caps => {
    const f = fixture(); f.data.before = command => command === 'RPRELAY COPYCAPS' ? f.respond(JSON.stringify(caps)) : undefined
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_ASF_INCOMPATIBLE' })
    expect(mutations(f.commands)).toEqual([])
  })

  it('configures Observe, confirms its source session, then turns On without a generic command', async () => {
    const f = fixture()
    const report = await f.backend.start(f.context, f.settings, false)
    expect(report).toMatchObject({ source: { steamId: sourceId, appId: 730, fields: { desc: 'In menu', steam_display: '#Status' }, authority: 'asf-source-session', groupSize: null }, targetAppId: 730, waiting: false, verification: 'not-verified' })
    expect(Object.keys(report.source!.fields)).toEqual(['desc', 'steam_display'])
    expect(JSON.stringify(report)).not.toMatch(/private-|fixture-ipc-secret|Target|Source/)
    const writes = mutations(f.commands)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatch(/^RPRELAY APPLY [A-Za-z0-9+/]+=*$/)
    expect(JSON.parse(Buffer.from(writes[0]!.slice(14), 'base64').toString())).toEqual({ MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [730], StartupMode: 'Observe', PollIntervalSeconds: 15 })
    expect(writes[1]).toBe('RPRELAY ON')
    expect(f.requests.every(request => request.init.redirect === 'error' && new Headers(request.init.headers).get('Authentication') === 'fixture-ipc-secret')).toBe(true)
  })

  it('stops only its fingerprint and leaves a new configuration Off without starting a bot', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    f.invalidate()
    await f.backend.stop()
    expect(f.data.config.StartupMode).toBe('Off')
    expect(mutations(f.commands).at(-1)).toBe('RPRELAY OFF')
    expect(f.commands.some(command => /START|STOP |VERIFY|SOURCE|STATUS/.test(command))).toBe(false)
    await expect(f.backend.stop()).resolves.toBeUndefined()
  })

  it.each(['Off', 'Observe'])('restores a consented previous %s configuration, never its old task as On', async mode => {
    const f = fixture(); f.data.config = oldConfig(mode)
    await f.backend.start(f.context, f.settings, true); f.invalidate(); await f.backend.stop()
    expect(f.data.config).toEqual(oldConfig(mode))
    const writes = mutations(f.commands)
    expect(writes.slice(-2)[0]).toBe('RPRELAY OFF')
    expect(writes.at(-1)).toMatch(/^RPRELAY APPLY /)
    expect(writes.filter(command => command === 'RPRELAY ON')).toHaveLength(1)
  })

  it('never overwrites an existing On task even with replacement consent', async () => {
    const f = fixture(); f.data.config = oldConfig('On')
    await expect(f.backend.start(f.context, f.settings, true)).rejects.toMatchObject({ code: 'COPY_ASF_CONFIG_CONFLICT' })
    await f.backend.stop()
    expect(mutations(f.commands)).toEqual([])
  })

  it('requires explicit consent to replace an Off route', async () => {
    const f = fixture(); f.data.config = oldConfig()
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_ASF_CONFIG_CONFLICT' })
    await f.backend.stop(); expect(mutations(f.commands)).toEqual([])
  })

  it('rejects group-size copying before making a request', async () => {
    const f = fixture(); f.settings.copyGroupSize = true
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_ASF_GROUP_UNSUPPORTED' })
    expect(f.requests).toEqual([])
  })

  it.each(['http://user:secret@host/', 'https://host/?password=x', 'https://host/#secret', 'https://host/?', 'https://host/#', 'https://@host/', 'file:///Api', 'ftp://host/'])('rejects unsafe URL %s', async url => {
    const f = fixture(); f.settings.asf!.url = url
    await expect(f.backend.preview(f.context, f.settings)).rejects.toMatchObject({ code: 'COPY_INVALID_INPUT' })
    expect(f.requests).toEqual([])
  })

  it.each([0, 14, 121, 15.1])('rejects unsupported polling interval %s', async interval => {
    const f = fixture(); f.settings.intervalSeconds = interval
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_INVALID_INPUT' })
    expect(f.requests).toEqual([])
  })

  it('binds target name and exact UInt64 SteamID without numeric rounding', async () => {
    const f = fixture()
    f.data.before = (_, route) => route.endsWith('/Bot/ASF') ? new Response(`{"Success":true,"Result":{"Target":{"SteamID":${targetId},"IsConnectedAndLoggedOn":true},"Source":{"SteamID":${sourceId},"IsConnectedAndLoggedOn":true}}}`) : undefined
    await expect(f.backend.start(f.context, f.settings, false)).resolves.toMatchObject({ targetAppId: 730 })
    const wrong = fixture(); wrong.data.bots.Target!.SteamID = otherId
    await expect(wrong.backend.start(wrong.context, wrong.settings, false)).rejects.toMatchObject({ code: 'COPY_IDENTITY_MISMATCH' })
    expect(mutations(wrong.commands)).toEqual([])
  })

  it.each(['offline', 'missing', 'alias'])('requires a unique already logged-on source bot: %s', async kind => {
    const f = fixture()
    if (kind === 'offline') f.data.bots.Source!.IsConnectedAndLoggedOn = false
    if (kind === 'missing') delete f.data.bots.Source
    if (kind === 'alias') f.data.bots.Other!.SteamID = sourceId
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_ASF_BOT_UNAVAILABLE' })
    expect(mutations(f.commands)).toEqual([])
  })

  it('does not treat an arbitrary friend ID or local identity mismatch as the source bot', async () => {
    const f = fixture(); f.local.steamId = otherId
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_IDENTITY_MISMATCH' })
    expect(f.requests).toEqual([])
  })

  it('rejects malformed or unknown plugin configuration without changes', async () => {
    const f = fixture(); f.data.before = command => command === 'RPRELAY CONFIG' ? f.respond('unknown command RPRELAY CONFIG') : undefined
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_ASF_INCOMPATIBLE' })
    expect(mutations(f.commands)).toEqual([])
  })

  it.each([
    { MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [730], StartupMode: 'Off', PollIntervalSeconds: 1 },
    { MainBot: 'Target', SourceBots: ['Target'], AllowedApps: [730], StartupMode: 'Off', PollIntervalSeconds: 15 },
    { MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [0], StartupMode: 'Off', PollIntervalSeconds: 15 },
    { MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [730, 730], StartupMode: 'Off', PollIntervalSeconds: 15 },
    { MainBot: 'Target', SourceBots: ['Source'], AllowedApps: [730], StartupMode: 'Off', PollIntervalSeconds: 15, Unknown: 'keep me' }
  ])('validates the complete existing configuration %#', async config => {
    const f = fixture(); f.data.config = config
    await expect(f.backend.start(f.context, f.settings, true)).rejects.toMatchObject({ code: 'COPY_ASF_INCOMPATIBLE' })
    expect(mutations(f.commands)).toEqual([])
  })

  it('only previews an exact configuration and never mutates', async () => {
    const f = fixture()
    expect(await f.backend.preview(f.context, f.settings)).toMatchObject({ source: null, waiting: true, warnings: ['COPY_ASF_CONFIG_CONFLICT'] })
    f.data.config = { ...oldConfig('Observe'), AllowedApps: [730], PollIntervalSeconds: 15 }
    expect(await f.backend.preview(f.context, f.settings)).toMatchObject({ source: { appId: 730 }, targetAppId: null, verification: 'not-verified' })
    expect(mutations(f.commands)).toEqual([])
  })

  it('does not replace a configuration referring to an unregistered bot', async () => {
    const f = fixture(); f.data.config = { ...oldConfig(), SourceBots: ['Missing'] }
    await expect(f.backend.start(f.context, f.settings, true)).rejects.toMatchObject({ code: 'COPY_ASF_INCOMPATIBLE' })
    expect(mutations(f.commands)).toEqual([])
  })

  it('confirms previous Observe mode in STATE instead of trusting only its saved CONFIG', async () => {
    const f = fixture(); f.data.config = oldConfig('Observe')
    await f.backend.start(f.context, f.settings, true)
    let restoring = false
    f.data.after = command => { if (command?.startsWith('RPRELAY APPLY')) restoring = true }
    f.data.before = command => {
      if (restoring && command === 'RPRELAY STATE') return f.respond(JSON.stringify({ Mode: 'On', MainBot: 'Target', SelectedSourceBot: 'Source', ActiveAppId: 570, MainAvailable: true, LastUploadAt: null, ObservedAt: '2026-10-22T12:00:00Z', RichPresence: {} }))
    }
    await expect(f.backend.stop()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    f.data.before = null
    await expect(f.backend.stop()).resolves.toBeUndefined()
    expect(f.data.config).toEqual(oldConfig('Observe'))
  })

  it('waits for an actual selected source session rather than turning On from friend persona', async () => {
    const f = fixture(); f.data.selected = ''
    const report = await f.backend.start(f.context, f.settings, false)
    expect(report).toMatchObject({ source: null, waiting: true, warnings: ['COPY_SOURCE_NOT_PLAYING'] })
    expect(mutations(f.commands)).toHaveLength(1)
    f.data.selected = 'Source'
    expect(await f.backend.tick(f.context, f.settings)).toMatchObject({ waiting: false, targetAppId: 730 })
  })

  it('rejects stale STATE as fresh and does not turn On', async () => {
    const f = fixture()
    f.data.after = command => { if (command?.startsWith('RPRELAY APPLY')) f.data.observed = '2026-10-21T00:00:00Z' }
    expect(await f.backend.start(f.context, f.settings, false)).toMatchObject({ source: null, waiting: true, warnings: ['COPY_SOURCE_STALE'] })
    expect(f.commands).not.toContain('RPRELAY ON')
  })

  it('filters private or unknown fields even if they are present in a capability-advertising STATE', async () => {
    const f = fixture(); f.data.fields = { desc: 'https://example.test/join/fixture', 'game:server': 'private-server', room: 'private-room', join_token: 'private-join', session: 'private-session', custom: 'private-unknown', status: 'Public menu', steam_display: '#Status' }
    const report = await f.backend.start(f.context, f.settings, false)
    expect(report.source!.fields).toEqual({ status: 'Public menu', steam_display: '#Status' })
    expect(JSON.stringify(report)).not.toMatch(/example\.test|private-/)
  })

  it('requires local source AppID to remain identical across every request', async () => {
    const f = fixture(); f.data.after = command => { if (command?.startsWith('RPRELAY APPLY')) f.local.appId = 570 }
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_SOURCE_STALE' })
    expect(f.commands).not.toContain('RPRELAY ON')
    await f.backend.stop(); expect(f.data.config.StartupMode).toBe('Off')
  })

  it('does not overwrite a foreign configuration on tick or stop', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    f.data.config.AllowedApps = [570]
    const before = mutations(f.commands).length
    await expect(f.backend.tick(f.context, f.settings)).rejects.toMatchObject({ code: 'COPY_ASF_CONFIG_CONFLICT' })
    await expect(f.backend.stop()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    expect(mutations(f.commands)).toHaveLength(before)
  })

  it('does not re-enable a task manually switched Off', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    f.data.config.StartupMode = 'Off'
    await expect(f.backend.tick(f.context, f.settings)).rejects.toMatchObject({ code: 'COPY_ASF_CONFIG_CONFLICT' })
    expect(f.commands.filter(command => command === 'RPRELAY ON')).toHaveLength(1)
  })

  it('safely stops its own old app, applies Observe for the new app, then On', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    const before = mutations(f.commands).length; f.local.appId = 570; f.advance(15_000)
    expect(await f.backend.tick(f.context, f.settings)).toMatchObject({ targetAppId: 570, source: { appId: 570 } })
    const writes = mutations(f.commands).slice(before)
    expect(writes[0]).toBe('RPRELAY OFF'); expect(writes[1]).toMatch(/^RPRELAY APPLY /); expect(writes[2]).toBe('RPRELAY ON')
    expect(f.data.config.AllowedApps).toEqual([570])
  })

  it('waits at source app zero without creating a configuration or clearing another task', async () => {
    const f = fixture(); f.local.appId = 0
    expect(await f.backend.start(f.context, f.settings, false)).toMatchObject({ waiting: true, source: null })
    expect(mutations(f.commands)).toEqual([])
    f.local.appId = 730
    expect(await f.backend.tick(f.context, f.settings)).toMatchObject({ targetAppId: 730 })
    f.local.appId = 0
    expect(await f.backend.tick(f.context, f.settings)).toMatchObject({ waiting: true, source: null })
    expect(mutations(f.commands).at(-1)).toBe('RPRELAY OFF')
    f.local.appId = 570
    expect(await f.backend.tick(f.context, f.settings)).toMatchObject({ targetAppId: 570 })
  })

  it('recognizes its route and stops even when ON committed but its response was lost', async () => {
    const f = fixture(); let lost = true
    f.data.after = command => { if (command === 'RPRELAY ON' && lost) { lost = false; throw new Error('private-sdk-password=fixture-ipc-secret') } }
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_REQUEST_FAILED', message: 'COPY_REQUEST_FAILED' })
    expect(f.data.config.StartupMode).toBe('On')
    f.invalidate(); await f.backend.stop()
    expect(f.data.config.StartupMode).toBe('Off')
  })

  it('leaves stop unconfirmed on transport failure, then allows an explicit retry', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    f.data.before = () => { throw new Error('secret transport URL') }
    await expect(f.backend.stop()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED', message: 'COPY_STOP_UNCONFIRMED' })
    f.data.before = null
    await expect(f.backend.stop()).resolves.toBeUndefined()
    expect(f.data.config.StartupMode).toBe('Off')
  })

  it.each(['identity', 'instance', 'exited'])('can stop its remote route after local Steam %s changes', async kind => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    if (kind === 'identity') f.local.steamId = targetId
    else if (kind === 'instance') f.local.steamStartTicks = '638900000000000001'
    else f.context.checkLocal = vi.fn(async () => { throw new Error('Steam has exited') })
    f.invalidate()
    await expect(f.backend.stop()).resolves.toBeUndefined()
    expect(mutations(f.commands).at(-1)).toBe('RPRELAY OFF')
    expect(f.data.config.StartupMode).toBe('Off')
  })

  it('can stop and restore Off even if the source bot is disconnected with SteamID zero', async () => {
    const f = fixture(); f.data.config = oldConfig('Off')
    await f.backend.start(f.context, f.settings, true)
    f.data.bots.Source!.IsConnectedAndLoggedOn = false; f.data.bots.Source!.SteamID = '0'
    f.context.checkLocal = vi.fn(async () => { throw new Error('Do not inspect local Steam while stopping') })
    f.invalidate()
    await expect(f.backend.stop()).resolves.toBeUndefined()
    expect(f.data.config).toEqual(oldConfig('Off'))
    expect(f.context.checkLocal).not.toHaveBeenCalled()
    expect(f.commands.some(command => /^STOP|^START/.test(command))).toBe(false)
  })

  it('can stop a new route when the source bot has been removed', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    delete f.data.bots.Source; f.invalidate()
    await expect(f.backend.stop()).resolves.toBeUndefined()
    expect(f.data.config.StartupMode).toBe('Off')
  })

  it('still refuses remote stop if the target bot now resolves to a different account', async () => {
    const f = fixture(); await f.backend.start(f.context, f.settings, false)
    const before = mutations(f.commands).length; f.data.bots.Target!.SteamID = otherId
    await expect(f.backend.stop()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    expect(mutations(f.commands)).toHaveLength(before)
  })

  it('does not make a new ON mutation after stop during an in-flight request', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    f.data.after = async command => {
      if (command?.startsWith('RPRELAY APPLY')) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    }
    const start = f.backend.start(f.context, f.settings, false)
    const rejected = expect(start).rejects.toMatchObject({ code: 'COPY_SESSION_CHANGED' })
    await enteredPromise
    const stop = f.backend.stop(); release(); await rejected; await stop
    expect(f.commands).not.toContain('RPRELAY ON')
    expect(f.data.config.StartupMode).toBe('Off')
  })

  it('rejects concurrent operations without a second request sequence', async () => {
    const f = fixture(); let release!: () => void
    f.data.before = async (_, route) => { if (route.endsWith('/Bot/ASF')) await new Promise<void>(resolve => { release = resolve }) }
    const start = f.backend.start(f.context, f.settings, false)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(f.backend.preview(f.context, f.settings)).rejects.toMatchObject({ code: 'COPY_BUSY' })
    f.data.before = null; release(); await start
  })

  it('bounds a fetch that ignores AbortSignal to ten seconds', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.data.before = async () => new Promise<Response>(() => {})
    const operation = f.backend.start(f.context, f.settings, false)
    const assertion = expect(operation).rejects.toMatchObject({ code: 'COPY_REQUEST_FAILED' })
    await vi.advanceTimersByTimeAsync(10_001); await assertion
    expect(mutations(f.commands)).toEqual([])
  })

  it.each(['length', 'stream', 'redirect'])('bounds or rejects HTTP response %s', async kind => {
    const f = fixture()
    f.data.before = () => {
      if (kind === 'length') return new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } })
      if (kind === 'stream') return new Response(new Uint8Array(1024 * 1024 + 1))
      const response = f.respond({}); Object.defineProperty(response, 'redirected', { value: true }); return response
    }
    await expect(f.backend.start(f.context, f.settings, false)).rejects.toMatchObject({ code: 'COPY_REQUEST_FAILED' })
    expect(mutations(f.commands)).toEqual([])
  })
})
