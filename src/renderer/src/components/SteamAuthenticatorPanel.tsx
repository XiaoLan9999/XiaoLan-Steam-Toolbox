import { useEffect, useRef, useState } from 'react'
import type { SteamAuthenticatorApi, SteamAuthenticatorEntry, SteamAuthenticatorSnapshot } from '../../../shared/steam-authenticator'
import type { SteamAuthenticatorConfirmationsApi } from '../../../shared/steam-authenticator-confirmations'
import type { SteamAuthenticatorEnrollmentApi } from '../../../shared/steam-authenticator-enrollment'
import { isEnergySavingActive, subscribeEnergySaving } from '../energy-saving'
import { useI18n, type Translate } from '../i18n'
import { SteamAuthenticatorConfirmationsPanel, type SteamAuthenticatorConfirmationEntry } from './SteamAuthenticatorConfirmationsPanel'
import { SteamAuthenticatorSetupPanel } from './SteamAuthenticatorSetupPanel'
import './game-status.css'
import './steam-account-tools.css'

export function steamAuthenticatorError(code: unknown, t: Translate): string {
  switch (code) {
    case 'AUTHENTICATOR_STORAGE_UNAVAILABLE': return t('本机安全存储不可用，未读取或导入令牌密钥', 'Local secure storage is unavailable; authenticator secrets were not read or imported')
    case 'AUTHENTICATOR_ENCRYPTED_UNSUPPORTED': return t('暂不支持加密的 .maFile，请在已有验证器中准备可导入的文件并妥善保管', 'Encrypted .maFile files are not supported; prepare an importable file in your existing authenticator and keep it private')
    case 'AUTHENTICATOR_SECRET_INVALID': case 'AUTHENTICATOR_NAME_INVALID': case 'AUTHENTICATOR_IDENTITY_INVALID':
    case 'AUTHENTICATOR_JSON_INVALID': case 'AUTHENTICATOR_FILE_INVALID': return t('无法识别这个 .maFile，请选择已有验证器导出的有效文件', 'This .maFile could not be read; choose a valid export from your existing authenticator')
    case 'AUTHENTICATOR_PATH_INVALID': case 'AUTHENTICATOR_FILE_UNAVAILABLE': case 'AUTHENTICATOR_FILE_CHANGED': return t('所选文件暂时无法安全读取，请重新选择文件', 'The selected file could not be read safely; select it again')
    case 'AUTHENTICATOR_FILE_TOO_LARGE': return t('文件大小异常，未导入令牌', 'The file size is unexpected; no authenticator was imported')
    case 'AUTHENTICATOR_VAULT_INVALID': return t('本机令牌数据无法校验，未尝试覆盖，请保留原文件', 'The local authenticator data could not be verified; nothing was overwritten, so keep the original file')
    case 'AUTHENTICATOR_VAULT_CHANGED': case 'AUTHENTICATOR_ENTRY_NOT_FOUND': return t('这个令牌记录已变化，请刷新列表后重试', 'This authenticator entry changed; refresh the list and try again')
    case 'AUTHENTICATOR_VAULT_FULL': return t('本机令牌记录已达到上限，请整理后再导入', 'The local authenticator limit was reached; remove unused entries before importing')
    case 'AUTHENTICATOR_STORAGE_FAILED': return t('未能加密保存令牌，原有记录未被自动覆盖，请重试', 'The authenticator could not be saved securely; existing records were not automatically overwritten, so try again')
    case 'AUTHENTICATOR_IMPORT_EXPIRED': case 'AUTHENTICATOR_REPLACE_REQUIRED': return t('导入确认已失效，请重新选择文件并确认', 'The import confirmation expired; select the file and confirm again')
    case 'AUTHENTICATOR_BUSY': return t('上一项令牌操作尚未完成，请稍候', 'The previous authenticator operation is still running')
    case 'AUTHENTICATOR_TIME_INVALID': case 'AUTHENTICATOR_TIME_UNAVAILABLE': return t('暂时无法同步 Steam 时间，请核对系统时间后重试', 'Steam time could not be synchronized; check the system clock and try again')
    case 'AUTHENTICATOR_CLIPBOARD_FAILED': return t('未能复制验证码，请重新尝试', 'The code could not be copied; try again')
    case 'AUTHENTICATOR_RECOVERY_UNAVAILABLE': case 'AUTHENTICATOR_MATERIAL_UNAVAILABLE': return t('本地存档没有可用的急救码，请重新导入包含原始恢复资料的 maFile，不会补造急救码', 'This local record has no available recovery code; re-import a maFile containing the original recovery material. Recovery codes are never invented')
    default: return t('令牌操作未完成，请重试；不会显示文件原文或密钥', 'The authenticator operation did not complete; try again. File contents and secrets are never displayed')
  }
}

function errorIdentifier(failure: unknown): string {
  return failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'unavailable'
}

export function authenticatorSecondsRemaining(expiresAt: number, now: number): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 0
  const seconds = Math.ceil((expiresAt - now) / 1_000)
  return seconds > 0 && seconds <= 30 ? seconds : 0
}

function displayCode(entry: SteamAuthenticatorEntry, now: number): string | null {
  return /^[A-Z0-9]{5}$/.test(entry.code) && authenticatorSecondsRemaining(entry.expiresAt, now) > 0 ? entry.code : null
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function confirmationMetadata(snapshot: SteamAuthenticatorSnapshot): SteamAuthenticatorConfirmationEntry[] {
  return snapshot.secretStorageAvailable ? snapshot.entries.map(entry => ({ id: entry.id, name: entry.name, steamId: entry.steamId,
    capabilities: { hasConfirmations: entry.capabilities?.hasConfirmations === true, fullBackup: entry.capabilities?.fullBackup === true } })) : []
}

export function SteamAuthenticatorPanel({ api, confirmationsApi, enrollmentApi, selectedSteamId, visible = true }: {
  api: SteamAuthenticatorApi
  confirmationsApi?: SteamAuthenticatorConfirmationsApi
  enrollmentApi?: SteamAuthenticatorEnrollmentApi
  selectedSteamId?: string | null
  visible?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<'codes' | 'confirmations' | 'setup'>('codes')
  const [pageActive, setPageActive] = useState(pageVisible)
  const [saving, setSaving] = useState(isEnergySavingActive)
  const [visibilityEpoch, setVisibilityEpoch] = useState(0)
  const [snapshot, setSnapshot] = useState<SteamAuthenticatorSnapshot | null>(null)
  const [metadata, setMetadata] = useState<SteamAuthenticatorConfirmationEntry[]>([])
  const [now, setNow] = useState(Date.now)
  const [operation, setOperation] = useState<'read' | 'import' | 'remove' | 'sync' | 'copy' | 'export' | 'recovery' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<'imported' | 'removed' | 'copied' | 'exported' | 'exported-codes' | 'recovery-viewed' | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const current = useRef<SteamAuthenticatorSnapshot | null>(null)
  const boundary = useRef('')
  const readRequested = useRef(false)
  const refresh = useRef<(() => Promise<void>) | null>(null)
  const active = visible && pageActive && tab === 'codes'
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const update = (): void => {
      const next = pageVisible()
      if (!next) { activeRef.current = false; generation.current++; current.current = null; pending.current = false; setSnapshot(null); setOperation(null); setVisibilityEpoch(value => value + 1) }
      setPageActive(next)
    }
    const unsubscribe = subscribeEnergySaving(setSaving)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
    update()
    return () => {
      unsubscribe()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update)
    }
  }, [])
  useEffect(() => {
    const epoch = ++generation.current
    current.current = null; pending.current = false; boundary.current = ''; readRequested.current = false; refresh.current = null
    setSnapshot(null); setOperation(null); setError(null); setNotice(null); setNow(Date.now())
    if (!active) return () => { generation.current++ }
    const read = async (): Promise<void> => {
      if (pending.current || !activeRef.current || epoch !== generation.current) return
      readRequested.current = true
      pending.current = true; setOperation('read'); setError(null)
      try {
        const value = await api.state()
        if (activeRef.current && epoch === generation.current) {
          current.current = value; setSnapshot(value); setMetadata(confirmationMetadata(value)); setNow(Date.now())
        }
      } catch (failure) {
        if (activeRef.current && epoch === generation.current) setError(errorIdentifier(failure))
      } finally {
        if (epoch === generation.current) { pending.current = false; setOperation(null) }
      }
    }
    refresh.current = read
    if (!isEnergySavingActive()) void read()
    return () => { generation.current++; current.current = null; refresh.current = null }
  }, [api, active, visibilityEpoch])
  useEffect(() => {
    if (!active || saving) return
    const tick = (): void => {
      if (!activeRef.current || isEnergySavingActive()) return
      const time = Date.now()
      setNow(time)
      if (!readRequested.current && !pending.current) { void refresh.current?.(); return }
      const expired = current.current?.entries.filter(entry => Number.isFinite(entry.expiresAt) && entry.expiresAt <= time)
        .map(entry => `${entry.id}:${entry.expiresAt}`).join('|')
      if (expired && boundary.current !== expired && !pending.current) {
        // One read per expired code window; failures require manual refresh rather than an IPC retry loop.
        boundary.current = expired
        void refresh.current?.()
      }
    }
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [active, saving, visibilityEpoch])
  const perform = async (kind: 'read' | 'import' | 'remove' | 'sync' | 'copy' | 'export' | 'recovery', id?: string): Promise<void> => {
    if (!activeRef.current || isEnergySavingActive() || pending.current || ['copy', 'remove', 'export', 'recovery'].includes(kind) && !current.current?.entries.some(entry => entry.id === id)) return
    const epoch = generation.current
    pending.current = true; setOperation(kind); setError(null); setNotice(null)
    try {
      if (kind === 'copy') {
        await api.copyCode({ id: id! })
        if (activeRef.current && epoch === generation.current) setNotice('copied')
      } else if (kind === 'export') {
        const result = await api.exportFile({ id: id! })
        if (result.exported && activeRef.current && epoch === generation.current) setNotice(result.kind === 'codes-only' ? 'exported-codes' : 'exported')
      } else if (kind === 'recovery') {
        const result = await api.showRecoveryCode({ id: id! })
        if (result.viewed && activeRef.current && epoch === generation.current) setNotice('recovery-viewed')
      } else {
        const value = kind === 'import' ? await api.importFile() : kind === 'remove' ? await api.remove({ id: id! })
          : kind === 'sync' ? await api.syncTime() : await api.state()
        if (value && activeRef.current && epoch === generation.current) {
          current.current = value; setSnapshot(value); setMetadata(confirmationMetadata(value)); setNow(Date.now())
          if (kind === 'import') setNotice('imported')
          if (kind === 'remove' && !value.entries.some(entry => entry.id === id)) setNotice('removed')
        }
      }
    } catch (failure) {
      if (activeRef.current && epoch === generation.current) setError(errorIdentifier(failure))
    } finally {
      if (epoch === generation.current) { pending.current = false; setOperation(null) }
    }
  }
  const busy = operation !== null || saving
  const entries = active && snapshot?.secretStorageAvailable ? snapshot.entries : []
  return <section className="game-status-panel steam-authenticator-panel" hidden={!visible} aria-label={t('本地 Steam 令牌', 'Local Steam authenticator')}>
    <header className="game-status-heading"><div><span className="game-status-eyebrow">STEAM GUARD</span>
      <h2>{t('本地令牌', 'Local authenticator')}</h2>
      <p>{t('手动导入已有 SDA .maFile，在本机查看当前验证码', 'Manually import an existing SDA .maFile to view current codes locally')}</p>
    </div><span className="game-status-badge">{!snapshot ? t('本机令牌', 'Local authenticator') : snapshot.timeSource === 'steam' ? t('Steam 时间', 'Steam time') : t('本机时间', 'Local time')}</span></header>
    <nav className="game-status-tabs steam-authenticator-tabs" aria-label={t('令牌工具', 'Authenticator tools')} role="tablist">
      {([['codes', t('验证码与备份', 'Codes and backups')], ['confirmations', t('交易与市场确认', 'Trade and market')], ['setup', t('新建手机令牌', 'New authenticator')]] as const).map(([value, label]) =>
        <button key={value} role="tab" id={`steam-authenticator-${value}-tab`} aria-controls={`steam-authenticator-${value}-panel`} aria-selected={tab === value}
          className={tab === value ? 'selected' : ''} disabled={!visible || !pageActive || busy} onClick={() => { if (!pending.current) setTab(value) }}>{label}</button>)}
    </nav>
    <section className="game-status-card" role="tabpanel" id="steam-authenticator-codes-panel" aria-labelledby="steam-authenticator-codes-tab" hidden={tab !== 'codes'}>
      <div className="game-status-section-title"><div><h3>{t('已导入的令牌', 'Imported authenticators')}</h3>
        <p>{t('文件选择、覆盖确认和删除确认都在系统窗口中完成，页面不接收文件路径、原文或密钥', 'File selection, replacement and removal are confirmed in native windows; this page never receives file paths, file contents or secrets')}</p></div></div>
      <div className="game-status-notice info"><strong>{t('验证码、确认材料与备份分开管理', 'Codes, confirmation materials and backups are managed separately')}</strong>
        <p>{t('查看验证码不会注册新的手机验证器，不会移除手机验证器，也不会自动确认交易', 'No new mobile authenticator is registered by viewing codes, no mobile authenticator is removed, and no trades are confirmed automatically')}</p>
        <p>{t('完整导入会在本机加密保留验证码密钥、确认密钥、设备标识和已有恢复资料，导入前会明确说明并确认；不会保留原 maFile 中的登录会话令牌或 Cookie', 'Full import retains code and confirmation secrets, device identifiers and existing recovery material encrypted locally, with explicit disclosure and confirmation first; login-session tokens and cookies from the original maFile are not retained')}</p>
        <p>{t('密钥不包含在普通数据导出或诊断日志中；单独导出的 .maFile 含未加密密钥，请妥善保管，不要当作日志上传或发送给他人', 'Secrets are excluded from ordinary data exports and diagnostic logs; a separately exported .maFile contains unencrypted secrets, so keep it private and never upload it as a log or send it to others')}</p>
      </div>
      {snapshot && !snapshot.secretStorageAvailable && <p className="game-status-notice error" role="alert">{t('本机安全存储不可用，令牌导入和验证码读取已停用', 'Local secure storage is unavailable; authenticator import and code access are disabled')}</p>}
      {snapshot?.clockWarning && <p className="game-status-notice info" role="status">{snapshot.clockWarning === 'steam-time-unavailable'
        ? t('Steam 时间同步暂不可用，目前使用本机时钟；若验证码被拒绝，请校准系统时间后重试', 'Steam time synchronization is unavailable, so the local clock is used; if codes are rejected, correct the system clock and try again')
        : t('当前使用本机时钟，可手动同步 Steam 时间以减少时钟偏差', 'Codes use the local clock; synchronize Steam time manually to reduce clock differences')}</p>}
      <div className="game-status-actions">
        <button className="primary" disabled={!active || busy || !snapshot?.secretStorageAvailable} onClick={() => void perform('import')}>{operation === 'import' ? t('正在导入…', 'Importing…') : t('导入 .maFile', 'Import .maFile')}</button>
        <button disabled={!active || busy} onClick={() => void perform('read')}>{operation === 'read' ? t('正在读取…', 'Reading…') : t('刷新验证码', 'Refresh codes')}</button>
        <button disabled={!active || busy || !snapshot?.secretStorageAvailable} onClick={() => void perform('sync')}>{operation === 'sync' ? t('正在同步…', 'Synchronizing…') : t('同步 Steam 时间', 'Sync Steam time')}</button>
      </div>
      {error && <p className="game-status-notice error" role="alert">{steamAuthenticatorError(error, t)}</p>}
      {notice && active && <p className="game-status-notice success" role="status">{notice === 'imported' ? t('令牌已导入并加密保存在本机', 'Authenticator imported and encrypted locally')
        : notice === 'removed' ? t('已删除工具箱中的本地令牌记录，手机验证器不受影响', 'The local toolbox entry was removed; the mobile authenticator is unchanged')
          : notice === 'exported-codes' ? t('已导出仅验证码备份，不包含交易确认材料或缺失的恢复码', 'A codes-only backup was exported without confirmation material or missing recovery codes')
            : notice === 'exported' ? t('已导出本机保留的令牌资料，不包含登录会话，请单独妥善保管', 'The retained local authenticator material was exported without login sessions; keep it private')
              : notice === 'recovery-viewed' ? t('已在系统窗口显示已有急救码，页面不接收码值；查看不等于已保存备份', 'The saved recovery code was shown in a native window, not returned to this page; viewing it does not mean a backup was saved')
          : t('已复制当前验证码', 'Current code copied')}</p>}
      {!active ? <p className="game-status-help">{t('页面隐藏时暂停验证码刷新与倒计时，重新显示后读取当前验证码', 'Code refresh and countdowns pause while hidden; current codes are read again when the page is visible')}</p>
        : entries.length > 0 ? <div className="game-status-key-table-wrap"><table className="game-status-key-table">
          <thead><tr><th scope="col">{t('账号', 'Account')}</th><th scope="col">{t('验证码', 'Code')}</th><th scope="col">{t('有效时间', 'Time remaining')}</th><th scope="col">{t('操作', 'Actions')}</th></tr></thead>
          <tbody>{entries.map(entry => {
            const code = saving ? null : displayCode(entry, now)
            const seconds = authenticatorSecondsRemaining(entry.expiresAt, now)
            return <tr key={entry.id}><th scope="row" className="steam-account-name"><strong>{entry.name}</strong>{entry.steamId && <div><code className="steam-account-id">{entry.steamId}</code></div>}
              <div className="steam-authenticator-capabilities"><span>{entry.capabilities?.hasConfirmations ? t('本地确认材料齐备', 'Local confirmation material ready') : t('仅验证码', 'Codes only')}</span>
                <span>{entry.capabilities?.fullBackup ? t('完整 SDA 备份材料', 'Full SDA backup material') : t('恢复资料可能不完整', 'Recovery material may be incomplete')}</span></div>
              {!entry.capabilities?.hasConfirmations && <small className="steam-authenticator-capability-note">{t('旧版仅验证码存档需重新导入原 maFile，才能补齐已有确认材料；不会捏造密钥或恢复码', 'Re-import the original maFile to supplement a legacy codes-only record; missing secrets or recovery codes are never invented')}</small>}</th>
              <td><code className="steam-authenticator-code" aria-label={t(`${entry.name} 的验证码`, `Code for ${entry.name}`)}>{code ?? '—'}</code></td>
              <td>{saving ? t('节能暂停显示', 'Display paused for energy saving') : code ? t(`${seconds} 秒后更新`, `Updates in ${seconds}s`) : t('等待刷新', 'Waiting for refresh')}</td>
              <td><div className="game-status-actions"><button disabled={busy || !code || !snapshot?.secretStorageAvailable} aria-label={t(`复制 ${entry.name} 的验证码`, `Copy code for ${entry.name}`)} onClick={() => void perform('copy', entry.id)}>{t('复制', 'Copy')}</button>
                <button disabled={busy || !snapshot?.secretStorageAvailable || typeof api.exportFile !== 'function'} aria-label={t(`导出 ${entry.name} 的敏感令牌备份`, `Export sensitive authenticator backup for ${entry.name}`)} onClick={() => void perform('export', entry.id)}>{operation === 'export' ? t('导出中…', 'Exporting…') : t('导出', 'Export')}</button>
                <button disabled={busy || !snapshot?.secretStorageAvailable || typeof api.showRecoveryCode !== 'function'} aria-label={t(`在系统窗口查看 ${entry.name} 的已有急救码`, `Show saved recovery code for ${entry.name} in native window`)} onClick={() => void perform('recovery', entry.id)}>{t('急救码', 'Recovery code')}</button>
                <button className="ghost danger-text" disabled={busy} aria-label={t(`删除 ${entry.name} 的本地令牌`, `Remove local authenticator for ${entry.name}`)} onClick={() => void perform('remove', entry.id)}>{t('删除', 'Remove')}</button></div></td></tr>
          })}</tbody>
        </table></div> : !busy && snapshot?.secretStorageAvailable && <div className="game-status-empty"><h3>{t('尚未导入令牌', 'No authenticators imported')}</h3>
          <p>{t('选择你已有的 .maFile，不会自动扫描其它软件或目录', 'Choose an existing .maFile; no other applications or directories are scanned automatically')}</p></div>}
    </section>
    {tab === 'confirmations' && <div role="tabpanel" id="steam-authenticator-confirmations-panel" aria-labelledby="steam-authenticator-confirmations-tab">
      <SteamAuthenticatorConfirmationsPanel api={confirmationsApi} entries={metadata} selectedSteamId={selectedSteamId} visible={visible && pageActive} />
    </div>}
    {tab === 'setup' && <div role="tabpanel" id="steam-authenticator-setup-panel" aria-labelledby="steam-authenticator-setup-tab"><SteamAuthenticatorSetupPanel api={enrollmentApi} visible={visible && pageActive} /></div>}
  </section>
}
