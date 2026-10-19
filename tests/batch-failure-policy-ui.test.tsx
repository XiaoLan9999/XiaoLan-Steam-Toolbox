import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { BatchFailurePolicyFields, BatchFailurePolicyPanel, failurePolicySummary } from '../src/renderer/src/components/BatchFailurePolicyPanel'
import { BatchVerificationPanel, batchVerificationActionLabel, batchVerificationConfirmation } from '../src/renderer/src/components/BatchVerificationPanel'
import { BatchRecoveryPanel } from '../src/renderer/src/components/BatchRecoveryPanel'
import { DEFAULT_BATCH_FAILURE_POLICY, type BatchFailurePolicy } from '../src/shared/batch-failure-policy'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { BatchSummary } from '../src/shared/types'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())
const t = (zh: string, _en: string) => zh
const task = (overrides: Partial<BatchSummary> = {}): BatchSummary => ({
  id: 'fixture-task-policy', accountId: '76561198000000001', status: 'paused', total: 2,
  completed: 1, pending: 1, sending: 0, uncertain: 1, cancelled: 0, sentVerified: 0, acceptedUnverified: 0,
  failedCount: 0, succeeded: 0, failed: 1, createdAt: '2026-10-20T01:00:00.000Z', startedAt: null,
  finishedAt: null, messageTemplate: 'Synthetic', delayMs: 100, autoRetryEnabled: false,
  stopCode: 'UNCERTAIN_RESULT', stopMessage: null, pausedAt: null, nextRetryAt: null, retryCount: 0,
  ...overrides
})
const render = (children: React.ReactNode, language: 'zh-CN' | 'en' = 'zh-CN') =>
  renderToStaticMarkup(<I18nProvider language={language}>{children}</I18nProvider>)

describe('per-task failure policy controls', () => {
  it.each(['zh-CN', 'en'] as const)('offers two failure and three uncertainty choices without auto-applying in %s', language => {
    const onChange = vi.fn()
    const html = render(<BatchFailurePolicyFields value={{ ...DEFAULT_BATCH_FAILURE_POLICY }} onChange={onChange} />, language)
    expect(html.match(/<option /g)).toHaveLength(5)
    expect(html).toContain('value="verify_then_skip" selected=""')
    expect(html).toContain('value="verify_then_pause"')
    expect(html).toContain(language === 'en' ? 'Skipping does not mean success' : '跳过不代表成功')
    expect(html).toContain(language === 'en' ? 'Steam rate limits' : 'Steam 限流')
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each(['running', 'completed', 'cancelled'] as const)('makes saved policy read-only for %s tasks', status => {
    const action = vi.fn(async () => null)
    const html = render(<BatchFailurePolicyPanel batch={task({ status })} runAction={action} />)
    expect(html).toContain('<fieldset class="batch-failure-fields" disabled="">')
    expect(html).not.toContain('保存到此任务（不恢复发送）')
    expect(action).not.toHaveBeenCalled()
  })

  it('enables editing only while paused, not while a send or verification is settling', () => {
    const action = vi.fn(async () => null)
    const paused = render(<BatchFailurePolicyPanel batch={task()} runAction={action} />)
    expect(paused).toContain('<fieldset class="batch-failure-fields">')
    expect(paused).toContain('保存不会恢复发送或改写已有投递结果')
    expect(paused).toContain('<button disabled="">保存到此任务（不恢复发送）</button>')
    const sending = render(<BatchFailurePolicyPanel batch={task({ sending: 1 })} runAction={action} />)
    expect(sending).toContain('<fieldset class="batch-failure-fields" disabled="">')
    const checking = render(<BatchFailurePolicyPanel batch={task({ verification: { deliveryId: 'd', friendSteamId: '76561198000000101',
      friendName: 'Synthetic friend', state: 'checking', attempt: 1, maxAttempts: 3, checkedAt: null, nextCheckAt: null, message: '' } })} runAction={action} />)
    expect(checking).toContain('<fieldset class="batch-failure-fields" disabled="">')
  })

  it('reflects pause-on-uncertain in all main descriptions and the resume confirmation', () => {
    const value = task({ failurePolicy: { definiteFailure: 'pause', uncertainResult: 'verify_then_pause' } })
    const html = render(<><BatchVerificationPanel batch={value} /><BatchRecoveryPanel batch={value} authenticated runAction={async () => null} /></>)
    expect(html).toContain('仍未确认则保持暂停')
    expect(html).not.toContain('也不阻塞其余待发')
    expect(batchVerificationActionLabel(value, t)).toBe('核对留言（未确认则暂停）')
    expect(batchVerificationConfirmation(value, t)).toContain('仍未确认则保持暂停')
    expect(failurePolicySummary(value.failurePolicy!, t)).toContain('普通失败暂停')
  })

  it('does not promise automatic checks when the chosen uncertainty policy is skip', () => {
    const value = task({ failurePolicy: { definiteFailure: 'skip', uncertainResult: 'skip' } })
    const html = render(<BatchVerificationPanel batch={value} />)
    expect(html).toContain('不自动核对')
    expect(html).toContain('保留待核对并直接跳过')
    expect(html).toContain('不重发')
  })

  it.each(['skip', 'pause'] as const)('summarizes persisted definite-failure mode %s independently of retry preference', definiteFailure => {
    const value: BatchFailurePolicy = { definiteFailure, uncertainResult: 'verify_then_skip' }
    expect(failurePolicySummary(value, t)).toContain(definiteFailure === 'pause' ? '普通失败暂停' : '普通失败跳过')
  })
})
