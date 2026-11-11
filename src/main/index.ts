import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { copyFile, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, safeStorage, shell, Tray } from 'electron'
import { BatchQueue } from './batch-queue'
import { CommentScanQueue } from './comment-scan-queue'
import { SecretCipher, SqliteStore } from './store'
import { applyPendingDataImport, discardPreparedDataImport, prepareDataImport, queueDataImport, type PreparedDataImport } from './data-import'
import { SteamService, publicErrorMessage } from './steam-service'
import { createSteamNetworkSession } from './steam-network-session'
import { GameStatusService, createGameStatusSteamClient } from './game-status-service'
import { NativePresenceBroker } from './native-presence-broker'
import { NativeGameStatusClient, detectNativeGameStatusContext } from './native-game-status-client'
import { createLiveNativeContextDetector } from './native-context-strategy'
import { createVerifiedNativeContextDetector } from './native-context-resolver'
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
import { createUpdateScheduler } from './update-scheduler'
import { createWindowEnergySaver } from './window-energy-saver'
import { BackgroundUiEvents } from './background-ui-events'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import { observeRendererHealth } from './renderer-health'
import { DiagnosticReportError, writeDiagnosticReport } from './diagnostic-report'
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
import { PersonaLockService } from './persona-lock-service'
import { connectNativePersona, hasNativePersonaWork, shutdownNativePersonaSessions } from './persona-lock-client'
import type { PersonaLockAction, PersonaLockStart } from '../shared/persona-lock'
import { SteamCachedAccountsService } from './steam-cached-accounts'
import { readSteamCachedRoot, readSteamAutoLogin, writeSteamAutoLogin, launchSteamCachedAccount, assertSteamCachedGamesIdle } from './steam-cached-accounts-runtime'
import type { SteamCachedAccountSwitch, SteamCachedAccountAction, SteamCachedAccountsSnapshot } from '../shared/steam-cached-accounts'
import { createStaticSteamAvatarCache, steamUserdataDirectory, publishSteamProfileShortcut, steamProfileShortcutTarget } from './steam-cache-profile-tools'
import { SteamAuthenticatorService, queryAnonymousSteamTime } from './steam-authenticator'
import { SteamAuthenticatorConfirmationsService } from './steam-authenticator-confirmations'
import { SteamAuthenticatorConfirmationSafetyJournal } from './steam-authenticator-confirmation-journal'
import type { SteamAuthenticatorConfirmationListInput, SteamAuthenticatorConfirmationRespondInput } from '../shared/steam-authenticator-confirmations'
import { createWindowCloseController } from './window-close-controller'
import type { WindowCloseMode } from '../shared/window-lifecycle'
import type { WindowUiState } from '../shared/window-ui'
import { SteamAuthenticatorEnrollmentService } from './steam-authenticator-enrollment'
import { SteamAuthenticatorMobileAdapter } from './steam-authenticator-mobile'
import type { SteamAuthenticatorEnrollmentAction, SteamAuthenticatorEnrollmentApi } from '../shared/steam-authenticator-enrollment'
import type { ScreenshotPrepareInput } from '../shared/steam-screenshots'
import { prepareWindowsUpdate } from './update-installer'
import { confirmUpdateStartup } from './update-startup'
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
let updateStartupConfirmation: Promise<unknown> | undefined
let shuttingDown = false
let exportInProgress = false
let diagnosticExportInProgress = false
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
let personaLock: PersonaLockService | undefined
let cachedAccounts: SteamCachedAccountsService | undefined
let authenticator: SteamAuthenticatorService | undefined
let authenticatorConfirmations: SteamAuthenticatorConfirmationsService | undefined
let authenticatorTimeNetwork: ReturnType<typeof createSteamNetworkSession> | undefined
let authenticatorEnrollment: SteamAuthenticatorEnrollmentService | undefined
let authenticatorMobile: SteamAuthenticatorMobileAdapter | undefined
let authenticatorFileOperations = 0
let unsafeAuthenticatorExitApproved = false
let unsafeAuthenticatorExitPrompt = false
let authenticatorDialogs = new AbortController()
let confirmationVisibility = new AbortController()
function invalidateConfirmationView(): void {
  confirmationVisibility.abort(); confirmationVisibility = new AbortController()
  authenticatorDialogs.abort(); authenticatorDialogs = new AbortController()
  authenticatorConfirmations?.invalidate()
}
let tray: Tray | null = null
let pendingSteamShortcut = steamProfileShortcutTarget(process.argv)
const readCachedAvatar = createStaticSteamAvatarCache(bytes => {
  const image = nativeImage.createFromBuffer(bytes)
  return image.isEmpty() ? null : image.resize({ width: 96, height: 96 }).toDataURL()
})
let lastPersonaDiagnostic = ''
let updater: UpdateService
let artworkBrowser: ArtworkBrowser | null = null
let artworkUploads: ArtworkUploadService | null = null
let backgroundMedia: BackgroundMediaService | null = null
let updateScheduler: ReturnType<typeof createUpdateScheduler> | undefined
let windowEnergySaver: ReturnType<typeof createWindowEnergySaver> | undefined
let energySavingActive = false
const backgroundUiEvents = new BackgroundUiEvents()
const resumeUpdateChecks = (): void => updateScheduler?.resume()
const stopUpdateChecks = (): void => {
  updateScheduler?.shutdown()
  powerMonitor.removeListener('resume', resumeUpdateChecks)
}
const updatePackageKind: UpdatePackageKind = process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup'
const quitDrain = new QuitDrain({
  prepare: [
    () => authenticatorDialogs.abort(),
    stopUpdateChecks,
    () => windowEnergySaver?.shutdown(),
    () => queue?.shutdown(),
    () => commentScans?.shutdown(),
    () => gameStatus?.dispose(),
    () => { void localAppSimulation?.invalidate('toolbox-exit').catch(() => {}) },
    () => { void statusCopy?.invalidate().catch(() => {}) }
  ],
  drain: async () => {
    const results = await Promise.allSettled([(async () => { try { await authenticatorEnrollment?.shutdown() } finally { authenticatorMobile?.dispose() } })(), cachedAccounts?.shutdown(), (async () => { await personaLock?.shutdown(); await shutdownNativePersonaSessions() })(), gameStatus?.shutdown() ?? nativePresenceForQuit?.shutdown(), localAppSimulation?.shutdown(), statusCopy?.shutdown(), screenshotApiHost?.shutdown(), shutdownScreenshotIdentityReads()])
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

app.on('second-instance', (_event, commandLine) => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  pendingSteamShortcut = steamProfileShortcutTarget(commandLine)
  void runPendingSteamShortcut()
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
      void localAppSimulation?.invalidate('web-login').catch(() => {})
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
    const projected = backgroundUiEvents.project(event)
    if (!projected) return
    const displayEvent = projected.type === 'batchProgress'
      ? { ...projected, summary: store.getBatchSummary(projected.batchId) }
      : 'message' in projected ? { ...projected, message: localizeMessage(projected.message, store.getLanguage()) } : projected
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
  }, { createNetwork: () => createSteamNetworkSession(event => diagnostics?.networkEvent(event)),
    onDiagnostic: (event) => diagnostics?.sessionEvent(event), onLoginDiagnostic: event => diagnostics?.loginEvent(event) })
  queue = new BatchQueue(store, steam, emit)
  const nativePresence = new NativePresenceBroker({
    workerDirectory: app.isPackaged ? join(process.resourcesPath, 'native-presence') : join(app.getAppPath(), 'resources', 'native-presence'),
    onContextLost: () => gameStatus.invalidateLiveContext(),
    onLifecycle: event => diagnostics?.nativePresenceEvent(event)
  })
  nativePresenceForQuit = nativePresence
  gameStatus = new GameStatusService({
    nativeWriter: nativePresence,
    createLocalClient: steamId => {
      const verified = createVerifiedNativeContextDetector(steamId,
        app.isPackaged ? join(process.resourcesPath, 'screenshot-import', 'screenshot-import-host-x64.exe')
          : join(app.getAppPath(), 'resources', 'screenshot-import', 'screenshot-import-host-x64.exe'))
      return new NativeGameStatusClient({ broker: nativePresence, steamId,
        detectContext: createLiveNativeContextDetector(detectNativeGameStatusContext, verified),
        cancelContextDetection: () => verified.cancel(),
        createMetadataClient: () => createGameStatusSteamClient() })
    },
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
    onChange: state => emit({ type: 'localAppSimulationChanged', state }),
    onDiagnostic: event => diagnostics?.localAppEvent(event)
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
      await localAppSimulation?.invalidate('mode-change')
      await gameStatus.retireConnection()
    },
    preferencesPath: join(app.getPath('userData'), 'status-copy-preferences.json'),
    cipher: createSecretCipher(),
    onChange: state => emit({ type: 'statusCopyChanged', state })
  })
  commentScans = new CommentScanQueue(store, steam, emit)
  personaLock = new PersonaLockService({
    // The legacy setter has not passed live verification; do not expose it as a working feature.
    enableWrites: false,
    getActiveAccount: () => {
      if (accountTransition.active) return null
      const id = store.getActiveAccountId(), account = id ? store.getAccount(id) : null
      return account ? { id: account.id, steamId: account.steamId } : null
    },
    connect: (steamId, signal) => connectNativePersona(app.isPackaged
      ? join(process.resourcesPath, 'persona-lock', 'persona-lock-host-x64.exe')
      : join(app.getAppPath(), 'resources', 'persona-lock', 'persona-lock-host-x64.exe'), steamId, signal),
    onChange: state => {
      emit({ type: 'personaLockChanged', state })
      const diagnostic = { stage: state.status, code: state.error, nativeCode: state.nativeCode ?? null, currentState: state.currentState, restored: state.restored }
      const key = JSON.stringify(diagnostic)
      if (key !== lastPersonaDiagnostic) { lastPersonaDiagnostic = key; diagnostics?.personaLockEvent(diagnostic) }
    }
  })
  diagnostics = new RuntimeDiagnostics({
    directory: join(app.getPath('userData'), 'diagnostics'), version: app.getVersion(),
    metrics: () => app.getAppMetrics(),
    task: () => {
      const accountId = store.getActiveAccountId()
      return accountId ? store.getActiveBatchSummary(accountId) : null
    }
  })
  diagnostics.start()
  authenticatorTimeNetwork = createSteamNetworkSession(event => diagnostics?.networkEvent(event))
  const authenticatorCipher = createSecretCipher()
  authenticator = new SteamAuthenticatorService({ vaultPath: join(app.getPath('userData'), 'steam-authenticators.vault.json'),
    cipher: { ...authenticatorCipher, isAvailable: () => process.platform === 'win32' && authenticatorCipher.isAvailable() }, fetchImpl: authenticatorTimeNetwork.fetch })
  authenticatorConfirmations = new SteamAuthenticatorConfirmationsService({
    journal: new SteamAuthenticatorConfirmationSafetyJournal({ path: join(app.getPath('userData'), 'steam-authenticator-confirmations.safety.json'),
      cipher: { ...authenticatorCipher, isAvailable: () => process.platform === 'win32' && authenticatorCipher.isAvailable() } }),
    material: id => authenticator!.confirmationMaterial(id),
    connect: async steamId => {
      requireAuthenticatorVisible()
      const connection = await steam.getAuthenticatorConfirmationSession(steamId, confirmationVisibility.signal)
      const assertCurrent = connection.assertCurrent
      return { ...connection, assertCurrent: () => { requireAuthenticatorVisible(); assertCurrent() } }
    },
    timeSeconds: readAuthenticatorServerTime,
    confirm: async (item, action, ownerSteamId) => {
      requireAuthenticatorVisible()
      const en = store.getLanguage() === 'en'
      const result = await dialog.showMessageBox(mainWindow!, { type: 'warning',
        title: action === 'allow' ? en ? 'Allow this confirmation?' : '允许这项确认？' : en ? 'Reject this confirmation?' : '拒绝这项确认？',
        message: `SteamID ${ownerSteamId}\n${item.type === 2 ? en ? 'Trade' : '交易' : en ? 'Market listing' : '市场上架'} #${item.id}\n${item.title}`,
        detail: (en
          ? 'These are Steam-provided summaries, not independently verified item details. Check the full trade or market page in Steam first. This acts only on this confirmation; allowing it does not prove that the transaction completed\n\n'
          : '以下是 Steam 返回的摘要，并非独立核实的物品详情。请先在 Steam 完整交易或市场页面核对对象与物品。本次只处理这一项确认；允许确认不等于交易已经完成\n\n') + item.summary.join('\n'),
        buttons: en ? ['Cancel', action === 'allow' ? 'Allow this item' : 'Reject this item'] : ['取消', action === 'allow' ? '允许这一项' : '拒绝这一项'], defaultId: 0, cancelId: 0, noLink: true })
      requireAuthenticatorVisible()
      return result.response === 1
    }
  })
  authenticatorMobile = new SteamAuthenticatorMobileAdapter({ createNetwork: () => createSteamNetworkSession() })
  authenticatorEnrollment = new SteamAuthenticatorEnrollmentService({ pendingPath: join(app.getPath('userData'), 'steam-authenticator-setup.pending.json'),
    cipher: { ...authenticatorCipher, isAvailable: () => process.platform === 'win32' && authenticatorCipher.isAvailable() },
    vault: {
      exportPendingMaterialTo: (material, destination) => authenticator!.exportPendingMaterialTo(material, destination),
      exportIsolatedRescueTo: (material, destination) => authenticator!.exportIsolatedRescueTo(material, destination),
      saveEnrolled: async material => {
        try { return await authenticator!.saveEnrolled(material) }
        catch (failure) {
          if (!(failure instanceof DomainError) || failure.code !== 'AUTHENTICATOR_REPLACE_REQUIRED') throw failure
          requireAuthenticatorVisible()
          const state = await authenticator!.state(); requireAuthenticatorVisible()
          const existing = state.entries.find(entry => entry.steamId === material.steamId || entry.name.toLowerCase() === material.name.toLowerCase())
          if (!existing) throw failure
          const en = store.getLanguage() === 'en'
          const choice = await dialog.showMessageBox(mainWindow!, { signal: authenticatorDialogs.signal, type: 'warning',
            title: en ? 'Update the existing local authenticator entry?' : '更新已有的本地令牌记录？',
            message: `${material.name}\nSteamID ${material.steamId}`,
            detail: en ? 'Steam has reported this new candidate active. A different local entry already exists; replace only this toolbox copy? The encrypted pending record and backup remain if you cancel'
              : 'Steam 已回报这个新候选为启用状态，但本地已有不同记录。是否只替换工具箱中的这一份？取消时仍保留加密待处理记录和备份',
            buttons: en ? ['Keep pending', 'Update local entry'] : ['保留待处理', '更新本地记录'], defaultId: 0, cancelId: 0, noLink: true })
          requireAuthenticatorVisible()
          if (choice.response !== 1) throw failure
          return authenticator!.saveEnrolled(material, { replaceId: existing.id })
        }
      }
    }, backend: authenticatorMobile,
    confirmAdd: async (account, signal) => {
      requireAuthenticatorVisible()
      const en = store.getLanguage() === 'en'
      const choice = await dialog.showMessageBox(mainWindow!, { signal, type: 'warning', title: en ? 'Start a new authenticator binding?' : '开始新建手机令牌绑定？',
        message: `${account.name}\nSteamID ${account.steamId}`,
        detail: en ? 'This sends one Add request to Steam and may send a verification message. Existing authenticators are never removed automatically. Newly issued secrets are encrypted and saved before activation; you must then back up the recovery code and file'
          : '本次会向 Steam 发送一次新建请求，并可能发送验证消息；不会自动移除已有验证器。收到的新密钥会先加密保存，备份急救码和文件后才能继续激活',
        buttons: en ? ['Cancel', 'Send one new-binding request'] : ['取消', '发送一次新建绑定请求'], defaultId: 0, cancelId: 0, noLink: true })
      requireAuthenticatorVisible(); return choice.response === 1
    },
    confirmRecoverySaved: async (account, signal) => {
      requireAuthenticatorVisible()
      const en = store.getLanguage() === 'en'
      const choice = await dialog.showMessageBox(mainWindow!, { signal, type: 'warning', title: en ? 'Confirm the private backup is saved' : '确认已保存私密备份',
        message: `${account.name}\nSteamID ${account.steamId}`,
        detail: en ? 'The exported backup was read back and verified locally. Confirm you have separately saved the recovery code and can access the backup; neither should be sent to chat or support'
          : '导出的备份已经在本机重新读取核对。请确认已单独保存急救码，且能访问备份文件；不要将它们发到聊天或排查日志中',
        checkboxLabel: en ? 'I have privately saved the recovery code and backup' : '我已私下保存急救码与备份文件', checkboxChecked: false,
        buttons: en ? ['Cancel', 'Confirm saved'] : ['取消', '确认已保存'], defaultId: 0, cancelId: 0, noLink: true })
      requireAuthenticatorVisible(); return choice.response === 1 && choice.checkboxChecked
    }
  })
  cachedAccounts = new SteamCachedAccountsService({ getSteamPath: readSteamCachedRoot, runtime: createScreenshotSteamRuntime(), cipher: createSecretCipher(),
    recoveryPath: join(app.getPath('userData'), 'steam-account-switch.recovery.json'), readAutoLogin: readSteamAutoLogin,
    writeAutoLogin: writeSteamAutoLogin, launch: launchSteamCachedAccount, assertIdle: ensureSteamSwitchIdle, assertGamesIdle: assertSteamCachedGamesIdle,
    confirm: async (account, running, mode) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const en = store.getLanguage() === 'en'
      const result = await dialog.showMessageBox(mainWindow, { type: 'warning',
        title: en ? 'Switch the Steam client account?' : '切换 Steam 客户端账号？',
        message: `${account.displayName} (${account.accountName})\nSteamID ${account.steamId}\n${mode === 'offline' ? en ? 'Offline startup' : '离线启动' : en ? 'Online startup' : '在线启动'}`,
        detail: en ? `${running ? 'Steam will exit normally and reopen. ' : 'Steam will be opened. '}The selected account becomes the startup account and an existing account-chooser prompt is disabled. Cached credentials stay with Steam; a password or Steam Guard check may still be required. The toolbox account and mobile authenticator are not switched. No games or Steam processes will be force-killed`
          : `${running ? 'Steam 会正常退出并重新打开' : '将打开 Steam'}，设为所选启动账号，并关闭已有的每次启动账号选择提示。登录凭据仍由 Steam 保存；缓存失效时仍需密码或 Steam Guard 验证。不会切换工具箱账号或手机令牌，不会强杀 Steam 或游戏` + (mode === 'offline' ? '\n离线启动仅在 Steam 已有可用离线凭据时有效，不会绕过登录或游戏许可' : ''),
        buttons: en ? ['Cancel', 'Switch Steam account'] : ['取消', '切换 Steam 账号'], defaultId: 0, cancelId: 0, noLink: true })
      return result.response === 1
    }
  })
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
          hasNativePersonaWork() || personaLock && (personaLock.state().busy || ['checking', 'locked'].includes(personaLock.state().status)) ||
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
  updateScheduler = createUpdateScheduler({
    enabled: () => app.isPackaged && store.getUpdatePreferences().autoCheck,
    phase: () => updater.getState().phase,
    checkedAt: () => updater.getState().checkedAt,
    check: () => updater.checkForUpdates()
  })
  powerMonitor.on('resume', resumeUpdateChecks)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  shuttingDown = true
  stopUpdateChecks()
  windowEnergySaver?.shutdown()
  updater?.shutdown()
  artworkBrowser?.shutdown()
  artworkUploads?.invalidate()
  backgroundMedia?.invalidate()
  queue?.shutdown()
  commentScans?.shutdown()
  steam?.dispose()
  gameStatus?.dispose()
  void personaLock?.shutdown().catch(() => {})
  void localAppSimulation?.shutdown().catch(() => {})
  void statusCopy?.shutdown().catch(() => {})
  screenshotController?.dispose()
  screenshotImageAdapter?.dispose()
  diagnostics?.shutdown()
  store?.close()
  authenticatorTimeNetwork?.dispose()
  authenticatorMobile?.dispose()
  authenticatorConfirmations?.dispose()
  tray?.destroy(); tray = null
})

app.on('child-process-gone', (_event, details) => {
  diagnostics?.processGone('child', details.reason, details.exitCode)
})

app.on('before-quit', (event) => {
  if (!unsafeAuthenticatorExitApproved && authenticatorEnrollment?.hasUnpersistedIssuedMaterial()) {
    event.preventDefault()
    if (unsafeAuthenticatorExitPrompt) return
    unsafeAuthenticatorExitPrompt = true
    showMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) { unsafeAuthenticatorExitPrompt = false; return }
    const en = store.getLanguage() === 'en'
    void dialog.showMessageBox(mainWindow, { type: 'warning', title: en ? 'Authenticator material is not safely saved' : '令牌资料尚未安全保存',
      message: en ? 'Exiting now can lose newly issued authenticator secrets' : '现在退出可能丢失刚收到的验证器密钥',
      detail: en ? 'Return to the setup page to privately view the recovery code or export rescue material first. A tray window is not a durable backup. Exit only after you have independently saved what you need'
        : '请先返回新建页面，私密查看急救码或导出救援资料。托盘驻留不能代替磁盘备份；只有确认已另行保存后才继续退出',
      checkboxLabel: en ? 'I understand unsaved material may be lost and have saved a private backup' : '我明白未落盘资料可能丢失，并已另行保存私密备份', checkboxChecked: false,
      buttons: en ? ['Return to recovery', 'Exit despite unsaved material'] : ['返回救援', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true })
      .then(choice => { if (choice.response === 1 && choice.checkboxChecked) { unsafeAuthenticatorExitApproved = true; app.quit() } })
      .catch(() => {}).finally(() => { unsafeAuthenticatorExitPrompt = false })
    return
  }
  if (authenticatorFileOperations === 0 && !exportInProgress && !screenshotImportInProgress && (!dataImportInProgress || dataImportQueued)) {
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

function showMainWindow(): void {
  if (shuttingDown) return
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
}

function ensureTray(): boolean {
  const menu = (): ReturnType<typeof Menu.buildFromTemplate> => {
    const en = store.getLanguage() === 'en'
    return Menu.buildFromTemplate([
      { label: en ? 'Open toolbox' : '打开工具箱', click: showMainWindow },
      { type: 'separator' },
      { label: en ? 'Exit program' : '退出程序', click: () => app.quit() }
    ])
  }
  try {
    if (!tray || tray.isDestroyed()) {
      const icon = nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icon.png')).resize({ width: 20, height: 20 })
      if (icon.isEmpty()) return false
      tray = new Tray(icon)
      tray.on('click', showMainWindow)
      tray.on('double-click', showMainWindow)
      tray.on('right-click', () => { if (tray && !tray.isDestroyed()) tray.setContextMenu(menu()) })
    }
    tray.setToolTip(store.getLanguage() === 'en' ? APP_NAME_EN : APP_NAME_ZH)
    tray.setContextMenu(menu())
    return true
  } catch { try { tray?.destroy() } catch { /* Keep the window usable if the system tray fails. */ } tray = null; return false }
}

function getWindowUiState(): WindowUiState {
  return {
    maximized: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized(),
    focused: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    language: store.getLanguage()
  }
}

function publishWindowUiState(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('windowUi:stateChanged', getWindowUiState())
  }
}

function createWindow(): void {
  windowEnergySaver?.shutdown()
  energySavingActive = false
  backgroundUiEvents.setBackground(false)
  artworkUploads?.invalidate()
  backgroundMedia?.invalidate()
  artworkBrowser?.shutdown()
  mainWindow = new BrowserWindow({
    frame: false,
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
      backgroundThrottling: true,
      sandbox: true
    }
  })

  const artworkWindow = mainWindow
  artworkWindow.removeMenu()
  artworkWindow.on('maximize', publishWindowUiState)
  artworkWindow.on('unmaximize', publishWindowUiState)
  artworkWindow.on('focus', publishWindowUiState)
  artworkWindow.on('blur', publishWindowUiState)
  artworkWindow.on('hide', invalidateConfirmationView)
  artworkWindow.on('minimize', invalidateConfirmationView)
  artworkWindow.once('closed', invalidateConfirmationView)
  observeRendererHealth(artworkWindow, {
    record: event => diagnostics?.rendererEvent(event),
    hideEmbeddedView: () => { if (mainWindow === artworkWindow) artworkBrowser?.setBounds(null) }
  })
  const energySaver = createWindowEnergySaver({
    window: artworkWindow,
    enabled: () => store.getEnergySavingEnabled(),
    onChange: active => {
      if (mainWindow !== artworkWindow) return
      energySavingActive = active
      backgroundUiEvents.setBackground(active)
      artworkBrowser?.setEnergySaving(active)
      if (shuttingDown || artworkWindow.isDestroyed()) return
      artworkWindow.webContents.send('app:event', { type: 'energySavingChanged', enabled: store.getEnergySavingEnabled(), active } satisfies AppEvent)
    },
    compact: () => { screenshotImageAdapter?.releaseIdleWorker() }
  })
  windowEnergySaver = energySaver
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
  browser.setEnergySaving(energySavingActive)
  const isAccountCurrent = (accountId: string): boolean => !accountTransition.active && store.getActiveAccountId() === accountId && steam.isAuthenticated(accountId)
  artworkUploads = new ArtworkUploadService({ directory: join(app.getPath('userData'), 'artwork-upload-temp'),
    browser: () => browser, isAccountCurrent })
  backgroundMedia = new BackgroundMediaService({ fetchImpl: createUpdateFetch(options => net.request(options)), isAccountCurrent })
  artworkWindow.once('closed', () => {
    energySaver.shutdown()
    if (windowEnergySaver === energySaver) windowEnergySaver = undefined
    artworkUploads?.invalidate()
    backgroundMedia?.invalidate()
    browser.shutdown()
    screenshotImageAdapter?.closeWorker()
  })

  mainWindow.once('ready-to-show', () => { mainWindow?.show(); void runPendingSteamShortcut() })
  mainWindow.webContents.session.on('will-download', (_event, item, contents) => {
    if (contents.id !== mainWindow?.webContents.id || !item.getURL().startsWith('blob:') ||
      item.getMimeType() !== 'image/png') return
    item.setSaveDialogOptions({
      title: store.getLanguage() === 'en' ? 'Save cropped artwork' : '保存裁剪后的艺术作品',
      defaultPath: join(app.getPath('downloads'), basename(item.getFilename()) || 'artwork.png'),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
  })
  const closeController = createWindowCloseController({
    mode: () => store.getWindowCloseMode(), save: mode => { store.setWindowCloseMode(mode); artworkWindow.webContents.send('app:event', { type: 'snapshotChanged' }) }, ensureTray,
    isQuitting: () => shuttingDown || quitDrain.settled,
    hide: () => artworkWindow.hide(), quit: () => app.quit(),
    unavailable: () => { if (!shuttingDown && !artworkWindow.isDestroyed()) { artworkWindow.show(); void dialog.showMessageBox(artworkWindow, { type: 'info', message: store.getLanguage() === 'en' ? 'The background tray is unavailable; the window was kept open' : '系统托盘暂不可用，窗口已保留打开' }).catch(() => {}) } },
    choose: async () => {
      const en = store.getLanguage() === 'en'
      const result = await dialog.showMessageBox(artworkWindow, { type: 'question', title: en ? 'Close the toolbox window' : '关闭工具箱窗口',
        message: en ? 'Keep tasks running in the tray, or exit the program?' : '最小化到托盘继续运行任务，还是退出程序？',
        detail: en ? 'Tray mode hides the interface and enables background energy saving when configured. Exit safely stops work and saves progress; unfinished authenticator setup is retained locally'
          : '托盘驻留会隐藏界面，并按设置进入后台节能。退出会安全停止工作并保存进度；未完成的令牌绑定记录会保留在本机',
        buttons: en ? ['Minimize to tray', 'Exit program', 'Cancel'] : ['最小化到托盘', '退出程序', '取消'],
        defaultId: 0, cancelId: 2, checkboxLabel: en ? 'Remember this choice (change it in Settings)' : '记住选择（可在设置中修改）', checkboxChecked: true, noLink: true })
      return { action: result.response === 0 ? 'tray' : result.response === 1 ? 'quit' : 'cancel', remember: result.checkboxChecked }
    }
  })
  mainWindow.on('close', (event) => {
    if (shuttingDown || quitDrain.settled) return
    if (cachedAccounts?.hasWork()) { event.preventDefault(); return }
    if (authenticatorFileOperations > 0 || exportInProgress || screenshotImportInProgress || dataImportInProgress && !dataImportQueued) {
      event.preventDefault()
      if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, {
        type: 'info', message: dataImportInProgress ? store.getLanguage() === 'en'
          ? 'Data import is being prepared; wait for it to finish before closing' : '数据导入正在准备，请完成后再退出'
          : screenshotImportInProgress ? store.getLanguage() === 'en'
          ? 'Screenshot preparation is committing local files. Please wait before closing' : '截图正在准备并写入本地文件，请完成后再退出'
          : store.getLanguage() === 'en' ? 'Please wait for the data export to finish before closing' : '数据正在导出，请完成后再退出'
      })
      return
    }
    event.preventDefault()
    void closeController.request()
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
    invalidateConfirmationView()
    void authenticatorEnrollment?.state().then(state => state.id ? authenticatorEnrollment?.pause({ id: state.id }) : undefined).catch(() => {})
    void personaLock?.shutdown().catch(() => {})
    void localAppSimulation?.invalidate('renderer-loss').catch(() => {})
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
  handle('windowUi:state', getWindowUiState)
  handle('windowUi:minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize() })
  handle('windowUi:toggleMaximize', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize() } })
  handle('windowUi:close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close() })
  const enrollment = async <T>(operation: () => Promise<T>): Promise<T> => { requireAuthenticatorVisible(); const result = await operation(); requireAuthenticatorVisible(); return result }
  handle('authenticatorEnrollment:state', () => enrollment(() => authenticatorEnrollment!.state()))
  handle('authenticatorEnrollment:login', (input: Parameters<SteamAuthenticatorEnrollmentApi['login']>[0]) => enrollment(() => authenticatorEnrollment!.login(input)))
  handle('authenticatorEnrollment:guard', (input: Parameters<SteamAuthenticatorEnrollmentApi['submitGuard']>[0]) => enrollment(() => authenticatorEnrollment!.submitGuard(input)))
  handle('authenticatorEnrollment:refreshLogin', (input: SteamAuthenticatorEnrollmentAction) => enrollment(() => authenticatorEnrollment!.refreshLogin(input)))
  handle('authenticatorEnrollment:resume', (input: SteamAuthenticatorEnrollmentAction) => enrollment(() => authenticatorEnrollment!.resume(input)))
  handle('authenticatorEnrollment:pause', (input: SteamAuthenticatorEnrollmentAction) => enrollment(() => authenticatorEnrollment!.pause(input)))
  handle('authenticatorEnrollment:add', (input: SteamAuthenticatorEnrollmentAction) => enrollment(() => authenticatorEnrollment!.add(input)))
  handle('authenticatorEnrollment:acknowledge', (input: SteamAuthenticatorEnrollmentAction) => enrollment(() => authenticatorEnrollment!.acknowledgeRecoverySaved(input)))
  handle('authenticatorEnrollment:phone', (input: Parameters<SteamAuthenticatorEnrollmentApi['phone']>[0]) => enrollment(async () => {
    if (input?.op === 'begin' || input?.op === 'send-sms') {
      const state = await authenticatorEnrollment!.state(); requireAuthenticatorVisible()
      if (input.id !== state.id) throw new DomainError('AUTHENTICATOR_ENROLLMENT_CHANGED', 'AUTHENTICATOR_ENROLLMENT_CHANGED')
      const en = store.getLanguage() === 'en'
      const choice = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'Send a phone-verification request?' : '发送手机号验证请求？',
        message: `${state.accountName ?? ''}\nSteamID ${state.steamId ?? ''}`,
        detail: input.op === 'begin' ? en ? 'This submits the phone number you entered to Steam and can send a confirmation email. No existing authenticator is removed'
          : '本次会将你输入的手机号提交给 Steam，并可能发送确认邮件；不会移除已有验证器'
          : en ? 'This asks Steam to send one verification text to the account’s phone number. Sending is not automatically retried' : '本次请求 Steam 向该账号手机号发送一次验证短信，不会自动重复发送',
        buttons: en ? ['Cancel', 'Send one request'] : ['取消', '发送一次请求'], defaultId: 0, cancelId: 0, noLink: true })
      requireAuthenticatorVisible(); if (choice.response !== 1) return state
    }
    return authenticatorEnrollment!.phone(input)
  }))
  handle('authenticatorEnrollment:finalize', (input: Parameters<SteamAuthenticatorEnrollmentApi['finalize']>[0]) => enrollment(async () => {
    const state = await authenticatorEnrollment!.state(); requireAuthenticatorVisible()
    if (state.id !== input?.id) throw new DomainError('AUTHENTICATOR_ENROLLMENT_CHANGED', 'AUTHENTICATOR_ENROLLMENT_CHANGED')
    const en = store.getLanguage() === 'en'
    const result = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'Activate this authenticator?' : '激活这个手机令牌？',
      message: `${state.accountName ?? ''}\nSteamID ${state.steamId ?? ''}`,
      detail: en ? 'This submits the activation code you entered after the backup checks. If the result is unknown, the toolbox will verify it without automatically re-adding or removing an authenticator'
        : '本次将在备份核对通过后提交你输入的激活码。结果不确定时只核对状态，不会自动重新新建或移除验证器',
      buttons: en ? ['Cancel', 'Submit activation once'] : ['取消', '提交一次激活'], defaultId: 0, cancelId: 0, noLink: true })
    requireAuthenticatorVisible(); return result.response === 1 ? authenticatorEnrollment!.finalize(input) : state
  }))
  handle('authenticatorEnrollment:showRecovery', (input: SteamAuthenticatorEnrollmentAction) => enrollment(async () => {
    const material = await authenticatorEnrollment!.recoveryMaterial(input?.id); requireAuthenticatorVisible()
    return showPendingRecoveryCode(material)
  }))
  handle('authenticatorEnrollment:exportBackup', (input: SteamAuthenticatorEnrollmentAction) => enrollment(async () => {
    const state = await authenticatorEnrollment!.state(); requireAuthenticatorVisible()
    if (state.id !== input?.id) throw new DomainError('AUTHENTICATOR_ENROLLMENT_CHANGED', 'AUTHENTICATOR_ENROLLMENT_CHANGED')
    const en = store.getLanguage() === 'en'
    const warning = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'Save private setup material?' : '保存私密绑定资料？',
      message: state.accountName ?? '', detail: state.hasRescueMaterials
        ? en ? 'This is isolated rescue data, not a usable authenticator. It may contain secrets from an unexpected response or identity. Save privately for manual verification; do not activate or upload it'
          : '这是隔离救援资料，不是有效验证器，可能含异常响应或身份下收到的秘密。请私密保存并人工核对，不要据此激活或上传'
        : en ? 'This unencrypted backup contains new authenticator secrets and a recovery code. It is not activated yet. Keep it private, separately from the encrypted local copy'
          : '此未加密备份包含新令牌密钥和急救码，目前尚未完成激活。请单独私密保管，不要上传或发到聊天',
      buttons: en ? ['Cancel', 'Choose a new private file'] : ['取消', '选择新私密文件'], defaultId: 0, cancelId: 0, noLink: true })
    if (warning.response !== 1) return { exported: false }
    requireAuthenticatorVisible()
    const selected = await dialog.showSaveDialog(mainWindow!, { title: en ? 'Save setup backup' : '保存绑定备份',
      defaultPath: join(app.getPath('downloads'), `steam-authenticator-setup-${state.id}-${Date.now()}.${state.hasRescueMaterials ? 'rescue.json' : 'maFile'}`),
      filters: [{ name: state.hasRescueMaterials ? 'Isolated rescue JSON' : 'SDA maFile', extensions: [state.hasRescueMaterials ? 'json' : 'maFile'] }] })
    if (selected.canceled || !selected.filePath) return { exported: false }
    requireAuthenticatorVisible(); return authenticatorEnrollment!.exportPendingBackup(input.id, selected.filePath)
  }))
  handle('cachedAccounts:state', readCachedProfiles)
  handle('cachedAccounts:switch', async (input: SteamCachedAccountSwitch) => decorateCachedProfiles(await cachedAccounts!.switchAccount(input)))
  handle('cachedAccounts:restoreHidden', async () => {
    for (const [id, value] of Object.entries(store.getSteamCacheProfilePreferences())) if (value.hidden) store.setSteamCacheProfilePreference(id, { ...value, hidden: false })
    return readCachedProfiles()
  })
  handle('cachedAccounts:avatar', async (input: { steamId: string; revision: string }) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || energySavingActive) return null
    try {
      const { root } = cachedAccounts!.peekAccount(input?.steamId, input?.revision)
      const value = await readCachedAvatar(root, input.steamId)
      return !shuttingDown && mainWindow?.isVisible() && !mainWindow.isMinimized() && !energySavingActive ? value : null
    } catch { return null }
  })
  handle('cachedAccounts:action', cachedProfileAction)
  handle('authenticator:state', async () => { requireAuthenticatorVisible(); const state = await authenticator!.state(); requireAuthenticatorVisible(); return state })
  handle('authenticatorConfirmations:list', async (input: SteamAuthenticatorConfirmationListInput) => {
    requireAuthenticatorVisible(); const state = await authenticatorConfirmations!.list(input); requireAuthenticatorVisible(); return state
  })
  handle('authenticatorConfirmations:respond', async (input: SteamAuthenticatorConfirmationRespondInput) => {
    requireAuthenticatorVisible(); const result = await authenticatorConfirmations!.respond(input); requireAuthenticatorVisible(); return result
  })
  handle('authenticator:export', async (input: { id: string }) => {
    requireAuthenticatorVisible()
    const state = await authenticator!.state(), entry = state.entries.find(value => value.id === input?.id)
    requireAuthenticatorVisible()
    if (!entry) throw new DomainError('AUTHENTICATOR_ENTRY_NOT_FOUND', 'AUTHENTICATOR_ENTRY_NOT_FOUND')
    const en = store.getLanguage() === 'en'
    const warning = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'Export an unencrypted authenticator file?' : '导出未加密的令牌文件？',
      message: entry.name,
      detail: (en ? 'This maFile contains authenticator secrets. Anyone with it may generate codes and, when included, perform confirmations or revoke the authenticator. Keep it private. Login cookies and access/refresh tokens are not exported. Existing files will not be overwritten'
        : '此 maFile 含验证器密钥，持有者可能生成验证码，并使用其中保留的确认密钥或急救码。请私下妥善保管。不会导出登录 Cookie、访问令牌或刷新令牌，不会覆盖已有文件') +
        (!entry.capabilities.fullBackup ? en ? '\nThis record lacks some original backup fields. Missing confirmation secrets or recovery codes cannot be reconstructed; keep the original source maFile' : '\n本记录缺少部分原始备份字段，不能补造已丢弃的确认密钥或急救码，请保留原始 maFile' : ''),
      buttons: en ? ['Cancel', 'Choose a new file'] : ['取消', '选择新文件保存'], defaultId: 0, cancelId: 0, noLink: true })
    if (warning.response !== 1) return { exported: false }
    requireAuthenticatorVisible()
    const selected = await dialog.showSaveDialog(mainWindow!, { title: en ? 'Save a private authenticator backup' : '保存私密令牌备份',
      defaultPath: join(app.getPath('downloads'), `steam-authenticator-${entry.steamId ?? entry.id}-${Date.now()}.maFile`), filters: [{ name: 'SDA maFile', extensions: ['maFile'] }] })
    if (selected.canceled || !selected.filePath) return { exported: false }
    requireAuthenticatorVisible()
    const result = await authenticator!.exportTo(entry.id, selected.filePath)
    requireAuthenticatorVisible(); return { exported: true, kind: result.kind }
  })
  handle('authenticator:showRecovery', async (input: { id: string }) => {
    requireAuthenticatorVisible()
    const material = await authenticator!.recoveryMaterial(input?.id)
    requireAuthenticatorVisible()
    const en = store.getLanguage() === 'en'
    const consent = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'View the private recovery code?' : '查看私密急救码？',
      message: material.name, detail: en ? 'A recovery code can revoke this authenticator. Display it only on a private screen and never send it to support or chat'
        : '急救码可用于移除此验证器，请仅在私密屏幕上查看，切勿发给排查人员或聊天窗口',
      buttons: en ? ['Cancel', 'Show recovery code'] : ['取消', '显示急救码'], defaultId: 0, cancelId: 0, noLink: true })
    if (consent.response !== 1) return { viewed: false }
    requireAuthenticatorVisible()
    const choice = await dialog.showMessageBox(mainWindow!, { type: 'info', title: en ? 'Authenticator recovery code' : '验证器急救码',
      message: material.revocationCode, detail: `${material.name}\n${material.steamId ?? ''}`,
      buttons: en ? ['Close', 'Copy recovery code'] : ['关闭', '复制急救码'], defaultId: 0, cancelId: 0, noLink: true })
    requireAuthenticatorVisible()
    if (choice.response === 1) clipboard.writeText(material.revocationCode)
    return { viewed: true }
  })
  handle('authenticator:import', async () => {
    requireAuthenticatorVisible()
    const window = mainWindow!
    const selected = await dialog.showOpenDialog(window, { title: store.getLanguage() === 'en' ? 'Import an exported SDA authenticator' : '导入已导出的 SDA 手机令牌',
      properties: ['openFile'], filters: [{ name: 'SDA maFile', extensions: ['maFile', 'mafile'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    requireAuthenticatorVisible()
    const consent = await dialog.showMessageBox(window, { type: 'question', title: store.getLanguage() === 'en' ? 'Import authenticator material?' : '导入验证器资料？',
      message: store.getLanguage() === 'en' ? 'Keep the file’s available authenticator secrets encrypted locally?' : '将文件中可用的验证器资料加密保存在本机？',
      detail: store.getLanguage() === 'en' ? 'This can include code and confirmation secrets, device information and a recovery code for private backup. Login session tokens/cookies are discarded. The source file and phone authenticator are unchanged'
        : '可能包括验证码密钥、交易确认密钥、设备资料与急救码，以支持确认和私密备份。登录会话令牌及 Cookie 会被丢弃，不修改源文件或手机验证器',
      buttons: store.getLanguage() === 'en' ? ['Cancel', 'Import encrypted copy'] : ['取消', '导入加密副本'], defaultId: 0, cancelId: 0, noLink: true })
    if (consent.response !== 1) return null
    requireAuthenticatorVisible()
    const preview = await authenticator!.prepareImport(selected.filePaths[0], { retainSdaBackup: true })
    try {
      requireAuthenticatorVisible()
      if (preview.replacesId) {
        const en = store.getLanguage() === 'en'
        const choice = await dialog.showMessageBox(window, { type: 'warning', title: en ? 'Replace this saved authenticator?' : '替换已保存的令牌？',
          message: preview.name, detail: en ? 'Only this toolbox copy is replaced; the source file and Steam mobile authenticator remain unchanged'
            : '只替换工具箱中这一份令牌，不修改源文件或手机 Steam 验证器',
          buttons: en ? ['Cancel', 'Replace saved copy'] : ['取消', '替换本地保存'], defaultId: 0, cancelId: 0, noLink: true })
        if (choice.response !== 1) return null
      }
      requireAuthenticatorVisible()
      const state = await authenticator!.confirmImport({ id: preview.id, replace: Boolean(preview.replacesId) })
      requireAuthenticatorVisible(); return state
    } finally { authenticator!.cancelImport(preview.id) }
  })
  handle('authenticator:remove', async (input: { id: string }) => {
    requireAuthenticatorVisible()
    const state = await authenticator!.state(), entry = state.entries.find(value => value.id === input?.id)
    requireAuthenticatorVisible()
    if (!entry) throw new DomainError('AUTHENTICATOR_NOT_FOUND', 'AUTHENTICATOR_NOT_FOUND')
    const en = store.getLanguage() === 'en'
    const choice = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'Remove the local authenticator copy?' : '删除本地令牌副本？', message: entry.name,
      detail: en ? 'This does not disable Steam Guard, modify the original maFile, or remove the phone authenticator' : '不会关闭 Steam Guard、修改原 maFile 或移除手机验证器',
      buttons: en ? ['Cancel', 'Remove local copy'] : ['取消', '删除本地副本'], defaultId: 0, cancelId: 0, noLink: true })
    requireAuthenticatorVisible()
    const result = await (choice.response === 1 ? authenticator!.remove(input.id) : authenticator!.state())
    requireAuthenticatorVisible(); return result
  })
  handle('authenticator:copyCode', async (input: { id: string }) => {
    requireAuthenticatorVisible()
    const state = await authenticator!.state(), entry = state.entries.find(value => value.id === input?.id)
    requireAuthenticatorVisible()
    if (!entry) throw new DomainError('AUTHENTICATOR_NOT_FOUND', 'AUTHENTICATOR_NOT_FOUND')
    clipboard.writeText(entry.code)
  })
  handle('authenticator:syncTime', async () => { requireAuthenticatorVisible(); const state = await authenticator!.syncTime(); requireAuthenticatorVisible(); return state })
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
      portableTarget: process.env.PORTABLE_EXECUTABLE_FILE,
      setupTarget: updatePackageKind === 'setup' ? app.getPath('exe') : undefined,
      currentVersion: app.getVersion()
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
  handle('update:startupHealthy', async () => {
    if (!app.isPackaged || process.platform !== 'win32' || !process.argv.includes('--updated')) return
    const receiptArgument = process.argv.find(value => value.startsWith('--update-receipt='))
    const transactionId = receiptArgument?.slice('--update-receipt='.length)
    if (receiptArgument && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(transactionId ?? '')) return
    updateStartupConfirmation ??= confirmUpdateStartup({
      cacheDirectory: join(app.getPath('userData'), 'updates'), currentVersion: app.getVersion(),
      packageKind: updatePackageKind, currentExecutable: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'),
      transactionId
    }).catch(() => ({ confirmed: false }))
    await updateStartupConfirmation
  })
  handle('gameStatus:state', () => gameStatus.snapshot())
  handle('personaLock:state', () => personaLock!.state())
  handle('personaLock:start', (input: PersonaLockStart) => personaLock!.start(input))
  handle('personaLock:stop', async (input: PersonaLockAction) => {
    await personaLock!.stop(input)
    await shutdownNativePersonaSessions()
    return personaLock!.state()
  })
  handle('gameStatus:connectLocal', async (input: GameStatusAction) => {
    if (input?.accountId !== store.getActiveAccountId() || input?.sessionId !== gameStatus.snapshot().sessionId) {
      throw new DomainError('GAME_STATUS_CONTEXT_CHANGED', '账号或游戏状态会话已变化，请刷新后重试。')
    }
    await localAppSimulation?.invalidate('native-state')
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
      invalidateConfirmationView()
      await personaLock?.shutdown()
      await shutdownNativePersonaSessions()
      gameStatus.invalidate()
      await localAppSimulation?.invalidate('account-change')
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
    if (store.getActiveAccountId() === accountId) { await personaLock?.shutdown(); await shutdownNativePersonaSessions(); gameStatus.invalidate(); await localAppSimulation?.invalidate('account-change'); await statusCopy?.invalidate() }
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
  handle('diagnostics:openDirectory', async () => {
    const directory = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(directory, { recursive: true })
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()) {
      throw new DomainError('DIAGNOSTICS_UNSAFE_PATH', '日志目录不是普通本地目录，已停止打开')
    }
    if (await shell.openPath(directory)) throw new DomainError('DIAGNOSTICS_OPEN_FAILED', '无法打开日志目录')
  })
  handle('diagnostics:export', async () => {
    if (!mainWindow || diagnosticExportInProgress) throw new DomainError('DIAGNOSTICS_BUSY', '诊断日志正在导出，请稍候')
    diagnosticExportInProgress = true
    try {
      const en = store.getLanguage() === 'en'
      const selected = await dialog.showSaveDialog(mainWindow, {
        title: en ? 'Export sanitized diagnostic log' : '导出脱敏诊断日志',
        defaultPath: `XiaoLan-Steam-Toolbox-Diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        filters: [{ name: en ? 'Diagnostic JSON' : '诊断 JSON', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePath || !mainWindow || mainWindow.isDestroyed()) return null
      diagnostics?.sample('memory')
      return await writeDiagnosticReport(selected.filePath, {
        userDataDirectory: app.getPath('userData'), diagnosticsDirectory: join(app.getPath('userData'), 'diagnostics'),
        appVersion: app.getVersion(), electronVersion: process.versions.electron,
        nodeVersion: process.versions.node, chromiumVersion: process.versions.chrome
      })
    } finally { diagnosticExportInProgress = false }
  })
  handle('settings:language', (language: 'zh-CN' | 'en') => {
    store.setLanguage(language)
    publishWindowUiState()
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('settings:theme', (theme: 'light' | 'dark') => {
    store.setTheme(theme)
    nativeTheme.themeSource = theme
    mainWindow?.setBackgroundColor(theme === 'dark' ? '#101820' : '#f3f6f7')
    mainWindow?.webContents.send('app:event', { type: 'snapshotChanged' })
  })
  handle('settings:energySaving', (enabled: boolean) => {
    store.setEnergySavingEnabled(enabled)
    windowEnergySaver?.refresh()
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:event', { type: 'energySavingChanged', enabled, active: energySavingActive } satisfies AppEvent)
  })
  handle('settings:windowClose', (mode: WindowCloseMode) => {
    store.setWindowCloseMode(mode)
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

function decorateCachedProfiles(state: SteamCachedAccountsSnapshot): SteamCachedAccountsSnapshot {
  const preferences = store.getSteamCacheProfilePreferences()
  return { ...state, hiddenCount: state.accounts.filter(value => preferences[value.steamId]?.hidden).length,
    accounts: state.accounts.filter(value => !preferences[value.steamId]?.hidden).map(value => ({ ...value, note: preferences[value.steamId]?.note ?? null })) }
}

async function readCachedProfiles(): Promise<SteamCachedAccountsSnapshot> { return decorateCachedProfiles(await cachedAccounts!.state()) }

async function cachedProfileAction(input: SteamCachedAccountAction) {
  if (cachedAccounts?.hasWork()) throw new DomainError('STEAM_CACHE_BUSY', 'STEAM_CACHE_BUSY')
  const state = await cachedAccounts!.state()
  if (!input || input.revision !== state.revision) throw new DomainError('STEAM_CACHE_CHANGED', 'STEAM_CACHE_CHANGED')
  const { root, account } = cachedAccounts!.peekAccount(input.steamId, input.revision)
  let performed = true
  switch (input.action) {
    case 'copy-id': clipboard.writeText(account.steamId); break
    case 'copy-login': clipboard.writeText(account.accountName); break
    case 'copy-name': clipboard.writeText(account.displayName); break
    case 'profile': await shell.openExternal(`https://steamcommunity.com/profiles/${account.steamId}/`); break
    case 'userdata': {
      const path = await steamUserdataDirectory(root, account.steamId)
      if (await shell.openPath(path)) throw new DomainError('STEAM_CACHE_ACTION_UNAVAILABLE', 'STEAM_CACHE_ACTION_UNAVAILABLE')
      break
    }
    case 'note': {
      if (typeof input.note !== 'string' || input.note.length > 80 || /[\p{Cc}\p{Cf}]/u.test(input.note)) throw new DomainError('STEAM_CACHE_INVALID', 'STEAM_CACHE_INVALID')
      const previous = store.getSteamCacheProfilePreferences()[account.steamId] ?? {}
      store.setSteamCacheProfilePreference(account.steamId, { ...previous, note: input.note.trim() }); break
    }
    case 'hide': {
      if (!mainWindow || mainWindow.isDestroyed()) throw new DomainError('STEAM_CACHE_ACTION_UNAVAILABLE', 'STEAM_CACHE_ACTION_UNAVAILABLE')
      const en = store.getLanguage() === 'en'
      const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: en ? 'Hide this local card?' : '隐藏这张本地账号卡片？',
        message: account.displayName, detail: en ? 'Only this toolbox list is affected. Steam credentials, accounts and userdata are not deleted; hidden cards can be restored on this page'
          : '只影响工具箱列表，不删除 Steam 登录凭据、账号或 userdata；可在本页恢复显示',
        buttons: en ? ['Cancel', 'Hide card'] : ['取消', '隐藏卡片'], defaultId: 0, cancelId: 0, noLink: true })
      if (choice.response === 1) store.setSteamCacheProfilePreference(account.steamId, { ...store.getSteamCacheProfilePreferences()[account.steamId], hidden: true })
      else performed = false
      break
    }
    case 'shortcut': {
      if (!app.isPackaged || !mainWindow || mainWindow.isDestroyed()) throw new DomainError('STEAM_CACHE_ACTION_UNAVAILABLE', 'STEAM_CACHE_ACTION_UNAVAILABLE')
      const selection = await dialog.showSaveDialog(mainWindow, { title: store.getLanguage() === 'en' ? 'Create an account shortcut' : '创建账号快捷方式',
        defaultPath: join(app.getPath('desktop'), `XiaoLan Steam - ${account.accountName}.lnk`), filters: [{ name: 'Windows shortcut', extensions: ['lnk'] }] })
      if (selection.canceled || !selection.filePath) { performed = false; break }
      await publishSteamProfileShortcut(selection.filePath, process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'), account.steamId,
        (path, target, args) => shell.writeShortcutLink(path, 'create', { target, args, icon: target, iconIndex: 0, description: 'XiaoLan Steam Toolbox account selection' }))
      break
    }
    default: throw new DomainError('STEAM_CACHE_INVALID', 'STEAM_CACHE_INVALID')
  }
  return { performed, state: decorateCachedProfiles(state) }
}

async function runPendingSteamShortcut(): Promise<void> {
  const id = pendingSteamShortcut; pendingSteamShortcut = null
  if (!id || !cachedAccounts || shuttingDown || cachedAccounts.hasWork()) return
  try {
    showMainWindow()
    const state = await cachedAccounts.state()
    if (!state.accounts.some(value => value.steamId === id)) return
    const result = await cachedAccounts.switchAccount({ steamId: id, revision: state.revision, mode: 'online' })
    if (result.error && mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, { type: 'info',
      message: store.getLanguage() === 'en' ? 'The Steam switch did not complete; open the account-switcher page to check its reason' : 'Steam 账号切换未完成，请打开账号切换页查看原因' })
  } catch { /* A shortcut never bypasses the normal confirmation or safety gates. */ }
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
  if (cachedAccounts?.hasWork()) throw new DomainError('update.installBusy', 'update.installBusy')
  if (hasNativePersonaWork() || personaLock && (personaLock.state().busy || ['checking', 'locked'].includes(personaLock.state().status))) throw new DomainError('update.installBusy', 'update.installBusy')
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

function requireAuthenticatorVisible(): void {
  if (shuttingDown || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    throw new DomainError('AUTHENTICATOR_HIDDEN', 'AUTHENTICATOR_HIDDEN')
  }
}

async function showPendingRecoveryCode(material: { name: string; steamId: string; revocationCode: string; isolated?: boolean; receivedSteamId?: string | null }): Promise<{ shown: boolean }> {
  requireAuthenticatorVisible()
  const en = store.getLanguage() === 'en'
  const choice = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: en ? 'View private setup recovery data?' : '查看私密绑定急救资料？',
    message: `${material.name}\nSteamID ${material.steamId}`,
    detail: (en ? 'A recovery code can revoke an authenticator. Show it only on a private screen; do not send it to support or chat'
      : '急救码可能用于移除验证器，请只在私密屏幕查看，不要发给排查人员或聊天窗口') + (material.isolated
      ? en ? '\nThis material is isolated because the issued response was not a verified candidate. Do not assume it belongs to the expected account or activate it'
        : '\n这是异常响应中隔离保留的资料，不是已核实的有效候选；不能假定它属于预期账号，也不能据此激活' : ''),
    buttons: en ? ['Cancel', 'Show privately'] : ['取消', '私密显示'], defaultId: 0, cancelId: 0, noLink: true })
  if (choice.response !== 1) return { shown: false }
  requireAuthenticatorVisible()
  const shown = await dialog.showMessageBox(mainWindow!, { type: 'info', title: material.isolated ? en ? 'Isolated recovery code' : '隔离保留的急救码' : en ? 'Setup recovery code' : '绑定急救码',
    message: material.revocationCode,
    detail: `${material.name}\n${material.steamId}` + (material.receivedSteamId ? `\n${en ? 'Response identity' : '响应身份'}: ${material.receivedSteamId}` : ''),
    buttons: en ? ['Close', 'Copy recovery code'] : ['关闭', '复制急救码'], defaultId: 0, cancelId: 0, noLink: true })
  requireAuthenticatorVisible()
  if (shown.response === 1) clipboard.writeText(material.revocationCode)
  return { shown: true }
}

async function readAuthenticatorServerTime(): Promise<number> {
  if (!authenticatorTimeNetwork) throw new DomainError('AUTH_CONFIRMATION_TIME_UNAVAILABLE', 'AUTH_CONFIRMATION_TIME_UNAVAILABLE')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000)
  try { return await queryAnonymousSteamTime(authenticatorTimeNetwork.fetch, controller.signal) }
  finally { clearTimeout(timer); controller.abort() }
}

function ensureSteamSwitchIdle(): void {
  const status = gameStatus?.snapshot(), native = nativePresenceForQuit?.diagnostics(), simulation = localAppSimulation?.state(), copy = statusCopy?.state()
  if (shuttingDown || installInProgress || dataImportInProgress || screenshotImportInProgress || screenshotPresenceOperations > 0 || accountTransition.active ||
      hasNativePersonaWork() || personaLock?.state().busy || personaLock?.state().status === 'locked' ||
      native && (native.active || native.retiringCount > 0) || screenshotApiHost?.hasClientWork() || hasScreenshotIdentityWork() ||
      status && (status.busy || status.connected || status.status === 'connecting' || status.live?.patchActive || status.liveLock && status.liveLock.status !== 'stopped') ||
      simulation && (simulation.busy || simulation.appId !== null || ['starting', 'running', 'stopping'].includes(simulation.status)) ||
      copy && (copy.busy || ['previewing', 'starting', 'following', 'waiting', 'stopping'].includes(copy.phase) || copy.error?.code === 'COPY_STOP_UNCONFIRMED')) {
    throw new DomainError('STEAM_CACHE_BUSY', 'STEAM_CACHE_BUSY')
  }
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
  if (cachedAccounts?.hasWork() || exportInProgress || screenshotImportInProgress || installInProgress || accountTransition.active || activeTasks || queue.hasPendingRequests() ||
      hasNativePersonaWork() || personaLock && (personaLock.state().busy || ['checking', 'locked'].includes(personaLock.state().status)) ||
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
    energySavingEnabled: store.getEnergySavingEnabled(),
    windowCloseMode: store.getWindowCloseMode(),
    energySavingActive,
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
    const windowControl = channel.startsWith('windowUi:')
    if (cachedAccounts?.hasWork() && (screenshotImportBlocksChannel(channel) || ['account:activate', 'account:remove', 'storage:import'].includes(channel))) {
      return { ok: false, error: { code: 'STEAM_CACHE_BUSY', message: 'STEAM_CACHE_BUSY' } }
    }
    if (installInProgress && channel !== 'snapshot:get' && !hidingArtwork && !windowControl) {
      return { ok: false, error: { code: 'update.installBusy', message: 'update.installBusy' } }
    }
    if (dataImportInProgress && !hidingArtwork && !windowControl && !['snapshot:get', 'gameStatus:state', 'localAppSimulation:state', 'statusCopy:state', 'personaLock:state', 'screenshots:catalog', 'screenshots:images'].includes(channel)) {
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
    const authenticatorTransfer = ['authenticator:import', 'authenticator:export', 'authenticator:remove', 'authenticatorEnrollment:exportBackup'].includes(channel)
    if (presenceOperation) screenshotPresenceOperations++
    if (authenticatorTransfer) authenticatorFileOperations++
    try {
      const data = await operation(...args)
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
      return { ok: true, data }
    } catch (error) {
      if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' } }
      return { ok: false, error: toAppError(error) }
    } finally { if (presenceOperation) screenshotPresenceOperations--; if (authenticatorTransfer) authenticatorFileOperations-- }
  })
}

function toAppError(error: unknown): AppError {
  const language = store?.getLanguage() ?? 'zh-CN'
  if (error instanceof DiagnosticReportError) {
    const messages = {
      UNSAFE_PATH: ['请选择数据目录之外的普通本地 JSON 文件位置', 'Choose an ordinary local JSON file outside the toolbox data directory'],
      DESTINATION_EXISTS: ['该文件已存在，请换一个新文件名；原文件未修改', 'This file already exists; choose a new name. The original file was not changed'],
      READ_FAILED: ['无法安全读取诊断日志，原日志未修改', 'Diagnostic logs could not be read safely; original logs were not changed'],
      WRITE_FAILED: ['无法保存诊断日志，请检查可用空间和写入权限', 'Diagnostic logs could not be saved; check free space and write permissions']
    }
    return { code: `DIAGNOSTICS_${error.code}`, message: messages[error.code][language === 'en' ? 1 : 0]!, retryable: false }
  }
  if (error instanceof DomainError) {
    if (language === 'en' && error.code.startsWith('DIAGNOSTICS_')) {
      const messages: Record<string, string> = {
        DIAGNOSTICS_BUSY: 'Diagnostic export is already in progress; wait for it to finish',
        DIAGNOSTICS_UNSAFE_PATH: 'The diagnostic folder is not an ordinary local directory',
        DIAGNOSTICS_OPEN_FAILED: 'The diagnostic folder could not be opened'
      }
      return { code: error.code, message: messages[error.code] ?? 'Diagnostics could not be accessed safely', retryable: false }
    }
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
