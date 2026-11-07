import { describe, expect, it, vi } from 'vitest'
import { win32 as path } from 'node:path'
import { createVerifiedNativeContextDetector } from '../src/main/native-context-resolver'
import type { VerifiedNativeInspection } from '../src/main/native-context-resolver'
import type { NativePresenceBinding, NativePresenceContext } from '../src/main/native-presence-broker'

const steamId = '76561198000000001'
const otherSteamId = '76561198000000002'
const appId = 493520
const workerPath = 'D:\\Toolbox\\screenshot-identity-x64.exe'
const steam = { pid: 410, startTicks: '639000000000000001', exe: 'D:\\Steam\\steam.exe' }
const game = { pid: 820, startTicks: '639000000000000002', exe: 'D:\\Steam\\steamapps\\common\\GTFO\\GTFO.exe' }
const activeUser = Number(BigInt(steamId) - 76_561_197_960_265_728n)

function fixture() {
  let state: VerifiedNativeInspection = { registryExe: steam.exe, steamProcesses: [{ ...steam }], runningAppId: 0,
    runningAppIds: [appId], activeProcess: { pid: steam.pid - 1, activeUser: activeUser + 1 }, gameProcess: { ...game } }
  const inspect = vi.fn(async (_pid?: number): Promise<unknown> => structuredClone(state))
  const discover = vi.fn(async (context: NativePresenceContext): Promise<NativePresenceBinding> => {
    if (context.appId !== appId) throw Object.assign(new Error('Synthetic app has no running process'), { nativeCode: 'NATIVE_GAME_NOT_FOUND' })
    return { gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe, clientDllPath: 'D:\\Steam\\steamclient64.dll',
      clientDllSha256: 'a'.repeat(64), dllPath: 'D:\\Steam\\steamapps\\common\\GTFO\\steam_api64.dll', dllSha256: 'b'.repeat(64),
      arch: 'x64', parentPid: 100, parentStartTicks: '639000000000000000', steamPid: steam.pid, steamStartTicks: steam.startTicks }
  })
  const readIdentity = vi.fn(async (_root?: string, _worker?: string, _options?: { signal?: AbortSignal }) => ({ steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
    steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) }))
  const realpath = vi.fn(async (value: string) => path.normalize(value))
  const detect = createVerifiedNativeContextDetector(steamId, workerPath, { platform: 'win32', inspect, discover, readIdentity, realpath })
  return { detect, inspect, discover, readIdentity, realpath, get state() { return state }, set state(value) { state = value } }
}

describe('verified native game context with offline dependencies only', () => {
  it('binds the actual Steam/game and native user despite stale ActiveProcess and zero RunningAppID', async () => {
    const f = fixture()
    await expect(f.detect()).resolves.toEqual({ appId, steamId, steamPid: steam.pid, steamStartTicks: steam.startTicks,
      steamExe: steam.exe, identitySource: 'native-user', gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe })
    expect(f.readIdentity).toHaveBeenCalledExactlyOnceWith('D:\\Steam', workerPath, { signal: expect.any(AbortSignal) })
    expect(f.discover).toHaveBeenCalledExactlyOnceWith({ appId, steamId, steamPid: steam.pid, steamStartTicks: steam.startTicks, identitySource: 'native-user' })
    expect(f.inspect.mock.calls).toEqual([[undefined], [game.pid], [game.pid]])
    for (let index = 0; index < 4; index++) await f.detect()
    expect(f.readIdentity).toHaveBeenCalledOnce()
    expect(f.discover).toHaveBeenCalledOnce()
    expect(f.inspect).toHaveBeenCalledTimes(7)
  })

  it('uses a nonzero RunningAppID only as another statically verified candidate', async () => {
    const f = fixture()
    f.state.runningAppId = 730
    await expect(f.detect()).resolves.toMatchObject({ appId })
    expect(f.discover.mock.calls.map(call => call[0].appId)).toEqual([730, appId])
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('supports eight bounded registry hints while accepting only the actual game', async () => {
    const f = fixture()
    f.state.runningAppIds = [1, 2, 3, 4, 5, 6, 7, appId]
    await expect(f.detect()).resolves.toMatchObject({ appId })
    expect(f.discover).toHaveBeenCalledTimes(8)
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('accepts matching canonical Steam executable spellings', async () => {
    const f = fixture()
    f.state.registryExe = 'd:/steam/STEAM.exe'
    await expect(f.detect()).resolves.toMatchObject({ appId })
  })

  it.each(['multiple Steam processes', 'registered executable mismatch', 'no candidate', 'too many candidates', 'invalid candidate'] as const)(
    'refuses %s before starting any native identity helper', async issue => {
      const f = fixture()
      if (issue === 'multiple Steam processes') f.state.steamProcesses.push({ ...steam, pid: steam.pid + 1 })
      if (issue === 'registered executable mismatch') f.state.registryExe = 'D:\\OtherSteam\\steam.exe'
      if (issue === 'no candidate') f.state.runningAppIds = []
      if (issue === 'too many candidates') f.state.runningAppIds = [1, 2, 3, 4, 5, 6, 7, 8, appId]
      if (issue === 'invalid candidate') f.state.runningAppIds = [0x1000000]
      await expect(f.detect()).rejects.toBeInstanceOf(Error)
      expect(f.readIdentity).not.toHaveBeenCalled()
      expect(f.discover).not.toHaveBeenCalled()
    })

  it('rejects a phantom RunningAppID without a real game binding', async () => {
    const f = fixture()
    f.state.runningAppId = 730
    f.state.runningAppIds = []
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it('rejects two actual game bindings instead of selecting a registry favorite', async () => {
    const f = fixture()
    f.state.runningAppId = 730
    f.discover.mockImplementation(async () => ({ gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe,
      clientDllPath: 'D:\\Steam\\steamclient64.dll', clientDllSha256: 'a'.repeat(64), arch: 'x64', parentPid: 100,
      parentStartTicks: '639000000000000000', steamPid: steam.pid, steamStartTicks: steam.startTicks }))
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it('does not swallow discovery ambiguity as an absent stale candidate', async () => {
    const f = fixture()
    f.discover.mockRejectedValueOnce(Object.assign(new Error('Synthetic multiple loaded APIs'), { nativeCode: 'NATIVE_GAME_AMBIGUOUS' }))
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it('rejects an explicit ActiveUser conflict belonging to the actual Steam PID', async () => {
    const f = fixture()
    f.state.activeProcess = { pid: steam.pid, activeUser: activeUser + 1 }
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 0, '0', activeUser])('does not turn ActiveUser %s into the source of identity', async user => {
    const f = fixture()
    f.state.activeProcess = { pid: steam.pid, activeUser: user }
    await expect(f.detect()).resolves.toMatchObject({ steamId, identitySource: 'native-user' })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('rejects a native user mismatch and never invokes a second helper on that detector', async () => {
    const f = fixture()
    f.readIdentity.mockResolvedValueOnce({ steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
      steamStartTicks: steam.startTicks, steamId: otherSteamId, clientSha256: 'c'.repeat(64) })
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_IDENTITY_MISMATCH' })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it.each(['Steam PID', 'Steam start time', 'Steam executable', 'Steam root', 'malformed client hash'] as const)(
    'rejects native identity proof with a different %s', async field => {
      const f = fixture()
      const identity = { steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
        steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) }
      if (field === 'Steam PID') identity.steamPid++
      if (field === 'Steam start time') identity.steamStartTicks = '639000000000000009'
      if (field === 'Steam executable') identity.steamExe = 'D:\\OtherSteam\\steam.exe'
      if (field === 'Steam root') identity.steamPath = 'D:\\OtherSteam'
      if (field === 'malformed client hash') identity.clientSha256 = ''
      f.readIdentity.mockResolvedValueOnce(identity)
      await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
      expect(f.inspect).toHaveBeenCalledTimes(2)
      await expect(f.detect()).rejects.toBeInstanceOf(Error)
      expect(f.readIdentity).toHaveBeenCalledOnce()
    })

  it('rejects a discovery binding from another Steam process before reading identity', async () => {
    const f = fixture()
    f.discover.mockResolvedValueOnce({ gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe,
      clientDllPath: 'D:\\Steam\\steamclient64.dll', clientDllSha256: 'a'.repeat(64), arch: 'x64', parentPid: 100,
      parentStartTicks: '639000000000000000', steamPid: steam.pid + 1, steamStartTicks: steam.startTicks })
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it.each(['unknown client hash', 'incomplete helper cleanup'] as const)('fails closed when the audited helper rejects %s', async () => {
    const f = fixture()
    f.readIdentity.mockRejectedValueOnce(new Error('Synthetic audited helper refused the read'))
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it.each(['Steam PID', 'Steam start time', 'game PID', 'game start time', 'game image', 'candidate set'] as const)(
    'rejects a changed %s during the native identity read', async change => {
      const f = fixture()
      f.readIdentity.mockImplementationOnce(async () => {
        if (change === 'Steam PID') f.state.steamProcesses[0]!.pid++
        if (change === 'Steam start time') f.state.steamProcesses[0]!.startTicks = '639000000000000009'
        if (change === 'game PID') f.state.gameProcess!.pid++
        if (change === 'game start time') f.state.gameProcess!.startTicks = '639000000000000009'
        if (change === 'game image') f.state.gameProcess!.exe = 'D:\\Other\\GTFO.exe'
        if (change === 'candidate set') f.state.runningAppIds = []
        return { steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
          steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) }
      })
      await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
      expect(f.readIdentity).toHaveBeenCalledOnce()
    })

  it('coalesces overlapping detection and does not expose its internal cached object', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<typeof f.readIdentity>>>()
    f.readIdentity.mockReturnValueOnce(pending.promise)
    const first = f.detect(), second = f.detect()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledOnce())
    pending.resolve({ steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
      steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) })
    const value = await first
    value.steamId = otherSteamId
    await expect(f.detect()).resolves.toMatchObject({ steamId })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it.each(['game exit', 'game PID reuse', 'Steam restart', 'account conflict'] as const)('latches %s after attachment without silently rebinding', async change => {
    const f = fixture()
    await f.detect()
    if (change === 'game exit') f.state.gameProcess = null
    if (change === 'game PID reuse') f.state.gameProcess!.startTicks = '639000000000000009'
    if (change === 'Steam restart') f.state.steamProcesses[0]!.startTicks = '639000000000000009'
    if (change === 'account conflict') f.state.activeProcess = { pid: steam.pid, activeUser: activeUser + 1 }
    await expect(f.detect()).rejects.toMatchObject({ code: change === 'account conflict' ? 'GAME_STATUS_IDENTITY_MISMATCH' : 'GAME_STATUS_CONTEXT_CHANGED' })
    f.state.gameProcess = { ...game }
    f.state.steamProcesses = [{ ...steam }]
    f.state.activeProcess = { pid: steam.pid, activeUser }
    await expect(f.detect()).rejects.toBeInstanceOf(Error)
    expect(f.readIdentity).toHaveBeenCalledOnce()
    expect(f.discover).toHaveBeenCalledOnce()
  })

  it('retains its binding through harmless registry marker disappearance and rechecks changed hints only once', async () => {
    const f = fixture()
    await f.detect()
    f.state.runningAppIds = []
    await expect(f.detect()).resolves.toMatchObject({ appId })
    expect(f.discover).toHaveBeenCalledOnce()
    f.state.runningAppId = 730
    await expect(f.detect()).resolves.toMatchObject({ appId })
    expect(f.discover).toHaveBeenCalledTimes(2)
    await f.detect()
    expect(f.discover).toHaveBeenCalledTimes(2)
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('stops when changed registry hints reveal another actual running game', async () => {
    const f = fixture()
    await f.detect()
    f.state.runningAppIds.push(730)
    f.discover.mockResolvedValueOnce({ gamePid: 821, gameStartTicks: '639000000000000009', gameExe: 'D:\\Steam\\steamapps\\common\\CS2\\cs2.exe',
      clientDllPath: 'D:\\Steam\\steamclient64.dll', clientDllSha256: 'a'.repeat(64), arch: 'x64', parentPid: 100,
      parentStartTicks: '639000000000000000', steamPid: steam.pid, steamStartTicks: steam.startTicks })
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('can recheck a temporary inspection failure without creating another identity helper', async () => {
    const f = fixture()
    await f.detect()
    f.inspect.mockRejectedValueOnce(new Error('Synthetic read access failure'))
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    await expect(f.detect()).resolves.toMatchObject({ appId })
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('cancels a pending discovery immediately without starting more candidates or an identity helper', async () => {
    const f = fixture()
    f.state.runningAppId = 730
    const pending = deferred<NativePresenceBinding>()
    f.discover.mockReturnValueOnce(pending.promise)
    const result = f.detect()
    await vi.waitFor(() => expect(f.discover).toHaveBeenCalledOnce())
    f.detect.cancel()
    await expect(result).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    pending.resolve({ gamePid: game.pid, gameStartTicks: game.startTicks, gameExe: game.exe,
      clientDllPath: 'D:\\Steam\\steamclient64.dll', clientDllSha256: 'a'.repeat(64), arch: 'x64', parentPid: 100,
      parentStartTicks: '639000000000000000', steamPid: steam.pid, steamStartTicks: steam.startTicks })
    await Promise.resolve()
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.discover).toHaveBeenCalledOnce()
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it('cancels a pending helper read without accepting late identity or starting final inspection', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<typeof f.readIdentity>>>()
    f.readIdentity.mockReturnValueOnce(pending.promise)
    const result = f.detect()
    await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledOnce())
    const signal = f.readIdentity.mock.calls[0]![2]!.signal!
    expect(signal.aborted).toBe(false)
    f.detect.cancel()
    expect(signal.aborted).toBe(true)
    await expect(result).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    const before = f.inspect.mock.calls.length
    pending.resolve({ steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
      steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) })
    await Promise.resolve()
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.inspect).toHaveBeenCalledTimes(before)
    expect(f.readIdentity).toHaveBeenCalledOnce()
  })

  it('forwards an owned abort signal so cancellation stops provider preflight without affecting another detector', async () => {
    const first = fixture(), second = fixture()
    const preflight = deferred<void>()
    const spawned = vi.fn()
    first.readIdentity.mockImplementationOnce(async (_root, _worker, options) => {
      await preflight.promise
      options!.signal!.throwIfAborted()
      spawned()
      return { steamPath: 'D:\\Steam', steamExe: steam.exe, steamPid: steam.pid,
        steamStartTicks: steam.startTicks, steamId, clientSha256: 'c'.repeat(64) }
    })
    const pending = first.detect()
    await vi.waitFor(() => expect(first.readIdentity).toHaveBeenCalledOnce())
    await second.detect()
    const firstSignal = first.readIdentity.mock.calls[0]![2]!.signal!
    const secondSignal = second.readIdentity.mock.calls[0]![2]!.signal!
    expect(firstSignal).not.toBe(secondSignal)
    first.detect.cancel()
    await expect(pending).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    preflight.resolve()
    await Promise.resolve()
    expect(spawned).not.toHaveBeenCalled()
    await expect(second.detect()).resolves.toMatchObject({ appId })
  })

  it('cancels initial inspection and never starts discovery when its snapshot arrives late', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.inspect.mockReturnValueOnce(pending.promise)
    const result = f.detect()
    f.detect.cancel()
    await expect(result).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    pending.resolve(f.state)
    await Promise.resolve()
    expect(f.discover).not.toHaveBeenCalled()
    expect(f.readIdentity).not.toHaveBeenCalled()
  })

  it('does not start any inspection when cancelled before its first invocation', async () => {
    const f = fixture()
    f.detect.cancel()
    await expect(f.detect()).rejects.toMatchObject({ code: 'GAME_STATUS_CONTEXT_CHANGED' })
    expect(f.inspect).not.toHaveBeenCalled()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
