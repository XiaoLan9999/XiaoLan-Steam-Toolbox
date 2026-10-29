import { net, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type { SteamNetwork } from './steam-service'
import { createSteamNetworkFetch } from './steam-network-fetch'

export function createSteamNetworkSession(): SteamNetwork {
  const isolated = session.fromPartition(`steam-network-${randomUUID()}`, { cache: false })
  const lifetime = new AbortController()
  const request = createSteamNetworkFetch(options => net.request({ ...options, session: isolated }))
  let disposed = false
  return {
    transport: 'chromium',
    fetch: async (input, init) => {
      if (disposed) throw new DomainError('SESSION_CHANGED', 'Steam network session changed')
      const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return request(input, { ...init, signal: inherited ? AbortSignal.any([inherited, lifetime.signal]) : lifetime.signal })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      lifetime.abort(new DomainError('SESSION_CHANGED', 'Steam network session changed'))
      // This is a private in-memory partition, never the app or browser's default session.
      void Promise.allSettled([
        Promise.resolve().then(() => isolated.closeAllConnections()),
        Promise.resolve().then(() => isolated.clearStorageData()),
        Promise.resolve().then(() => isolated.clearCache())
      ])
    }
  }
}
