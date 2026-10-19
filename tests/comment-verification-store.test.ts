import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { CommentAttemptEvidence } from '../src/main/comment-reconciliation'
import type { AccountRecord, BatchVerification } from '../src/shared/types'

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const firstFriend = '76561198000001000'
const submittedAt = '2026-10-18T01:00:00.000Z'
const resources: Array<{ directory: string; stores: Set<SqliteStore> }> = []
const cipher: SecretCipher = { isAvailable: () => false, backend: () => 'synthetic-fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString() }

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('persisted read-only comment verification', () => {
  it('persists only bounded submission evidence, refining but never widening or replacing the original attempt', () => {
    const { store, databasePath } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    const initial = evidence({ serverWindow: null })
    store.saveDeliveryCommentEvidence(delivery.id, initial)
    expect(store.getDeliveryCommentEvidence(delivery.id)).toEqual(initial)
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    const narrow = evidence({ serverWindow: { earliest: 1_792_284_002, latest: 1_792_284_008 } })
    store.saveDeliveryCommentEvidence(delivery.id, narrow)
    store.saveDeliveryCommentEvidence(delivery.id, narrow)
    for (const conflict of [evidence(), evidence({ serverWindow: null }), evidence({ baselineIds: ['103'] }),
      evidence({ submittedAt: '2026-10-18T01:00:01.000Z' })]) {
      expect(() => store.saveDeliveryCommentEvidence(delivery.id, conflict)).toThrow(/不能替换|不能.*扩大/)
    }
    expect(store.getDeliveryCommentEvidence(delivery.id)).toEqual(narrow)
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    const row = inspection.prepare('SELECT * FROM delivery_comment_verification').get()
    expect(JSON.stringify(row)).not.toContain('synthetic-private-body')
    expect(row).not.toHaveProperty('rendered_message')
    expect(row).not.toHaveProperty('cookie')
    inspection.close()
  })

  it('only saves evidence for a currently sending delivery and does not mutate pending or uncertain entries', () => {
    const { store } = fixture()
    const batch = createTask(store, 2)
    const pending = store.listBatchDeliveries(accountA, batch.id).items[0]!
    expect(() => store.saveDeliveryCommentEvidence(pending.id, evidence())).toThrow(/当前提交/)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    store.completeDelivery(delivery.id, 'uncertain')
    expect(() => store.saveDeliveryCommentEvidence(delivery.id, evidence())).toThrow(/当前提交/)
    expect(() => store.saveDeliveryCommentEvidence('missing', evidence())).toThrow(/不存在/)
    expect(store.getDeliveryCommentEvidence('missing')).toBeNull()
    expect(store.getBatchSummary(batch.id)?.pending).toBe(1)
  })

  it('accepts one thousand unique canonical IDs and rejects oversized, duplicate or invalid evidence', () => {
    const { store } = fixture()
    const batch = createTask(store, 1)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    const ids = Array.from({ length: 1000 }, (_, index) => String(index + 1))
    const valid = evidence({ baselineIds: ids })
    store.saveDeliveryCommentEvidence(delivery.id, valid)
    const invalid: CommentAttemptEvidence[] = [
      evidence({ baselineIds: [...ids, '1001'] }), evidence({ baselineIds: ['1', '1'] }),
      evidence({ baselineIds: ['0'] }), evidence({ baselineIds: ['01'] }), evidence({ baselineIds: ['-1'] }),
      evidence({ baselineIds: ['1'.repeat(21)] }), evidence({ submittedAt: '2026-10-18' }),
      evidence({ submittedAt: 'invalid' }), evidence({ serverWindow: { earliest: 0, latest: 1 } }),
      evidence({ serverWindow: { earliest: 1, latest: 302 } }),
      evidence({ serverWindow: { earliest: 100, latest: 99 } }),
      evidence({ serverWindow: { earliest: 100.5, latest: 101 } }),
      evidence({ serverWindow: { earliest: 100, latest: Infinity } })
    ]
    for (const value of invalid) expect(() => store.saveDeliveryCommentEvidence(delivery.id, value)).toThrow(/证据无效/)
    expect(store.getDeliveryCommentEvidence(delivery.id)).toEqual(valid)
  })

  it('allows clocks to differ without comparing local submission time with the trusted server window', () => {
    const { store } = fixture()
    const batch = createTask(store, 1)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    const value = evidence({ serverWindow: { earliest: 100, latest: 150 } })
    store.saveDeliveryCommentEvidence(delivery.id, value)
    expect(store.getDeliveryCommentEvidence(delivery.id)).toEqual(value)
  })

  it('clears evidence only for a proven pre-submit reset and retains uncertain evidence', () => {
    const { store } = fixture()
    const batch = createTask(store, 1)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    store.resetDeliveryToPending(delivery.id)
    expect(store.getDeliveryCommentEvidence(delivery.id)).toBeNull()
    const again = store.takeNextDelivery(batch.id)!
    const nextEvidence = evidence({ submittedAt: '2026-10-18T02:00:00.000Z' })
    store.saveDeliveryCommentEvidence(again.id, nextEvidence)
    store.completeDelivery(again.id, 'uncertain')
    store.resetDeliveryToPending(again.id)
    expect(store.getDeliveryRecordById(again.id)?.status).toBe('uncertain')
    expect(store.getDeliveryCommentEvidence(again.id)).toEqual(nextEvidence)
  })

  it('treats corrupt persisted evidence as unavailable and refuses to replace it', () => {
    const { store, databasePath } = fixture()
    const batch = createTask(store, 1)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    const edit = new DatabaseSync(databasePath)
    edit.prepare('UPDATE delivery_comment_verification SET baseline_ids = ?').run('not-json')
    edit.close()
    expect(store.getDeliveryCommentEvidence(delivery.id)).toBeNull()
    expect(() => store.saveDeliveryCommentEvidence(delivery.id, evidence())).toThrow(/不能替换/)
  })

  it('walks only uncertain recipients in the exact frozen order with a bounded cursor', () => {
    const { store, databasePath } = fixture()
    const batch = createTask(store, 6)
    store.setBatchRunning(batch.id)
    const ordered = store.listBatchDeliveries(accountA, batch.id).items
    for (const status of ['uncertain', 'failed', 'uncertain', 'sent_verified'] as const) {
      store.completeDelivery(store.takeNextDelivery(batch.id)!.id, status)
    }
    const edit = new DatabaseSync(databasePath)
    edit.prepare('UPDATE deliveries SET created_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', ordered[2]!.id)
    edit.close()
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Unbounded history forbidden') })
    const first = store.getNextUncertainDelivery(batch.id)!
    expect(first.id).toBe(ordered[2]!.id)
    const second = store.getNextUncertainDelivery(batch.id, first)!
    expect(second.id).toBe(ordered[0]!.id)
    expect(store.getNextUncertainDelivery(batch.id, second)).toBeNull()
    expect(() => store.getNextUncertainDelivery(batch.id, { createdAt: 'invalid', id: 'id' })).toThrow(/位置无效/)
    expect(() => store.getNextUncertainDelivery('missing')).toThrow(/批次不存在/)
    expect(store.getBatch).not.toHaveBeenCalled()
  })

  it('uses a single ordered candidate query without recounting or materializing the whole batch', () => {
    const { store } = fixture()
    const batch = createTask(store, 1200)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.completeDelivery(delivery.id, 'uncertain')
    const statements = vi.spyOn((store as unknown as { db: DatabaseSync }).db, 'prepare')
    expect(store.getNextUncertainDelivery(batch.id)?.id).toBe(delivery.id)
    const queries = statements.mock.calls.map(([value]) => String(value))
    expect(queries).toHaveLength(2)
    expect(queries[1]).toContain("status = 'uncertain'")
    expect(queries[1]).toContain('ORDER BY created_at, id LIMIT 1')
    expect(queries.join('\n')).not.toMatch(/COUNT|SUM|GROUP BY/)
  })

  it('publishes only one latest metadata progress record per task, including task pages and account isolation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(submittedAt)
    const { store } = fixture()
    const batch = createTask(store, 3)
    const other = createTask(store, 1, accountB)
    store.setBatchRunning(batch.id)
    const first = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(first.id, evidence())
    store.completeDelivery(first.id, 'uncertain')
    const second = store.takeNextDelivery(batch.id)!
    store.completeDelivery(second.id, 'uncertain')
    store.recordDeliveryVerification(second.id, progress({ message: 'synthetic-second' }))
    store.recordDeliveryVerification(first.id, progress({ message: 'synthetic-first-latest' }))
    const expected: BatchVerification = { deliveryId: first.id, friendSteamId: first.friendSteamId,
      friendName: first.friendName, state: 'checking', attempt: 1, maxAttempts: 3,
      checkedAt: null, nextCheckAt: null, message: 'synthetic-first-latest' }
    expect(store.getBatchSummary(batch.id)?.verification).toEqual(expected)
    expect(store.getActiveBatchSummary(accountA)?.verification).toEqual(expected)
    expect(store.listBatchTasks(accountA).items[0]?.verification).toEqual(expected)
    expect(store.listBatchTasks(accountB).items[0]?.verification).toBeNull()
    expect(store.getBatchSummary(other.id)?.verification).toBeNull()
    const json = JSON.stringify(store.getBatchSummary(batch.id)?.verification)
    expect(json).not.toContain('baseline')
    expect(json).not.toContain('submittedAt')
    expect(json).not.toContain('renderedMessage')
    expect(json.length).toBeLessThan(1000)
    const statements = vi.spyOn((store as unknown as { db: DatabaseSync }).db, 'prepare')
    store.getBatchSummary(batch.id)
    const query = statements.mock.calls.map(([value]) => String(value)).find(value => value.includes('v.state, v.attempt'))!
    expect(query).toContain('LIMIT 1')
    expect(query).not.toContain('baseline_ids')
    expect(query).not.toContain('rendered_message')
  })

  it('validates progress states and records local completion timestamps without claiming delivery', () => {
    vi.useFakeTimers()
    vi.setSystemTime(submittedAt)
    const { store } = fixture()
    const batch = createTask(store, 1)
    const pending = store.listBatchDeliveries(accountA, batch.id).items[0]!
    expect(() => store.recordDeliveryVerification(pending.id, progress())).toThrow(/不能更新核对/)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.completeDelivery(delivery.id, 'uncertain')
    for (const invalid of [progress({ attempt: 0 }), progress({ maxAttempts: 11 }), progress({ attempt: 4 }),
      progress({ state: 'waiting' }), progress({ nextCheckAt: '2026-10-18T01:00:01.000Z' }),
      progress({ message: '' }), progress({ message: 'x'.repeat(1001) })]) {
      expect(() => store.recordDeliveryVerification(delivery.id, invalid)).toThrow(/进度无效/)
    }
    expect(() => store.recordDeliveryVerification(delivery.id, progress({ state: 'confirmed' }))).toThrow(/不能更新核对/)
    store.recordDeliveryVerification(delivery.id, progress({ state: 'waiting', nextCheckAt: '2026-10-18T01:00:05.000Z' }))
    expect(store.getBatchSummary(batch.id)?.verification?.checkedAt).toBe(submittedAt)
    vi.setSystemTime('2026-10-18T01:00:05.000Z')
    store.recordDeliveryVerification(delivery.id, progress({ attempt: 2 }))
    expect(store.getBatchSummary(batch.id)?.verification?.checkedAt).toBe(submittedAt)
    expect(store.getDeliveryRecordById(delivery.id)).toMatchObject({ status: 'uncertain', sentAt: null })
  })

  it.each(['checking', 'waiting'] as const)('recovers interrupted %s progress without sending or resuming', state => {
    const { store, reopen } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    store.completeDelivery(delivery.id, 'uncertain')
    store.recordDeliveryVerification(delivery.id, progress({ state,
      nextCheckAt: state === 'waiting' ? '2026-10-18T01:00:05.000Z' : null }))
    const recovered = reopen()
    expect(recovered.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', uncertain: 1, pending: 1,
      nextRetryAt: null, verification: { state: 'unresolved', nextCheckAt: null, message: '核对中断，未重发' } })
    expect(recovered.getDeliveryCommentEvidence(delivery.id)).toEqual(evidence())
    expect(recovered.getDeliveryRecordById(delivery.id)?.sentAt).toBeNull()
  })

  it('migrates v7 without inventing submission evidence or changing frozen delivery results', () => {
    const { store, databasePath, reopen } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.completeDelivery(delivery.id, 'uncertain', { error: 'synthetic-existing-error' })
    store.pauseBatch(batch.id)
    const before = store.listBatchDeliveries(accountA, batch.id)
    store.close()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec('DROP TABLE delivery_comment_verification; PRAGMA user_version = 7;')
    legacy.close()
    const migrated = reopen(true)
    expect(migrated.listBatchDeliveries(accountA, batch.id)).toEqual(before)
    expect(migrated.getDeliveryCommentEvidence(delivery.id)).toBeNull()
    expect(migrated.getBatchSummary(batch.id)?.verification).toBeNull()
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
    expect(inspection.prepare('SELECT COUNT(*) AS count FROM delivery_comment_verification').get()).toMatchObject({ count: 0 })
    inspection.close()
  })

  it('preserves an interrupted in-flight attempt baseline on restart while leaving all unsent recipients pending', () => {
    const { store, reopen } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    const recovered = reopen()
    expect(recovered.getDeliveryCommentEvidence(delivery.id)).toEqual(evidence())
    expect(recovered.getDeliveryRecordById(delivery.id)?.status).toBe('uncertain')
    expect(recovered.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', uncertain: 1, pending: 1,
      verification: null, nextRetryAt: null })
  })

  it('CAS-confirms an uncertain delivery with the remote posted time and recomputes counts, leaving pending untouched', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-18T02:00:00.000Z')
    const { store } = fixture()
    const batch = createTask(store, 2)
    store.setBatchRunning(batch.id)
    const delivery = store.takeNextDelivery(batch.id)!
    store.saveDeliveryCommentEvidence(delivery.id, evidence())
    store.completeDelivery(delivery.id, 'uncertain', { error: 'synthetic-old-403' })
    store.pauseBatch(batch.id, { code: 'UNCERTAIN_RESULT', message: 'synthetic-needs-review' })
    store.recordDeliveryVerification(delivery.id, progress())
    const pending = store.listBatchDeliveries(accountA, batch.id, { status: 'pending' })
    const remoteSeconds = 1_792_284_005
    expect(store.confirmUncertainDelivery(delivery.id, accountA, '888', remoteSeconds)).toBe(true)
    expect(store.getDeliveryRecordById(delivery.id)).toMatchObject({ status: 'sent_verified', error: null,
      remoteCommentId: '888', sentAt: new Date(remoteSeconds * 1000).toISOString() })
    expect(store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', pending: 1, uncertain: 0,
      completed: 1, succeeded: 1, failed: 0, verification: { state: 'confirmed', checkedAt: '2026-10-18T02:00:00.000Z' },
      activity: { lastConfirmed: { deliveryId: delivery.id, recordedAt: '2026-10-18T02:00:00.000Z' } } })
    expect(store.listBatchDeliveries(accountA, batch.id, { status: 'pending' })).toEqual(pending)
    expect(store.confirmUncertainDelivery(delivery.id, accountA, '889', remoteSeconds)).toBe(false)
    store.recordDeliveryVerification(delivery.id, progress({ state: 'confirmed', message: 'synthetic-confirmed' }))
    expect(() => store.recordDeliveryVerification(delivery.id, progress())).toThrow(/不能更新核对/)
  })

  it('does not reuse one remote comment across deliveries for the same account and target', () => {
    const { store } = fixture()
    const first = uncertainTask(store)
    expect(store.confirmUncertainDelivery(first.delivery.id, accountA, '888', 1_792_284_005)).toBe(true)
    const second = uncertainTask(store)
    expect(store.confirmUncertainDelivery(second.delivery.id, accountA, '888', 1_792_284_005)).toBe(false)
    expect(store.getDeliveryRecordById(second.delivery.id)?.status).toBe('uncertain')
    const differentAccount = uncertainTask(store, accountB)
    expect(store.confirmUncertainDelivery(differentAccount.delivery.id, accountB, '888', 1_792_284_005)).toBe(true)
    const differentTarget = uncertainTask(store, accountA, '76561198000001001')
    expect(store.confirmUncertainDelivery(differentTarget.delivery.id, accountA, '888', 1_792_284_005)).toBe(true)
  })

  it('rejects wrong-account, cancelled, missing or non-uncertain confirmations', () => {
    const { store } = fixture()
    const { batch, delivery } = uncertainTask(store)
    expect(() => store.confirmUncertainDelivery(delivery.id, accountB, '888', 1_792_284_005)).toThrow(/不属于当前账号/)
    expect(() => store.confirmUncertainDelivery('missing', accountA, '888', 1_792_284_005)).toThrow(/不存在/)
    for (const [id, seconds] of [['0', 1], ['01', 1], ['1'.repeat(21), 1], ['888', 0], ['888', Infinity], ['888', 1.1]] as const) {
      expect(() => store.confirmUncertainDelivery(delivery.id, accountA, id, seconds)).toThrow(/编号或时间无效/)
    }
    store.cancelBatch(batch.id)
    expect(store.confirmUncertainDelivery(delivery.id, accountA, '888', 1_792_284_005)).toBe(false)
    expect(store.getDeliveryRecordById(delivery.id)?.status).toBe('uncertain')
    expect(() => store.recordDeliveryVerification(delivery.id, progress())).toThrow(/不能更新核对/)
    store.recordDeliveryVerification(delivery.id, progress({ state: 'unresolved' }))
    const next = createTask(store, 1)
    const pending = store.listBatchDeliveries(accountA, next.id).items[0]!
    expect(store.confirmUncertainDelivery(pending.id, accountA, '888', 1_792_284_005)).toBe(false)
    store.setBatchRunning(next.id)
    store.takeNextDelivery(next.id)
    expect(store.confirmUncertainDelivery(pending.id, accountA, '888', 1_792_284_005)).toBe(false)
    store.completeDelivery(pending.id, 'failed')
    expect(store.confirmUncertainDelivery(pending.id, accountA, '888', 1_792_284_005)).toBe(false)
  })

  it('cascades only the removed account evidence and keeps other account progress intact', () => {
    const { store, databasePath } = fixture()
    const first = createTask(store, 1)
    const other = createTask(store, 1, accountB)
    for (const task of [first, other]) {
      store.setBatchRunning(task.id)
      const delivery = store.takeNextDelivery(task.id)!
      store.saveDeliveryCommentEvidence(delivery.id, evidence())
      store.completeDelivery(delivery.id, 'uncertain')
      store.recordDeliveryVerification(delivery.id, progress())
    }
    store.deleteAccount(accountA)
    expect(store.getBatchSummary(first.id)).toBeNull()
    expect(store.getBatchSummary(other.id)?.verification?.state).toBe('checking')
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('SELECT COUNT(*) AS count FROM delivery_comment_verification').get()).toMatchObject({ count: 1 })
    expect(inspection.prepare('SELECT batch_id FROM delivery_comment_verification').get()).toMatchObject({ batch_id: other.id })
    inspection.close()
  })
})

function evidence(overrides: Partial<CommentAttemptEvidence> = {}): CommentAttemptEvidence {
  return { baselineIds: ['101', '102'], serverWindow: { earliest: 1_792_284_000, latest: 1_792_284_010 },
    submittedAt, ...overrides }
}

function progress(overrides: Partial<Pick<BatchVerification, 'state' | 'attempt' | 'maxAttempts' | 'nextCheckAt' | 'message'>> = {}) {
  return { state: 'checking' as BatchVerification['state'], attempt: 1, maxAttempts: 3,
    nextCheckAt: null as string | null, message: 'synthetic-checking', ...overrides }
}

function createTask(store: SqliteStore, count: number, accountId = accountA, friendSteamId = firstFriend) {
  return store.createBatchTask(accountId, 'synthetic-template', 100, Array.from({ length: count }, (_, index) => ({
    friendSteamId: String(BigInt(friendSteamId) + BigInt(index)), friendName: `synthetic-friend-${index}`,
    renderedMessage: `synthetic-private-body-${index}`
  })))
}

function uncertainTask(store: SqliteStore, accountId = accountA, friendSteamId = firstFriend) {
  const batch = createTask(store, 1, accountId, friendSteamId)
  store.setBatchRunning(batch.id)
  const delivery = store.takeNextDelivery(batch.id)!
  store.completeDelivery(delivery.id, 'uncertain')
  store.pauseBatch(batch.id)
  return { batch, delivery }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'steam-comment-verification-'))
  const databasePath = join(directory, 'synthetic.sqlite3')
  const stores = new Set<SqliteStore>()
  resources.push({ directory, stores })
  const store = new SqliteStore(databasePath, cipher)
  stores.add(store)
  for (const id of [accountA, accountB]) {
    const account: AccountRecord = { id, steamId: id, accountName: `synthetic-${id}`,
      displayName: `synthetic-account-${id}`, avatarUrl: '', createdAt: submittedAt,
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
