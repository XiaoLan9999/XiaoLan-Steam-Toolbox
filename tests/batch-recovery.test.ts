import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchRecoveryController } from '../src/main/batch-recovery'
import { DomainError } from '../src/shared/domain'
import { MAX_BATCH_RETRY_DELAY_MS } from '../src/shared/batch-retry-policy'
import type { BatchPauseDetails, BatchStopCode, BatchSummary, SessionState } from '../src/shared/types'

const controllers: BatchRecoveryController[] = []
const accountId = '76561198000000001'
const batchId = 'fixture-batch'
const rate = { code: 'RATE_LIMITED' as const, message: 'HTTP 429', allowAuto: true }

beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-10-16T02:00:00.000Z') }) })
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('bounded batch automatic recovery', () => {
  it.each(['COMMENT_BASELINE', 'NETWORK_ERROR', 'RATE_LIMITED', 'SESSION_PREPARATION'] as BatchStopCode[])
  ('does not replace the current %s cause with an old POST denial count', code => {
    const f = fixture({ accessDeniedCount: 6, autoRetryEnabled: false })
    f.controller.interrupt(batchId, { code, message: 'Current pre-send failure', allowAuto: true })
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: code, stopMessage: 'Current pre-send failure',
      nextRetryAt: null, retryCount: 0, accessDeniedCount: 6 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the independent denial circuit for a current access-denied response', () => {
    const f = fixture({ accessDeniedCount: 2 })
    f.controller.interrupt(batchId, { code: 'ACCESS_DENIED', message: 'Current HTTP 403', allowAuto: true })
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'ACCESS_DENIED_PERSISTENT', nextRetryAt: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates a recovery refresh already in flight after an unresolved POST requires manual review', async () => {
    const f = fixture()
    const refresh = deferred()
    f.steam.ensureSessionFresh.mockImplementationOnce(() => refresh.promise)
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    f.update({ pending: 1, uncertain: 1 })
    f.controller.interrupt(batchId, { code: 'UNCERTAIN_RESULT', message: 'Synthetic unresolved POST', allowAuto: false })
    refresh.resolve()
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT', stopMessage: 'Synthetic unresolved POST',
      nextRetryAt: null, pending: 1, uncertain: 1 })
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['authenticated', 'expired'] as const)
  ('preserves the concrete unresolved POST stop despite a previous denial circuit and %s session', state => {
    const f = fixture({ accessDeniedCount: 6 })
    f.sessionState = state
    f.controller.interrupt(batchId, { code: 'UNCERTAIN_RESULT', message: 'Synthetic result needs review', allowAuto: false })
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'UNCERTAIN_RESULT',
      stopMessage: 'Synthetic result needs review', nextRetryAt: null, retryCount: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('persists a visible stop and deadline, then resumes only after refreshing the matching account', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, rate)
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'RATE_LIMITED', stopMessage: 'HTTP 429',
      retryCount: 1, nextRetryAt: '2026-10-16T02:01:00.000Z', pending: 2, sentVerified: 3 })
    expect(f.changed).toHaveBeenCalledWith(batchId)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledExactlyOnceWith(accountId)
    expect(f.resume).toHaveBeenCalledExactlyOnceWith(batchId)
    expect(f.read()).toMatchObject({ status: 'running', nextRetryAt: null, retryCount: 1,
      stopCode: 'RATE_LIMITED', pending: 2, sentVerified: 3 })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('keeps one attempt while never shortening the deadline for the same incident', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(20_000)
    f.controller.interrupt(batchId, { ...rate, message: 'Same incident, more detail' })
    expect(f.read()).toMatchObject({ retryCount: 1, nextRetryAt: '2026-10-16T02:01:20.000Z',
      stopMessage: 'Same incident, more detail' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('does not count busy polling as attempts or rewrite the durable deadline', async () => {
    const f = fixture()
    f.busy = true
    f.controller.interrupt(batchId, rate)
    const deadline = f.read().nextRetryAt
    await vi.advanceTimersByTimeAsync(65_000)
    expect(f.store.pauseBatch).toHaveBeenCalledTimes(1)
    expect(f.read()).toMatchObject({ retryCount: 1, nextRetryAt: deadline })
    expect(f.steam.ensureSessionFresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    f.busy = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('prevents parallel SDK refreshes when a newer deadline expires before the old refresh settles', async () => {
    const f = fixture()
    const refresh = deferred()
    f.steam.ensureSessionFresh.mockImplementationOnce(() => refresh.promise)
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(1)
    expect(f.read().retryCount).toBe(1)
    refresh.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(2)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('backs off a failed session refresh and advances once before a later successful recovery', async () => {
    const f = fixture()
    f.steam.ensureSessionFresh.mockRejectedValueOnce(new DomainError('SESSION_PREPARATION_FAILED', 'Temporary refresh failure'))
    f.controller.interrupt(batchId, { code: 'SESSION_PREPARATION', message: 'Preparing session', allowAuto: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.read()).toMatchObject({ status: 'paused', retryCount: 2, stopCode: 'SESSION_PREPARATION',
      stopMessage: 'Temporary refresh failure', nextRetryAt: '2026-10-16T02:01:30.000Z' })
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(f.read()).toMatchObject({ status: 'running', retryCount: 2 })
  })

  it('stops after five consecutive failed recovery attempts and retains the actual failure reason', async () => {
    const f = fixture()
    f.steam.ensureSessionFresh.mockRejectedValue(new DomainError('SESSION_PREPARATION_FAILED', 'Refresh still unavailable'))
    f.controller.interrupt(batchId, { code: 'SESSION_PREPARATION', message: 'Preparing session', allowAuto: true })
    for (const delay of [30_000, 60_000, 120_000, 300_000, 600_000]) await vi.advanceTimersByTimeAsync(delay)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(5)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'RETRY_EXHAUSTED', retryCount: 5, nextRetryAt: null })
    expect(f.read().stopMessage).toContain('Refresh still unavailable')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.steam.ensureSessionFresh).toHaveBeenCalledTimes(5)
  })

  it('increments the next incident after an automatic resume, but starts at one after real progress resets the count', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    f.controller.interrupt(batchId, rate)
    expect(f.read()).toMatchObject({ retryCount: 2, nextRetryAt: '2026-10-16T02:03:00.000Z' })
    await vi.advanceTimersByTimeAsync(120_000)
    f.update({ retryCount: 0 })
    f.controller.interrupt(batchId, rate)
    expect(f.read()).toMatchObject({ retryCount: 1, nextRetryAt: '2026-10-16T02:04:00.000Z' })
  })

  it('respects a Retry-After hint longer than the ordinary backoff', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, { ...rate, retryAfterMs: 180_000 })
    expect(f.read().nextRetryAt).toBe('2026-10-16T02:03:00.000Z')
    await vi.advanceTimersByTimeAsync(179_999)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('extends an existing session cooldown when the same incident later reports a longer HTTP hint', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, { code: 'SESSION_PREPARATION', message: 'Refreshing', allowAuto: true })
    await vi.advanceTimersByTimeAsync(10_000)
    f.controller.interrupt(batchId, { ...rate, retryAfterMs: 20 * 60_000 })
    expect(f.read()).toMatchObject({ retryCount: 1, nextRetryAt: '2026-10-16T02:20:10.000Z', stopCode: 'RATE_LIMITED' })
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('rearms an early timer after the system clock moves backward instead of sending before the deadline', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(30_000)
    vi.setSystemTime(new Date('2026-10-16T02:00:00.000Z'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.steam.ensureSessionFresh).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('requires manual handling of server hints outside the supported one-day window', () => {
    const f = fixture()
    f.controller.interrupt(batchId, { ...rate, retryAfterMs: MAX_BATCH_RETRY_DELAY_MS + 1 })
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'RATE_LIMITED', retryCount: 0, nextRetryAt: null })
    expect(f.read().stopMessage).toContain('等待时间超出自动恢复范围')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the longer access-denied cooldown rather than immediately repeating a refused POST', async () => {
    const f = fixture()
    f.controller.interrupt(batchId, { code: 'ACCESS_DENIED', message: 'HTTP 403', allowAuto: true })
    expect(f.read().nextRetryAt).toBe('2026-10-16T02:05:00.000Z')
    await vi.advanceTimersByTimeAsync(299_999)
    expect(f.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('keeps manual opt-out and non-retryable failures paused without timers', () => {
    const disabled = fixture({ autoRetryEnabled: false })
    disabled.controller.interrupt(batchId, rate)
    expect(disabled.read()).toMatchObject({ status: 'paused', stopCode: 'RATE_LIMITED', nextRetryAt: null, retryCount: 0 })
    const permanent = fixture()
    permanent.controller.interrupt(batchId, { code: 'QUEUE_ERROR', message: 'Storage problem', allowAuto: false })
    expect(permanent.read()).toMatchObject({ status: 'paused', stopCode: 'QUEUE_ERROR', nextRetryAt: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['expired', 'offline'] as const)('does not schedule retries for an explicitly %s account', state => {
    const f = fixture()
    f.sessionState = state
    f.authenticated = false
    f.controller.interrupt(batchId, rate)
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'LOGIN_REQUIRED', nextRetryAt: null, retryCount: 0 })
    expect(f.read().stopMessage).toContain('重新登录')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can recover a restoring account, but stops if the refresh establishes an expired token', async () => {
    const restoring = fixture()
    restoring.sessionState = 'restoring'
    restoring.authenticated = false
    restoring.steam.ensureSessionFresh.mockImplementation(async () => {
      restoring.sessionState = 'authenticated'
      restoring.authenticated = true
    })
    restoring.controller.interrupt(batchId, { code: 'SESSION_EXPIRED', message: 'Web cookie expired', allowAuto: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(restoring.resume).toHaveBeenCalledTimes(1)

    const expired = fixture()
    expired.steam.ensureSessionFresh.mockImplementation(async () => {
      expired.sessionState = 'expired'
      expired.authenticated = false
      throw new Error('Refresh token rejected')
    })
    expired.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(expired.read()).toMatchObject({ stopCode: 'LOGIN_REQUIRED', nextRetryAt: null, retryCount: 1 })
    expect(expired.resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off a still-restoring session rather than falsely treating a resolved SDK call as authentication', async () => {
    const f = fixture()
    f.sessionState = 'restoring'
    f.authenticated = false
    f.controller.interrupt(batchId, { code: 'SESSION_PREPARATION', message: 'Restore in progress', allowAuto: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'SESSION_PREPARATION', retryCount: 2 })
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('turns a switched account into a manual stop both before and after SDK recovery', async () => {
    const before = fixture()
    before.activeAccountId = '76561198000000002'
    before.controller.interrupt(batchId, rate)
    expect(before.read()).toMatchObject({ stopCode: 'ACCOUNT_CHANGED', nextRetryAt: null })

    const after = fixture()
    const refresh = deferred()
    after.steam.ensureSessionFresh.mockImplementation(() => refresh.promise)
    after.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    after.activeAccountId = '76561198000000002'
    refresh.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(after.read()).toMatchObject({ status: 'paused', stopCode: 'ACCOUNT_CHANGED', nextRetryAt: null })
    expect(after.resume).not.toHaveBeenCalled()
  })

  it.each(['MANUAL_PAUSE', 'CANCELLED', 'APP_RESTARTED', 'ACCOUNT_CHANGED', 'APP_SHUTDOWN'] as BatchStopCode[])(
    'does not overwrite a protected %s pause', code => {
      const f = fixture({ status: 'paused', stopCode: code, stopMessage: 'Protected reason' })
      const before = f.read()
      f.controller.interrupt(batchId, rate)
      expect(f.read()).toEqual(before)
      expect(f.store.pauseBatch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

  it('accepts a new automatic interruption after an explicit resume from a protected pause', () => {
    const f = fixture({ status: 'running', stopCode: 'APP_RESTARTED', stopMessage: 'Previous restart' })
    f.controller.interrupt(batchId, rate)
    expect(f.read()).toMatchObject({ status: 'paused', stopCode: 'RATE_LIMITED', retryCount: 1 })
  })

  it('invalidates a late SDK result before any database read after manual pause or cancel', async () => {
    for (const status of ['paused', 'cancelled'] as const) {
      const f = fixture()
      const refresh = deferred()
      f.steam.ensureSessionFresh.mockImplementation(() => refresh.promise)
      const token = f.controller.capture(batchId)
      expect(f.controller.capture(batchId)).toBe(token)
      f.controller.interrupt(batchId, rate, token)
      await vi.advanceTimersByTimeAsync(60_000)
      f.controller.invalidate(batchId)
      f.update({ status, stopCode: status === 'paused' ? 'MANUAL_PAUSE' : 'CANCELLED', nextRetryAt: null })
      f.store.getBatchSummary.mockClear()
      refresh.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.controller.isCurrent(batchId, token)).toBe(false)
      expect(f.store.getBatchSummary).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled()
      expect(f.read().status).toBe(status)
    }
  })

  it('ignores stale interruption tokens without touching storage', () => {
    const f = fixture()
    const token = f.controller.capture(batchId)
    f.controller.invalidate(batchId)
    f.store.getBatchSummary.mockClear()
    f.controller.interrupt(batchId, rate, token)
    expect(f.store.getBatchSummary).not.toHaveBeenCalled()
    expect(f.store.pauseBatch).not.toHaveBeenCalled()
  })

  it('does not retry empty or terminal tasks, and cleanup removes idle intent state', () => {
    const empty = fixture({ pending: 0 })
    empty.controller.interrupt(batchId, rate)
    expect(empty.read()).toMatchObject({ status: 'paused', nextRetryAt: null })
    const terminal = fixture({ status: 'cancelled' })
    const token = terminal.controller.capture(batchId)
    terminal.controller.interrupt(batchId, rate)
    expect(terminal.store.pauseBatch).not.toHaveBeenCalled()
    terminal.busy = true
    terminal.controller.cleanup(batchId)
    expect(terminal.controller.isCurrent(batchId, token)).toBe(true)
    terminal.busy = false
    terminal.controller.cleanup(batchId)
    expect(terminal.controller.isCurrent(batchId, token)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks a changed stored deadline or disabled retry setting before doing SDK work', async () => {
    const changed = fixture()
    changed.controller.interrupt(batchId, rate)
    changed.update({ nextRetryAt: '2026-10-16T03:00:00.000Z' })
    const disabled = fixture()
    disabled.controller.interrupt(batchId, rate)
    disabled.update({ autoRetryEnabled: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(changed.steam.ensureSessionFresh).not.toHaveBeenCalled()
    expect(disabled.steam.ensureSessionFresh).not.toHaveBeenCalled()
    expect(changed.resume).not.toHaveBeenCalled()
    expect(disabled.resume).not.toHaveBeenCalled()
  })

  it('waits for a worker that became busy while SDK refresh was running', async () => {
    const f = fixture()
    const refresh = deferred()
    f.steam.ensureSessionFresh.mockImplementationOnce(() => refresh.promise)
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    f.busy = true
    refresh.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.read()).toMatchObject({ status: 'paused', retryCount: 1 })
    f.busy = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('shuts down timers and ignores a late failed SDK result even after storage becomes unusable', async () => {
    const f = fixture()
    const refresh = deferred()
    f.steam.ensureSessionFresh.mockImplementation(() => refresh.promise)
    const token = f.controller.capture(batchId)
    f.controller.interrupt(batchId, rate, token)
    await vi.advanceTimersByTimeAsync(60_000)
    f.controller.shutdown()
    f.store.getBatchSummary.mockImplementation(() => { throw new Error('Database closed') })
    f.store.getBatchSummary.mockClear()
    refresh.reject(new Error('Late network failure'))
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(f.store.getBatchSummary).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.controller.isCurrent(batchId, token)).toBe(false)
    f.controller.interrupt(batchId, rate)
    f.controller.invalidate(batchId)
    f.controller.cleanup(batchId)
    expect(f.store.getBatchSummary).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('redacts tokens from SDK failure messages and bounds persisted text', async () => {
    const f = fixture()
    f.steam.ensureSessionFresh.mockRejectedValue(new Error(
      `network steamLoginSecure=secret; eyJfixture.token.signature access_token=access-secret&sessionid=session-secret; "refresh_token":"refresh-secret" ${'x'.repeat(1500)}`))
    f.controller.interrupt(batchId, rate)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.read().stopMessage).not.toContain('=secret')
    expect(f.read().stopMessage).not.toContain('eyJfixture')
    expect(f.read().stopMessage).not.toContain('access-secret')
    expect(f.read().stopMessage).not.toContain('session-secret')
    expect(f.read().stopMessage).not.toContain('refresh-secret')
    expect(f.read().stopMessage!.length).toBeLessThanOrEqual(1000)
  })
})

function fixture(overrides: Partial<BatchSummary> = {}) {
  let batch: BatchSummary = { id: batchId, accountId, messageTemplate: 'Frozen message', delayMs: 100,
    status: 'running', total: 5, completed: 3, succeeded: 3, failed: 0,
    createdAt: '2026-10-16T00:00:00.000Z', startedAt: '2026-10-16T00:00:00.000Z', finishedAt: null,
    autoRetryEnabled: true, stopCode: null, stopMessage: null, pausedAt: null, nextRetryAt: null, retryCount: 0,
    pending: 2, sending: 0, sentVerified: 3, acceptedUnverified: 0, failedCount: 0, uncertain: 0, cancelled: 0,
    ...overrides }
  const state = { activeAccountId: accountId, sessionState: 'authenticated' as SessionState,
    authenticated: true, busy: false }
  const store = {
    getBatchSummary: vi.fn((id: string) => id === batchId ? { ...batch } : null),
    getActiveAccountId: vi.fn(() => state.activeAccountId),
    pauseBatch: vi.fn((_id: string, stop?: BatchPauseDetails) => {
      batch = { ...batch, status: 'paused', stopCode: stop?.code ?? 'MANUAL_PAUSE',
        stopMessage: stop?.message ?? 'Manual pause', pausedAt: new Date().toISOString(),
        nextRetryAt: stop?.nextRetryAt ?? null, retryCount: stop?.retryCount ?? batch.retryCount }
    }),
    setBatchRunning: vi.fn((_id: string) => { batch = { ...batch, status: 'running', nextRetryAt: null } })
  }
  const steam = {
    isAuthenticated: vi.fn((_id: string) => state.authenticated),
    ensureSessionFresh: vi.fn(async (_id: string): Promise<void> => {}),
    getAccountViews: vi.fn(() => [{ id: accountId, sessionState: state.sessionState, sessionMessage: null }])
  }
  const resume = vi.fn((_id: string) => {})
  const changed = vi.fn((_id: string) => {})
  const controller = new BatchRecoveryController(store, steam, {
    resume, changed, isBusy: (_id: string, _account: string) => state.busy
  })
  controllers.push(controller)
  return { controller, store, steam, resume, changed, read: () => ({ ...batch }),
    update: (values: Partial<BatchSummary>) => { batch = { ...batch, ...values } },
    get activeAccountId() { return state.activeAccountId }, set activeAccountId(value: string) { state.activeAccountId = value },
    get sessionState() { return state.sessionState }, set sessionState(value: SessionState) { state.sessionState = value },
    get authenticated() { return state.authenticated }, set authenticated(value: boolean) { state.authenticated = value },
    get busy() { return state.busy }, set busy(value: boolean) { state.busy = value }
  }
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
