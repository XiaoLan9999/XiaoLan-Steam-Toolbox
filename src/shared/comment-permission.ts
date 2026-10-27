import { DomainError } from './domain'

/** A reported recipient permission denial is separate from whether a POST reached Steam. */
export class CommentPermissionDeniedError extends DomainError {
  readonly commentPermissionDenied = true

  constructor(code: 'COMMUNITY_ACCESS_DENIED' | 'COMMENT_POST_UNCERTAIN', message: string, retryAfterMs?: number) {
    super(code, message, code === 'COMMUNITY_ACCESS_DENIED', retryAfterMs)
  }
}
