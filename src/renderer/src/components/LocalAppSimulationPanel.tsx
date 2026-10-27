import { useLayoutEffect, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import type { GameStatusAppInfo, GameStatusPresence } from '../../../shared/game-status'
import type { LocalAppSimulationApi, LocalAppSimulationSnapshot } from '../../../shared/local-app-simulation'
import { useI18n } from '../i18n'
import { GameStatusIdentity, GameStatusTemplateEditor, gameStatusPresenceResult } from './GameStatusPanel'
import { GROUP_SIZE_KEY, MAX_GROUP_SIZE, readGroupSize } from '../../../shared/game-status-group'
import { validateExperimentalPresence } from '../../../shared/local-app-experimental'
import { richPresenceContract } from '../../../shared/rich-presence-contract'

const inputLimits = richPresenceContract.presence

interface Props {
  account: AccountView
  api: LocalAppSimulationApi
  appIdText: string
  onAppIdChange(value: string): void
  presence?: GameStatusPresence
  onPresenceChange(value: GameStatusPresence | undefined): void
  groupSize?: number
  onGroupSizeChange?(value: number | undefined): void
  onSaveDraft(): void
  saveBusy: boolean
  liveRestoreRequired: boolean
}
type Translate = (zh: string, en: string) => string
export function localSimulationError(code: unknown, t: Translate): string {
  switch (code) {
    case 'LOCAL_APP_GAME_ACTIVE': return t('检测到其他游戏正在运行。请先正常退出游戏，再启动本机模拟。', 'Another game is running. Exit it normally before starting local simulation.')
    case 'LOCAL_APP_LIVE_RESTORE_REQUIRED': return t('真实游戏仍有锁定或恢复记录，请先解除锁定并安全恢复。', 'Unlock and safely restore the live-game edit before starting simulation.')
    case 'LOCAL_APP_CONTEXT_CHANGED': return t('账号或 Steam 会话已变化，旧操作已停止。请重新读取状态。', 'The account or Steam session changed. The old operation stopped; refresh the state.')
    case 'LOCAL_APP_CONTEXT_UNAVAILABLE': return t('无法核实本机 Steam。请确认 Steam 正常运行且账号一致。', 'Local Steam could not be verified. Check that Steam is running with the selected account.')
    case 'LOCAL_APP_TEMPLATE_UNAVAILABLE': return t('尚未取得可验证的官方子消息模板。可重试读取，或显式选择实验性手动模式尝试公开字段。', 'A verified published substatus template is not available. Retry the lookup, or explicitly enable experimental manual fields.')
    case 'LOCAL_APP_METADATA_UNAVAILABLE': return t('游戏信息暂未读取完成，请稍后重试。', 'Game information could not be read. Retry shortly.')
    case 'LOCAL_APP_STOP_FAILED': return t('旧模拟进程尚未确认退出，未启动新的模拟。请先重新停止核对。', 'The previous simulation has not confirmed exit. Stop it before starting another one.')
    case 'LOCAL_APP_SET_REJECTED': return t('本机 Steam 未接受全部子消息字段，请重新读取核对；不会自动重发。', 'Local Steam did not accept every substatus field. Read back before retrying; nothing is resent automatically.')
    case 'LOCAL_APP_WORKER_UNAVAILABLE': return t('本机模拟组件缺失或不可用，请检查工具箱文件是否完整。未改用个人 CM 登录。', 'The local simulation component is missing or unavailable. Check the toolbox files. No personal CM sign-in fallback was used.')
    case 'LOCAL_APP_PROFILE_UNSUPPORTED': return t('当前 Steam 客户端版本尚未适配，已拒绝使用不匹配的接口。请更新工具箱；这不是目标游戏未安装。', 'This Steam client version is not supported by the current toolbox. Mismatched interfaces were not used. Update the toolbox; this is not caused by the target game being uninstalled.')
    case 'LOCAL_APP_NOT_LICENSED': return t('当前 Steam 会话未确认此 AppID 的可用许可。请核对所选账号的游戏许可；无需先下载或安装目标游戏。', 'The current Steam session has not confirmed a usable license for this AppID. Check the selected account\'s license; downloading or installing the target game is not required.')
    case 'LOCAL_APP_INIT_FAILED': return t('本机 Steam 接口初始化失败。请确认 Steam 已正常运行并登录，未自动改用个人 CM 登录。', 'The local Steam interface could not initialize. Check that Steam is running and signed in. No personal CM sign-in fallback was used.')
    case 'LOCAL_APP_IDENTITY_MISMATCH': return t('本机 Steam 返回的账号身份与工具箱所选账号不同，未继续模拟。', 'The local Steam identity does not match the selected toolbox account. Simulation did not continue.')
    case 'LOCAL_APP_APP_MISMATCH': return t('Steam 未建立请求 AppID 的本机接口上下文，未继续模拟。', 'Steam did not establish a local interface context for the requested AppID. Simulation did not continue.')
    case 'LOCAL_APP_DLL_INVALID': return t('本机 Steam 客户端 DLL 未通过完整性校验，未加载该文件。', 'The local Steam client DLL failed its integrity check and was not loaded.')
    case 'LOCAL_APP_TIMEOUT': return t('等待本机模拟组件超时，请停止并核对后重试。', 'The local simulation component timed out. Stop and verify it before retrying.')
    case 'LOCAL_APP_BUSY': return t('上一个本机模拟操作尚未结束，请稍候。', 'The previous local simulation operation is still running.')
    case 'LOCAL_APP_INVALID_INPUT': return t('请输入有效 AppID，并检查官方模板或实验性字段及参数。', 'Enter a valid AppID and check the published template or experimental fields.')
    default: return t('本机模拟操作未完成，请核对 Steam 和当前状态后重试。', 'The local simulation operation did not complete. Check Steam and the current state before retrying.')
  }
}

export function LocalAppSimulationPanel(props: Props): React.JSX.Element {
  const { t, language } = useI18n()
  const { account, api } = props
  const [snapshot, setSnapshot] = useState<LocalAppSimulationSnapshot | null>(null)
  const [info, setInfo] = useState<GameStatusAppInfo | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [groupEnabled, setGroupEnabled] = useState(props.groupSize !== undefined)
  const [groupText, setGroupText] = useState(String(props.groupSize ?? 2))
  const experimentalTarget = `${account.id}:${account.steamId}:${props.appIdText}`
  const [manual, setManual] = useState({ target: experimentalTarget, enabled: false, token: '', rows: [{ id: 0, key: '', value: '' }] })
  const nextManualRow = useRef(1)
  useLayoutEffect(() => {
    setManual({ target: experimentalTarget, enabled: false, token: '', rows: [{ id: 0, key: '', value: '' }] })
    nextManualRow.current = 1
  }, [experimentalTarget])
  useLayoutEffect(() => {
    setGroupEnabled(props.groupSize !== undefined)
    setGroupText(String(props.groupSize ?? 2))
  }, [account.id, props.groupSize])
  const epoch = useRef(0)
  const actionVersion = useRef(0)
  const current = useRef<LocalAppSimulationSnapshot | null>(null)
  const selectedId = useRef(props.appIdText)
  selectedId.current = props.appIdText
  const belongs = (state: LocalAppSimulationSnapshot): boolean =>
    (state.accountId === null || state.accountId === account.id) && (state.steamId === null || state.steamId === account.steamId)
  const apply = (state: LocalAppSimulationSnapshot): void => {
    if (!belongs(state)) return
    current.current = state; setSnapshot(state)
    if (state.appInfo?.appId === Number(selectedId.current)) setInfo(state.appInfo)
  }
  useLayoutEffect(() => {
    const generation = ++epoch.current
    let revision = 0
    current.current = null; setSnapshot(null); setInfo(null); setError(null); setOperation(null)
    const unsubscribe = api.onChange(state => {
      if (epoch.current !== generation || !belongs(state)) return
      revision++
      if (current.current && state.sessionId !== current.current.sessionId) {
        actionVersion.current++; setOperation(null); setError(null)
        setManual({ target: experimentalTarget, enabled: false, token: '', rows: [{ id: 0, key: '', value: '' }] }); nextManualRow.current = 1
      }
      apply(state)
    })
    void api.state().then(state => { if (epoch.current === generation && revision === 0) apply(state) }, () => {
      if (epoch.current === generation) setError('LOCAL_APP_CONTEXT_UNAVAILABLE')
    })
    return () => { epoch.current++; actionVersion.current++; unsubscribe() }
  }, [account.id, account.steamId, api])

  const appId = Number(props.appIdText)
  const validAppId = /^\d+$/.test(props.appIdText) && Number.isSafeInteger(appId) && appId > 0 && appId <= 0xffffff
  const visibleInfo = info?.appId === appId ? info : snapshot?.appInfo?.appId === appId ? snapshot.appInfo : null
  const working = operation !== null || Boolean(snapshot?.busy)
  const running = snapshot?.status === 'running'
  const sameTarget = running && snapshot.appId === appId
  const unverifiedDraft = Boolean(props.presence && (!visibleInfo || !visibleInfo.templates.length || visibleInfo.templateStatus === 'unavailable'))
  const omitUnverifiedDraft = unverifiedDraft && !sameTarget
  const submittedPresence = omitUnverifiedDraft ? undefined : props.presence
  const presence = gameStatusPresenceResult(visibleInfo, submittedPresence)
  const selectedGroupSize = groupEnabled ? readGroupSize(groupText) : null
  const groupValid = !groupEnabled || selectedGroupSize !== null
  const experimental = manual.target === experimentalTarget && manual.enabled
  let experimentalFields: Record<string, string> | null = null
  if (experimental) {
    try {
      const entries: Array<[string, string]> = manual.rows.filter(row => row.key !== '' || row.value !== '').map(row => [row.key, row.value])
      if (manual.token !== '') entries.push(['steam_display', manual.token])
      if (new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length) throw new Error()
      experimentalFields = validateExperimentalPresence(Object.fromEntries(entries), groupEnabled ? 2 : 0)
    } catch { /* An invalid draft is never submitted to Steam. */ }
  }
  const publishedFieldCount = submittedPresence && presence.valid ? Object.keys(submittedPresence.values).length + 1 : 0
  const publishedCapacityExceeded = !experimental && groupEnabled && presence.valid && publishedFieldCount + inputLimits.reservedGroupKeys > inputLimits.maxKeys
  const substatusValid = experimental ? experimentalFields !== null : presence.valid && !publishedCapacityExceeded
  const observedGroupSize = readGroupSize(snapshot?.fields[GROUP_SIZE_KEY])
  const canStop = !!snapshot && (snapshot.status === 'starting' || snapshot.status === 'running' || snapshot.status === 'stopping' || snapshot.status === 'error' || snapshot.busy)

  async function run(kind: 'inspect' | 'start' | 'stop'): Promise<void> {
    const state = current.current
    if (!state || (kind !== 'stop' && working)) return
    if (kind !== 'stop' && (!validAppId || kind === 'start' && (!substatusValid || !groupValid || props.liveRestoreRequired))) return
    const generation = epoch.current; const version = ++actionVersion.current
    const context = { accountId: account.id, sessionId: state.sessionId }
    setOperation(kind); setError(null)
    try {
      if (kind === 'inspect') {
        const result = await api.inspect({ ...context, appId, language: language === 'en' ? 'english' : 'schinese' })
        if (epoch.current === generation && actionVersion.current === version && result.appId === Number(selectedId.current)) setInfo(result)
      } else {
        const result = kind === 'stop' ? await api.stop(context) : await api.start({ ...context, appId,
          ...(experimental && experimentalFields ? { unverifiedPresence: experimentalFields } : submittedPresence ? { presence: submittedPresence } : {}),
          ...(groupEnabled && selectedGroupSize !== null ? { groupSize: selectedGroupSize } : {}) })
        if (epoch.current === generation && actionVersion.current === version) apply(result)
      }
    } catch (failure) {
      if (epoch.current === generation && actionVersion.current === version) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : 'LOCAL_APP_CONTEXT_UNAVAILABLE'
        setError(code)
      }
    } finally { if (epoch.current === generation && actionVersion.current === version) setOperation(null) }
  }
  const labels = { idle: t('尚未启动', 'Not started'), starting: t('正在启动本机进程', 'Starting local process'),
    running: t('本机模拟运行中', 'Local simulation running'), stopping: t('正在停止并清理', 'Stopping and cleaning up'), error: t('需要核对', 'Verification needed') }

  return <section className="game-status-card" aria-label={t('本机 AppID 模拟', 'Local AppID simulation')}>
    <div className="game-status-section-title"><div><h3>{t('模拟已有 Steam AppID', 'Simulate an existing Steam AppID')}</h3>
      <p>{t('启动一个轻量本机占位进程，复用已登录的 Steam。不会创建个人 CM 登录、上线聊天会话或读取好友名单。', 'Start a lightweight local placeholder using the signed-in Steam client. No personal CM sign-in, chat sign-in or friends-list query is created.')}</p></div>
      <span className="game-status-badge">{snapshot ? labels[snapshot.status] : t('读取状态中…', 'Reading state…')}</span></div>
    <div className="game-status-form-grid"><label>{t('Steam AppID', 'Steam AppID')}<input inputMode="numeric" value={props.appIdText} disabled={working} placeholder="1329410" onChange={event => props.onAppIdChange(event.target.value)} /></label></div>
    <div className="game-status-actions"><button disabled={working || !snapshot || !validAppId} onClick={() => void run('inspect')}>{operation === 'inspect' ? t('读取中…', 'Reading…') : t('读取游戏与子消息模板', 'Read game and substatus templates')}</button></div>
    {visibleInfo && <><GameStatusIdentity game={visibleInfo} />
      <GameStatusTemplateEditor id={`local-app-${account.id}`} info={visibleInfo} presence={props.presence} disabled={working || experimental} onChange={props.onPresenceChange} onRetry={() => void run('inspect')} />
    </>}
    {props.presence && <div className="game-status-actions"><button disabled={working || experimental} onClick={() => props.onPresenceChange(undefined)}>{t('清除子消息选择（仅显示游戏）', 'Clear substatus selection (game only)')}</button></div>}
    <section className="game-status-live-display" aria-label={t('实验性手动子状态', 'Experimental manual substatus')}>
      <label className="game-status-checkbox"><input type="checkbox" checked={experimental} disabled={working} onChange={event => {
        if (!working) setManual(value => ({ ...value, target: experimentalTarget, enabled: event.target.checked }))
      }} /><span>{t('强制尝试子状态（实验性）', 'Force a substatus attempt (experimental)')}</span></label>
      <p className="game-status-help">{t('仅用于本机 AppID 模拟。未取得模板也可手动提交公开字段；不保证 Steam 会显示第二行，不会将本机缓存回读当作好友端确认。', 'For local AppID simulation only. Public fields can be submitted without a catalog, but Steam may not show a second line. A local cache readback is not friend-client confirmation.')}</p>
      {experimental && <>
        <p className="game-status-notice info">{t('官方模板草稿会保留，但本次仅提交下方实验字段。实验表单不保存；切换账号或 AppID 后清空。不会自动猜测或添加 #Status。', 'The published-template draft is retained; this attempt submits only the experimental fields below. This form is not saved and clears when the account or AppID changes. No #Status token is guessed or added.')}</p>
        <label>{t('steam_display 令牌（可选）', 'steam_display token (optional)')}<input aria-label={t('实验性 steam_display 令牌', 'Experimental steam_display token')} value={manual.token} maxLength={inputLimits.displayTokenBodyLength + 1} disabled={working} placeholder={t('已知的 #令牌；不知道可留空', 'A known #token; leave empty if unknown')} onChange={event => {
          if (!working) setManual(value => ({ ...value, token: event.target.value }))
        }} /></label>
        <p className="game-status-help">{t(`可尝试游戏使用的 desc、status 等公开字段。令牌以 # 开头，之后最多 ${inputLimits.displayTokenBodyLength} 个字母、数字或 _ : . -；若游戏没有匹配的已发布模板，字段被接受也可能没有显示效果。禁止连接、房间、会话和分组标识等私密字段。`, `Try public fields used by the game, such as desc or status. A token begins with # followed by up to ${inputLimits.displayTokenBodyLength} letters, numbers or _ : . -. Without a matching published template, accepted fields may still produce no display. Connection, room, session and group identifiers are not allowed.`)}</p>
        {manual.rows.map((row, index) => <div key={row.id} className="game-status-form-grid">
          <label>{t('字段名', 'Field name')}<input aria-label={`${t('实验字段名', 'Experimental field name')} ${index + 1}`} value={row.key} maxLength={inputLimits.keyAsciiLength} disabled={working} placeholder="desc" onChange={event => {
            if (!working) setManual(value => ({ ...value, rows: value.rows.map(item => item.id === row.id ? { ...item, key: event.target.value } : item) }))
          }} /></label>
          <label>{t('字段值', 'Field value')}<input aria-label={`${t('实验字段值', 'Experimental field value')} ${index + 1}`} value={row.value} maxLength={inputLimits.valueUtf8Bytes} disabled={working} onChange={event => {
            if (!working) setManual(value => ({ ...value, rows: value.rows.map(item => item.id === row.id ? { ...item, value: event.target.value } : item) }))
          }} /></label>
          <button disabled={working} onClick={() => { if (!working) setManual(value => ({ ...value, rows: value.rows.filter(item => item.id !== row.id) })) }}>{t('移除此字段', 'Remove field')} {index + 1}</button>
        </div>)}
        <div className="game-status-actions"><button disabled={working || manual.rows.length >= inputLimits.maxKeys} onClick={() => {
          if (!working && manual.rows.length < inputLimits.maxKeys) { const rowId = nextManualRow.current++; setManual(value => ({ ...value, rows: [...value.rows, { id: rowId, key: '', value: '' }] })) }
        }}>{t('添加公开字段', 'Add public field')}</button></div>
        <p className={`game-status-notice ${experimentalFields ? 'info' : 'error'}`} role="status">{experimentalFields
          ? t('实验字段格式有效，尚未提交；点击启动／更新后仅表示尝试提交。', 'Experimental field format is valid, not yet submitted. Start or Update only attempts a submission.')
          : t(`请填写至少一个有效字段或令牌。字段名不超过 ${inputLimits.keyAsciiLength} 个 ASCII 字符、每值不超过 ${inputLimits.valueUtf8Bytes} UTF-8 字节，不允许控制字符、模板指令或大小写重复；最多 ${inputLimits.maxKeys} 项，启用人数展示时预留 ${inputLimits.reservedGroupKeys} 项。`, `Enter at least one valid field or token. Names allow up to ${inputLimits.keyAsciiLength} ASCII characters; each value allows ${inputLimits.valueUtf8Bytes} UTF-8 bytes. No control characters, template expressions or case-insensitive duplicate names. Up to ${inputLimits.maxKeys} entries, with ${inputLimits.reservedGroupKeys} reserved when group size is enabled.`)}</p>
      </>}
    </section>
    <section className="game-status-live-display" aria-label={t('模拟同组游玩人数', 'Simulated group size')}>
      <h3>{t('同组游玩人数', 'Players in group')}</h3>
      <label className="game-status-checkbox"><input type="checkbox" checked={groupEnabled} disabled={working} onChange={event => {
        if (working) return
        const enabled = event.target.checked; setGroupEnabled(enabled)
        props.onGroupSizeChange?.(enabled ? readGroupSize(groupText) ?? 2 : undefined)
      }} /><span>{t('自定义人数展示', 'Customize the displayed group size')}</span></label>
      {groupEnabled && <label>{t('同组总人数（包含你自己）', 'Total players in group (including you)')}<input aria-label={t('模拟同组总人数', 'Simulated total group size')} inputMode="numeric" value={groupText} disabled={working} onChange={event => {
        if (working) return
        setGroupText(event.target.value)
        const value = readGroupSize(event.target.value); if (value !== null) props.onGroupSizeChange?.(value)
      }} /><span className="game-status-parameter-help">{groupValid ? `${t('换算为不含本人的人数（非好友端显示确认）', 'Calculated players excluding you (not friend-client confirmation)')}: ${selectedGroupSize! - 1}` : `${t('请输入正整数，最大', 'Enter a positive whole number, up to')} ${MAX_GROUP_SIZE}`}</span></label>}
      <p className="game-status-help">{t('这不是文字子状态，也不会真实增加玩家。模拟使用独立的临时分组标识，不含进房信息；具体排版及是否显示由 Steam 决定。', 'This is separate from text substatus and does not add real players. Simulation uses a temporary isolated group identifier with no join information; Steam controls its final appearance.')}</p>
      <p className="game-status-notice info">{t('查看方显示限制：Steam 的混合“In Game / 游戏中”单例列表不绘制组队人数。若查看号只有你一位好友玩该游戏，条目可能合并到该列表。人数需在独立游戏分组里查看，文案还取决于查看方的设置和可见同组好友；发送方不能强制所有查看号显示。', 'Viewer-side display limit: Steam does not draw party counts in the mixed In Game singleton list. If you are the viewer’s only friend playing this game, your entry may be merged there. Check a dedicated game group instead; wording also depends on viewer settings and visible group members. The sender cannot force every viewer to show a count.')}</p>
      {observedGroupSize !== null && <p>{t('本机缓存回读的同组总人数', 'Total group size read from the local cache')}: {observedGroupSize}</p>}
    </section>
    {publishedCapacityExceeded && <p className="game-status-notice error" role="alert">{t(
      `所选模板需要 ${publishedFieldCount} 个字段（含显示令牌），人数展示另需 ${inputLimits.reservedGroupKeys} 个字段，超过 Steam 的 ${inputLimits.maxKeys} 项上限。请关闭人数展示，或选择字段更少的模板。`,
      `The selected template needs ${publishedFieldCount} fields including its display token, and group size needs ${inputLimits.reservedGroupKeys} more, exceeding Steam's ${inputLimits.maxKeys}-entry limit. Disable group size or choose a template requiring fewer fields.`
    )}</p>}
    {props.liveRestoreRequired && <p className="game-status-notice info">{t('真实游戏仍有锁定或恢复记录，请先解除锁定并安全恢复，再启动本机模拟。', 'Unlock and safely restore the live-game edit before starting local simulation.')}</p>}
    {(error || snapshot?.error) && <p className="game-status-notice error" role="alert">{localSimulationError(error ?? snapshot?.error?.code, t)}</p>}
    <p className="game-status-help">{t('AppID 必须属于当前账号可运行且有许可的游戏，无需先下载或安装目标游戏。默认通过游戏发布的有效模板提交子状态；也可显式启用实验性手动模式，但不保证显示。首次可先不选子消息启动，再读取模板并更新。', 'The selected account must be licensed to run this AppID; downloading or installing the target game is not required. Published templates are used by default. Experimental manual fields require explicit opt-in and may not display. Start without a substatus if needed, then read and apply its template.')}</p>
    {!experimental && omitUnverifiedDraft && <p className="game-status-notice info">{t('草稿中的子消息还未通过模板核对，本次只启动游戏，不提交这段子消息。草稿会保留，读取模板后可再更新。', 'The draft substatus has not passed template verification. This start runs only the game, without submitting that substatus. The draft is retained for updating after templates are read.')}</p>}
    {running && <div className="game-status-notice info" role="status"><strong>{snapshot.submissionMode === 'experimental'
      ? t('实验字段已提交；仅回读本机缓存，尚未确认好友端显示。', 'Experimental fields were submitted; only the local cache was read, not a friend-client display.')
      : t('本机接口已核对；好友端显示仍需实际确认。', 'The local interface is verified; a friend-client display still needs confirmation.')}</strong>
      <p>{t('当前运行的模拟', 'Currently running simulation')}: {snapshot.appId}{snapshot.appInfo?.name ? ` · ${snapshot.appInfo.name}` : ''}</p>
      {snapshot.localizedString && <p>{snapshot.localizedString}</p>}
      <p>{t('开始真实游戏前请先停止模拟。停止只处理工具箱自己的占位进程，不结束 Steam 或其他游戏。', 'Stop simulation before starting a real game. Only the toolbox-owned placeholder is stopped, never Steam or another game.')}</p></div>}
    <div className="game-status-actions"><button className="primary" disabled={working || !snapshot || !validAppId || !substatusValid || !groupValid || props.liveRestoreRequired} onClick={() => void run('start')}>{operation === 'start' ? t('提交中…', 'Submitting…') : sameTarget ? t('更新子消息', 'Update substatus') : t('启动本机模拟', 'Start local simulation')}</button>
      <button disabled={!canStop || operation === 'stop'} onClick={() => void run('stop')}>{operation === 'stop' ? t('停止中…', 'Stopping…') : t('停止本机模拟', 'Stop local simulation')}</button>
      <button className="ghost" disabled={working || experimental || props.saveBusy || !validAppId || !groupValid} onClick={() => { if (!experimental) props.onSaveDraft() }}>{t('保存本机草稿', 'Save local draft')}</button></div>
  </section>
}
