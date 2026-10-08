import { useEffect, useState } from 'react'
import { AppSnapshot, BatchRecord, DeliveryStatus } from '../../../shared/types'
import { formatDate, formatDuration } from '../ui'
import { useI18n, type Translate } from '../i18n'

export function HistoryPanel({ snapshot }: { snapshot: AppSnapshot }): React.JSX.Element {
  const { t } = useI18n()
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(snapshot.batches[0]?.id ?? null)

  useEffect(() => {
    if (selectedBatchId && snapshot.batches.some((batch) => batch.id === selectedBatchId)) return
    setSelectedBatchId(snapshot.batches[0]?.id ?? null)
  }, [selectedBatchId, snapshot.batches])

  const selectedBatch = snapshot.batches.find((batch) => batch.id === selectedBatchId) ?? null
  if (snapshot.batches.length === 0) {
    return (
      <section className="card empty-history">
        <div>◷</div>
        <h2>{t('还没有发送记录', 'No delivery history yet')}</h2>
        <p>{t('完成首次留言批次后，每位好友的结果会保存在这里。', 'Results for each friend will appear here after your first comment batch.')}</p>
      </section>
    )
  }

  return (
    <div className="history-layout">
      <section className="card batch-list-card">
        <div className="card-heading">
          <div>
            <h2>{t('发送批次', 'Comment batches')}</h2>
            <p>{t(`当前账号最近 ${snapshot.batches.length} 条记录`, `${snapshot.batches.length} recent batches for this account`)}</p>
          </div>
        </div>
        <div className="batch-list">
          {snapshot.batches.map((batch) => (
            <button
              key={batch.id}
              className={batch.id === selectedBatchId ? 'active' : ''}
              onClick={() => setSelectedBatchId(batch.id)}
            >
              <span className={`batch-status ${batch.status}`} />
              <span>
                <strong>{formatDate(batch.createdAt)}</strong>
                <small>{t(`${batch.total} 位好友`, `${batch.total} friends`)} · {batchStatusLabel(batch, t)}</small>
              </span>
              <b>{batch.succeeded}/{batch.total}</b>
            </button>
          ))}
        </div>
      </section>

      {selectedBatch && <BatchDetails batch={selectedBatch} />}
    </div>
  )
}

function BatchDetails({ batch }: { batch: BatchRecord }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <section className="card batch-details">
      <div className="batch-details-header">
        <div>
          <p className="eyebrow">BATCH {batch.id.slice(0, 8).toUpperCase()}</p>
          <h2>{batchStatusLabel(batch, t)}</h2>
          <span>
            {t('创建于', 'Created')} {formatDate(batch.createdAt)} · {t('基础间隔', 'Interval')} {formatDuration(batch.delayMs)}
          </span>
        </div>
        <div className="batch-score">
          <strong>{batch.succeeded}</strong>
          <span>/ {batch.total} {t('成功', 'successful')}</span>
        </div>
      </div>
      <div className="history-message">
        <small>{t('批次正文快照', 'Saved message template')}</small>
        <p>{batch.messageTemplate}</p>
      </div>
      <div className="delivery-list">
        <div className="delivery-list-head">
          <span>{t('好友', 'Friend')}</span>
          <span>{t('结果', 'Result')}</span>
          <span>{t('留言编号 / 错误', 'Comment ID / Error')}</span>
          <span>{t('时间', 'Time')}</span>
        </div>
        {batch.deliveries.map((delivery) => (
          <div className="delivery-row" key={delivery.id}>
            <span>
              <strong>{delivery.friendName}</strong>
              <small>{delivery.friendSteamId}</small>
            </span>
            <span>
              <i className={`delivery-badge ${delivery.status}`}>
                {deliveryStatusLabel(delivery.status, t)}
              </i>
            </span>
            <span className="delivery-detail">
              {delivery.remoteCommentId ? `#${delivery.remoteCommentId}` : delivery.error ?? '—'}
            </span>
            <span>{formatDate(delivery.sentAt ?? delivery.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function batchStatusLabel(batch: BatchRecord, t: Translate): string {
  if (batch.status === 'completed') return batch.failed ? t('已完成（部分需处理）', 'Completed (needs attention)') : t('已完成', 'Completed')
  if (batch.status === 'cancelled') return t('已取消', 'Cancelled')
  if (batch.status === 'paused') return t('已暂停', 'Paused')
  if (batch.status === 'running') return t('发送中', 'Sending')
  return t('等待发送', 'Queued')
}

function deliveryStatusLabel(status: DeliveryStatus, t: Translate): string {
  switch (status) {
    case 'sent_verified':
      return t('已确认', 'Confirmed')
    case 'accepted_unverified':
      return t('已接受', 'Accepted')
    case 'failed':
      return t('失败', 'Failed')
    case 'uncertain':
      return t('待核对', 'Uncertain')
    case 'cancelled':
      return t('已取消', 'Cancelled')
    case 'sending':
      return t('发送中', 'Sending')
    default:
      return t('等待中', 'Pending')
  }
}
