import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountRecord, FriendRecord } from '../src/shared/types'
import { SecretCipher, SqliteStore } from '../src/main/store'

const resources: Array<{ directory: string; stores: SqliteStore[] }> = []
const accountA = '76561198000000001'
const accountB = '76561198000000002'
const friendA = '76561198000000101'
const friendB = '76561198000000102'
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'test',
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/, '')
}

afterEach(() => {
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('friend policies', () => {
  it('returns unchecked defaults for every active friend without modifying groups', () => {
    const { store } = setup()
    const group = store.createGroup(accountA, 'friends', '#66c0f4')
    store.setFriendGroups(accountA, [friendA], [group.id])
    expect(store.getFriendPolicies(accountA)).toEqual([
      { accountId: accountA, steamId: friendA, blacklisted: false,
        commentStatus: 'unchecked', commentReason: null, commentCheckedAt: null },
      { accountId: accountA, steamId: friendB, blacklisted: false,
        commentStatus: 'unchecked', commentReason: null, commentCheckedAt: null }
    ])
    store.setBlacklist(accountA, [friendA], true)
    expect(store.getFriend(accountA, friendA)?.groupIds).toEqual([group.id])
  })

  it('isolates blacklist and results for the same friend under two accounts', () => {
    const { store } = setup()
    store.upsertAccount(account(accountB))
    store.replaceFriends(accountB, [friend(accountB, friendA)])
    store.setBlacklist(accountA, [friendA], true)
    const job = store.createCommentScan(accountA, [friendA], 5_000)
    const item = store.takeNextCommentScanItem(job.id)!
    store.completeCommentScanItem(job.id, item, { status: 'blocked', reason: 'disabled' })
    expect(store.getFriendPolicies(accountA)[0]).toMatchObject({ blacklisted: true, commentStatus: 'blocked' })
    expect(store.getFriendPolicies(accountB)[0]).toMatchObject({ blacklisted: false, commentStatus: 'unchecked' })
    expect(store.isBlacklisted(accountA, friendA)).toBe(true)
    expect(store.isBlacklisted(accountB, friendA)).toBe(false)
  })

  it('retains policies across sync, disappearance, and reappearance', () => {
    const { store } = setup()
    store.setBlacklist(accountA, [friendA], true)
    store.replaceFriends(accountA, [friend(accountA, friendB)])
    expect(store.getFriendPolicies(accountA).map((entry) => entry.steamId)).toEqual([friendB])
    store.replaceFriends(accountA, [friend(accountA, friendA)])
    expect(store.getFriendPolicies(accountA)[0]?.blacklisted).toBe(true)
    store.setBlacklist(accountA, [friendA], false)
    expect(store.isBlacklisted(accountA, friendA)).toBe(false)
  })

  it('rejects unsynced, malformed, cross-account, empty, and oversized selections atomically', () => {
    const { store } = setup()
    store.upsertAccount(account(accountB))
    expect(() => store.setBlacklist(accountB, [friendA], true)).toThrow(/已同步/)
    expect(() => store.setBlacklist(accountA, [friendA, '76561198009999999'], true)).toThrow(/已同步/)
    expect(store.isBlacklisted(accountA, friendA)).toBe(false)
    expect(() => store.setBlacklist(accountA, ['bad-id'], true)).toThrow(/Steam ID/)
    expect(() => store.setBlacklist(accountA, [], true)).toThrow(/至少/)
    expect(() => store.setBlacklist(accountA, Array(5001).fill(friendA), true)).toThrow(/5000/)
    expect(() => store.setBlacklist(accountA, [friendA], 1 as unknown as boolean)).toThrow(/状态/)
  })
})

describe('persistent comment scans', () => {
  it('persists results and counters, keeps blacklist, and rejects a second unfinished job', () => {
    const { store } = setup()
    store.setBlacklist(accountA, [friendA], true)
    const job = store.createCommentScan(accountA, [friendA, friendB, friendA], 1)
    expect(job).toMatchObject({ total: 2, completed: 0, delayMs: 5000 })
    expect(() => store.createCommentScan(accountA, [friendA], 5000)).toThrow(/未完成/)
    const first = store.takeNextCommentScanItem(job.id)!
    expect(first.steamId).toBe(friendA)
    expect(store.takeNextCommentScanItem(job.id)).toBeNull()
    expect(store.completeCommentScanItem(job.id, first, { status: 'allowed', reason: 'form found' })).toBe(true)
    expect(store.completeCommentScanItem(job.id, first, { status: 'blocked', reason: 'stale' })).toBe(false)
    const second = store.takeNextCommentScanItem(job.id)!
    store.completeCommentScanItem(job.id, second, { status: 'unknown', reason: 'ambiguous' })
    expect(store.getLatestCommentScan(accountA)).toMatchObject({
      id: job.id, status: 'completed', total: 2, completed: 2, allowed: 1, unknown: 1, blocked: 0
    })
    expect(store.isBlacklisted(accountA, friendA)).toBe(true)
  })

  it('ignores stale responses after pause, resume, cancellation, and account deletion', () => {
    const { store } = setup()
    const job = store.createCommentScan(accountA, [friendA, friendB], 5000)
    const stale = store.takeNextCommentScanItem(job.id)!
    store.pauseCommentScan(job.id)
    store.setCommentScanRunning(job.id)
    const current = store.takeNextCommentScanItem(job.id)!
    expect(current.attemptId).not.toBe(stale.attemptId)
    expect(store.completeCommentScanItem(job.id, stale, { status: 'blocked', reason: 'old' })).toBe(false)
    store.cancelCommentScan(job.id)
    expect(store.completeCommentScanItem(job.id, current, { status: 'blocked', reason: 'old' })).toBe(false)
    const next = store.createCommentScan(accountA, [friendA], 5000)
    const nextItem = store.takeNextCommentScanItem(next.id)!
    store.deleteAccount(accountA)
    expect(store.completeCommentScanItem(next.id, nextItem, { status: 'blocked', reason: 'old' })).toBe(false)
    expect(store.getCommentScan(next.id)).toBeNull()
  })

  it('recovers in-flight checks as pending, paused, and manually resumable', () => {
    const fixture = setup()
    const job = fixture.store.createCommentScan(accountA, [friendA, friendB], 5000)
    const first = fixture.store.takeNextCommentScanItem(job.id)!
    fixture.store.completeCommentScanItem(job.id, first, { status: 'allowed', reason: 'form' })
    fixture.store.takeNextCommentScanItem(job.id)
    const store = fixture.reopen()
    expect(store.getCommentScan(job.id)).toMatchObject({ status: 'paused', completed: 1, currentSteamId: null })
    expect(store.takeNextCommentScanItem(job.id)).toBeNull()
    store.setCommentScanRunning(job.id)
    expect(store.takeNextCommentScanItem(job.id)?.steamId).toBe(friendB)
  })

  it('migrates a v1 database without changing accounts, tokens, groups, or old batches', () => {
    const fixture = setup()
    fixture.store.upsertAccount(account(accountA), 'preserved-token')
    const group = fixture.store.createGroup(accountA, 'retained', '#66c0f4')
    fixture.store.setFriendGroups(accountA, [friendA], [group.id])
    const batch = fixture.store.createBatch(accountA, 'hi', 15000, [
      { friendSteamId: friendA, friendName: 'Friend', renderedMessage: 'hi' }
    ])
    fixture.close()
    const old = new DatabaseSync(fixture.path)
    old.exec('DROP TABLE comment_scan_items; DROP TABLE comment_scan_jobs; DROP TABLE friend_policies; PRAGMA user_version = 1;')
    old.close()
    const store = fixture.reopen()
    expect(store.getRefreshToken(accountA)).toBe('preserved-token')
    expect(store.getFriend(accountA, friendA)?.groupIds).toEqual([group.id])
    expect(store.getBatch(batch.id)?.deliveries[0]?.renderedMessage).toBe('hi')
    expect(store.getFriendPolicies(accountA)).toHaveLength(2)
    store.setBlacklist(accountA, [friendA], true)
    expect(store.isBlacklisted(accountA, friendA)).toBe(true)
  })

  it('handles 1005 friends in one persistent job and blacklist operation', () => {
    const { store } = setup()
    const ids = Array.from({ length: 1005 }, (_, index) => String(76561198001000000n + BigInt(index)))
    store.replaceFriends(accountA, ids.map((id) => friend(accountA, id)))
    store.setBlacklist(accountA, ids, true)
    const job = store.createCommentScan(accountA, ids, 5000)
    for (const id of ids) {
      const item = store.takeNextCommentScanItem(job.id)!
      expect(item.steamId).toBe(id)
      store.completeCommentScanItem(job.id, item, { status: 'allowed', reason: 'form' })
    }
    expect(store.getCommentScan(job.id)).toMatchObject({ total: 1005, completed: 1005, allowed: 1005, status: 'completed' })
    expect(store.getFriendPolicies(accountA).every((entry) => entry.blacklisted)).toBe(true)
  }, 90_000)
})

describe('settings and redacted database export', () => {
  it('stores the supported UI languages persistently and rejects other values', () => {
    const fixture = setup()
    expect(fixture.store.getLanguage()).toBe('zh-CN')
    fixture.store.setLanguage('en')
    expect(fixture.reopen().getLanguage()).toBe('en')
    expect(() => fixture.store.setLanguage('fr' as 'en')).toThrow(/语言/)
  })

  it('exports business state and language without token rows or residual ciphertext', async () => {
    const fixture = setup()
    const token = 'export-must-not-contain-this-sensitive-refresh-token'
    fixture.store.upsertAccount(account(accountA), token)
    fixture.store.setLanguage('en')
    fixture.store.setBlacklist(accountA, [friendA], true)
    const group = fixture.store.createGroup(accountA, 'exported-group', '#66c0f4')
    fixture.store.setFriendGroups(accountA, [friendA], [group.id])
    const job = fixture.store.createCommentScan(accountA, [friendA], 5000)
    fixture.store.takeNextCommentScanItem(job.id)
    const destination = join(fixture.directory, 'export.sqlite3')
    await fixture.store.exportDatabase(destination)
    expect(fixture.store.getRefreshToken(accountA)).toBe(token)
    expect(fixture.store.getCommentScan(job.id)?.status).toBe('running')
    expect(readFileSync(destination).includes(Buffer.from(token))).toBe(false)
    const raw = new DatabaseSync(destination)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM account_secrets').get()?.count).toBe(0)
    expect(raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
    raw.close()
    const exported = new SqliteStore(destination, cipher)
    try {
      expect(exported.getRefreshToken(accountA)).toBeNull()
      expect(exported.getLanguage()).toBe('en')
      expect(exported.getFriend(accountA, friendA)?.groupIds).toEqual([group.id])
      expect(exported.isBlacklisted(accountA, friendA)).toBe(true)
      expect(exported.getCommentScan(job.id)).toMatchObject({ status: 'paused', currentSteamId: null })
    } finally { exported.close() }
  })
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'steam-policy-test-'))
  const path = join(directory, 'state.sqlite3')
  const resource = { directory, stores: [] as SqliteStore[] }
  resources.push(resource)
  const fixture = {
    directory, path,
    store: new SqliteStore(path, cipher),
    close() {
      for (const store of resource.stores.splice(0)) store.close()
    },
    reopen() {
      fixture.close()
      fixture.store = new SqliteStore(path, cipher)
      resource.stores.push(fixture.store)
      return fixture.store
    }
  }
  resource.stores.push(fixture.store)
  fixture.store.upsertAccount(account(accountA))
  fixture.store.replaceFriends(accountA, [friend(accountA, friendA), friend(accountA, friendB)])
  return fixture
}

function account(id: string): AccountRecord {
  return { id, steamId: id, accountName: id, displayName: id, avatarUrl: '',
    createdAt: '2026-09-26T00:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null }
}

function friend(accountId: string, steamId: string): Omit<FriendRecord, 'groupIds'> {
  return { accountId, steamId, displayName: steamId, avatarUrl: '',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline', syncedAt: '2026-09-26T00:00:00.000Z' }
}
