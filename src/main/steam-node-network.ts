import { Agent, request } from 'node:https'
import { DomainError } from '../shared/domain'
import { createSteamNetworkFetch, type SteamRequestFactory } from './steam-network-fetch'

export function isNodeSteamNetworkAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !Object.entries(environment).some(([key, value]) =>
    /^(?:https?|all)_proxy$/i.test(key) && typeof value === 'string' && value.trim().length > 0)
}

// Direct Node HTTPS is a last resort only after the caller has confirmed the system route is DIRECT.
export function createNodeSteamNetwork(): { fetch: typeof fetch; dispose(): void } {
  const agent = new Agent({ keepAlive: false, maxSockets: 4, maxTotalSockets: 4, timeout: 12_000 })
  const lifetime = new AbortController()
  let disposed = false
  const fetchImpl = createSteamNetworkFetch(options => request(String(options.url), {
    method: options.method,
    headers: options.headers as Record<string, string>,
    agent,
    rejectUnauthorized: true
  }) as unknown as ReturnType<SteamRequestFactory>)
  return {
    fetch: (input, init) => {
      if (disposed) return Promise.reject(new DomainError('SESSION_CHANGED', 'Steam network session changed'))
      if (!isNodeSteamNetworkAllowed()) return Promise.reject(new DomainError('SESSION_CHECK_FAILED', 'Direct Steam fallback is unavailable with a configured proxy'))
      const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return fetchImpl(input, { ...init, signal: inherited ? AbortSignal.any([inherited, lifetime.signal]) : lifetime.signal })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      lifetime.abort(new DomainError('SESSION_CHANGED', 'Steam network session changed'))
      agent.destroy()
    }
  }
}
