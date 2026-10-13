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

describe('bounded Community response resources', () => {
  const friend = '76561198000000002'
  const responseLimit = 5 * 1024 * 1024

  it.each<{ status: number; headers: Record<string, string>; error: RegExp }>([
    { status: 401, headers: {}, error: /会话已失效/ },
    { status: 403, headers: {}, error: /会话已失效/ },
    { status: 302, headers: { Location: 'https://steamcommunity.com/login/home/' }, error: /会话已失效/ },
    { status: 200, headers: { 'Content-Length': String(responseLimit + 1) }, error: /size limit/ }
  ])('cancels the unconsumed body on early exit $status $headers', async ({ status, headers, error }) => {
    const cancel = vi.fn()
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array(64)))
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status, headers })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.postProfileComment(friend, 'fixture')).rejects.toThrow(error)
    expect(cancel).toHaveBeenCalledOnce()
    expect(pull).not.toHaveBeenCalled()
    expect(response.body?.locked).toBe(false)
  })

  it.each<Record<string, string>>([{}, { 'Content-Length': '1' }])('stops a chunked/decompressed body before buffering its entire payload: %j', async headers => {
    const cancel = vi.fn()
    let emitted = 0
    const chunkBytes = 64 * 1024
    const response = new Response(new ReadableStream({
      pull(controller) {
        emitted += chunkBytes
        controller.enqueue(new Uint8Array(chunkBytes).fill(120))
        if (emitted >= 16 * 1024 * 1024) controller.close()
      }, cancel
    }, { highWaterMark: 0 }), { status: 200, headers })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.postProfileComment(friend, 'fixture')).rejects.toThrow('size limit')
    expect(emitted).toBe(responseLimit + chunkBytes)
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('reassembles split UTF-8 bytes without corrupting a valid comment response', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ success: true, error: '汉', comments_html: '<div id="comment_42"></div>' }))
    let offset = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else controller.enqueue(bytes.slice(offset, ++offset))
      }
    }, { highWaterMark: 0 }))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.postProfileComment(friend, 'fixture')).resolves.toEqual({ commentId: '42' })
    expect(response.body?.locked).toBe(false)
  })

  it('marks an interrupted POST response ambiguous and releases its reader', async () => {
    const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('Synthetic broken stream')) } }))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.postProfileComment(friend, 'fixture')).rejects.toThrow('Steam response interrupted')
    expect(response.body?.locked).toBe(false)
  })

  it('cancels an unsafe GET redirect body without following it', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { Location: 'https://untrusted.example/profile' }
    })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await expect(client.checkCommentEligibility(friend)).resolves.toMatchObject({ status: 'unknown' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('clears request deadlines immediately after success or an early response rejection', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    await client.postProfileComment(friend, 'fixture')
    expect(vi.getTimerCount()).toBe(0)
    await expect(client.postProfileComment(friend, 'fixture')).rejects.toThrow(/会话已失效/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a stalled fetch at its deadline and clears the timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })))
    const client = new SteamCommunityClient('76561198000000001', cookies, vi.fn())
    const checked = expect(client.postProfileComment(friend, 'fixture')).rejects.toThrow('Steam request timed out')
    await vi.advanceTimersByTimeAsync(50_000)
    await checked
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('account-scoped profile background transport', () => {
  const account = '76561198000000001'
  const media = 'https://shared.akamai.steamstatic.com/community_assets/images/items/440/background.jpg'
  const item = (id: string, image = 'background.jpg') => ({
    communityitemid: id, item_class: 3, image_large: `items/440/${image}`, item_title: `Background ${id}`
  })
  const token = () => [
    Buffer.from('{"alg":"EdDSA","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: account, exp: Math.floor(Date.now() / 1000) + 3600, aud: ['webapi'] })).toString('base64url'),
    Buffer.from('community-client-unit-fixture-not-a-real-signature').toString('base64url')
  ].join('.')
  const tokenPage = (value: string) => `<script>var g_steamID = "${account}"; var g_wapit = "${value}";</script>`
  const profilePage = () => `<div class="profile_page has_profile_background" style="background-image:url('${media}')"></div>`
  const inventory = () => ({
    success: 1, assets: [{ classid: '100', instanceid: '0' }], more_items: 0,
    descriptions: [{ classid: '100', instanceid: '0', name: 'Inventory background',
      tags: [{ category: 'item_class', internal_name: 'item_class_3' }],
      actions: [{ name: 'View Full Size', link: media }] }]
  })

  it('fetches the page-issued token once, isolates Cookie from Web API, and returns no credentials', async () => {
    const fakeToken = token()
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.origin === 'https://steamcommunity.com') {
        expect(url.pathname).toBe(`/profiles/${account}/edit/info`)
        expect(new Headers(init?.headers).get('Cookie')).toContain('steamLoginSecure=')
        return new Response(tokenPage(fakeToken))
      }
      expect(url.origin).toBe('https://api.steampowered.com')
      expect(url.searchParams.get('access_token')).toBe(fakeToken)
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
      expect(new Headers(init?.headers).has('Cookie')).toBe(false)
      expect(init?.body).toBeUndefined()
      if (url.pathname === '/IPlayerService/GetProfileItemsOwned/v1/') {
        expect(JSON.parse(url.searchParams.get('input_json')!)).toEqual({ language: 'english', filters: [3] })
        return jsonResponse({ response: { profile_backgrounds: [item('123'), item('124', 'second.jpg')] } })
      }
      expect(url.pathname).toBe('/IPlayerService/GetProfileItemsEquipped/v1/')
      expect(JSON.parse(url.searchParams.get('input_json')!)).toEqual({ steamid: account, language: 'english' })
      return jsonResponse({ response: { profile_background: item('124', 'second.jpg') } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds()
    expect(result).toMatchObject({ accountId: account, ownedComplete: true, issues: [] })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ id: 'item:124', equipped: true, source: 'profileItems' })
    expect(JSON.stringify(result)).not.toContain(fakeToken)
    expect(JSON.stringify(result)).not.toContain('steamLoginSecure')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([503, 302])('falls back to current profile and inventory after HTTP %i without forwarding API redirects', async status => {
    const fakeToken = token()
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.hostname === 'api.steampowered.com') {
        expect(init?.redirect).toBe('error')
        expect(new Headers(init?.headers).has('Cookie')).toBe(false)
        return new Response('', { status, headers: status === 302 ? { Location: 'https://untrusted.example/credential-sink' } : {} })
      }
      expect(url.origin).toBe('https://steamcommunity.com')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('Cookie')).toContain('steamLoginSecure=')
      if (url.pathname.endsWith('/edit/info')) return new Response(tokenPage(fakeToken))
      if (url.pathname.startsWith('/inventory/')) return jsonResponse(inventory())
      return new Response(profilePage())
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds()
    expect(result).toMatchObject({ ownedComplete: false, issues: ['ownedUnavailable'] })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ title: 'Inventory background', equipped: true, source: 'inventory' })
    expect(JSON.stringify(result)).not.toContain(fakeToken)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('does not call Web API when no safe page-issued token is present', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.origin).toBe('https://steamcommunity.com')
      if (url.pathname.endsWith('/edit/info')) return new Response('<script>g_wapit="opaque-fixture";</script>')
      if (url.pathname.startsWith('/inventory/')) return jsonResponse(inventory())
      return new Response(profilePage())
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds()
    expect(result.ownedComplete).toBe(false)
    expect(result.items[0]?.equipped).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops before the first request when the account guard is already invalid', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds(() => false))
      .rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops at the Community response boundary without API or fallback requests after switching account', async () => {
    let current = true
    const fetchMock = vi.fn(async () => {
      current = false
      return new Response(tokenPage(token()))
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds(() => current))
      .rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not follow an old account\'s same-origin redirect after the guard changes', async () => {
    let current = true
    const fetchMock = vi.fn(async () => {
      current = false
      return new Response(null, { status: 302, headers: { Location: '/id/synthetic-account/edit/info' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds(() => current))
      .rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('checks the account immediately after Web API fetch, before consuming its body', async () => {
    let current = true
    const body = jsonResponse({ response: { profile_backgrounds: [item('123')] } })
    const getReader = vi.spyOn(body.body!, 'getReader')
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.hostname === 'steamcommunity.com') return new Response(tokenPage(token()))
      current = false
      return body
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds(() => current))
      .rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getReader).not.toHaveBeenCalled()
  })

  it('stops consuming streamed Web API chunks immediately after an account switch', async () => {
    let current = true
    const response = jsonResponse({ response: {} })
    const reader = {
      read: vi.fn()
        .mockImplementationOnce(async () => {
          current = false
          return { done: false, value: Buffer.from('{"response":{}}') }
        })
        .mockResolvedValue({ done: true, value: undefined }),
      cancel: vi.fn(async () => undefined), releaseLock: vi.fn()
    }
    vi.spyOn(response.body!, 'getReader').mockReturnValue(reader as any)
    const fetchMock = vi.fn(async (url: URL) => url.hostname === 'steamcommunity.com'
      ? new Response(tokenPage(token())) : response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, vi.fn()).getProfileBackgrounds(() => current))
      .rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(reader.read).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('read-only comment-check page authentication evidence', () => {
  const account = '76561198000000001'
  const friend = '76561198000000002'
  const controls = `<div id="commentthread_Profile_${friend}_area">
    <textarea id="commentthread_Profile_${friend}_textarea"></textarea>
    <span id="commentthread_Profile_${friend}_submit">Post Comment</span></div>`

  it.each(['false', 'null', '""', '"76561198000000003"'])
  ('stops the check on explicit top-level guest or other-account identity %s', async literal => {
    const onExpired = vi.fn()
    const fetchMock = vi.fn(async () => new Response(`<script>g_steamID=${literal};</script>${controls}`))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SteamCommunityClient(account, cookies, onExpired).checkCommentEligibility(friend))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(onExpired).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    '<div class="commentthread_comment_text">g_steamID=false;</div>',
    '<div class="commentthread_comment_text"><script>g_steamID=false;</script></div>',
    '<script src="https://untrusted.example/script.js">g_steamID=false;</script>',
    '<script>/* inactive assignment:\ng_steamID=false;\n*/</script>',
    '<script>const template=`inactive assignment:\ng_steamID=false;\n`;</script>',
    '<script>const string="diagnostic;g_steamID=false;";</script>',
    '<script>const pattern=/diagnostic;g_steamID=false;/;</script>',
    '<script>function unused() {\ng_steamID=false;\n}</script>',
    '<script>if (false) {\ng_steamID=false;\n}</script>',
    '<script type="text/plain">g_steamID=false;</script>',
    '<template><script>g_steamID=false;</script></template>'
  ])('does not mistake comments, strings, or nonexecuting markup for page authentication: %s', async fake => {
    const onExpired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${fake}${controls}`)))
    await expect(new SteamCommunityClient(account, cookies, onExpired).checkCommentEligibility(friend))
      .resolves.toMatchObject({ status: 'allowed' })
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('still recognizes an active guest assignment when inert examples mention another identity', async () => {
    const onExpired = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<script>g_steamID=false;const example=\`diagnostic;g_steamID="${account}";\`;</script>${controls}`
    )))
    await expect(new SteamCommunityClient(account, cookies, onExpired).checkCommentEligibility(friend))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
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
