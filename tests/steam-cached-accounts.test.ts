import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import { parseSteamCachedAccounts, selectSteamCachedAccount, skipSteamAccountChooser, SteamCachedAccountsService } from '../src/main/steam-cached-accounts'
import { steamCachedRegistryScript, steamCachedActivityScript } from '../src/main/steam-cached-accounts-runtime'

const A = '76561198000000001', B = '76561198000000002'
const source = `// retain comment\n"users" {\n "${A}" { "AccountName" "fixture_one" "PersonaName" "Synthetic One" "RememberPassword" "0" "mostrecent" "1" "AutoLogin" "1" "Timestamp" "1700000000" "untouched" "fixture-marker" }\n "${B}" { "AccountName" "fixture_two" "PersonaName" "Synthetic Two" "RememberPassword" "1" "AllowAutoLogin" "0" "WantsOfflineMode" "1" }\n}`
const config = '"InstallConfigStore" { "WebStorage" { "Auth" { "AlwaysShowUserChooser" "1" "untouched" "keep" } } "other" "retain" }'
const directories: string[] = []
afterEach(async () => {
  const root = await realpath(tmpdir())
  for (const directory of directories.splice(0)) {
    const actual = await realpath(directory)
    expect(dirname(actual).toLowerCase()).toBe(root.toLowerCase()); expect(basename(actual).startsWith('steam-cache-test-')).toBe(true)
    await rm(actual, { recursive: true, force: true })
  }
})
async function fixture(running = true) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'steam-cache-test-'))); directories.push(root)
  await mkdir(join(root, 'config')); await mkdir(join(root, 'private'))
  await writeFile(join(root, 'steam.exe'), 'synthetic executable, never executed')
  const file = join(root, 'config/loginusers.vdf'), settings = join(root, 'config/config.vdf')
  await writeFile(file, source); await writeFile(settings, config)
  let active = running, auto: string | null = 'fixture_one', clock = 1000
  const runtime = { isRunning: vi.fn(async () => active), resolveRunningClient: vi.fn(async () => ({ executable: join(root, 'steam.exe'), pid: 999, startTicks: '638000000000000000' })),
    requestShutdown: vi.fn(async () => { active = false }), start: vi.fn(async () => { active = true }) }
  const launch = vi.fn(async () => { active = true }), confirm = vi.fn(async () => true), idle = vi.fn()
  const writeAuto = vi.fn(async (value: string | null) => { auto = value })
  const recovery = join(root, 'private/latest.json')
  const options = { getSteamPath: async () => root, runtime, cipher: { isAvailable: () => true, encrypt: vi.fn((text: string) => Buffer.from(`encrypted-fixture-${text.length}`)) }, recoveryPath: recovery,
    readAutoLogin: async () => auto, writeAutoLogin: writeAuto, launch, confirm, assertIdle: idle, now: () => clock,
    sleep: async (ms: number) => { clock += ms }, exitTimeoutMs: 1000 }
  const service = new SteamCachedAccountsService(options), initial = await service.state()
  return { root, file, settings, recovery, service, initial, runtime, launch, confirm, idle, options, writeAuto,
    auto: () => auto, setAuto: (value: string | null) => { auto = value }, active: (value: boolean) => { active = value } }
}

describe('Steam cached-account selectors', () => {
  it('reads old and new selector formats without treating a cached name as credentials', () => {
    const entries = parseSteamCachedAccounts(source)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ steamId: A, accountName: 'fixture_one', mostRecent: true, remembered: false })
    expect(parseSteamCachedAccounts(`"users" { "${A}" { "AccountName" "user_one" "AutoLogin" "1" } }`)[0]!.mostRecent).toBe(true)
    expect(parseSteamCachedAccounts(`"users" { "${A}" { "AccountName" "user_one" "AllowAutoLogin" "1" } }`)[0]!.mostRecent).toBe(true)
  })
  it('patches selectors only, preserving remembered/offline/unknown data and key spelling', () => {
    const selected = selectSteamCachedAccount(source, B), rows = parseSteamCachedAccounts(selected)
    expect(rows.map(row => row.mostRecent)).toEqual([false, true]); expect(rows[0]!.remembered).toBe(false)
    expect(selected).toContain('"mostrecent"'); expect(selected).not.toContain('"MostRecent"\t\t"0"')
    expect(selected).toContain('"WantsOfflineMode" "1"'); expect(selected).toContain('"untouched" "fixture-marker"')
    expect(selected).toContain('// retain comment'); expect(selected).toContain('"Timestamp" "1700000000"')
    expect(skipSteamAccountChooser(config)).toContain('"AlwaysShowUserChooser"\t\t"0"')
    expect(skipSteamAccountChooser(config)).toContain('"other" "retain"')
  })
  it.each([source.replace('"AutoLogin" "1"', '"AutoLogin" "1" "autologin" "0"'), source.replace(B, A), source.replace('fixture_two', 'fixture_one'), source.replace('"users"', '"unexpected"')])('rejects ambiguous or malformed account metadata', text => {
    expect(() => parseSteamCachedAccounts(text)).toThrow()
  })
  it('does not create missing config branches and rejects duplicate chooser fields', () => {
    expect(skipSteamAccountChooser('"InstallConfigStore" { "other" "1" }')).toBe('"InstallConfigStore" { "other" "1" }')
    expect(() => skipSteamAccountChooser(config.replace('"AlwaysShowUserChooser" "1"', '"AlwaysShowUserChooser" "1" "alwaysshowuserchooser" "0"'))).toThrow()
  })
  it('writes only AutoLoginUser through encoded registry values, not password preferences or arbitrary script', () => {
    const script = steamCachedRegistryScript('write', 'fixture_one')
    expect(script).toContain('-Name AutoLoginUser'); expect(script).not.toContain('RememberPassword'); expect(script).not.toContain('steamchina')
    expect(script).not.toContain('fixture_one'); expect(steamCachedRegistryScript('write', null)).toContain('Remove-ItemProperty')
    expect(steamCachedRegistryScript('read')).toContain('RegistryValueKind]::String')
    expect(steamCachedActivityScript).toContain("-notcontains 'RunningAppID'")
    expect(steamCachedActivityScript).toContain("Software\\Valve\\Steam\\Apps' -ErrorAction Stop")
    expect(() => steamCachedRegistryScript('write', 'invalid\ncommand')).toThrow()
  })
})

describe('Steam cached switching uses isolated synthetic files only', () => {
  it('lists metadata without changing files, registry or Steam', async () => {
    const f = await fixture()
    expect(f.initial.accounts).toHaveLength(2); expect(f.initial.revision).toHaveLength(64)
    expect(await readFile(f.file, 'utf8')).toBe(source)
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled(); expect(f.writeAuto).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
  })
  it('requires native confirmation and leaves everything unchanged when cancelled', async () => {
    const f = await fixture(); f.confirm.mockResolvedValue(false)
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).status).toBe('cancelled')
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled(); expect(await readFile(f.file, 'utf8')).toBe(source)
  })
  it.each([true, false])('selects with Steam initially running=%s, and reports only awaiting-login after launch', async running => {
    const f = await fixture(running)
    const done = await f.service.switchAccount({ steamId: B, revision: f.initial.revision })
    expect(done.status).toBe('awaiting-login'); expect(f.auto()).toBe('fixture_two')
    expect(f.launch).toHaveBeenCalledExactlyOnceWith(join(f.root, 'steam.exe'), 'fixture_two')
    expect(f.runtime.requestShutdown).toHaveBeenCalledTimes(running ? 1 : 0)
    expect(parseSteamCachedAccounts(await readFile(f.file, 'utf8')).map(row => row.mostRecent)).toEqual([false, true])
    const backup = await readFile(f.recovery, 'utf8')
    expect(backup).not.toContain('fixture_one'); expect(backup).not.toContain('AccountName'); expect(backup).not.toContain('untouched')
    const plainLedger = f.options.cipher.encrypt.mock.calls[0]![0]
    expect(plainLedger).toContain('selectors'); expect(plainLedger).not.toContain('fixture-marker'); expect(plainLedger).not.toContain('untouched')
    expect(plainLedger).not.toContain('original":"'); expect(JSON.parse(backup).pending).toBe(false)
  })
  it('does not stop Steam when a game is still running or the list changed', async () => {
    const f = await fixture(); f.runtime.resolveRunningClient.mockRejectedValue(new DomainError('SCREENSHOT_STEAM_GAME_RUNNING', 'fixture'))
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).error).toBe('STEAM_CACHE_GAME_RUNNING')
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled(); expect(await readFile(f.file, 'utf8')).toBe(source)
    await expect(f.service.switchAccount({ steamId: B, revision: 'stale' })).rejects.toMatchObject({ code: 'STEAM_CACHE_CHANGED' })
  })
  it('waits for complete shutdown and aborts without configuration writes on timeout', async () => {
    const f = await fixture(); f.runtime.requestShutdown.mockImplementation(async () => {})
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).error).toBe('STEAM_CACHE_EXIT_UNCONFIRMED')
    expect(f.writeAuto).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled(); expect(await readFile(f.file, 'utf8')).toBe(source)
  })
  it('allows Steam shutdown saves but preserves the freshly saved unknown fields', async () => {
    const f = await fixture()
    f.runtime.requestShutdown.mockImplementation(async () => { f.active(false); await writeFile(f.file, source.replace('fixture-marker', 'saved-on-exit')) })
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).status).toBe('awaiting-login')
    expect(await readFile(f.file, 'utf8')).toContain('saved-on-exit')
  })
  it('rolls back its own metadata and registry change if Steam launch fails', async () => {
    const f = await fixture(); f.launch.mockRejectedValue(new DomainError('STEAM_CACHE_LAUNCH_FAILED', 'fixture'))
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).error).toBe('STEAM_CACHE_LAUNCH_FAILED')
    expect(await readFile(f.file, 'utf8')).toBe(source); expect(await readFile(f.settings, 'utf8')).toBe(config)
    expect(f.auto()).toBe('fixture_one'); expect(f.runtime.start).toHaveBeenCalledOnce()
  })
  it('rolls back even if the registry write throws after changing the value', async () => {
    const f = await fixture()
    f.writeAuto.mockImplementationOnce(async value => { f.setAuto(value); throw new Error('fixture partial write') })
    const result = await f.service.switchAccount({ steamId: B, revision: f.initial.revision })
    expect(result.status).toBe('error'); expect(await readFile(f.file, 'utf8')).toBe(source)
    expect(f.writeAuto).toHaveBeenLastCalledWith('fixture_one')
    expect(f.auto()).toBe('fixture_one')
  })
  it('preserves an unresolved transaction and blocks retries across restarts instead of claiming restoration', async () => {
    const f = await fixture()
    f.writeAuto.mockImplementationOnce(async value => { f.setAuto(value); f.active(true) })
    expect((await f.service.switchAccount({ steamId: B, revision: f.initial.revision })).error).toBe('STEAM_CACHE_RECOVERY_REQUIRED')
    expect(f.launch).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(f.recovery, 'utf8')).pending).toBe(true)
    f.active(false)
    expect((await f.service.state()).error).toBe('STEAM_CACHE_RECOVERY_REQUIRED')
    const fresh = new SteamCachedAccountsService(f.options)
    expect((await fresh.state()).error).toBe('STEAM_CACHE_RECOVERY_REQUIRED')
  })
  it('blocks shutdown on unknown activity evidence', async () => {
    const f = await fixture()
    const activity = vi.fn(async () => { throw new DomainError('STEAM_CACHE_ACTIVITY_UNAVAILABLE', 'fixture') })
    const guarded = new SteamCachedAccountsService({ ...f.options, assertGamesIdle: activity })
    const state = await guarded.state()
    expect((await guarded.switchAccount({ steamId: B, revision: state.revision })).error).toBe('STEAM_CACHE_ACTIVITY_UNAVAILABLE')
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled()
  })
  it('requires encryption before any shutdown or persistent change', async () => {
    const f = await fixture(); f.options.cipher.isAvailable = () => false
    await expect(f.service.switchAccount({ steamId: B, revision: f.initial.revision })).rejects.toMatchObject({ code: 'STEAM_CACHE_UNAVAILABLE' })
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
  })
})
