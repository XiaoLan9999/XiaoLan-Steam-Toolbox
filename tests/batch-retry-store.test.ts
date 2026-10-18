import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore, type DeliverySeed, type SecretCipher } from '../src/main/store'
import type { AccountRecord, BatchPauseDetails } from '../src/shared/types'

const accountId = '76561198000000001'
const resources: Array<{ directory: string; stores: Set<SqliteStore> }> = []
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'test',
  encrypt: value => Buffer.from(`encrypted:${value}`),
  decrypt: value => value.toString().replace(/^encrypted:/, '')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('durable batch stop reasons and bounded retry state', () => {
  it('enables retry on new tasks by default and preserves an explicit opt-out', () => {
    const { store } = fixture()
    const enabled = store.createBatchTask(accountId, 'Hello', 100, recipients(2))
    const disabled = store.createBatchTask(accountId, 'Hello', 100, recipients(2), false)
    expect(enabled).toMatchObject({ autoRetryEnabled: true, stopCode: null, stopMessage: null,
      pausedAt: null, nextRetryAt: null, retryCount: 0, pending: 2 })
    expect(disabled.autoRetryEnabled).toBe(false)
    for (const value of [null, 0, 'true']) {
      expectCode(() => store.createBatchTask(accountId, 'Hello', 100, recipients(1), value as unknown as boolean),
        'INVALID_AUTO_RETRY')
    }
    expect(store.listBatchTasks(accountId).total).toBe(2)
  })

  it('propagates stop metadata through bounded summaries and pages without reading delivery bodies', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Frozen template', 100, recipients(4))
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Unexpected full read') })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T02:00:00.000Z'))
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, { code: 'RATE_LIMITED', message: 'Steam returned HTTP 429',
      nextRetryAt: '2026-10-16T02:01:00.000Z', retryCount: 1 })
    const expected = { status: 'paused', total: 4, pending: 4, completed: 0,
      autoRetryEnabled: true, stopCode: 'RATE_LIMITED', stopMessage: 'Steam returned HTTP 429',
      pausedAt: '2026-10-16T02:00:00.000Z', nextRetryAt: '2026-10-16T02:01:00.000Z', retryCount: 1 }
    expect(store.getBatchSummary(task.id)).toMatchObject(expected)
    expect(store.getActiveBatchSummary(accountId)).toMatchObject(expected)
    expect(store.getRecentBatchSummaries(accountId)[0]).toMatchObject(expected)
    expect(store.listBatchTasks(accountId, { status: 'paused' }).items[0]).toMatchObject(expected)
    expect(store.listBatchDeliveries(accountId, task.id).items).toHaveLength(4)
    expect(store.listBatchDeliveries(accountId, task.id).items[0]).not.toHaveProperty('renderedMessage')
  })

  it('clears only the deadline on resume and resets consecutive retries only on explicit progress', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(1))
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, retryStop())
    const paused = store.getBatchSummary(task.id)!
    store.setBatchRunning(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', nextRetryAt: null,
      retryCount: 2, stopCode: paused.stopCode, stopMessage: paused.stopMessage, pausedAt: paused.pausedAt })
    store.clearBatchRetryCount(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ retryCount: 0, stopCode: paused.stopCode })
  })

  it('lets a manual pause revoke an automatic plan and rejects late automatic stops', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(2))
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, retryStop())
    store.pauseBatch(task.id)
    const manual = store.getBatchSummary(task.id)!
    expect(manual).toMatchObject({ status: 'paused', stopCode: 'MANUAL_PAUSE',
      nextRetryAt: null, retryCount: 0, pending: 2 })
    expectCode(() => store.pauseBatch(task.id, retryStop()), 'BATCH_NOT_PAUSABLE')
    expect(store.getBatchSummary(task.id)).toEqual(manual)
    store.pauseBatch(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ stopCode: 'MANUAL_PAUSE', nextRetryAt: null })
  })

  it('updates an automatic wait without rewriting the queue, and does not arm a disabled task', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(2))
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, retryStop())
    const deliveries = store.listBatchDeliveries(accountId, task.id)
    store.pauseBatch(task.id, { ...retryStop(), code: 'ACCESS_DENIED', retryCount: 3 })
    expect(store.getBatchSummary(task.id)).toMatchObject({ stopCode: 'ACCESS_DENIED', retryCount: 3 })
    store.setBatchAutoRetry(task.id, false)
    expect(store.getBatchSummary(task.id)).toMatchObject({ autoRetryEnabled: false, nextRetryAt: null,
      stopCode: 'ACCESS_DENIED', retryCount: 3 })
    expectCode(() => store.pauseBatch(task.id, retryStop()), 'BATCH_AUTO_RETRY_DISABLED')
    store.setBatchAutoRetry(task.id, true)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', autoRetryEnabled: true, nextRetryAt: null })
    expect(store.listBatchDeliveries(accountId, task.id)).toEqual(deliveries)
  })

  it('cancels a scheduled task durably and cannot be revived by a late stop or resume', () => {
    const { store, reopen } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(3))
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, retryStop())
    store.cancelBatch(task.id)
    const cancelled = store.getBatchSummary(task.id)!
    expect(cancelled).toMatchObject({ status: 'cancelled', nextRetryAt: null, stopCode: 'CANCELLED',
      pending: 0, cancelled: 3, completed: 3 })
    expectCode(() => store.pauseBatch(task.id, retryStop()), 'BATCH_NOT_PAUSABLE')
    expectCode(() => store.setBatchRunning(task.id), 'BATCH_NOT_RESUMABLE')
    expect(reopen().getBatchSummary(task.id)).toEqual(cancelled)
  })

  it('clears a retry deadline on completion but retains the last reason for inspection', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(1))
    store.setBatchRunning(task.id)
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'failed', { error: 'Permanent refusal' })
    store.pauseBatch(task.id, retryStop())
    expect(store.finishBatchIfDone(task.id)).toBe(true)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', nextRetryAt: null,
      stopCode: 'RATE_LIMITED', completed: 1, failedCount: 1 })
    expectCode(() => store.pauseBatch(task.id, retryStop()), 'BATCH_NOT_PAUSABLE')
  })

  it('never recreates pending work when cancellation happens during session preparation', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(3))
    store.setBatchRunning(task.id)
    const confirmed = store.takeNextDelivery(task.id)!
    store.completeDelivery(confirmed.id, 'sent_verified', { remoteCommentId: 'already-sent' })
    const preparing = store.takeNextDelivery(task.id)!
    store.cancelBatch(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ sending: 1, cancelled: 1, sentVerified: 1 })
    store.resetDeliveryToPending(preparing.id)
    store.resetDeliveryToPending(confirmed.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'cancelled', pending: 0,
      sending: 0, cancelled: 2, sentVerified: 1, completed: 3, succeeded: 1, failed: 0 })
    expect(store.getDeliveryRecordById(preparing.id)).toMatchObject({ status: 'cancelled', error: '用户取消' })
    expect(store.getDeliveryRecordById(confirmed.id)).toMatchObject({ status: 'sent_verified', remoteCommentId: 'already-sent' })
  })

  it('restores an unsubmitted item to pending during a pause but never touches uncertain or accepted results', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(4))
    store.setBatchRunning(task.id)
    const uncertain = store.takeNextDelivery(task.id)!
    store.completeDelivery(uncertain.id, 'uncertain', { error: 'POST response lost' })
    const accepted = store.takeNextDelivery(task.id)!
    store.completeDelivery(accepted.id, 'accepted_unverified')
    const preparing = store.takeNextDelivery(task.id)!
    store.pauseBatch(task.id, retryStop())
    store.resetDeliveryToPending(preparing.id)
    store.resetDeliveryToPending(uncertain.id)
    store.resetDeliveryToPending(accepted.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 2, sending: 0,
      completed: 2, uncertain: 1, acceptedUnverified: 1, nextRetryAt: retryStop().nextRetryAt })
    expect(store.getDeliveryRecordById(uncertain.id)).toMatchObject({ status: 'uncertain', error: 'POST response lost' })
    expect(store.getDeliveryRecordById(accepted.id)?.status).toBe('accepted_unverified')
    store.setBatchRunning(task.id)
    const next = store.takeNextDelivery(task.id)!
    expect([uncertain.id, accepted.id]).not.toContain(next.id)
  })

  it('requires explicit continuation after a restart and preserves all delivery outcomes', () => {
    const { store, reopen } = fixture()
    const task = store.createBatchTask(accountId, 'Frozen template', 100, recipients(6))
    store.setBatchRunning(task.id)
    const confirmed = store.takeNextDelivery(task.id)!
    store.completeDelivery(confirmed.id, 'sent_verified', { remoteCommentId: 'kept' })
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'accepted_unverified')
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'failed', { error: 'Permanent refusal' })
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'uncertain', { error: 'POST response lost' })
    const interrupted = store.takeNextDelivery(task.id)!
    store.pauseBatch(task.id, retryStop())
    const recovered = reopen()
    expect(recovered.getBatchSummary(task.id)).toMatchObject({ status: 'paused', nextRetryAt: null,
      autoRetryEnabled: true, stopCode: 'APP_RESTARTED', retryCount: 2,
      pending: 1, sending: 0, sentVerified: 1, acceptedUnverified: 1, failedCount: 1, uncertain: 2 })
    expect(recovered.getBatchSummary(task.id)?.stopMessage).toContain('Steam returned HTTP 429')
    expect(recovered.takeNextDelivery(task.id)).toBeNull()
    expect(recovered.getDeliveryRecordById(interrupted.id)?.status).toBe('uncertain')
    expect(recovered.getDeliveryRecordById(confirmed.id)).toMatchObject({ status: 'sent_verified', remoteCommentId: 'kept' })
  })

  it('migrates a version 4 database with automatic retries disabled and delivery history unchanged', () => {
    const data = fixture()
    const task = data.store.createBatchTask(accountId, 'Frozen v4 template', 5_000, recipients(2))
    data.store.setBatchRunning(task.id)
    const confirmed = data.store.takeNextDelivery(task.id)!
    data.store.completeDelivery(confirmed.id, 'sent_verified', { remoteCommentId: 'v4-confirmed' })
    data.store.pauseBatch(task.id)
    const before = data.store.listBatchDeliveries(accountId, task.id)
    data.close()
    const database = new DatabaseSync(data.databasePath)
    try {
      for (const column of ['auto_retry_enabled', 'stop_code', 'stop_message', 'paused_at', 'next_retry_at', 'retry_count']) {
        database.exec(`ALTER TABLE batches DROP COLUMN ${column}`)
      }
      database.exec('PRAGMA user_version = 4;')
    } finally { database.close() }
    const migrated = data.reopen()
    expect(migrated.getBatchSummary(task.id)).toMatchObject({ status: 'paused', autoRetryEnabled: false,
      stopCode: 'APP_RESTARTED', retryCount: 0, nextRetryAt: null, messageTemplate: 'Frozen v4 template',
      total: 2, completed: 1, sentVerified: 1, pending: 1 })
    expect(migrated.listBatchDeliveries(accountId, task.id)).toEqual(before)
    const inspection = new DatabaseSync(data.databasePath)
    try { expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 }) }
    finally { inspection.close() }
  })

  it('tolerates older migration fixtures that retain new columns while downgrading user_version', () => {
    const data = fixture()
    const task = data.store.createBatchTask(accountId, 'Hello', 100, recipients(1))
    data.close()
    const database = new DatabaseSync(data.databasePath)
    database.exec('PRAGMA user_version = 3;')
    database.close()
    expect(data.reopen().getBatchSummary(task.id)).toMatchObject({ status: 'paused', autoRetryEnabled: true })
  })

  it('validates retry settings and stop metadata atomically', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountId, 'Hello', 100, recipients(1))
    store.setBatchRunning(task.id)
    const original = store.getBatchSummary(task.id)
    for (const value of [null, 0, 'true', {}]) {
      expectCode(() => store.setBatchAutoRetry(task.id, value as boolean), 'INVALID_AUTO_RETRY')
    }
    for (const value of [
      null, {}, { code: 'BAD', message: 'Bad' }, { code: 'RATE_LIMITED', message: '' },
      { code: 'RATE_LIMITED', message: 'x'.repeat(1001) },
      { ...retryStop(), nextRetryAt: 'not-a-date' }, { ...retryStop(), nextRetryAt: 123 },
      { ...retryStop(), retryCount: -1 }, { ...retryStop(), retryCount: 0.5 },
      { ...retryStop(), retryCount: Infinity }, { ...retryStop(), retryCount: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expectCode(() => store.pauseBatch(task.id, value as BatchPauseDetails), 'INVALID_BATCH_STOP')
      expect(store.getBatchSummary(task.id)).toEqual(original)
    }
    expectCode(() => store.setBatchAutoRetry('missing', true), 'BATCH_NOT_FOUND')
    expectCode(() => store.clearBatchRetryCount('missing'), 'BATCH_NOT_FOUND')
  })
})

function retryStop(): BatchPauseDetails {
  return { code: 'RATE_LIMITED', message: 'Steam returned HTTP 429',
    nextRetryAt: '2026-10-16T05:00:00.000Z', retryCount: 2 }
}

function recipients(count: number): DeliverySeed[] {
  return Array.from({ length: count }, (_, index) => ({
    friendSteamId: String(76561198001000000n + BigInt(index)),
    friendName: `Friend ${index}`, renderedMessage: `Frozen message ${index}`
  }))
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ name: 'DomainError', code }))
}

function fixture(): {
  store: SqliteStore; databasePath: string; close(): void; reopen(): SqliteStore
} {
  const directory = mkdtempSync(join(tmpdir(), 'steam-batch-retry-store-'))
  const databasePath = join(directory, 'fixture.sqlite3')
  const stores = new Set<SqliteStore>()
  resources.push({ directory, stores })
  let current: SqliteStore | null = new SqliteStore(databasePath, cipher)
  stores.add(current)
  const account: AccountRecord = { id: accountId, steamId: accountId, accountName: 'fixture',
    displayName: 'Fixture', avatarUrl: '', createdAt: '2026-10-16T00:00:00.000Z',
    lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null }
  current.upsertAccount(account)
  const close = (): void => {
    if (!current) return
    current.close()
    stores.delete(current)
    current = null
  }
  return { store: current, databasePath, close, reopen: () => {
    close()
    current = new SqliteStore(databasePath, cipher)
    stores.add(current)
    return current
  } }
}
