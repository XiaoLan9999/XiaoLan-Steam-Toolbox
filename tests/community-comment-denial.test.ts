import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SteamCommunityClient, type CommentDenialReason, type CommunityDiagnosticEvent } from '../src/main/community-client'
import { RuntimeDiagnostics } from '../src/main/runtime-diagnostics'
import { localizeMessage } from '../src/shared/localization'
import { stubCommentBaseline } from './helpers/comment-baseline'

const account = '76561198000000001'
const recipient = '76561198000000002'
const baseMessage = 'Steam 拒绝响应，但发送结果待核对；为防重复不会自动重发。Steam 返回JSON 拒绝（HTTP 403）；尚未确认登录失效或具体限制原因，请稍后再试'
const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function rejected(body: unknown, headers: HeadersInit = {}) {
  const diagnostic: CommunityDiagnosticEvent[] = []
  const expired = vi.fn()
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 403, headers }))
  const { baselineReads } = stubCommentBaseline(fetch, account, recipient)
  const client = new SteamCommunityClient(account, [
    `steamLoginSecure=${account}%7C%7Csynthetic-cookie; Path=/; Secure; Domain=steamcommunity.com`,
    'sessionid=synthetic-csrf; Path=/; Secure; Domain=steamcommunity.com'
  ], expired, event => diagnostic.push(event))
  let error: unknown
  try { await client.postProfileComment(recipient, 'synthetic-private-comment') } catch (caught) { error = caught }
  expect(fetch).toHaveBeenCalledOnce()
  expect(baselineReads).toHaveBeenCalledOnce()
  return { diagnostic, expired, fetch, error: error as Error & { code: string } }
}

describe('safe Steam JSON comment denial details', () => {
  it.each<[string, CommentDenialReason]>([
    ['Invalid sessionid.', 'csrf-sessionid'],
    ['The session ID is invalid. Please reload the page.', 'csrf-sessionid'],
    ['当前会话标识已过期，请刷新页面', 'csrf-sessionid'],
    ["You've been posting too frequently, and can't make another post right now.", 'posting-too-frequently'],
    ['Posting too frequently. Please try again later.', 'posting-too-frequently'],
    ['Your comment was not posted because you have been posting too frequently.', 'posting-too-frequently'],
    ['您发帖过于频繁，暂时无法留言。', 'posting-too-frequently'],
    ['Comments have been disabled for this profile.', 'target-comments-disabled'],
    ['The profile owner has disabled comments.', 'target-comments-disabled'],
    ['该用户已关闭评论。', 'target-comments-disabled'],
    ['Only friends can post comments on this profile.', 'friends-only'],
    ['You must be friends with this user to leave a comment on their profile.', 'friends-only'],
    ['仅允许好友留言。', 'friends-only'],
    ['This user has blocked you.', 'target-blocked'],
    ['You have been blocked by this user.', 'target-blocked'],
    ['您已被该用户屏蔽。', 'target-blocked'],
    ['Your account is restricted from posting comments.', 'account-restricted'],
    ['Your account does not have permission to post comments.', 'account-restricted'],
    ['您的账号已被限制发表评论。', 'account-restricted'],
    ['Please complete the CAPTCHA before commenting.', 'challenge'],
    ['Verify that you are a human.', 'challenge'],
    ['请先完成人机验证。', 'challenge']
  ])('recognizes only the explicit error meaning: %s', async (serverError, reason) => {
    const { diagnostic, expired, error } = await rejected({ success: 2, error: serverError })
    expect(diagnostic[0]).toMatchObject({ responseCode: 2, commentDenialReason: reason, errorPresent: true })
    expect(error.code).toBe('COMMENT_POST_UNCERTAIN')
    expect(error.message).toBe(`${baseMessage}。Steam 原因：${serverError}`)
    expect(expired).not.toHaveBeenCalled()
    expect(JSON.stringify(diagnostic)).not.toContain(serverError)
  })

  it.each([
    'There was a problem posting your comment. Please try again.',
    'Access denied.',
    'Your account is not restricted from posting comments.',
    'Your account does not have restrictions.',
    'The session ID is not invalid.',
    'Comments are not disabled for this profile.',
    'Example: Only friends can post comments.',
    'This text says "Posting too frequently" but is not a restriction.',
    '"This user has blocked you" is a quoted example.',
    'Your account is restricted from posting comments, as an example only.',
    '该用户并未将您拉黑。',
    '无需完成人机验证。',
    '示例：您发帖过于频繁。',
    'This is a discussion of sessionid rather than a CSRF error.'
  ])('does not invent a cause from a generic code, quotation or negation: %s', async serverError => {
    const { diagnostic, expired } = await rejected({ success: 2, error: serverError })
    expect(diagnostic[0]).toMatchObject({ responseCode: 2, commentDenialReason: 'unknown', errorPresent: true })
    expect(expired).not.toHaveBeenCalled()
  })

  it('never examines other response fields or the submitted comment for a cause', async () => {
    const { diagnostic, error, expired } = await rejected({ success: 2,
      message: 'Invalid sessionid.', comment: 'Posting too frequently.',
      details: { error: 'This user has blocked you.' } })
    expect(error.message).toBe(baseMessage)
    expect(diagnostic[0]).not.toHaveProperty('commentDenialReason')
    expect(diagnostic[0]).not.toHaveProperty('errorPresent')
    expect(expired).not.toHaveBeenCalled()
  })

  it.each([undefined, null, false, 2, ['Invalid sessionid.'], { text: 'Invalid sessionid.' }])('does not coerce an error value into text: %j', async errorValue => {
    const { error, diagnostic } = await rejected({ success: 2, error: errorValue })
    expect(error.message).toBe(baseMessage)
    expect(diagnostic[0]).not.toHaveProperty('errorPresent')
  })

  it.each([
    'sessionid=synthetic-short',
    'Error: session_id: synthetic-short',
    'Error: access_token=synthetic-short',
    'Error: refresh token: synthetic-short',
    'Authorization: Bearer synthetic-short',
    'Error: auth=synthetic-short',
    'Error: Cookie: sessionid=synthetic-short',
    'Error: steamLoginSecure synthetic-short',
    'Error: bearer synthetic-short',
    'Error: token=synthetic-short',
    'Error: csrf_key=synthetic-short',
    'Error: {"access_token":"synthetic-short"}',
    'Error: sessionid：synthetic-short',
    'Error: auth_token=synthetic-short',
    'Error: session&#105;d=synthetic-short',
    'Error: steamLogin<b>Secure</b>=synthetic-short',
    'Error: access<b></b>_token=synthetic-short',
    'Error: sessionid&colon; synthetic-short',
    'Error: access%5Ftoken=synthetic-short',
    'Error: sess\u200bionid=synthetic-short',
    'Error: access\u202etoken=synthetic-short',
    'private-server-token',
    'private-error'
  ])('suppresses credential-shaped messages instead of exposing partial credentials: %s', async serverError => {
    const { error, diagnostic } = await rejected({ success: 2, error: serverError })
    expect(error.message).toBe(baseMessage)
    expect(diagnostic[0]).toMatchObject({ errorPresent: true })
    expect(JSON.stringify(diagnostic)).not.toMatch(/synthetic|private|sessionid=|token=/)
  })

  it('suppresses JWTs and long opaque tokens without putting them in diagnostics', async () => {
    const jwt = ['eyJ' + 'a'.repeat(20), 'eyJ' + 'b'.repeat(20), 'c'.repeat(30)].join('.')
    const opaque = 'd'.repeat(48)
    for (const serverError of [`Error: ${jwt}`, `Error: ${opaque}`]) {
      const { error, diagnostic } = await rejected({ success: 2, error: serverError })
      expect(error.message).toBe(baseMessage)
      expect(JSON.stringify(diagnostic)).not.toContain(jwt)
      expect(JSON.stringify(diagnostic)).not.toContain(opaque)
    }
  })

  it('strips HTML, control and bidi characters and redacts URLs, mail and Steam IDs', async () => {
    const { error, diagnostic } = await rejected({ success: 2,
      error: `<script>synthetic-script-secret</script><b>Temporary failure.</b>\u202e Contact player@example.invalid or https://help.example.invalid/page and ${recipient}.\u0000` })
    expect(error.message).toContain('Steam 原因：Temporary failure. Contact [redacted] or [redacted] and [redacted].')
    expect(error.message).not.toMatch(/<|>|script|\u202e|\u0000|player@|https|7656119/)
    expect(JSON.stringify(diagnostic)).not.toMatch(/Temporary|synthetic|player|https|7656119/)
  })

  it('bounds displayed server text at 160 Unicode code points and suppresses oversized sources', async () => {
    const message = '暂时无法发表评论。'.repeat(40)
    const { error } = await rejected({ success: 2, error: message })
    expect(Array.from(error.message.split('Steam 原因：')[1]!).length).toBe(160)
    const tooLong = await rejected({ success: 2, error: 'a'.repeat(4097) })
    expect(tooLong.error.message).toBe(baseMessage)
    expect(tooLong.diagnostic[0]).toMatchObject({ errorPresent: true, commentDenialReason: 'unknown' })
  })

  it.each([21, '21'])('keeps explicit NotLoggedOn %j ahead of ordinary denial extraction', async success => {
    const { error, expired, diagnostic } = await rejected({ success, error: 'Invalid sessionid.' })
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(expired).toHaveBeenCalledOnce()
    expect(diagnostic).toEqual([{ phase: 'community-request', outcome: 'auth-rejected', reason: 'not-logged-on', httpStatus: 403, method: 'POST' }])
  })

  it('localizes fixed nested wrappers but preserves the original Steam message language', async () => {
    const { error } = await rejected({ success: 2, error: '暂时无法发表评论，请稍后再试。' })
    const wrapped = `留言请求持续被拒绝（HTTP 403），已停止自动重试。当前对象和剩余好友保留待发；尚不能确定是好友权限、账号限制或网络拦截，请处理原因后再手动继续。${error.message}`
    const translated = localizeMessage(wrapped, 'en')
    expect(translated).toContain('Automatic retries stopped.')
    expect(translated).toContain('Steam returned a JSON refusal (HTTP 403).')
    expect(translated).toContain('Steam reason: 暂时无法发表评论，请稍后再试。')
    expect(translated).not.toContain('Steam 原因')
    expect(localizeMessage(error.message, 'zh-CN')).toBe(error.message)
  })
})

describe('denial diagnostic persistence whitelist', () => {
  it('stores only a fixed reason enum and a boolean, never the displayed or raw error text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sfc-comment-denial-'))
    directories.push(directory)
    const diagnostics = new RuntimeDiagnostics({ directory, version: 'synthetic-test', metrics: () => [], task: () => null })
    const reply = await rejected({ success: 2, error: 'Invalid sessionid.' })
    diagnostics.sessionEvent({ ...reply.diagnostic[0]!, errorMessage: 'synthetic-private-text', responseBody: 'synthetic-private-body' } as never)
    diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
      commentDenialReason: 'synthetic-private-enum', errorPresent: 'synthetic-private-bool' } as never)
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toMatch(/synthetic-private|Invalid sessionid|errorMessage|responseBody/)
    const rows = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0]).toMatchObject({ commentDenialReason: 'csrf-sessionid', errorPresent: true })
    expect(rows[1]).not.toHaveProperty('commentDenialReason')
    expect(rows[1]).not.toHaveProperty('errorPresent')
  })
})
