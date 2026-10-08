import { describe, expect, it } from 'vitest'
import {
  DomainError,
  MAX_BATCH_RECIPIENTS,
  countCharacters,
  normalizeEmoticonToken,
  renderMessageTemplate,
  uniqueSteamIds,
  validateBatchSize,
  validateDelay,
  validateMessageTemplate
} from '../src/shared/domain'
import { composerIssues } from '../src/shared/composer-validation'

describe('message domain', () => {
  it('renders account and friend placeholders without touching other text', () => {
    expect(
      renderMessageTemplate('你好 {friend}，来自 {account} :wave:', {
        friend: 'Alice',
        account: 'Bot Owner'
      })
    ).toBe('你好 Alice，来自 Bot Owner :wave:')
  })

  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(countCharacters('A😀中')).toBe(3)
  })

  it('normalizes line endings and rejects an empty message', () => {
    expect(validateMessageTemplate('  first\r\nsecond  ')).toBe('first\nsecond')
    expect(() => validateMessageTemplate('  ')).toThrowError(DomainError)
  })

  it('supports the requested one-second minimum without changing the default', () => {
    expect(validateDelay(1_000)).toBe(1_000)
    expect(validateDelay(0)).toBe(1_000)
    expect(validateDelay(15_000)).toBe(15_000)
    expect(validateDelay(999_999)).toBe(300_000)
  })
})

describe('composer readiness feedback', () => {
  const valid = {
    authenticated: true,
    recipients: [{ displayName: 'Friend' }],
    excludedCount: 0,
    message: 'Hello {friend}',
    accountName: 'Sender',
    delayMs: 1000,
    hasActiveBatch: false
  }

  it('explains why a thousand selected friends cannot start instead of silently disabling', () => {
    expect(composerIssues({ ...valid, recipients: Array.from({ length: 1000 }, () => ({ displayName: 'Friend' })) }))
      .toEqual([{ code: 'tooManyRecipients' }])
  })

  it('accepts a permitted selection and a one-second base interval', () => {
    expect(composerIssues(valid)).toEqual([])
    expect(composerIssues({ ...valid, recipients: Array.from({ length: 30 }, () => ({ displayName: 'Friend' })) })).toEqual([])
  })

  it('reports all applicable blockers', () => {
    expect(composerIssues({ ...valid, authenticated: false, recipients: [], message: '  ', delayMs: 0, hasActiveBatch: true }))
      .toEqual([{ code: 'login' }, { code: 'noRecipients' }, { code: 'emptyMessage' }, { code: 'invalidDelay' }, { code: 'activeBatch' }])
  })

  it('explains when all selected friends were removed by the blacklist', () => {
    expect(composerIssues({ ...valid, recipients: [], excludedCount: 3 })).toEqual([{ code: 'blacklisted' }])
  })

  it('validates every personalized message, not just the template or first friend', () => {
    expect(composerIssues({ ...valid, message: `${'a'.repeat(991)}{friend}`,
      recipients: [{ displayName: 'Short' }, { displayName: 'Longer friend name' }] }))
      .toEqual([{ code: 'renderedMessageTooLong', friendName: 'Longer friend name' }])
  })

  it('validates account expansion, normalized line endings, and non-finite intervals', () => {
    expect(composerIssues({ ...valid, message: `${'a'.repeat(990)}{account}`, accountName: 'A very long account name' })[0]?.code)
      .toBe('renderedMessageTooLong')
    expect(composerIssues({ ...valid, message: `${'a'.repeat(998)}\r\nb` })).toEqual([])
    expect(composerIssues({ ...valid, delayMs: Number.NaN })).toEqual([{ code: 'invalidDelay' }])
  })
})

describe('recipient and emoticon validation', () => {
  const first = '76561198000000001'
  const second = '76561198000000002'

  it('deduplicates valid SteamID64 values', () => {
    expect(uniqueSteamIds([first, first, 'invalid', second])).toEqual([first, second])
  })

  it('enforces the batch recipient ceiling', () => {
    const ids = Array.from(
      { length: MAX_BATCH_RECIPIENTS + 1 },
      (_, index) => `7656119${String(index).padStart(10, '0')}`
    )
    expect(() => validateBatchSize(ids)).toThrowError(/单次最多/)
  })

  it('accepts only complete Steam emoticon tokens', () => {
    expect(normalizeEmoticonToken(':steamhappy:')).toBe(':steamhappy:')
    expect(normalizeEmoticonToken('steamhappy')).toBeNull()
    expect(normalizeEmoticonToken(':bad token:')).toBeNull()
  })
})
