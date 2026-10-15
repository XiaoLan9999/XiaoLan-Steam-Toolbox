import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRetryAfterMs, RETRY_AFTER_TOO_LONG_MS, SteamCommunityClient } from '../src/main/community-client'
import { DomainError } from '../src/shared/domain'

const accountId = '76561198000000001'
const cookies = [
  `steamLoginSecure=${accountId}%7C%7Ctoken; Path=/; Secure; Domain=steamcommunity.com`,
  'sessionid=session-123; Path=/; Secure; Domain=steamcommunity.com'
]
const now = Date.parse('2026-10-16T00:00:00Z')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Retry-After metadata', () => {
  it.each([
    ['0', 0], ['60', 60_000], ['  00060  ', 60_000],
    ['604800', 604_800_000],
    ['Fri, 16 Oct 2026 00:02:00 GMT', 120_000],
    ['Friday, 16-Oct-26 00:02:00 GMT', 120_000],
    ['Fri Oct 16 00:02:00 2026', 120_000],
    ['Fri, 16 Oct 2026 00:00:00 GMT', 0],
    ['Thu, 15 Oct 2026 23:59:59 GMT', 0],
    ['Sunday, 06-Nov-94 08:49:37 GMT', 0]
  ])('parses %s without shortening the server wait', (value, expected) => {
    expect(parseRetryAfterMs(value, now)).toBe(expected)
  })

  it('does not round down a remaining partial second', () => {
    expect(parseRetryAfterMs('Fri, 16 Oct 2026 00:00:01 GMT', now + 100)).toBe(900)
  })

  it.each([null, '', ' ', '-1', '0.1', '+60', '1e3', 'Infinity', 'NaN', '0x10',
    '12, 24', 'not a date', '2026-10-16T00:02:00Z', 'Fri, 30 Feb 2026 00:00:00 GMT',
    'Fri, 16 Oct 2026 25:00:00 GMT', 'Fri, 16 Oct 2026 00:60:00 GMT'])('ignores invalid input %j', value => {
    expect(parseRetryAfterMs(value, now)).toBeUndefined()
  })

  it.each(['604801', '9999999999999999999999999999999999999999',
    '9'.repeat(10_000), 'Sat, 24 Oct 2026 00:00:00 GMT',
    'Friday, 16-Oct-66 00:02:00 GMT'])('preserves an excessive wait as a finite long hint', value => {
    const delay = parseRetryAfterMs(value, now)
    expect(delay).toBe(RETRY_AFTER_TOO_LONG_MS)
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBeGreaterThan(7 * 24 * 60 * 60 * 1000)
  })

  it('keeps zero with many leading zeroes', () => {
    expect(parseRetryAfterMs('0'.repeat(10_000), now)).toBe(0)
  })

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])('ignores invalid reference time %s', value => {
    expect(parseRetryAfterMs('Fri, 16 Oct 2026 00:02:00 GMT', value)).toBeUndefined()
  })

  it.each([403, 429])('carries the HTTP %s hint after only one POST without logging out', async status => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => new Response('Denied', {
      status, headers: { 'Retry-After': 'Fri, 16 Oct 2026 00:02:00 GMT' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const expired = vi.fn()
    const diagnostic = vi.fn()
    const client = new SteamCommunityClient(accountId, cookies, expired, diagnostic)
    await expect(client.postProfileComment('76561198000000002', 'Hello')).rejects.toMatchObject({
      code: status === 403 ? 'COMMUNITY_ACCESS_DENIED' : 'RATE_LIMITED',
      retryable: true, retryAfterMs: 120_000
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(vi.getTimerCount()).toBe(0)
    expect(expired).not.toHaveBeenCalled()
    expect(client.getCookies()).toEqual(cookies)
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      httpStatus: status, method: 'POST', reason: status === 403 ? 'http-403' : 'http-429'
    }))
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Retry-After')
  })

  it.each([403, 429].flatMap(status => [
    { status, header: '60', expected: 60_000 },
    { status, header: '0.1', expected: undefined },
    { status, header: '604801', expected: RETRY_AFTER_TOO_LONG_MS },
    { status, header: 'Thu, 15 Oct 2026 23:59:59 GMT', expected: 0 }
  ]))('handles HTTP $status metadata for $header without retrying', async ({ status, header, expected }) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const fetchMock = vi.fn(async () => new Response('Denied', { status, headers: { 'Retry-After': header } }))
    vi.stubGlobal('fetch', fetchMock)
    const expired = vi.fn()
    const client = new SteamCommunityClient(accountId, cookies, expired)
    const result = await client.postProfileComment('76561198000000002', 'Hello').catch(error => error as unknown)
    expect(result).toBeInstanceOf(DomainError)
    expect((result as DomainError).retryAfterMs).toBe(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(expired).not.toHaveBeenCalled()
  })

  it('keeps old DomainError construction compatible', () => {
    const error = new DomainError('EXISTING_CODE', 'Existing message', true)
    expect(error).toMatchObject({ code: 'EXISTING_CODE', message: 'Existing message', retryable: true })
    expect(error.retryAfterMs).toBeUndefined()
  })
})
