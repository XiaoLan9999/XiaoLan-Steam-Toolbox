import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { CommentPermissionDeniedError } from '../src/shared/comment-permission'

const account = '76561198000000001'
const friend = '76561198000000002'
const mini = String(BigInt(account) - 76561197960265728n)
const serverNow = Date.parse('2026-10-18T00:00:00.000Z')
const seconds = serverNow / 1000
const message = ':star13:'
const cookies = [
  `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com'
]
const comment = (id: string, options: { author?: string; at?: number; text?: string } = {}) =>
  `<div class="commentthread_comment responsive_body_text" id="comment_${id}"><a class="commentthread_author_link" data-miniprofile="${options.author ?? mini}" href="/id/synthetic-author/">Author</a><div class="commentthread_comment_timestamp" data-timestamp="${options.at ?? seconds}"></div><div class="commentthread_comment_text" id="comment_content_${id}">${options.text ?? '<img class="emoticon" alt=":star13:">'}</div></div>`
const page = (comments = '', owner = friend) => `<script>var g_steamID="${account}";</script><div id="commentthread_Profile_${owner}_area" class="commentthread_area"><div id="commentthread_Profile_${owner}_posts" class="commentthread_comments">${comments}</div></div>`
const old = comment('1001')
const json = (body: unknown, status = 403, date: string | null = new Date(serverNow).toUTCString()) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(date === null ? {} : { Date: date }) }
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(after = page(old + comment('1002')), response = () => json({ success: 2 })) {
  let reads = 0
  const diagnostic = vi.fn()
  const expired = vi.fn()
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    if (init.method === 'POST') return response()
    return new Response(++reads === 1 ? page(old) : after)
  })
  vi.stubGlobal('fetch', fetch)
  const client = new SteamCommunityClient(account, cookies, expired, diagnostic)
  return { fetch, diagnostic, expired, client }
}

describe('profile comment POST outcome reconciliation', () => {
  it('lets independent delivery confirmation override an explicit 403 permission refusal', async () => {
    const { client, fetch, expired } = setup(undefined, () => json({ success: 2,
      error: 'The settings on this account do not allow you to add comments.' }))
    await expect(client.postProfileComment(friend, message)).resolves.toEqual({ commentId: '1002' })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(expired).not.toHaveBeenCalled()
  })

  it('retains permission evidence if a 403 read-back cannot confirm delivery without replaying', async () => {
    const { client, fetch } = setup(page(old), () => json({ success: 2,
      error: 'The settings on this account do not allow you to add comments.' }))
    const error = await client.postProfileComment(friend, message).catch(error => error)
    expect(error).toBeInstanceOf(CommentPermissionDeniedError)
    expect(error).toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false, commentPermissionDenied: true })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('confirms a new matching comment despite HTTP 403/success:2, using server rather than local time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(serverNow + 7000)
    const { client, fetch, diagnostic, expired } = setup()
    await expect(client.postProfileComment(friend, message)).resolves.toEqual({ commentId: '1002' })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ phase: 'comment-reconcile', reason: 'comment-reconciled', outcome: 'success', httpStatus: 200, method: 'GET' }))
    expect(expired).not.toHaveBeenCalled()
  })

  it('does not mistake a pre-existing identical comment in the exact time window for this POST', async () => {
    const { client, fetch } = setup(page(old))
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it.each([
    ['two new matching comments', page(old + comment('1002') + comment('1003'))],
    ['different sender', page(old + comment('1002', { author: '39734274' }))],
    ['different content', page(old + comment('1002', { text: ':not_the_same:' }))],
    ['older timestamp', page(old + comment('1002', { at: seconds - 300 }))],
    ['future timestamp', page(old + comment('1002', { at: seconds + 300 }))],
    ['different target thread', page(old + comment('1002'), account)],
    ['missing target thread', '<script>g_steamID="' + account + '";</script>'],
    ['duplicate comment ID', page(old + comment('1002') + comment('1002'))]
  ])('keeps %s uncertain and never replays', async (_label, after) => {
    const { client, fetch } = setup(after)
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it.each([null, 'invalid-date'])('cannot claim confirmation without a trusted server Date (%s)', async date => {
    const { client, fetch } = setup(undefined, () => json({ success: 2 }, 403, date))
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('stops before POST if the baseline cannot be read reliably', async () => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response('<script>g_steamID="' + account + '";</script>'))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies, vi.fn())
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_PREFLIGHT_FAILED', retryable: true,
      interruption: { code: 'COMMENT_BASELINE', rejectedBeforeAcceptance: true } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.every(([, init]) => !init || init.method !== 'POST')).toBe(true)
  })

  it('does not need a read-back for an ordinary accepted response', async () => {
    const { client, fetch } = setup(undefined, () => json({ success: true, comments_html: '<div id="comment_2001"></div>' }, 200))
    await expect(client.postProfileComment(friend, message)).resolves.toEqual({ commentId: '2001' })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST'])
  })

  it('does not use a different cookie generation to declare the old POST confirmed', async () => {
    const { client, fetch } = setup(undefined, () => {
      client.replaceCookies(cookies.map(cookie => cookie.replace('synthetic-csrf', 'synthetic-next-csrf')))
      return json({ success: 2 })
    })
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retains the server wait hint but never makes an unconfirmed POST retryable', async () => {
    const { client } = setup(page(old), () => new Response('{"success":2}', { status: 403,
      headers: { Date: new Date(serverNow).toUTCString(), 'Retry-After': '600' } }))
    await expect(client.postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false, retryAfterMs: 600000 })
  })
})
