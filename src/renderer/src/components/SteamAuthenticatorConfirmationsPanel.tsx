import { useEffect, useRef, useState } from 'react'
import type { SteamAuthenticatorEntry } from '../../../shared/steam-authenticator'
import type {
  SteamAuthenticatorConfirmationAction, SteamAuthenticatorConfirmationResult, SteamAuthenticatorConfirmationSnapshot,
  SteamAuthenticatorConfirmationsApi
} from '../../../shared/steam-authenticator-confirmations'
import { isEnergySavingActive, subscribeEnergySaving } from '../energy-saving'
import { useI18n, type Translate } from '../i18n'

export type SteamAuthenticatorConfirmationEntry = Pick<SteamAuthenticatorEntry, 'id' | 'name' | 'steamId' | 'capabilities'>

export function steamAuthenticatorConfirmationError(code: unknown, t: Translate): string {
  switch (code) {
    case 'AUTH_CONFIRMATION_IDENTITY': return t('工具箱当前登录账号与该令牌的 SteamID 不一致，未继续读取或处理确认', 'The signed-in toolbox account does not match the authenticator SteamID; confirmation access stopped')
    case 'AUTH_CONFIRMATION_CHANGED': case 'AUTH_CONFIRMATION_EXPIRED': return t('确认列表或会话已变化，请核对后手动重新读取', 'The confirmation list or session changed; verify it and load the list again manually')
    case 'AUTH_CONFIRMATION_BUSY': return t('上一项确认操作尚未结束，请稍候', 'The previous confirmation operation is still running')
    case 'AUTH_CONFIRMATION_UNSUPPORTED': return t('此类型尚不支持处理，未发送允许或拒绝请求', 'This confirmation type is not supported; no allow or cancel request was sent')
    case 'AUTH_CONFIRMATION_LIST_FAILED': return t('未能读取确认列表，请核对网络与同账号的工具箱登录，再手动重试', 'The confirmation list could not be loaded; check the network and sign in to the matching toolbox account before retrying manually')
    case 'AUTH_CONFIRMATION_TIME_UNAVAILABLE': return t('无法取得可靠的 Steam 时间，未继续处理确认，请稍后重试', 'Reliable Steam time is unavailable; confirmation processing stopped, so try again later')
    case 'AUTH_CONFIRMATION_UNAVAILABLE': return t('确认材料或网页登录会话不可用，请重新导入原 maFile 并登录同一 Steam 账号', 'Confirmation material or the web session is unavailable; re-import the original maFile and sign in to the matching Steam account')
    case 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE': return t('安全记录不可用，已阻止提交；请保留记录并手动在 Steam 核对，不要清除文件绕过保护', 'Safety records are unavailable and submission was blocked; preserve the records and verify manually in Steam. Do not delete files to bypass this protection')
    default: return t('本次确认操作未完成，请先在 Steam 核对，不会自动重试', 'This confirmation operation did not complete; verify it in Steam first. It will not retry automatically')
  }
}

export function steamAuthenticatorConfirmationResultText(result: SteamAuthenticatorConfirmationResult, t: Translate): string {
  if (result.outcome === 'accepted') return result.action === 'allow'
    ? t('确认接口已接受允许请求，请到 Steam 核对最终交易或市场状态；这不代表已成交', 'The confirmation endpoint accepted the allow request; check the final trade or market state in Steam. This does not mean a trade completed')
    : t('确认接口已接受取消请求，请到 Steam 核对最终交易或市场状态', 'The confirmation endpoint accepted the cancel request; check the final trade or market state in Steam')
  if (result.outcome === 'cancelled' && !result.requestSubmitted) return t('你已取消本次操作，未提交确认请求', 'You cancelled this operation; no confirmation request was submitted')
  if (result.outcome === 'stale' && !result.requestSubmitted) return t('列表或会话已失效，未继续操作，请核对后重新读取', 'The list or session is stale; the operation stopped. Verify it and load the list again')
  if (result.outcome === 'rejected') return t('Steam 未接受本次请求，不代表交易已被拒绝；请先核对 Steam，再手动读取新列表', 'Steam did not accept this request; that does not mean the trade was rejected. Check Steam before manually loading a fresh list')
  return t('本次请求是否生效无法核实，可能已经提交；不会自动重试，请先核对 Steam 记录，重新读取或重启不代表可安全重试', 'The request outcome is unconfirmed and it may have been submitted; nothing will retry automatically. Check Steam first; reloading or restarting does not make another attempt safe')
}

function codeOf(failure: unknown): string {
  return failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'unavailable'
}

function documentActive(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export function SteamAuthenticatorConfirmationsPanel({ api, entries, selectedSteamId, visible = true }: {
  api?: SteamAuthenticatorConfirmationsApi
  entries: SteamAuthenticatorConfirmationEntry[]
  selectedSteamId?: string | null
  visible?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const [entryId, setEntryId] = useState(() => entries.find(entry => entry.capabilities?.hasConfirmations)?.id ?? '')
  const [pageActive, setPageActive] = useState(documentActive)
  const [saving, setSaving] = useState(isEnergySavingActive)
  const [visibilityEpoch, setVisibilityEpoch] = useState(0)
  const [snapshot, setSnapshot] = useState<SteamAuthenticatorConfirmationSnapshot | null>(null)
  const [result, setResult] = useState<SteamAuthenticatorConfirmationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const pending = useRef(false)
  const activeRef = useRef(visible && pageActive)
  const current = useRef<SteamAuthenticatorConfirmationSnapshot | null>(null)
  const entry = entries.find(value => value.id === entryId)
  const active = visible && pageActive
  activeRef.current = active
  useEffect(() => {
    const update = (): void => {
      const next = documentActive()
      if (!next) { activeRef.current = false; generation.current++; current.current = null; pending.current = false; setSnapshot(null); setResult(null); setError(null); setWorking(false); setVisibilityEpoch(value => value + 1) }
      setPageActive(next)
    }
    const unsubscribe = subscribeEnergySaving(setSaving)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
    return () => { unsubscribe(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    generation.current++; current.current = null; pending.current = false
    setSnapshot(null); setResult(null); setError(null); setWorking(false); setNow(Date.now())
    return () => { generation.current++; current.current = null }
  }, [api, entryId, selectedSteamId, active, visibilityEpoch])
  useEffect(() => {
    if (!active || saving || !snapshot) return
    setNow(Date.now())
    if (snapshot.expiresAt <= Date.now()) return
    const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= snapshot.expiresAt) clearInterval(timer) }, 1_000)
    return () => clearInterval(timer)
  }, [active, saving, snapshot?.listId])
  const ownerMatches = Boolean(entry?.steamId && selectedSteamId && entry.steamId === selectedSteamId)
  const available = Boolean(api && active && !saving && entry?.capabilities?.hasConfirmations && ownerMatches)
  const run = async (confirmationId?: string, action?: SteamAuthenticatorConfirmationAction): Promise<void> => {
    if (!available || !api || !entry || pending.current || !activeRef.current || !documentActive() || isEnergySavingActive()) return
    const lease = current.current
    if (confirmationId && (!lease || lease.entryId !== entry.id || lease.ownerSteamId !== selectedSteamId ||
        lease.expiresAt <= Date.now() || !lease.items.some(item => item.id === confirmationId && item.canRespond && [2, 3].includes(item.type)))) return
    const epoch = generation.current
    pending.current = true; setWorking(true); setError(null); setResult(null)
    try {
      if (confirmationId && action && lease) {
        const value = await api.respond({ entryId: entry.id, listId: lease.listId, confirmationId, action })
        if (epoch !== generation.current || !activeRef.current || !documentActive()) return
        current.current = null; setSnapshot(null)
        if (value.entryId !== entry.id || value.listId !== lease.listId || value.confirmationId !== confirmationId || value.action !== action) {
          throw { code: 'AUTH_CONFIRMATION_CHANGED' }
        }
        setResult(value)
      } else {
        current.current = null; setSnapshot(null)
        const value = await api.list({ entryId: entry.id })
        if (epoch !== generation.current || !activeRef.current || !documentActive()) return
        if (value.entryId !== entry.id || value.ownerSteamId !== selectedSteamId || value.ownerSteamId !== entry.steamId || !value.listId) {
          throw { code: 'AUTH_CONFIRMATION_IDENTITY' }
        }
        current.current = value; setSnapshot(value); setNow(Date.now())
      }
    } catch (failure) {
      if (epoch === generation.current && activeRef.current) { current.current = null; setSnapshot(null); setError(codeOf(failure)) }
    } finally {
      if (epoch === generation.current) { pending.current = false; setWorking(false) }
    }
  }
  const shown = active && ownerMatches && snapshot?.entryId === entryId && snapshot.ownerSteamId === selectedSteamId ? snapshot : null
  const expired = Boolean(shown && shown.expiresAt <= now)
  return <section className="game-status-card steam-authenticator-confirmations" aria-label={t('交易与市场确认', 'Trade and market confirmations')}>
    <div className="game-status-section-title"><div><h3>{t('交易与市场确认', 'Trade and market confirmations')}</h3>
      <p>{t('在左侧工具箱账号中选择并登录与令牌相同的账号，再手动读取；不影响 Steam 客户端当前账号', 'Select and sign in to the matching account in the toolbox sidebar, then load confirmations manually. The current Steam client account is unchanged')}</p></div></div>
    <div className="game-status-notice info"><strong>{t('仅逐项处理，不会自动允许或批量确认', 'Individual decisions only, with no automatic or bulk approvals')}</strong>
      <p>{t('先核对类型、对象和内容，再点击允许或拒绝；系统窗口还会要求最终确认。接口接受不等于交易完成，结果不明时先到 Steam 核对，不自动重试', 'Review the type, counterparty and contents before allowing or cancelling; a native window asks for final confirmation. Endpoint acceptance is not trade completion. Uncertain results require checking Steam, not an automatic retry')}</p></div>
    {!api ? <p className="game-status-notice info" role="status">{t('此界面尚未连接确认接口，不会发出读取、允许或拒绝请求', 'The confirmation interface is not connected; this page sends no list, allow or cancel requests')}</p>
      : <>
        <label>{t('选择本地令牌', 'Choose a local authenticator')}<select aria-label={t('选择确认令牌', 'Choose confirmation authenticator')} value={entryId} disabled={!active || saving || working}
          onChange={event => setEntryId(event.target.value)}><option value="">{t('选择令牌', 'Select an authenticator')}</option>
          {entries.map(value => <option value={value.id} key={value.id} disabled={!value.capabilities?.hasConfirmations}>{value.name}{value.capabilities?.hasConfirmations ? '' : t('（仅验证码）', ' (codes only)')}</option>)}</select></label>
        {!entries.some(value => value.capabilities?.hasConfirmations) && <p className="game-status-help">{t('暂无可用的确认材料，旧版仅验证码存档需重新导入原 maFile', 'No confirmation material is available; re-import the original maFile for legacy codes-only records')}</p>}
        {entry?.capabilities?.hasConfirmations && !ownerMatches && <p className="game-status-notice info" role="status">{t('请先在工具箱左侧选择并登录与此令牌相同的 Steam 账号，未继续读取', 'Select and sign in to the same Steam account in the toolbox sidebar first; no list was loaded')}</p>}
        <div className="game-status-actions"><button disabled={!available || working} onClick={() => void run()}>{working ? t('正在处理…', 'Working…') : t('手动读取确认列表', 'Load confirmations manually')}</button></div>
      </>}
    {error && active && <p className="game-status-notice error" role="alert">{steamAuthenticatorConfirmationError(error, t)}</p>}
    {result && active && <p className={`game-status-notice ${result.outcome === 'accepted' ? 'success' : 'info'}`} role="status">{steamAuthenticatorConfirmationResultText(result, t)}</p>}
    {expired && <p className="game-status-notice info" role="status">{t('列表已过期，请手动重新读取后再处理', 'This list expired; load it again manually before responding')}</p>}
    {shown && !shown.items.length && <div className="game-status-empty"><h3>{t('当前未返回待处理确认', 'No pending confirmations were returned')}</h3><p>{t('这仅是本次读取结果，不代表所有交易均已完成', 'This is the result of this lookup, not proof that every trade has completed')}</p></div>}
    {shown && shown.items.length > 0 && <div className="steam-authenticator-confirmation-list">{shown.items.map(item => <article key={item.id} className="game-status-live-display">
      <div className="game-status-section-title"><div><span className="game-status-badge">{item.type === 2 ? t('交易', 'Trade') : item.type === 3 ? t('市场', 'Market') : t('未支持的类型', 'Unsupported type')}</span><h4>{item.title}</h4></div></div>
      <ul>{item.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
      {!item.canRespond || ![2, 3].includes(item.type) ? <p className="game-status-help">{item.blockedReason === 'already-submitted'
        ? t('此项已有提交记录，当前禁止重发；请人工核对 Steam，重新读取或重启不代表可安全重试', 'This item has a submission record and cannot be sent again. Check Steam manually; reloading or restarting does not make another attempt safe')
        : t('此项仅显示，不开放处理', 'This item is read-only and cannot be processed')}</p>
        : <div className="game-status-actions"><button className="primary" disabled={working || expired || !available} aria-label={t(`允许确认 ${item.title}`, `Allow confirmation ${item.title}`)} onClick={() => void run(item.id, 'allow')}>{t('允许此项', 'Allow this item')}</button>
          <button className="ghost danger-text" disabled={working || expired || !available} aria-label={t(`拒绝确认 ${item.title}`, `Cancel confirmation ${item.title}`)} onClick={() => void run(item.id, 'cancel')}>{t('拒绝此项', 'Cancel this item')}</button></div>}
    </article>)}</div>}
  </section>
}
