import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { SteamService } from '../src/main/steam-service'
import { BatchQueue } from '../src/main/batch-queue'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import { emptyCommentProfile } from './helpers/comment-baseline'

const account = '76561198000000001'
const otherAccount = '76561198000000002'
const friend = '76561198000000101'
const message = 'Synthetic pre-submit guard message'
const cipher: SecretCipher = {
  isAvailable: () => false, backend: () => 'synthetic-fixture',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString()
}
const resources: Array<{ directory: string; store: SqliteStore; service: SteamService; queue: BatchQueue }> = []
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  for (const { directory, store, service, queue } of resources.splice(0)) {
    queue.shutdown()
    service.dispose()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fixture(options: { deferBaseline?: boolean; deferPost?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-pre-submit-guard-'))
  const store = new SqliteStore(join(directory, 'synthetic.sqlite3'), cipher)
  const stamp = new Date().toISOString()
  for (const id of [account, otherAccount]) store.upsertAccount({
    id, steamId: id, accountName: 'Synthetic account', displayName: 'Synthetic account', avatarUrl: '',
    createdAt: stamp, lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null
  })
  store.setActiveAccountId(account)
  store.replaceFriends(account, [{
    accountId: account, steamId: friend, displayName: 'Synthetic friend', avatarUrl: '',
    profileUrl: '', onlineState: 'offline', syncedAt: stamp
  }])
  const baseline = deferred<Response>()
  const baselineStarted = deferred<void>()
  const post = deferred<Response>()
  const postStarted = deferred<void>()
  let reads = 0
  const fetch = vi.fn(async (url: URL, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      expect(url.href).toBe(`https://steamcommunity.com/comment/Profile/post/${friend}/-1/`)
      expect(new URLSearchParams(String(init.body)).get('comment')).toBe(message)
      postStarted.resolve()
      return options.deferPost ? post.promise : new Response(JSON.stringify({ success: true, comments_html: '<div id="comment_42"></div>' }))
    }
    expect(url.href).toBe(`https://steamcommunity.com/profiles/${friend}/?l=english`)
    expect(init.body).toBeUndefined()
    baselineStarted.resolve()
    return options.deferBaseline !== false && reads++ === 0 ? baseline.promise : emptyCommentProfile(account, friend)
  })
  vi.stubGlobal('fetch', fetch)
  const service = new SteamService(store, () => undefined, () => undefined)
  const community = new SteamCommunityClient(account, [
    `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
    'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com'
  ], () => undefined)
  Object.assign(service, { runtime: {
    accountId: account, community, refreshAt: Date.now() + 600_000, refresh: null, recovering: false
  } })
  const queue = new BatchQueue(store, service, () => undefined)
  resources.push({ directory, store, service, queue })
  return {
    store, service, community, queue, fetch, baselineStarted, postStarted, post,
    finishBaseline: () => baseline.resolve(emptyCommentProfile(account, friend)),
    input: { accountId: account, friendSteamIds: [friend], messageTemplate: message, delayMs: 100 },
    postCalls: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  }
}

describe('real service and client pre-submit state guards', () => {
  it.each(['switch-account', 'switch-away-and-back', 'dispose', 'blacklist', 'remove-friend'] as const)
  ('does not POST after %s while the baseline GET is in flight', async action => {
    const f = fixture()
    const pending = f.service.postProfileComment(account, friend, message)
    await f.baselineStarted.promise
    if (action === 'switch-account' || action === 'switch-away-and-back') await f.service.activateAccount(otherAccount)
    if (action === 'switch-away-and-back') await f.service.activateAccount(account)
    if (action === 'dispose') f.service.dispose()
    if (action === 'blacklist') f.store.setBlacklist(account, [friend], true)
    if (action === 'remove-friend') f.store.replaceFriends(account, [])
    f.finishBaseline()
    await expect(pending).rejects.toMatchObject({ code: action === 'blacklist' ? 'FRIEND_BLACKLISTED'
      : action === 'remove-friend' ? 'FRIEND_NOT_FOUND' : 'SESSION_PREPARATION_FAILED' })
    expect(f.postCalls()).toHaveLength(0)
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('checks caller permission before issuing even a baseline GET', async () => {
    const f = fixture()
    await expect(f.service.postProfileComment(account, friend, message, () => false))
      .rejects.toMatchObject({ code: 'SESSION_PREPARATION_FAILED', retryable: true })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('checks caller permission again after the baseline without changing target or message', async () => {
    const f = fixture()
    let permitted = true
    const pending = f.service.postProfileComment(account, friend, message, () => permitted)
    await f.baselineStarted.promise
    permitted = false
    f.finishBaseline()
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_PREPARATION_FAILED', retryable: true })
    expect(f.postCalls()).toHaveLength(0)
  })

  it('does not relabel an already submitted denial as preparation after the account changes', async () => {
    const f = fixture({ deferBaseline: false, deferPost: true })
    const pending = f.service.postProfileComment(account, friend, message)
    await f.postStarted.promise
    await f.service.activateAccount(otherAccount)
    f.post.resolve(new Response('{"success":2}', { status: 403 }))
    await expect(pending).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(f.postCalls()).toHaveLength(1)
  })
})

describe('real queue cancellation during comment baselines', () => {
  it.each(['pause', 'cancel', 'shutdown'] as const)('does not submit after %s during the baseline GET', async action => {
    const f = fixture()
    const task = f.queue.start(f.input)
    await f.baselineStarted.promise
    expect(f.store.getBatchSummary(task.id)).toMatchObject({ sending: 1, pending: 0 })
    if (action === 'pause') f.queue.pause(task.id)
    if (action === 'cancel') f.queue.cancel(task.id)
    if (action === 'shutdown') f.queue.shutdown()
    f.finishBaseline()
    await vi.waitFor(() => expect(f.queue.hasPendingRequests()).toBe(false))
    expect(f.postCalls()).toHaveLength(0)
    expect(f.store.getBatchSummary(task.id)).toMatchObject({
      status: action === 'cancel' ? 'cancelled' : 'paused',
      sending: 0, pending: action === 'cancel' ? 0 : 1, cancelled: action === 'cancel' ? 1 : 0,
      succeeded: 0, failedCount: 0, uncertain: 0, nextRetryAt: null
    })
  })

  it('invalidates the old baseline after pause/resume and submits only the new worker once', async () => {
    const f = fixture()
    const task = f.queue.start(f.input)
    await f.baselineStarted.promise
    f.queue.pause(task.id)
    f.queue.resume(task.id)
    f.finishBaseline()
    await vi.waitFor(() => expect(f.store.getBatchSummary(task.id)?.status).toBe('completed'))
    expect(f.postCalls()).toHaveLength(1)
    expect(f.fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'GET', 'POST'])
    expect(f.store.getBatchSummary(task.id)).toMatchObject({ succeeded: 1, uncertain: 0, pending: 0 })
  })

  it('keeps a submitted POST uncertain rather than restoring it to pending after cancellation', async () => {
    const f = fixture({ deferBaseline: false, deferPost: true })
    const task = f.queue.start(f.input)
    await f.postStarted.promise
    f.queue.cancel(task.id)
    f.post.resolve(new Response('{"success":2}', { status: 403 }))
    await vi.waitFor(() => expect(f.queue.hasPendingRequests()).toBe(false))
    expect(f.postCalls()).toHaveLength(1)
    expect(f.store.getBatchSummary(task.id)).toMatchObject({ status: 'cancelled', pending: 0, sending: 0,
      uncertain: 1, succeeded: 0, nextRetryAt: null })
  })
})
