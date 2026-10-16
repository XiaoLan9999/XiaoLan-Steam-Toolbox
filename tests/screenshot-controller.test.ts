import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotController } from '../src/main/screenshot-controller'
import type { SteamScreenshotService } from '../src/main/steam-screenshots'
import type { ScreenshotNameService } from '../src/main/steam-screenshot-names'
import type { ScreenshotCatalog, ScreenshotGame } from '../src/shared/steam-screenshots'

const directories: string[] = []
const controllers: ScreenshotController[] = []
const NOW = '2026-10-16T04:00:00.000Z'

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('steam-screenshot-controller-')) {
      throw new Error('Refusing to remove a directory outside the test workspace')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function game(appId = '440', nameSource: ScreenshotGame['nameSource'] = 'fallback'): ScreenshotGame {
  return { appId, name: `AppID ${appId}`, nameSource, installed: false, userIds: [] }
}

function catalog(steamPath: string | null = null, games = [game()]): ScreenshotCatalog {
  return { steamPath, refreshedAt: NOW, steamRunning: false, users: [], games, warnings: [] }
}

function deferred<T>() {
  let accept!: (value: T) => void
  let decline!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, reject) => { accept = resolvePromise; decline = reject })
  return { promise, resolve: accept, reject: decline }
}

async function tick(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

function fixture(preferencesPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'steam-screenshot-controller-'))
  directories.push(directory)
  let current = catalog()
  const service = {
    getCatalog: vi.fn(() => current),
    refresh: vi.fn(async (steamPath?: string) => { current = catalog(steamPath ?? join(directory, 'Steam')); return current }),
    setResolvedGame: vi.fn((appId: string, name: string) => {
      current = { ...current, games: [...current.games.filter(item => item.appId !== appId), { ...game(appId, 'store'), name }] }
    }),
    dispose: vi.fn()
  }
  const names = {
    enrich: vi.fn((value: ScreenshotCatalog, _accounts: Array<{ steamId: string; displayName: string }>) => value),
    refresh: vi.fn(async (_value: ScreenshotCatalog, _signal: AbortSignal, changed: (pending: number) => void) => { changed(0) }),
    resolveGame: vi.fn(async (appId: string, _signal: AbortSignal) => ({ ...game(appId, 'store'), name: 'Resolved Game' }))
  }
  const accounts = vi.fn(() => [{ steamId: '76561198000000001', displayName: 'Toolbox Player' }])
  const changed = vi.fn()
  const path = preferencesPath ?? join(directory, 'preferences.json')
  const controller = new ScreenshotController(service as unknown as SteamScreenshotService, names as unknown as ScreenshotNameService,
    { preferencesPath: path, accounts, changed })
  controllers.push(controller)
  return { directory, preferencesPath: path, controller, service, names, accounts, changed, setCatalog: (value: ScreenshotCatalog) => { current = value } }
}

describe('screenshot controller startup and catalog refresh', () => {
  it('tries an explicitly selected directory even if the startup scan it awaited fails', async () => {
    const f = fixture()
    const scan = deferred<ScreenshotCatalog>()
    f.service.refresh.mockImplementationOnce(() => scan.promise)
    const startup = f.controller.refresh()
    const rejected = expect(startup).rejects.toThrow('Synthetic missing old root')
    await vi.waitFor(() => expect(f.service.refresh).toHaveBeenCalledTimes(1))
    const selectedRoot = join(f.directory, 'SelectedSteam')
    const selected = f.controller.refresh(selectedRoot)
    scan.reject(new Error('Synthetic missing old root'))
    await rejected
    expect(await selected).toMatchObject({ steamPath: selectedRoot })
    expect(f.service.refresh).toHaveBeenCalledTimes(2)
    expect(f.service.refresh).toHaveBeenLastCalledWith(selectedRoot)
    expect(JSON.parse(readFileSync(f.preferencesPath, 'utf8'))).toEqual({ steamPath: selectedRoot })
  })

  it('coalesces startup and repeated manual refresh requests into one local scan and one online-name job', async () => {
    const f = fixture()
    const scan = deferred<ScreenshotCatalog>()
    f.service.refresh.mockImplementation(() => scan.promise)
    const startup = f.controller.refresh()
    const manual = f.controller.refresh()
    expect(manual).toBe(startup)
    await vi.waitFor(() => expect(f.service.refresh).toHaveBeenCalledTimes(1))
    const found = catalog(join(f.directory, 'Steam'))
    f.setCatalog(found)
    scan.resolve(found)
    expect(await startup).toMatchObject({ steamPath: found.steamPath })
    expect(await manual).toMatchObject({ steamPath: found.steamPath })
    expect(f.names.refresh).toHaveBeenCalledTimes(1)
    expect(f.names.refresh).toHaveBeenCalledWith(found, expect.any(AbortSignal), expect.any(Function))
  })

  it('marks an unfinished local scan as refreshing rather than showing a completed empty catalog', async () => {
    const f = fixture()
    const scan = deferred<ScreenshotCatalog>()
    f.service.refresh.mockImplementation(() => scan.promise)
    const refresh = f.controller.refresh()
    expect(f.controller.getCatalog().refreshing).toBe(true)
    await vi.waitFor(() => expect(f.service.refresh).toHaveBeenCalledTimes(1))
    scan.resolve(catalog())
    await refresh
    await tick()
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: false, nameLookupPending: 0 })
  })

  it('does not make local scans or online requests for repeated getCatalog and enrichment reads', () => {
    const f = fixture()
    for (let index = 0; index < 25; index++) f.controller.getCatalog()
    expect(f.service.getCatalog).toHaveBeenCalledTimes(25)
    expect(f.names.enrich).toHaveBeenCalledTimes(25)
    expect(f.accounts).toHaveBeenCalledTimes(25)
    expect(f.names.enrich).toHaveBeenLastCalledWith(expect.any(Object), [{ steamId: '76561198000000001', displayName: 'Toolbox Player' }])
    expect(f.service.refresh).not.toHaveBeenCalled()
    expect(f.names.refresh).not.toHaveBeenCalled()
    expect(f.names.resolveGame).not.toHaveBeenCalled()
  })

  it('starts a new name refresh only for an explicit subsequent catalog refresh, not for catalog reads', async () => {
    const f = fixture()
    await f.controller.refresh()
    await tick()
    for (let index = 0; index < 10; index++) f.controller.getCatalog()
    expect(f.service.refresh).toHaveBeenCalledTimes(1)
    expect(f.names.refresh).toHaveBeenCalledTimes(1)
    await f.controller.refresh()
    expect(f.service.refresh).toHaveBeenCalledTimes(2)
    expect(f.names.refresh).toHaveBeenCalledTimes(2)
  })

  it('serializes an explicitly selected new root behind a startup scan rather than losing the selection', async () => {
    const f = fixture()
    const scan = deferred<ScreenshotCatalog>()
    f.service.refresh.mockImplementationOnce(() => scan.promise)
    const startup = f.controller.refresh()
    const selectedPath = join(f.directory, 'Selected Steam')
    const selected = f.controller.refresh(selectedPath)
    await vi.waitFor(() => expect(f.service.refresh).toHaveBeenCalledTimes(1))
    scan.resolve(catalog(join(f.directory, 'Auto Steam')))
    await startup
    await expect(selected).resolves.toMatchObject({ steamPath: selectedPath })
    expect(f.service.refresh).toHaveBeenCalledTimes(2)
    expect(f.service.refresh).toHaveBeenLastCalledWith(selectedPath)
  })

  it('clears loading state after a failed scan so a later manual refresh can recover', async () => {
    const f = fixture()
    f.service.refresh.mockRejectedValueOnce(new Error('Synthetic local scan failure'))
    await expect(f.controller.refresh()).rejects.toThrow('Synthetic local scan failure')
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: false, nameLookupPending: 0 })
    await expect(f.controller.refresh()).resolves.toMatchObject({ steamPath: join(f.directory, 'Steam') })
    expect(f.service.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('screenshot controller remembered root preferences', () => {
  it('atomically remembers a selected Steam root and reuses it on a new controller startup', async () => {
    const f = fixture()
    const selectedPath = join(f.directory, 'Selected Steam')
    await f.controller.refresh(selectedPath)
    expect(JSON.parse(readFileSync(f.preferencesPath, 'utf8'))).toEqual({ steamPath: selectedPath })
    expect(readdirSync(dirname(f.preferencesPath))).toEqual(['preferences.json'])
    const reopened = fixture(f.preferencesPath)
    await reopened.controller.refresh()
    expect(reopened.service.refresh).toHaveBeenCalledWith(selectedPath)
  })

  it('keeps the selected root in memory for subsequent refreshes without rereading a changed preferences file', async () => {
    const f = fixture()
    const selectedPath = join(f.directory, 'Selected Steam')
    await f.controller.refresh(selectedPath)
    writeFileSync(f.preferencesPath, JSON.stringify({ steamPath: join(f.directory, 'Unexpected Other Steam') }))
    await f.controller.refresh()
    expect(f.service.refresh).toHaveBeenLastCalledWith(selectedPath)
  })

  it('does not persist automatic discovery as a user override', async () => {
    const f = fixture()
    await f.controller.refresh()
    expect(existsSync(f.preferencesPath)).toBe(false)
  })

  it.each([
    'not json',
    JSON.stringify({ steamPath: { nested: 'not a path' } }),
    JSON.stringify({ steamPath: 'x'.repeat(4096) }),
    'x'.repeat(16_385)
  ])('ignores invalid preference content and falls back to automatic discovery', async contents => {
    const f = fixture()
    writeFileSync(f.preferencesPath, contents)
    await f.controller.refresh()
    expect(f.service.refresh).toHaveBeenCalledWith(undefined)
  })
})

describe('screenshot controller background generation and cancellation', () => {
  it('returns local metadata without waiting for public names and reports remaining name work', async () => {
    const f = fixture()
    const names = deferred<void>()
    f.names.refresh.mockImplementation((_value, _signal, progress) => { progress(7); return names.promise })
    await expect(f.controller.refresh()).resolves.toMatchObject({ refreshing: true, nameLookupPending: 7 })
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: true, nameLookupPending: 7 })
    names.resolve()
    await tick()
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: false, nameLookupPending: 0 })
  })

  it('isolates cancelled old-directory progress and late completion from the newly selected root', async () => {
    const f = fixture()
    const oldNames = deferred<void>()
    const newNames = deferred<void>()
    const signals: AbortSignal[] = []
    const progress: Array<(pending: number) => void> = []
    f.names.refresh.mockImplementation((_value, signal, changed) => {
      signals.push(signal)
      progress.push(changed)
      changed(signals.length === 1 ? 9 : 2)
      return signals.length === 1 ? oldNames.promise : newNames.promise
    })
    await f.controller.refresh(join(f.directory, 'Old Steam'))
    await f.controller.refresh(join(f.directory, 'New Steam'))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    progress[0]!(999)
    oldNames.resolve()
    await tick()
    expect(f.controller.getCatalog()).toMatchObject({ steamPath: join(f.directory, 'New Steam'), refreshing: true, nameLookupPending: 2 })
    newNames.resolve()
    await tick()
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: false, nameLookupPending: 0 })
  })

  it('keeps local metadata usable and resets progress when online-name enrichment fails', async () => {
    const f = fixture()
    f.names.refresh.mockRejectedValueOnce(new Error('Synthetic public endpoint unavailable'))
    await expect(f.controller.refresh()).resolves.toMatchObject({ steamPath: join(f.directory, 'Steam') })
    await tick()
    expect(f.controller.getCatalog()).toMatchObject({ refreshing: false, nameLookupPending: 0, games: [game()] })
  })

  it('cancels every in-flight manual lookup on refresh, including lookups started before the first catalog scan', async () => {
    const f = fixture()
    const manual = deferred<ScreenshotGame>()
    const signals: AbortSignal[] = []
    f.names.resolveGame.mockImplementation((_id, signal) => { signals.push(signal); return manual.promise })
    const first = f.controller.resolveGame('440')
    const second = f.controller.resolveGame('570')
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    await f.controller.refresh()
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    manual.resolve({ ...game('440', 'store'), name: 'Stale Resolved Game' })
    await Promise.all([firstRejected, secondRejected])
    expect(f.service.setResolvedGame).not.toHaveBeenCalled()
  })

  it('aborts manual lookups from a previous selected root and rejects their late results', async () => {
    const f = fixture()
    await f.controller.refresh(join(f.directory, 'Old Steam'))
    const manual = deferred<ScreenshotGame>()
    let signal: AbortSignal | null = null
    f.names.resolveGame.mockImplementation((_id, value) => { signal = value; return manual.promise })
    const lookup = f.controller.resolveGame('570')
    const rejected = expect(lookup).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    await f.controller.refresh(join(f.directory, 'New Steam'))
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    manual.resolve({ ...game('570', 'store'), name: 'Old Directory Game' })
    await rejected
    expect(f.service.setResolvedGame).not.toHaveBeenCalled()
    expect(f.controller.getCatalog().steamPath).toBe(join(f.directory, 'New Steam'))
  })

  it('adds successful manual store names and leaves local shortcut names offline', async () => {
    const f = fixture()
    await expect(f.controller.resolveGame('570')).resolves.toMatchObject({ appId: '570', name: 'Resolved Game', nameSource: 'store' })
    expect(f.service.setResolvedGame).toHaveBeenCalledWith('570', 'Resolved Game')
    const shortcut = game('12345678901234567890', 'localconfig')
    f.setCatalog(catalog(null, [shortcut]))
    await expect(f.controller.resolveGame(shortcut.appId)).resolves.toEqual(shortcut)
    expect(f.names.resolveGame).toHaveBeenCalledTimes(1)
    await expect(f.controller.resolveGame('12345678901234567891')).rejects.toMatchObject({ code: 'SCREENSHOT_UNKNOWN_SHORTCUT' })
    expect(f.names.resolveGame).toHaveBeenCalledTimes(1)
  })
})

describe('screenshot controller disposal and notifications', () => {
  it('coalesces progress changes into one notification and clears a queued notification on disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const names = deferred<void>()
    let progress: ((pending: number) => void) | undefined
    f.names.refresh.mockImplementation((_value, _signal, changed) => { progress = changed; return names.promise })
    await f.controller.refresh(join(f.directory, 'Steam'))
    progress!(5)
    progress!(4)
    progress!(3)
    expect(f.changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.changed).toHaveBeenCalledTimes(1)
    progress!(2)
    f.controller.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.changed).toHaveBeenCalledTimes(1)
    names.resolve()
    await tick()
  })

  it('does not emit or read account data after disposal when a late local scan resolves', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const scan = deferred<ScreenshotCatalog>()
    f.service.refresh.mockImplementationOnce(() => scan.promise)
    const refresh = f.controller.refresh(join(f.directory, 'Steam'))
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    expect(f.service.refresh).toHaveBeenCalledTimes(1)
    f.controller.dispose()
    f.accounts.mockClear()
    f.changed.mockClear()
    scan.resolve(catalog(join(f.directory, 'Steam')))
    await rejected
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.names.refresh).not.toHaveBeenCalled()
    expect(f.accounts).not.toHaveBeenCalled()
    expect(f.changed).not.toHaveBeenCalled()
    expect(existsSync(f.preferencesPath)).toBe(false)
    expect(f.service.dispose).toHaveBeenCalledTimes(1)
  })

  it('aborts background and all manual lookups and ignores late callbacks after disposal without account reads', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const background = deferred<void>()
    const manual = deferred<ScreenshotGame>()
    let signal: AbortSignal | null = null
    let progress: ((pending: number) => void) | undefined
    const lookupSignals: AbortSignal[] = []
    f.names.refresh.mockImplementation((_value, value, changed) => { signal = value; progress = changed; return background.promise })
    f.names.resolveGame.mockImplementation((_id, value) => { lookupSignals.push(value); return manual.promise })
    await f.controller.refresh(join(f.directory, 'Steam'))
    const lookup = f.controller.resolveGame('570')
    const other = f.controller.resolveGame('730')
    const lookupRejected = expect(lookup).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    const otherRejected = expect(other).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    f.controller.dispose()
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(lookupSignals.every(value => value.aborted)).toBe(true)
    f.accounts.mockClear()
    f.changed.mockClear()
    progress!(55)
    background.resolve()
    manual.resolve({ ...game('570', 'store'), name: 'Late Name' })
    await Promise.all([lookupRejected, otherRejected])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.accounts).not.toHaveBeenCalled()
    expect(f.service.setResolvedGame).not.toHaveBeenCalled()
  })

  it('rejects new operations after disposal without scanning or making online lookups', async () => {
    const f = fixture()
    f.controller.dispose()
    await expect(f.controller.refresh()).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    await expect(f.controller.resolveGame('440')).rejects.toBeDefined()
    expect(f.service.refresh).not.toHaveBeenCalled()
    expect(f.names.refresh).not.toHaveBeenCalled()
    expect(f.names.resolveGame).not.toHaveBeenCalled()
    expect(f.accounts).not.toHaveBeenCalled()
  })
})
