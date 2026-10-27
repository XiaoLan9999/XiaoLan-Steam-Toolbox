import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import type { CommentVerificationResult } from '../src/main/comment-reconciliation'
import { DomainError } from '../src/shared/domain'
import { CommentPermissionDeniedError } from '../src/shared/comment-permission'
import { DEFAULT_BATCH_FAILURE_POLICY, type BatchFailurePolicy } from '../src/shared/batch-failure-policy'

const A = '76561198000000001'
const B = '76561198000000002'
const cipher: SecretCipher = { isAvailable: () => false, backend: () => 'fixture', encrypt: value => Buffer.from(value), decrypt: value => value.toString() }
const resources: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []
const evidence = { baselineIds: ['5001'], serverWindow: { earliest: 1_790_999_998, latest: 1_791_000_050 }, submittedAt: new Date(1_791_000_000_000).toISOString() }
const policy = (uncertainResult: BatchFailurePolicy['uncertainResult'], definiteFailure: BatchFailurePolicy['definiteFailure'] = 'skip'): BatchFailurePolicy => ({ definiteFailure, uncertainResult })

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(async () => {
  for (const item of resources) item.queue.shutdown()
  await vi.advanceTimersByTimeAsync(500)
  for (const { directory, store } of resources.splice(0)) {
    store.close()
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('batch-failure-policy-')) throw new Error('Unexpected fixture cleanup target')
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  vi.restoreAllMocks(); vi.useRealTimers()
})

function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'batch-failure-policy-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  for (const id of [A, B]) store.upsertAccount({ id, steamId: id, accountName: 'synthetic', displayName: 'Fixture sender', avatarUrl: '', createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
  store.setActiveAccountId(A)
  const friendIds = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(A, friendIds.map((steamId, index) => ({ accountId: A, steamId, displayName: `Fixture ${index}`, avatarUrl: '', profileUrl: `https://steamcommunity.com/profiles/${steamId}`, onlineState: 'offline' as const, syncedAt: new Date().toISOString() })))
  const post = vi.fn<SteamService['postProfileComment']>().mockResolvedValue({ commentId: '8001' })
  const verify = vi.fn<SteamService['reconcileProfileComment']>().mockResolvedValue({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 })
  const steam = { isAuthenticated: vi.fn(() => true), postProfileComment: post, reconcileProfileComment: verify }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  resources.push({ directory, store, queue })
  const deliveries = friendIds.map((friendSteamId, index) => ({ friendSteamId, friendName: `Fixture ${index}`, renderedMessage: ':fixture:' }))
  return { directory, store, queue, post, verify, steam, deliveries, input: { accountId: A, friendSteamIds: friendIds, messageTemplate: ':fixture:', delayMs: 100, autoRetryEnabled: false } }
}
function seed(f: ReturnType<typeof fixture>, failurePolicy: BatchFailurePolicy, uncertain = false) {
  const batch = f.store.createBatchTask(A, ':fixture:', 100, f.deliveries, false, failurePolicy)
  f.store.setBatchRunning(batch.id)
  if (uncertain) {
    const delivery = f.store.takeNextDelivery(batch.id)!
    f.store.saveDeliveryCommentEvidence(delivery.id, evidence)
    f.store.completeDelivery(delivery.id, 'uncertain', { error: 'Synthetic uncertain result' })
  }
  f.store.pauseBatch(batch.id, { code: 'UNCERTAIN_RESULT', message: 'Synthetic paused task' })
  return batch.id
}
function ambiguousOnce(f: ReturnType<typeof fixture>) {
  f.post.mockImplementationOnce(async (_account, _friend, _message, _guard, save) => { save?.(evidence); throw new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic ambiguous POST') })
}

describe('durable batch failure policy snapshots', () => {
  it('copies validated policies into full, summary and paged snapshots without aliasing', () => {
    const f = fixture(); const requested = policy('verify_then_pause', 'pause')
    const batch = f.store.createBatchTask(A, ':fixture:', 100, f.deliveries, false, requested)
    requested.definiteFailure = 'skip'
    expect(f.store.getBatch(batch.id)!.failurePolicy).toEqual(policy('verify_then_pause', 'pause'))
    const returned = f.store.getBatchSummary(batch.id)!.failurePolicy!; returned.uncertainResult = 'skip'
    expect(f.store.listBatchTasks(A).items[0]!.failurePolicy).toEqual(policy('verify_then_pause', 'pause'))
    expect(f.store.getRecentBatchSummaries(A)[0]!.failurePolicy).toEqual(policy('verify_then_pause', 'pause'))
  })
  it('migrates v8 tasks to the existing behavior without modifying frozen deliveries or cooldown', () => {
    const f = fixture(); const id = seed(f, policy('verify_then_pause', 'pause'), true)
    f.store.recordBatchAccessDenied(id)
    const original = f.store.getBatch(id)!
    f.queue.shutdown(); f.store.close()
    const path = join(f.directory, 'fixture.sqlite3'); const db = new DatabaseSync(path)
    try { db.exec('ALTER TABLE batches DROP COLUMN failure_policy; PRAGMA user_version = 8;') } finally { db.close() }
    const resource = resources.find(item => item.store === f.store)!
    resource.store = new SqliteStore(path, cipher); resource.queue = new BatchQueue(resource.store, f.steam as unknown as SteamService, () => undefined)
    const migrated = resource.store.getBatch(id)!
    expect(migrated.failurePolicy).toEqual(DEFAULT_BATCH_FAILURE_POLICY); expect(migrated.deliveries).toEqual(original.deliveries)
    expect(migrated.accessDeniedUntil).toBe(original.accessDeniedUntil); expect(migrated.status).toBe('paused'); expect(migrated.stopCode).toBe('APP_RESTARTED')
    const inspection = new DatabaseSync(path, { readOnly: true })
    try { expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 }) } finally { inspection.close() }
  })
  it('persists paused edits across reopen, clears scheduled retry but not the access-denied deadline', () => {
    const f = fixture(); const id = seed(f, policy('verify_then_skip'))
    f.store.recordBatchAccessDenied(id); const until = f.store.getBatchSummary(id)!.accessDeniedUntil
    f.store.setBatchAutoRetry(id, true); f.store.pauseBatch(id, { code: 'RATE_LIMITED', message: 'Synthetic rate pause', nextRetryAt: new Date(Date.now() + 60000).toISOString() })
    f.queue.setFailurePolicy(id, policy('skip', 'pause'))
    expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'paused', failurePolicy: policy('skip', 'pause'), nextRetryAt: null, accessDeniedUntil: until })
    f.queue.shutdown(); f.store.close(); const resource = resources.find(item => item.store === f.store)!
    resource.store = new SqliteStore(join(f.directory, 'fixture.sqlite3'), cipher); resource.queue = new BatchQueue(resource.store, f.steam as unknown as SteamService, () => undefined)
    expect(resource.store.getBatchSummary(id)!.failurePolicy).toEqual(policy('skip', 'pause')); expect(f.post).not.toHaveBeenCalled()
  })
  it('rejects malformed policies before creating or changing any task', () => {
    const f = fixture(); const id = seed(f, policy('verify_then_skip'))
    for (const invalid of [null, {}, { definiteFailure: 'retry', uncertainResult: 'skip' }, { definiteFailure: 'skip', uncertainResult: 'repost' }, { ...policy('skip'), sql: "'; DROP TABLE batches;--" }]) {
      expect(() => f.queue.start({ ...f.input, failurePolicy: invalid as BatchFailurePolicy })).toThrow()
      expect(() => f.store.setBatchFailurePolicy(id, invalid as BatchFailurePolicy)).toThrow()
    }
    expect(f.store.listBatchTasks(A).total).toBe(1); expect(f.store.getBatchSummary(id)!.failurePolicy).toEqual(DEFAULT_BATCH_FAILURE_POLICY); expect(f.post).not.toHaveBeenCalled()
  })
  it('only edits paused tasks with no sending or active verification records', () => {
    const f = fixture(); const batch = f.store.createBatchTask(A, ':fixture:', 100, f.deliveries)
    expect(() => f.store.setBatchFailurePolicy(batch.id, policy('skip'))).toThrow()
    f.store.setBatchRunning(batch.id); const delivery = f.store.takeNextDelivery(batch.id)!
    f.store.pauseBatch(batch.id, { code: 'UNCERTAIN_RESULT', message: 'Synthetic' })
    expect(() => f.store.setBatchFailurePolicy(batch.id, policy('skip'))).toThrow()
    f.store.completeDelivery(delivery.id, 'uncertain')
    for (const state of ['checking', 'waiting'] as const) {
      f.store.recordDeliveryVerification(delivery.id, { state, attempt: 1, maxAttempts: 3, nextCheckAt: state === 'waiting' ? new Date(Date.now() + 5000).toISOString() : null, message: 'Synthetic checking' })
      expect(() => f.store.setBatchFailurePolicy(batch.id, policy('skip'))).toThrow()
    }
    f.store.recordDeliveryVerification(delivery.id, { state: 'unresolved', attempt: 1, maxAttempts: 3, nextCheckAt: null, message: 'Stopped' })
    f.store.setBatchFailurePolicy(batch.id, policy('skip'))
    expect(f.store.getBatchSummary(batch.id)!.failurePolicy).toEqual(policy('skip'))
  })
  it('refuses a wrong active account and never resumes a task merely by editing its policy', async () => {
    const f = fixture(); const id = seed(f, policy('verify_then_skip'))
    f.store.setActiveAccountId(B); expect(() => f.queue.setFailurePolicy(id, policy('skip'))).toThrow()
    f.store.setActiveAccountId(A); f.steam.isAuthenticated.mockReturnValue(false); expect(() => f.queue.setFailurePolicy(id, policy('skip'))).toThrow()
    f.steam.isAuthenticated.mockReturnValue(true); f.queue.setFailurePolicy(id, policy('verify_then_pause'))
    await vi.advanceTimersByTimeAsync(3_600_000); expect(f.post).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled(); expect(f.store.getBatchSummary(id)!.status).toBe('paused')
  })
  it('invalidates a real auto-recovery plan without clearing its persisted 403 cooldown', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic access denial'))
    const batch = f.queue.start({ ...f.input, autoRetryEnabled: true }); await vi.advanceTimersByTimeAsync(0)
    const before = f.store.getBatchSummary(batch.id)!
    expect(before.nextRetryAt).not.toBeNull(); expect(before.accessDeniedUntil).not.toBeNull()
    f.queue.setFailurePolicy(batch.id, policy('skip', 'pause'))
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ pending: 2, nextRetryAt: null, accessDeniedUntil: before.accessDeniedUntil, accessDeniedCount: before.accessDeniedCount })
    await vi.advanceTimersByTimeAsync(3_600_000); expect(f.post).toHaveBeenCalledOnce(); expect(f.store.getBatchSummary(batch.id)!.status).toBe('paused')
  })
  it('rejects edits for completed and cancelled tasks', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const f = fixture(1); const id = seed(f, policy('verify_then_skip'), true)
      if (status === 'completed') f.store.finishBatchIfDone(id); else f.store.cancelBatch(id)
      expect(() => f.queue.setFailurePolicy(id, policy('skip'))).toThrow()
      expect(f.store.getBatchSummary(id)!.failurePolicy).toEqual(DEFAULT_BATCH_FAILURE_POLICY)
    }
  })
})

describe('explicit friend failure behavior', () => {
  it.each(['skip', 'verify_then_skip', 'verify_then_pause'] as const)
  ('keeps a permission-denied POST uncertain, categorizes the friend, and skips it under %s', async uncertainResult => {
    const f = fixture()
    f.post.mockRejectedValueOnce(new CommentPermissionDeniedError('COMMENT_POST_UNCERTAIN', 'Synthetic explicit permission refusal'))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy(uncertainResult, 'pause') })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', uncertain: 1,
      failedCount: 0, sentVerified: 1, pending: 0, nextRetryAt: null, accessDeniedCount: 0,
      verification: { state: 'unresolved', attempt: 0 } })
    const unavailable = f.post.mock.calls[0]![1]
    expect(f.store.getBatch(batch.id)!.deliveries.find(item => item.friendSteamId === unavailable))
      .toMatchObject({ status: 'uncertain', remoteCommentId: null })
    expect(f.store.getFriendPolicies(A).find(item => item.steamId === unavailable)?.commentStatus).toBe('blocked')
    expect(f.store.getBatchSummary(batch.id)?.verification?.message).toContain('Steam 明确提示无法留言')
    expect(f.store.getBatchSummary(batch.id)?.verification?.message).not.toContain('网络或服务请求失败')
    expect(f.post.mock.calls.filter(call => call[1] === unavailable)).toHaveLength(1)
    expect(f.verify).not.toHaveBeenCalled()
  })

  it.each(['skip', 'pause'] as const)('always skips a proven unavailable target with the selected %s policy without retrying it', async definiteFailure => {
    const f = fixture()
    f.post.mockRejectedValueOnce(new DomainError('COMMENT_TARGET_UNAVAILABLE', 'Target profile is private; no comment submitted'))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('verify_then_skip', definiteFailure) })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed',
      failedCount: 1, uncertain: 0, pending: 0, sentVerified: 1, nextRetryAt: null, accessDeniedCount: 0 })
    const unavailable = f.post.mock.calls[0]![1]
    expect(f.store.getBatch(batch.id)!.deliveries.find(delivery => delivery.friendSteamId === unavailable))
      .toMatchObject({ status: 'failed', error: 'Target profile is private; no comment submitted' })
    expect(f.store.getFriendPolicies(A).find(item => item.steamId === unavailable)?.commentStatus).toBe('blocked')
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.post.mock.calls.filter(call => call[1] === unavailable)).toHaveLength(1)
    expect(f.verify).not.toHaveBeenCalled()
  })

  it('defaults to recording a definite rejection and continuing without retrying that recipient', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('Comments disabled for this profile'))
    const batch = f.queue.start(f.input); await vi.advanceTimersByTimeAsync(100)
    expect(f.post).toHaveBeenCalledTimes(2); expect(new Set(f.post.mock.calls.map(call => call[1])).size).toBe(2)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', failedCount: 1, sentVerified: 1, failurePolicy: DEFAULT_BATCH_FAILURE_POLICY })
  })
  it.each([1, 2])('pauses a definite rejection only when %s recipient(s) leave more pending work', async count => {
    const f = fixture(count); f.post.mockRejectedValueOnce(new Error('Comments disabled for this profile'))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('verify_then_skip', 'pause') }); await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: count > 1 ? 'paused' : 'completed', failedCount: 1, pending: count - 1, nextRetryAt: null }); expect(f.post).toHaveBeenCalledOnce()
    if (count > 1) expect(f.store.getBatchSummary(batch.id)!.stopCode).toBe('DELIVERY_FAILED')
  })
  it.each(['RATE_LIMITED', 'COMMUNITY_ACCESS_DENIED', 'SESSION_EXPIRED', 'NOT_AUTHENTICATED', 'WRONG_ACCOUNT'])('never bypasses global protection for %s under skip policies', async code => {
    const f = fixture(); f.post.mockRejectedValueOnce(new DomainError(code, 'Synthetic global rejection'))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('skip') }); await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.store.getBatchSummary(batch.id)!.status).toBe('paused'); expect(f.post).toHaveBeenCalledOnce(); expect(f.verify).not.toHaveBeenCalled()
    if (code === 'COMMUNITY_ACCESS_DENIED') expect(f.store.getBatchSummary(batch.id)!.accessDeniedUntil).not.toBeNull()
  })
})

describe('uncertain result strategies never repeat the original POST', () => {
  it('skip preserves uncertain, records that no check was made, and immediately moves to pending', async () => {
    const f = fixture(); ambiguousOnce(f)
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('skip') }); await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).not.toHaveBeenCalled(); expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', uncertain: 1, sentVerified: 1, verification: { state: 'unresolved', attempt: 0 } })
    expect(f.store.getBatchSummary(batch.id)!.verification!.message).toContain('未执行核对')
  })
  it('skip can resume an old uncertain task even without a read-only verifier', async () => {
    const f = fixture(); const id = seed(f, policy('skip'), true)
    Object.assign(f.steam, { reconcileProfileComment: undefined }); f.queue.resume(id); await vi.advanceTimersByTimeAsync(100)
    expect(f.post).toHaveBeenCalledOnce(); expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'completed', uncertain: 1, sentVerified: 1 })
  })
  it('an explicit check overrides automatic skip and performs GET before continuing pending only', async () => {
    const f = fixture(); const id = seed(f, policy('skip'), true)
    f.queue.verify(id); await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).toHaveBeenCalledOnce(); expect(f.post).toHaveBeenCalledOnce()
    expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'completed', uncertain: 0, sentVerified: 2, verification: { state: 'confirmed' } })
  })
  it('an explicit check of a completed skip-policy task still performs GET without any POST', async () => {
    const f = fixture(1); const id = seed(f, policy('skip'), true); f.store.finishBatchIfDone(id)
    f.queue.verify(id); await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).toHaveBeenCalledOnce(); expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'completed', uncertain: 0, sentVerified: 1 })
  })
  it('an explicit check requires a verifier even when automatic uncertainty handling is skip', () => {
    const f = fixture(); const id = seed(f, policy('skip'), true)
    Object.assign(f.steam, { reconcileProfileComment: undefined })
    expect(() => f.queue.verify(id)).toThrow('只读核对'); expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'paused', uncertain: 1, pending: 1 })
  })
  it('the default verifies at most three times before skipping, while retaining uncertainty', async () => {
    const f = fixture(); ambiguousOnce(f); f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' })
    const batch = f.queue.start(f.input); await vi.advanceTimersByTimeAsync(20_100)
    expect(f.verify).toHaveBeenCalledTimes(3); expect(f.post).toHaveBeenCalledTimes(2); expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', uncertain: 1, sentVerified: 1 })
  })
  it.each([1, 2])('verify then pause retains a paused task after unresolved checks for %s recipient(s)', async count => {
    const f = fixture(count); ambiguousOnce(f); f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' })
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('verify_then_pause') }); await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.verify).toHaveBeenCalledTimes(3); expect(f.post).toHaveBeenCalledOnce()
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', uncertain: 1, pending: count - 1, stopCode: 'UNCERTAIN_RESULT', nextRetryAt: null })
    expect(f.store.getBatchSummary(batch.id)!.verification!.message).not.toContain('将继续')
  })
  it.each(['verify_then_skip', 'verify_then_pause'] as const)('%s confirms by read-only lookup and continues only the remaining recipient', async uncertainResult => {
    const f = fixture(); ambiguousOnce(f)
    const batch = f.queue.start({ ...f.input, failurePolicy: policy(uncertainResult) }); await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).toHaveBeenCalledOnce(); expect(f.post).toHaveBeenCalledTimes(2); expect(new Set(f.post.mock.calls.map(call => call[1])).size).toBe(2)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', sentVerified: 2, uncertain: 0 })
  })
  it('explicit verification respects pause policy instead of completing a task with no pending recipients', async () => {
    const f = fixture(1); const id = seed(f, policy('verify_then_pause'), true)
    f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' }); f.queue.verify(id)
    await vi.advanceTimersByTimeAsync(20_100)
    expect(f.store.getBatchSummary(id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT', uncertain: 1, nextRetryAt: null }); expect(f.post).not.toHaveBeenCalled()
  })
  it('a completed task remains completed when explicit verification cannot resolve it', async () => {
    const f = fixture(1); const id = seed(f, policy('verify_then_pause'), true); f.store.finishBatchIfDone(id)
    f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' }); f.queue.verify(id); await vi.advanceTimersByTimeAsync(20_100)
    expect(f.store.getBatchSummary(id)!.status).toBe('completed'); expect(f.store.getBatchSummary(id)!.verification!.message).toContain('不会重新发送'); expect(f.post).not.toHaveBeenCalled()
  })
  it.each(['COMMUNITY_ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED'])("still stops on a verifier's global %s", async code => {
    const f = fixture(); ambiguousOnce(f); f.verify.mockRejectedValue(new DomainError(code, 'Synthetic GET protection'))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('verify_then_skip') }); await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.store.getBatchSummary(batch.id)!.status).toBe('paused'); expect(f.post).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce()
  })
  it.each(['cancel', 'switch', 'pause'] as const)('does not continue after %s during an unresolved read', async action => {
    const f = fixture(); const id = seed(f, policy('verify_then_pause'), true)
    let finish!: (result: CommentVerificationResult) => void
    f.verify.mockReturnValue(new Promise(resolve => { finish = resolve })); f.queue.verify(id)
    expect(() => f.queue.setFailurePolicy(id, policy('skip'))).toThrow()
    if (action === 'cancel') f.queue.cancel(id)
    else if (action === 'switch') { f.store.setActiveAccountId(B); f.queue.pauseForAccountChange(A) }
    else f.queue.pause(id)
    finish({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 }); await vi.advanceTimersByTimeAsync(100000)
    expect(f.post).not.toHaveBeenCalled(); expect(f.store.getBatchSummary(id)!.uncertain).toBe(1); expect(f.store.getBatchSummary(id)!.status).toBe(action === 'cancel' ? 'cancelled' : 'paused')
  })
  it('guards a live skip-policy worker even when an account switch omits the normal pause notification', async () => {
    const f = fixture(); let finish!: () => void
    f.post.mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = () => reject(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic delayed result')) }))
    const batch = f.queue.start({ ...f.input, failurePolicy: policy('skip') })
    f.store.setActiveAccountId(B); finish(); await vi.advanceTimersByTimeAsync(100000)
    expect(f.post).toHaveBeenCalledOnce(); expect(f.verify).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', stopCode: 'ACCOUNT_CHANGED', pending: 1, uncertain: 1 })
  })
})
