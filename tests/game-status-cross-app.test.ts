import { describe, expect, it, vi } from 'vitest'
import { readGameStatusAppInfo } from '../src/main/game-status-apps'
import { gameStatusPresenceParameterHints, validateGameStatusPresence } from '../src/shared/game-status-presence'

const appIds = Array.from({ length: 12 }, (_, index) => 1 + ((index + 17) * 104729) % 0xffffff)
type Catalog = Record<string, string>

async function lookup(appId: number, preferred: Catalog, english: Catalog = preferred, language: 'schinese' | 'english' = 'english') {
  const getAppRichPresenceLocalization = vi.fn(async (_app: number, requested: string) => ({ tokens: requested === 'english' ? english : preferred }))
  const info = await readGameStatusAppInfo({ getAppRichPresenceLocalization }, appId, language, () => {})
  expect(getAppRichPresenceLocalization.mock.calls.every(([requestedApp]) => requestedApp === appId)).toBe(true)
  expect(info.appId).toBe(appId)
  return info
}

describe.each(appIds)('AppID-independent template compatibility (%i)', appId => {
  it('accepts large catalogs through the shared lookup without an AppID exception', async () => {
    const catalog = Object.fromEntries(Array.from({ length: 320 }, (_, index) => [`#Entry_${index}`, `Synthetic entry ${index}`]))
    const info = await lookup(appId, catalog)
    expect(info.templateStatus).toBe('available')
    expect(info.templates).toHaveLength(320)
    expect(validateGameStatusPresence(info, { displayToken: '#Entry_319', values: {} }).preview).toBe('Synthetic entry 319')
  })

  it('fills an empty preferred language and missing dependencies from English', async () => {
    const english = { '#Display': '{#Map_%mapid%} %minutes%', '#Map_A': 'Synthetic map' }
    const empty = await lookup(appId, {}, english, 'schinese')
    expect(empty.templateDiagnostics?.usedEnglishFallback).toBe(true)
    expect(validateGameStatusPresence(empty, { displayToken: '#Display', values: { mapid: 'A', minutes: '8' } }).preview).toBe('Synthetic map 8')
    const mixed = await lookup(appId, { '#Display': 'Preferred {#Map_%mapid%} %minutes%' }, english, 'schinese')
    expect(mixed.templateDiagnostics?.sourceLanguage).toBe('mixed')
    expect(validateGameStatusPresence(mixed, { displayToken: '#Display', values: { mapid: 'A', minutes: '8' } }).preview).toBe('Preferred Synthetic map 8')
  })

  it('isolates unsafe and cyclic branches without disabling a safe sibling', async () => {
    const catalog = { '#Display': '{#Mode_%mode%}', '#Mode_Menu': 'Synthetic menu', '#Mode_Join': '%lobby%', '#Mode_Cycle': '{#Mode_Cycle}' }
    const info = await lookup(appId, catalog)
    expect(info.templates.some(template => template.token === '#Display')).toBe(true)
    expect(validateGameStatusPresence(info, { displayToken: '#Display', values: { mode: 'Menu' } }).preview).toBe('Synthetic menu')
    for (const mode of ['Join', 'Cycle']) expect(() => validateGameStatusPresence(info, { displayToken: '#Display', values: { mode } })).toThrow()
  })

  it('offers initial choices for several unknown variables and enforces their combinations', async () => {
    const info = await lookup(appId, { '#Display': '{#State_%region%_%mode%}', '#State_EU_Menu': 'EU menu', '#State_EU_Match': 'EU match', '#State_US_Menu': 'US menu' })
    const initial = gameStatusPresenceParameterHints(info, { displayToken: '#Display', values: {} })
    expect(initial.find(hint => hint.key === 'region')?.options.map(option => option.value.toLowerCase()).sort()).toEqual(['eu', 'us'])
    expect(initial.find(hint => hint.key === 'mode')?.options.map(option => option.value.toLowerCase()).sort()).toEqual(['match', 'menu'])
    const selected = gameStatusPresenceParameterHints(info, { displayToken: '#Display', values: { region: 'US' } })
    expect(selected.find(hint => hint.key === 'mode')?.options.map(option => option.value.toLowerCase())).toEqual(['menu'])
    expect(validateGameStatusPresence(info, { displayToken: '#Display', values: { region: 'US', mode: 'Menu' } }).preview).toBe('US menu')
    expect(() => validateGameStatusPresence(info, { displayToken: '#Display', values: { region: 'US', mode: 'Match' } })).toThrow()
  })

  it('honors repeated variables instead of matching impossible sibling names', async () => {
    const info = await lookup(appId, { '#Display': '{#Pair_%mode%_%mode%}', '#Pair_A_A': 'Equal values', '#Pair_A_B': '%connect%' })
    expect(validateGameStatusPresence(info, { displayToken: '#Display', values: { mode: 'A' } }).preview).toBe('Equal values')
    expect(gameStatusPresenceParameterHints(info, { displayToken: '#Display', values: {} }).find(hint => hint.key === 'mode')?.options.map(option => option.value.toLowerCase())).toEqual(['a'])
  })

  it('preserves literal text and whitespace references with supported transport grammar', async () => {
    const info = await lookup(appId, { '#State:Menu.Ready-1': 'Before{#Space}After %not-a-key% %1score%', '#Space': ' ' })
    expect(validateGameStatusPresence(info, { displayToken: '#State:Menu.Ready-1', values: { '1score': '9' } }).preview).toBe('Before After %not-a-key% 9')
  })

  it('does not depend on dictionary insertion order or token capitalization', async () => {
    const catalog = { '#Display': '{#Mode_%mode%}', '#Mode_Menu': 'Menu', '#Mode_Unsafe': '%server%' }
    const first = await lookup(appId, catalog)
    const reordered = Object.fromEntries(Object.entries(catalog).reverse().map(([key, value]) => [key.toUpperCase(), value]))
    const second = await lookup(appId, reordered)
    for (const info of [first, second]) expect(validateGameStatusPresence(info, { displayToken: '#display', values: { mode: 'menu' } }).preview).toBe('Menu')
  })
})
