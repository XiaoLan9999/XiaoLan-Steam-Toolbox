import type { GameStatusFailure } from './game-status-errors'

export type GameStatusConnectionStatus = 'logged_out' | 'connecting' | 'guard_required' | 'logged_on' | 'error' | 'disconnected'

export interface GameStatusPresenceReadDiagnostic {
  at: string
  appId: number
  usersCount: number
  selfPresent: boolean
  presenceKind: 'missing' | 'object' | 'array' | 'other'
  valueCount: number
  nonStringValues: number
}

export interface GameStatusPresenceWireDiagnostic {
  at: string
  rows: number
  selfPresent: boolean
  legacyBytes: number
  newKvPairs: number
}

export interface GameStatusAction { accountId: string; sessionId: string }
export interface GameStatusConnectInput extends GameStatusAction { accountName: string; password: string }
export interface GameStatusGuardInput extends GameStatusAction { challengeId: string; code: string }
export interface GameStatusPresence { displayToken: string; values: Record<string, string> }
export interface GameStatusGame { appId: number; name: string; iconUrl: string | null }
export interface GameStatusTemplate { token: string; text: string; parameters: string[] }
export interface GameStatusAppInfo extends GameStatusGame { language: 'schinese' | 'english'; templates: GameStatusTemplate[]; templateStatus?: 'available' | 'empty' | 'unavailable' }
export interface GameStatusAppInput extends GameStatusAction { appId: number; language?: 'schinese' | 'english' }
export interface GameStatusDraft { displayKind: 'custom' | 'app'; gameName: string; details: string; appId?: number; presence?: GameStatusPresence }
export interface GameStatusPlayInput extends GameStatusAction, GameStatusDraft {}
export interface GameStatusSaveDraftInput extends GameStatusAction { draft: GameStatusDraft }
export interface GameStatusPatchInput extends GameStatusAction { snapshotId: string; changes: Record<string, string> }
export interface GameStatusLiveDisplayInput extends GameStatusAction { snapshotId: string; presence: GameStatusPresence; lock: boolean }
export interface GameStatusUnlockInput extends GameStatusAction { restore?: boolean }

export interface GameStatusGuard {
  challengeId: string
  type: 'email' | 'authenticator'
  emailDomain: string | null
  lastCodeWrong: boolean
  retryAfterSeconds: number
}

export interface GameStatusPlaying extends GameStatusDraft { displayName: string; delivery: 'submitted'; limitations: string[]; game?: GameStatusGame; preview?: string | null }
export interface GameStatusLiveSnapshot {
  snapshotId: string
  appId: number
  gameEpoch: number
  observedAt: string
  fields: Record<string, string>
  editableKeys: string[]
  readOnlyKeys: string[]
  patchActive: boolean
  game?: GameStatusGame
  localizedString?: string | null
}

export interface GameStatusLiveLock {
  appId: number
  gameEpoch: number
  desired: Record<string, string>
  status: 'checking' | 'locked' | 'retrying' | 'paused' | 'stopped'
  matched: boolean
  localizedString: string | null
  nextCheckAt: string | null
  lastCheckedAt: string | null
  consecutiveFailures: number
  error: string | null
}

export interface GameStatusOperation {
  kind: 'observe' | 'patch' | 'restore' | 'lock' | 'unlock'
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
  appInfo?: GameStatusAppInfo | null
  liveLock?: GameStatusLiveLock | null
  failure?: GameStatusFailure | null
  presenceRead?: GameStatusPresenceReadDiagnostic | null
  presenceWire?: GameStatusPresenceWireDiagnostic | null
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
  inspectApp(input: GameStatusAppInput): Promise<GameStatusAppInfo>
  lockLive(input: GameStatusPatchInput): Promise<GameStatusSnapshot>
  unlockLive(input: GameStatusUnlockInput): Promise<GameStatusSnapshot>
  setLiveDisplay(input: GameStatusLiveDisplayInput): Promise<GameStatusSnapshot>
  loadDraft(input: GameStatusAction): Promise<GameStatusDraft | null>
  saveDraft(input: GameStatusSaveDraftInput): Promise<GameStatusDraft>
  onChange(listener: (snapshot: GameStatusSnapshot) => void): () => void
}
