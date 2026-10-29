import type { ArtworkSource } from './artwork-links'
import type { ArtworkBounds, ArtworkBrowserState, ArtworkTool } from './artwork-browser'
import type { ArtworkUploadDraft, ProfileBackgroundCatalog, ProfileBackgroundImage } from './profile-backgrounds'
import type { UpdatePreferences, UpdateState } from './update-types'
import type { ScreenshotCatalog, ScreenshotGame, ScreenshotImage, ScreenshotImportPhase, ScreenshotPrepareInput, ScreenshotPrepareResult } from './steam-screenshots'
import type { GameStatusApi, GameStatusSnapshot } from './game-status'
import type { LocalAppSimulationApi, LocalAppSimulationSnapshot } from './local-app-simulation'
import type { StatusCopyApi, StatusCopySnapshot } from './status-copy'
import type { BatchFailurePolicy } from './batch-failure-policy'

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
  sessionRetryAt?: string | null
  sessionRetryAttempt?: number
  sessionRetryBlocked?: boolean
  statusCheckState?: 'checking' | 'verified' | 'unverified'
  statusCheckedAt?: string | null
  statusCheckMessage?: string | null
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

export type BatchStopCode =
  | 'MANUAL_PAUSE'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'ACCESS_DENIED_PERSISTENT'
  | 'SESSION_EXPIRED'
  | 'SESSION_PREPARATION'
  | 'COMMENT_BASELINE'
  | 'LOGIN_REQUIRED'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'UNCERTAIN_RESULT'
  | 'SESSION_CHANGED'
  | 'ACCOUNT_CHANGED'
  | 'APP_RESTARTED'
  | 'APP_SHUTDOWN'
  | 'RETRY_EXHAUSTED'
  | 'QUEUE_ERROR'
  | 'LEGACY_PAUSED'
  | 'DELIVERY_FAILED'
  | 'CANCELLED'

export interface BatchPauseDetails {
  code: BatchStopCode
  message: string
  nextRetryAt?: string | null
  retryCount?: number
}

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
  autoRetryEnabled: boolean
  failurePolicy?: BatchFailurePolicy
  stopCode: BatchStopCode | null
  stopMessage: string | null
  pausedAt: string | null
  nextRetryAt: string | null
  retryCount: number
  accessDeniedCount?: number
  accessDeniedUntil?: string | null
  deliveries: DeliveryRecord[]
}

export interface BatchSummary extends Omit<BatchRecord, 'deliveries'> {
  pending: number
  sending: number
  sentVerified: number
  acceptedUnverified: number
  failedCount: number
  uncertain: number
  cancelled: number
  activity?: BatchActivity
  verification?: BatchVerification | null
}

export interface BatchVerification {
  deliveryId: string
  friendSteamId: string
  friendName: string
  state: 'checking' | 'waiting' | 'confirmed' | 'unresolved'
  attempt: number
  maxAttempts: number
  checkedAt: string | null
  nextCheckAt: string | null
  message: string
}

export interface BatchRecipientActivity {
  deliveryId: string
  friendSteamId: string
  friendName: string
  ordinal: number
  status: DeliveryStatus
  // Local result/recovery recording time, not proof of a Steam delivery time.
  recordedAt: string | null
  remoteCommentId: string | null
}

export interface BatchActivity {
  current: BatchRecipientActivity | null
  lastProcessed: BatchRecipientActivity | null
  lastConfirmed: BatchRecipientActivity | null
  nextPending: BatchRecipientActivity | null
  recent: BatchRecipientActivity[]
}

export type DeliveryListRecord = Omit<DeliveryRecord, 'renderedMessage'>

export interface BatchTaskListOptions {
  offset?: number
  limit?: number
  status?: BatchStatus
}

export interface BatchDeliveryListOptions {
  offset?: number
  limit?: number
  status?: DeliveryStatus
}

export interface BatchTaskPage {
  items: BatchSummary[]
  total: number
  offset: number
  limit: number
}

export interface BatchDeliveryPage {
  items: DeliveryListRecord[]
  total: number
  offset: number
  limit: number
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
  batches: BatchSummary[]
  activeBatch: BatchSummary | null
  friendPolicies: FriendPolicy[]
  commentScan: CommentScanJob | null
  dataDirectory: string
  language: 'zh-CN' | 'en'
  theme?: 'light' | 'dark'
  energySavingEnabled?: boolean
  energySavingActive?: boolean
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
  autoRetryEnabled?: boolean
  failurePolicy?: BatchFailurePolicy
}

export type AppEvent =
  | { type: 'gameStatusChanged'; state: GameStatusSnapshot }
  | { type: 'localAppSimulationChanged'; state: LocalAppSimulationSnapshot }
  | { type: 'statusCopyChanged'; state: StatusCopySnapshot }
  | { type: 'screenshotsChanged'; scope?: 'catalog' | 'images' | 'all' }
  | { type: 'screenshotImportProgress'; phase: ScreenshotImportPhase }
  | { type: 'artworkChanged'; state: ArtworkBrowserState }
  | { type: 'updateChanged'; state: UpdateState }
  | { type: 'snapshotChanged' }
  | { type: 'energySavingChanged'; enabled: boolean; active: boolean }
  | { type: 'friendPolicyChanged'; policy: FriendPolicy }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'authRemoteInteraction'; loginId: string }
  | { type: 'authCompleting'; loginId: string }
  | { type: 'authFinished'; loginId: string; accountId: string }
  | { type: 'authFailed'; loginId: string; message: string }
  | { type: 'batchProgress'; batchId: string; summary?: BatchSummary | null }

export type GameStatusIpcApi = {
  [K in Exclude<keyof GameStatusApi, 'onChange'>]: (...args: Parameters<GameStatusApi[K]>) => Promise<IpcResult<Awaited<ReturnType<GameStatusApi[K]>>>>
}
export type LocalAppSimulationIpcApi = {
  [K in Exclude<keyof LocalAppSimulationApi, 'onChange'>]: (...args: Parameters<LocalAppSimulationApi[K]>) => Promise<IpcResult<Awaited<ReturnType<LocalAppSimulationApi[K]>>>>
}
export type StatusCopyIpcApi = {
  [K in Exclude<keyof StatusCopyApi, 'onChange'>]: (...args: Parameters<StatusCopyApi[K]>) => Promise<IpcResult<Awaited<ReturnType<StatusCopyApi[K]>>>>
}

export interface SteamFriendCommenterApi {
  gameStatus: GameStatusIpcApi
  localAppSimulation?: LocalAppSimulationIpcApi
  statusCopy?: StatusCopyIpcApi
  getScreenshotCatalog(): Promise<IpcResult<ScreenshotCatalog>>
  refreshScreenshotCatalog(): Promise<IpcResult<ScreenshotCatalog>>
  chooseScreenshotSteamDirectory(): Promise<IpcResult<ScreenshotCatalog | null>>
  getScreenshotImages(): Promise<IpcResult<ScreenshotImage[]>>
  chooseScreenshotImages(): Promise<IpcResult<ScreenshotImage[]>>
  clearScreenshotImages(imageIds?: string[]): Promise<IpcResult<ScreenshotImage[]>>
  resolveScreenshotGame(appId: string): Promise<IpcResult<ScreenshotGame>>
  prepareScreenshots(input: ScreenshotPrepareInput): Promise<IpcResult<ScreenshotPrepareResult | null>>
  getProfileBackgrounds(accountId: string): Promise<IpcResult<ProfileBackgroundCatalog>>
  loadProfileBackground(accountId: string, backgroundId: string): Promise<IpcResult<ProfileBackgroundImage>>
  cancelProfileBackgroundLoad(): Promise<IpcResult<void>>
  prepareArtworkUpload(accountId: string, draft: ArtworkUploadDraft): Promise<IpcResult<ArtworkBrowserState>>
  checkForUpdates(): Promise<IpcResult<UpdateState>>
  downloadUpdate(routeId?: string): Promise<IpcResult<UpdateState>>
  cancelUpdate(): Promise<IpcResult<void>>
  installUpdate(): Promise<IpcResult<void>>
  setUpdatePreferences(preferences: UpdatePreferences): Promise<IpcResult<void>>
  openUpdateRelease(): Promise<IpcResult<void>>
  openArtworkTool(tool: ArtworkTool, accountId?: string): Promise<IpcResult<ArtworkBrowserState>>
  getArtworkToolState(): Promise<IpcResult<ArtworkBrowserState>>
  setArtworkToolBounds(bounds: ArtworkBounds | null): Promise<IpcResult<void>>
  setArtworkToolZoom(zoom: number | null): Promise<IpcResult<ArtworkBrowserState>>
  setArtworkDynamicPreview(enabled: boolean): Promise<IpcResult<ArtworkBrowserState>>
  applyLongArtwork(): Promise<IpcResult<void>>
  reloadArtworkTool(): Promise<IpcResult<void>>
  closeArtworkTool(): Promise<IpcResult<void>>
  copyArtworkScript(): Promise<IpcResult<void>>
  openArtworkPage(): Promise<IpcResult<void>>
  openArtworkSource(source: ArtworkSource): Promise<IpcResult<void>>
  getSnapshot(): Promise<IpcResult<AppSnapshot>>
  activateAccount(accountId: string): Promise<IpcResult<AppSnapshot>>
  refreshAccountStatus(accountId: string): Promise<IpcResult<AccountView>>
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
  updateCommentScanDelay(jobId: string, delayMs: number): Promise<IpcResult<void>>
  resumeCommentScan(jobId: string): Promise<IpcResult<void>>
  cancelCommentScan(jobId: string): Promise<IpcResult<void>>
  openDataDirectory(): Promise<IpcResult<void>>
  exportDiagnosticLogs(): Promise<IpcResult<{ path: string; records: number } | null>>
  openDiagnosticsDirectory(): Promise<IpcResult<void>>
  setLanguage(language: 'zh-CN' | 'en'): Promise<IpcResult<void>>
  setTheme(theme: 'light' | 'dark'): Promise<IpcResult<void>>
  setEnergySaving(enabled: boolean): Promise<IpcResult<void>>
  exportData(): Promise<IpcResult<{ path: string } | null>>
  importData(): Promise<IpcResult<{ backupPath: string; restartScheduled: true } | null>>
  createGroup(accountId: string, name: string, color: string): Promise<IpcResult<FriendGroup>>
  renameGroup(accountId: string, groupId: string, name: string): Promise<IpcResult<void>>
  deleteGroup(accountId: string, groupId: string): Promise<IpcResult<void>>
  setFriendGroups(accountId: string, friendSteamIds: string[], groupIds: string[]): Promise<IpcResult<void>>
  updateSettings(accountId: string, draft: string, delayMs: number): Promise<IpcResult<void>>
  startBatch(input: BatchStartInput): Promise<IpcResult<BatchSummary>>
  listBatchTasks(accountId: string, options?: BatchTaskListOptions): Promise<IpcResult<BatchTaskPage>>
  listBatchDeliveries(accountId: string, batchId: string, options?: BatchDeliveryListOptions): Promise<IpcResult<BatchDeliveryPage>>
  pauseBatch(batchId: string): Promise<IpcResult<void>>
  resumeBatch(batchId: string): Promise<IpcResult<void>>
  verifyBatch(batchId: string): Promise<IpcResult<void>>
  setBatchAutoRetry(batchId: string, enabled: boolean): Promise<IpcResult<void>>
  setBatchFailurePolicy(batchId: string, policy: BatchFailurePolicy): Promise<IpcResult<void>>
  cancelBatch(batchId: string): Promise<IpcResult<void>>
  onEvent(callback: (event: AppEvent) => void): () => void
}
