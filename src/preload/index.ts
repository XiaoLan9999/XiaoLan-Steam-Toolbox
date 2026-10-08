import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateState } from '../shared/update-types'
import {
  AppEvent,
  AppSnapshot,
  AuthStartResult,
  BatchRecord,
  BatchStartInput,
  CommentScanJob,
  FriendGroup,
  IpcResult,
  SteamFriendCommenterApi
} from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

const api: SteamFriendCommenterApi = {
  checkForUpdates: () => invoke<UpdateState>('update:check'),
  downloadUpdate: (routeId) => invoke<UpdateState>('update:download', routeId),
  cancelUpdate: () => invoke<void>('update:cancel'),
  installUpdate: () => invoke<void>('update:install'),
  setUpdatePreferences: (preferences) => invoke<void>('update:preferences', preferences),
  openUpdateRelease: () => invoke<void>('update:openRelease'),
  copyArtworkScript: () => invoke<void>('artwork:copyScript'),
  openArtworkPage: () => invoke<void>('artwork:openUpload'),
  openArtworkSource: (source) => invoke<void>('artwork:openSource', source),
  getSnapshot: () => invoke<AppSnapshot>('snapshot:get'),
  activateAccount: (accountId) => invoke<AppSnapshot>('account:activate', accountId),
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
  startBatch: (input: BatchStartInput) => invoke<BatchRecord>('batch:start', input),
  pauseBatch: (batchId) => invoke<void>('batch:pause', batchId),
  resumeBatch: (batchId) => invoke<void>('batch:resume', batchId),
  cancelBatch: (batchId) => invoke<void>('batch:cancel', batchId),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, appEvent: AppEvent): void => callback(appEvent)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  }
}

contextBridge.exposeInMainWorld('steamCommenter', api)
