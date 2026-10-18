import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { verifyCommentAttempt, type CommentAttemptEvidence } from '../src/main/comment-reconciliation'
import { DomainError } from '../src/shared/domain'

const account = '76561198000000001'
const friend = '76561198000000002'
const mini = String(BigInt(account) - 76561197960265728n)
const serverNow = Date.parse('2026-10-18T00:00:00Z')
const seconds = serverNow / 1000
const message = ':star13:'
const cookies = [`steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com']
const comment = (id: string, options: { author?: string; at?: number; text?: string } = {}) =>
  `<div class="commentthread_comment" id="comment_${id}"><a class="commentthread_author_link" data-miniprofile="${options.author ?? mini}" href="/id/synthetic/">Author</a><div class="commentthread_comment_timestamp" data-timestamp="${options.at ?? seconds}"></div><div class="commentthread_comment_text">${options.text ?? '<img class="emoticon" alt=":star13:">'}</div></div>`
const page = (comments = '', identity = account, owner = friend) => `<script>var g_steamID="${identity}";</script><div id="commentthread_Profile_${owner}_area" class="commentthread_area"><div id="commentthread_Profile_${owner}_posts" class="commentthread_comments">${comments}</div></div>`
const headers = (at = serverNow) => ({ Date: new Date(at).toUTCString() })
const evidence = (): CommentAttemptEvidence => ({ baselineIds: ['1001'], submittedAt: new Date(serverNow + 7000).toISOString(),
  serverWindow: { earliest: seconds - 2, latest: seconds + 2 } })
const client = () => new SteamCommunityClient(account, cookies, vi.fn())

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('durable comment attempt evidence', () => {
  it('records a copied baseline and server-clock window synchronously before POST and refines it after the response', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(serverNow + 7000)
    const recorded: CommentAttemptEvidence[] = []
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      methods.push(init.method ?? 'GET')
      if (init.method !== 'POST') return new Response(page(comment('1001')), { headers: headers() })
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toEqual({ baselineIds: ['1001'], submittedAt: new Date(serverNow + 7000).toISOString(),
        serverWindow: { earliest: seconds - 2, latest: seconds + 52 } })
      return new Response(JSON.stringify({ success: true, comments_html: '<div id="comment_1002"></div>' }), { headers: headers() })
    }))
    await expect(client().postProfileComment(friend, message, undefined, value => recorded.push(value))).resolves.toEqual({ commentId: '1002' })
    expect(methods).toEqual(['GET', 'POST'])
    expect(recorded).toHaveLength(2)
    expect(recorded[1]).toEqual({ ...recorded[0], serverWindow: { earliest: seconds - 2, latest: seconds + 2 } })
    expect(recorded[0]!.serverWindow!.latest).toBe(seconds + 52)
  })

  it('stops before submitting if initial evidence cannot be saved', async () => {
    const fetch = vi.fn(async () => new Response(page(), { headers: headers() }))
    vi.stubGlobal('fetch', fetch)
    await expect(client().postProfileComment(friend, message, undefined, () => { throw new Error('synthetic disk failure') }))
      .rejects.toMatchObject({ code: 'SESSION_PREPARATION_FAILED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.every(args => (args as unknown as [unknown, RequestInit])[1]?.method !== 'POST')).toBe(true)
  })

  it('keeps response evidence persistence failures uncertain after exactly one POST', async () => {
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response('{"success":true}', { headers: headers() })
      : new Response(page(), { headers: headers() }))
    vi.stubGlobal('fetch', fetch)
    let callbacks = 0
    await expect(client().postProfileComment(friend, message, undefined, () => {
      if (++callbacks === 2) throw new Error('synthetic disk failure')
    })).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST'])
  })

  it('does not widen or replace a baseline window when the response server clock disagrees', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(serverNow + 7000)
    const recorded: CommentAttemptEvidence[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response('{"success":true}', { headers: headers(serverNow + 600_000) })
      : new Response(page(), { headers: headers() })))
    await client().postProfileComment(friend, message, undefined, value => recorded.push(value))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.serverWindow).toEqual({ earliest: seconds - 2, latest: seconds + 52 })
  })

  it('can refine a missing baseline Date from the actual POST response clock', async () => {
    const recorded: CommentAttemptEvidence[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response('{"success":true}', { headers: headers() }) : new Response(page())))
    await client().postProfileComment(friend, message, undefined, value => recorded.push(value))
    expect(recorded[0]!.serverWindow).toBeNull()
    expect(recorded[1]!.serverWindow!.earliest).toBeGreaterThanOrEqual(seconds - 3)
    expect(recorded[1]!.serverWindow!.earliest).toBeLessThanOrEqual(seconds - 2)
    expect(recorded[1]!.serverWindow!.latest).toBe(seconds + 2)
  })

  it('does not let persistence callbacks mutate the baseline kept for response reconciliation', async () => {
    const recorded: CommentAttemptEvidence[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response('{"success":true}', { headers: headers() }) : new Response(page(comment('1001')))))
    await client().postProfileComment(friend, message, undefined, value => {
      recorded.push(structuredClone(value))
      value.baselineIds.push('9999')
      if (value.serverWindow) value.serverWindow.earliest = 1
    })
    expect(recorded).toHaveLength(2)
    expect(recorded[1]!.baselineIds).toEqual(['1001'])
    expect(recorded[1]!.serverWindow!.earliest).toBeGreaterThan(seconds - 5)
  })

  it('keeps the trusted response window even when the local wall clock jumps during the POST', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(serverNow + 7000)
    const recorded: CommentAttemptEvidence[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method !== 'POST') return new Response(page(), { headers: headers() })
      vi.setSystemTime(serverNow - 86_400_000)
      return new Response('{"success":true}', { headers: headers() })
    }))
    await client().postProfileComment(friend, message, undefined, value => recorded.push(value))
    expect(recorded[1]!.serverWindow).toEqual({ earliest: seconds - 2, latest: seconds + 2 })
    expect(recorded[1]!.submittedAt).toBe(new Date(serverNow + 7000).toISOString())
  })

  it('does not use a disjoint server-clock response to immediately confirm a 403', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(serverNow + 7000)
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => init.method === 'POST'
      ? new Response('{"success":2}', { status: 403, headers: headers(serverNow + 600_000) })
      : new Response(page(), { headers: headers() }))
    vi.stubGlobal('fetch', fetch)
    await expect(client().postProfileComment(friend, message)).rejects.toMatchObject({ code: 'COMMENT_POST_UNCERTAIN' })
    expect(fetch.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST'])
  })
})

describe('delayed profile comment reconciliation', () => {
  it('confirms the unique new matching comment using persisted evidence with only a GET', async () => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response(page(comment('1001') + comment('1002'))))
    vi.stubGlobal('fetch', fetch)
    await expect(client().reconcileProfileComment(friend, message, evidence())).resolves.toEqual({ status: 'confirmed', commentId: '1002', postedAtSeconds: seconds })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0].toString()).toContain(`/profiles/${friend}/?l=english`)
    expect((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].method).not.toBe('POST')
  })

  it.each([
    ['old identical ID', comment('1001')],
    ['wrong author', comment('1002', { author: String(BigInt(mini) + 1n) })],
    ['wrong text', comment('1002', { text: ':other:' })],
    ['old time', comment('1002', { at: seconds - 5 })],
    ['future time', comment('1002', { at: seconds + 5 })],
    ['ambiguous duplicate text', comment('1002') + comment('1003')],
    ['no visible match', '']
  ])('never assumes %s means that the original POST can be repeated', async (_label, comments) => {
    const fetch = vi.fn(async () => new Response(page(comments)))
    vi.stubGlobal('fetch', fetch)
    await expect(client().reconcileProfileComment(friend, message, evidence())).resolves.toMatchObject({ status: 'unresolved' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reads legacy pending-review pages but cannot invent missing attempt evidence', async () => {
    const fetch = vi.fn(async () => new Response(page(comment('1002'))))
    vi.stubGlobal('fetch', fetch)
    await expect(client().reconcileProfileComment(friend, message, null)).resolves.toEqual({ status: 'unresolved', reason: 'missing-attempt-evidence' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects incomplete or wrong-target snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page(comment('1002'), account, account))))
    await expect(client().reconcileProfileComment(friend, message, evidence())).resolves.toMatchObject({ status: 'unresolved', reason: 'unreliable-snapshot' })
  })

  it.each([403, 429])('propagates GET %s without issuing a POST or retry loop', async status => {
    const fetch = vi.fn(async () => new Response('synthetic denied', { status, headers: { 'Retry-After': '60' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(client().reconcileProfileComment(friend, message, evidence())).rejects.toMatchObject({ code: status === 403 ? 'COMMUNITY_ACCESS_DENIED' : 'RATE_LIMITED', retryAfterMs: 60_000 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels the read result when caller intent changes in flight', async () => {
    let allowed = true
    const fetch = vi.fn(async () => { allowed = false; return new Response(page(comment('1002'))) })
    vi.stubGlobal('fetch', fetch)
    await expect(client().reconcileProfileComment(friend, message, evidence(), () => {
      if (!allowed) throw new DomainError('CHECK_CANCELLED', 'Synthetic task changed')
    })).rejects.toMatchObject({ code: 'CHECK_CANCELLED' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not accept a different logged-in identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page(comment('1002'), friend))))
    await expect(client().reconcileProfileComment(friend, message, evidence())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('discards a read performed across a cookie replacement', async () => {
    const instance = client()
    vi.stubGlobal('fetch', vi.fn(async () => {
      instance.replaceCookies(cookies.map(cookie => cookie.replace('synthetic-csrf', 'synthetic-new-csrf')))
      return new Response(page(comment('1002')))
    }))
    await expect(instance.reconcileProfileComment(friend, message, evidence())).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
  })

  it.each([
    { baselineIds: ['1001', '1001'] }, { baselineIds: [1001] }, { baselineIds: ['invalid'] },
    { submittedAt: 'invalid' }, { serverWindow: null },
    { serverWindow: { earliest: seconds, latest: seconds + 301 } }
  ])('treats malformed stored evidence as unresolved: %j', overrides => {
    const snapshot = { ownerSteamId: friend, complete: true, threadExists: true,
      comments: [{ id: '1002', authorSteamId: account, text: message, postedAtSeconds: seconds }] }
    expect(verifyCommentAttempt(snapshot, account, message, { ...evidence(), ...overrides } as CommentAttemptEvidence)).toEqual({ status: 'unresolved', reason: 'invalid-attempt-evidence' })
  })
})
