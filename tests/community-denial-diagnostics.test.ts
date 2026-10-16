import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient, type CommunityDiagnosticEvent } from '../src/main/community-client'

const account = '76561198000000001'
const friend = '76561198000000002'
const cookies = [
  `steamLoginSecure=${account}%7C%7Cprivate-cookie; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=private-csrf; Path=/; Secure; Domain=steamcommunity.com'
]

afterEach(() => { vi.unstubAllGlobals() })

async function rejectResponse(body: string, headers: HeadersInit = {}, operation: 'comment' | 'verify' | 'friends' = 'comment') {
  const events: CommunityDiagnosticEvent[] = []
  const expired = vi.fn()
  const fetch = vi.fn(async () => new Response(body, { status: 403, headers }))
  vi.stubGlobal('fetch', fetch)
  const client = new SteamCommunityClient(account, cookies, expired, event => events.push(event))
  const request = operation === 'comment' ? client.postProfileComment(friend, 'private-message')
    : operation === 'verify' ? client.verifySession() : client.getFriendRelationships()
  let error: unknown
  try { await request } catch (caught) { error = caught }
  return { events, expired, fetch, error }
}

describe('privacy-safe forbidden-response diagnostics', () => {
  it.each([
    ['{"success":false,"error":"private-error"}', 'json', 'unknown'],
    ['<html><title>Access Denied</title><body>private-body</body></html>', 'html', 'access-denied'],
    ['<div class="g-recaptcha" data-sitekey="private-key"></div>', 'html', 'challenge'],
    ['<html><p>Verify that you are a human</p></html>', 'html', 'challenge'],
    ['<html><input name="captcha_text" value="private-value"></html>', 'html', 'challenge'],
    ['<html><script src="/private/captcha.js"></script></html>', 'html', 'unknown'],
    ['<html><h1>Temporary maintenance</h1></html>', 'html', 'unknown'],
    ['', 'empty', 'unknown'],
    ['  \r\n\t', 'empty', 'unknown'],
    ['private-text', 'other', 'unknown'],
    ['null', 'json', 'unknown'],
    ['[15]', 'json', 'unknown']
  ])('classifies the response without persisting its content: %j', async (body, responseKind, denialKind) => {
    const { events, error, expired, fetch } = await rejectResponse(body)
    expect(error).toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED', retryable: true })
    expect(events).toEqual([{ phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
      httpStatus: 403, method: 'POST', endpoint: 'profile-comment', responseKind, denialKind,
      ...(body.includes('"error":"private-error"') ? { commentDenialReason: 'unknown', errorPresent: true } : {}) }])
    expect(JSON.stringify(events)).not.toMatch(/private|7656119|https|csrf/)
    expect(String(error)).not.toMatch(/private|7656119|https|csrf/)
    expect(expired).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['eresult', 'error_code', 'errorcode', 'code', 'error', 'success'])('records the small numeric %s protocol code only', async field => {
    const { events } = await rejectResponse(JSON.stringify({ [field]: 15, detail: 'private-detail', account }))
    expect(events[0]).toMatchObject({ responseKind: 'json', denialKind: 'access-denied', responseCode: 15 })
    expect(JSON.stringify(events)).not.toMatch(/private|7656119/)
  })

  it.each([true, false, '15', -1, 1.2, 256, 76561198000000001, null, [15], { value: 15 }])('does not coerce or persist non-code values: %j', async value => {
    const { events } = await rejectResponse(JSON.stringify({ success: value, token: 'private-token' }))
    expect(events[0]).not.toHaveProperty('responseCode')
    expect(JSON.stringify(events)).not.toMatch(/private|7656119/)
  })

  it('prefers an explicit error code to a generic numeric success flag', async () => {
    const { events } = await rejectResponse('{"success":0,"eresult":15}')
    expect(events[0]).toMatchObject({ responseCode: 15, denialKind: 'access-denied' })
  })

  it('records a parsed server retry hint without retaining header or response strings', async () => {
    const { events, error } = await rejectResponse('{"success":false,"error":"private-error"}', {
      'Retry-After': '120', 'Set-Cookie': 'private-cookie', 'X-Private-Header': 'private-header'
    })
    expect(events[0]).toMatchObject({ retryAfterMs: 120_000 })
    expect(error).toMatchObject({ retryAfterMs: 120_000 })
    expect(JSON.stringify(events)).not.toMatch(/private|Cookie|Header/)
  })

  it.each(['-1', 'private-header', '1.5'])('omits an invalid server retry hint: %s', async hint => {
    const { events, error } = await rejectResponse('', { 'Retry-After': hint })
    expect(events[0]).not.toHaveProperty('retryAfterMs')
    expect(error).toMatchObject({ retryAfterMs: undefined })
  })

  it.each([['verify', 'session-verify'], ['friends', 'other']] as const)('classifies %s without recording a path or identity', async (operation, endpoint) => {
    const { events, expired } = await rejectResponse('<html>Forbidden</html>', {}, operation)
    expect(events[0]).toMatchObject({ endpoint, method: 'GET' })
    expect(JSON.stringify(events)).not.toMatch(/profiles|7656119|https|ajaxgetfriendslist/)
    expect(expired).not.toHaveBeenCalled()
  })

  it.each([21, '21'])('preserves explicit NotLoggedOn classification before ordinary 403 diagnostics: %j', async success => {
    const { events, error, expired } = await rejectResponse(JSON.stringify({ success, error: 'private-error' }))
    expect(error).toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(events).toEqual([{ phase: 'community-request', outcome: 'auth-rejected', reason: 'not-logged-on', httpStatus: 403, method: 'POST' }])
    expect(expired).toHaveBeenCalledOnce()
  })

  it('describes a challenge only as a verification-page refusal, not expired authentication', async () => {
    const { error } = await rejectResponse('<html><div class="cf-turnstile"></div></html>')
    expect(error).toMatchObject({ message: expect.stringContaining('验证页面拒绝') })
    expect(error).toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED' })
  })
})
