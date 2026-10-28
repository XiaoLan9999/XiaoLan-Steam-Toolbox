import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ComposerPanel } from '../src/renderer/src/components/ComposerPanel'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { AppSnapshot, BatchSummary } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())
const accountId = '76561198000000001'
const now = '2026-10-26T10:00:00.000Z'
const task = (overrides: Partial<BatchSummary> = {}): BatchSummary => ({
  id: 'task-layout', accountId, messageTemplate: 'Hello', delayMs: 100, status: 'paused', total: 10,
  completed: 3, succeeded: 2, failed: 1, pending: 7, sending: 0, sentVerified: 2,
  acceptedUnverified: 0, failedCount: 1, uncertain: 0, cancelled: 0,
  createdAt: now, startedAt: now, finishedAt: null, autoRetryEnabled: false,
  stopCode: 'COMMENT_BASELINE', stopMessage: null, pausedAt: now, nextRetryAt: null, retryCount: 0,
  activity: { current: null, lastConfirmed: null, recent: [],
    lastProcessed: { deliveryId: 'done', friendSteamId: '76561198000000101', friendName: 'Last Friend',
      ordinal: 3, status: 'failed', recordedAt: now, remoteCommentId: null },
    nextPending: { deliveryId: 'next', friendSteamId: '76561198000000102', friendName: 'Next Friend',
      ordinal: 4, status: 'pending', recordedAt: null, remoteCommentId: null } }, ...overrides
})
function snapshot(batch: BatchSummary): AppSnapshot {
  return { accounts: [{ id: accountId, steamId: accountId, accountName: 'Sender', displayName: 'Sender', avatarUrl: '',
    createdAt: now, lastLoginAt: now, lastFriendSyncAt: now, lastEmoticonSyncAt: null,
    sessionState: 'authenticated', sessionMessage: null }], activeAccountId: accountId,
  friends: [], friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [], friendPolicies: [],
  settings: { accountId, draft: 'Hello', delayMs: 100 }, batches: [batch], activeBatch: batch,
  commentScan: null, dataDirectory: '', language: 'zh-CN', updater: initialUpdateState('0.15.2', 'setup'),
  updatePreferences: DEFAULT_UPDATE_PREFERENCES, security: { secretStorageAvailable: true, secretStorageBackend: 'fixture' } }
}
function render(batch = task(), language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(<I18nProvider language={language}><ComposerPanel snapshot={snapshot(batch)}
    selected={new Set()} onSelectedChange={() => undefined} onOpenFriends={() => undefined}
    onOpenTasks={() => undefined} runAction={async () => null} /></I18nProvider>)
}
type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
function nodes(root: Node): Node[] { return [root, ...('childNodes' in root ? root.childNodes.flatMap(nodes) : [])] }
function hasClass(node: Node, value: string): node is Element {
  return 'attrs' in node && node.attrs.some(attr => attr.name === 'class' && attr.value.split(/\s+/).includes(value))
}
function get(root: Node, className: string): Element {
  const match = nodes(root).find(node => hasClass(node, className))
  if (!match || !('tagName' in match)) throw new Error(`Missing class ${className}`)
  return match
}
function text(root: Node): string {
  return nodes(root).flatMap(node => node.nodeName === '#text' && 'value' in node ? [node.value] : []).join('')
}

describe('compact composer runtime layout', () => {
  it.each(['zh-CN', 'en'] as const)('puts default-closed diagnostics below delivery settings, not in the sidebar, in %s', language => {
    const root = parse(render(task(), language))
    const main = get(root, 'composer-main')
    const settings = get(main, 'delivery-card')
    const details = get(main, 'composer-task-details')
    const aside = get(root, 'composer-aside')
    expect(main.childNodes.indexOf(details)).toBeGreaterThan(main.childNodes.indexOf(settings))
    expect(details.tagName).toBe('details')
    expect(details.attrs.some(attr => attr.name === 'open')).toBe(false)
    for (const className of ['batch-activity', 'batch-verification', 'batch-recovery', 'batch-failure-panel']) {
      expect(nodes(aside).some(node => hasClass(node, className))).toBe(false)
    }
    expect(nodes(details).some(node => hasClass(node, 'batch-recovery'))).toBe(true)
    expect(nodes(details).some(node => hasClass(node, 'batch-failure-panel'))).toBe(true)
    expect(text(details)).toContain(language === 'en' ? 'View all deliveries and errors' : '查看全部好友投递与错误')
    expect(text(aside)).toContain(language === 'en' ? 'Open activity and errors' : '展开运行记录与错误')
    expect(text(aside)).toContain('Last Friend')
    expect(text(aside)).toContain('Next Friend')
    expect(text(aside)).toContain(language === 'en' ? 'Comment baseline could not be read; not sent' : '评论基线读取失败，尚未发送')
    expect(text(aside)).not.toContain(language === 'en' ? 'Automatic retries are off' : '自动重试已关闭')
  })

  it('keeps pause and cancellation controls visible during sending without opening the log', () => {
    const root = parse(render(task({ status: 'running', stopCode: null })))
    const sidebar = text(get(root, 'active-batch-card'))
    expect(sidebar).toContain('暂停')
    expect(sidebar).toContain('取消批次')
    expect(sidebar).toContain('查看持久任务与明细')
    expect(get(root, 'composer-task-details').attrs.some(attr => attr.name === 'open')).toBe(false)
  })

  it('keeps a long raw stop message out of the compact sidebar', () => {
    const root = parse(render(task({ stopMessage: 'LONG_FAILURE_DETAIL '.repeat(60) })))
    expect(text(get(root, 'composer-task-details'))).toContain('LONG_FAILURE_DETAIL')
    expect(text(get(root, 'composer-aside'))).not.toContain('LONG_FAILURE_DETAIL')
  })

  it('retains a visible cooldown reason and disables resuming while the log is collapsed', () => {
    const root = parse(render(task({ stopCode: 'ACCESS_DENIED', accessDeniedUntil: '2036-10-26T10:05:00.000Z' })))
    const sidebar = get(root, 'active-batch-card')
    const resume = nodes(sidebar).find(node => 'tagName' in node && node.tagName === 'button' && text(node) === '冷却中') as Element
    expect(resume.attrs.some(attr => attr.name === 'disabled')).toBe(true)
    expect(text(sidebar)).toContain('发送冷却尚未结束')
    expect(text(sidebar)).toContain('Steam 拒绝访问（HTTP 403）')
  })

  it('keeps stop-verification available outside the collapsed diagnostics', () => {
    const root = parse(render(task({ verification: { deliveryId: 'check', friendSteamId: '76561198000000101',
      friendName: 'Review Friend', state: 'checking', attempt: 1, maxAttempts: 3, checkedAt: null,
      nextCheckAt: null, message: '' } }), 'en'))
    const sidebar = text(get(root, 'active-batch-card'))
    expect(sidebar).toContain('Stop verification')
    expect(sidebar).toContain('Checking read-only; uncertain comments are never resent')
    expect(sidebar).not.toContain('Review Friend')
  })
})
