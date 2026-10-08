import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccountView, AppEvent, AppSnapshot } from '../../shared/types'
import { APP_NAME_EN, APP_NAME_ZH, AUTHOR_NAME, AUTHOR_WEBSITE_URL } from '../../shared/branding'
import { ComposerPanel } from './components/ComposerPanel'
import { FriendsPanel } from './components/FriendsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { LoginModal } from './components/LoginModal'
import { SettingsModal } from './components/SettingsModal'
import ArtworkToolsPanel from './components/ArtworkToolsPanel'
import { I18nProvider, type Translate } from './i18n'
import { avatarFallback, unwrap } from './ui'

type Tab = 'friends' | 'compose' | 'history' | 'tools'

interface Toast {
  id: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('friends')
  const [selectedFriends, setSelectedFriends] = useState<Set<string>>(new Set())
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const refreshSequence = useRef(0)
  const language = snapshot?.language ?? 'zh-CN'
  const t: Translate = (zh, en) => language === 'en' ? en : zh

  const pushToast = useCallback((message: string, level: Toast['level'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current.slice(-3), { id, level, message }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 5_000)
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    const result = await window.steamCommenter.getSnapshot()
    if (sequence !== refreshSequence.current) return
    try {
      const next = unwrap(result)
      document.documentElement.lang = next.language
      document.title = next.language === 'en' ? APP_NAME_EN : APP_NAME_ZH
      setSnapshot(next)
      setFatalError(null)
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.steamCommenter.onEvent((event: AppEvent) => {
      if (event.type === 'snapshotChanged' || event.type === 'batchProgress') void refresh()
      if (event.type === 'notice') pushToast(event.message, event.level)
    })
  }, [pushToast, refresh])

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
    if (!window.confirm(t(`确定忘记账号“${account.displayName}”吗？本地分组、黑名单、好友历史、检查任务、缓存和发送记录会一并删除。`,
      `Forget "${account.displayName}"? Its local groups, blacklist, friend history, checks, cache and delivery history will also be deleted.`))) {
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
        <div className="steam-mark">S</div>
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
          <div className="brand-mark">S</div>
          <div>
            <strong>{t(APP_NAME_ZH, APP_NAME_EN)}</strong>
            <span>{t('好友管理与艺术作品小工具', 'Friends and artwork tools')}</span>
          </div>
        </div>

        <button className={`sidebar-tools-button ${tab === 'tools' ? 'active' : ''}`} onClick={() => setTab('tools')}>
          {t('艺术作品与小工具', 'Artwork & tools')}
        </button>
        {tab === 'tools' && activeAccount && <button className="sidebar-tools-button" onClick={() => setTab('friends')}>
          {t('返回好友管理', 'Back to friends')}
        </button>}

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
            {t('设置 / 语言 / 导出数据', 'Settings / Language / Export')}
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
        {tab === 'tools' ? (
          <>
            <header className="topbar tools-topbar">
              <div><h1>{t('艺术作品与小工具', 'Artwork & tools')}</h1><p>{t('长图上传助手 · 背景裁剪预览', 'Long artwork assistant · Background crop preview')}</p></div>
              <button className="ghost" onClick={() => setTab('friends')}>{t('返回', 'Back')}</button>
            </header>
            <section className="content"><ArtworkToolsPanel /></section>
          </>
        ) : activeAccount ? (
          <>
            <header className="topbar">
              <div>
                <h1>{activeAccount.displayName}</h1>
                <p>
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
                  {t('发送记录', 'History')}
                </button>
              </nav>
            </header>

            <section className="content">
              {activeAccount.sessionState !== 'authenticated' && (
                <div className="session-banner">
                  <div>
                    <strong>{t('当前账号未连接', 'Account is disconnected')}</strong>
                    <span>{activeAccount.sessionMessage ?? t('重新登录后才可同步或留言', 'Sign in again to sync or post comments')}</span>
                  </div>
                  <button onClick={() => setLoginOpen(true)}>{t('重新登录', 'Sign in again')}</button>
                </div>
              )}
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
                  runAction={runAction}
                />
              )}
              {tab === 'history' && <HistoryPanel snapshot={snapshot} />}
            </section>
          </>
        ) : (
          <section className="welcome">
            <div className="welcome-orbit">
              <div>S</div>
            </div>
            <p className="eyebrow">LOCAL-FIRST STEAM TOOL</p>
            <h1>{t('先连接一个 Steam 账号', 'Connect a Steam account')}</h1>
            <p>{t('使用 Steam 手机应用扫码最安全。应用只保存 DPAPI 加密后的自动登录令牌，不保存密码。', 'Scan with the Steam mobile app. Only DPAPI-encrypted login tokens are stored, never passwords.')}</p>
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
