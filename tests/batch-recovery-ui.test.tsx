import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, BatchSummary, SteamFriendCommenterApi } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import { COMMENT_POST_UNCERTAIN_MESSAGE, LEGACY_COMMENT_POST_REVIEW_MESSAGE } from '../src/shared/batch-retry-policy'
import { I18nProvider } from '../src/renderer/src/i18n'
import {
  BatchRecoveryPanel, batchCooldownActive, enableBatchRetryAndResume, retryCountdown
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

function visibleRecovery(html: string): string {
  return html.replace(/<details class="batch-recovery-history">[\s\S]*?<\/details>/g, '')
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
  it.each(['zh-CN', 'en'] as const)('shows a pre-send baseline failure without claiming a session problem in %s', language => {
    const html = render(batch({ stopCode: 'COMMENT_BASELINE', stopMessage: 'Fixture recipient (SteamID: 76561198000000101): no POST',
      autoRetryEnabled: false, accessDeniedCount: 6 }), language)
    const visible = visibleRecovery(html)
    expect(visible).toContain(language === 'en' ? 'Comment baseline could not be read; not sent' : '评论基线读取失败，尚未发送')
    expect(visible).toContain(language === 'en' ? 'Read-only pre-send check' : '发送前只读检查')
    expect(visible).toContain('Fixture recipient (SteamID: 76561198000000101): no POST')
    expect(visible).not.toContain(language === 'en' ? 'Steam session is not ready' : 'Steam 会话尚未准备完成')
    expect(visible).not.toContain(language === 'en' ? 'Steam repeatedly denied access' : 'Steam 持续拒绝访问')
    expect(visible).toContain(language === 'en' ? 'Automatic retries are off' : '自动重试已关闭')
    expect(visible).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
  })

  it.each(['zh-CN', 'en'] as const)
  ('prioritizes unresolved POST safety over stale 403 counters and deadlines in %s', language => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'UNCERTAIN_RESULT', uncertain: 1,
      stopMessage: COMMENT_POST_UNCERTAIN_MESSAGE,
      accessDeniedCount: 6, accessDeniedUntil: '2030-10-16T02:05:00.000Z', nextRetryAt: '2030-10-16T02:05:00.000Z' }), language)
    expect(html).toContain(language === 'en' ? 'Delivery result needs review' : '需核对送达结果')
    expect(html).toContain(language === 'en' ? 'Other pending recipients must still wait for the cooldown below' : '其余待发仍需等待下方冷却结束')
    expect(html).toContain(language === 'en' ? 'may already have received the comment' : '可能已经送达')
    expect(html).toContain(language === 'en' ? 'without blocking other pending recipients' : '也不阻塞其余待发')
    expect(html).toContain(language === 'en' ? 'never resent' : '不重复发送')
    expect(html).not.toContain(language === 'en' ? 'The current and remaining recipients stay pending' : '当前对象和剩余对象仍待发')
    expect(html).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    expect(html).not.toContain(language === 'en' ? 'only 1 automatic retry after cooldown' : '冷却后自动重试 1 次')
  })

  it.each(['zh-CN', 'en'] as const)('retains legacy recipient-review safety after restart in %s', language => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'APP_RESTARTED', uncertain: 1,
      stopMessage: `应用已重启，任务保持暂停，请手动继续。上次停止：${LEGACY_COMMENT_POST_REVIEW_MESSAGE}`,
      accessDeniedCount: 6, accessDeniedUntil: '2030-10-16T02:05:00.000Z' }), language)
    expect(html).toContain(language === 'en' ? 'This recipient needs review' : '本对象已列入待核对')
    expect(html).toContain(language === 'en' ? 'Earliest resume time' : '最早可继续时间')
    expect(html).not.toContain(language === 'en' ? 'The current and remaining recipients stay pending' : '当前对象和剩余对象仍待发')
    expect(html).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    if (language === 'en') expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not hide a real scheduled recovery for an unrelated malformed response', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'UNCERTAIN_RESULT', uncertain: 1,
      stopMessage: 'Steam returned invalid JSON', nextRetryAt: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('已安排自动继续剩余待发')
    expect(html).toContain('距离自动继续')
    expect(html).not.toContain('也不会自动发送下一位')
  })

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
    expect(html).toContain(language === 'en' ? 'Recorded HTTP 403 responses: 1 (historical count)' : '已记录 HTTP 403 响应：1 次（历史计数）')
    expect(html).toContain(language === 'en' ? 'only 1 automatic retry after cooldown' : '冷却后自动重试 1 次')
    expect(html).toContain(language === 'en' ? 'Earliest resume time' : '最早可继续时间')
    expect(html).toContain(language === 'en' ? 'Cooldown remaining' : '距离冷却结束')
    expect(html).toContain('<details class="batch-recovery-history">')
    expect(visibleRecovery(html)).not.toContain(language === 'en' ? 'historical count' : '历史计数')
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
    expect(html).toContain(language === 'en' ? 'proves neither expired sign-in nor failed delivery' : '不能单独证明登录失效')
    expect(html).toContain(language === 'en' ? 'No automatic resume is scheduled' : '当前没有自动继续计划')
    expect(html).toContain(language === 'en' ? 'Cooldown remaining' : '距离冷却结束')
    expect(html).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    expect(html).not.toContain(language === 'en' ? 'Pending deliveries will resume automatically' : '已安排自动继续剩余待发')
    expect(html).not.toContain(language === 'en' ? 'Automatic retry 1 / 5' : '第 1 / 5 次自动重试')
  })

  it.each(['ACCESS_DENIED', 'APP_RESTARTED'] as const)('retains the earliest retry time with automatic retries off after %s', stopCode => {
    const html = render(batch({ autoRetryEnabled: false, stopCode, accessDeniedCount: 1,
      accessDeniedUntil: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('最早可继续时间:')
    expect(html).toContain('关闭自动重试或重启不会清除冷却')
    expect(html).not.toContain('距离自动继续')
    expect(html).toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
  })

  it('preserves the restart as the current reason and moves old denial counts to collapsed history', () => {
    const html = render(batch({ autoRetryEnabled: false, stopCode: 'APP_RESTARTED', accessDeniedCount: 2,
      accessDeniedUntil: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('软件重启后保护性暂停')
    expect(html).toContain('已记录 HTTP 403 响应：2 次（历史计数）')
    expect(visibleRecovery(html)).not.toContain('连续收到 HTTP 403，已停止自动继续')
    expect(visibleRecovery(html)).not.toContain('HTTP 403')
    expect(html).toContain('当前没有自动继续计划')
    expect(html).toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
  })

  it('still explains a separately confirmed login expiry when a prior 403 record remains', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'LOGIN_REQUIRED', accessDeniedCount: 2 }))
    expect(html).toContain('需要重新登录此账号，再手动继续原任务')
    expect(html).not.toContain('距离自动继续')
  })

  it('keeps ordinary retry counts visible for a diagnostic network failure without erasing the separate 403 count', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'NETWORK_ERROR', retryCount: 3,
      accessDeniedCount: 1, nextRetryAt: '2030-10-16T02:05:00.000Z' }))
    expect(html).toContain('已记录 HTTP 403 响应：1 次（历史计数）')
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

  it.each(['zh-CN', 'en'] as const)('shows the live unresolved state instead of an expired cooldown in %s', language => {
    const html = render(batch({ stopCode: 'UNCERTAIN_RESULT', stopMessage: COMMENT_POST_UNCERTAIN_MESSAGE,
      uncertain: 1, autoRetryEnabled: true, nextRetryAt: null,
      accessDeniedCount: 7, accessDeniedUntil: '2000-01-01T00:00:00.000Z' }), language)
    const current = visibleRecovery(html)
    expect(current).toContain(language === 'en' ? 'Delivery result needs review' : '需核对送达结果')
    expect(current).toContain(language === 'en' ? 'This is not a wait for cooldown' : '这不是仍在等待冷却')
    expect(current).toContain(language === 'en' ? 'No automatic resume is scheduled' : '当前没有自动继续计划')
    expect(current).toContain(language === 'en' ? 'a retry preference, not a scheduled resume' : '仅设置重试策略，不代表已安排继续')
    expect(current).not.toContain('HTTP 403')
    expect(current).not.toContain(language === 'en' ? 'Cooldown remaining' : '距离冷却结束')
    expect(current).not.toContain(language === 'en' ? 'Automatic resume in' : '距离自动继续')
    expect(html).toContain(language === 'en' ? 'Previous cooldown has ended' : '上次冷却已结束')
    expect(html).toContain(language === 'en' ? 'Recorded HTTP 403 responses: 7' : '已记录 HTTP 403 响应：7 次')
    expect(html).toContain('<details class="batch-recovery-history">')
    expect(html).not.toContain('<details class="batch-recovery-history" open')
    if (language === 'en') expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it.each(['MANUAL_PAUSE', 'APP_RESTARTED', 'NETWORK_ERROR'] as const)
  ('does not let historical repeated denials replace the current %s reason or block manual recovery', stopCode => {
    const html = render(batch({ stopCode, autoRetryEnabled: false, accessDeniedCount: 7,
      accessDeniedUntil: '2000-01-01T00:00:00.000Z', stopMessage: '上次停止：HTTP 403' }))
    const current = visibleRecovery(html)
    expect(current).not.toContain('HTTP 403')
    expect(current).not.toContain('连续收到')
    expect(current).not.toContain('距离冷却结束')
    expect(current).toContain('当前没有自动继续计划')
    expect(current).toContain('开启自动重试并继续待发')
    expect(current).not.toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
    expect(html).toContain('保存的停止信息: 上次停止：HTTP 403')
  })

  it('keeps a current GET denial visible without claiming that it has been delivered', () => {
    const html = render(batch({ stopCode: 'ACCESS_DENIED_PERSISTENT', accessDeniedCount: 7,
      accessDeniedUntil: '2000-01-01T00:00:00.000Z', stopMessage: 'HTTP 403', autoRetryEnabled: false }))
    const current = visibleRecovery(html)
    expect(current).toContain('Steam 持续拒绝访问（HTTP 403）')
    expect(current).toContain('当前对象和剩余对象仍待发')
    expect(current).toContain('当前没有自动继续计划')
    expect(current).not.toContain('需核对送达结果')
    expect(current).not.toContain('距离冷却结束')
    expect(current).toContain('开启自动重试并继续待发')
    expect(current).not.toMatch(/<button class="ghost batch-enable-retry" disabled="">/)
  })

  it('keeps past HTTP errors collapsed while normal sending has resumed', () => {
    const html = render(batch({ status: 'running', stopCode: 'ACCESS_DENIED_PERSISTENT', accessDeniedCount: 7,
      accessDeniedUntil: '2000-01-01T00:00:00.000Z', stopMessage: 'HTTP 403', autoRetryEnabled: true }))
    expect(visibleRecovery(html)).not.toContain('HTTP 403')
    expect(visibleRecovery(html)).toContain('临时错误后退避重试剩余待发')
    expect(html).toContain('最近停止原因: Steam 持续拒绝访问（HTTP 403）')
  })

  it('uses the actual future cooldown deadline for a precise countdown without an automatic plan', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T02:00:29.100Z'))
    try {
      const html = render(batch({ stopCode: 'UNCERTAIN_RESULT', uncertain: 1,
        stopMessage: COMMENT_POST_UNCERTAIN_MESSAGE, autoRetryEnabled: true, accessDeniedCount: 7,
        accessDeniedUntil: '2026-10-16T02:02:00.000Z', nextRetryAt: null }))
      expect(html).toContain('距离冷却结束: 01:31')
      expect(html).toContain('其余待发仍有冷却限制')
      expect(html).toContain('当前没有自动继续计划')
      expect(html).not.toContain('距离自动继续')
    } finally {
      clock.mockRestore()
    }
  })

  it('ignores malformed automatic deadlines rather than promising a retry', () => {
    const html = render(batch({ autoRetryEnabled: true, stopCode: 'NETWORK_ERROR', nextRetryAt: 'invalid' }))
    expect(html).toContain('当前没有自动继续计划')
    expect(html).not.toContain('距离自动继续')
    expect(html).not.toContain('Invalid Date')
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

  it.each(['queued', 'running', 'paused'] as const)('retains only a valid future cooldown for %s', status => {
    const now = Date.parse(timestamp)
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: '2026-10-16T02:00:01.000Z' }), now)).toBe(true)
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: timestamp }), now)).toBe(false)
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: '2000-01-01T00:00:00.000Z' }), now)).toBe(false)
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: 'invalid' }), now)).toBe(false)
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: null }), now)).toBe(false)
  })

  it.each(['completed', 'cancelled'] as const)('does not show a sending cooldown on a %s task', status => {
    expect(batchCooldownActive(batch({ status, accessDeniedUntil: '2030-10-16T02:05:00.000Z' }), Date.parse(timestamp))).toBe(false)
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
