import { describe, expect, it } from 'vitest'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'
import { gameStatusPresenceParameterHints, gameStatusTemplatesFromTokens, sanitizeGameStatusPresence, validateGameStatusPresence } from '../src/shared/game-status-presence'

const info = (catalog: Record<string, string>): GameStatusAppInfo => ({ appId: 440, name: 'Synthetic catalog', iconUrl: null, language: 'english', templates: gameStatusTemplatesFromTokens(catalog), templateStatus: 'available' })
const input = (displayToken: string, values: Record<string, string> = {}): GameStatusPresence => ({ displayToken, values })

describe('generic rich-presence graph semantics', () => {
  it('isolates missing, private, cyclic and oversized siblings from a safe dynamic branch', () => {
    const catalog = {
      '#Display': '{#State_%state%}', '#State_Good': 'Playing %map%', '#State_Private': '%server%',
      '#State_Cycle': '{#State_Cycle}', '#State_Missing': '{#Absent}', '#State_Deep': '{#D0}',
      ...Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`#D${index}`, index === 13 ? 'End' : `{#D${index + 1}}`]))
    }
    const data = info(catalog)
    expect(data.templates.find(template => template.token === '#Display')?.parameters).toEqual(['map', 'state'])
    expect(validateGameStatusPresence(data, input('#Display', { state: 'Good', map: 'map_1' })).preview).toBe('Playing map_1')
    expect(gameStatusPresenceParameterHints(data, input('#Display')).find(hint => hint.key === 'state')?.options).toEqual([{ value: 'Good', label: 'Playing %map%' }])
    for (const state of ['Private', 'Cycle', 'Missing', 'Deep']) expect(() => validateGameStatusPresence(data, input('#Display', { state }))).toThrow()
  })

  it('authorizes values only from the branch actually selected, not the catalog union', () => {
    const data = info({ '#Display': '{#State_%state%}', '#State_Menu': 'Menu', '#State_Play': '%map%' })
    expect(data.templates.find(template => template.token === '#Display')?.parameters).toEqual(['map', 'state'])
    expect(() => validateGameStatusPresence(data, input('#Display', { state: 'Menu', map: 'stale' }))).toThrow()
    expect(validateGameStatusPresence(data, input('#Display', { state: 'Menu' })).preview).toBe('Menu')
  })

  it('does not use an impossible repeated-variable token to authorize an unsafe branch', () => {
    const data = info({ '#Display': '{#Repeat_%mode%_%mode%}', '#Repeat_A_A': 'Ready', '#Repeat_A_B': '%server%' })
    expect(data.templates.find(template => template.token === '#Display')?.parameters).toEqual(['mode'])
    expect(validateGameStatusPresence(data, input('#Display', { mode: 'A' })).preview).toBe('Ready')
    expect(gameStatusPresenceParameterHints(data, input('#Display'))[0]?.options).toEqual([{ value: 'A', label: 'Ready' }])
  })

  it('allows empty or whitespace fragments inside nonempty composed results', () => {
    const data = info({ '#Display': 'A{#Empty}{#Space}B', '#Empty': '', '#Space': ' ' })
    expect(validateGameStatusPresence(data, input('#Display')).preview).toBe('A B')
    for (const token of ['#Empty', '#Space']) expect(() => validateGameStatusPresence(data, input(token))).toThrow()
  })

  it('treats unsupported percent and brace forms as text, while resolving legal directives', () => {
    const text = '100% %bad-name% {#bad token} {#} {#incomplete {literal} %123:key% / {#State:Ready.v-2}'
    const data = info({ '#Display.v-1:Ready': text, '#State:Ready.v-2': 'Done' })
    expect(validateGameStatusPresence(data, input('#Display.v-1:Ready', { '123:key': 'Value' })).preview).toBe('100% %bad-name% {#bad token} {#} {#incomplete {literal} Value / Done')
  })

  it('projects viable initial domains and narrows them without taking a cross-product', () => {
    const data = info({ '#Display': '{#Pair_%region%_%mode%}', '#Pair_EU_Ranked': 'EU ranked', '#Pair_US_Casual': 'US casual', '#Pair_EU_Private': '%session%' })
    const initial = gameStatusPresenceParameterHints(data, input('#Display'))
    expect(initial.find(hint => hint.key === 'region')?.options.map(option => option.value)).toEqual(['EU', 'US'])
    expect(initial.find(hint => hint.key === 'mode')?.options.map(option => option.value)).toEqual(['Casual', 'Ranked'])
    expect(gameStatusPresenceParameterHints(data, input('#Display', { region: 'EU' })).find(hint => hint.key === 'mode')?.options.map(option => option.value)).toEqual(['Ranked'])
    expect(() => validateGameStatusPresence(data, input('#Display', { region: 'EU', mode: 'Casual' }))).toThrow()
  })

  it('keeps template and literal field Unicode well formed at UTF-8 boundaries', () => {
    expect(info({ '#Broken': 'bad\uD800', '#Good': '遊戲 😀 %desc%' }).templates.map(template => template.token)).toEqual(['#Good'])
    for (const value of ['\uD800', '\uDC00', 'a\uD800b', '\uDC00\uD800']) expect(() => sanitizeGameStatusPresence(input('#Good', { desc: value }))).toThrow()
    expect(validateGameStatusPresence(info({ '#Good': '%desc%' }), input('#Good', { desc: '😀'.repeat(63) })).preview).toBe('😀'.repeat(63))
  })

  it('bounds ambiguous matching over many adjacent unknowns instead of blocking the event loop', () => {
    const variables = Array.from({ length: 19 }, (_, index) => `%key_${index}%`).join('')
    const data = info({ '#Display': `{#P_${variables}_tail}`, [`#P_${'a'.repeat(100)}_tail`]: 'Published' })
    expect(() => gameStatusPresenceParameterHints(data, input('#Display'))).not.toThrow()
    expect(gameStatusPresenceParameterHints(data, input('#Display')).every(hint => hint.options.length <= 64)).toBe(true)
  })
})
