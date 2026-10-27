import { describe, expect, it } from 'vitest'
import { validateExperimentalPresence } from '../src/shared/local-app-experimental'

describe('explicit experimental local-app presence validation', () => {
  it('canonicalizes public fields into an independent null-prototype record', () => {
    const source = { STEAM_DISPLAY: '#Status_Game.Mode-1:Live', DeSc: 'Playing now', status: 'Public text' }
    const result = validateExperimentalPresence(source)
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect({ ...result }).toEqual({ steam_display: '#Status_Game.Mode-1:Live', desc: 'Playing now', status: 'Public text' })
    expect(source).toEqual({ STEAM_DISPLAY: '#Status_Game.Mode-1:Live', DeSc: 'Playing now', status: 'Public text' })
  })
  it('accepts a null-prototype input and public match-group labels', () => {
    const value = Object.assign(Object.create(null), { matchgrouploc: 'Casual' }) as Record<string, string>
    expect({ ...validateExperimentalPresence(value) }).toEqual({ matchgrouploc: 'Casual' })
  })
  it.each([undefined, null, true, 1, 'text', [], new Date(), Object.create({ desc: 'Inherited' }), {}])('rejects non-plain or empty input %j', value => {
    expect(() => validateExperimentalPresence(value)).toThrow()
  })
  it('reserves exactly two group fields when requested, without truncation', () => {
    const fields = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, 'value']))
    expect(Object.keys(validateExperimentalPresence(fields(20)))).toHaveLength(20)
    expect(Object.keys(validateExperimentalPresence(fields(18), 2))).toHaveLength(18)
    expect(() => validateExperimentalPresence(fields(21))).toThrow()
    expect(() => validateExperimentalPresence(fields(19), 2)).toThrow()
    for (const reserved of [-1, 1, 3, 0.5, Number.NaN, Infinity, '2', null]) expect(() => validateExperimentalPresence(fields(1), reserved as number)).toThrow()
  })
  it.each(['connect', 'connectinfo', 'joinGame', 'lobby', 'session', 'password', 'auth_token', 'secret', 'ticket', 'credential', 'steam_player_group', 'steam_player_group_size', 'groupid', 'party', 'invite', 'steamid', 'userid', 'server', 'server:ip', 'server:port', 'url', 'endpoint', 'private', 'privateData', '__proto__', 'constructor', 'prototype'])('rejects private or protected key %s', key => {
    const value = Object.create(null) as Record<string, string>
    value[key] = 'DO-NOT-SUBMIT'
    expect(() => validateExperimentalPresence(value)).toThrow()
  })
  it.each(['room', 'RoomId', 'roomid', 'room_id', 'room:id', 'current_room', 'game:roomid', 'currentRoomId', 'RoomName', 'roomcode', 'room:key', 'room_number', 'room_address', 'serverName', 'current_session', 'version', 'Version'])('rejects room and native-host sensitive key %s', key => {
    expect(() => validateExperimentalPresence({ [key]: 'DO-NOT-SUBMIT' })).toThrow()
  })
  it('does not confuse public map or scene labels with room identifiers', () => {
    expect({ ...validateExperimentalPresence({ map: 'map_a', mapid: '2201', scene: 'MainMenu', scene_name: 'Public display', mushroom: 'Literal label' }) }).toEqual({ map: 'map_a', mapid: '2201', scene: 'MainMenu', scene_name: 'Public display', mushroom: 'Literal label' })
  })
  it('rejects case aliases and keys outside the bounded ASCII grammar', () => {
    expect(() => validateExperimentalPresence({ desc: 'a', DESC: 'b' })).toThrow()
    expect(() => validateExperimentalPresence({ steam_display: '#A', STEAM_DISPLAY: '#A' })).toThrow()
    for (const key of ['a'.repeat(63), '1field', '_field', ':field']) expect(Object.keys(validateExperimentalPresence({ [key]: 'value' }))).toHaveLength(1)
    for (const key of ['a'.repeat(64), '', 'has-dash', 'has.dot', 'space key', '汉字', 'key\0name']) expect(() => validateExperimentalPresence({ [key]: 'value' })).toThrow()
  })
  it('enforces UTF-8 value bytes, not UTF-16 length', () => {
    expect(validateExperimentalPresence({ desc: 'a'.repeat(255) }).desc).toHaveLength(255)
    expect(validateExperimentalPresence({ desc: '状'.repeat(85) }).desc).toHaveLength(85)
    expect(validateExperimentalPresence({ desc: '😀'.repeat(63) }).desc).toHaveLength(126)
    for (const value of ['a'.repeat(256), '状'.repeat(86), '😀'.repeat(64)]) expect(() => validateExperimentalPresence({ desc: value })).toThrow()
  })
  it.each(['', null, 1, false, [], {}, '\0', 'line\nbreak', '\t', '\r', '\u0085', '\u2028', '\u2029', '\uD800', '\uDC00', 'a\uD800b', '\uDC00\uD800'])('rejects empty, non-string or invalid Unicode text %j', value => {
    expect(() => validateExperimentalPresence({ desc: value })).toThrow()
  })
  it('treats display token syntax separately from literal public text', () => {
    expect(validateExperimentalPresence({ steam_display: '#' + 'a'.repeat(127) }).steam_display).toHaveLength(128)
    for (const token of ['#', 'Status_Game', '#Has space', '#中文', '#A{#B}', '#A%mode%', '#' + 'a'.repeat(128), '#' + 'a'.repeat(255)]) expect(() => validateExperimentalPresence({ steam_display: token })).toThrow()
    expect(validateExperimentalPresence({ desc: 'Literal 100% and {braces}' }).desc).toBe('Literal 100% and {braces}')
  })
  it.each(['%desc%', 'Prefix %MapId%', '{#InGame}', '{#InGame_%desc%}'])('does not interpret experimental parameter values as template programs: %s', value => {
    expect(() => validateExperimentalPresence({ desc: value })).toThrow()
  })
  it('rejects accessors without invoking them, symbol keys and hidden fields', () => {
    let invoked = false
    const accessor = Object.defineProperty({}, 'desc', { enumerable: true, get: () => { invoked = true; return 'value' } })
    expect(() => validateExperimentalPresence(accessor)).toThrow()
    expect(invoked).toBe(false)
    expect(() => validateExperimentalPresence({ desc: 'value', [Symbol('hidden')]: 'value' })).toThrow()
    expect(() => validateExperimentalPresence(Object.defineProperty({}, 'desc', { value: 'value' }))).toThrow()
  })
})
