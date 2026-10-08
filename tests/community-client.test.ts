import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'

const cookies = [
  'steamLoginSecure=76561198000000001%7C%7Ctoken; Path=/; Secure; Domain=steamcommunity.com',
  'sessionid=session-123; Path=/; Secure; Domain=steamcommunity.com'
]

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SteamCommunityClient', () => {
  it('parses the authenticated compact friend relationship response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          success: 1,
          friendslist: {
            friends: [
              { ulfriendid: '76561198000000002', efriendrelationship: 3 },
              { ulfriendid: '76561198000000003', efriendrelationship: 1 }
            ]
          }
        })
      )
    )
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.getFriendRelationships()).resolves.toEqual({
      '76561198000000002': 3,
      '76561198000000003': 1
    })
  })

  it('accepts standard relationship strings and consistent duplicate entries', async () => {
    const friends = Array.from({ length: 8 }, (_, index) => ({
      ulfriendid: String(76561198000000002n + BigInt(index)),
      efriendrelationship: String(index)
    }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      success: '1', friendslist: { friends: [...friends, { ...friends[3]!, efriendrelationship: 3 }] }
    })))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.getFriendRelationships()).resolves.toEqual(
      Object.fromEntries(friends.map((entry, index) => [entry.ulfriendid, index]))
    )
  })

  it.each([
    null,
    [],
    {},
    { ulfriendid: 76561198000000002, efriendrelationship: 3 },
    { ulfriendid: 'not-a-steam-id', efriendrelationship: 3 },
    { ulfriendid: ' 76561198000000002', efriendrelationship: 3 },
    ...[null, undefined, true, false, '', ' ', '03', '3.0', '3e0', ' 3', [], {}, -1, 8, 3.5].map(
      (efriendrelationship) => ({ ulfriendid: '76561198000000002', efriendrelationship })
    )
  ])('rejects the entire relationship snapshot on an invalid entry: %j', async (invalidEntry) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      success: 1,
      friendslist: { friends: [{ ulfriendid: '76561198000000003', efriendrelationship: 3 }, invalidEntry] }
    })))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.getFriendRelationships()).rejects.toThrow('malformed friends list')
  })

  it('rejects conflicting duplicate relationships rather than deciding removal by response order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      success: 1,
      friendslist: { friends: [
        { ulfriendid: '76561198000000002', efriendrelationship: 3 },
        { ulfriendid: '76561198000000002', efriendrelationship: 0 }
      ] }
    })))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.getFriendRelationships()).rejects.toThrow('malformed friends list')
  })

  it.each([true, [], ['1'], null, '01', '1.0'])('does not coerce invalid success flags: %j', async (success) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success, friendslist: { friends: [] } })))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.getFriendRelationships()).rejects.toThrow('malformed friends list')
  })

  it('normalizes the current top-level emoticon token list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        url.pathname.includes('ajaxgetfriendslist')
          ? jsonResponse({ success: 1, friendslist: { friends: [] } })
          : jsonResponse([':steamhappy:', 'wave'])
      )
    )
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getEmoticons()
    expect(result.map((item) => [item.token, item.count])).toEqual([
      [':steamhappy:', 1],
      [':wave:', 1]
    ])
  })

  it('resolves persona data in one batch and builds avatar URLs from hashes', async () => {
    mockProfileResolver(async () =>
      jsonResponse([
        {
          steamid: '76561198000000002',
          persona_name: 'Friend',
          avatar_url: '415e13fb7a29810d88ec0bc0ae070b8667433c11',
          persona_state: 4
        }
      ])
    )
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries(['76561198000000002'])
    expect(result.profiles.get('76561198000000002')).toEqual({
      steamId: '76561198000000002',
      displayName: 'Friend',
      avatarUrl:
        'https://avatars.akamai.steamstatic.com/415e13fb7a29810d88ec0bc0ae070b8667433c11_medium.jpg',
      onlineState: 'online'
    })
    expect(result.error).toBeNull()
  })

  it('syncs 1005 profiles without exceeding the upstream request URL limit', async () => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 1005 }, (_, index) => String(76561198000000000n + BigInt(index)))
    const requestedIds: string[] = []
    const requestTimes: number[] = []
    const fetchMock = mockProfileResolver(async (url: URL) => {
      if (url.href.length > 8192) return new Response('URI Too Long', { status: 414 })
      expect(url.href.length).toBeLessThan(3000)
      requestTimes.push(Date.now())
      const chunk = url.searchParams.get('steamids')!.split(',')
      requestedIds.push(...chunk)
      return jsonResponse(chunk.map((steamid) => ({ steamid, persona_name: `Friend ${steamid}` })))
    })
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const pending = client.getProfileSummaries(ids)
    const [result] = await Promise.all([pending, vi.runAllTimersAsync()])
    expect(result.error).toBeNull()
    expect(result.profiles.size).toBe(1005)
    expect(requestedIds).toEqual(ids)
    expect(fetchMock).toHaveBeenCalledTimes(11)
    expect(requestTimes.slice(1).every((time, index) => time - requestTimes[index]! >= 5000)).toBe(true)
  })

  it.each([429, 500])('keeps successful batches and stops on HTTP %i without retrying', async (status) => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 250 }, (_, index) => String(76561198000000000n + BigInt(index)))
    const onExpired = vi.fn()
    const fetchMock = mockProfileResolver(async (url: URL) => {
      const chunk = url.searchParams.get('steamids')!.split(',')
      return chunk[0] === ids[0]
        ? jsonResponse(chunk.map((steamid) => ({ steamid, persona_name: 'Cached result' })))
        : new Response('Request failed', { status })
    })
    const client = new SteamCommunityClient('76561198000000001', cookies, onExpired)
    const pending = client.getProfileSummaries(ids)
    const [result] = await Promise.all([pending, vi.runAllTimersAsync()])
    expect(result.profiles.size).toBe(100)
    expect(result.profiles.get(ids[0]!)?.displayName).toBe('Cached result')
    expect(result.error?.message).toContain(String(status))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('retains the failure reason when the first profile batch fails', async () => {
    mockProfileResolver(async () => new Response('Rate limited', { status: 429 }))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries(['76561198000000002'])
    expect(result.profiles.size).toBe(0)
    expect(result.error?.message).toContain('HTTP 429')
  })

  it('deduplicates IDs and ignores unsolicited profiles in the response', async () => {
    const requested = '76561198000000002'
    mockProfileResolver(async (url: URL) => {
      expect(url.searchParams.get('steamids')).toBe(requested)
      return jsonResponse([
        { steamid: requested, persona_name: 'Requested' },
        { steamid: '76561198000000003', persona_name: 'Not requested' }
      ])
    })
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries([requested, requested, 'invalid'])
    expect([...result.profiles.keys()]).toEqual([requested])
  })

  it('does not issue profile requests for an empty friend list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries([])
    expect(result.profiles.size).toBe(0)
    expect(result.error).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not replace a cached name with an ID when the resolver omits the persona name', async () => {
    mockProfileResolver(async () => jsonResponse([{ steamid: '76561198000000002' }]))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries(['76561198000000002'])
    expect(result.profiles.size).toBe(0)
  })

  it('reads 1005 personas from one friend page without using the rate-limited resolver', async () => {
    const ids = Array.from({ length: 1005 }, (_, index) => String(76561198000000000n + BigInt(index)))
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe('/profiles/76561198000000001/friends/')
      return new Response(ids.map(friendHtml).join(''))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries(ids)
    expect(result.profiles.size).toBe(1005)
    expect(result.profiles.get(ids[0]!)?.displayName).toBe('Friend & name')
    expect(result.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('only resolves IDs missing from the rendered friend page and retains the page data on failure', async () => {
    const first = '76561198000000002'
    const second = '76561198000000003'
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/friends/')) return new Response(friendHtml(first))
      expect(url.searchParams.get('steamids')).toBe(second)
      return new Response('Rate limited', { status: 429 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries([first, second])
    expect([...result.profiles.keys()]).toEqual([first])
    expect(result.error?.message).toContain('429')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('follows same-origin vanity redirects for the friend page', async () => {
    const fetchMock = vi.fn(async (url: URL) => url.pathname.startsWith('/profiles/')
      ? new Response(null, { status: 302, headers: { location: '/id/account/friends/' } })
      : new Response(friendHtml('76561198000000002')))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const result = await client.getProfileSummaries(['76561198000000002'])
    expect(result.profiles.size).toBe(1)
    expect(result.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['https://untrusted.example/friends/', 'http://steamcommunity.com/id/account/friends/'])(
    'never forwards cookies to an unsafe friend page redirect: %s', async (location) => {
      const fetchMock = vi.fn(async (url: URL) => {
        expect(url.origin).toBe('https://steamcommunity.com')
        return url.pathname.endsWith('/friends/')
          ? new Response(null, { status: 302, headers: { location } })
          : jsonResponse([{ steamid: '76561198000000002', persona_name: 'Fallback' }])
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
      const result = await client.getProfileSummaries(['76561198000000002'])
      expect(result.profiles.size).toBe(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each([302, 429])('does not fall back after login redirect or rate limiting on the friend page (%i)', async (status) => {
    const onExpired = vi.fn()
    const fetchMock = vi.fn(async () => new Response(null, {
      status,
      headers: status === 302 ? { location: 'https://steamcommunity.com/login/home/' } : {}
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, onExpired)
    const result = await client.getProfileSummaries(['76561198000000002'])
    expect(result.profiles.size).toBe(0)
    expect(result.error?.message).toMatch(status === 302 ? /会话已失效/ : /429/)
    expect(onExpired).toHaveBeenCalledTimes(status === 302 ? 1 : 0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('posts a profile comment with the current session id and captures the response id', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) =>
      jsonResponse({ success: true, comments_html: '<div id="comment_7788"></div>' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.postProfileComment('76561198000000002', 'hello')).resolves.toEqual({
      commentId: '7788'
    })
    const init = fetchMock.mock.calls[0]?.[1]
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('sessionid')).toBe('session-123')
    expect(form.get('comment')).toBe('hello')
  })

  it('marks HTTP 401 as an expired session', async () => {
    const onExpired = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 }))
    )
    const client = new SteamCommunityClient('76561198000000001', cookies, onExpired)
    await expect(client.getEmoticons()).rejects.toThrow(/会话已失效/)
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('recognizes Steam success 21 inside an HTTP 500 response as logged out', async () => {
    const onExpired = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: 21 }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    const client = new SteamCommunityClient('76561198000000001', cookies, onExpired)
    await expect(client.getFriendRelationships()).rejects.toThrow(/会话已失效/)
    expect(onExpired).toHaveBeenCalledOnce()
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function mockProfileResolver(handler: (url: URL) => Promise<Response>) {
  const resolver = vi.fn(handler)
  vi.stubGlobal('fetch', (url: URL) => url.pathname.endsWith('/friends/')
    ? Promise.resolve(new Response('<html><body>Unavailable friend page</body></html>'))
    : resolver(url))
  return resolver
}

function friendHtml(steamId: string): string {
  return `<div class="selectable friend_block_v2 persona online" data-steamid="${steamId}">
    <div class="player_avatar"><img src="https://avatars.steamstatic.com/example.jpg"></div>
    <div class="friend_block_content">Friend &amp; name<br><span>Online</span></div>
  </div>`
}
