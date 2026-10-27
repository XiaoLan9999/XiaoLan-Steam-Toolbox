import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { CommentPreflightError } from '../src/shared/comment-preflight'
import { localizeMessage } from '../src/shared/localization'

const account = '76561198000000001'
const target = '76561198000000002'
const cookies = [`steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com']
const page = (body: string, identity = account) => `<script>g_steamID="${identity}";</script>${body}`
const empty = `<div class="commentthread_area" id="commentthread_Profile_${target}_area"><div class="commentthread_comments" id="commentthread_Profile_${target}_posts"></div></div>`

afterEach(() => vi.unstubAllGlobals())

describe('profile comment preflight failures', () => {
  it.each([
    ['missing thread', () => new Response(page('')), 'COMMENT_BASELINE', '评论区'],
    ['incomplete thread', () => new Response(page(`<div class="commentthread_area" id="commentthread_Profile_${target}_area"></div>`)), 'COMMENT_BASELINE', '不完整'],
    ['HTTP 403', () => new Response('{}', { status: 403, headers: { 'Retry-After': '90' } }), 'ACCESS_DENIED', '403'],
    ['HTTP 429', () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }), 'RATE_LIMITED', '429'],
    ['server error', () => new Response('', { status: 503 }), 'SERVER_ERROR', '服务'],
    ['network error', () => { throw new TypeError('fetch failed: private-cookie-that-must-not-leak') }, 'NETWORK_ERROR', '网络'],
    ['missing identity', () => new Response(empty), 'SESSION_PREPARATION', '身份'],
    ['wrong identity', () => new Response(page(empty, target)), 'SESSION_EXPIRED', '失效']
  ])('preserves the real %s cause and proves no POST occurred', async (_name, response, code, description) => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => response())
    const expired = vi.fn()
    const onEvidence = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies, expired)
    const error = await client.postProfileComment(target, ':test:', () => undefined, onEvidence).catch(error => error)
    expect(error).toBeInstanceOf(CommentPreflightError)
    expect(error.interruption).toMatchObject({ code, rejectedBeforeAcceptance: true })
    expect(error.message).toContain(description)
    expect(error.message).toContain('尚未提交留言')
    expect(error.message).not.toContain('private-cookie')
    expect(localizeMessage(error.message, 'en')).not.toMatch(/\p{Script=Han}/u)
    expect(localizeMessage(`Test Friend (SteamID: ${target})：${error.message}`, 'en')).not.toMatch(/\p{Script=Han}/u)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1].method ?? 'GET').toBe('GET')
    expect(onEvidence).not.toHaveBeenCalled()
    expect(expired).toHaveBeenCalledTimes(code === 'SESSION_EXPIRED' ? 1 : 0)
    if (code === 'RATE_LIMITED' || code === 'ACCESS_DENIED') expect(error.retryAfterMs).toBe(90000)
  })

  it('does not weaken the complete empty-thread baseline', async () => {
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response(JSON.stringify({ success: true, comments_html: '<div id="comment_101"></div>' }))
      : new Response(page(empty)))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies, vi.fn())
    await expect(client.postProfileComment(target, ':test:')).resolves.toEqual({ commentId: '101' })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST'])
  })

  it.each([
    ['private profile', `<html><body class="flat_page profile_page private_profile responsive_page"><div class="responsive_page_frame with_header"><div class="responsive_page_content"><div id="responsive_page_template_content" class="responsive_page_template_content"><div class="no_header profile_page private_profile"></div><script>g_rgProfileData={"steamid":"${target}"};g_steamID="${account}";</script></div></div></div></body></html>`],
    ['disabled comments', page(`<div class="commentthread_area" id="commentthread_Profile_${target}_area"><div class="commentthread_entry_error">Comments are disabled for this profile.</div></div>`)]
  ])('rejects a conclusive %s as a target failure before any POST', async (_label, html) => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response(html))
    const onEvidence = vi.fn()
    const diagnostics = vi.fn()
    const expired = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const error = await new SteamCommunityClient(account, cookies, expired, diagnostics)
      .postProfileComment(target, ':test:', () => undefined, onEvidence).catch(error => error)
    expect(error).toMatchObject({ code: 'COMMENT_TARGET_UNAVAILABLE', retryable: false })
    expect(error.message).toContain('尚未提交留言')
    expect(localizeMessage(error.message, 'en')).not.toMatch(/\p{Script=Han}/u)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1].method ?? 'GET').toBe('GET')
    expect(onEvidence).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'comment-preflight', reason: 'target-unavailable', method: 'GET' }))
  })
})
