import { describe, expect, it, vi } from 'vitest'
import { applyBatchProgress, applyProgressUpdates, createSnapshotRefresh } from '../src/renderer/src/snapshot-refresh'
import type { AppSnapshot, BatchSummary } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('single-flight snapshot refresh', () => {
  it('coalesces 72000 events to one in-flight request and one latest follow-up', async () => {
    const first = deferred<number>()
    const second = deferred<number>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const apply = vi.fn()
    const refresh = createSnapshotRefresh<number>(load, apply, vi.fn())
    const flight = refresh.refresh()
    for (let index = 0; index < 72_000; index += 1) expect(refresh.refresh()).toBe(flight)
    expect(load).toHaveBeenCalledTimes(1)
    first.resolve(1)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    expect(apply).not.toHaveBeenCalled()
    second.resolve(2)
    await flight
    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
    refresh.dispose()
  })

  it('discards late results after unmount and makes further refreshes no-ops', async () => {
    const result = deferred<number>()
    const load = vi.fn(() => result.promise)
    const apply = vi.fn()
    const fail = vi.fn()
    const refresh = createSnapshotRefresh(load, apply, fail)
    const flight = refresh.refresh()
    refresh.dispose()
    result.resolve(1)
    await flight
    await refresh.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('reports a current failure once and can retry without accumulating work', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('fixture failed')).mockResolvedValueOnce(2)
    const apply = vi.fn()
    const fail = vi.fn()
    const refresh = createSnapshotRefresh<number>(load, apply, fail)
    await refresh.refresh()
    expect(fail).toHaveBeenCalledTimes(1)
    await refresh.refresh()
    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
    refresh.dispose()
  })
})

describe('lightweight task progress reconciliation', () => {
  const task = (accountId: string, completed = 0): BatchSummary => ({
    id: 'fixture-task', accountId, messageTemplate: 'fixture message', delayMs: 100,
    status: 'paused', total: 1200, completed, succeeded: completed, failed: 0,
    createdAt: '2026-10-13T00:00:00.000Z', startedAt: null, finishedAt: null,
    pending: 1200 - completed, sending: 0, sentVerified: completed,
    acceptedUnverified: 0, failedCount: 0, uncertain: 0, cancelled: 0,
    autoRetryEnabled: false, stopCode: null, stopMessage: null, pausedAt: null, nextRetryAt: null, retryCount: 0
  })
  const snapshot = (accountId: string): AppSnapshot => ({ activeAccountId: accountId, batches: [], activeBatch: null } as unknown as AppSnapshot)

  it('preserves a newer paused task event when loading the first snapshot or switching accounts', () => {
    const incoming = { ...snapshot('B'), batches: [task('B', 1)], activeBatch: task('B', 1) }
    const next = applyProgressUpdates(incoming, [{ revision: 2, batchId: 'fixture-task', summary: task('B', 44) }], 1)
    expect(next.activeBatch).toMatchObject({ status: 'paused', completed: 44, pending: 1156 })
    expect(next.batches).toHaveLength(1)
    expect(next.batches[0]?.completed).toBe(44)
    expect(JSON.stringify(next)).not.toContain('deliveries')
  })

  it('does not apply stale, unrelated-account, or unknown-null task events', () => {
    const state = snapshot('A')
    expect(applyProgressUpdates(state, [{ revision: 1, batchId: 'fixture-task', summary: task('A', 10) }], 1)).toBe(state)
    expect(applyBatchProgress(state, 'fixture-task', task('B', 10))).toBe(state)
    expect(applyBatchProgress(state, 'unknown-task', null)).toBe(state)
  })

  it('clears active tasks on completion without discarding saved history', () => {
    const state = { ...snapshot('A'), batches: [task('A', 44)], activeBatch: task('A', 44) }
    const next = applyBatchProgress(state, 'fixture-task', { ...task('A', 1200), status: 'completed', pending: 0 })
    expect(next.activeBatch).toBeNull()
    expect(next.batches[0]).toMatchObject({ status: 'completed', completed: 1200 })
  })

  it('preserves recipient activity from a newer event even when aggregate counts have not changed', () => {
    const recipient = { deliveryId: 'current-recipient', friendSteamId: '76561198000000002', friendName: 'New recipient',
      ordinal: 466, status: 'sending' as const, recordedAt: null, remoteCommentId: null }
    const before = task('A', 465)
    const updated = { ...before, activity: { current: recipient, lastProcessed: null, lastConfirmed: null,
      nextPending: null, recent: [] } }
    const state = { ...snapshot('A'), batches: [before], activeBatch: before }
    const result = applyProgressUpdates(state, [{ revision: 2, batchId: before.id, summary: updated }], 1)
    expect(result.activeBatch?.activity?.current).toEqual(recipient)
    expect(result.batches[0]?.activity?.current?.friendName).toBe('New recipient')
    expect(result.activeBatch?.completed).toBe(465)
    expect(JSON.stringify(result)).not.toContain('renderedMessage')
  })
})
