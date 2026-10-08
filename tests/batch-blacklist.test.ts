import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { SteamService } from '../src/main/steam-service'
import type { AccountRecord } from '../src/shared/types'

const owner = '76561198000000001'
const other = '76561198000000002'
const friend = '76561198000000003'
const resources: Array<{ directory: string; store: SqliteStore }> = []
const cipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: value => Buffer.from(value),
  decrypt: value => value.toString()
}

afterEach(() => {
  for (const { directory, store } of resources.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('blacklist enforcement on delivery', () => {
  it('rejects a blacklisted recipient before creating any delivery', () => {
    const { store, queue, post } = fixture()
    store.setBlacklist(owner, [friend], true)
    expect(() => queue.start({ accountId: owner, friendSteamIds: [friend],
      messageTemplate: 'hello', delayMs: 10000 })).toThrow(/黑名单/)
    expect(store.getRecentBatches(owner)).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('does not apply another account blacklist to the current account', async () => {
    const { store, queue, post } = fixture()
    store.setBlacklist(other, [friend], true)
    const batch = queue.start({ accountId: owner, friendSteamIds: [friend],
      messageTemplate: 'hello', delayMs: 10000 })
    await vi.waitFor(() => expect(store.getBatch(batch.id)?.status).toBe('completed'))
    expect(post).toHaveBeenCalledExactlyOnceWith(owner, friend, 'hello')
  })

  it('skips a recipient added to the blacklist after the batch was created', () => {
    const { store, queue, post } = fixture()
    const batch = store.createBatch(owner, 'hello', 10000, [
      { friendSteamId: friend, friendName: 'Friend', renderedMessage: 'hello' }
    ])
    store.setBatchRunning(batch.id)
    queue.pause(batch.id)
    store.setBlacklist(owner, [friend], true)
    queue.resume(batch.id)
    expect(post).not.toHaveBeenCalled()
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed',
      deliveries: [{ status: 'failed', error: expect.stringContaining('未发送留言') }] })
  })
})

describe('friendship removal enforcement on delivery', () => {
  it('rejects a recipient absent from the current account before creating a delivery', () => {
    const { store, queue, post } = fixture()
    store.replaceFriends(owner, [])
    expect(() => queue.start({ accountId: owner, friendSteamIds: [friend],
      messageTemplate: 'hello', delayMs: 1000 })).toThrow(/已同步的好友/)
    expect(store.getRecentBatches(owner)).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
    expect(store.hasActiveFriend(other, friend)).toBe(true)
  })

  it('skips an unsent recipient removed after the batch was created even if another account remains friends', () => {
    const { store, queue, post } = fixture()
    const batch = store.createBatch(owner, 'hello', 1000, [
      { friendSteamId: friend, friendName: 'Friend', renderedMessage: 'hello' }
    ])
    store.setBatchRunning(batch.id)
    queue.pause(batch.id)
    store.replaceFriends(owner, [])
    queue.resume(batch.id)
    expect(post).not.toHaveBeenCalled()
    expect(store.hasActiveFriend(other, friend)).toBe(true)
    expect(store.getBatch(batch.id)).toMatchObject({ status: 'completed', failed: 1,
      deliveries: [{ status: 'failed', error: expect.stringContaining('已不在当前好友列表中') }] })
  })

  it('does not apply another account friendship removal to a pending current-account recipient', async () => {
    const { store, queue, post } = fixture()
    const batch = store.createBatch(owner, 'hello', 1000, [
      { friendSteamId: friend, friendName: 'Friend', renderedMessage: 'hello' }
    ])
    store.setBatchRunning(batch.id)
    queue.pause(batch.id)
    store.replaceFriends(other, [])
    queue.resume(batch.id)
    await vi.waitFor(() => expect(store.getBatch(batch.id)?.status).toBe('completed'))
    expect(post).toHaveBeenCalledExactlyOnceWith(owner, friend, 'hello')
  })

  it('allows a pending recipient who has been re-added before the queue resumes', async () => {
    const { store, queue, post } = fixture()
    const cached = store.getFriends(owner)
    const batch = store.createBatch(owner, 'hello', 1000, [
      { friendSteamId: friend, friendName: 'Friend', renderedMessage: 'hello' }
    ])
    store.setBatchRunning(batch.id)
    queue.pause(batch.id)
    store.replaceFriends(owner, [])
    store.replaceFriends(owner, cached)
    queue.resume(batch.id)
    await vi.waitFor(() => expect(store.getBatch(batch.id)?.status).toBe('completed'))
    expect(post).toHaveBeenCalledExactlyOnceWith(owner, friend, 'hello')
  })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-blacklist-test-'))
  const store = new SqliteStore(join(directory, 'test.sqlite3'), cipher)
  resources.push({ directory, store })
  for (const id of [other, owner]) {
    const account: AccountRecord = { id, steamId: id, accountName: 'Test', displayName: 'Test',
      avatarUrl: '', createdAt: new Date().toISOString(), lastLoginAt: null,
      lastFriendSyncAt: null, lastEmoticonSyncAt: null }
    store.upsertAccount(account)
    store.replaceFriends(id, [{ accountId: id, steamId: friend, displayName: 'Friend',
      avatarUrl: '', profileUrl: `https://steamcommunity.com/profiles/${friend}`,
      onlineState: 'offline', syncedAt: new Date().toISOString() }])
  }
  const post = vi.fn(async () => ({ commentId: 'test-comment' }))
  const steam = { isAuthenticated: () => true, postProfileComment: post } as unknown as SteamService
  return { store, post, queue: new BatchQueue(store, steam, vi.fn()) }
}
