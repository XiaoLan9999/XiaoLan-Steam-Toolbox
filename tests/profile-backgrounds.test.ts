import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import {
  getProfileBackgroundCatalog,
  extractProfileWebApiToken,
  normalizeProfileBackgroundMediaUrl,
  parseEquippedProfileBackground,
  parseProfileItemBackground,
  type ProfileBackgroundProvider
} from '../src/main/profile-backgrounds'

const ACCOUNT = '76561198000000001'
const IMAGE = 'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.jpg'
const VIDEO = 'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.mp4'
const NOW = 1_800_000_000
const jwt = (overrides = {}, header = { alg: 'EdDSA', typ: 'JWT' }) => [
  Buffer.from(JSON.stringify(header)).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: ACCOUNT, exp: NOW + 3_600, aud: ['webapi'], ...overrides })).toString('base64url'),
  Buffer.from('unit-test-not-a-real-token-signature').toString('base64url')
].join('.')
const tokenPage = (token = jwt(), account = ACCOUNT) =>
  `<script>var g_steamID = ${JSON.stringify(account)}; var g_wapit = ${JSON.stringify(token)};</script>`
const item = (id = '123', overrides = {}) => ({
  communityitemid: id, item_class: 3, image_large: 'items/440/main.jpg', item_title: 'Main background', ...overrides
})
const page = (inside = '', style = '', extra = '') =>
  `<html><body class="profile_page"><div class="profile_page ${extra}" style="${style}">${inside}</div></body></html>`
const inventory = (name = 'First background', cursor?: string) => ({
  success: 1,
  assets: [{ classid: '100', instanceid: '0' }],
  descriptions: [{
    classid: '100', instanceid: '0', name,
    tags: [{ category: 'item_class', internal_name: 'item_class_3' }],
    actions: [{ name: 'View Full Size', link: IMAGE }]
  }],
  more_items: cursor ? 1 : 0, ...(cursor ? { last_assetid: cursor } : {})
})
const provider = (overrides: Partial<ProfileBackgroundProvider> = {}): ProfileBackgroundProvider => ({
  requestText: vi.fn(async () => page()),
  requestJson: vi.fn(async () => ({ success: 1, total_inventory_count: 0 })),
  pause: vi.fn(async () => {}),
  ...overrides
})

describe('page-issued Community Web API token extraction', () => {
  it('reads a literal token only when page identity, JWT subject, and expiry agree', () => {
    const token = jwt()
    expect(extractProfileWebApiToken(tokenPage(token), ACCOUNT, NOW)).toBe(token)
    expect(extractProfileWebApiToken(tokenPage(token).replace('var g_wapit', 'window.g_wapit'), ACCOUNT, NOW)).toBe(token)
  })

  it('does not require signature verification in the parser; Steam API remains the authenticating endpoint', () => {
    expect(extractProfileWebApiToken(tokenPage(), ACCOUNT, NOW)).toBe(jwt())
  })

  it.each([
    { sub: '76561198000000002' }, { exp: NOW }, { exp: NOW + 5 }, { exp: 'future' },
    { exp: NOW + 0.5 }, { exp: null }, { nbf: NOW + 61 }, { nbf: 'future' }, { aud: ['derive', 'webapi'] }
  ])('rejects a foreign, expired, malformed, or refresh token: %j', (claims) => {
    expect(extractProfileWebApiToken(tokenPage(jwt(claims)), ACCOUNT, NOW)).toBeNull()
  })

  it('rejects page identity mismatch even when the token subject looks correct', () => {
    expect(extractProfileWebApiToken(tokenPage(jwt(), '76561198000000002'), ACCOUNT, NOW)).toBeNull()
  })

  it('rejects missing page identity rather than borrowing the target profile identity', () => {
    expect(extractProfileWebApiToken(`<script>g_rgProfileData={steamid:${JSON.stringify(ACCOUNT)}};g_wapit=${JSON.stringify(jwt())};</script>`, ACCOUNT, NOW)).toBeNull()
  })

  it('rejects conflicting token and account literals', () => {
    expect(extractProfileWebApiToken(`${tokenPage()}<script>g_wapit=${JSON.stringify(jwt({ exp: NOW + 7_200 }))};</script>`, ACCOUNT, NOW)).toBeNull()
    expect(extractProfileWebApiToken(`${tokenPage()}<script>g_steamID="76561198000000002";</script>`, ACCOUNT, NOW)).toBeNull()
  })

  it('allows repetition of an identical literal without picking between conflicting credentials', () => {
    expect(extractProfileWebApiToken(tokenPage() + tokenPage(), ACCOUNT, NOW)).toBe(jwt())
  })

  it('does not execute script functions or expressions to obtain a token', () => {
    expect(extractProfileWebApiToken(tokenPage().replace(JSON.stringify(jwt()), 'getToken()'), ACCOUNT, NOW)).toBeNull()
    expect(extractProfileWebApiToken(tokenPage().replace(JSON.stringify(jwt()), `${JSON.stringify(jwt())}+"suffix"`), ACCOUNT, NOW)).toBeNull()
    expect(extractProfileWebApiToken(`${tokenPage()}<script>g_wapit=readOtherAccountToken();</script>`, ACCOUNT, NOW)).toBeNull()
  })

  it('does not treat comments, attributes, strings, templates, or regular expressions as assignments', () => {
    for (const source of [
      `// g_wapit=${JSON.stringify(jwt())};`, `/* g_wapit=${JSON.stringify(jwt())}; */`,
      `const string='g_wapit=${JSON.stringify(jwt())};';`,
      'const template=`g_wapit=' + JSON.stringify(jwt()) + ';`;',
      `const pattern=/g_wapit=${JSON.stringify(jwt())};/;`
    ]) {
      expect(extractProfileWebApiToken(`<script>g_steamID=${JSON.stringify(ACCOUNT)};${source}</script>`, ACCOUNT, NOW)).toBeNull()
    }
    expect(extractProfileWebApiToken(`<div data-token='g_wapit=${JSON.stringify(jwt())};'></div><script>g_steamID=${JSON.stringify(ACCOUNT)};</script>`, ACCOUNT, NOW)).toBeNull()
  })

  it('ignores external script bodies and unrelated object properties', () => {
    expect(extractProfileWebApiToken(`<script src="https://evil.example/script.js">g_steamID=${JSON.stringify(ACCOUNT)};g_wapit=${JSON.stringify(jwt())};</script>`, ACCOUNT, NOW)).toBeNull()
    expect(extractProfileWebApiToken(tokenPage().replace('var g_wapit', 'otherObject.g_wapit'), ACCOUNT, NOW)).toBeNull()
  })

  it('fails closed if Valve changes this field to opaque token syntax', () => {
    expect(extractProfileWebApiToken(tokenPage('opaque-token'), ACCOUNT, NOW)).toBeNull()
    expect(extractProfileWebApiToken(tokenPage(jwt({}, { alg: 'none', typ: 'JWT' })), ACCOUNT, NOW)).toBeNull()
  })

  it('rejects invalid caller identity and oversized token without logging its contents', () => {
    expect(extractProfileWebApiToken(tokenPage(), 'bad', NOW)).toBeNull()
    expect(extractProfileWebApiToken(tokenPage('a'.repeat(16_385)), ACCOUNT, NOW)).toBeNull()
  })
})

describe('Steam background media boundaries', () => {
  it('converts Steam profile item relative paths to full-size official CDN URLs', () => {
    expect(normalizeProfileBackgroundMediaUrl('items/440/main.jpg', 'image')).toBe(IMAGE)
    expect(normalizeProfileBackgroundMediaUrl('items/440/main.mp4', 'video')).toBe(VIDEO)
  })

  it.each([
    'https://shared.steamstatic.com/community_assets/images/items/440/main.jpg',
    'https://shared.fastly.steamstatic.com/community_assets/images/items/440/main.png',
    'https://community.akamai.steamstatic.com/economy/profilebackground/items/440/main.jpg',
    'https://steamcommunity.com/economy/profilebackground/items/440/main.jpg'
  ])('accepts primary Steam CDN full-size image: %s', (url) => {
    expect(normalizeProfileBackgroundMediaUrl(url, 'image')).toBe(url)
  })

  it.each([
    'http://shared.akamai.steamstatic.com/community_assets/images/items/440/main.jpg',
    'https://shared.akamai.steamstatic.com.evil.example/community_assets/images/items/440/main.jpg',
    'https://127.0.0.1/community_assets/images/items/440/main.jpg',
    'https://shared.akamai.steamstatic.com:444/community_assets/images/items/440/main.jpg',
    'https://name:password@shared.akamai.steamstatic.com/community_assets/images/items/440/main.jpg',
    `${IMAGE}?access_token=secret`, `${IMAGE}#fragment`,
    'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.svg',
    'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.html',
    'https://steamcommunity.com/profiles/76561198000000001/main.jpg',
    'https://shared.akamai.steamstatic.com/economy/image/icon.jpg',
    'javascript:alert(1)', '//shared.akamai.steamstatic.com/community_assets/images/items/440/main.jpg',
    'items/440/path/main.jpg', 'items/440/back\\slash.jpg', 'items/440/with space.jpg'
  ])('rejects unsafe or non-original media: %s', (url) => {
    expect(normalizeProfileBackgroundMediaUrl(url, 'image')).toBeNull()
  })

  it('does not treat video as image or an image as video', () => {
    expect(normalizeProfileBackgroundMediaUrl(VIDEO, 'image')).toBeNull()
    expect(normalizeProfileBackgroundMediaUrl(IMAGE, 'video')).toBeNull()
  })
})

describe('Steam profile items and equipped HTML', () => {
  it('reads static full-size profile items, not their inventory icon thumbnail', () => {
    expect(parseProfileItemBackground(item('123', { image_small: 'items/440/thumbnail.jpg' }))).toEqual({
      id: 'item:123', title: 'Main background', kind: 'static', imageUrl: IMAGE, stillImageUrl: IMAGE,
      videoUrl: null, equipped: false, source: 'profileItems'
    })
  })

  it('retains both animation and its explicitly static poster', () => {
    expect(parseProfileItemBackground(item('123', { movie_mp4: 'items/440/main.mp4' }), true)).toMatchObject({
      kind: 'animated', equipped: true, imageUrl: IMAGE, stillImageUrl: IMAGE, videoUrl: VIDEO
    })
  })

  it('supports animation with no poster without inventing a crop-able still', () => {
    expect(parseProfileItemBackground(item('123', { image_large: '', movie_webm: 'items/440/main.webm' }))).toMatchObject({
      kind: 'animated', imageUrl: null, stillImageUrl: null, videoUrl: expect.stringContaining('main.webm')
    })
  })

  it.each([
    item('0'), item('not-an-id'), item('123', { item_class: 4 }),
    item('123', { image_large: '', image_small: 'items/440/thumbnail.jpg' }),
    item('123', { movie_mp4: 'https://evil.example/main.mp4' })
  ])('rejects unsupported items without changing animation to static', (value) => {
    expect(parseProfileItemBackground(value)).toBeNull()
  })

  it('reads static current profile style regardless of quote and HTML entity encoding', () => {
    const html = page('', `background-image: url('${IMAGE}');`, 'has_profile_background')
    expect(parseEquippedProfileBackground(html)).toMatchObject({ imageUrl: IMAGE, equipped: true, kind: 'static' })
    expect(parseEquippedProfileBackground(page('', `background-image: url(&quot;${IMAGE}&quot;);`))).toMatchObject({ imageUrl: IMAGE })
  })

  it('uses only the actual profile background, not avatar or user-generated showcase images', () => {
    const html = page(`<div class="profile_content"><img src="${IMAGE}"><div style="background-image:url('${IMAGE}')"></div></div>`)
    expect(parseEquippedProfileBackground(html)).toBeNull()
  })

  it('reads the active animated profile video and poster, preferring mp4', () => {
    const html = page(`<div class="profile_animated_background"><video poster="${IMAGE}">
      <source src="${VIDEO.replace('.mp4', '.webm')}" type="video/webm"><source src="${VIDEO}" type="video/mp4">
    </video></div>`, '', 'has_profile_background')
    expect(parseEquippedProfileBackground(html)).toMatchObject({ kind: 'animated', imageUrl: IMAGE, videoUrl: VIDEO })
  })

  it('never executes page JavaScript or accepts its proposed external URLs', () => {
    expect(parseEquippedProfileBackground(page('<script>throw new Error("should not execute")</script>'))).toBeNull()
    expect(() => parseEquippedProfileBackground(page('', "background-image:url('https://evil.example/main.jpg')"))).toThrow()
  })

  it('does not report logged-out/error or changed templates as a valid empty profile', () => {
    expect(() => parseEquippedProfileBackground('<title>Sign in</title><form></form>')).toThrow('BACKGROUND_PROFILE_PAGE_INVALID')
    expect(() => parseEquippedProfileBackground(page('', '', 'has_profile_background'))).toThrow('BACKGROUND_PROFILE_MEDIA_INVALID')
  })
})

describe('account background catalog', () => {
  it('requests only read-only Player API methods and includes equipped plus owned points backgrounds', async () => {
    const api = vi.fn(async (method: string) => method === 'GetProfileItemsOwned'
      ? { response: { profile_backgrounds: [item(), item('124', { image_large: 'items/440/second.jpg', movie_mp4: 'items/440/second.mp4' })] } }
      : { response: { profile_background: item('124', { image_large: 'items/440/second.jpg', movie_mp4: 'items/440/second.mp4' }) } })
    const transport = provider({ requestPlayerJson: api })
    const result = await getProfileBackgroundCatalog(ACCOUNT, transport)
    expect(api.mock.calls).toEqual([
      ['GetProfileItemsOwned', { language: 'english', filters: [3] }],
      ['GetProfileItemsEquipped', { steamid: ACCOUNT, language: 'english' }]
    ])
    expect(result.ownedComplete).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ id: 'item:124', kind: 'animated', equipped: true })
    expect(transport.requestText).not.toHaveBeenCalled()
    expect(transport.requestJson).not.toHaveBeenCalled()
  })

  it('accepts the valid protobuf omission for an empty owned set and no equipped item', async () => {
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestPlayerJson: async () => ({ response: {} }) }))
    expect(result.ownedComplete).toBe(true)
    expect(result.items).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('falls back to the actual profile and 753/6 inventory if Player transport is unavailable', async () => {
    const transport = provider({
      requestText: vi.fn(async () => page('', `background-image:url('${IMAGE}')`)),
      requestJson: vi.fn(async () => inventory())
    })
    const result = await getProfileBackgroundCatalog(ACCOUNT, transport)
    expect(transport.requestText).toHaveBeenCalledWith(`/profiles/${ACCOUNT}/?l=english`)
    expect(transport.requestJson).toHaveBeenCalledWith(`/inventory/${ACCOUNT}/753/6?l=english&count=2000`)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ title: 'First background', equipped: true, source: 'inventory' })
    expect(result.ownedComplete).toBe(false)
    expect(result.issues).toEqual(['ownedUnavailable'])
  })

  it('deduplicates different Steam CDN hosts pointing to the same full-size media', async () => {
    const body = inventory()
    body.descriptions[0]!.actions[0]!.link = IMAGE.replace('shared.akamai.', 'shared.')
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({
      requestText: async () => page('', `background-image:url('${IMAGE}')`), requestJson: async () => body
    }))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.equipped).toBe(true)
  })

  it('preserves equipped image if inventory is private/unavailable without claiming an empty complete list', async () => {
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({
      requestText: async () => page('', `background-image:url('${IMAGE}')`),
      requestJson: async () => ({ success: 15 })
    }))
    expect(result.items).toHaveLength(1)
    expect(result.ownedComplete).toBe(false)
    expect(result.issues).toEqual(['ownedUnavailable', 'inventoryUnavailable'])
  })

  it('preserves readable owned items and falls back to current HTML when equipped API fails', async () => {
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({
      requestText: async () => page('', `background-image:url('${IMAGE}')`),
      requestPlayerJson: async (method) => {
        if (method === 'GetProfileItemsEquipped') throw new Error('HTTP 500')
        return { response: { profile_backgrounds: [item()] } }
      }
    }))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ source: 'profileItems', equipped: true })
    expect(result.ownedComplete).toBe(true)
  })

  it('lists partial unsupported media rather than claiming all owned items were read', async () => {
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestPlayerJson: async (method) => ({
      response: method === 'GetProfileItemsOwned' ? { profile_backgrounds: [item(), item('124', { image_large: 'https://evil.example/bg.jpg' })] } : {}
    }) }))
    expect(result.items).toHaveLength(1)
    expect(result.ownedComplete).toBe(false)
    expect(result.issues).toEqual(['unsupportedItems'])
  })

  it('only uses actually owned inventory assets tagged as full profile backgrounds', async () => {
    const body = inventory()
    body.descriptions.push({ ...body.descriptions[0]!, classid: '200', name: 'Not owned' })
    body.descriptions.push({ ...body.descriptions[0]!, classid: '100', tags: [{ category: 'item_class', internal_name: 'item_class_4' }], name: 'Emoticon' })
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: async () => body }))
    expect(result.items.map((entry) => entry.title)).toEqual(['First background'])
  })

  it('does not silently substitute an icon thumbnail when a full-size link is missing', async () => {
    const body = inventory()
    body.descriptions[0]!.actions = [{ name: 'View Full Size', link: 'https://shared.steamstatic.com/economy/image/thumb.jpg' }]
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: async () => body }))
    expect(result.items).toEqual([])
    expect(result.issues).toContain('unsupportedItems')
  })

  it('paginates inventory with a bounded cursor and retains previous results on later failure', async () => {
    const json = vi.fn().mockResolvedValueOnce(inventory('First background', '500')).mockRejectedValueOnce(new Error('HTTP 503'))
    const transport = provider({ requestJson: json })
    const result = await getProfileBackgroundCatalog(ACCOUNT, transport)
    expect(json.mock.calls[1]).toEqual([`/inventory/${ACCOUNT}/753/6?l=english&count=2000&start_assetid=500`])
    expect(transport.pause).toHaveBeenCalledWith(350)
    expect(result.items).toHaveLength(1)
    expect(result.issues).toContain('inventoryPartial')
  })

  it('stops after at most eight inventory pages and marks a bounded result partial', async () => {
    let cursor = 0
    const json = vi.fn(async () => inventory('First background', String(++cursor)))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(json).toHaveBeenCalledTimes(8)
    expect(result.issues).toContain('inventoryPartial')
  })

  it('stops repeated pagination cursors instead of looping', async () => {
    const json = vi.fn(async () => inventory('First background', '500'))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(json).toHaveBeenCalledTimes(2)
    expect(result.issues).toContain('inventoryPartial')
  })

  it('treats string zero as the final page, not as a truthy pagination flag', async () => {
    const json = vi.fn(async () => ({ ...inventory(), more_items: '0' }))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(json).toHaveBeenCalledTimes(1)
    expect(result.items).toHaveLength(1)
    expect(result.issues).toEqual(['ownedUnavailable'])
  })

  it.each(['yes', 2, {}, []])('rejects malformed pagination flag %j', async (moreItems) => {
    const json = vi.fn(async () => ({ ...inventory(), more_items: moreItems }))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(json).toHaveBeenCalledTimes(1)
    expect(result.issues).toContain('inventoryUnavailable')
  })

  it('rejects malformed owned asset records before treating descriptions as ownership proof', async () => {
    const json = vi.fn(async () => ({ ...inventory(), assets: [{ classid: 'bad', instanceid: '0' }] }))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(result.items).toEqual([])
    expect(result.issues).toContain('inventoryUnavailable')
  })

  it('does not insert unsafe inventory cursor strings into a network request', async () => {
    const json = vi.fn(async () => inventory('First background', '500&access_token=secret'))
    const result = await getProfileBackgroundCatalog(ACCOUNT, provider({ requestJson: json }))
    expect(json).toHaveBeenCalledTimes(1)
    expect(result.issues).toContain('inventoryUnavailable')
  })

  it.each(['SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'SESSION_CHANGED', 'ARTWORK_SESSION_CHANGED', 'ARTWORK_BACKGROUND_CANCELLED', 'BACKGROUND_CANCELLED', 'WRONG_ACCOUNT', 'NOT_AUTHENTICATED', 'RATE_LIMITED'])('immediately propagates transport stop signal %s', async (code) => {
    const transport = provider({ requestPlayerJson: vi.fn(async () => { throw new DomainError(code, code) }) })
    await expect(getProfileBackgroundCatalog(ACCOUNT, transport)).rejects.toMatchObject({ code })
    expect(transport.requestText).not.toHaveBeenCalled()
    expect(transport.requestJson).not.toHaveBeenCalled()
  })

  it('rejects invalid account IDs before performing requests', async () => {
    const transport = provider()
    await expect(getProfileBackgroundCatalog('../somewhere', transport)).rejects.toMatchObject({ code: 'INVALID_STEAM_ID' })
    expect(transport.requestText).not.toHaveBeenCalled()
  })
})
