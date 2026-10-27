import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient, type CommunityDiagnosticEvent } from '../src/main/community-client'
import { CommentPermissionDeniedError } from '../src/shared/comment-permission'
import { stubCommentBaseline } from './helpers/comment-baseline'

const account = '76561198000000001'
const target = '76561198000000002'
const cookies = [
  `steamLoginSecure=${account}%7C%7Csynthetic-cookie; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com'
]

afterEach(() => vi.unstubAllGlobals())

async function reply(body: unknown, status = 200, headers: HeadersInit = {}) {
  const diagnostic: CommunityDiagnosticEvent[] = []
  const expired = vi.fn()
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
  const { baselineReads } = stubCommentBaseline(fetch, account, target)
  const client = new SteamCommunityClient(account, cookies, expired, event => diagnostic.push(event))
  const result = await client.postProfileComment(target, ':synthetic:').then(value => ({ value, error: null }),
    error => ({ value: null, error: error as Error & { code?: string; retryable?: boolean } }))
  expect(fetch).toHaveBeenCalledOnce()
  expect(baselineReads).toHaveBeenCalledOnce()
  return { ...result, diagnostic, expired, fetch }
}

describe('explicit successful-HTTP comment permission refusals', () => {
  it.each([
    ['Comments have been disabled for this profile.', '已关闭留言', 'target-comments-disabled'],
    ['The profile owner has disabled comments.', '已关闭留言', 'target-comments-disabled'],
    ['Only friends can post comments on this profile.', '仅允许好友留言', 'friends-only'],
    ['This user has blocked you.', '已屏蔽当前账号', 'target-blocked'],
    ['Your account does not have permission to post comments.', '没有此资料页留言权限', 'account-restricted'],
    ['Your account is not allowed to post comments.', '没有此资料页留言权限', 'account-restricted'],
    ['This account is not permitted to leave comments.', '没有此资料页留言权限', 'account-restricted'],
    ['You are not allowed to add comments on this profile.', '没有此资料页留言权限', 'account-restricted'],
    ['The settings on this account do not allow you to add comments.', '没有此资料页留言权限', 'account-restricted'],
    ['此账户不允许你进行留言。', '没有此资料页留言权限', 'account-restricted'],
    ['该账号的设置不允许您发表评论。', '没有此资料页留言权限', 'account-restricted']
  ])('types only an explicit permission assertion without replaying: %s', async (error, reason, diagnosticReason) => {
    const result = await reply({ success: 2, error, access_token: 'synthetic-other-field-that-must-not-be-read' })
    expect(result.error).toMatchObject({ code: 'COMMENT_TARGET_UNAVAILABLE', retryable: false })
    expect(result.error!.message).toContain(reason)
    expect(result.error!.message).not.toContain(error)
    expect(result.error!.message).not.toContain('synthetic-other')
    expect(result.diagnostic).toContainEqual(expect.objectContaining({ phase: 'community-request',
      reason: 'target-unavailable', commentDenialReason: diagnosticReason, httpStatus: 200, method: 'POST' }))
    expect(JSON.stringify(result.diagnostic)).not.toContain(error)
    expect(JSON.stringify(result.diagnostic)).not.toContain('synthetic-other')
    expect(result.expired).not.toHaveBeenCalled()
  })

  it.each([
    'There was a problem posting your comment. Please try again.',
    'Access denied.',
    'Your account is not restricted from posting comments.',
    'Your account is not allowed to post comments, as an example only.',
    'Example: Your account is not allowed to post comments.',
    'Comments are not disabled for this profile.',
    'The settings on this account do not allow you to add comments, as a quoted example.',
    'Posting too frequently. Please try again later.',
    'Your account is not allowed to post comments because you are posting too frequently.',
    'Your account is not allowed to post comments: invalid sessionid.',
    'Your account is not allowed to post comments because your session expired.',
    'Your account is not allowed to post comments due to authentication failure.',
    'Invalid sessionid.',
    'Please complete the CAPTCHA before commenting.',
    '该账号的设置不允许您发表评论，原因是当前发帖过于频繁。',
    'This is not a permission refusal.'
  ])('does not turn generic, quoted, rate or session text into a blocked friend: %s', async error => {
    const result = await reply({ success: 2, error })
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error!.code).not.toBe('COMMENT_TARGET_UNAVAILABLE')
    expect(result.diagnostic).not.toContainEqual(expect.objectContaining({ reason: 'target-unavailable' }))
    expect(result.expired).not.toHaveBeenCalled()
  })

  it('never infers a permission refusal from other JSON fields', async () => {
    const result = await reply({ success: false, message: 'Your account is not allowed to post comments.',
      details: { error: 'This user has blocked you.' } })
    expect(result.error!.code).not.toBe('COMMENT_TARGET_UNAVAILABLE')
    expect(result.error!.message).toBe('Steam rejected the profile comment')
    expect(result.diagnostic).toEqual([])
  })

  it.each([
    'Your account is not allowed to post comments. sessionid=private-short',
    'Your account is not allowed to post comments. Authorization: Bearer private-short',
    `Your account is not allowed to post comments. ${'X'.repeat(48)}`
  ])('suppresses credential-shaped text instead of classifying or displaying it: %s', async error => {
    const result = await reply({ success: false, error })
    expect(result.error!.code).not.toBe('COMMENT_TARGET_UNAVAILABLE')
    expect(result.error!.message).toBe('Steam rejected the profile comment')
    expect(JSON.stringify(result.diagnostic)).not.toMatch(/private-short|XXXXX|sessionid=/)
  })

  it('does not convert a 403 into a permission failure despite its explicit message', async () => {
    const result = await reply({ success: 2, error: 'Your account is not allowed to post comments.' }, 403)
    expect(result.error).toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(result.error).toBeInstanceOf(CommentPermissionDeniedError)
    expect(result.error).toMatchObject({ commentPermissionDenied: true })
    expect(result.expired).not.toHaveBeenCalled()
  })

  it.each([
    'Comments have been disabled for this profile.',
    'Only friends can post comments on this profile.',
    'This user has blocked you.',
    'The settings on this account do not allow you to add comments.'
  ])('retains explicit 403 permission evidence while preserving an uncertain POST result: %s', async error => {
    const result = await reply({ success: 2, error }, 403, { 'Retry-After': '120' })
    expect(result.error).toBeInstanceOf(CommentPermissionDeniedError)
    expect(result.error).toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false,
      commentPermissionDenied: true, retryAfterMs: 120000 })
    expect(result.expired).not.toHaveBeenCalled()
  })

  it.each([
    'Access denied.',
    'Posting too frequently. Please try again later.',
    'Invalid sessionid.',
    'Please complete the CAPTCHA before commenting.',
    'Your account is not allowed to post comments because your session expired.',
    'Your account is not allowed to post comments because you are posting too frequently.',
    'Your account is not allowed to post comments. sessionid=private-short',
    'Example: Your account is not allowed to post comments.',
    'Comments are not disabled for this profile.'
  ])('does not add a permission marker to generic, rate, auth, unsafe or quoted 403 responses: %s', async error => {
    const result = await reply({ success: 2, error }, 403)
    expect(result.error).toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(result.error).not.toBeInstanceOf(CommentPermissionDeniedError)
    expect(result.error).not.toHaveProperty('commentPermissionDenied')
    expect(result.expired).not.toHaveBeenCalled()
  })

  it('does not treat a permission-looking error from another endpoint as recipient permission evidence', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: 2,
      error: 'Your account is not allowed to post comments.' }), { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies, vi.fn())
    const error = await client.getFriendRelationships().catch(error => error)
    expect(error).toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED', retryable: true })
    expect(error).not.toBeInstanceOf(CommentPermissionDeniedError)
    expect(error).not.toHaveProperty('commentPermissionDenied')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not override an accepted response with a leftover permission error', async () => {
    const result = await reply({ success: true, error: 'Your account is not allowed to post comments.',
      comments_html: '<div id="comment_1001"></div>' })
    expect(result.error).toBeNull()
    expect(result.value).toEqual({ commentId: '1001' })
    expect(result.diagnostic).toEqual([])
  })

  it('keeps contradictory comment HTML and permission refusal uncertain rather than blocked', async () => {
    const result = await reply({ success: false, error: 'Your account is not allowed to post comments.',
      comments_html: '<div id="comment_1001"></div>' })
    expect(result.error).toMatchObject({ code: 'COMMENT_POST_UNCERTAIN', retryable: false })
    expect(result.diagnostic).toEqual([])
  })

  it('preserves explicit NotLoggedOn ahead of permission typing', async () => {
    const result = await reply({ success: 21, error: 'Your account is not allowed to post comments.' })
    expect(result.error).toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(result.expired).toHaveBeenCalledOnce()
  })

  it.each([401, 429])('preserves HTTP %s ahead of its untrusted permission-looking body', async status => {
    const result = await reply({ success: false, error: 'Your account is not allowed to post comments.' }, status)
    expect(result.error).toMatchObject({ code: status === 401 ? 'SESSION_EXPIRED' : 'RATE_LIMITED' })
    expect(result.error!.code).not.toBe('COMMENT_TARGET_UNAVAILABLE')
    expect(result.expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
  })
})
