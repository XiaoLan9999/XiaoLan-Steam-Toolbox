import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import type { GameStatusAction, GameStatusApi, GameStatusAppInfo, GameStatusDraft, GameStatusGame, GameStatusLiveLock, GameStatusLiveSnapshot, GameStatusOperation, GameStatusPresence, GameStatusSnapshot } from '../../../shared/game-status'
import { validateGameStatusPresence, isSafeGameStatusIconUrl } from '../../../shared/game-status-presence'
import { gameStatusFailureMessage, gameStatusFailureStageMessage, isGameStatusFailureCode } from '../../../shared/game-status-errors'
import { useI18n, type Translate } from '../i18n'
import './game-status.css'

export interface GameStatusPanelProps { activeAccount: AccountView | null; api: GameStatusApi }
type Tab = 'simulate' | 'live' | 'draft'
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null
const EMPTY_DRAFT: GameStatusDraft = { displayKind: 'app', gameName: '', details: '' }

export function gameStatusError(error: unknown, t: Translate): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return gameStatusFailureMessage(code, t)
}

export function GameStatusFailureNotice({ failure }: { failure: unknown }): React.JSX.Element {
  const { language, t } = useI18n()
  const value = failure && typeof failure === 'object' ? failure as Record<string, unknown> : {}
  const at = typeof value.at === 'string' && value.at.length <= 40 ? Date.parse(value.at) : NaN
  const time = Number.isFinite(at) ? new Date(at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : t('时间不可用', 'Time unavailable')
  const submitted = value.submitted === 'no'
    ? t('尚未提交状态修改', 'No status changes were submitted')
    : value.submitted === 'yes'
      ? t('已尝试提交，是否生效需以回读为准', 'Submission was attempted; readback is needed to confirm the result')
      : t('是否提交尚不能确定，请先读取核对', 'Submission is not confirmed; read the current status first')
  return <section className="game-status-notice error" role="alert" aria-label={t('游戏状态操作原因', 'Game status operation reason')}>
    <strong>{gameStatusFailureMessage(value.code, t)}</strong>
    <p>{gameStatusFailureStageMessage(value.stage, t)} · {time}</p>
    <p>{submitted}</p>
    {isGameStatusFailureCode(value.code) && <code>{value.code}</code>}
    {typeof value.appId === 'number' && Number.isInteger(value.appId) && value.appId > 0 && value.appId <= 0xffffff && <span> · AppID {value.appId}</span>}
  </section>
}

export function GameStatusConnectionNotice({ snapshot }: { snapshot: (Pick<GameStatusSnapshot, 'status' | 'error'> & { failure?: unknown }) | null }): React.JSX.Element | null {
  const { t } = useI18n()
  if (snapshot?.failure) return <GameStatusFailureNotice failure={snapshot.failure} />
  if (snapshot?.status === 'guard_required') return <p className="game-status-inline-error">{gameStatusFailureMessage('GAME_STATUS_GUARD_REQUIRED', t)}</p>
  return snapshot?.error ? <p className="game-status-inline-error">{gameStatusFailureMessage(undefined, t)}</p> : null
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
  if (operation.outcome === 'conflict') return t('游戏会话或字段已变化，本次结果存在冲突，未继续覆盖。请重新读取。', 'The game session or fields changed and the result conflicts. No further overwrite was made; read again.')
  if (operation.outcome === 'unverified') return t('已尝试提交，但回读未能确认。请重新读取后核对，不能仅凭已发送判断生效。', 'Submission was attempted but readback could not confirm it. Read again to verify; sending alone does not prove it took effect.')
  if (operation.kind === 'observe') return t('已读取当前游戏字段，尚未提交修改。', 'Current game fields were read; no changes were submitted.')
  if (operation.kind === 'lock') return t('锁定请求已回读匹配；将定期核对并重申所选字段，好友端显示仍需实际核对。', 'The lock request matched on readback. Selected fields will be checked and reasserted; appearance in a friend’s client still needs verification.')
  if (operation.kind === 'unlock') return t('已停止持续锁定；是否恢复原字段请以本次回读结果为准。', 'Continuous locking stopped. Use the current readback result to check whether original fields were restored.')
  return operation.kind === 'restore'
    ? t('恢复结果已回读匹配。游戏后续更新仍可能改变这些字段。', 'Restoration matched on readback. Later game updates may still change these fields.')
    : t('本次单次提交已回读匹配；尚未确认好友端实际显示。', 'This one-time submission matched on readback; its appearance in a friend’s client is still unconfirmed.')
}

export function GameStatusIdentity({ game, appId }: { game?: GameStatusGame | null; appId?: number }): React.JSX.Element {
  const { t } = useI18n()
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = game?.iconUrl && isSafeGameStatusIconUrl(game.iconUrl, game.appId) ? game.iconUrl : null
  return <div className="game-status-game-identity">
    {url && failedUrl !== url ? <img src={url} alt="" width={40} height={40} referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> : <span className="game-status-game-placeholder" aria-label={t('无可用游戏图标', 'Game icon unavailable')} aria-hidden="true">◈</span>}
    <div><strong>{game?.name || (appId ? `AppID ${appId}` : t('非 Steam 游戏', 'Non-Steam game'))}</strong><span>{game?.appId || appId ? `AppID ${game?.appId ?? appId}` : t('无官方图标或原生第二行状态', 'No official icon or native second-line status')}</span></div>
  </div>
}

export function gameStatusPresenceResult(info: GameStatusAppInfo | null, presence: GameStatusPresence | undefined): { preview: string | null; valid: boolean } {
  if (!presence) return { preview: null, valid: true }
  if (!info) return { preview: null, valid: false }
  try { return { preview: validateGameStatusPresence(info, presence).preview, valid: true } }
  catch { return { preview: null, valid: false } }
}

export function GameStatusTemplateEditor({ info, presence, onChange, disabled = false, id }: { info: GameStatusAppInfo; presence?: GameStatusPresence; onChange(value: GameStatusPresence | undefined): void; disabled?: boolean; id: string }): React.JSX.Element {
  const { t } = useI18n()
  const template = info.templates.find(value => value.token === presence?.displayToken)
  const result = gameStatusPresenceResult(info, presence)
  return <div className="game-status-template-editor">
    <label htmlFor={`${id}-template`}>{t('官方子状态模板', 'Published substatus template')}<select id={`${id}-template`} disabled={disabled} value={presence?.displayToken ?? ''} onChange={event => onChange(event.target.value ? { displayToken: event.target.value, values: {} } : undefined)}>
      <option value="">{t('仅显示游戏，不设置子状态', 'Game only, no substatus')}</option>
      {info.templates.map(value => <option key={value.token} value={value.token}>{value.text} ({value.token})</option>)}
    </select></label>
    {info.templates.length === 0 && <p className="game-status-help">{info.templateStatus === 'unavailable'
      ? t('本次未能取得官方子状态模板，不代表游戏不支持。可以重试读取，或暂时只显示官方游戏名称与图标；不会退回任意 status 文字。', 'Published substatus templates could not be retrieved this time; this does not prove the game lacks support. Retry the lookup, or show only the official game name and icon. Arbitrary status text is not used as a fallback.')
      : info.templateStatus === 'empty'
        ? t('Steam 已返回本次模板结果，但没有可安全渲染的公开子状态模板。可以只显示游戏名称与图标，不能添加任意原生第二行文字。', 'Steam returned the template result, but it contains no safely renderable published substatus templates. You can show the game name and icon, not arbitrary native second-line text.')
        : t('未取得可安全渲染的公开模板。可以只显示游戏；不能把任意 status 文字当成原生子状态。', 'No safely renderable published template is available. You can display the game alone; arbitrary status text is not a native substatus.')}</p>}
    {template && <div className="game-status-form-grid">{template.parameters.map(key => <label key={key}>{key}<input disabled={disabled} value={presence?.values[key] ?? ''} onChange={event => onChange({ displayToken: template.token, values: { ...presence?.values, [key]: event.target.value } })} /></label>)}</div>}
    {presence && <div className={`game-status-template-preview ${result.valid ? '' : 'invalid'}`} role="status"><span>{t('本机模板预览（不是好友端确认）', 'Local template preview (not confirmation from a friend)')}</span><strong>{result.valid ? result.preview : t('尚不可渲染：请选择有效模板并填写受支持的参数。', 'Not renderable yet: select a valid template and complete its supported parameters.')}</strong></div>}
  </div>
}

export function GameStatusLockStatus({ lock, onUnlock, onRestore, disabled }: { lock: GameStatusLiveLock; onUnlock(): void; onRestore(): void; disabled: boolean }): React.JSX.Element {
  const { language, t } = useI18n()
  const names: Record<GameStatusLiveLock['status'], string> = {
    checking: t('正在核对', 'Checking'), locked: t('持续锁定中', 'Lock active'), retrying: t('等待重试', 'Waiting to retry'), paused: t('锁定已暂停', 'Lock paused'), stopped: t('锁定已停止', 'Lock stopped')
  }
  const format = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : '—'
  return <section className="game-status-lock" aria-label={t('子状态锁定', 'Substatus lock')}><div className="game-status-section-title"><h3>{names[lock.status]}</h3><span className="game-status-badge">AppID {lock.appId}</span></div>
    <dl><div><dt>{t('锁定字段', 'Locked fields')}</dt><dd>{Object.keys(lock.desired).join(', ') || '—'}</dd></div><div><dt>{t('最近回读', 'Latest readback')}</dt><dd>{format(lock.lastCheckedAt)} · {lock.matched ? t('匹配', 'Matched') : t('未确认匹配', 'Not confirmed')}</dd></div><div><dt>{t('下次核对', 'Next check')}</dt><dd>{format(lock.nextCheckAt)}</dd></div></dl>
    {lock.localizedString && <p className="game-status-readback"><span>{t('Steam 子状态回读', 'Steam substatus readback')}</span><strong>{lock.localizedString}</strong></p>}
    {(lock.error || lock.consecutiveFailures > 0) && <p className="game-status-inline-error">{t('最近核对未完成，连续失败', 'The latest check did not complete; consecutive failures')}: {lock.consecutiveFailures}{lock.error ? ` · ${lock.error}` : ''}</p>}
    <p className="game-status-help">{t('只定期重申这些字段，不阻止游戏瞬间覆写。退出游戏、切换游戏或账号、断线会停止；不修改真实游戏的运行状态。', 'Only these fields are periodically reasserted; the game can briefly overwrite them. Exiting or changing the game, switching accounts, or disconnecting stops the lock; the running game is not changed.')}</p>
    <div className="game-status-actions"><button disabled={disabled || lock.status === 'stopped'} onClick={onUnlock}>{t('解除锁定（保留当前值）', 'Unlock (keep current values)')}</button><button disabled={disabled || lock.status === 'stopped'} onClick={onRestore}>{t('解除并安全恢复原字段', 'Unlock and safely restore original fields')}</button></div>
  </section>
}

export function isGameStatusFieldEditable(live: GameStatusLiveSnapshot, key: string): boolean {
  return Object.hasOwn(live.fields, key) && key.toLowerCase() !== 'steam_display' && live.editableKeys.includes(key) && !live.readOnlyKeys.includes(key)
}

export function GameStatusPanel({ activeAccount, api }: GameStatusPanelProps): React.JSX.Element {
  const { language, t } = useI18n()
  const languageRef = useRef(language)
  languageRef.current = language
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
  const [simulationInfo, setSimulationInfo] = useState<GameStatusAppInfo | null>(null)
  const [liveInfo, setLiveInfo] = useState<GameStatusAppInfo | null>(null)
  const [livePresence, setLivePresence] = useState<GameStatusPresence | undefined>()
  const [lockDisplay, setLockDisplay] = useState(false)
  const [lockFields, setLockFields] = useState(false)
  const liveDraftRevision = useRef(0)
  const appIdRef = useRef(appIdText)
  appIdRef.current = appIdText

  useLayoutEffect(() => {
    const generation = ++epoch.current
    let disposed = false
    const current = (): boolean => !disposed && epoch.current === generation && selectedIdentity.current === identityKey
    lock.current = null; draftRevision.current = 0
    setSnapshot(null); setBusy(null); setLoading(Boolean(accountId)); setNotice(null)
    setDraft({ ...EMPTY_DRAFT }); setAppIdText(''); setDraftDirty(false); setEditor(null); setEditedFields({})
    setSimulationInfo(null); setLiveInfo(null); setLivePresence(undefined); setLockDisplay(false); setLockFields(false); liveDraftRevision.current++
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
  const foregroundWorking = loading || busy !== null
  const visibleSnapshot = sameAccount ? snapshot : null
  const liveStale = Boolean(editor && (!sameAccount || snapshot?.live?.snapshotId !== editor.snapshotId))
  const changedFields = useMemo(() => editor ? Object.fromEntries(Object.keys(editor.fields)
    .filter(key => isGameStatusFieldEditable(editor, key) && (editedFields[key] ?? editor.fields[key]) !== editor.fields[key])
    .map(key => [key, editedFields[key] ?? editor.fields[key] ?? ''])) : {}, [editor, editedFields])
  const changedCount = Object.keys(changedFields).length
  const parsedAppId = Number(appIdText)
  const validAppId = /^\d+$/.test(appIdText) && Number.isSafeInteger(parsedAppId) && parsedAppId > 0 && parsedAppId <= 0xffffff
  const visibleSimulationInfo = simulationInfo?.appId === parsedAppId ? simulationInfo : null
  const visibleLiveInfo = liveInfo?.appId === editor?.appId ? liveInfo : null
  const simulationPresence = gameStatusPresenceResult(visibleSimulationInfo, draft.presence)
  const livePresenceResult = gameStatusPresenceResult(visibleLiveInfo, livePresence)
  const activeLiveLock = Boolean(visibleSnapshot?.liveLock && visibleSnapshot.liveLock.status !== 'stopped')
  const hasRestorablePatch = Boolean(visibleSnapshot?.live?.patchActive && !activeLiveLock)
  const draftValue = (): GameStatusDraft => ({ ...draft, ...(draft.displayKind === 'app' && validAppId ? { appId: parsedAppId, gameName: visibleSimulationInfo?.name ?? '', details: '' } : { appId: undefined, presence: undefined }) })
  const replaceLive = (next: GameStatusSnapshot): void => {
    setSnapshot(next)
    setEditor(next.live ? { ...next.live, fields: { ...next.live.fields } } : null)
    setEditedFields(next.live ? { ...next.live.fields } : {})
    if (next.live?.appId !== editor?.appId) { setLiveInfo(null); setLivePresence(undefined); liveDraftRevision.current++ }
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
  const updateAppId = (value: string): void => { draftRevision.current++; setAppIdText(value); setSimulationInfo(null); setDraft(previous => ({ ...previous, presence: undefined })); setDraftDirty(true) }
  const inspectSimulation = (): void => {
    if (!validAppId) return
    const revision = draftRevision.current; const requestedId = parsedAppId; const requestedLanguage = language
    void run('inspectSimulation', context => api.inspectApp({ ...context, appId: requestedId, language: language === 'en' ? 'english' : 'schinese' }), info => {
      if (draftRevision.current !== revision || Number(appIdRef.current) !== requestedId || info.appId !== requestedId || requestedLanguage !== languageRef.current) return
      setSimulationInfo(info)
    })
  }
  const inspectLive = (): void => {
    if (!editor || liveStale) return
    const revision = liveDraftRevision.current; const requestedId = editor.appId; const requestedSnapshot = editor.snapshotId; const requestedLanguage = language
    void run('inspectLive', context => api.inspectApp({ ...context, appId: requestedId, language: language === 'en' ? 'english' : 'schinese' }), info => {
      if (liveDraftRevision.current !== revision || snapshotRef.current?.live?.snapshotId !== requestedSnapshot || info.appId !== requestedId || languageRef.current !== requestedLanguage) return
      setLiveInfo(info)
    })
  }
  const connectWithToolbox = (): void => { void run('login', context => api.connectWithToolbox(context), setSnapshot) }
  const simulate = (): void => {
    if (draft.displayKind === 'app' && !validAppId) { setNotice({ kind: 'error', text: t('请输入有效的 Steam AppID。', 'Enter a valid Steam AppID.') }); return }
    if (draft.displayKind === 'app' && (!visibleSimulationInfo || !simulationPresence.valid)) { setNotice({ kind: 'error', text: t('请先读取该游戏的官方信息，并检查子状态模板及参数。', 'Read this game’s published information first, then check its substatus template and parameters.') }); return }
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
    <header className="game-status-heading"><div><span className="game-status-eyebrow">{t('STEAM 游戏状态', 'STEAM GAME STATUS')}</span><h2>{t('游戏状态工具', 'Game status tools')}</h2><p>{t('显示官方游戏与模板子状态，或编辑并持续锁定当前真实游戏的公开状态。', 'Display an official game and published substatus, or edit and keep the current real game’s exposed status locked.')}</p></div>
      <span className={`game-status-badge ${signedIn ? 'connected' : ''}`}>{statusLabel(visibleSnapshot?.status, t)}</span>
    </header>

    {!activeAccount ? <section className="game-status-card game-status-empty"><span aria-hidden="true">◉</span><h3>{t('先选择一个工具箱账号', 'Select a toolbox account first')}</h3><p>{t('游戏状态连接、修改与本机草稿都绑定到当前选中账号。', 'Game status connections, changes and local drafts are bound to the selected account.')}</p></section> : <>
      <section className="game-status-binding" aria-label={t('当前账号绑定', 'Current account binding')}><span className="game-status-account-icon" aria-hidden="true">{(activeAccount.displayName || activeAccount.accountName).slice(0, 1).toUpperCase()}</span><div><strong>{activeAccount.displayName || activeAccount.accountName}</strong><span>{t('强绑定 SteamID', 'Bound SteamID')} <code>{activeAccount.steamId}</code></span></div><p>{t('使用工具箱已有登录，并核验此 SteamID；登录凭据不会传给本页面。', 'Use the existing toolbox sign-in and verify this SteamID; sign-in credentials are not passed to this page.')}</p></section>

      <section className="game-status-card game-status-login"><div className="game-status-section-title"><div><h3>{t('连接工具箱当前账号', 'Connect the current toolbox account')}</h3><p>{t('复用工具箱已有登录，不需要再次输入登录名、密码或验证码。', 'Reuse the existing toolbox sign-in without entering a login name, password or code again.')}</p></div><button className="ghost" disabled={working || !snapshot} onClick={() => void run('refresh', () => api.state(), setSnapshot)}>{t('刷新状态', 'Refresh state')}</button></div>
        <div className="game-status-connect-actions"><button className="primary" disabled={working || !snapshot || visibleSnapshot?.status === 'connecting'} onClick={connectWithToolbox}>{busy === 'login' || visibleSnapshot?.status === 'connecting' ? t('正在连接…', 'Connecting…') : t('使用工具箱当前账号连接', 'Connect with current toolbox account')}</button><button disabled={working || !sameAccount || !snapshot} onClick={() => void run('logout', context => api.logout(context), replaceLive)}>{t('断开游戏状态连接', 'Disconnect game status')}</button></div>
        <p className="game-status-help">{t('打开本页不会自动连接或修改在线状态。若现有登录已过期，请回到工具箱当前账号页面完成登录，再点击连接重试。', 'Opening this page does not automatically connect or change online presence. If the existing sign-in expired, complete sign-in on the current toolbox account page, then connect again.')}</p>
        <GameStatusConnectionNotice snapshot={visibleSnapshot} />
        {sameAccount && snapshot?.status === 'logged_on' && !identityMatches && <p className="game-status-inline-error">{t('登录身份与选中 SteamID 不一致，显示与状态修改已禁用。', 'The signed-in identity differs from the selected SteamID. Display and status changes are disabled.')}</p>}
      </section>

      <div className="game-status-tabs" role="tablist" aria-label={t('游戏状态功能', 'Game status features')}>{tabs.map(item => <button key={item.id} id={`${baseId}-${item.id}-tab`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${baseId}-${item.id}`} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'draft' && draftDirty && <i aria-label={t('未保存', 'Unsaved')} />}</button>)}</div>
      {notice && <div className={`game-status-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {tab === 'simulate' && <section className="game-status-card" role="tabpanel" id={`${baseId}-simulate`} aria-labelledby={`${baseId}-simulate-tab`}>
        <div className="game-status-section-title"><div><h3>{t('手动显示游戏', 'Set a simulated game display')}</h3><p>{t('可离线编辑；连接工具箱账号后，点击应用才会提交。', 'Edit offline; nothing is submitted until you connect the toolbox account and apply it.')}</p></div></div>
        <div className="game-status-actions"><button type="button" disabled={!signedIn || !visibleSnapshot?.blockingAppId} onClick={() => setTab('live')}>{t('编辑当前正在玩的游戏', 'Edit the game currently being played')}</button></div>
        <div className="game-status-form-grid"><label>{t('显示方式', 'Display type')}<select value={draft.displayKind} onChange={event => changeDraft({ displayKind: event.target.value as GameStatusDraft['displayKind'] })}><option value="custom">{t('自定义非 Steam 游戏名称', 'Custom non-Steam game name')}</option><option value="app">{t('Steam AppID', 'Steam AppID')}</option></select></label>
          {draft.displayKind === 'app' ? <label>{t('Steam AppID', 'Steam AppID')}<input inputMode="numeric" value={appIdText} placeholder="1329410" onChange={event => updateAppId(event.target.value)} /></label> : <label>{t('游戏名称', 'Game name')}<input value={draft.gameName} onChange={event => changeDraft({ gameName: event.target.value })} placeholder={t('自定义非 Steam 游戏', 'Custom non-Steam game')} /></label>}
          {draft.displayKind === 'custom' && <label className="game-status-wide">{t('合并到名称的补充文字（不是原生子状态）', 'Additional title text (not a native substatus)')}<input value={draft.details} onChange={event => changeDraft({ details: event.target.value })} /></label>}
        </div>
        {draft.displayKind === 'app' && <><div className="game-status-actions"><button disabled={working || !signedIn || !validAppId} onClick={inspectSimulation}>{busy === 'inspectSimulation' ? t('读取中…', 'Reading…') : t('读取官方游戏信息与模板', 'Read published game info and templates')}</button></div>{visibleSimulationInfo && <><GameStatusIdentity game={visibleSimulationInfo} /><GameStatusTemplateEditor id={`${baseId}-simulation`} info={visibleSimulationInfo} presence={draft.presence} onChange={presence => changeDraft({ presence })} disabled={working} /></>}</>}
        <div className="game-status-draft-preview"><span>{t('本机草稿预览', 'Local draft preview')}</span><strong>{draft.displayKind === 'custom' ? draft.gameName.trim() ? `${draft.gameName.trim()}${draft.details.trim() ? ` · ${draft.details.trim()}` : ''}` : t('等待填写游戏名称', 'Enter a game name') : visibleSimulationInfo?.name ?? `Steam AppID ${appIdText || '—'}`}</strong>{simulationPresence.preview && draft.displayKind === 'app' && <span>{simulationPresence.preview}</span>}<small>{draft.displayKind === 'custom' ? t('名称和补充文字合并为一行非 Steam 游戏名称；没有官方游戏图标或原生第二级状态。请使用 AppID 模式显示官方游戏。', 'The name and extra text form one non-Steam game title, with no official game icon or native second-line status. Use AppID mode for an official game.') : t('仅使用这个游戏发布的模板生成子状态，不再发送任意 status。这里是本机预览，不代表好友端显示已确认。', 'Substatus uses only templates published by this game, not arbitrary status text. This is a local preview, not confirmation of a friend’s display.')}</small></div>
        {visibleSnapshot?.playing && <section className="game-status-submitted" aria-label={t('当前已提交显示', 'Current submitted display')}><GameStatusIdentity game={visibleSnapshot.playing.game} appId={visibleSnapshot.playing.appId} /><strong>{visibleSnapshot.playing.displayName}</strong>{visibleSnapshot.playing.preview && <p>{visibleSnapshot.playing.preview}</p>}<p className="game-status-help">{t('已向 Steam 提交；本机预览不等于好友客户端实际显示确认。', 'Submitted to Steam; a local preview is not confirmation of what a friend’s client displays.')}</p></section>}
        {visibleSnapshot?.blocked && <p className="game-status-help">{t('账号正在真实游戏中，模拟显示已禁用。可切换到“真实游戏状态”读取当前字段。', 'The account is playing a real game, so simulation is disabled. Open Live game status to read its current fields.')}</p>}
        <div className="game-status-actions"><button className="primary" disabled={working || !signedIn || Boolean(snapshot?.blocked) || (draft.displayKind === 'app' && (!validAppId || !visibleSimulationInfo || !simulationPresence.valid))} onClick={simulate}>{busy === 'play' ? t('提交中…', 'Submitting…') : t('应用模拟显示', 'Apply simulated display')}</button><button disabled={foregroundWorking || !signedIn} onClick={() => void run('stop', context => api.stop(context), setSnapshot)}>{t('停止模拟显示', 'Stop simulated display')}</button><button className="ghost" disabled={working || !snapshot} onClick={saveDraft}>{t('保存本机草稿', 'Save local draft')}</button></div>
      </section>}

      {tab === 'live' && <section className="game-status-card" role="tabpanel" id={`${baseId}-live`} aria-labelledby={`${baseId}-live-tab`}><div className="game-status-section-title"><div><h3>{t('真实游戏：子状态编辑与锁定', 'Real game: substatus editing and locking')}</h3><p>{t('先实际启动游戏并读取当前状态。可以使用官方子状态模板，或修改已公开的可编辑字段；锁定不抢占游戏会话。', 'Start the real game and read its current state. Use a published substatus template or edit exposed fields; locking does not take over the game session.')}</p></div><button disabled={working || !signedIn} onClick={() => void run('observe', context => api.observeLive(context), replaceLive)}>{busy === 'observe' ? t('读取中…', 'Reading…') : t('读取当前游戏', 'Read current game')}</button></div>
        {visibleSnapshot?.liveLock && <GameStatusLockStatus lock={visibleSnapshot.liveLock} disabled={foregroundWorking || !signedIn} onUnlock={() => void run('unlock', context => api.unlockLive({ ...context, restore: false }), replaceLive)} onRestore={() => void run('unlockRestore', context => api.unlockLive({ ...context, restore: true }), replaceLive)} />}
        {sameAccount && snapshot?.lastOperation && <div className={`game-status-notice ${snapshot.lastOperation.outcome === 'matched' ? 'success' : 'info'}`} role="status">{operationLabel(snapshot.lastOperation, t)}</div>}
        {!editor ? <div className="game-status-live-empty"><strong>{t('还没有当前游戏快照', 'No current game snapshot')}</strong><p>{t('读取后会显示公开键和值。steam_display 始终只读，不能靠任意文字伪造官方详细状态。', 'Read the game to see its exposed keys and values. steam_display is always read-only; arbitrary text cannot invent official rich-presence states.')}</p></div> : <>
          <GameStatusIdentity game={editor.game ?? visibleLiveInfo} appId={editor.appId} />
          <div className="game-status-live-meta"><span>{formatTime(editor.observedAt)}</span><span>{editor.fields && Object.keys(editor.fields).length} {t('个公开字段', 'exposed fields')}</span><span>{changedCount} {t('项未提交修改', 'unsubmitted changes')}</span></div>
          <p className="game-status-readback"><span>{t('Steam 实际子状态回读（不是本机预览）', 'Steam substatus readback (not a local preview)')}</span><strong>{editor.localizedString || t('Steam 未返回可渲染的子状态；不能确认好友端显示。', 'Steam did not return a renderable substatus; the friend-client display is not confirmed.')}</strong></p>
          {liveStale && <div className="game-status-notice info">{t('当前游戏或快照已经变化，旧编辑内容已保留但不能提交。请重新读取。', 'The game or snapshot changed. Old edits are retained but cannot be submitted. Read the current game again.')}</div>}
          {hasRestorablePatch && <p className="game-status-notice info">{t('上次修改仍有安全恢复记录。可先安全恢复原字段；待核对或部分写入的记录会保留，重新读取不会自动重发。已被游戏覆盖的普通旧记录，或超过 10 分钟的记录，可在重新读取后建立新基线。', 'A safe-restore record remains from the previous edit. Safely restore original fields first. Unconfirmed or partial-write records are retained; reading again never resends them. A normal superseded record, or one over 10 minutes old, can be retired by reading again to establish a new baseline.')}</p>}
          <section className="game-status-live-display"><div className="game-status-section-title"><div><h3>{t('模板化子状态', 'Template-based substatus')}</h3><p>{t('使用当前游戏真正发布的模板；不伪造任意显示令牌。', 'Use templates actually published by this game, not invented display tokens.')}</p></div><button disabled={working || !signedIn || liveStale} onClick={inspectLive}>{busy === 'inspectLive' ? t('读取中…', 'Reading…') : t('读取子状态模板与图标', 'Read substatus templates and icon')}</button></div>
            {visibleLiveInfo && <GameStatusTemplateEditor id={`${baseId}-live-display`} info={visibleLiveInfo} presence={livePresence} disabled={working || liveStale || activeLiveLock} onChange={presence => { liveDraftRevision.current++; setLivePresence(presence) }} />}
            <label className="game-status-checkbox"><input type="checkbox" checked={lockDisplay} disabled={foregroundWorking || activeLiveLock} onChange={event => setLockDisplay(event.target.checked)} /><span>{t('持续锁定此子状态，游戏更新后定期重申', 'Keep this substatus locked and periodically reassert it after game updates')}</span></label>
            <button className="primary" disabled={working || !signedIn || liveStale || activeLiveLock || hasRestorablePatch || !livePresence || !livePresenceResult.valid} onClick={() => { if (livePresence) void run('liveDisplay', context => api.setLiveDisplay({ ...context, snapshotId: editor.snapshotId, presence: livePresence, lock: lockDisplay }), replaceLive) }}>{lockDisplay ? t('应用并锁定子状态', 'Apply and lock substatus') : t('单次应用子状态', 'Apply substatus once')}</button>
          </section>
          <div className="game-status-key-table-wrap"><table className="game-status-key-table"><thead><tr><th scope="col">{t('公开键', 'Exposed key')}</th><th scope="col">{t('当前 / 编辑值', 'Current / edited value')}</th><th scope="col">{t('权限', 'Access')}</th></tr></thead><tbody>{Object.entries(editor.fields).map(([key, value]) => {
            const editable = isGameStatusFieldEditable(editor, key)
            return <tr key={key}><th scope="row"><code>{key}</code></th><td>{editable ? <input aria-label={`${key} ${t('编辑值', 'edited value')}`} value={editedFields[key] ?? value} disabled={working || liveStale || activeLiveLock} onChange={event => setEditedFields(values => ({ ...values, [key]: event.target.value }))} /> : <code className="game-status-readonly-value">{value || '—'}</code>}</td><td><span className={editable ? 'game-status-field-editable' : 'game-status-field-readonly'}>{editable ? t('可编辑 / 锁定', 'Editable / lockable') : t('只读', 'Read-only')}</span></td></tr>
          })}</tbody></table></div>
          {Object.keys(editor.fields).length === 0 && <p className="game-status-help">{t('游戏当前没有公开详细字段，请等待场景变化后再读取。', 'The game currently exposes no detail fields. Read again after its state changes.')}</p>}
        </>}
        <label className="game-status-checkbox"><input type="checkbox" checked={lockFields} disabled={foregroundWorking || activeLiveLock} onChange={event => setLockFields(event.target.checked)} /><span>{t('持续锁定上表中本次修改的字段', 'Keep the changed fields in the table locked')}</span></label>
        <p className="game-status-help">{t('默认只提交一次。启用锁定后，仅定期核对并重申你修改的字段，不锁定其他游戏信息或加入令牌；游戏仍可瞬间覆写。回读匹配不等于好友端已经刷新。安全恢复仅在原会话和字段仍匹配时执行。', 'The default is a one-time submission. A lock checks and reasserts only your changed fields, not other game data or join tokens; the game may still briefly overwrite them. Matching readback does not prove a refreshed friend client. Safe restore runs only while the original session and fields still match.')}</p>
        <div className="game-status-actions"><button className="primary" disabled={working || !signedIn || !editor || !changedCount || liveStale || activeLiveLock || hasRestorablePatch} onClick={() => { if (editor) void run(lockFields ? 'lockFields' : 'patch', context => lockFields ? api.lockLive({ ...context, snapshotId: editor.snapshotId, changes: changedFields }) : api.patchLive({ ...context, snapshotId: editor.snapshotId, changes: changedFields }), replaceLive) }}>{lockFields ? t('应用并锁定修改字段', 'Apply and lock changed fields') : busy === 'patch' ? t('单次提交中…', 'Submitting once…') : t('仅提交这次修改', 'Submit these changes once')}</button><button disabled={working || !signedIn} onClick={() => void run('readback', context => api.observeLive(context), replaceLive)}>{t('重新读取 / 回读', 'Read again / read back')}</button><button disabled={working || !signedIn || !snapshot?.live?.patchActive || activeLiveLock} onClick={() => void run('restore', context => api.restoreLive(context), replaceLive)}>{busy === 'restore' ? t('恢复中…', 'Restoring…') : t('恢复本次修改前的字段', 'Restore fields from before this edit')}</button></div>
      </section>}

      {tab === 'draft' && <section className="game-status-card" role="tabpanel" id={`${baseId}-draft`} aria-labelledby={`${baseId}-draft-tab`}><div className="game-status-section-title"><div><h3>{t('当前账号的本机草稿', 'Local draft for this account')}</h3><p>{t('无需建立游戏状态连接，通过工具箱本机服务保存。草稿不含登录凭据，也不会自动应用。', 'Save through the toolbox’s local service without a game status connection. Drafts contain no sign-in credentials and are never auto-applied.')}</p></div><span className="game-status-badge">{draftDirty ? t('尚未保存', 'Unsaved') : t('草稿就绪', 'Draft ready')}</span></div>
        <dl className="game-status-draft-summary"><div><dt>{t('绑定账号', 'Bound account')}</dt><dd>{activeAccount.displayName || activeAccount.accountName} <code>{activeAccount.steamId}</code></dd></div><div><dt>{t('显示方式', 'Display type')}</dt><dd>{draft.displayKind === 'custom' ? t('自定义非 Steam 游戏', 'Custom non-Steam game') : t('Steam AppID', 'Steam AppID')}</dd></div><div><dt>{t('游戏名称 / AppID', 'Game name / AppID')}</dt><dd>{draft.displayKind === 'custom' ? draft.gameName || '—' : appIdText || '—'}</dd></div><div><dt>{t('补充文字', 'Additional text')}</dt><dd>{draft.details || '—'}</dd></div></dl>
        <div className="game-status-actions"><button className="primary" disabled={working || !snapshot} onClick={saveDraft}>{busy === 'saveDraft' ? t('保存中…', 'Saving…') : t('保存当前草稿到本机', 'Save current draft locally')}</button><button disabled={working || !snapshot} onClick={loadDraft}>{t('重新载入本机草稿', 'Reload local draft')}</button><button className="ghost" onClick={() => setTab('simulate')}>{t('返回编辑草稿', 'Return to draft editor')}</button></div><p className="game-status-help">{t('重新载入会替换当前编辑内容。真实游戏修改仍需重新读取游戏快照，不会从草稿自动恢复。', 'Reloading replaces current edits. Live-game changes still require a fresh game snapshot and are not automatically restored from drafts.')}</p>
      </section>}
    </>}
  </div>
}
