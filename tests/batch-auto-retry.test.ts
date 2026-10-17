import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import { DomainError } from '../src/shared/domain'

const accountId = '76561198000000001'
const resources: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []
const cipher: SecretCipher = { isAvailable: () => false, backend: () => 'fixture', encrypt: value => Buffer.from(value), decrypt: value => value.toString() }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z')); vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(async () => {
  for (const item of resources) item.queue.shutdown()
  await vi.advanceTimersByTimeAsync(0)
  for (const { directory, store } of resources.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) }
  vi.restoreAllMocks(); vi.useRealTimers()
})

function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-automatic-retry-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  store.upsertAccount({ id: accountId, steamId: accountId, accountName: 'Synthetic', displayName: 'Synthetic', avatarUrl: '',
    createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
  const ids = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(accountId, ids.map(steamId => ({ accountId, steamId, displayName: 'Synthetic friend', avatarUrl: '',
    profileUrl: '', onlineState: 'offline', syncedAt: new Date().toISOString() })))
  const post = vi.fn<(account: string, friend: string, message: string) => Promise<{ commentId: string | null }>>()
    .mockResolvedValue({ commentId: 'synthetic-result' })
  const steam = { isAuthenticated: vi.fn(() => true), ensureSessionFresh: vi.fn(async () => undefined),
    verifyCommentSession: vi.fn<() => Promise<void>>(async () => undefined), postProfileComment: post }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  resources.push({ directory, store, queue })
  const input = { accountId, friendSteamIds: ids, messageTemplate: 'Synthetic message', delayMs: 100 }
  return { store, queue, post, steam, input }
}

describe('automatic recovery through the durable sending queue', () => {
  it.each([true, false])('stops an unresolved POST denial with auto mode %s without retrying it or advancing recipients', async autoRetryEnabled => {
    const { queue, store, post, steam, input } = fixture(3)
    const message = 'Steam 拒绝响应但发送结果待核对，防重复不自动重发'
    post.mockRejectedValueOnce(new DomainError('COMMENT_POST_UNCERTAIN', message, true, 300_000))
    const task = queue.start({ ...input, autoRetryEnabled })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      stopMessage: message, pending: 2, uncertain: 1, failedCount: 0, sending: 0,
      completed: 1, retryCount: 0, nextRetryAt: null, accessDeniedCount: 0 })
    const deliveries = store.getBatch(task.id)!.deliveries
    expect(deliveries.filter(delivery => delivery.status === 'uncertain')).toEqual([
      expect.objectContaining({ friendSteamId: post.mock.calls[0]![1], error: message })
    ])
    expect(deliveries.filter(delivery => delivery.status === 'pending')).toHaveLength(2)
    queue.setAutoRetry(task.id, false)
    queue.setAutoRetry(task.id, true)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(steam.verifyCommentSession).not.toHaveBeenCalled()
    expect(store.getBatchSummary(task.id)?.nextRetryAt).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the final unresolved POST paused with its reason instead of reporting the task completed', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValueOnce(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic final POST awaiting review'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      stopMessage: 'Synthetic final POST awaiting review', uncertain: 1, pending: 0, finishedAt: null, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
  })

  it('resumes only other pending recipients after an explicit manual resume from an unresolved POST', async () => {
    const { queue, store, post, input } = fixture(3)
    post.mockRejectedValueOnce(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic HTTP 403 outcome unknown'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    const uncertainRecipient = post.mock.calls[0]![1]
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(200)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls.filter(call => call[1] === uncertainRecipient)).toHaveLength(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', uncertain: 1, succeeded: 2, pending: 0 })
  })

  it.each(['pause-resume', 'session-expiry', 'manual-pause', 'cancel'] as const)
  ('settles a late unresolved POST safely after %s without any automatic next delivery', async action => {
    const { queue, store, post, input } = fixture()
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_yes, no) => { reject = no }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'pause-resume') { queue.pause(task.id); queue.resume(task.id) }
    if (action === 'session-expiry') queue.pauseForSessionExpiry(accountId)
    if (action === 'manual-pause') queue.pause(task.id)
    if (action === 'cancel') queue.cancel(task.id)
    reject(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic late POST outcome unknown'))
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'paused',
      uncertain: 1, pending: action === 'cancel' ? 0 : 1, nextRetryAt: null, sending: 0 })
    if (action === 'pause-resume' || action === 'session-expiry') {
      expect(store.getBatchSummary(task.id)?.stopCode).toBe('UNCERTAIN_RESULT')
    }
    if (action === 'manual-pause') expect(store.getBatchSummary(task.id)?.stopCode).toBe('MANUAL_PAUSE')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not replace an unresolved POST review stop with a previous access-denied circuit message', async () => {
    const { queue, store, post, input } = fixture()
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_yes, no) => { reject = no }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    store.recordBatchAccessDenied(task.id)
    store.recordBatchAccessDenied(task.id)
    reject(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic POST may already exist'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      stopMessage: 'Synthetic POST may already exist', pending: 1, uncertain: 1, accessDeniedCount: 2, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
  })

  it('cancels the busy session-recovery poll when the original in-flight POST becomes uncertain', async () => {
    const { queue, store, post, steam, input } = fixture()
    let rejectPost!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_yes, no) => { rejectPost = no }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pauseForSessionExpiry(accountId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    rejectPost(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic unresolved POST during recovery'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      pending: 1, uncertain: 1, nextRetryAt: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains unresolved POST outcomes across restart and never restores an automatic plan', async () => {
    const { queue, store, post, steam, input } = fixture()
    post.mockRejectedValueOnce(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic POST awaiting manual review'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    const item = resources.find(resource => resource.store === store)!
    queue.shutdown()
    store.close()
    const reopened = new SqliteStore(join(item.directory, 'fixture.sqlite3'), cipher)
    item.store = reopened
    item.queue = new BatchQueue(reopened, steam as unknown as SteamService, () => undefined)
    expect(reopened.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'APP_RESTARTED',
      pending: 1, uncertain: 1, nextRetryAt: null, stopMessage: expect.stringContaining('Synthetic POST awaiting manual review') })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
  })

  it.each([true, false])('still persists a late 429 cooldown when switching auto mode to %s during a POST', async enabled => {
    const { queue, store, post, input } = fixture()
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start({ ...input, autoRetryEnabled: !enabled })
    await vi.advanceTimersByTimeAsync(0)
    queue.setAutoRetry(task.id, enabled)
    reject(new DomainError('RATE_LIMITED', 'Synthetic HTTP 429', true, 180_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'RATE_LIMITED', autoRetryEnabled: enabled })
    expect(Boolean(store.getBatchSummary(task.id)?.nextRetryAt)).toBe(enabled)
    await vi.advanceTimersByTimeAsync(179_999)
    expect(post).toHaveBeenCalledTimes(1)
    if (!enabled) expect(store.getBatchSummary(task.id)?.pending).toBe(1)
  })

  it('retains a preflight 429 reason and twenty-minute Retry-After without claiming a recipient', async () => {
    const { queue, store, post, steam, input } = fixture()
    steam.ensureSessionFresh.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic preflight HTTP 429', true, 1_200_000))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 2, stopCode: 'RATE_LIMITED',
      stopMessage: 'Synthetic preflight HTTP 429', nextRetryAt: '2026-10-16T00:20:00.000Z' })
    await vi.advanceTimersByTimeAsync(1_199_999)
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps a planned retry count when an older POST succeeds during a separate session pause', async () => {
    const { queue, store, post, input } = fixture()
    let finish!: (value: { commentId: string }) => void
    post.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pauseForSessionExpiry(accountId)
    finish({ commentId: 'synthetic-known-success' })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', succeeded: 1, pending: 1, retryCount: 1 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 2 })
    expect(post.mock.calls[1]![1]).not.toBe(post.mock.calls[0]![1])
  })
  it('defaults new tasks to enabled and retries a definite 403 rejection after five minutes', async () => {
    const { queue, store, post, input } = fixture()
    post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', autoRetryEnabled: true,
      pending: 2, failedCount: 0, retryCount: 1, stopCode: 'ACCESS_DENIED', nextRetryAt: '2026-10-16T00:05:00.000Z' })
    await vi.advanceTimersByTimeAsync(299_999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(101)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[0]![1]).toBe(post.mock.calls[1]![1])
    expect(post.mock.calls[2]![1]).not.toBe(post.mock.calls[1]![1])
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 2, failedCount: 0, pending: 0 })
  })

  it('never retries earlier than a server Retry-After hint', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic HTTP 429', true, 90_000))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)?.nextRetryAt).toBe('2026-10-16T00:01:30.000Z')
    await vi.advanceTimersByTimeAsync(89_999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 1 })
  })

  it('skips an uncertain submitted result and resumes only a different pending recipient', async () => {
    const { queue, store, post, input } = fixture()
    post.mockRejectedValueOnce(new TypeError('fetch failed'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', uncertain: 1, pending: 1, stopCode: 'NETWORK_ERROR' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).not.toBe(post.mock.calls[0]![1])
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', uncertain: 1, succeeded: 1 })
  })

  it('opens a durable circuit after one automatic retry of a persistent denial', async () => {
    const { queue, store, post, steam, input } = fixture(1)
    post.mockRejectedValue(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(post).toHaveBeenCalledTimes(2)
    expect(steam.verifyCommentSession).toHaveBeenCalledExactlyOnceWith(accountId)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 1, retryCount: 1,
      accessDeniedCount: 2, stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('retains a definite denied recipient even with automatic retries disabled', async () => {
    const { queue, store, post, input } = fixture()
    post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 2, failedCount: 0,
      accessDeniedCount: 1, accessDeniedUntil: '2026-10-16T00:05:00.000Z', nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not erase a denial budget through manual resume or retry mode changes', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValue(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.setAutoRetry(task.id, false)
    queue.pause(task.id)
    queue.setAutoRetry(task.id, true)
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
    await vi.advanceTimersByTimeAsync(300_000)
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 1, accessDeniedCount: 2,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
    await vi.advanceTimersByTimeAsync(300_000)
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 1, accessDeniedCount: 3,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('honors a longer 403 server cooldown for manual and automatic resumes', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403', true, 1_200_000))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedUntil: '2026-10-16T00:20:00.000Z',
      nextRetryAt: '2026-10-16T00:20:00.000Z' })
    await vi.advanceTimersByTimeAsync(1_199_999)
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 1,
      accessDeniedCount: 0, accessDeniedUntil: null })
  })

  it('enforces a late POST rejection cooldown after a user paused and resumed the in-flight worker', async () => {
    const { queue, store, post, input } = fixture()
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pause(task.id)
    queue.resume(task.id)
    reject(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic late HTTP 403'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 2,
      accessDeniedCount: 1, nextRetryAt: '2026-10-16T00:05:00.000Z' })
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(101)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 2 })
  })

  it('does not consume the independent POST denial budget on earlier network failures', async () => {
    const { queue, store, post, input } = fixture(3)
    post.mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
      .mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ uncertain: 1, pending: 2, retryCount: 2,
      accessDeniedCount: 1, stopCode: 'ACCESS_DENIED', nextRetryAt: '2026-10-16T00:06:00.000Z' })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[1]![1]).toBe(post.mock.calls[2]![1])
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 2, pending: 2,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
  })

  it('does not turn a refused protected GET into another comment POST', async () => {
    const { queue, store, post, steam, input } = fixture()
    post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    steam.verifyCommentSession.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic protected GET 403', true, 1_200_000))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 2, accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T00:25:00.000Z', stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    expect(store.getBatchSummary(task.id)?.stopMessage).toContain('尚未提交新留言')
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
  })

  it('keeps a POST denial budget through a failed read-only rate-limit check', async () => {
    const { queue, store, post, steam, input } = fixture()
    post.mockRejectedValue(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    steam.verifyCommentSession.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic protected GET 429', true, 600_000))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1, stopCode: 'RATE_LIMITED',
      nextRetryAt: '2026-10-16T00:15:00.000Z' })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 2, accessDeniedCount: 2,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
  })

  it.each(['pause', 'cancel', 'switch', 'shutdown'] as const)
  ('discards a late read-only recovery check after %s', async action => {
    const { queue, store, post, steam, input } = fixture()
    post.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    let resolve!: () => void
    steam.verifyCommentSession.mockReturnValueOnce(new Promise<void>(done => { resolve = done }))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(steam.verifyCommentSession).toHaveBeenCalledTimes(1)
    if (action === 'pause') queue.pause(task.id)
    if (action === 'cancel') queue.cancel(task.id)
    if (action === 'switch') vi.spyOn(store, 'getActiveAccountId').mockReturnValue('other-fixture-account')
    if (action === 'shutdown') queue.shutdown()
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getBatchSummary(task.id)?.status).not.toBe('running')
    expect(store.getBatchSummary(task.id)?.sending).toBe(0)
  })

  it.each(['pause', 'cancel', 'disable'] as const)('revokes scheduled recovery on user %s', async action => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValueOnce(new DomainError('RATE_LIMITED', 'Synthetic HTTP 429'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'pause') queue.pause(task.id)
    else if (action === 'cancel') queue.cancel(task.id)
    else queue.setAutoRetry(task.id, false)
    expect(store.getBatchSummary(task.id)?.nextRetryAt).toBeNull()
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(1)
    if (action === 'pause') expect(store.getBatchSummary(task.id)?.stopCode).toBe('MANUAL_PAUSE')
  })
})
