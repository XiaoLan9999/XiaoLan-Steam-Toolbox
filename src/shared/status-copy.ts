export type StatusCopyMode = 'toolbox' | 'asf'
export type StatusCopyPhase = 'idle' | 'previewing' | 'starting' | 'following' | 'waiting' | 'stopping' | 'error'
export type StatusCopyCode = 'COPY_INVALID_INPUT' | 'COPY_SOURCE_EQUALS_TARGET' | 'COPY_TARGET_IS_LOCAL' | 'COPY_LOCAL_UNAVAILABLE' | 'COPY_LOGIN_REQUIRED' | 'COPY_IDENTITY_MISMATCH' | 'COPY_SOURCE_UNAVAILABLE' | 'COPY_SOURCE_NOT_FRIEND' | 'COPY_SOURCE_NOT_PLAYING' | 'COPY_SOURCE_STALE' | 'COPY_REQUEST_FAILED' | 'COPY_SESSION_CHANGED' | 'COPY_BUSY' | 'COPY_STOP_UNCONFIRMED' | 'COPY_PLAYING_BLOCKED' | 'COPY_ASF_INCOMPATIBLE' | 'COPY_ASF_BOT_UNAVAILABLE' | 'COPY_ASF_CONFIG_CONFLICT' | 'COPY_ASF_GROUP_UNSUPPORTED' | 'COPY_TEMPLATE_UNAVAILABLE' | 'COPY_LIVE_RESTORE_REQUIRED'

export interface StatusCopyAsfInput { url: string; botName: string; password?: string }
export interface StatusCopySettingsInput {
  mode: StatusCopyMode
  sourceSteamId: string
  intervalSeconds: number
  copyGroupSize: boolean
  persona: 'online' | 'away'
  asf?: StatusCopyAsfInput
}
export interface StatusCopySettings extends Omit<StatusCopySettingsInput, 'asf'> {
  asf?: { url: string; botName: string; hasPassword: boolean }
}
export interface StatusCopyAction { accountId: string; sessionId: string }
export interface StatusCopyInput extends StatusCopyAction { settings: StatusCopySettingsInput; allowAsfConfigReplace?: boolean }
export interface StatusCopySource {
  steamId: string
  appId: number
  gameName: string | null
  fields: Record<string, string>
  groupSize: number | null
  observedAt: string
  authority: 'local-source-session' | 'friend-presence' | 'asf-source-session'
}
export interface StatusCopyReport {
  source: StatusCopySource | null
  targetAppId: number | null
  appliedAt: string | null
  verification: 'not-verified' | 'target-readback'
  waiting: boolean
  warnings: StatusCopyCode[]
}
export interface StatusCopySnapshot extends StatusCopyReport {
  sessionId: string
  accountId: string | null
  targetSteamId: string | null
  phase: StatusCopyPhase
  busy: boolean
  settings: StatusCopySettings
  error: { code: StatusCopyCode } | null
}
export interface StatusCopyApi {
  state(): Promise<StatusCopySnapshot>
  save(input: StatusCopyInput): Promise<StatusCopySnapshot>
  preview(input: StatusCopyInput): Promise<StatusCopySnapshot>
  start(input: StatusCopyInput): Promise<StatusCopySnapshot>
  stop(input: StatusCopyAction): Promise<StatusCopySnapshot>
  onChange(listener: (snapshot: StatusCopySnapshot) => void): () => void
}

export const STATUS_COPY_DEFAULTS: StatusCopySettings = {
  mode: 'toolbox', sourceSteamId: '', intervalSeconds: 15, copyGroupSize: false, persona: 'away'
}
