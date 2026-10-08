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

describe('friend name change history', () => {
  it('starts a baseline on first sync and records every later name transition', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'))
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    expect(store.getFriendNameChanges(owner)).toEqual([])

    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'))
    store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    vi.setSystemTime(new Date('2026-10-08T02:00:00Z'))
    store.replaceFriends(owner, [friend(owner, friendId, 'Gamma')])
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    const history = store.getFriendNameChanges(owner)
    expect(history).toEqual([
      expect.objectContaining({ oldName: 'Gamma', newName: 'Alpha', detectedAt: '2026-10-08T03:00:00.000Z' }),
      expect.objectContaining({ oldName: 'Beta', newName: 'Gamma', detectedAt: '2026-10-08T02:00:00.000Z' }),
      expect.objectContaining({ oldName: 'Alpha', newName: 'Beta', detectedAt: '2026-10-08T01:00:00.000Z' })
    ])
    expect(history[0]).toMatchObject({
      id: expect.any(String), accountId: owner, steamId: friendId,
      avatarUrl: `https://example.invalid/${friendId}.jpg`,
      profileUrl: `https://steamcommunity.com/profiles/${friendId}`
    })
    expect(new Set(history.map((item) => item.id)).size).toBe(3)
  })

  it('does not create duplicate changes after repeated refreshes and restarts', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    const history = data.store.getFriendNameChanges(owner)
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    const reopened = data.reopen()
    reopened.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    expect(reopened.getFriendNameChanges(owner)).toEqual(history)
    reopened.replaceFriends(owner, [friend(owner, friendId, 'Gamma')])
    expect(reopened.getFriendNameChanges(owner)).toHaveLength(2)
  })

  it('ignores an initial placeholder and establishes the first verified profile without a change', () => {
    const { store, read } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, friendId)], { verifiedNameIds: new Set() })
    expect(read('SELECT COUNT(*) AS count FROM friend_name_baselines')).toMatchObject({ count: 0 })
    store.replaceFriends(owner, [friend(owner, friendId, 'Real name')], { verifiedNameIds: new Set([friendId]) })
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(read('SELECT display_name FROM friend_name_baselines')).toMatchObject({ display_name: 'Real name' })
    store.replaceFriends(owner, [friend(owner, friendId, 'Changed name')], { verifiedNameIds: new Set([friendId]) })
    expect(store.getFriendNameChanges(owner)[0]).toMatchObject({ oldName: 'Real name', newName: 'Changed name' })
  })

  it('compares fresh data with the last verified name after failed profile refreshes', () => {
    const { store, read } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Verified name')])
    store.replaceFriends(owner, [friend(owner, friendId, 'Cached or untrusted name')], { verifiedNameIds: new Set() })
    store.replaceFriends(owner, [friend(owner, friendId, friendId)], { verifiedNameIds: new Set() })
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(read('SELECT display_name FROM friend_name_baselines')).toMatchObject({ display_name: 'Verified name' })
    store.replaceFriends(owner, [friend(owner, friendId, 'Fresh name')], { verifiedNameIds: new Set([friendId]) })
    expect(store.getFriendNameChanges(owner)[0]).toMatchObject({ oldName: 'Verified name', newName: 'Fresh name' })
  })

  it('handles a mixed partial profile refresh per friend', () => {
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'First'), friend(owner, anotherId, 'Second')])
    store.replaceFriends(owner, [friend(owner, friendId, 'First changed'), friend(owner, anotherId, 'Wrong')], {
      verifiedNameIds: new Set([friendId])
    })
    expect(store.getFriendNameChanges(owner)).toEqual([
      expect.objectContaining({ steamId: friendId, oldName: 'First', newName: 'First changed' })
    ])
    store.replaceFriends(owner, [friend(owner, friendId, 'First changed'), friend(owner, anotherId, 'Second changed')])
    expect(store.getFriendNameChanges(owner)[0]).toMatchObject({ steamId: anotherId, oldName: 'Second', newName: 'Second changed' })
  })

  it('supports a verified nickname that happens to equal a Steam ID', () => {
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, friendId)], { verifiedNameIds: new Set([friendId]) })
    expect(store.getFriendNameChanges(owner)).toEqual([])
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    store.replaceFriends(owner, [friend(owner, friendId, friendId)], { verifiedNameIds: new Set([friendId]) })
    expect(store.getFriendNameChanges(owner)).toEqual([
      expect.objectContaining({ oldName: 'Alpha', newName: friendId }),
      expect.objectContaining({ oldName: friendId, newName: 'Alpha' })
    ])
  })

  it('does not replace a verified baseline with blank profile data', () => {
    const { store, read } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    store.replaceFriends(owner, [friend(owner, friendId, '  \t\n')])
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(read('SELECT display_name FROM friend_name_baselines')).toMatchObject({ display_name: 'Alpha' })
    store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    expect(store.getFriendNameChanges(owner)[0]).toMatchObject({ oldName: 'Alpha', newName: 'Beta' })
  })

  it('keeps baselines and history when a friend is removed and added again', () => {
    const { store } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    const original = store.getFriendNameChanges(owner)[0]!
    store.replaceFriends(owner, [])
    expect(store.getFriendNameChanges(owner)).toEqual([original])
    store.replaceFriends(owner, [friend(owner, friendId, 'Gamma')])
    expect(store.getFriendNameChanges(owner)).toEqual([
      expect.objectContaining({ oldName: 'Beta', newName: 'Gamma' }), original
    ])
    expect(store.getFriendRemovals(owner)[0]?.restoredAt).not.toBeNull()
  })

  it('isolates the same Steam ID between accounts and cascades deleted accounts', () => {
    const { store, read } = fixture()
    store.upsertAccount(account(other))
    store.replaceFriends(owner, [friend(owner, friendId, 'Owner alpha')])
    store.replaceFriends(other, [friend(other, friendId, 'Other alpha')])
    store.replaceFriends(owner, [friend(owner, friendId, 'Owner beta')])
    expect(store.getFriendNameChanges(other)).toEqual([])
    store.replaceFriends(other, [friend(other, friendId, 'Other beta')])
    expect(store.getFriendNameChanges(owner)[0]?.oldName).toBe('Owner alpha')
    expect(store.getFriendNameChanges(other)[0]?.oldName).toBe('Other alpha')
    store.deleteAccount(owner)
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(read('SELECT COUNT(*) AS count FROM friend_name_baselines')).toMatchObject({ count: 1 })
    expect(read('SELECT COUNT(*) AS count FROM friend_name_changes')).toMatchObject({ count: 1 })
    expect(store.getFriendNameChanges(other)).toHaveLength(1)
  })

  it('migrates v3 caches without inventing events or treating placeholder names as trusted', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Legacy real name'), friend(owner, anotherId, anotherId)])
    data.close()
    data.sql('DROP TABLE friend_name_changes; DROP TABLE friend_name_baselines; PRAGMA user_version = 3;')
    const migrated = data.reopen()
    expect(data.read('PRAGMA user_version')).toMatchObject({ user_version: 4 })
    expect(migrated.getFriendNameChanges(owner)).toEqual([])
    expect(data.read('SELECT COUNT(*) AS count FROM friend_name_baselines')).toMatchObject({ count: 1 })
    migrated.replaceFriends(owner, [friend(owner, friendId, 'Updated real name'), friend(owner, anotherId, 'First real name')])
    const history = migrated.getFriendNameChanges(owner)
    expect(history).toEqual([
      expect.objectContaining({ steamId: friendId, oldName: 'Legacy real name', newName: 'Updated real name' })
    ])
    expect(data.reopen().getFriendNameChanges(owner)).toEqual(history)
  })

  it('migrates an inactive friend baseline and skips empty old cache names', () => {
    const data = fixture()
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Inactive real name'), friend(owner, anotherId, '')])
    data.store.replaceFriends(owner, [])
    data.close()
    data.sql('DROP TABLE friend_name_changes; DROP TABLE friend_name_baselines; PRAGMA user_version = 3;')
    const migrated = data.reopen()
    migrated.replaceFriends(owner, [friend(owner, friendId, 'Restored new name'), friend(owner, anotherId, 'First real name')])
    expect(migrated.getFriendNameChanges(owner)).toEqual([
      expect.objectContaining({ steamId: friendId, oldName: 'Inactive real name', newName: 'Restored new name' })
    ])
  })

  it('exports names and trusted baselines without copying login secrets', async () => {
    const data = fixture()
    data.store.upsertAccount(account(owner), 'synthetic-private-refresh-token')
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    data.store.replaceFriends(owner, [friend(owner, friendId, 'Beta')])
    const history = data.store.getFriendNameChanges(owner)
    const destination = join(data.directory, 'export.sqlite3')
    await data.store.exportDatabase(destination)
    const exported = new SqliteStore(destination, cipher)
    try {
      expect(exported.getFriendNameChanges(owner)).toEqual(history)
      expect(exported.getRefreshToken(owner)).toBeNull()
      expect(readFileSync(destination).includes(Buffer.from('synthetic-private-refresh-token'))).toBe(false)
      exported.replaceFriends(owner, [friend(owner, friendId, 'Gamma')])
      expect(exported.getFriendNameChanges(owner)[0]).toMatchObject({ oldName: 'Beta', newName: 'Gamma' })
    } finally {
      exported.close()
    }
    expect(data.store.getFriendNameChanges(owner)).toEqual(history)
    expect(data.store.getRefreshToken(owner)).toBe('synthetic-private-refresh-token')
  })

  it('rolls back changed baselines and events when a later friend write fails', () => {
    const { store, sql, read } = fixture()
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    const before = store.getFriends(owner)
    const syncTime = store.getAccount(owner)?.lastFriendSyncAt
    sql(`CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON friends
      WHEN NEW.steam_id = '${anotherId}' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`)
    expect(() => store.replaceFriends(owner, [friend(owner, friendId, 'Beta'), friend(owner, anotherId, 'Another')]))
      .toThrow(/synthetic write failure/)
    expect(store.getFriends(owner)).toEqual(before)
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(read('SELECT display_name FROM friend_name_baselines')).toMatchObject({ display_name: 'Alpha' })
    expect(store.getAccount(owner)?.lastFriendSyncAt).toBe(syncTime)
    store.replaceFriends(owner, [friend(owner, friendId, 'Gamma')])
    expect(store.getFriendNameChanges(owner)[0]).toMatchObject({ oldName: 'Alpha', newName: 'Gamma' })
  })

  it('enforces account-scoped foreign keys for history and baselines', () => {
    const { store, sql } = fixture()
    store.upsertAccount(account(other))
    store.replaceFriends(owner, [friend(owner, friendId, 'Alpha')])
    expect(() => sql(`INSERT INTO friend_name_changes
      (id, account_id, steam_id, old_name, new_name, profile_url, detected_at)
      VALUES ('cross-account', '${other}', '${friendId}', 'Alpha', 'Beta', '', '2026-10-08T00:00:00Z')`))
      .toThrow(/FOREIGN KEY/)
    expect(() => sql(`INSERT INTO friend_name_baselines (account_id, steam_id, display_name, updated_at)
      VALUES ('${other}', '${friendId}', 'Alpha', '2026-10-08T00:00:00Z')`)).toThrow(/FOREIGN KEY/)
    expect(store.getFriendNameChanges(owner)).toEqual([])
    expect(store.getFriendNameChanges(other)).toEqual([])
  })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-name-changes-test-'))
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
    createdAt: '2026-10-08T00:00:00.000Z', lastLoginAt: null,
    lastFriendSyncAt: null, lastEmoticonSyncAt: null
  }
}

function friend(accountId: string, steamId: string, displayName: string): Omit<FriendRecord, 'groupIds'> {
  return {
    accountId, steamId, displayName, avatarUrl: `https://example.invalid/${steamId}.jpg`,
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline', syncedAt: '2026-10-08T00:00:00.000Z'
  }
}
