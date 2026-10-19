import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, BatchSummary } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { HistoryPanel, TaskDetails, TaskPageRequests, TaskPagination } from '../src/renderer/src/components/HistoryPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const timestamp = '2026-10-13T01:00:00.000Z'
const runAction = async () => null

function batch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'task-12345678', accountId, messageTemplate: 'Saved hello {friend}', delayMs: 100, status: 'paused',
    total: 1005, completed: 405, succeeded: 400, failed: 5, createdAt: timestamp, startedAt: timestamp,
    finishedAt: null, pending: 599, sending: 1, sentVerified: 390, acceptedUnverified: 10,
    failedCount: 3, uncertain: 2, cancelled: 0, autoRetryEnabled: false, stopCode: null,
    stopMessage: null, pausedAt: null, nextRetryAt: null, retryCount: 0, ...overrides
  }
}

function snapshot(batches: BatchSummary[] = [batch()]): AppSnapshot {
  return {
    accounts: [{
      id: accountId, steamId: accountId, accountName: 'Sender', displayName: 'Sender', avatarUrl: '',
      createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: null,
      sessionState: 'authenticated', sessionMessage: null
    }],
    activeAccountId: accountId, friends: [], friendRemovals: [], friendNameChanges: [], groups: [],
    emoticons: [], friendPolicies: [], settings: null, batches, activeBatch: batches[0] ?? null, commentScan: null,
    dataDirectory: '', language: 'zh-CN', updater: initialUpdateState('0.6.1', 'setup'),
    updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'test' }
  }
}

function render(children: React.ReactNode, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, { language, children }))
}

describe('durable task center UI', () => {
  it('shows completion, the seven separate status counts, timestamps, and the saved template', () => {
    const html = render(React.createElement(HistoryPanel, { snapshot: snapshot(), runAction }))
    expect(html).toContain('持久任务列表')
    expect(html).toContain('每页 25 条')
    expect(html).toContain('405/1005')
    expect(html).toContain('<strong>405</strong><span>/ 1005 已处理')
    expect(html).toContain('<dt>创建</dt>')
    expect(html).toContain('<dt>开始</dt>')
    expect(html).toContain('<dt>结束</dt><dd>尚未</dd>')
    expect(html).toContain('Saved hello {friend}')
    for (const [label, count] of [['待发', 599], ['发送中', 1], ['已确认', 390], ['已接受未核验', 10], ['失败', 3], ['待核对', 2], ['已取消', 0]]) {
      expect(html).toContain(`${label} <strong>${count}</strong>`)
    }
    expect(html).toContain('每页 50 条')
    expect(html).toContain('2 条结果待核对，不会自动重发。')
    expect(html).toContain('不重复发送，也不阻塞其余待发')
    expect(html).toContain('好友发送状态')
  })

  it('supports English without document-language globals, including the fractional interval', () => {
    const html = render(React.createElement(HistoryPanel, { snapshot: snapshot(), runAction }), 'en')
    expect(html).toContain('Saved task list')
    expect(html).toContain('All locally saved tasks, 25 per page')
    expect(html).toContain('Interval 0.1 sec')
    expect(html).toContain('<dt>Finished</dt><dd>Not yet</dd>')
    expect(html).toContain('2 uncertain results will NOT be automatically retried.')
    expect(html).toContain('Verify and resume remaining pending')
    expect(html).toContain('50 per page')
    expect(html).not.toContain('尚未')
  })

  it('keeps records available offline but disables resuming pending recipients', () => {
    const state = snapshot()
    state.accounts[0]!.sessionState = 'offline'
    const html = render(React.createElement(HistoryPanel, { snapshot: state, runAction }))
    expect(html).toContain('账号未登录：可查看保存记录')
    expect(html).toMatch(/<button class="primary" disabled="">核对并继续其余待发/)
    expect(html).toContain('Saved hello {friend}')
    expect(html).toContain('<button class="danger-text">取消任务</button>')
  })

  it('shows pause for a running task and no resume for a task without pending recipients', () => {
    const running = render(React.createElement(TaskDetails, {
      batch: batch({ status: 'running' }), accountName: 'Sender', authenticated: true, runAction
    }))
    expect(running).toContain('<button>暂停任务</button>')
    expect(running).not.toContain('继续其余待发')
    const noPending = render(React.createElement(TaskDetails, {
      batch: batch({ pending: 0 }), accountName: 'Sender', authenticated: true, runAction
    }))
    expect(noPending).toMatch(/<button class="primary">仅核对待核对记录/)
    expect(noPending).not.toContain('>核对并继续其余待发</button>')
  })

  it('does not borrow another account\'s task summary', () => {
    const state = snapshot([batch({ accountId: '76561198000000002', messageTemplate: 'OTHER_ACCOUNT_MESSAGE' })])
    const html = render(React.createElement(HistoryPanel, { snapshot: state, runAction }))
    expect(html).not.toContain('OTHER_ACCOUNT_MESSAGE')
    expect(html).toContain('还没有发送任务')
  })

  it('puts the affected friend and delivery result ahead of historical HTTP errors and initially filters uncertain rows', () => {
    const recipient = { deliveryId: 'review-recipient', friendSteamId: '76561198000000002', friendName: 'Review Friend',
      ordinal: 465, status: 'uncertain' as const, recordedAt: timestamp, remoteCommentId: null }
    const value = batch({ sending: 0, uncertain: 1, stopCode: 'UNCERTAIN_RESULT', accessDeniedCount: 7,
      accessDeniedUntil: new Date(Date.now() - 1000).toISOString(), nextRetryAt: null,
      activity: { current: null, lastProcessed: recipient, lastConfirmed: null,
        nextPending: { ...recipient, deliveryId: 'next-recipient', friendName: 'Next Friend', ordinal: 466, status: 'pending', recordedAt: null },
        recent: [recipient] } })
    const html = render(React.createElement(TaskDetails, { batch: value, accountName: 'Sender', authenticated: true, runAction }))
    expect(html).toContain('Review Friend')
    expect(html).toContain('Next Friend')
    expect(html).toContain('无法确认是否发出，不会自动重发')
    expect(html).toContain('本任务无在途发送')
    expect(html).toContain('<option value="uncertain" selected="">')
    expect(html.indexOf('逐好友发送进度')).toBeLessThan(html.indexOf('停止原因与自动重试'))
    expect(html).toMatch(/<button class="primary">核对并继续其余待发/)
    expect(html).not.toContain('<button class="primary" disabled="">冷却中')
  })

  it('initially bounds seeded history rendering to 25 rows, never hydrating all deliveries', () => {
    const state = snapshot(Array.from({ length: 100 }, (_, index) => batch({ id: `task-${index}` })))
    const html = render(React.createElement(HistoryPanel, { snapshot: state, runAction }))
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(25)
    expect(html).not.toContain('delivery-row')
  })

  it('pages through all 71 saved tasks rather than stopping at the latest 20', () => {
    const html = render(React.createElement(TaskPagination, {
      page: { total: 71, offset: 25, limit: 25 }, loaded: true, loading: false, onChange: () => undefined
    }))
    expect(html).toContain('第 2 页')
    expect(html).toContain('共 71 条')
    expect(html).toContain('<button>上一页</button>')
    expect(html).toContain('<button>下一页</button>')
  })

  it('disables Next on the final page and while fetching', () => {
    const final = render(React.createElement(TaskPagination, {
      page: { total: 1005, offset: 1000, limit: 50 }, loaded: true, loading: false, onChange: () => undefined
    }), 'en')
    expect(final).toContain('<button disabled="">Next</button>')
    const loading = render(React.createElement(TaskPagination, {
      page: { total: 1005, offset: 0, limit: 50 }, loaded: false, loading: true, onChange: () => undefined
    }))
    expect(loading).toContain('读取总数中')
    expect(loading).toContain('<button disabled="">下一页</button>')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function callbacks<T>(load: () => Promise<T>) {
  return { load, start: vi.fn(), success: vi.fn(), failure: vi.fn(), finish: vi.fn() }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('bounded task page request coordination', () => {
  it('merges 1000 progress refreshes into one trailing request with a single active load', async () => {
    const pages = new TaskPageRequests<number>()
    const first = deferred<number>()
    const a = callbacks(() => first.promise)
    pages.request('account:task:0:all', a)
    const latest = callbacks(async () => 1001)
    for (let i = 0; i < 1000; i++) pages.request('account:task:0:all', latest)
    expect(a.start).toHaveBeenCalledTimes(1)
    expect(latest.start).not.toHaveBeenCalled()
    first.resolve(1)
    await flush()
    expect(a.success).toHaveBeenCalledWith(1)
    expect(latest.start).toHaveBeenCalledTimes(1)
    expect(latest.success).toHaveBeenCalledWith(1001)
  })

  it.each(['account-b:task:0:all', 'account-a:other-task:0:all', 'account-a:task:50:uncertain'])
  ('discards an old response after switching to %s', async (nextKey) => {
    const pages = new TaskPageRequests<number>()
    const old = deferred<number>()
    const a = callbacks(() => old.promise)
    const b = callbacks(async () => 2)
    pages.request('account-a:task:0:all', a)
    pages.request(nextKey, b)
    old.resolve(1)
    await flush()
    expect(a.success).not.toHaveBeenCalled()
    expect(a.finish).not.toHaveBeenCalled()
    expect(b.success).toHaveBeenCalledWith(2)
  })

  it('invalidates a response immediately when the rendered query changes, before its next effect', async () => {
    const pages = new TaskPageRequests<number>()
    const old = deferred<number>()
    const a = callbacks(() => old.promise)
    pages.request('first-page', a)
    pages.setKey('second-page')
    old.resolve(1)
    await flush()
    expect(a.success).not.toHaveBeenCalled()
  })

  it('does not revive an old A response after switching from A to B and back to A', async () => {
    const pages = new TaskPageRequests<number>()
    const old = deferred<number>()
    const a = callbacks(() => old.promise)
    const b = callbacks(async () => 2)
    const newA = callbacks(async () => 3)
    pages.request('A', a)
    pages.request('B', b)
    pages.request('A', newA)
    old.resolve(1)
    await flush()
    expect(a.success).not.toHaveBeenCalled()
    expect(b.start).not.toHaveBeenCalled()
    expect(newA.success).toHaveBeenCalledWith(3)
  })

  it('reports an error and allows an explicit retry without keeping rejected promises', async () => {
    const pages = new TaskPageRequests<number>()
    const first = deferred<number>()
    const failed = callbacks(() => first.promise)
    pages.request('page', failed)
    const error = new Error('Local records unavailable')
    first.reject(error)
    await flush()
    expect(failed.failure).toHaveBeenCalledWith(error)
    expect(failed.finish).toHaveBeenCalledTimes(1)
    const retry = callbacks(async () => 7)
    pages.request('page', retry)
    await flush()
    expect(retry.success).toHaveBeenCalledWith(7)
  })

  it('drops in-flight and trailing callbacks after unmount, and can reactivate for StrictMode', async () => {
    const pages = new TaskPageRequests<number>()
    const first = deferred<number>()
    const a = callbacks(() => first.promise)
    const b = callbacks(async () => 2)
    pages.request('page', a)
    pages.request('page', b)
    pages.dispose()
    first.resolve(1)
    await flush()
    expect(a.success).not.toHaveBeenCalled()
    expect(a.finish).not.toHaveBeenCalled()
    expect(b.start).not.toHaveBeenCalled()
    pages.activate()
    const revived = callbacks(async () => 3)
    pages.request('page', revived)
    await flush()
    expect(revived.success).toHaveBeenCalledWith(3)
  })
})
