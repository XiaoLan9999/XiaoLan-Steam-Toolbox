import { describe, expect, it, vi } from 'vitest'
import { initialUpdateState, type UpdateState } from '../src/shared/update-types'
import { compareUpdateVersions, DISMISSED_UPDATE_VERSION_KEY, dismissUpdateVersion,
  hasAvailableUpdate, readDismissedUpdateVersion, shouldShowUpdateNotice } from '../src/renderer/src/update-notification'

const base = initialUpdateState('0.16.12', 'portable')
const newer: UpdateState = { ...base, phase: 'available', latestVersion: '0.16.13' }
function storage(initial: string | null = null) {
  let value = initial
  return { getItem: vi.fn((_key: string) => value), setItem: vi.fn((_key: string, next: string) => { value = next }), value: () => value }
}

describe('version-scoped persistent update dismissal', () => {
  it('stores the dismissed version and restores it independently of a component lifetime', () => {
    const store = storage()
    expect(readDismissedUpdateVersion(store)).toBeNull()
    expect(dismissUpdateVersion('0.16.13', store)).toBe('0.16.13')
    expect(store.setItem).toHaveBeenCalledExactlyOnceWith(DISMISSED_UPDATE_VERSION_KEY, '0.16.13')
    const restarted = storage(store.value())
    expect(readDismissedUpdateVersion(restarted)).toBe('0.16.13')
    expect(shouldShowUpdateNotice(newer, readDismissedUpdateVersion(restarted))).toBe(false)
    expect(hasAvailableUpdate(newer)).toBe(true)
    expect(shouldShowUpdateNotice({ ...newer, latestVersion: '0.16.14' }, readDismissedUpdateVersion(restarted))).toBe(true)
  })

  it('never lowers the highest stored dismissal when an old notice closes late', () => {
    const store = storage('0.16.15')
    expect(dismissUpdateVersion('0.16.13', store)).toBe('0.16.15')
    expect(store.value()).toBe('0.16.15')
    expect(shouldShowUpdateNotice(newer, store.value())).toBe(false)
    expect(dismissUpdateVersion('0.16.16', store)).toBe('0.16.16')
    expect(store.value()).toBe('0.16.16')
  })

  it.each(['', '01.2.3', 'v1.2.3', '1.2', '1.2.3-beta.1', '9007199254740992.0.0', '"0.16.13"', '<script>bad()</script>', 'x'.repeat(1000)])('ignores an invalid stored version %s', value => {
    const store = storage(value)
    expect(readDismissedUpdateVersion(store)).toBeNull()
    expect(shouldShowUpdateNotice(newer, value)).toBe(true)
    expect(dismissUpdateVersion(value, storage())).toBeNull()
  })

  it('keeps storage failures harmless without generating an update version', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readDismissedUpdateVersion(blocked)).toBeNull()
    expect(dismissUpdateVersion('0.16.13', blocked)).toBe('0.16.13')
    expect(readDismissedUpdateVersion(null)).toBeNull()
    expect(dismissUpdateVersion('invalid', blocked)).toBeNull()
    expect(hasAvailableUpdate({ ...base, phase: 'error', error: 'update.timeout' })).toBe(false)
  })

  it.each<UpdateState['phase']>(['idle', 'checking', 'upToDate', 'available', 'downloading', 'ready', 'error'])(
    'retains the settings badge but not the dismissed popup across %s', phase => {
      expect(hasAvailableUpdate({ ...newer, phase })).toBe(true)
      expect(shouldShowUpdateNotice({ ...newer, phase }, '0.16.13')).toBe(false)
    })

  it.each([null, '0.16.11', '0.16.12', 'v0.16.13', '0.16.13-beta.1'])('does not invent a newer version from %s', latestVersion => {
    expect(hasAvailableUpdate({ ...newer, latestVersion })).toBe(false)
    expect(shouldShowUpdateNotice({ ...newer, latestVersion }, null)).toBe(false)
  })

  it('uses numeric stable-version ordering', () => {
    expect(compareUpdateVersions('0.16.9', '0.16.12')).toBe(-1)
    expect(compareUpdateVersions('0.17.0', '0.16.12')).toBe(1)
    expect(compareUpdateVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareUpdateVersions(null, '1.0.0')).toBeNull()
    expect(compareUpdateVersions('0.16.13', 'invalid')).toBeNull()
  })
})
