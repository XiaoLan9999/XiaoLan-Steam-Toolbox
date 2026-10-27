import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import type { GameStatusApi, GameStatusAppInfo, GameStatusPlayInput, GameStatusSnapshot } from '../src/shared/game-status'
import type { LocalAppSimulationApi } from '../src/shared/local-app-simulation'
import { LocalAppSimulationPanel } from '../src/renderer/src/components/LocalAppSimulationPanel'

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
    status: 'logged_on', connected: true, connectionKind: 'cm', simulationReady: true, guard: null, blocked: false, blockingAppId: null, playing: null, live: null, lastOperation: null, busy: false, limitations: [], error: null }
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

async function fixture(initial = state(), localSimulationApi?: LocalAppSimulationApi) {
  let current = initial; let account = a; let root: ReactElement
  const listeners = new Set<(value: GameStatusSnapshot) => void>()
  const api = { state: vi.fn(async () => current), connectLocal: vi.fn(async () => current), connectWithToolbox: vi.fn(async () => current), play: vi.fn(async (_input: GameStatusPlayInput) => current), stop: vi.fn(async () => current), logout: vi.fn(async () => current), observeLive: vi.fn(async () => current), patchLive: vi.fn(async () => current), restoreLive: vi.fn(async () => current),
    inspectApp: vi.fn(async () => app), lockLive: vi.fn(async () => current), unlockLive: vi.fn(async () => current), setLiveDisplay: vi.fn(async () => current), loadDraft: vi.fn(async () => null), saveDraft: vi.fn(async input => input.draft),
    onChange: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }) } satisfies GameStatusApi
  const render = () => { hooks.cursor = 0; root = GameStatusPanel({ activeAccount: account, api, localSimulationApi }); const effects = hooks.effects.splice(0); effects.forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); render() }
  const button = (label: string) => { const node = elements(root).find(node => node.type === 'button' && text(node.props.children) === label); if (!node) throw new Error(`Missing button ${label}`); return node.props }
  const appInput = () => { const node = elements(root).find(node => node.type === 'input' && node.props.inputMode === 'numeric'); if (!node) throw new Error('Missing AppID input'); return node.props }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  const chooseApp = (id: string) => { appInput().onChange({ target: { value: id } }); render() }
  render(); await settle()
  allFixtures.push(() => { for (const entry of hooks.slots) entry?.cleanup?.() })
  return { api, render, settle, click, chooseApp, button, root: () => root, emit(value: GameStatusSnapshot) { current = value; for (const listener of listeners) listener(value); render() }, select(next: AccountView) { account = next; current = state(next); render() } }
}

async function simulationFixture() {
  const result = await fixture()
  await result.click('Simulated display')
  return result
}

describe('game status action identity and native-template boundaries', () => {
  it.each(['zh-CN', 'en'] as const)('disables a known unsafe local connection without invoking it in %s', async language => {
    hooks.language = language
    const initial = { ...state(), connected: false, status: 'logged_out' as const, steamId: null, localConnectionAvailable: false }
    const f = await fixture(initial)
    const label = language === 'en' ? 'Connect local Steam (no new sign-in)' : '连接本机 Steam（不重新登录）'
    expect(f.button(label).disabled).toBe(true)
    expect(text(f.root())).toContain(language === 'en' ? 'connecting alone was observed to hide' : '仅连接也可能使游戏原生子状态消失')
    await f.click(label)
    expect(f.api.connectLocal).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })
  it.each(['zh-CN', 'en'] as const)('warns that disconnect does not restore a local edit, without preventing it or adding writes, in %s', async language => {
    hooks.language = language
    const live = { snapshotId: 'local-edited', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: 'Edited room' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live }
    const f = await fixture(initial)
    const warning = language === 'en' ? 'Disconnecting does not restore fields automatically' : '直接断开不会自动恢复'
    expect(text(f.root())).toContain(warning)
    expect(text(f.root())).toContain(language === 'en' ? 'Unlock if enabled and safely restore' : '先解除锁定（如已启用）并安全恢复')
    expect(text(f.root())).toContain(language === 'en' ? 'only for this game-status session' : '仅在本次游戏状态会话中有效')
    expect(text(f.root())).toContain(language === 'en' ? 'not saved for the next launch' : '不会保存到下次启动')
    expect(text(f.root())).toContain(language === 'en' ? 'You can still stop or exit at any time' : '你仍可随时停止或退出')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.restoreLive).not.toHaveBeenCalled(); expect(f.api.unlockLive).not.toHaveBeenCalled()
    const disconnect = language === 'en' ? 'Disconnect game status' : '断开游戏状态连接'
    expect(f.button(disconnect).disabled).toBe(false)
    f.api.logout.mockResolvedValueOnce({ ...initial, connected: false, status: 'logged_out', live: null })
    await f.click(disconnect)
    expect(f.api.logout).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.restoreLive).not.toHaveBeenCalled(); expect(f.api.unlockLive).not.toHaveBeenCalled()
    expect(text(f.root())).not.toContain(warning)
  })

  it.each(['zh-CN', 'en'] as const)('keeps the restore warning visible while locked and removes it after recovery in %s', async language => {
    hooks.language = language
    const live = { snapshotId: 'local-locked', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: 'Locked room' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const liveLock = { appId: 1329410, gameEpoch: 1, desired: { desc: 'Locked room' }, status: 'locked' as const, matched: true, localizedString: null, nextCheckAt: null, lastCheckedAt: live.observedAt, consecutiveFailures: 0, error: null }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live, liveLock }
    const f = await fixture(initial)
    const warning = language === 'en' ? 'Disconnecting does not restore fields automatically' : '直接断开不会自动恢复'
    expect(text(f.root())).toContain(warning)
    f.emit({ ...initial, live: { ...live, snapshotId: 'local-restored', patchActive: false }, liveLock: { ...liveLock, status: 'stopped' } })
    expect(text(f.root())).not.toContain(warning)
    expect(f.api.restoreLive).not.toHaveBeenCalled(); expect(f.api.unlockLive).not.toHaveBeenCalled(); expect(f.api.logout).not.toHaveBeenCalled()
  })

  it('opens the live page without connecting, and the global button uses only the local connection API', async () => {
    const initial = { ...state(), connected: false, status: 'logged_out' as const, steamId: null }
    const f = await fixture(initial)
    const selected = elements(f.root()).find(node => node.props.role === 'tab' && node.props['aria-selected'])!
    expect(text(selected)).toBe('Live game status')
    expect(text(f.root())).not.toContain('Connect a separate simulation session')
    expect(f.api.connectLocal).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
    f.api.connectLocal.mockResolvedValueOnce({ ...state(), connectionKind: 'local', sessionId: 'local-session' })
    await f.click('Connect local Steam (no new sign-in)')
    expect(f.api.connectLocal).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.connectWithToolbox).not.toHaveBeenCalled(); expect(f.api.observeLive).not.toHaveBeenCalled()
  })

  it('never silently falls back to a personal CM login when local connection fails', async () => {
    const f = await fixture({ ...state(), connected: false, status: 'logged_out' })
    f.api.connectLocal.mockRejectedValueOnce({ code: 'GAME_STATUS_NATIVE_UNAVAILABLE', message: 'PRIVATE_NATIVE_ERROR' })
    await f.click('Connect local Steam (no new sign-in)')
    expect(f.api.connectLocal).toHaveBeenCalledOnce(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
    expect(text(f.root())).not.toContain('PRIVATE_NATIVE_ERROR')
  })

  it('shows the separate CM session and its refresh warning only in explicit simulation mode', async () => {
    const f = await fixture({ ...state(), connected: false, status: 'logged_out' })
    await f.click('Simulated display')
    expect(text(f.root())).toContain('may refresh the Steam friends interface')
    expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
    await f.click('Connect a separate simulation session')
    expect(f.api.connectWithToolbox).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.connectLocal).not.toHaveBeenCalled(); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('does not use an existing CM simulation session to read or edit a real game', async () => {
    const f = await fixture({ ...state(), blocked: true, blockingAppId: 730 })
    expect(text(f.root())).toContain('live game editing is disabled')
    expect(f.button('Read current game').disabled).toBe(true)
    await f.click('Read current game')
    expect(f.api.observeLive).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
  })

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
    const f = await simulationFixture()
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

  it('waits for simulation permission instead of treating a logged-on CM as idle', async () => {
    const initial = { ...state(), simulationReady: false }
    const f = await fixture(initial); await f.click('Simulated display')
    f.chooseApp('730'); await f.click('Read published game info and templates')
    expect(text(f.root())).toContain('Verifying the local Steam account and game state')
    expect(f.button('Apply simulated display').disabled).toBe(true)
    expect(f.button('Recheck simulation permission (no new sign-in)').disabled).toBe(false)
    await f.click('Recheck simulation permission (no new sign-in)')
    expect(f.api.connectWithToolbox).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.logout).not.toHaveBeenCalled(); expect(f.api.connectLocal).not.toHaveBeenCalled()
    await f.click('Apply simulated display')
    expect(f.api.play).not.toHaveBeenCalled()
    f.emit({ ...initial, simulationReady: true })
    expect(f.button('Apply simulated display').disabled).toBe(false)
    expect(text(f.root())).not.toContain('Verifying the local Steam account and game state')
  })

  it.each([true, false])('does not discard a live restore record when opening simulation (lock=%s)', async locked => {
    const live = { snapshotId: 'local-live', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z',
      fields: { desc: 'Original' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true }
    const liveLock = locked ? { appId: 730, gameEpoch: 1, desired: { desc: 'Edited' }, status: 'locked' as const,
      matched: true, localizedString: 'Edited', nextCheckAt: null, lastCheckedAt: null, consecutiveFailures: 0, error: null } : null
    const f = await fixture({ ...state(), connectionKind: 'local', live, liveLock })
    await f.click('Simulated display')
    expect(f.button('Connect a separate simulation session').disabled).toBe(true)
    expect(text(f.root())).toContain('Unlock and safely restore it on Live game status')
    await f.click('Connect a separate simulation session')
    expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
    expect(f.api.logout).not.toHaveBeenCalled(); expect(f.api.unlockLive).not.toHaveBeenCalled()
  })

  it('blocks incomplete native templates then sends only selected published token and values', async () => {
    const f = await simulationFixture(); f.chooseApp('730'); await f.click('Read published game info and templates')
    const editor = elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!
    editor.props.onChange({ displayToken: '#Map', values: {} }); f.render()
    expect(f.button('Apply simulated display').disabled).toBe(true)
    elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!.props.onChange({ displayToken: '#Map', values: { map: 'Fixture map' } }); f.render()
    await f.click('Apply simulated display')
    expect(f.api.play).toHaveBeenCalledWith(expect.objectContaining({ details: '', presence: { displayToken: '#Map', values: { map: 'Fixture map' } } }))
  })

  it('discards an AppID inspection when the user changes AppID while it is loading', async () => {
    const f = await simulationFixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    f.chooseApp('570'); pending.resolve(app); await f.settle()
    expect(elements(f.root()).filter(node => node.type === GameStatusIdentity && node.props.game?.appId === 730)).toHaveLength(0)
    expect(f.button('Apply simulated display').disabled).toBe(true); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('does not apply late metadata after switching selected account', async () => {
    const f = await simulationFixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    f.select(b); await f.settle(); pending.resolve(app); await f.settle()
    expect(text(f.root())).toContain('Fixture B')
    expect(elements(f.root()).filter(node => node.type === GameStatusTemplateEditor)).toHaveLength(0)
    expect(f.api.play).not.toHaveBeenCalled()
  })

  it('discards metadata returned for the old language', async () => {
    const f = await simulationFixture(); const pending = promise<GameStatusAppInfo>(); f.api.inspectApp.mockReturnValueOnce(pending.value)
    f.chooseApp('730'); f.button('Read published game info and templates').onClick(); await f.settle()
    hooks.language = 'zh-CN'; f.render(); pending.resolve(app); await f.settle()
    expect(elements(f.root()).filter(node => node.type === GameStatusTemplateEditor)).toHaveLength(0)
    expect(f.api.play).not.toHaveBeenCalled()
  })

  it('keeps unlock available during background checking and calls the non-restoring endpoint once', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: true, localizedString: 'Steam returned value' }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 730, busy: true, live, liveLock: { appId: 730, gameEpoch: 1, desired: { status: 'x' }, status: 'checking' as const, matched: false, localizedString: null, nextCheckAt: null, lastCheckedAt: null, consecutiveFailures: 0, error: null } }
    const f = await fixture(initial); await f.click('Live game status')
    const lock = elements(f.root()).find(node => node.type === GameStatusLockStatus)!
    expect(lock.props.disabled).toBe(false)
    lock.props.onUnlock(); await f.settle()
    expect(f.api.unlockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, restore: false })
    expect(f.api.setLiveDisplay).not.toHaveBeenCalled(); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('marks a changed live snapshot stale before sending edited fields', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: false }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 730, live }
    const f = await fixture(initial); await f.click('Live game status'); await f.click('Read current game')
    const input = elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'status edited value')!
    input.props.onChange({ target: { value: 'Custom' } }); f.render()
    expect(f.button('Submit these changes once').disabled).toBe(false)
    f.emit({ ...initial, live: { ...live, snapshotId: 'live-2' } })
    expect(f.button('Submit these changes once').disabled).toBe(true); expect(text(f.root())).toContain('Old edits are retained but cannot be submitted')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('submits a published native substatus with an explicit lock and keeps the Steam readback separate', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x' }, editableKeys: ['status'], readOnlyKeys: [], patchActive: false, localizedString: 'Actual Steam readback', verificationSource: 'local-cache' as const }
    const f = await fixture({ ...state(), connectionKind: 'local', blocked: true, blockingAppId: 730, live })
    await f.click('Live game status'); await f.click('Read current game'); await f.click('Read substatus templates and icon')
    expect(text(f.root())).toContain('Local Steam cached substatus (not independent server confirmation)'); expect(text(f.root())).toContain('Actual Steam readback')
    elements(f.root()).find(node => node.type === GameStatusTemplateEditor)!.props.onChange({ displayToken: '#Map', values: { map: 'Custom map' } }); f.render()
    const label = elements(f.root()).find(node => node.type === 'label' && text(node.props.children).includes('Keep this substatus locked'))!
    elements(label).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } }); f.render()
    await f.click('Apply and lock substatus')
    expect(f.api.setLiveDisplay).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'live-1', presence: { displayToken: '#Map', values: { map: 'Custom map' } }, lock: true })
    expect(f.api.play).not.toHaveBeenCalled(); expect(f.api.patchLive).not.toHaveBeenCalled()
  })

  it('locks only changed observed fields rather than the entire game presence', async () => {
    const live = { snapshotId: 'live-1', appId: 730, gameEpoch: 1, observedAt: '2026-10-20T12:00:00Z', fields: { status: 'x', 'game:score': '3:2', steam_display: '#Fixed' }, editableKeys: ['status', 'game:score'], readOnlyKeys: ['steam_display'], patchActive: false }
    const f = await fixture({ ...state(), connectionKind: 'local', blocked: true, blockingAppId: 730, live })
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
    const f = await fixture({ ...state(), connectionKind: 'local', blocked: true, blockingAppId: 730, live })
    await f.click('Live game status'); await f.click('Read current game')
    elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'status edited value')!.props.onChange({ target: { value: 'Custom' } }); f.render()
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Restore fields from before this edit').disabled).toBe(false)
    expect(text(f.root())).toContain('A safe-restore record remains from the previous edit')
  })

  it('edits and locks an observed local desc without a template or guessed steam_display token', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内', steam_display: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: ['steam_display'], patchActive: false,
      localizedString: '魂天神社内', verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const f = await fixture({ ...state(), connectionKind: 'local', blocked: true, blockingAppId: 1329410, live })
    await f.click('Read current game')
    expect(text(f.root())).toContain('魂天神社内')
    expect(text(f.root())).toContain('Local Steam cached substatus (not independent server confirmation)')
    expect(text(f.root())).toContain('no token is guessed')
    expect(elements(f.root()).some(node => node.type === GameStatusTemplateEditor)).toBe(false)
    expect(elements(f.root()).some(node => node.type === 'button' && text(node) === 'Read substatus templates and icon')).toBe(false)
    elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.onChange({ target: { value: '王座之间 四人东' } }); f.render()
    const label = elements(f.root()).find(node => node.type === 'label' && text(node).includes('Keep the changed fields in the table locked'))!
    elements(label).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } }); f.render()
    await f.click('Apply and lock changed fields')
    expect(f.api.lockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'local-live', changes: { desc: '王座之间 四人东' } })
    expect(f.api.inspectApp).not.toHaveBeenCalled(); expect(f.api.setLiveDisplay).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
  })

  it('does not turn local cached matches into an independent server confirmation', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: false, localizedString: null, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const lastOperation = { kind: 'lock' as const, outcome: 'matched' as const, message: 'PRIVATE_IGNORED_RAW_MESSAGE', at: live.observedAt, verificationSource: 'local-cache' as const }
    const f = await fixture({ ...state(), connectionKind: 'local', blocked: true, blockingAppId: 1329410, live, lastOperation })
    await f.click('Read current game')
    expect(text(f.root())).toContain('Locked fields match the local Steam cache')
    expect(text(f.root())).toContain('魂天神社内')
    expect(text(f.root())).toContain('observed exposed desc field')
    expect(text(f.root())).not.toContain('PRIVATE_IGNORED_RAW_MESSAGE')
    expect(text(f.root())).not.toContain('Steam server substatus readback')
    const notice = elements(f.root()).find(node => node.props.className === 'game-status-notice info' && text(node).includes('Locked fields match the local Steam cache'))
    expect(notice).toBeDefined()
    expect(elements(f.root()).some(node => node.props.className === 'game-status-notice success')).toBe(false)
  })

  it('marks an old snapshot unconfirmed after a failed read without discarding recovery controls', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, localizedString: '魂天神社内', verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const lastOperation = { kind: 'patch' as const, outcome: 'matched' as const, message: 'ignored', at: live.observedAt, verificationSource: 'local-cache' as const }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live, lastOperation }
    const f = await fixture(initial); await f.click('Read current game')
    f.emit({ ...initial, failure: { code: 'GAME_STATUS_RP_EMPTY', stage: 'read_presence', at: '2026-10-21T12:01:00Z', appId: 1329410, submitted: 'no' } })
    expect(text(f.root())).toContain('The previous snapshot is shown and old edits cannot be submitted')
    expect(text(f.root())).not.toContain('The result matches the local Steam cache')
    expect(elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.disabled).toBe(true)
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Read current game').disabled).toBe(false)
    expect(f.button('Restore fields from before this edit').disabled).toBe(false)
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.restoreLive).not.toHaveBeenCalled()
    f.api.observeLive.mockResolvedValueOnce({ ...initial, failure: null, live: { ...live, snapshotId: 'fresh-local-live' } })
    await f.click('Read current game')
    expect(text(f.root())).not.toContain('The previous snapshot is shown')
    expect(elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.disabled).toBe(false)
  })

  it('marks an existing lock readback unconfirmed but keeps guarded unlock available after a read failure', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const liveLock = { appId: 1329410, gameEpoch: 1, desired: { desc: '魂天神社内' }, status: 'locked' as const, matched: true, localizedString: '魂天神社内', nextCheckAt: null, lastCheckedAt: live.observedAt, consecutiveFailures: 0, error: null }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live, liveLock }
    const f = await fixture(initial)
    f.emit({ ...initial, failure: { code: 'GAME_STATUS_RP_READ_FAILED', stage: 'readback', at: '2026-10-21T12:01:00Z', appId: 1329410, submitted: 'yes' } })
    const lock = elements(f.root()).find(node => node.type === GameStatusLockStatus)!
    expect(lock.props.readUnconfirmed).toBe(true)
    expect(lock.props.disabled).toBe(false)
    lock.props.onUnlock(); await f.settle()
    expect(f.api.unlockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, restore: false })
    expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
  })

  it('suspends an unverifiable context without claiming a game change or blocking guarded recovery', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const liveLock = { appId: 1329410, gameEpoch: 1, desired: { desc: '魂天神社内' }, status: 'stopped' as const, matched: true, localizedString: '魂天神社内', nextCheckAt: null, lastCheckedAt: live.observedAt, consecutiveFailures: 0, error: null }
    const lastOperation = { kind: 'lock' as const, outcome: 'matched' as const, message: 'ignored', at: live.observedAt, verificationSource: 'local-cache' as const }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live, liveLock, lastOperation }
    const f = await fixture(initial); await f.click('Read current game')
    f.emit({ ...initial, failure: { code: 'GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', stage: 'context', at: '2026-10-21T12:01:00Z', appId: 1329410, submitted: 'unknown' } })
    expect(text(f.root())).toContain('this does not prove that the account or game changed')
    expect(text(f.root())).not.toContain('The game or snapshot changed')
    expect(text(f.root())).not.toContain('Locked fields match the local Steam cache')
    expect(elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.disabled).toBe(true)
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Read current game').disabled).toBe(false)
    expect(f.button('Restore fields from before this edit').disabled).toBe(false)
    expect(elements(f.root()).find(node => node.type === GameStatusLockStatus)!.props.readUnconfirmed).toBe(true)
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.restoreLive).not.toHaveBeenCalled()
    await f.click('Restore fields from before this edit')
    expect(f.api.restoreLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.connectLocal).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
  })

  it('marks a helper-context failure as a stale baseline while keeping guarded restore available', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: true, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const lastOperation = { kind: 'patch' as const, outcome: 'matched' as const, message: 'ignored', at: live.observedAt, verificationSource: 'local-cache' as const }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live, lastOperation }
    const f = await fixture(initial); await f.click('Read current game')
    f.emit({ ...initial, failure: { code: 'GAME_STATUS_NATIVE_CONTEXT', stage: 'context', at: '2026-10-21T12:01:00Z', appId: 1329410, submitted: 'unknown' } })
    expect(text(f.root())).toContain('The local presence connection or context was not verified')
    expect(text(f.root())).not.toContain('The result matches the local Steam cache')
    expect(elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.disabled).toBe(true)
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Read current game').disabled).toBe(false)
    expect(f.button('Restore fields from before this edit').disabled).toBe(false)
    await f.click('Restore fields from before this edit')
    expect(f.api.restoreLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}` })
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.connectWithToolbox).not.toHaveBeenCalled()
  })

  it('blocks a stale local editor after changing to a CM connection, even when callbacks are invoked directly', async () => {
    const live = { snapshotId: 'local-live', appId: 1329410, gameEpoch: 1, observedAt: '2026-10-21T12:00:00Z', fields: { desc: '魂天神社内' }, editableKeys: ['desc'], readOnlyKeys: [], patchActive: false, verificationSource: 'local-cache' as const, displayTokenReadable: false }
    const initial = { ...state(), connectionKind: 'local' as const, blocked: true, blockingAppId: 1329410, live }
    const f = await fixture(initial); await f.click('Read current game')
    elements(f.root()).find(node => node.type === 'input' && node.props['aria-label'] === 'desc edited value')!.props.onChange({ target: { value: '王座之间 四人东' } }); f.render()
    f.emit({ ...initial, connectionKind: 'cm' })
    expect(f.button('Submit these changes once').disabled).toBe(true)
    await f.click('Submit these changes once')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })
})

function groupState(size: string | undefined = '2'): GameStatusSnapshot {
  const fields: Record<string, string> = { desc: 'Fixture room' }
  if (size !== undefined) fields.steam_player_group_size = size
  return { ...state(), connectionKind: 'local', blocked: true, blockingAppId: 730,
    live: { snapshotId: 'live-group-fixture', appId: 730, gameEpoch: 1, observedAt: '2026-10-22T06:00:00Z', fields,
      editableKeys: Object.keys(fields), readOnlyKeys: [], patchActive: false, verificationSource: 'local-cache', displayTokenReadable: false } }
}
const liveGroupInput = (root: ReactNode) => elements(root).find(node => node.type === 'input' && node.props['aria-label'] === 'Live game total group size')!.props

describe('controlled live group-size UI actions', () => {
  it('keeps group count out of the ordinary text-field editor and changes only the size key', async () => {
    const f = await fixture(groupState()); await f.click('Read current game')
    expect(elements(f.root()).some(node => node.props['aria-label'] === 'Live game group size')).toBe(true)
    expect(text(f.root())).toContain('mixed In Game singleton list')
    expect(text(f.root())).toContain('does not prove receipt or display by a friend')
    expect(elements(f.root()).some(node => node.props['aria-label'] === 'steam_player_group_size edited value')).toBe(false)
    liveGroupInput(f.root()).onChange({ target: { value: '5' } }); f.render()
    expect(f.button('Submit these changes once').disabled).toBe(true)
    expect(f.button('Apply group size once').disabled).toBe(false); await f.click('Apply group size once')
    expect(f.api.patchLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'live-group-fixture', changes: { steam_player_group_size: '5' } })
    expect(f.api.lockLive).not.toHaveBeenCalled(); expect(f.api.setLiveDisplay).not.toHaveBeenCalled(); expect(f.api.play).not.toHaveBeenCalled()
  })

  it('locks only an explicitly changed observed size', async () => {
    const f = await fixture(groupState()); await f.click('Read current game')
    expect(f.button('Apply and lock group size').disabled).toBe(true)
    liveGroupInput(f.root()).onChange({ target: { value: '4' } }); f.render(); await f.click('Apply and lock group size')
    expect(f.api.lockLive).toHaveBeenCalledExactlyOnceWith({ accountId: a.id, sessionId: `session-${a.id}`, snapshotId: 'live-group-fixture', changes: { steam_player_group_size: '4' } })
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.setLiveDisplay).not.toHaveBeenCalled()
  })

  it.each(['', '0', '-1', '02', '2.5', '2147483648', 'words'])('refuses invalid live group-size text %j at the action boundary', async value => {
    const f = await fixture(groupState()); await f.click('Read current game'); liveGroupInput(f.root()).onChange({ target: { value } }); f.render()
    expect(f.button('Apply group size once').disabled).toBe(true); expect(f.button('Apply and lock group size').disabled).toBe(true)
    await f.click('Apply group size once'); await f.click('Apply and lock group size')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('does not create a group count when no size was observed', async () => {
    const initial = groupState(); delete initial.live!.fields.steam_player_group_size; initial.live!.editableKeys = ['desc']
    const f = await fixture(initial); await f.click('Read current game')
    expect(elements(f.root()).some(node => node.props['aria-label'] === 'Live game total group size')).toBe(false)
    expect(elements(f.root()).some(node => node.type === 'button' && text(node) === 'Apply group size once')).toBe(false)
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('does not edit an observed count marked read-only by the backend', async () => {
    const initial = groupState(); initial.live!.editableKeys = ['desc']; initial.live!.readOnlyKeys = ['steam_player_group_size']
    const f = await fixture(initial); await f.click('Read current game')
    expect(liveGroupInput(f.root()).disabled).toBe(true); liveGroupInput(f.root()).onChange({ target: { value: '5' } }); f.render()
    expect(f.button('Apply group size once').disabled).toBe(true); await f.click('Apply group size once')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it.each(['snapshot', 'lock', 'account'] as const)('does not submit a cached group callback after %s changes', async change => {
    const initial = groupState(); const f = await fixture(initial); await f.click('Read current game')
    liveGroupInput(f.root()).onChange({ target: { value: '5' } }); f.render()
    const staleSubmit = f.button('Apply group size once').onClick
    if (change === 'snapshot') f.emit({ ...initial, live: { ...initial.live!, snapshotId: 'new-group-snapshot' } })
    else if (change === 'account') { f.select(b); await f.settle() }
    else f.emit({ ...initial, liveLock: { appId: 730, gameEpoch: 1, desired: { steam_player_group_size: '3' }, status: 'locked', matched: true, localizedString: null, nextCheckAt: null, lastCheckedAt: null, consecutiveFailures: 0, error: null } })
    staleSubmit(); await f.settle()
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('keeps group editing disabled while an earlier patch has a safe-restore record', async () => {
    const initial = groupState(); initial.live!.patchActive = true
    const f = await fixture(initial); await f.click('Read current game'); liveGroupInput(f.root()).onChange({ target: { value: '5' } }); f.render()
    expect(f.button('Apply group size once').disabled).toBe(true); await f.click('Apply group size once')
    expect(f.api.patchLive).not.toHaveBeenCalled(); expect(f.api.lockLive).not.toHaveBeenCalled()
  })

  it('saves the local simulation group count as a draft integer without a group identity', async () => {
    const localApi = { state: vi.fn(), inspect: vi.fn(), start: vi.fn(), stop: vi.fn(), onChange: vi.fn(() => () => {}) } as LocalAppSimulationApi
    const f = await fixture(state(), localApi); await f.click('Local AppID simulation')
    let panel = elements(f.root()).find(node => node.type === LocalAppSimulationPanel)!
    panel.props.onAppIdChange('730'); f.render(); panel = elements(f.root()).find(node => node.type === LocalAppSimulationPanel)!
    panel.props.onGroupSizeChange(7); f.render(); panel = elements(f.root()).find(node => node.type === LocalAppSimulationPanel)!
    expect(panel.props.groupSize).toBe(7); panel.props.onSaveDraft(); await f.settle()
    expect(f.api.saveDraft).toHaveBeenCalledWith({ accountId: a.id, sessionId: `session-${a.id}`, draft: expect.objectContaining({ displayKind: 'app', appId: 730, groupSize: 7 }) })
    expect(JSON.stringify(f.api.saveDraft.mock.calls)).not.toContain('steam_player_group')
    expect(f.api.connectWithToolbox).not.toHaveBeenCalled(); expect(localApi.start).not.toHaveBeenCalled()
  })
})
