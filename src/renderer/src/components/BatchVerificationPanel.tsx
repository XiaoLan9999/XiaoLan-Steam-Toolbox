import { useEffect, useState } from 'react'
import type { BatchSummary } from '../../../shared/types'
import { localizeMessage } from '../../../shared/localization'
import { useI18n, type Translate } from '../i18n'
import { retryCountdown } from './BatchRecoveryPanel'
import './batch-verification.css'

export function batchVerificationActive(batch: BatchSummary): boolean {
  return batch.verification?.state === 'checking' || batch.verification?.state === 'waiting'
}

export function batchVerificationActionLabel(batch: BatchSummary, t: Translate): string {
  if (batchVerificationActive(batch)) return t('正在核对', 'Verifying')
  return batch.status === 'completed' || batch.pending === 0
    ? t('仅核对待核对记录', 'Verify uncertain records only')
    : t('核对并继续其余待发', 'Verify and resume remaining pending')
}

export function batchVerificationConfirmation(batch: BatchSummary, t: Translate): string {
  return batch.status === 'completed' || batch.pending === 0
    ? t(`仅只读核对 ${batch.uncertain} 条待核对记录？找到可靠证据才标记成功，未确认的保留待核对；不会重发，也不会启动任何新发送。`,
      `Read-only check ${batch.uncertain} uncertain records? Only reliable evidence confirms success. Unproven records remain for review. Nothing will be resent and no new sending will start.`)
    : t(`只读核对 ${batch.uncertain} 条待核对记录，然后继续其余 ${batch.pending} 位待发好友？找到可靠证据才标记成功；未确认的仍保留待核对并跳过，不会重发。原有发送间隔和冷却仍有效。`,
      `Read-only check ${batch.uncertain} uncertain records, then resume ${batch.pending} remaining pending recipients? Only reliable evidence confirms success. Unproven records remain for review and are skipped, never resent. Existing send intervals and cooldown still apply.`)
}

export function BatchVerificationPanel({ batch, compact = false, disabled = false, onStop }: {
  batch: BatchSummary
  compact?: boolean
  disabled?: boolean
  onStop?(): void
}): React.JSX.Element | null {
  const { language, t } = useI18n()
  const [, tick] = useState(0)
  const verification = batch.verification
  const active = batchVerificationActive(batch)
  const deadline = verification?.state === 'waiting' && verification.nextCheckAt
    && Number.isFinite(Date.parse(verification.nextCheckAt)) ? verification.nextCheckAt : null
  const waiting = active && deadline !== null && Date.parse(deadline) > Date.now()
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [batch.id, verification?.deliveryId, deadline, waiting])

  if (!verification && batch.uncertain === 0) return null
  const state = verification?.state
  const title = state === 'checking' ? t('正在只读核对好友主页', 'Checking the friend profile (read-only)')
    : state === 'waiting' ? t('等待下一次只读核对', 'Waiting for the next read-only check')
      : state === 'confirmed' ? t('主页已确认留言送达', 'Delivery confirmed on the profile')
        : state === 'unresolved' ? t('本条暂未证实，保留待核对', 'Not proven; kept for review')
          : t('待核对留言可以自动核实', 'Uncertain comments can be verified automatically')
  const checkedAt = verification?.checkedAt && Number.isFinite(Date.parse(verification.checkedAt))
    ? verification.checkedAt : null
  const attempt = verification && Number.isSafeInteger(verification.attempt) ? Math.max(0, verification.attempt) : 0
  const maxAttempts = verification && Number.isSafeInteger(verification.maxAttempts) ? Math.max(0, verification.maxAttempts) : 0
  return <section className={`batch-verification${compact ? ' compact' : ''} state-${state ?? 'idle'}`}
    aria-label={t('留言只读核对', 'Read-only comment verification')}>
    <div className="batch-verification-heading">
      <h4>{t('自动核对送达', 'Automatic delivery verification')}</h4>
      <span>{t('仅读取主页，不重发待核对留言', 'Reads profiles only; never resends uncertain comments')}</span>
    </div>
    <strong className="batch-verification-state" role="status">{title}</strong>
    {verification && <div className="batch-verification-person">
      <strong dir="auto">{verification.friendName}</strong>
      <span>SteamID: <bdi>{verification.friendSteamId}</bdi></span>
      <span>{t(`核对 ${attempt} / ${maxAttempts} 次`, `Check ${attempt} / ${maxAttempts}`)}</span>
    </div>}
    {state === 'waiting' && <p className="batch-verification-countdown">
      {waiting ? <>{t('下次只读核对', 'Next read-only check')}: <strong aria-live="off">{retryCountdown(deadline!, Date.now())}</strong></>
        : t('正在准备下一次核对；这不是发送倒计时。', 'Preparing the next check; this is not a send countdown.')}
    </p>}
    {checkedAt && <p className="batch-verification-time">{t('最近核对', 'Last checked')}: <time dateTime={checkedAt}>{new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(checkedAt))}</time></p>}
    <p className="batch-verification-safety">{batch.status === 'cancelled'
      ? t('此任务已取消，不会自动核对、继续或重发；待核对记录继续保留。',
        'This task was cancelled. No automatic checks, continuation, or resending will occur; uncertain records are retained.')
      : batch.status === 'completed'
      ? t('此任务已结束：仅核对保存的待核对记录，不会启动任何新发送。',
        'This task has ended: only saved uncertain records are checked; no new sending will start.')
      : t('会自动只读核对；找到可靠证据才标记成功。未确定的保留待核对并跳过，不重复发送，也不阻塞其余待发。发送冷却仍然有效。',
        'Checks are read-only; success requires reliable evidence. Unproven results stay for review and are skipped, never resent, without blocking other pending recipients. Sending cooldown still applies.')}</p>
    {active && onStop && <button className="ghost" disabled={disabled} onClick={onStop}>{t('停止核对', 'Stop verification')}</button>}
    {verification?.message && <details className="batch-verification-detail"><summary>{t('核对技术详情', 'Verification technical details')}</summary>
      <p>{localizeMessage(verification.message, language)}</p></details>}
  </section>
}
