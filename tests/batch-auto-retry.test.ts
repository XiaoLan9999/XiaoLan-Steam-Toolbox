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
  const steam = { isAuthenticated: vi.fn(() => true), ensureSessionFresh: vi.fn(async () => undefined), postProfileComment: post }
  const queue = new BatchQueue(store, steam as unknown as SteamService, () => undefined)
  resources.push({ directory, store, queue })
  const input = { accountId, friendSteamIds: ids, messageTemplate: 'Synthetic message', delayMs: 100 }
  return { store, queue, post, steam, input }
}

describe('automatic recovery through the durable sending queue', () => {
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

  it('stops after five consecutive automatic attempts instead of hammering a persistent denial', async () => {
    const { queue, store, post, input } = fixture(1)
    post.mockRejectedValue(new DomainError('COMMUNITY_ACCESS_DENIED', 'Synthetic HTTP 403'))
    const task = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [300_000, 600_000, 900_000, 1_800_000, 3_600_000]) await vi.advanceTimersByTimeAsync(delay)
    expect(post).toHaveBeenCalledTimes(6)
    expect(store.getBatchSummary(task.id)).toMatchObject({ status: 'paused', pending: 1, retryCount: 5,
      stopCode: 'RETRY_EXHAUSTED', nextRetryAt: null })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(post).toHaveBeenCalledTimes(6)
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
