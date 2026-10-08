import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, FriendRemovalRecord } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { FriendRemovalsPanel, filterFriendRemovals } from '../src/renderer/src/components/FriendRemovalsPanel'
import { FriendsPanel } from '../src/renderer/src/components/FriendsPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const removed: FriendRemovalRecord = {
  id: 'removed-1', accountId, steamId: '76561198000000002', displayName: 'Cached Alice',
  avatarUrl: 'https://avatars.akamai.steamstatic.com/cached_medium.jpg',
  profileUrl: 'https://steamcommunity.com/profiles/76561198000000002',
  detectedAt: '2026-10-04T01:23:45.000Z', restoredAt: null, source: 'sync'
}
const restored: FriendRemovalRecord = {
  ...removed, id: 'restored-1', displayName: 'Earlier Alice', detectedAt: '2026-10-01T01:23:45.000Z',
  restoredAt: '2026-10-02T01:23:45.000Z'
}
const legacy: FriendRemovalRecord = {
  ...removed, id: 'legacy-1', steamId: '76561198000000003', displayName: 'Cached Bob',
  detectedAt: null, avatarUrl: '', source: 'legacy'
}

function renderRemovals(removals: FriendRemovalRecord[], language: 'zh-CN' | 'en' = 'zh-CN', canSync = true): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: React.createElement(FriendRemovalsPanel, { removals, canSync, onSync: () => undefined })
  }))
}

describe('removed-friend history filtering', () => {
  it('defaults to records that are still removed, including migrated unknown-time records', () => {
    expect(filterFriendRemovals([removed, restored, legacy], '', 'unrestored')).toEqual([removed, legacy])
  })

  it('retains repeated removals of the same SteamID as separate historical records', () => {
    expect(filterFriendRemovals([removed, restored], '', 'all')).toEqual([removed, restored])
  })

  it('searches cached names case-insensitively and ignores surrounding whitespace', () => {
    expect(filterFriendRemovals([removed, restored, legacy], '  ALICE  ', 'all')).toEqual([removed, restored])
  })

  it('searches by SteamID and combines the search with the restored filter', () => {
    expect(filterFriendRemovals([removed, restored, legacy], '000000002', 'unrestored')).toEqual([removed])
  })

  it('does not mutate or rewrite cached history', () => {
    const history = [legacy, restored, removed]
    const before = structuredClone(history)
    expect(filterFriendRemovals(history, 'missing', 'all')).toEqual([])
    expect(history).toEqual(before)
  })
})

describe('removed-friend read-only UI', () => {
  it('renders cached identity, exact SteamID and detection timestamp without any selection or action controls', () => {
    const html = renderRemovals([removed, restored, legacy])
    expect(html).toContain('Cached Alice')
    expect(html).toContain('76561198000000002')
    expect(html).toContain('dateTime="2026-10-04T01:23:45.000Z"')
    expect(html).toContain('cached_medium.jpg')
    expect(html).toContain('旧版缓存 · 时间未知')
    expect(html).toContain('仍未恢复 2 人 · 历史 3 条 · 当前显示 2 条')
    expect(html).not.toContain('Earlier Alice')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('data-friend-id')
    expect(html).not.toContain('friend-drag-surface')
    expect(html).not.toContain('去留言')
    expect(html).not.toContain('应用分组')
    expect(html).not.toContain('检查已选')
  })

  it('explains who-removed-whom and timestamp limitations without assigning blame', () => {
    const html = renderRemovals([removed])
    expect(html).toContain('无法判断是对方删除你，还是你删除对方')
    expect(html).toContain('发现时间不是实际解除时间')
    expect(html).toContain('再次解除会新增记录')
  })

  it('renders complete English controls, empty states and limitations', () => {
    const html = renderRemovals([removed, legacy], 'en')
    expect(html).toContain('Still removed')
    expect(html).toContain('All history (including re-added)')
    expect(html).toContain('Legacy cache · Time unknown')
    expect(html).toContain('cannot tell who removed whom')
    expect(html).toContain('not the exact removal time')
    expect(html).not.toMatch(/\p{Script=Han}/u)
    expect(renderRemovals([], 'en')).toContain('No removed-friend records')
  })

  it('offers historical records when all removed friends have been re-added', () => {
    const html = renderRemovals([restored], 'en')
    expect(html).toContain('0 still removed · 1 historical records · 0 shown')
    expect(html).toContain('Switch to All history to view re-added records')
  })

  it('does not offer sync while the current account is unauthenticated', () => {
    expect(renderRemovals([], 'en', false)).toMatch(/<button class="ghost" disabled=""/)
  })

  it('escapes cached profile names instead of interpreting them as markup', () => {
    const html = renderRemovals([{ ...removed, displayName: '<script>bad()</script>' }])
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()')
  })

  it('keeps current-friend totals separate from account-scoped unrestored history counts', () => {
    const snapshot: AppSnapshot = {
      accounts: [{ id: accountId, steamId: accountId, accountName: 'Account', displayName: 'Account', avatarUrl: '', createdAt: removed.detectedAt!, lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null, sessionState: 'offline', sessionMessage: null }],
      activeAccountId: accountId,
      friends: [{ accountId, steamId: legacy.steamId, displayName: 'Current friend', avatarUrl: '', profileUrl: legacy.profileUrl, onlineState: 'offline', groupIds: [], syncedAt: removed.detectedAt! }],
      friendRemovals: [removed, restored, { ...legacy, accountId: '76561198000000099' }],
      friendNameChanges: [],
      friendPolicies: [], commentScan: null, groups: [], emoticons: [], settings: null,
      batches: [], activeBatch: null, dataDirectory: '', language: 'en',
      updater: initialUpdateState('0.4.0', 'setup'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
      security: { secretStorageAvailable: true, secretStorageBackend: 'dpapi' }
    }
    const html = renderToStaticMarkup(React.createElement(I18nProvider, {
      language: 'en', children: React.createElement(FriendsPanel, { snapshot, selected: new Set<string>(), onSelectedChange: () => undefined, onCompose: () => undefined, runAction: async () => null })
    }))
    expect(html).toContain('<span>Total friends</span><strong>1</strong>')
    expect(html).toContain('Removed friends <b>1</b>')
    expect(html).toContain('Regular friends <b>1</b>')
    expect(html).toContain('Current friend')
    expect(html).not.toContain('Cached Alice')
    expect(html).not.toContain('Cached Bob')
  })
})
