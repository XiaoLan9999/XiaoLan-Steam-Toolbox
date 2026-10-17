import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import { LEGACY_COMMENT_POST_REVIEW_MESSAGE } from '../src/shared/batch-retry-policy'
import type { BatchStopCode } from '../src/shared/types'

const accountId = '76561198000000001'
const cipher: SecretCipher = {
  isAvailable: () => false, backend: () => 'fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString()
}
const resources: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-18T00:00:00.000Z') })
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(async () => {
  for (const item of resources) item.queue.shutdown()
  await vi.advanceTimersByTimeAsync(0)
  for (const { directory, store } of resources.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('one-time protection for legacy POST 403 records', () => {
  it.each(['ACCESS_DENIED', 'ACCESS_DENIED_PERSISTENT', 'APP_RESTARTED', 'MANUAL_PAUSE'] as BatchStopCode[])
  ('quarantines exactly the first legacy pending recipient on resume after %s without submitting a comment', async code => {
    const f = fixture(3, code)
    const firstPending = f.store.getBatch(f.task.id)!.deliveries[0]!
    vi.spyOn(f.store, 'getBatch').mockImplementation(() => { throw new Error('Full task reads are unnecessary') })
    f.queue.resume(f.task.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      stopMessage: LEGACY_COMMENT_POST_REVIEW_MESSAGE, pending: 2, uncertain: 1, completed: 1,
      failedCount: 0, sending: 0, nextRetryAt: null, accessDeniedCount: 1 })
    expect(f.store.getDeliveryRecordById(firstPending.id)).toMatchObject({ status: 'uncertain',
      error: LEGACY_COMMENT_POST_REVIEW_MESSAGE, remoteCommentId: null, sentAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(f.post).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('quarantines only once, retains the old cooldown, then explicitly resumes only other pending recipients', async () => {
    const f = fixture(3)
    const firstPending = f.store.getBatch(f.task.id)!.deliveries[0]!
    f.queue.resume(f.task.id)
    expect(() => f.queue.resume(f.task.id)).toThrow('HTTP 403 冷却尚未结束')
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ uncertain: 1, pending: 2, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(300_000)
    f.queue.resume(f.task.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.post.mock.calls.every(call => call[1] !== firstPending.friendSteamId)).toBe(true)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ status: 'completed', uncertain: 1, succeeded: 2, pending: 0 })
  })

  it('does not reclassify sent records or earlier unrelated uncertain outcomes', () => {
    const f = fixture(5)
    f.store.setBatchRunning(f.task.id)
    const sent = f.store.takeNextDelivery(f.task.id)!
    f.store.completeDelivery(sent.id, 'sent_verified', { remoteCommentId: 'synthetic-known-comment' })
    const olderUncertain = f.store.takeNextDelivery(f.task.id)!
    f.store.completeDelivery(olderUncertain.id, 'uncertain', { error: 'Synthetic earlier network result' })
    const pending = f.store.takeNextDelivery(f.task.id)!
    f.store.resetDeliveryToPending(pending.id)
    f.store.pauseBatch(f.task.id, { code: 'ACCESS_DENIED_PERSISTENT', message: 'Synthetic old POST 403' })
    f.queue.resume(f.task.id)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ pending: 2, uncertain: 2, succeeded: 1, failedCount: 0 })
    expect(f.store.getDeliveryRecordById(sent.id)).toMatchObject({ status: 'sent_verified', remoteCommentId: 'synthetic-known-comment' })
    expect(f.store.getDeliveryRecordById(olderUncertain.id)).toMatchObject({ status: 'uncertain', error: 'Synthetic earlier network result' })
    expect(f.store.getDeliveryRecordById(pending.id)).toMatchObject({ status: 'uncertain', error: LEGACY_COMMENT_POST_REVIEW_MESSAGE })
    expect(f.post).not.toHaveBeenCalled()
  })

  it('survives restart before quarantine and a second restart afterward without marking another recipient', async () => {
    const f = fixture(3)
    f.reopen()
    expect(f.current.store.getBatchSummary(f.task.id)?.stopCode).toBe('APP_RESTARTED')
    f.current.queue.resume(f.task.id)
    expect(f.current.store.getBatchSummary(f.task.id)).toMatchObject({ uncertain: 1, pending: 2, stopCode: 'UNCERTAIN_RESULT' })
    f.reopen()
    expect(f.current.store.getBatchSummary(f.task.id)).toMatchObject({ uncertain: 1, pending: 2, stopCode: 'APP_RESTARTED',
      stopMessage: expect.stringContaining(LEGACY_COMMENT_POST_REVIEW_MESSAGE), nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(300_000)
    f.current.queue.resume(f.task.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.current.store.getBatchSummary(f.task.id)).toMatchObject({ status: 'completed', uncertain: 1, succeeded: 2 })
    expect(f.post).toHaveBeenCalledTimes(2)
  })

  it('keeps a single-recipient legacy task paused for review even when no pending recipients remain', () => {
    const f = fixture(1)
    f.queue.resume(f.task.id)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ status: 'paused', uncertain: 1, pending: 0,
      stopCode: 'UNCERTAIN_RESULT', finishedAt: null, nextRetryAt: null })
    expect(f.post).not.toHaveBeenCalled()
  })

  it('never touches a sending record or claims another pending recipient while a POST is still settling', () => {
    const f = fixture(3)
    f.store.setBatchRunning(f.task.id)
    const sending = f.store.takeNextDelivery(f.task.id)!
    f.store.pauseBatch(f.task.id, { code: 'ACCESS_DENIED', message: 'Synthetic old denial during POST' })
    expect(f.store.quarantineLegacyDeniedPost(f.task.id)).toBe(false)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ status: 'paused', pending: 2, sending: 1, uncertain: 0 })
    expect(f.store.getDeliveryRecordById(sending.id)?.status).toBe('sending')
  })

  it.each(['queued', 'running', 'cancelled', 'completed'] as const)('does not quarantine a %s task', status => {
    const f = fixture(2)
    const db = new DatabaseSync(f.path)
    db.prepare('UPDATE batches SET status = ? WHERE id = ?').run(status, f.task.id)
    db.close()
    expect(f.store.quarantineLegacyDeniedPost(f.task.id)).toBe(false)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ status, pending: 2, uncertain: 0 })
  })

  it('does not treat a read-only GET cooldown with no old POST denial as a legacy delivery', () => {
    const f = fixture(2)
    f.store.resetBatchAccessDenials(f.task.id)
    f.store.extendBatchAccessDeniedCooldown(f.task.id)
    expect(f.store.quarantineLegacyDeniedPost(f.task.id)).toBe(false)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ accessDeniedCount: 0, pending: 2, uncertain: 0 })
  })

  it('marks newly created tasks as already using safe POST reconciliation and never quarantines their synthetic denial', () => {
    const f = fixture(2, 'ACCESS_DENIED', false)
    expect(f.store.quarantineLegacyDeniedPost(f.task.id)).toBe(false)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ accessDeniedCount: 1, pending: 2, uncertain: 0 })
  })

  it('requires the corresponding account to be authenticated before modifying any legacy record', () => {
    const f = fixture(2)
    f.steam.isAuthenticated.mockReturnValue(false)
    expect(() => f.queue.resume(f.task.id)).toThrow('恢复批次前必须登录对应 Steam 账号')
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ pending: 2, uncertain: 0, stopCode: 'ACCESS_DENIED_PERSISTENT' })
    expect(f.post).not.toHaveBeenCalled()
  })

  it('rolls back delivery, pause, and one-time marker together if persistence fails', () => {
    const f = fixture(3)
    const db = new DatabaseSync(f.path)
    db.exec(`CREATE TRIGGER fail_comment_safety_marker BEFORE INSERT ON app_meta
      WHEN NEW.key LIKE 'comment-post-safety:%'
      BEGIN SELECT RAISE(ABORT, 'Synthetic marker failure'); END`)
    expect(() => f.queue.resume(f.task.id)).toThrow('Synthetic marker failure')
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ pending: 3, uncertain: 0,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    expect(db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(`comment-post-safety:${f.task.id}`)).toBeUndefined()
    db.exec('DROP TRIGGER fail_comment_safety_marker')
    db.close()
    f.queue.resume(f.task.id)
    expect(f.store.getBatchSummary(f.task.id)).toMatchObject({ pending: 2, uncertain: 1, stopCode: 'UNCERTAIN_RESULT' })
    expect(f.post).not.toHaveBeenCalled()
  })
})

function fixture(count: number, code: BatchStopCode = 'ACCESS_DENIED_PERSISTENT', legacy = true) {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-legacy-post-review-'))
  const path = join(directory, 'fixture.sqlite3')
  const store = new SqliteStore(path, cipher)
  store.upsertAccount({ id: accountId, steamId: accountId, accountName: 'Synthetic', displayName: 'Synthetic', avatarUrl: '',
    createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
  const ids = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(accountId, ids.map(steamId => ({ accountId, steamId, displayName: 'Synthetic friend', avatarUrl: '',
    profileUrl: '', onlineState: 'offline', syncedAt: new Date().toISOString() })))
  const task = store.createBatchTask(accountId, 'Synthetic message', 100, ids.map(friendSteamId => ({
    friendSteamId, friendName: 'Synthetic friend', renderedMessage: 'Synthetic message'
  })))
  if (legacy) {
    const db = new DatabaseSync(path)
    db.prepare('DELETE FROM app_meta WHERE key = ?').run(`comment-post-safety:${task.id}`)
    db.close()
  }
  store.recordBatchAccessDenied(task.id)
  store.pauseBatch(task.id, { code, message: 'Synthetic old POST 403' })
  const post = vi.fn<(account: string, friend: string, message: string) => Promise<{ commentId: string | null }>>()
    .mockResolvedValue({ commentId: 'synthetic-confirmed-comment' })
  const steam = { isAuthenticated: vi.fn(() => true), postProfileComment: post, verifyCommentSession: vi.fn(async () => undefined) }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  const current = { directory, store, queue }
  resources.push(current)
  return { directory, path, store, queue, current, task, post, steam, reopen() {
    current.queue.shutdown()
    current.store.close()
    current.store = new SqliteStore(path, cipher)
    current.queue = new BatchQueue(current.store, steam as unknown as SteamService, () => undefined)
  } }
}
