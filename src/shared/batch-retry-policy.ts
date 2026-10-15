import { DomainError } from './domain'
import type { BatchStopCode } from './types'

export const MAX_BATCH_RETRIES = 5
export const MAX_BATCH_RETRY_DELAY_MS = 24 * 60 * 60 * 1000

const standardDelays = [60_000, 120_000, 300_000, 600_000, 900_000]
const sessionDelays = [30_000, 60_000, 120_000, 300_000, 600_000]
const accessDelays = [300_000, 600_000, 900_000, 1_800_000, 3_600_000]

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
  const delays = code === 'ACCESS_DENIED' ? accessDelays
    : ['SESSION_EXPIRED', 'SESSION_PREPARATION'].includes(code) ? sessionDelays : standardDelays
  return Math.max(delays[attempt - 1]!, Math.max(0, retryAfterMs ?? 0))
}
