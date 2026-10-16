import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, BatchSummary, SteamFriendCommenterApi } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { I18nProvider } from '../src/renderer/src/i18n'
import {
  BatchRecoveryPanel, enableBatchRetryAndResume, retryCountdown
} from '../src/renderer/src/components/BatchRecoveryPanel'
import { ComposerPanel } from '../src/renderer/src/components/ComposerPanel'
import { TaskDetails } from '../src/renderer/src/components/HistoryPanel'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const accountId = '76561198000000001'
const timestamp = '2026-10-16T02:00:00.000Z'
const runAction = async () => null

function batch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'task-12345678', accountId, messageTemplate: 'Hello', delayMs: 5000, status: 'paused',
    total: 994, completed: 436, succeeded: 399, failed: 37, createdAt: timestamp, startedAt: timestamp,
    finishedAt: null, pending: 558, sending: 0, sentVerified: 399, acceptedUnverified: 0,
    failedCount: 37, uncertain: 0, cancelled: 0, autoRetryEnabled: false,
    stopCode: 'LEGACY_PAUSED', stopMessage: null, pausedAt: timestamp, nextRetryAt: null, retryCount: 0,
    ...overrides
  }
}

function render(value: BatchSummary, language: 'zh-CN' | 'en' = 'zh-CN', authenticated = true): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language, children: React.createElement(BatchRecoveryPanel, { batch: value, authenticated, runAction })
  }))
}

function snapshot(task: BatchSummary | null): AppSnapshot {
  return {
    accounts: [{
      id: accountId, steamId: accountId, accountName: 'Sender', displayName: 'Sender', avatarUrl: '',
      createdAt: timestamp, lastLoginAt: timestamp, lastFriendSyncAt: timestamp, lastEmoticonSyncAt: null,
      sessionState: 'authenticated', sessionMessage: null
    }],
    activeAccountId: accountId, friends: [], friendRemovals: [], friendNameChanges: [], groups: [],
    emoticons: [], friendPolicies: [], settings: null, batches: task ? [task] : [], activeBatch: task, commentScan: null,
    dataDirectory: '', language: 'zh-CN', updater: initialUpdateState('0.7.1', 'setup'),
    updatePreferences: DEFAULT_UPDATE_PREFERENCES, security: { secretStorageAvailable: true, secretStorageBackend: 'test' }
  }
}

describe('persistent batch stop reasons and recovery UI', () => {
  it('identifies legacy unknown causes honestly and requires explicit authorization to enable retries', () => {
    const html = render(batch())
    expect(html).toContain('旧版本任务未保存停止原因')
    expect(html).toContain('自动重试已关闭，不会自动继续')
    expect(html).toContain('开启自动重试并继续待发')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('距离自动继续')
    expect(html).toContain('已发送、已接受和结果不确定的对象不会自动重发')
  })

  it('shows source, persisted timestamp, next deadline, and the scheduled attempt without claiming completion', () => {
    const html = render(batch({
      autoRetryEnabled: true, stopCode: 'RATE_LIMITED', stopMessage: 'HTTP 429 / Retry-After',
      nextRetryAt: '2026-10-16T02:02:00.000Z', retryCount: 2
    }))
    expect(html).toContain('Steam 频率限制')
    expect(html).toContain('来源: Steam 响应')
    expect(html).toContain('HTTP 429 / Retry-After')
    expect(html).toContain('下次重试:')
    expect(html).toContain('第 2 / 5 次自动重试（待执行）')
    expect(html).toContain('停止自动重试')
    expect(html).toContain('aria-live="off"')
    expect(html).not.toContain('已重试 2')
  })

  it('does not promise automatic continuation after a manual pause or an app restart', () => {
    for (const stopCode of ['MANUAL_PAUSE', 'APP_RESTARTED'] as const) {
      const html = render(batch({ autoRetryEnabled: true, stopCode }))
      expect(html).toContain('当前没有自动继续计划，请手动继续待发')
      expect(html).not.toContain('距离自动继续')
      expect(html).not.toContain('停止自动重试</button>')
    }
  })

  it('distinguishes sign-in and exhausted retries instead of suggesting an endless retry loop', () => {
    const signIn = render(batch({ autoRetryEnabled: true, stopCode: 'LOGIN_REQUIRED' }))
    expect(signIn).toContain('需要重新登录此账号，再手动继续原任务')
    expect(signIn).toContain('不会自动扫码')
    const exhausted = render(batch({ autoRetryEnabled: true, stopCode: 'RETRY_EXHAUSTED', retryCount: 5 }))
    expect(exhausted).toContain('已达到自动重试上限')
    expect(exhausted).toContain('第 5 / 5 次自动重试（最近记录）')
    expect(exhausted).not.toContain('距离自动继续')
  })

  it('retains the last cause after resuming, while explaining that an uncertain recipient is skipped', () => {
    const html = render(batch({ status: 'running', autoRetryEnabled: true, stopCode: 'UNCERTAIN_RESULT', retryCount: 1 }))
    expect(html).toContain('最近停止原因')
    expect(html).toContain('本条发送结果不确定')
    expect(html).toContain('结果不确定的对象不会自动重发')
    expect(html).toContain('临时错误后退避重试剩余待发')
  })

  it('keeps an offline task editable but disables authorizing and resuming it', () => {
    const html = render(batch(), 'zh-CN', false)
    expect(html).toMatch(/<input type="checkbox"\/>/)
    expect(html).toMatch(/<button class="ghost batch-enable-retry" disabled="">开启自动重试并继续待发/)
  })

  it('renders both workflows in English, safely escapes detail text, and preserves its reason code', () => {
    const html = render(batch({ stopCode: 'ACCESS_DENIED', stopMessage: '<img src=x onerror=bad>' }), 'en')
    expect(html).toContain('Steam denied access (HTTP 403)')
    expect(html).toContain('Source: Steam response')
    expect(html).toContain('Enable retries and resume pending')
    expect(html).toContain('&lt;img src=x onerror=bad&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('自动')
  })

  it.each(['zh-CN', 'en'] as const)('shows the independent 403 response count and one-retry policy in %s', language => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'ACCESS_DENIED', retryCount: 4,
      accessDeniedCount: 1, accessDeniedUntil: '2030-10-16T02:05:00.000Z', nextRetryAt: '2030-10-16T02:05:00.000Z' }), language)
    expect(html).toContain(language === 'en' ? 'Consecutive HTTP 403 responses in this incident: 1' : '本轮连续 HTTP 403 响应：1 次')
    expect(html).toContain(language === 'en' ? 'only 1 automatic retry after cooldown' : '冷却后自动重试 1 次')
    expect(html).toContain(language === 'en' ? 'Earliest retry time' : '最早可再试时间')
    expect(html).toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    expect(html).not.toContain(language === 'en' ? 'Automatic retry 4 / 5' : '第 4 / 5 次自动重试')
    expect(html).not.toContain(language === 'en' ? 'temporarily denied access' : '暂时拒绝访问')
  })

  it.each(['zh-CN', 'en'] as const)('stops promising an automatic resume for persistent 403 in %s', language => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'ACCESS_DENIED_PERSISTENT', retryCount: 1,
      accessDeniedCount: 2, accessDeniedUntil: '2030-10-16T02:05:00.000Z', nextRetryAt: '2030-10-16T02:05:00.000Z' }), language)
    expect(html).toContain(language === 'en' ? 'Steam repeatedly denied access (HTTP 403)' : 'Steam 持续拒绝访问（HTTP 403）')
    expect(html).toContain(language === 'en' ? 'a friend permission problem has not been established' : '未判定为好友权限问题')
    expect(html).toContain(language === 'en' ? 'The current and remaining recipients stay pending' : '当前对象和剩余对象仍待发')
    expect(html).toContain(language === 'en' ? 'does not prove sign-in expired' : '不能单独证明登录失效')
    expect(html).toContain(language === 'en' ? 'you can resume manually' : '冷却结束后可手动继续')
    expect(html).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    expect(html).not.toContain(language === 'en' ? 'Pending deliveries will resume automatically' : '已安排自动继续剩余待发')
    expect(html).not.toContain(language === 'en' ? 'Automatic retry 1 / 5' : '第 1 / 5 次自动重试')
  })

  it.each(['ACCESS_DENIED', 'APP_RESTARTED'] as const)('retains the earliest retry time with automatic retries off after %s', stopCode => {
    const html = render(batch({ autoRetryEnabled: false, stopCode, accessDeniedCount: 1,
      accessDeniedUntil: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('最早可再试时间:')
    expect(html).toContain('关闭自动重试或重启不会清除冷却')
    expect(html).not.toContain('距离自动继续')
    expect(html).toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
  })

  it('retains the persistent denial warning across a restart without promising a fresh retry budget', () => {
    const html = render(batch({ autoRetryEnabled: false, stopCode: 'APP_RESTARTED', accessDeniedCount: 2,
      accessDeniedUntil: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('软件重启后保护性暂停')
    expect(html).toContain('连续收到 HTTP 403，已停止自动继续')
    expect(html).toContain('请勿反复扫码或连续点击继续')
    expect(html).not.toContain('开启自动重试并继续待发')
  })

  it('still explains a separately confirmed login expiry when a prior 403 record remains', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'LOGIN_REQUIRED', accessDeniedCount: 2 }))
    expect(html).toContain('需要重新登录此账号，再手动继续原任务')
    expect(html).not.toContain('距离自动继续')
  })

  it('keeps ordinary retry counts visible for a diagnostic network failure without erasing the separate 403 count', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'NETWORK_ERROR', retryCount: 3,
      accessDeniedCount: 1, nextRetryAt: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('本轮连续 HTTP 403 响应：1 次')
    expect(html).toContain('第 3 / 5 次自动重试（待执行）')
  })

  it('does not block explicit recovery after a completed cooldown or invent a malformed deadline', () => {
    for (const accessDeniedUntil of ['2000-01-01T00:00:00.000Z', 'invalid']) {
      const html = render(batch({ stopCode: 'ACCESS_DENIED', accessDeniedCount: 1, accessDeniedUntil }))
      expect(html).toContain('开启自动重试并继续待发')
      expect(html).not.toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
      expect(html).not.toContain('Invalid Date')
      if (accessDeniedUntil === 'invalid') expect(html).not.toContain('最早可再试时间')
    }
  })

  it('removes retry controls for finished tasks, but retains the saved stop reason', () => {
    const html = render(batch({ status: 'cancelled', stopCode: 'CANCELLED', nextRetryAt: null }))
    expect(html).toContain('用户取消任务')
    expect(html).toContain('任务已结束，不再自动重试')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('开启自动重试并继续待发')
  })

  it('places the cause above task action controls in the persistent task detail view', () => {
    const html = renderToStaticMarkup(React.createElement(I18nProvider, {
      language: 'zh-CN', children: React.createElement(TaskDetails, {
        batch: batch({ stopCode: 'SESSION_EXPIRED' }), accountName: 'Sender', authenticated: true, runAction
      })
    }))
    expect(html.indexOf('Steam 网页会话失效')).toBeLessThan(html.indexOf('继续待发</button>'))
  })

  it('enables new task retries by default, and shows recovery information in the composer aside', () => {
    const html = renderToStaticMarkup(React.createElement(I18nProvider, {
      language: 'zh-CN', children: React.createElement(ComposerPanel, {
        snapshot: snapshot(batch({ stopCode: 'NETWORK_ERROR' })), selected: new Set<string>(),
        onSelectedChange: () => undefined, onOpenFriends: () => undefined, runAction
      })
    }))
    expect(html).toMatch(/class="composer-auto-retry"><input type="checkbox" checked=""/)
    expect(html).toContain('临时错误后自动重试并继续待发')
    expect(html).toContain('网络请求暂时失败')
  })

  it('does not display another account’s task in the composer recovery controls', () => {
    const html = renderToStaticMarkup(React.createElement(I18nProvider, {
      language: 'zh-CN', children: React.createElement(ComposerPanel, {
        snapshot: snapshot(batch({ accountId: '76561198000000099', stopMessage: 'OTHER_ACCOUNT_REASON' })),
        selected: new Set<string>(), onSelectedChange: () => undefined, onOpenFriends: () => undefined, runAction
      })
    }))
    expect(html).not.toContain('OTHER_ACCOUNT_REASON')
    expect(html).not.toContain('当前批次')
  })
})

describe('retry countdown is local-only and bounded at zero', () => {
  it('rounds remaining fractional seconds up and formats a stable mm:ss countdown', () => {
    expect(retryCountdown('2026-10-16T02:02:00.000Z', Date.parse('2026-10-16T02:00:29.100Z'))).toBe('01:31')
    expect(retryCountdown(timestamp, Date.parse(timestamp) + 1000)).toBe('00:00')
    expect(retryCountdown('invalid', 0)).toBe('-')
  })
})

describe('explicit legacy task authorization', () => {
  function api(): Pick<SteamFriendCommenterApi, 'setBatchAutoRetry' | 'resumeBatch'> {
    return {
      setBatchAutoRetry: vi.fn(async () => ({ ok: true as const, data: undefined })),
      resumeBatch: vi.fn(async () => ({ ok: true as const, data: undefined }))
    }
  }

  it('persists enabling retries before resuming the existing task', async () => {
    const service = api()
    await enableBatchRetryAndResume(service, 'saved-task')
    expect(service.setBatchAutoRetry).toHaveBeenCalledWith('saved-task', true)
    expect(service.resumeBatch).toHaveBeenCalledWith('saved-task')
    expect(vi.mocked(service.setBatchAutoRetry).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(service.resumeBatch).mock.invocationCallOrder[0]!)
  })

  it('never resumes if the preference could not be saved', async () => {
    const service = api()
    vi.mocked(service.setBatchAutoRetry).mockResolvedValue({ ok: false, error: { code: 'FAILED', message: 'Save failed' } })
    await expect(enableBatchRetryAndResume(service, 'saved-task')).rejects.toThrow('Save failed')
    expect(service.resumeBatch).not.toHaveBeenCalled()
  })

  it('does not resume after an account switch or unmount while saving', async () => {
    const service = api()
    let current = true
    vi.mocked(service.setBatchAutoRetry).mockImplementation(async () => {
      current = false
      return { ok: true, data: undefined }
    })
    await enableBatchRetryAndResume(service, 'saved-task', () => current)
    expect(service.resumeBatch).not.toHaveBeenCalled()
  })

  it('never calls either IPC once authorization is stale', async () => {
    const service = api()
    await enableBatchRetryAndResume(service, 'saved-task', () => false)
    expect(service.setBatchAutoRetry).not.toHaveBeenCalled()
    expect(service.resumeBatch).not.toHaveBeenCalled()
  })
})
