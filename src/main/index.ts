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
import { ARTWORK_SOURCE_URLS, type ArtworkSource } from '../shared/artwork-links'
import { ArtworkBrowser } from './artwork-browser'
import { AccountTransition } from './account-transition'
import { ArtworkUploadService } from './artwork-upload'
import { BackgroundMediaService } from './background-media'
import type { ArtworkUploadDraft } from '../shared/profile-backgrounds'
import type { ArtworkBounds, ArtworkTool } from '../shared/artwork-browser'
import { UpdateService } from './update-service'
import { createUpdateFetch } from './update-fetch'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import { SteamScreenshotService } from './steam-screenshots'
import { ScreenshotNameService } from './steam-screenshot-names'
import { ScreenshotController } from './screenshot-controller'
import { ScreenshotBrowserImageAdapter } from './screenshot-image-adapter'
import { discoverScreenshotSteamPaths, isSteamClientRunning } from './steam-screenshot-runtime'
import type { ScreenshotPrepareInput } from '../shared/steam-screenshots'
import { prepareWindowsUpdate } from './update-installer'
import { UPDATE_REPOSITORY, type UpdatePreferences, type UpdatePackageKind } from '../shared/update-types'
import {
  AppError,
  AppEvent,
  AppSnapshot,
  BatchStartInput,
  BatchTaskListOptions,
  BatchDeliveryListOptions,
  CommentScanStartInput,
  IpcResult
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let store: SqliteStore
let steam: SteamService
let queue: BatchQueue
let commentScans: CommentScanQueue
let diagnostics: RuntimeDiagnostics | undefined
let recoveringRenderer = false
let shuttingDown = false
let exportInProgress = false
let installInProgress = false
let screenshotImportInProgress = false
let screenshotService: SteamScreenshotService
let screenshotController: ScreenshotController
let screenshotImageAdapter: ScreenshotBrowserImageAdapter
const accountTransition = new AccountTransition()
let updater: UpdateService
let artworkBrowser: ArtworkBrowser | null = null
let artworkUploads: ArtworkUploadService | null = null
let backgroundMedia: BackgroundMediaService | null = null
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
    if (shuttingDown) return
    if (event.type === 'authFinished') {
      artworkUploads?.invalidate()
      backgroundMedia?.invalidate()
      void artworkBrowser?.close()
      for (const account of store.getAccounts()) {
        commentScans?.pauseForAccount(account.id)
        const batch = store.getActiveBatchSummary(account.id)
        if (batch && (batch.status === 'running' || batch.status === 'queued' ||
          (batch.nextRetryAt && account.id !== event.accountId))) {
          queue?.pause(batch.id, account.id === event.accountId ? 'SESSION_CHANGED' : 'ACCOUNT_CHANGED',
            '登录账号或会话已改变，自动继续已停止，请核对后手动继续')
        }
      }
    }
    const displayEvent = event.type === 'batchProgress'
      ? { ...event, summary: store.getBatchSummary(event.batchId) }
      : 'message' in event ? { ...event, message: localizeMessage(event.message, store.getLanguage()) } : event
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try { mainWindow.webContents.send('app:event', displayEvent) }
      catch { /* Saved task state is recovered when the interface reconnects. */ }
    }
  }
  steam = new SteamService(store, emit, (accountId) => {
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    if (artworkBrowser?.getState().accountId === accountId) void artworkBrowser.close()
    queue?.pauseForSessionExpiry(accountId)
    commentScans?.pauseForAccount(accountId)
  }, { onDiagnostic: (event) => diagnostics?.sessionEvent(event) })
  queue = new BatchQueue(store, steam, emit)
  commentScans = new CommentScanQueue(store, steam, emit)
  diagnostics = new RuntimeDiagnostics({
    directory: join(app.getPath('userData'), 'diagnostics'), version: app.getVersion(),
    metrics: () => app.getAppMetrics(),
    task: () => {
      const accountId = store.getActiveAccountId()
      return accountId ? store.getActiveBatchSummary(accountId) : null
    }
  })
  diagnostics.start()
  screenshotImageAdapter = new ScreenshotBrowserImageAdapter()
  screenshotService = new SteamScreenshotService({ imageAdapter: screenshotImageAdapter,
    findSteamPaths: discoverScreenshotSteamPaths, isSteamRunning: isSteamClientRunning })
  screenshotController = new ScreenshotController(screenshotService,
    new ScreenshotNameService({ cachePath: join(app.getPath('userData'), 'screenshot-catalog-names.json') }), {
      preferencesPath: join(app.getPath('userData'), 'screenshot-preferences.json'), accounts: () => store.getAccounts(),
      changed: () => emit({ type: 'screenshotsChanged', scope: 'catalog' })
    })
  updater = new UpdateService({
    currentVersion: app.getVersion(), packageKind: updatePackageKind,
    cacheDirectory: join(app.getPath('userData'), 'updates'),
    preferences: () => store.getUpdatePreferences(),
    fetchImpl: createUpdateFetch(options => net.request(options)),
    onStateChange: (state) => emit({ type: 'updateChanged', state })
  })
  registerIpcHandlers()
  createWindow()
  void screenshotController.refresh().catch(() => { /* The screenshot page offers a manual directory selector. */ })
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
  shuttingDown = true
  clearTimeout(startupUpdateTimer)
  clearInterval(periodicUpdateTimer)
  updater?.shutdown()
  artworkBrowser?.shutdown()
  artworkUploads?.invalidate()
  backgroundMedia?.invalidate()
  queue?.shutdown()
  commentScans?.shutdown()
  steam?.dispose()
  screenshotController?.dispose()
  screenshotImageAdapter?.dispose()
  diagnostics?.shutdown()
  store?.close()
})

app.on('child-process-gone', (_event, details) => {
  diagnostics?.processGone('child', details.reason, details.exitCode)
})

app.on('before-quit', (event) => {
  if (!exportInProgress && !screenshotImportInProgress) { shuttingDown = true; return }
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
    type: 'info', message: screenshotImportInProgress ? store.getLanguage() === 'en'
      ? 'Screenshot preparation is committing local files. Please wait before closing.' : '截图正在准备并写入本地文件，请完成后再退出。'
      : store.getLanguage() === 'en' ? 'Please wait for the data export to finish before closing.' : '数据正在导出，请完成后再退出。'
  })
})

function createWindow(): void {
  artworkUploads?.invalidate()
  backgroundMedia?.invalidate()
  artworkBrowser?.shutdown()
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f6f7',
    title: APP_NAME_ZH,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const artworkWindow = mainWindow
  const browser = new ArtworkBrowser({
    parent: artworkWindow,
    getSessionCookies: (accountId) => steam.getArtworkWebCookies(accountId),
    isAccountCurrent: (accountId) => !accountTransition.active && store.getActiveAccountId() === accountId && steam.isAuthenticated(accountId),
    language: () => store.getLanguage(),
    onStateChange: (state) => {
      if (!state.tool) artworkUploads?.invalidate()
      if (!artworkWindow.isDestroyed()) artworkWindow.webContents.send('app:event', { type: 'artworkChanged', state } satisfies AppEvent)
    }
  })
  artworkBrowser = browser
  const isAccountCurrent = (accountId: string): boolean => !accountTransition.active && store.getActiveAccountId() === accountId && steam.isAuthenticated(accountId)
  artworkUploads = new ArtworkUploadService({ directory: join(app.getPath('userData'), 'artwork-upload-temp'),
    browser: () => browser, isAccountCurrent })
  backgroundMedia = new BackgroundMediaService({ fetchImpl: createUpdateFetch(options => net.request(options)), isAccountCurrent })
  artworkWindow.once('closed', () => {
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    browser.shutdown()
    screenshotImageAdapter?.closeWorker()
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
    if (exportInProgress || screenshotImportInProgress) {
      event.preventDefault()
      if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
        type: 'info', message: screenshotImportInProgress ? store.getLanguage() === 'en'
          ? 'Screenshot preparation is committing local files. Please wait before closing.' : '截图正在准备并写入本地文件，请完成后再退出。'
          : store.getLanguage() === 'en' ? 'Please wait for the data export to finish before closing.' : '数据正在导出，请完成后再退出。'
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
  const rendererWindow = mainWindow
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.processGone('renderer', details.reason, details.exitCode)
    if (details.reason === 'clean-exit' || shuttingDown || rendererWindow.isDestroyed() || recoveringRenderer) return
    for (const account of store.getAccounts()) {
      const batch = store.getActiveBatchSummary(account.id)
      if (batch && (batch.status === 'running' || batch.status === 'queued' || batch.nextRetryAt)) {
        queue.pause(batch.id, 'QUEUE_ERROR', '界面异常退出，自动继续已停止，请重新加载后手动继续')
      }
      commentScans.pauseForAccount(account.id)
    }
    recoveringRenderer = true
    const en = store.getLanguage() === 'en'
    void dialog.showMessageBox(rendererWindow, {
      type: 'error', title: en ? 'Toolbox interface stopped' : '工具箱界面已停止',
      message: en ? 'Tasks are paused. Saved results and pending recipients remain in the task list.'
        : '任务已暂停，已保存的结果和未发送对象仍保留在任务列表中。',
      detail: en ? 'Reloading the interface does not resume sending. Check the task list and continue manually.'
        : '重新加载界面不会自动继续发送，请在任务列表核对后手动继续。',
      buttons: en ? ['Reload interface (keep paused)', 'Exit'] : ['重新加载界面（保持暂停）', '退出'],
      defaultId: 0, cancelId: 1
    }).then(({ response }) => {
      if (rendererWindow.isDestroyed()) return
      if (response === 0) rendererWindow.reload()
      else app.quit()
    }).catch(() => undefined).finally(() => { recoveringRenderer = false })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  handle('screenshots:catalog', () => screenshotController.getCatalog())
  handle('screenshots:refresh', () => screenshotController.refresh())
  handle('screenshots:images', () => screenshotService.getImages())
  handle('screenshots:chooseSteam', async () => {
    if (!mainWindow || screenshotImportInProgress) throw new DomainError('SCREENSHOT_BUSY', '正在准备截图，请稍后重试')
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: store.getLanguage() === 'en' ? 'Choose the Steam installation directory' : '选择 Steam 安装目录',
      properties: ['openDirectory'], defaultPath: screenshotController.getCatalog().steamPath ?? undefined
    })
    return chosen.canceled || !chosen.filePaths[0] ? null : screenshotController.refresh(chosen.filePaths[0])
  })
  handle('screenshots:chooseImages', async () => {
    if (!mainWindow || screenshotImportInProgress) throw new DomainError('SCREENSHOT_BUSY', '正在准备截图，请稍后重试')
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: store.getLanguage() === 'en' ? 'Add screenshots' : '添加截图图片', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    if (!chosen.canceled && chosen.filePaths.length) await screenshotService.addImages(chosen.filePaths)
    mainWindow?.webContents.send('app:event', { type: 'screenshotsChanged', scope: 'images' })
    return screenshotService.getImages()
  })
  handle('screenshots:clearImages', (ids?: string[]) => {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || id.length > 128))) {
      throw new DomainError('SCREENSHOT_INVALID_QUEUE', '截图队列参数无效')
    }
    screenshotService.clearImages(ids)
    mainWindow?.webContents.send('app:event', { type: 'screenshotsChanged', scope: 'images' })
    return screenshotService.getImages()
  })
  handle('screenshots:resolveGame', (appId: string) => screenshotController.resolveGame(appId))
  handle('screenshots:prepare', async (input: ScreenshotPrepareInput) => {
    if (screenshotImportInProgress) throw new DomainError('SCREENSHOT_BUSY', '正在准备截图，请稍后重试')
    screenshotImportInProgress = true
    try {
      const result = await screenshotService.prepare(input)
      mainWindow?.webContents.send('app:event', { type: 'screenshotsChanged', scope: 'images' })
      return result
    } finally { screenshotImportInProgress = false }
  })
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
  handle('backgrounds:list', async (accountId: string) => {
    const catalog = await steam.getProfileBackgrounds(accountId, () => !accountTransition.active)
    if (!backgroundMedia) throw new DomainError('BACKGROUND_SESSION_CHANGED', 'BACKGROUND_SESSION_CHANGED')
    backgroundMedia.setCatalog(catalog)
    return catalog
  })
  handle('backgrounds:load', (accountId: string, backgroundId: string) => {
    if (!backgroundMedia) throw new DomainError('BACKGROUND_SESSION_CHANGED', 'BACKGROUND_SESSION_CHANGED')
    return backgroundMedia.load(accountId, backgroundId)
  })
  handle('backgrounds:cancel', () => backgroundMedia?.cancel())
  handle('artwork:prepareUpload', (accountId: string, draft: ArtworkUploadDraft) => {
    if (!artworkUploads) throw new DomainError('ARTWORK_UNAVAILABLE', 'ARTWORK_UNAVAILABLE')
    return artworkUploads.prepare(accountId, draft)
  })
  handle('artwork:state', () => requireArtworkBrowser().getState())
  handle('artwork:openTool', (tool: ArtworkTool, accountId?: string) => requireArtworkBrowser().open(tool, accountId))
  handle('artwork:bounds', (bounds: ArtworkBounds | null) => requireArtworkBrowser().setBounds(bounds))
  handle('artwork:applyLong', () => requireArtworkBrowser().applyLongArtwork())
  handle('artwork:reload', () => requireArtworkBrowser().reload())
  handle('artwork:close', async () => {
    artworkUploads?.invalidate()
    await requireArtworkBrowser().close()
    artworkUploads?.invalidate()
  })
  handle('artwork:openUpload', async () => {
    await requireArtworkBrowser().open('upload', store.getActiveAccountId() ?? undefined)
  })
  handle('artwork:openSource', async (source: ArtworkSource) => {
    if (!Object.hasOwn(ARTWORK_SOURCE_URLS, source)) {
      throw new DomainError('INVALID_SOURCE', '无法打开未知工具来源')
    }
    await requireArtworkBrowser().open(source === 'steam-design' ? 'design' : source)
  })
  handle('snapshot:get', () => getSnapshot())
  handle('account:refreshStatus', (accountId: string) => steam.refreshAccountStatus(accountId))
  handle('account:activate', (accountId: string) => accountTransition.run(async () => {
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    await artworkBrowser?.close()
    const previousId = store.getActiveAccountId()
    if (previousId && previousId !== accountId) {
      commentScans.pauseForAccount(previousId)
      const activeBatch = store.getActiveBatchSummary(previousId)
      if (activeBatch && (activeBatch.status === 'running' || activeBatch.status === 'queued' || activeBatch.nextRetryAt)) {
        queue.pause(activeBatch.id, 'ACCOUNT_CHANGED', '当前账号已切换，自动继续已停止，请切回后手动继续')
      }
    }
    await steam.activateAccount(accountId)
    return getSnapshot()
  }))
  handle('account:remove', (accountId: string) => accountTransition.run(async () => {
    const batch = store.getActiveBatchSummary(accountId)
    if (batch) {
      throw new DomainError('ACCOUNT_HAS_ACTIVE_BATCH', '请先取消这个账号的未完成批次')
    }
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    if (artworkBrowser?.getState().accountId === accountId) await artworkBrowser.close()
    commentScans.pauseForAccount(accountId)
    steam.removeAccount(accountId)
  }))
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
  handle('commentScan:updateDelay', (jobId: string, delayMs: number) => commentScans.updateDelay(jobId, delayMs))
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
  handle('batch:tasks', (accountId: string, options?: BatchTaskListOptions) => {
    requireTaskAccount(accountId)
    return store.listBatchTasks(accountId, options)
  })
  handle('batch:deliveries', (accountId: string, batchId: string, options?: BatchDeliveryListOptions) => {
    requireTaskAccount(accountId)
    const page = store.listBatchDeliveries(accountId, batchId, options)
    return { ...page, items: page.items.map(item => ({ ...item,
      error: item.error === null ? null : localizeMessage(item.error, store.getLanguage()) })) }
  })
  handle('batch:pause', (batchId: string) => { requireCurrentTask(batchId); queue.pause(batchId) })
  handle('batch:resume', (batchId: string) => { requireCurrentTask(batchId); queue.resume(batchId) })
  handle('batch:autoRetry', (batchId: string, enabled: boolean) => { requireCurrentTask(batchId); queue.setAutoRetry(batchId, enabled) })
  handle('batch:cancel', (batchId: string) => { requireCurrentTask(batchId); queue.cancel(batchId) })
}

function requireTaskAccount(accountId: string): void {
  if (accountTransition.active || store.getActiveAccountId() !== accountId) {
    throw new DomainError('ACCOUNT_NOT_ACTIVE', '请先切换到任务所属账号')
  }
}

function requireCurrentTask(batchId: string): void {
  const batch = store.getBatchSummary(batchId)
  if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
  requireTaskAccount(batch.accountId)
}

function ensureInstallationIdle(): void {
  if (artworkBrowser?.getState().tool) throw new DomainError('update.installArtworkBusy', 'update.installArtworkBusy')
  const hasActiveWork = store.getAccounts().some((account) => {
    const batch = store.getActiveBatchSummary(account.id)
    const scan = store.getLatestCommentScan(account.id)
    return batch?.status === 'running' || batch?.status === 'queued' ||
      Boolean(batch?.sending) || scan?.status === 'running'
  })
  if (exportInProgress || screenshotImportInProgress || installInProgress || hasActiveWork || queue.hasPendingRequests()) throw new DomainError('update.installBusy', 'update.installBusy')
}

function requireArtworkBrowser(): ArtworkBrowser {
  if (!artworkBrowser) throw new DomainError('ARTWORK_UNAVAILABLE', '艺术作品工具暂时不可用，请重新打开软件')
  return artworkBrowser
}

function getSnapshot(): AppSnapshot {
  const activeAccountId = store.getActiveAccountId()
  const secretInfo = store.getSecretStorageInfo()
  const language = store.getLanguage()
  const translated = (message: string | null): string | null => message === null ? null : localizeMessage(message, language)
  const batch = activeAccountId ? store.getActiveBatchSummary(activeAccountId) : null
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
    batches: activeAccountId ? store.getRecentBatchSummaries(activeAccountId) : [],
    activeBatch: batch,
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
    if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '拒绝未知页面的请求' } }
    }
    if (installInProgress && channel !== 'snapshot:get') {
      return { ok: false, error: { code: 'update.installBusy', message: 'update.installBusy' } }
    }
    try {
      const data = await operation(...args)
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
      return { ok: true, data }
    } catch (error) {
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
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
