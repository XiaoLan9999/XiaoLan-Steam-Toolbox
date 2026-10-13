import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue, classifyDeliveryError } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import { DomainError } from '../src/shared/domain'
import type { AppEvent, BatchStartInput } from '../src/shared/types'

const accountId = '76561198000000001'
const fixtures: Array<{ directory: string; store: SqliteStore; queue: BatchQueue }> = []
const cipher: SecretCipher = {
  isAvailable: () => false, backend: () => 'fixture',
  encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(async () => {
  for (const fixture of fixtures) {
    fixture.queue.shutdown()
  }
  await vi.advanceTimersByTimeAsync(500)
  for (const { directory, store } of fixtures.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('delivery error classification', () => {
  it.each([
    new TypeError('fetch failed'), new Error('Steam returned invalid JSON'),
    new Error('Steam returned a malformed comment response'),
    new Error('Steam response exceeded the size limit'), new Error('Steam response interrupted'),
    new Error('This operation was aborted'), new Error('Steam HTTP error 503')
  ])('pauses without automatically retrying ambiguous failure %s', (error) => {
    expect(classifyDeliveryError(error)).toEqual({ status: 'uncertain', pauseBatch: true })
  })

  it.each([new Error('Steam HTTP error 429'), new DomainError('RATE_LIMITED', '频率限制'), new Error('Not logged in')])
  ('pauses explicit rate/session failure %s', (error) => {
    expect(classifyDeliveryError(error)).toEqual({ status: 'failed', pauseBatch: true })
  })

  it('allows a definite friend-specific rejection to be recorded without a blind retry', () => {
    expect(classifyDeliveryError(new Error('Comments are disabled for this profile')))
      .toEqual({ status: 'failed', pauseBatch: false })
  })
})

describe('persistent sending queue', () => {
  it('keeps the requested 0.1-second base interval sequential without removing jitter', async () => {
    const { queue, store, post, input } = fixture(2)
    const batch = queue.start({ ...input, delayMs: 0.1 * 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', delayMs: 100, succeeded: 2 })
  })

  it('sends a valid one-second batch sequentially and completes it', async () => {
    const { queue, store, post, events, input } = fixture(2)
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', succeeded: 2, failed: 0, delayMs: 1000 })
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'success' }))
  })

  it('still rejects a duplicate active batch before another request', async () => {
    const { queue, post, input } = fixture(2)
    expect(post).not.toHaveBeenCalled()
    queue.start(input)
    expect(() => queue.start(input)).toThrowError(/已有未完成批次/)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('persists all 1200 valid recipients and their frozen messages without truncating a batch', async () => {
    const { queue, store, post, input } = fixture(1200)
    const batch = queue.start({ ...input, friendSteamIds: [...input.friendSteamIds,
      input.friendSteamIds[0]!, 'invalid', ` ${input.friendSteamIds.at(-1)} `], delayMs: 100 })
    queue.pause(batch.id)
    await vi.advanceTimersByTimeAsync(0)
    const persisted = store.getBatch(batch.id)!
    expect(persisted).toMatchObject({ status: 'paused', total: 1200, completed: 1 })
    expect(persisted.deliveries).toHaveLength(1200)
    expect(new Set(persisted.deliveries.map((delivery) => delivery.friendSteamId)))
      .toEqual(new Set(input.friendSteamIds))
    expect(persisted.deliveries.find((delivery) => delivery.friendSteamId === input.friendSteamIds[0]))
      .toMatchObject({ friendName: 'Friend 0', renderedMessage: 'Hello Friend 0 from Sender' })
    expect(persisted.deliveries.find((delivery) => delivery.friendSteamId === input.friendSteamIds.at(-1)))
      .toMatchObject({ friendName: 'Friend 1199', renderedMessage: 'Hello Friend 1199 from Sender' })
    expect(post).toHaveBeenCalledTimes(1)

    const resource = fixtures.find((item) => item.store === store)!
    store.close()
    const recovered = new SqliteStore(join(resource.directory, 'fixture.sqlite3'), cipher)
    resource.store = recovered
    resource.queue = new BatchQueue(recovered, {
      isAuthenticated: () => true, postProfileComment: post
    } as unknown as SteamService, () => undefined)
    expect(recovered.getBatch(batch.id)).toMatchObject({ status: 'paused', total: 1200,
      completed: 1, deliveries: persisted.deliveries })
    expect(post).toHaveBeenCalledTimes(1)
  }, 90_000)

  it('sends every member of a batch over 30 sequentially and preserves pending recipients across pause/resume', async () => {
    const { queue, store, post, input } = fixture(40)
    let active = 0
    let peak = 0
    post.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { commentId: 'synthetic-comment' }
    })
    const batch = queue.start({ ...input, delayMs: 100 })
    const persistedOrder = store.getBatch(batch.id)!.deliveries.map((delivery) => delivery.friendSteamId)
    await vi.advanceTimersByTimeAsync(900)
    expect(post).toHaveBeenCalledTimes(10)
    queue.pause(batch.id)
    await vi.advanceTimersByTimeAsync(2000)
    expect(post).toHaveBeenCalledTimes(10)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'paused', total: 40, completed: 10 })
    queue.resume(batch.id)
    await vi.advanceTimersByTimeAsync(3000)
    expect(post.mock.calls.map((call) => call[1])).toEqual(persistedOrder)
    expect(new Set(post.mock.calls.map((call) => call[1])).size).toBe(40)
    expect(peak).toBe(1)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', total: 40,
      completed: 40, succeeded: 40, failed: 0 })
  }, 60_000)

  it('records fetch failures as uncertain, surfaces them, and only resumes pending recipients', async () => {
    const { queue, store, post, events, input } = fixture(2)
    post.mockRejectedValueOnce(new TypeError('fetch failed'))
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'paused', failed: 1 })
    expect(store.getBatch(batch.id)?.deliveries.filter((item) => item.status === 'uncertain')).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', message: expect.stringContaining('fetch failed') }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(post).toHaveBeenCalledTimes(1)
    queue.resume(batch.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(2)
    expect(new Set(post.mock.calls.map((call) => call[1])).size).toBe(2)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', failed: 1, succeeded: 1 })
  })

  it('retains a single-recipient failure in history and reports the actual error', async () => {
    const { queue, store, post, events, input } = fixture(1)
    post.mockRejectedValueOnce(new Error('Comments are disabled for this profile'))
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', failed: 1 })
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', message: expect.stringContaining('Comments are disabled') }))
  })

  it('survives pause/resume during an in-flight request without concurrent or duplicate delivery', async () => {
    const { queue, store, post, input } = fixture(2)
    let finish!: (value: { commentId: string }) => void
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pause(batch.id)
    queue.resume(batch.id)
    queue.resume(batch.id)
    expect(post).toHaveBeenCalledTimes(1)
    finish({ commentId: 'synthetic-first' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatch(batch.id)?.status).toBe('completed')
  })

  it('does not overlap a new batch with a cancelled batch whose POST is still settling', async () => {
    const { queue, store, post, input } = fixture(2)
    let finish!: (value: { commentId: string }) => void
    post.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const first = queue.start(input)
    queue.cancel(first.id)
    expect(queue.hasPendingRequests()).toBe(true)
    expect(store.getBatchSummary(first.id)).toMatchObject({ status: 'cancelled', sending: 1, cancelled: 1 })
    expect(() => queue.start(input)).toThrow(/请求正在结束/)
    expect(post).toHaveBeenCalledOnce()
    finish({ commentId: 'settled-first' })
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.hasPendingRequests()).toBe(false)
    expect(store.getBatchSummary(first.id)).toMatchObject({ status: 'cancelled', sending: 0, succeeded: 1 })
    const second = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(second.id).not.toBe(first.id)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('restarts a worker when resume lands between pause observation and worker cleanup', async () => {
    const { queue, store, post, input } = fixture(2)
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pause(batch.id)
    const getBatchSummary = store.getBatchSummary.bind(store)
    vi.spyOn(store, 'getBatchSummary').mockImplementationOnce((id) => {
      const pausedSnapshot = getBatchSummary(id)
      queue.resume(id)
      return pausedSnapshot
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.getBatch(batch.id)?.status).toBe('completed')
  })

  it('does not send recipients added to the blacklist after batch creation', async () => {
    const { queue, store, post, input } = fixture(2)
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    const pending = store.getBatch(batch.id)!.deliveries.find((item) => item.status === 'pending')!
    store.setBlacklist(accountId, [pending.friendSteamId], true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getBatch(batch.id)?.deliveries.find((item) => item.id === pending.id)).toMatchObject({
      status: 'failed', error: expect.stringContaining('黑名单')
    })
  })

  it('contains unexpected worker errors and pauses instead of silently leaving a running batch', async () => {
    const { queue, store, post, events, input } = fixture(2)
    vi.spyOn(store, 'takeNextDelivery').mockImplementationOnce(() => { throw new Error('Synthetic storage failure') })
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).not.toHaveBeenCalled()
    expect(store.getBatch(batch.id)?.status).toBe('paused')
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'error', message: expect.stringContaining('Synthetic storage failure') }))
  })

  it('fails closed rather than rejecting its detached worker when metadata storage fails repeatedly', async () => {
    const { queue, store, post, events, input } = fixture(2)
    queue.start(input)
    vi.spyOn(store, 'getBatchSummary').mockImplementation(() => { throw new Error('Synthetic database read failure') })
    await vi.advanceTimersByTimeAsync(5000)
    expect(post).toHaveBeenCalledOnce()
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'error', message: expect.stringContaining('Synthetic database read failure') }))
  })

  it('uses only constant-sized metadata while waiting on a million-recipient summary', async () => {
    const { queue, store, post, events, input } = fixture(2)
    const getBatchSummary = store.getBatchSummary.bind(store)
    vi.spyOn(store, 'getBatch').mockImplementation(() => { throw new Error('Full delivery read is forbidden in the queue') })
    const summaries = vi.spyOn(store, 'getBatchSummary').mockImplementation(id => {
      const value = getBatchSummary(id)
      return value ? { ...value, total: 1_000_000, pending: 999_999 } : null
    })
    const batch = queue.start({ ...input, delayMs: 300_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(post).toHaveBeenCalledOnce()
    expect(summaries.mock.calls.length).toBeGreaterThan(200)
    expect(batch).not.toHaveProperty('deliveries')
    expect(events.some(event => event.type === 'snapshotChanged')).toBe(false)
    queue.pause(batch.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes and clears interval timers on shutdown and never reads a subsequently closed database', async () => {
    const { queue, store, post, input } = fixture(2)
    queue.start({ ...input, delayMs: 300_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    queue.shutdown()
    const reads = vi.spyOn(store, 'getBatchSummary').mockImplementation(() => { throw new Error('Database closed') })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(reads).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledOnce()
    expect(() => queue.start(input)).toThrow(/队列已关闭/)
  })

  it.each(['resolve', 'reject'] as const)('ignores a late POST %s after shutdown and restores it as uncertain', async outcome => {
    const { queue, store, post, events, input } = fixture(2)
    let resolve!: (value: { commentId: string }) => void
    let reject!: (error: Error) => void
    post.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no }))
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getBatchSummary(batch.id)).toMatchObject({ sending: 1, pending: 1 })
    queue.shutdown()
    expect(queue.hasPendingRequests()).toBe(true)
    const eventCount = events.length
    const reads = vi.spyOn(store, 'getBatchSummary')
    const complete = vi.spyOn(store, 'completeDelivery')
    store.close()
    if (outcome === 'resolve') resolve({ commentId: 'late-result' })
    else reject(new Error('fetch failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.hasPendingRequests()).toBe(false)
    expect(reads).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(events).toHaveLength(eventCount)

    const resource = fixtures.find(item => item.store === store)!
    const recovered = new SqliteStore(join(resource.directory, 'fixture.sqlite3'), cipher)
    resource.store = recovered
    resource.queue = new BatchQueue(recovered, { isAuthenticated: () => true, postProfileComment: post } as unknown as SteamService, () => undefined)
    expect(recovered.getBatchSummary(batch.id)).toMatchObject({ status: 'paused', pending: 1, sending: 0, uncertain: 1, succeeded: 0 })
    resource.queue.resume(batch.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(2)
    expect(new Set(post.mock.calls.map(call => call[1])).size).toBe(2)
    expect(recovered.getBatchSummary(batch.id)).toMatchObject({ status: 'completed', uncertain: 1, succeeded: 1 })
  })
})

function fixture(count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'steam-comment-queue-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  store.upsertAccount({
    id: accountId, steamId: accountId, accountName: 'synthetic', displayName: 'Sender', avatarUrl: '',
    createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null
  })
  const friendIds = Array.from({ length: count }, (_, index) => String(76561198000000101n + BigInt(index)))
  store.replaceFriends(accountId, friendIds.map((steamId, index) => ({
    accountId, steamId, displayName: `Friend ${index}`, avatarUrl: '',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`, onlineState: 'offline', syncedAt: new Date().toISOString()
  })))
  const post = vi.fn<(account: string, friend: string, message: string) => Promise<{ commentId: string | null }>>()
    .mockResolvedValue({ commentId: 'synthetic-comment' })
  const events: AppEvent[] = []
  const steam = { isAuthenticated: vi.fn(() => true), postProfileComment: post }
  const queue = new BatchQueue(store, steam as unknown as SteamService, (event) => events.push(event))
  fixtures.push({ directory, store, queue })
  const input: BatchStartInput = {
    accountId, friendSteamIds: friendIds, messageTemplate: 'Hello {friend} from {account}', delayMs: 1000
  }
  return { queue, store, post, events, input }
}
