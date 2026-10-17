import { DomainError } from './domain'
import type { BatchStopCode } from './types'

export const MAX_BATCH_RETRIES = 5
export const MAX_ACCESS_DENIED_RETRIES = 1
export const ACCESS_DENIED_COOLDOWN_MS = 300_000
export const MAX_BATCH_RETRY_DELAY_MS = 24 * 60 * 60 * 1000
export const COMMENT_POST_UNCERTAIN_MESSAGE = 'Steam 拒绝响应，但发送结果待核对；为防重复不会自动重发。'
export const LEGACY_COMMENT_POST_REVIEW_MESSAGE = '旧版 HTTP 403 可能已经送达，该对象已移入待核对；核对后可继续其余待发。为避免重复，未自动重发。'

const standardDelays = [60_000, 120_000, 300_000, 600_000, 900_000]
const sessionDelays = [30_000, 60_000, 120_000, 300_000, 600_000]

export interface BatchInterruption {
  code: BatchStopCode
  canRetry: boolean
  rejectedBeforeAcceptance: boolean
  retryAfterMs?: number
}

export function batchInterruption(error: unknown): BatchInterruption {
  if (error instanceof DomainError) {
    const retryAfterMs = error.retryAfterMs
    switch (error.code) {
      case 'RATE_LIMITED': return { code: 'RATE_LIMITED', canRetry: true, rejectedBeforeAcceptance: true, retryAfterMs }
      case 'COMMUNITY_ACCESS_DENIED': return { code: 'ACCESS_DENIED', canRetry: true, rejectedBeforeAcceptance: true, retryAfterMs }
      case 'COMMENT_POST_UNCERTAIN': return { code: 'UNCERTAIN_RESULT', canRetry: false, rejectedBeforeAcceptance: false }
      case 'SESSION_EXPIRED': return { code: 'SESSION_EXPIRED', canRetry: true, rejectedBeforeAcceptance: true }
      case 'SESSION_PREPARATION_FAILED': return { code: 'SESSION_PREPARATION', canRetry: true, rejectedBeforeAcceptance: true, retryAfterMs }
      case 'SESSION_CHANGED': return { code: 'SESSION_CHANGED', canRetry: true, rejectedBeforeAcceptance: false }
      case 'SESSION_CHECK_FAILED': return { code: 'SESSION_PREPARATION', canRetry: true, rejectedBeforeAcceptance: false }
      case 'WRONG_ACCOUNT': return { code: 'ACCOUNT_CHANGED', canRetry: false, rejectedBeforeAcceptance: false }
      case 'NOT_AUTHENTICATED': return { code: 'LOGIN_REQUIRED', canRetry: false, rejectedBeforeAcceptance: false }
    }
  }
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (/http error 5\d\d|service unavailable|busy/.test(message)) {
    return { code: 'SERVER_ERROR', canRetry: true, rejectedBeforeAcceptance: false }
  }
  if (/timeout|timed out|socket|econn|network|hang up|connection|fetch failed|abort|网络|连接/.test(message)) {
    return { code: 'NETWORK_ERROR', canRetry: true, rejectedBeforeAcceptance: false }
  }
  if (/invalid json|malformed comment response|response interrupted|response exceeded the size limit/.test(message)) {
    return { code: 'UNCERTAIN_RESULT', canRetry: true, rejectedBeforeAcceptance: false }
  }
  return { code: 'QUEUE_ERROR', canRetry: false, rejectedBeforeAcceptance: false }
}

export function batchRetryDelay(code: BatchStopCode, attempt: number, retryAfterMs?: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_BATCH_RETRIES) return null
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs > MAX_BATCH_RETRY_DELAY_MS)) return null
  if (code === 'ACCESS_DENIED_PERSISTENT') return null
  const delay = code === 'ACCESS_DENIED' ? ACCESS_DENIED_COOLDOWN_MS
    : (['SESSION_EXPIRED', 'SESSION_PREPARATION'].includes(code) ? sessionDelays : standardDelays)[attempt - 1]!
  return Math.max(delay, Math.max(0, retryAfterMs ?? 0))
}
