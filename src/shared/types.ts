import type { ArtworkSource } from './artwork-links'
import type { UpdatePreferences, UpdateState } from './update-types'

export type SessionState = 'offline' | 'restoring' | 'authenticated' | 'expired' | 'error'

export interface AccountRecord {
  id: string
  steamId: string
  accountName: string
  displayName: string
  avatarUrl: string
  createdAt: string
  lastLoginAt: string | null
  lastFriendSyncAt: string | null
  lastEmoticonSyncAt: string | null
}

export interface AccountView extends AccountRecord {
  sessionState: SessionState
  sessionMessage: string | null
}

export interface FriendRecord {
  accountId: string
  steamId: string
  displayName: string
  avatarUrl: string
  profileUrl: string
  onlineState: 'in-game' | 'online' | 'offline' | 'unknown'
  groupIds: string[]
  syncedAt: string
}

export interface FriendGroup {
  id: string
  accountId: string
  name: string
  color: string
  createdAt: string
}

export interface FriendRemovalRecord {
  id: string
  accountId: string
  steamId: string
  displayName: string
  avatarUrl: string
  profileUrl: string
  detectedAt: string | null
  restoredAt: string | null
  source: 'sync' | 'legacy'
}

export interface FriendNameChangeRecord {
  id: string
  accountId: string
  steamId: string
  oldName: string
  newName: string
  avatarUrl: string
  profileUrl: string
  detectedAt: string
}

export type CommentEligibility = 'unchecked' | 'allowed' | 'blocked' | 'unknown'

export interface CommentCheckResult {
  status: Exclude<CommentEligibility, 'unchecked'>
  reason: string
}

export interface FriendPolicy {
  accountId: string
  steamId: string
  blacklisted: boolean
  commentStatus: CommentEligibility
  commentReason: string | null
  commentCheckedAt: string | null
}

export interface CommentScanStartInput {
  accountId: string
  friendSteamIds: string[]
  delayMs: number
}

export interface CommentScanJob {
  id: string
  accountId: string
  status: 'running' | 'paused' | 'completed' | 'cancelled'
  total: number
  completed: number
  allowed: number
  blocked: number
  unknown: number
  currentSteamId: string | null
  lastError: string | null
  delayMs: number
  createdAt: string
  updatedAt: string
}

export interface SteamEmoticon {
  accountId: string
  token: string
  name: string
  imageUrl: string
  count: number
}

export interface AccountSettings {
  accountId: string
  draft: string
  delayMs: number
}

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent_verified'
  | 'accepted_unverified'
  | 'failed'
  | 'uncertain'
  | 'cancelled'

export interface DeliveryRecord {
  id: string
  batchId: string
  friendSteamId: string
  friendName: string
  renderedMessage: string
  status: DeliveryStatus
  error: string | null
  remoteCommentId: string | null
  createdAt: string
  sentAt: string | null
}

export type BatchStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled'

export interface BatchRecord {
  id: string
  accountId: string
  messageTemplate: string
  delayMs: number
  status: BatchStatus
  total: number
  completed: number
  succeeded: number
  failed: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  deliveries: DeliveryRecord[]
}

export interface AppSnapshot {
  accounts: AccountView[]
  activeAccountId: string | null
  friends: FriendRecord[]
  friendRemovals: FriendRemovalRecord[]
  friendNameChanges: FriendNameChangeRecord[]
  groups: FriendGroup[]
  emoticons: SteamEmoticon[]
  settings: AccountSettings | null
  batches: BatchRecord[]
  activeBatch: BatchRecord | null
  friendPolicies: FriendPolicy[]
  commentScan: CommentScanJob | null
  dataDirectory: string
  language: 'zh-CN' | 'en'
  updater: UpdateState
  updatePreferences: UpdatePreferences
  security: {
    secretStorageAvailable: boolean
    secretStorageBackend: string
  }
}

export type GuardType =
  | 'emailCode'
  | 'deviceCode'
  | 'deviceConfirmation'
  | 'emailConfirmation'
  | 'unknown'

export interface AuthStartResult {
  loginId: string
  mode: 'qr' | 'credentials'
  qrChallengeUrl?: string
  actionRequired: boolean
  guardTypes: GuardType[]
  guardDetail?: string
}

export interface AppError {
  code: string
  message: string
  retryable?: boolean
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError }

export interface BatchStartInput {
  accountId: string
  friendSteamIds: string[]
  messageTemplate: string
  delayMs: number
}

export type AppEvent =
  | { type: 'updateChanged'; state: UpdateState }
  | { type: 'snapshotChanged' }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'authRemoteInteraction'; loginId: string }
  | { type: 'authFinished'; loginId: string; accountId: string }
  | { type: 'authFailed'; loginId: string; message: string }
  | { type: 'batchProgress'; batchId: string }

export interface SteamFriendCommenterApi {
  checkForUpdates(): Promise<IpcResult<UpdateState>>
  downloadUpdate(routeId?: string): Promise<IpcResult<UpdateState>>
  cancelUpdate(): Promise<IpcResult<void>>
  installUpdate(): Promise<IpcResult<void>>
  setUpdatePreferences(preferences: UpdatePreferences): Promise<IpcResult<void>>
  openUpdateRelease(): Promise<IpcResult<void>>
  copyArtworkScript(): Promise<IpcResult<void>>
  openArtworkPage(): Promise<IpcResult<void>>
  openArtworkSource(source: ArtworkSource): Promise<IpcResult<void>>
  getSnapshot(): Promise<IpcResult<AppSnapshot>>
  activateAccount(accountId: string): Promise<IpcResult<AppSnapshot>>
  removeAccount(accountId: string): Promise<IpcResult<void>>
  startQrLogin(): Promise<IpcResult<AuthStartResult>>
  startCredentialsLogin(accountName: string, password: string): Promise<IpcResult<AuthStartResult>>
  submitSteamGuard(loginId: string, code: string): Promise<IpcResult<void>>
  cancelLogin(loginId: string): Promise<IpcResult<void>>
  syncFriends(accountId: string): Promise<IpcResult<number>>
  syncEmoticons(accountId: string): Promise<IpcResult<number>>
  setBlacklist(accountId: string, friendSteamIds: string[], blacklisted: boolean): Promise<IpcResult<void>>
  startCommentScan(input: CommentScanStartInput): Promise<IpcResult<CommentScanJob>>
  pauseCommentScan(jobId: string): Promise<IpcResult<void>>
  resumeCommentScan(jobId: string): Promise<IpcResult<void>>
  cancelCommentScan(jobId: string): Promise<IpcResult<void>>
  openDataDirectory(): Promise<IpcResult<void>>
  setLanguage(language: 'zh-CN' | 'en'): Promise<IpcResult<void>>
  exportData(): Promise<IpcResult<{ path: string } | null>>
  createGroup(accountId: string, name: string, color: string): Promise<IpcResult<FriendGroup>>
  renameGroup(accountId: string, groupId: string, name: string): Promise<IpcResult<void>>
  deleteGroup(accountId: string, groupId: string): Promise<IpcResult<void>>
  setFriendGroups(accountId: string, friendSteamIds: string[], groupIds: string[]): Promise<IpcResult<void>>
  updateSettings(accountId: string, draft: string, delayMs: number): Promise<IpcResult<void>>
  startBatch(input: BatchStartInput): Promise<IpcResult<BatchRecord>>
  pauseBatch(batchId: string): Promise<IpcResult<void>>
  resumeBatch(batchId: string): Promise<IpcResult<void>>
  cancelBatch(batchId: string): Promise<IpcResult<void>>
  onEvent(callback: (event: AppEvent) => void): () => void
}
