import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { ComposerPanel } from '../src/renderer/src/components/ComposerPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const timestamp = '2026-10-11T01:00:00.000Z'

function snapshot(count: number): AppSnapshot {
  return {
    accounts: [{
      id: accountId, steamId: accountId, accountName: 'Sender', displayName: 'Sender', avatarUrl: '',
      createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: null,
      sessionState: 'authenticated', sessionMessage: null
    }],
    activeAccountId: accountId,
    friends: Array.from({ length: count }, (_, index) => {
      const steamId = String(76561198000000101n + BigInt(index))
      return { accountId, steamId, displayName: `Friend ${index}`, avatarUrl: '',
        profileUrl: `https://steamcommunity.com/profiles/${steamId}/`,
        onlineState: 'offline' as const, groupIds: [], syncedAt: timestamp }
    }),
    friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [], friendPolicies: [],
    settings: { accountId, draft: 'Hello {friend}', delayMs: 100 }, batches: [], activeBatch: null,
    commentScan: null, dataDirectory: '', language: 'zh-CN',
    updater: initialUpdateState('0.6.0', 'setup'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'test' }
  }
}

function render(state: AppSnapshot, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: React.createElement(ComposerPanel, {
      snapshot: state, selected: new Set(state.friends.map((friend) => friend.steamId)),
      onSelectedChange: () => undefined, onOpenFriends: () => undefined, runAction: async () => null
    })
  }))
}

describe('uncapped recipient composer', () => {
  it.each([31, 1005, 1200])('allows preview with %i valid selected recipients', (count) => {
    const html = render(snapshot(count))
    expect(html).toMatch(/<button class="primary send-button" aria-describedby="send-readiness">预览并确认发送/)
    expect(html).toContain(`非黑名单好友 (${count})`)
    expect(html).toContain(`另有 ${count - 12} 人`)
    expect(html).not.toContain('仅保留前')
    expect(html).not.toContain('单次最多')
    expect(html).not.toContain('拆分批次')
  })

  it('removes the cap and destructive keep-first button in English as well', () => {
    const html = render(snapshot(1200), 'en')
    expect(html).toMatch(/<button class="primary send-button" aria-describedby="send-readiness">Preview and confirm/)
    expect(html).toContain('1188 more')
    expect(html).not.toContain('Keep first')
    expect(html).not.toContain('Split the selection')
    expect(html).not.toContain('A batch allows')
  })

  it('still disables preview when all selected recipients are blacklisted', () => {
    const state = snapshot(31)
    state.friendPolicies = state.friends.map((friend) => ({
      accountId, steamId: friend.steamId, blacklisted: true,
      commentStatus: 'unknown', commentReason: null, commentCheckedAt: null
    }))
    const html = render(state)
    expect(html).toMatch(/<button class="primary send-button" disabled="" aria-describedby="send-readiness">预览并确认发送/)
    expect(html).toContain('已排除 31 位黑名单好友')
    expect(html).toContain('选中的好友均在黑名单中')
  })

  it('keeps validation of personalized text even with more than a thousand recipients', () => {
    const state = snapshot(1200)
    state.settings!.draft = `${'a'.repeat(989)}{friend}`
    state.friends.at(-1)!.displayName = 'Long final friend name'
    const html = render(state)
    expect(html).toContain('Long final friend name')
    expect(html).toMatch(/<button class="primary send-button" disabled="" aria-describedby="send-readiness">预览并确认发送/)
  })
})
