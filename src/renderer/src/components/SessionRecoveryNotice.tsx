import { localizeMessage } from '../../../shared/localization'
import type { AccountView } from '../../../shared/types'
import { useI18n } from '../i18n'
import { useVisibleTick } from '../use-visible-tick'
import './session-recovery-notice.css'

export function SessionRecoveryNotice({ account, busy = false, onRetry, onSignIn }: {
  account: AccountView
  busy?: boolean
  onRetry(): void
  onSignIn(): void
}): React.JSX.Element | null {
  const { language, t } = useI18n()
  const retryAt = account.sessionRetryAt ? Date.parse(account.sessionRetryAt) : NaN
  const hasPlan = account.sessionState !== 'expired' && Number.isFinite(retryAt) && retryAt > 0
  const waiting = hasPlan && retryAt > Date.now()
  const connecting = account.sessionState === 'restoring' && !hasPlan
  const retryBlocked = Boolean(account.sessionRetryBlocked)
  const expired = account.sessionState === 'expired'
  const attempt = Number.isSafeInteger(account.sessionRetryAttempt) && (account.sessionRetryAttempt ?? 0) > 0
    ? account.sessionRetryAttempt! : null

  useVisibleTick(account.sessionState !== 'authenticated' && waiting)

  if (account.sessionState === 'authenticated') return null
  const seconds = hasPlan ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0
  const countdown = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  const title = expired ? t('Steam 登录需要更新', 'Steam sign-in needs renewal')
    : hasPlan ? t('Steam 连接暂时中断，正在自动恢复', 'Steam connection interrupted; automatic recovery is active')
      : connecting ? t('正在连接 Steam', 'Connecting to Steam')
        : t('当前 Steam 账号尚未连接', 'The current Steam account is not connected')
  const description = expired
    ? t('保存的登录状态已失效或不可用，请重新登录此账号', 'The saved sign-in has expired or is unavailable. Sign in to this account again')
    : hasPlan || connecting
      ? t('正在复用已保存的登录信息。暂时的网络错误不代表凭据失效，不需要反复扫码',
        'Saved sign-in details are being reused. A temporary network error does not mean credentials expired; repeated QR scans are unnecessary')
      : t('可以先尝试用已保存的登录信息重新连接；若凭据不可用，再重新登录',
        'Try reconnecting with saved sign-in details first. Sign in again only if those credentials are unavailable')
  const detail = account.sessionMessage && /Client network socket disconnected before secure TLS connection was established/i.test(account.sessionMessage)
    ? t('网络连接在 TLS 安全握手完成前中断；这不能单独证明登录已失效',
      'The network connection closed before the TLS handshake completed. This alone does not prove sign-in expired')
    : account.sessionMessage ? localizeMessage(account.sessionMessage, language) : null

  return <section className={`session-recovery-notice${expired ? ' needs-sign-in' : ''}`}
    aria-label={t('Steam 连接恢复', 'Steam connection recovery')} data-session-state={account.sessionState}>
    <div className="session-recovery-copy">
      <h3 role="status">{title}</h3>
      <p>{description}</p>
      {detail && <p className="session-recovery-detail" dir="auto">{detail}</p>}
      {hasPlan && <p className="session-recovery-plan" aria-live="off">
        <span>{waiting ? t('距离下次自动连接', 'Next automatic connection in')
          : t('已到重试时间，正在等待自动连接', 'Retry time reached; waiting for automatic connection')}</span>
        {waiting && <strong>{countdown}</strong>}
        {attempt !== null && <span>{t(`第 ${attempt} 次重试`, `Retry ${attempt}`)}</span>}
      </p>}
      <small>{t('重连不会新建留言任务或启动游戏状态功能；已有任务仍遵循暂停和自动重试设置',
        'Reconnection creates no delivery task and starts no presence features. Existing tasks keep their pause and automatic retry settings')}</small>
    </div>
    <div className="session-recovery-actions">
      {!expired && <button type="button" className="primary" disabled={busy || connecting || retryBlocked} onClick={() => {
        if (!busy && !connecting && !retryBlocked) onRetry()
      }}>{connecting ? t('正在连接…', 'Connecting…') : retryBlocked ? t('等待登录服务允许重连', 'Waiting for sign-in retry window') : t('立即重试连接', 'Retry connection now')}</button>}
      <button type="button" className={expired ? 'primary' : 'ghost'} disabled={busy} onClick={() => {
        if (!busy) onSignIn()
      }}>{expired ? t('重新登录此账号', 'Sign in to this account again') : t('改用重新登录', 'Sign in again instead')}</button>
    </div>
  </section>
}
