import {
  countCharacters, MAX_BATCH_RECIPIENTS, MAX_COMMENT_LENGTH, MAX_DELAY_MS, MIN_DELAY_MS
} from './domain'

export type ComposerIssueCode = 'login' | 'noRecipients' | 'blacklisted' | 'tooManyRecipients' |
  'emptyMessage' | 'messageTooLong' | 'renderedMessageTooLong' | 'invalidDelay' | 'activeBatch'

export interface ComposerIssue {
  code: ComposerIssueCode
  friendName?: string
}

export function composerIssues(input: {
  authenticated: boolean
  recipients: ReadonlyArray<{ displayName: string }>
  excludedCount: number
  message: string
  accountName: string
  delayMs: number
  hasActiveBatch: boolean
}): ComposerIssue[] {
  const issues: ComposerIssue[] = []
  if (!input.authenticated) issues.push({ code: 'login' })
  if (input.recipients.length === 0) {
    issues.push({ code: input.excludedCount ? 'blacklisted' : 'noRecipients' })
  }
  if (input.recipients.length > MAX_BATCH_RECIPIENTS) issues.push({ code: 'tooManyRecipients' })
  const normalized = input.message.replace(/\r\n/g, '\n').trim()
  if (!normalized) issues.push({ code: 'emptyMessage' })
  if (countCharacters(normalized) > MAX_COMMENT_LENGTH) issues.push({ code: 'messageTooLong' })
  if (normalized && countCharacters(normalized) <= MAX_COMMENT_LENGTH) {
    const overlong = input.recipients.find((friend) => countCharacters(normalized
      .replaceAll('{friend}', friend.displayName)
      .replaceAll('{account}', input.accountName)) > MAX_COMMENT_LENGTH)
    if (overlong) issues.push({ code: 'renderedMessageTooLong', friendName: overlong.displayName })
  }
  if (!Number.isFinite(input.delayMs) || input.delayMs < MIN_DELAY_MS || input.delayMs > MAX_DELAY_MS) {
    issues.push({ code: 'invalidDelay' })
  }
  if (input.hasActiveBatch) issues.push({ code: 'activeBatch' })
  return issues
}
