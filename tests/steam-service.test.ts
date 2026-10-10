import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SteamService } from '../src/main/steam-service'
import { SecretCipher, SqliteStore } from '../src/main/store'
import { AccountRecord, AppEvent, FriendRecord } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  relationships: vi.fn(),
  summaries: vi.fn(),
  profile: vi.fn(),
  webCookies: vi.fn(),
  instances: [] as Array<{ accountId: string; expire: () => void }>
}))

vi.mock('steam-session', () => ({
  EAuthSessionGuardType: {},
  EAuthTokenPlatformType: { WebBrowser: 2 },
  ESessionPersistence: { Persistent: 1 },
  LoginSession: class {
    refreshToken = ''
    loginTimeout = 0
    async getWebCookies(): Promise<string[]> {
      return mocks.webCookies()
    }
  }
}))

vi.mock('../src/main/community-client', () => ({
  SteamCommunityClient: class {
    constructor(accountId: string, _cookies: string[], expire: () => void) {
      mocks.instances.push({ accountId, expire })
    }
    getFriendRelationships = mocks.relationships
    getProfileSummaries = mocks.summaries
    getProfileSummary = mocks.profile
  }
}))

const accountA = '76561198000000001'
const accountB = '76561198000000002'
const friendA = '76561198000000101'
const friendB = '76561198000000102'
const friendC = '76561198000000103'
const fixtures: Array<{ directory: string; store: SqliteStore }> = []

type Profile = Pick<FriendRecord, 'steamId' | 'displayName' | 'avatarUrl' | 'onlineState'>
type ProfilesResult = { profiles: Map<string, Profile>; error: Error | null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.instances.splice(0)
  mocks.profile.mockResolvedValue(null)
  mocks.webCookies.mockResolvedValue(['sessionid=test-session'])
  mocks.relationships.mockResolvedValue({ [friendA]: 3 })
  mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Updated friend')]))
})

afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SteamService artwork sessions', () => {
  it('keeps web cookies in the main process and returns an independent array', async () => {
    const { service, events } = await createService()
    const cookies = ['steamLoginSecure=artwork-test', 'sessionid=artwork-session']
    mocks.webCookies.mockResolvedValueOnce(cookies)
    const result = await service.getArtworkWebCookies(accountA)
    expect(result).toEqual(cookies)
    expect(result).not.toBe(cookies)
    expect(JSON.stringify(events)).not.toContain('artwork-session')
    await expect(service.getArtworkWebCookies(accountB)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' })
  })

  it('rejects cookies fetched across an account switch or removal', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const opening = service.getArtworkWebCookies(accountA)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await service.activateAccount(accountB)
    pending.resolve(['sessionid=stale-session'])
    await rejected
    service.removeAccount(accountB)
    await expect(service.getArtworkWebCookies(accountB)).rejects.toThrow()
  })

  it('rejects an old login session even after switching back to the same account', async () => {
    const { service } = await createService()
    const pending = deferred<string[]>()
    mocks.webCookies.mockReturnValueOnce(pending.promise)
    const opening = service.getArtworkWebCookies(accountA)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    pending.resolve(['sessionid=old-session'])
    await rejected
  })

  it('does not expose native cookie or token diagnostics on authentication failure', async () => {
    const { service } = await createService()
    mocks.webCookies.mockRejectedValueOnce(new Error('sessionid=private-cookie steamLoginSecure=private-token'))
    await expect(service.getArtworkWebCookies(accountA)).rejects.toMatchObject({ code: 'ARTWORK_AUTH_FAILED' })
    expect(service.isAuthenticated(accountA)).toBe(true)
  })
})

describe('SteamService friend synchronization', () => {
  it('records only newly resolved nickname changes and preserves the baseline across failed lookups', async () => {
    const { service, store } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendA, 'Original name')])
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'New name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toEqual([
      expect.objectContaining({ steamId: friendA, oldName: 'Original name', newName: 'New name' })
    ])
    mocks.summaries.mockResolvedValue(profileResult([], new Error('HTTP 503')))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(1)
    expect(store.getFriend(accountA, friendA)?.displayName).toBe('New name')
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Original name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(2)
    expect(store.getFriendNameChanges(accountA)[0]).toMatchObject({ oldName: 'New name', newName: 'Original name' })
  })

  it('does not count an initial SteamID placeholder becoming a resolved name as a rename', async () => {
    const { service, store } = await createService()
    mocks.summaries.mockResolvedValue(profileResult([], new Error('HTTP 429')))
    await service.syncFriends(accountA)
    expect(store.getFriend(accountA, friendA)?.displayName).toBe(friendA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(0)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'First resolved name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)).toHaveLength(0)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Second name')]))
    await service.syncFriends(accountA)
    expect(store.getFriendNameChanges(accountA)[0]).toMatchObject({
      oldName: 'First resolved name', newName: 'Second name'
    })
  })

  it('reports complete success only after all friend profiles are refreshed', async () => {
    const { service, store, events } = await createService()
    mocks.relationships.mockResolvedValue({ [friendA]: 3, [friendB]: 2 })

    expect(await service.syncFriends(accountA)).toBe(1)

    expect(mocks.summaries).toHaveBeenCalledWith([friendA])
    expect(store.getFriends(accountA)).toEqual([
      expect.objectContaining({ steamId: friendA, displayName: 'Updated friend' })
    ])
    expect(notices(events)).toEqual([
      { type: 'notice', level: 'success', message: '已同步 1 位好友及资料' }
    ])
  })

  it('retains successful profiles, cached missing profiles and account-scoped groups on partial failure', async () => {
    const { service, store, events } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendB, 'Cached friend')])
    store.replaceFriends(accountB, [friend(accountB, friendA, 'Other account name')])
    const group = store.createGroup(accountA, 'Local group', '#66c0f4')
    store.setFriendGroups(accountA, [friendB], [group.id])
    mocks.relationships.mockResolvedValue({ [friendA]: 3, [friendB]: 3, [friendC]: 3 })
    mocks.summaries.mockResolvedValue(
      profileResult([profile(friendA, 'Fresh friend')], new Error('HTTP 429 eyJsecret-token'))
    )

    expect(await service.syncFriends(accountA)).toBe(3)

    const friends = new Map(store.getFriends(accountA).map((item) => [item.steamId, item]))
    expect(friends.get(friendA)?.displayName).toBe('Fresh friend')
    expect(friends.get(friendB)).toMatchObject({
      displayName: 'Cached friend',
      avatarUrl: 'https://example.invalid/cached-avatar.jpg',
      groupIds: [group.id]
    })
    expect(friends.get(friendC)).toMatchObject({ displayName: friendC, onlineState: 'unknown' })
    expect(store.getFriends(accountB)[0]?.displayName).toBe('Other account name')
    expect(notices(events)).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('3 位），但 2 位资料暂未刷新')
      })
    ])
    expect(notices(events)[0]?.message).toContain('HTTP 429 [token]')
    expect(notices(events)[0]?.message).not.toContain('eyJsecret-token')
  })

  it('reports missing profiles without falsely claiming complete success', async () => {
    const { service, events } = await createService()
    mocks.summaries.mockResolvedValue(profileResult([]))

    await service.syncFriends(accountA)

    expect(notices(events)).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('Steam 未返回完整好友资料')
      })
    ])
  })

  it('coalesces concurrent manual syncs and allows another sync after completion', async () => {
    const { service, events } = await createService()
    const pending = deferred<Record<string, number>>()
    mocks.relationships.mockReturnValueOnce(pending.promise)

    const first = service.syncFriends(accountA)
    const second = service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(1)
    pending.resolve({ [friendA]: 3 })
    expect(await Promise.all([first, second])).toEqual([1, 1])
    expect(mocks.summaries).toHaveBeenCalledTimes(1)
    expect(notices(events)).toHaveLength(1)

    await service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })

  it('coalesces login-triggered automatic sync with a manual sync', async () => {
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const { service, events } = await createService(true)

    const manual = service.syncFriends(accountA)
    expect(mocks.relationships).toHaveBeenCalledTimes(1)
    pending.resolve(profileResult([profile(friendA, 'Fresh friend')]))
    expect(await manual).toBe(1)
    expect(mocks.summaries).toHaveBeenCalledTimes(1)
    expect(notices(events)).toHaveLength(1)
  })

  it('does not replace cached data when relationships fail, and clears the in-flight request', async () => {
    const { service, store, events } = await createService()
    store.replaceFriends(accountA, [friend(accountA, friendB, 'Cached friend')])
    mocks.relationships.mockRejectedValueOnce(new Error('HTTP 503'))

    await expect(service.syncFriends(accountA)).rejects.toThrow('HTTP 503')

    expect(store.getFriends(accountA)[0]?.displayName).toBe('Cached friend')
    expect(mocks.summaries).not.toHaveBeenCalled()
    expect(notices(events)).toHaveLength(0)
    expect(await service.syncFriends(accountA)).toBe(1)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })

  it('does not fetch profiles after the account was switched while relationships were loading', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<Record<string, number>>()
    mocks.relationships.mockReturnValueOnce(pending.promise)
    const sync = service.syncFriends(accountA)
    const rejection = expect(sync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })

    await service.activateAccount(accountB)
    pending.resolve({ [friendA]: 3 })
    await rejection

    expect(mocks.summaries).not.toHaveBeenCalled()
    expect(store.getFriends(accountA)).toHaveLength(0)
    expect(notices(events)).toHaveLength(0)
  })

  it('does not write profiles after the account was removed', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const sync = service.syncFriends(accountA)
    const rejection = expect(sync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    await vi.waitFor(() => expect(mocks.summaries).toHaveBeenCalledTimes(1))

    service.removeAccount(accountA)
    pending.resolve(profileResult([profile(friendA, 'Stale friend')]))
    await rejection

    expect(store.getAccount(accountA)).toBeNull()
    expect(store.getFriends(accountA)).toHaveLength(0)
    expect(notices(events)).toHaveLength(0)
  })

  it('does not reuse, overwrite or expire a newer session with results from an old session', async () => {
    const { service, store, events } = await createService()
    const pending = deferred<ProfilesResult>()
    mocks.summaries.mockReturnValueOnce(pending.promise)
    const oldSync = service.syncFriends(accountA)
    const rejection = expect(oldSync).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    await vi.waitFor(() => expect(mocks.summaries).toHaveBeenCalledTimes(1))
    const oldClient = mocks.instances[0]!

    await service.activateAccount(accountB)
    await service.activateAccount(accountA)
    mocks.summaries.mockResolvedValue(profileResult([profile(friendA, 'Current friend')]))
    expect(await service.syncFriends(accountA)).toBe(1)
    oldClient.expire()
    expect(service.isAuthenticated(accountA)).toBe(true)
    pending.resolve(profileResult([profile(friendA, 'Stale friend')]))
    await rejection

    expect(store.getFriends(accountA)[0]?.displayName).toBe('Current friend')
    expect(notices(events)).toHaveLength(1)
    expect(mocks.relationships).toHaveBeenCalledTimes(2)
  })
})

const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  backend: () => 'test',
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => value.toString()
}

async function createService(autoSync = false): Promise<{
  service: SteamService
  store: SqliteStore
  events: AppEvent[]
}> {
  const directory = mkdtempSync(join(tmpdir(), 'steam-service-test-'))
  const store = new SqliteStore(join(directory, 'test.sqlite3'), fakeCipher)
  fixtures.push({ directory, store })
  store.upsertAccount(account(accountA, autoSync), 'test-token-a')
  store.upsertAccount(account(accountB), 'test-token-b')
  const events: AppEvent[] = []
  const service = new SteamService(store, (event) => events.push(event), vi.fn())
  await service.activateAccount(accountA)
  return { service, store, events }
}

function account(id: string, autoSync = false): AccountRecord {
  const now = new Date().toISOString()
  return {
    id,
    steamId: id,
    accountName: id,
    displayName: id,
    avatarUrl: '',
    createdAt: now,
    lastLoginAt: now,
    lastFriendSyncAt: autoSync ? null : now,
    lastEmoticonSyncAt: now
  }
}

function profile(steamId: string, displayName: string): Profile {
  return { steamId, displayName, avatarUrl: '', onlineState: 'online' }
}

function profileResult(profiles: Profile[], error: Error | null = null): ProfilesResult {
  return { profiles: new Map(profiles.map((item) => [item.steamId, item])), error }
}

function friend(accountId: string, steamId: string, displayName: string): Omit<FriendRecord, 'groupIds'> {
  return {
    accountId,
    steamId,
    displayName,
    avatarUrl: 'https://example.invalid/cached-avatar.jpg',
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    onlineState: 'offline',
    syncedAt: new Date().toISOString()
  }
}

function notices(events: AppEvent[]): Array<Extract<AppEvent, { type: 'notice' }>> {
  return events.filter((event) => event.type === 'notice')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
