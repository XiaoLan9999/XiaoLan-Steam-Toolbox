import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import type { ScreenshotImportPhase, ScreenshotPrepareInput, ScreenshotPrepareResult } from '../src/shared/steam-screenshots'
import { ScreenshotImport, screenshotImportBlocksChannel } from '../src/main/screenshot-import'

const input: ScreenshotPrepareInput = { mode: 'local-account', steamPath: 'D:\\Steam', userId: '123', appId: '730', imageIds: ['image-1'], jpegQuality: 95, resizeLargeImages: true, restartSteam: true }
const currentInput: ScreenshotPrepareInput = { ...input, mode: 'current-account' }
const result = (): ScreenshotPrepareResult => ({ imported: 1, files: ['new.jpg'], backupPath: 'backup', vdfPath: 'screenshots.vdf' })
function fixture(initiallyRunning = true, liveImport?: { prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> }) {
  let running = initiallyRunning
  let clock = 0
  const phases: ScreenshotImportPhase[] = []
  const order: string[] = []
  const client = Object.freeze({ executable: 'D:\\Steam\\steam.exe', pid: 1234, startTicks: '638964000000000001' })
  const service = {
    preflight: vi.fn(async (_input: ScreenshotPrepareInput) => { order.push('preflight') }),
    prepare: vi.fn(async (_input: ScreenshotPrepareInput) => { order.push('import'); expect(running).toBe(false); return result() })
  }
  const runtime = {
    isRunning: vi.fn(async () => running),
    resolveRunningClient: vi.fn(async (_path: string) => { order.push('resolve'); return client }),
    requestShutdown: vi.fn(async (_client: typeof client) => { order.push('shutdown'); running = false }),
    start: vi.fn(async (_client: typeof client) => { order.push('restart'); running = true })
  }
  const confirmRestart = vi.fn(async () => { order.push('confirm'); return true })
  const assertRestartAllowed = vi.fn(() => {})
  const localImport = { prepareIfInactive: vi.fn(async (_input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> => null),
    assertCurrentTarget: vi.fn(async (_input: ScreenshotPrepareInput, _client?: typeof client) => {}) }
  const sleep = vi.fn(async (ms: number) => { clock += ms })
  const operation = new ScreenshotImport({ service, runtime, liveImport, localImport, confirmRestart, assertRestartAllowed,
    progress: phase => phases.push(phase), now: () => clock, sleep })
  return { operation, service, runtime, liveImport, localImport, confirmRestart, assertRestartAllowed, sleep, phases, order, client,
    setRunning(value: boolean) { running = value }, elapsed: () => clock }
}

describe('confirmed Steam screenshot import orchestration', () => {
  it('defaults to mode one regardless of legacy preferLive or restart flags', async () => {
    const response: ScreenshotPrepareResult = { ...result(), method: 'steam-api', backupPath: null }
    const live = { prepare: vi.fn(async () => response) }; const f = fixture(true, live)
    expect(await f.operation.prepare({ ...currentInput, mode: undefined, preferLive: false, restartSteam: true })).toBe(response)
    expect(live.prepare).toHaveBeenCalledWith(expect.objectContaining({ preferLive: true }))
    expect(f.localImport.prepareIfInactive).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
  })

  it('never imports mode one offline or launches Steam implicitly', async () => {
    const live = { prepare: vi.fn(async () => result()) }; const f = fixture(false, live)
    await expect(f.operation.prepare(currentInput)).rejects.toMatchObject({ code: 'SCREENSHOT_MODE_ONE_REQUIRES_STEAM' })
    expect(live.prepare).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('rejects a caption in mode one without switching modes', async () => {
    const live = { prepare: vi.fn(async () => result()) }; const f = fixture(true, live)
    await expect(f.operation.prepare({ ...currentInput, caption: 'keep this caption' })).rejects.toMatchObject({ code: 'SCREENSHOT_MODE_ONE_CAPTION_UNSUPPORTED' })
    expect(live.prepare).not.toHaveBeenCalled()
    expect(f.localImport.prepareIfInactive).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
  })

  it('rejects the wrong current account before starting a fake-game API context', async () => {
    const live = { prepare: vi.fn(async () => result()) }; const f = fixture(true, live)
    f.localImport.assertCurrentTarget.mockRejectedValue(new DomainError('SCREENSHOT_TARGET_NOT_CURRENT', 'Synthetic wrong account'))
    await expect(f.operation.prepare(currentInput)).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_NOT_CURRENT' })
    expect(live.prepare).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
  })

  it.each([false, true])('mode two imports an inactive target without quitting Steam even when restart is %s', async restartSteam => {
    const live = { prepare: vi.fn(async () => result()) }; const f = fixture(true, live)
    const inactive: ScreenshotPrepareResult = { ...result(), method: 'index', activation: 'after-account-switch', completedImageIds: input.imageIds }
    f.localImport.prepareIfInactive.mockResolvedValue(inactive)
    expect(await f.operation.prepare({ ...input, restartSteam })).toBe(inactive)
    expect(f.runtime.resolveRunningClient).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.assertRestartAllowed).not.toHaveBeenCalled()
    expect(live.prepare).not.toHaveBeenCalled()
  })

  it('does not turn an unknown local target identity into a restart or unsafe write', async () => {
    const f = fixture()
    f.localImport.prepareIfInactive.mockRejectedValue(new DomainError('SCREENSHOT_ACTIVE_USER_UNAVAILABLE', 'Synthetic unavailable identity'))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
  })

  it.each([1, 2])('mode two detects a target change around restart confirmation at guard %s', async guard => {
    const f = fixture()
    if (guard === 2) f.localImport.assertCurrentTarget.mockResolvedValueOnce(undefined)
    f.localImport.assertCurrentTarget.mockRejectedValue(new DomainError('SCREENSHOT_TARGET_CHANGED', 'Synthetic changed account'))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_CHANGED' })
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.confirmRestart).toHaveBeenCalledTimes(guard === 2 ? 1 : 0)
  })

  it('never selects the API for explicit local mode even if the legacy preference is true', async () => {
    const live = { prepare: vi.fn(async () => result()) }; const f = fixture(true, live)
    expect(await f.operation.prepare({ ...input, preferLive: true })).toMatchObject({ imported: 1 })
    expect(live.prepare).not.toHaveBeenCalled()
  })

  it('rejects unrecognized modes before starting any read or write stage', async () => {
    const f = fixture()
    await expect(f.operation.prepare({ ...input, mode: 'unknown' } as unknown as ScreenshotPrepareInput)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_INPUT' })
    expect(f.service.preflight).not.toHaveBeenCalled()
    expect(f.runtime.isRunning).not.toHaveBeenCalled()
  })

  it('prefers a confirmed live API result without closing Steam or rewriting the VDF', async () => {
    const response: ScreenshotPrepareResult = { ...result(), method: 'steam-api', backupPath: null, completedImageIds: ['image-1'] }
    const live = { prepare: vi.fn(async () => response) }
    const f = fixture(true, live)
    expect(await f.operation.prepare(currentInput)).toBe(response)
    expect(f.assertRestartAllowed).toHaveBeenCalledExactlyOnceWith('live')
    expect(f.runtime.resolveRunningClient).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.phases).toEqual(['connecting-steam', 'idle'])
  })

  it('keeps mode one selected when the live route cannot initialize, even with restart enabled', async () => {
    const live = { prepare: vi.fn(async () => null) }; const f = fixture(true, live)
    await expect(f.operation.prepare(currentInput)).rejects.toMatchObject({ code: 'SCREENSHOT_MODE_ONE_UNAVAILABLE' })
    expect(live.prepare).toHaveBeenCalledTimes(1)
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.localImport.prepareIfInactive).not.toHaveBeenCalled()
  })

  it.each(['uncertain', 'rejected'] as const)('never automatically restart-reimports a returned live %s result', async status => {
    const response: ScreenshotPrepareResult = { imported: 0, method: 'steam-api', backupPath: null, vdfPath: 'screenshots.vdf', files: [],
      completedImageIds: [], outcomes: [{ imageId: 'image-1', name: 'Test.jpg', status }] }
    const f = fixture(true, { prepare: async () => response })
    expect(await f.operation.prepare(currentInput)).toBe(response)
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
  })

  it('does not convert a live ledger error into restart fallback', async () => {
    const f = fixture(true, { prepare: async () => { throw new DomainError('SCREENSHOT_LIVE_LEDGER_UNAVAILABLE', 'Synthetic corrupt ledger') } })
    await expect(f.operation.prepare(currentInput)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_LEDGER_UNAVAILABLE' })
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
  })

  it('supports explicitly selecting the original restart method', async () => {
    const live = { prepare: vi.fn(async () => null) }; const f = fixture(true, live)
    expect(await f.operation.prepare({ ...input, preferLive: false })).toMatchObject({ imported: 1 })
    expect(live.prepare).not.toHaveBeenCalled()
  })

  it('validates first, confirms, waits for a stable exit, imports, then restarts only the original client', async () => {
    const f = fixture()
    expect(await f.operation.prepare(input)).toMatchObject({ imported: 1, steamRestart: 'restarted' })
    expect(f.order).toEqual(['preflight', 'resolve', 'confirm', 'shutdown', 'import', 'restart'])
    expect(f.phases).toEqual(['importing', 'closing-steam', 'importing', 'starting-steam', 'idle'])
    expect(f.elapsed()).toBe(1500)
    expect(f.runtime.requestShutdown).toHaveBeenCalledWith(f.client)
    expect(f.runtime.start).toHaveBeenCalledWith(f.client)
    expect(f.assertRestartAllowed).toHaveBeenCalledTimes(2)
  })

  it('does not launch Steam that was already closed, even when auto-restart is checked', async () => {
    const f = fixture(false)
    expect(await f.operation.prepare(input)).toEqual(result())
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.runtime.resolveRunningClient).not.toHaveBeenCalled()
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.phases).toEqual(['importing', 'idle'])
  })

  it.each([false, undefined])('does not quit an open client without restart opt-in %s', async restartSteam => {
    const f = fixture()
    await expect(f.operation.prepare({ ...input, restartSteam })).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RUNNING' })
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.phases).toEqual(['importing', 'idle'])
  })

  it('native cancellation has no file writes, shutdown, restart, or queue clearing', async () => {
    const f = fixture(); f.confirmRestart.mockResolvedValue(false)
    expect(await f.operation.prepare(input)).toBeNull()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.phases).toEqual(['importing', 'idle'])
  })

  it('refuses invalid input before inspecting or interrupting the client', async () => {
    const f = fixture(); f.service.preflight.mockRejectedValue(new DomainError('SCREENSHOT_INVALID_QUEUE', 'Synthetic stale queue'))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_QUEUE' })
    expect(f.runtime.isRunning).not.toHaveBeenCalled()
    expect(f.confirmRestart).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
  })

  it.each([1, 2])('rejects live game/status work at guard %s without requesting shutdown', async guard => {
    const f = fixture()
    if (guard === 2) f.assertRestartAllowed.mockImplementationOnce(() => {})
    f.assertRestartAllowed.mockImplementation(() => { throw new DomainError('SCREENSHOT_STEAM_WORK_BUSY', 'Synthetic work') })
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_WORK_BUSY' })
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
  })

  it('does not write or launch a second client when graceful exit times out', async () => {
    const f = fixture(); f.runtime.requestShutdown.mockImplementation(async () => {})
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_EXIT_TIMEOUT' })
    expect(f.elapsed()).toBeGreaterThanOrEqual(60_000)
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('requires continuously stopped observations instead of one absent process sample', async () => {
    const f = fixture()
    f.runtime.requestShutdown.mockImplementation(async () => {
      f.runtime.isRunning.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      f.setRunning(false)
    })
    expect(await f.operation.prepare(input)).toMatchObject({ imported: 1 })
    expect(f.elapsed()).toBe(2500)
  })

  it('preserves the original import error but still reopens Steam after conversion/write failure', async () => {
    const f = fixture(); const error = new DomainError('SCREENSHOT_ENCODE_FAILED', 'Synthetic encoding')
    f.service.prepare.mockRejectedValue(error)
    await expect(f.operation.prepare(input)).rejects.toBe(error)
    expect(f.runtime.start).toHaveBeenCalledExactlyOnceWith(f.client)
    expect(f.phases.at(-1)).toBe('idle')
  })

  it('recovers an exited Steam even when its shutdown command rejects after delivering the request', async () => {
    const f = fixture(); f.runtime.requestShutdown.mockImplementation(async () => { f.setRunning(false); throw new DomainError('SCREENSHOT_STEAM_SHUTDOWN_FAILED', 'Synthetic exit status') })
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_SHUTDOWN_FAILED' })
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.start).toHaveBeenCalledExactlyOnceWith(f.client)
  })

  it('waits for delayed exit after an ambiguous shutdown command failure, then reopens without importing', async () => {
    const f = fixture()
    f.runtime.requestShutdown.mockRejectedValue(new DomainError('SCREENSHOT_STEAM_SHUTDOWN_FAILED', 'Synthetic timeout after delivery'))
    f.runtime.isRunning.mockImplementation(async () => f.runtime.start.mock.calls.length > 0 || f.elapsed() < 2000)
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_SHUTDOWN_FAILED' })
    expect(f.elapsed()).toBe(3500)
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.start).toHaveBeenCalledExactlyOnceWith(f.client)
  })

  it('reports an uncertain late-exit possibility rather than claiming shutdown was recovered', async () => {
    const f = fixture()
    f.runtime.requestShutdown.mockRejectedValue(new DomainError('SCREENSHOT_STEAM_SHUTDOWN_FAILED', 'Synthetic command failure'))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_SHUTDOWN_UNCONFIRMED' })
    expect(f.elapsed()).toBeGreaterThanOrEqual(60_000)
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
  })

  it('returns committed import success with a separate restart warning instead of prompting duplicate import', async () => {
    const f = fixture(); f.runtime.start.mockRejectedValue(new Error('Synthetic spawn failure'))
    expect(await f.operation.prepare(input)).toMatchObject({ imported: 1, steamRestart: 'failed' })
    expect(f.service.prepare).toHaveBeenCalledTimes(1)
  })

  it('also distinguishes startup detection timeout from a failed import', async () => {
    const f = fixture(); f.runtime.start.mockImplementation(async () => {})
    expect(await f.operation.prepare(input)).toMatchObject({ imported: 1, steamRestart: 'failed' })
    expect(f.elapsed()).toBeGreaterThanOrEqual(31_500)
  })

  it('reports both import and restart failure without discarding the unsent queue', async () => {
    const f = fixture(); f.service.prepare.mockRejectedValue(new Error('Synthetic import failure'))
    f.runtime.start.mockRejectedValue(new Error('Synthetic spawn failure'))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_IMPORT_AND_RESTART_FAILED' })
  })

  it('never imports when process inspection fails', async () => {
    const f = fixture(); f.runtime.isRunning.mockRejectedValue(new Error('Synthetic tasklist failure'))
    await expect(f.operation.prepare(input)).rejects.toThrow('Synthetic tasklist failure')
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.runtime.requestShutdown).not.toHaveBeenCalled()
  })

  it('serializes native confirmation and allows a later operation after cancellation', async () => {
    const f = fixture(); let accept!: (value: boolean) => void
    f.confirmRestart.mockImplementationOnce(() => new Promise<boolean>(resolve => { accept = resolve }))
    const pending = f.operation.prepare(input)
    await vi.waitFor(() => expect(f.confirmRestart).toHaveBeenCalledTimes(1))
    await expect(f.operation.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_BUSY' })
    accept(false)
    expect(await pending).toBeNull()
    expect(await f.operation.prepare(input)).toMatchObject({ imported: 1 })
  })
})

describe('screenshot import conflict fence', () => {
  it.each(['screenshots:prepare', 'screenshots:refresh', 'screenshots:chooseSteam', 'screenshots:chooseImages', 'screenshots:clearImages', 'screenshots:resolveGame', 'gameStatus:connectLocal', 'gameStatus:observe', 'gameStatus:patch', 'localAppSimulation:start', 'statusCopy:start', 'statusCopy:preview'])('blocks %s during the entire confirmed restart/import', channel => {
    expect(screenshotImportBlocksChannel(channel)).toBe(true)
  })
  it.each(['screenshots:catalog', 'screenshots:images', 'snapshot:get', 'gameStatus:state', 'localAppSimulation:state', 'statusCopy:state', 'batch:pause', 'batch:resume'])('allows read-only UI and independent web task control %s', channel => {
    expect(screenshotImportBlocksChannel(channel)).toBe(false)
  })
})
