import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import { DomainError } from '../src/shared/domain'
import { CommentPreflightError } from '../src/shared/comment-preflight'
import type { AppEvent, BatchStopCode } from '../src/shared/types'

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
  const events: AppEvent[] = []
  const queue = new BatchQueue(store, steam as unknown as SteamService, event => events.push(event))
  resources.push({ directory, store, queue })
  const input = { accountId, friendSteamIds: ids, messageTemplate: 'Synthetic message', delayMs: 100 }
  return { store, queue, post, steam, input, events }
}

describe('automatic recovery through the durable sending queue', () => {
  it.each([
    ['NETWORK_ERROR', false, 'skip'], ['NETWORK_ERROR', true, 'skip'],
    ['NETWORK_ERROR', false, 'pause'], ['NETWORK_ERROR', true, 'pause'],
    ['SERVER_ERROR', false, 'skip'], ['SERVER_ERROR', true, 'skip'],
    ['SERVER_ERROR', false, 'pause'], ['SERVER_ERROR', true, 'pause']
  ] as const)('always skips a proven unsubmitted %s failure with auto retry %s and ordinary policy %s', async (code, autoRetryEnabled, definiteFailure) => {
    const { queue, store, post, input, events } = fixture()
    post.mockRejectedValueOnce(new CommentPreflightError('Synthetic request failure; no comment submitted',
      { code, canRetry: true, rejectedBeforeAcceptance: true }))
    const task = queue.start({ ...input, autoRetryEnabled,
      failurePolicy: { definiteFailure, uncertainResult: 'verify_then_pause' } })
    await vi.advanceTimersByTimeAsync(0)
    const skipped = post.mock.calls[0]![1]
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', completed: 1, failedCount: 1,
      pending: 1, uncertain: 0, retryCount: 0, nextRetryAt: null, accessDeniedCount: 0 })
    const record = store.getBatch(task.id)!.deliveries.find(item => item.friendSteamId === skipped)!
    expect(record).toMatchObject({ status: 'failed', error: expect.stringMatching(/^已跳过（未发送）：/) })
    expect(store.getDeliveryCommentEvidence(record.id)).toBeNull()
    expect(store.getFriendPolicies(accountId).find(item => item.steamId === skipped)?.commentStatus).toBe('unknown')
    expect(events).toContainEqual(expect.objectContaining({ type: 'friendPolicyChanged',
      policy: expect.objectContaining({ accountId, steamId: skipped, commentStatus: 'unknown' }) }))
    await vi.advanceTimersByTimeAsync(99)
    expect(post).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).not.toBe(skipped)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', failedCount: 1,
      sentVerified: 1, uncertain: 0, pending: 0, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it.each(['freshness', 'legacy-verification'] as const)('skips only the current unsent recipient when %s has a network failure', async phase => {
    const { queue, store, post, steam, input } = fixture()
    let task
    if (phase === 'freshness') {
      steam.ensureSessionFresh.mockRejectedValueOnce(Object.assign(new Error('Resolver failure'), { code: 'ENOTFOUND' }))
      task = queue.start({ ...input, failurePolicy: { definiteFailure: 'pause', uncertainResult: 'verify_then_pause' } })
    } else {
      task = store.createBatchTask(accountId, input.messageTemplate, input.delayMs,
        input.friendSteamIds.map(friendSteamId => ({ friendSteamId, friendName: 'Synthetic friend', renderedMessage: 'Synthetic message' })),
        false, { definiteFailure: 'pause', uncertainResult: 'verify_then_pause' })
      store.recordBatchAccessDenied(task.id)
      store.pauseBatch(task.id, { code: 'ACCESS_DENIED', message: 'Synthetic legacy denial' })
      vi.setSystemTime(Date.now() + 300_001)
      steam.verifyCommentSession.mockRejectedValueOnce(new TypeError('fetch failed'))
      queue.resume(task.id)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(post).not.toHaveBeenCalled()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', completed: 1, failedCount: 1,
      pending: 1, uncertain: 0, nextRetryAt: null })
    const skipped = store.getBatch(task.id)!.deliveries.find(item => item.status === 'failed')!
    expect(skipped.error).toContain('已跳过（未发送）')
    expect(store.getDeliveryCommentEvidence(skipped.id)).toBeNull()
    await vi.advanceTimersByTimeAsync(99)
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledOnce()
    expect(post.mock.calls[0]![1]).not.toBe(skipped.friendSteamId)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', failedCount: 1, sentVerified: 1 })
  })

  it.each(['skip', 'verify_then_skip', 'verify_then_pause'] as const)
  ('skips an ambiguous submitted network failure without another read or POST under %s', async uncertainResult => {
    const { queue, store, post, steam, input } = fixture()
    const verify = vi.fn<SteamService['reconcileProfileComment']>().mockRejectedValue(new Error('Unexpected extra GET'))
    Object.assign(steam, { reconcileProfileComment: verify })
    post.mockRejectedValueOnce(new TypeError('fetch failed'))
    const task = queue.start({ ...input, failurePolicy: { definiteFailure: 'pause', uncertainResult } })
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', uncertain: 1, failedCount: 0,
      sentVerified: 1, pending: 0, verification: { state: 'unresolved', attempt: 0, nextCheckAt: null } })
    expect(verify).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(2)
    expect(new Set(post.mock.calls.map(call => call[1])).size).toBe(2)
    const uncertain = store.getBatch(task.id)!.deliveries.find(item => item.status === 'uncertain')!
    expect(uncertain.error).toContain('发送结果待核对')
    expect(store.getFriendPolicies(accountId).find(item => item.steamId === uncertain.friendSteamId)?.commentStatus).toBe('unknown')
  })

  it('does not replace a known blocked availability with an inconclusive network failure', async () => {
    const { queue, store, post, input } = fixture()
    post.mockImplementationOnce(async (_account, steamId) => {
      store.recordFriendCommentAvailability(accountId, steamId, { status: 'blocked', reason: 'Synthetic explicit restriction' })
      throw new CommentPreflightError('Synthetic request failure', { code: 'NETWORK_ERROR', canRetry: true, rejectedBeforeAcceptance: true })
    })
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getBatchSummary(task.id)?.status).toBe('completed')
    expect(store.getFriendPolicies(accountId).find(item => item.steamId === post.mock.calls[0]![1]))
      .toMatchObject({ commentStatus: 'blocked', commentReason: 'Synthetic explicit restriction' })
  })

  it('does not swallow a network-shaped storage error after the POST returned successfully', async () => {
    const { queue, store, post, input } = fixture()
    vi.spyOn(store, 'completeDelivery').mockImplementationOnce(() => { throw new Error('Synthetic network storage error') })
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'QUEUE_ERROR',
      pending: 1, uncertain: 1, verification: null })
  })

  it.each([true, false])('defaults to skipping an unreadable unsubmitted recipient with auto retry %s while preserving cadence', async autoRetryEnabled => {
    const { queue, store, post, input, events } = fixture(3)
    post.mockRejectedValueOnce(new CommentPreflightError('资料页未提供可核验的目标评论区，暂不能确定留言权限；尚未提交留言，当前好友保留待发',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    const task = queue.start({ ...input, autoRetryEnabled })
    await vi.advanceTimersByTimeAsync(0)
    const skipped = post.mock.calls[0]![1]
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', completed: 1, failedCount: 1,
      pending: 2, uncertain: 0, autoRetryEnabled, retryCount: 0, nextRetryAt: null, accessDeniedCount: 0 })
    const record = store.getBatch(task.id)!.deliveries.find(delivery => delivery.friendSteamId === skipped)!
    expect(record).toMatchObject({ status: 'failed', error: '已跳过（未发送）：资料页未提供可核验的目标评论区，暂不能确定留言权限' })
    expect(record.error).not.toContain('保留待发')
    expect(store.getDeliveryCommentEvidence(record.id)).toBeNull()
    expect(events.filter(event => event.type === 'notice')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(99)
    expect(post).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).not.toBe(skipped)
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls.filter(call => call[1] === skipped)).toHaveLength(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', sentVerified: 2,
      failedCount: 1, uncertain: 0, pending: 0, sending: 0, retryCount: 0, nextRetryAt: null })
  })

  it('retains the configured jitter between unreadable recipients and completes an all-skipped task', async () => {
    const { queue, store, post, steam, input } = fixture(3)
    vi.mocked(Math.random).mockReturnValue(0.5)
    post.mockRejectedValue(new CommentPreflightError('目标评论区内容不完整或结构无法可靠解析；尚未提交留言，当前好友保留待发',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(1599)
    expect(post).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(post).toHaveBeenCalledTimes(3)
    expect(new Set(post.mock.calls.map(call => call[1])).size).toBe(3)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', completed: 3,
      sentVerified: 0, failedCount: 3, uncertain: 0, pending: 0, sending: 0, nextRetryAt: null })
    for (const delivery of store.getBatch(task.id)!.deliveries) {
      expect(delivery).toMatchObject({ status: 'failed', error: '已跳过（未发送）：目标评论区内容不完整或结构无法可靠解析' })
      expect(store.getDeliveryCommentEvidence(delivery.id)).toBeNull()
    }
    const completed = store.getBatch(task.id)!
    const resource = resources.find(item => item.store === store)!
    queue.shutdown()
    store.close()
    const reopened = new SqliteStore(join(resource.directory, 'fixture.sqlite3'), cipher)
    resource.store = reopened
    resource.queue = new BatchQueue(reopened, steam as unknown as SteamService, () => undefined)
    expect(reopened.getBatch(task.id)).toEqual(completed)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('can change an explicitly paused baseline to skip without automatically starting the task', async () => {
    const { queue, store, post, input } = fixture()
    const failure = new CommentPreflightError('Synthetic incomplete baseline; no comment submitted',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true })
    post.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
    const task = queue.start({ ...input, autoRetryEnabled: false,
      failurePolicy: { definiteFailure: 'pause', uncertainResult: 'verify_then_skip' } })
    await vi.advanceTimersByTimeAsync(0)
    const first = post.mock.calls[0]![1]
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 2,
      stopCode: 'COMMENT_BASELINE', failedCount: 0, uncertain: 0 })
    queue.setFailurePolicy(task.id, { definiteFailure: 'skip', uncertainResult: 'verify_then_skip' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(post).toHaveBeenCalledOnce()
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[1]![1]).toBe(first)
    expect(post.mock.calls[2]![1]).not.toBe(first)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', failedCount: 1,
      sentVerified: 1, uncertain: 0, pending: 0 })
  })

  it.each(['pause', 'cancel', 'account-change', 'shutdown'] as const)
  ('does not consume a late unreadable baseline after %s even under the default skip policy', async action => {
    const { queue, store, post, input } = fixture(1)
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'pause') queue.pause(task.id)
    if (action === 'cancel') queue.cancel(task.id)
    if (action === 'account-change') queue.pauseForAccountChange(accountId)
    if (action === 'shutdown') queue.shutdown()
    reject(new CommentPreflightError('Synthetic stale unreadable baseline',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'paused',
      sending: 0, pending: action === 'cancel' ? 0 : 1, cancelled: action === 'cancel' ? 1 : 0,
      failedCount: 0, uncertain: 0, completed: action === 'cancel' ? 1 : 0, nextRetryAt: null })
  })

  it('uses a new baseline after pause/resume rather than skipping a stale unreadable result', async () => {
    const { queue, store, post, input } = fixture(1)
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(0)
    queue.pause(task.id)
    queue.resume(task.id)
    reject(new CommentPreflightError('Synthetic stale unreadable baseline',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).toBe(post.mock.calls[0]![1])
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', sentVerified: 1,
      failedCount: 0, uncertain: 0, pending: 0 })
  })

  it('does not misclassify a storage failure while saving an unsubmitted skip as an uncertain POST', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValueOnce(new CommentPreflightError('Synthetic unreadable baseline',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    vi.spyOn(store, 'completeDelivery').mockImplementationOnce(() => { throw new Error('Synthetic storage failure') })
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'QUEUE_ERROR',
      failedCount: 0, uncertain: 0, pending: 1, sending: 0, completed: 0, nextRetryAt: null })
  })

  it('retains an unsubmitted unreadable recipient if authentication disappears before the read settles', async () => {
    const { queue, store, post, steam, input } = fixture(1)
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(0)
    steam.isAuthenticated.mockReturnValue(false)
    reject(new CommentPreflightError('Synthetic unreadable baseline after sign-out',
      { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 1,
      sending: 0, failedCount: 0, uncertain: 0, completed: 0, nextRetryAt: null })
  })

  it.each(['COMMENT_BASELINE', 'RATE_LIMITED', 'ACCESS_DENIED',
    'SESSION_EXPIRED', 'SESSION_PREPARATION', 'SESSION_CHANGED', 'LOGIN_REQUIRED'] as BatchStopCode[])
  ('retains the unsent recipient and concrete %s cause without enabling automatic retries', async code => {
    const { queue, store, post, input } = fixture()
    post.mockRejectedValueOnce(new CommentPreflightError('Synthetic pre-send read failure; no comment submitted',
      { code, canRetry: true, rejectedBeforeAcceptance: true, retryAfterMs: 600_000 }))
    const task = queue.start({ ...input, autoRetryEnabled: false,
      ...(code === 'COMMENT_BASELINE' ? { failurePolicy: { definiteFailure: 'pause' as const, uncertainResult: 'verify_then_skip' as const } } : {}) })
    await vi.advanceTimersByTimeAsync(0)
    const target = post.mock.calls[0]![1]
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: code,
      pending: 2, sending: 0, completed: 0, failedCount: 0, uncertain: 0,
      autoRetryEnabled: false, retryCount: 0, nextRetryAt: null, accessDeniedCount: 0,
      activity: { current: null, nextPending: { friendSteamId: target, status: 'pending' } } })
    expect(store.getBatchSummary(task.id)?.stopMessage).toContain(`Synthetic friend (SteamID: ${target})`)
    expect(store.getBatchSummary(task.id)?.accessDeniedUntil).toBe(code === 'ACCESS_DENIED'
      ? '2026-10-16T00:10:00.000Z' : null)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
  })

  it('retries a proven pre-submit session check failure only when enabled and processes that pending recipient once', async () => {
    const { queue, store, post, input } = fixture()
    post.mockRejectedValueOnce(new CommentPreflightError('Synthetic network read failure; no comment submitted',
      { code: 'SESSION_PREPARATION', canRetry: true, rejectedBeforeAcceptance: true }))
    const task = queue.start({ ...input, autoRetryEnabled: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ stopCode: 'SESSION_PREPARATION', pending: 2,
      retryCount: 1, nextRetryAt: '2026-10-16T00:00:30.000Z' })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(post).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).toBe(post.mock.calls[0]![1])
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[2]![1]).not.toBe(post.mock.calls[0]![1])
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', sentVerified: 2,
      failedCount: 0, uncertain: 0 })
  })

  it('does not consume the POST denial budget when a baseline GET is denied repeatedly', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValue(new CommentPreflightError('Synthetic baseline HTTP 403; no comment submitted',
      { code: 'ACCESS_DENIED', canRetry: true, rejectedBeforeAcceptance: true }))
    const task = queue.start({ ...input, autoRetryEnabled: true })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', stopCode: 'ACCESS_DENIED',
      pending: 1, failedCount: 0, uncertain: 0, accessDeniedCount: 0, retryCount: 2,
      nextRetryAt: '2026-10-16T00:10:00.000Z', accessDeniedUntil: '2026-10-16T00:10:00.000Z' })
  })

  it.each(['pause', 'cancel', 'account-change', 'shutdown'] as const)
  ('does not schedule recovery or preserve a stale baseline denial after %s', async action => {
    const { queue, store, post, input } = fixture(1)
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    const task = queue.start({ ...input, autoRetryEnabled: true })
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'pause') queue.pause(task.id)
    if (action === 'cancel') queue.cancel(task.id)
    if (action === 'account-change') queue.pauseForAccountChange(accountId)
    if (action === 'shutdown') queue.shutdown()
    reject(new CommentPreflightError('Synthetic stale baseline GET 403; no comment submitted',
      { code: 'ACCESS_DENIED', canRetry: true, rejectedBeforeAcceptance: true }))
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledOnce()
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'paused',
      sending: 0, pending: action === 'cancel' ? 0 : 1, cancelled: action === 'cancel' ? 1 : 0,
      failedCount: 0, uncertain: 0, accessDeniedCount: 0, accessDeniedUntil: null, nextRetryAt: null })
  })

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
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', uncertain: 1, pending: 1, stopCode: null,
      verification: { state: 'unresolved', attempt: 0 }, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(100)
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
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ uncertain: 1, pending: 2, retryCount: 0,
      accessDeniedCount: 0, nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getBatchSummary(task.id)).toMatchObject({ uncertain: 1, pending: 2, retryCount: 1,
      accessDeniedCount: 1, stopCode: 'ACCESS_DENIED', nextRetryAt: '2026-10-16T00:05:00.100Z' })
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
