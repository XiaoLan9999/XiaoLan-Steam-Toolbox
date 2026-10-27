import type { GameStatusAppInfo, GameStatusPresence } from './game-status'

export type LocalAppSimulationStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'
export type LocalAppSimulationErrorCode = 'LOCAL_APP_CONTEXT_CHANGED' | 'LOCAL_APP_CONTEXT_UNAVAILABLE' | 'LOCAL_APP_GAME_ACTIVE' | 'LOCAL_APP_BUSY' | 'LOCAL_APP_INVALID_INPUT' | 'LOCAL_APP_METADATA_UNAVAILABLE' | 'LOCAL_APP_TEMPLATE_UNAVAILABLE' | 'LOCAL_APP_WORKER_UNAVAILABLE' | 'LOCAL_APP_PROFILE_UNSUPPORTED' | 'LOCAL_APP_NOT_LICENSED' | 'LOCAL_APP_INIT_FAILED' | 'LOCAL_APP_IDENTITY_MISMATCH' | 'LOCAL_APP_APP_MISMATCH' | 'LOCAL_APP_DLL_INVALID' | 'LOCAL_APP_PROTOCOL_INVALID' | 'LOCAL_APP_TIMEOUT' | 'LOCAL_APP_EXITED' | 'LOCAL_APP_SET_REJECTED' | 'LOCAL_APP_STOP_FAILED' | 'LOCAL_APP_LIVE_RESTORE_REQUIRED'
export interface LocalAppSimulationAction { accountId: string; sessionId: string }
export interface LocalAppSimulationInspectInput extends LocalAppSimulationAction { appId: number; language?: 'schinese' | 'english' }
export interface LocalAppSimulationStartInput extends LocalAppSimulationAction { appId: number; presence?: GameStatusPresence; unverifiedPresence?: Record<string, string>; groupSize?: number | null }
export interface LocalAppSimulationError { code: LocalAppSimulationErrorCode; message: string }
export interface LocalAppSimulationSnapshot {
  sessionId: string
  accountId: string | null
  steamId: string | null
  status: LocalAppSimulationStatus
  busy: boolean
  appId: number | null
  appInfo: GameStatusAppInfo | null
  fields: Record<string, string>
  localizedString: string | null
  verificationSource: 'local-cache' | null
  submissionMode?: 'published-template' | 'experimental'
  error: LocalAppSimulationError | null
}
export interface LocalAppSimulationApi {
  state(): Promise<LocalAppSimulationSnapshot>
  inspect(input: LocalAppSimulationInspectInput): Promise<GameStatusAppInfo>
  start(input: LocalAppSimulationStartInput): Promise<LocalAppSimulationSnapshot>
  stop(input: LocalAppSimulationAction): Promise<LocalAppSimulationSnapshot>
  onChange(listener: (snapshot: LocalAppSimulationSnapshot) => void): () => void
}
