import { useEffect, useRef, useState } from 'react'
import { COMMENT_POST_UNCERTAIN_MESSAGE, LEGACY_COMMENT_POST_REVIEW_MESSAGE, MAX_ACCESS_DENIED_RETRIES, MAX_BATCH_RETRIES } from '../../../shared/batch-retry-policy'
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

export function batchCooldownActive(batch: BatchSummary, now = Date.now()): boolean {
  return ['queued', 'running', 'paused'].includes(batch.status) && Boolean(batch.accessDeniedUntil)
    && Date.parse(batch.accessDeniedUntil!) > now
}

export function useBatchCooldownActive(batch: BatchSummary): boolean {
  const [, tick] = useState(0)
  const active = batchCooldownActive(batch)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [batch.id, batch.accessDeniedUntil, active])
  return active
}

export function batchStopLabel(code: BatchStopCode | null, t: Translate): string {
  if (!code) return t('没有保存停止原因', 'No stop reason was saved')
  const labels: Record<BatchStopCode, string> = {
    MANUAL_PAUSE: t('用户手动暂停', 'Paused by the user'),
    RATE_LIMITED: t('Steam 频率限制', 'Steam rate limit'),
    ACCESS_DENIED: t('Steam 拒绝访问（HTTP 403）', 'Steam denied access (HTTP 403)'),
    ACCESS_DENIED_PERSISTENT: t('Steam 持续拒绝访问（HTTP 403）', 'Steam repeatedly denied access (HTTP 403)'),
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
    DELIVERY_FAILED: t('按所选策略在失败后暂停', 'Paused after failure by the selected policy'),
    CANCELLED: t('用户取消任务', 'Cancelled by the user')
  }
  return labels[code] ?? t('任务已停止', 'The task stopped')
}

function stopSource(code: BatchStopCode | null, t: Translate): string {
  if (code === 'MANUAL_PAUSE' || code === 'CANCELLED') return t('用户操作', 'User action')
  if (code === 'RATE_LIMITED' || code === 'ACCESS_DENIED' || code === 'ACCESS_DENIED_PERSISTENT' || code === 'SERVER_ERROR') return t('Steam 响应', 'Steam response')
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_PREPARATION' || code === 'LOGIN_REQUIRED'
    || code === 'SESSION_CHANGED' || code === 'ACCOUNT_CHANGED') return t('账号与会话', 'Account and session')
  if (code === 'APP_RESTARTED' || code === 'APP_SHUTDOWN') return t('软件生命周期', 'App lifecycle')
  if (code === 'NETWORK_ERROR') return t('网络连接', 'Network connection')
  if (code === 'UNCERTAIN_RESULT') return t('发送结果保护', 'Delivery safety check')
  if (code === 'DELIVERY_FAILED') return t('用户选择的处理策略', 'Selected failure policy')
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
  const [, tick] = useState(0)
  const now = Date.now()
  const [acting, setActing] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const currentBatchId = useRef(batch.id)
  currentBatchId.current = batch.id
  const active = ['queued', 'running', 'paused'].includes(batch.status)
  const verifying = batch.verification?.state === 'checking' || batch.verification?.state === 'waiting'
  const uncertainPolicy = batch.failurePolicy?.uncertainResult ?? 'verify_then_skip'
  const accessDeniedCount = Number.isSafeInteger(batch.accessDeniedCount) && batch.accessDeniedCount! > 0
    ? batch.accessDeniedCount! : 0
  const unresolvedPost = (batch.stopCode === 'UNCERTAIN_RESULT' && !batch.nextRetryAt) ||
    (batch.uncertain > 0 && [COMMENT_POST_UNCERTAIN_MESSAGE, LEGACY_COMMENT_POST_REVIEW_MESSAGE]
      .some(message => batch.stopMessage?.includes(message)))
  const currentAccessDenied = batch.status === 'paused' && !unresolvedPost &&
    (batch.stopCode === 'ACCESS_DENIED' || batch.stopCode === 'ACCESS_DENIED_PERSISTENT')
  const persistentAccessDenied = currentAccessDenied &&
    (batch.stopCode === 'ACCESS_DENIED_PERSISTENT' || accessDeniedCount > MAX_ACCESS_DENIED_RETRIES)
  const accessDeniedUntil = batch.accessDeniedUntil && Number.isFinite(Date.parse(batch.accessDeniedUntil))
    ? batch.accessDeniedUntil : null
  const accessCooldown = useBatchCooldownActive(batch)
  const hasAccessHistory = accessDeniedCount > 0 || accessDeniedUntil !== null
  const historicalAccessStop = batch.status !== 'paused' &&
    (batch.stopCode === 'ACCESS_DENIED' || batch.stopCode === 'ACCESS_DENIED_PERSISTENT')
  const showStopHistory = Boolean(batch.stopMessage) && (unresolvedPost || historicalAccessStop ||
    (!currentAccessDenied && hasAccessHistory && /\b403\b/.test(batch.stopMessage!)))
  const canResume = authenticated && !otherTaskActive && !disabled && !accessCooldown && batch.status === 'paused' && batch.pending > 0
  const resumeAllowed = useRef(canResume)
  resumeAllowed.current = canResume
  const scheduled = batch.status === 'paused' && batch.autoRetryEnabled && Boolean(batch.nextRetryAt)
    && Number.isFinite(Date.parse(batch.nextRetryAt!)) && !persistentAccessDenied && !unresolvedPost

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!scheduled || accessCooldown) return
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [batch.id, batch.nextRetryAt, accessDeniedUntil, scheduled, accessCooldown])

  const perform = async (enabled: boolean, resume = false): Promise<void> => {
    if (lock.current || !mounted.current || disabled || !active || (resume && !canResume)) return
    if (resume && !window.confirm(t(
      `开启自动重试并继续此任务？仅发送剩余 ${batch.pending} 位待发好友；已确认、已接受和待核对对象不会重发。一般临时错误最多自动重试 ${MAX_BATCH_RETRIES} 次，实际冷却限制仍然有效。`,
      `Enable automatic retries and resume this task? Only ${batch.pending} pending recipients will be sent. Confirmed, accepted, and uncertain deliveries will not be retried. Temporary errors allow up to ${MAX_BATCH_RETRIES} automatic retries; any active cooldown still applies.`))) return
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
  if (verifying) {
    recoveryStatus = batch.status === 'completed'
      ? t('正在有限次只读核对已结束任务中的记录，不会重发，也不会启动新发送。',
        'Saved records in this ended task are receiving bounded read-only checks. Nothing will be resent and no new sending will start.')
      : t('正在有限次只读核对好友主页，不会重发本条；核对结束后只继续其余待发，发送冷却仍有效。手动暂停或切号会停止继续。',
        'Bounded read-only profile verification is in progress. This comment will not be resent. Only other pending recipients resume afterward, subject to sending cooldown. A manual pause or account switch stops continuation.')
  } else if (active && batch.status === 'paused' && unresolvedPost) {
    recoveryStatus = uncertainPolicy === 'verify_then_pause'
      ? t('本对象可能已经送达。按所选策略，核对后仍未确认时保持暂停，不重发；可手动再次核对或调整此任务策略。',
        'This recipient may already have received the comment. The selected policy keeps the task paused if verification is inconclusive. It is never resent; check again or change this task’s policy.')
      : uncertainPolicy === 'skip'
        ? t('本对象保留待核对且不会重发。按所选策略直接跳过；仍可手动只读核对，继续仅处理其余待发。',
          'This recipient stays uncertain and will not be resent. The selected policy skips it; manual read-only checking remains available and continuation handles only other pending recipients.')
        : t('本对象已列入待核对，可能已经送达。会自动只读核对；找到可靠证据才标记成功。未确定的保留待核对并跳过，不重复发送，也不阻塞其余待发。可选择“核对并继续其余待发”。',
          'This recipient needs review and may already have received the comment. Verification is read-only; reliable evidence is required to confirm success. Unproven results stay for review and are skipped, never resent, without blocking other pending recipients. Choose “Verify and resume remaining pending”.')
  } else if (active && batch.status === 'paused' && !scheduled && batch.stopCode === 'LOGIN_REQUIRED') {
    recoveryStatus = t('需要重新登录此账号，再手动继续原任务；不会自动扫码。', 'Sign in to this account again, then resume the original task manually. QR sign-in is never automatic.')
  } else if (active && batch.status === 'paused' && persistentAccessDenied) {
    recoveryStatus = t('连续收到 HTTP 403，已停止自动继续。当前对象和剩余对象仍待发，未判定为好友权限问题。',
      'Repeated HTTP 403 responses stopped automatic continuation. The current and remaining recipients stay pending; a friend permission problem has not been established.')
  } else if (active && batch.status === 'paused' && !scheduled && batch.stopCode === 'RETRY_EXHAUSTED') {
    recoveryStatus = t('已达到自动重试上限，请检查停止原因后手动继续。', 'The automatic retry limit was reached. Check the stop reason before resuming manually.')
  }

  const planStatus = verifying ? t('本轮核对完成后仅继续其余待发，未确认的本条保留待核对并跳过；原有发送冷却仍有效。',
    'After these checks, only other pending recipients resume. Unproven records remain for review and are skipped. Existing sending cooldown still applies.')
    : scheduled ? t('有自动继续计划；倒计时结束后仅处理剩余待发。',
    'Automatic resume is scheduled; only pending recipients will resume when the countdown ends.')
    : t('当前没有自动继续计划。勾选“启用”仅设置重试策略，不代表已安排继续。',
      'No automatic resume is scheduled. “Enabled” is a retry preference, not a scheduled resume.')

  return <section className={`batch-recovery${scheduled ? ' scheduled' : ''}`} aria-label={t('停止原因与自动重试', 'Stop reason and automatic retries')}>
    {!historicalAccessStop && (batch.status === 'paused' || batch.status === 'cancelled' || batch.stopCode) && <div className="batch-stop-reason" role="status">
      <small>{batch.status === 'paused' ? t('本次暂停原因', 'Why this task paused') : t('最近停止原因', 'Last stop reason')}</small>
      <strong>{batch.status === 'paused' && unresolvedPost
        ? t('需核对送达结果', 'Delivery result needs review') : batchStopLabel(batch.stopCode, t)}</strong>
      {batch.status === 'paused' && unresolvedPost && <p>{accessCooldown
        ? t('本条需要核对是否送达，不会自动重发；其余待发仍需等待下方冷却结束。',
          'This delivery needs review and will not be resent automatically. Other pending recipients must still wait for the cooldown below.')
        : uncertainPolicy === 'verify_then_pause' ? t('这不是仍在等待冷却：本条送达尚未确认，按你的策略保持暂停，不会重发。',
          'This is not a wait for cooldown: delivery is unconfirmed and your selected policy keeps the task paused. It will not be resent.')
          : uncertainPolicy === 'skip' ? t('本条保留待核对，按策略跳过，不重发。旧冷却已结束不代表此条已失败或已送达。',
            'This record stays uncertain and is skipped without resending. An expired cooldown proves neither failure nor delivery.')
            : t('这不是仍在等待冷却：该条可能已经送达，尚未确认。会自动只读核对；未确定保留待核对并跳过，不重复发送，也不阻塞其余待发。',
              'This is not a wait for cooldown: the comment may already have arrived, but delivery is not confirmed. Read-only checks verify it; unproven results remain for review and are skipped, never resent, without blocking other pending recipients.')}</p>}
      {batch.stopMessage && !showStopHistory && <p>{localizeMessage(batch.stopMessage, language)}</p>}
      <span>{t('来源', 'Source')}: {stopSource(batch.stopCode, t)} · {timestamp(batch.pausedAt, language)}</span>
    </div>}
    {accessCooldown && <div className="batch-access-denied" aria-label={t('尚未结束的发送冷却', 'Active sending cooldown')}>
      <strong>{t(unresolvedPost ? '其余待发仍有冷却限制' : '发送冷却尚未结束',
        unresolvedPost ? 'Other pending recipients remain under cooldown' : 'Sending cooldown is still active')}</strong>
      <p className="batch-access-cooldown"><strong>{t('距离冷却结束', 'Cooldown remaining')}: {retryCountdown(accessDeniedUntil!, now)}</strong>
        <span>{t('最早可继续时间', 'Earliest resume time')}: {timestamp(accessDeniedUntil, language)}</span>
        <span>{t('冷却仅限制最早继续时间，不代表已安排自动继续；关闭自动重试或重启不会清除冷却。',
          'Cooldown only limits the earliest resume time; it is not an automatic resume plan. Disabling retries or restarting does not clear it.')}</span></p>
    </div>}
    {(hasAccessHistory || showStopHistory || historicalAccessStop) && <details className="batch-recovery-history">
      <summary>{t('历史技术详情（不是当前送达状态）', 'Technical history (not the current delivery status)')}</summary>
      {historicalAccessStop && <p>{t('最近停止原因', 'Last stop reason')}: {batchStopLabel(batch.stopCode, t)} · {timestamp(batch.pausedAt, language)}</p>}
      {accessDeniedCount > 0 && <p>{t(`已记录 HTTP 403 响应：${accessDeniedCount} 次（历史计数）`,
        `Recorded HTTP 403 responses: ${accessDeniedCount} (historical count)`)}</p>}
      {accessDeniedUntil && <p>{Date.parse(accessDeniedUntil) > now ? t('记录的冷却截止', 'Recorded cooldown deadline')
        : t('上次冷却已结束', 'Previous cooldown has ended')}: {timestamp(accessDeniedUntil, language)}</p>}
      {showStopHistory && <p>{t('保存的停止信息', 'Saved stop detail')}: {localizeMessage(batch.stopMessage!, language)}</p>}
      {currentAccessDenied && <p>{t(`HTTP 403 仅在冷却后自动重试 ${MAX_ACCESS_DENIED_RETRIES} 次；再次拒绝将停止自动继续。该计数独立于一般临时故障的重试次数。`,
        `HTTP 403 allows only ${MAX_ACCESS_DENIED_RETRIES} automatic retry after cooldown. Another denial stops automatic continuation. Its response count is separate from retries for other temporary errors.`)}</p>}
      {hasAccessHistory && <p>{t('HTTP 403 不能单独证明登录失效，也不能单独证明留言未送达。历史计数不会覆盖当前暂停原因；不会因此重发已确认或待核对的留言。',
        'HTTP 403 alone proves neither expired sign-in nor failed delivery. Historical counts do not override the current pause reason or cause confirmed or uncertain comments to be resent.')}</p>}
    </details>}
    <div className="batch-retry-heading"><strong>{t('自动重试', 'Automatic retries')}</strong>
      {active && <label><input type="checkbox" checked={Boolean(batch.autoRetryEnabled)} disabled={disabled || acting}
        onChange={(event) => void perform(event.target.checked)} />{t('启用', 'Enabled')}</label>}
    </div>
    <p className="batch-retry-state" role="status">{recoveryStatus}</p>
    {batch.status === 'paused' && <p className="batch-retry-plan">{planStatus}</p>}
    {batch.retryCount > 0 && batch.stopCode !== 'ACCESS_DENIED' && !persistentAccessDenied && <p className="batch-retry-attempt">{t(
      `第 ${batch.retryCount} / ${MAX_BATCH_RETRIES} 次自动重试${scheduled ? '（待执行）' : '（最近记录）'}`,
      `Automatic retry ${batch.retryCount} / ${MAX_BATCH_RETRIES}${scheduled ? ' (scheduled)' : ' (last recorded)'}`)}</p>}
    {scheduled && batch.nextRetryAt && <div className="batch-retry-deadline">
      <span>{t('距离自动继续', 'Automatic resume in')}</span>
      <strong aria-live="off">{retryCountdown(batch.nextRetryAt, now)}</strong>
      <small>{t('下次重试', 'Next retry')}: {timestamp(batch.nextRetryAt, language)}</small>
      <button className="ghost" disabled={disabled || acting} onClick={() => void perform(false)}>{t('停止自动重试', 'Stop automatic retries')}</button>
    </div>}
    {active && batch.status === 'paused' && batch.uncertain === 0 && !batch.autoRetryEnabled && <button className="ghost batch-enable-retry"
      disabled={acting || !canResume} onClick={() => void perform(true, true)}>{t('开启自动重试并继续待发', 'Enable retries and resume pending')}</button>}
    <small className="batch-retry-safety">{t('仅处理剩余待发对象；已发送、已接受和结果不确定的对象不会自动重发。手动暂停、退出或切换账号会取消自动继续计划。',
      'Only pending recipients resume. Sent, accepted, and uncertain results are never retried. Pausing manually, closing the app, or switching accounts cancels automatic resume.')}</small>
  </section>
}
