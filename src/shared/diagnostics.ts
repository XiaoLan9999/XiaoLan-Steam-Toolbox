export const LOGIN_NETWORK_CODES = [
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EPIPE', 'EPROTO',
  'ERR_SOCKET_CLOSED', 'ERR_CONNECTION_CLOSED', 'ERR_HTTP_HEADERS_TIMEOUT',
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER'
] as const

export type LoginNetworkCode = typeof LOGIN_NETWORK_CODES[number]

export interface LoginDiagnosticEvent {
  attempt: number
  mode: 'qr' | 'credentials' | 'restore'
  stage: 'requested' | 'qr-ready' | 'remote-interaction' | 'authenticated' | 'web-cookies' |
    'session-verify' | 'profile' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'request' | 'guard-submit'
  outcome: 'started' | 'success' | 'failed' | 'cancelled' | 'response'
  endpoint?: 'qr-begin' | 'credentials-begin' | 'poll' | 'guard' | 'rsa' | 'access-token' |
    'finalize' | 'transfer' | 'community-transfer' | 'store-transfer' | 'help-transfer' | 'checkout-transfer' | 'other'
  reason?: 'network' | 'tls' | 'dns' | 'timeout' | 'rate-limited' | 'access-denied' |
    'credentials-rejected' | 'invalid-response' | 'cancelled' | 'unknown'
  networkCode?: LoginNetworkCode
  httpStatus?: number
  eresult?: number
  elapsedMs?: number
  transport?: 'node' | 'chromium'
}

export interface DiagnosticRecord {
  event: 'start' | 'memory' | 'stop' | 'process-gone' | 'session' | 'native-presence' | 'game-status' | 'login'
  at?: string
  version?: string
  [key: string]: unknown
}

const processTypes = ['Browser', 'Tab', 'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Unknown']
const exitReasons = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed',
  'integrity-failure', 'memory-eviction', 'unknown']
const taskStatuses = ['queued', 'running', 'paused', 'completed', 'cancelled', 'unknown']
const sessionPhases = ['restore', 'refresh', 'recover', 'community-request', 'session-probe',
  'comment-reconcile', 'comment-preflight', 'unknown']
const sessionOutcomes = ['success', 'transient', 'expired', 'auth-rejected', 'access-denied', 'rate-limited',
  'unverified', 'request-failed', 'stale-response', 'unknown']
const sessionReasons = ['http-401', 'login-redirect', 'not-logged-on', 'http-403', 'http-429',
  'identity-match', 'identity-mismatch', 'identity-guest', 'identity-missing', 'transport-error', 'network',
  'timeout', 'token-rejected', 'token-missing', 'session-changed', 'scheduled', 'on-demand', 'cookie-expired',
  'unknown', 'verified', 'credentials_rejected', 'network_or_service', 'rate_limited',
  'community_access_denied', 'session_check_failed', 'session_changed', 'comment-reconciled',
  'baseline-missing', 'baseline-incomplete', 'baseline-unreadable', 'target-unavailable']
const nativeStages = ['worker-started', 'stop-requested', 'forced-kill', 'worker-closed', 'retire-timeout',
  'release-user-start', 'release-user-returned', 'release-pipe-start', 'release-pipe-returned',
  'free-api-library', 'free-client-library', 'cleanup-complete', 'unknown']
const gameStatusStages = ['connect-requested', 'connect-reused', 'connect-deferred', 'cm-logon-started',
  'cm-logged-on', 'cm-retiring', 'cm-retired', 'cm-retire-timeout', 'cm-retire-failed', 'simulation-submit',
  'simulation-noop', 'simulation-stop', 'playing-state-confirmed', 'simulation-context-checking',
  'simulation-context-confirmed', 'simulation-context-blocked', 'simulation-context-unavailable', 'unknown']
const loginModes = ['qr', 'credentials', 'restore']
const loginStages = ['requested', 'qr-ready', 'remote-interaction', 'authenticated', 'web-cookies',
  'session-verify', 'profile', 'completed', 'failed', 'cancelled', 'timeout', 'request', 'guard-submit']
const loginOutcomes = ['started', 'success', 'failed', 'cancelled', 'response']
const loginEndpoints = ['qr-begin', 'credentials-begin', 'poll', 'guard', 'rsa', 'access-token',
  'finalize', 'transfer', 'community-transfer', 'store-transfer', 'help-transfer', 'checkout-transfer', 'other']
const loginReasons = ['network', 'tls', 'dns', 'timeout', 'rate-limited', 'access-denied',
  'credentials-rejected', 'invalid-response', 'cancelled', 'unknown']

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const member = (value: unknown, values: readonly string[]): value is string =>
  typeof value === 'string' && values.includes(value)
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const nullableNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
  integer(value, 0, max) ? value : null

export function sanitizeDiagnosticVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|dev|nightly)(?:[.-]\d{1,6})?)?$/.test(value)
    ? value : undefined
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return
  const time = new Date(value)
  return Number.isFinite(time.getTime()) && time.toISOString() === value ? value : undefined
}

function optionalEnum(output: DiagnosticRecord, input: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (member(input[key], values)) output[key] = input[key]
}

function optionalInteger(output: DiagnosticRecord, input: Record<string, unknown>, key: string, min: number, max: number): void {
  if (integer(input[key], min, max)) output[key] = input[key]
}

// This is also applied at export time: historical files are never trusted as already sanitized.
export function sanitizeDiagnosticRecord(input: unknown): DiagnosticRecord | null {
  try {
    const value = object(input)
    if (!value) return null
    const event = value.event
    if (!member(event, ['start', 'memory', 'stop', 'process-gone', 'session', 'native-presence', 'game-status', 'login'])) return null
    const output: DiagnosticRecord = { event: event as DiagnosticRecord['event'] }
    const at = timestamp(value.at)
    const version = sanitizeDiagnosticVersion(value.version)
    if (at) output.at = at
    if (version) output.version = version

    switch (event) {
      case 'start':
      case 'memory':
      case 'stop': {
        const main = object(value.main)
        output.main = Object.fromEntries(['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBufferBytes']
          .map(key => [key, nullableNumber(main?.[key], 2 ** 50)]))
        output.processes = Array.isArray(value.processes) ? value.processes.slice(0, 32).flatMap(item => {
          const metric = object(item)
          return metric ? [{ pid: nullableNumber(metric.pid, 0xffffffff),
            type: member(metric.type, processTypes) ? metric.type : 'Unknown',
            workingSetKiB: nullableNumber(metric.workingSetKiB, 2 ** 40),
            peakWorkingSetKiB: nullableNumber(metric.peakWorkingSetKiB, 2 ** 40),
            privateKiB: nullableNumber(metric.privateKiB, 2 ** 40) }] : []
        }) : []
        const task = object(value.task)
        output.task = task ? { status: member(task.status, taskStatuses) ? task.status : 'unknown',
          ...Object.fromEntries(['total', 'completed', 'pending', 'sending', 'uncertain']
            .map(key => [key, nullableNumber(task[key], 1_000_000_000)])) } : null
        break
      }
      case 'process-gone':
        output.kind = value.kind === 'renderer' || value.kind === 'child' ? value.kind : 'unknown'
        output.reason = member(value.reason, exitReasons) ? value.reason : 'unknown'
        output.exitCode = integer(value.exitCode, -0x80000000, 0x7fffffff) ? value.exitCode : null
        break
      case 'session':
        output.phase = member(value.phase, sessionPhases) ? value.phase : 'unknown'
        output.outcome = member(value.outcome, sessionOutcomes) ? value.outcome : 'unknown'
        output.reason = member(value.reason, sessionReasons) ? value.reason : 'unknown'
        optionalInteger(output, value, 'httpStatus', 100, 599)
        optionalEnum(output, value, 'method', ['GET', 'POST'])
        optionalEnum(output, value, 'endpoint', ['profile-comment', 'session-verify', 'other'])
        optionalEnum(output, value, 'responseKind', ['json', 'html', 'empty', 'other'])
        optionalEnum(output, value, 'denialKind', ['access-denied', 'challenge', 'unknown'])
        optionalEnum(output, value, 'commentDenialReason', ['unknown', 'csrf-sessionid', 'posting-too-frequently',
          'target-comments-disabled', 'friends-only', 'target-blocked', 'account-restricted', 'challenge'])
        optionalInteger(output, value, 'responseCode', 0, 255)
        if (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 86_400_000) output.retryAfterMs = value.retryAfterMs
        if (typeof value.errorPresent === 'boolean') output.errorPresent = value.errorPresent
        break
      case 'native-presence':
        output.stage = member(value.stage, nativeStages) ? value.stage : 'unknown'
        if (typeof value.ok === 'boolean' || value.ok === null) output.ok = value.ok
        optionalInteger(output, value, 'elapsedMs', 0, 3_600_000)
        optionalInteger(output, value, 'helperPid', 1, 0xffffffff)
        if (value.exitCode === null || integer(value.exitCode, -0x80000000, 0x7fffffff)) output.exitCode = value.exitCode
        if (typeof value.forced === 'boolean') output.forced = value.forced
        optionalInteger(output, value, 'retiringCount', 0, 128)
        break
      case 'game-status':
        output.stage = member(value.stage, gameStatusStages) ? value.stage : 'unknown'
        optionalEnum(output, value, 'connectionKind', ['local', 'cm'])
        optionalInteger(output, value, 'generation', 0, 0xffffffff)
        break
      case 'login':
        if (!integer(value.attempt, 1, 0xffffffff) || !member(value.mode, loginModes) ||
            !member(value.stage, loginStages) || !member(value.outcome, loginOutcomes)) return null
        output.attempt = value.attempt
        output.mode = value.mode
        output.stage = value.stage
        output.outcome = value.outcome
        optionalEnum(output, value, 'endpoint', loginEndpoints)
        optionalEnum(output, value, 'reason', loginReasons)
        optionalEnum(output, value, 'networkCode', LOGIN_NETWORK_CODES)
        optionalEnum(output, value, 'transport', ['node', 'chromium'])
        optionalInteger(output, value, 'httpStatus', 100, 599)
        optionalInteger(output, value, 'eresult', 0, 255)
        optionalInteger(output, value, 'elapsedMs', 0, 600_000)
        break
    }
    return output
  } catch {
    return null
  }
}
