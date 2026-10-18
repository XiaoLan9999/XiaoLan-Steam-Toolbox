import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import type { GameStatusAction, GameStatusApi, GameStatusDraft, GameStatusLiveSnapshot, GameStatusOperation, GameStatusSnapshot } from '../../../shared/game-status'
import { useI18n, type Translate } from '../i18n'
import './game-status.css'

export interface GameStatusPanelProps { activeAccount: AccountView | null; api: GameStatusApi }
type Tab = 'simulate' | 'live' | 'draft'
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null
const EMPTY_DRAFT: GameStatusDraft = { displayKind: 'custom', gameName: '', details: '' }
const ROOMS = [
  ['bronze', '铜之间', 'Bronze Room'], ['silver', '银之间', 'Silver Room'], ['gold', '金之间', 'Gold Room'],
  ['jade', '玉之间', 'Jade Room'], ['throne', '王座之间', 'Throne Room']
] as const

export function gameStatusError(error: unknown, t: Translate): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (/ACCOUNT|IDENTITY|WRONG_STEAM/.test(code)) return t('账号身份已变化或不匹配，请重新选中账号，再使用工具箱账号连接。', 'The account changed or its identity does not match. Select it again and connect with the toolbox account.')
  if (/SESSION|SNAPSHOT|EPOCH|CONFLICT/.test(code)) return t('账号或游戏快照已变化，未继续覆盖。请刷新并重新读取。', 'The account or game snapshot changed. No further overwrite was made. Refresh and read again.')
  if (/GUARD|CODE/.test(code)) return t('工具箱登录需要重新验证。请回到当前账号页面完成登录，再重试连接。', 'Toolbox sign-in needs verification. Complete sign-in on the current account page, then connect again.')
  if (/BLOCKED|OCCUPIED/.test(code)) return t('账号正在其他会话游玩，模拟显示已让位。真实游戏请使用单次状态编辑。', 'The account is playing in another session. Simulation yields to it; use the one-time live editor for a real game.')
  if (/LOGIN|AUTH/.test(code)) return t('工具箱登录可能已过期，请先回当前账号页面完成登录，再重试连接。', 'Toolbox sign-in may have expired. Sign in again on the current account page, then retry the connection.')
  if (/INVALID|VALIDATION|TOO_LONG|UNSUPPORTED/.test(code)) return t('输入内容或字段不符合要求，请检查 AppID、文字长度和可编辑字段。', 'An input or field is not valid. Check the AppID, text length and editable fields.')
  return t('本次操作未完成。请刷新后重试；若登录已过期，请先在工具箱当前账号页面重新登录。', 'The operation did not complete. Refresh and retry; if sign-in expired, sign in again on the current toolbox account page first.')
}

function statusLabel(status: GameStatusSnapshot['status'] | undefined, t: Translate): string {
  switch (status) {
    case 'logged_on': return t('游戏状态已连接', 'Game status connected')
    case 'connecting': return t('正在连接', 'Connecting')
    case 'guard_required': return t('请在工具箱完成验证', 'Complete verification in the toolbox')
    case 'error': return t('连接需要重试', 'Connection needs a retry')
    case 'disconnected': return t('游戏状态连接已断开', 'Game status disconnected')
    default: return t('尚未连接', 'Not connected')
  }
}

function operationLabel(operation: GameStatusOperation, t: Translate): string {
  if (operation.outcome === 'conflict') return t('游戏会话或字段已变化，本次结果存在冲突。请重新读取，未启动持续覆盖。', 'The game session or fields changed and the result conflicts. Read again; no continuous overwrite was started.')
  if (operation.outcome === 'unverified') return t('已尝试提交，但回读未能确认。请重新读取后核对，不能仅凭已发送判断生效。', 'Submission was attempted but readback could not confirm it. Read again to verify; sending alone does not prove it took effect.')
  if (operation.kind === 'observe') return t('已读取当前游戏字段，尚未提交修改。', 'Current game fields were read; no changes were submitted.')
  return operation.kind === 'restore'
    ? t('恢复结果已回读匹配。游戏后续更新仍可能改变这些字段。', 'Restoration matched on readback. Later game updates may still change these fields.')
    : t('本次单次提交已回读匹配；尚未确认好友端实际显示。', 'This one-time submission matched on readback; its appearance in a friend’s client is still unconfirmed.')
}

export function isGameStatusFieldEditable(live: GameStatusLiveSnapshot, key: string): boolean {
  return Object.hasOwn(live.fields, key) && key.toLowerCase() !== 'steam_display' && live.editableKeys.includes(key) && !live.readOnlyKeys.includes(key)
}

export function GameStatusPanel({ activeAccount, api }: GameStatusPanelProps): React.JSX.Element {
  const { language, t } = useI18n()
  const baseId = useId()
  const accountId = activeAccount?.id ?? null
  const expectedSteamId = activeAccount?.steamId ?? null
  const identityKey = `${accountId ?? ''}\0${expectedSteamId ?? ''}`
  const selectedIdentity = useRef(identityKey)
  selectedIdentity.current = identityKey
  const epoch = useRef(0)
  const lock = useRef<symbol | null>(null)
  const draftRevision = useRef(0)
  const [snapshot, assignSnapshot] = useState<GameStatusSnapshot | null>(null)
  const snapshotRef = useRef<GameStatusSnapshot | null>(null)
  const setSnapshot = (next: GameStatusSnapshot | null): void => { snapshotRef.current = next; assignSnapshot(next) }
  const [loading, setLoading] = useState(Boolean(activeAccount))
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [tab, setTab] = useState<Tab>('simulate')
  const [draft, setDraft] = useState<GameStatusDraft>({ ...EMPTY_DRAFT })
  const [appIdText, setAppIdText] = useState('')
  const [draftDirty, setDraftDirty] = useState(false)
  const [editor, setEditor] = useState<GameStatusLiveSnapshot | null>(null)
  const [editedFields, setEditedFields] = useState<Record<string, string>>({})

  useLayoutEffect(() => {
    const generation = ++epoch.current
    let disposed = false
    const current = (): boolean => !disposed && epoch.current === generation && selectedIdentity.current === identityKey
    lock.current = null; draftRevision.current = 0
    setSnapshot(null); setBusy(null); setLoading(Boolean(accountId)); setNotice(null)
    setDraft({ ...EMPTY_DRAFT }); setAppIdText(''); setDraftDirty(false); setEditor(null); setEditedFields({})
    if (!accountId) return () => { disposed = true; epoch.current++ }
    const unsubscribe = api.onChange(next => { if (current()) setSnapshot(next) })
    void api.state().then(async next => {
      if (!current()) return
      // A service event may already have delivered a newer login while this read was in flight.
      if (!snapshotRef.current || snapshotRef.current.sessionId === next.sessionId) setSnapshot(next)
      setLoading(false)
      const readSession = snapshotRef.current?.sessionId ?? next.sessionId
      const revision = draftRevision.current
      const saved = await api.loadDraft({ accountId, sessionId: readSession })
      if (!current() || snapshotRef.current?.sessionId !== readSession || draftRevision.current !== revision || !saved) return
      setDraft(saved); setAppIdText(saved.appId === undefined ? '' : String(saved.appId)); setDraftDirty(false)
    }).catch(error => {
      if (current()) { setLoading(false); setNotice({ kind: 'error', text: gameStatusError(error, t) }) }
    })
    return () => { disposed = true; epoch.current++; unsubscribe() }
    // The account's identity, not its display name or web-login status, owns this session and draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, accountId, expectedSteamId])

  const sameAccount = Boolean(activeAccount && snapshot?.accountId === accountId && snapshot.boundSteamId === expectedSteamId)
  const identityMatches = sameAccount && snapshot?.steamId === expectedSteamId
  const signedIn = Boolean(identityMatches && snapshot?.connected && snapshot.status === 'logged_on')
  const working = loading || busy !== null || Boolean(sameAccount && snapshot?.busy)
  const visibleSnapshot = sameAccount ? snapshot : null
  const liveStale = Boolean(editor && (!sameAccount || snapshot?.live?.snapshotId !== editor.snapshotId))
  const changedFields = useMemo(() => editor ? Object.fromEntries(Object.keys(editor.fields)
    .filter(key => isGameStatusFieldEditable(editor, key) && (editedFields[key] ?? editor.fields[key]) !== editor.fields[key])
    .map(key => [key, editedFields[key] ?? editor.fields[key] ?? ''])) : {}, [editor, editedFields])
  const changedCount = Object.keys(changedFields).length
  const parsedAppId = Number(appIdText)
  const validAppId = /^\d+$/.test(appIdText) && Number.isSafeInteger(parsedAppId) && parsedAppId > 0 && parsedAppId <= 0xffffff
  const draftValue = (): GameStatusDraft => ({ ...draft, ...(draft.displayKind === 'app' && validAppId ? { appId: parsedAppId } : { appId: undefined }) })
  const replaceLive = (next: GameStatusSnapshot): void => {
    setSnapshot(next)
    setEditor(next.live ? { ...next.live, fields: { ...next.live.fields } } : null)
    setEditedFields(next.live ? { ...next.live.fields } : {})
  }

  async function run<T>(label: string, action: (context: GameStatusAction) => Promise<T>, apply: (result: T) => void): Promise<void> {
    if (lock.current || !accountId || !snapshot) return
    const token = Symbol(label); const generation = epoch.current; const owner = identityKey; const sessionId = snapshot.sessionId
    lock.current = token; setBusy(label); setNotice(null)
    try {
      const result = await action({ accountId, sessionId })
      if (epoch.current !== generation || selectedIdentity.current !== owner || lock.current !== token) return
      const stateResult = typeof result === 'object' && result !== null && 'sessionId' in result && 'status' in result ? result as unknown as GameStatusSnapshot : null
      if (stateResult?.accountId && stateResult.accountId !== accountId) return
      if (stateResult?.boundSteamId && stateResult.boundSteamId !== expectedSteamId) return
      const latestId = snapshotRef.current?.sessionId
      if (label === 'login' || label === 'logout' || label === 'refresh') {
        if (latestId !== sessionId && latestId !== stateResult?.sessionId) return
      } else if (latestId !== sessionId || (stateResult && stateResult.sessionId !== sessionId)) return
      apply(result)
    } catch (error) {
      if (epoch.current === generation && selectedIdentity.current === owner && lock.current === token) setNotice({ kind: 'error', text: gameStatusError(error, t) })
    } finally {
      if (epoch.current === generation && lock.current === token) { lock.current = null; setBusy(null) }
    }
  }

  const changeDraft = (patch: Partial<GameStatusDraft>): void => { draftRevision.current++; setDraft(value => ({ ...value, ...patch })); setDraftDirty(true) }
  const updateAppId = (value: string): void => { draftRevision.current++; setAppIdText(value); setDraftDirty(true) }
  const connectWithToolbox = (): void => { void run('login', context => api.connectWithToolbox(context), setSnapshot) }
  const simulate = (): void => {
    if (draft.displayKind === 'app' && !validAppId) { setNotice({ kind: 'error', text: t('请输入有效的 Steam AppID。', 'Enter a valid Steam AppID.') }); return }
    if (draft.displayKind === 'custom' && !draft.gameName.trim()) { setNotice({ kind: 'error', text: t('请填写自定义游戏名称。', 'Enter a custom game name.') }); return }
    void run('play', context => api.play({ ...context, ...draftValue() }), next => {
      setSnapshot(next); setNotice({ kind: 'info', text: t('显示请求已提交；是否在好友端生效仍需实际核对。', 'The display request was submitted; confirm its appearance in a friend’s client.') })
    })
  }
  const saveDraft = (): void => {
    const revision = draftRevision.current
    void run('saveDraft', context => api.saveDraft({ ...context, draft: draftValue() }), saved => {
      if (draftRevision.current === revision) { setDraft(saved); setDraftDirty(false) }
      setNotice({ kind: 'success', text: t('已保存本机草稿，没有向 Steam 应用显示。', 'The draft was saved locally; nothing was applied to Steam.') })
    })
  }
  const loadDraft = (): void => { const revision = draftRevision.current; void run('loadDraft', context => api.loadDraft(context), saved => {
    if (draftRevision.current !== revision) { setNotice({ kind: 'info', text: t('读取期间草稿已有新编辑，已保留你的输入。', 'The draft was edited while loading; your new input was kept.') }); return }
    if (saved) { draftRevision.current++; setDraft(saved); setAppIdText(saved.appId === undefined ? '' : String(saved.appId)); setDraftDirty(false) }
    setNotice({ kind: 'info', text: saved ? t('已载入本机草稿，尚未应用。', 'The local draft was loaded but not applied.') : t('当前账号还没有本机草稿。', 'This account has no local draft yet.') })
  }) }
  const formatTime = (time: string): string => Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : t('时间不可用', 'Time unavailable')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'simulate', label: t('自定义模拟', 'Simulated display') },
    { id: 'live', label: t('真实游戏状态', 'Live game status') },
    { id: 'draft', label: t('本机草稿', 'Local draft') }
  ]

  return <div className="game-status-panel">
    <header className="game-status-heading"><div><span className="game-status-eyebrow">{t('STEAM 游戏状态', 'STEAM GAME STATUS')}</span><h2>{t('游戏状态工具', 'Game status tools')}</h2><p>{t('模拟显示，或对真实游戏已公开的字段做一次修改。', 'Simulate a display, or make a one-time edit to fields exposed by a real game.')}</p></div>
      <span className={`game-status-badge ${signedIn ? 'connected' : ''}`}>{statusLabel(visibleSnapshot?.status, t)}</span>
    </header>

    {!activeAccount ? <section className="game-status-card game-status-empty"><span aria-hidden="true">◉</span><h3>{t('先选择一个工具箱账号', 'Select a toolbox account first')}</h3><p>{t('游戏状态连接、修改与本机草稿都绑定到当前选中账号。', 'Game status connections, changes and local drafts are bound to the selected account.')}</p></section> : <>
      <section className="game-status-binding" aria-label={t('当前账号绑定', 'Current account binding')}><span className="game-status-account-icon" aria-hidden="true">{(activeAccount.displayName || activeAccount.accountName).slice(0, 1).toUpperCase()}</span><div><strong>{activeAccount.displayName || activeAccount.accountName}</strong><span>{t('强绑定 SteamID', 'Bound SteamID')} <code>{activeAccount.steamId}</code></span></div><p>{t('使用工具箱已有登录，并核验此 SteamID；登录凭据不会传给本页面。', 'Use the existing toolbox sign-in and verify this SteamID; sign-in credentials are not passed to this page.')}</p></section>

      <section className="game-status-card game-status-login"><div className="game-status-section-title"><div><h3>{t('连接工具箱当前账号', 'Connect the current toolbox account')}</h3><p>{t('复用工具箱已有登录，不需要再次输入登录名、密码或验证码。', 'Reuse the existing toolbox sign-in without entering a login name, password or code again.')}</p></div><button className="ghost" disabled={working || !snapshot} onClick={() => void run('refresh', () => api.state(), setSnapshot)}>{t('刷新状态', 'Refresh state')}</button></div>
        <div className="game-status-connect-actions"><button className="primary" disabled={working || !snapshot || visibleSnapshot?.status === 'connecting'} onClick={connectWithToolbox}>{busy === 'login' || visibleSnapshot?.status === 'connecting' ? t('正在连接…', 'Connecting…') : t('使用工具箱当前账号连接', 'Connect with current toolbox account')}</button><button disabled={working || !sameAccount || !snapshot} onClick={() => void run('logout', context => api.logout(context), replaceLive)}>{t('断开游戏状态连接', 'Disconnect game status')}</button></div>
        <p className="game-status-help">{t('打开本页不会自动连接或修改在线状态。若现有登录已过期，请回到工具箱当前账号页面完成登录，再点击连接重试。', 'Opening this page does not automatically connect or change online presence. If the existing sign-in expired, complete sign-in on the current toolbox account page, then connect again.')}</p>
        {(visibleSnapshot?.error || visibleSnapshot?.status === 'guard_required') && <p className="game-status-inline-error">{t('游戏状态连接未完成。请先在工具箱当前账号页面检查登录并完成验证，再刷新重试。', 'The game status connection is not ready. Check sign-in and complete verification on the current toolbox account page, then refresh and retry.')}</p>}
        {sameAccount && snapshot?.status === 'logged_on' && !identityMatches && <p className="game-status-inline-error">{t('登录身份与选中 SteamID 不一致，显示与状态修改已禁用。', 'The signed-in identity differs from the selected SteamID. Display and status changes are disabled.')}</p>}
      </section>

      <div className="game-status-tabs" role="tablist" aria-label={t('游戏状态功能', 'Game status features')}>{tabs.map(item => <button key={item.id} id={`${baseId}-${item.id}-tab`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${baseId}-${item.id}`} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'draft' && draftDirty && <i aria-label={t('未保存', 'Unsaved')} />}</button>)}</div>
      {notice && <div className={`game-status-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {tab === 'simulate' && <section className="game-status-card" role="tabpanel" id={`${baseId}-simulate`} aria-labelledby={`${baseId}-simulate-tab`}>
        <div className="game-status-section-title"><div><h3>{t('手动显示游戏', 'Set a simulated game display')}</h3><p>{t('可离线编辑；连接工具箱账号后，点击应用才会提交。', 'Edit offline; nothing is submitted until you connect the toolbox account and apply it.')}</p></div></div>
        <div className="game-status-preset"><span>{t('雀魂快捷文字', 'Mahjong Soul presets')}</span><div>{ROOMS.map(([id, zh, en]) => <button key={id} type="button" onClick={() => changeDraft({ displayKind: 'custom', gameName: t('雀魂', 'Mahjong Soul'), details: t(zh, en) })}>{t(zh, en)}</button>)}</div></div>
        <div className="game-status-form-grid"><label>{t('显示方式', 'Display type')}<select value={draft.displayKind} onChange={event => changeDraft({ displayKind: event.target.value as GameStatusDraft['displayKind'] })}><option value="custom">{t('自定义非 Steam 游戏名称', 'Custom non-Steam game name')}</option><option value="app">{t('Steam AppID', 'Steam AppID')}</option></select></label>
          {draft.displayKind === 'app' ? <label>{t('Steam AppID', 'Steam AppID')}<input inputMode="numeric" value={appIdText} placeholder="730" onChange={event => updateAppId(event.target.value)} /></label> : <label>{t('游戏名称', 'Game name')}<input value={draft.gameName} onChange={event => changeDraft({ gameName: event.target.value })} placeholder={t('例如：雀魂', 'For example: Mahjong Soul')} /></label>}
          <label className="game-status-wide">{t('子信息 / 补充文字', 'Details / additional text')}<input value={draft.details} onChange={event => changeDraft({ details: event.target.value })} placeholder={t('例如：金之间', 'For example: Gold Room')} /></label>
        </div>
        <div className="game-status-draft-preview"><span>{t('草稿预览', 'Draft preview')}</span><strong>{draft.displayKind === 'custom' ? draft.gameName.trim() ? `${draft.gameName.trim()}${draft.details.trim() ? ` · ${draft.details.trim()}` : ''}` : t('等待填写游戏名称', 'Enter a game name') : `Steam AppID ${appIdText || '—'}`}</strong><small>{draft.displayKind === 'custom' ? t('名称和子信息合并为一行非 Steam 游戏名称；不会产生官方游戏的第二级状态。', 'The name and details form one non-Steam game title; this does not create an official game’s second-level status.') : t('应用名称由 Steam 决定。子信息是否显示取决于游戏支持，不保证任意二级信息生效。', 'Steam determines the application name. Detail visibility depends on game support; arbitrary second-level text is not guaranteed.')}</small></div>
        {visibleSnapshot?.blocked && <p className="game-status-help">{t('账号正在真实游戏中，模拟显示已禁用。可切换到“真实游戏状态”读取当前字段。', 'The account is playing a real game, so simulation is disabled. Open Live game status to read its current fields.')}</p>}
        <div className="game-status-actions"><button className="primary" disabled={working || !signedIn || Boolean(snapshot?.blocked)} onClick={simulate}>{busy === 'play' ? t('提交中…', 'Submitting…') : t('应用模拟显示', 'Apply simulated display')}</button><button disabled={working || !signedIn} onClick={() => void run('stop', context => api.stop(context), setSnapshot)}>{t('停止模拟显示', 'Stop simulated display')}</button><button className="ghost" disabled={working || !snapshot} onClick={saveDraft}>{t('保存本机草稿', 'Save local draft')}</button></div>
      </section>}

      {tab === 'live' && <section className="game-status-card" role="tabpanel" id={`${baseId}-live`} aria-labelledby={`${baseId}-live-tab`}><div className="game-status-section-title"><div><h3>{t('真实游戏：实验性单次编辑', 'Real game: experimental one-time edit')}</h3><p>{t('先在 Steam 中实际启动游戏，再读取它公开的字段。只修改已观察且允许编辑的键，不新增键。', 'Start the game in Steam, then read its exposed fields. Only observed, editable keys can be changed; no new keys are added.')}</p></div><button disabled={working || !signedIn} onClick={() => void run('observe', context => api.observeLive(context), replaceLive)}>{busy === 'observe' ? t('读取中…', 'Reading…') : t('读取当前游戏', 'Read current game')}</button></div>
        {sameAccount && snapshot?.lastOperation && <div className={`game-status-notice ${snapshot.lastOperation.outcome === 'matched' ? 'success' : 'info'}`} role="status">{operationLabel(snapshot.lastOperation, t)}</div>}
        {!editor ? <div className="game-status-live-empty"><strong>{t('还没有当前游戏快照', 'No current game snapshot')}</strong><p>{t('读取后会显示公开键和值。steam_display 始终只读，不能靠任意文字伪造官方详细状态。', 'Read the game to see its exposed keys and values. steam_display is always read-only; arbitrary text cannot invent official rich-presence states.')}</p></div> : <>
          <div className="game-status-live-meta"><strong>AppID {editor.appId}</strong><span>{formatTime(editor.observedAt)}</span><span>{editor.fields && Object.keys(editor.fields).length} {t('个公开字段', 'exposed fields')}</span><span>{changedCount} {t('项未提交修改', 'unsubmitted changes')}</span></div>
          {liveStale && <div className="game-status-notice info">{t('当前游戏或快照已经变化，旧编辑内容已保留但不能提交。请重新读取。', 'The game or snapshot changed. Old edits are retained but cannot be submitted. Read the current game again.')}</div>}
          <div className="game-status-key-table-wrap"><table className="game-status-key-table"><thead><tr><th scope="col">{t('公开键', 'Exposed key')}</th><th scope="col">{t('当前 / 编辑值', 'Current / edited value')}</th><th scope="col">{t('权限', 'Access')}</th></tr></thead><tbody>{Object.entries(editor.fields).map(([key, value]) => {
            const editable = isGameStatusFieldEditable(editor, key)
            return <tr key={key}><th scope="row"><code>{key}</code></th><td>{editable ? <input aria-label={`${key} ${t('编辑值', 'edited value')}`} value={editedFields[key] ?? value} disabled={working || liveStale} onChange={event => setEditedFields(values => ({ ...values, [key]: event.target.value }))} /> : <code className="game-status-readonly-value">{value || '—'}</code>}</td><td><span className={editable ? 'game-status-field-editable' : 'game-status-field-readonly'}>{editable ? t('可单次修改', 'One-time edit') : t('只读', 'Read-only')}</span></td></tr>
          })}</tbody></table></div>
          {Object.keys(editor.fields).length === 0 && <p className="game-status-help">{t('游戏当前没有公开详细字段，请等待场景变化后再读取。', 'The game currently exposes no detail fields. Read again after its state changes.')}</p>}
        </>}
        <p className="game-status-help">{t('提交只执行一次，不会循环覆盖游戏。游戏可立即重写字段；回读成功也不保证好友客户端已刷新。恢复只针对当前仍匹配的游戏会话。', 'Submission runs once and does not repeatedly overwrite the game. The game may rewrite fields immediately; matching readback does not guarantee a refreshed friend client. Restore applies only to the matching current game session.')}</p>
        <div className="game-status-actions"><button className="primary" disabled={working || !signedIn || !editor || !changedCount || liveStale} onClick={() => { if (editor) void run('patch', context => api.patchLive({ ...context, snapshotId: editor.snapshotId, changes: changedFields }), replaceLive) }}>{busy === 'patch' ? t('单次提交中…', 'Submitting once…') : t('仅提交这次修改', 'Submit these changes once')}</button><button disabled={working || !signedIn} onClick={() => void run('readback', context => api.observeLive(context), replaceLive)}>{t('重新读取 / 回读', 'Read again / read back')}</button><button disabled={working || !signedIn || !snapshot?.live?.patchActive} onClick={() => void run('restore', context => api.restoreLive(context), replaceLive)}>{busy === 'restore' ? t('恢复中…', 'Restoring…') : t('恢复本次修改前的字段', 'Restore fields from before this edit')}</button></div>
      </section>}

      {tab === 'draft' && <section className="game-status-card" role="tabpanel" id={`${baseId}-draft`} aria-labelledby={`${baseId}-draft-tab`}><div className="game-status-section-title"><div><h3>{t('当前账号的本机草稿', 'Local draft for this account')}</h3><p>{t('无需建立游戏状态连接，通过工具箱本机服务保存。草稿不含登录凭据，也不会自动应用。', 'Save through the toolbox’s local service without a game status connection. Drafts contain no sign-in credentials and are never auto-applied.')}</p></div><span className="game-status-badge">{draftDirty ? t('尚未保存', 'Unsaved') : t('草稿就绪', 'Draft ready')}</span></div>
        <dl className="game-status-draft-summary"><div><dt>{t('绑定账号', 'Bound account')}</dt><dd>{activeAccount.displayName || activeAccount.accountName} <code>{activeAccount.steamId}</code></dd></div><div><dt>{t('显示方式', 'Display type')}</dt><dd>{draft.displayKind === 'custom' ? t('自定义非 Steam 游戏', 'Custom non-Steam game') : t('Steam AppID', 'Steam AppID')}</dd></div><div><dt>{t('游戏名称 / AppID', 'Game name / AppID')}</dt><dd>{draft.displayKind === 'custom' ? draft.gameName || '—' : appIdText || '—'}</dd></div><div><dt>{t('补充文字', 'Additional text')}</dt><dd>{draft.details || '—'}</dd></div></dl>
        <div className="game-status-actions"><button className="primary" disabled={working || !snapshot} onClick={saveDraft}>{busy === 'saveDraft' ? t('保存中…', 'Saving…') : t('保存当前草稿到本机', 'Save current draft locally')}</button><button disabled={working || !snapshot} onClick={loadDraft}>{t('重新载入本机草稿', 'Reload local draft')}</button><button className="ghost" onClick={() => setTab('simulate')}>{t('返回编辑草稿', 'Return to draft editor')}</button></div><p className="game-status-help">{t('重新载入会替换当前编辑内容。真实游戏修改仍需重新读取游戏快照，不会从草稿自动恢复。', 'Reloading replaces current edits. Live-game changes still require a fresh game snapshot and are not automatically restored from drafts.')}</p>
      </section>}
    </>}
  </div>
}
