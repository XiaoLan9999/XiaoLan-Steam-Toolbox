import { useEffect, useRef, useState } from 'react'
import { MAX_BATCH_RETRIES } from '../../../shared/batch-retry-policy'
import { localizeMessage } from '../../../shared/localization'
import type { BatchStopCode, BatchSummary, SteamFriendCommenterApi } from '../../../shared/types'
import { useI18n, type Translate } from '../i18n'
import { unwrap } from '../ui'
import type { RunAction } from './types'
import './batch-recovery.css'

type RecoveryApi = Pick<SteamFriendCommenterApi, 'setBatchAutoRetry' | 'resumeBatch'>

export async function enableBatchRetryAndResume(
  api: RecoveryApi, batchId: string, isCurrent: () => boolean = () => true
): Promise<void> {
  if (!isCurrent()) return
  unwrap(await api.setBatchAutoRetry(batchId, true))
  if (isCurrent()) unwrap(await api.resumeBatch(batchId))
}

export function retryCountdown(nextRetryAt: string, now: number): string {
  const target = Date.parse(nextRetryAt)
  if (!Number.isFinite(target)) return '-'
  const seconds = Math.max(0, Math.ceil((target - now) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function batchStopLabel(code: BatchStopCode | null, t: Translate): string {
  if (!code) return t('没有保存停止原因', 'No stop reason was saved')
  const labels: Record<BatchStopCode, string> = {
    MANUAL_PAUSE: t('用户手动暂停', 'Paused by the user'),
    RATE_LIMITED: t('Steam 频率限制', 'Steam rate limit'),
    ACCESS_DENIED: t('Steam 暂时拒绝访问', 'Steam temporarily denied access'),
    SESSION_EXPIRED: t('Steam 网页会话失效', 'Steam web session expired'),
    SESSION_PREPARATION: t('Steam 会话尚未准备完成', 'Steam session is not ready'),
    LOGIN_REQUIRED: t('需要重新登录 Steam', 'Steam sign-in is required'),
    NETWORK_ERROR: t('网络请求暂时失败', 'Temporary network failure'),
    SERVER_ERROR: t('Steam 服务暂时异常', 'Temporary Steam service error'),
    UNCERTAIN_RESULT: t('本条发送结果不确定', 'The delivery result is uncertain'),
    SESSION_CHANGED: t('登录会话已变更', 'The sign-in session changed'),
    ACCOUNT_CHANGED: t('当前 Steam 账号已切换', 'The active Steam account changed'),
    APP_RESTARTED: t('软件重启后保护性暂停', 'Paused safely after restarting'),
    APP_SHUTDOWN: t('软件退出时暂停', 'Paused when the app closed'),
    RETRY_EXHAUSTED: t('自动重试次数已用尽', 'Automatic retry limit reached'),
    QUEUE_ERROR: t('任务队列出现错误', 'Task queue error'),
    LEGACY_PAUSED: t('旧版本任务未保存停止原因', 'The older app did not save this task’s stop reason'),
    CANCELLED: t('用户取消任务', 'Cancelled by the user')
  }
  return labels[code] ?? t('任务已停止', 'The task stopped')
}

function stopSource(code: BatchStopCode | null, t: Translate): string {
  if (code === 'MANUAL_PAUSE' || code === 'CANCELLED') return t('用户操作', 'User action')
  if (code === 'RATE_LIMITED' || code === 'ACCESS_DENIED' || code === 'SERVER_ERROR') return t('Steam 响应', 'Steam response')
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_PREPARATION' || code === 'LOGIN_REQUIRED'
    || code === 'SESSION_CHANGED' || code === 'ACCOUNT_CHANGED') return t('账号与会话', 'Account and session')
  if (code === 'APP_RESTARTED' || code === 'APP_SHUTDOWN') return t('软件生命周期', 'App lifecycle')
  if (code === 'NETWORK_ERROR') return t('网络连接', 'Network connection')
  if (code === 'UNCERTAIN_RESULT') return t('发送结果保护', 'Delivery safety check')
  if (code === 'QUEUE_ERROR' || code === 'RETRY_EXHAUSTED') return t('任务队列', 'Task queue')
  return t('历史记录', 'Saved history')
}

function timestamp(value: string | null, language: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return language === 'en' ? 'Not recorded' : '未记录'
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value))
}

export function BatchRecoveryPanel({ batch, authenticated, otherTaskActive = false, disabled = false, runAction }: {
  batch: BatchSummary
  authenticated: boolean
  otherTaskActive?: boolean
  disabled?: boolean
  runAction: RunAction
}): React.JSX.Element {
  const { language, t } = useI18n()
  const [now, setNow] = useState(Date.now)
  const [acting, setActing] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const currentBatchId = useRef(batch.id)
  currentBatchId.current = batch.id
  const canResume = authenticated && !otherTaskActive && !disabled && batch.status === 'paused' && batch.pending > 0
  const resumeAllowed = useRef(canResume)
  resumeAllowed.current = canResume
  const active = ['queued', 'running', 'paused'].includes(batch.status)
  const scheduled = batch.status === 'paused' && batch.autoRetryEnabled && Boolean(batch.nextRetryAt)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!scheduled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [batch.id, batch.nextRetryAt, scheduled])

  const perform = async (enabled: boolean, resume = false): Promise<void> => {
    if (lock.current || !mounted.current || disabled || !active || (resume && !canResume)) return
    if (resume && !window.confirm(t(
      `开启自动重试并继续此任务？仅发送剩余 ${batch.pending} 位待发好友，已发送和结果不确定的对象不会重发；临时错误后最多自动重试 ${MAX_BATCH_RETRIES} 次。`,
      `Enable automatic retries and resume this task? Only ${batch.pending} pending recipients will be sent. Sent and uncertain results will not be retried. Temporary errors allow up to ${MAX_BATCH_RETRIES} automatic retries.`))) return
    const id = batch.id
    const isCurrent = (): boolean => mounted.current && currentBatchId.current === id && resumeAllowed.current
    lock.current = true
    setActing(true)
    try {
      await runAction(resume ? t('正在开启自动重试并继续任务', 'Enabling retries and resuming task')
        : enabled ? t('正在开启自动重试', 'Enabling automatic retries') : t('正在停止自动重试', 'Stopping automatic retries'), async () => {
        if (!mounted.current || currentBatchId.current !== id) return
        if (resume) await enableBatchRetryAndResume(window.steamCommenter, id, isCurrent)
        else unwrap(await window.steamCommenter.setBatchAutoRetry(id, enabled))
      })
    } finally {
      lock.current = false
      if (mounted.current) setActing(false)
    }
  }

  let recoveryStatus = !active ? t('任务已结束，不再自动重试。', 'The task has ended; automatic retries are stopped.')
    : scheduled ? t('已安排自动继续剩余待发。', 'Pending deliveries will resume automatically.')
      : !batch.autoRetryEnabled ? batch.status === 'paused'
        ? t('自动重试已关闭，不会自动继续。', 'Automatic retries are off. The task will not resume automatically.')
        : t('自动重试未开启：本轮正常发送，出错暂停后需手动处理。', 'Automatic retries are off. Sending continues normally, but an error pause requires manual action.')
        : batch.status === 'paused' ? t('当前没有自动继续计划，请手动继续待发。', 'No automatic resume is scheduled. Resume pending deliveries manually.')
          : t('已开启：临时错误后退避重试剩余待发。', 'Enabled: pending deliveries retry with backoff after temporary errors.')
  if (active && batch.status === 'paused' && !scheduled && batch.stopCode === 'LOGIN_REQUIRED') {
    recoveryStatus = t('需要重新登录此账号，再手动继续原任务；不会自动扫码。', 'Sign in to this account again, then resume the original task manually. QR sign-in is never automatic.')
  } else if (active && batch.status === 'paused' && !scheduled && batch.stopCode === 'RETRY_EXHAUSTED') {
    recoveryStatus = t('已达到自动重试上限，请检查停止原因后手动继续。', 'The automatic retry limit was reached. Check the stop reason before resuming manually.')
  }

  return <section className={`batch-recovery${scheduled ? ' scheduled' : ''}`} aria-label={t('停止原因与自动重试', 'Stop reason and automatic retries')}>
    {(batch.status === 'paused' || batch.status === 'cancelled' || batch.stopCode) && <div className="batch-stop-reason" role="status">
      <small>{batch.status === 'paused' ? t('本次暂停原因', 'Why this task paused') : t('最近停止原因', 'Last stop reason')}</small>
      <strong>{batchStopLabel(batch.stopCode, t)}</strong>
      {batch.stopMessage && <p>{localizeMessage(batch.stopMessage, language)}</p>}
      <span>{t('来源', 'Source')}: {stopSource(batch.stopCode, t)} · {timestamp(batch.pausedAt, language)}</span>
    </div>}
    <div className="batch-retry-heading"><strong>{t('自动重试', 'Automatic retries')}</strong>
      {active && <label><input type="checkbox" checked={Boolean(batch.autoRetryEnabled)} disabled={disabled || acting}
        onChange={(event) => void perform(event.target.checked)} />{t('启用', 'Enabled')}</label>}
    </div>
    <p className="batch-retry-state" role="status">{recoveryStatus}</p>
    {batch.retryCount > 0 && <p className="batch-retry-attempt">{t(
      `第 ${batch.retryCount} / ${MAX_BATCH_RETRIES} 次自动重试${scheduled ? '（待执行）' : '（最近记录）'}`,
      `Automatic retry ${batch.retryCount} / ${MAX_BATCH_RETRIES}${scheduled ? ' (scheduled)' : ' (last recorded)'}`)}</p>}
    {scheduled && batch.nextRetryAt && <div className="batch-retry-deadline">
      <span>{t('距离自动继续', 'Automatic resume in')}</span>
      <strong aria-live="off">{retryCountdown(batch.nextRetryAt, now)}</strong>
      <small>{t('下次重试', 'Next retry')}: {timestamp(batch.nextRetryAt, language)}</small>
      <button className="ghost" disabled={disabled || acting} onClick={() => void perform(false)}>{t('停止自动重试', 'Stop automatic retries')}</button>
    </div>}
    {active && batch.status === 'paused' && !batch.autoRetryEnabled && <button className="ghost batch-enable-retry"
      disabled={acting || !canResume} onClick={() => void perform(true, true)}>{t('开启自动重试并继续待发', 'Enable retries and resume pending')}</button>}
    <small className="batch-retry-safety">{t('仅处理剩余待发对象；已发送、已接受和结果不确定的对象不会自动重发。手动暂停、退出或切换账号会取消自动继续计划。',
      'Only pending recipients resume. Sent, accepted, and uncertain results are never retried. Pausing manually, closing the app, or switching accounts cancels automatic resume.')}</small>
  </section>
}
