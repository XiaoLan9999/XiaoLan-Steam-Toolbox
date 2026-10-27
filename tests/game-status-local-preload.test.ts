import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SteamFriendCommenterApi } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: { connected: false } })),
  expose: vi.fn(), on: vi.fn(), removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener }
}))

import '../src/preload/index'

const api = mocks.expose.mock.calls[0]![1] as SteamFriendCommenterApi
afterEach(() => { mocks.invoke.mockClear(); mocks.on.mockClear(); mocks.removeListener.mockClear() })

describe('local game-status preload boundary', () => {
  it('exposes no generic IPC or native execution surface', () => {
    expect(mocks.expose.mock.calls[0]![0]).toBe('steamCommenter')
    for (const key of ['invoke', 'send', 'execute', 'native', 'loadLibrary', 'credentials', 'webLogonToken']) expect(Object.hasOwn(api.gameStatus, key)).toBe(false)
  })

  it('forwards only the local connection action to the dedicated channel', async () => {
    const action = { accountId: 'fixture-account', sessionId: 'fixture-session' }
    await expect(api.gameStatus.connectLocal(action)).resolves.toEqual({ ok: true, data: { connected: false } })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('gameStatus:connectLocal', action)
  })

  it('keeps the legacy action on its dedicated channel without any fallback', async () => {
    const action = { accountId: 'fixture-account', sessionId: 'fixture-session' }
    await api.gameStatus.connectWithToolbox(action)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('gameStatus:connectWithToolbox', action)
  })

  it('does not fall back to CM if the dedicated local invocation fails', async () => {
    const action = { accountId: 'fixture-account', sessionId: 'fixture-session' }
    const failure = { ok: false, error: { code: 'GAME_STATUS_NATIVE_UNAVAILABLE', message: 'Unavailable' } }
    mocks.invoke.mockResolvedValueOnce(failure as never)
    await expect(api.gameStatus.connectLocal(action)).resolves.toEqual(failure)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('gameStatus:connectLocal', action)
  })

  it('exposes only dedicated existing-AppID operations, never generic native execution', async () => {
    expect(api.localAppSimulation).toBeDefined()
    expect(Object.keys(api.localAppSimulation!).sort()).toEqual(['inspect', 'start', 'state', 'stop'])
    const action = { accountId: 'fixture-account', sessionId: 'fixture-session' }
    await api.localAppSimulation!.start({ ...action, appId: 1329410 })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('localAppSimulation:start', { ...action, appId: 1329410 })
  })

  it('does not invoke the legacy CM channel when local AppID startup fails', async () => {
    const action = { accountId: 'fixture-account', sessionId: 'fixture-session', appId: 1329410 }
    const failure = { ok: false, error: { code: 'LOCAL_APP_WORKER_UNAVAILABLE', message: 'Unavailable' } }
    mocks.invoke.mockResolvedValueOnce(failure as never)
    await expect(api.localAppSimulation!.start(action)).resolves.toEqual(failure)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('localAppSimulation:start', action)
  })

  it('exposes a separate bounded status-copy API without credentials or arbitrary commands', async () => {
    expect(Object.keys(api.statusCopy!).sort()).toEqual(['preview', 'save', 'start', 'state', 'stop'])
    const input = { accountId: 'fixture-account', sessionId: 'copy-session', settings: {
      mode: 'toolbox' as const, sourceSteamId: '76561198000000002', intervalSeconds: 15, copyGroupSize: false, persona: 'away' as const
    } }
    await api.statusCopy!.preview(input)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('statusCopy:preview', input)
    for (const key of ['getLogin', 'credentials', 'invoke', 'command', 'fetch', 'execute']) expect(Object.hasOwn(api.statusCopy!, key)).toBe(false)
  })
})
