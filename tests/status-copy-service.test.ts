import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusCopyService, type StatusCopyServiceOptions } from '../src/main/status-copy-service'
import type { StatusCopyBackend, StatusCopyBackendContext, StatusCopyLocalContext } from '../src/main/status-copy-backend'
import type { StatusCopyReport, StatusCopySettingsInput } from '../src/shared/status-copy'

const TARGET = '76561198000000001', SOURCE = '76561198000000002', OTHER = '76561198000000003'
const settings: StatusCopySettingsInput = { mode: 'toolbox', sourceSteamId: SOURCE, intervalSeconds: 5, copyGroupSize: false, persona: 'away' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function report(): StatusCopyReport { return { source: { steamId: SOURCE, appId: 730, gameName: 'Fixture', fields: { steam_display: '#Playing', map: 'Office' }, groupSize: 2, observedAt: new Date().toISOString(), authority: 'local-source-session' }, targetAppId: 730, appliedAt: null, verification: 'not-verified', waiting: false, warnings: [] } }
class Backend implements StatusCopyBackend {
  preview = vi.fn(async (_context: StatusCopyBackendContext) => report())
  start = vi.fn(async (_context: StatusCopyBackendContext) => report())
  tick = vi.fn(async (_context: StatusCopyBackendContext) => report())
  stop = vi.fn(async () => {})
}
function fixture(options: Partial<StatusCopyServiceOptions> = {}) {
  let account: { id: string; steamId: string } | null = { id: 'account-a', steamId: TARGET }
  let local: StatusCopyLocalContext = { steamId: SOURCE, appId: 730, steamPid: 10, steamStartTicks: '100' }
  const backend = new Backend(); const factory = vi.fn(() => backend); const before = vi.fn(async () => {})
  const service = new StatusCopyService({ getActiveAccount: () => account, readLocalContext: async () => ({ ...local }), beforeStart: before, createBackend: factory, ...options })
  const input = (overrides: Partial<StatusCopySettingsInput> = {}) => ({ accountId: account!.id, sessionId: service.state().sessionId, settings: { ...settings, ...overrides } })
  return { service, backend, factory, before, input, setLocal: (value: Partial<StatusCopyLocalContext>) => { local = { ...local, ...value } }, setAccount: (id: string, steamId: string) => { account = { id, steamId } }, transition: () => { account = null } }
}
const directories: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
describe('status-copy coordinator without live accounts or network', () => {
  it('retains a shared-grammar display token without widening the public field whitelist', async () => {
    const f = fixture(); const raw = report()
    raw.source!.fields = { steam_display: '#State.Menu:Ready-1', map: 'Office', connect: 'private join', customPrivateValue: 'not included' }
    f.backend.preview.mockResolvedValueOnce(raw)
    const result = await f.service.preview(f.input())
    expect(result.source?.fields).toEqual({ steam_display: '#State.Menu:Ready-1', map: 'Office' })
    await f.service.shutdown()
  })
  it('starts idle and does not create either backend when saving', async () => {
    const f = fixture(); expect(f.service.state().phase).toBe('idle')
    await f.service.save(f.input()); expect(f.factory).not.toHaveBeenCalled(); expect(f.before).not.toHaveBeenCalled()
    expect(f.service.state().settings.sourceSteamId).toBe(SOURCE)
  })
  it('does not let a renderer observer interrupt starting or retiring the owned backend', async () => {
    const f = fixture({ onChange: () => { throw new Error('Synthetic observer failure') } })
    await expect(f.service.start(f.input())).resolves.toMatchObject({ phase: 'following', busy: false })
    await expect(f.service.stop(f.input())).resolves.toMatchObject({ phase: 'idle', busy: false })
    expect(f.backend.stop).toHaveBeenCalledOnce()
    await f.service.shutdown()
  })
  it.each([TARGET, '10358279140000000', '00000000000000000', (0x110000100000000n).toString(), (0x110000100000000n + (1n << 32n)).toString(), '1e16', ` ${SOURCE}`])('rejects same or non-individual source ID %s', async sourceSteamId => {
    const f = fixture(); await expect(f.service.start(f.input({ sourceSteamId }))).rejects.toMatchObject({ code: sourceSteamId === TARGET ? 'COPY_SOURCE_EQUALS_TARGET' : 'COPY_INVALID_INPUT' })
    expect(f.factory).not.toHaveBeenCalled()
  })
  it.each([4, 121, 5.5])('rejects invalid toolbox interval %s', async intervalSeconds => {
    const f = fixture(); await expect(f.service.save(f.input({ intervalSeconds }))).rejects.toMatchObject({ code: 'COPY_INVALID_INPUT' })
  })
  it('blocks native target before old-mode retirement or driver construction', async () => {
    const f = fixture(); f.setLocal({ steamId: TARGET })
    expect(await f.service.start(f.input())).toMatchObject({ phase: 'error', error: { code: 'COPY_TARGET_IS_LOCAL' } })
    expect(f.factory).not.toHaveBeenCalled(); expect(f.before).not.toHaveBeenCalled()
  })
  it('rechecks local identity after awaiting beforeStart', async () => {
    const f = fixture(); f.before.mockImplementationOnce(async () => { f.setLocal({ steamId: TARGET }) })
    expect(await f.service.start(f.input())).toMatchObject({ error: { code: 'COPY_TARGET_IS_LOCAL' } }); expect(f.factory).not.toHaveBeenCalled()
  })
  it('previews once and retires the temporary backend without scheduling writes', async () => {
    vi.useFakeTimers(); const f = fixture(); expect(await f.service.preview(f.input())).toMatchObject({ phase: 'idle', source: { steamId: SOURCE } })
    expect(f.backend.preview).toHaveBeenCalledOnce(); expect(f.backend.start).not.toHaveBeenCalled(); expect(f.backend.stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30000); expect(f.backend.tick).not.toHaveBeenCalled()
  })
  it('polls single-flight and stops instead of reconnecting after an error', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input())
    f.backend.tick.mockRejectedValueOnce(new Error('private SDK token and URL'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.service.state()).toMatchObject({ phase: 'error', error: { code: 'COPY_REQUEST_FAILED' } }); expect(JSON.stringify(f.service.state())).not.toContain('private SDK')
    await vi.advanceTimersByTimeAsync(120000); expect(f.backend.tick).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledOnce()
  })
  it('detects a native account change to a third account even if Steam PID remains the same', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input()); f.setLocal({ steamId: OTHER })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.service.state()).toMatchObject({ phase: 'error', error: { code: 'COPY_SESSION_CHANGED' } }); expect(f.backend.tick).not.toHaveBeenCalled()
  })
  it('stops on a native switch back before a long source polling interval elapses', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input({ intervalSeconds: 120 })); f.setLocal({ steamId: TARGET })
    await vi.advanceTimersByTimeAsync(1001)
    expect(f.service.state()).toMatchObject({ phase: 'error', error: { code: 'COPY_TARGET_IS_LOCAL' } }); expect(f.backend.tick).not.toHaveBeenCalled(); expect(f.backend.stop).toHaveBeenCalledOnce()
  })
  it('shares one bounded local query between the fast guard and source operations', async () => {
    vi.useFakeTimers(); const wait = deferred<StatusCopyLocalContext>(); let hang = false
    const reader = vi.fn(async () => hang ? wait.promise : { steamId: SOURCE, appId: 730, steamPid: 10, steamStartTicks: '100' })
    const f = fixture({ readLocalContext: reader, localTimeoutMs: 50 }); await f.service.start(f.input({ intervalSeconds: 120 })); const initial = reader.mock.calls.length; hang = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(reader.mock.calls.length - initial).toBe(1); expect(f.service.state().error?.code).toBe('COPY_LOCAL_UNAVAILABLE')
    wait.resolve({ steamId: SOURCE, appId: 730, steamPid: 10, steamStartTicks: '100' })
  })
  it('allows source AppID changes but rejects a Steam instance change', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.start(f.input()); f.setLocal({ appId: 440 })
    await vi.advanceTimersByTimeAsync(5000); expect(f.backend.tick).toHaveBeenCalledOnce()
    f.setLocal({ steamStartTicks: '101' }); await vi.advanceTimersByTimeAsync(5000)
    expect(f.service.state().error?.code).toBe('COPY_SESSION_CHANGED'); expect(f.backend.tick).toHaveBeenCalledOnce()
  })
  it('invalidates a late result on stop and does not resurrect following', async () => {
    const f = fixture(); const wait = deferred<StatusCopyReport>(); f.backend.start.mockImplementationOnce(() => wait.promise)
    const started = f.service.start(f.input()); await vi.waitFor(() => expect(f.backend.start).toHaveBeenCalledOnce())
    await f.service.stop(f.input()); wait.resolve(report()); await started
    expect(f.service.state()).toMatchObject({ phase: 'idle', busy: false }); expect(f.backend.stop).toHaveBeenCalledOnce()
  })
  it('keeps replacement blocked after an unconfirmed driver stop', async () => {
    const f = fixture(); await f.service.start(f.input()); f.backend.stop.mockRejectedValue(new Error('unknown cleanup'))
    expect(await f.service.stop(f.input())).toMatchObject({ phase: 'error', error: { code: 'COPY_STOP_UNCONFIRMED' } })
    await expect(f.service.start(f.input({ mode: 'asf', intervalSeconds: 15, asf: { url: 'http://localhost:1242', botName: 'fixture' } }))).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    expect(f.factory).toHaveBeenCalledOnce()
    f.backend.stop.mockResolvedValue(); await f.service.stop(f.input()); await f.service.start(f.input()); expect(f.factory).toHaveBeenCalledTimes(2)
    await f.service.shutdown()
  })
  it('replaces account sessions only through explicit invalidation and never auto-starts', async () => {
    const f = fixture(); await f.service.save(f.input()); const old = f.input(); await f.service.start(f.input())
    f.setAccount('account-b', OTHER); await f.service.invalidate()
    expect(f.service.state()).toMatchObject({ accountId: 'account-b', phase: 'idle', source: null, settings: { sourceSteamId: '' } })
    await expect(f.service.start(old)).rejects.toMatchObject({ code: 'COPY_SESSION_CHANGED' }); expect(f.factory).toHaveBeenCalledOnce()
    f.setAccount('account-a', TARGET); await f.service.invalidate(); expect(f.service.state().settings.sourceSteamId).toBe(SOURCE)
  })
  it('rebinds safely when main invalidates during a null account-transition window', async () => {
    const f = fixture(); await f.service.save(f.input()); await f.service.start(f.input()); f.transition(); await f.service.invalidate()
    expect(f.service.state().accountId).toBeNull(); f.setAccount('account-b', OTHER)
    expect(f.service.state()).toMatchObject({ accountId: 'account-b', targetSteamId: OTHER, phase: 'idle', settings: { sourceSteamId: '' } })
    f.setAccount('account-a', TARGET); expect(f.service.state().settings.sourceSteamId).toBe(SOURCE)
    expect(f.factory).toHaveBeenCalledOnce()
  })
  it('retains the old owner and session when invalidation cannot confirm stop', async () => {
    const f = fixture(); await f.service.start(f.input()); const sessionId = f.service.state().sessionId
    f.backend.stop.mockRejectedValue(new Error('unknown')); f.transition()
    await expect(f.service.invalidate()).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' })
    f.setAccount('account-b', OTHER)
    expect(f.service.state()).toMatchObject({ accountId: 'account-a', targetSteamId: TARGET, sessionId, error: { code: 'COPY_STOP_UNCONFIRMED' } })
    f.backend.stop.mockResolvedValue(); await f.service.invalidate(); expect(f.service.state().accountId).toBe('account-b')
  })
  it('sanitizes secret group/connect fields even from a custom backend', async () => {
    const f = fixture(); const raw = report(); raw.source!.fields.connect = 'private join'; raw.source!.fields.steam_player_group = 'opaque secret'
    f.backend.start.mockResolvedValueOnce(raw); await f.service.start(f.input())
    expect(JSON.stringify(f.service.state())).not.toMatch(/private join|opaque secret/); await f.service.shutdown()
  })
  it('times out a hanging operation, aborts its context, and refuses a late report', async () => {
    vi.useFakeTimers(); const f = fixture({ operationTimeoutMs: 25 }); const wait = deferred<StatusCopyReport>(); f.backend.start.mockImplementationOnce(() => wait.promise)
    const pending = f.service.start(f.input()); await vi.advanceTimersByTimeAsync(26)
    expect(await pending).toMatchObject({ phase: 'error', error: { code: 'COPY_REQUEST_FAILED' } })
    wait.resolve(report()); await Promise.resolve(); expect(f.service.state().phase).toBe('error')
  })
  it('persists isolated preferences with encrypted ASF password and reloads idle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text.split('').reverse().join('')), decrypt: (buf: Buffer) => buf.toString().split('').reverse().join('') }
    const options = { preferencesPath: path, cipher }
    const f = fixture(options); const input = f.input({ mode: 'asf', intervalSeconds: 15, asf: { url: 'http://localhost:1242', botName: 'my-bot', password: 'fixture-password-private' } })
    await f.service.save(input)
    const disk = await readFile(path, 'utf8'); expect(disk).not.toContain('fixture-password-private'); expect(JSON.stringify(f.service.state())).not.toContain('fixture-password-private')
    const second = fixture(options); await second.service.save(second.input({ mode: 'asf', intervalSeconds: 15, asf: { url: 'http://localhost:1242', botName: 'my-bot' } }))
    expect(second.service.state()).toMatchObject({ phase: 'idle', settings: { asf: { hasPassword: true } } }); expect(second.factory).not.toHaveBeenCalled()
  })
  it('does not persist an ASF password if DPAPI is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const f = fixture({ preferencesPath: path, cipher: { isAvailable: () => false, encrypt: () => { throw new Error('no') }, decrypt: () => '' } })
    await expect(f.service.save(f.input({ mode: 'asf', intervalSeconds: 15, asf: { url: 'http://localhost:1242', botName: 'my-bot', password: 'private' } }))).rejects.toMatchObject({ code: 'COPY_REQUEST_FAILED' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.service.state().busy).toBe(false)
  })
  it('retains ASF settings and encrypted password across toolbox-mode save and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString() }
    const options = { preferencesPath: path, cipher }; const asf = { url: 'http://localhost:1242', botName: 'fixture' }
    const first = fixture(options)
    await first.service.save(first.input({ mode: 'asf', intervalSeconds: 15, asf: { ...asf, password: 'fixture-secret' } }))
    expect(await first.service.save(first.input())).toMatchObject({ busy: false, settings: { mode: 'toolbox', asf: { hasPassword: true } } })
    const reopened = fixture(options)
    expect(await reopened.service.save(reopened.input({ mode: 'asf', intervalSeconds: 15, asf }))).toMatchObject({ phase: 'idle', settings: { mode: 'asf', asf: { hasPassword: true } } })
    expect(reopened.factory).not.toHaveBeenCalled(); expect(await readFile(path, 'utf8')).not.toContain('fixture-secret')
  })
  it('serializes save then removal and never resurrects an account from a cancelled save rollback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const f = fixture({ preferencesPath: path }); await f.service.save(f.input())
    const pendingSave = f.service.save(f.input({ sourceSteamId: OTHER })).catch(caught => caught)
    await Promise.resolve()
    const removing = f.service.forgetAccount('account-a')
    const caught = await pendingSave; await removing
    expect(caught).toMatchObject({ code: 'COPY_SESSION_CHANGED' })
    expect(JSON.parse(await readFile(path, 'utf8')).accounts).toEqual({})
    f.setAccount('account-b', TARGET); f.service.state(); f.setAccount('account-a', TARGET)
    expect(f.service.state().settings.sourceSteamId).toBe('')
  })
  it('keeps committed preferences consistent with disk when Stop cancels the save response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const f = fixture({ preferencesPath: path }); await f.service.save(f.input())
    const saving = f.service.save(f.input({ sourceSteamId: OTHER })).catch(caught => caught)
    await Promise.resolve(); await f.service.stop(f.input())
    expect(await saving).toMatchObject({ code: 'COPY_SESSION_CHANGED' })
    expect(JSON.parse(await readFile(path, 'utf8')).accounts['account-a'].settings.sourceSteamId).toBe(OTHER)
    expect(f.service.state()).toMatchObject({ phase: 'idle', settings: { sourceSteamId: OTHER } })
    f.setAccount('account-b', TARGET); f.service.state(); f.setAccount('account-a', TARGET)
    expect(f.service.state().settings.sourceSteamId).toBe(OTHER)
    const reopened = fixture({ preferencesPath: path }); await vi.waitFor(() => expect(reopened.service.state().settings.sourceSteamId).toBe(OTHER))
  })
  it('preserves an omitted ASF password, clears it explicitly, and forgets removed accounts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copy-prefs-')); directories.push(directory); const path = join(directory, 'prefs.json')
    const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString() }
    const f = fixture({ preferencesPath: path, cipher }); const asf = { url: 'http://localhost:1242', botName: 'fixture' }
    await f.service.save(f.input({ mode: 'asf', intervalSeconds: 15, asf: { ...asf, password: 'fixture-secret' } }))
    await f.service.save(f.input()); expect(f.service.state().settings.asf?.hasPassword).toBe(true)
    await f.service.save(f.input({ mode: 'asf', intervalSeconds: 15, asf })); expect(f.service.state().settings.asf?.hasPassword).toBe(true)
    await f.service.save(f.input({ mode: 'asf', intervalSeconds: 15, asf: { ...asf, password: '' } })); expect(f.service.state().settings.asf?.hasPassword).toBe(false)
    await f.service.forgetAccount('account-a'); expect(JSON.parse(await readFile(path, 'utf8')).accounts).toEqual({}); expect(f.service.state().settings.sourceSteamId).toBe('')
  })
  it('refuses account deletion until its existing driver confirms stop', async () => {
    const f = fixture(); await f.service.save(f.input()); await f.service.start(f.input()); f.backend.stop.mockRejectedValue(new Error('unknown'))
    await expect(f.service.forgetAccount('account-a')).rejects.toMatchObject({ code: 'COPY_STOP_UNCONFIRMED' }); expect(f.service.state().settings.sourceSteamId).toBe(SOURCE)
    f.backend.stop.mockResolvedValue(); await f.service.forgetAccount('account-a'); expect(f.service.state().settings.sourceSteamId).toBe('')
  })
  it('rejects a 65th saved account without evicting another account preference', async () => {
    const f = fixture()
    for (let index = 0; index < 64; index++) { f.setAccount(`account-${index}`, TARGET); f.service.state(); await f.service.save(f.input()) }
    f.setAccount('account-64', TARGET); f.service.state()
    await expect(f.service.save(f.input())).rejects.toMatchObject({ code: 'COPY_INVALID_INPUT' })
    f.setAccount('account-0', TARGET); expect(f.service.state().settings.sourceSteamId).toBe(SOURCE)
  })
})
