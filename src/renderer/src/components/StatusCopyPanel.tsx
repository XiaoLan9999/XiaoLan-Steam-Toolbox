import { useLayoutEffect, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import { STATUS_COPY_DEFAULTS, type StatusCopyApi, type StatusCopyCode, type StatusCopyMode, type StatusCopySettings, type StatusCopySettingsInput, type StatusCopySnapshot } from '../../../shared/status-copy'
import { useI18n } from '../i18n'

interface Props { account: AccountView; api: StatusCopyApi }
type Translate = (zh: string, en: string) => string
type Action = 'save' | 'preview' | 'start' | 'stop'
interface Draft {
  mode: StatusCopyMode
  sourceSteamId: string
  intervalText: string
  copyGroupSize: boolean
  persona: 'online' | 'away'
  asfUrl: string
  asfBot: string
}

const errors: Record<StatusCopyCode, readonly [string, string]> = {
  COPY_INVALID_INPUT: ['请检查源 Steam64ID、检查间隔及 ASF 配置。', 'Check the source Steam64ID, interval and ASF settings.'],
  COPY_SOURCE_EQUALS_TARGET: ['源账号②不能与目标账号①相同。', 'Source account ② must differ from target account ①.'],
  COPY_TARGET_IS_LOCAL: ['本机 Steam 当前登录的是目标账号①，请先切换到源账号②；不会自动切号。', 'Local Steam is signed into target ①. Switch it to source ② yourself; the toolbox will not switch accounts.'],
  COPY_LOCAL_UNAVAILABLE: ['暂时无法核实本机源账号②，请确认 Steam 正常运行且账号一致。', 'Local source account ② could not be verified. Check Steam and the signed-in account.'],
  COPY_LOGIN_REQUIRED: ['目标账号①需要先在工具箱完成登录。', 'Sign target account ① into the toolbox first.'],
  COPY_IDENTITY_MISMATCH: ['源或目标账号身份不一致，未继续复制。', 'The source or target identity did not match. Copying did not continue.'],
  COPY_SOURCE_UNAVAILABLE: ['源状态暂不可读；私密、离线、可见性或源配置都可能影响读取。', 'Source status is unavailable. Privacy, offline state, visibility or source settings may prevent reading.'],
  COPY_SOURCE_NOT_FRIEND: ['当前读取会话无法按好友关系取得源状态，请核对两账号关系。', 'The reading session cannot obtain source status through the friend relationship. Check both accounts.'],
  COPY_SOURCE_NOT_PLAYING: ['尚未取得源账号正在游玩的游戏，请保持源游戏运行后重试。', 'No source game is available. Keep the source game running and retry.'],
  COPY_SOURCE_STALE: ['源数据新鲜度未确认，未使用旧数据继续提交。', 'Source freshness is unconfirmed. Stale data was not submitted again.'],
  COPY_REQUEST_FAILED: ['状态复制操作未完成，请检查连接和当前任务后重试。', 'The status-copy operation did not complete. Check the connection and current task before retrying.'],
  COPY_SESSION_CHANGED: ['账号、来源或会话已变化，请重新预览核对。', 'The account, source or session changed. Preview again before continuing.'],
  COPY_BUSY: ['上一个操作尚未结束，可以使用停止／取消。', 'The previous operation is still running. Stop / cancel remains available.'],
  COPY_STOP_UNCONFIRMED: ['尚未确认停止。ASF 连接中断时任务可能仍在运行；请恢复连接并核对，不要启动重复任务。', 'Stopping is unconfirmed. An ASF task may still be running after a connection failure. Reconnect and verify it before starting a duplicate.'],
  COPY_ASF_INCOMPATIBLE: ['ASF 或状态复制插件不兼容，请先核对插件版本与配置。', 'ASF or its status-copy plugin is incompatible. Check its version and configuration.'],
  COPY_ASF_BOT_UNAVAILABLE: ['源②和目标①都必须对应已登录、在线的 ASF 机器人；此处不会启动机器人。', 'Source ② and target ① must both be signed-in, online ASF bots. This panel never starts bots.'],
  COPY_ASF_CONFIG_CONFLICT: ['已有插件配置或运行中的任务，未覆盖。只可明确允许替换已停止任务的配置。', 'An existing plugin configuration or active task was not overwritten. Only a stopped configuration may be explicitly replaced.'],
  COPY_ASF_GROUP_UNSUPPORTED: ['当前 ASF 插件不支持复制同组人数，已禁止提交该选项。', 'The current ASF plugin does not support group-size copying. That option cannot be submitted.'],
  COPY_TEMPLATE_UNAVAILABLE: ['未取得可验证的游戏子状态模板，不能把显示文字冒充原始状态。', 'A verified game substatus template is unavailable. Display text cannot be treated as the original status.'],
  COPY_LIVE_RESTORE_REQUIRED: ['请先解除真实游戏锁定并安全恢复，再开始状态复制。', 'Unlock and safely restore the live-game edit before starting status copy.'],
  COPY_PLAYING_BLOCKED: ['目标账号①另有游玩会话，未强制抢占。请先自行处理该会话。', 'Target account ① has another playing session. It was not forcibly taken over; resolve that session first.']
}

function copyCode(code: unknown): StatusCopyCode {
  return typeof code === 'string' && Object.hasOwn(errors, code) ? code as StatusCopyCode : 'COPY_REQUEST_FAILED'
}
export function statusCopyError(code: unknown, t: Translate): string {
  const message = errors[copyCode(code)]
  return t(message[0], message[1])
}
function initialDraft(settings: StatusCopySettings): Draft {
  return { mode: settings.mode, sourceSteamId: settings.sourceSteamId, intervalText: String(settings.intervalSeconds),
    copyGroupSize: settings.mode === 'toolbox' && settings.copyGroupSize, persona: settings.persona,
    asfUrl: settings.asf?.url ?? '', asfBot: settings.asf?.botName ?? '' }
}
function validUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash }
  catch { return false }
}
function validDraft(draft: Draft, targetSteamId: string): boolean {
  const interval = Number(draft.intervalText), minimum = draft.mode === 'asf' ? 15 : 5
  return /^[0-9]{17}$/.test(draft.sourceSteamId) && draft.sourceSteamId !== targetSteamId
    && /^\d+$/.test(draft.intervalText) && Number.isInteger(interval) && interval >= minimum && interval <= 120
    && (draft.mode === 'toolbox' || draft.mode === 'asf' && validUrl(draft.asfUrl) && Boolean(draft.asfBot.trim()))
}
function sameAsfUrl(left: string, right: string): boolean {
  try { return new URL(left).href.replace(/\/$/, '') === new URL(right).href.replace(/\/$/, '') }
  catch { return false }
}
const publicFields = new Set(['desc', 'status', 'activity', 'details', 'state', 'currentmap', 'map', 'mode', 'score', 'gamestatus', 'matchgrouploc',
  'game:state', 'game:mode', 'game:map', 'game:act', 'game:score', 'level', 'chapter', 'difficulty', 'character', 'hero', 'team', 'health',
  'players', 'maxplayers', 'kills', 'deaths', 'round', 'rounds', 'time', 'elapsed', 'remaining', 'scene', 'zone', 'music_track', 'displayname',
  'display_name', 'description', 'steam_display', 'steam_player_group_size'])

export function StatusCopyPanel({ account, api }: Props): React.JSX.Element {
  const { t, language } = useI18n()
  const [snapshot, setSnapshot] = useState<StatusCopySnapshot | null>(null)
  const [draft, setDraft] = useState<Draft>(() => initialDraft(STATUS_COPY_DEFAULTS))
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [allowReplace, setAllowReplace] = useState(false)
  const [operation, setOperation] = useState<Action | null>(null)
  const [error, setError] = useState<StatusCopyCode | null>(null)
  const epoch = useRef(0), actionVersion = useRef(0), eventVersion = useRef(0)
  const current = useRef<StatusCopySnapshot | null>(null)
  const draftRef = useRef(draft), dirty = useRef(false), operationRef = useRef<Action | null>(null)
  const passwordRef = useRef(''), clearPasswordRef = useRef(false), retired = useRef(new Set<string>())
  const accountKey = `${account.id}\0${account.steamId}`
  const selectedAccount = useRef(accountKey)
  selectedAccount.current = accountKey
  draftRef.current = draft

  function setWorking(value: Action | null): void { operationRef.current = value; setOperation(value) }
  function belongs(state: StatusCopySnapshot): boolean {
    return selectedAccount.current === accountKey && (state.accountId === null || state.accountId === account.id)
      && (state.targetSteamId === null || state.targetSteamId === account.steamId)
  }
  function accept(state: StatusCopySnapshot, hydrate: boolean): void {
    if (!belongs(state) || retired.current.has(state.sessionId)) return
    const previous = current.current
    if (previous && (state.sessionId !== previous.sessionId || state.settings.mode !== previous.settings.mode || state.settings.sourceSteamId !== previous.settings.sourceSteamId)) {
      if (state.sessionId !== previous.sessionId) {
        retired.current.add(previous.sessionId)
        if (retired.current.size > 32) retired.current.delete(retired.current.values().next().value!)
      }
      actionVersion.current++; setWorking(null); setError(null); setAllowReplace(false)
      passwordRef.current = ''; setPassword(''); clearPasswordRef.current = false; setClearPassword(false)
    }
    current.current = state; setSnapshot(state)
    if (hydrate && !dirty.current) { const next = initialDraft(state.settings); draftRef.current = next; setDraft(next) }
  }
  useLayoutEffect(() => {
    const generation = ++epoch.current
    actionVersion.current++; eventVersion.current = 0; retired.current.clear(); dirty.current = false
    current.current = null; setSnapshot(null); setWorking(null); setError(null); setAllowReplace(false)
    passwordRef.current = ''; setPassword(''); clearPasswordRef.current = false; setClearPassword(false)
    const next = initialDraft(STATUS_COPY_DEFAULTS); draftRef.current = next; setDraft(next)
    const unsubscribe = api.onChange(state => {
      if (epoch.current !== generation || !belongs(state) || retired.current.has(state.sessionId)) return
      eventVersion.current++; accept(state, true)
    })
    void Promise.resolve().then(() => api.state()).then(state => { if (epoch.current === generation && eventVersion.current === 0) accept(state, true) }, () => {
      if (epoch.current === generation && eventVersion.current === 0) setError('COPY_REQUEST_FAILED')
    })
    return () => { epoch.current++; actionVersion.current++; passwordRef.current = ''; clearPasswordRef.current = false; unsubscribe() }
  }, [account.id, account.steamId, api])

  const working = operation !== null || Boolean(snapshot?.busy)
  const active = snapshot?.phase === 'following' || snapshot?.phase === 'waiting' || snapshot?.phase === 'starting' || snapshot?.phase === 'stopping'
  const formDisabled = working || active
  const minimum = draft.mode === 'asf' ? 15 : 5
  const sourceValid = /^[0-9]{17}$/.test(draft.sourceSteamId)
  const sameSource = sourceValid && draft.sourceSteamId === account.steamId
  const formValid = validDraft(draft, account.steamId)
  const visibleSource = snapshot && snapshot.settings.mode === draft.mode && snapshot.settings.sourceSteamId === draft.sourceSteamId && snapshot.source?.steamId === draft.sourceSteamId ? snapshot.source : null
  const reportVisible = Boolean(visibleSource)
  const unconfirmedStop = error === 'COPY_STOP_UNCONFIRMED' || snapshot?.error?.code === 'COPY_STOP_UNCONFIRMED' || snapshot?.warnings.includes('COPY_STOP_UNCONFIRMED')

  function canEdit(): boolean {
    return selectedAccount.current === accountKey && !operationRef.current && !current.current?.busy
      && !['following', 'waiting', 'starting', 'stopping'].includes(current.current?.phase ?? '')
  }
  function update(change: Partial<Draft>): void {
    if (!canEdit()) return
    dirty.current = true; actionVersion.current++; setError(null); setAllowReplace(false)
    if ((['mode', 'sourceSteamId', 'asfUrl', 'asfBot'] as const).some(key => change[key] !== undefined && change[key] !== draftRef.current[key])) {
      passwordRef.current = ''; setPassword(''); clearPasswordRef.current = false; setClearPassword(false)
    }
    const next = { ...draftRef.current, ...change }
    if (next.mode === 'asf') { next.copyGroupSize = false; if (change.mode === 'asf' && Number(next.intervalText) < 15 && next.intervalText !== '') next.intervalText = '15' }
    draftRef.current = next; setDraft(next)
  }

  async function run(kind: Action): Promise<void> {
    const state = current.current
    if (!state || !belongs(state) || (kind !== 'stop' && (operationRef.current || state.busy || ['following', 'waiting', 'starting', 'stopping'].includes(state.phase) || !validDraft(draftRef.current, account.steamId)))) return
    if (kind === 'stop' && operationRef.current === 'stop') return
    if ((kind === 'preview' || kind === 'start') && draftRef.current.mode === 'asf' && clearPasswordRef.current) return
    const generation = epoch.current, version = ++actionVersion.current, revision = eventVersion.current
    const selectedDraft = draftRef.current, signature = JSON.stringify(selectedDraft), expectedSession = state.sessionId
    const removingPassword = kind === 'save' && selectedDraft.mode === 'asf' && clearPasswordRef.current
    const context = { accountId: account.id, sessionId: expectedSession }
    const settings: StatusCopySettingsInput = { mode: selectedDraft.mode, sourceSteamId: selectedDraft.sourceSteamId,
      intervalSeconds: Number(selectedDraft.intervalText), copyGroupSize: selectedDraft.mode === 'toolbox' && selectedDraft.copyGroupSize, persona: selectedDraft.persona,
      ...(selectedDraft.mode === 'asf' ? { asf: { url: selectedDraft.asfUrl, botName: selectedDraft.asfBot.trim(), ...(clearPasswordRef.current ? { password: '' } : passwordRef.current ? { password: passwordRef.current } : {}) } } : {}) }
    const input = { ...context, settings, ...(selectedDraft.mode === 'asf' && allowReplace && !active ? { allowAsfConfigReplace: true } : {}) }
    setWorking(kind); setError(null)
    if (kind !== 'stop') { passwordRef.current = ''; setPassword('') }
    const isCurrent = () => epoch.current === generation && actionVersion.current === version && selectedAccount.current === accountKey
      && current.current?.sessionId === expectedSession && JSON.stringify(draftRef.current) === signature
    try {
      const result = kind === 'stop' ? await api.stop(context) : await api[kind](input)
      if (!isCurrent()) return
      if (kind !== 'stop' && (result.settings.mode !== selectedDraft.mode || result.settings.sourceSteamId !== selectedDraft.sourceSteamId)) return
      if (removingPassword) {
        const confirmsRemoval = (candidate: StatusCopySnapshot | null) => !!candidate && candidate.accountId === account.id && candidate.targetSteamId === account.steamId
          && !candidate.busy && candidate.phase === 'idle' && !candidate.error && candidate.settings.mode === 'asf'
          && candidate.settings.sourceSteamId === selectedDraft.sourceSteamId && candidate.settings.asf?.hasPassword === false
          && candidate.settings.asf.botName === selectedDraft.asfBot.trim() && sameAsfUrl(candidate.settings.asf.url, selectedDraft.asfUrl)
        // Both the completed Save and any newer same-scope state must confirm removal.
        if (!confirmsRemoval(result) || eventVersion.current !== revision && !confirmsRemoval(current.current)) {
          setError('COPY_REQUEST_FAILED'); return
        }
        clearPasswordRef.current = false; setClearPassword(false)
      }
      if (eventVersion.current !== revision) return
      accept(result, false)
    } catch (failure) {
      if (isCurrent() && (kind === 'save' || eventVersion.current === revision)) setError(copyCode(failure && typeof failure === 'object' && 'code' in failure ? failure.code : null))
    } finally { if (epoch.current === generation && actionVersion.current === version) setWorking(null) }
  }

  function time(value: string | null | undefined): string {
    if (!value) return t('尚无', 'Not available')
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : t('时间无效', 'Invalid time')
  }
  const phases = { idle: t('尚未运行', 'Not running'), previewing: t('正在连接并预览', 'Connecting and previewing'), starting: t('正在启动跟随', 'Starting follow'),
    following: t('跟随运行中', 'Following'), waiting: t('正在等待源状态', 'Waiting for source'), stopping: t('正在请求停止', 'Requesting stop'), error: t('需要处理', 'Attention required') }
  const fieldEntries = visibleSource ? Object.entries(visibleSource.fields).filter(([key, value]) => publicFields.has(key) && typeof value === 'string' && value.length <= 4096).slice(0, 20) : []
  const warnings = snapshot ? [...new Set(snapshot.warnings.map(copyCode))].slice(0, 8) : []

  return <section className="game-status-card" aria-label={t('账号状态复制', 'Account status copy')}>
    <div className="game-status-section-title"><div><h3>{t('② → ① 状态跟随', '② → ① status follow')}</h3>
      <p>{t('目标①为当前工具箱账号；填写源②的 Steam64ID。打开本页不会登录、启动机器人或写入游戏状态。', 'Target ① is the selected toolbox account. Enter source ②’s Steam64ID. Opening this page does not sign in, start bots or write game status.')}</p></div>
      <span className="game-status-badge" role="status">{unconfirmedStop ? t('停止未确认', 'Stop unconfirmed') : snapshot ? phases[snapshot.phase] : t('读取状态中…', 'Reading state…')}</span></div>
    <p>{t('目标账号①', 'Target account ①')}: {account.displayName || account.accountName} · {account.steamId}</p>
    <div className="game-status-form-grid">
      <label>{t('执行方式', 'Execution mode')}<select aria-label={t('状态复制执行方式', 'Status-copy mode')} value={draft.mode} disabled={formDisabled} onChange={event => update({ mode: event.target.value as StatusCopyMode })}>
        <option value="toolbox">{t('工具箱独立会话', 'Toolbox separate session')}</option><option value="asf">ASF</option></select></label>
      <label>{t('源账号② Steam64ID', 'Source account ② Steam64ID')}<input aria-label={t('源 Steam64ID', 'Source Steam64ID')} inputMode="numeric" maxLength={17} autoComplete="off" value={draft.sourceSteamId} disabled={formDisabled} onChange={event => update({ sourceSteamId: event.target.value })} placeholder={t('17 位 Steam64ID', '17-digit Steam64ID')} /></label>
      <label>{t('检查间隔（秒）', 'Check interval (seconds)')}<input aria-label={t('状态复制检查间隔', 'Status-copy interval')} type="number" min={minimum} max={120} step={1} value={draft.intervalText} disabled={formDisabled} onChange={event => update({ intervalText: event.target.value })} /><span className="game-status-parameter-help">{minimum}–120 {t('秒', 'seconds')}</span></label>
      {draft.mode === 'toolbox' && <label>{t('目标①会话在线状态', 'Target ① session persona')}<select aria-label={t('目标会话在线状态', 'Target session persona')} value={draft.persona} disabled={formDisabled} onChange={event => update({ persona: event.target.value as 'online' | 'away' })}><option value="away">{t('离开', 'Away')}</option><option value="online">{t('在线', 'Online')}</option></select></label>}
    </div>
    {sameSource && <p className="game-status-notice error" role="alert">{statusCopyError('COPY_SOURCE_EQUALS_TARGET', t)}</p>}
    {draft.mode === 'toolbox' ? <div className="game-status-notice info">
      <p>{t('“连接并预览”可能为目标①建立独立 CM 会话，但不会提交复制状态；只有“开始跟随”会应用复制状态。它与本机 AppID 模拟不是同一路径，可能刷新 Steam 好友界面。', 'Connect and preview may establish a separate CM session for target ①, but does not submit copied status. Only Start following applies copied status. This differs from local AppID simulation and may refresh Steam Friends.')}</p>
      <p>{t('本机 Steam 应保持登录源②。检测到同一客户端切回目标①时会停止跟随；不会强制抢占目标①已有的游玩会话。', 'Keep local Steam signed into source ②. Detecting the same client switching back to target ① stops following. An existing playing session for target ① will not be forcibly taken over.')}</p>
    </div> : <section className="game-status-live-display" aria-label={t('ASF 状态复制配置', 'ASF status-copy settings')}>
      <p>{t('需要 ASFStatusRelay 0.3 安全版插件及其配置；旧版不兼容，不会自动部署插件。源②和目标①都必须是已经登录、在线的 ASF 机器人；源 Steam64ID 用于匹配机器人，不支持把任意好友 ID 当成已配置源。不会启动机器人。', 'ASFStatusRelay 0.3 safe-edition plugin and configuration are required. Older versions are incompatible; plugins are not deployed automatically. Source ② and target ① must both be signed-in, online ASF bots. The source Steam64ID identifies a configured bot, not an arbitrary friend. Bots are never started here.')}</p>
      <div className="game-status-form-grid"><label>{t('ASF 地址', 'ASF URL')}<input aria-label={t('ASF 地址', 'ASF URL')} type="url" autoComplete="off" value={draft.asfUrl} disabled={formDisabled} placeholder="http://127.0.0.1:1242" onChange={event => update({ asfUrl: event.target.value })} /></label>
        <label>{t('目标①机器人名称', 'Target ① bot name')}<input aria-label={t('ASF 目标机器人', 'ASF target bot')} autoComplete="off" value={draft.asfBot} disabled={formDisabled} onChange={event => update({ asfBot: event.target.value })} /></label>
        <label>{t('ASF IPC 密码（只写入）', 'ASF IPC password (write only)')}<input aria-label={t('ASF IPC 密码', 'ASF IPC password')} type="password" autoComplete="off" value={password} disabled={formDisabled || clearPassword} onChange={event => { if (!canEdit() || clearPasswordRef.current) return; passwordRef.current = event.target.value; setPassword(event.target.value) }} /><span className="game-status-parameter-help">{snapshot?.settings.asf?.hasPassword ? t('已保存密码；留空保留，不会回填。', 'A password is saved. Leave blank to retain it; it is never returned to this field.') : t('密码提交后立即清空，不显示配置凭据。', 'The password is cleared immediately after submission; credentials are not displayed.')}</span></label></div>
      <label className="game-status-checkbox"><input aria-label={t('清除已保存 ASF 密码', 'Clear the saved ASF password')} type="checkbox" checked={clearPassword} disabled={formDisabled} onChange={event => { if (!canEdit()) return; clearPasswordRef.current = event.target.checked; setClearPassword(event.target.checked); if (event.target.checked) { passwordRef.current = ''; setPassword('') } }} /><span>{t('清除已保存 ASF 密码（点击保存设置后生效）', 'Clear the saved ASF password (takes effect after Save settings)')}</span></label>
      {clearPassword && <p className="game-status-help">{t('清除操作尚未确认保存。请先成功保存设置，再连接预览或开始跟随。', 'Password removal is not confirmed saved. Successfully save settings before previewing or starting follow.')}</p>}
      <label className="game-status-checkbox"><input aria-label={t('允许替换已停止的 ASF 配置', 'Allow replacing a stopped ASF configuration')} type="checkbox" checked={allowReplace} disabled={formDisabled} onChange={event => { if (canEdit()) setAllowReplace(event.target.checked) }} /><span>{t('允许替换已停止任务的插件配置（不会覆盖运行中的任务）', 'Allow replacing a stopped plugin configuration (never an active task)')}</span></label>
      <p className="game-status-help">{t('断网或停止响应失败时不能确认 ASF 已停止；任务可能仍在运行，请恢复连接后核对。', 'A network failure or failed stop response does not confirm ASF stopped. The task may still be running; reconnect and verify it.')}</p>
      <p className="game-status-notice info">{t('检测到同机 Steam 切回①时会请求停止转发，是否成功以停止核对结果为准；不会自动登出或停止您预先登录的 ASF 机器人①。要避免同号会话并行，请在切回前自行停止 ASF 机器人①；停止转发不等于机器人已登出。', 'Switching local Steam back to ① triggers a stop request; check whether stopping is confirmed. This does not sign out or stop your pre-existing ASF bot ①. To avoid parallel sessions for the same account, stop ASF bot ① yourself before switching back. Stopping forwarding does not mean the bot signed out.')}</p>
    </section>}
    <label className="game-status-checkbox"><input aria-label={t('复制同组人数', 'Copy group size')} type="checkbox" checked={draft.mode === 'toolbox' && draft.copyGroupSize} disabled={formDisabled || draft.mode === 'asf'} onChange={event => update({ copyGroupSize: event.target.checked })} /><span>{t('复制同组总人数', 'Copy total group size')}</span></label>
    {draft.mode === 'asf' && <p className="game-status-help">{t('当前 ASF 插件不支持同组人数；该选项已禁用，不会提交。', 'The current ASF plugin does not support group size. This option is disabled and is not submitted.')}</p>}
    <p className="game-status-help">{t('只复制经过筛选的公开状态，不复制房间、连接信息或源分组标识。私密、离线或非好友关系可能导致读取不可用；并非所有游戏的全部子状态都能复制，也不绕过游戏许可。', 'Only filtered public status is copied, never room, connection details or source group identifiers. Privacy, offline state or a non-friend relationship may prevent reads. Not every game or substatus can be copied, and game licensing is not bypassed.')}</p>
    <p className="game-status-help">{t('连接预览或开始跟随前会结束互斥的旧工具箱模拟／状态连接；不会结束 Steam、真实游戏或 ASF 机器人。', 'Previewing or starting first retires mutually exclusive toolbox simulation/status connections. Steam, real games and ASF bots are not terminated.')}</p>
    {(error || snapshot?.error) && <p className="game-status-notice error" role="alert">{statusCopyError(error ?? snapshot?.error?.code, t)}</p>}
    {warnings.length > 0 && <ul className="game-status-notice info" aria-label={t('状态复制提示', 'Status-copy notices')}>{warnings.map(code => <li key={code}>{statusCopyError(code, t)}</li>)}</ul>}
    <section className="game-status-live-display" aria-label={t('源状态预览与目标核对', 'Source preview and target verification')}>
      <h3>{t('源状态预览', 'Source status preview')}</h3>
      {visibleSource ? <><p>{t('源游戏', 'Source game')}: {visibleSource.gameName || t('名称暂不可用', 'Name unavailable')} · AppID {visibleSource.appId}</p>
        <p>{t('观测时间', 'Observed at')}: {time(visibleSource.observedAt)}</p>
        <p>{t('源读取方式', 'Source read authority')}: {visibleSource.authority === 'local-source-session' ? t('本机源会话', 'Local source session') : visibleSource.authority === 'asf-source-session' ? t('ASF 源会话', 'ASF source session') : t('当前会话可见的好友状态', 'Friend presence visible to this session')}</p>
        <p>{t('源同组总人数', 'Source total group size')}: {visibleSource.groupSize ?? t('未提供', 'Not provided')}</p>
        {fieldEntries.length > 0 ? <dl>{fieldEntries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <p>{t('没有可展示的公开字段。', 'No public fields are available to display.')}</p>}</> : <p>{t('尚无与当前来源和模式一致的预览；不会显示旧来源的数据。', 'No preview matches the selected source and mode. Old-source data is not shown.')}</p>}
      <p>{t('请求展示的目标 AppID', 'Requested target AppID')}: {reportVisible ? snapshot?.targetAppId ?? t('尚无', 'Not available') : t('尚无', 'Not available')}</p>
      <p>{t('最近提交时间', 'Last submitted at')}: {reportVisible ? time(snapshot?.appliedAt) : t('尚无', 'Not available')}</p>
      <p className="game-status-notice info">{draft.mode === 'asf' ? t('ASF 仅记录插件提交，未完成独立读回，也未确认好友端显示。', 'ASF records plugin submission only, without independent readback or friend-client confirmation.') : reportVisible && snapshot?.verification === 'target-readback' ? t('目标会话读回，非好友端确认。', 'Read back from the target session, not confirmed by a friend client.') : t('尚未完成目标会话读回；未确认好友端显示。', 'Target-session readback is not complete. A friend-client display is not confirmed.')}</p>
    </section>
    {active && <p className="game-status-help">{t('修改来源或配置前请先停止当前任务。', 'Stop the current task before changing its source or settings.')}</p>}
    <div className="game-status-actions">
      <button disabled={!snapshot || formDisabled || !formValid} onClick={() => void run('save')}>{t('保存设置（不启动）', 'Save settings (do not start)')}</button>
      <button disabled={!snapshot || formDisabled || !formValid || draft.mode === 'asf' && clearPassword} onClick={() => void run('preview')}>{t('连接并预览', 'Connect and preview')}</button>
      <button className="primary" disabled={!snapshot || formDisabled || !formValid || draft.mode === 'asf' && clearPassword} onClick={() => void run('start')}>{t('开始跟随', 'Start following')}</button>
      <button disabled={!snapshot || operation === 'stop'} onClick={() => void run('stop')}>{operation === 'stop' ? t('请求停止中…', 'Requesting stop…') : t('停止／取消', 'Stop / cancel')}</button>
    </div>
  </section>
}
