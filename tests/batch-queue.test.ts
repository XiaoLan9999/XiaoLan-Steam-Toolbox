import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue, classifyDeliveryError } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import { DomainError } from '../src/shared/domain'
import type { AppEvent, BatchStartInput } from '../src/shared/types'

vi.mock('node:timers/promises', () => ({
  setTimeout: (delay: number) => new Promise((resolve) => setTimeout(resolve, delay))
}))

const accountId = '76561198000000001'
const friendIds = ['76561198000000101', '76561198000000102', '76561198000000103']
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
    const active = fixture.store.getActiveBatch(accountId)
    if (active) fixture.queue.cancel(active.id)
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

  it('rejects an oversized selection and a duplicate active batch before another request', async () => {
    const { queue, post, input } = fixture(2)
    expect(() => queue.start({ ...input, friendSteamIds: Array.from({ length: 31 }, (_, i) => String(76561198000001000n + BigInt(i))) }))
      .toThrowError(/单次最多/)
    expect(post).not.toHaveBeenCalled()
    queue.start(input)
    expect(() => queue.start(input)).toThrowError(/已有未完成批次/)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

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

  it('restarts a worker when resume lands between pause observation and worker cleanup', async () => {
    const { queue, store, post, input } = fixture(2)
    const batch = queue.start(input)
    await vi.advanceTimersByTimeAsync(0)
    queue.pause(batch.id)
    const getBatch = store.getBatch.bind(store)
    vi.spyOn(store, 'getBatch').mockImplementationOnce((id) => {
      const pausedSnapshot = getBatch(id)
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
})

function fixture(count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'steam-comment-queue-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  store.upsertAccount({
    id: accountId, steamId: accountId, accountName: 'synthetic', displayName: 'Sender', avatarUrl: '',
    createdAt: new Date().toISOString(), lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null
  })
  store.replaceFriends(accountId, friendIds.slice(0, count).map((steamId, index) => ({
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
    accountId, friendSteamIds: friendIds.slice(0, count), messageTemplate: 'Hello {friend} from {account}', delayMs: 1000
  }
  return { queue, store, post, events, input }
}
