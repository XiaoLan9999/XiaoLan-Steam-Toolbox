import { DomainError } from '../shared/domain'
import type { NativeGameStatusContext } from './native-game-status-client'

export function createLiveNativeContextDetector(legacy: () => Promise<NativeGameStatusContext>,
  verified: () => Promise<NativeGameStatusContext>): () => Promise<NativeGameStatusContext> {
  let source: 'legacy' | 'verified' | undefined
  let flight: Promise<NativeGameStatusContext> | undefined
  return () => {
    if (flight) return flight
    const resolve = async (): Promise<NativeGameStatusContext> => {
      if (source === 'legacy') return legacy()
      if (source === 'verified') return verified()
      try {
        const context = await legacy()
        if (context.appId !== 0) { source = 'legacy'; return context }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE') throw error
      }
      source = 'verified'
      return verified()
    }
    flight = resolve().finally(() => { flight = undefined })
    return flight
  }
}
