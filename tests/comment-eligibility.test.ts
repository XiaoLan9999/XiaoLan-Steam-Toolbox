import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCommentEligibility } from '../src/main/comment-eligibility-parser'
import { SteamCommunityClient } from '../src/main/community-client'
import { SteamService } from '../src/main/steam-service'
import type { SqliteStore } from '../src/main/store'
import type { CommentCheckResult } from '../src/shared/types'

const accountId = '76561198000000001'
const friendId = '76561198000000002'
const otherId = '76561198000000003'
const prefix = `commentthread_Profile_${friendId}`
const cookies = [
  `steamLoginSecure=${accountId}%7C%7Cfixture; Domain=steamcommunity.com`,
  'sessionid=fixture-session; Domain=steamcommunity.com'
]

afterEach(() => vi.unstubAllGlobals())

describe('read-only profile comment eligibility parser', () => {
  it('accepts only enabled target textarea and submit controls', () => {
    expect(parseCommentEligibility(profile(controls()), friendId)).toEqual({
      status: 'allowed', reason: '页面当前提供留言入口；不保证实际发送成功'
    })
  })

  it('recognizes the Steam submit container shown after entering text', () => {
    expect(parseCommentEligibility(profile(
      `<textarea id="${prefix}_textarea"></textarea>` +
      `<div id="${prefix}_submit_container" style="display: none">` +
      `<a id="${prefix}_submit">Post Comment</a></div>`
    ), friendId).status).toBe('allowed')
  })

  it('does not label an enabled form as blocked when a friends-only notice is also present', () => {
    const html = profile('<div>Only friends can post comments.</div>' + controls())
    expect(parseCommentEligibility(html, friendId).status).toBe('unknown')
  })

  it.each([
    ['Comments are disabled for this profile.', '关闭'],
    ['Only friends can post comments on this profile.', '好友'],
    ['This user has blocked you.', '屏蔽'],
    ['Your account does not have sufficient privileges to perform this action.', '权限'],
    ['您的账号暂时无法发表评论。', '权限']
  ])('marks explicit restriction %s as blocked', (notice, reason) => {
    const result = parseCommentEligibility(profile(`<div class="commentthread_entry_error">${notice}</div>`), friendId)
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain(reason)
  })

  it.each([
    '<div class="profile_private_info">This profile is private.</div>',
    '<div class="login_area"><form><input name="username"></form></div>',
    '<h1>Too Many Requests</h1>',
    '<h1>Access Denied</h1>',
    profile('<div>Comments</div>'),
    profile(controls(otherId)),
    profile(controls(), otherId),
    `<div id="${prefix}_area"></div>${controls()}`,
    `${profile(controls())}${profile(controls())}`,
    `<script>${profile(controls())}</script>`,
    `<template>${profile(controls())}</template>`
  ])('does not infer blocked or allowed from missing/ambiguous forms', (html) => {
    expect(parseCommentEligibility(html, friendId).status).toBe('unknown')
  })

  it.each(['disabled', 'readonly', 'hidden', 'inert', 'aria-disabled="true"', 'style="display:none"'])
  ('does not accept a textarea marked %s', (attribute) => {
    expect(parseCommentEligibility(profile(
      `<textarea id="${prefix}_textarea" ${attribute}></textarea><button id="${prefix}_submit">Post</button>`
    ), friendId).status).toBe('unknown')
  })

  it.each(['disabled', 'hidden', 'style="visibility: hidden"', 'class="disabled"', 'style="display:none"'])
  ('does not accept a submit control marked %s', (attribute) => {
    expect(parseCommentEligibility(profile(
      `<textarea id="${prefix}_textarea"></textarea><button id="${prefix}_submit" ${attribute}>Post</button>`
    ), friendId).status).toBe('unknown')
  })

  it('rejects controls under hidden or disabled ancestors', () => {
    expect(parseCommentEligibility(`<div hidden>${profile(controls())}</div>`, friendId).status).toBe('unknown')
    expect(parseCommentEligibility(profile(`<fieldset disabled>${controls()}</fieldset>`), friendId).status).toBe('unknown')
    expect(parseCommentEligibility(profile(`<div style="display:none">${controls()}</div>`), friendId).status).toBe('unknown')
  })

  it('does not treat profile biographies or user comments as permission evidence', () => {
    const html = '<div class="profile_summary">Comments are disabled.</div>' + profile(
      '<div class="commentthread_comments"><div class="commentthread_comment_text">Comments are disabled.</div></div>' +
      '<div class="commentthread_entry_error" style="display:none">This user has blocked you.</div>' + controls()
    )
    expect(parseCommentEligibility(html, friendId).status).toBe('allowed')
  })

  it('ignores enabled controls in a nested non-target comment thread', () => {
    expect(parseCommentEligibility(profile(profile(controls(), otherId)), friendId).status).toBe('unknown')
  })
})

describe('read-only profile comment eligibility requests', () => {
  it('uses only an authenticated GET and validates the target thread', async () => {
    const fetchMock = vi.fn(async () => new Response(profile(controls())))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    expect((await client.checkCommentEligibility(friendId)).status).toBe('allowed')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe(`/profiles/${friendId}/`)
    expect(url.searchParams.get('l')).toBe('english')
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(init.headers).toMatchObject({ Cookie: expect.stringContaining('steamLoginSecure=') })
  })

  it('follows bounded same-origin vanity redirects without losing target validation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: '/id/synthetic-friend/' } }))
      .mockResolvedValueOnce(new Response(profile(controls(otherId), otherId)))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    expect((await client.checkCommentEligibility(friendId)).status).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([429, 401])('keeps HTTP %i as a task-pausing domain error', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({
      code: status === 429 ? 'RATE_LIMITED' : 'SESSION_EXPIRED'
    })
  })

  it('does not label HTTP 403 as friend rejection or expire the whole account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Access Denied', { status: 403 })))
    const expire = vi.fn()
    const client = new SteamCommunityClient(accountId, cookies, expire)
    expect((await client.checkCommentEligibility(friendId)).status).toBe('unknown')
    expect(expire).not.toHaveBeenCalled()
  })

  it('preserves explicit authentication failure even when returned with HTTP 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":21}', { status: 403 })))
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('stops on a login redirect instead of retrying or treating it as blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 302, headers: { Location: 'https://steamcommunity.com/login/home/' }
    })))
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('does not follow external redirects or post test comments', async () => {
    const fetchMock = vi.fn(async () => new Response('', {
      status: 302, headers: { Location: 'https://example.invalid/' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    expect((await client.checkCommentEligibility(friendId)).status).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('propagates network failures so the queue can mark unknown and pause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({ code: 'CHECK_REQUEST_FAILED' })
  })

  it('propagates service outages so a long scan will pause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status: 503 })))
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({ code: 'CHECK_REQUEST_FAILED' })
  })
})

describe('SteamService comment eligibility account boundary', () => {
  it('requires an active account and a known friend before requesting a page', async () => {
    const { service, check } = serviceFixture()
    await expect(service.checkCommentEligibility(otherId, friendId)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' })
    await expect(service.checkCommentEligibility(accountId, otherId)).rejects.toMatchObject({ code: 'FRIEND_NOT_FOUND' })
    expect(check).not.toHaveBeenCalled()
  })

  it('discards results from a session replaced during the check', async () => {
    const { service, check } = serviceFixture()
    let resolve!: (result: CommentCheckResult) => void
    check.mockReturnValueOnce(new Promise<CommentCheckResult>((done) => { resolve = done }))
    const pending = service.checkCommentEligibility(accountId, friendId)
    ;(service as unknown as { runtime: unknown }).runtime = null
    resolve({ status: 'allowed', reason: 'fixture' })
    await expect(pending).rejects.toMatchObject({ code: 'CHECK_CANCELLED' })
  })

  it('refuses blacklisted friends even when called outside the sending queue', async () => {
    const { service, store, post } = serviceFixture()
    store.isBlacklisted.mockReturnValue(true)
    await expect(service.postProfileComment(accountId, friendId, 'Never sent')).rejects.toMatchObject({
      code: 'FRIEND_BLACKLISTED'
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses removed friends even when called outside the sending queue', async () => {
    const { service, store, post } = serviceFixture()
    store.hasActiveFriend.mockReturnValue(false)
    await expect(service.postProfileComment(accountId, friendId, 'Never sent')).rejects.toMatchObject({
      code: 'FRIEND_NOT_FOUND'
    })
    expect(store.hasActiveFriend).toHaveBeenCalledExactlyOnceWith(accountId, friendId)
    expect(post).not.toHaveBeenCalled()
  })
})

function controls(id = friendId): string {
  return `<textarea id="commentthread_Profile_${id}_textarea"></textarea>` +
    `<a id="commentthread_Profile_${id}_submit">Post Comment</a>`
}

function profile(content: string, id = friendId): string {
  return `<div class="commentthread_area" id="commentthread_Profile_${id}_area">${content}</div>`
}

function serviceFixture() {
  const store = {
    getActiveAccountId: vi.fn(() => accountId),
    getAccount: vi.fn(() => ({ id: accountId })),
    getFriend: vi.fn((account: string, steamId: string) =>
      account === accountId && steamId === friendId ? { steamId: friendId } : null),
    hasActiveFriend: vi.fn((account: string, steamId: string) => account === accountId && steamId === friendId),
    isBlacklisted: vi.fn(() => false)
  }
  const check = vi.fn<(steamId: string) => Promise<CommentCheckResult>>()
    .mockResolvedValue({ status: 'allowed', reason: 'fixture' })
  const post = vi.fn()
  const service = new SteamService(store as unknown as SqliteStore, vi.fn(), vi.fn())
  ;(service as unknown as { runtime: unknown }).runtime = {
    accountId, community: { checkCommentEligibility: check, postProfileComment: post }
  }
  return { service, store, check, post }
}
