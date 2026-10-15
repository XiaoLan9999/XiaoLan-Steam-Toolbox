import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'

const fixtures: Array<{ directory: string; store: SqliteStore }> = []
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
const first = '76561198000000001'
const second = '76561198000000002'
const account = (id: string) => ({ id, steamId: id, accountName: 'Synthetic', displayName: 'Synthetic', avatarUrl: '',
  createdAt: '2026-10-15T00:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
const cipher: SecretCipher = { isAvailable: () => true, backend: () => 'fixture',
  encrypt: value => Buffer.from(`fixture-encrypted:${value}`), decrypt: value => value.toString().replace(/^fixture-encrypted:/, '') }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-session-token-'))
  const store = new SqliteStore(join(directory, 'fixture.sqlite3'), cipher)
  fixtures.push({ directory, store })
  store.upsertAccount(account(first), 'synthetic-token-old')
  store.upsertAccount(account(second), 'synthetic-token-other')
  return store
}

describe('refresh-token-only persistence', () => {
  it('updates only the encrypted token without changing active account, profile, or drafts', () => {
    const store = fixture()
    store.updateSettings(first, 'Synthetic saved draft', 5000)
    const before = store.getAccount(first)
    store.saveRefreshToken(first, 'synthetic-token-new')
    expect(store.getRefreshToken(first)).toBe('synthetic-token-new')
    expect(store.getRefreshToken(second)).toBe('synthetic-token-other')
    expect(store.getActiveAccountId()).toBe(second)
    expect(store.getAccount(first)).toEqual(before)
    expect(store.getSettings(first)).toMatchObject({ draft: 'Synthetic saved draft', delayMs: 5000 })
  })

  it('does not recreate a removed account or accept an empty token', () => {
    const store = fixture()
    expect(() => store.saveRefreshToken(first, '')).toThrow(/令牌无效/)
    expect(store.getRefreshToken(first)).toBe('synthetic-token-old')
    store.deleteAccount(first)
    expect(() => store.saveRefreshToken(first, 'synthetic-token-new')).toThrow(/账号不存在/)
    expect(store.getAccount(first)).toBeNull()
    expect(store.getActiveAccountId()).toBe(second)
  })
})
