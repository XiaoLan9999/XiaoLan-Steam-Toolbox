import { describe, expect, it } from 'vitest'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'
import { GAME_STATUS_MAX_TEMPLATES, gameStatusPresenceParameterHints, gameStatusTemplatesFromTokens, validateGameStatusPresence } from '../src/shared/game-status-presence'

const info = (catalog: Record<string, string>): GameStatusAppInfo => ({ appId: 730, name: 'Published fixture', iconUrl: null, language: 'schinese', templates: gameStatusTemplatesFromTokens(catalog), templateStatus: 'available' })
const input = (displayToken: string, values: Record<string, string> = {}): GameStatusPresence => ({ displayToken, values })
const hints = (catalog: Record<string, string>, displayToken: string, values: Record<string, string> = {}) => gameStatusPresenceParameterHints(info(catalog), input(displayToken, values))

describe('published rich-presence parameter candidates', () => {
  it('derives a game-mode selector from published tokens instead of accepting arbitrary text', () => {
    const catalog = { '#display_GameWkshpMap': '{#gamemode_%game:mode%} - workshop map', '#gamemode_casual': 'Casual', '#gamemode_competitive': 'Competitive' }
    const result = hints(catalog, '#display_GameWkshpMap', { 'game:mode': 'abcd' })
    expect(result).toEqual([{ key: 'game:mode', kind: 'choice', options: [{ value: 'casual', label: 'Casual' }, { value: 'competitive', label: 'Competitive' }] }])
    expect(() => validateGameStatusPresence(info(catalog), input('#display_GameWkshpMap', { 'game:mode': 'abcd' }))).toThrow()
    for (const option of result[0]!.options) expect(validateGameStatusPresence(info(catalog), input('#display_GameWkshpMap', { 'game:mode': option.value })).preview).toContain(option.label)
  })
  it('keeps plain text separate from a finite published enum', () => {
    expect(hints({ '#Display': '%details% on %currentmap%' }, '#Display')).toEqual([
      { key: 'currentmap', kind: 'text', options: [] }, { key: 'details', kind: 'text', options: [] }
    ])
  })
  it('preserves published value spelling and normalizes token/parameter lookups', () => {
    expect(hints({ '#Display': '{#STATE_%State%}', '#state_Menu': 'At menu', '#State_PLAYING': 'Playing' }, '#DISPLAY', { STATE: 'menu' })).toEqual([
      { key: 'state', kind: 'choice', options: [{ value: 'Menu', label: 'At menu' }, { value: 'PLAYING', label: 'Playing' }] }
    ])
  })
  it('extracts the full suffix between fixed prefix/suffix, including underscores', () => {
    const result = hints({ '#Display': '{#mode_%mode%_label}', '#mode_Death_Match_label': 'Deathmatch', '#mode_0_label': 'Zero' }, '#Display')
    expect(result[0]!.options).toEqual([{ value: '0', label: 'Zero' }, { value: 'Death_Match', label: 'Deathmatch' }])
  })
  it('enforces identical repeated parameters rather than independent wildcard captures', () => {
    const catalog = { '#Display': '{#repeat_%mode%_%MODE%_end}', '#repeat_Menu_menu_end': 'Menu', '#repeat_a_b_end': 'Impossible split', '#repeat_long_name_long_name_end': 'Long' }
    expect(hints(catalog, '#Display')[0]!.options).toEqual([{ value: 'long_name', label: 'Long' }, { value: 'Menu', label: 'Menu' }])
    expect(() => validateGameStatusPresence(info(catalog), input('#Display', { mode: 'a' }))).toThrow()
  })
  it('supports adjacent repeats without backtracking over possible splits', () => {
    expect(hints({ '#Display': '{#repeat_%mode%%mode%}', '#repeat_abab': 'AB', '#repeat_abcd': 'No' }, '#Display')[0]!.options).toEqual([{ value: 'ab', label: 'AB' }])
  })
  it('intersects the candidate domain across multiple dynamic references', () => {
    const catalog = { '#Display': '{#mode_%mode%} / {#icon_%mode%}', '#mode_A': 'Mode A', '#mode_B': 'Mode B', '#icon_b': 'Icon B', '#icon_C': 'Icon C' }
    expect(hints(catalog, '#Display')[0]!.options).toEqual([{ value: 'B', label: 'Mode B' }])
  })
  it('does not turn incompatible dynamic constraints into free text', () => {
    const catalog = { '#Display': '{#one_%mode%} {#two_%mode%}', '#one_A': 'One', '#two_B': 'Two' }
    expect(hints(catalog, '#Display')).toEqual([{ key: 'mode', kind: 'choice', options: [] }])
  })
  it('derives dependent enums using the current known values of the other parameters', () => {
    const catalog = { '#Display': '{#mode_%region%_%mode%_label}', '#mode_EU_Ranked_label': 'EU ranked', '#mode_EU_Casual_label': 'EU casual', '#mode_US_Casual_label': 'US casual' }
    const result = hints(catalog, '#Display', { REGION: 'eu', mode: 'casual' })
    expect(result).toEqual([
      { key: 'mode', kind: 'choice', options: [{ value: 'Casual', label: 'EU casual' }, { value: 'Ranked', label: 'EU ranked' }] },
      { key: 'region', kind: 'choice', options: [{ value: 'EU', label: 'EU casual' }, { value: 'US', label: 'US casual' }] }
    ])
  })
  it('projects bounded initial choices for multiple unknown parameters', () => {
    const catalog = { '#Display': '{#mode_%region%_%mode%}', '#mode_EU_Ranked': 'Ranked', '#mode_US_Casual': 'Casual' }
    expect(hints(catalog, '#Display')).toEqual([
      { key: 'mode', kind: 'dependent', options: [{ value: 'Casual', label: 'Casual' }, { value: 'Ranked', label: 'Ranked' }] },
      { key: 'region', kind: 'dependent', options: [{ value: 'EU', label: 'Ranked' }, { value: 'US', label: 'Casual' }] }
    ])
    expect(hints(catalog, '#Display', { region: 'not_published', mode: 'Ranked' }).find(hint => hint.key === 'mode')?.kind).toBe('dependent')
    expect(hints(catalog, '#Display', { region: 'not a token', mode: 'Ranked' }).find(hint => hint.key === 'mode')?.kind).toBe('dependent')
  })
  it('preserves repeat equality with other known parameters mixed into the reference', () => {
    const catalog = { '#Display': '{#p_%region%_%mode%_%region%_%mode%}', '#p_EU_Casual_eu_casual': 'Repeated', '#p_EU_Casual_US_Casual': 'Not consistent' }
    expect(hints(catalog, '#Display', { region: 'eu' }).find(hint => hint.key === 'mode')?.options).toEqual([{ value: 'Casual', label: 'Repeated' }])
  })
  it('shows only the currently selected branch rather than every reachable branch parameter', () => {
    const catalog = { '#Display': '{#State_%state%}', '#State_Menu': 'Main menu', '#State_Playing': '%currentmap% %score%' }
    expect(hints(catalog, '#Display', { state: 'Menu', currentmap: 'old', score: 'old' }).map(hint => hint.key)).toEqual(['state'])
    expect(hints(catalog, '#Display', { state: 'Playing' }).map(hint => hint.key)).toEqual(['currentmap', 'score', 'state'])
    expect(hints(catalog, '#Display', { state: 'Unknown' }).map(hint => hint.key)).toEqual(['state'])
  })
  it('collects enums behind static references and labels nested published references', () => {
    const catalog = { '#Display': '{#Static}', '#Static': '{#Mode_%mode%}', '#Mode_Ranked': '{#RankedName}', '#RankedName': 'Published localized name' }
    expect(hints(catalog, '#Display')).toEqual([{ key: 'mode', kind: 'choice', options: [{ value: 'Ranked', label: 'Published localized name' }] }])
  })
  it('renders candidate labels with actual known text context and never interpolates as instructions', () => {
    const catalog = { '#Display': '{#Mode_%mode%}', '#Mode_A': '%details%' }
    expect(hints(catalog, '#Display', { details: '$& $1 $$' }).find(hint => hint.key === 'mode')?.options).toEqual([{ value: 'A', label: '$& $1 $$' }])
    expect(hints(catalog, '#Display', { details: '{#Injected}' }).find(hint => hint.key === 'mode')?.options).toEqual([{ value: 'A', label: '%details%' }])
  })
  it('does not invent a label when a candidate needs another missing field', () => {
    const catalog = { '#Display': '{#Mode_%mode%}', '#Mode_A': '%details%' }
    expect(hints(catalog, '#Display').find(hint => hint.key === 'mode')?.options).toEqual([{ value: 'A', label: '%details%' }])
  })
  it('filters a candidate that cannot reach a nested same-parameter published token', () => {
    const catalog = { '#Display': '{#State_%state%}', '#State_A': '{#Label_%state%}', '#State_B': 'B', '#Label_B': 'Only B exists' }
    expect(hints(catalog, '#Display')[0]!.options).toEqual([{ value: 'B', label: 'B' }])
  })
  it('is read-only and keeps the existing strict validator unchanged', () => {
    const data = info({ '#Display': '{#Mode_%mode%}', '#Mode_A': 'Mode A' }); const draft = input('#Display', { mode: 'bad' })
    const before = JSON.stringify({ data, draft }); gameStatusPresenceParameterHints(data, draft)
    expect(JSON.stringify({ data, draft })).toBe(before)
    expect(() => validateGameStatusPresence(data, draft)).toThrow()
  })
  it.each(['%map%', '{#Injected}', 'x'.repeat(256), '状'.repeat(86)])('keeps invalid free text editable without accepting it: %s', value => {
    const data = info({ '#Display': '%desc%' }); const draft = input('#Display', { desc: value })
    expect(gameStatusPresenceParameterHints(data, draft)).toEqual([{ key: 'desc', kind: 'text', options: [] }])
    expect(() => validateGameStatusPresence(data, draft)).toThrow()
  })
  it.each([null, {}, { displayToken: '#Display', values: [] }, { displayToken: '#Display', values: { mode: 'a', MODE: 'b' } }, { displayToken: '#Display', values: { 'connect': 'private' } }])('does not throw on an unknown or damaged draft: %j', draft => {
    expect(() => gameStatusPresenceParameterHints(info({ '#Display': '%mode%' }), draft as unknown as GameStatusPresence)).not.toThrow()
    expect(gameStatusPresenceParameterHints(info({ '#Display': '%mode%' }), draft as unknown as GameStatusPresence)).toEqual([])
  })
  it('bounds malformed, cyclic and oversized catalogs before offering values', () => {
    const bad = { ...info({ '#Valid': 'Valid' }), templates: [{ token: '#Display', text: '{#Display}', parameters: [] }] }
    expect(gameStatusPresenceParameterHints(bad, input('#Display'))).toEqual([])
    const oversized = { ...bad, templates: Array.from({ length: GAME_STATUS_MAX_TEMPLATES + 1 }, (_, n) => ({ token: `#T${n}`, text: 'x', parameters: [] })) }
    expect(gameStatusPresenceParameterHints(oversized, input('#T0'))).toEqual([])
  })
  it('handles a bounded catalog of many long, repeated reference candidates without exponential matching', () => {
    const catalog: Record<string, string> = { '#Display': '{#p_%mode%_%mode%_%mode%_%mode%_tail}' }
    for (let i = 0; i < 400; i++) catalog[`#p_${i}_${i}_${i}_${i}_tail`] = `Mode ${i}`
    const result = hints(catalog, '#Display')
    expect(result).toHaveLength(1); expect(result[0]!.kind).toBe('choice'); expect(result[0]!.options).toHaveLength(400)
  })
})
