import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, FriendPolicy, FriendRecord } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { FriendsPanel } from '../src/renderer/src/components/FriendsPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

const state = vi.hoisted(() => ({ view: 'normal' }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => initial === 'normal' ? [state.view, () => undefined] : actual.useState(initial) }
})
vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const a = '76561198000000001'
const b = '76561198000000002'
const at = '2026-10-27T01:00:00.000Z'
const id = (n: number) => String(76561198000000100n + BigInt(n))
const friend = (n: number, accountId = a): FriendRecord => ({ accountId, steamId: id(n), displayName: `Friend ${n}`,
  avatarUrl: '', profileUrl: `https://steamcommunity.com/profiles/${id(n)}/`, onlineState: 'offline', groupIds: ['kept-group'], syncedAt: at })
const policy = (n: number, commentStatus: FriendPolicy['commentStatus'], blacklisted = false, accountId = a): FriendPolicy => ({
  accountId, steamId: id(n), blacklisted, commentStatus, commentReason: commentStatus === 'unknown' ? 'Network failed' : 'Comments disabled', commentCheckedAt: at
})
function snapshot(): AppSnapshot {
  return { accounts: [{ id: a, steamId: a, accountName: 'Fixture', displayName: 'Fixture', avatarUrl: '', createdAt: at,
    lastLoginAt: at, lastFriendSyncAt: at, lastEmoticonSyncAt: at, sessionState: 'authenticated', sessionMessage: null }],
    activeAccountId: a, friends: [friend(1), friend(2), friend(3), friend(4), friend(5, b)],
    friendPolicies: [policy(1, 'blocked'), policy(2, 'blocked', true), policy(3, 'unknown'), policy(4, 'allowed'), policy(5, 'blocked', false, b), policy(1, 'allowed', false, b)],
    groups: [{ id: 'kept-group', accountId: a, name: 'Existing group', color: '#66c0f4', createdAt: at }],
    friendRemovals: [], friendNameChanges: [], emoticons: [], settings: null, batches: [], activeBatch: null, commentScan: null,
    dataDirectory: '', language: 'en', updater: initialUpdateState('0.15.4', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'fixture' } }
}
function render(view = 'normal', language: 'zh-CN' | 'en' = 'en', data = snapshot()) {
  state.view = view
  return renderToStaticMarkup(<I18nProvider language={language}><FriendsPanel snapshot={data} selected={new Set()}
    onSelectedChange={() => undefined} onCompose={() => undefined} runAction={async () => null} /></I18nProvider>)
}
const row = (html: string, n: number) => html.includes(`data-friend-id="${id(n)}"`)

describe('account-scoped comments unavailable category', () => {
  it('offers the category with a count that includes blacklisted restrictions but not network failures or other accounts', () => {
    const html = render()
    expect(html).toContain('Comments unavailable <b>2</b>')
    expect(html).toContain('Regular friends <b>2</b>')
    expect(html).toContain('Blacklist <b>1</b>')
    expect(html).toContain('<span>Total friends</span><strong>4</strong>')
    expect(row(html, 1)).toBe(false)
    expect(row(html, 2)).toBe(false)
    expect(row(html, 3)).toBe(true)
    expect(row(html, 5)).toBe(false)
    expect(html).toContain('Network errors do not place friends in that category')
  })

  it('shows only the current account blocked friends in the virtual category without changing their groups', () => {
    const html = render('unavailable')
    for (const n of [1, 2]) expect(row(html, n)).toBe(true)
    for (const n of [3, 4, 5]) expect(row(html, n)).toBe(false)
    expect(html).toContain('including blacklisted friends')
    expect(html).toContain('Existing group')
    expect(html).toContain('Add to blacklist')
    expect(html).toContain('Remove from blacklist')
  })

  it('leaves the blacklist independent and removes an allowed friend from the unavailable category', () => {
    const data = snapshot()
    data.friendPolicies[0]!.commentStatus = 'allowed'
    const html = render('unavailable', 'en', data)
    expect(html).toContain('Comments unavailable <b>1</b>')
    expect(row(html, 1)).toBe(false)
    expect(row(html, 2)).toBe(true)
    expect(row(render('normal', 'en', data), 1)).toBe(true)
    expect(row(render('blacklist'), 2)).toBe(true)
  })

  it('provides the same category and network caveat in Chinese', () => {
    const html = render('unavailable', 'zh-CN')
    expect(html).toContain('无法留言 <b>2</b>')
    expect(html).toContain('当前无法留言')
    expect(html).toContain('网络错误仍属暂无法判断')
    expect(html).toContain('不改变自定义分组')
  })
})
