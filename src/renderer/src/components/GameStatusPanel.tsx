import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import type { GameStatusAction, GameStatusApi, GameStatusAppInfo, GameStatusDraft, GameStatusGame, GameStatusLiveLock, GameStatusLiveSnapshot, GameStatusOperation, GameStatusPresence, GameStatusSnapshot } from '../../../shared/game-status'
import type { LocalAppSimulationApi } from '../../../shared/local-app-simulation'
import { LocalAppSimulationPanel } from './LocalAppSimulationPanel'
import { validateGameStatusPresence, isSafeGameStatusIconUrl, gameStatusPresenceParameterHints } from '../../../shared/game-status-presence'
import { gameStatusFailureMessage, gameStatusFailureStageMessage, isGameStatusFailureCode } from '../../../shared/game-status-errors'
import { useI18n, type Translate } from '../i18n'
import { GROUP_SIZE_KEY, MAX_GROUP_SIZE, readGroupSize } from '../../../shared/game-status-group'
import type { StatusCopyApi } from '../../../shared/status-copy'
import { StatusCopyPanel } from './StatusCopyPanel'
import { GameStatusTemplateDiagnostics } from './GameStatusTemplateDiagnostics'
import { richPresenceContract } from '../../../shared/rich-presence-contract'
import './game-status.css'

export interface GameStatusPanelProps { activeAccount: AccountView | null; api: GameStatusApi; localSimulationApi?: LocalAppSimulationApi; statusCopyApi?: StatusCopyApi }
type Tab = 'simulate' | 'live' | 'copy' | 'draft'
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
  if (operation.verificationSource === 'local-cache') {
    if (operation.kind === 'observe') return t('已读取本机 Steam 缓存中的公开字段，尚未提交修改；这不是独立服务端确认。', 'Exposed fields were read from the local Steam cache without changes; this is not independent server confirmation.')
    if (operation.kind === 'unlock') return t('已停止持续锁定；恢复结果仅由本机 Steam 缓存核对，不代表独立服务端或好友端确认。', 'Continuous locking stopped. Any restoration was checked only against the local Steam cache, not independently confirmed by the server or a friend.')
    return operation.kind === 'lock'
      ? t('锁定字段与本机 Steam 缓存匹配，将定期核对并重申；尚未独立确认服务端或好友端显示。', 'Locked fields match the local Steam cache and will be checked and reasserted; server or friend-client appearance is not independently confirmed.')
      : t('本次结果与本机 Steam 缓存匹配；尚未独立确认服务端或好友端显示。', 'The result matches the local Steam cache; server or friend-client appearance is not independently confirmed.')
  }
  if (operation.kind === 'observe') return t('已读取当前游戏字段，尚未提交修改。', 'Current game fields were read; no changes were submitted.')
  if (operation.kind === 'lock') return t('锁定请求已回读匹配；将定期核对并重申所选字段，好友端显示仍需实际核对。', 'The lock request matched on readback. Selected fields will be checked and reasserted; appearance in a friend’s client still needs verification.')
  if (operation.kind === 'unlock') return t('已停止持续锁定；是否恢复原字段请以本次回读结果为准。', 'Continuous locking stopped. Use the current readback result to check whether original fields were restored.')
  return operation.kind === 'restore'
    ? t('恢复结果已回读匹配。游戏后续更新仍可能改变这些字段。', 'Restoration matched on readback. Later game updates may still change these fields.')
    : t('本次单次提交已回读匹配；尚未确认好友端实际显示。', 'This one-time submission matched on readback; its appearance in a friend’s client is still unconfirmed.')
}

function readbackLabel(source: GameStatusLiveSnapshot['verificationSource'], t: Translate): string {
  if (source === 'local-cache') return t('本机 Steam 缓存子状态（非独立服务端确认）', 'Local Steam cached substatus (not independent server confirmation)')
  if (source === 'server') return t('Steam 服务端子状态回读（非好友端确认）', 'Steam server substatus readback (not friend-client confirmation)')
  return t('子状态回读（来源未标记，非好友端确认）', 'Substatus readback (source not marked; not friend-client confirmation)')
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

export function GameStatusTemplateEditor({ info, presence, onChange, onRetry, disabled = false, id }: { info: GameStatusAppInfo; presence?: GameStatusPresence; onChange(value: GameStatusPresence | undefined): void; onRetry?(): void; disabled?: boolean; id: string }): React.JSX.Element {
  const { t } = useI18n()
  const template = info.templates.find(value => value.token.toLowerCase() === presence?.displayToken.toLowerCase())
  const result = gameStatusPresenceResult(info, presence)
  const hints = presence ? gameStatusPresenceParameterHints(info, presence) : []
  const fieldValue = (key: string): string => Object.entries(presence?.values ?? {}).find(([name]) => name.toLowerCase() === key)?.[1] ?? ''
  const invalidChoices = hints.filter(hint => hint.kind === 'choice' && fieldValue(hint.key) && !hint.options.some(option => option.value.toLowerCase() === fieldValue(hint.key).toLowerCase()))
  const previewError = !template
    ? t('尚不可渲染：原模板已不可用，请重新选择官方模板。', 'Not renderable yet: the previous template is unavailable. Select a published template.')
    : invalidChoices.length
      ? `${t('尚不可渲染：以下字段只能使用下拉列表中的官方值', 'Not renderable yet: choose a published value from the dropdown for')}: ${invalidChoices.map(hint => hint.key).join(', ')}`
      : t('尚不可渲染：请按字段提示完成参数；枚举值必须来自官方列表，不能随意填写。', 'Not renderable yet: complete the parameters using their hints. Enumerated values must come from the published list.')
  const changeField = (key: string, value: string): void => {
    if (!template || disabled) return
    const values = Object.fromEntries(Object.entries(presence?.values ?? {}).filter(([name]) => name.toLowerCase() !== key))
    const next = { displayToken: template.token, values: { ...values, [key]: value } }
    const active = gameStatusPresenceParameterHints(info, next)
    if (active.length) {
      const keys = new Set(active.map(hint => hint.key))
      next.values = Object.fromEntries(Object.entries(next.values).filter(([name]) => keys.has(name.toLowerCase())))
    }
    onChange(next)
  }
  return <div className="game-status-template-editor">
    <label htmlFor={`${id}-template`}>{t('官方子状态模板', 'Published substatus template')}<select id={`${id}-template`} disabled={disabled} value={template?.token ?? presence?.displayToken ?? ''} onChange={event => { if (!disabled) onChange(event.target.value ? { displayToken: event.target.value, values: {} } : undefined) }}>
      <option value="">{t('仅显示游戏，不设置子状态', 'Game only, no substatus')}</option>
      {presence && !template && <option value={presence.displayToken} disabled>{t('原模板已不可用，请重新选择', 'Previous template unavailable; select another')}: {presence.displayToken}</option>}
      {info.templates.map(value => <option key={value.token} value={value.token}>{value.text} ({value.token})</option>)}
    </select></label>
    <GameStatusTemplateDiagnostics info={info} onRetry={onRetry} disabled={disabled} />
    {info.templates.length === 0 && <p className="game-status-help">{info.templateStatus === 'unavailable'
      ? t('本次未能取得官方子状态模板，不代表游戏不支持。可以重试读取，或暂时只显示官方游戏名称与图标；不会退回任意 status 文字。', 'Published substatus templates could not be retrieved this time; this does not prove the game lacks support. Retry the lookup, or show only the official game name and icon. Arbitrary status text is not used as a fallback.')
      : info.templateStatus === 'empty'
        ? t('Steam 已返回本次模板结果，但没有可安全渲染的公开子状态模板。可以只显示游戏名称与图标，不能添加任意原生第二行文字。', 'Steam returned the template result, but it contains no safely renderable published substatus templates. You can show the game name and icon, not arbitrary native second-line text.')
        : t('未取得可安全渲染的公开模板。可以只显示游戏；不能把任意 status 文字当成原生子状态。', 'No safely renderable published template is available. You can display the game alone; arbitrary status text is not a native substatus.')}</p>}
    {template && hints.some(hint => hint.kind !== 'text') && <p className="game-status-help">{t('以下可用值从游戏实际发布的模板推导，左侧是提交值，右侧是显示含义。修改这里只编辑草稿，点击更新才会提交。', 'Choices below are derived from game-published templates: submitted value on the left, display meaning on the right. Changes here only edit the draft; click Update to submit.')}</p>}
    {template && <div className="game-status-form-grid">{hints.map((hint, index) => {
      const value = fieldValue(hint.key)
      const selected = hint.options.find(option => option.value.toLowerCase() === value.toLowerCase())
      const unknown = Boolean(value && hint.kind === 'choice' && !selected)
      const inputId = `${id}-parameter-${index}`
      return <label key={hint.key} htmlFor={inputId} className="game-status-parameter">{hint.key}
        {hint.kind === 'choice' ? <select id={inputId} disabled={disabled} value={selected?.value ?? value} aria-invalid={unknown || undefined} aria-describedby={`${inputId}-help`} onChange={event => changeField(hint.key, event.target.value)}>
          <option value="">{t('请选择官方可用值', 'Select a published value')}</option>
          {unknown && <option value={value} disabled>{t('无效值', 'Invalid value')}: {value}</option>}
          {hint.options.map(option => <option key={option.value} value={option.value}>{option.value}{option.label !== option.value ? ` — ${option.label}` : ''}</option>)}
        </select> : <input id={inputId} disabled={disabled} value={value} aria-describedby={`${inputId}-help`} list={hint.options.length ? `${inputId}-options` : undefined} onChange={event => changeField(hint.key, event.target.value)} />}
        {hint.kind !== 'choice' && hint.options.length > 0 && <datalist id={`${inputId}-options`}>{hint.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>}
        <span id={`${inputId}-help`} className={`game-status-parameter-help${unknown ? ' invalid' : ''}`}>{hint.kind === 'choice'
          ? unknown ? t('这个值不在官方列表中，请重新选择。', 'This value is not in the published list. Select another.') : hint.options.length === 0 ? t('当前字段组合没有匹配值，请调整相关参数。', 'No published value matches this combination. Adjust the related parameters.') : `${t('官方可用值', 'Published choices')}: ${hint.options.length}`
          : hint.kind === 'dependent' ? t('此字段参与组合模板，请先选择相关字段；完整组合仍需通过预览校验。', 'This field is part of a combined template. Select related fields first; the complete combination must pass preview validation.')
            : t(`自由文本，最多 ${richPresenceContract.presence.valueUtf8Bytes} 个 UTF-8 字节；不是所有游戏参数都支持自由填写。`, `Free text, up to ${richPresenceContract.presence.valueUtf8Bytes} UTF-8 bytes. Not every game parameter accepts arbitrary text.`)}</span>
      </label>
    })}</div>}
    {presence && <div className={`game-status-template-preview ${result.valid ? '' : 'invalid'}`} role="status"><span>{t('本机模板预览（不是好友端确认）', 'Local template preview (not confirmation from a friend)')}</span><strong>{result.valid ? result.preview : previewError}</strong></div>}
  </div>
}

export function GameStatusLockStatus({ lock, onUnlock, onRestore, disabled, verificationSource, readUnconfirmed = false }: { lock: GameStatusLiveLock; onUnlock(): void; onRestore(): void; disabled: boolean; verificationSource?: GameStatusLiveSnapshot['verificationSource']; readUnconfirmed?: boolean }): React.JSX.Element {
  const { language, t } = useI18n()
  const names: Record<GameStatusLiveLock['status'], string> = {
    checking: t('正在核对', 'Checking'), locked: verificationSource === 'local-cache' ? t('本机字段维持中（显示待核实）', 'Maintaining local fields (display unverified)') : t('持续锁定中', 'Lock active'), retrying: t('等待重试', 'Waiting to retry'), paused: t('锁定已暂停', 'Lock paused'), stopped: t('锁定已停止', 'Lock stopped')
  }
  const format = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : '—'
  return <section className="game-status-lock" aria-label={t('子状态锁定', 'Substatus lock')}><div className="game-status-section-title"><h3>{names[lock.status]}</h3><span className="game-status-badge">AppID {lock.appId}</span></div>
    <dl><div><dt>{t('锁定字段', 'Locked fields')}</dt><dd>{Object.keys(lock.desired).join(', ') || '—'}</dd></div><div><dt>{t('最近回读', 'Latest readback')}</dt><dd>{format(lock.lastCheckedAt)} · {lock.matched && !readUnconfirmed ? verificationSource === 'local-cache' ? t('本机缓存字段匹配', 'Local cached fields match') : t('匹配', 'Matched') : t('未确认匹配', 'Not confirmed')}</dd></div><div><dt>{t('下次核对', 'Next check')}</dt><dd>{format(lock.nextCheckAt)}</dd></div></dl>
    {readUnconfirmed && <p className="game-status-inline-error">{t('最近读取或上下文核对未完成；以下锁定结果来自上次核对，尚不能确认当前匹配。', 'The latest read or context verification did not complete. The lock result below is from the previous check and does not confirm a current match.')}</p>}
    {lock.localizedString && <p className="game-status-readback"><span>{readbackLabel(verificationSource, t)}</span><strong>{lock.localizedString}</strong></p>}
    {verificationSource === 'local-cache' && <p className="game-status-help">{t('匹配仅指本机 Steam 缓存字段一致，不是独立服务端或好友端确认。', 'A match means only that local Steam cached fields agree, not independent server or friend-client confirmation.')}</p>}
    {(lock.error || lock.consecutiveFailures > 0) && <p className="game-status-inline-error">{t('最近核对未完成，连续失败', 'The latest check did not complete; consecutive failures')}: {lock.consecutiveFailures}{lock.error ? ` · ${lock.error}` : ''}</p>}
    <p className="game-status-help">{t('只定期重申这些字段，不阻止游戏瞬间覆写。退出游戏、切换游戏或账号、断线会停止；不修改真实游戏的运行状态。', 'Only these fields are periodically reasserted; the game can briefly overwrite them. Exiting or changing the game, switching accounts, or disconnecting stops the lock; the running game is not changed.')}</p>
    <div className="game-status-actions"><button disabled={disabled || lock.status === 'stopped'} onClick={onUnlock}>{t('解除锁定（保留当前值）', 'Unlock (keep current values)')}</button><button disabled={disabled || lock.status === 'stopped'} onClick={onRestore}>{t('解除并安全恢复原字段', 'Unlock and safely restore original fields')}</button></div>
  </section>
}

export function isGameStatusFieldEditable(live: GameStatusLiveSnapshot, key: string): boolean {
  return Object.hasOwn(live.fields, key) && key.toLowerCase() !== 'steam_display' && live.editableKeys.includes(key) && !live.readOnlyKeys.includes(key)
}

export function GameStatusPanel({ activeAccount, api, localSimulationApi, statusCopyApi }: GameStatusPanelProps): React.JSX.Element {
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
  const [tab, setTab] = useState<Tab>('live')
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
  const localSignedIn = signedIn && snapshot?.connectionKind === 'local'
  const localConnectionPaused = snapshot?.localConnectionAvailable === false
  const cmSignedIn = signedIn && snapshot?.connectionKind === 'cm'
  const simulationReady = cmSignedIn && snapshot?.simulationReady === true
  const canRecheckSimulation = cmSignedIn && !simulationReady && !snapshot?.blocked
  const working = loading || busy !== null || Boolean(sameAccount && snapshot?.busy)
  const foregroundWorking = loading || busy !== null
  const visibleSnapshot = sameAccount ? snapshot : null
  const localDetectionUnavailable = visibleSnapshot?.failure?.code === 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE'
  const liveContextUnconfirmed = visibleSnapshot?.failure?.stage === 'context'
  const liveReadFailed = localDetectionUnavailable || liveContextUnconfirmed || visibleSnapshot?.failure?.stage === 'read_presence' || visibleSnapshot?.failure?.stage === 'readback'
  const liveStale = Boolean(editor && (!sameAccount || snapshot?.live?.snapshotId !== editor.snapshotId || liveReadFailed))
  const changedFields = useMemo(() => editor ? Object.fromEntries(Object.keys(editor.fields)
    .filter(key => key !== GROUP_SIZE_KEY && isGameStatusFieldEditable(editor, key) && (editedFields[key] ?? editor.fields[key]) !== editor.fields[key])
    .map(key => [key, editedFields[key] ?? editor.fields[key] ?? ''])) : {}, [editor, editedFields])
  const changedCount = Object.keys(changedFields).length
  const parsedAppId = Number(appIdText)
  const validAppId = /^\d+$/.test(appIdText) && Number.isSafeInteger(parsedAppId) && parsedAppId > 0 && parsedAppId <= 0xffffff
  const visibleSimulationInfo = simulationInfo?.appId === parsedAppId ? simulationInfo : null
  const visibleLiveInfo = liveInfo?.appId === editor?.appId ? liveInfo : null
  const liveVerificationSource = visibleSnapshot?.connectionKind === 'local' ? 'local-cache' : editor?.verificationSource
  const simulationPresence = gameStatusPresenceResult(visibleSimulationInfo, draft.presence)
  const livePresenceResult = gameStatusPresenceResult(visibleLiveInfo, livePresence)
  const activeLiveLock = Boolean(visibleSnapshot?.liveLock && visibleSnapshot.liveLock.status !== 'stopped')
  const hasRestorablePatch = Boolean(visibleSnapshot?.live?.patchActive && !activeLiveLock)
  const simulationSwitchBlocked = localSignedIn && (activeLiveLock || hasRestorablePatch)
  const liveGroupSize = readGroupSize(editor?.fields[GROUP_SIZE_KEY])
  const groupEditText = editedFields[GROUP_SIZE_KEY] ?? editor?.fields[GROUP_SIZE_KEY] ?? ''
  const groupEditSize = readGroupSize(groupEditText)
  const groupWriteAllowed = Boolean(editor && liveGroupSize !== null && groupEditSize !== null && groupEditText !== editor.fields[GROUP_SIZE_KEY] && isGameStatusFieldEditable(editor, GROUP_SIZE_KEY) && !working && localSignedIn && !liveStale && !activeLiveLock && !hasRestorablePatch)
  const draftValue = (): GameStatusDraft => ({ ...draft, ...(localSimulationApi && tab === 'simulate' ? { displayKind: 'app', details: '' } : {}), ...((draft.displayKind === 'app' || localSimulationApi && tab === 'simulate') && validAppId ? { appId: parsedAppId, gameName: visibleSimulationInfo?.name ?? '', details: '' } : { appId: undefined, presence: undefined }) })
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
      if (label === 'loginLocal' || label === 'loginCM' || label === 'logout' || label === 'refresh') {
        if (latestId !== sessionId && latestId !== stateResult?.sessionId) return
      } else if (latestId !== sessionId || (stateResult && stateResult.sessionId !== sessionId)) return
      apply(result)
    } catch (error) {
      if (epoch.current === generation && selectedIdentity.current === owner && lock.current === token) setNotice({ kind: 'error', text: gameStatusError(error, t) })
    } finally {
      if (epoch.current === generation && lock.current === token) { lock.current = null; setBusy(null) }
    }
  }

  async function runLive<T>(label: string, action: (context: GameStatusAction) => Promise<T>, apply: (result: T) => void): Promise<void> {
    if (!localSignedIn) return
    await run(label, action, apply)
  }

  const applyGroupSize = (keepLocked: boolean): void => {
    if (!editor || !groupWriteAllowed) return
    const latest = snapshotRef.current
    if (selectedIdentity.current !== identityKey || !latest || latest.sessionId !== snapshot?.sessionId || latest.accountId !== accountId || latest.boundSteamId !== expectedSteamId || latest.steamId !== expectedSteamId || !latest.connected || latest.connectionKind !== 'local' || latest.busy || latest.live?.snapshotId !== editor.snapshotId || latest.live.fields[GROUP_SIZE_KEY] !== editor.fields[GROUP_SIZE_KEY] || latest.live.patchActive || latest.liveLock && latest.liveLock.status !== 'stopped' || latest.failure && ['context', 'read_presence', 'readback'].includes(latest.failure.stage)) return
    void runLive(keepLocked ? 'lockGroup' : 'patchGroup', context => {
      const input = { ...context, snapshotId: editor.snapshotId, changes: { [GROUP_SIZE_KEY]: groupEditText } }
      return keepLocked ? api.lockLive(input) : api.patchLive(input)
    }, replaceLive)
  }

  const changeDraft = (patch: Partial<GameStatusDraft>): void => { draftRevision.current++; setDraft(value => ({ ...value, ...patch })); setDraftDirty(true) }
  const updateAppId = (value: string): void => { draftRevision.current++; setAppIdText(value); setSimulationInfo(null); setDraft(previous => ({ ...previous, presence: undefined })); setDraftDirty(true) }
  const inspectSimulation = (): void => {
    if (!cmSignedIn || !validAppId) return
    const revision = draftRevision.current; const requestedId = parsedAppId; const requestedLanguage = language
    void run('inspectSimulation', context => api.inspectApp({ ...context, appId: requestedId, language: language === 'en' ? 'english' : 'schinese' }), info => {
      if (draftRevision.current !== revision || Number(appIdRef.current) !== requestedId || info.appId !== requestedId || requestedLanguage !== languageRef.current) return
      setSimulationInfo(info)
    })
  }
  const inspectLive = (): void => {
    if (!localSignedIn || !editor || liveStale || editor.displayTokenReadable === false) return
    const revision = liveDraftRevision.current; const requestedId = editor.appId; const requestedSnapshot = editor.snapshotId; const requestedLanguage = language
    void runLive('inspectLive', context => api.inspectApp({ ...context, appId: requestedId, language: language === 'en' ? 'english' : 'schinese' }), info => {
      if (liveDraftRevision.current !== revision || snapshotRef.current?.live?.snapshotId !== requestedSnapshot || info.appId !== requestedId || languageRef.current !== requestedLanguage) return
      setLiveInfo(info)
    })
  }
  const connectLocal = (): void => { if (!localConnectionPaused) void run('loginLocal', context => api.connectLocal(context), replaceLive) }
  const connectWithToolbox = (): void => { if (!simulationSwitchBlocked) void run('loginCM', context => api.connectWithToolbox(context), replaceLive) }
  const simulate = (): void => {
    if (!simulationReady) return
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
    { id: 'simulate', label: localSimulationApi ? t('本机 AppID 模拟', 'Local AppID simulation') : t('自定义模拟', 'Simulated display') },
    { id: 'live', label: t('真实游戏状态', 'Live game status') },
    ...(statusCopyApi ? [{ id: 'copy' as const, label: t('复制／跟随状态', 'Copy / follow status') }] : []),
    { id: 'draft', label: t('本机草稿', 'Local draft') }
  ]

  return <div className="game-status-panel">
    <header className="game-status-heading"><div><span className="game-status-eyebrow">{t('STEAM 游戏状态', 'STEAM GAME STATUS')}</span><h2>{t('游戏状态工具', 'Game status tools')}</h2><p>{t('显示官方游戏与模板子状态，或编辑并持续锁定当前真实游戏的公开状态。', 'Display an official game and published substatus, or edit and keep the current real game’s exposed status locked.')}</p></div>
      <span className={`game-status-badge ${tab !== 'copy' && signedIn ? 'connected' : ''}`}>{tab === 'copy' ? t('独立转发模块', 'Separate relay module') : statusLabel(visibleSnapshot?.status, t)}</span>
    </header>

    {!activeAccount ? <section className="game-status-card game-status-empty"><span aria-hidden="true">◉</span><h3>{t('先选择一个工具箱账号', 'Select a toolbox account first')}</h3><p>{t('游戏状态连接、修改与本机草稿都绑定到当前选中账号。', 'Game status connections, changes and local drafts are bound to the selected account.')}</p></section> : <>
      <section className="game-status-binding" aria-label={t('当前账号绑定', 'Current account binding')}><span className="game-status-account-icon" aria-hidden="true">{(activeAccount.displayName || activeAccount.accountName).slice(0, 1).toUpperCase()}</span><div><strong>{activeAccount.displayName || activeAccount.accountName}</strong><span>{t('强绑定 SteamID', 'Bound SteamID')} <code>{activeAccount.steamId}</code></span></div><p>{t('本机 Steam 必须登录此账号；连接时核验 SteamID，不向本页面传递登录凭据。', 'The local Steam client must use this account. Its SteamID is verified on connection; sign-in credentials are not passed to this page.')}</p></section>

      {(!localSimulationApi || tab === 'live') && <section className="game-status-card game-status-login"><div className="game-status-section-title"><div><h3>{t('连接本机 Steam', 'Connect local Steam')}</h3><p>{t('直接复用正在运行的本机 Steam 与真实游戏，不重新登录账号，也不新建个人 CM 会话。', 'Use the running local Steam client and real game directly, without signing in again or creating a separate personal CM session.')}</p></div><button className="ghost" disabled={working || !snapshot} onClick={() => void run('refresh', () => api.state(), setSnapshot)}>{t('刷新状态', 'Refresh state')}</button></div>
        <div className="game-status-connect-actions"><button className="primary" disabled={working || !snapshot || localSignedIn || localConnectionPaused || visibleSnapshot?.status === 'connecting'} onClick={connectLocal}>{busy === 'loginLocal' || visibleSnapshot?.status === 'connecting' ? t('正在连接…', 'Connecting…') : t('连接本机 Steam（不重新登录）', 'Connect local Steam (no new sign-in)')}</button><button disabled={working || !sameAccount || !snapshot} onClick={() => void run('logout', context => api.logout(context), replaceLive)}>{t('断开游戏状态连接', 'Disconnect game status')}</button></div>
        {localConnectionPaused && <p className="game-status-notice info" role="status">{t('真实游戏连接与锁定暂时停用：实测发现仅连接也可能使游戏原生子状态消失。修复并验证前不会启动该连接，也不会自动改用模拟会话。其他工具不受影响。', 'Live game connection and locking are temporarily disabled: connecting alone was observed to hide the game\'s native substatus. This connection will not start until a fix is verified, and no simulation fallback is used. Other tools are unaffected.')}</p>}
        <p className="game-status-help">{t('打开本页不会自动连接或修改状态。请先启动 Steam 与游戏，确认本机 Steam 账号和上方账号一致，再连接并读取。本机连接失败不会自动改用个人 CM 登录。', 'Opening this page does not automatically connect or change status. Start Steam and the game, verify the account above matches local Steam, then connect and read. A failed local connection never falls back to a personal CM sign-in.')}</p>
        {localSignedIn && visibleSnapshot?.live?.patchActive && <p className="game-status-notice info" role="status">{t('当前修改仍有安全恢复记录。请先解除锁定（如已启用）并安全恢复，再断开连接、切换账号或关闭工具箱。直接断开不会自动恢复；恢复记录仅在本次游戏状态会话中有效，不会保存到下次启动。你仍可随时停止或退出。', 'A safe-restore record remains for the current edit. Unlock if enabled and safely restore before disconnecting, switching accounts, or closing the toolbox. Disconnecting does not restore fields automatically. The restore record is valid only for this game-status session and is not saved for the next launch. You can still stop or exit at any time.')}</p>}
        <GameStatusConnectionNotice snapshot={visibleSnapshot} />
        {sameAccount && snapshot?.status === 'logged_on' && !identityMatches && <p className="game-status-inline-error">{t('登录身份与选中 SteamID 不一致，显示与状态修改已禁用。', 'The signed-in identity differs from the selected SteamID. Display and status changes are disabled.')}</p>}
      </section>}

      <div className="game-status-tabs" role="tablist" aria-label={t('游戏状态功能', 'Game status features')}>{tabs.map(item => <button key={item.id} id={`${baseId}-${item.id}-tab`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${baseId}-${item.id}`} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'draft' && draftDirty && <i aria-label={t('未保存', 'Unsaved')} />}</button>)}</div>
      {tab === 'copy' && statusCopyApi && <section role="tabpanel" id={`${baseId}-copy`} aria-labelledby={`${baseId}-copy-tab`}><StatusCopyPanel account={activeAccount} api={statusCopyApi} /></section>}
      {notice && <div className={`game-status-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {tab === 'simulate' && localSimulationApi && <LocalAppSimulationPanel account={activeAccount} api={localSimulationApi}
        appIdText={appIdText} onAppIdChange={value => { changeDraft({ displayKind: 'app', details: '' }); updateAppId(value) }} presence={draft.presence}
        onPresenceChange={presence => changeDraft({ displayKind: 'app', details: '', presence })}
        groupSize={draft.groupSize} onGroupSizeChange={groupSize => changeDraft({ groupSize })}
        onSaveDraft={saveDraft} saveBusy={working} liveRestoreRequired={localSignedIn && (activeLiveLock || hasRestorablePatch)} />}
      {tab === 'simulate' && !localSimulationApi && <section className="game-status-card" role="tabpanel" id={`${baseId}-simulate`} aria-labelledby={`${baseId}-simulate-tab`}>
        <div className="game-status-section-title"><div><h3>{t('手动显示游戏', 'Set a simulated game display')}</h3><p>{t('可离线编辑；连接工具箱账号后，点击应用才会提交。', 'Edit offline; nothing is submitted until you connect the toolbox account and apply it.')}</p></div></div>
        <p className="game-status-notice info">{t('模拟显示需要新建独立的个人 CM 会话，可能使 Steam 好友界面刷新。仅用于自定义模拟；真实游戏状态请使用上方“连接本机 Steam”，不会自动改用此登录方式。', 'Simulation creates a separate personal CM session and may refresh the Steam friends interface. Use it only for simulation. Live game status uses Connect local Steam above and never automatically switches to this sign-in method.')}</p>
        <div className="game-status-connect-actions"><button disabled={working || !snapshot || (cmSignedIn && !canRecheckSimulation) || simulationSwitchBlocked || visibleSnapshot?.status === 'connecting'} onClick={connectWithToolbox}>{busy === 'loginCM' ? t('正在核对／连接…', 'Checking / connecting…') : canRecheckSimulation ? t('重新核对模拟权限（不重新登录）', 'Recheck simulation permission (no new sign-in)') : t('连接模拟用独立会话', 'Connect a separate simulation session')}</button></div>
        {simulationSwitchBlocked && <p className="game-status-notice info">{t('真实游戏仍有锁定或安全恢复记录。请先回到“真实游戏状态”解除锁定并安全恢复，再连接模拟；不会直接丢弃记录或重登。', 'The live game has a lock or safe-restore record. Unlock and safely restore it on Live game status before connecting simulation; the record is not silently discarded and no sign-in is started.')}</p>}
        {cmSignedIn && !visibleSnapshot?.blocked && !simulationReady && <p className="game-status-notice info" role="status">{t('正在核对本机 Steam 账号和游戏状态；核对完成前不会提交模拟。若检查未完成，可点击“重新核对模拟权限”，复用当前连接，不会重新登录或抢占游戏。', 'Verifying the local Steam account and game state; simulation is not submitted before verification. Use Recheck simulation permission to reuse the current connection without signing in again or taking over a game.')}</p>}
        <div className="game-status-actions"><button type="button" disabled={!signedIn || !visibleSnapshot?.blockingAppId} onClick={() => setTab('live')}>{t('编辑当前正在玩的游戏', 'Edit the game currently being played')}</button></div>
        <div className="game-status-form-grid"><label>{t('显示方式', 'Display type')}<select value={draft.displayKind} onChange={event => changeDraft({ displayKind: event.target.value as GameStatusDraft['displayKind'] })}><option value="custom">{t('自定义非 Steam 游戏名称', 'Custom non-Steam game name')}</option><option value="app">{t('Steam AppID', 'Steam AppID')}</option></select></label>
          {draft.displayKind === 'app' ? <label>{t('Steam AppID', 'Steam AppID')}<input inputMode="numeric" value={appIdText} placeholder="1329410" onChange={event => updateAppId(event.target.value)} /></label> : <label>{t('游戏名称', 'Game name')}<input value={draft.gameName} onChange={event => changeDraft({ gameName: event.target.value })} placeholder={t('自定义非 Steam 游戏', 'Custom non-Steam game')} /></label>}
          {draft.displayKind === 'custom' && <label className="game-status-wide">{t('合并到名称的补充文字（不是原生子状态）', 'Additional title text (not a native substatus)')}<input value={draft.details} onChange={event => changeDraft({ details: event.target.value })} /></label>}
        </div>
        {draft.displayKind === 'app' && <><div className="game-status-actions"><button disabled={working || !cmSignedIn || !validAppId} onClick={inspectSimulation}>{busy === 'inspectSimulation' ? t('读取中…', 'Reading…') : t('读取官方游戏信息与模板', 'Read published game info and templates')}</button></div>{visibleSimulationInfo && <><GameStatusIdentity game={visibleSimulationInfo} /><GameStatusTemplateEditor id={`${baseId}-simulation`} info={visibleSimulationInfo} presence={draft.presence} onChange={presence => changeDraft({ presence })} disabled={working} /></>}</>}
        <div className="game-status-draft-preview"><span>{t('本机草稿预览', 'Local draft preview')}</span><strong>{draft.displayKind === 'custom' ? draft.gameName.trim() ? `${draft.gameName.trim()}${draft.details.trim() ? ` · ${draft.details.trim()}` : ''}` : t('等待填写游戏名称', 'Enter a game name') : visibleSimulationInfo?.name ?? `Steam AppID ${appIdText || '—'}`}</strong>{simulationPresence.preview && draft.displayKind === 'app' && <span>{simulationPresence.preview}</span>}<small>{draft.displayKind === 'custom' ? t('名称和补充文字合并为一行非 Steam 游戏名称；没有官方游戏图标或原生第二级状态。请使用 AppID 模式显示官方游戏。', 'The name and extra text form one non-Steam game title, with no official game icon or native second-line status. Use AppID mode for an official game.') : t('仅使用这个游戏发布的模板生成子状态，不再发送任意 status。这里是本机预览，不代表好友端显示已确认。', 'Substatus uses only templates published by this game, not arbitrary status text. This is a local preview, not confirmation of a friend’s display.')}</small></div>
        {visibleSnapshot?.playing && <section className="game-status-submitted" aria-label={t('当前已提交显示', 'Current submitted display')}><GameStatusIdentity game={visibleSnapshot.playing.game} appId={visibleSnapshot.playing.appId} /><strong>{visibleSnapshot.playing.displayName}</strong>{visibleSnapshot.playing.preview && <p>{visibleSnapshot.playing.preview}</p>}<p className="game-status-help">{t('已向 Steam 提交；本机预览不等于好友客户端实际显示确认。', 'Submitted to Steam; a local preview is not confirmation of what a friend’s client displays.')}</p></section>}
        {visibleSnapshot?.blocked && <p className="game-status-help">{t('账号正在真实游戏中，模拟显示已禁用。可切换到“真实游戏状态”读取当前字段。', 'The account is playing a real game, so simulation is disabled. Open Live game status to read its current fields.')}</p>}
        <div className="game-status-actions"><button className="primary" disabled={working || !simulationReady || Boolean(snapshot?.blocked) || (draft.displayKind === 'app' && (!validAppId || !visibleSimulationInfo || !simulationPresence.valid))} onClick={simulate}>{busy === 'play' ? t('提交中…', 'Submitting…') : t('应用模拟显示', 'Apply simulated display')}</button><button disabled={foregroundWorking || !cmSignedIn} onClick={() => { if (cmSignedIn) void run('stop', context => api.stop(context), setSnapshot) }}>{t('停止模拟显示', 'Stop simulated display')}</button><button className="ghost" disabled={working || !snapshot} onClick={saveDraft}>{t('保存本机草稿', 'Save local draft')}</button></div>
      </section>}

      {tab === 'live' && <section className="game-status-card" role="tabpanel" id={`${baseId}-live`} aria-labelledby={`${baseId}-live-tab`}><div className="game-status-section-title"><div><h3>{t('真实游戏：子状态编辑与锁定', 'Real game: substatus editing and locking')}</h3><p>{t('先连接本机 Steam 并读取当前游戏。直接修改已观察到的公开参数（例如 desc），锁定不新建个人 CM 登录或抢占游戏会话。', 'Connect local Steam and read the current game first. Edit observed exposed parameters such as desc directly; locking neither creates a personal CM sign-in nor takes over the game session.')}</p></div><button disabled={working || !localSignedIn} onClick={() => void runLive('observe', context => api.observeLive(context), replaceLive)}>{busy === 'observe' ? t('读取中…', 'Reading…') : t('读取当前游戏', 'Read current game')}</button></div>
        {cmSignedIn && <p className="game-status-notice info">{t('当前连接是模拟用个人 CM 会话，真实游戏编辑已禁用。请点击上方“连接本机 Steam”切换；不会自动重新登录。', 'The current connection is a personal CM simulation session, so live game editing is disabled. Switch using Connect local Steam above; no sign-in happens automatically.')}</p>}
        {visibleSnapshot?.liveLock && <GameStatusLockStatus lock={visibleSnapshot.liveLock} verificationSource={visibleSnapshot.connectionKind === 'local' ? 'local-cache' : visibleSnapshot.live?.verificationSource} readUnconfirmed={liveReadFailed} disabled={foregroundWorking || !localSignedIn} onUnlock={() => void runLive('unlock', context => api.unlockLive({ ...context, restore: false }), replaceLive)} onRestore={() => void runLive('unlockRestore', context => api.unlockLive({ ...context, restore: true }), replaceLive)} />}
        {sameAccount && snapshot?.lastOperation && !liveReadFailed && <div className={`game-status-notice ${snapshot.lastOperation.outcome === 'matched' && snapshot.connectionKind !== 'local' && snapshot.lastOperation.verificationSource !== 'local-cache' ? 'success' : 'info'}`} role="status">{operationLabel(snapshot.connectionKind === 'local' ? { ...snapshot.lastOperation, verificationSource: 'local-cache' } : snapshot.lastOperation, t)}</div>}
        {!editor ? <div className="game-status-live-empty"><strong>{t('还没有当前游戏快照', 'No current game snapshot')}</strong><p>{t('读取后会显示公开键和值。steam_display 始终只读，不能靠任意文字伪造官方详细状态。', 'Read the game to see its exposed keys and values. steam_display is always read-only; arbitrary text cannot invent official rich-presence states.')}</p></div> : <>
          <GameStatusIdentity game={editor.game ?? visibleLiveInfo} appId={editor.appId} />
          <div className="game-status-live-meta"><span>{formatTime(editor.observedAt)}</span><span>{editor.fields && Object.keys(editor.fields).length} {t('个公开字段', 'exposed fields')}</span><span>{changedCount} {t('项未提交修改', 'unsubmitted changes')}</span></div>
          <p className="game-status-readback"><span>{readbackLabel(liveVerificationSource, t)}</span><strong>{editor.localizedString || editor.fields.desc || t('未取得可显示的子状态；不能确认好友端显示。', 'No displayable substatus was obtained; the friend-client display is not confirmed.')}</strong></p>
          {!editor.localizedString && editor.fields.desc && <p className="game-status-help">{t('这里展示已观察到的公开 desc 字段，不是模板渲染或好友端确认。', 'This shows the observed exposed desc field, not template rendering or friend-client confirmation.')}</p>}
          {liveStale && <div className="game-status-notice info">{localDetectionUnavailable ? t('暂时无法核实本机 Steam 与游戏，以下是上次快照，旧编辑内容不能提交；尚未证明账号或游戏已经变化。请手动重新读取，安全恢复记录仍保留。', 'Local Steam and the game could not be verified. The previous snapshot is shown and old edits cannot be submitted; this does not prove that the account or game changed. Read again manually; safe-restore records are retained.') : liveContextUnconfirmed ? t('本机状态连接或上下文未通过核对，以下是上次快照，旧编辑内容不能提交。请手动重新读取；已有安全恢复记录仍需重新校验，不会自动覆盖。', 'The local presence connection or context was not verified. The previous snapshot is shown and old edits cannot be submitted. Read again manually; existing safe-restore records still require revalidation and never trigger an automatic overwrite.') : liveReadFailed ? t('最近读取未完成，以下是上次快照，旧编辑内容不能提交。请成功重新读取后再修改；安全恢复记录会保留。', 'The latest read did not complete. The previous snapshot is shown and old edits cannot be submitted. Read successfully before editing again; safe-restore records are retained.') : t('当前游戏或快照已经变化，旧编辑内容已保留但不能提交。请重新读取。', 'The game or snapshot changed. Old edits are retained but cannot be submitted. Read the current game again.')}</div>}
          {hasRestorablePatch && <p className="game-status-notice info">{t('上次修改仍有安全恢复记录。可先安全恢复原字段；待核对或部分写入的记录会保留，重新读取不会自动重发。已被游戏覆盖的普通旧记录，或超过 10 分钟的记录，可在重新读取后建立新基线。', 'A safe-restore record remains from the previous edit. Safely restore original fields first. Unconfirmed or partial-write records are retained; reading again never resends them. A normal superseded record, or one over 10 minutes old, can be retired by reading again to establish a new baseline.')}</p>}
          {editor.displayTokenReadable === false ? <p className="game-status-notice info">{t('本机接口返回的 steam_display 是本地化显示文字，不是原始显示令牌，因此已禁用模板提交与令牌恢复，不会猜测令牌。可直接修改下表中已观察到的 desc 等公开可编辑参数并锁定；恢复只处理本次实际修改的参数。', 'The local interface returns localized steam_display text, not the original display token. Template submission and token restoration are disabled; no token is guessed. Edit and lock observed exposed parameters such as desc below. Restoration covers only parameters actually changed in this edit.')}</p> : <section className="game-status-live-display"><div className="game-status-section-title"><div><h3>{t('模板化子状态', 'Template-based substatus')}</h3><p>{t('使用当前游戏真正发布的模板；不伪造任意显示令牌。', 'Use templates actually published by this game, not invented display tokens.')}</p></div><button disabled={working || !localSignedIn || liveStale} onClick={inspectLive}>{busy === 'inspectLive' ? t('读取中…', 'Reading…') : t('读取子状态模板与图标', 'Read substatus templates and icon')}</button></div>
            {visibleLiveInfo && <GameStatusTemplateEditor id={`${baseId}-live-display`} info={visibleLiveInfo} presence={livePresence} disabled={working || !localSignedIn || liveStale || activeLiveLock} onChange={presence => { liveDraftRevision.current++; setLivePresence(presence) }} />}
            <label className="game-status-checkbox"><input type="checkbox" checked={lockDisplay} disabled={foregroundWorking || activeLiveLock} onChange={event => setLockDisplay(event.target.checked)} /><span>{t('持续锁定此子状态，游戏更新后定期重申', 'Keep this substatus locked and periodically reassert it after game updates')}</span></label>
            <button className="primary" disabled={working || !localSignedIn || liveStale || activeLiveLock || hasRestorablePatch || !livePresence || !livePresenceResult.valid} onClick={() => { if (livePresence) void runLive('liveDisplay', context => api.setLiveDisplay({ ...context, snapshotId: editor.snapshotId, presence: livePresence, lock: lockDisplay }), replaceLive) }}>{lockDisplay ? t('应用并锁定子状态', 'Apply and lock substatus') : t('单次应用子状态', 'Apply substatus once')}</button>
          </section>}
          <section className="game-status-live-display" aria-label={t('真实游戏同组人数', 'Live game group size')}><h3>{t('同组游玩人数', 'Players in group')}</h3>
            <p>{t('本机缓存中的同组总人数', 'Total players in the local group cache')}: {liveGroupSize ?? t('未取得', 'Unavailable')}</p>
            {liveGroupSize !== null ? <><label>{t('展示的总人数（包含你自己）', 'Displayed total players (including you)')}<input aria-label={t('真实游戏同组总人数', 'Live game total group size')} inputMode="numeric" value={groupEditText} disabled={working || !localSignedIn || liveStale || activeLiveLock || !isGameStatusFieldEditable(editor, GROUP_SIZE_KEY)} onChange={event => setEditedFields(values => ({ ...values, [GROUP_SIZE_KEY]: event.target.value }))} /></label>
              <p className="game-status-parameter-help">{groupEditSize === null ? `${t('请输入正整数，最大', 'Enter a positive whole number, up to')} ${MAX_GROUP_SIZE}` : `${t('换算为不含本人的人数（非好友端显示确认）', 'Calculated players excluding you (not friend-client confirmation)')}: ${groupEditSize - 1}`}</p>
              <div className="game-status-actions"><button disabled={!groupWriteAllowed} onClick={() => applyGroupSize(false)}>{t('单次应用人数', 'Apply group size once')}</button><button disabled={!groupWriteAllowed} onClick={() => applyGroupSize(true)}>{t('应用并锁定人数', 'Apply and lock group size')}</button></div>
            </> : <p className="game-status-help">{t('游戏尚未提供可核实的人数字段，不会凭空添加真实游戏分组。未取得不等于人数为零。', 'The game has not supplied a verifiable group-size field. No live-game group is invented. Unavailable does not mean zero.')}</p>}
            <p className="game-status-help">{t('只修改人数字段，不修改房间或分组标识、加入信息。不会真实增加玩家；最终显示由 Steam 决定。安全恢复与解除锁定使用下方原有按钮。', 'Only the count changes, never the room/group identifier or join data. This does not add real players; Steam controls the final display. Use the existing unlock and safe-restore controls below.')}</p>
            <p className="game-status-notice info">{t('查看方显示限制：Steam 的混合“In Game / 游戏中”单例列表不绘制组队人数。若查看号只有你一位好友玩该游戏，条目可能合并到该列表。请在独立游戏分组内核对；本机读回匹配不证明好友端已经收到或显示。', 'Viewer-side display limit: Steam does not draw party counts in the mixed In Game singleton list. If you are the viewer’s only friend playing this game, your entry may be merged there. Verify in a dedicated game group. Matching local readback does not prove receipt or display by a friend.')}</p>
          </section>
          <div className="game-status-key-table-wrap"><table className="game-status-key-table"><thead><tr><th scope="col">{t('公开键', 'Exposed key')}</th><th scope="col">{t('当前 / 编辑值', 'Current / edited value')}</th><th scope="col">{t('权限', 'Access')}</th></tr></thead><tbody>{Object.entries(editor.fields).filter(([key]) => key !== GROUP_SIZE_KEY).map(([key, value]) => {
            const editable = isGameStatusFieldEditable(editor, key)
            return <tr key={key}><th scope="row"><code>{key}</code>{key.toLowerCase() === 'steam_display' && editor.displayTokenReadable === false && <small>{t('本地化文字，非原始令牌', 'Localized text, not the original token')}</small>}</th><td>{editable ? <input aria-label={`${key} ${t('编辑值', 'edited value')}`} value={editedFields[key] ?? value} disabled={working || !localSignedIn || liveStale || activeLiveLock} onChange={event => setEditedFields(values => ({ ...values, [key]: event.target.value }))} /> : <code className="game-status-readonly-value">{value || '—'}</code>}</td><td><span className={editable ? 'game-status-field-editable' : 'game-status-field-readonly'}>{editable ? t('可编辑 / 锁定', 'Editable / lockable') : t('只读', 'Read-only')}</span></td></tr>
          })}</tbody></table></div>
          {Object.keys(editor.fields).length === 0 && <p className="game-status-help">{t('游戏当前没有公开详细字段，请等待场景变化后再读取。', 'The game currently exposes no detail fields. Read again after its state changes.')}</p>}
        </>}
        <label className="game-status-checkbox"><input type="checkbox" checked={lockFields} disabled={foregroundWorking || activeLiveLock} onChange={event => setLockFields(event.target.checked)} /><span>{t('持续锁定上表中本次修改的字段', 'Keep the changed fields in the table locked')}</span></label>
        <p className="game-status-help">{t('默认只提交一次。启用锁定后，仅定期核对并重申你修改的字段，不锁定其他游戏信息或加入令牌；游戏仍可瞬间覆写。回读匹配不等于好友端已经刷新。安全恢复仅在原会话和字段仍匹配时执行。', 'The default is a one-time submission. A lock checks and reasserts only your changed fields, not other game data or join tokens; the game may still briefly overwrite them. Matching readback does not prove a refreshed friend client. Safe restore runs only while the original session and fields still match.')}</p>
        <div className="game-status-actions"><button className="primary" disabled={working || !localSignedIn || !editor || !changedCount || liveStale || activeLiveLock || hasRestorablePatch} onClick={() => { if (editor) void runLive(lockFields ? 'lockFields' : 'patch', context => lockFields ? api.lockLive({ ...context, snapshotId: editor.snapshotId, changes: changedFields }) : api.patchLive({ ...context, snapshotId: editor.snapshotId, changes: changedFields }), replaceLive) }}>{lockFields ? t('应用并锁定修改字段', 'Apply and lock changed fields') : busy === 'patch' ? t('单次提交中…', 'Submitting once…') : t('仅提交这次修改', 'Submit these changes once')}</button><button disabled={working || !localSignedIn} onClick={() => void runLive('readback', context => api.observeLive(context), replaceLive)}>{t('重新读取 / 回读', 'Read again / read back')}</button><button disabled={working || !localSignedIn || !snapshot?.live?.patchActive || activeLiveLock} onClick={() => void runLive('restore', context => api.restoreLive(context), replaceLive)}>{busy === 'restore' ? t('恢复中…', 'Restoring…') : t('恢复本次修改前的字段', 'Restore fields from before this edit')}</button></div>
      </section>}

      {tab === 'draft' && <section className="game-status-card" role="tabpanel" id={`${baseId}-draft`} aria-labelledby={`${baseId}-draft-tab`}><div className="game-status-section-title"><div><h3>{t('当前账号的本机草稿', 'Local draft for this account')}</h3><p>{t('无需建立游戏状态连接，通过工具箱本机服务保存。草稿不含登录凭据，也不会自动应用。', 'Save through the toolbox’s local service without a game status connection. Drafts contain no sign-in credentials and are never auto-applied.')}</p></div><span className="game-status-badge">{draftDirty ? t('尚未保存', 'Unsaved') : t('草稿就绪', 'Draft ready')}</span></div>
        <dl className="game-status-draft-summary"><div><dt>{t('绑定账号', 'Bound account')}</dt><dd>{activeAccount.displayName || activeAccount.accountName} <code>{activeAccount.steamId}</code></dd></div><div><dt>{t('显示方式', 'Display type')}</dt><dd>{draft.displayKind === 'custom' ? t('自定义非 Steam 游戏', 'Custom non-Steam game') : t('Steam AppID', 'Steam AppID')}</dd></div><div><dt>{t('游戏名称 / AppID', 'Game name / AppID')}</dt><dd>{draft.displayKind === 'custom' ? draft.gameName || '—' : appIdText || '—'}</dd></div><div><dt>{t('补充文字', 'Additional text')}</dt><dd>{draft.details || '—'}</dd></div></dl>
        <div className="game-status-actions"><button className="primary" disabled={working || !snapshot} onClick={saveDraft}>{busy === 'saveDraft' ? t('保存中…', 'Saving…') : t('保存当前草稿到本机', 'Save current draft locally')}</button><button disabled={working || !snapshot} onClick={loadDraft}>{t('重新载入本机草稿', 'Reload local draft')}</button><button className="ghost" onClick={() => setTab('simulate')}>{t('返回编辑草稿', 'Return to draft editor')}</button></div><p className="game-status-help">{t('重新载入会替换当前编辑内容。真实游戏修改仍需重新读取游戏快照，不会从草稿自动恢复。', 'Reloading replaces current edits. Live-game changes still require a fresh game snapshot and are not automatically restored from drafts.')}</p>
      </section>}
    </>}
  </div>
}
