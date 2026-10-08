import { describe, expect, it, vi } from 'vitest'
import { parseFriendPage } from '../src/main/friend-page-parser'

const ids = ['76561198000000001', '76561198000000002', '76561198000000003']
const avatar = 'https://avatars.fastly.steamstatic.com/415e13fb7a29810d88ec0bc0ae070b8667433c11_medium.jpg'

function row(id: string, name: string, state = 'offline', image = avatar): string {
  return `<div class="selectable friend_block_v2 persona ${state}" data-steamid="${id}">
    <a class="selectable_overlay" href="https://steamcommunity.com/profiles/${id}"></a>
    <div class="player_avatar"><img src="${image}"></div>
    <div class="friend_block_content">${name}<br><span class="friend_small_text">A game or status</span></div>
  </div>`
}

describe('parseFriendPage', () => {
  it('reads the complete SSR friend list with online, offline and in-game states', () => {
    const html = `<div id="search_results" class="profile_friends">
      ${row(ids[0]!, 'Playing friend', 'in-game')}
      ${row(ids[1]!, 'Online friend', 'online')}
      ${row(ids[2]!, 'Offline friend')}
    </div>`
    expect([...parseFriendPage(html, ids).values()]).toEqual([
      { steamId: ids[0], displayName: 'Playing friend', avatarUrl: avatar, onlineState: 'in-game' },
      { steamId: ids[1], displayName: 'Online friend', avatarUrl: avatar, onlineState: 'online' },
      { steamId: ids[2], displayName: 'Offline friend', avatarUrl: avatar, onlineState: 'offline' }
    ])
  })

  it('decodes entities and preserves Unicode and nested name text without the status', () => {
    const html = row(ids[0]!, '  &#x5C0F;&#x84DD; &amp; <span>&lt;friend&gt; &#128512;</span>  ')
    expect(parseFriendPage(html, ids).get(ids[0]!)?.displayName).toBe('\u5c0f\u84dd & <friend> \u{1f600}')
  })

  it('does not admit unrelated rows, unrequested IDs or invalid relationship IDs', () => {
    const html = `${row(ids[0]!, 'Allowed')}${row(ids[1]!, 'Not a friend')}
      ${row('invalid', 'Invalid')}
      <div class="not_friend_block_v2" data-steamid="${ids[2]}"><div class="friend_block_content">Other</div></div>`
    expect([...parseFriendPage(html, [ids[0]!, ids[2]!, 'invalid']).keys()]).toEqual([ids[0]])
  })

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,evil',
    'http://avatars.fastly.steamstatic.com/image.jpg',
    'https://avatars.fastly.steamstatic.com.evil.test/image.jpg',
    'https://user:password@avatars.fastly.steamstatic.com/image.jpg',
    '/relative-avatar.jpg'
  ])('rejects unsafe or non-Steam avatar URLs: %s', (image) => {
    expect(parseFriendPage(row(ids[0]!, 'Friend', 'offline', image), ids).get(ids[0]!)?.avatarUrl).toBe('')
  })

  it('parses inertly without evaluating scripts or requesting images', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const html = row(ids[0]!, '<script>throw new Error("executed")</script>Safe', 'offline', `${avatar}" onerror="fetch('/bad')`)
      expect(parseFriendPage(html, ids).get(ids[0]!)?.displayName).toBe('Safe')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    '<html><body><form action="/login/"><input name="password"></form></body></html>',
    '<html><body><div class="profile_private_info">This profile is private.</div></body></html>',
    '{"success":21}',
    '<div class="friend_block_v2" data-steamid="76561198000000001"><span>Missing content</span></div>',
    '<div class="friend_block_v2" data-steamid="76561198000000001"><div class="friend_block_content"><span class="friend_small_text">Offline</span></div></div>',
    ''
  ])('leaves login, private and malformed pages unresolved', (html) => {
    expect(parseFriendPage(html, ids).size).toBe(0)
  })

  it('keeps the first valid duplicate and does not borrow nested row details', () => {
    const html = `${row(ids[0]!, ' ')}${row(ids[0]!, 'First valid')}${row(ids[0]!, 'Duplicate')}
      <div class="friend_block_v2" data-steamid="${ids[1]}">${row(ids[2]!, 'Nested')}</div>`
    expect([...parseFriendPage(html, ids).values()].map((profile) => profile.displayName)).toEqual(['First valid'])
  })

  it('ignores deeply nested markup without recursive traversal', () => {
    const html = `${'<div>'.repeat(1000)}${row(ids[0]!, 'Too deeply nested')}${'</div>'.repeat(1000)}`
    expect(parseFriendPage(html, ids).size).toBe(0)
  })

  it('does not parse anything for an empty relationship list', () => {
    expect(parseFriendPage(row(ids[0]!, 'No longer a friend'), []).size).toBe(0)
  })
})
