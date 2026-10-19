import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateState } from '../shared/update-types'
import type { ScreenshotCatalog, ScreenshotGame, ScreenshotImage, ScreenshotPrepareInput, ScreenshotPrepareResult } from '../shared/steam-screenshots'
import type { ArtworkBrowserState } from '../shared/artwork-browser'
import type { GameStatusAppInfo, GameStatusDraft, GameStatusSnapshot } from '../shared/game-status'
import type { ProfileBackgroundCatalog, ProfileBackgroundImage } from '../shared/profile-backgrounds'
import {
  AppEvent,
  AppSnapshot,
  AccountView,
  AuthStartResult,
  BatchSummary,
  BatchTaskPage,
  BatchDeliveryPage,
  BatchStartInput,
  CommentScanJob,
  FriendGroup,
  IpcResult,
  SteamFriendCommenterApi
} from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

const api: SteamFriendCommenterApi = {
  gameStatus: {
    state: () => invoke<GameStatusSnapshot>('gameStatus:state'),
    connectWithToolbox: input => invoke<GameStatusSnapshot>('gameStatus:connectWithToolbox', input),
    play: input => invoke<GameStatusSnapshot>('gameStatus:play', input),
    stop: input => invoke<GameStatusSnapshot>('gameStatus:stop', input),
    logout: input => invoke<GameStatusSnapshot>('gameStatus:logout', input),
    observeLive: input => invoke<GameStatusSnapshot>('gameStatus:observe', input),
    patchLive: input => invoke<GameStatusSnapshot>('gameStatus:patch', input),
    restoreLive: input => invoke<GameStatusSnapshot>('gameStatus:restore', input),
    inspectApp: input => invoke<GameStatusAppInfo>('gameStatus:app', input),
    lockLive: input => invoke<GameStatusSnapshot>('gameStatus:lock', input),
    unlockLive: input => invoke<GameStatusSnapshot>('gameStatus:unlock', input),
    setLiveDisplay: input => invoke<GameStatusSnapshot>('gameStatus:display', input),
    loadDraft: input => invoke<GameStatusDraft | null>('gameStatus:loadDraft', input),
    saveDraft: input => invoke<GameStatusDraft>('gameStatus:saveDraft', input)
  },
  getScreenshotCatalog: () => invoke<ScreenshotCatalog>('screenshots:catalog'),
  refreshScreenshotCatalog: () => invoke<ScreenshotCatalog>('screenshots:refresh'),
  chooseScreenshotSteamDirectory: () => invoke<ScreenshotCatalog | null>('screenshots:chooseSteam'),
  getScreenshotImages: () => invoke<ScreenshotImage[]>('screenshots:images'),
  chooseScreenshotImages: () => invoke<ScreenshotImage[]>('screenshots:chooseImages'),
  clearScreenshotImages: imageIds => invoke<ScreenshotImage[]>('screenshots:clearImages', imageIds),
  resolveScreenshotGame: appId => invoke<ScreenshotGame>('screenshots:resolveGame', appId),
  prepareScreenshots: (input: ScreenshotPrepareInput) => invoke<ScreenshotPrepareResult>('screenshots:prepare', input),
  getProfileBackgrounds: (accountId) => invoke<ProfileBackgroundCatalog>('backgrounds:list', accountId),
  loadProfileBackground: (accountId, backgroundId) => invoke<ProfileBackgroundImage>('backgrounds:load', accountId, backgroundId),
  cancelProfileBackgroundLoad: () => invoke<void>('backgrounds:cancel'),
  prepareArtworkUpload: (accountId, draft) => invoke<ArtworkBrowserState>('artwork:prepareUpload', accountId, draft),
  checkForUpdates: () => invoke<UpdateState>('update:check'),
  downloadUpdate: (routeId) => invoke<UpdateState>('update:download', routeId),
  cancelUpdate: () => invoke<void>('update:cancel'),
  installUpdate: () => invoke<void>('update:install'),
  setUpdatePreferences: (preferences) => invoke<void>('update:preferences', preferences),
  openUpdateRelease: () => invoke<void>('update:openRelease'),
  openArtworkTool: (tool, accountId) => invoke<ArtworkBrowserState>('artwork:openTool', tool, accountId),
  getArtworkToolState: () => invoke<ArtworkBrowserState>('artwork:state'),
  setArtworkToolBounds: (bounds) => invoke<void>('artwork:bounds', bounds),
  applyLongArtwork: () => invoke<void>('artwork:applyLong'),
  reloadArtworkTool: () => invoke<void>('artwork:reload'),
  closeArtworkTool: () => invoke<void>('artwork:close'),
  copyArtworkScript: () => invoke<void>('artwork:copyScript'),
  openArtworkPage: () => invoke<void>('artwork:openUpload'),
  openArtworkSource: (source) => invoke<void>('artwork:openSource', source),
  getSnapshot: () => invoke<AppSnapshot>('snapshot:get'),
  activateAccount: (accountId) => invoke<AppSnapshot>('account:activate', accountId),
  refreshAccountStatus: (accountId) => invoke<AccountView>('account:refreshStatus', accountId),
  removeAccount: (accountId) => invoke<void>('account:remove', accountId),
  startQrLogin: () => invoke<AuthStartResult>('auth:startQr'),
  startCredentialsLogin: (accountName, password) =>
    invoke<AuthStartResult>('auth:startCredentials', accountName, password),
  submitSteamGuard: (loginId, code) => invoke<void>('auth:submitGuard', loginId, code),
  cancelLogin: (loginId) => invoke<void>('auth:cancel', loginId),
  syncFriends: (accountId) => invoke<number>('friends:sync', accountId),
  syncEmoticons: (accountId) => invoke<number>('emoticons:sync', accountId),
  setBlacklist: (accountId, friendSteamIds, blacklisted) =>
    invoke<void>('friends:blacklist', accountId, friendSteamIds, blacklisted),
  startCommentScan: (input) => invoke<CommentScanJob>('commentScan:start', input),
  pauseCommentScan: (jobId) => invoke<void>('commentScan:pause', jobId),
  updateCommentScanDelay: (jobId, delayMs) => invoke<void>('commentScan:updateDelay', jobId, delayMs),
  resumeCommentScan: (jobId) => invoke<void>('commentScan:resume', jobId),
  cancelCommentScan: (jobId) => invoke<void>('commentScan:cancel', jobId),
  openDataDirectory: () => invoke<void>('storage:openDirectory'),
  setLanguage: (language) => invoke<void>('settings:language', language),
  exportData: () => invoke<{ path: string } | null>('storage:export'),
  createGroup: (accountId, name, color) =>
    invoke<FriendGroup>('groups:create', accountId, name, color),
  renameGroup: (accountId, groupId, name) =>
    invoke<void>('groups:rename', accountId, groupId, name),
  deleteGroup: (accountId, groupId) => invoke<void>('groups:delete', accountId, groupId),
  setFriendGroups: (accountId, friendSteamIds, groupIds) =>
    invoke<void>('groups:setFriends', accountId, friendSteamIds, groupIds),
  updateSettings: (accountId, draft, delayMs) =>
    invoke<void>('settings:update', accountId, draft, delayMs),
  startBatch: (input: BatchStartInput) => invoke<BatchSummary>('batch:start', input),
  listBatchTasks: (accountId, options) => invoke<BatchTaskPage>('batch:tasks', accountId, options),
  listBatchDeliveries: (accountId, batchId, options) => invoke<BatchDeliveryPage>('batch:deliveries', accountId, batchId, options),
  pauseBatch: (batchId) => invoke<void>('batch:pause', batchId),
  resumeBatch: (batchId) => invoke<void>('batch:resume', batchId),
  verifyBatch: (batchId) => invoke<void>('batch:verify', batchId),
  setBatchAutoRetry: (batchId, enabled) => invoke<void>('batch:autoRetry', batchId, enabled),
  setBatchFailurePolicy: (batchId, policy) => invoke<void>('batch:failurePolicy', batchId, policy),
  cancelBatch: (batchId) => invoke<void>('batch:cancel', batchId),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, appEvent: AppEvent): void => callback(appEvent)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  }
}

contextBridge.exposeInMainWorld('steamCommenter', api)
