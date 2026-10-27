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

  it('recognizes the current Steam styled span submit instead of requiring a native button', () => {
    expect(parseCommentEligibility(steamCommentEntry(), friendId)).toEqual({
      status: 'allowed', reason: '页面当前提供留言入口；不保证实际发送成功'
    })
  })

  it.each(['disabled', 'hidden', 'aria-disabled="true"', 'class="disabled"', 'class="btn_green_white_innerfade btn_disabled"'])
  ('does not accept a Steam span submit marked %s', (attribute) => {
    expect(parseCommentEligibility(profile(
      `<textarea id="${prefix}_textarea"></textarea>` +
      `<div id="${prefix}_submit_container" style="display: none">` +
      `<span id="${prefix}_submit" ${attribute}><span>Post Comment</span></span></div>`
    ), friendId).status).toBe('unknown')
  })

  it('rejects a hidden entry even if its submit container is conditionally hidden', () => {
    expect(parseCommentEligibility(steamCommentEntry('style="display: none"'), friendId).status).toBe('unknown')
  })

  it('does not use the bootstrap alone as permission or let user comments forge an entry', () => {
    const html = steamCommentBootstrap() + profile(
      `<div class="commentthread_comments">${steamCommentEntry()}</div>`
    )
    expect(parseCommentEligibility(html, friendId).status).toBe('unknown')
  })

  it('does not accept a duplicated styled span submit', () => {
    const duplicate = `<span id="${prefix}_submit"><span>Post Comment</span></span>`
    expect(parseCommentEligibility(steamCommentEntry().replace('</form>', `${duplicate}</form>`), friendId).status)
      .toBe('unknown')
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

  it('recognizes the target-bound official private profile layout without relying on translated text', () => {
    expect(parseCommentEligibility(privateProfile(), friendId)).toEqual({
      status: 'blocked', reason: '资料页明确提示为私密，当前无法留言'
    })
  })

  it.each([
    ['wrong owner', privateProfile({ owner: otherId })],
    ['missing owner', privateProfile({ script: '' })],
    ['malformed owner', privateProfile({ script: 'g_rgProfileData = {steamid: "' + friendId + '"};' })],
    ['non-string owner', privateProfile({ script: 'g_rgProfileData = {"steamid": 76561198000000002};' })],
    ['duplicate owner keys', privateProfile({ script: `g_rgProfileData = {"steamid":"${otherId}","steamid":"${friendId}"};` })],
    ['escaped duplicate owner keys', privateProfile({ script: `g_rgProfileData = {"steamid":"${otherId}","\\u0073teamid":"${friendId}"};` })],
    ['duplicate owner assignments', privateProfile({ script: ownerBootstrap() + ownerBootstrap() })],
    ['conflicting owner assignments', privateProfile({ script: ownerBootstrap() + ownerBootstrap(otherId) })],
    ['a dynamic owner', privateProfile({ script: 'g_rgProfileData = JSON.parse(\'{"steamid":"' + friendId + '"}\');' })],
    ['an expression after owner JSON', privateProfile({ script: ownerBootstrap().replace('};', '} || {};') })],
    ['a quoted owner assignment', privateProfile({ script: `const text = ${JSON.stringify(ownerBootstrap())};` })],
    ['a template-string owner assignment', privateProfile({ script: '`\n' + ownerBootstrap() + '`;' })],
    ['a commented owner assignment', privateProfile({ script: '/* ' + ownerBootstrap() + ' */' })],
    ['a conditional owner assignment', privateProfile({ script: 'if (true) { ' + ownerBootstrap() + ' }' })],
    ['a callback owner assignment', privateProfile({ script: '(() => { ' + ownerBootstrap() + ' })();' })],
    ['a nested owner script', privateProfile({ scriptContainer: 'div' })],
    ['a non-executable owner script', privateProfile({ scriptType: 'application/json' })],
    ['an external owner script', privateProfile({ scriptSrc: 'https://example.invalid/owner.js' })],
    ['a normal body', privateProfile({ bodyClass: 'profile_page responsive_page' })],
    ['a normal profile', privateProfile({ profileClass: 'no_header profile_page' })],
    ['a duplicate profile', privateProfile({ extraProfile: '<div class="profile_page private_profile"></div>' })],
    ['a duplicate template', privateProfile() + '<div id="responsive_page_template_content"></div>'],
    ['a hidden profile', privateProfile({ profileAttributes: 'hidden' })],
    ['a hidden template', privateProfile({ templateAttributes: 'style="display: none"' })],
    ['a user biography container', privateProfile({ profileContainer: 'profile_summary' })],
    ['a user comment container', privateProfile({ profileContainer: 'commentthread_comment_text' })],
    ['a conflicting target comment area', privateProfile({ extraProfile: profile(controls()) })],
    ['a conflicting foreign comment area', privateProfile({ extraProfile: profile(controls(otherId), otherId) })]
  ])('keeps private profile inference unknown for %s', (_label, html) => {
    expect(parseCommentEligibility(html, friendId).status).toBe('unknown')
  })

  it('does not infer a private profile from user content or a class/text marker alone', () => {
    const fake = '<div class="profile_page private_profile"><div class="profile_private_info">This profile is private.</div></div>'
    expect(parseCommentEligibility(fake + ownerBootstrap(), friendId).status).toBe('unknown')
    expect(parseCommentEligibility(profile(`<div class="commentthread_comment_text">${fake}</div>` + controls()), friendId).status)
      .toBe('allowed')
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

  it('recognizes the Steam span submission form from an authenticated read-only response', async () => {
    const fetchMock = vi.fn(async () => new Response(steamCommentEntry()))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient(accountId, cookies, vi.fn())
    expect((await client.checkCommentEligibility(friendId)).status).toBe('allowed')
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
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
    await expect(client.checkCommentEligibility(friendId)).rejects.toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED', retryable: true })
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

function ownerBootstrap(owner = friendId): string {
  return `g_rgProfileData = ${JSON.stringify({ steamid: owner, personaname: 'Synthetic target' })};`
}

function privateProfile(options: {
  owner?: string
  script?: string
  scriptContainer?: string
  scriptType?: string
  scriptSrc?: string
  bodyClass?: string
  profileClass?: string
  profileAttributes?: string
  templateAttributes?: string
  profileContainer?: string
  extraProfile?: string
} = {}): string {
  let script = `<script${options.scriptType ? ` type="${options.scriptType}"` : ''}${options.scriptSrc ? ` src="${options.scriptSrc}"` : ''}>` +
    (options.script ?? ownerBootstrap(options.owner)) + '</script>'
  if (options.scriptContainer) script = `<${options.scriptContainer}>${script}</${options.scriptContainer}>`
  let content = `<div class="${options.profileClass ?? 'no_header profile_page private_profile'}" ${options.profileAttributes ?? ''}>` +
    '<div class="profile_header_bg"><div class="profile_header_bg_texture"><div class="profile_header">' +
    '<div class="profile_header_content"><div class="profile_header_summary mobile"><div class="profile_private_info"></div></div>' +
    '<div class="profile_header_centered_col"><div class="profile_header_summary desktop"><div class="profile_private_info"></div></div></div>' +
    '</div></div></div></div></div>'
  if (options.profileContainer) content = `<div class="${options.profileContainer}">${content}</div>`
  return `<html><body class="${options.bodyClass ?? 'flat_page profile_page private_profile responsive_page'}">` +
    '<div class="responsive_page_frame with_header"><div class="responsive_page_content">' +
    `<div id="responsive_page_template_content" class="responsive_page_template_content" ${options.templateAttributes ?? ''}>` +
    script + content + (options.extraProfile ?? '') + '</div></div></div></body></html>'
}

function profile(content: string, id = friendId): string {
  return `<div class="commentthread_area" id="commentthread_Profile_${id}_area">${content}</div>`
}

function steamCommentBootstrap(): string {
  return `<script>$J(function() {
    InitializeCommentThread("Profile", "Profile_${friendId}",
      {"feature":"-1","feature2":-1,"owner":"${friendId}","commentthreadid":"1234","total_count":0,
       "start":0,"pagesize":6,"has_upvoted":0,"upvotes":0,"votecountid":null,"voteupid":null,
       "commentcountid":null,"subscribed":false}, 'https://steamcommunity.com/comment/Profile/', 40);
  });</script>`
}

function steamCommentEntry(entryAttributes = ''): string {
  return steamCommentBootstrap() + profile(`<form id="${prefix}_form">
    <div class="commentthread_entry" ${entryAttributes}>
      <div class="commentthread_entry_quotebox">
        <textarea rows="3" class="commentthread_textarea" id="${prefix}_textarea"
          placeholder="Add a comment" style="overflow: hidden; height: 20px;"></textarea>
      </div>
      <div class="commentthread_entry_submitlink" id="${prefix}_submit_container" style="display: none">
        <span class="emoticon_container"><span class="emoticon_button small"></span></span>
        <span class="btn_green_white_innerfade btn_small" id="${prefix}_submit"><span>Post Comment</span></span>
      </div>
    </div>
  </form>`)
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
