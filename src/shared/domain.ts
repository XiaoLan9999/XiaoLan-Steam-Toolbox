export const MAX_COMMENT_LENGTH = 1000
export const MIN_DELAY_MS = 1_000
export const MAX_DELAY_MS = 300_000
export const MAX_BATCH_RECIPIENTS = 30

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function countCharacters(value: string): number {
  return Array.from(value).length
}

export function validateMessageTemplate(template: string): string {
  const normalized = template.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    throw new DomainError('EMPTY_MESSAGE', '留言内容不能为空')
  }

  if (countCharacters(normalized) > MAX_COMMENT_LENGTH) {
    throw new DomainError('MESSAGE_TOO_LONG', `留言最多 ${MAX_COMMENT_LENGTH} 个字符`)
  }

  return normalized
}

export function renderMessageTemplate(
  template: string,
  values: { friend: string; account: string }
): string {
  const rendered = template
    .replaceAll('{friend}', values.friend)
    .replaceAll('{account}', values.account)

  if (countCharacters(rendered) > MAX_COMMENT_LENGTH) {
    throw new DomainError(
      'RENDERED_MESSAGE_TOO_LONG',
      `为 ${values.friend} 生成的留言超过 ${MAX_COMMENT_LENGTH} 个字符`
    )
  }

  return rendered
}

export function validateDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    throw new DomainError('INVALID_DELAY', '发送间隔无效')
  }

  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(delayMs)))
}

export function uniqueSteamIds(ids: string[]): string[] {
  const normalized = ids.map((id) => id.trim()).filter((id) => /^7656119\d{10}$/.test(id))
  return [...new Set(normalized)]
}

export function validateBatchSize(ids: string[]): string[] {
  const uniqueIds = uniqueSteamIds(ids)
  if (uniqueIds.length === 0) {
    throw new DomainError('NO_RECIPIENTS', '请至少选择一位好友')
  }
  if (uniqueIds.length > MAX_BATCH_RECIPIENTS) {
    throw new DomainError(
      'TOO_MANY_RECIPIENTS',
      `单次最多选择 ${MAX_BATCH_RECIPIENTS} 位好友，请拆分批次`
    )
  }
  return uniqueIds
}

export function normalizeEmoticonToken(value: string): string | null {
  const token = value.trim()
  if (!/^:[^:\s]{1,64}:$/.test(token)) {
    return null
  }
  return token
}
