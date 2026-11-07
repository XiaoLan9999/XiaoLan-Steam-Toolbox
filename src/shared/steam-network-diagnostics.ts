import { LOGIN_NETWORK_CODES, type LoginNetworkCode } from './diagnostics'

export interface SteamNetworkDiagnostic {
  stage: 'route-request' | 'route-success' | 'route-failed' | 'route-skipped'
  route: 'system' | 'fresh-system' | 'direct' | 'node-direct'
  endpoint: 'api' | 'finalize' | 'community-transfer' | 'community-read' | 'other'
  attempt: number
  elapsedMs?: number
  networkCode?: LoginNetworkCode
  proxyMode?: 'direct' | 'proxy' | 'unknown'
}

export function sanitizeSteamNetworkDiagnostic(value: unknown): SteamNetworkDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const v = value as Record<string, unknown>
    if (!['route-request', 'route-success', 'route-failed', 'route-skipped'].includes(v.stage as string) ||
        !['system', 'fresh-system', 'direct', 'node-direct'].includes(v.route as string) ||
        !['api', 'finalize', 'community-transfer', 'community-read', 'other'].includes(v.endpoint as string) ||
        !Number.isSafeInteger(v.attempt) || (v.attempt as number) < 1 || (v.attempt as number) > 4) return null
    return { stage: v.stage, route: v.route, endpoint: v.endpoint, attempt: v.attempt,
      ...(Number.isSafeInteger(v.elapsedMs) && (v.elapsedMs as number) >= 0 && (v.elapsedMs as number) <= 60000 ? { elapsedMs: v.elapsedMs } : {}),
      ...(LOGIN_NETWORK_CODES.includes(v.networkCode as LoginNetworkCode) ? { networkCode: v.networkCode } : {}),
      ...(['direct', 'proxy', 'unknown'].includes(v.proxyMode as string) ? { proxyMode: v.proxyMode } : {}) } as SteamNetworkDiagnostic
  } catch { return null }
}
