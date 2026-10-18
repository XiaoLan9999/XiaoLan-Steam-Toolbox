import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import type { CommentAttemptEvidence, CommentVerificationResult } from '../src/main/comment-reconciliation'
import { DomainError } from '../src/shared/domain'

const accountId = '76561198000000001'
const otherId = '76561198000000002'
const resources: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []
const cipher: SecretCipher = { isAvailable: () => false, backend: () => 'fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString() }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(async () => {
  for (const resource of resources) resource.queue.shutdown()
  await vi.advanceTimersByTimeAsync(500)
  for (const { store, directory } of resources.splice(0)) {
    store.close()
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('comment-verification-queue-')) {
      throw new Error('Unexpected fixture cleanup path')
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('read-only delivery verification and pending continuation', () => {
  it('saves attempt evidence, confirms a refused POST by GET, and sends only the next recipient', async () => {
    const f = fixture()
    f.post.mockImplementationOnce(async (_account, _friend, _message, _canSubmit, onEvidence) => {
      onEvidence?.(evidence())
      throw new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic response refusal')
    })
    const batch = f.queue.start(f.input)
    const order = f.store.getBatch(batch.id)!.deliveries.map(item => item.friendSteamId)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.verify.mock.calls[0]?.[3]).toEqual(evidence())
    expect(f.post.mock.calls.map(call => call[1])).toEqual(order)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', sentVerified: 2,
      uncertain: 0, pending: 0, verification: { state: 'confirmed', friendSteamId: order[0] } })
    expect(f.store.getBatch(batch.id)?.deliveries[0]).toMatchObject({ remoteCommentId: '7001',
      sentAt: new Date(1_791_000_000_000).toISOString() })
  })

  it('bounds read-only retries and leaves an unconfirmed recipient out of all later POSTs', async () => {
    const f = fixture()
    f.post.mockImplementationOnce(async (_account, _friend, _message, _canSubmit, onEvidence) => {
      onEvidence?.(evidence())
      throw new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic response refusal')
    })
    f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' })
    const batch = f.queue.start(f.input)
    const order = f.store.getBatch(batch.id)!.deliveries.map(item => item.friendSteamId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.store.getBatchSummary(batch.id)?.verification).toMatchObject({ state: 'waiting', attempt: 1 })
    expect(f.post).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.verify).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.verify).toHaveBeenCalledTimes(3)
    expect(f.post.mock.calls.map(call => call[1])).toEqual(order)
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', uncertain: 1,
      sentVerified: 1, verification: { state: 'unresolved', attempt: 3, nextCheckAt: null } })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.verify).toHaveBeenCalledTimes(3)
  })

  it('checks an old uncertain item once without invented evidence, skips it and resumes only pending', async () => {
    const f = fixture()
    const batchId = seedUncertain(f)
    const pendingId = f.store.getBatch(batchId)!.deliveries.find(item => item.status === 'pending')!.friendSteamId
    f.verify.mockResolvedValue({ status: 'unresolved', reason: 'missing-attempt-evidence' })
    f.queue.resume(batchId)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.verify.mock.calls[0]?.[3]).toBeNull()
    expect(f.post.mock.calls.map(call => call[1])).toEqual([pendingId])
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'completed', uncertain: 1,
      sentVerified: 1, verification: { state: 'unresolved' } })
  })

  it.each(['pause', 'cancel', 'switch'] as const)('does not continue after %s during a deferred read', async action => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    const read = deferred<CommentVerificationResult>()
    f.verify.mockReturnValue(read.promise)
    f.queue.verify(batchId)
    expect(f.queue.hasPendingRequests()).toBe(true)
    if (action === 'pause') f.queue.pause(batchId)
    else if (action === 'cancel') f.queue.cancel(batchId)
    else f.store.setActiveAccountId(otherId)
    read.resolve({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ uncertain: 1, sentVerified: 0,
      status: action === 'cancel' ? 'cancelled' : 'paused' })
    expect(f.store.getBatchSummary(batchId)?.verification?.state).toBe('unresolved')
    expect(f.queue.hasPendingRequests()).toBe(false)
  })

  it('stops its read-only wait promptly without an automatic resurrection', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    f.verify.mockResolvedValue({ status: 'unresolved', reason: 'no-new-matching-comment' })
    f.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.store.getBatchSummary(batchId)?.verification?.state).toBe('waiting')
    f.queue.pause(batchId)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'paused', stopCode: 'MANUAL_PAUSE',
      verification: { state: 'unresolved', nextCheckAt: null } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains duplicate verify clicks in one reader and one pending worker', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    const read = deferred<CommentVerificationResult>()
    f.verify.mockReturnValue(read.promise)
    f.queue.verify(batchId)
    f.queue.verify(batchId)
    expect(f.verify).toHaveBeenCalledOnce()
    read.resolve({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.post).toHaveBeenCalledOnce()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'completed', sentVerified: 2 })
  })

  it('can read during a POST cooldown but cannot bypass that cooldown to submit the next comment', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    f.store.recordBatchAccessDenied(batchId)
    const deadline = f.store.getBatchSummary(batchId)!.accessDeniedUntil
    f.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'paused', pending: 1,
      sentVerified: 1, accessDeniedUntil: deadline, stopCode: 'ACCESS_DENIED' })
  })

  it.each(['COMMUNITY_ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED'] as const)
    ('does not POST through a read-only %s error', async code => {
      const f = fixture()
      const batchId = seedUncertain(f, true)
      f.verify.mockRejectedValue(new DomainError(code, 'Synthetic read restriction', true, 60_000))
      f.queue.verify(batchId)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.post).not.toHaveBeenCalled()
      expect(f.verify).toHaveBeenCalledOnce()
      expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'paused', uncertain: 1, pending: 1,
        verification: { state: 'unresolved' } })
    })

  it('only reconciles completed tasks without reopening them or sending new comments', async () => {
    const f = fixture(1)
    const batchId = seedUncertain(f, true)
    f.store.finishBatchIfDone(batchId)
    expect(f.store.getBatchSummary(batchId)?.status).toBe('completed')
    f.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'completed', uncertain: 0,
      sentVerified: 1, verification: { state: 'confirmed' } })
  })

  it('completes a last confirmed record without getting stuck behind an irrelevant POST cooldown', async () => {
    const f = fixture(1)
    const batchId = seedUncertain(f, true)
    f.store.recordBatchAccessDenied(batchId)
    const deadline = f.store.getBatchSummary(batchId)!.accessDeniedUntil
    f.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'completed', uncertain: 0,
      pending: 0, sentVerified: 1, accessDeniedUntil: deadline, verification: { state: 'confirmed' } })
  })

  it.each([false, true])('invalidates a %s completed task check across an account switch back', async completed => {
    const f = fixture(completed ? 1 : 2)
    const batchId = seedUncertain(f, true)
    if (completed) f.store.finishBatchIfDone(batchId)
    const read = deferred<CommentVerificationResult>()
    f.verify.mockReturnValue(read.promise)
    f.queue.verify(batchId)
    f.queue.pauseForAccountChange(accountId)
    f.store.setActiveAccountId(otherId)
    f.store.setActiveAccountId(accountId)
    read.resolve({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: completed ? 'completed' : 'paused',
      uncertain: 1, sentVerified: 0, verification: { state: 'unresolved' } })
  })

  it('does not retry a cancelled SDK read against a replacement session', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    f.verify.mockRejectedValue(new DomainError('CHECK_CANCELLED', 'Synthetic replaced runtime'))
    f.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.store.getBatchSummary(batchId)).toMatchObject({ status: 'paused', stopCode: 'SESSION_CHANGED',
      uncertain: 1, pending: 1, verification: { state: 'unresolved' } })
  })

  it('pauses a running worker if its automatic verification loses the SDK session', async () => {
    const f = fixture()
    f.post.mockRejectedValueOnce(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic response refusal'))
    f.verify.mockRejectedValue(new DomainError('CHECK_CANCELLED', 'Synthetic replaced runtime'))
    const batch = f.queue.start(f.input)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.post).toHaveBeenCalledOnce()
    expect(f.store.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', stopCode: 'SESSION_CHANGED',
      uncertain: 1, pending: 1, verification: { state: 'unresolved' } })
  })

  it('ignores a late read after shutdown and database closure', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    const read = deferred<CommentVerificationResult>()
    f.verify.mockReturnValue(read.promise)
    f.queue.verify(batchId)
    f.queue.shutdown()
    const reads = vi.spyOn(f.store, 'getBatchSummary')
    f.store.close()
    resources.find(item => item.store === f.store)!.store = new SqliteStore(join(f.directory, 'fixture.sqlite3'), cipher)
    read.resolve({ status: 'confirmed', commentId: '7001', postedAtSeconds: 1_791_000_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).not.toHaveBeenCalled()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.queue.hasPendingRequests()).toBe(false)
  })

  it('retains submission evidence across restart without replaying the uncertain recipient', async () => {
    const f = fixture()
    const batchId = seedUncertain(f, true)
    const pendingId = f.store.getBatch(batchId)!.deliveries.find(item => item.status === 'pending')!.friendSteamId
    f.queue.shutdown()
    f.store.close()
    const resource = resources.find(item => item.store === f.store)!
    resource.store = new SqliteStore(join(resource.directory, 'fixture.sqlite3'), cipher)
    resource.queue = new BatchQueue(resource.store, f.steam as unknown as SteamService, () => undefined)
    expect(resource.store.getDeliveryCommentEvidence(resource.store.getNextUncertainDelivery(batchId)!.id)).toEqual(evidence())
    resource.queue.verify(batchId)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.post.mock.calls.map(call => call[1])).toEqual([pendingId])
    expect(resource.store.getBatchSummary(batchId)).toMatchObject({ status: 'completed', sentVerified: 2 })
  })
})

function evidence(): CommentAttemptEvidence {
  return { baselineIds: ['5001'], serverWindow: { earliest: 1_790_999_998, latest: 1_791_000_050 },
    submittedAt: new Date(1_791_000_000_000).toISOString() }
}

function seedUncertain(f: ReturnType<typeof fixture>, withEvidence = false): string {
  const batch = f.store.createBatchTask(accountId, f.input.messageTemplate, f.input.delayMs,
    f.friendIds.map((friendSteamId, index) => ({ friendSteamId, friendName: `Friend ${index}`,
      renderedMessage: `Hello Friend ${index}` })), false)
  f.store.setBatchRunning(batch.id)
  const delivery = f.store.takeNextDelivery(batch.id)!
  if (withEvidence) f.store.saveDeliveryCommentEvidence(delivery.id, evidence())
  f.store.completeDelivery(delivery.id, 'uncertain', { error: 'Synthetic unresolved result' })
  f.store.pauseBatch(batch.id, { code: 'UNCERTAIN_RESULT', message: 'Synthetic review needed' })
  return batch.id
}

function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'comment-verification-queue-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  for (const id of [accountId, otherId]) store.upsertAccount({ id, steamId: id, accountName: 'synthetic',
    displayName: 'Sender', avatarUrl: '', createdAt: new Date().toISOString(), lastLoginAt: null,
    lastFriendSyncAt: null, lastEmoticonSyncAt: null })
  store.setActiveAccountId(accountId)
  const friendIds = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(accountId, friendIds.map((steamId, index) => ({ accountId, steamId,
    displayName: `Friend ${index}`, avatarUrl: '', profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline', syncedAt: new Date().toISOString() })))
  const post = vi.fn<SteamService['postProfileComment']>().mockResolvedValue({ commentId: '8001' })
  const verify = vi.fn<SteamService['reconcileProfileComment']>().mockResolvedValue({ status: 'confirmed',
    commentId: '7001', postedAtSeconds: 1_791_000_000 })
  const steam = { isAuthenticated: vi.fn(() => true), postProfileComment: post, reconcileProfileComment: verify }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  resources.push({ directory, store, queue })
  return { directory, queue, store, post, verify, steam, friendIds, input: { accountId, friendSteamIds: friendIds,
    messageTemplate: 'Hello {friend}', delayMs: 100, autoRetryEnabled: false } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
