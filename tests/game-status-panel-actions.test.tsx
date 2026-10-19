import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import type { GameStatusApi, GameStatusAppInfo, GameStatusPlayInput, GameStatusSnapshot } from '../src/shared/game-status'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'en' | 'zh-CN' }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useId: () => 'game-ui-test',
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.slots[index]) : value }] },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useMemo: (value: () => unknown) => value(),
    useLayoutEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { const index = hooks.cursor++; const previous = hooks.slots[index]; if (!previous || dependencies.some((value, i) => !Object.is(previous.dependencies[i], value))) { previous?.cleanup?.(); const entry = { dependencies, cleanup: undefined as void | (() => void) }; hooks.slots[index] = entry; hooks.effects.push(() => { entry.cleanup = effect() }) } }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language, t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }) }))

import { GameStatusIdentity, GameStatusLockStatus, GameStatusPanel, GameStatusTemplateEditor } from '../src/renderer/src/components/GameStatusPanel'

const a = { id: 'account-A', steamId: '76561198000000001', accountName: 'Fixture', displayName: 'Fixture A' } as AccountView
const b = { ...a, id: 'account-B', steamId: '76561198000000002', displayName: 'Fixture B' }
const app: GameStatusAppInfo = { appId: 730, name: 'Fixture Game', iconUrl: null, language: 'english', templates: [{ token: '#Map', text: 'Playing %map%', parameters: ['map'] }] }
function state(account = a): GameStatusSnapshot {
  return { accountId: account.id, boundSteamId: account.steamId, steamId: account.steamId, sessionId: `session-${account.id}`, accountName: account.accountName,
    status: 'logged_on', connected: true, guard: null, blocked: false, blockingAppId: null, playing: null, live: null, lastOperation: null, busy: false, limitations: [], error: null }
}
const promise = <T,>() => { let resolve!: (value: T) => void; const value = new Promise<T>(done => { resolve = done }); return { value, resolve } }
const elements = (root: ReactNode): ReactElement<any>[] => {
  if (!root || typeof root !== 'object') return []
  if (Array.isArray(root)) return root.flatMap(elements)
  const element = root as ReactElement<any>
  return [element, ...elements(element.props?.children)]
}
const text = (root: ReactNode): string => typeof root === 'string' || typeof root === 'number' ? String(root) : Array.isArray(root) ? root.map(text).join('') : root && typeof root === 'object' ? text((root as ReactElement<any>).props?.children) : ''
const allFixtures: Array<() => void> = []
afterEach(() => { for (const cleanup of allFixtures.splice(0)) cleanup(); hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en' })

async function fixture(initial = state()) {
  let current = initial; let account = a; let root: ReactElement
  const listeners = new Set<(value: GameStatusSnapshot) => void>()
  const api = { state: vi.fn(async () => current), connectWithToolbox: vi.fn(async () => current), play: vi.fn(async (_input: GameStatusPlayInput) => current), stop: vi.fn(async () => current), logout: vi.fn(async () => current), observeLive: vi.fn(async () => current), patchLive: vi.fn(async () => current), restoreLive: vi.fn(async () => current),
    inspectApp: vi.fn(async () => app), lockLive: vi.fn(async () => current), unlockLive: vi.fn(async () => current), setLiveDisplay: vi.fn(async () => current), loadDraft: vi.fn(async () => null), saveDraft: vi.fn(async input => input.draft),
    onChange: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }) } satisfies GameStatusApi
  const render = () => { hooks.cursor = 0; root = GameStatusPanel({ activeAccount: account, api }); const effects = hooks.effects.splice(0); effects.forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); render() }
  const button = (label: string) => { const node = elements(root).find(node => node.type === 'button' && text(node.props.children) === label); if (!node) throw new Error(`Missing button ${label}`); return node.props }
  const appInput = () => { const node = elements(root).find(node => node.type === 'input' && node.props.inputMode === 'numeric'); if (!node) throw new Error('Missing AppID input'); return node.props }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  const chooseApp = (id: string) => { appInput().onChange({ target: { value: id } }); render() }
  render(); await settle()
  allFixtures.push(() => { for (const entry of hooks.slots) entry?.cleanup?.() })
  return { api, render, settle, click, chooseApp, button, root: () => root, emit(value: GameStatusSnapshot) { current = value; for (const listener of listeners) listener(value); render() }, select(next: AccountView) { account = next; current = state(next); render() } }
}

describe('game status action identity and native-template boundaries', () => {
  it('replaces a failed official image with a stable placeholder and permits a new safe image URL', () => {
    hooks.cursor = 0
    const first = { ...app, iconUrl: `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/730/${'a'.repeat(40)}.jpg` }
    let root = GameStatusIdentity({ game: first })
    elements(root).find(node => node.type === 'img')!.props.onError()
    hooks.cursor = 0; root = GameStatusIdentity({ game: first })
    expect(elements(root).some(node => node.type === 'img')).toBe(false)
    hooks.cursor = 0; root = GameStatusIdentity({ game: { ...first, iconUrl: first.iconUrl.replace('a'.repeat(40), 'b'.repeat(40)) } })
    expect(elements(root).some(node => node.type === 'img')).toBe(true)
  })

  it('starts in official AppID mode and requires explicit metadata before applying', async () => {
    const f = await fixture()
    expect(text(f.root())).not.toContain('Mahjong Soul presets')
    expect(f.api.inspectApp).not.toHaveBeenCalled(); expect(f.api.play).not.toHaveBeenCalled()
    f.chooseApp('730'); expect(f.button('Apply simulated display').disabled).toBe(true)
    await f.click('Read published game info and templates')
    expect(f.api.inspectApp).toHaveBeenCalledWith({ accountId: a.id, sessionId: `session-${a.id}`, appId: 730, language: 'english' })
    expect(f.button('Apply simulated display').disabled).toBe(false)
    await f.click('Apply simulated display')
    expect(f.api.play).toHaveBeenCalledWith(expect.objectContaining({ appId: 730, details: '', displayKind: 'app', gameName: 'Fixture Game' }))
    expect(f.api.play.mock.calls[0]![0].presence).toBeUndefined()
  })

  it('blocks incomplete native templates then sends only selected published token and values', async () => {
    const f = await fixture(); f.chooseApp('730'); await f.click('Read published game info and templates')
    const editor = elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!
    editor.props.onChange({ displayToken: '#Map', values: {} }); f.render()
    expect(f.button('Apply simulated display').disabled).toBe(true)
    elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!.props.onChange({ displayToken: '#Map', values: { map: 'Fixture map' } }); f.render()
    await f.click('Apply simulated display')
    expect(f.api.play).toHaveBeenCalledWith(expect.objectContaining({ details: '', presence: { displayToken: '#Map', values: { map: 'Fixture map' } } }))
  })

  it('discards an AppID inspection when the user changes AppID while it is loading', async () => {
    const f = await fixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    f.chooseApp('570'); pending.resolve(app); await f.settle()
    expect(elements(f.root()).filter(node => node.type === GameStatusIdentity && node.props.game?.appId === 730)).toHaveLength(0)
    expect(f.button('Apply simulated display').disabled).toBe(true); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('does not apply late metadata after switching selected account', async () => {
    const f = await fixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    f.select(b); await f.settle(); pending.resolve(app); await f.settle()
    expect(text(f.root())).toContain('Fixture B')
    expect(elements(f.root()).filter(node => node.type === GameStatusTemplateEditor)).toHaveLength(0)
    expect(f.api.play).not.toHaveBeenCalled()
  })

  it('discards metadata returned for the old language', async () => {
    const f = await fixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    hooks.language = 'zh-CN'; f.render(); pending.resolve(app); await f.settle()
    expect(elements(f.root()).filter(node => node.type === GameStatusTemplateEditor)).toHaveLength(0)
    expect(f.api.play).not.toHaveBeenCalled()
  })

  it('keeps unlock available during background checking and calls the non-restoring endpoint once', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: true, localizedString: 'Steam returned value' }
    const initial = { ...state(), blocked: true, blockingAppId: 730, busy: true, live, liveLock: { appId: 730, gameEpoch: 1, desired: { status: 'x' }, status: 'checking' as const, matched: false, localizedString: null, nextCheckAt: null, lastCheckedAt: null, consecutiveFailures: 0, error: null } }
    const f = await fixture(initial); await f.click('Live game status')
    const lock = elements(f.root()).find(node => node.type === GameStatusLockStatus)!
    expect(lock.props.disabled).toBe(false)
    lock.props.onUnlock(); await f.settle()
    expect(f.api.unlockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, restore: false })
    expect(f.api.setLiveDisplay).not.toHaveBeenCalled(); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('marks a changed live snapshot stale before sending edited fields', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: false }
    const initial = { ...state(), blocked: true, blockingAppId: 730, live }
    const f = await fixture(initial); await f.click('Live game status'); await f.click('Read current game')
    const input = elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'status edited value')!
    input.props.onChange({ target: { value: 'Custom' } }); f.render()
    expect(f.button('Submit these changes once').disabled).toBe(false)
    f.emit({ ...initial, live: { ...live, snapshotId: 'live-2' } })
    expect(f.button('Submit these changes once').disabled).toBe(true); expect(text(f.root())).toContain('Old edits are retained but cannot be submitted')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('submits a published native substatus with an explicit lock and keeps the Steam readback separate', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: false, localizedString: 'Actual Steam readback' }
    const f = await fixture({ ...state(), blocked: true, blockingAppId: 730, live })
    await f.click('Live game status'); await f.click('Read current game'); await f.click('Read substatus templates and icon')
    expect(text(f.root())).toContain('Steam substatus readback (not a local preview)'); expect(text(f.root())).toContain('Actual Steam readback')
    elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!.props.onChange({ displayToken: '#Map', values: { map: 'Custom map' } }); f.render()
    const label = elements(f.root()).find(node => node.type === 'label' && text(node.props.children).includes('Keep this substatus locked'))!
    elements(label).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } }); f.render()
    await f.click('Apply and lock substatus')
    expect(f.api.setLiveDisplay).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'live-1', presence: { displayToken: '#Map', values: { map: 'Custom map' } }, lock: true })
    expect(f.api.play).not.toHaveBeenCalled(); expect(f.api.patchLive).not.toHaveBeenCalled()
  })

  it('locks only changed observed fields rather than the entire game presence', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x', 'game:score': '3:2', steam_display: '#Fixed' }, editableKeys: ['status', 'game:score'], readOnlyKeys: ['steam_display'], patchActive: false }
    const f = await fixture({ ...state(), blocked: true, blockingAppId: 730, live })
    await f.click('Live game status'); await f.click('Read current game')
    elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'status edited value')!.props.onChange({ target: { value: 'Custom' } }); f.render()
    const label = elements(f.root()).find(node => node.type === 'label' && text(node.props.children).includes('Keep the changed fields in the table locked'))!
    elements(label).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } }); f.render()
    await f.click('Apply and lock changed fields')
    expect(f.api.lockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'live-1', changes: { status: 'Custom' } })
    expect(f.api.patchLive).not.toHaveBeenCalled()
  })

  it('blocks new patches while a previous one has a safe-restore record and provides the resolution', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: true }
    const f = await fixture({ ...state(), blocked: true, blockingAppId: 730, live })
    await f.click('Live game status'); await f.click('Read current game')
    elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'status edited value')!.props.onChange({ target: { value: 'Custom' } }); f.render()
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Restore fields from before this edit').disabled).toBe(false)
    expect(text(f.root())).toContain('A safe-restore record remains from the previous edit')
  })
})
