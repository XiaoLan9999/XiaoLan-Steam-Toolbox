import { useEffect, useRef, useState } from 'react'
import type {
  SteamCachedAccountAction, SteamCachedAccountsApi, SteamCachedAccountsError, SteamCachedAccountsSnapshot
} from '../../../shared/steam-cached-accounts'
import { inspectStaticArtwork } from '../../../shared/artwork'
import { isEnergySavingActive, subscribeEnergySaving } from '../energy-saving'
import { useI18n, type Translate } from '../i18n'
import './game-status.css'
import './steam-account-tools.css'

export function steamCachedAccountsError(code: unknown, t: Translate): string {
  switch (code) {
    case 'STEAM_CACHE_INVALID': return t('Steam 缓存文件无法识别，未修改账号信息', 'The Steam cache could not be read; account information was not changed')
    case 'STEAM_CACHE_CHANGED': return t('本机账号列表已变化，请刷新后重新选择', 'The local account list changed; refresh it before choosing again')
    case 'STEAM_CACHE_BUSY': return t('上一项客户端操作尚未结束，请稍候', 'The previous client operation is still running')
    case 'STEAM_CACHE_GAME_RUNNING': return t('请先正常退出正在运行的 Steam 游戏，再切换账号', 'Exit running Steam games normally before switching accounts')
    case 'STEAM_CACHE_EXIT_UNCONFIRMED': return t('尚未确认 Steam 正常退出，未继续切换，也不会强制结束进程', 'Steam has not confirmed a normal exit; switching stopped without forcing the process to close')
    case 'STEAM_CACHE_LAUNCH_FAILED': return t('未能启动 Steam，请手动打开 Steam 并核对登录账号', 'Steam could not be launched; open it manually and check the selected account')
    case 'STEAM_CACHE_WRITE_FAILED': return t('未能安全保存客户端切换设置，请刷新后核对', 'The client switch settings could not be saved safely; refresh and check again')
    case 'STEAM_CACHE_CLIENT_CHANGED': return t('Steam 客户端位置或配置已变化，请刷新后重试', 'The Steam client location or configuration changed; refresh and try again')
    case 'STEAM_CACHE_RECOVERY_REQUIRED': return t('上次切换设置未完整恢复，已停止继续切换，请保留恢复记录并在 Steam 核对或人工处理', 'The previous switch settings were not fully restored; further switching has stopped. Keep the recovery record and check Steam or resolve it manually')
    case 'STEAM_CACHE_ACTIVITY_UNAVAILABLE': return t('无法可靠核实是否有游戏正在运行，未自动退出 Steam，请先手动核对', 'Running-game activity could not be verified reliably; Steam was not exited automatically, so check manually first')
    default: return t('暂时无法读取本机 Steam 缓存，请确认已安装 Steam 并在客户端登录过账号', 'The local Steam cache is unavailable; check that Steam is installed and an account has signed in through the client')
  }
}

export function staticCachedAvatarDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 350_000 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  try {
    const bytes = Uint8Array.from(atob(value.slice(value.indexOf(',') + 1)), character => character.charCodeAt(0))
    const info = inspectStaticArtwork(bytes)
    return info.width <= 512 && info.height <= 512 && value.startsWith(`data:image/${info.format === 'png' ? 'png' : 'jpeg'};`) ? value : null
  } catch { return null }
}

export function SteamCachedAccountAvatar({ api, steamId, revision, fallback, name, active }: {
  api: SteamCachedAccountsApi; steamId: string; revision: string; fallback?: string | null; name: string; active: boolean
}): React.JSX.Element {
  const [avatar, setAvatar] = useState(() => active ? staticCachedAvatarDataUrl(fallback) : null)
  const target = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    setAvatar(active ? staticCachedAvatarDataUrl(fallback) : null)
    if (!active || !api.avatar || !target.current || typeof IntersectionObserver === 'undefined') return
    let stopped = false
    let requested = false
    let inView = false
    let version = 0
    const observer = new IntersectionObserver(records => {
      if (stopped) return
      inView = records.some(record => record.isIntersecting)
      if (!inView) { version++; requested = false; setAvatar(null); return }
      if (requested || isEnergySavingActive() || typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      requested = true
      const requestVersion = ++version
      void api.avatar!({ steamId, revision }).then(value => {
        if (!stopped && inView && requestVersion === version && !isEnergySavingActive() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) setAvatar(staticCachedAvatarDataUrl(value))
      }, () => undefined)
    }, { rootMargin: '0px', threshold: 0 })
    observer.observe(target.current)
    return () => { stopped = true; observer.disconnect() }
  }, [api, steamId, revision, fallback, active])
  return <span className="steam-account-avatar" ref={target}>{avatar
    ? <img src={avatar} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setAvatar(null)} />
    : <span aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() || 'S'}</span>}</span>
}

export function SteamCachedAccountsPanel({ api, visible = true }: {
  api: SteamCachedAccountsApi
  visible?: boolean
}): React.JSX.Element {
  const { t, language } = useI18n()
  const [snapshot, setSnapshot] = useState<SteamCachedAccountsSnapshot | null>(null)
  const [operation, setOperation] = useState<'refresh' | 'switch' | 'action' | null>(null)
  const [error, setError] = useState<SteamCachedAccountsError | 'unavailable' | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ steamId: string; x: number; y: number } | null>(null)
  const [noteEditor, setNoteEditor] = useState<{ steamId: string; value: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [avatarsActive, setAvatarsActive] = useState(() => !isEnergySavingActive() && (typeof document === 'undefined' || document.visibilityState !== 'hidden'))
  const generation = useRef(0)
  const pending = useRef(false)
  const apply = (value: SteamCachedAccountsSnapshot): void => {
    setSnapshot(value)
    setSelectedId(previous => value.accounts.some(account => account.steamId === previous) ? previous : value.accounts.find(account => account.mostRecent)?.steamId ?? value.accounts[0]?.steamId ?? null)
    setMenu(null)
  }
  useEffect(() => {
    const update = (): void => setAvatarsActive(!isEnergySavingActive() && document.visibilityState !== 'hidden')
    const unsubscribe = subscribeEnergySaving(() => { if (typeof document !== 'undefined') update() })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
    return () => { unsubscribe(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    if (!menu || typeof document === 'undefined') return
    const close = (event: Event): void => {
      const element = event.target as HTMLElement | null
      if (!element?.closest?.('.steam-account-context-menu')) setMenu(null)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [menu])
  useEffect(() => {
    const epoch = ++generation.current
    setSnapshot(null); setError(null); setOperation(null); setMenu(null); setNoteEditor(null); setNotice(null); pending.current = false
    if (visible) {
      pending.current = true; setOperation('refresh')
      void api.state().then(value => {
        if (epoch === generation.current) apply(value)
      }, () => { if (epoch === generation.current) setError('unavailable') })
        .finally(() => { if (epoch === generation.current) { pending.current = false; setOperation(null) } })
    }
    return () => { generation.current++ }
  }, [api, visible])
  const busy = operation !== null || snapshot?.busy === true || snapshot?.status === 'switching'
  const run = async (steamId?: string, mode?: 'online' | 'offline'): Promise<void> => {
    if (!visible || pending.current || steamId && (busy || !snapshot?.revision || !snapshot.accounts.some(account => account.steamId === steamId))) return
    const epoch = generation.current
    pending.current = true; setOperation(steamId ? 'switch' : 'refresh'); setError(null); setNotice(null); setMenu(null)
    try {
      const value = steamId ? await api.switchAccount({ steamId, revision: snapshot!.revision, ...(mode ? { mode } : {}) }) : await api.state()
      if (epoch === generation.current) apply(value)
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null
      if (epoch === generation.current) setError(typeof code === 'string' ? code as SteamCachedAccountsError : 'unavailable')
    } finally {
      if (epoch === generation.current) { pending.current = false; setOperation(null) }
    }
  }
  const action = async (kind: SteamCachedAccountAction['action'], steamId: string, note?: string): Promise<void> => {
    if (!visible || pending.current || busy || !api.action || !snapshot?.accounts.some(account => account.steamId === steamId)) return
    const epoch = generation.current
    pending.current = true; setOperation('action'); setError(null); setNotice(null); setMenu(null)
    try {
      const result = await api.action({ steamId, revision: snapshot.revision, action: kind, ...(kind === 'note' ? { note: note ?? '' } : {}) })
      if (epoch === generation.current) {
        apply(result.state)
        if (result.performed) {
          setNotice(kind === 'hide' ? t('已从工具箱列表隐藏，未删除 Steam 登录缓存或 userdata', 'Hidden from the toolbox list; Steam login cache and userdata were not deleted')
            : kind === 'note' ? t('本地备注已保存', 'Local note saved') : kind.startsWith('copy-') ? t('已复制所选账号资料', 'Selected account information copied')
              : kind === 'shortcut' ? t('快捷方式已创建', 'Shortcut created') : t('已请求打开所选位置', 'The selected destination was requested'))
          if (kind === 'note') setNoteEditor(null)
        }
      }
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null
      if (epoch === generation.current) setError(typeof code === 'string' ? code as SteamCachedAccountsError : 'unavailable')
    } finally { if (epoch === generation.current) { pending.current = false; setOperation(null) } }
  }
  const restore = async (): Promise<void> => {
    if (!visible || pending.current || !api.restoreHidden) return
    const epoch = generation.current
    pending.current = true; setOperation('action'); setError(null); setNotice(null)
    try { const state = await api.restoreHidden(); if (epoch === generation.current) apply(state) }
    catch { if (epoch === generation.current) setError('unavailable') }
    finally { if (epoch === generation.current) { pending.current = false; setOperation(null) } }
  }
  const showMenu = (steamId: string, x: number, y: number): void => {
    if (busy || !visible) return
    setSelectedId(steamId)
    const width = typeof window === 'undefined' ? 1320 : window.innerWidth
    const height = typeof window === 'undefined' ? 860 : window.innerHeight
    setMenu({ steamId, x: Math.max(8, Math.min(x, width - 250)), y: Math.max(8, Math.min(y, height - 430)) })
  }
  const menuAccount = snapshot?.accounts.find(account => account.steamId === menu?.steamId)
  const shownError = error ?? snapshot?.error
  return <section className="game-status-panel steam-cached-accounts-panel" hidden={!visible} aria-label={t('Steam 客户端缓存账号', 'Steam client cached accounts')}>
    <header className="game-status-heading"><div><span className="game-status-eyebrow">STEAM CLIENT</span>
      <h2>{t('客户端账号切换', 'Client account switching')}</h2>
      <p>{t('查看本机 Steam 记住的账号，再由你选择切换', 'View accounts remembered by the local Steam client and choose when to switch')}</p>
    </div><span className="game-status-badge">{t('本机缓存，不是工具箱账号', 'Local cache, not toolbox accounts')}</span></header>
    <section className="game-status-card">
      <div className="game-status-section-title"><div><h3>{t('Steam 记住的账号', 'Accounts remembered by Steam')}</h3>
        <p>{t('这里不会切换工具箱当前账号，也不会导入或复制账号密码', 'This does not change the current toolbox account or import or copy account passwords')}</p></div>
        <button disabled={operation !== null || !visible} onClick={() => void run()}>{operation === 'refresh' ? t('正在读取…', 'Reading…') : t('刷新列表', 'Refresh list')}</button>
      </div>
      <details className="game-status-notice info steam-account-switch-help"><summary><strong>{t('切换前需要正常退出 Steam', 'Steam must exit normally before switching')}</strong>{' · '}{t('缓存失效时仍需验证', 'Expired cache still requires verification')}</summary>
        <p>{t('点击切换后，在系统确认窗口中核对目标账号。工具箱只请求 Steam 正常退出，不强制结束游戏或 Steam', 'After clicking Switch, review the target account in the native confirmation window. The toolbox requests a normal Steam exit without force-closing games or Steam')}</p>
        <p>{t('即使账号显示已记住，登录缓存缺失或失效时，Steam 仍可能要求密码或 Steam 令牌验证', 'Even remembered accounts may need a password or Steam Guard verification when the login cache is missing or expired')}</p>
      </details>
      {snapshot && <p className="game-status-live-meta">{snapshot.steamRunning ? t('检测到 Steam 正在运行', 'Steam is currently running') : t('未检测到运行中的 Steam', 'No running Steam client detected')}{' · '}{t(`${snapshot.accounts.length} 个本机账号`, `${snapshot.accounts.length} local accounts`)}</p>}
      {snapshot?.status === 'awaiting-login' && <p className="game-status-notice info" role="status">{t('已请求启动 Steam，请在客户端核对账号并完成可能出现的验证；这不代表已登录成功', 'Steam was asked to launch; check the account and complete any verification in the client. This does not confirm a successful sign-in')}</p>}
      {snapshot?.status === 'cancelled' && <p className="game-status-notice info" role="status">{t('已取消本次切换', 'This switch was cancelled')}</p>}
      {shownError && <p className="game-status-notice error" role="alert">{steamCachedAccountsError(shownError, t)}</p>}
      {notice && <p className="game-status-notice success" role="status">{notice}</p>}
      {Boolean(snapshot?.hiddenCount) && api.restoreHidden && <div className="game-status-actions"><button disabled={operation !== null || !visible} onClick={() => void restore()}>{t(`显示已隐藏账号（${snapshot!.hiddenCount}）`, `Show hidden accounts (${snapshot!.hiddenCount})`)}</button></div>}
      <p className="game-status-help">{t('单击卡片只选择账号；通过“切换”或右键菜单执行操作。头像仅使用本机缓存的静态图片，不加载动画头像框', 'Clicking a card only selects it; use Switch or its context menu to act. Avatars use static local cache images only, without animated avatar frames')}</p>
      {snapshot && snapshot.accounts.length > 0 ? <div className="steam-account-grid" aria-label={t('本机账号卡片', 'Local account cards')}>
        {snapshot.accounts.map(account => <article key={account.steamId} className={`steam-account-card${selectedId === account.steamId ? ' selected' : ''}`}
          onContextMenu={event => { event.preventDefault(); showMenu(account.steamId, event.clientX, event.clientY) }}>
          <button className="steam-account-select" aria-pressed={selectedId === account.steamId} aria-label={t(`选择账号 ${account.accountName || account.displayName}`, `Select account ${account.accountName || account.displayName}`)}
            onClick={() => { setSelectedId(account.steamId); setMenu(null) }}>
            <SteamCachedAccountAvatar api={api} steamId={account.steamId} revision={snapshot.revision} fallback={account.avatarDataUrl} name={account.displayName || account.accountName} active={visible && avatarsActive} />
            <span className="steam-account-name" title={account.note || account.displayName || account.accountName}>{account.note || account.displayName || account.accountName}</span>
            <small className="steam-account-login">{account.accountName}</small>
          </button>
          <div className="steam-account-card-details"><code className="steam-account-id">{account.steamId}</code>
            <span>{account.remembered ? t('已记住账号', 'Account remembered') : t('可能需要验证', 'Verification may be needed')}</span>
            {account.lastLoginAt && Number.isFinite(Date.parse(account.lastLoginAt)) && <time dateTime={account.lastLoginAt}>{new Date(account.lastLoginAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</time>}
            {account.mostRecent && <strong>{t('上次使用', 'Most recently used')}</strong>}</div>
          <div className="steam-account-card-actions"><button className="primary" disabled={busy || !visible || !snapshot.revision} aria-label={t(`切换 Steam 到 ${account.accountName || account.displayName}`, `Switch Steam to ${account.accountName || account.displayName}`)}
            onClick={() => void run(account.steamId)}>{operation === 'switch' ? t('切换中…', 'Switching…') : t('切换', 'Switch')}</button>
            <button className="ghost steam-account-more" disabled={busy || !visible} aria-label={t(`${account.accountName || account.displayName} 的更多操作`, `More actions for ${account.accountName || account.displayName}`)} aria-haspopup="menu"
              onClick={event => { const box = event.currentTarget.getBoundingClientRect(); showMenu(account.steamId, box.right, box.bottom) }}>…</button></div>
        </article>)}
      </div> : !busy && !shownError && <div className="game-status-empty"><h3>{t('暂无可读取的客户端账号', 'No cached client accounts found')}</h3>
        <p>{t('先在 Steam 客户端登录并记住账号，然后刷新列表；不会自动扫描其它目录或获取密码', 'Sign in through Steam and let the client remember the account, then refresh this list. No other directories or passwords are scanned')}</p></div>}
    </section>
    {menu && menuAccount && <div className="steam-account-context-menu" role="menu" aria-label={t('账号操作菜单', 'Account actions menu')} style={{ left: menu.x, top: menu.y }}>
      <strong>{menuAccount.note || menuAccount.displayName || menuAccount.accountName}</strong>
      <details><summary>{t('启动方式', 'Launch mode')}</summary><button role="menuitem" onClick={() => void run(menuAccount.steamId, 'online')}>{t('在线方式启动', 'Start in online mode')}</button>
        <button role="menuitem" onClick={() => void run(menuAccount.steamId, 'offline')}>{t('离线方式启动', 'Start in offline mode')}</button></details>
      {api.action && <><details><summary>{t('复制账号资料', 'Copy account information')}</summary>
        <button role="menuitem" onClick={() => void action('copy-id', menuAccount.steamId)}>{t('复制 SteamID', 'Copy SteamID')}</button>
        <button role="menuitem" onClick={() => void action('copy-login', menuAccount.steamId)}>{t('复制登录账号', 'Copy login name')}</button>
        <button role="menuitem" onClick={() => void action('copy-name', menuAccount.steamId)}>{t('复制显示名称', 'Copy display name')}</button></details>
        <button role="menuitem" onClick={() => void action('profile', menuAccount.steamId)}>{t('打开 Steam 个人资料', 'Open Steam profile')}</button>
        <button role="menuitem" onClick={() => { setNoteEditor({ steamId: menuAccount.steamId, value: menuAccount.note || '' }); setMenu(null) }}>{t('修改本地备注', 'Edit local note')}</button>
        <button role="menuitem" onClick={() => void action('shortcut', menuAccount.steamId)}>{t('创建切换快捷方式', 'Create switch shortcut')}</button>
        <button role="menuitem" onClick={() => void action('userdata', menuAccount.steamId)}>{t('打开 userdata', 'Open userdata')}</button>
        <button className="danger-text" role="menuitem" onClick={() => void action('hide', menuAccount.steamId)}>{t('从工具箱隐藏', 'Hide from toolbox')}</button></>}
    </div>}
    {noteEditor && <div className="modal-backdrop"><section className="modal steam-account-note-dialog" role="dialog" aria-modal="true" aria-label={t('修改本地备注', 'Edit local note')}>
      <h3>{t('本地备注', 'Local note')}</h3><p>{t('仅在工具箱中显示，不修改 Steam 昵称', 'Shown only in the toolbox; the Steam display name is unchanged')}</p>
      <textarea aria-label={t('账号本地备注', 'Local account note')} maxLength={80} value={noteEditor.value} disabled={busy} onChange={event => setNoteEditor({ ...noteEditor, value: event.target.value })} />
      <div className="game-status-actions"><button disabled={busy} onClick={() => setNoteEditor(null)}>{t('取消', 'Cancel')}</button><button className="primary" disabled={busy || noteEditor.value.length > 80} onClick={() => void action('note', noteEditor.steamId, noteEditor.value)}>{t('保存备注', 'Save note')}</button></div>
    </section></div>}
  </section>
}
