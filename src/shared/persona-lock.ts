export type PersonaLockError = 'PERSONA_UNAVAILABLE' | 'PERSONA_CONTEXT_CHANGED' | 'PERSONA_PRIVATE_STATE' | 'PERSONA_UNCONFIRMED' | 'PERSONA_BUSY'
export const PERSONA_NATIVE_FAILURE_CODES = ['PERSONA_ARGUMENTS_INVALID', 'PERSONA_CONNECT_FAILED', 'PERSONA_CONTEXT_CHANGED',
  'PERSONA_CONTEXT_UNAVAILABLE', 'PERSONA_DLL_UNSUPPORTED', 'PERSONA_EXPORT_UNSUPPORTED', 'PERSONA_FRAME_TOO_LARGE',
  'PERSONA_IDENTITY_MISMATCH', 'PERSONA_INTERFACE_UNSUPPORTED', 'PERSONA_INTERNAL_ERROR', 'PERSONA_LOAD_FAILED',
  'PERSONA_METHOD_UNSUPPORTED', 'PERSONA_NOT_LOGGED_ON', 'PERSONA_PIPE_FAILED', 'PERSONA_PROTOCOL_INVALID',
  'PERSONA_RESTORE_REJECTED', 'PERSONA_SET_REJECTED', 'PERSONA_STATE_INVALID', 'PERSONA_UNSAFE_PATH'] as const
export type PersonaNativeFailureCode = typeof PERSONA_NATIVE_FAILURE_CODES[number]
export function personaNativeFailureCode(error: unknown): PersonaNativeFailureCode | null {
  const value = error && typeof error === 'object' && 'nativeCode' in error ? error.nativeCode : undefined
  return typeof value === 'string' && (PERSONA_NATIVE_FAILURE_CODES as readonly string[]).includes(value) ? value as PersonaNativeFailureCode : null
}

export interface PersonaLockAction { accountId: string; sessionId: string }
export interface PersonaLockStart extends PersonaLockAction { mode: 'snooze' }
export interface PersonaLockSnapshot {
  available: boolean
  sessionId: string
  accountId: string | null
  steamId: string | null
  status: 'idle' | 'checking' | 'locked' | 'error'
  currentState: number | null
  originalState: number | null
  lastCheckedAt: string | null
  restored: boolean | null
  error: PersonaLockError | null
  nativeCode?: PersonaNativeFailureCode | null
  busy: boolean
}

export interface PersonaLockApi {
  state(): Promise<PersonaLockSnapshot>
  start(input: PersonaLockStart): Promise<PersonaLockSnapshot>
  stop(input: PersonaLockAction): Promise<PersonaLockSnapshot>
  onChange(listener: (snapshot: PersonaLockSnapshot) => void): () => void
}
