import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/shared/domain'
import { batchInterruption, batchRetryDelay, MAX_BATCH_RETRIES } from '../src/shared/batch-retry-policy'

describe('bounded batch recovery policy', () => {
  it('uses a conservative cooldown for access denials and respects server retry hints', () => {
    expect(batchRetryDelay('ACCESS_DENIED', 1)).toBe(300_000)
    expect(batchRetryDelay('ACCESS_DENIED', 5)).toBe(300_000)
    expect(batchRetryDelay('ACCESS_DENIED_PERSISTENT', 1)).toBeNull()
    expect(batchRetryDelay('RATE_LIMITED', 1)).toBe(60_000)
    expect(batchRetryDelay('RATE_LIMITED', 1, 500_000)).toBe(500_000)
    expect(batchRetryDelay('RATE_LIMITED', 1, 0)).toBe(60_000)
  })

  it('does not shorten very long server cooldowns or schedule unbounded attempts', () => {
    expect(batchRetryDelay('RATE_LIMITED', 1, Number.MAX_SAFE_INTEGER)).toBeNull()
    expect(batchRetryDelay('RATE_LIMITED', MAX_BATCH_RETRIES + 1)).toBeNull()
    expect(batchRetryDelay('RATE_LIMITED', 0)).toBeNull()
  })

  it.each(['RATE_LIMITED', 'COMMUNITY_ACCESS_DENIED', 'SESSION_EXPIRED', 'SESSION_PREPARATION_FAILED'])
  ('only explicitly unaccepted %s requests are eligible to return to pending', code => {
    expect(batchInterruption(new DomainError(code, 'Synthetic error')).rejectedBeforeAcceptance).toBe(true)
  })

  it.each([new Error('fetch failed'), new Error('Steam HTTP error 503'), new Error('Steam returned invalid JSON'),
    new DomainError('SESSION_CHANGED', 'Synthetic changed session')])
  ('never replays an uncertain submitted request %s', error => {
    expect(batchInterruption(error)).toMatchObject({ canRetry: true, rejectedBeforeAcceptance: false })
  })

  it('does not automatically retry unknown errors or user/account transitions', () => {
    expect(batchInterruption(new Error('Unexpected storage state')).canRetry).toBe(false)
    expect(batchInterruption(new DomainError('WRONG_ACCOUNT', 'Synthetic account transition')).canRetry).toBe(false)
    expect(batchInterruption(new DomainError('NOT_AUTHENTICATED', 'Synthetic expired token')).code).toBe('LOGIN_REQUIRED')
  })

  it('never automatically continues after an unresolved POST denial, regardless of error retry hints', () => {
    expect(batchInterruption(new DomainError('COMMENT_POST_UNCERTAIN', 'Synthetic POST uncertainty', true, 300_000)))
      .toEqual({ code: 'UNCERTAIN_RESULT', canRetry: false, rejectedBeforeAcceptance: false })
  })
})
