import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { copyFile, rename, unlink } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell } from 'electron'
import { BatchQueue } from './batch-queue'
import { CommentScanQueue } from './comment-scan-queue'
import { SecretCipher, SqliteStore } from './store'
import { SteamService, publicErrorMessage } from './steam-service'
import { DomainError } from '../shared/domain'
import { isAllowedExternalUrl } from './external-links'
import { localizeMessage } from '../shared/localization'
import { APP_NAME_EN, APP_NAME_ZH } from '../shared/branding'
import { buildLongArtworkScript } from '../shared/artwork'
import { ARTWORK_SOURCE_URLS, ARTWORK_UPLOAD_URL, type ArtworkSource } from '../shared/artwork-links'
import { UpdateService } from './update-service'
import { createUpdateFetch } from './update-fetch'
import { prepareWindowsUpdate } from './update-installer'
import { UPDATE_REPOSITORY, type UpdatePreferences, type UpdatePackageKind } from '../shared/update-types'
import {
  AppError,
  AppEvent,
  AppSnapshot,
  BatchStartInput,
  BatchRecord,
  CommentScanStartInput,
  IpcResult
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let store: SqliteStore
let steam: SteamService
let queue: BatchQueue
let commentScans: CommentScanQueue
let exportInProgress = false
let installInProgress = false
let updater: UpdateService
let startupUpdateTimer: ReturnType<typeof setTimeout> | undefined
let periodicUpdateTimer: ReturnType<typeof setInterval> | undefined
const updatePackageKind: UpdatePackageKind = process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup'

// Retain the existing account database if Electron uses the renamed product name.
if ([APP_NAME_ZH, APP_NAME_EN].includes(app.getName())) {
  const existingDataDirectory = join(app.getPath('appData'), 'steam-friend-commenter')
  mkdirSync(existingDataDirectory, { recursive: true })
  app.setPath('userData', existingDataDirectory)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  store = new SqliteStore(
    join(app.getPath('userData'), 'steam-friend-commenter.sqlite3'),
    createSecretCipher()
  )
  const emit = (event: AppEvent): void => {
    if (event.type === 'authFinished') {
      for (const account of store.getAccounts()) commentScans?.pauseForAccount(account.id)
    }
    const displayEvent = 'message' in event
      ? { ...event, message: localizeMessage(event.message, store.getLanguage()) } : event
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:event', displayEvent)
  }
  steam = new SteamService(store, emit, (accountId) => {
    queue?.pauseForSessionExpiry(accountId)
    commentScans?.pauseForAccount(accountId)
  })
  queue = new BatchQueue(store, steam, emit)
  commentScans = new CommentScanQueue(store, steam, emit)
  updater = new UpdateService({
    currentVersion: app.getVersion(), packageKind: updatePackageKind,
    cacheDirectory: join(app.getPath('userData'), 'updates'),
    preferences: () => store.getUpdatePreferences(),
    fetchImpl: createUpdateFetch(options => net.request(options)),
    onStateChange: (state) => emit({ type: 'updateChanged', state })
  })
  registerIpcHandlers()
  createWindow()
  void steam.restoreActiveAccount()
  const automaticCheck = (): void => {
    if (app.isPackaged && store.getUpdatePreferences().autoCheck && updater.getState().phase !== 'downloading') {
      void updater.checkForUpdates()
    }
  }
  startupUpdateTimer = setTimeout(automaticCheck, 8_000)
  periodicUpdateTimer = setInterval(automaticCheck, 4 * 60 * 60 * 1000)
  startupUpdateTimer.unref()
  periodicUpdateTimer.unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  clearTimeout(startupUpdateTimer)
  clearInterval(periodicUpdateTimer)
  updater?.shutdown()
  commentScans?.shutdown()
  store?.close()
})

app.on('before-quit', (event) => {
  if (!exportInProgress) return
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
    type: 'info', message: store.getLanguage() === 'en'
      ? 'Please wait for the data export to finish before closing.' : '数据正在导出，请完成后再退出。'
  })
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e1721',
    title: APP_NAME_ZH,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.session.on('will-download', (_event, item, contents) => {
    if (contents.id !== mainWindow?.webContents.id || !item.getURL().startsWith('blob:') ||
      item.getMimeType() !== 'image/png') return
    item.setSaveDialogOptions({
      title: store.getLanguage() === 'en' ? 'Save cropped artwork' : '保存裁剪后的艺术作品',
      defaultPath: join(app.getPath('downloads'), basename(item.getFilename()) || 'artwork.png'),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
  })
  mainWindow.on('close', (event) => {
    if (exportInProgress) {
      event.preventDefault()
      if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
        type: 'info', message: store.getLanguage() === 'en'
          ? 'Please wait for the data export to finish before closing.' : '数据正在导出，请完成后再退出。'
      })
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (url !== currentUrl) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  handle('update:check', () => updater.checkForUpdates())
  handle('update:download', (routeId?: string) => updater.downloadUpdate(routeId))
  handle('update:cancel', () => updater.cancel())
  handle('update:preferences', (preferences: UpdatePreferences) => {
    store.setUpdatePreferences(preferences)
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('update:openRelease', () => shell.openExternal(
    updater.getState().releaseUrl ?? `https://github.com/${UPDATE_REPOSITORY}/releases/latest`
  ))
  handle('update:install', async () => {
    if (!app.isPackaged) throw new DomainError('update.notPackaged', 'update.notPackaged')
    if (process.platform !== 'win32') throw new DomainError('update.installPlatform', 'update.installPlatform')
    ensureInstallationIdle()
    const ready = await updater.getReadyUpdate()
    const plan = await prepareWindowsUpdate(ready, {
      packageKind: updatePackageKind, cacheDirectory: join(app.getPath('userData'), 'updates'),
      portableTarget: process.env.PORTABLE_EXECUTABLE_FILE
    })
    ensureInstallationIdle()
    installInProgress = true
    try {
      await plan.launch()
      setImmediate(() => app.quit())
    } catch {
      installInProgress = false
      throw new DomainError('update.installLaunch', 'update.installLaunch')
    }
  })
  handle('artwork:copyScript', () => clipboard.writeText(buildLongArtworkScript()))
  handle('artwork:openUpload', () => shell.openExternal(ARTWORK_UPLOAD_URL))
  handle('artwork:openSource', (source: ArtworkSource) => {
    if (!Object.hasOwn(ARTWORK_SOURCE_URLS, source)) {
      throw new DomainError('INVALID_SOURCE', '无法打开未知工具来源')
    }
    return shell.openExternal(ARTWORK_SOURCE_URLS[source])
  })
  handle('snapshot:get', () => getSnapshot())
  handle('account:activate', async (accountId: string) => {
    const previousId = store.getActiveAccountId()
    if (previousId && previousId !== accountId) {
      commentScans.pauseForAccount(previousId)
      const activeBatch = store.getActiveBatch(previousId)
      if (activeBatch?.status === 'running' || activeBatch?.status === 'queued') {
        queue.pause(activeBatch.id)
      }
    }
    await steam.activateAccount(accountId)
    return getSnapshot()
  })
  handle('account:remove', (accountId: string) => {
    const batch = store.getActiveBatch(accountId)
    if (batch) {
      throw new DomainError('ACCOUNT_HAS_ACTIVE_BATCH', '请先取消这个账号的未完成批次')
    }
    commentScans.pauseForAccount(accountId)
    steam.removeAccount(accountId)
  })
  handle('auth:startQr', () => steam.startQrLogin())
  handle('auth:startCredentials', (accountName: string, password: string) =>
    steam.startCredentialsLogin(accountName, password)
  )
  handle('auth:submitGuard', (loginId: string, code: string) =>
    steam.submitSteamGuard(loginId, code)
  )
  handle('auth:cancel', (loginId: string) => steam.cancelLogin(loginId))
  handle('friends:sync', (accountId: string) => steam.syncFriends(accountId))
  handle('emoticons:sync', (accountId: string) => steam.syncEmoticons(accountId))
  handle('friends:blacklist', (accountId: string, friendSteamIds: string[], blacklisted: boolean) => {
    store.setBlacklist(accountId, friendSteamIds, blacklisted)
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('commentScan:start', (input: CommentScanStartInput) => commentScans.start(input))
  handle('commentScan:pause', (jobId: string) => commentScans.pause(jobId))
  handle('commentScan:resume', (jobId: string) => commentScans.resume(jobId))
  handle('commentScan:cancel', (jobId: string) => commentScans.cancel(jobId))
  handle('storage:openDirectory', async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new DomainError('OPEN_DIRECTORY_FAILED', '无法打开数据目录，请根据界面路径手动打开')
  })
  handle('settings:language', (language: 'zh-CN' | 'en') => {
    store.setLanguage(language)
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('storage:export', async () => {
    if (!mainWindow || exportInProgress) throw new DomainError('EXPORT_BUSY', '数据导出正在进行中')
    const en = store.getLanguage() === 'en'
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: en ? 'Export data (no login tokens)' : '导出数据（不含登录令牌）',
      defaultPath: `SteamFriendCommenter-Backup-${new Date().toISOString().slice(0, 10)}.sqlite3`,
      filters: [{ name: 'SQLite', extensions: ['sqlite3'] }]
    })
    if (selected.canceled || !selected.filePath) return null
    const destination = resolve(selected.filePath)
    const liveDatabase = resolve(app.getPath('userData'), 'steam-friend-commenter.sqlite3')
    if ([liveDatabase, `${liveDatabase}-wal`, `${liveDatabase}-shm`]
      .some(path => path.toLowerCase() === destination.toLowerCase())) {
      throw new DomainError('INVALID_EXPORT_PATH', '请选择数据目录之外的位置，不能覆盖当前数据库')
    }
    if (exportInProgress) throw new DomainError('EXPORT_BUSY', '数据导出正在进行中')
    exportInProgress = true
    const temporaryPath = `${destination}.${randomUUID()}.tmp`
    const stagingPath = join(app.getPath('userData'), `.export-${randomUUID()}.sqlite3`)
    try {
      // Sanitize locally before putting any backup in a potentially cloud-synced destination.
      await store.exportDatabase(stagingPath)
      await copyFile(stagingPath, temporaryPath)
      await rename(temporaryPath, destination)
      return { path: destination }
    } finally {
      try {
        for (const basePath of [stagingPath, temporaryPath]) {
          for (const path of [basePath, `${basePath}-wal`, `${basePath}-shm`, `${basePath}-journal`]) {
            await unlink(path).catch(() => undefined)
          }
        }
      } finally {
        exportInProgress = false
      }
    }
  })
  handle('groups:create', (accountId: string, name: string, color: string) =>
    store.createGroup(accountId, name, color)
  )
  handle('groups:rename', (accountId: string, groupId: string, name: string) =>
    store.renameGroup(accountId, groupId, name)
  )
  handle('groups:delete', (accountId: string, groupId: string) =>
    store.deleteGroup(accountId, groupId)
  )
  handle(
    'groups:setFriends',
    (accountId: string, friendSteamIds: string[], groupIds: string[]) =>
      store.setFriendGroups(accountId, friendSteamIds, groupIds)
  )
  handle('settings:update', (accountId: string, draft: string, delayMs: number) =>
    store.updateSettings(accountId, draft, delayMs)
  )
  handle('batch:start', (input: BatchStartInput) => queue.start(input))
  handle('batch:pause', (batchId: string) => queue.pause(batchId))
  handle('batch:resume', (batchId: string) => queue.resume(batchId))
  handle('batch:cancel', (batchId: string) => queue.cancel(batchId))
}

function ensureInstallationIdle(): void {
  const hasActiveWork = store.getAccounts().some((account) => {
    const batch = store.getActiveBatch(account.id)
    const scan = store.getLatestCommentScan(account.id)
    return batch?.status === 'running' || batch?.status === 'queued' ||
      batch?.deliveries.some((delivery) => delivery.status === 'sending') || scan?.status === 'running'
  })
  if (exportInProgress || installInProgress || hasActiveWork) throw new DomainError('update.installBusy', 'update.installBusy')
}

function getSnapshot(): AppSnapshot {
  const activeAccountId = store.getActiveAccountId()
  const secretInfo = store.getSecretStorageInfo()
  const language = store.getLanguage()
  const translated = (message: string | null): string | null => message === null ? null : localizeMessage(message, language)
  const translateBatch = (batch: BatchRecord): BatchRecord => ({ ...batch,
    deliveries: batch.deliveries.map(delivery => ({ ...delivery, error: translated(delivery.error) })) })
  const batch = activeAccountId ? store.getActiveBatch(activeAccountId) : null
  const scan = activeAccountId ? store.getLatestCommentScan(activeAccountId) : null
  return {
    accounts: steam.getAccountViews().map(account => ({ ...account, sessionMessage: translated(account.sessionMessage) })),
    activeAccountId,
    friends: activeAccountId ? store.getFriends(activeAccountId) : [],
    friendRemovals: activeAccountId ? store.getFriendRemovals(activeAccountId) : [],
    friendNameChanges: activeAccountId ? store.getFriendNameChanges(activeAccountId) : [],
    groups: activeAccountId ? store.getGroups(activeAccountId) : [],
    emoticons: activeAccountId ? store.getEmoticons(activeAccountId) : [],
    settings: activeAccountId ? store.getSettings(activeAccountId) : null,
    batches: activeAccountId ? store.getRecentBatches(activeAccountId).map(translateBatch) : [],
    activeBatch: batch ? translateBatch(batch) : null,
    friendPolicies: activeAccountId ? store.getFriendPolicies(activeAccountId)
      .map(policy => ({ ...policy, commentReason: translated(policy.commentReason) })) : [],
    commentScan: scan ? { ...scan, lastError: translated(scan.lastError) } : null,
    dataDirectory: app.getPath('userData'),
    language,
    updater: updater.getState(),
    updatePreferences: store.getUpdatePreferences(),
    security: {
      secretStorageAvailable: secretInfo.available,
      secretStorageBackend: secretInfo.backend
    }
  }
}

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  operation: (...args: TArgs) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, ...args: TArgs): Promise<IpcResult<TResult>> => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '拒绝未知页面的请求' } }
    }
    if (installInProgress && channel !== 'snapshot:get') {
      return { ok: false, error: { code: 'update.installBusy', message: 'update.installBusy' } }
    }
    try {
      const data = await operation(...args)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toAppError(error) }
    }
  })
}

function toAppError(error: unknown): AppError {
  const language = store?.getLanguage() ?? 'zh-CN'
  if (error instanceof DomainError) {
    return { code: error.code, message: localizeMessage(error.message, language), retryable: error.retryable }
  }
  return { code: 'UNEXPECTED_ERROR', message: localizeMessage(publicErrorMessage(error) || '发生未知错误', language) }
}

function createSecretCipher(): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    backend: () => (process.platform === 'win32' ? 'Windows DPAPI' : 'Electron safeStorage'),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  }
}
