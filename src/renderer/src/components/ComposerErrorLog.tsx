import { useCallback, useEffect, useRef, useState } from 'react'
import { localizeMessage } from '../../../shared/localization'
import type { BatchDeliveryPage, BatchSummary } from '../../../shared/types'
import { useI18n } from '../i18n'
import { unwrap } from '../ui'
import './composer-error-log.css'

const PAGE_SIZE = 5

interface LogContext {
  scope: string
  token: symbol
  enabled: boolean
  accountId: string
  batchId: string
  failedCount: number
}

interface LogView {
  token: symbol
  offset: number
  page: BatchDeliveryPage | null
  loading: boolean
  failed: boolean
  loadedFailureCount: number
}

export function ComposerErrorLog({ batch, enabled = false }: {
  batch: BatchSummary
  enabled?: boolean
}): React.JSX.Element | null {
  const { language, t } = useI18n()
  const scope = JSON.stringify([batch.accountId, batch.id])
  const context = useRef<LogContext>({ scope, token: Symbol(scope), enabled,
    accountId: batch.accountId, batchId: batch.id, failedCount: batch.failedCount })
  if (context.current.scope !== scope || context.current.enabled !== enabled) {
    context.current = { scope, token: Symbol(scope), enabled, accountId: batch.accountId,
      batchId: batch.id, failedCount: batch.failedCount }
  } else context.current.failedCount = batch.failedCount
  const mounted = useRef(false)
  const inFlight = useRef<symbol | null>(null)
  const queued = useRef<{ token: symbol; offset: number } | null>(null)
  const [view, setView] = useState<LogView | null>(null)
  const request = useCallback(async (offset = 0): Promise<void> => {
    const current = context.current
    if (!mounted.current || !current.enabled) return
    if (inFlight.current) {
      if (inFlight.current !== current.token) {
        queued.current = { token: current.token, offset }
        setView({ token: current.token, offset, page: null, loading: true, failed: false, loadedFailureCount: 0 })
      }
      return
    }
    const isCurrent = (): boolean => mounted.current && context.current.enabled && context.current.token === current.token
    const requestedFailureCount = current.failedCount
    inFlight.current = current.token
    setView(previous => ({ token: current.token, offset,
      page: previous?.token === current.token && previous.offset === offset ? previous.page : null,
      loading: true, failed: false, loadedFailureCount: previous?.token === current.token ? previous.loadedFailureCount : 0 }))
    try {
      const result = unwrap(await window.steamCommenter.listBatchDeliveries(current.accountId, current.batchId,
        { status: 'failed', offset, limit: PAGE_SIZE }))
      if (!isCurrent()) return
      const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0
      const items = result.items.slice(0, PAGE_SIZE).filter(item => item.batchId === current.batchId && item.status === 'failed')
      setView({ token: current.token, offset, page: { items, total, offset, limit: PAGE_SIZE },
        loading: false, failed: false, loadedFailureCount: requestedFailureCount })
    } catch {
      if (isCurrent()) setView({ token: current.token, offset, page: null, loading: false, failed: true,
        loadedFailureCount: requestedFailureCount })
    } finally {
      inFlight.current = null
      const next = queued.current
      queued.current = null
      if (next && mounted.current && context.current.enabled && next.token === context.current.token) void request(next.offset)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; queued.current = null }
  }, [])
  useEffect(() => {
    if (enabled) void request()
    else { queued.current = null; setView(null) }
  }, [scope, enabled, request])

  if (!enabled) return null
  const current = view?.token === context.current.token ? view : null
  const loading = current?.loading ?? true
  const offset = current?.offset ?? 0
  const page = current?.page
  const hasNewErrors = Boolean(current?.page && batch.failedCount > current.loadedFailureCount)
  const displayTime = (value: string | null): string => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(value)) : t('未记录', 'Not recorded')
  return <section className="composer-error-log" aria-label={t('失败与跳过记录', 'Failure and skipped-recipient log')}>
    <div className="composer-error-log-heading">
      <h4>{t('失败与跳过记录', 'Failure and skipped-recipient log')}</h4>
      <button disabled={loading} onClick={() => void request(offset)}>{t('刷新记录', 'Refresh log')}</button>
    </div>
    <p className="composer-error-log-note">{t(`已保存 ${batch.failedCount} 条失败／跳过记录，每页 5 条。`,
      `${batch.failedCount} failure/skipped records saved, five per page.`)} {t('跳过不代表发送成功；完整记录保留在任务明细中。',
      'Skipping does not mean sent. Full records remain in task details.')}</p>
    {hasNewErrors && <p className="composer-error-log-note" role="status">{t('有新增记录，请点“刷新记录”查看；这里不会自动发送或重复处理。',
      'New records are available. Refresh to view them; this log never sends or repeats a delivery.')}</p>}
    {loading ? <p role="status">{t('正在读取保存的失败记录…', 'Reading saved failure records…')}</p>
      : current?.failed ? <p role="alert">{t('暂时无法读取失败记录，请点击刷新重试；不会影响发送任务。',
        'The saved failure log could not be read. Refresh to retry; the sending task is unaffected.')}</p>
        : page && page.items.length > 0 ? <ol className="composer-error-log-list" start={offset + 1}>{page.items.map(item => <li key={item.id}>
          <strong dir="auto">{item.friendName.trim() || t('未记录好友名称', 'Friend name not recorded')}</strong>
          <span>SteamID: <bdi>{item.friendSteamId}</bdi></span>
          <span>{t('记录时间', 'Recorded time')}: {displayTime(batch.activity?.recent.find(record => record.deliveryId === item.id)?.recordedAt ?? item.sentAt)}</span>
          <p dir="auto">{item.error ? localizeMessage(item.error, language) : t('未记录具体原因，请查看任务明细。',
            'No specific reason was saved. Check task details.')}</p>
        </li>)}</ol> : <p>{t('这一页没有失败或跳过记录。', 'No failed or skipped recipients on this page.')}</p>}
    <div className="composer-error-log-pagination">
      <button disabled={loading || offset === 0} onClick={() => void request(Math.max(0, offset - PAGE_SIZE))}>{t('上一页', 'Previous')}</button>
      <span>{t(`第 ${Math.floor(offset / PAGE_SIZE) + 1} 页`, `Page ${Math.floor(offset / PAGE_SIZE) + 1}`)} · {page?.total ?? batch.failedCount} {t('条', 'records')}</span>
      <button disabled={loading || !page || offset + PAGE_SIZE >= page.total} onClick={() => void request(offset + PAGE_SIZE)}>{t('下一页', 'Next')}</button>
    </div>
  </section>
}
