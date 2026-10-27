import { describe, expect, it, vi } from 'vitest'
import { readLocalSimulationContext } from '../src/main/simulation-local-context'
import type { NativeGameStatusContext } from '../src/main/native-game-status-client'

const context: NativeGameStatusContext = { steamId: '76561198000000001', appId: 0,
  steamPid: 1234, steamStartTicks: '639281229140268291', steamExe: 'C:/fixture/steam.exe' }

describe('read-only local simulation permission indicators', () => {
  it('reports idle only after checking both indicators in the same Steam instance', async () => {
    const detect = vi.fn(async () => ({ ...context }))
    const activity = vi.fn(async () => ({ gameActive: false }))
    await expect(readLocalSimulationContext({ detectContext: detect, queryActivity: activity }))
      .resolves.toEqual({ steamId: context.steamId, appId: 0, gameActive: false })
    expect(detect).toHaveBeenCalledTimes(2); expect(activity).toHaveBeenCalledOnce()
  })

  it('rejects idle classification when RunningAppID already identifies a game', async () => {
    const activity = vi.fn(async () => ({ gameActive: false }))
    await expect(readLocalSimulationContext({ detectContext: async () => ({ ...context, appId: 730 }), queryActivity: activity }))
      .resolves.toEqual({ steamId: context.steamId, appId: 730, gameActive: true })
    expect(activity).not.toHaveBeenCalled()
  })

  it('keeps Apps.Running activity even when RunningAppID is zero', async () => {
    await expect(readLocalSimulationContext({ detectContext: async () => ({ ...context }), queryActivity: async () => ({ gameActive: true }) }))
      .resolves.toEqual({ steamId: context.steamId, appId: 0, gameActive: true })
  })

  it('catches a game starting while the local indicators are being checked', async () => {
    const detect = vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, appId: 730 })
    await expect(readLocalSimulationContext({ detectContext: detect, queryActivity: async () => ({ gameActive: false }) }))
      .resolves.toEqual({ steamId: context.steamId, appId: 730, gameActive: true })
  })

  it.each([
    { steamId: '76561198000000002' }, { steamPid: 4321 }, { steamStartTicks: '639281229140268292' },
    { steamExe: 'C:/another-fixture/steam.exe' }
  ])('does not combine activity from changed Steam identity %j', async change => {
    const detect = vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, ...change })
    await expect(readLocalSimulationContext({ detectContext: detect, queryActivity: async () => ({ gameActive: false }) }))
      .rejects.toMatchObject({ code: 'GAME_STATUS_SIMULATION_CONTEXT_UNAVAILABLE' })
  })

  it('fails closed on inaccessible or malformed activity without exposing raw errors', async () => {
    const run = (queryActivity: () => Promise<{ gameActive: boolean }>) =>
      readLocalSimulationContext({ detectContext: async () => ({ ...context }), queryActivity })
    await expect(run(async () => { throw new Error('SYNTHETIC_PRIVATE_REGISTRY_ERROR') })).rejects.not.toThrow('SYNTHETIC_PRIVATE')
    await expect(run(async () => ({ gameActive: 'false' }) as never)).rejects.toMatchObject({ code: 'GAME_STATUS_SIMULATION_CONTEXT_UNAVAILABLE' })
  })
})
