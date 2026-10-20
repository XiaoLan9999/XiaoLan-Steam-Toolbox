import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GAME_STATUS_ERROR_MESSAGES, gameStatusFailureMessage, gameStatusFailureStageMessage, isGameStatusFailureCode } from '../src/shared/game-status-errors'
import { GameStatusConnectionNotice, GameStatusFailureNotice, gameStatusError } from '../src/renderer/src/components/GameStatusPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

const zh = (text: string, _english: string): string => text
const en = (_text: string, english: string): string => english
const secret = 'webLogonToken=fixture-secret steamLoginSecure=private-cookie join=steam://joinlobby/private-address eyJfixture-token'
const render = (failure: unknown, language: 'zh-CN' | 'en' = 'zh-CN'): string => renderToStaticMarkup(<I18nProvider language={language}><GameStatusFailureNotice failure={failure} /></I18nProvider>)

describe('safe exact game status failure codes', () => {
  it.each(Object.keys(GAME_STATUS_ERROR_MESSAGES))('offers distinct fixed bilingual text for %s without returning the SDK message', code => {
    expect(isGameStatusFailureCode(code)).toBe(true)
    for (const t of [zh, en]) {
      const message = gameStatusError({ code, message: secret, stack: secret, richPresence: { connect: secret } }, t)
      expect(message).toBe(gameStatusFailureMessage(code, t))
      expect(message).not.toContain('fixture-secret'); expect(message).not.toContain('private-address')
      expect(message).not.toContain('eyJfixture-token')
    }
    expect(gameStatusFailureMessage(code, zh)).not.toBe(gameStatusFailureMessage(code, en))
  })

  it.each(['UNEXPECTED_ERROR', 'GAME_STATUS_DECODE_FAILED', 'GAME_STATUS_AUTH_UNKNOWN', secret, '__proto__', 'constructor', undefined, null, 42])('does not classify or render unrecognized code %s', code => {
    expect(isGameStatusFailureCode(code)).toBe(false)
    expect(gameStatusError({ code, message: secret }, en)).toBe(gameStatusFailureMessage(undefined, en))
    expect(gameStatusError({ code, message: secret }, en)).not.toContain('requires security verification')
    expect(gameStatusError({ code, message: secret }, en)).not.toContain(secret)
  })

  it('maps the existing explicit session-changed code without allowing arbitrary session substrings', () => {
    expect(gameStatusError({ code: 'GAME_STATUS_SESSION_CHANGED' }, en)).toBe(gameStatusFailureMessage('GAME_STATUS_CONTEXT_CHANGED', en))
    expect(gameStatusError({ code: 'UNRELATED_SESSION_UNKNOWN' }, en)).toBe(gameStatusFailureMessage(undefined, en))
  })

  it('explains that absent live-game state is not an expired sign-in or a forced disconnect', () => {
    const message = gameStatusError({ code: 'GAME_STATUS_NO_LIVE_GAME', message: secret }, en)
    expect(message).toContain('No live game session has been identified')
    expect(message).toContain('No game status was changed')
    expect(message).not.toMatch(/expired|disconnected|security verification|Sign in again/i)
  })

  it.each(['GAME_STATUS_RP_READ_FAILED', 'GAME_STATUS_RP_EMPTY', 'GAME_STATUS_RP_INVALID'])('distinguishes rich-presence failures from a sign-in diagnosis: %s', code => {
    const message = gameStatusError({ code, message: secret }, en)
    expect(message).toMatch(/rich presence/i)
    expect(message).not.toContain('Sign in again'); expect(message).not.toContain('requires security verification')
    expect(message).not.toContain('sign-in has expired')
  })
})

describe('game status failure stage and outcome presentation', () => {
  it.each(['zh-CN', 'en'] as const)('shows only fixed reason, stage, time and safe AppID in %s', language => {
    const html = render({ code: 'GAME_STATUS_RP_READ_FAILED', stage: 'read_presence', at: '2026-10-20T12:00:00.000Z', appId: 1329410, submitted: 'no', message: secret, nonce: secret, raw: { connect: secret } }, language)
    expect(html).toContain('GAME_STATUS_RP_READ_FAILED'); expect(html).toContain('AppID 1329410')
    expect(html).toContain(language === 'en' ? 'Reading game rich presence' : '读取游戏详细状态')
    expect(html).toContain(language === 'en' ? 'No status changes were submitted' : '尚未提交状态修改')
    expect(html).toContain('2026'); expect(html).not.toContain('fixture-secret'); expect(html).not.toContain('private-address')
    expect(html).not.toContain('eyJfixture-token')
  })

  it('does not echo unknown code, stage, timestamp, app or submission values', () => {
    const html = render({ code: secret, stage: secret, at: secret, appId: secret, submitted: secret, message: secret }, 'en')
    expect(html).toContain('cause is not confirmed'); expect(html).toContain('Stage not established'); expect(html).toContain('Time unavailable')
    expect(html).toContain('Submission is not confirmed'); expect(html).not.toContain('AppID')
    expect(html).not.toContain('fixture-secret'); expect(html).not.toContain('private-address'); expect(html).not.toContain('eyJfixture-token')
  })

  it.each([null, undefined, secret, 123, [], {}])('handles malformed failure %s with fixed fallback text', failure => {
    const html = render(failure, 'en')
    expect(html).toContain('cause is not confirmed'); expect(html).not.toContain('fixture-secret')
  })

  it.each(['yes', 'unknown'] as const)('never treats submission=%s as proof of delivery', submitted => {
    const html = render({ code: 'GAME_STATUS_UPLOAD_FAILED', stage: 'upload', submitted, at: '2026-10-20T12:00:00.000Z' }, 'en')
    expect(html).toContain(submitted === 'yes' ? 'readback is needed to confirm the result' : 'read the current status first')
    expect(html).not.toContain('successfully'); expect(html).not.toContain('confirmed successful')
  })

  it.each([-1, 0, 1.2, 0x1000000, NaN, Infinity])('omits invalid app ID %s', appId => {
    expect(render({ code: 'GAME_STATUS_NO_LIVE_GAME', appId }, 'en')).not.toContain('AppID')
  })

  it('does not inspect arbitrary error messages when no known code exists', () => {
    const error = { get message(): never { throw new Error('Do not inspect sensitive error messages') } }
    expect(gameStatusError(error, en)).toBe(gameStatusFailureMessage(undefined, en))
    expect(gameStatusFailureStageMessage('RAW_PRIVATE_CONTEXT', en)).toBe('Stage not established')
  })

  it('does not contradict an empty post-submission readback with a claim that nothing was submitted', () => {
    const html = render({ code: 'GAME_STATUS_RP_EMPTY', stage: 'readback', submitted: 'yes', at: '2026-10-20T12:00:00.000Z' }, 'en')
    expect(html).toContain('Submission was attempted')
    expect(html).not.toContain('no changes were submitted'); expect(html).not.toContain('No status changes were submitted')
  })

  it.each(['zh-CN', 'en'] as const)('does not expose legacy snapshot errors without a structured failure in %s', language => {
    const html = renderToStaticMarkup(<I18nProvider language={language}><GameStatusConnectionNotice snapshot={{ status: 'error', error: secret }} /></I18nProvider>)
    expect(html).toContain(language === 'en' ? 'cause is not confirmed' : '具体原因尚未确认')
    expect(html).not.toContain('fixture-secret'); expect(html).not.toContain('private-address'); expect(html).not.toContain('eyJfixture-token')
  })

  it('uses a specific structured read failure ahead of the generic connection label or raw legacy error', () => {
    const html = renderToStaticMarkup(<I18nProvider language="en"><GameStatusConnectionNotice snapshot={{ status: 'logged_on', error: secret, failure: { code: 'GAME_STATUS_RP_INVALID', stage: 'read_presence', submitted: 'no', at: '2026-10-20T12:00:00.000Z' } }} /></I18nProvider>)
    expect(html).toContain('unsupported format'); expect(html).toContain('Reading game rich presence')
    expect(html).not.toContain('security verification'); expect(html).not.toContain('fixture-secret')
  })

  it('requires a real guard_required status to show the security-verification fallback', () => {
    const html = renderToStaticMarkup(<I18nProvider language="en"><GameStatusConnectionNotice snapshot={{ status: 'guard_required', error: secret }} /></I18nProvider>)
    expect(html).toContain('Steam requires security verification'); expect(html).not.toContain('fixture-secret')
    expect(renderToStaticMarkup(<GameStatusConnectionNotice snapshot={null} />)).toBe('')
    expect(renderToStaticMarkup(<GameStatusConnectionNotice snapshot={{ status: 'logged_on', error: null }} />)).toBe('')
  })
})
