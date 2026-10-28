import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { copyFile, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, safeStorage, shell } from 'electron'
import { BatchQueue } from './batch-queue'
import { CommentScanQueue } from './comment-scan-queue'
import { SecretCipher, SqliteStore } from './store'
import { applyPendingDataImport, discardPreparedDataImport, prepareDataImport, queueDataImport, type PreparedDataImport } from './data-import'
import { SteamService, publicErrorMessage } from './steam-service'
import { GameStatusService, createGameStatusSteamClient } from './game-status-service'
import { NativePresenceBroker } from './native-presence-broker'
import { NativeGameStatusClient } from './native-game-status-client'
import { readLocalSimulationContext } from './simulation-local-context'
import { LocalAppSimulationService } from './local-app-simulation'
import { StatusCopyService } from './status-copy-service'
import { ToolboxStatusCopyBackend } from './status-copy-toolbox'
import { AsfStatusCopyBackend } from './status-copy-asf'
import type { StatusCopyAction, StatusCopyInput } from '../shared/status-copy'
import type { LocalAppSimulationAction, LocalAppSimulationInspectInput, LocalAppSimulationStartInput } from '../shared/local-app-simulation'
import { QuitDrain } from './quit-drain'
import type { GameStatusAction, GameStatusAppInput, GameStatusLiveDisplayInput, GameStatusPatchInput, GameStatusPlayInput, GameStatusSaveDraftInput, GameStatusUnlockInput } from '../shared/game-status'
import type { BatchFailurePolicy } from '../shared/batch-failure-policy'
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
import { ScreenshotImport, screenshotImportBlocksChannel } from './screenshot-import'
import { createScreenshotSteamRuntime } from './steam-screenshot-lifecycle-runtime'
import { ScreenshotApiHost, discoverScreenshotApiContext } from './screenshot-api-host'
import { ScreenshotLiveImport } from './screenshot-live-import'
import { ScreenshotLocalImport } from './screenshot-local-import'
import { hasScreenshotIdentityWork, readScreenshotActiveUser, shutdownScreenshotIdentityReads } from './screenshot-active-user'
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
let gameStatus: GameStatusService
let localAppSimulation: LocalAppSimulationService | undefined
let statusCopy: StatusCopyService | undefined
let queue: BatchQueue
let commentScans: CommentScanQueue
let diagnostics: RuntimeDiagnostics | undefined
let nativePresenceForQuit: NativePresenceBroker | undefined
let recoveringRenderer = false
let shuttingDown = false
let exportInProgress = false
let dataImportInProgress = false
let dataImportQueued = false
let installInProgress = false
let screenshotImportInProgress = false
let screenshotPresenceOperations = 0
let screenshotService: SteamScreenshotService
let screenshotController: ScreenshotController
let screenshotImageAdapter: ScreenshotBrowserImageAdapter
let screenshotImport: ScreenshotImport
let screenshotApiHost: ScreenshotApiHost | undefined
const accountTransition = new AccountTransition()
let updater: UpdateService
let artworkBrowser: ArtworkBrowser | null = null
let artworkUploads: ArtworkUploadService | null = null
let backgroundMedia: BackgroundMediaService | null = null
let startupUpdateTimer: ReturnType<typeof setTimeout> | undefined
let periodicUpdateTimer: ReturnType<typeof setInterval> | undefined
const updatePackageKind: UpdatePackageKind = process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup'
const quitDrain = new QuitDrain({
  prepare: [
    () => clearTimeout(startupUpdateTimer),
    () => clearInterval(periodicUpdateTimer),
    () => queue?.shutdown(),
    () => commentScans?.shutdown(),
    () => gameStatus?.dispose(),
    () => { void localAppSimulation?.invalidate().catch(() => {}) },
    () => { void statusCopy?.invalidate().catch(() => {}) }
  ],
  drain: async () => {
    const results = await Promise.allSettled([gameStatus?.shutdown() ?? nativePresenceForQuit?.shutdown(), localAppSimulation?.shutdown(), statusCopy?.shutdown(), screenshotApiHost?.shutdown(), shutdownScreenshotIdentityReads()])
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  },
  onSettled: () => app.quit()
})

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
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    await applyPendingDataImport(app.getPath('userData'))
  }
  catch {
    await dialog.showMessageBox({ type: 'error', title: APP_NAME_ZH,
      message: '数据导入未能安全完成 / Data import could not finish safely',
      detail: '工具箱没有打开数据库，请保留导入计划、旧数据及备份后重试，不要混用 WAL/SHM 文件\nThe database was not opened; preserve the import plan, original data and backups before retrying\n' + app.getPath('userData') })
    app.quit()
    return
  }
  store = new SqliteStore(
    join(app.getPath('userData'), 'steam-friend-commenter.sqlite3'),
    createSecretCipher()
  )
  nativeTheme.themeSource = store.getTheme()
  const emit = (event: AppEvent): void => {
    if (shuttingDown) return
    if (event.type === 'authFinished') {
      gameStatus?.invalidate()
      void localAppSimulation?.invalidate().catch(() => {})
      void statusCopy?.invalidate().catch(() => {})
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
  const nativePresence = new NativePresenceBroker({
    workerDirectory: app.isPackaged ? join(process.resourcesPath, 'native-presence') : join(app.getAppPath(), 'resources', 'native-presence'),
    onContextLost: () => gameStatus.invalidateLiveContext(),
    onLifecycle: event => diagnostics?.nativePresenceEvent(event)
  })
  nativePresenceForQuit = nativePresence
  gameStatus = new GameStatusService({
    nativeWriter: nativePresence,
    createLocalClient: steamId => new NativeGameStatusClient({ broker: nativePresence, steamId, createMetadataClient: () => createGameStatusSteamClient() }),
    checkSimulationContext: () => readLocalSimulationContext(),
    onDiagnostic: event => diagnostics?.gameStatusEvent(event),
    getActiveAccount: () => {
      if (accountTransition.active) return null
      const id = store.getActiveAccountId()
      const account = id ? store.getAccount(id) : null
      return account ? { id: account.id, steamId: account.steamId } : null
    },
    onChange: state => emit({ type: 'gameStatusChanged', state }),
    draftPath: join(app.getPath('userData'), 'game-status-drafts.json')
  })
  localAppSimulation = new LocalAppSimulationService({
    getWorkerPath: () => app.isPackaged
      ? join(process.resourcesPath, 'local-app-simulation', 'local-app-host-x64.exe')
      : join(app.getAppPath(), 'resources', 'local-app-simulation', 'local-app-host-x64.exe'),
    getActiveAccount: () => {
      if (accountTransition.active) return null
      const id = store.getActiveAccountId()
      const account = id ? store.getAccount(id) : null
      return account ? { id: account.id, steamId: account.steamId } : null
    },
    beforeStart: async () => {
      const state = gameStatus.snapshot()
      if (state.live?.patchActive || state.liveLock && state.liveLock.status !== 'stopped') {
        throw new DomainError('LOCAL_APP_LIVE_RESTORE_REQUIRED', '请先解除真实游戏锁定并安全恢复，再启动本机模拟。')
      }
      await statusCopy?.invalidate()
      await gameStatus.retireConnection()
    },
    onChange: state => emit({ type: 'localAppSimulationChanged', state })
  })
  statusCopy = new StatusCopyService({
    getActiveAccount: () => {
      if (accountTransition.active) return null
      const id = store.getActiveAccountId()
      const account = id ? store.getAccount(id) : null
      return account ? { id: account.id, steamId: account.steamId } : null
    },
    getToolboxLogin: accountId => steam.getGameStatusLogin(accountId),
    createBackend: mode => mode === 'asf' ? new AsfStatusCopyBackend() : new ToolboxStatusCopyBackend({
      getToolboxLogin: accountId => steam.getGameStatusLogin(accountId)
    }),
    beforeStart: async () => {
      const state = gameStatus.snapshot()
      if (state.live?.patchActive || state.liveLock && state.liveLock.status !== 'stopped') {
        throw new DomainError('COPY_LIVE_RESTORE_REQUIRED', '请先解除真实游戏锁定并安全恢复。')
      }
      await localAppSimulation?.invalidate()
      await gameStatus.retireConnection()
    },
    preferencesPath: join(app.getPath('userData'), 'status-copy-preferences.json'),
    cipher: createSecretCipher(),
    onChange: state => emit({ type: 'statusCopyChanged', state })
  })
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
  screenshotApiHost = new ScreenshotApiHost({ workerPath: () => app.isPackaged
    ? join(process.resourcesPath, 'screenshot-import', 'screenshot-import-host-x64.exe')
    : join(app.getAppPath(), 'resources', 'screenshot-import', 'screenshot-import-host-x64.exe') })
  screenshotImport = new ScreenshotImport({ service: screenshotService, runtime: createScreenshotSteamRuntime(),
    localImport: new ScreenshotLocalImport({ service: screenshotService,
      readActiveUser: steamPath => readScreenshotActiveUser(steamPath, app.isPackaged
        ? join(process.resourcesPath, 'screenshot-import', 'screenshot-import-host-x64.exe')
        : join(app.getAppPath(), 'resources', 'screenshot-import', 'screenshot-import-host-x64.exe')) }),
    liveImport: new ScreenshotLiveImport({ service: screenshotService,
      directory: join(app.getPath('userData'), 'screenshot-live-imports'),
      discoverContext: discoverScreenshotApiContext,
      createHost: () => screenshotApiHost!,
      progress: phase => emit({ type: 'screenshotImportProgress', phase }) }),
    assertRestartAllowed: mode => {
      const status = gameStatus?.snapshot()
      const simulation = localAppSimulation?.state()
      const copy = statusCopy?.state()
      const native = nativePresenceForQuit?.diagnostics()
      if (mode !== 'live' && screenshotApiHost?.hasClientWork() || hasScreenshotIdentityWork() || accountTransition.active || screenshotPresenceOperations > 0 || localAppSimulation?.hasClientWork() ||
          native && (native.active || native.retiringCount > 0) ||
          status && (status.busy || status.connected || status.status === 'connecting' || status.live?.patchActive || status.liveLock) ||
          simulation && (simulation.busy || simulation.appId !== null || ['starting', 'running', 'stopping'].includes(simulation.status)) ||
          copy && (copy.busy || ['previewing', 'starting', 'following', 'waiting', 'stopping'].includes(copy.phase) || copy.error?.code === 'COPY_STOP_UNCONFIRMED')) {
        throw new DomainError('SCREENSHOT_STEAM_WORK_BUSY', '请先停止模拟、锁定或状态复制并断开本机游戏状态连接，再自动重启 Steam')
      }
    },
    confirmRestart: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const en = store.getLanguage() === 'en'
      const choice = await dialog.showMessageBox(mainWindow, { type: 'warning',
        title: en ? 'Restart Steam to import screenshots?' : '退出并重启 Steam 以导入截图？',
        message: en ? 'Mode 2 targets the account currently in use. Exit Steam, import locally and reopen it?' : '模式二的目标账号正在 Steam 中使用。是否正常退出、导入本地截图并重新打开？',
        detail: en ? 'Steam friends and chat will disconnect briefly. Save your work and exit games first. The toolbox will not force-kill Steam. If it cannot exit within 60 seconds, no screenshots will be imported. Steam Cloud upload still requires your confirmation in Steam'
          : 'Steam 好友和聊天会短暂断开。请先保存进度并退出游戏。工具箱不会强杀 Steam；60 秒内无法完全退出则不导入。这里只导入本地截图库，云端上传仍需你在 Steam 中确认',
        buttons: en ? ['Cancel', 'Exit Steam, import & reopen'] : ['取消', '退出 Steam、导入并重开'],
        defaultId: 0, cancelId: 0, noLink: true })
      return choice.response === 1
    },
    progress: phase => emit({ type: 'screenshotImportProgress', phase }) })
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
  void steam.restoreActiveAccount().catch(() => {
    emit({ type: 'notice', level: 'warning', message: '启动时未能恢复账号连接，请查看账号提示后重试；保存的账号未被删除' })
  })
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
  gameStatus?.dispose()
  void localAppSimulation?.shutdown().catch(() => {})
  void statusCopy?.shutdown().catch(() => {})
  screenshotController?.dispose()
  screenshotImageAdapter?.dispose()
  diagnostics?.shutdown()
  store?.close()
})

app.on('child-process-gone', (_event, details) => {
  diagnostics?.processGone('child', details.reason, details.exitCode)
})

app.on('before-quit', (event) => {
  if (!exportInProgress && !screenshotImportInProgress && (!dataImportInProgress || dataImportQueued)) {
    shuttingDown = true
    if (!nativePresenceForQuit || quitDrain.settled) return
    event.preventDefault()
    void quitDrain.begin().catch(() => {})
    return
  }
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
    type: 'info', message: dataImportInProgress ? store.getLanguage() === 'en'
      ? 'Data import is being prepared; wait for it to finish before closing' : '数据导入正在准备，请完成后再退出'
      : screenshotImportInProgress ? store.getLanguage() === 'en'
      ? 'Screenshot preparation is committing local files. Please wait before closing' : '截图正在准备并写入本地文件，请完成后再退出'
      : store.getLanguage() === 'en' ? 'Please wait for the data export to finish before closing' : '数据正在导出，请完成后再退出'
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
    backgroundColor: store.getTheme() === 'dark' ? '#101820' : '#f3f6f7',
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icon.png'),
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
    if (exportInProgress || screenshotImportInProgress || dataImportInProgress && !dataImportQueued) {
      event.preventDefault()
      if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
        type: 'info', message: dataImportInProgress ? store.getLanguage() === 'en'
          ? 'Data import is being prepared; wait for it to finish before closing' : '数据导入正在准备，请完成后再退出'
          : screenshotImportInProgress ? store.getLanguage() === 'en'
          ? 'Screenshot preparation is committing local files. Please wait before closing' : '截图正在准备并写入本地文件，请完成后再退出'
          : store.getLanguage() === 'en' ? 'Please wait for the data export to finish before closing' : '数据正在导出，请完成后再退出'
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
    gameStatus.invalidateForRendererLoss()
    void localAppSimulation?.invalidate().catch(() => {})
    void statusCopy?.invalidate().catch(() => {})
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
      message: en ? 'Tasks are paused. Game status maintenance has stopped and connection shutdown has been requested. Saved comment results remain in the task list'
        : '任务已暂停，游戏状态维持已停止并已请求关闭连接，已保存的留言结果仍保留在任务列表中',
      detail: en ? 'Reloading will not resume sending or game status maintenance. Disconnecting does not mean the original game text was restored. Revisit an in-game page to let the game refresh its own status'
        : '重新加载不会自动继续发送或恢复游戏状态维持。断开连接并不表示已恢复游戏原生文字；可重新进入游戏页面，让游戏自行刷新状态',
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
      const result = await screenshotImport.prepare(input)
      return result
    } finally {
      screenshotImportInProgress = false
      emitScreenshotImagesChanged()
      void screenshotController.refresh().catch(() => {})
    }
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
  handle('artwork:zoom', (zoom: number | null) => requireArtworkBrowser().setZoom(zoom))
  handle('artwork:dynamicPreview', (enabled: boolean) => requireArtworkBrowser().setDynamicPreview(enabled))
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
  handle('gameStatus:state', () => gameStatus.snapshot())
  handle('gameStatus:connectLocal', async (input: GameStatusAction) => {
    if (input?.accountId !== store.getActiveAccountId() || input?.sessionId !== gameStatus.snapshot().sessionId) {
      throw new DomainError('GAME_STATUS_CONTEXT_CHANGED', '账号或游戏状态会话已变化，请刷新后重试。')
    }
    await localAppSimulation?.invalidate()
    await statusCopy?.invalidate()
    return gameStatus.connectLocal(input)
  })
  handle('gameStatus:connectWithToolbox', (_input: GameStatusAction) => {
    throw new DomainError('GAME_STATUS_PERSONAL_CM_DISABLED', '模拟已经改为本机 AppID 进程，不再建立独立 CM 登录。')
  })
  handle('localAppSimulation:state', () => localAppSimulation!.state())
  handle('localAppSimulation:inspect', (input: LocalAppSimulationInspectInput) => localAppSimulation!.inspect(input))
  handle('localAppSimulation:start', (input: LocalAppSimulationStartInput) => localAppSimulation!.start(input))
  handle('localAppSimulation:stop', (input: LocalAppSimulationAction) => localAppSimulation!.stop(input))
  handle('statusCopy:state', () => statusCopy!.state())
  handle('statusCopy:save', (input: StatusCopyInput) => statusCopy!.save(input))
  handle('statusCopy:preview', (input: StatusCopyInput) => statusCopy!.preview(input))
  handle('statusCopy:start', (input: StatusCopyInput) => statusCopy!.start(input))
  handle('statusCopy:stop', (input: StatusCopyAction) => statusCopy!.stop(input))
  handle('gameStatus:play', (input: GameStatusPlayInput) => gameStatus.play(input))
  handle('gameStatus:stop', (input: GameStatusAction) => gameStatus.stop(input))
  handle('gameStatus:logout', (input: GameStatusAction) => gameStatus.logout(input))
  handle('gameStatus:observe', (input: GameStatusAction) => gameStatus.observeLive(input))
  handle('gameStatus:patch', (input: GameStatusPatchInput) => gameStatus.patchLive(input))
  handle('gameStatus:restore', (input: GameStatusAction) => gameStatus.restoreLive(input))
  handle('gameStatus:app', (input: GameStatusAppInput) => gameStatus.inspectApp(input))
  handle('gameStatus:lock', (input: GameStatusPatchInput) => gameStatus.lockLive(input))
  handle('gameStatus:unlock', (input: GameStatusUnlockInput) => gameStatus.unlockLive(input))
  handle('gameStatus:display', (input: GameStatusLiveDisplayInput) => gameStatus.setLiveDisplay(input))
  handle('gameStatus:loadDraft', (input: GameStatusAction) => gameStatus.loadDraft(input))
  handle('gameStatus:saveDraft', (input: GameStatusSaveDraftInput) => gameStatus.saveDraft(input))
  handle('account:refreshStatus', (accountId: string) => steam.refreshAccountStatus(accountId))
  handle('account:activate', (accountId: string) => accountTransition.run(async () => {
    if (store.getActiveAccountId() === accountId) {
      await steam.activateAccount(accountId)
      return getSnapshot()
    }
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    await artworkBrowser?.close()
    const previousId = store.getActiveAccountId()
    if (previousId && previousId !== accountId) {
      gameStatus.invalidate()
      await localAppSimulation?.invalidate()
      await statusCopy?.invalidate()
      commentScans.pauseForAccount(previousId)
      queue.pauseForAccountChange(previousId)
    }
    await steam.activateAccount(accountId)
    return getSnapshot()
  }))
  handle('account:remove', (accountId: string) => accountTransition.run(async () => {
    const batch = store.getActiveBatchSummary(accountId)
    if (batch) {
      throw new DomainError('ACCOUNT_HAS_ACTIVE_BATCH', '请先取消这个账号的未完成批次')
    }
    if (store.getActiveAccountId() === accountId) { gameStatus.invalidate(); await localAppSimulation?.invalidate(); await statusCopy?.invalidate() }
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    if (artworkBrowser?.getState().accountId === accountId) await artworkBrowser.close()
    commentScans.pauseForAccount(accountId)
    await statusCopy?.forgetAccount(accountId)
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
  handle('settings:theme', (theme: 'light' | 'dark') => {
    store.setTheme(theme)
    nativeTheme.themeSource = theme
    mainWindow?.setBackgroundColor(theme === 'dark' ? '#101820' : '#f3f6f7')
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('storage:import', async () => {
    if (!mainWindow || dataImportInProgress) throw new DomainError('DATA_IMPORT_BUSY', '数据导入正在进行中')
    ensureDataImportIdle()
    dataImportInProgress = true
    let prepared: PreparedDataImport | undefined
    try {
      const en = store.getLanguage() === 'en'
      const selected = await dialog.showOpenDialog(mainWindow, { title: en ? 'Import toolbox data backup' : '导入工具箱数据备份',
        properties: ['openFile'], filters: [{ name: 'SQLite backup', extensions: ['sqlite3', 'sqlite', 'db'] }] })
      if (selected.canceled || !selected.filePaths[0]) return null
      ensureDataImportIdle()
      prepared = await prepareDataImport(selected.filePaths[0], app.getPath('userData'))
      const summary = prepared.summary
      const choice = await dialog.showMessageBox(mainWindow, { type: 'warning',
        title: en ? 'Replace toolbox data?' : '确认整体替换工具箱数据？',
        message: en ? 'This replaces existing toolbox data, not merges it' : '此操作将整体替换现有工具箱数据，不是合并',
        detail: (en ? `Backup contains ${summary.accounts} accounts, ${summary.friends} friends, ${summary.groups} groups, ${summary.tasks} tasks and ${summary.deliveries} delivery records\n\n`
          : `备份包含 ${summary.accounts} 个账号、${summary.friends} 位好友、${summary.groups} 个分组、${summary.tasks} 个任务、${summary.deliveries} 条发送记录\n\n`) +
          (en ? 'The toolbox will restart, back up the old database locally and apply the validated import before opening the database. Steam itself will not restart. Imported login tokens are discarded; sign in to Steam accounts again. Unfinished tasks will remain paused. Local screenshots and other separate files are not included\n\nOld-data backup: '
            : '工具箱将正常重启，启动时先在本机备份旧数据库，再应用校验后的导入；不会重启 Steam。导入不会保留登录令牌，需要重新登录工具箱内的 Steam 账号；未完成任务保持暂停。本地截图等独立文件不包含在此次导入中\n\n旧数据备份位置：') + prepared.backupPath,
        buttons: en ? ['Cancel', 'Back up, replace and restart toolbox'] : ['取消', '备份旧数据、替换并重启工具箱'],
        defaultId: 0, cancelId: 0, noLink: true })
      if (choice.response !== 1) return null
      ensureDataImportIdle()
      const restartPath = resolve(process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'))
      const executable = await lstat(restartPath)
      if (!executable.isFile() || executable.isSymbolicLink() || (await realpath(restartPath)).toLowerCase() !== restartPath.toLowerCase() ||
          process.platform === 'win32' && !restartPath.toLowerCase().endsWith('.exe')) {
        throw new DomainError('DATA_IMPORT_RESTART_UNAVAILABLE', '无法核实工具箱重启程序，尚未安排导入，请将程序放回原位置后重试')
      }
      await queueDataImport(prepared, app.getPath('userData'))
      dataImportQueued = true
      try {
        app.relaunch({ execPath: restartPath })
        setTimeout(() => app.quit(), 600)
      } catch {
        if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, { type: 'info',
          message: en ? 'Import is prepared; close and reopen the toolbox manually to finish' : '导入已准备，请手动关闭并重新打开工具箱以完成导入' })
      }
      return { backupPath: prepared.backupPath, restartScheduled: true as const }
    } finally {
      if (!dataImportQueued) {
        try { if (prepared) await discardPreparedDataImport(prepared, app.getPath('userData')) }
        finally { dataImportInProgress = false }
      }
    }
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
  handle('batch:verify', (batchId: string) => { requireCurrentTask(batchId); queue.verify(batchId) })
  handle('batch:autoRetry', (batchId: string, enabled: boolean) => { requireCurrentTask(batchId); queue.setAutoRetry(batchId, enabled) })
  handle('batch:failurePolicy', (batchId: string, policy: BatchFailurePolicy) => { requireCurrentTask(batchId); queue.setFailurePolicy(batchId, policy) })
  handle('batch:cancel', (batchId: string) => { requireCurrentTask(batchId); queue.cancel(batchId) })
}

function emitScreenshotImagesChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try { mainWindow.webContents.send('app:event', { type: 'screenshotsChanged', scope: 'images' }) }
    catch { /* The durable import ledger and queue can be read after renderer recovery. */ }
  }
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
  if (screenshotApiHost?.hasClientWork() || hasScreenshotIdentityWork()) throw new DomainError('update.installBusy', 'update.installBusy')
  const copy = statusCopy?.state()
  if (copy && (copy.busy || ['previewing', 'starting', 'following', 'waiting', 'stopping'].includes(copy.phase) || copy.error?.code === 'COPY_STOP_UNCONFIRMED')) {
    throw new DomainError('update.installBusy', 'update.installBusy')
  }
  if (artworkBrowser?.getState().tool) throw new DomainError('update.installArtworkBusy', 'update.installArtworkBusy')
  const hasActiveWork = store.getAccounts().some((account) => {
    const batch = store.getActiveBatchSummary(account.id)
    const scan = store.getLatestCommentScan(account.id)
    return batch?.status === 'running' || batch?.status === 'queued' ||
      Boolean(batch?.sending) || scan?.status === 'running'
  })
  if (exportInProgress || dataImportInProgress || screenshotImportInProgress || installInProgress || hasActiveWork || queue.hasPendingRequests()) throw new DomainError('update.installBusy', 'update.installBusy')
}

function ensureDataImportIdle(): void {
  const status = gameStatus.snapshot()
  const simulation = localAppSimulation?.state()
  const copy = statusCopy?.state()
  const native = nativePresenceForQuit?.diagnostics()
  const activeTasks = store.getAccounts().some(account => {
    const batch = store.getActiveBatchSummary(account.id)
    const scan = store.getLatestCommentScan(account.id)
    return batch?.status === 'running' || batch?.status === 'queued' || Boolean(batch?.sending || batch?.nextRetryAt) || scan?.status === 'running'
  })
  if (exportInProgress || screenshotImportInProgress || installInProgress || accountTransition.active || activeTasks || queue.hasPendingRequests() ||
      status.busy || status.connected || status.status === 'connecting' || status.live?.patchActive || status.liveLock && status.liveLock.status !== 'stopped' ||
      simulation && (simulation.busy || simulation.appId !== null || ['starting', 'running', 'stopping'].includes(simulation.status)) ||
      copy && (copy.busy || ['previewing', 'starting', 'following', 'waiting', 'stopping'].includes(copy.phase) || copy.error?.code === 'COPY_STOP_UNCONFIRMED') ||
      native && (native.active || native.retiringCount > 0) || screenshotApiHost?.hasClientWork() || hasScreenshotIdentityWork() || artworkBrowser?.getState().tool || updater.getState().phase === 'downloading') {
    throw new DomainError('DATA_IMPORT_BUSY', '请先暂停发送与检查任务、关闭自动继续计划，并停止游戏状态、截图及艺术作品操作后再导入')
  }
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
    theme: store.getTheme(),
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
    const hidingArtwork = channel === 'artwork:bounds' && args.length === 1 && args[0] === null
    if (installInProgress && channel !== 'snapshot:get' && !hidingArtwork) {
      return { ok: false, error: { code: 'update.installBusy', message: 'update.installBusy' } }
    }
    if (dataImportInProgress && !hidingArtwork && !['snapshot:get', 'gameStatus:state', 'localAppSimulation:state', 'statusCopy:state', 'screenshots:catalog', 'screenshots:images'].includes(channel)) {
      return { ok: false, error: { code: 'DATA_IMPORT_BUSY', message: store.getLanguage() === 'en'
        ? 'Data import is being prepared; wait for it to finish or restart the toolbox' : '数据导入正在准备，请等待完成或重启工具箱' } }
    }
    if (screenshotImportInProgress && screenshotImportBlocksChannel(channel)) {
      return { ok: false, error: { code: 'SCREENSHOT_BUSY', message: store.getLanguage() === 'en'
        ? 'Screenshot import is in progress. Wait for it to finish before changing screenshots or game status.' : '截图正在导入，请完成后再修改图片队列或游戏状态。' } }
    }
    if (!channel.startsWith('screenshots:') && screenshotImportBlocksChannel(channel) && (screenshotApiHost?.hasClientWork() || hasScreenshotIdentityWork())) {
      return { ok: false, error: { code: 'SCREENSHOT_LIVE_STOP_FAILED', message: store.getLanguage() === 'en'
        ? 'The screenshot component has not exited yet. Local presence changes are blocked until it closes. Retry screenshot import to drain it, or close the toolbox.'
        : '截图辅助组件尚未确认退出，暂不启动游戏状态功能。可重新进入截图导入以完成清理，或先退出工具箱。' } }
    }
    const presenceOperation = !channel.startsWith('screenshots:') && screenshotImportBlocksChannel(channel)
    if (presenceOperation) screenshotPresenceOperations++
    try {
      const data = await operation(...args)
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
      return { ok: true, data }
    } catch (error) {
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
      return { ok: false, error: toAppError(error) }
    } finally { if (presenceOperation) screenshotPresenceOperations-- }
  })
}

function toAppError(error: unknown): AppError {
  const language = store?.getLanguage() ?? 'zh-CN'
  if (error instanceof DomainError) {
    if (language === 'en' && error.code.startsWith('DATA_IMPORT_')) {
      const messages: Record<string, string> = {
        DATA_IMPORT_BUSY: 'Pause sending and checking tasks, disable scheduled retries, and stop presence, screenshots, artwork, exports and downloads before importing',
        DATA_IMPORT_UNSAFE_PATH: 'The backup or import directory is not a safe regular path; choose an ordinary toolbox SQLite backup file',
        DATA_IMPORT_FILE_CHANGED: 'The backup changed while it was being checked; keep the original file unchanged and try again',
        DATA_IMPORT_INVALID: 'This is not a supported, valid toolbox backup; existing toolbox data was not replaced',
        DATA_IMPORT_INVALID_PLAN: 'The prepared import record could not be verified; preserve it for recovery',
        DATA_IMPORT_PENDING: 'Another import is already scheduled; restart the toolbox to finish it first',
        DATA_IMPORT_RESTART_UNAVAILABLE: 'The toolbox executable cannot be verified for restart; restore it to its original location and try again',
        DATA_IMPORT_LIVE_DATABASE: 'Do not import the running database or its WAL/SHM files; choose a previously exported backup',
        DATA_IMPORT_BACKUP_FAILED: 'The old-data backup could not be created; no replacement was performed',
        DATA_IMPORT_REPLACE_FAILED: 'The prepared data could not replace the database; preserve the original data and backup',
        DATA_IMPORT_APPLY_UNCONFIRMED: 'Import completion could not be confirmed; do not open or overwrite the database manually'
      }
      return { code: error.code, message: messages[error.code] ?? 'Data import could not be prepared safely; preserve the file and import records before retrying', retryable: error.retryable }
    }
    if (language === 'en' && error.code === 'INVALID_THEME') return { code: error.code, message: 'Unsupported interface theme', retryable: false }
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
