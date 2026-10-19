import { afterEach, describe, expect, it, vi } from 'vitest'
import { GAME_STATUS_APP_LOOKUP_TIMEOUT_MS, readGameStatusAppInfo, type GameStatusAppClient } from '../src/main/game-status-apps'
import { GAME_STATUS_MAX_TEMPLATES, gameStatusTemplatesFromTokens, isSafeGameStatusIconUrl, sanitizeGameStatusPresence, validateGameStatusPresence } from '../src/shared/game-status-presence'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'

const APP = 730
const HASH = '0123456789abcdef0123456789abcdef01234567'
const ICON = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${APP}/${HASH}.jpg`
const TABLE = {
  '#Display': '{#State_%state%}',
  '#State_Playing': '%mode% - %currentmap% [%score%]',
  '#State_Menu': 'At the main menu',
  '#Direct': '%details%',
  '#Fixed': 'Ready',
  '#Percent': '100% ready',
  '#Group': '%matchgrouploc%',
  '#Nested': 'Mode: {#Display}'
}
const info = (tokens: Record<string, string> = TABLE): GameStatusAppInfo => ({ appId: APP, name: 'Synthetic Game', iconUrl: ICON, language: 'english', templates: gameStatusTemplatesFromTokens(tokens), templateStatus: Object.keys(tokens).length ? 'available' : 'empty' })
const input = (displayToken = '#Direct', values: Record<string, string> = { details: 'Ready to play' }): GameStatusPresence => ({ displayToken, values })
const assertion = () => {}

afterEach(() => { vi.useRealTimers() })

describe('published Steam rich-presence templates', () => {
  it('collects direct and reachable conditional parameters without inventing a display token', () => {
    const templates = gameStatusTemplatesFromTokens(TABLE)
    expect(templates.find(template => template.token === '#Display')).toEqual({ token: '#Display', text: '{#State_%state%}', parameters: ['currentmap', 'mode', 'score', 'state'] })
    expect(templates.find(template => template.token === '#Fixed')!.parameters).toEqual([])
    expect(templates.find(template => template.token === '#Nested')!.parameters).toEqual(['currentmap', 'mode', 'score', 'state'])
  })
  it('renders fixed text without sending a legacy status field', () => {
    expect(validateGameStatusPresence(info(), input('#Fixed', {}))).toEqual({ fields: { steam_display: '#Fixed' }, preview: 'Ready' })
    expect(validateGameStatusPresence(info(), input('#Percent', {})).preview).toBe('100% ready')
  })
  it('renders nested conditional published tokens with matching variables', () => {
    expect(validateGameStatusPresence(info(), input('#Display', { state: 'Playing', mode: 'Casual', currentmap: 'map_a', score: '3:2' }))).toEqual({ fields: { steam_display: '#Display', state: 'Playing', mode: 'Casual', currentmap: 'map_a', score: '3:2' }, preview: 'Casual - map_a [3:2]' })
    expect(validateGameStatusPresence(info(), input('#Display', { state: 'Menu' })).preview).toBe('At the main menu')
    expect(validateGameStatusPresence(info(), input('#Nested', { state: 'Menu' })).preview).toBe('Mode: At the main menu')
  })
  it('normalizes variable and token lookup case while emitting the published token spelling', () => {
    expect(validateGameStatusPresence(info({ '#Known': '%DETAILS%' }), input('#KNOWN', { DETAILS: 'Hello' }))).toEqual({ fields: { steam_display: '#Known', details: 'Hello' }, preview: 'Hello' })
  })
  it('allows public match-group labels without permitting Steam party identifiers', () => {
    expect(validateGameStatusPresence(info(), input('#Group', { matchgrouploc: 'SpecialEvent' })).preview).toBe('SpecialEvent')
    expect(gameStatusTemplatesFromTokens({ '#Group': '%steam_player_group%' })).toEqual([])
  })
  it('uses literal replacement values and does not reinterpret injected display syntax', () => {
    expect(validateGameStatusPresence(info(), input('#Direct', { details: '$& $1 $$' })).preview).toBe('$& $1 $$')
    expect(() => validateGameStatusPresence(info(), input('#Direct', { details: '{#Fixed}' }))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Direct', { details: '%details%' }))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Display', { state: 'Menu} {#Fixed' }))).toThrow()
  })
  it('rejects arbitrary display text, unknown tokens and unsupported extra variables', () => {
    expect(() => validateGameStatusPresence(info(), input('Arbitrary status'))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#NotPublished'))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Direct', { details: 'Ready', status: 'injected' }))).toThrow()
  })
  it('rejects a missing required value, empty removal value, and unknown conditional branch', () => {
    expect(() => validateGameStatusPresence(info(), input('#Direct', {}))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Direct', { details: '' }))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Display', { state: 'Playing', mode: 'Casual' }))).toThrow()
    expect(() => validateGameStatusPresence(info(), input('#Display', { state: 'Unknown' }))).toThrow()
  })
  it.each(['connect', 'game:join', 'joinGame', 'game:lobby', 'access_token', 'accessToken', 'password', 'secret', 'auth', 'ticket', 'credential', 'session', 'steam_player_group', 'steamPlayerGroup', 'groupid', 'groupLabel', 'party', 'server:ip', 'steam_display', '__proto__', 'constructor'])('refuses sensitive variable %s', key => {
    const value = JSON.parse(JSON.stringify({ displayToken: '#Direct', values: {} })) as GameStatusPresence
    Object.defineProperty(value.values, key, { value: 'DO-NOT-EXPOSE', enumerable: true })
    expect(() => sanitizeGameStatusPresence(value)).toThrow()
    expect(gameStatusTemplatesFromTokens({ '#Unsafe': `%${key}%` })).toEqual([])
  })
  it('rejects duplicate-case variables, non-plain records, control characters and invalid names', () => {
    expect(() => sanitizeGameStatusPresence(input('#Direct', { details: 'a', DETAILS: 'b' }))).toThrow()
    expect(() => sanitizeGameStatusPresence({ displayToken: '#Direct', values: [] })).toThrow()
    expect(() => sanitizeGameStatusPresence({ displayToken: '#Direct', values: new Date() })).toThrow()
    expect(() => sanitizeGameStatusPresence(input('#Direct', { 'not-valid': 'x' }))).toThrow()
    expect(() => sanitizeGameStatusPresence(input('#Direct', { details: 'line\nbreak' }))).toThrow()
    expect(() => sanitizeGameStatusPresence(input('#Direct', { details: 'nul\0byte' }))).toThrow()
  })
  it('enforces UTF-8 protocol value limits, not JavaScript character counts', () => {
    const chinese = '\u72b6'
    expect(sanitizeGameStatusPresence(input('#Direct', { details: chinese.repeat(85) })).values.details).toHaveLength(85)
    expect(() => sanitizeGameStatusPresence(input('#Direct', { details: chinese.repeat(86) }))).toThrow()
    const nineteen = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`value_${index}`, 'x']))
    expect(Object.keys(sanitizeGameStatusPresence(input('#Direct', nineteen)).values)).toHaveLength(19)
    expect(() => sanitizeGameStatusPresence(input('#Direct', { ...nineteen, extra: 'x' }))).toThrow()
  })
  it('rejects static cycles, missing dependencies, malformed instructions and oversized rendered results', () => {
    expect(gameStatusTemplatesFromTokens({ '#A': '{#B}', '#B': '{#A}' })).toEqual([])
    expect(gameStatusTemplatesFromTokens({ '#A': '{#Missing}' })).toEqual([])
    expect(gameStatusTemplatesFromTokens({ '#A': '{#Missing', '#B': '%bad-name%' })).toEqual([])
    const cyclic = { ...info(), templates: [{ token: '#A', text: '{#A}', parameters: [] }] }
    expect(() => validateGameStatusPresence(cyclic, input('#A', {}))).toThrow()
    expect(() => validateGameStatusPresence(info({ '#A': '%details%'.repeat(12) }), input('#A', { details: 'x'.repeat(255) }))).toThrow()
  })
  it('bounds catalog size and nesting rather than silently truncating required dependencies', () => {
    const tooMany = Object.fromEntries(Array.from({ length: GAME_STATUS_MAX_TEMPLATES + 1 }, (_, index) => [`#Token_${index}`, 'x']))
    expect(() => gameStatusTemplatesFromTokens(tooMany)).toThrow()
    const tooLarge = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`#Token_${index}`, 'x'.repeat(2000)]))
    expect(() => gameStatusTemplatesFromTokens(tooLarge)).toThrow()
    const deep = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`#Token_${index}`, index === 19 ? 'Done' : `{#Token_${index + 1}}`]))
    expect(gameStatusTemplatesFromTokens(deep).some(template => template.token === '#Token_0')).toBe(false)
  })
  it('does not trust renderer-provided parameters to authorize an extra field', () => {
    const forged = { ...info(), templates: [{ token: '#Direct', text: '%details%', parameters: ['details', 'unknown'] }] }
    expect(() => validateGameStatusPresence(forged, input('#Direct', { details: 'Ready', unknown: 'no' }))).toThrow()
  })
  it('matches adjacent dynamic parameters without catastrophic regex backtracking', () => {
    const parameters = Array.from({ length: 19 }, (_, index) => `%value_${index}%`).join('')
    const templates = gameStatusTemplatesFromTokens({ '#Dynamic': `{#${parameters}Z}`, [`#${'a'.repeat(120)}`]: 'Safe fixed text' })
    expect(templates.map(template => template.token)).toEqual([`#${'a'.repeat(120)}`])
    const tokens = { '#Dynamic': '{#Branch_%first%%second%}', '#Branch_ab': 'Two values', '#Branch_a': 'Too short' }
    expect(validateGameStatusPresence(info(tokens), input('#Dynamic', { first: 'a', second: 'b' })).preview).toBe('Two values')
    expect(() => validateGameStatusPresence(info(tokens), input('#Dynamic', { first: 'a', second: '' }))).toThrow()
  })
  it('accepts only official exact-hash app icon URLs for the same AppID', () => {
    expect(isSafeGameStatusIconUrl(ICON, APP)).toBe(true)
    expect(isSafeGameStatusIconUrl(ICON, 440)).toBe(false)
    for (const value of [ICON.replace('https:', 'http:'), ICON.replace('cdn.cloudflare.steamstatic.com', 'steamstatic.com.evil.test'), `${ICON}?x=1`, `${ICON}#x`, ICON.replace(HASH, '../icon'), ICON.replace('https://', 'https://user:pass@'), ICON.replace('.jpg', '.svg'), 'file:///D:/icon.jpg', 'data:image/svg+xml,x', null]) expect(isSafeGameStatusIconUrl(value)).toBe(false)
  })
})

describe('read-only game metadata and localization catalog', () => {
  function fixture(): GameStatusAppClient & { getProductInfo: ReturnType<typeof vi.fn>; getAppRichPresenceLocalization: ReturnType<typeof vi.fn> } {
    return { getProductInfo: vi.fn(async () => ({ apps: { [APP]: { appinfo: { common: { name: 'Synthetic Game', icon: HASH } } } } })), getAppRichPresenceLocalization: vi.fn(async () => ({ tokens: TABLE })) }
  }
  it('uses only the public SDK read APIs and preserves account checks', async () => {
    const client = fixture(); const assertCurrent = vi.fn()
    const result = await readGameStatusAppInfo(client, APP, 'english', assertCurrent)
    expect(result).toEqual(info())
    expect(client.getProductInfo).toHaveBeenCalledExactlyOnceWith([APP], [], true)
    expect(client.getAppRichPresenceLocalization).toHaveBeenCalledExactlyOnceWith(APP, 'english')
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(6)
  })
  it('supports localization without metadata and preserves metadata without localization capability', async () => {
    const result = await readGameStatusAppInfo({ getAppRichPresenceLocalization: async () => ({ tokens: { '#Ready': 'Ready' } }) }, APP, 'english', assertion)
    expect(result).toMatchObject({ appId: APP, name: `App ${APP}`, iconUrl: null })
    expect(await readGameStatusAppInfo({}, APP, 'english', assertion)).toEqual({ appId: APP, name: `App ${APP}`, iconUrl: null, language: 'english', templates: [], templateStatus: 'unavailable' })
    const client = fixture()
    const withoutLocalization = { getProductInfo: client.getProductInfo }
    expect(await readGameStatusAppInfo(withoutLocalization, APP, 'english', assertion)).toMatchObject({ name: 'Synthetic Game', iconUrl: ICON, templates: [], templateStatus: 'unavailable' })
  })
  it('keeps a valid catalog when metadata fails or targets another AppID', async () => {
    const client = fixture(); client.getProductInfo.mockRejectedValue(new Error('private-network-details-must-not-leak'))
    expect(await readGameStatusAppInfo(client, APP, 'english', assertion)).toMatchObject({ name: `App ${APP}`, iconUrl: null })
    client.getProductInfo.mockResolvedValue({ apps: { 440: { appinfo: { common: { name: 'Wrong Game', icon: HASH } } } } })
    expect(await readGameStatusAppInfo(client, APP, 'english', assertion)).toMatchObject({ name: `App ${APP}`, iconUrl: null })
  })
  it('does not accept remote URLs or malformed PICS icon hashes', async () => {
    const client = fixture()
    for (const icon of ['https://evil.test/image.png', `${HASH}/../x`, HASH.slice(1), null]) {
      client.getProductInfo.mockResolvedValue({ apps: { [APP]: { appinfo: { common: { name: 'Synthetic Game', icon } } } } })
      expect((await readGameStatusAppInfo(client, APP, 'english', assertion)).iconUrl).toBeNull()
    }
  })
  it('falls back to English only after a Chinese localization read fails', async () => {
    const client = fixture(); client.getAppRichPresenceLocalization.mockRejectedValueOnce(new Error('Language missing'))
    expect((await readGameStatusAppInfo(client, APP, 'schinese', assertion)).language).toBe('english')
    expect(client.getAppRichPresenceLocalization.mock.calls).toEqual([[APP, 'schinese'], [APP, 'english']])
  })
  it('treats an empty published catalog as unsupported, not a generic status template', async () => {
    const client = fixture(); client.getAppRichPresenceLocalization.mockResolvedValue({ tokens: {} })
    expect(await readGameStatusAppInfo(client, APP, 'english', assertion)).toMatchObject({ templates: [], templateStatus: 'empty' })
  })
  it('does not describe a malformed or unsafe nonempty catalog as an empty publication', async () => {
    const client = fixture(); client.getAppRichPresenceLocalization.mockResolvedValue({ tokens: { '#Unsafe': '%connect%' } })
    expect(await readGameStatusAppInfo(client, APP, 'english', assertion)).toMatchObject({ name: 'Synthetic Game', iconUrl: ICON, templates: [], templateStatus: 'unavailable' })
  })
  it('does not leak lookup errors or malformed RPC responses', async () => {
    const client = fixture(); client.getAppRichPresenceLocalization.mockResolvedValue({ wrong: TABLE })
    expect(await readGameStatusAppInfo(client, APP, 'english', assertion)).toMatchObject({ name: 'Synthetic Game', iconUrl: ICON, templates: [], templateStatus: 'unavailable' })
    client.getAppRichPresenceLocalization.mockRejectedValue(new Error('FAKE-secret-error'))
    const result = await readGameStatusAppInfo(client, APP, 'english', assertion)
    expect(result).toMatchObject({ name: 'Synthetic Game', iconUrl: ICON, templates: [], templateStatus: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('FAKE-secret-error')
  })
  it('rejects invalid AppIDs and languages before calling the SDK', async () => {
    const client = fixture()
    for (const appId of [0, -1, 1.5, Number.NaN, 0x1000000]) await expect(readGameStatusAppInfo(client, appId, 'english', assertion)).rejects.toThrow()
    await expect(readGameStatusAppInfo(client, APP, 'invalid' as 'english', assertion)).rejects.toThrow()
    expect(client.getProductInfo).not.toHaveBeenCalled(); expect(client.getAppRichPresenceLocalization).not.toHaveBeenCalled()
  })
  it('abandons stale metadata before requesting localization', async () => {
    const client = fixture(); let active = true
    client.getProductInfo.mockImplementation(async () => { active = false; return {} })
    await expect(readGameStatusAppInfo(client, APP, 'english', () => { if (!active) throw new Error('Stale account') })).rejects.toThrow('Stale account')
    expect(client.getAppRichPresenceLocalization).not.toHaveBeenCalled()
  })
  it('does not fall back or return a response after account identity changes during localization', async () => {
    const client = fixture(); let active = true
    client.getAppRichPresenceLocalization.mockImplementation(async () => { active = false; return { tokens: TABLE } })
    await expect(readGameStatusAppInfo(client, APP, 'schinese', () => { if (!active) throw new Error('Stale session') })).rejects.toThrow('Stale session')
    expect(client.getAppRichPresenceLocalization).toHaveBeenCalledTimes(1)
  })
  it('bounds metadata waits, then continues only with fallback metadata', async () => {
    vi.useFakeTimers(); const client = fixture(); client.getProductInfo.mockImplementation(() => new Promise(() => {}))
    const result = readGameStatusAppInfo(client, APP, 'english', assertion)
    await vi.advanceTimersByTimeAsync(GAME_STATUS_APP_LOOKUP_TIMEOUT_MS)
    expect(await result).toMatchObject({ name: `App ${APP}`, iconUrl: null })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a hung localization wait without retaining its timer', async () => {
    vi.useFakeTimers(); const client = fixture(); client.getAppRichPresenceLocalization.mockImplementation(() => new Promise(() => {}))
    const pending = readGameStatusAppInfo(client, APP, 'english', assertion)
    await vi.advanceTimersByTimeAsync(GAME_STATUS_APP_LOOKUP_TIMEOUT_MS)
    expect(await pending).toMatchObject({ name: 'Synthetic Game', iconUrl: ICON, templates: [], templateStatus: 'unavailable' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
