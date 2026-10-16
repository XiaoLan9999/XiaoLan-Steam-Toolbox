import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import type { SteamService } from '../src/main/steam-service'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import { DomainError } from '../src/shared/domain'

const accountId = '76561198000000001'
const resources: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []
const cipher: SecretCipher = {
  isAvailable: () => false, backend: () => 'fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-16T00:00:00.000Z')
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(async () => {
  for (const resource of resources) resource.queue.shutdown()
  await vi.advanceTimersByTimeAsync(0)
  for (const { directory, store } of resources.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture(count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-access-denied-review-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  store.upsertAccount({ id: accountId, steamId: accountId, accountName: 'Synthetic', displayName: 'Synthetic',
    avatarUrl: '', createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
  const ids = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(accountId, ids.map(steamId => ({ accountId, steamId, displayName: 'Synthetic friend',
    avatarUrl: '', profileUrl: '', onlineState: 'offline', syncedAt: new Date().toISOString() })))
  const steam = {
    isAuthenticated: vi.fn(() => true),
    ensureSessionFresh: vi.fn<() => Promise<void>>(async () => undefined),
    verifyCommentSession: vi.fn<() => Promise<void>>(async () => undefined),
    postProfileComment: vi.fn<() => Promise<{ commentId: string | null }>>()
      .mockResolvedValue({ commentId: 'synthetic-comment' })
  }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  resources.push({ directory, store, queue })
  return { store, queue, steam,
    input: { accountId, friendSteamIds: ids, messageTemplate: 'Synthetic message', delayMs: 100 } }
}

describe('independent access-denial recovery regression review', () => {
  it.each(['maintenance', 'protected-check'] as const)
  ('persists a longer GET 403 hint from %s without claiming another POST attempt', async source => {
    const { store, queue, steam, input } = fixture()
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic POST 403'))
    const rejection = new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic GET 403', true, 1_200_000)
    if (source === 'maintenance') steam.ensureSessionFresh.mockResolvedValueOnce().mockRejectedValueOnce(rejection)
    else steam.verifyCommentSession.mockRejectedValueOnce(rejection)
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', accessDeniedCount: 1,
      accessDeniedUntil: '2026-10-16T00:25:00.000Z', stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null,
      pending: 1, sending: 0, failedCount: 0 })
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(steam.verifyCommentSession).toHaveBeenCalledWith(accountId)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(2)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 1,
      accessDeniedCount: 0, accessDeniedUntil: null })
  })

  it.each(['maintenance', 'protected-check'] as const)
  ('does not turn a maximum-date %s rejection into an overflowing timer', async source => {
    const { store, queue, steam, input } = fixture()
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic POST 403'))
    const rejection = new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic GET 403', true, Number.MAX_SAFE_INTEGER)
    if (source === 'maintenance') steam.ensureSessionFresh.mockResolvedValueOnce().mockRejectedValueOnce(rejection)
    else steam.verifyCommentSession.mockRejectedValueOnce(rejection)
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '+275760-09-13T00:00:00.000Z', nextRetryAt: null, stopCode: 'ACCESS_DENIED_PERSISTENT' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
  })

  it('retains the maximum-date POST cooldown without scheduling a short overflow timer', async () => {
    const { store, queue, steam, input } = fixture()
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED',
      'Synthetic POST 403', true, Number.MAX_SAFE_INTEGER))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(task.id)).toMatchObject({ accessDeniedCount: 1,
      accessDeniedUntil: '+275760-09-13T00:00:00.000Z', nextRetryAt: null, pending: 1 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
    expect(() => queue.resume(task.id)).toThrow('HTTP 403 冷却尚未结束')
  })

  it.each([
    ['protected-check', 'pause'], ['protected-check', 'cancel'], ['protected-check', 'shutdown'],
    ['maintenance', 'pause'], ['maintenance', 'cancel'], ['maintenance', 'shutdown']
  ] as const)('does not persist a late %s GET 403 hint after %s', async (source, action) => {
    const { store, queue, steam, input } = fixture()
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic POST 403'))
    let reject!: (error: Error) => void
    const deferred = new Promise<void>((_resolve, no) => { reject = no })
    if (source === 'maintenance') steam.ensureSessionFresh.mockResolvedValueOnce().mockReturnValueOnce(deferred)
    else steam.verifyCommentSession.mockReturnValueOnce(deferred)
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_000)
    if (action === 'pause') queue.pause(task.id)
    else if (action === 'cancel') queue.cancel(task.id)
    else queue.shutdown()
    const extend = vi.spyOn(store, 'extendBatchAccessDeniedCooldown')
    const before = store.getBatchSummary(task.id)
    reject(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic late GET 403', true, 3_600_000))
    await vi.advanceTimersByTimeAsync(0)
    expect(extend).not.toHaveBeenCalled()
    expect(store.getBatchSummary(task.id)).toEqual(before)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
  })

  it.each(['network', 'target-rejection'] as const)
  ('does not reset a prior POST denial after an intervening %s result', async failure => {
    const { store, queue, steam, input } = fixture(2)
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic POST 403'))
      .mockRejectedValueOnce(failure === 'network' ? new TypeError('fetch failed') : new Error('Target comments disabled'))
      .mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic second POST 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(300_100)
    if (failure === 'network') await vi.advanceTimersByTimeAsync(120_000)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(3)
    expect(store.getBatchSummary(task.id)).toMatchObject({ pending: 1, succeeded: 0, accessDeniedCount: 2,
      stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    expect(steam.postProfileComment.mock.calls[0]).toEqual(steam.postProfileComment.mock.calls[1])
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(3)
  })

  it('awaits protected identity verification before a manual retry claims or posts a recipient', async () => {
    const { store, queue, steam, input } = fixture()
    steam.postProfileComment.mockRejectedValueOnce(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic POST 403'))
    const task = queue.start({ ...input, autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(300_000)
    let resolve!: () => void
    steam.verifyCommentSession.mockReturnValueOnce(new Promise<void>(done => { resolve = done }))
    queue.resume(task.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(steam.verifyCommentSession).toHaveBeenCalledExactlyOnceWith(accountId)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(1)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'running', pending: 1, sending: 0, accessDeniedCount: 1 })
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(steam.postProfileComment).toHaveBeenCalledTimes(2)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'completed', succeeded: 1, accessDeniedCount: 0 })
  })
})
