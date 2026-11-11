import { useEffect, useRef, useState } from 'react'
import type { SteamAuthenticatorEnrollmentApi, SteamAuthenticatorEnrollmentPhase, SteamAuthenticatorEnrollmentSnapshot } from '../../../shared/steam-authenticator-enrollment'
import { isEnergySavingActive, subscribeEnergySaving } from '../energy-saving'
import { useI18n, type Translate } from '../i18n'

export function steamAuthenticatorEnrollmentError(code: unknown, t: Translate): string {
  const suffix = typeof code === 'string' ? code.replace(/^AUTHENTICATOR_ENROLLMENT_|^AUTH_ENROLL_MOBILE_/, '') : ''
  switch (suffix) {
    case 'BACKUP_REQUIRED': case 'BACKUP_UNAVAILABLE': return t('必须先安全导出并核验急救码备份，再由你明确确认已保管，才能激活', 'Export and verify the recovery backup first, then explicitly confirm that you have saved it before activation')
    case 'ADD_UNCERTAIN': return t('添加请求的结果无法核实，禁止再次 Add；请保留待恢复记录并先到 Steam 核对', 'The Add outcome is unconfirmed and another Add is forbidden; preserve the pending record and verify it in Steam first')
    case 'PERSISTENCE_FAILED': return t('临时密钥尚未确认安全持久保存，已停止继续激活；请勿退出或清理记录，先查看急救码并导出备份', 'Pending secrets have not been confirmed durably saved, so activation stopped. Do not exit or clear records; view the recovery code and export the backup first')
    case 'MATERIAL_UNAVAILABLE': return t('现有资料中没有可用的急救码或所需材料，请保留并导出可用的救援资料后人工核对，不会补造', 'The available material lacks a recovery code or required fields; preserve and export available rescue material for manual verification. Missing values are never invented')
    case 'CONFIRM_TYPE_UNSUPPORTED': return t('Steam 返回的激活确认类型尚未识别，不能猜测完成；请保留急救码与备份并停止激活', 'The activation confirmation type is unknown; do not guess completion. Preserve the recovery code and backup and stop activation')
    case 'STATUS_UNCONFIRMED': case 'FINALIZE_UNCERTAIN': return t('最终绑定状态尚未核实，只能重新读取服务端状态，不会自动再次激活', 'Enrollment is unconfirmed; only a server-status check is allowed, with no automatic activation retry')
    case 'ACTIVATION_REJECTED': case 'ACTIVATION_INVALID': case 'CODE_INVALID': return t('Steam 未接受本次验证码，请核对验证码及当前步骤后由你重新提交', 'Steam did not accept this code; check the code and current step before submitting it again yourself')
    case 'AUTHENTICATOR_PRESENT': return t('目标账号已有手机验证器，请导入原 maFile 或使用 Steam 官方迁移，不会自动移除原验证器', 'The account already has an authenticator; import the original maFile or use official Steam transfer. The existing authenticator is not removed automatically')
    case 'IDENTITY': return t('返回的 SteamID 与本次目标账号不符，流程已停止，未继续绑定', 'The returned SteamID does not match this target; enrollment stopped')
    case 'LOGIN_REQUIRED': case 'AUTH_REQUIRED': return t('独立手机端登录需要重新认证，请登录同一目标账号，不会改用网页登录令牌', 'Independent mobile authentication is required again; sign in to the same target account. A browser token is not substituted')
    case 'CREDENTIALS_REJECTED': case 'LOGIN_FAILED': return t('独立手机端认证未通过，请核对账号、密码或登录验证步骤后重试', 'Independent mobile authentication failed; check the account, password or sign-in verification step before retrying')
    case 'GUARD_INVALID': return t('登录验证码未通过校验，请核对本次邮箱或已有令牌验证码后重新填写', 'The sign-in verification code was not accepted; check the current email or existing authenticator code and enter it again')
    case 'PHONE_INVALID': case 'COUNTRY_INVALID': case 'SMS_CODE_INVALID': return t('手机号、区号或短信码尚未通过校验，请按当前步骤核对后重新填写', 'The phone number, calling code or SMS code was not valid; check the current step and enter it again')
    case 'PHONE_REQUIRED': return t('Steam 当前要求先完成手机号验证，未自动继续添加；请核对手机号状态并按服务端要求处理', 'Steam currently requires phone verification before Add; enrollment did not continue automatically. Check phone status and follow the server requirements')
    case 'PHONE_VERIFY_FAILED': return t('手机号验证尚未完成，请核对邮件、短信及当前服务端状态，不会自动重发短信', 'Phone verification is incomplete; check email, SMS and server status. SMS is not resent automatically')
    case 'RATE_LIMITED': return t('Steam 暂时限制请求频率，请停止重复操作并稍后由你重试', 'Steam is temporarily rate-limiting requests; stop repeated actions and retry manually later')
    case 'ADD_FAILED': return t('Steam 未接受本次添加请求，未标记绑定成功，请核对当前流程提示', 'Steam did not accept this Add request; enrollment was not marked successful. Check the current flow guidance')
    case 'FINALIZE_FAILED': case 'STATUS_INVALID': return t('激活或最终状态尚未核实，未标记完成，请先只读核对状态，不自动再次激活', 'Activation or final state is unconfirmed and not marked complete; read back the state first, without an automatic activation retry')
    case 'TIME_UNAVAILABLE': case 'NETWORK_FAILED': return t('网络或 Steam 时间暂不可用，请按保留的当前流程核对；添加结果不明时不能重发 Add', 'Network access or Steam time is unavailable; verify the preserved current flow. An uncertain Add must not be resent')
    case 'BUSY': return t('上一项绑定操作尚未完成，请等待结果，不要重复添加', 'The previous enrollment operation is still running; wait for its result and do not repeat Add')
    case 'CHANGED': return t('本次绑定流程已变化，旧请求已停止，请重新读取当前流程', 'This enrollment flow changed and the old request stopped; read the current flow again')
    case 'INVALID': case 'STATE_INVALID': case 'ADD_FORBIDDEN': return t('当前步骤或输入尚不符合要求，未跳过验证，也不会重发添加请求', 'The input or current step is not valid; checks were not skipped and Add is not resent')
    case 'CANCELLED': return t('本次操作已暂停，重新读取流程后由你决定是否恢复', 'This operation was paused; read the flow again and choose whether to resume')
    default: return t('绑定操作未完成，请保留当前记录并重新核对；不会显示密码、密钥或原始响应', 'Enrollment did not complete; preserve the current record and verify it. Passwords, secrets and raw responses are not displayed')
  }
}

const activeDocument = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'
const errorCode = (failure: unknown): string => failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'unavailable'
type Operation = 'read' | 'login' | 'guard' | 'refresh-login' | 'phone-status' | 'phone-begin' | 'phone-send' | 'phone-submit' | 'add' | 'show-recovery' | 'export-backup' | 'acknowledge' | 'finalize' | 'resume' | 'pause'

export function SteamAuthenticatorEnrollmentWizard({ api, visible = true }: { api: SteamAuthenticatorEnrollmentApi; visible?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [pageActive, setPageActive] = useState(activeDocument)
  const [saving, setSaving] = useState(isEnergySavingActive)
  const [visibilityEpoch, setVisibilityEpoch] = useState(0)
  const [state, setState] = useState<SteamAuthenticatorEnrollmentSnapshot | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<'recovery-shown' | 'backup-exported' | null>(null)
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [expectedSteamId, setExpectedSteamId] = useState('')
  const [guardCode, setGuardCode] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [countryCode, setCountryCode] = useState('86')
  const [smsCode, setSmsCode] = useState('')
  const [activationCode, setActivationCode] = useState('')
  const [recoverySaved, setRecoverySaved] = useState(false)
  const [phoneChecked, setPhoneChecked] = useState(false)
  const [newAccount, setNewAccount] = useState(false)
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const pending = useRef(false)
  const current = useRef<SteamAuthenticatorEnrollmentSnapshot | null>(null)
  const active = visible && pageActive
  const activeRef = useRef(active)
  activeRef.current = active
  const clearInputs = (): void => { setPassword(''); setGuardCode(''); setSmsCode(''); setActivationCode('') }
  const accept = (value: SteamAuthenticatorEnrollmentSnapshot): void => {
    current.current = value; setState(value); setNow(Date.now())
    if (value.accountName) setAccountName(value.accountName)
    if (value.steamId) setExpectedSteamId(value.steamId)
  }
  useEffect(() => {
    const update = (): void => {
      const next = activeDocument()
      if (!next) { activeRef.current = false; generation.current++; current.current = null; pending.current = false; setState(null); setOperation(null); clearInputs(); setRecoverySaved(false); setPhoneChecked(false); setVisibilityEpoch(value => value + 1) }
      setPageActive(next)
    }
    const unsubscribe = subscribeEnergySaving(setSaving)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
    return () => { unsubscribe(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    const epoch = ++generation.current
    current.current = null; pending.current = false
    setState(null); setOperation(null); setError(null); setNotice(null); clearInputs(); setPhoneNumber(''); setRecoverySaved(false); setPhoneChecked(false); setNewAccount(false)
    if (active) {
      pending.current = true; setOperation('read')
      void api.state().then(value => { if (epoch === generation.current && activeRef.current) accept(value) }, failure => {
        if (epoch === generation.current && activeRef.current) setError(errorCode(failure))
      }).finally(() => { if (epoch === generation.current) { pending.current = false; setOperation(null) } })
    }
    return () => { generation.current++; current.current = null }
  }, [api, active, visibilityEpoch])
  useEffect(() => { clearInputs(); setRecoverySaved(false) }, [state?.id, state?.phase])
  useEffect(() => { setPhoneChecked(false) }, [state?.id])
  useEffect(() => {
    if (!active || saving) return
    setNow(Date.now())
    if (!state?.retryAt || state.retryAt <= Date.now()) return
    const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= state.retryAt!) clearInterval(timer) }, 1_000)
    return () => clearInterval(timer)
  }, [active, saving, state?.retryAt])
  useEffect(() => {
    if (!active || saving || !state?.busy || operation !== null) return
    const epoch = generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      if (stopped || epoch !== generation.current || !activeRef.current || !activeDocument() || isEnergySavingActive() || !current.current?.busy) return
      if (pending.current) { timer = setTimeout(() => { void poll() }, 1_000); return }
      try {
        const value = await api.state()
        if (stopped || epoch !== generation.current || !activeRef.current || !activeDocument()) return
        accept(value)
        if (value.busy && !isEnergySavingActive()) timer = setTimeout(() => { void poll() }, 1_000)
      } catch (failure) {
        if (!stopped && epoch === generation.current && activeRef.current) setError(errorCode(failure))
      }
    }
    // A reopened visible page may only observe "busy" while an already-authorized Main operation finishes.
    timer = setTimeout(() => { void poll() }, 1_000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, active, saving, state?.busy, operation, visibilityEpoch])
  const phase = state?.phase ?? 'idle'
  const busy = operation !== null || state?.busy === true || saving
  const id = state?.id ?? null
  const phonePhase = ['phone-needed', 'email-required', 'sms-required'].includes(phase)
  const rescueOnly = state?.hasRescueMaterials === true
  const hasPendingMaterial = phase !== 'complete' && (rescueOnly || ['backup-required', 'ready-to-finalize', 'finalize-wait', 'finalizing', 'verifying'].includes(phase) || Boolean(id && state?.confirmationKind))
  const replaceable = Boolean(id && !hasPendingMaterial && !rescueOnly && ['guard-required', 'phone-needed', 'email-required', 'sms-required', 'ready-to-add', 'paused', 'error', 'login-required'].includes(phase))
  const loginPhase = phase === 'idle' || phase === 'login-required' || newAccount && (phase === 'complete' || replaceable)
  const canFinalize = Boolean(id && !rescueOnly && ['ready-to-finalize', 'finalize-wait'].includes(phase) && state?.backupExported && state.backupAcknowledged &&
    ['sms', 'email'].includes(state.confirmationKind ?? '') && (!state.retryAt || state.retryAt <= now))
  const run = async (kind: Operation): Promise<void> => {
    if (!activeRef.current || !activeDocument() || isEnergySavingActive() || pending.current || kind !== 'read' && state?.busy) return
    const context = current.current
    const contextId = context?.id
    const stage = context?.phase ?? 'idle'
    if (kind !== 'read' && kind !== 'login' && !contextId) return
    const replaceContext = Boolean(newAccount && !context?.hasRescueMaterials && !context?.confirmationKind && ['guard-required', 'phone-needed', 'email-required', 'sms-required', 'ready-to-add', 'paused', 'error'].includes(stage))
    if (kind === 'login' && ((!['idle', 'login-required'].includes(stage) && !(stage === 'complete' && newAccount) && !replaceContext) || !accountName.trim() || !password || expectedSteamId.trim() && !/^7656119\d{10}$/.test(expectedSteamId.trim()))) return
    if (kind === 'guard' && (stage !== 'guard-required' || !['email', 'device'].includes(context?.guardType ?? '') || !guardCode.trim())) return
    if (kind === 'phone-send' && (!phoneChecked || stage !== 'sms-required')) return
    if (kind === 'phone-begin' && (!phoneChecked || stage !== 'phone-needed' || !/^\+[1-9]\d{6,14}$/.test(phoneNumber.trim()) || !/^\d{1,4}$/.test(countryCode.trim()) || !phoneNumber.trim().startsWith(`+${countryCode.trim()}`))) return
    if (kind === 'phone-submit' && (stage !== 'sms-required' || !/^\d{4,12}$/.test(smsCode.trim()))) return
    if (kind === 'add' && (!['phone-needed', 'ready-to-add'].includes(stage) || context?.hasRescueMaterials || stage === 'phone-needed' && /PHONE_REQUIRED$/.test(context?.error ?? ''))) return
    if (kind === 'acknowledge' && (stage !== 'backup-required' || context?.hasRescueMaterials || !context?.backupExported || !recoverySaved)) return
    if (kind === 'finalize' && (!['ready-to-finalize', 'finalize-wait'].includes(stage) || context?.hasRescueMaterials || !context?.backupExported || !context.backupAcknowledged ||
        !['sms', 'email'].includes(context.confirmationKind ?? '') || context.retryAt && context.retryAt > Date.now() || !activationCode.trim())) return
    const epoch = generation.current
    pending.current = true; setOperation(kind); setError(null); setNotice(null)
    const loginInput = { accountName: accountName.trim(), password, ...(expectedSteamId.trim() ? { expectedSteamId: expectedSteamId.trim() } : {}) }
    const guardInput = guardCode.trim(), phoneInput = smsCode.trim(), activationInput = activationCode.trim()
    if (kind === 'login') { setPassword(''); setPhoneChecked(false) }
    if (kind === 'guard') setGuardCode('')
    if (kind === 'phone-submit') setSmsCode('')
    if (kind === 'finalize') setActivationCode('')
    try {
      let next: SteamAuthenticatorEnrollmentSnapshot | null = null
      const input = { id: contextId! }
      if (kind === 'read') next = await api.state()
      else if (kind === 'login') next = await api.login(loginInput)
      else if (kind === 'guard') next = await api.submitGuard({ ...input, code: guardInput })
      else if (kind === 'refresh-login') next = await api.refreshLogin(input)
      else if (kind === 'phone-status') { next = await api.phone({ ...input, op: 'status' }); if (epoch === generation.current) setPhoneChecked(true) }
      else if (kind === 'phone-begin') next = await api.phone({ ...input, op: 'begin', phoneNumber: phoneNumber.trim(), countryCode: countryCode.trim() })
      else if (kind === 'phone-send') next = await api.phone({ ...input, op: 'send-sms' })
      else if (kind === 'phone-submit') next = await api.phone({ ...input, op: 'submit-sms', code: phoneInput })
      else if (kind === 'add') next = await api.add(input)
      else if (kind === 'show-recovery') {
        const result = await api.showRecoveryCode(input)
        if (result.shown && epoch === generation.current && activeRef.current) setNotice('recovery-shown')
      } else if (kind === 'export-backup') {
        const result = await api.exportBackup(input)
        if (result.exported && epoch === generation.current && activeRef.current && activeDocument()) { setNotice('backup-exported'); next = await api.state() }
      } else if (kind === 'acknowledge') next = await api.acknowledgeRecoverySaved(input)
      else if (kind === 'finalize') next = await api.finalize({ ...input, activationCode: activationInput })
      else if (kind === 'resume') next = await api.resume(input)
      else if (kind === 'pause') next = await api.pause(input)
      if (epoch !== generation.current || !activeRef.current || !activeDocument()) return
      if (next) {
        if (kind !== 'read' && kind !== 'login' && next.id !== contextId) throw { code: 'AUTHENTICATOR_ENROLLMENT_CHANGED' }
        accept(next)
        if (kind === 'login') setNewAccount(false)
      }
    } catch (failure) {
      if (epoch === generation.current && activeRef.current && activeDocument()) {
        setError(errorCode(failure))
        // Mutation failure can still leave a safely recorded pending Add or Finalize; read it without replaying the request.
        if (kind !== 'read') {
          try { const latest = await api.state(); if (epoch === generation.current && activeRef.current && activeDocument()) accept(latest) } catch { /* Preserve the original stable error. */ }
        }
      }
    } finally { if (epoch === generation.current) { pending.current = false; setOperation(null) } }
  }
  const phaseLabels: Record<SteamAuthenticatorEnrollmentPhase, string> = {
    idle: t('尚未开始', 'Not started'), 'login-required': t('需要独立手机端登录', 'Independent mobile sign-in required'), 'guard-required': t('等待登录验证', 'Waiting for sign-in verification'),
    'phone-needed': t('选择验证方式或核对手机号', 'Choose a verification path or check phone status'), 'email-required': t('等待邮箱操作', 'Waiting for email action'), 'sms-required': t('等待手机号短信验证', 'Waiting for phone SMS verification'),
    'ready-to-add': t('可核对后添加一次', 'Ready for one confirmed Add'), adding: t('正在添加，请勿重复操作', 'Adding; do not repeat the request'), 'add-uncertain': t('添加结果未核实，禁止再次添加', 'Add unconfirmed; another Add is forbidden'),
    'backup-required': t('必须先保存急救码与备份', 'Recovery code and backup must be saved first'), 'ready-to-finalize': t('等待激活验证码', 'Waiting for activation code'), finalizing: t('正在激活，请勿重复操作', 'Finalizing; do not repeat the request'),
    'finalize-wait': t('等待服务端允许的重试时间', 'Waiting for the server retry deadline'), verifying: t('需要核对服务端最终状态', 'Server-state verification needed'), complete: t('服务端已核对绑定完成', 'Enrollment confirmed by server readback'),
    paused: t('已暂停，待你明确恢复', 'Paused until you explicitly resume'), error: t('需要核对当前流程', 'Current flow needs verification')
  }
  const shownError = error ?? state?.error
  const durableUnconfirmed = /PERSISTENCE_FAILED$/.test(shownError ?? '')
  return <section className="game-status-card steam-authenticator-enrollment" aria-label={t('新建手机令牌向导', 'Mobile authenticator enrollment wizard')}>
    <div className="game-status-section-title"><div><h3>{t('新建手机令牌', 'Create a mobile authenticator')}</h3><p>{t('独立 MobileApp 认证，不复用工具箱网页登录或个人 CM 会话', 'Independent MobileApp authentication, without reusing toolbox browser or personal CM sessions')}</p></div><span className="game-status-badge" role="status">{newAccount ? t('新目标待独立认证', 'New target needs independent authentication') : phaseLabels[phase]}</span></div>
    <div className="game-status-notice info"><strong>{t('此流程会改变 Steam 账号的安全状态', 'This flow changes Steam account security')}</strong>
      <p>{t('添加前和确认急救码已保管时，都需在系统窗口明确确认。隔离测试不等于真实账号验证，只有服务端核对后才显示完成；已有验证器请导入或使用官方迁移，不会自动移除', 'Native confirmation is required before Add and when acknowledging saved recovery material. Isolated tests are not live-account verification; completion requires server readback. Import or officially transfer an existing authenticator; it is never removed automatically')}</p></div>
    <div className="game-status-actions"><button disabled={!active || saving || operation !== null} onClick={() => void run('read')}>{operation === 'read' ? t('正在读取…', 'Reading…') : t('刷新流程状态', 'Read flow state')}</button>
      {id && !newAccount && !['complete', 'add-uncertain'].includes(phase) && <button disabled={!active || busy} onClick={() => void run('pause')}>{t('暂停此流程', 'Pause this flow')}</button>}
      {replaceable && !newAccount && <button disabled={!active || busy} onClick={() => { setNewAccount(true); setAccountName(''); setExpectedSteamId(''); setPhoneNumber(''); setPhoneChecked(false); clearInputs() }}>{t('添加前重新选择目标账号', 'Choose another target before Add')}</button>}</div>
    {state?.accountName && !newAccount && <div className="game-status-binding"><div><strong>{state.accountName}</strong><span>SteamID <code>{state.steamId ?? t('尚未返回', 'Not returned yet')}</code></span></div></div>}
    {state?.hint && active && <p className="game-status-notice info">{state.hint.slice(0, 400)}</p>}
    {shownError && active && <p className="game-status-notice error" role="alert">{steamAuthenticatorEnrollmentError(shownError, t)}</p>}
    {state?.metadataIncomplete && active && <p className="game-status-notice info" role="status">{t('Steam 未返回完整的 SDA 可选元数据，备份仅保留实际收到的资料，不补造 serial、tokenGid 等字段；这不应标为完整 SDA 备份', 'Steam did not return all optional SDA metadata. The backup preserves received material only, without inventing serial, tokenGid or other missing fields; it must not be labelled a full SDA backup')}</p>}
    {notice && active && <p className="game-status-notice success" role="status">{notice === 'recovery-shown' ? t('急救码已在系统窗口显示，页面未收到码值；请单独妥善保管', 'The recovery code was shown in a native window, not returned to this page; keep it separately and private')
      : rescueOnly ? t('隔离救援资料已导出，不是已完成绑定的验证器备份，请保留文件并人工核对', 'Quarantined rescue material was exported; this is not a backup of a successfully enrolled authenticator. Keep the file and verify manually')
        : t('敏感备份已保存并重新读取状态；激活前仍需你明确确认已保管急救码', 'The sensitive backup was saved and the state was reread; you must still explicitly acknowledge saving the recovery code before activation')}</p>}
    {!active ? <p className="game-status-help">{t('页面隐藏后清空输入并停止显示更新，不会自动添加、激活或恢复流程', 'Hidden pages clear entered values and stop display updates, without automatically adding, finalizing or resuming')}</p>
      : <>
        {loginPhase && <div className="steam-authenticator-enrollment-form"><label>{t('手机端登录账号', 'Mobile sign-in account')}<input aria-label={t('手机端登录账号', 'Mobile sign-in account')} autoComplete="username" value={accountName} maxLength={128} disabled={busy} onChange={event => setAccountName(event.target.value)} /></label>
          <label>{t('本次登录密码', 'Password for this sign-in')}<input aria-label={t('本次登录密码', 'Password for this sign-in')} type="password" autoComplete="off" value={password} maxLength={256} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
          <label>{t('目标 SteamID（可选）', 'Expected SteamID (optional)')}<input aria-label={t('目标 SteamID（可选）', 'Expected SteamID (optional)')} inputMode="numeric" value={expectedSteamId} maxLength={17} disabled={busy} onChange={event => setExpectedSteamId(event.target.value)} /></label>
          <div className="game-status-actions"><button className="primary" disabled={!state || busy || !accountName.trim() || !password || Boolean(expectedSteamId.trim() && !/^7656119\d{10}$/.test(expectedSteamId.trim()))} onClick={() => void run('login')}>{t('开始独立手机端认证', 'Start independent mobile authentication')}</button></div>
          <p className="game-status-help">{t('密码仅提交到主进程用于本次认证，提交或隐藏后立即清空输入，不写入令牌备份', 'The password goes only to the main process for this sign-in; the input clears on submission or hiding and is not written to authenticator backups')}</p></div>}
        {phase === 'guard-required' && !newAccount && <div className="steam-authenticator-enrollment-form">{['email', 'device'].includes(state?.guardType ?? '')
          ? <><label>{state?.guardType === 'email' ? t('邮箱登录验证码', 'Email sign-in code') : t('已有令牌登录验证码', 'Existing authenticator sign-in code')}<input aria-label={t('登录验证码', 'Sign-in verification code')} autoComplete="one-time-code" value={guardCode} maxLength={32} disabled={busy} onChange={event => setGuardCode(event.target.value)} /></label><button disabled={busy || !guardCode.trim()} onClick={() => void run('guard')}>{t('提交登录验证码', 'Submit sign-in code')}</button></>
          : <p className="game-status-help">{t('请按 Steam 提示在手机端确认登录，再由你手动核对状态；本页不自动调用重新核对，也不猜测验证方式', 'Follow Steam’s mobile confirmation prompt, then check the state manually; this page does not call the check action automatically or guess a verification method')}</p>}
          <button disabled={busy} onClick={() => void run('refresh-login')}>{t('重新核对登录确认', 'Check sign-in confirmation')}</button></div>}
        {phonePhase && !newAccount && <div className="steam-authenticator-enrollment-form">{phase === 'phone-needed' && <div className="game-status-notice info"><strong>{t('验证方式以 Steam 实际返回为准', 'The verification method is determined by Steam')}</strong>
          <p>{t('可以先明确尝试新建一次，邮件或短信激活方式由 Steam 决定；不保证免手机号，也不会强制冒充邮件方式。若服务端明确要求手机号，再按下方步骤核对', 'You may explicitly attempt enrollment once; Steam determines whether activation uses email or SMS. This does not guarantee phone-free enrollment or force an email method. Follow the phone steps below if the server requires them')}</p>
          <button className="primary" disabled={busy || !id || !state?.steamId || /PHONE_REQUIRED$/.test(state.error ?? '')} onClick={() => void run('add')}>{t('尝试按 Steam 允许方式新建', 'Try enrollment using the method Steam permits')}</button></div>}
          <p className="game-status-help">{t('手机号流程先明确读取状态，再决定绑定或发送短信；等待邮件时请先完成邮件操作', 'For the phone path, read status explicitly before enrolling a number or sending SMS; complete any required email action first')}</p>
          <button disabled={busy} onClick={() => void run('phone-status')}>{t('核对手机号与邮箱状态', 'Check phone and email status')}</button>
          {phase === 'phone-needed' && <><label>{t('国际区号（例如 86，不带 +）', 'Calling code (for example 86, without +)')}<input aria-label={t('国际区号', 'Calling code')} inputMode="numeric" value={countryCode} maxLength={4} disabled={busy} onChange={event => { setCountryCode(event.target.value); setPhoneChecked(false) }} /></label>
            <label>{t('完整国际手机号（必须含 + 和国家码）', 'Full international phone number (include + and calling code)')}<input aria-label={t('完整国际手机号', 'Full international phone number')} type="tel" placeholder="+8613800000000" value={phoneNumber} maxLength={16} disabled={busy} onChange={event => { setPhoneNumber(event.target.value); setPhoneChecked(false) }} /></label>
            <button disabled={busy || !phoneChecked || !/^\+[1-9]\d{6,14}$/.test(phoneNumber.trim()) || !/^\d{1,4}$/.test(countryCode.trim()) || !phoneNumber.trim().startsWith(`+${countryCode.trim()}`)} onClick={() => void run('phone-begin')}>{t('请求绑定此手机号', 'Request this phone number')}</button></>}
          {phase === 'email-required' && <p className="game-status-help">{t('请先在邮箱完成 Steam 要求的验证，然后点击上方核对状态；不会自动发送短信', 'Complete the verification requested by Steam in your email, then check the state above; SMS is not sent automatically')}</p>}
          {phase === 'sms-required' && <><button disabled={busy || !phoneChecked} onClick={() => void run('phone-send')}>{t('明确发送验证短信', 'Send verification SMS explicitly')}</button>
            <label>{t('手机号验证短信码', 'Phone-verification SMS code')}<input aria-label={t('手机号验证短信码', 'Phone-verification SMS code')} inputMode="numeric" autoComplete="one-time-code" value={smsCode} maxLength={12} disabled={busy} onChange={event => setSmsCode(event.target.value)} /></label>
            <button disabled={busy || !/^\d{4,12}$/.test(smsCode.trim())} onClick={() => void run('phone-submit')}>{t('提交手机号短信码', 'Submit phone SMS code')}</button></>}
        </div>}
        {phase === 'ready-to-add' && !newAccount && <div className="game-status-notice info"><p>{t('下一步只请求添加一次，需在系统窗口核对目标账号。即使超时也不会自动重发 Add', 'The next step requests Add once after native confirmation of the target account. Add is not resent automatically, even after a timeout')}</p>
          <button className="primary" disabled={busy || !id || !state?.steamId} onClick={() => void run('add')}>{t('核对后添加令牌一次', 'Confirm and add authenticator once')}</button></div>}
        {phase === 'add-uncertain' && <p className="game-status-notice error">{rescueOnly
          ? durableUnconfirmed
            ? t('已收到并隔离保留资料，但加密持久保存尚未核实，不能当作已绑定验证器。不要退出、清理或重新 Add，请先导出可用救援资料并人工核对', 'Received material is isolated in the pending flow, but encrypted persistence is unconfirmed. It is not an enrolled authenticator. Do not exit, clear records or repeat Add; export available rescue material and verify manually first')
            : t('已隔离加密保留收到的资料，但字段或身份未通过核对，不能当作已绑定验证器。禁止重新 Add 或 Finalize，请先导出救援资料并人工核对', 'Received material was quarantined and encrypted, but its fields or identity could not be verified. It is not an enrolled authenticator. Add and Finalize are forbidden; export rescue material and verify manually first')
          : t('服务端可能已经处理添加，但本机未取得可核实结果。不要再次添加、移除验证器或清理记录；请先通过 Steam 核对', 'The server may have processed Add without a verifiable local result. Do not add again, remove authenticators or clear records; verify with Steam first')}</p>}
        {hasPendingMaterial && <div className="game-status-live-display"><h4>{rescueOnly ? t('隔离救援资料（不是已绑定令牌）', 'Quarantined rescue material (not an enrolled authenticator)') : t('急救码与敏感备份', 'Recovery code and sensitive backup')}</h4><p className="game-status-help">{rescueOnly
          ? t('仅保留实际收到的资料，不补造缺失字段。若资料中包含急救码可在系统窗口查看，救援文件含未加密敏感资料，不能作为已完成验证器导入', 'Only actually received material is preserved; missing fields are not invented. A recovery code, if present, can be shown in a native window. The rescue file contains unencrypted sensitive material and must not be imported as a completed authenticator')
          : t('急救码只在系统窗口显示；敏感备份含未加密密钥，必须单独妥善保存。页面勾选不能替代主进程的备份校验和最终确认', 'The recovery code appears only in a native window. The sensitive backup contains unencrypted secrets and must be kept private. A page checkbox does not replace main-process backup verification or final confirmation')}</p>
          <div className="game-status-actions"><button disabled={busy} onClick={() => void run('show-recovery')}>{t('在系统窗口查看急救码', 'Show recovery code in native window')}</button><button disabled={busy || ['finalizing', 'finalize-wait', 'verifying'].includes(phase)} onClick={() => void run('export-backup')}>{rescueOnly ? t('保存隔离救援资料', 'Save quarantined rescue material') : t('保存敏感急救备份', 'Save sensitive recovery backup')}</button></div>
          <p>{state?.backupExported ? t('备份保存已由主进程记录', 'Backup saving is recorded by the main process') : t('尚未完成可核验的备份保存', 'A verifiable backup has not been saved yet')}</p>
          {!state?.backupAcknowledged && phase === 'backup-required' && !rescueOnly && <><label className="game-status-checkbox"><input type="checkbox" checked={recoverySaved} disabled={busy || !state?.backupExported} onChange={event => setRecoverySaved(event.target.checked)} /><span>{t('我已单独保存急救码及敏感备份，并知道不能将它们当日志分享', 'I saved the recovery code and sensitive backup separately and will not share them as logs')}</span></label>
            <button disabled={busy || !state?.backupExported || !recoverySaved} onClick={() => void run('acknowledge')}>{t('再次确认急救码已妥善保存', 'Confirm recovery material is safely saved')}</button></>}
        </div>}
        {['ready-to-finalize', 'finalize-wait'].includes(phase) && <div className="steam-authenticator-enrollment-form">{['sms', 'email'].includes(state?.confirmationKind ?? '')
          ? <><label>{state?.confirmationKind === 'email' ? t('邮箱激活验证码', 'Email activation code') : t('短信激活验证码', 'SMS activation code')}<input aria-label={t('激活验证码', 'Activation verification code')} autoComplete="one-time-code" value={activationCode} maxLength={32} disabled={busy} onChange={event => setActivationCode(event.target.value)} /></label>
            {state?.retryAt && state.retryAt > now && <p role="status">{t(`请等待 ${Math.ceil((state.retryAt - now) / 1_000)} 秒后由你重新提交，不会自动激活`, `Wait ${Math.ceil((state.retryAt - now) / 1_000)}s before submitting again yourself; activation is not automatic`)}</p>}
            <button className="primary" disabled={busy || !canFinalize || !activationCode.trim()} onClick={() => void run('finalize')}>{t('提交激活验证码并核对', 'Submit activation code and verify')}</button></>
          : <p className="game-status-notice error">{t('激活确认类型未识别，未开放 Finalize；请保留急救码和备份', 'The activation confirmation type is unknown; Finalize is disabled. Preserve the recovery code and backup')}</p>}</div>}
        {['paused', 'verifying'].includes(phase) && !newAccount && <div className="game-status-actions"><button disabled={busy || !id} onClick={() => void run('resume')}>{phase === 'verifying' ? t('只读核对服务端绑定状态', 'Read back server enrollment state') : t('明确恢复当前流程', 'Resume this flow explicitly')}</button></div>}
        {phase === 'complete' && <><p className="game-status-notice success" role="status">{newAccount ? t('上一个流程已完成，新目标尚未开始认证；上一个令牌记录会保留', 'The previous flow completed and its authenticator entry is retained; the new target has not authenticated yet')
          : t('服务端状态已核对为绑定完成，本机令牌记录已保存。请继续单独保管急救码及敏感备份', 'Server readback confirms enrollment and the local authenticator entry is saved. Continue keeping the recovery code and sensitive backup separately')}</p>
          {!newAccount && <button disabled={busy} onClick={() => { setNewAccount(true); setAccountName(''); setExpectedSteamId(''); setPhoneNumber(''); setPhoneChecked(false); setRecoverySaved(false); clearInputs() }}>{t('为另一个账号新建', 'Enroll another account')}</button>}</>}
      </>}
  </section>
}
