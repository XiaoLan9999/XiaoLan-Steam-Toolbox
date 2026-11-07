import { DomainError } from '../shared/domain'
import { sanitizeSteamNetworkDiagnostic, type SteamNetworkDiagnostic } from '../shared/steam-network-diagnostics'
import { loginDiagnosticFailure } from './login-diagnostic'
import { STEAM_NETWORK_REQUEST_LIMIT, STEAM_NETWORK_RESPONSE_LIMIT } from './steam-network-fetch'

export type SteamNetworkRouteKind = SteamNetworkDiagnostic['route']
export interface SteamNetworkRecoveryRoute {
  fetch: typeof fetch
  ready?(signal: AbortSignal): Promise<void>
  resolveProxy(url: string, signal: AbortSignal): Promise<string>
  dispose(): void | Promise<void>
}
export interface SteamNetworkRecoveryOptions {
  createRoute(kind: SteamNetworkRouteKind): SteamNetworkRecoveryRoute
  onDiagnostic?(event: SteamNetworkDiagnostic): void
  budgetMs?: number
  attemptTimeoutMs?: number
  stopTimeoutMs?: number
  nodeDirectAllowed?(): boolean
  now?: () => number
}

export const STEAM_RECOVERY_BUDGET_MS = 48_000
export const STEAM_RECOVERY_ATTEMPT_MS = 12_000
const HOSTS = new Set(['api.steampowered.com', 'login.steampowered.com', 'steamcommunity.com'])
const KINDS: readonly SteamNetworkRouteKind[] = ['system', 'fresh-system', 'direct', 'node-direct']
const TRANSIENT = new Set(['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'ERR_CONNECTION_CLOSED', 'ERR_SOCKET_CLOSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
const cancelled = (): DomainError => new DomainError('SESSION_CHANGED', 'Steam network session changed')
const timeout = (): Error => Object.assign(new Error('Steam network request timed out'), { code: 'ETIMEDOUT' })
const invalid = (): DomainError => new DomainError('SESSION_CHECK_FAILED', 'Invalid Steam network request or response')
const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
  Number.isInteger(value) && value! > 0 && value! <= maximum ? value! : fallback

export interface SteamNetworkResponseTiming { receivedAt: number; receivedMonotonic: number }
const responseTimings = new WeakMap<Response, SteamNetworkResponseTiming>()

export function getSteamNetworkResponseTiming(response: Response): SteamNetworkResponseTiming | undefined {
  const value = responseTimings.get(response)
  return value ? { ...value } : undefined
}

function captureHeaderTiming(): SteamNetworkResponseTiming | undefined {
  try {
    const receivedAt = Date.now(), receivedMonotonic = performance.now()
    return Number.isSafeInteger(receivedAt) && Number.isFinite(receivedMonotonic) && receivedMonotonic >= 0
      ? { receivedAt, receivedMonotonic } : undefined
  } catch { return undefined }
}

export function abortableSteamNetwork<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? cancelled())
    if (signal.aborted) {
      void operation.catch(() => undefined)
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}

function mayReplay(url: URL, method: string, init?: RequestInit, original?: Request | null): boolean {
  if (method === 'GET') return !init?.body && !original?.body
  if (method !== 'POST' || original?.body && init?.body === undefined) return false
  const path = url.pathname.replace(/\/$/, '')
  if (url.hostname === 'api.steampowered.com') return path === '/IAuthenticationService/PollAuthSessionStatus/v1'
  if (url.hostname === 'login.steampowered.com') return path === '/jwt/finalizelogin'
  return url.hostname === 'steamcommunity.com' && ['/login/settoken', '/login/transfer'].includes(path)
}

function endpoint(url: URL, method: string): SteamNetworkDiagnostic['endpoint'] {
  if (url.hostname === 'api.steampowered.com') return 'api'
  if (url.hostname === 'login.steampowered.com' && url.pathname.replace(/\/$/, '') === '/jwt/finalizelogin') return 'finalize'
  if (url.hostname === 'steamcommunity.com') {
    if (['/login/settoken', '/login/transfer'].includes(url.pathname.replace(/\/$/, ''))) return 'community-transfer'
    if (method === 'GET') return 'community-read'
  }
  return 'other'
}

async function frozenInit(input: string | URL | Request, init: RequestInit | undefined,
  signal: AbortSignal): Promise<RequestInit> {
  const request = new Request(input, { ...init, signal })
  if (!request.body) return { ...init, method: request.method, headers: request.headers, body: undefined }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0, complete = false
  try {
    for (;;) {
      const chunk = await abortableSteamNetwork(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      length += chunk.value.byteLength
      if (length > STEAM_NETWORK_REQUEST_LIMIT) throw invalid()
      chunks.push(chunk.value)
    }
    return { ...init, method: request.method, headers: request.headers, body: Uint8Array.from(Buffer.concat(chunks, length)) }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface Attempt {
  controller: AbortController
  native?: Promise<Response>
  work?: Promise<Response>
  response?: Response
  headerTiming?: SteamNetworkResponseTiming
  reader?: ReadableStreamDefaultReader<Uint8Array>
}

async function completeResponse(response: Response, state: Attempt, signal: AbortSignal): Promise<Response> {
  if (!response.body) return response
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > STEAM_NETWORK_RESPONSE_LIMIT)) throw invalid()
  const reader = response.body.getReader()
  state.reader = reader
  const chunks: Uint8Array[] = []
  let bytes = 0, complete = false
  try {
    for (;;) {
      const chunk = await abortableSteamNetwork(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      bytes += chunk.value.byteLength
      if (bytes > STEAM_NETWORK_RESPONSE_LIMIT) throw invalid()
      chunks.push(chunk.value)
    }
    const copy = new Response(Uint8Array.from(Buffer.concat(chunks, bytes)), {
      status: response.status, statusText: response.statusText, headers: response.headers
    })
    Object.defineProperty(copy, 'url', { value: response.url })
    if (state.headerTiming) responseTimings.set(copy, state.headerTiming)
    return copy
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    state.reader = undefined
  }
}

async function stopAttempt(state: Attempt, error: unknown, timeoutMs: number): Promise<boolean> {
  state.controller.abort(error)
  const stops: Promise<unknown>[] = []
  if (state.reader) stops.push(state.reader.cancel().catch(() => undefined))
  if (state.native) stops.push(state.native.then(async response => {
    if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel().catch(() => undefined)
  }, () => undefined))
  if (state.work) stops.push(state.work.catch(() => undefined))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(stops).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.() })
    ])
  } finally { clearTimeout(timer) }
}

export function createSteamNetworkRecovery(options: SteamNetworkRecoveryOptions): { fetch: typeof fetch; dispose(): void } {
  const lifetime = new AbortController()
  const routes = new Map<number, SteamNetworkRecoveryRoute>([[0, options.createRoute('system')]])
  const preferred = new Map<string, number>()
  let disposed = false
  const getRoute = (index: number): SteamNetworkRecoveryRoute => {
    if (disposed) throw cancelled()
    let route = routes.get(index)
    if (!route) { route = options.createRoute(KINDS[index]!); routes.set(index, route) }
    return route
  }
  const observe = (event: SteamNetworkDiagnostic): void => {
    try {
      const safe = sanitizeSteamNetworkDiagnostic(event)
      if (safe) options.onDiagnostic?.(safe)
    } catch { /* Route observation must never control authentication or delivery. */ }
  }
  const request: typeof fetch = async (input, init) => {
    if (disposed) throw cancelled()
    const original = input instanceof Request ? input : null
    let url: URL
    try { url = new URL(original?.url ?? String(input)) } catch { throw invalid() }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw invalid()
    const method = (init?.method ?? original?.method ?? 'GET').toUpperCase()
    const redirect = init?.redirect ?? original?.redirect ?? 'error'
    if (!['GET', 'POST'].includes(method) || !['manual', 'error'].includes(redirect)) throw invalid()
    if (original?.body && init?.body === undefined) throw invalid()
    let headers: Headers
    try { headers = new Headers(init?.headers ?? original?.headers) } catch { throw invalid() }
    if (init?.body instanceof FormData) headers.delete('content-type')
    const base: RequestInit = { ...init, method, redirect, headers }
    const caller = init?.signal ?? original?.signal
    if (caller?.aborted) throw caller.reason ?? cancelled()
    const replay = mayReplay(url, method, init, original)
    const budget = new AbortController()
    const operationSignal = AbortSignal.any([lifetime.signal, budget.signal, ...(caller ? [caller] : [])])
    const totalTimer = setTimeout(() => budget.abort(timeout()), replay
      ? bounded(options.budgetMs, STEAM_RECOVERY_BUDGET_MS, STEAM_RECOVERY_BUDGET_MS) : 55_000)
    totalTimer.unref?.()
    const stopTimeoutMs = bounded(options.stopTimeoutMs, 1000, 2000)
    const label = endpoint(url, method)
    const now = options.now ?? Date.now
    let sent = 0, lastError: unknown
    const direct = async (): Promise<'direct' | 'proxy' | 'unknown'> => {
      try {
        const result = await abortableSteamNetwork(getRoute(0).resolveProxy(url.href, operationSignal), operationSignal)
        return result.trim() === 'DIRECT' ? 'direct' : 'proxy'
      } catch (error) {
        if (operationSignal.aborted) throw operationSignal.reason ?? error
        return 'unknown'
      }
    }
    try {
      const prepared = replay ? await frozenInit(url.href, base, operationSignal) : base
      let index = preferred.get(url.hostname) ?? 0
      if (index >= 2 && (await direct() !== 'direct' || index === 3 && !options.nodeDirectAllowed?.())) {
        index = 1
        preferred.set(url.hostname, 1)
      }
      for (; index < KINDS.length; index += 1) {
        operationSignal.throwIfAborted()
        const kind = KINDS[index]!
        if (index >= 2) {
          const proxyMode = await direct()
          if (proxyMode !== 'direct' || index === 3 && !options.nodeDirectAllowed?.()) {
            observe({ stage: 'route-skipped', route: kind, endpoint: label, attempt: Math.min(4, sent + 1),
              proxyMode: proxyMode === 'direct' ? 'proxy' : proxyMode })
            throw lastError ?? cancelled()
          }
        }
        const route = getRoute(index)
        const state: Attempt = { controller: new AbortController() }
        const signal = AbortSignal.any([state.controller.signal, operationSignal])
        const startedAt = now()
        const attempt = ++sent
        const record = (stage: SteamNetworkDiagnostic['stage'], error?: unknown): void => {
          const failure = error === undefined ? {} : loginDiagnosticFailure(error)
          observe({ stage, route: kind, endpoint: label, attempt,
            elapsedMs: Math.min(60_000, Math.max(0, Math.floor(now() - startedAt))),
            ...(failure.networkCode ? { networkCode: failure.networkCode } : {}),
            ...(index >= 2 ? { proxyMode: 'direct' } : {}) })
        }
        record('route-request')
        const timer = replay ? setTimeout(() => state.controller.abort(timeout()),
          bounded(options.attemptTimeoutMs, STEAM_RECOVERY_ATTEMPT_MS, STEAM_RECOVERY_ATTEMPT_MS)) : undefined
        timer?.unref?.()
        try {
          state.work = (async () => {
            await route.ready?.(signal)
            signal.throwIfAborted()
            if (index >= 2) {
              const proxyMode = await direct()
              if (proxyMode !== 'direct' || index === 3 && !options.nodeDirectAllowed?.()) {
                observe({ stage: 'route-skipped', route: kind, endpoint: label, attempt,
                  proxyMode: proxyMode === 'direct' ? 'proxy' : proxyMode })
                throw new DomainError('SESSION_CHANGED', 'Steam proxy configuration changed')
              }
            }
            const body = prepared.body instanceof Uint8Array ? prepared.body.slice() : prepared.body
            state.native = route.fetch(url.href, { ...prepared, headers: new Headers(prepared.headers), body, signal })
            void state.native.then(response => {
              state.response = response
              state.headerTiming = captureHeaderTiming()
              if (signal.aborted && response.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
            }, () => undefined).catch(() => undefined)
            const response = await abortableSteamNetwork(state.native, signal)
            // HTTP denial is authoritative, and an unsafe POST is never replayed after headers.
            return !replay || !response.ok ? response : completeResponse(response, state, signal)
          })()
          const response = await abortableSteamNetwork(state.work, signal)
          preferred.set(url.hostname, Math.max(preferred.get(url.hostname) ?? 0, index))
          record('route-success')
          return response
        } catch (error) {
          const failure = signal.aborted ? signal.reason ?? error : error
          lastError = failure
          record('route-failed', failure)
          const stopped = await stopAttempt(state, failure, stopTimeoutMs)
          if (operationSignal.aborted) throw operationSignal.reason ?? failure
          const detail = loginDiagnosticFailure(failure)
          if (!replay || !stopped || detail.httpStatus !== undefined || detail.eresult !== undefined ||
              !detail.networkCode || !TRANSIENT.has(detail.networkCode)) throw failure
        } finally { clearTimeout(timer) }
      }
      throw lastError ?? cancelled()
    } finally { clearTimeout(totalTimer) }
  }
  return {
    fetch: request,
    dispose(): void {
      if (disposed) return
      disposed = true
      lifetime.abort(cancelled())
      for (const route of routes.values()) {
        try { void Promise.resolve(route.dispose()).catch(() => undefined) } catch { /* Each owned route still gets disposed. */ }
      }
      routes.clear()
      preferred.clear()
    }
  }
}
