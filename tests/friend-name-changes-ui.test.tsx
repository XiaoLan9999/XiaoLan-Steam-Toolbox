import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FriendNameChangeRecord } from '../src/shared/types'
import { FriendNameChangesPanel, filterFriendNameChanges } from '../src/renderer/src/components/FriendNameChangesPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const rename: FriendNameChangeRecord = {
  id: 'rename-1', accountId, steamId: '76561198000000002', oldName: 'Alice Old', newName: 'Spring Bird',
  avatarUrl: 'https://avatars.akamai.steamstatic.com/cached_medium.jpg',
  profileUrl: 'https://steamcommunity.com/profiles/76561198000000002',
  detectedAt: '2026-10-08T01:23:45.000Z'
}
const repeated: FriendNameChangeRecord = {
  ...rename, id: 'rename-2', oldName: 'Spring Bird', newName: 'Summer Cat', detectedAt: '2026-10-09T01:23:45.000Z'
}
const otherAccount: FriendNameChangeRecord = {
  ...rename, id: 'other-account', accountId: '76561198000000099', oldName: 'Private old name', newName: 'Private new name'
}

function renderHistory(changes: FriendNameChangeRecord[], language: 'zh-CN' | 'en' = 'zh-CN', canSync = true): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: React.createElement(FriendNameChangesPanel, { accountId, changes, canSync, onSync: () => undefined })
  }))
}

describe('friend name history search', () => {
  it('finds old names, new names and SteamIDs without crossing account boundaries', () => {
    const changes = [rename, repeated, otherAccount]
    expect(filterFriendNameChanges(changes, accountId, ' ALICE OLD ')).toEqual([rename])
    expect(filterFriendNameChanges(changes, accountId, 'spring bird')).toEqual([rename, repeated])
    expect(filterFriendNameChanges(changes, accountId, 'SUMMER')).toEqual([repeated])
    expect(filterFriendNameChanges(changes, accountId, '000000002')).toEqual([rename, repeated])
    expect(filterFriendNameChanges(changes, accountId, 'private')).toEqual([])
    expect(filterFriendNameChanges(changes, otherAccount.accountId, 'private')).toEqual([otherAccount])
  })

  it('preserves multiple events for one friend and leaves saved history unchanged', () => {
    const changes = [repeated, rename, otherAccount]
    const before = structuredClone(changes)
    expect(filterFriendNameChanges(changes, accountId, '')).toEqual([repeated, rename])
    expect(changes).toEqual(before)
  })
})

describe('friend name history read-only UI', () => {
  it('renders both rename events, year-bearing detection times and profile links for the current account', () => {
    const html = renderHistory([repeated, rename, otherAccount])
    expect(html).toContain('Alice Old')
    expect(html).toContain('Spring Bird')
    expect(html).toContain('Summer Cat')
    expect(html).toContain('76561198000000002')
    expect(html).toContain('cached_medium.jpg')
    expect(html).toContain('href="https://steamcommunity.com/profiles/76561198000000002"')
    expect(html).toContain('dateTime="2026-10-08T01:23:45.000Z"')
    expect(html).toContain('dateTime="2026-10-09T01:23:45.000Z"')
    expect(html).toMatch(/<time[^>]*>2026\//)
    expect(html).toContain('昵称变化 2 条 · 当前显示 2 条')
    expect(html).not.toContain('Private old name')
    expect(html).not.toContain('Private new name')
  })

  it('has no selection, compose, group or scan controls', () => {
    const html = renderHistory([rename])
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('data-friend-id')
    expect(html).not.toContain('friend-drag-surface')
    expect(html).not.toContain('friend-selected-tools')
    expect(html).not.toContain('comment-scan-controls')
    expect(html).toContain('发现时间不是精确改名时间')
    expect(html).toContain('首次获取资料不算更名')
    expect(html).toContain('每个账号独立保存')
    expect(html).toContain('包含在导出数据中')
  })

  it('shows English controls and limitations, including an account-isolated empty state', () => {
    const html = renderHistory([rename], 'en')
    expect(html).toContain('Search old name, new name or SteamID')
    expect(html).toContain('not the exact rename time')
    expect(html).toContain('First-time profiles and cached names')
    expect(html).toContain('included in data exports')
    expect(html).not.toMatch(/\p{Script=Han}/u)
    expect(renderHistory([otherAccount], 'en')).toContain('No name-change records')
  })

  it('disables sync without authentication and renders remote names as text', () => {
    const html = renderHistory([{ ...rename, oldName: '<script>old()</script>', newName: '<img onerror="new()">' }], 'en', false)
    expect(html).toMatch(/<button class="ghost" disabled=""/)
    expect(html).toContain('&lt;script&gt;old()&lt;/script&gt;')
    expect(html).toContain('&lt;img onerror=&quot;new()&quot;&gt;')
    expect(html).not.toContain('<script>old()')
    expect(html).not.toContain('<img onerror="new()">')
  })
})
