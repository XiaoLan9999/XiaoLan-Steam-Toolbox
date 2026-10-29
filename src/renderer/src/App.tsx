import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccountView, AppEvent, AppSnapshot } from '../../shared/types'
import { APP_NAME_EN, APP_NAME_ZH, AUTHOR_NAME, AUTHOR_WEBSITE_URL } from '../../shared/branding'
import { AppLogo } from './components/AppLogo'
import { ComposerPanel } from './components/ComposerPanel'
import { FriendsPanel } from './components/FriendsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { LoginModal } from './components/LoginModal'
import { SettingsModal } from './components/SettingsModal'
import ArtworkToolsPanel from './components/ArtworkToolsPanel'
import { AccountStatusPanel } from './components/AccountStatusPanel'
import { UpdateNotice } from './components/UpdateNotice'
import { hasAvailableUpdate } from './update-notification'
import ScreenshotToolsPanel from './components/ScreenshotToolsPanel'
import { GameStatusPanel } from './components/GameStatusPanel'
import { WelcomePanel } from './components/WelcomePanel'
import { SessionRecoveryNotice } from './components/SessionRecoveryNotice'
import type { GameStatusApi } from '../../shared/game-status'
import type { LocalAppSimulationApi } from '../../shared/local-app-simulation'
import type { StatusCopyApi } from '../../shared/status-copy'
import { I18nProvider, type Translate } from './i18n'
import { avatarFallback, unwrap } from './ui'
import { applyBatchProgress, applyProgressUpdates, createSnapshotRefresh, type BatchProgressUpdate } from './snapshot-refresh'
import { applyFriendPolicy, applyFriendPolicyUpdates, type FriendPolicyUpdate } from './friend-policy-updates'
import { applyTheme, normalizeTheme, restoreCachedTheme } from './theme'
import { createRendererEnergySaver, type RendererEnergySaver } from './energy-saving'
import './task-list.css'
import './theme.css'
import './energy-saving.css'

restoreCachedTheme()

type Tab = 'home' | 'friends' | 'compose' | 'history' | 'tools' | 'screenshots' | 'game-status'

const gameStatusApi: GameStatusApi = {
  state: async () => unwrap(await window.steamCommenter.gameStatus.state()),
  connectLocal: async input => unwrap(await window.steamCommenter.gameStatus.connectLocal(input)),
  connectWithToolbox: async input => unwrap(await window.steamCommenter.gameStatus.connectWithToolbox(input)),
  play: async input => unwrap(await window.steamCommenter.gameStatus.play(input)),
  stop: async input => unwrap(await window.steamCommenter.gameStatus.stop(input)),
  logout: async input => unwrap(await window.steamCommenter.gameStatus.logout(input)),
  observeLive: async input => unwrap(await window.steamCommenter.gameStatus.observeLive(input)),
  patchLive: async input => unwrap(await window.steamCommenter.gameStatus.patchLive(input)),
  restoreLive: async input => unwrap(await window.steamCommenter.gameStatus.restoreLive(input)),
  inspectApp: async input => unwrap(await window.steamCommenter.gameStatus.inspectApp(input)),
  lockLive: async input => unwrap(await window.steamCommenter.gameStatus.lockLive(input)),
  unlockLive: async input => unwrap(await window.steamCommenter.gameStatus.unlockLive(input)),
  setLiveDisplay: async input => unwrap(await window.steamCommenter.gameStatus.setLiveDisplay(input)),
  loadDraft: async input => unwrap(await window.steamCommenter.gameStatus.loadDraft(input)),
  saveDraft: async input => unwrap(await window.steamCommenter.gameStatus.saveDraft(input)),
  onChange: callback => window.steamCommenter.onEvent(event => { if (event.type === 'gameStatusChanged') callback(event.state) })
}
const localAppSimulationApi: LocalAppSimulationApi | undefined = window.steamCommenter.localAppSimulation ? {
  state: async () => unwrap(await window.steamCommenter.localAppSimulation!.state()),
  inspect: async input => unwrap(await window.steamCommenter.localAppSimulation!.inspect(input)),
  start: async input => unwrap(await window.steamCommenter.localAppSimulation!.start(input)),
  stop: async input => unwrap(await window.steamCommenter.localAppSimulation!.stop(input)),
  onChange: callback => window.steamCommenter.onEvent(event => { if (event.type === 'localAppSimulationChanged') callback(event.state) })
} : undefined
const statusCopyApi: StatusCopyApi | undefined = window.steamCommenter.statusCopy ? {
  state: async () => unwrap(await window.steamCommenter.statusCopy!.state()),
  save: async input => unwrap(await window.steamCommenter.statusCopy!.save(input)),
  preview: async input => unwrap(await window.steamCommenter.statusCopy!.preview(input)),
  start: async input => unwrap(await window.steamCommenter.statusCopy!.start(input)),
  stop: async input => unwrap(await window.steamCommenter.statusCopy!.stop(input)),
  onChange: callback => window.steamCommenter.onEvent(event => { if (event.type === 'statusCopyChanged') callback(event.state) })
} : undefined

interface Toast {
  id: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

interface RefreshValue { snapshot: AppSnapshot; batchRevision: number; energyRevision: number }

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [selectedFriends, setSelectedFriends] = useState<Set<string>>(new Set())
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const refreshController = useRef<ReturnType<typeof createSnapshotRefresh<RefreshValue>> | null>(null)
  const batchRevision = useRef(0)
  const progressUpdates = useRef(new Map<string, BatchProgressUpdate>())
  const friendPolicyUpdates = useRef(new Map<string, FriendPolicyUpdate>())
  const energySaver = useRef<RendererEnergySaver | null>(null)
  const backgroundUi = useRef(false)
  const backgroundDirty = useRef(false)
  const initialSnapshotLoaded = useRef(false)
  const energyRevision = useRef(0)
  const latestEnergy = useRef<{ enabled: boolean; active: boolean } | null>(null)
  const selectedAccountId = useRef(snapshot?.activeAccountId ?? null)
  selectedAccountId.current = snapshot?.activeAccountId ?? null
  const language = snapshot?.language ?? 'zh-CN'
  const t: Translate = (zh, en) => language === 'en' ? en : zh

  const pushToast = useCallback((message: string, level: Toast['level'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current.slice(-3), { id, level, message }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 5_000)
  }, [])

  const refresh = useCallback(() => {
    if (backgroundUi.current && initialSnapshotLoaded.current) {
      backgroundDirty.current = true
      return Promise.resolve()
    }
    return refreshController.current?.refresh() ?? Promise.resolve()
  }, [])

  useEffect(() => {
    let mounted = true
    const saver = createRendererEnergySaver({ onChange: active => {
      if (!mounted) return
      backgroundUi.current = active
      if (active) backgroundDirty.current = true
      if (!active && backgroundDirty.current) {
        backgroundDirty.current = false
        void refreshController.current?.refresh()
      }
    } })
    energySaver.current = saver
    return () => { mounted = false; saver.dispose(); if (energySaver.current === saver) energySaver.current = null }
  }, [])

  useEffect(() => {
    energySaver.current?.update(snapshot?.energySavingEnabled !== false, snapshot?.energySavingActive === true)
  }, [snapshot?.energySavingEnabled, snapshot?.energySavingActive])

  useEffect(() => {
    const controller = createSnapshotRefresh(async () => {
      const revision = batchRevision.current
      const loadedEnergyRevision = energyRevision.current
      return { snapshot: unwrap(await window.steamCommenter.getSnapshot()), batchRevision: revision, energyRevision: loadedEnergyRevision }
    }, ({ snapshot: loaded, batchRevision: revision, energyRevision: loadedEnergyRevision }) => {
      const energy = latestEnergy.current
      const next = energy && loadedEnergyRevision < energyRevision.current
        ? { ...loaded, energySavingEnabled: energy.enabled, energySavingActive: energy.active } : loaded
      energySaver.current?.update(next.energySavingEnabled !== false, next.energySavingActive === true)
      if (backgroundUi.current && initialSnapshotLoaded.current) {
        backgroundDirty.current = true
        return
      }
      initialSnapshotLoaded.current = true
      document.documentElement.lang = next.language
      document.title = next.language === 'en' ? APP_NAME_EN : APP_NAME_ZH
      applyTheme(normalizeTheme(next.theme))
      for (const [id, update] of friendPolicyUpdates.current) {
        if (update.revision <= revision || update.policy.accountId !== next.activeAccountId) friendPolicyUpdates.current.delete(id)
      }
      setSnapshot(() => applyFriendPolicyUpdates(applyProgressUpdates(next, progressUpdates.current.values(), revision),
        friendPolicyUpdates.current.values(), revision))
      setFatalError(null)
    }, error => {
      setFatalError(error instanceof Error ? error.message : String(error))
    })
    refreshController.current = controller
    void controller.refresh()
    const unsubscribe = window.steamCommenter.onEvent((event: AppEvent) => {
      if (event.type === 'energySavingChanged') {
        energyRevision.current += 1
        latestEnergy.current = { enabled: event.enabled, active: event.active }
        energySaver.current?.update(event.enabled, event.active)
        setSnapshot(current => current ? { ...current, energySavingEnabled: event.enabled, energySavingActive: event.active } : current)
        return
      }
      if (backgroundUi.current && ['snapshotChanged', 'friendPolicyChanged', 'batchProgress', 'updateChanged'].includes(event.type)) {
        backgroundDirty.current = true
        return
      }
      if (event.type === 'snapshotChanged') void controller.refresh()
      if (event.type === 'friendPolicyChanged' && event.policy.accountId === selectedAccountId.current) {
        batchRevision.current += 1
        friendPolicyUpdates.current.set(event.policy.steamId, { policy: event.policy, revision: batchRevision.current })
        setSnapshot(current => current ? applyFriendPolicy(current, event.policy) : current)
      }
      if (event.type === 'batchProgress') {
        if (event.summary !== undefined) {
          batchRevision.current += 1
          progressUpdates.current.delete(event.batchId)
          progressUpdates.current.set(event.batchId, { batchId: event.batchId, summary: event.summary, revision: batchRevision.current })
          if (progressUpdates.current.size > 32) progressUpdates.current.delete(progressUpdates.current.keys().next().value!)
          setSnapshot(current => current ? applyBatchProgress(current, event.batchId, event.summary!) : current)
        }
        else void controller.refresh()
      }
      if (event.type === 'updateChanged') setSnapshot((current) => current ? { ...current, updater: event.state } : current)
      if (event.type === 'notice') pushToast(event.message, event.level)
    })
    return () => {
      unsubscribe()
      controller.dispose()
      if (refreshController.current === controller) refreshController.current = null
    }
  }, [pushToast])

  useEffect(() => {
    setSelectedFriends(new Set())
  }, [snapshot?.activeAccountId])

  const activeAccount = useMemo(
    () => snapshot?.accounts.find((account) => account.id === snapshot.activeAccountId) ?? null,
    [snapshot]
  )

  const runAction = useCallback(
    async <T,>(label: string, action: () => Promise<T>, successMessage?: string): Promise<T | null> => {
      setBusy(label)
      try {
        const value = await action()
        if (successMessage) pushToast(successMessage, 'success')
        await refresh()
        return value
      } catch (error) {
        pushToast(error instanceof Error ? error.message : String(error), 'error')
        return null
      } finally {
        setBusy(null)
      }
    },
    [pushToast, refresh]
  )

  const activateAccount = async (account: AccountView): Promise<void> => {
    if (account.id === snapshot?.activeAccountId) return
    setSelectedFriends(new Set())
    await runAction(t('正在切换账号', 'Switching accounts'), async () => unwrap(await window.steamCommenter.activateAccount(account.id)))
  }

  const removeAccount = async (account: AccountView): Promise<void> => {
    if (!window.confirm(t(`确定忘记账号“${account.displayName}”吗？本地分组、黑名单、好友历史、检查任务、缓存、发送记录和复制状态配置会一并删除`,
      `Forget "${account.displayName}"? Its local groups, blacklist, friend history, checks, cache, delivery history and status-copy settings will also be deleted`))) {
      return
    }
    await runAction(
      t('正在删除账号', 'Removing account'),
      async () => unwrap(await window.steamCommenter.removeAccount(account.id)),
      t('账号已从本机删除', 'Account removed from this computer')
    )
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <AppLogo className="steam-mark" size={56} />
        <h1>{t(APP_NAME_ZH, APP_NAME_EN)}</h1>
        <p>{fatalError ?? t('正在读取本地数据...', 'Loading local data...')}</p>
        {fatalError && <button onClick={() => void refresh()}>{t('重试', 'Retry')}</button>}
      </main>
    )
  }

  return (
    <I18nProvider language={language}><div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <AppLogo className="brand-mark" size={38} />
          <div>
            <strong>{t(APP_NAME_ZH, APP_NAME_EN)}</strong>
            <span>{t('好友管理 · 艺术作品 · 截图工具', 'Friends · Artwork · Screenshots')}</span>
          </div>
        </div>

        <button className={`sidebar-tools-button ${tab === 'home' ? 'active' : ''}`} onClick={() => setTab('home')}>
          {t('欢迎首页', 'Welcome home')}
        </button>
        <button className={`sidebar-tools-button ${['friends', 'compose', 'history'].includes(tab) ? 'active' : ''}`} onClick={() => setTab('friends')}>
          {t('好友留言板', 'Friend comments')}
        </button>
        <button className={`sidebar-tools-button ${tab === 'tools' ? 'active' : ''}`} onClick={() => setTab('tools')}>
          {t('艺术作品与小工具', 'Artwork & tools')}
        </button>
        <button className={`sidebar-tools-button ${tab === 'screenshots' ? 'active' : ''}`} onClick={() => setTab('screenshots')}>
          {t('Steam 截图工具', 'Steam screenshots')}
        </button>
        <button className={`sidebar-tools-button ${tab === 'game-status' ? 'active' : ''}`} onClick={() => setTab('game-status')}>
          {t('游戏状态与自定义', 'Game status & presence')}
        </button>

        <div className="sidebar-heading">
          <span>{t('STEAM 账号', 'STEAM ACCOUNTS')}</span>
          <button className="icon-button" title={t('添加账号', 'Add account')} onClick={() => setLoginOpen(true)}>
            +
          </button>
        </div>
        <div className="account-list">
          {snapshot.accounts.map((account) => (
            <button
              className={`account-card ${account.id === snapshot.activeAccountId ? 'active' : ''}`}
              key={account.id}
              onClick={() => void activateAccount(account)}
            >
              <Avatar account={account} />
              <span className="account-copy">
                <strong>{account.displayName}</strong>
                <small>
                  <i className={`status-dot ${account.sessionState}`} />
                  {sessionLabel(account, t)}
                </small>
              </span>
              <span
                className="account-remove"
                role="button"
                title={t('忘记账号', 'Forget account')}
                onClick={(event) => {
                  event.stopPropagation()
                  void removeAccount(account)
                }}
              >
                ×
              </span>
            </button>
          ))}
          {snapshot.accounts.length === 0 && (
            <button className="empty-account" onClick={() => setLoginOpen(true)}>
              <span>+</span>
              {t('添加第一个 Steam 账号', 'Add your first Steam account')}
            </button>
          )}
        </div>

        {activeAccount && <AccountStatusPanel key={activeAccount.id} account={activeAccount} runAction={runAction} />}
        <UpdateNotice state={snapshot.updater} onOpenSettings={() => setSettingsOpen(true)} />
        <div className="sidebar-footer">
          <span className={snapshot.security.secretStorageAvailable ? 'secure' : 'warning'}>
            {snapshot.security.secretStorageAvailable ? t('● 登录令牌已加密', '● Login tokens encrypted') : t('● 安全存储不可用', '● Secure storage unavailable')}
          </span>
          <small>{snapshot.security.secretStorageBackend}</small>
          <button
            className="data-directory-link"
            title={snapshot.dataDirectory}
            onClick={() => setSettingsOpen(true)}
          >
            {t('设置 / 更新 / 语言 / 数据', 'Settings / Updates / Data')}
            {hasAvailableUpdate(snapshot.updater) && <b className="update-sidebar-badge" aria-label={t('有新版本可更新', 'A new version is available')} title={t(`新版本 v${snapshot.updater.latestVersion}`, `New version v${snapshot.updater.latestVersion}`)}>NEW</b>}
          </button>
          <a
            className="author-watermark"
            href={AUTHOR_WEBSITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={t(`访问 ${AUTHOR_NAME} 的网站（在浏览器中打开）`, `Open ${AUTHOR_NAME}'s website in your browser`)}
          >
            <span>{t('作者', 'By')}</span> {AUTHOR_NAME}
          </a>
        </div>
      </aside>

      <main className="workspace">
        {tab === 'home' ? <WelcomePanel snapshot={snapshot} onNavigate={setTab} onLogin={() => setLoginOpen(true)} onSettings={() => setSettingsOpen(true)}
          connectionNotice={activeAccount && <SessionRecoveryNotice account={activeAccount} busy={Boolean(busy)}
            onRetry={() => void runAction(t('正在重新连接保存的账号', 'Reconnecting the saved account'), async () => unwrap(await window.steamCommenter.refreshAccountStatus(activeAccount.id)))}
            onSignIn={() => setLoginOpen(true)} />} /> : tab === 'game-status' ? (
          <>
            <header className="topbar tools-topbar">
              <div><h1>{t('游戏状态与自定义', 'Game status & presence')}</h1><p>{t('自定义游戏显示 · 实际游玩参数实验性修改', 'Custom game presence · Experimental live-game status editing')}</p></div>
              <button className="ghost" onClick={() => setTab('home')}>{t('返回首页', 'Back home')}</button>
            </header>
            <section className="content"><GameStatusPanel activeAccount={activeAccount} api={gameStatusApi} localSimulationApi={localAppSimulationApi} statusCopyApi={statusCopyApi} /></section>
          </>
        ) : tab === 'screenshots' ? (
          <>
            <header className="topbar tools-topbar">
              <div><h1>{t('Steam 截图工具', 'Steam screenshots')}</h1><p>{t('选择用户与游戏 · 准备本地截图 · 从 Steam 上传', 'Choose a user and game · Prepare screenshots · Upload from Steam')}</p></div>
              <button className="ghost" onClick={() => setTab('home')}>{t('返回首页', 'Back home')}</button>
            </header>
            <section className="content"><ScreenshotToolsPanel visible={!settingsOpen && !loginOpen} runAction={runAction} /></section>
          </>
        ) : tab === 'tools' ? (
          <>
            <header className="topbar tools-topbar">
              <div><h1>{t('艺术作品与小工具', 'Artwork & tools')}</h1><p>{t('长图上传助手 · 背景裁剪预览', 'Long artwork assistant · Background crop preview')}</p></div>
              <button className="ghost" onClick={() => setTab('home')}>{t('返回首页', 'Back home')}</button>
            </header>
            <section className="content"><ArtworkToolsPanel account={activeAccount} visible={!settingsOpen && !loginOpen && !busy} /></section>
          </>
        ) : activeAccount ? (
          <>
            <header className="topbar">
              <div>
                <h1>{t('好友留言板', 'Friend comments')}</h1>
                <p>
                  {activeAccount.displayName} · {' '}
                  {t(`${snapshot.friends.length} 位好友 · ${snapshot.groups.length} 个本地分组`, `${snapshot.friends.length} friends · ${snapshot.groups.length} local groups`)}
                </p>
              </div>
              <nav className="tabs">
                <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
                  {t('好友与分组', 'Friends & groups')}
                </button>
                <button className={tab === 'compose' ? 'active' : ''} onClick={() => setTab('compose')}>
                  {t('批量留言', 'Compose')}
                  {selectedFriends.size > 0 && <b>{selectedFriends.size}</b>}
                </button>
                <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
                  {t('任务列表', 'Tasks')}
                </button>
              </nav>
            </header>

            <section className="content">
              <SessionRecoveryNotice account={activeAccount} busy={Boolean(busy)}
                onRetry={() => void runAction(t('正在重新连接保存的账号', 'Reconnecting the saved account'), async () => unwrap(await window.steamCommenter.refreshAccountStatus(activeAccount.id)))}
                onSignIn={() => setLoginOpen(true)} />
              {tab === 'friends' && (
                <FriendsPanel
                  snapshot={snapshot}
                  selected={selectedFriends}
                  onSelectedChange={setSelectedFriends}
                  onCompose={() => setTab('compose')}
                  runAction={runAction}
                />
              )}
              {tab === 'compose' && (
                <ComposerPanel
                  snapshot={snapshot}
                  selected={selectedFriends}
                  onSelectedChange={setSelectedFriends}
                  onOpenFriends={() => setTab('friends')}
                  onOpenTasks={() => setTab('history')}
                  runAction={runAction}
                />
              )}
              {tab === 'history' && <HistoryPanel snapshot={snapshot} runAction={runAction} />}
            </section>
          </>
        ) : (
          <section className="welcome">
            <div className="welcome-orbit">
              <div>S</div>
            </div>
            <p className="eyebrow">LOCAL-FIRST STEAM TOOL</p>
            <h1>{t('先连接一个 Steam 账号', 'Connect a Steam account')}</h1>
            <p>{t('使用 Steam 手机应用扫码最安全。应用只保存 DPAPI 加密后的自动登录令牌，不保存密码', 'Scan with the Steam mobile app. Only DPAPI-encrypted login tokens are stored, never passwords')}</p>
            <button className="primary" onClick={() => setLoginOpen(true)}>
              {t('添加 Steam 账号', 'Add Steam account')}
            </button>
            <button className="ghost welcome-tools-button" onClick={() => setTab('tools')}>
              {t('先使用艺术作品小工具', 'Try artwork tools first')}
            </button>
          </section>
        )}
      </main>

      {busy && (
        <div className="busy-overlay">
          <div className="spinner" />
          <span>{busy}</span>
        </div>
      )}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div className={`toast ${toast.level}`} key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={refresh} />
      {settingsOpen && <SettingsModal snapshot={snapshot} onClose={() => setSettingsOpen(false)} runAction={runAction} />}
    </div></I18nProvider>
  )
}

function Avatar({ account }: { account: AccountView }): React.JSX.Element {
  return account.avatarUrl ? (
    <img className="avatar" src={account.avatarUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar fallback">{avatarFallback(account.displayName)}</span>
  )
}

function sessionLabel(account: AccountView, t: Translate): string {
  switch (account.sessionState) {
    case 'authenticated':
      return t('已登录', 'Signed in')
    case 'restoring':
      return t('正在恢复', 'Restoring')
    case 'expired':
      return t('需要登录', 'Sign-in required')
    case 'error':
      return t('连接错误', 'Connection error')
    default:
      return t('未连接', 'Disconnected')
  }
}
