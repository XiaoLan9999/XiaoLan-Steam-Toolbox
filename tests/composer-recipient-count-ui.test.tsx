import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, BatchSummary } from '../src/shared/types'
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

  it('shows the affected and next friend directly in the compact current-batch panel without claiming a paused task is sending', () => {
    const state = snapshot(1)
    const recipient = { deliveryId: 'review-recipient', friendSteamId: '76561198000000002', friendName: 'Review Friend',
      ordinal: 465, status: 'uncertain' as const, recordedAt: timestamp, remoteCommentId: null }
    const task: BatchSummary = { id: 'fixture-batch', accountId, messageTemplate: 'Hello', delayMs: 100,
      status: 'paused', total: 994, completed: 465, succeeded: 423, failed: 42,
      pending: 529, sending: 0, sentVerified: 423, acceptedUnverified: 0, failedCount: 41, uncertain: 1, cancelled: 0,
      createdAt: timestamp, startedAt: timestamp, finishedAt: null, autoRetryEnabled: true,
      stopCode: 'UNCERTAIN_RESULT', stopMessage: null, pausedAt: timestamp, nextRetryAt: null, retryCount: 0,
      activity: { current: null, lastProcessed: recipient, lastConfirmed: null,
        nextPending: { ...recipient, deliveryId: 'next-recipient', friendName: 'Next Friend', ordinal: 466, status: 'pending', recordedAt: null }, recent: [recipient] } }
    state.batches = [task]
    state.activeBatch = task
    const html = render(state, 'en')
    expect(html).toContain('batch-activity compact')
    expect(html).toContain('Review Friend')
    expect(html).toContain('Next Friend')
    expect(html).toContain('Delivery unknown; never retried automatically')
    expect(html).toContain('No delivery is in flight for this task')
    expect(html).toContain('Processed')
    expect(html).toContain('465 / 994')
    expect(html).not.toContain('465 comments sent')
  })
})
