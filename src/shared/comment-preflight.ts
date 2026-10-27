import { DomainError } from './domain'
import type { BatchInterruption } from './batch-retry-policy'

/** Failure before the comment POST, so the recipient is still safe to leave pending. */
export class CommentPreflightError extends DomainError {
  readonly interruption: BatchInterruption

  constructor(message: string, interruption: BatchInterruption) {
    super('COMMENT_PREFLIGHT_FAILED', message, interruption.canRetry, interruption.retryAfterMs)
    this.interruption = { ...interruption, rejectedBeforeAcceptance: true }
  }
}
