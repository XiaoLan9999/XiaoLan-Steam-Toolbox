import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AccountRecord, FriendRecord } from '../src/shared/types'

const owner = '76561198000000001'
const other = '76561198000000002'
const friendId = '76561198000000101'
const anotherId = '76561198000000102'
const resources: Array<{ directory: string; current: SqliteStore | null }> = []
const cipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/, '')
}

afterEach(() => {
  vi.useRealTimers()
  for (const resource of resources.splice(0)) {
    resource.current?.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

describe('friend removal history', () => {
  it('records a 1005 to 1004 change without losing cached details, groups, or blacklist', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
    const { store, read } = fixture()
    const friends = Array.from({ length: 1005 }, (_, index) =>
      friend(owner, (76561198000100000n + BigInt(index)).toString()))
    store.replaceFriends(owner, friends)
    expect(store.getFriendRemovals(owner)).toEqual([])
    const removed = friends[217]!
    const group = store.createGroup(owner, 'Preserved group', '#66c0f4')
    store.setFriendGroups(owner, [removed.steamId], [group.id])
    store.setBlacklist(owner, [removed.steamId], true)

    vi.setSystemTime(new Date('2026-10-04T01:00:00Z'))
    store.replaceFriends(owner, friends.filter((item) => item.steamId !== removed.steamId))

    expect(store.getFriends(owner)).toHaveLength(1004)
    expect(store.hasActiveFriend(owner, removed.steamId)).toBe(false)
    expect(store.getFriendRemovals(owner)).toEqual([{
      id: expect.any(String), accountId: owner, steamId: removed.steamId,
      displayName: removed.displayName, avatarUrl: removed.avatarUrl, profileUrl: removed.profileUrl,
      detectedAt: '2026-10-04T01:00:00.000Z', restoredAt: null, source: 'sync'
    }])
    expect(read('SELECT is_active FROM friends WHERE account_id = ? AND steam_id = ?',
      owner, removed.steamId)).toMatchObject({ is_active: 0 })
    expect(read('SELECT group_id FROM friend_group_members WHERE account_id = ? AND friend_steam_id = ?',
      owner, removed.steamId)).toMatchObject({ group_id: group.id })
    expect(store.isBlacklisted(owner, removed.steamId)).toBe(true)

    store.replaceFriends(owner, friends)
    expect(store.getFriend(owner, removed.steamId)?.groupIds).toEqual([group.id])
    expect(store.getFriendPolicies(owner).find((item) => item.steamId === removed.steamId)?.blacklisted).toBe(true)
  })

  it('does not duplicate removal records across repeated syncs or restarts', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId), friend(owner, anotherId)])
    data.store.replaceFriends(owner, [friend(owner, anotherId)])
    const first = data.store.getFriendRemovals(owner)
    data.store.replaceFriends(owner, [friend(owner, anotherId)])
    const reopened = data.reopen()
    reopened.replaceFriends(owner, [friend(owner, anotherId)])
    expect(reopened.getFriendRemovals(owner)).toEqual(first)
  })

  it('closes a removal on reappearance, freezes snapshots, and creates a new event on a later removal', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Original name')])
    store.replaceFriends(owner, [])
    const firstId = store.getFriendRemovals(owner)[0]!.id

    vi.setSystemTime(new Date('2026-10-04T01:00:00Z'))
    store.replaceFriends(owner, [friend(owner, friendId, 'New name')])
    expect(store.getFriendRemovals(owner)[0]).toMatchObject({
      id: firstId, displayName: 'Original name', restoredAt: '2026-10-04T01:00:00.000Z'
    })
    vi.setSystemTime(new Date('2026-10-04T02:00:00Z'))
    store.replaceFriends(owner, [friend(owner, friendId, 'New name')])
    expect(store.getFriendRemovals(owner)[0]?.restoredAt).toBe('2026-10-04T01:00:00.000Z')
    store.replaceFriends(owner, [])
    const history = store.getFriendRemovals(owner)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ displayName: 'New name', detectedAt: '2026-10-04T02:00:00.000Z', restoredAt: null })
    expect(history[0]?.id).not.toBe(firstId)
    expect(history[1]?.id).toBe(firstId)
  })

  it('isolates the same friend under different accounts and cascades account removal', () => {
    const { store, read } = fixture()
    store.upsertAccount(account(other))
    store.replaceFriends(owner, [friend(owner, friendId, 'Owner cache')])
    store.replaceFriends(other, [friend(other, friendId, 'Other cache')])
    store.replaceFriends(owner, [])
    expect(store.getFriendRemovals(other)).toEqual([])
    expect(store.hasActiveFriend(other, friendId)).toBe(true)
    store.replaceFriends(other, [])
    store.replaceFriends(owner, [friend(owner, friendId)])
    expect(store.getFriendRemovals(owner)[0]?.restoredAt).not.toBeNull()
    expect(store.getFriendRemovals(other)[0]).toMatchObject({ displayName: 'Other cache', restoredAt: null })
    store.deleteAccount(owner)
    expect(store.getFriendRemovals(owner)).toEqual([])
    expect(read('SELECT COUNT(*) AS count FROM friend_removals')).toMatchObject({ count: 1 })
    expect(store.getFriendRemovals(other)).toHaveLength(1)
  })

  it('accepts a verified empty list but does not invent history on a first sync', () => {
    const { store } = fixture()
    store.replaceFriends(owner, [])
    expect(store.getFriendRemovals(owner)).toEqual([])
    store.replaceFriends(owner, [friend(owner, friendId), friend(owner, anotherId)])
    expect(store.getFriendRemovals(owner)).toEqual([])
    store.replaceFriends(owner, [])
    expect(store.getFriends(owner)).toEqual([])
    expect(store.getFriendRemovals(owner)).toHaveLength(2)
    store.replaceFriends(owner, [])
    expect(store.getFriendRemovals(owner)).toHaveLength(2)
  })

  it('migrates old inactive caches once without inventing a detection time', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId), friend(owner, anotherId)])
    data.close()
    data.sql(`DROP TABLE friend_removals;
      UPDATE friends SET is_active = 0 WHERE steam_id = '${friendId}';
      PRAGMA user_version = 2;`)
    const migrated = data.reopen()
    expect(data.read('PRAGMA user_version')).toMatchObject({ user_version: 4 })
    expect(migrated.getFriendRemovals(owner)).toEqual([{
      id: expect.any(String), accountId: owner, steamId: friendId,
      displayName: `Friend ${friendId}`, avatarUrl: `https://example.invalid/${friendId}.jpg`,
      profileUrl: `https://steamcommunity.com/profiles/${friendId}`,
      detectedAt: null, restoredAt: null, source: 'legacy'
    }])
    const original = migrated.getFriendRemovals(owner)
    const reopened = data.reopen()
    expect(reopened.getFriendRemovals(owner)).toEqual(original)
    reopened.replaceFriends(owner, [friend(owner, friendId), friend(owner, anotherId)])
    expect(reopened.getFriendRemovals(owner)[0]?.restoredAt).not.toBeNull()
    expect(reopened.getFriendRemovals(owner)[0]?.detectedAt).toBeNull()
    expect(data.reopen().getFriendRemovals(owner)).toHaveLength(1)
  })

  it('does not backfill a second legacy event for an existing restored history', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId)])
    data.store.replaceFriends(owner, [])
    data.store.replaceFriends(owner, [friend(owner, friendId)])
    const history = data.store.getFriendRemovals(owner)
    data.close()
    data.sql('UPDATE friends SET is_active = 0; PRAGMA user_version = 2;')
    expect(data.reopen().getFriendRemovals(owner)).toEqual(history)
  })

  it('exports and reopens all history without copying login secrets', async () => {
    const data = fixture()
    data.store.upsertAccount(account(owner), 'synthetic-sensitive-refresh-token')
    data.store.replaceFriends(owner, [friend(owner, friendId)])
    const group = data.store.createGroup(owner, 'Retained', '#66c0f4')
    data.store.setFriendGroups(owner, [friendId], [group.id])
    data.store.setBlacklist(owner, [friendId], true)
    data.store.replaceFriends(owner, [])
    const original = data.store.getFriendRemovals(owner)
    const exportedPath = join(data.directory, 'export.sqlite3')
    await data.store.exportDatabase(exportedPath)
    const exported = new SqliteStore(exportedPath, cipher)
    try {
      expect(exported.getFriendRemovals(owner)).toEqual(original)
      expect(exported.getRefreshToken(owner)).toBeNull()
      expect(readFileSync(exportedPath).includes(Buffer.from('synthetic-sensitive-refresh-token'))).toBe(false)
      exported.replaceFriends(owner, [friend(owner, friendId)])
      expect(exported.getFriend(owner, friendId)?.groupIds).toEqual([group.id])
      expect(exported.isBlacklisted(owner, friendId)).toBe(true)
    } finally {
      exported.close()
    }
    expect(data.store.getRefreshToken(owner)).toBe('synthetic-sensitive-refresh-token')
    expect(data.store.getFriendRemovals(owner)).toEqual(original)
  })

  it.each([
    ['wrong account', [{ ...friend(owner, friendId), accountId: other }]],
    ['invalid Steam ID', [{ ...friend(owner, friendId), steamId: 'not-an-id' }]],
    ['numeric Steam ID', [{ ...friend(owner, friendId), steamId: 76561198000000101 }]],
    ['self as friend', [friend(owner, owner)]],
    ['duplicate Steam ID', [friend(owner, friendId), friend(owner, friendId)]],
    ['missing profile', [{ ...friend(owner, friendId), profileUrl: undefined }]],
    ['invalid state', [{ ...friend(owner, friendId), onlineState: 'invalid' }]],
    ['null entry', [null]],
    ['non-array list', null]
  ])('rejects %s without changing friends, sync timestamp, or history', (_, invalid) => {
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId), friend(owner, anotherId)])
    const before = store.getFriends(owner)
    const syncTime = store.getAccount(owner)?.lastFriendSyncAt
    expect(() => store.replaceFriends(owner, invalid as Omit<FriendRecord, 'groupIds'>[])).toThrow()
    expect(store.getFriends(owner)).toEqual(before)
    expect(store.getAccount(owner)?.lastFriendSyncAt).toBe(syncTime)
    expect(store.getFriendRemovals(owner)).toEqual([])
  })

  it('rejects an unknown account even for an empty input', () => {
    const { store } = fixture()
    expect(() => store.replaceFriends(other, [])).toThrow(/账号不存在/)
    expect(store.getFriendRemovals(other)).toEqual([])
  })

  it('rolls back newly recorded removals when a later friend write fails', () => {
    const { store, sql } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId)])
    const before = store.getFriends(owner)
    const syncTime = store.getAccount(owner)?.lastFriendSyncAt
    sql(`CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON friends
      WHEN NEW.steam_id = '${anotherId}' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`)
    expect(() => store.replaceFriends(owner, [friend(owner, anotherId)])).toThrow(/synthetic write failure/)
    expect(store.getFriends(owner)).toEqual(before)
    expect(store.getFriendRemovals(owner)).toEqual([])
    expect(store.getAccount(owner)?.lastFriendSyncAt).toBe(syncTime)
  })

  it('enforces a single open event and account-scoped friend foreign keys', () => {
    const { store, sql } = fixture()
    store.upsertAccount(account(other))
    store.replaceFriends(owner, [friend(owner, friendId)])
    store.replaceFriends(owner, [])
    expect(() => sql(`INSERT INTO friend_removals
      (id, account_id, steam_id, display_name, profile_url, detected_at, source)
      VALUES ('duplicate', '${owner}', '${friendId}', 'Duplicate', '', '2026-10-04T00:00:00Z', 'sync')`)).toThrow(/UNIQUE/)
    expect(() => sql(`INSERT INTO friend_removals
      (id, account_id, steam_id, display_name, profile_url, detected_at, source)
      VALUES ('wrong-account', '${other}', '${friendId}', 'Cross-account', '', '2026-10-04T00:00:00Z', 'sync')`)).toThrow(/FOREIGN KEY/)
    expect(store.getFriendRemovals(owner)).toHaveLength(1)
    expect(store.getFriendRemovals(other)).toEqual([])
  })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-removals-test-'))
  const path = join(directory, 'data.sqlite3')
  const store = new SqliteStore(path, cipher)
  const resource = { directory, current: store as SqliteStore | null }
  resources.push(resource)
  store.upsertAccount(account(owner))
  const close = () => {
    resource.current?.close()
    resource.current = null
  }
  return {
    directory,
    store,
    close,
    reopen: () => {
      close()
      resource.current = new SqliteStore(path, cipher)
      return resource.current
    },
    sql: (sql: string) => {
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA foreign_keys = ON;')
        db.exec(sql)
      } finally { db.close() }
    },
    read: (sql: string, ...args: string[]) => {
      const db = new DatabaseSync(path)
      try { return db.prepare(sql).get(...args) } finally { db.close() }
    }
  }
}

function account(id: string): AccountRecord {
  return {
    id, steamId: id, accountName: `account-${id}`, displayName: `Account ${id}`, avatarUrl: '',
    createdAt: '2026-10-04T00:00:00.000Z', lastLoginAt: null,
    lastFriendSyncAt: null, lastEmoticonSyncAt: null
  }
}

function friend(accountId: string, steamId: string, displayName = `Friend ${steamId}`): Omit<FriendRecord, 'groupIds'> {
  return {
    accountId, steamId, displayName, avatarUrl: `https://example.invalid/${steamId}.jpg`,
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline', syncedAt: '2026-10-04T00:00:00.000Z'
  }
}
