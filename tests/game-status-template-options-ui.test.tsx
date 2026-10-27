import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'
import { gameStatusTemplatesFromTokens } from '../src/shared/game-status-presence'
import { GameStatusTemplateEditor, gameStatusPresenceResult } from '../src/renderer/src/components/GameStatusPanel'

vi.stubGlobal('React', React)
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: 'en', t: (_zh: string, en: string) => en }) }))
afterAll(() => vi.unstubAllGlobals())

const info: GameStatusAppInfo = { appId: 730, name: 'Synthetic catalog', iconUrl: null, language: 'english',
  templates: gameStatusTemplatesFromTokens({
    '#display_GameWkshpMap': '{#gamemode_%game:mode%} - Workshop map',
    '#gamemode_competitive': 'Competitive', '#gamemode_casual': 'Casual',
    '#Direct': '%desc%', '#State': '{#state_%state%}',
    '#state_Menu': 'Main menu', '#state_Playing': 'Playing %map%'
  }), templateStatus: 'available' }
const elements = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap(elements) : [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
function fixture(presence: GameStatusPresence, disabled = false) {
  const onChange = vi.fn()
  const root = GameStatusTemplateEditor({ info, presence, disabled, onChange, id: 'options' })
  const control = (id: string) => elements(root).find(node => node.props.id === id)!.props
  return { root, onChange, control, html: renderToStaticMarkup(root) }
}

describe('published parameter selection UI', () => {
  it('lists actual submitted enum values with their published display labels', () => {
    const f = fixture({ displayToken: '#display_GameWkshpMap', values: { 'game:mode': 'casual' } })
    expect(f.html).toContain('casual — Casual')
    expect(f.html).toContain('competitive — Competitive')
    expect(f.html).toContain('Published choices')
    expect(f.html).toContain('Casual - Workshop map')
    expect(f.control('options-parameter-0').value).toBe('casual')
    expect(f.html).not.toContain('<input')
  })

  it('preserves an invalid old value visibly and explains why it cannot update', () => {
    const f = fixture({ displayToken: '#display_GameWkshpMap', values: { 'game:mode': 'abcd' } })
    expect(f.html).toContain('Invalid value: abcd')
    expect(f.html).toContain('This value is not in the published list')
    expect(f.html).toContain('choose a published value from the dropdown for')
    expect(f.control('options-parameter-0')['aria-invalid']).toBe(true)
    expect(f.onChange).not.toHaveBeenCalled()
  })

  it('emits the raw option value, not its display label, and then validates successfully', () => {
    const f = fixture({ displayToken: '#display_GameWkshpMap', values: { 'game:mode': 'abcd' } })
    f.control('options-parameter-0').onChange({ target: { value: 'competitive' } })
    const next = f.onChange.mock.calls[0]![0]
    expect(next).toEqual({ displayToken: '#display_GameWkshpMap', values: { 'game:mode': 'competitive' } })
    expect(gameStatusPresenceResult(info, next)).toEqual({ valid: true, preview: 'Competitive - Workshop map' })
  })

  it('keeps genuinely free text editable rather than guessing an enum', () => {
    const f = fixture({ displayToken: '#Direct', values: { desc: 'Custom text' } })
    expect(f.html).toContain('Free text, up to 255 UTF-8 bytes')
    expect(f.html).toContain('<input')
    f.control('options-parameter-0').onChange({ target: { value: 'Another text' } })
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith({ displayToken: '#Direct', values: { desc: 'Another text' } })
  })

  it.each(['%map%', 'x'.repeat(256)])('keeps an invalid text field visible so it can be corrected: %s', value => {
    const f = fixture({ displayToken: '#Direct', values: { desc: value } })
    expect(f.html).toContain('Not renderable yet')
    expect(f.control('options-parameter-0').value).toBe(value)
    f.control('options-parameter-0').onChange({ target: { value: 'Corrected' } })
    expect(gameStatusPresenceResult(info, f.onChange.mock.calls[0]![0])).toEqual({ valid: true, preview: 'Corrected' })
  })

  it('uses published token and option spelling for case-insensitive old drafts', () => {
    const f = fixture({ displayToken: '#DISPLAY_GAMEWKSHPMAP', values: { 'GAME:MODE': 'CASUAL' } })
    expect(f.control('options-template').value).toBe('#display_GameWkshpMap')
    expect(f.control('options-parameter-0').value).toBe('casual')
    expect(f.html).not.toContain('Invalid value')
  })

  it('does not silently show Game only for a missing old template', () => {
    const f = fixture({ displayToken: '#Removed', values: {} })
    expect(f.html).toContain('Previous template unavailable; select another')
    expect(f.html).toContain('the previous template is unavailable')
    expect(f.control('options-template').value).toBe('#Removed')
    expect(f.onChange).not.toHaveBeenCalled()
  })

  it('changes branch fields only when the user selects a branch and removes stale branch values', () => {
    const f = fixture({ displayToken: '#State', values: { state: 'Playing', map: 'Fixture' } })
    const state = elements(f.root).find(node => node.type === 'select' && node.props.id !== 'options-template')!
    state.props.onChange({ target: { value: 'Menu' } })
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith({ displayToken: '#State', values: { state: 'Menu' } })
    const menu = fixture(f.onChange.mock.calls[0]![0])
    expect(menu.html).not.toContain('Free text')
    expect(menu.html).toContain('Main menu')
  })

  it('does not mutate the draft while controls are disabled, even via direct callbacks', () => {
    const f = fixture({ displayToken: '#display_GameWkshpMap', values: { 'game:mode': 'casual' } }, true)
    f.control('options-parameter-0').onChange({ target: { value: 'competitive' } })
    f.control('options-template').onChange({ target: { value: '#Direct' } })
    expect(f.onChange).not.toHaveBeenCalled()
  })
})
