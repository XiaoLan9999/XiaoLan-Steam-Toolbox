export type GameStatusConnectionStatus = 'logged_out' | 'connecting' | 'guard_required' | 'logged_on' | 'error' | 'disconnected'

export interface GameStatusAction { accountId: string; sessionId: string }
export interface GameStatusConnectInput extends GameStatusAction { accountName: string; password: string }
export interface GameStatusGuardInput extends GameStatusAction { challengeId: string; code: string }
export interface GameStatusDraft { displayKind: 'custom' | 'app'; gameName: string; details: string; appId?: number }
export interface GameStatusPlayInput extends GameStatusAction, GameStatusDraft {}
export interface GameStatusSaveDraftInput extends GameStatusAction { draft: GameStatusDraft }
export interface GameStatusPatchInput extends GameStatusAction { snapshotId: string; changes: Record<string, string> }

export interface GameStatusGuard {
  challengeId: string
  type: 'email' | 'authenticator'
  emailDomain: string | null
  lastCodeWrong: boolean
  retryAfterSeconds: number
}

export interface GameStatusPlaying extends GameStatusDraft { displayName: string; delivery: 'submitted'; limitations: string[] }
export interface GameStatusLiveSnapshot {
  snapshotId: string
  appId: number
  gameEpoch: number
  observedAt: string
  fields: Record<string, string>
  editableKeys: string[]
  readOnlyKeys: string[]
  patchActive: boolean
}

export interface GameStatusOperation {
  kind: 'observe' | 'patch' | 'restore'
  outcome: 'observed' | 'matched' | 'unverified' | 'conflict'
  message: string
  at: string
  changedKeys?: string[]
}

export interface GameStatusSnapshot {
  sessionId: string
  accountId: string | null
  boundSteamId: string | null
  status: GameStatusConnectionStatus
  connected: boolean
  accountName: string | null
  steamId: string | null
  guard: GameStatusGuard | null
  blocked: boolean
  blockingAppId: number | null
  playing: GameStatusPlaying | null
  live: GameStatusLiveSnapshot | null
  lastOperation: GameStatusOperation | null
  busy: boolean
  limitations: string[]
  error: string | null
}

export interface GameStatusApi {
  state(): Promise<GameStatusSnapshot>
  connectWithToolbox(input: GameStatusAction): Promise<GameStatusSnapshot>
  play(input: GameStatusPlayInput): Promise<GameStatusSnapshot>
  stop(input: GameStatusAction): Promise<GameStatusSnapshot>
  logout(input: GameStatusAction): Promise<GameStatusSnapshot>
  observeLive(input: GameStatusAction): Promise<GameStatusSnapshot>
  patchLive(input: GameStatusPatchInput): Promise<GameStatusSnapshot>
  restoreLive(input: GameStatusAction): Promise<GameStatusSnapshot>
  loadDraft(input: GameStatusAction): Promise<GameStatusDraft | null>
  saveDraft(input: GameStatusSaveDraftInput): Promise<GameStatusDraft>
  onChange(listener: (snapshot: GameStatusSnapshot) => void): () => void
}
