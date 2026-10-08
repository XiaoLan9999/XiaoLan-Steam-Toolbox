import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountRecord, FriendRecord } from '../src/shared/types'
import { SecretCipher, SqliteStore } from '../src/main/store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SqliteStore account isolation', () => {
  it('keeps the same Steam friend in different per-account groups', () => {
    const { store } = createStore()
    const accountA = createAccount('76561198000000001', 'Account A')
    const accountB = createAccount('76561198000000002', 'Account B')
    const sharedFriend = '76561198000000999'
    store.upsertAccount(accountA, 'token-a')
    store.upsertAccount(accountB, 'token-b')
    store.replaceFriends(accountA.id, [createFriend(accountA.id, sharedFriend, 'Shared A')])
    store.replaceFriends(accountB.id, [createFriend(accountB.id, sharedFriend, 'Shared B')])
    const groupA = store.createGroup(accountA.id, 'A only', '#66c0f4')
    const groupB = store.createGroup(accountB.id, 'B only', '#7cc576')

    store.setFriendGroups(accountA.id, [sharedFriend], [groupA.id])
    store.setFriendGroups(accountB.id, [sharedFriend], [groupB.id])

    expect(store.getFriends(accountA.id)[0]?.groupIds).toEqual([groupA.id])
    expect(store.getFriends(accountB.id)[0]?.groupIds).toEqual([groupB.id])
    expect(() => store.setFriendGroups(accountA.id, [sharedFriend], [groupB.id])).toThrowError(
      /不属于当前账号/
    )
    store.close()
  })

  it('round-trips refresh tokens through the cipher abstraction', () => {
    const { store } = createStore()
    const account = createAccount('76561198000000001', 'Account')
    store.upsertAccount(account, 'sensitive-refresh-token')
    expect(store.getRefreshToken(account.id)).toBe('sensitive-refresh-token')
    store.close()
  })
})

describe('SqliteStore persistent queue recovery', () => {
  it('marks an in-flight request uncertain and pauses the batch after restart', () => {
    const { store, databasePath } = createStore()
    const account = createAccount('76561198000000001', 'Account')
    const friend = createFriend(account.id, '76561198000000002', 'Friend')
    store.upsertAccount(account, 'token')
    store.replaceFriends(account.id, [friend])
    const batch = store.createBatch(account.id, 'hello', 15_000, [
      { friendSteamId: friend.steamId, friendName: friend.displayName, renderedMessage: 'hello' }
    ])
    store.setBatchRunning(batch.id)
    expect(store.takeNextDelivery(batch.id)?.status).toBe('sending')
    store.close()

    const recovered = new SqliteStore(databasePath, fakeCipher)
    const recoveredBatch = recovered.getBatch(batch.id)
    expect(recoveredBatch?.status).toBe('paused')
    expect(recoveredBatch?.deliveries[0]?.status).toBe('uncertain')
    expect(recoveredBatch?.deliveries[0]?.error).toContain('避免重复留言')
    recovered.close()
  })
})

const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decrypt: (value) => value.toString('utf8').replace(/^encrypted:/, '')
}

function createStore(): { store: SqliteStore; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'steam-commenter-test-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'test.sqlite3')
  return { store: new SqliteStore(databasePath, fakeCipher), databasePath }
}

function createAccount(id: string, displayName: string): AccountRecord {
  return {
    id,
    steamId: id,
    accountName: displayName.toLocaleLowerCase().replaceAll(' ', '_'),
    displayName,
    avatarUrl: '',
    createdAt: '2026-08-17T00:00:00.000Z',
    lastLoginAt: null,
    lastFriendSyncAt: null,
    lastEmoticonSyncAt: null
  }
}

function createFriend(
  accountId: string,
  steamId: string,
  displayName: string
): Omit<FriendRecord, 'groupIds'> {
  return {
    accountId,
    steamId,
    displayName,
    avatarUrl: '',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline',
    syncedAt: '2026-08-17T00:00:00.000Z'
  }
}
