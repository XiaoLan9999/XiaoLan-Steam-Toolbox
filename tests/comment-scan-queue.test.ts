import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommentCheckResult } from '../src/shared/types'
import { CommentScanQueue } from '../src/main/comment-scan-queue'
import { SecretCipher, SqliteStore } from '../src/main/store'

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const friendA = '76561198000000101'
const friendB = '76561198000000102'
const allowed: CommentCheckResult = { status: 'allowed', reason: 'form found' }
const blocked: CommentCheckResult = { status: 'blocked', reason: 'comments disabled' }
const resources: Array<{ directory: string; store: SqliteStore; queue: CommentScanQueue; closed: boolean }> = []
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'test',
  encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T00:00:00.000Z'))
})

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (!resource.closed) {
      resource.queue.shutdown()
      resource.store.close()
    }
    rmSync(resource.directory, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('CommentScanQueue', () => {
  it('checks serially with the minimum interval and publishes progress', async () => {
    const { store, queue, check, emit } = setup()
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 1 })
    expect(check).toHaveBeenCalledTimes(1)
    await flush()
    expect(store.getCommentScan(job.id)).toMatchObject({ completed: 1, allowed: 1, status: 'running' })
    await vi.advanceTimersByTimeAsync(4999)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    expect(store.getCommentScan(job.id)).toMatchObject({ completed: 2, status: 'completed', currentSteamId: null })
    expect(emit).toHaveBeenCalledWith({ type: 'snapshotChanged' })
  })

  it('clamps the maximum interval and defaults a missing interval to 10 seconds', async () => {
    const { store, queue } = setup()
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA], delayMs: 999999 })
    await flush()
    expect(store.getCommentScan(job.id)?.delayMs).toBe(60000)
    const next = queue.start({ accountId: accountA, friendSteamIds: [friendB], delayMs: undefined as unknown as number })
    expect(next.delayMs).toBe(10000)
  })

  it('requires the active authenticated account and an already-synced friend', () => {
    const fixture = setup()
    fixture.steam.isAuthenticated.mockReturnValue(false)
    expect(() => fixture.queue.start({ accountId: accountA, friendSteamIds: [friendA], delayMs: 5000 })).toThrow(/登录/)
    fixture.steam.isAuthenticated.mockReturnValue(true)
    expect(() => fixture.queue.start({ accountId: accountB, friendSteamIds: [friendA], delayMs: 5000 })).toThrow(/切换/)
    expect(() => fixture.queue.start({ accountId: accountA, friendSteamIds: ['76561198009999999'], delayMs: 5000 })).toThrow(/已同步/)
  })

  it('does not lose a quick pause/resume or run overlapping checks', async () => {
    const { store, queue, check } = setup()
    const pending = deferred<CommentCheckResult>()
    check.mockImplementationOnce(() => pending.promise)
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    queue.pause(job.id)
    queue.resume(job.id)
    queue.resume(job.id)
    expect(check).toHaveBeenCalledTimes(1)
    pending.resolve(blocked)
    await flush()
    expect(store.getFriendPolicies(accountA)[0]?.commentStatus).toBe('unchecked')
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(check.mock.calls[1]).toEqual([accountA, friendA])
    expect(store.getCommentScan(job.id)?.completed).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.getCommentScan(job.id)?.status).toBe('completed')
  })

  it('resumes while an older pump is settling', async () => {
    const { store, queue } = setup()
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    await flush()
    queue.pause(job.id)
    await Promise.resolve()
    queue.resume(job.id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.getCommentScan(job.id)?.status).toBe('completed')
  })

  it('cancels an in-flight check without letting it overwrite a replacement job', async () => {
    const { store, queue, check } = setup()
    const pending = deferred<CommentCheckResult>()
    check.mockImplementationOnce(() => pending.promise)
    const first = queue.start({ accountId: accountA, friendSteamIds: [friendA], delayMs: 5000 })
    queue.cancel(first.id)
    const next = queue.start({ accountId: accountA, friendSteamIds: [friendB], delayMs: 5000 })
    pending.resolve(blocked)
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    expect(store.getFriendPolicies(accountA)[0]?.commentStatus).toBe('unchecked')
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(store.getCommentScan(first.id)?.status).toBe('cancelled')
    expect(store.getCommentScan(next.id)).toMatchObject({ status: 'completed', allowed: 1 })
  })

  it('marks an interrupted account check unknown and serializes the next account', async () => {
    const { store, queue, check } = setup()
    const pending = deferred<CommentCheckResult>()
    check.mockImplementationOnce(() => pending.promise)
    const first = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    queue.pauseForAccount(accountA)
    store.setActiveAccountId(accountB)
    const next = queue.start({ accountId: accountB, friendSteamIds: [friendA], delayMs: 5000 })
    pending.resolve(blocked)
    await flush()
    expect(store.getCommentScan(first.id)).toMatchObject({ status: 'paused', completed: 1, unknown: 1, blocked: 0 })
    expect(store.getFriendPolicies(accountA)[0]?.commentStatus).toBe('unknown')
    await vi.advanceTimersByTimeAsync(5000)
    expect(check.mock.calls).toEqual([[accountA, friendA], [accountB, friendA]])
    expect(store.getCommentScan(next.id)?.status).toBe('completed')
  })

  it.each(['HTTP error 429', 'fetch failed', 'Steam session expired', 'HTTP error 503'])
  ('records %s as unknown and pauses without automatic retries', async (message) => {
    const { store, queue, check } = setup()
    check.mockRejectedValueOnce(new Error(message))
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    await flush()
    expect(store.getCommentScan(job.id)).toMatchObject({ status: 'paused', completed: 1, unknown: 1, blocked: 0, lastError: message })
    expect(store.getFriendPolicies(accountA)[0]?.commentStatus).toBe('unknown')
    await vi.advanceTimersByTimeAsync(120000)
    expect(check).toHaveBeenCalledTimes(1)
    queue.resume(job.id)
    await flush()
    expect(check.mock.calls[1]).toEqual([accountA, friendB])
    expect(store.getCommentScan(job.id)?.status).toBe('completed')
  })

  it('handles a synchronous session-expiry callback before rejection', async () => {
    const fixture = setup()
    const pending = deferred<CommentCheckResult>()
    fixture.check.mockImplementationOnce(() => pending.promise)
    const job = fixture.queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    fixture.steam.isAuthenticated.mockReturnValue(false)
    fixture.queue.pauseForAccount(accountA)
    pending.reject(new Error('Steam session expired'))
    await flush()
    expect(fixture.store.getCommentScan(job.id)).toMatchObject({ status: 'paused', unknown: 1, blocked: 0 })
    await vi.advanceTimersByTimeAsync(120000)
    expect(fixture.check).toHaveBeenCalledTimes(1)
  })

  it('ignores late responses after account deletion', async () => {
    const { store, queue, check } = setup()
    const pending = deferred<CommentCheckResult>()
    check.mockImplementationOnce(() => pending.promise)
    const job = queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    store.deleteAccount(accountA)
    pending.resolve(blocked)
    await flush()
    expect(store.getCommentScan(job.id)).toBeNull()
    await vi.advanceTimersByTimeAsync(60000)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('does not touch a closed database when shutdown happens during a GET', async () => {
    const fixture = setup()
    const pending = deferred<CommentCheckResult>()
    fixture.check.mockImplementationOnce(() => pending.promise)
    const job = fixture.queue.start({ accountId: accountA, friendSteamIds: [friendA, friendB], delayMs: 5000 })
    fixture.queue.shutdown()
    expect(fixture.store.getCommentScan(job.id)).toMatchObject({ status: 'paused', currentSteamId: null, completed: 0 })
    const read = vi.spyOn(fixture.store, 'getActiveAccountId')
    const write = vi.spyOn(fixture.store, 'completeCommentScanItem')
    fixture.store.close()
    fixture.resource.closed = true
    pending.resolve(blocked)
    await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not auto-start paused jobs after app restart', async () => {
    const fixture = setup()
    const pending = deferred<CommentCheckResult>()
    fixture.check.mockImplementationOnce(() => pending.promise)
    const job = fixture.queue.start({ accountId: accountA, friendSteamIds: [friendA], delayMs: 5000 })
    fixture.queue.shutdown()
    fixture.store.close()
    fixture.resource.closed = true
    const recovered = new SqliteStore(join(fixture.resource.directory, 'state.sqlite3'), cipher)
    const check = vi.fn().mockResolvedValue(allowed)
    const queue = new CommentScanQueue(recovered, { isAuthenticated: () => true, checkCommentEligibility: check }, vi.fn())
    try {
      await vi.advanceTimersByTimeAsync(60000)
      expect(check).not.toHaveBeenCalled()
      expect(recovered.getCommentScan(job.id)?.status).toBe('paused')
      queue.resume(job.id)
      await flush()
      expect(recovered.getCommentScan(job.id)?.status).toBe('completed')
    } finally {
      queue.shutdown()
      recovered.close()
    }
    pending.resolve(blocked)
    await flush()
  })

  it('processes a 1005-friend task at a controlled rate', async () => {
    const { store, queue, check } = setup()
    const ids = Array.from({ length: 1005 }, (_, index) => String(76561198001000000n + BigInt(index)))
    addFriends(store, accountA, ids)
    const job = queue.start({ accountId: accountA, friendSteamIds: ids, delayMs: 5000 })
    await flush()
    await vi.advanceTimersByTimeAsync(5000 * 1004)
    expect(check).toHaveBeenCalledTimes(1005)
    expect(store.getCommentScan(job.id)).toMatchObject({ status: 'completed', total: 1005, completed: 1005, allowed: 1005 })
  }, 90_000)
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'steam-scan-test-'))
  const store = new SqliteStore(join(directory, 'state.sqlite3'), cipher)
  for (const id of [accountB, accountA]) {
    store.upsertAccount({ id, steamId: id, accountName: id, displayName: id, avatarUrl: '',
      createdAt: '2026-09-26T00:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
    addFriends(store, id, [friendA, friendB])
  }
  const check = vi.fn<(accountId: string, steamId: string) => Promise<CommentCheckResult>>().mockResolvedValue(allowed)
  const steam = { isAuthenticated: vi.fn(() => true), checkCommentEligibility: check }
  const emit = vi.fn()
  const queue = new CommentScanQueue(store, steam, emit)
  const resource = { directory, store, queue, closed: false }
  resources.push(resource)
  return { store, queue, check, steam, emit, resource }
}

function addFriends(store: SqliteStore, accountId: string, ids: string[]): void {
  store.replaceFriends(accountId, ids.map((steamId) => ({
    accountId, steamId, displayName: steamId, avatarUrl: '',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline', syncedAt: '2026-09-26T00:00:00.000Z'
  })))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
