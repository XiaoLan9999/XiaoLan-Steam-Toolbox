import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createScreenshotSteamRuntime, type ScreenshotSteamRuntimeDependencies } from '../src/main/steam-screenshot-lifecycle-runtime'

const ROOT = 'D:\\Steam'
const EXE = `${ROOT}\\steam.exe`
const snapshot = () => ({ executable: EXE, registryExecutable: EXE, pid: 1234, startTicks: '638964000000000001', steamPids: [1234], runningAppId: 0, runningAppIds: [] as number[] })
const file = (directory = false) => ({ isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, dev: 1, ino: directory ? 10 : 11, size: directory ? 0 : 1024, mtimeMs: 123456 })
function fixture() {
  let state: unknown = snapshot()
  const dependencies: ScreenshotSteamRuntimeDependencies = {
    platform: 'win32', isRunning: vi.fn(async () => false), inspect: vi.fn(async () => state),
    realpath: vi.fn(async path => path), lstat: vi.fn(async path => file(path.toLowerCase() === ROOT.toLowerCase())),
    shutdown: vi.fn(async () => {}), launch: vi.fn(async () => {})
  }
  return { dependencies, runtime: createScreenshotSteamRuntime(dependencies), setState(value: unknown) { state = value } }
}

describe('Steam screenshot graceful client lifecycle runtime', () => {
  it('resolves the single active Steam instance without requiring an account or native API', async () => {
    const f = fixture()
    const client = await f.runtime.resolveRunningClient(ROOT)
    expect(client).toEqual({ executable: EXE, pid: 1234, startTicks: snapshot().startTicks })
    expect(Object.isFrozen(client)).toBe(true)
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
    expect(f.dependencies.launch).not.toHaveBeenCalled()
    expect(await f.runtime.isRunning()).toBe(false)
  })

  it('revalidates process identity immediately before requesting normal shutdown', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    await f.runtime.requestShutdown(client)
    expect(f.dependencies.inspect).toHaveBeenCalledTimes(2)
    expect(f.dependencies.shutdown).toHaveBeenCalledExactlyOnceWith(EXE)
    expect(f.dependencies.launch).not.toHaveBeenCalled()
  })

  it.each([
    { pid: 5678, steamPids: [5678] },
    { startTicks: '638964000000000002' }
  ])('does not shut down a replacement instance %#', async changes => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    f.setState({ ...snapshot(), ...changes })
    await expect(f.runtime.requestShutdown(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_CHANGED' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it.each([
    null, {}, { ...snapshot(), steamPids: [1234, 5678] }, { ...snapshot(), steamPids: [] },
    { ...snapshot(), steamPids: [5678] }, { ...snapshot(), pid: 0 }, { ...snapshot(), startTicks: '' },
    { ...snapshot(), executable: 'D:\\Other\\steam.exe' }, { ...snapshot(), registryExecutable: 'D:\\Other\\steam.exe' },
    { ...snapshot(), executable: `${ROOT}\\fake.exe`, registryExecutable: `${ROOT}\\fake.exe` },
    { ...snapshot(), runningAppId: -1 }, { ...snapshot(), runningAppIds: [Number.NaN] },
    { ...snapshot(), runningAppIds: Array.from({ length: 4097 }, () => 0) }
  ])('fails closed for incomplete, multiple, or mismatched Steam instances %#', async state => {
    const f = fixture(); f.setState(state)
    await expect(f.runtime.resolveRunningClient(ROOT)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it.each([{ runningAppId: 730 }, { runningAppIds: [1329410] }])('refuses to interrupt running games %#', async changes => {
    const f = fixture(); f.setState({ ...snapshot(), ...changes })
    await expect(f.runtime.resolveRunningClient(ROOT)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_GAME_RUNNING' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it('rechecks running games added after initial confirmation', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    f.setState({ ...snapshot(), runningAppIds: [730] })
    await expect(f.runtime.requestShutdown(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_GAME_RUNNING' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it.each(['Steam', 'D:\\Steam\0other', 'D:\\Other'])('rejects an invalid or different selected root %s', async root => {
    const f = fixture()
    await expect(f.runtime.resolveRunningClient(root)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED' })
  })

  it.each([ROOT, EXE])('rejects filesystem links and redirects at %s', async target => {
    const f = fixture()
    vi.mocked(f.dependencies.realpath).mockImplementation(async path => path === target ? 'D:\\Redirected' : path)
    await expect(f.runtime.resolveRunningClient(ROOT)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it.each([ROOT, EXE])('rejects symlinks at %s', async target => {
    const f = fixture()
    vi.mocked(f.dependencies.lstat).mockImplementation(async path => ({ ...file(path === ROOT), isSymbolicLink: () => path === target }))
    await expect(f.runtime.resolveRunningClient(ROOT)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED' })
  })

  it('accepts equivalent Windows path casing and separators', async () => {
    const f = fixture(); f.setState({ ...snapshot(), registryExecutable: 'd:/steam/STEAM.EXE' })
    await expect(f.runtime.resolveRunningClient('d:/steam')).resolves.toMatchObject({ pid: 1234 })
  })

  it('rejects caller-created or copied client descriptors', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    await expect(f.runtime.requestShutdown({ ...client })).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_CHANGED' })
    await expect(f.runtime.start({ ...client })).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_CHANGED' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled()
  })

  it('starts only the resolved executable after validating it again', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    await f.runtime.requestShutdown(client); await f.runtime.start(client)
    expect(f.dependencies.launch).toHaveBeenCalledExactlyOnceWith(EXE)
    expect(f.dependencies.lstat).toHaveBeenCalledWith(EXE)
  })

  it('does not start a duplicate client if Steam was already reopened', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    vi.mocked(f.dependencies.isRunning).mockResolvedValue(true)
    await f.runtime.start(client)
    expect(f.dependencies.launch).not.toHaveBeenCalled()
  })

  it.each(['dev', 'ino', 'size', 'mtimeMs'] as const)('does not restart an executable replaced after validation (%s)', async key => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    vi.mocked(f.dependencies.lstat).mockImplementation(async path => ({ ...file(path === ROOT), ...(path === EXE ? { [key]: file()[key] + 1 } : {}) }))
    await expect(f.runtime.start(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_CHANGED' })
    expect(f.dependencies.launch).not.toHaveBeenCalled()
  })

  it('does not execute an executable replaced before requesting shutdown', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    vi.mocked(f.dependencies.lstat).mockImplementation(async path => ({ ...file(path === ROOT), ...(path === EXE ? { ino: 99 } : {}) }))
    await expect(f.runtime.requestShutdown(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_CLIENT_CHANGED' })
    expect(f.dependencies.shutdown).not.toHaveBeenCalled()
  })

  it('reports normal shutdown failure without a fallback termination attempt', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    vi.mocked(f.dependencies.shutdown).mockRejectedValue(new Error('fixture timeout'))
    await expect(f.runtime.requestShutdown(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_SHUTDOWN_FAILED' })
    expect(f.dependencies.shutdown).toHaveBeenCalledTimes(1)
    expect(f.dependencies.launch).not.toHaveBeenCalled()
  })

  it('reports spawn failure as restart failure', async () => {
    const f = fixture(); const client = await f.runtime.resolveRunningClient(ROOT)
    vi.mocked(f.dependencies.launch).mockRejectedValue(new Error('fixture spawn failure'))
    await expect(f.runtime.start(client)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_START_FAILED' })
  })

  it('supports read-only running checks but rejects automatic lifecycle outside Windows', async () => {
    const f = fixture(); const runtime = createScreenshotSteamRuntime({ ...f.dependencies, platform: 'linux' })
    expect(await runtime.isRunning()).toBe(false)
    await expect(runtime.resolveRunningClient(ROOT)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RESTART_UNSUPPORTED' })
    expect(f.dependencies.inspect).not.toHaveBeenCalled()
  })

  it('uses bounded native commands without services, shell execution, API initialization, or forced termination', async () => {
    const source = await readFile(new URL('../src/main/steam-screenshot-lifecycle-runtime.ts', import.meta.url), 'utf8')
    expect(source).toContain("execute(executable, ['-shutdown']")
    expect(source).toContain('timeout: 10_000')
    expect(source).toContain("detached: true, windowsHide: true, stdio: 'ignore', shell: false")
    expect(source).toContain("child.once('spawn'")
    expect(source).not.toMatch(/taskkill|Stop-Process|Restart-Service|Stop-Service|steamservice|SteamAPI_Init|SteamClient\(|shell:\s*true/i)
    expect(source).not.toContain('ActiveUser')
    expect(source).not.toContain('ActiveProcess')
    expect(source).toContain("$steam=$all[0]")
  })
})
