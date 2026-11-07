import { net, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type { SteamNetwork } from './steam-service'
import { createSteamNetworkFetch } from './steam-network-fetch'
import { abortableSteamNetwork, createSteamNetworkRecovery, type SteamNetworkRouteKind } from './steam-network-recovery'
import type { SteamNetworkDiagnostic } from '../shared/steam-network-diagnostics'
import { createNodeSteamNetwork, isNodeSteamNetworkAllowed } from './steam-node-network'

export function createSteamNetworkSession(onDiagnostic?: (event: SteamNetworkDiagnostic) => void): SteamNetwork {
  const recovery = createSteamNetworkRecovery({
    onDiagnostic,
    nodeDirectAllowed: isNodeSteamNetworkAllowed,
    createRoute(kind: SteamNetworkRouteKind) {
      if (kind === 'node-direct') return { ...createNodeSteamNetwork(), resolveProxy: async () => 'DIRECT' }
      const isolated = session.fromPartition(`steam-network-${randomUUID()}`, { cache: false })
      const lifetime = new AbortController()
      const request = createSteamNetworkFetch(options => net.request({ ...options, session: isolated }))
      const ready = Promise.resolve().then(() => isolated.setProxy({ mode: kind === 'direct' ? 'direct' : 'system' }))
      void ready.catch(() => undefined)
      let disposed = false
      return {
        ready: (signal: AbortSignal) => abortableSteamNetwork(ready, signal),
        resolveProxy: async (url: string, signal: AbortSignal) => {
          await abortableSteamNetwork(ready, signal)
          if (disposed) throw new DomainError('SESSION_CHANGED', 'Steam network session changed')
          return abortableSteamNetwork(isolated.resolveProxy(url), signal)
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          if (disposed) throw new DomainError('SESSION_CHANGED', 'Steam network session changed')
          const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          const signal = inherited ? AbortSignal.any([inherited, lifetime.signal]) : lifetime.signal
          await abortableSteamNetwork(ready, signal)
          if (disposed || signal.aborted) throw new DomainError('SESSION_CHANGED', 'Steam network session changed')
          return request(input, { ...init, signal })
        },
        dispose(): void {
          if (disposed) return
          disposed = true
          lifetime.abort(new DomainError('SESSION_CHANGED', 'Steam network session changed'))
          // This partition never shares browser/default-session cookies or proxy configuration.
          void Promise.allSettled([
            Promise.resolve().then(() => isolated.closeAllConnections()),
            Promise.resolve().then(() => isolated.clearStorageData()),
            Promise.resolve().then(() => isolated.clearCache())
          ])
        }
      }
    }
  })
  return {
    transport: 'adaptive',
    fetch: recovery.fetch,
    dispose: recovery.dispose
  }
}
