import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import type { AccountRecord, BatchDeliveryListOptions, BatchTaskListOptions } from '../src/shared/types'
import { SqliteStore, type DeliverySeed, type SecretCipher } from '../src/main/store'

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const resources: Array<{ directory: string; stores: Set<SqliteStore> }> = []
const cipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/, '')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('persistent task summaries and bounded delivery pages', () => {
  it('keeps 10000 frozen deliveries durable without loading their bodies into summaries or pages', () => {
    const { store, reopen } = fixture()
    const legacyRead = vi.spyOn(store, 'getBatch').mockImplementation(() => {
      throw new Error('Full-batch reads must not run on the task path')
    })
    const seeds = recipients(10_000)
    const task = store.createBatchTask(accountA, 'Frozen task template', 100, seeds)
    expect(task).toMatchObject({ total: 10_000, pending: 10_000, sending: 0, completed: 0 })
    expect(task).not.toHaveProperty('deliveries')
    expect(store.getBatchSummary(task.id)).toEqual(task)
    expect(store.getActiveBatchSummary(accountA)).toEqual(task)
    expect(store.getRecentBatchSummaries(accountA)).toEqual([task])
    expect(store.listBatchTasks(accountA)).toMatchObject({ total: 1, offset: 0, limit: 25, items: [task] })

    const seen = new Set<string>()
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = store.listBatchDeliveries(accountA, task.id, { offset, limit: 100 })
      expect(page).toMatchObject({ total: 10_000, offset, limit: 100 })
      expect(page.items).toHaveLength(100)
      for (const item of page.items) {
        expect(item).not.toHaveProperty('renderedMessage')
        seen.add(item.friendSteamId)
      }
    }
    expect(seen).toEqual(new Set(seeds.map((seed) => seed.friendSteamId)))
    expect(store.listBatchDeliveries(accountA, task.id, { offset: 10_000 }).items).toEqual([])
    const firstPage = store.listBatchDeliveries(accountA, task.id)
    expect(firstPage.limit).toBe(50)
    expect(firstPage.items).toHaveLength(50)
    expect(store.getDeliveryRecordById(firstPage.items[0]!.id)?.renderedMessage).toHaveLength(1000)
    expect(legacyRead).not.toHaveBeenCalled()

    const recovered = reopen()
    expect(recovered.getBatchSummary(task.id)).toMatchObject({ status: 'paused', total: 10_000, pending: 10_000 })
    expect(recovered.listBatchDeliveries(accountA, task.id)).toEqual(firstPage)
    expect(recovered.getDeliveryRecordById(firstPage.items[0]!.id)?.renderedMessage).toHaveLength(1000)
  }, 90_000)

  it('pages every historical task beyond the old 20-task window with deterministic ordering and status filters', () => {
    const { store } = fixture()
    const tasks = Array.from({ length: 61 }, (_, index) => {
      const task = store.createBatchTask(accountA, `Task ${index}`, 100, recipients(1))
      if (index % 2 === 0) {
        store.setBatchRunning(task.id)
        store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'sent_verified', { remoteCommentId: `comment-${index}` })
        store.finishBatchIfDone(task.id)
      }
      return store.getBatchSummary(task.id)!
    })
    store.createBatchTask(accountB, 'Other account', 100, recipients(1))
    const expectedOrder = tasks.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const first = store.listBatchTasks(accountA)
    const second = store.listBatchTasks(accountA, { offset: 25 })
    const third = store.listBatchTasks(accountA, { offset: 50 })
    expect(first).toMatchObject({ total: 61, offset: 0, limit: 25 })
    expect([...first.items, ...second.items, ...third.items]).toEqual(expectedOrder)
    expect(third.items).toHaveLength(11)
    expect(store.listBatchTasks(accountA, { offset: 61 }).items).toEqual([])
    const completed = store.listBatchTasks(accountA, { status: 'completed', limit: 50 })
    expect(completed.total).toBe(31)
    expect(completed.items.every((task) => task.status === 'completed')).toBe(true)
    expect(store.listBatchTasks(accountB).total).toBe(1)
  }, 60_000)

  it('separates confirmed, accepted, failed, uncertain, sending and pending counts and recovers only unfinished requests', () => {
    const { store, reopen } = fixture()
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Unexpected full read') })
    const task = store.createBatchTask(accountA, 'Hello', 100, recipients(7))
    store.setBatchRunning(task.id)
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'sent_verified', { remoteCommentId: 'confirmed' })
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'accepted_unverified')
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'failed', { error: 'Comments disabled' })
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'uncertain', { error: 'Network result uncertain' })
    const interrupted = store.takeNextDelivery(task.id)!
    expect(store.getBatchSummary(task.id)).toMatchObject({
      status: 'running', total: 7, completed: 4, succeeded: 2, failed: 2,
      pending: 2, sending: 1, sentVerified: 1, acceptedUnverified: 1,
      failedCount: 1, uncertain: 1, cancelled: 0
    })
    expect(store.listBatchDeliveries(accountA, task.id, { status: 'uncertain' })).toMatchObject({ total: 1, items: [{ status: 'uncertain' }] })
    expect(store.listBatchDeliveries(accountA, task.id, { status: 'pending' }).total).toBe(2)

    const recovered = reopen()
    expect(recovered.getBatchSummary(task.id)).toMatchObject({
      status: 'paused', total: 7, completed: 5, succeeded: 2, failed: 3,
      pending: 2, sending: 0, sentVerified: 1, acceptedUnverified: 1,
      failedCount: 1, uncertain: 2, cancelled: 0
    })
    expect(recovered.getDeliveryRecordById(interrupted.id)).toMatchObject({ status: 'uncertain', error: expect.stringContaining('避免重复留言') })
    const retained = recovered.listBatchDeliveries(accountA, task.id, { status: 'uncertain' }).items
    recovered.setBatchRunning(task.id)
    while (true) {
      const pending = recovered.takeNextDelivery(task.id)
      if (!pending) break
      expect(retained.map((item) => item.id)).not.toContain(pending.id)
      recovered.completeDelivery(pending.id, 'sent_verified')
    }
    recovered.finishBatchIfDone(task.id)
    expect(recovered.listBatchDeliveries(accountA, task.id, { status: 'uncertain' }).items).toEqual(retained)
    expect(recovered.getBatchSummary(task.id)).toMatchObject({ status: 'completed', completed: 7, succeeded: 4, failed: 3 })
  })

  it('preserves cancelled tasks and fixes their aggregate after an in-flight request was interrupted', () => {
    const { store, reopen } = fixture()
    const task = store.createBatchTask(accountA, 'Hello', 100, recipients(3))
    store.setBatchRunning(task.id)
    const interrupted = store.takeNextDelivery(task.id)!
    store.cancelBatch(task.id)
    const cancelled = store.getBatchSummary(task.id)!
    expect(cancelled).toMatchObject({ status: 'cancelled', completed: 2, cancelled: 2, sending: 1 })
    const recovered = reopen()
    expect(recovered.getBatchSummary(task.id)).toMatchObject({
      status: 'cancelled', completed: 3, failed: 1, failedCount: 0, uncertain: 1,
      cancelled: 2, sending: 0, pending: 0, finishedAt: cancelled.finishedAt
    })
    expect(recovered.getDeliveryRecordById(interrupted.id)?.status).toBe('uncertain')
    expect(recovered.getActiveBatchSummary(accountA)).toBeNull()
    expectErrorCode(() => recovered.setBatchRunning(task.id), 'BATCH_NOT_RESUMABLE')
  })

  it('rejects unknown accounts, missing batches and cross-account task details', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountA, 'Hello', 100, recipients(1))
    expectErrorCode(() => store.listBatchTasks('missing-account'), 'ACCOUNT_NOT_FOUND')
    expectErrorCode(() => store.listBatchDeliveries('missing-account', task.id), 'ACCOUNT_NOT_FOUND')
    expectErrorCode(() => store.listBatchDeliveries(accountB, task.id), 'BATCH_ACCOUNT_MISMATCH')
    expectErrorCode(() => store.listBatchDeliveries(accountA, 'missing-batch'), 'BATCH_NOT_FOUND')
    expectErrorCode(() => store.createBatchTask('missing-account', 'Hello', 100, recipients(1)), 'ACCOUNT_NOT_FOUND')
    expect(store.getBatchSummary('missing-batch')).toBeNull()
    expect(store.getDeliveryRecordById('missing-delivery')).toBeNull()
  })

  it('strictly validates page sizes, safe-integer offsets and both status enums', () => {
    const { store } = fixture()
    const task = store.createBatchTask(accountA, 'Hello', 100, recipients(1))
    const invalidCommon = [
      null, [], 'bad', { offset: -1 }, { offset: 0.5 }, { offset: NaN }, { offset: Infinity },
      { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: null }, { limit: null },
      { limit: 0 }, { limit: -1 }, { limit: 0.5 }, { limit: NaN }, { limit: Infinity },
      { limit: Number.MAX_SAFE_INTEGER + 1 }
    ]
    for (const options of invalidCommon) {
      expectErrorCode(() => store.listBatchTasks(accountA, options as BatchTaskListOptions), 'INVALID_TASK_PAGE')
      expectErrorCode(() => store.listBatchDeliveries(accountA, task.id, options as BatchDeliveryListOptions), 'INVALID_TASK_PAGE')
    }
    expectErrorCode(() => store.listBatchTasks(accountA, { limit: 51 }), 'INVALID_TASK_PAGE')
    expectErrorCode(() => store.listBatchDeliveries(accountA, task.id, { limit: 101 }), 'INVALID_TASK_PAGE')
    for (const status of ['all', "pending' OR 1=1 --", 1, null]) {
      expectErrorCode(() => store.listBatchTasks(accountA, { status } as BatchTaskListOptions), 'INVALID_TASK_STATUS')
      expectErrorCode(() => store.listBatchDeliveries(accountA, task.id, { status } as BatchDeliveryListOptions), 'INVALID_TASK_STATUS')
    }
    expect(store.listBatchTasks(accountA, { limit: 50 }).items).toHaveLength(1)
    expect(store.listBatchDeliveries(accountA, task.id, { limit: 100 }).items).toHaveLength(1)
    expect(store.listBatchTasks(accountA, { offset: Number.MAX_SAFE_INTEGER }).items).toEqual([])
  })
})

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`Expected ${code}`)
}

function recipients(count: number): DeliverySeed[] {
  return Array.from({ length: count }, (_, index) => ({
    friendSteamId: String(76561198001000000n + BigInt(index)),
    friendName: `Friend ${index}`,
    renderedMessage: 'x'.repeat(1000)
  }))
}

function account(id: string): AccountRecord {
  return {
    id, steamId: id, accountName: `test-${id}`, displayName: `Account ${id}`, avatarUrl: '',
    createdAt: '2026-10-13T00:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null
  }
}

function fixture(): { store: SqliteStore; reopen(): SqliteStore } {
  const directory = mkdtempSync(join(tmpdir(), 'steam-task-store-test-'))
  const databasePath = join(directory, 'fixture.sqlite3')
  const stores = new Set<SqliteStore>()
  resources.push({ directory, stores })
  const store = new SqliteStore(databasePath, cipher)
  stores.add(store)
  store.upsertAccount(account(accountA))
  store.upsertAccount(account(accountB))
  return {
    store,
    reopen: () => {
      store.close()
      stores.delete(store)
      const recovered = new SqliteStore(databasePath, cipher)
      stores.add(recovered)
      return recovered
    }
  }
}
