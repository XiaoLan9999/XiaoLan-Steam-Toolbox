import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CommentScanJob } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { ComposerPanel } from '../src/renderer/src/components/ComposerPanel'
import { FriendsPanel } from '../src/renderer/src/components/FriendsPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const friendId = '76561198000000002'
const timestamp = '2026-10-11T01:00:00.000Z'

function snapshot(delayMs = 100, scanDelayMs: number | null = 100): AppSnapshot {
  return {
    accounts: [{
      id: accountId, steamId: accountId, accountName: 'Sender', displayName: 'Sender', avatarUrl: '',
      createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: null,
      sessionState: 'authenticated', sessionMessage: null
    }],
    activeAccountId: accountId,
    friends: [{
      accountId, steamId: friendId, displayName: 'Friend', avatarUrl: '',
      profileUrl: `https://steamcommunity.com/profiles/${friendId}/`,
      onlineState: 'offline', groupIds: [], syncedAt: timestamp
    }],
    friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [], friendPolicies: [],
    settings: { accountId, draft: 'Hello {friend}', delayMs }, batches: [], activeBatch: null,
    commentScan: scanDelayMs === null ? null : scan(scanDelayMs),
    dataDirectory: '', language: 'zh-CN',
    updater: initialUpdateState('0.5.0', 'setup'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'test' }
  }
}

function scan(delayMs: number): CommentScanJob {
  return {
    id: 'completed-scan', accountId, status: 'completed', total: 1, completed: 1,
    allowed: 1, blocked: 0, unknown: 0, currentSteamId: null, lastError: null,
    delayMs, createdAt: timestamp, updatedAt: timestamp
  }
}

function renderPanel(kind: 'composer' | 'friends', state = snapshot(), language: 'zh-CN' | 'en' = 'zh-CN'): string {
  const common = {
    snapshot: state, selected: new Set([friendId]), onSelectedChange: () => undefined,
    runAction: async () => null
  }
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: kind === 'composer'
      ? React.createElement(ComposerPanel, { ...common, onOpenFriends: () => undefined })
      : React.createElement(FriendsPanel, { ...common, onCompose: () => undefined })
  }))
}

describe('fractional-second interval controls', () => {
  it('offers a 0.1-second minimum and tenth-second input steps on both panels', () => {
    const composer = renderPanel('composer')
    const friends = renderPanel('friends')
    expect(composer).toMatch(/type="number" min="0\.1" max="300" step="0\.1" value="0\.1"/)
    expect(friends).toMatch(/type="number" min="0\.1" max="60" step="0\.1" value="0\.1"/)
    expect(composer).not.toMatch(/disabled=""[^>]*>预览并确认发送/)
    expect(friends).not.toMatch(/disabled=""[^>]*>检查当前筛选/)
  })

  it('hydrates decimal delivery and latest scan intervals without rounding to whole seconds', () => {
    const state = snapshot(1300, 300)
    expect(renderPanel('composer', state)).toMatch(/type="number"[^>]*value="1\.3"/)
    expect(renderPanel('friends', state)).toMatch(/type="number"[^>]*value="0\.3"/)
  })

  it('retains the 15-second delivery and 10-second check defaults', () => {
    const state = snapshot(15_000, null)
    state.settings = null
    expect(renderPanel('composer', state)).toMatch(/type="number"[^>]*value="15"/)
    expect(renderPanel('friends', state)).toMatch(/type="number"[^>]*value="10"/)
  })

  it('does not borrow another account\'s last scan interval', () => {
    const state = snapshot()
    state.commentScan = { ...scan(100), accountId: '76561198000000003' }
    expect(renderPanel('friends', state)).toMatch(/type="number"[^>]*value="10"/)
  })

  it('leaves a running scan interval fixed and disables editing or launching a second task', () => {
    const state = snapshot()
    state.commentScan = { ...scan(100), status: 'running', completed: 0, allowed: 0 }
    const html = renderPanel('friends', state)
    expect(html).toMatch(/type="number"[^>]*disabled=""[^>]*value="0\.1"/)
    expect(html).toMatch(/disabled=""[^>]*>检查当前筛选/)
    expect(html).toContain('每人间隔 0.1 秒')
  })

  it('allows a paused check interval to be saved without starting another task', () => {
    const state = snapshot()
    state.commentScan = { ...scan(300), status: 'paused', total: 3, completed: 1 }
    const html = renderPanel('friends', state)
    expect(html).toMatch(/type="number" min="0\.1" max="60" step="0\.1" value="0\.3"/)
    expect(html).not.toMatch(/type="number"[^>]*disabled=""/)
    expect(html).toContain('<button class="ghost">保存检查间隔</button>')
    expect(html).toContain('点击继续会先保存新间隔')
    expect(html).toMatch(/disabled=""[^>]*>检查当前筛选/)
  })

  it('allows offline paused interval editing while keeping Resume disabled', () => {
    const state = snapshot()
    state.accounts[0]!.sessionState = 'offline'
    state.commentScan = { ...scan(100), status: 'paused' }
    const html = renderPanel('friends', state, 'en')
    expect(html).not.toMatch(/type="number"[^>]*disabled=""/)
    expect(html).toContain('<button class="ghost">Save check interval</button>')
    expect(html).toMatch(/disabled=""[^>]*>Resume/)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
  ('rejects non-finite saved intervals %s instead of enabling submission', (value) => {
    const state = snapshot(value, value)
    const composer = renderPanel('composer', state)
    const friends = renderPanel('friends', state)
    expect(composer).toMatch(/type="number"[^>]*value=""/)
    expect(friends).toMatch(/type="number"[^>]*value=""/)
    expect(composer).toMatch(/disabled=""[^>]*>预览并确认发送/)
    expect(friends).toMatch(/disabled=""[^>]*>检查当前筛选/)
    expect(composer).toContain('基础间隔必须在 0.1–300 秒之间。')
  })

  it('translates the supported range accurately in English', () => {
    expect(renderPanel('composer', snapshot(0), 'en')).toContain('between 0.1 and 300 seconds')
    expect(renderPanel('friends', snapshot(), 'en')).toContain('0.1–60 sec')
  })
})
