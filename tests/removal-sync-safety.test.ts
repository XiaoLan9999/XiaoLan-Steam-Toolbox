import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { SteamService } from '../src/main/steam-service'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AccountRecord, AppEvent, FriendRecord } from '../src/shared/types'

const owner = '76561198000000001'
const other = '76561198000000002'
const friendIds = Array.from({ length: 1005 }, (_, index) => String(76561198001000000n + BigInt(index)))
const resources: Array<{ directory: string; store: SqliteStore }> = []
const cipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: value => Buffer.from(value),
  decrypt: value => value.toString()
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const { directory, store } of resources.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('authoritative friend snapshot removal safety', () => {
  it.each([500, 429])('does not remove cached friends or create history on relationship HTTP %i', async (status) => {
    const { service, store, events } = fixture()
    const cached = store.getFriends(owner)
    const lastSync = store.getAccount(owner)!.lastFriendSyncAt
    const fetchMock = vi.fn(async () => new Response('Unavailable', { status }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.syncFriends(owner)).rejects.toThrow(String(status))

    expect(store.getFriends(owner)).toEqual(cached)
    expect(store.getAccount(owner)!.lastFriendSyncAt).toBe(lastSync)
    expect(store.getFriendRemovals(owner)).toHaveLength(0)
    expect(store.getFriendRemovals(other)).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events).toHaveLength(0)
  })

  it.each([
    { success: 1, friendslist: {} },
    { success: true, friendslist: { friends: [] } },
    { success: 1, friendslist: { friends: [null] } },
    { success: 1, friendslist: { friends: [{ ulfriendid: friendIds[0], efriendrelationship: null }] } },
    { success: 1, friendslist: { friends: [
      { ulfriendid: friendIds[0], efriendrelationship: 3 },
      { ulfriendid: friendIds[1], efriendrelationship: 'invalid' }
    ] } }
  ])('does not treat a malformed or partially parsed relationship response as removals: %j', async body => {
    const { service, store } = fixture()
    const cached = store.getFriends(owner)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)))

    await expect(service.syncFriends(owner)).rejects.toThrow('malformed friends list')

    expect(store.getFriends(owner)).toEqual(cached)
    expect(store.getFriendRemovals(owner)).toHaveLength(0)
    expect(store.getFriends(other)).toHaveLength(1005)
  })

  it('does not generate removal history when Steam returns a logged-out relationship response', async () => {
    const { service, store } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: 21 }), { status: 500 })))

    await expect(service.syncFriends(owner)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    expect(service.isAuthenticated(owner)).toBe(false)
    expect(store.getFriends(owner)).toHaveLength(1005)
    expect(store.getFriendRemovals(owner)).toHaveLength(0)
  })

  it('discards a successful relationship list if the session expires during persona loading', async () => {
    const { service, store } = fixture()
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.includes('ajaxgetfriendslist')
      ? relationshipResponse(friendIds.slice(0, -1))
      : new Response('Unauthorized', { status: 401 })))

    await expect(service.syncFriends(owner)).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })

    expect(store.getFriends(owner)).toHaveLength(1005)
    expect(store.getFriendRemovals(owner)).toHaveLength(0)
  })

  it.each([429, 500])('does not confuse HTTP %i persona failure with relationship removals', async status => {
    const { service, store, events } = fixture()
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.includes('ajaxgetfriendslist')
      ? relationshipResponse(friendIds)
      : new Response('Personas unavailable', { status })))

    expect(await service.syncFriends(owner)).toBe(1005)

    expect(store.getFriends(owner)).toHaveLength(1005)
    expect(store.getFriends(owner).every(item => item.displayName.startsWith('Cached '))).toBe(true)
    expect(store.getFriendRemovals(owner)).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'warning' }))
  })

  it.each(['fresh', 'cached'])('records exactly one 1005-to-1004 removal with %s persona data', async mode => {
    const { service, store, events } = fixture()
    const currentIds = friendIds.slice(0, -1)
    const removedId = friendIds.at(-1)!
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (url.pathname.includes('ajaxgetfriendslist')) return relationshipResponse(currentIds)
      return mode === 'cached'
        ? new Response('Rate limited', { status: 429 })
        : new Response(currentIds.map(id => `<div class="friend_block_v2 persona online" data-steamid="${id}">
          <div class="friend_block_content">Fresh ${id}<br><span>Online</span></div></div>`).join(''))
    }))

    expect(await service.syncFriends(owner)).toBe(1004)

    expect(store.getFriends(owner)).toHaveLength(1004)
    expect(store.getFriends(owner).every(item => item.displayName.startsWith(mode === 'cached' ? 'Cached ' : 'Fresh '))).toBe(true)
    expect(store.hasActiveFriend(owner, removedId)).toBe(false)
    expect(store.getFriendRemovals(owner)).toEqual([
      expect.objectContaining({ steamId: removedId, displayName: `Cached ${removedId}` })
    ])
    expect(store.getFriends(other)).toHaveLength(1005)
    expect(store.getFriendRemovals(other)).toHaveLength(0)
    expect(store.hasActiveFriend(other, removedId)).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'notice', level: mode === 'cached' ? 'warning' : 'success',
      message: expect.stringContaining('1004')
    }))

    expect(await service.syncFriends(owner)).toBe(1004)
    expect(store.getFriendRemovals(owner)).toHaveLength(1)
  })

  it('blocks a removed friend at the service boundary without issuing a POST', async () => {
    const { service, store } = fixture()
    const removedId = friendIds.at(-1)!
    store.replaceFriends(owner, store.getFriends(owner).filter(item => item.steamId !== removedId))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.postProfileComment(owner, removedId, 'Must not be sent')).rejects.toMatchObject({
      code: 'FRIEND_NOT_FOUND'
    })

    expect(store.hasActiveFriend(other, removedId)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-removal-sync-test-'))
  const store = new SqliteStore(join(directory, 'test.sqlite3'), cipher)
  resources.push({ directory, store })
  const timestamp = new Date().toISOString()
  for (const id of [other, owner]) {
    const account: AccountRecord = { id, steamId: id, accountName: 'Test', displayName: 'Test',
      avatarUrl: '', createdAt: timestamp, lastLoginAt: timestamp,
      lastFriendSyncAt: timestamp, lastEmoticonSyncAt: timestamp }
    store.upsertAccount(account)
    store.replaceFriends(id, friendIds.map(steamId => ({
      accountId: id, steamId, displayName: `Cached ${steamId}`, avatarUrl: '',
      profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
      onlineState: 'offline', syncedAt: timestamp
    } satisfies Omit<FriendRecord, 'groupIds'>)))
  }
  const events: AppEvent[] = []
  const service = new SteamService(store, event => events.push(event), vi.fn())
  const runtime = service as unknown as { runtime: unknown }
  const community = new SteamCommunityClient(owner, [
    `steamLoginSecure=${owner}%7C%7Ctest-token; Domain=steamcommunity.com`,
    'sessionid=test-session; Domain=steamcommunity.com'
  ], () => { runtime.runtime = null })
  runtime.runtime = { accountId: owner, community }
  return { service, store, events }
}

function relationshipResponse(ids: string[]): Response {
  return jsonResponse({ success: 1, friendslist: { friends: ids.map(ulfriendid => ({ ulfriendid, efriendrelationship: 3 })) } })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}
