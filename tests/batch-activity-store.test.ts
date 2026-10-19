import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AccountRecord, BatchRecipientActivity } from '../src/shared/types'

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const resources: Array<{ directory: string; stores: Set<SqliteStore> }> = []
const cipher: SecretCipher = {
  isAvailable: () => false, backend: () => 'synthetic-fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('bounded batch recipient activity', () => {
  it('starts with only the exact next pending recipient and keeps frozen task names', () => {
    const { store } = fixture()
    const batch = createTask(store, 3)
    const ordered = store.listBatchDeliveries(accountA, batch.id).items
    expect(batch.activity).toEqual({ current: null, lastProcessed: null, lastConfirmed: null,
      nextPending: expected(ordered[0]!, 1), recent: [] })
    expect(store.getActiveBatchSummary(accountA)?.activity).toEqual(batch.activity)
    expect(store.listBatchTasks(accountA).items[0]?.activity).toEqual(batch.activity)
    expect(batch.activity?.nextPending?.friendName).toBe(ordered[0]!.friendName)
    store.replaceFriends(accountA, [{ accountId: accountA, steamId: ordered[0]!.friendSteamId,
      displayName: 'synthetic-renamed-friend', avatarUrl: '', profileUrl: '', onlineState: 'offline',
      syncedAt: new Date().toISOString() }])
    expect(store.getBatchSummary(batch.id)?.activity?.nextPending?.friendName).toBe(ordered[0]!.friendName)
  })

  it('distinguishes processing, confirmed, accepted and uncertain without calling processing sent', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-18T01:00:00.000Z')
    const { store } = fixture()
    const batch = createTask(store, 6)
    const ordered = store.listBatchDeliveries(accountA, batch.id).items
    store.setBatchRunning(batch.id)
    const complete = (status: 'sent_verified' | 'accepted_unverified' | 'failed' | 'uncertain', index: number) => {
      vi.setSystemTime(`2026-10-18T01:00:0${index + 1}.000Z`)
      const delivery = store.takeNextDelivery(batch.id)!
      expect(delivery.id).toBe(ordered[index]!.id)
      store.completeDelivery(delivery.id, status, status === 'sent_verified' ? { remoteCommentId: 'synthetic-confirmed' }
        : { error: 'synthetic-private-error-not-in-activity' })
    }
    complete('sent_verified', 0)
    complete('accepted_unverified', 1)
    complete('failed', 2)
    complete('uncertain', 3)
    const processing = store.takeNextDelivery(batch.id)!
    store.pauseBatch(batch.id)
    const summary = store.getBatchSummary(batch.id)!
    expect(summary.activity).toEqual({
      current: expected(processing, 5),
      lastProcessed: expected({ ...ordered[3]!, status: 'uncertain' }, 4, '2026-10-18T01:00:04.000Z'),
      lastConfirmed: expected({ ...ordered[0]!, status: 'sent_verified', remoteCommentId: 'synthetic-confirmed' },
        1, '2026-10-18T01:00:01.000Z'),
      nextPending: expected(ordered[5]!, 6),
      recent: [
        expected({ ...ordered[3]!, status: 'uncertain' }, 4, '2026-10-18T01:00:04.000Z'),
        expected({ ...ordered[2]!, status: 'failed' }, 3, '2026-10-18T01:00:03.000Z'),
        expected({ ...ordered[1]!, status: 'accepted_unverified' }, 2, '2026-10-18T01:00:02.000Z'),
        expected({ ...ordered[0]!, status: 'sent_verified', remoteCommentId: 'synthetic-confirmed' },
          1, '2026-10-18T01:00:01.000Z')
      ]
    })
    expect(store.getDeliveryRecordById(ordered[2]!.id)?.sentAt).toBeNull()
    expect(store.getDeliveryRecordById(ordered[3]!.id)?.sentAt).toBeNull()
    expect(JSON.stringify(summary.activity)).not.toContain('synthetic-private-error')
    expect(JSON.stringify(summary.activity)).not.toContain('synthetic-private-body')
  })

  it('bounds recent output to five real outcomes beyond the first 50 frozen records in a 1200-person task', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-18T02:00:00.000Z')
    const { store } = fixture()
    const batch = createTask(store, 1200)
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Full history read prohibited') })
    store.setBatchRunning(batch.id)
    const processed: string[] = []
    for (let index = 0; index < 70; index++) {
      vi.setSystemTime(Date.parse('2026-10-18T02:00:00.000Z') + index * 1000)
      const delivery = store.takeNextDelivery(batch.id)!
      processed.push(delivery.id)
      store.completeDelivery(delivery.id, index === 0 ? 'sent_verified' : 'failed',
        index === 0 ? { remoteCommentId: 'synthetic-first-confirmed' } : { error: 'synthetic-failed' })
    }
    store.pauseBatch(batch.id)
    const summary = store.getBatchSummary(batch.id)!
    expect(summary.activity?.recent.map(item => item.deliveryId)).toEqual(processed.slice(-5).reverse())
    expect(summary.activity?.recent.map(item => item.ordinal)).toEqual([70, 69, 68, 67, 66])
    expect(summary.activity?.lastProcessed?.ordinal).toBe(70)
    expect(summary.activity?.lastConfirmed?.ordinal).toBe(1)
    expect(summary.activity?.nextPending?.ordinal).toBe(71)
    expect(summary.activity?.recent.every(item => !('renderedMessage' in item) && !('error' in item))).toBe(true)
    expect(JSON.stringify(summary.activity).length).toBeLessThan(3500)
    expect(store.getBatch).not.toHaveBeenCalled()
    expect(store.listBatchTasks(accountA).items[0]?.activity).toEqual(summary.activity)
  }, 30_000)

  it('limits SQL activity candidates before computing exact ordinals and projects no body or error fields', () => {
    const { store } = fixture()
    const batch = createTask(store, 1001)
    store.setBatchRunning(batch.id)
    for (let index = 0; index < 8; index++) {
      store.completeDelivery(store.takeNextDelivery(batch.id)!.id, 'failed', { error: 'synthetic-private-error' })
    }
    const database = (store as unknown as { db: DatabaseSync }).db
    const statements = vi.spyOn(database, 'prepare')
    const summary = store.getBatchSummary(batch.id)!
    const queries = statements.mock.calls.map(([query]) => String(query))
    const activityQueries = queries.filter(query => query.includes('WITH selected AS MATERIALIZED'))
    expect(activityQueries).toHaveLength(2)
    expect(activityQueries.every(query => /ORDER BY .* LIMIT \?/.test(query))).toBe(true)
    expect(activityQueries.every(query => !query.includes('rendered_message') && !query.includes('d.error'))).toBe(true)
    expect(queries.some(query => /SELECT \* FROM deliveries/i.test(query))).toBe(false)
    expect(summary.activity?.recent).toHaveLength(5)
    expect(summary.activity?.lastProcessed?.ordinal).toBe(8)
  })

  it('does not mislabel cancelled or pending entries as processed, even after cancelling an in-flight task', () => {
    const { store } = fixture()
    const batch = createTask(store, 3)
    store.setBatchRunning(batch.id)
    const processing = store.takeNextDelivery(batch.id)!
    store.cancelBatch(batch.id)
    expect(store.getBatchSummary(batch.id)?.activity).toEqual({ current: expected(processing, 1),
      lastProcessed: null, lastConfirmed: null, nextPending: null, recent: [] })
  })

  it('removes processing activity when proven pre-submit failure returns the recipient to pending', () => {
    const { store } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const processing = store.takeNextDelivery(batch.id)!
    expect(store.getBatchSummary(batch.id)?.activity?.current?.deliveryId).toBe(processing.id)
    store.resetDeliveryToPending(processing.id)
    const activity = store.getBatchSummary(batch.id)?.activity
    expect(activity?.current).toBeNull()
    expect(activity?.nextPending).toEqual(expected({ ...processing, status: 'pending' }, 1))
    expect(activity?.recent).toEqual([])
  })

  it('isolates activity by account and batch even for identical friend IDs', () => {
    const { store } = fixture()
    const first = createTask(store, 1, accountA)
    const other = createTask(store, 1, accountB)
    store.setBatchRunning(other.id)
    store.completeDelivery(store.takeNextDelivery(other.id)!.id, 'sent_verified',
      { remoteCommentId: 'synthetic-other-account-comment' })
    const own = store.listBatchTasks(accountA).items
    expect(own).toHaveLength(1)
    expect(own[0]!.id).toBe(first.id)
    expect(own[0]!.activity?.recent).toEqual([])
    expect(JSON.stringify(own[0]!.activity)).not.toContain('synthetic-other-account-comment')
    expect(store.listBatchTasks(accountB).items[0]?.activity?.lastConfirmed?.remoteCommentId)
      .toBe('synthetic-other-account-comment')
  })

  it('keeps processed time distinct from sent time for interrupted requests on restart', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-18T03:00:00.000Z')
    const { store, reopen } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const processing = store.takeNextDelivery(batch.id)!
    vi.setSystemTime('2026-10-18T03:01:00.000Z')
    const recovered = reopen()
    expect(recovered.getBatchSummary(batch.id)?.activity).toMatchObject({ current: null,
      lastProcessed: { deliveryId: processing.id, status: 'uncertain', ordinal: 1,
        recordedAt: '2026-10-18T03:01:00.000Z' }, lastConfirmed: null })
    expect(recovered.getDeliveryRecordById(processing.id)?.sentAt).toBeNull()
  })

  it('migrates v6 metadata transactionally without inventing a failed send time or changing outcomes', () => {
    const { store, databasePath, reopen } = fixture()
    const batch = createTask(store, 4)
    const deliveries = store.listBatchDeliveries(accountA, batch.id).items
    store.setBatchRunning(batch.id)
    store.pauseBatch(batch.id)
    store.close()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec('ALTER TABLE deliveries DROP COLUMN processed_at; PRAGMA user_version = 6;')
    legacy.prepare("UPDATE batches SET stop_code = 'UNCERTAIN_RESULT', paused_at = ? WHERE id = ?")
      .run('2026-10-17T01:02:03.000Z', batch.id)
    const update = legacy.prepare('UPDATE deliveries SET status = ?, sent_at = ? WHERE id = ?')
    update.run('sent_verified', '2026-10-17T01:00:00.000Z', deliveries[0]!.id)
    update.run('failed', null, deliveries[1]!.id)
    update.run('uncertain', null, deliveries[2]!.id)
    legacy.close()
    const recovered = reopen(true)
    expect(recovered.getBatchSummary(batch.id)?.activity).toMatchObject({
      lastProcessed: { deliveryId: deliveries[2]!.id, status: 'uncertain', recordedAt: '2026-10-17T01:02:03.000Z' },
      lastConfirmed: { deliveryId: deliveries[0]!.id, recordedAt: '2026-10-17T01:00:00.000Z' },
      nextPending: { deliveryId: deliveries[3]!.id, ordinal: 4 }
    })
    expect(recovered.getBatchSummary(batch.id)?.activity?.recent.find(item => item.status === 'failed')?.recordedAt).toBeNull()
    expect(recovered.getDeliveryRecordById(deliveries[2]!.id)?.sentAt).toBeNull()
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
    inspection.close()
    const before = recovered.listBatchDeliveries(accountA, batch.id)
    expect(recovered.getBatchSummary(batch.id)?.activity).toEqual(recovered.getBatchSummary(batch.id)?.activity)
    expect(recovered.listBatchDeliveries(accountA, batch.id)).toEqual(before)
  })

  it('preserves exact created_at/id ordinals when frozen creation timestamps differ', () => {
    const { store, databasePath } = fixture()
    const batch = createTask(store, 3)
    const original = store.listBatchDeliveries(accountA, batch.id).items
    const edit = new DatabaseSync(databasePath)
    edit.prepare('UPDATE deliveries SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', original[2]!.id)
    edit.close()
    store.setBatchRunning(batch.id)
    expect(store.getBatchSummary(batch.id)?.activity?.nextPending).toMatchObject({ deliveryId: original[2]!.id, ordinal: 1 })
    const first = store.takeNextDelivery(batch.id)!
    expect(first.id).toBe(original[2]!.id)
    expect(store.getBatchSummary(batch.id)?.activity?.current?.ordinal).toBe(1)
    expect(store.getBatchSummary(batch.id)?.activity?.nextPending).toMatchObject({ deliveryId: original[0]!.id, ordinal: 2 })
  })
})

function expected(delivery: { id: string; friendSteamId: string; friendName: string; status: BatchRecipientActivity['status'];
  remoteCommentId?: string | null }, ordinal: number, recordedAt: string | null = null): BatchRecipientActivity {
  return { deliveryId: delivery.id, friendSteamId: delivery.friendSteamId, friendName: delivery.friendName,
    status: delivery.status, ordinal, recordedAt, remoteCommentId: delivery.remoteCommentId ?? null }
}

function createTask(store: SqliteStore, count: number, accountId = accountA) {
  return store.createBatchTask(accountId, 'synthetic-template', 100, Array.from({ length: count }, (_, index) => ({
    friendSteamId: String(76561198000001000n + BigInt(index)), friendName: `synthetic-friend-${index}`,
    renderedMessage: `synthetic-private-body-${index}-${'x'.repeat(1000)}`
  })))
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'steam-batch-activity-'))
  const databasePath = join(directory, 'synthetic.sqlite3')
  const stores = new Set<SqliteStore>()
  resources.push({ directory, stores })
  const store = new SqliteStore(databasePath, cipher)
  stores.add(store)
  for (const id of [accountA, accountB]) {
    const account: AccountRecord = { id, steamId: id, accountName: `synthetic-${id}`,
      displayName: `synthetic-account-${id}`, avatarUrl: '', createdAt: '2026-10-17T00:00:00.000Z',
      lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null }
    store.upsertAccount(account)
  }
  return { store, databasePath, reopen: (alreadyClosed = false) => {
    if (!alreadyClosed) store.close()
    stores.delete(store)
    const recovered = new SqliteStore(databasePath, cipher)
    stores.add(recovered)
    return recovered
  } }
}
