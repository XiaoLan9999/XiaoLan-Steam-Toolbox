import type { BatchRecipientActivity, BatchSummary, DeliveryStatus } from '../../../shared/types'
import { useI18n, type Translate } from '../i18n'
import './batch-activity.css'

function deliveryLabel(recipient: BatchRecipientActivity, t: Translate): string {
  const labels: Record<DeliveryStatus, string> = {
    pending: t('尚未发送', 'Not sent yet'),
    sending: t('正在处理（准备/提交中）', 'Processing (preparing/submitting)'),
    sent_verified: recipient.remoteCommentId
      ? t('已确认送达', 'Delivery confirmed')
      : t('已核验（未记录留言编号）', 'Verified (comment ID not recorded)'),
    accepted_unverified: t('Steam 已接受，尚未确认送达', 'Accepted by Steam; delivery not confirmed'),
    failed: t('失败（任务记录）', 'Failed (task record)'),
    uncertain: t('无法确认是否发出，不会自动重发', 'Delivery unknown; never retried automatically'),
    cancelled: t('已取消', 'Cancelled')
  }
  return labels[recipient.status]
}

function Recipient({ value, compact = false }: { value: BatchRecipientActivity; compact?: boolean }): React.JSX.Element {
  const { language, t } = useI18n()
  const recordedAt = value.recordedAt && Number.isFinite(Date.parse(value.recordedAt)) ? value.recordedAt : null
  const ordinal = Number.isSafeInteger(value.ordinal) && value.ordinal > 0 ? value.ordinal : null
  return <div className={`batch-activity-recipient result-${value.status}`}>
    <div className="batch-activity-person">
      <strong dir="auto">{value.friendName.trim() ? value.friendName : t('未记录好友名称', 'Friend name not recorded')}</strong>
      {!compact && ordinal !== null && <small className="batch-activity-ordinal">{t(`第 ${ordinal} 位`, `Recipient ${ordinal}`)}</small>}
    </div>
    <span className="batch-activity-steam-id">SteamID: <bdi>{value.friendSteamId}</bdi></span>
    <strong className="batch-activity-result">{deliveryLabel(value, t)}</strong>
    {(!compact || value.remoteCommentId) && <div className="batch-activity-record">
      {!compact && <span>{t('记录时间', 'Recorded at')}: {recordedAt
        ? <time dateTime={recordedAt}>{new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(new Date(recordedAt))}</time>
        : t('未记录', 'Not recorded')}</span>}
      <span>{t('留言编号', 'Comment ID')}: {value.remoteCommentId ? <bdi>#{value.remoteCommentId}</bdi> : t('未记录', 'Not recorded')}</span>
    </div>}
  </div>
}

export function BatchActivityPanel({ batch, compact = false }: { batch: BatchSummary; compact?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const activity = batch.activity
  const current = activity?.current ?? null
  const noInFlight = Boolean(activity) && !current && batch.sending === 0
  const recent = activity?.recent.slice(0, 5) ?? []
  const emptyCurrent = batch.sending > 0
    ? t('存在处理中的记录，好友信息尚未提供，请刷新任务明细。', 'A recipient is being processed, but their details are missing. Refresh task details.')
    : batch.status === 'paused'
      ? t('本任务无在途发送。', 'No delivery is in flight for this task.')
      : batch.status === 'queued'
        ? t('尚未开始处理。', 'Processing has not started.')
        : t('当前没有正在处理的好友。', 'No friend is currently being processed.')
  const slots = activity ? [
    { key: 'current', title: t('当前处理好友', 'Current recipient'), value: current, empty: emptyCurrent },
    { key: 'last-processed', title: t('最近处理结果', 'Latest processed result'), value: activity.lastProcessed,
      empty: t('尚无已处理记录。', 'No processed result recorded yet.') },
    { key: 'last-confirmed', title: t('上次已确认送达', 'Last confirmed delivery'), value: activity.lastConfirmed,
      empty: batch.sentVerified > 0
        ? t('最近确认对象的信息尚未提供，请刷新任务明细。', 'Last confirmed recipient details are missing. Refresh task details.')
        : t('尚无已确认送达记录。', 'No confirmed delivery recorded yet.') },
    { key: 'next-pending', title: t('下一位待发', 'Next pending recipient'), value: activity.nextPending,
      empty: batch.pending > 0
        ? t('待发对象的信息尚未提供，请刷新任务明细。', 'Pending recipient details are missing. Refresh task details.')
        : t('没有待发对象。', 'No pending recipients.') }
  ] : []

  return <section className={`batch-activity${compact ? ' compact' : ''}`} aria-label={t('逐好友发送进度', 'Per-friend delivery progress')}>
    <div className="batch-activity-heading"><h4>{t('发到哪位了？', 'Who is the task sending to?')}</h4>
      <span>{t('逐好友投递记录', 'Per-friend delivery records')}</span></div>
    {!activity ? <p className="batch-activity-missing" role="status">{t(
      '尚无逐好友状态，请刷新任务明细；不能据此判断留言已经发出。',
      'Per-friend status is not available. Refresh task details; this does not establish that a comment was sent.')}</p>
      : <>
        <p className="batch-activity-overview" role="status">{current?.status === 'sending'
          ? t('正在处理不代表已发出，请以下方投递结果为准。', 'Processing does not mean sent. Check the delivery result below.')
          : noInFlight && batch.status === 'paused'
            ? t('任务已暂停，本任务无在途发送。', 'Task paused. No delivery is in flight for this task.')
            : t('查看当前对象、最近结果和下一位队列位置。', 'Check the current recipient, latest result, and next queue position.')}</p>
        <div className="batch-activity-slots">{slots.map(slot => <section className={`batch-activity-slot slot-${slot.key}`} key={slot.key}
          aria-label={slot.title}>
          <h5>{slot.title}</h5>
          {slot.value ? <Recipient value={slot.value} compact={compact} /> : <p className="batch-activity-empty">{slot.empty}</p>}
          {slot.key === 'next-pending' && slot.value && <p className="batch-activity-next-note">{t(
            '此对象尚未发送；这里只展示队列位置，不会触发发送。',
            'This recipient has not been sent a comment. Showing their queue position does not trigger sending.')}</p>}
        </section>)}</div>
        <details className="batch-activity-recent" aria-label={t('最近 5 条处理记录', 'Five most recent processed records')}>
          <summary>{t('最近处理记录（最多 5 条）', 'Recent processed records (up to 5)')}</summary>
          {recent.length > 0 ? <ol>{recent.map((value, index) => <li key={`${value.deliveryId}-${index}`}>
            <Recipient value={value} />
          </li>)}</ol> : <p className="batch-activity-empty">{t('尚无最近处理记录。', 'No recent processed records yet.')}</p>}
        </details>
      </>}
    <p className="batch-activity-technical-note">{t('HTTP 状态与冷却属于技术信息，不能单独证明留言是否发出。',
      'HTTP status and cooldown are technical details, not proof of whether a comment was sent.')}</p>
  </section>
}
