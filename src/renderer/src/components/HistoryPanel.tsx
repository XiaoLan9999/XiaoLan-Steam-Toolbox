import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSnapshot, BatchDeliveryPage, BatchStatus, BatchSummary, BatchTaskPage, DeliveryStatus
} from '../../../shared/types'
import { unwrap } from '../ui'
import { useI18n, type Translate } from '../i18n'
import type { RunAction } from './types'

const TASK_PAGE_SIZE = 25
const DELIVERY_PAGE_SIZE = 50
const DELIVERY_STATUSES: DeliveryStatus[] = [
  'pending', 'sending', 'sent_verified', 'accepted_unverified', 'failed', 'uncertain', 'cancelled'
]

interface PageRequest<T> {
  key: string
  generation: number
  load: () => Promise<T>
  start: () => void
  success: (value: T) => void
  failure: (error: unknown) => void
  finish: () => void
}

// One active request and one replaceable refresh, including across page/account changes.
export class TaskPageRequests<T> {
  private key = ''
  private generation = 0
  private busy = false
  private disposed = false
  private pending: PageRequest<T> | null = null

  setKey(key: string): void {
    if (this.key === key) return
    this.key = key
    this.generation++
    this.pending = null
  }

  activate(): void { this.disposed = false }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.pending = null
  }

  request(key: string, callbacks: Omit<PageRequest<T>, 'key' | 'generation'>): void {
    this.setKey(key)
    if (this.disposed) return
    this.pending = { ...callbacks, key, generation: this.generation }
    void this.pump()
  }

  private current(request: PageRequest<T>): boolean {
    return !this.disposed && request.key === this.key && request.generation === this.generation
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.pending && !this.disposed) {
        const request = this.pending
        this.pending = null
        if (!this.current(request)) continue
        request.start()
        try {
          const value = await request.load()
          if (this.current(request)) request.success(value)
        } catch (error) {
          if (this.current(request)) request.failure(error)
        } finally {
          if (this.current(request)) request.finish()
        }
      }
    } finally {
      this.busy = false
    }
  }
}

interface PageState<T> {
  key: string
  data: T
  loading: boolean
  loaded: boolean
  error: string
}

function useTaskPage<T>(key: string, seed: T, load: () => Promise<T>, revision: string): PageState<T> & { retry(): void } {
  const requests = useRef<TaskPageRequests<T> | null>(null)
  if (!requests.current) requests.current = new TaskPageRequests<T>()
  const coordinator = requests.current
  coordinator.setKey(key)
  const [state, setState] = useState<PageState<T>>({ key, data: seed, loading: true, loaded: false, error: '' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    coordinator.activate()
    return () => coordinator.dispose()
  }, [coordinator])

  useEffect(() => {
    coordinator.request(key, {
      load,
      start: () => setState((previous) => previous.key === key
        ? { ...previous, loading: true, error: '' }
        : { key, data: seed, loading: true, loaded: false, error: '' }),
      success: (data) => setState({ key, data, loading: true, loaded: true, error: '' }),
      failure: (error) => setState((previous) => ({
        ...(previous.key === key ? previous : { key, data: seed, loaded: false }),
        loading: true, error: error instanceof Error ? error.message : String(error)
      })),
      finish: () => setState((previous) => previous.key === key ? { ...previous, loading: false } : previous)
    })
  }, [coordinator, key, load, revision, retry])

  const visible = state.key === key ? state : { key, data: seed, loading: true, loaded: false, error: '' }
  return { ...visible, retry: () => setRetry((value) => value + 1) }
}

export function HistoryPanel({ snapshot, runAction }: { snapshot: AppSnapshot; runAction: RunAction }): React.JSX.Element {
  const { t } = useI18n()
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)
  if (!account) return <section className="card empty-history"><h2>{t('请先选择账号', 'Select an account first')}</h2></section>
  return <AccountTasks key={account.id} snapshot={snapshot} runAction={runAction} />
}

function AccountTasks({ snapshot, runAction }: { snapshot: AppSnapshot; runAction: RunAction }): React.JSX.Element {
  const { language, t } = useI18n()
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)!
  const accountBatches = snapshot.batches.filter((batch) => batch.accountId === account.id)
  const activeBatch = snapshot.activeBatch?.accountId === account.id ? snapshot.activeBatch : null
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<BatchStatus | 'all'>('all')
  const [selected, setSelected] = useState<BatchSummary | null>(activeBatch ?? accountBatches[0] ?? null)
  const seed: BatchTaskPage = {
    items: offset === 0 ? accountBatches.filter((batch) => status === 'all' || batch.status === status).slice(0, TASK_PAGE_SIZE) : [],
    total: accountBatches.length, offset, limit: TASK_PAGE_SIZE
  }
  const load = useCallback(async (): Promise<BatchTaskPage> => {
    const page = unwrap(await window.steamCommenter.listBatchTasks(account.id, {
      offset, limit: TASK_PAGE_SIZE, ...(status === 'all' ? {} : { status })
    }))
    return { ...page, items: page.items.slice(0, TASK_PAGE_SIZE) }
  }, [account.id, offset, status])
  const revision = accountBatches.map(batchRevision).join('|') + (activeBatch ? batchRevision(activeBatch) : '')
  const tasks = useTaskPage(`${account.id}:${offset}:${status}`, seed, load, revision)

  useEffect(() => {
    if (!selected && tasks.data.items[0]) setSelected(tasks.data.items[0])
  }, [selected, tasks.data.items])

  const selectedBatch = selected && (accountBatches.find((item) => item.id === selected.id)
    ?? tasks.data.items.find((item) => item.id === selected.id) ?? selected)
  const dates = (value: string | null): string => taskDate(value, language)

  return (
    <div className="history-layout task-center">
      <section className="card batch-list-card">
        <div className="card-heading">
          <div>
            <h2>{t('持久任务列表', 'Saved task list')}</h2>
            <p>{t('本地数据库中的全部任务，每页 25 条', 'All locally saved tasks, 25 per page')}</p>
          </div>
          <button className="ghost" disabled={tasks.loading} onClick={tasks.retry}>{t('刷新', 'Refresh')}</button>
        </div>
        <div className="task-list-filter">
          <label>{t('任务状态', 'Task status')}
            <select value={status} onChange={(event) => { setStatus(event.target.value as BatchStatus | 'all'); setOffset(0) }}>
              <option value="all">{t('全部任务', 'All tasks')}</option>
              {(['queued', 'running', 'paused', 'completed', 'cancelled'] as const).map((value) =>
                <option key={value} value={value}>{batchStatusLabel(value, t)}</option>)}
            </select>
          </label>
        </div>
        <PageFeedback loading={tasks.loading} error={tasks.error} retry={tasks.retry} />
        <div className="batch-list">
          {tasks.data.items.map((batch) => (
            <button key={batch.id} className={batch.id === selectedBatch?.id ? 'active' : ''}
              aria-pressed={batch.id === selectedBatch?.id} onClick={() => setSelected(batch)}>
              <span className={`batch-status ${batch.status}`} />
              <span>
                <strong>{dates(batch.createdAt)}</strong>
                <small>{batchStatusLabel(batch.status, t)} · {t('完成', 'Done')} {batch.completed}/{batch.total}</small>
                {batch.uncertain > 0 && <small className="task-uncertain-text">{t('待核对', 'Uncertain')} {batch.uncertain}</small>}
              </span>
              <b>{batch.pending} {t('待发', 'pending')}</b>
            </button>
          ))}
          {!tasks.loading && !tasks.error && tasks.data.items.length === 0 &&
            <p className="task-empty">{t('此页没有任务。', 'No tasks on this page.')}</p>}
        </div>
        <TaskPagination page={tasks.data} loading={tasks.loading} loaded={tasks.loaded} onChange={setOffset} />
      </section>
      {selectedBatch ? <TaskDetails key={selectedBatch.id} batch={selectedBatch} accountName={account.displayName}
        authenticated={account.sessionState === 'authenticated'}
        otherTaskActive={Boolean(activeBatch && activeBatch.id !== selectedBatch.id)}
        runAction={runAction} />
        : <section className="card empty-history task-empty-card">
          <h2>{t('还没有发送任务', 'No delivery tasks yet')}</h2>
          <p>{t('创建任务后会先保存全部收件人；关闭或异常退出后仍能查看进度。',
            'All recipients are saved when a task is created. Its progress remains available after closing or a crash.')}</p>
        </section>}
    </div>
  )
}

export function TaskDetails({ batch, accountName, authenticated, otherTaskActive = false, runAction }: {
  batch: BatchSummary
  accountName: string
  authenticated: boolean
  otherTaskActive?: boolean
  runAction: RunAction
}): React.JSX.Element {
  const { language, t } = useI18n()
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<DeliveryStatus | 'all'>('all')
  const [acting, setActing] = useState(false)
  const actionLock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const seed: BatchDeliveryPage = { items: [], total: status === 'all' ? batch.total : statusCount(batch, status), offset, limit: DELIVERY_PAGE_SIZE }
  const load = useCallback(async (): Promise<BatchDeliveryPage> => {
    const page = unwrap(await window.steamCommenter.listBatchDeliveries(batch.accountId, batch.id, {
      offset, limit: DELIVERY_PAGE_SIZE, ...(status === 'all' ? {} : { status })
    }))
    return { ...page, items: page.items.slice(0, DELIVERY_PAGE_SIZE) }
  }, [batch.accountId, batch.id, offset, status])
  const rows = useTaskPage(`${batch.accountId}:${batch.id}:${offset}:${status}`, seed, load, batchRevision(batch))
  const active = ['queued', 'running', 'paused'].includes(batch.status)
  const perform = async (kind: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    if (actionLock.current || !mounted.current) return
    if (kind === 'resume' && (!authenticated || batch.pending === 0 || otherTaskActive)) return
    if (kind === 'resume' && !window.confirm(t(
      `确认使用账号“${accountName}”继续此任务？仅发送剩余 ${batch.pending} 位待发好友；${batch.uncertain} 条待核对记录不会自动重发。`,
      `Resume this task with account "${accountName}"? Only ${batch.pending} pending recipients will be sent. ${batch.uncertain} uncertain results will NOT be retried.`))) return
    if (kind === 'cancel' && !window.confirm(t(
      `取消剩余 ${batch.pending} 位好友的发送？已发送记录会保留，当前请求若已提交则无法撤回。`,
      `Cancel ${batch.pending} remaining deliveries? Existing records are retained. A submitted request cannot be recalled.`))) return
    actionLock.current = true
    setActing(true)
    try {
      await runAction(kind === 'pause' ? t('正在暂停任务', 'Pausing task')
        : kind === 'resume' ? t('正在继续任务', 'Resuming task') : t('正在取消任务', 'Cancelling task'), async () => {
        if (!mounted.current) return
        const result = kind === 'pause' ? await window.steamCommenter.pauseBatch(batch.id)
          : kind === 'resume' ? await window.steamCommenter.resumeBatch(batch.id)
            : await window.steamCommenter.cancelBatch(batch.id)
        unwrap(result)
      })
      if (mounted.current) rows.retry()
    } finally {
      actionLock.current = false
      if (mounted.current) setActing(false)
    }
  }

  return (
    <section className="card batch-details task-details">
      <div className="batch-details-header">
        <div>
          <p className="eyebrow">TASK {batch.id.slice(0, 8).toUpperCase()}</p>
          <h2>{batchStatusLabel(batch.status, t)}</h2>
          <span>{accountName} · {t('间隔', 'Interval')} {batch.delayMs / 1000} {t('秒', 'sec')}</span>
        </div>
        <div className="batch-score"><strong>{batch.completed}</strong><span>/ {batch.total} {t('已完成', 'done')}</span></div>
      </div>
      <dl className="task-timestamps">
        <div><dt>{t('创建', 'Created')}</dt><dd>{taskDate(batch.createdAt, language)}</dd></div>
        <div><dt>{t('开始', 'Started')}</dt><dd>{taskDate(batch.startedAt, language)}</dd></div>
        <div><dt>{t('结束', 'Finished')}</dt><dd>{taskDate(batch.finishedAt, language)}</dd></div>
      </dl>
      <div className="progress-track task-progress"><i style={{ width: `${batch.total ? Math.round(batch.completed / batch.total * 100) : 0}%` }} /></div>
      <div className="task-status-counts">
        {DELIVERY_STATUSES.map((value) => <button key={value} className={`delivery-badge ${value}${status === value ? ' active' : ''}`}
          onClick={() => { setStatus(value); setOffset(0) }}>
          {deliveryStatusLabel(value, t)} <strong>{statusCount(batch, value)}</strong>
        </button>)}
      </div>
      {batch.uncertain > 0 && <div className="inline-warning task-uncertain-note" role="status">
        <strong>{t(`${batch.uncertain} 条结果待核对，不会自动重发。`, `${batch.uncertain} uncertain results will NOT be automatically retried.`)}</strong>
        <span>{t('请求可能已到达 Steam。请先核对好友主页，避免重复留言；继续只处理待发记录。',
          'A request may have reached Steam. Check the friend profile to avoid duplicates; Resume only processes pending records.')}</span>
      </div>}
      {!authenticated && <p className="task-offline-note">{t('账号未登录：可查看保存记录，登录此账号后才能继续发送。',
        'Account offline: saved records remain available. Sign in to this account to resume sending.')}</p>}
      {otherTaskActive && active && <p className="task-offline-note">{t('当前账号有其他未结束任务，请先处理或取消该任务。',
        'Another unfinished task exists for this account. Finish or cancel it first.')}</p>}
      {active && <div className="batch-controls task-controls">
        {(batch.status === 'running' || batch.status === 'queued') && <button disabled={acting} onClick={() => void perform('pause')}>{t('暂停任务', 'Pause task')}</button>}
        {batch.status === 'paused' && <button className="primary" disabled={acting || !authenticated || batch.pending === 0 || otherTaskActive}
          onClick={() => void perform('resume')}>{t('继续待发', 'Resume pending')}</button>}
        <button className="danger-text" disabled={acting} onClick={() => void perform('cancel')}>{t('取消任务', 'Cancel task')}</button>
      </div>}
      <div className="history-message"><small>{t('任务正文快照', 'Saved message template')}</small><p>{batch.messageTemplate}</p></div>
      <div className="task-delivery-toolbar">
        <label>{t('好友发送状态', 'Delivery status')}
          <select value={status} onChange={(event) => { setStatus(event.target.value as DeliveryStatus | 'all'); setOffset(0) }}>
            <option value="all">{t('全部状态', 'All statuses')}</option>
            {DELIVERY_STATUSES.map((value) => <option key={value} value={value}>{deliveryStatusLabel(value, t)}</option>)}
          </select>
        </label>
        <button className="ghost" disabled={rows.loading} onClick={rows.retry}>{t('刷新明细', 'Refresh details')}</button>
      </div>
      <PageFeedback loading={rows.loading} error={rows.error} retry={rows.retry} />
      <div className="delivery-list task-delivery-list">
        <div className="delivery-list-head"><span>{t('好友', 'Friend')}</span><span>{t('结果', 'Result')}</span>
          <span>{t('留言编号 / 错误', 'Comment ID / Error')}</span><span>{t('时间', 'Time')}</span></div>
        {rows.data.items.map((delivery) => <div className={`delivery-row ${delivery.status}`} key={delivery.id}>
          <span><strong>{delivery.friendName}</strong><small>{delivery.friendSteamId}</small></span>
          <span><i className={`delivery-badge ${delivery.status}`}>{deliveryStatusLabel(delivery.status, t)}</i></span>
          <span className="delivery-detail" title={delivery.error ?? undefined}>
            {delivery.remoteCommentId ? `#${delivery.remoteCommentId}` : delivery.error ?? '-'}
          </span>
          <span>{taskDate(delivery.sentAt ?? delivery.createdAt, language)}</span>
        </div>)}
        {!rows.loading && !rows.error && rows.data.items.length === 0 &&
          <p className="task-empty">{t('此筛选下没有发送记录。', 'No deliveries match this filter.')}</p>}
      </div>
      <TaskPagination page={rows.data} loading={rows.loading} loaded={rows.loaded} onChange={setOffset} />
    </section>
  )
}

function PageFeedback({ loading, error, retry }: { loading: boolean; error: string; retry(): void }): React.JSX.Element | null {
  const { t } = useI18n()
  if (error) return <div className="task-page-feedback error" role="alert"><span>{error}</span>
    <button onClick={retry}>{t('重试', 'Retry')}</button></div>
  return loading ? <p className="task-page-feedback" role="status">{t('正在读取本地记录...', 'Loading local records...')}</p> : null
}

export function TaskPagination({ page, loading, loaded, onChange }: {
  page: { total: number; offset: number; limit: number }; loading: boolean; loaded: boolean; onChange(offset: number): void
}): React.JSX.Element {
  const { t } = useI18n()
  return <div className="task-pagination">
    <button disabled={loading || page.offset === 0} onClick={() => onChange(Math.max(0, page.offset - page.limit))}>{t('上一页', 'Previous')}</button>
    <span>{t(`第 ${Math.floor(page.offset / page.limit) + 1} 页`, `Page ${Math.floor(page.offset / page.limit) + 1}`)}
      {' · '}{loaded ? t(`共 ${page.total} 条`, `${page.total} total`) : t('读取总数中', 'Counting')}
      {' · '}{t(`每页 ${page.limit} 条`, `${page.limit} per page`)}</span>
    <button disabled={loading || !loaded || page.offset + page.limit >= page.total} onClick={() => onChange(page.offset + page.limit)}>{t('下一页', 'Next')}</button>
  </div>
}

function batchRevision(batch: BatchSummary): string {
  return [batch.id, batch.status, batch.completed, batch.pending, batch.sending, batch.sentVerified,
    batch.acceptedUnverified, batch.failedCount, batch.uncertain, batch.cancelled, batch.startedAt, batch.finishedAt].join(':')
}

function statusCount(batch: BatchSummary, status: DeliveryStatus): number {
  const counts: Record<DeliveryStatus, number> = {
    pending: batch.pending, sending: batch.sending, sent_verified: batch.sentVerified,
    accepted_unverified: batch.acceptedUnverified, failed: batch.failedCount, uncertain: batch.uncertain, cancelled: batch.cancelled
  }
  return counts[status]
}

function taskDate(value: string | null, language: string): string {
  if (!value) return language === 'en' ? 'Not yet' : '尚未'
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value))
}

function batchStatusLabel(status: BatchStatus, t: Translate): string {
  return ({ queued: t('等待发送', 'Queued'), running: t('发送中', 'Sending'), paused: t('已暂停', 'Paused'),
    completed: t('已完成', 'Completed'), cancelled: t('已取消', 'Cancelled') })[status]
}

function deliveryStatusLabel(status: DeliveryStatus, t: Translate): string {
  return ({ pending: t('待发', 'Pending'), sending: t('发送中', 'Sending'), sent_verified: t('已确认', 'Confirmed'),
    accepted_unverified: t('已接受未核验', 'Accepted, unverified'), failed: t('失败', 'Failed'),
    uncertain: t('待核对', 'Uncertain'), cancelled: t('已取消', 'Cancelled') })[status]
}
