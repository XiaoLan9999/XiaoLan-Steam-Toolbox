import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import { createLiveNativeContextDetector } from '../src/main/native-context-strategy'
import type { NativeGameStatusContext } from '../src/main/native-game-status-client'

const context: NativeGameStatusContext = { appId: 493520, steamId: '76561198000000001', steamPid: 123,
  steamStartTicks: '638964000000000001', steamExe: 'D:/Steam/steam.exe' }

describe('local connection detection strategy', () => {
  it('preserves the working legacy path and never opens an identity helper for it', async () => {
    const legacy = vi.fn(async () => context), verified = vi.fn(async () => context)
    const detect = createLiveNativeContextDetector(legacy, verified)
    expect(await detect()).toBe(context)
    expect(await detect()).toBe(context)
    expect(legacy).toHaveBeenCalledTimes(2)
    expect(verified).not.toHaveBeenCalled()
  })

  it.each(['missing', 'zero'])('uses native identity proof initially for %s registry game context and stays on that mode', async reason => {
    const legacy = vi.fn(async () => { if (reason === 'missing') throw new DomainError('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', 'synthetic'); return { ...context, appId: 0 } })
    const verified = vi.fn(async () => ({ ...context, identitySource: 'native-user' as const }))
    const detect = createLiveNativeContextDetector(legacy, verified)
    expect((await detect()).identitySource).toBe('native-user')
    expect((await detect()).identitySource).toBe('native-user')
    expect(legacy).toHaveBeenCalledOnce()
    expect(verified).toHaveBeenCalledTimes(2)
  })

  it('does not silently switch a connected legacy session when its later context read fails', async () => {
    const legacy = vi.fn(async () => context), verified = vi.fn(async () => context)
    const detect = createLiveNativeContextDetector(legacy, verified)
    await detect()
    legacy.mockRejectedValueOnce(new DomainError('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', 'synthetic'))
    await expect(detect()).rejects.toMatchObject({ code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE' })
    expect(verified).not.toHaveBeenCalled()
  })

  it('does not hide an explicit identity conflict or unknown failure by trying another account source', async () => {
    for (const error of [new DomainError('GAME_STATUS_IDENTITY_MISMATCH', 'synthetic'), new Error('synthetic')]) {
      const verified = vi.fn(async () => context)
      const detect = createLiveNativeContextDetector(async () => { throw error }, verified)
      await expect(detect()).rejects.toBe(error)
      expect(verified).not.toHaveBeenCalled()
    }
  })

  it('coalesces the initial proof instead of starting duplicate identity helpers', async () => {
    let done!: (value: NativeGameStatusContext) => void
    const verified = vi.fn(() => new Promise<NativeGameStatusContext>(resolve => { done = resolve }))
    const detect = createLiveNativeContextDetector(async () => ({ ...context, appId: 0 }), verified)
    const first = detect(), second = detect()
    expect(first).toBe(second)
    await Promise.resolve()
    done(context)
    expect(await first).toBe(context)
    expect(verified).toHaveBeenCalledOnce()
  })
})
