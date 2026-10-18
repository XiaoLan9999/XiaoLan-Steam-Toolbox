import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'

const accountId = '76561198000000001'
const resources: Array<{ directory: string; stores: Set<SqliteStore> }> = []
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'test',
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

describe('durable access denial circuit breaker state', () => {
  it('starts with no denial and maps bounded summaries without reading delivery bodies', () => {
    const { store } = fixture()
    const task = createTask(store)
    expect(task).toMatchObject({ accessDeniedCount: 0, accessDeniedUntil: null })
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Unexpected full read') })
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id)
    const expected = { accessDeniedCount: 1, accessDeniedUntil: '2026-10-16T02:05:00.000Z',
      completed: 0, succeeded: 0, failed: 0, pending: 2 }
    expect(store.getBatchSummary(task.id)).toMatchObject(expected)
    expect(store.getActiveBatchSummary(accountId)).toMatchObject(expected)
    expect(store.getRecentBatchSummaries(accountId)[0]).toMatchObject(expected)
    const listed = store.listBatchTasks(accountId).items[0]
    expect(listed).toMatchObject(expected)
    expect(listed).not.toHaveProperty('deliveries')
    expect(listed).not.toHaveProperty('renderedMessage')
    expect(store.listBatchDeliveries(accountId, task.id).items[0]).not.toHaveProperty('renderedMessage')
  })

  it('counts every denial independently of ordinary retry state and never shortens a server deadline', () => {
    const { store } = fixture()
    const task = createTask(store)
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id, 3_600_000)
    vi.setSystemTime('2026-10-16T02:01:00.000Z')
    store.recordBatchAccessDenied(task.id, 60_000)
    store.clearBatchRetryCount(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 2,
      accessDeniedUntil: '2026-10-16T03:00:00.000Z', retryCount: 0 })
    vi.setSystemTime('2026-10-16T02:59:00.000Z')
    store.recordBatchAccessDenied(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 3,
      accessDeniedUntil: '2026-10-16T03:04:00.000Z' })
  })

  it('extends a diagnostic cooldown without incrementing the POST denial count', () => {
    const { store } = fixture()
    const task = createTask(store)
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id)
    vi.setSystemTime('2026-10-16T02:01:00.000Z')
    store.extendBatchAccessDeniedCooldown(task.id, 3_600_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T03:01:00.000Z' })
    store.extendBatchAccessDeniedCooldown(task.id, 1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T03:01:00.000Z' })
    store.extendBatchAccessDeniedCooldown(task.id, Number.MAX_SAFE_INTEGER)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '+275760-09-13T00:00:00.000Z' })
  })

  it.each([undefined, -1, NaN, Infinity, -Infinity])('uses the minimum cooldown for an invalid hint %s', hint => {
    const { store } = fixture()
    const task = createTask(store)
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id, hint)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T02:05:00.000Z' })
  })

  it.each([0, 100, 300_000])('does not reduce the minimum cooldown for a valid short hint %s', hint => {
    const { store } = fixture()
    const task = createTask(store)
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id, hint)
    expect(store.getBatchSummary(task.id)?.accessDeniedUntil).toBe('2026-10-16T02:05:00.000Z')
  })

  it('rounds fractional server milliseconds upward and clamps an unrepresentable future date safely', () => {
    const { store } = fixture()
    const task = createTask(store)
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    store.recordBatchAccessDenied(task.id, 300_000.5)
    expect(store.getBatchSummary(task.id)?.accessDeniedUntil).toBe('2026-10-16T02:05:00.001Z')
    store.recordBatchAccessDenied(task.id, Number.MAX_SAFE_INTEGER)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 2,
      accessDeniedUntil: '+275760-09-13T00:00:00.000Z' })
    store.recordBatchAccessDenied(task.id, 300_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 3,
      accessDeniedUntil: '+275760-09-13T00:00:00.000Z' })
  })

  it('preserves the circuit across manual pause, resume, retry mode changes, and cancellation', () => {
    const { store } = fixture()
    const task = createTask(store)
    store.recordBatchAccessDenied(task.id)
    const { accessDeniedCount, accessDeniedUntil } = store.getBatchSummary(task.id)!
    const expected = { accessDeniedCount, accessDeniedUntil }
    store.setBatchRunning(task.id)
    store.pauseBatch(task.id, { code: 'ACCESS_DENIED_PERSISTENT', message: 'Repeated HTTP 403', retryCount: 1 })
    expect(store.getBatchSummary(task.id)).toMatchObject({ ...expected, stopCode: 'ACCESS_DENIED_PERSISTENT' })
    store.pauseBatch(task.id)
    store.setBatchRunning(task.id)
    store.clearBatchRetryCount(task.id)
    store.setBatchAutoRetry(task.id, false)
    store.setBatchAutoRetry(task.id, true)
    expect(store.getBatchSummary(task.id)).toMatchObject(expected)
    store.cancelBatch(task.id)
    expect(store.getBatchSummary(task.id)).toMatchObject({ ...expected, status: 'cancelled' })
  })

  it('preserves denial counts and cooldown through restart without changing confirmed outcomes', () => {
    const { store, reopen } = fixture()
    const task = createTask(store)
    store.setBatchRunning(task.id)
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'sent_verified', { remoteCommentId: 'retained' })
    store.recordBatchAccessDenied(task.id, 600_000)
    store.recordBatchAccessDenied(task.id, 600_000)
    const before = store.getBatchSummary(task.id)!
    const recovered = reopen()
    expect(recovered.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'APP_RESTARTED',
      accessDeniedCount: 2, accessDeniedUntil: before.accessDeniedUntil, completed: 1, succeeded: 1,
      pending: 1, sentVerified: 1 })
    recovered.setBatchRunning(task.id)
    expect(recovered.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 2,
      accessDeniedUntil: before.accessDeniedUntil })
  })

  it('resets only the denial state after an explicitly successful POST is committed', () => {
    const { store } = fixture()
    const task = createTask(store)
    store.setBatchRunning(task.id)
    store.recordBatchAccessDenied(task.id)
    store.recordBatchAccessDenied(task.id)
    store.completeDelivery(store.takeNextDelivery(task.id)!.id, 'sent_verified', { remoteCommentId: 'confirmed' })
    const before = store.getBatchSummary(task.id)!
    store.resetBatchAccessDenials(task.id)
    const after = store.getBatchSummary(task.id)!
    expect(after).toMatchObject({ accessDeniedCount: 0, accessDeniedUntil: null,
      completed: 1, succeeded: 1, failed: 0, sentVerified: 1, pending: 1 })
    const { accessDeniedCount: _count, accessDeniedUntil: _until, ...restBefore } = before
    const { accessDeniedCount: _countAfter, accessDeniedUntil: _untilAfter, ...restAfter } = after
    expect(restAfter).toEqual(restBefore)
    expect(store.getBatch(task.id)).toMatchObject({ accessDeniedCount: 0, accessDeniedUntil: null })
  })

  it('migrates version 5 without rewriting delivery history or enabling a circuit on old tasks', () => {
    const data = fixture()
    const task = createTask(data.store)
    data.store.setBatchRunning(task.id)
    data.store.completeDelivery(data.store.takeNextDelivery(task.id)!.id, 'sent_verified', { remoteCommentId: 'v5' })
    const deliveries = data.store.listBatchDeliveries(accountId, task.id)
    data.close()
    const database = new DatabaseSync(data.databasePath)
    try {
      database.exec(`ALTER TABLE batches DROP COLUMN access_denied_count;
        ALTER TABLE batches DROP COLUMN access_denied_until;
        PRAGMA user_version = 5;`)
    } finally { database.close() }
    const migrated = data.reopen()
    expect(migrated.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 0, accessDeniedUntil: null,
      status: 'paused', stopCode: 'APP_RESTARTED', succeeded: 1, pending: 1 })
    expect(migrated.listBatchDeliveries(accountId, task.id)).toEqual(deliveries)
    const inspection = new DatabaseSync(data.databasePath, { readOnly: true })
    try { expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 }) }
    finally { inspection.close() }
  })

  it('preserves a future legacy 403 deadline while startup clears the old automatic retry plan', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    const data = fixture()
    const task = createTask(data.store)
    data.store.setBatchRunning(task.id)
    data.store.pauseBatch(task.id, { code: 'ACCESS_DENIED', message: 'HTTP 403',
      nextRetryAt: '2026-10-16T03:00:00.000Z', retryCount: 2 })
    downgradeToVersion5(data)
    expect(data.reopen().getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'APP_RESTARTED',
      nextRetryAt: null, accessDeniedUntil: '2026-10-16T03:00:00.000Z', accessDeniedCount: 0,
      total: 2, completed: 0, pending: 2 })
  })

  it('does not infer a legacy 403 cooldown from another stop code or its free-form message', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    const data = fixture()
    const task = createTask(data.store)
    data.store.setBatchRunning(task.id)
    data.store.pauseBatch(task.id, { code: 'RATE_LIMITED', message: 'Previous HTTP 403 mentioned here',
      nextRetryAt: '2026-10-16T03:00:00.000Z', retryCount: 2 })
    downgradeToVersion5(data)
    expect(data.reopen().getBatchSummary(task.id)).toMatchObject({ nextRetryAt: null,
      accessDeniedUntil: null, accessDeniedCount: 0 })
  })

  it('keeps the later deadline and existing counters when a downgraded fixture retains the new columns', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    const data = fixture()
    const longer = createTask(data.store)
    const shorter = createTask(data.store)
    data.store.recordBatchAccessDenied(longer.id, 7_200_000)
    data.store.recordBatchAccessDenied(shorter.id)
    for (const task of [longer, shorter]) {
      data.store.setBatchRunning(task.id)
      data.store.pauseBatch(task.id, { code: 'ACCESS_DENIED', message: 'HTTP 403',
        nextRetryAt: '2026-10-16T03:00:00.000Z', retryCount: 2 })
    }
    downgradeToVersion5(data, true)
    const migrated = data.reopen()
    expect(migrated.getBatchSummary(longer.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T04:00:00.000Z', nextRetryAt: null })
    expect(migrated.getBatchSummary(shorter.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T03:00:00.000Z', nextRetryAt: null })
  })

  it.each(['not-a-date', '2026-10-16T01:59:59.000Z', '2026-10-16T02:00:00.000Z',
    '2026-02-30T03:00:00.000Z', 'October 17, 2026 03:00:00'])('does not preserve an invalid or elapsed legacy deadline %s', deadline => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-16T02:00:00.000Z')
    const data = fixture()
    const task = createTask(data.store)
    data.store.setBatchRunning(task.id)
    data.store.pauseBatch(task.id, { code: 'ACCESS_DENIED', message: 'HTTP 403' })
    downgradeToVersion5(data)
    const database = new DatabaseSync(data.databasePath)
    try { database.prepare('UPDATE batches SET next_retry_at = ? WHERE id = ?').run(deadline, task.id) }
    finally { database.close() }
    expect(data.reopen().getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 0,
      accessDeniedUntil: null, nextRetryAt: null })
  })

  it('requires an existing task for both state mutations', () => {
    const { store } = fixture()
    for (const action of [() => store.recordBatchAccessDenied('missing'),
      () => store.extendBatchAccessDeniedCooldown('missing'), () => store.resetBatchAccessDenials('missing')]) {
      expect(action).toThrowError(expect.objectContaining({ code: 'BATCH_NOT_FOUND' }))
    }
  })
})

function createTask(store: SqliteStore) {
  return store.createBatchTask(accountId, 'Frozen template', 100, [0, 1].map(index => ({
    friendSteamId: String(76561198001000000n + BigInt(index)),
    friendName: `Friend ${index}`, renderedMessage: `Frozen message ${index}`
  })))
}

function downgradeToVersion5(data: { close(): void; databasePath: string }, keepColumns = false): void {
  data.close()
  const database = new DatabaseSync(data.databasePath)
  try {
    if (!keepColumns) database.exec(`ALTER TABLE batches DROP COLUMN access_denied_count;
      ALTER TABLE batches DROP COLUMN access_denied_until;`)
    database.exec('PRAGMA user_version = 5;')
  } finally { database.close() }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'steam-access-denied-store-'))
  const databasePath = join(directory, 'fixture.sqlite3')
  const stores = new Set<SqliteStore>()
  resources.push({ directory, stores })
  let current: SqliteStore | null = new SqliteStore(databasePath, cipher)
  stores.add(current)
  current.upsertAccount({ id: accountId, steamId: accountId, accountName: 'fixture',
    displayName: 'Fixture', avatarUrl: '', createdAt: '2026-10-16T00:00:00.000Z',
    lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
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
