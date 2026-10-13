import type { AppSnapshot, BatchSummary } from '../../shared/types'

export function createSnapshotRefresh<T>(load: () => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void): {
  refresh(): Promise<void>
  dispose(): void
} {
  let pending = false
  let stopped = false
  let flight: Promise<void> | null = null

  const pump = async (): Promise<void> => {
    do {
      pending = false
      try {
        const value = await load()
        if (!stopped && !pending) apply(value)
      } catch (error) {
        if (!stopped && !pending) fail(error)
      }
    } while (pending && !stopped)
  }

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    pending = true
    if (!flight) flight = pump().finally(() => {
      flight = null
      if (pending && !stopped) void refresh()
    })
    return flight
  }
  return { refresh, dispose: () => { stopped = true; pending = false } }
}

export function applyBatchProgress(snapshot: AppSnapshot, batchId: string, summary: BatchSummary | null): AppSnapshot {
  if (summary && summary.accountId !== snapshot.activeAccountId) return snapshot
  if (!summary && !snapshot.batches.some(batch => batch.id === batchId) && snapshot.activeBatch?.id !== batchId) return snapshot
  const recent = snapshot.batches.filter(batch => batch.id !== batchId)
  const batches = summary ? [summary, ...recent].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) : recent
  const active = summary && ['queued', 'running', 'paused'].includes(summary.status)
  return { ...snapshot, batches,
    activeBatch: active ? summary : snapshot.activeBatch?.id === batchId ? null : snapshot.activeBatch }
}

export interface BatchProgressUpdate { revision: number; batchId: string; summary: BatchSummary | null }

export function applyProgressUpdates(snapshot: AppSnapshot, updates: Iterable<BatchProgressUpdate>, loadedRevision: number): AppSnapshot {
  let next = snapshot
  for (const update of updates) {
    if (update.revision > loadedRevision) next = applyBatchProgress(next, update.batchId, update.summary)
  }
  return next
}
