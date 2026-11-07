export const LOCAL_APP_DIAGNOSTIC_STAGES = [
  'start-requested', 'running', 'monitor-retry', 'monitor-recovered', 'monitor-stop',
  'worker-started', 'worker-ready', 'worker-terminal', 'worker-error', 'worker-exited',
  'request-timeout', 'noise-limit', 'stop-requested', 'invalidated', 'stopped', 'retire-timeout'
] as const

export const LOCAL_APP_DIAGNOSTIC_CODES = [
  'LOCAL_APP_CONTEXT_CHANGED', 'LOCAL_APP_CONTEXT_UNAVAILABLE', 'LOCAL_APP_GAME_ACTIVE',
  'LOCAL_APP_BUSY', 'LOCAL_APP_INVALID_INPUT', 'LOCAL_APP_METADATA_UNAVAILABLE',
  'LOCAL_APP_TEMPLATE_UNAVAILABLE', 'LOCAL_APP_WORKER_UNAVAILABLE', 'LOCAL_APP_PROFILE_UNSUPPORTED',
  'LOCAL_APP_NOT_LICENSED', 'LOCAL_APP_INIT_FAILED', 'LOCAL_APP_IDENTITY_MISMATCH',
  'LOCAL_APP_APP_MISMATCH', 'LOCAL_APP_DLL_INVALID', 'LOCAL_APP_PROTOCOL_INVALID',
  'LOCAL_APP_TIMEOUT', 'LOCAL_APP_EXITED', 'LOCAL_APP_SET_REJECTED', 'LOCAL_APP_STOP_FAILED',
  'LOCAL_APP_LIVE_RESTORE_REQUIRED', 'LOCAL_APP_READ_FAILED', 'LOCAL_APP_INTERNAL_ERROR',
  'LOCAL_APP_ARGUMENTS_INVALID'
] as const

export const LOCAL_APP_DIAGNOSTIC_REASONS = [
  'user', 'account-change', 'renderer-loss', 'toolbox-exit', 'mode-change', 'monitor', 'worker', 'context-change',
  'web-login', 'native-state'
] as const
export const LOCAL_APP_DIAGNOSTIC_OPERATIONS = ['ready', 'ping', 'read', 'apply', 'catalog', 'stop'] as const
export const LOCAL_APP_DIAGNOSTIC_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGABRT', 'unknown'] as const

export type LocalAppDiagnosticStage = typeof LOCAL_APP_DIAGNOSTIC_STAGES[number]
export type LocalAppDiagnosticReason = typeof LOCAL_APP_DIAGNOSTIC_REASONS[number]

export interface LocalAppDiagnosticEvent {
  stage: LocalAppDiagnosticStage
  code?: string
  reason?: LocalAppDiagnosticReason
  generation?: number
  helperPid?: number
  exitCode?: number | null
  signal?: typeof LOCAL_APP_DIAGNOSTIC_SIGNALS[number] | null
  elapsedMs?: number
  count?: number
  noiseBytes?: number
  operation?: typeof LOCAL_APP_DIAGNOSTIC_OPERATIONS[number]
  ok?: boolean | null
}

function member<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value)
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

// Runtime writes and exports both project through this allowlist; never copy native output.
export function sanitizeLocalAppDiagnostic(input: unknown): LocalAppDiagnosticEvent | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const value = input as Record<string, unknown>
    const stage = value.stage
    if (!member(stage, LOCAL_APP_DIAGNOSTIC_STAGES)) return null
    const output: LocalAppDiagnosticEvent = { stage }
    const code = value.code, reason = value.reason, generation = value.generation, helperPid = value.helperPid
    const exitCode = value.exitCode, signal = value.signal, elapsedMs = value.elapsedMs
    const count = value.count, noiseBytes = value.noiseBytes, operation = value.operation, ok = value.ok
    if (member(code, LOCAL_APP_DIAGNOSTIC_CODES)) output.code = code
    if (member(reason, LOCAL_APP_DIAGNOSTIC_REASONS)) output.reason = reason
    if (integer(generation, 0, Number.MAX_SAFE_INTEGER)) output.generation = generation
    if (integer(helperPid, 1, 0xffffffff)) output.helperPid = helperPid
    if (exitCode === null || integer(exitCode, -0x80000000, 0xffffffff)) output.exitCode = exitCode
    if (signal === null || member(signal, LOCAL_APP_DIAGNOSTIC_SIGNALS)) output.signal = signal
    if (integer(elapsedMs, 0, 604_800_000)) output.elapsedMs = elapsedMs
    if (integer(count, 0, 4096)) output.count = count
    if (integer(noiseBytes, 0, 1024 * 1024 * 1024)) output.noiseBytes = noiseBytes
    if (member(operation, LOCAL_APP_DIAGNOSTIC_OPERATIONS)) output.operation = operation
    if (typeof ok === 'boolean' || ok === null) output.ok = ok
    return output
  } catch {
    return null
  }
}
