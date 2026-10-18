import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, BatchSummary, BatchVerification } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import { BatchVerificationPanel, batchVerificationActive, batchVerificationActionLabel, batchVerificationConfirmation } from '../src/renderer/src/components/BatchVerificationPanel'
import { TaskDetails } from '../src/renderer/src/components/HistoryPanel'
import { ComposerPanel } from '../src/renderer/src/components/ComposerPanel'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const timestamp = '2026-10-18T00:02:00.000Z'
const runAction = async () => null
const zh = (value: string): string => value
const en = (_zh: string, value: string): string => value

function batch(value: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'synthetic-review-batch', accountId, messageTemplate: 'Synthetic message', delayMs: 1000,
    status: 'paused', total: 1000, completed: 465, succeeded: 423, failed: 42,
    createdAt: timestamp, startedAt: timestamp, finishedAt: null,
    pending: 535, sending: 0, sentVerified: 423, acceptedUnverified: 0, failedCount: 41,
    uncertain: 1, cancelled: 0, autoRetryEnabled: true, stopCode: 'UNCERTAIN_RESULT',
    stopMessage: 'synthetic-detail', pausedAt: timestamp, nextRetryAt: null, retryCount: 0,
    accessDeniedCount: 7, accessDeniedUntil: new Date(Date.now() + 60_000).toISOString(),
    ...value
  }
}

function verification(value: Partial<BatchVerification> = {}): BatchVerification {
  return {
    deliveryId: 'synthetic-review-recipient', friendSteamId: '76561198000000002', friendName: 'Synthetic Review Friend',
    state: 'checking', attempt: 1, maxAttempts: 3, checkedAt: null, nextCheckAt: null,
    message: '', ...value
  }
}

function snapshot(value: BatchSummary): AppSnapshot {
  return {
    accounts: [{ id: accountId, steamId: accountId, accountName: 'Synthetic Sender', displayName: 'Synthetic Sender',
      avatarUrl: '', createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: null,
      sessionState: 'authenticated', sessionMessage: null }],
    activeAccountId: accountId, friends: [], groups: [], friendPolicies: [], friendRemovals: [], friendNameChanges: [],
    emoticons: [], settings: null, batches: [value], activeBatch: value.status === 'completed' ? null : value,
    commentScan: null, dataDirectory: '', language: 'zh-CN', updater: initialUpdateState('0.10.1', 'setup'),
    updatePreferences: DEFAULT_UPDATE_PREFERENCES, security: { secretStorageAvailable: true, secretStorageBackend: 'test' }
  }
}

function render(child: React.ReactNode, language: Language = 'zh-CN'): string {
  return renderToStaticMarkup(<I18nProvider language={language}>{child}</I18nProvider>)
}

function panel(value: Partial<BatchSummary> = {}, language: Language = 'zh-CN'): string {
  return render(<BatchVerificationPanel batch={batch(value)} onStop={() => undefined} />, language)
}

function task(value: Partial<BatchSummary> = {}, authenticated = true, otherTaskActive = false, language: Language = 'zh-CN'): string {
  return render(<TaskDetails batch={batch(value)} accountName="Synthetic Sender" authenticated={authenticated}
    otherTaskActive={otherTaskActive} runAction={runAction} />, language)
}

function composer(value: Partial<BatchSummary> = {}, language: Language = 'zh-CN'): string {
  return render(<ComposerPanel snapshot={snapshot(batch(value))} selected={new Set()} onSelectedChange={() => undefined}
    onOpenFriends={() => undefined} runAction={runAction} />, language)
}

describe('read-only uncertain-delivery verification UI', () => {
  it('does not invent a check or a successful outcome from uncertain counts', () => {
    const html = panel()
    expect(html).toContain('待核对留言可以自动核实')
    expect(html).toContain('未确定的保留待核对并跳过')
    expect(html).toContain('不重复发送，也不阻塞其余待发')
    expect(html).not.toContain('Synthetic Review Friend')
    expect(html).not.toContain('主页已确认留言送达')
    expect(html).not.toContain('停止核对')
    expect(panel({ uncertain: 0 })).toBe('')
  })

  it.each([
    ['checking', '正在只读核对好友主页', 'Checking the friend profile (read-only)'],
    ['waiting', '等待下一次只读核对', 'Waiting for the next read-only check'],
    ['confirmed', '主页已确认留言送达', 'Delivery confirmed on the profile'],
    ['unresolved', '本条暂未证实，保留待核对', 'Not proven; kept for review']
  ] as const)('shows %s using metadata, not the technical message, in both languages', (state, chinese, english) => {
    const value = { verification: verification({ state, message: '' }) }
    expect(panel(value)).toContain(chinese)
    const html = panel(value, 'en')
    expect(html).toContain(english)
    expect(html).toContain('Synthetic Review Friend')
    expect(html).toContain('76561198000000002')
    expect(html).toContain('Check 1 / 3')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not claim successful delivery merely because a technical message says success', () => {
    const html = panel({ verification: verification({ state: 'unresolved', message: 'synthetic success statement' }) })
    expect(html).toContain('本条暂未证实，保留待核对')
    expect(html).not.toContain('主页已确认留言送达')
    expect(html).toContain('<details class="batch-verification-detail">')
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
  })

  it('renders a finite next-check countdown, not a send countdown', () => {
    const html = panel({ verification: verification({ state: 'waiting', attempt: 2,
      nextCheckAt: new Date(Date.now() + 15_000).toISOString(), checkedAt: timestamp }) })
    expect(html).toContain('下次只读核对')
    expect(html).toMatch(/aria-live="off">00:1[45]/)
    expect(html).toContain('核对 2 / 3 次')
    expect(html).toContain(`<time dateTime="${timestamp}">`)
    expect(html).not.toContain('距离自动发送')
  })

  it.each([null, 'invalid-date', new Date(Date.now() - 1000).toISOString()])('does not keep a false countdown for deadline=%s', nextCheckAt => {
    const html = panel({ verification: verification({ state: 'waiting', nextCheckAt }) })
    expect(html).toContain('这不是发送倒计时')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('00:00')
  })

  it.each(['checking', 'waiting'] as const)('permits stopping a %s check but not starting it again', state => {
    const value = batch({ verification: verification({ state }) })
    expect(batchVerificationActive(value)).toBe(true)
    expect(batchVerificationActionLabel(value, zh)).toBe('正在核对')
    expect(batchVerificationActionLabel(value, en)).toBe('Verifying')
    expect(panel(value)).toContain('<button class="ghost">停止核对</button>')
    expect(task(value)).toMatch(/<button class="primary" disabled="">正在核对/)
    expect(composer(value)).toMatch(/<button class="primary" disabled="">正在核对/)
  })

  it.each(['confirmed', 'unresolved'] as const)('does not show a stop control for terminal verification state %s', state => {
    const value = batch({ verification: verification({ state }) })
    expect(batchVerificationActive(value)).toBe(false)
    expect(panel(value)).not.toContain('停止核对')
  })

  it('allows explicit read-only verification during an active POST cooldown in both locations', () => {
    expect(task()).toContain('<button class="primary">核对并继续其余待发</button>')
    expect(composer()).toContain('<button class="primary">核对并继续其余待发</button>')
    expect(task()).toContain('尚未结束的发送冷却')
    expect(composer()).toContain('尚未结束的发送冷却')
    expect(task({}, true, false, 'en')).toContain('Verify and resume remaining pending')
    expect(composer({}, 'en')).toContain('Verify and resume remaining pending')
  })

  it('does not disable the real POST cooldown for a task without uncertain results', () => {
    expect(task({ uncertain: 0 })).toContain('<button class="primary" disabled="">冷却中</button>')
    expect(composer({ uncertain: 0 })).toContain('<button class="primary" disabled="">冷却中</button>')
  })

  it('allows completed uncertain records to be checked without promising any sending', () => {
    const value = { status: 'completed' as const, pending: 0, finishedAt: timestamp }
    for (const html of [task(value), composer(value)]) {
      expect(html).toContain('<button class="primary">仅核对待核对记录</button>')
      expect(html).toContain('此任务已结束：仅核对保存的待核对记录，不会启动任何新发送')
      expect(html).not.toContain('取消任务</button>')
      expect(html).not.toContain('取消批次</button>')
    }
    const confirmation = batchVerificationConfirmation(batch(value), zh)
    expect(confirmation).toContain('不会启动任何新发送')
    expect(confirmation).not.toContain('继续其余')
    expect(batchVerificationConfirmation(batch(value), en)).toContain('no new sending will start')
  })

  it('still allows review-only checking when paused and no pending recipients remain', () => {
    const value = { pending: 0 }
    expect(task(value)).toContain('<button class="primary">仅核对待核对记录</button>')
    expect(composer(value)).toContain('<button class="primary">仅核对待核对记录</button>')
  })

  it('disables checks while offline or another task is active', () => {
    expect(task({}, false)).toContain('<button class="primary" disabled="">核对并继续其余待发</button>')
    expect(task({}, true, true)).toContain('<button class="primary" disabled="">核对并继续其余待发</button>')
  })

  it('keeps manual send consent explicit and states the exact scope', () => {
    const message = batchVerificationConfirmation(batch(), zh)
    expect(message).toContain('只读核对 1 条待核对记录')
    expect(message).toContain('然后继续其余 535 位待发好友')
    expect(message).toContain('未确认的仍保留待核对并跳过，不会重发')
    expect(message).toContain('原有发送间隔和冷却仍有效')
    expect(batchVerificationConfirmation(batch(), en)).not.toMatch(/\p{Script=Han}/u)
  })

  it('keeps canceled tasks non-resumable even with an uncertain record', () => {
    expect(task({ status: 'cancelled' })).not.toContain('class="primary"')
    expect(composer({ status: 'cancelled' })).not.toContain('class="primary">核对并继续')
  })

  it('escapes recipient names and technical details instead of creating HTML or links', () => {
    const html = panel({ verification: verification({ friendName: '<img src=x onerror=alert(1)>', message: '<script>synthetic</script>' }) })
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;synthetic&lt;/script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<a ')
  })

  it('keeps unknown processing times absent, not fabricated', () => {
    expect(panel({ verification: verification({ checkedAt: 'invalid-date' }) })).not.toContain('<time')
    expect(panel({ verification: verification({ checkedAt: null }) })).not.toContain('<time')
  })

  it('wires only explicit actions, keeps same-count verification refreshes, and uses wrapping theme colors', () => {
    const history = readFileSync(new URL('../src/renderer/src/components/HistoryPanel.tsx', import.meta.url), 'utf8')
    const composerSource = readFileSync(new URL('../src/renderer/src/components/ComposerPanel.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/renderer/src/components/batch-verification.css', import.meta.url), 'utf8')
    for (const source of [history, composerSource]) {
      expect(source).toContain('window.steamCommenter.verifyBatch(batch.id)')
      expect(source).toContain('batchVerificationConfirmation(batch, t)')
      expect(source).toContain('batchVerificationActive(batch)')
    }
    expect(history).toContain('batch.verification?.checkedAt, batch.verification?.nextCheckAt')
    expect(history).toContain('batch.verification?.deliveryId, batch.verification?.state, batch.verification?.attempt')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain('flex-wrap: wrap')
    expect(css).toContain('var(--sky-soft)')
    expect(css).toContain('var(--tea-soft)')
  })
})
