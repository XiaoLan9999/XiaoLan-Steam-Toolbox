import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { BatchActivity, BatchRecipientActivity, BatchSummary, DeliveryStatus } from '../src/shared/types'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import { BatchActivityPanel } from '../src/renderer/src/components/BatchActivityPanel'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const batch: BatchSummary = {
  id: 'synthetic-batch', accountId: '76561198000000001', messageTemplate: 'synthetic-message',
  delayMs: 1000, status: 'paused', total: 1000, completed: 11, succeeded: 10, failed: 1,
  createdAt: '2026-10-18T00:00:00.000Z', startedAt: '2026-10-18T00:01:00.000Z', finishedAt: null,
  autoRetryEnabled: false, stopCode: 'UNCERTAIN_RESULT', stopMessage: 'synthetic-stop-message',
  pausedAt: '2026-10-18T00:02:00.000Z', nextRetryAt: null, retryCount: 0,
  accessDeniedCount: 6, accessDeniedUntil: '2026-10-17T00:00:00.000Z',
  pending: 988, sending: 0, sentVerified: 10, acceptedUnverified: 0, failedCount: 1, uncertain: 1, cancelled: 0
}

function recipient(status: DeliveryStatus = 'uncertain', ordinal = 12): BatchRecipientActivity {
  return {
    deliveryId: `synthetic-delivery-${ordinal}`, friendSteamId: `7656119800${String(ordinal).padStart(7, '0')}`,
    friendName: `Synthetic friend ${ordinal}`, ordinal, status,
    recordedAt: '2026-10-18T00:02:00.000Z', remoteCommentId: status === 'sent_verified' ? `synthetic-comment-${ordinal}` : null
  }
}

function activity(value: Partial<BatchActivity> = {}): BatchActivity {
  return { current: null, lastProcessed: null, lastConfirmed: null, nextPending: null, recent: [], ...value }
}

function render(value: Partial<BatchSummary> = {}, language: Language = 'zh-CN', compact = false): string {
  return renderToStaticMarkup(<I18nProvider language={language}><BatchActivityPanel batch={{ ...batch, ...value }} compact={compact} /></I18nProvider>)
}

function recentMarkup(html: string): string {
  return html.match(/<details class="batch-activity-recent"[^>]*>([\s\S]*?)<\/details>/)?.[1] ?? ''
}

describe('per-friend batch delivery activity', () => {
  it('does not infer delivery from aggregate counts or a historical 403 if activity is unavailable', () => {
    const html = render()
    expect(html).toContain('尚无逐好友状态，请刷新任务明细')
    expect(html).toContain('不能据此判断留言已经发出')
    expect(html).not.toContain('已确认送达')
    expect(html).not.toContain('本任务无在途发送')
    expect(html).not.toContain('SteamID:')
    expect(html).not.toContain('synthetic-stop-message')
  })

  it('clearly identifies a paused task without an in-flight recipient and never invents an active cooldown', () => {
    const html = render({ activity: activity() })
    expect(html).toContain('任务已暂停，本任务无在途发送')
    expect(html).not.toContain('正在冷却')
    expect(html).not.toContain('最早可再试时间')
    expect(html).not.toContain('2026-10-17')
    expect(html).not.toContain('倒计时')
  })

  it('marks current preparation/submission as processing rather than claiming it has been delivered', () => {
    const current = recipient('sending')
    const html = render({ status: 'running', sending: 1, activity: activity({ current }) })
    expect(html).toContain('当前处理好友')
    expect(html).toContain('Synthetic friend 12')
    expect(html).toContain(current.friendSteamId)
    expect(html).toContain('第 12 位')
    expect(html).toContain('正在处理（准备/提交中）')
    expect(html).toContain('正在处理不代表已发出')
    expect(html).not.toContain('本任务无在途发送')
    expect(html).not.toContain('result-sent_verified')
  })

  it('shows recent outcomes, the last confirmed comment, and the next unsent friend together', () => {
    const latest = recipient('uncertain', 12)
    const confirmed = recipient('sent_verified', 11)
    const pending = recipient('pending', 13)
    const html = render({ activity: activity({ lastProcessed: latest, lastConfirmed: confirmed, nextPending: pending,
      recent: [latest, confirmed] }) })
    expect(html).toContain('最近处理结果')
    expect(html).toContain('上次已确认送达')
    expect(html).toContain('Synthetic friend 11')
    expect(html).toContain('#synthetic-comment-11')
    expect(html).toContain('已确认送达')
    expect(html).toContain('Synthetic friend 12')
    expect(html).toContain('无法确认是否发出，不会自动重发')
    expect(html).toContain('Synthetic friend 13')
    expect(html).toContain('此对象尚未发送；这里只展示队列位置，不会触发发送')
    expect(html).toContain('<time dateTime="2026-10-18T00:02:00.000Z"')
    expect(html).toContain('HTTP 状态与冷却属于技术信息，不能单独证明留言是否发出')
    expect(html).not.toContain('HTTP 403')
  })

  it.each([
    ['pending', '尚未发送', 'Not sent yet'],
    ['sending', '正在处理（准备/提交中）', 'Processing (preparing/submitting)'],
    ['sent_verified', '已确认送达', 'Delivery confirmed'],
    ['accepted_unverified', 'Steam 已接受，尚未确认送达', 'Accepted by Steam; delivery not confirmed'],
    ['failed', '失败（任务记录）', 'Failed (task record)'],
    ['uncertain', '无法确认是否发出，不会自动重发', 'Delivery unknown; never retried automatically'],
    ['cancelled', '已取消', 'Cancelled']
  ] as const)('retains the exact outcome boundary for %s in both languages', (status, zh, en) => {
    const value = { activity: activity({ lastProcessed: recipient(status) }) }
    expect(render(value)).toContain(zh)
    const english = render(value, 'en')
    expect(english).toContain(en)
    expect(english).not.toMatch(/\p{Script=Han}/u)
  })

  it('distinguishes a verified result without a saved comment ID rather than fabricating an ID', () => {
    const lastConfirmed = { ...recipient('sent_verified'), remoteCommentId: null }
    const html = render({ activity: activity({ lastConfirmed }) })
    expect(html).toContain('已核验（未记录留言编号）')
    expect(html).toContain('留言编号: 未记录')
    expect(html).not.toContain('synthetic-comment-')
    expect(render({ activity: activity({ lastConfirmed }) }, 'en')).toContain('Verified (comment ID not recorded)')
  })

  it('does not turn a server acceptance into a confirmed delivery', () => {
    const html = render({ acceptedUnverified: 1, activity: activity({ lastProcessed: recipient('accepted_unverified') }) })
    expect(html).toContain('Steam 已接受，尚未确认送达')
    expect(html).not.toContain('result-sent_verified')
    expect(html).not.toContain('已确认送达</strong>')
  })

  it('caps recent records at five even if a future source supplies a larger list', () => {
    const recent = Array.from({ length: 30 }, (_, index) => recipient('sent_verified', 30 - index))
    const html = recentMarkup(render({ activity: activity({ recent }) }))
    expect(html.match(/<li>/g)).toHaveLength(5)
    expect(html).toContain('Synthetic friend 30')
    expect(html).toContain('Synthetic friend 26')
    expect(html).not.toContain('Synthetic friend 25')
    expect(html.indexOf('Synthetic friend 30')).toBeLessThan(html.indexOf('Synthetic friend 29'))
  })

  it.each([false, true])('keeps recent details collapsed by default in compact=%s while retaining five records in the DOM', compact => {
    const recent = Array.from({ length: 8 }, (_, index) => recipient('sent_verified', index + 1))
    const html = render({ activity: activity({ recent }) }, 'zh-CN', compact)
    expect(html).toContain('<details class="batch-activity-recent" aria-label="最近 5 条处理记录">')
    expect(html).toContain('<summary>最近处理记录（最多 5 条）</summary>')
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/)
    const recentHtml = recentMarkup(html)
    expect(recentHtml.match(/<li>/g)).toHaveLength(5)
    expect(recentHtml).toContain('Synthetic friend 5')
    expect(recentHtml).not.toContain('Synthetic friend 6')
  })

  it('compact mode keeps core identity and outcomes, compressing summary timestamps but retaining full expandable history', () => {
    const latest = recipient('uncertain', 12)
    const confirmed = recipient('sent_verified', 11)
    const next = recipient('pending', 13)
    const value = { activity: activity({ lastProcessed: latest, lastConfirmed: confirmed, nextPending: next,
      recent: [latest, confirmed] }) }
    const html = render(value, 'zh-CN', true)
    expect(html).toContain('class="batch-activity compact"')
    for (const item of [latest, confirmed, next]) {
      expect(html).toContain(item.friendName)
      expect(html).toContain(item.friendSteamId)
    }
    expect(html).toContain('#synthetic-comment-11')
    expect(html).toContain('无法确认是否发出，不会自动重发')
    expect(html).toContain('已确认送达')
    expect(html).toContain('尚未发送')
    const summaryHtml = html.split('<details class="batch-activity-recent"')[0]
    expect(summaryHtml).not.toContain('记录时间')
    expect(summaryHtml).not.toContain('<time')
    expect(summaryHtml).not.toContain('第 12 位')
    const recentHtml = recentMarkup(html)
    expect(recentHtml).toContain('记录时间')
    expect(recentHtml).toContain('<time')
    expect(recentHtml).toContain('第 12 位')
    const fullHtml = render(value)
    expect(fullHtml).toContain('记录时间')
    expect(fullHtml).toContain('第 12 位')
    expect(render(value, 'en', true)).not.toMatch(/\p{Script=Han}/u)
  })

  it('preserves full Steam IDs, ordinals beyond one thousand, and comment identifiers as text', () => {
    const value = { ...recipient('sent_verified', 1234), friendSteamId: '76561198000001234', remoteCommentId: '18446744073709551615' }
    const html = render({ activity: activity({ lastProcessed: value }) })
    expect(html).toContain('76561198000001234')
    expect(html).toContain('第 1234 位')
    expect(html).toContain('#18446744073709551615')
    expect(html).not.toContain('18446744073709552000')
  })

  it('escapes untrusted names and identifiers without creating links, images, forms, or scripts', () => {
    const value = { ...recipient(), friendName: '<img src=x onerror=alert(1)> https://synthetic.invalid',
      friendSteamId: '<script>synthetic-bad()</script>', remoteCommentId: '<a href="https://synthetic.invalid">bad</a>' }
    const html = render({ activity: activity({ lastProcessed: value, recent: [value] }) })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;synthetic-bad()&lt;/script&gt;')
    expect(html).toContain('&lt;a href=')
    expect(html).not.toMatch(/<(?:img|script|a|iframe|form)\b/)
  })

  it('uses honest fallbacks for blank names, invalid times, and missing comment IDs', () => {
    const value = { ...recipient(), friendName: '  ', recordedAt: 'synthetic-invalid-date', ordinal: -1 }
    const html = render({ activity: activity({ lastProcessed: value }) })
    expect(html).toContain('未记录好友名称')
    expect(html).toContain('记录时间: 未记录')
    expect(html).toContain('留言编号: 未记录')
    expect(html).not.toContain('<time')
    expect(html).not.toContain('第 -1 位')
    expect(html).not.toContain('Invalid Date')
    expect(render({ activity: activity({ lastProcessed: value }) }, 'en')).toContain('Friend name not recorded')
  })

  it('does not claim there is no in-flight delivery when a sending count exists but recipient data is missing', () => {
    const html = render({ sending: 1, activity: activity() })
    expect(html).toContain('存在处理中的记录，好友信息尚未提供')
    expect(html).not.toContain('本任务无在途发送')
  })

  it('does not contradict aggregate pending or confirmed counts when a detail field is absent', () => {
    const html = render({ pending: 988, sentVerified: 10, activity: activity() })
    expect(html).toContain('待发对象的信息尚未提供')
    expect(html).toContain('最近确认对象的信息尚未提供')
    expect(html).not.toContain('没有待发对象')
    expect(html).not.toContain('尚无已确认送达记录')
  })

  it('renders truthful empty-state descriptions for an untouched queued task', () => {
    const html = render({ status: 'queued', completed: 0, sentVerified: 0, activity: activity({ nextPending: recipient('pending', 1) }) })
    expect(html).toContain('尚未开始处理')
    expect(html).toContain('尚无已处理记录')
    expect(html).toContain('尚无已确认送达记录')
    expect(html).toContain('尚无最近处理记录')
    expect(html).toContain('Synthetic friend 1')
    expect(html).not.toContain('正在处理（准备/提交中）')
  })

  it.each(['completed', 'cancelled'] as const)('does not manufacture a next recipient for a %s task with none pending', status => {
    const html = render({ status, pending: 0, sentVerified: 0, activity: activity() })
    expect(html).toContain('没有待发对象')
    expect(html).toContain('当前没有正在处理的好友')
    expect(html).not.toContain('任务已暂停')
  })

  it.each(['zh-CN', 'en'] as const)('remains a read-only component in %s without triggering comments, profiles, or retry actions', language => {
    const html = render({ activity: activity({ current: recipient('sending'), lastProcessed: recipient('uncertain'),
      lastConfirmed: recipient('sent_verified', 11), nextPending: recipient('pending', 13), recent: [recipient('uncertain')] }) }, language)
    expect(html).not.toMatch(/<(?:button|a|input|form)\b/)
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('steamcommunity.com')
  })

  it('fully translates the missing-data warning and all empty-state copy', () => {
    const missing = render({}, 'en')
    const empty = render({ pending: 0, sentVerified: 0, activity: activity() }, 'en')
    expect(missing).toContain('Per-friend status is not available')
    expect(empty).toContain('No delivery is in flight for this task')
    expect(empty).toContain('No confirmed delivery recorded yet')
    expect(empty).toContain('No pending recipients')
    expect(`${missing}${empty}`).not.toMatch(/\p{Script=Han}/u)
  })

  it('allows long names, IDs and a narrow side card to wrap instead of truncating identity information', () => {
    const friendName = 'Synthetic-Looooooooong-Name-'.repeat(40)
    const html = render({ activity: activity({ lastProcessed: { ...recipient(), friendName } }) })
    expect(html).toContain(friendName)
    const css = readFileSync(new URL('../src/renderer/src/components/batch-activity.css', import.meta.url), 'utf8')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain('minmax(min(100%, 210px), 1fr)')
    expect(css).toContain('flex-wrap: wrap')
    expect(css).not.toContain('text-overflow: ellipsis')
    expect(css).not.toContain('white-space: nowrap')
  })
})
