import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'

const account = '76561198000000001'
const friend = '76561198000000002'
const cookies = (token = 'first', session = 'csrf-first') => [
  `steamLoginSecure=${account}%7C%7C${token}; Path=/; Secure; Domain=steamcommunity.com`,
  `sessionid=${session}; Path=/; Secure; Domain=steamcommunity.com`
]
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers })
const identity = (id = account) => new Response(`<script>var g_steamID = "${id}";</script>`)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Community authentication evidence and read-only verification', () => {
  it('preserves the authenticated session after an ordinary forbidden comment and never replays it', async () => {
    const expired = vi.fn()
    const fetch = vi.fn().mockResolvedValueOnce(json({ success: false, error: 'Access denied' }, 403))
      .mockResolvedValueOnce(json({ success: true, comments_html: '<div id="comment_77"></div>' }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), expired)
    await expect(client.postProfileComment(friend, 'first')).rejects.toMatchObject({ code: 'COMMUNITY_ACCESS_DENIED', retryable: true })
    expect(fetch).toHaveBeenCalledOnce()
    expect(expired).not.toHaveBeenCalled()
    await expect(client.postProfileComment(friend, 'next explicit action')).resolves.toEqual({ commentId: '77' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(expired).not.toHaveBeenCalled()
  })

  it('treats HTTP 429 as throttling before parsing misleading logged-out content', async () => {
    const expired = vi.fn()
    const fetch = vi.fn(async () => json({ success: 21 }, 429))
    vi.stubGlobal('fetch', fetch)
    await expect(new SteamCommunityClient(account, cookies(), expired).postProfileComment(friend, 'fixture'))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(expired).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([200, 403, 500])('recognizes explicit NotLoggedOn 21 at HTTP %i', async status => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: 21 }, status)))
    await expect(new SteamCommunityClient(account, cookies(), expired).postProfileComment(friend, 'fixture'))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(expired).toHaveBeenCalledOnce()
  })

  it.each([[21], '021', '21.0', { value: 21 }])('does not coerce arbitrary JSON into authentication rejection: %j', async success => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => json({ success, error: 'Synthetic rejection' })))
    await expect(new SteamCommunityClient(account, cookies(), expired).postProfileComment(friend, 'fixture')).rejects.toThrow()
    expect(expired).not.toHaveBeenCalled()
  })

  it.each([
    'https://untrusted.example/login/',
    'https://untrusted.example/?next=login.steampowered.com',
    'https://login.steampowered.com.untrusted.example/',
    'https://login.steampowered.com:444/',
    'http://steamcommunity.com/login/home/',
    'https://steamcommunity.com@untrusted.example/login/'
  ])('does not mistake an untrusted login-like redirect for expired credentials: %s', async location => {
    const expired = vi.fn()
    const fetch = vi.fn(async () => new Response('', { status: 302, headers: { Location: location } }))
    vi.stubGlobal('fetch', fetch)
    await expect(new SteamCommunityClient(account, cookies(), expired).postProfileComment(friend, 'fixture')).rejects.toThrow()
    expect(expired).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('verifies only the logged-in account using one authenticated GET and does not submit a test comment', async () => {
    const diagnostic = vi.fn()
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe(`https://steamcommunity.com/profiles/${account}/edit/info?l=english`)
      expect(init.method ?? 'GET').toBe('GET')
      expect(init.body).toBeUndefined()
      return identity()
    })
    vi.stubGlobal('fetch', fetch)
    await expect(new SteamCommunityClient(account, cookies(), vi.fn(), diagnostic).verifySession()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledWith({ phase: 'session-probe', outcome: 'success', reason: 'identity-match', method: 'GET' })
  })

  it.each(['false', '"76561198000000003"'])('rejects explicit guest or another account during verification: %s', async literal => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<script>g_steamID=${literal};</script>`)))
    await expect(new SteamCommunityClient(account, cookies(), expired).verifySession()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(expired).toHaveBeenCalledOnce()
  })

  it('does not destroy a session when a verification page has no conclusive account identity', async () => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Temporary maintenance</html>')))
    await expect(new SteamCommunityClient(account, cookies(), expired).verifySession())
      .rejects.toMatchObject({ code: 'SESSION_CHECK_FAILED', retryable: true })
    expect(expired).not.toHaveBeenCalled()
  })

  it('does not introduce a probe or retry per comment during a long synthetic batch', async () => {
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe('POST')
      return json({ success: true })
    })
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), vi.fn())
    for (let i = 0; i < 100; i++) await client.postProfileComment(friend, `fixture ${i}`)
    expect(fetch).toHaveBeenCalledTimes(100)
  })

  it('emits only bounded classification fields even when the server error and URL contain secrets', async () => {
    const diagnostic = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'private-server-token', success: false }, 403)))
    await expect(new SteamCommunityClient(account, cookies('private-cookie-token'), vi.fn(), diagnostic)
      .postProfileComment(friend, 'private-message')).rejects.toThrow()
    expect(diagnostic.mock.calls).toEqual([[{
      phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403, method: 'POST',
      endpoint: 'profile-comment', responseKind: 'json', denialKind: 'unknown'
    }]])
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|7656119|https/)
  })
})

describe('Community cookie replacement and same-origin response rotation', () => {
  it('absorbs root session rotation and sends matching Cookie and CSRF values on the next POST', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(json({ success: true }))
    const first = identity()
    first.headers.append('Set-Cookie', `steamLoginSecure=${account}%7C%7Crotated; Path=/; Secure; Domain=.steamcommunity.com; HttpOnly`)
    first.headers.append('Set-Cookie', 'sessionid=csrf-rotated; Path=/; Secure; Domain=steamcommunity.com')
    fetch.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), vi.fn())
    await client.verifySession()
    await client.postProfileComment(friend, 'fixture')
    const init = fetch.mock.calls[1]![1] as RequestInit
    expect(new Headers(init.headers).get('Cookie')).toContain(`steamLoginSecure=${account}%7C%7Crotated`)
    expect(new Headers(init.headers).get('Cookie')).toContain('sessionid=csrf-rotated')
    expect(new URLSearchParams(String(init.body)).get('sessionid')).toBe('csrf-rotated')
  })

  it('exports a defensive Main-only cookie snapshot including rotated values and expiry for candidate commit', async () => {
    const page = identity()
    page.headers.append('Set-Cookie', 'sessionid=probe-rotated; Path=/; Secure; Max-Age=3600')
    const fetch = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const candidate = new SteamCommunityClient(account, cookies('candidate'), vi.fn())
    await candidate.verifySession()
    const snapshot = candidate.getCookies()
    expect(snapshot.find(line => line.startsWith('sessionid='))).toMatch(/^sessionid=probe-rotated; Path=\/; Secure; Domain=steamcommunity.com; Expires=/)
    const runtime = new SteamCommunityClient(account, cookies(), vi.fn())
    runtime.replaceCookies(snapshot)
    snapshot.length = 0
    expect(candidate.getCookies()).toHaveLength(2)
    await runtime.postProfileComment(friend, 'fixture')
    const init = fetch.mock.calls[1]![1] as RequestInit
    expect(new URLSearchParams(String(init.body)).get('sessionid')).toBe('probe-rotated')
    expect(new Headers(init.headers).get('Cookie')).toContain('%7C%7Ccandidate')
  })

  it.each([
    'sessionid=evil; Domain=untrusted.example; Path=/',
    'sessionid=evil; Domain=sub.steamcommunity.com; Path=/',
    'sessionid=evil; Domain=steamcommunity.com.untrusted.example; Path=/',
    'sessionid=evil; Domain=steamcommunity.com; Domain=untrusted.example; Path=/',
    'sessionid=evil; Domain=steamcommunity.com; Path=/comment',
    'sessionid=evil; Domain=steamcommunity.com; Path=/; Secure=false',
    'sessionid=%0aevil; Domain=steamcommunity.com; Path=/',
    'sessionid=%broken; Domain=steamcommunity.com; Path=/',
    'steamLoginSecure=76561198000000003%7C%7Cevil; Domain=steamcommunity.com; Path=/'
  ])('ignores unsafe or wrong-account response cookies without changing the next POST: %s', async setCookie => {
    const first = identity()
    first.headers.set('Set-Cookie', setCookie)
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), vi.fn())
    await client.verifySession()
    await client.postProfileComment(friend, 'fixture')
    const init = fetch.mock.calls[1]![1] as RequestInit
    expect(new Headers(init.headers).get('Cookie')).toContain(`steamLoginSecure=${account}%7C%7Cfirst`)
    expect(new URLSearchParams(String(init.body)).get('sessionid')).toBe('csrf-first')
  })

  it('keeps unrelated cookies within their exact path segment and honors root deletion', async () => {
    const rotated = identity()
    rotated.headers.append('Set-Cookie', 'scoped=fixture; Path=/profiles; Secure')
    const removed = identity()
    removed.headers.append('Set-Cookie', 'sessionid=; Path=/; Max-Age=0; Secure')
    const fetch = vi.fn().mockResolvedValueOnce(rotated).mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(removed)
    vi.stubGlobal('fetch', fetch)
    const expired = vi.fn()
    const client = new SteamCommunityClient(account, cookies(), expired)
    await client.verifySession()
    await client.postProfileComment(friend, 'fixture')
    expect(new Headers((fetch.mock.calls[1]![1] as RequestInit).headers).get('Cookie')).not.toContain('scoped=')
    await client.verifySession()
    expect(new Headers((fetch.mock.calls[2]![1] as RequestInit).headers).get('Cookie')).toContain('scoped=fixture')
    await expect(client.postProfileComment(friend, 'not sent')).rejects.toMatchObject({ code: 'SESSION_PREPARATION_FAILED', retryable: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(expired).toHaveBeenCalledOnce()
  })

  it.each(['steamLoginSecure', 'sessionid'])('requests recovery without a POST when %s naturally expires before submission', async name => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
    const fetch = vi.fn()
    const expired = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const initialCookies = cookies().map(line => line.startsWith(`${name}=`) ? `${line}; Max-Age=1` : line)
    const client = new SteamCommunityClient(account, initialCookies, expired)
    await vi.advanceTimersByTimeAsync(1100)
    await expect(client.postProfileComment(friend, 'never submitted'))
      .rejects.toMatchObject({ code: 'SESSION_PREPARATION_FAILED', retryable: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(expired).toHaveBeenCalledOnce()
  })

  it('replaces credentials atomically and resets only the expired notification latch', async () => {
    const expired = vi.fn()
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), expired)
    await expect(client.postProfileComment(friend, 'first')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(() => client.replaceCookies(['sessionid=unsafe; Domain=untrusted.example'])).toThrow()
    client.replaceCookies(cookies('second', 'csrf-second'))
    await client.postProfileComment(friend, 'next')
    const init = fetch.mock.calls[1]![1] as RequestInit
    expect(new Headers(init.headers).get('Cookie')).toContain('%7C%7Csecond')
    expect(new URLSearchParams(String(init.body)).get('sessionid')).toBe('csrf-second')
    await expect(client.postProfileComment(friend, 'final')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(expired).toHaveBeenCalledTimes(2)
  })

  it('preserves a real in-flight POST success during refresh without allowing old Set-Cookie to roll back credentials', async () => {
    const response = deferred<Response>()
    const fetch = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), vi.fn())
    const pending = client.postProfileComment(friend, 'in flight')
    client.replaceCookies(cookies('refreshed', 'csrf-refreshed'))
    response.resolve(json({ success: true, comments_html: '<div id="comment_90"></div>' }, 200, { 'Set-Cookie': 'sessionid=old-response; Path=/; Secure' }))
    await expect(pending).resolves.toEqual({ commentId: '90' })
    await client.postProfileComment(friend, 'next explicit action')
    const first = fetch.mock.calls[0]![1] as RequestInit
    const next = fetch.mock.calls[1]![1] as RequestInit
    expect(new URLSearchParams(String(first.body)).get('sessionid')).toBe('csrf-first')
    expect(new Headers(first.headers).get('Cookie')).toContain('sessionid=csrf-first')
    expect(new URLSearchParams(String(next.body)).get('sessionid')).toBe('csrf-refreshed')
  })

  it.each([401, 200])('does not log out replacement cookies when an old request is rejected at HTTP %i', async status => {
    const response = deferred<Response>()
    const expired = vi.fn()
    const fetch = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce(identity())
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), expired)
    const pending = client.postProfileComment(friend, 'in flight')
    client.replaceCookies(cookies('refreshed', 'csrf-refreshed'))
    response.resolve(json({ success: 21 }, status))
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED', retryable: true })
    expect(expired).not.toHaveBeenCalled()
    await expect(client.verifySession()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([401, 200])('does not let an older POST rejection invalidate cookies rotated by another successful GET (HTTP %i)', async status => {
    const oldPost = deferred<Response>()
    const page = identity()
    page.headers.append('Set-Cookie', 'sessionid=rotated-by-get; Path=/; Secure')
    const expired = vi.fn()
    const fetch = vi.fn().mockReturnValueOnce(oldPost.promise).mockResolvedValueOnce(page).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const client = new SteamCommunityClient(account, cookies(), expired)
    const pending = client.postProfileComment(friend, 'old in flight')
    await client.verifySession()
    oldPost.resolve(json({ success: 21 }, status, { 'Set-Cookie': 'sessionid=; Path=/; Max-Age=0; Secure' }))
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(expired).not.toHaveBeenCalled()
    await client.postProfileComment(friend, 'next explicit action')
    expect(new URLSearchParams(String((fetch.mock.calls[2]![1] as RequestInit).body)).get('sessionid')).toBe('rotated-by-get')
  })

  it('preserves an older real POST success without rolling back cookies rotated by another successful GET', async () => {
    const oldPost = deferred<Response>()
    const page = identity()
    page.headers.append('Set-Cookie', `steamLoginSecure=${account}%7C%7Crotated-by-get; Path=/; Secure`)
    page.headers.append('Set-Cookie', 'sessionid=rotated-by-get; Path=/; Secure')
    const fetch = vi.fn().mockReturnValueOnce(oldPost.promise).mockResolvedValueOnce(page).mockResolvedValueOnce(json({ success: true }))
    vi.stubGlobal('fetch', fetch)
    const expired = vi.fn()
    const client = new SteamCommunityClient(account, cookies(), expired)
    const pending = client.postProfileComment(friend, 'old in flight')
    await client.verifySession()
    oldPost.resolve(json({ success: true, comments_html: '<div id="comment_91"></div>' }, 200, { 'Set-Cookie': 'sessionid=stale-response; Path=/; Secure' }))
    await expect(pending).resolves.toEqual({ commentId: '91' })
    await client.postProfileComment(friend, 'next explicit action')
    const init = fetch.mock.calls[2]![1] as RequestInit
    expect(new Headers(init.headers).get('Cookie')).toContain('%7C%7Crotated-by-get')
    expect(new URLSearchParams(String(init.body)).get('sessionid')).toBe('rotated-by-get')
    expect(expired).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([401, 200])('does not let a rejecting response disguise its own authentication failure by setting cookies (HTTP %i)', async status => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: 21 }, status, { 'Set-Cookie': 'sessionid=own-response; Path=/; Secure' })))
    const client = new SteamCommunityClient(account, cookies(), expired)
    await expect(client.postProfileComment(friend, 'fixture')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(expired).toHaveBeenCalledOnce()
  })

  it('does not let a guest verification response disguise its own identity rejection by setting cookies', async () => {
    const expired = vi.fn()
    const page = new Response('<script>g_steamID=false;</script>', { headers: { 'Set-Cookie': 'sessionid=own-response; Path=/; Secure' } })
    vi.stubGlobal('fetch', vi.fn(async () => page))
    const client = new SteamCommunityClient(account, cookies(), expired)
    await expect(client.verifySession()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(expired).toHaveBeenCalledOnce()
  })
})
