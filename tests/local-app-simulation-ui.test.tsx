import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import type { GameStatusAppInfo, GameStatusPresence } from '../src/shared/game-status'
import type { LocalAppSimulationApi, LocalAppSimulationSnapshot } from '../src/shared/local-app-simulation'
import { richPresenceContract } from '../src/shared/rich-presence-contract'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void> }))
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.slots[index]) : value }] },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useLayoutEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { const index = hooks.cursor++; const previous = hooks.slots[index]; if (!previous || dependencies.some((value, i) => !Object.is(previous.dependencies[i], value))) { previous?.cleanup?.(); const entry = { dependencies, cleanup: undefined as void | (() => void) }; hooks.slots[index] = entry; hooks.effects.push(() => { entry.cleanup = effect() }) } }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: 'en', t: (_zh: string, en: string) => en }) }))
import { LocalAppSimulationPanel, localSimulationError } from '../src/renderer/src/components/LocalAppSimulationPanel'

const account = { id: 'local-ui-A', steamId: '76561198000000001' } as AccountView
const base: LocalAppSimulationSnapshot = { sessionId: 'local-ui-session', accountId: account.id, steamId: account.steamId,
  status: 'idle', busy: false, appId: null, appInfo: null, fields: {}, localizedString: null, verificationSource: null, error: null }
const info: GameStatusAppInfo = { appId: 1329410, name: 'Synthetic game', iconUrl: null, language: 'english',
  templates: [{ token: '#Game', text: '%desc%', parameters: ['desc'] }], templateStatus: 'available' }
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''
afterEach(() => { for (const entry of hooks.slots) entry?.cleanup?.(); hooks.cursor = 0; hooks.slots = []; hooks.effects = [] })

async function fixture(options: { initial?: LocalAppSimulationSnapshot; presence?: GameStatusPresence; appIdText?: string; restore?: boolean; groupSize?: number } = {}) {
  let snapshot = options.initial ?? base
  const listeners = new Set<(state: LocalAppSimulationSnapshot) => void>()
  const api = { state: vi.fn(async () => snapshot), inspect: vi.fn(async () => info),
    start: vi.fn(async (): Promise<LocalAppSimulationSnapshot> => ({ ...base, status: 'running', appId: 1329410, appInfo: info, verificationSource: 'local-cache' })),
    stop: vi.fn(async () => ({ ...base })), onChange: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }) } satisfies LocalAppSimulationApi
  const onGroupSizeChange = vi.fn<(value: number | undefined) => void>()
  const props = { account, api, appIdText: options.appIdText ?? '1329410', presence: options.presence, groupSize: options.groupSize,
    onAppIdChange: vi.fn(), onPresenceChange: vi.fn(), onGroupSizeChange, onSaveDraft: vi.fn(), saveBusy: false, liveRestoreRequired: options.restore ?? false }
  onGroupSizeChange.mockImplementation(value => { props.groupSize = value })
  let root: ReactElement
  const render = () => { hooks.cursor = 0; root = LocalAppSimulationPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => { const node = nodes(root).find(node => node.type === 'button' && text(node.props.children) === label); if (!node) throw new Error(`Missing ${label}`); return node.props }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  render(); await settle()
  return { api, props, render, settle, button, click, root: () => root,
    emit(state: LocalAppSimulationSnapshot) { snapshot = state; for (const listener of listeners) listener(state); render() } }
}

describe('local AppID simulation UI', () => {
  it('retries the current template lookup without starting, stopping or submitting a status', async () => {
    const f = await fixture({ initial: { ...base, status: 'running', appId: info.appId, appInfo: info } })
    const editor = nodes(f.root()).find(node => typeof node.type === 'function' && node.type.name === 'GameStatusTemplateEditor')!
    expect(editor.props.onRetry).toBeTypeOf('function')
    editor.props.onRetry(); await f.settle()
    expect(f.api.inspect).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: info.appId, language: 'english' })
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.stop).not.toHaveBeenCalled(); expect(f.props.onPresenceChange).not.toHaveBeenCalled()
  })

  it.each([
    ['LOCAL_APP_PROFILE_UNSUPPORTED', '当前 Steam 客户端版本尚未适配', 'Steam client version is not supported'],
    ['LOCAL_APP_NOT_LICENSED', '未确认此 AppID 的可用许可', 'has not confirmed a usable license'],
    ['LOCAL_APP_INIT_FAILED', '接口初始化失败', 'interface could not initialize'],
    ['LOCAL_APP_IDENTITY_MISMATCH', '账号身份与工具箱所选账号不同', 'identity does not match'],
    ['LOCAL_APP_APP_MISMATCH', '未建立请求 AppID 的本机接口上下文', 'requested AppID'],
    ['LOCAL_APP_DLL_INVALID', '未通过完整性校验', 'DLL failed its integrity check']
  ])('explains %s separately in Chinese and English', (code, zh, en) => {
    expect(localSimulationError(code, text => text)).toContain(zh)
    expect(localSimulationError(code, (_zh, text) => text)).toContain(en)
  })
  it('distinguishes a Steam profile update from license ownership or game installation', async () => {
    const f = await fixture({ appIdText: '4000' })
    f.api.start.mockRejectedValueOnce({ code: 'LOCAL_APP_PROFILE_UNSUPPORTED', message: 'private SDK path and credential' })
    await f.click('Start local simulation')
    expect(text(f.root())).toContain('Update the toolbox; this is not caused by the target game being uninstalled.')
    expect(text(f.root())).toContain('downloading or installing the target game is not required')
    expect(text(f.root())).not.toContain('private SDK path')
  })
  it('explains a missing session license without asking users to install the game', async () => {
    const f = await fixture({ appIdText: '4000' })
    f.api.start.mockRejectedValueOnce({ code: 'LOCAL_APP_NOT_LICENSED', message: 'private SDK payload' })
    await f.click('Start local simulation')
    expect(text(f.root())).toContain('has not confirmed a usable license for this AppID')
    expect(text(f.root())).not.toContain('private SDK payload')
    expect(localSimulationError('LOCAL_APP_NOT_LICENSED', text => text)).toContain('无需先下载或安装目标游戏')
  })
  const groupCheckbox = (root: ReactNode) => nodes(nodes(root).find(node => node.type === 'label' && text(node).includes('Customize the displayed group size'))).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props
  const groupInput = (root: ReactNode) => nodes(root).find(node => node.type === 'input' && node.props['aria-label'] === 'Simulated total group size')!.props
  const experimentalCheckbox = (root: ReactNode) => nodes(nodes(root).find(node => node.type === 'label' && text(node).includes('Force a substatus attempt (experimental)'))).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props
  const experimentalInput = (root: ReactNode, label: string) => nodes(root).find(node => node.type === 'input' && node.props['aria-label'] === label)!.props
  async function enableExperimental(f: Awaited<ReturnType<typeof fixture>>, key = 'desc', value = 'Synthetic scene') {
    experimentalCheckbox(f.root()).onChange({ target: { checked: true } }); f.render()
    experimentalInput(f.root(), 'Experimental field name 1').onChange({ target: { value: key } }); f.render()
    experimentalInput(f.root(), 'Experimental field value 1').onChange({ target: { value } }); f.render()
  }

  it('uses the common native contract for experimental input bounds', async () => {
    const f = await fixture()
    await enableExperimental(f, `1${'x'.repeat(richPresenceContract.presence.keyAsciiLength - 1)}`, 'Public text')
    const token = `#${'a'.repeat(richPresenceContract.presence.displayTokenBodyLength)}`
    experimentalInput(f.root(), 'Experimental steam_display token').onChange({ target: { value: token } }); f.render()
    expect(experimentalInput(f.root(), 'Experimental steam_display token').maxLength).toBe(richPresenceContract.presence.displayTokenBodyLength + 1)
    expect(experimentalInput(f.root(), 'Experimental field name 1').maxLength).toBe(richPresenceContract.presence.keyAsciiLength)
    expect(experimentalInput(f.root(), 'Experimental field value 1').maxLength).toBe(richPresenceContract.presence.valueUtf8Bytes)
    expect(f.button('Start local simulation').disabled).toBe(false)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledWith(expect.objectContaining({ unverifiedPresence: expect.objectContaining({ steam_display: token }) }))
  })

  it('never enables or restores experimental fields automatically', async () => {
    const f = await fixture({ initial: { ...base, status: 'running', appId: 1329410, submissionMode: 'experimental', fields: { desc: 'Old private draft' } } })
    expect(experimentalCheckbox(f.root()).checked).toBe(false)
    expect(nodes(f.root()).some(node => node.props['aria-label'] === 'Experimental field name 1')).toBe(false)
    expect(text(f.root())).toContain('only the local cache was read, not a friend-client display')
    expect(text(f.root())).not.toContain('Old private draft'); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('allows explicit public fields without any game metadata and retains the normal template draft', async () => {
    const presence = { displayToken: '#OldDraft', values: { status: 'Retain this' } }
    const f = await fixture({ presence, appIdText: '2507950' }); await enableExperimental(f)
    expect(f.button('Start local simulation').disabled).toBe(false)
    expect(text(f.root())).toContain('No #Status token is guessed or added')
    expect(f.button('Save local draft').disabled).toBe(true)
    await f.click('Save local draft'); expect(f.props.onSaveDraft).not.toHaveBeenCalled()
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 2507950, unverifiedPresence: { desc: 'Synthetic scene' } })
    expect(f.api.inspect).not.toHaveBeenCalled(); expect(f.props.onPresenceChange).not.toHaveBeenCalled(); expect(f.props.presence).toBe(presence)
  })
  it('submits a manually specified token and fields, never both experimental and verified presence', async () => {
    const f = await fixture({ presence: { displayToken: '#Game', values: { desc: 'Existing draft' } }, initial: { ...base, appInfo: info } })
    await enableExperimental(f)
    experimentalInput(f.root(), 'Experimental steam_display token').onChange({ target: { value: '#Known_Template' } }); f.render()
    const editor = nodes(f.root()).find(node => typeof node.type === 'function' && node.type.name === 'GameStatusTemplateEditor')!
    expect(editor.props.disabled).toBe(true)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410,
      unverifiedPresence: { desc: 'Synthetic scene', steam_display: '#Known_Template' } })
  })
  it('supports a token-only attempt without adding a fake desc or status field', async () => {
    const f = await fixture(); experimentalCheckbox(f.root()).onChange({ target: { checked: true } }); f.render()
    expect(f.button('Start local simulation').disabled).toBe(true)
    experimentalInput(f.root(), 'Experimental steam_display token').onChange({ target: { value: '#Known' } }); f.render()
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, unverifiedPresence: { steam_display: '#Known' } })
  })
  it.each([
    ['connect', 'not-public'], ['steam_player_group', 'not-public'], ['private_state', 'not-public'], ['desc', ''],
    ['desc', '界'.repeat(86)], ['desc', 'contains\ncontrol'], ['desc', '\ud800']
  ])('rejects unsafe experimental field %s at the UI action boundary', async (key, value) => {
    const f = await fixture(); await enableExperimental(f, key, value)
    expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('rejects duplicate experimental keys before object construction could overwrite them', async () => {
    const f = await fixture(); await enableExperimental(f)
    await f.click('Add public field')
    experimentalInput(f.root(), 'Experimental field name 2').onChange({ target: { value: 'DESC' } }); f.render()
    experimentalInput(f.root(), 'Experimental field value 2').onChange({ target: { value: 'Duplicate' } }); f.render()
    expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
    await f.click('Remove field 2'); expect(f.button('Start local simulation').disabled).toBe(false)
  })
  it.each(['bad token', '#bad token', '#x\ncontrol', `#${'x'.repeat(richPresenceContract.presence.displayTokenBodyLength + 1)}`])('rejects malformed experimental token %j', async token => {
    const f = await fixture(); await enableExperimental(f)
    experimentalInput(f.root(), 'Experimental steam_display token').onChange({ target: { value: token } }); f.render()
    expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('keeps group size separate and reserves two entries in experimental mode', async () => {
    const f = await fixture({ groupSize: 3 }); await enableExperimental(f)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, groupSize: 3, unverifiedPresence: { desc: 'Synthetic scene' } })
  })
  it('switches back to the unchanged published draft without an implicit write', async () => {
    const presence = { displayToken: '#Game', values: { desc: 'Original' } }
    const f = await fixture({ presence, initial: { ...base, appInfo: info } }); await enableExperimental(f)
    experimentalCheckbox(f.root()).onChange({ target: { checked: false } }); f.render()
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.props.onPresenceChange).not.toHaveBeenCalled()
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, presence })
  })
  it.each(['app', 'account'])('clears experimental opt-in, token and fields on %s changes', async kind => {
    const f = await fixture(); await enableExperimental(f)
    experimentalInput(f.root(), 'Experimental steam_display token').onChange({ target: { value: '#Known' } }); f.render()
    if (kind === 'app') f.props.appIdText = '2507950'; else f.props.account = { ...account, id: 'other', steamId: '76561198000000002' }
    f.render(); await f.settle()
    expect(experimentalCheckbox(f.root()).checked).toBe(false)
    experimentalCheckbox(f.root()).onChange({ target: { checked: true } }); f.render()
    expect(experimentalInput(f.root(), 'Experimental steam_display token').value).toBe('')
    expect(experimentalInput(f.root(), 'Experimental field name 1').value).toBe('')
    expect(experimentalInput(f.root(), 'Experimental field value 1').value).toBe('')
    expect(f.api.start).not.toHaveBeenCalled()
  })
  it('clears the experimental form when the simulation session is invalidated', async () => {
    const f = await fixture(); await enableExperimental(f)
    f.emit({ ...base, sessionId: 'replacement-session' }); await f.settle()
    expect(experimentalCheckbox(f.root()).checked).toBe(false)
    experimentalCheckbox(f.root()).onChange({ target: { checked: true } }); f.render()
    expect(experimentalInput(f.root(), 'Experimental field value 1').value).toBe('')
    expect(f.api.start).not.toHaveBeenCalled()
  })
  it('can stop a busy experimental submission and ignores its late success', async () => {
    const f = await fixture(); await enableExperimental(f); const delayed = pending<LocalAppSimulationSnapshot>()
    f.api.start.mockReturnValueOnce(delayed.promise); f.button('Start local simulation').onClick(); await f.settle()
    f.emit({ ...base, status: 'starting', busy: true })
    expect(experimentalCheckbox(f.root()).disabled).toBe(true); expect(f.button('Stop local simulation').disabled).toBe(false)
    await f.click('Stop local simulation')
    delayed.resolve({ ...base, status: 'running', appId: 1329410, submissionMode: 'experimental' }); await f.settle()
    expect(text(f.root())).not.toContain('Experimental fields were submitted'); expect(f.api.stop).toHaveBeenCalledOnce()
  })
  it('does not bypass the live-game restore guard with experimental opt-in', async () => {
    const f = await fixture({ restore: true }); await enableExperimental(f)
    expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
  })

  it('does not customize group size by default or submit an implicit count', async () => {
    const f = await fixture()
    expect(groupCheckbox(f.root()).checked).toBe(false)
    expect(nodes(f.root()).some(node => node.props['aria-label'] === 'Simulated total group size')).toBe(false)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410 })
    expect(f.props.onGroupSizeChange).not.toHaveBeenCalled()
  })

  it('submits an explicit total group size as an integer separate from template variables', async () => {
    const f = await fixture(); groupCheckbox(f.root()).onChange({ target: { checked: true } }); f.render()
    groupInput(f.root()).onChange({ target: { value: '5' } }); f.render()
    expect(f.props.groupSize).toBe(5)
    expect(text(f.root())).toContain('including you'); expect(text(f.root())).toContain('Calculated players excluding you (not friend-client confirmation): 4')
    expect(text(f.root())).toContain('mixed In Game singleton list')
    expect(text(f.root())).not.toContain('Expected other players shown')
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, groupSize: 5 })
    expect(f.props.onPresenceChange).not.toHaveBeenCalled()
  })

  const publishedFields = (count: number) => {
    const parameters = Array.from({ length: count }, (_, index) => `field_${index}`)
    return {
      appInfo: { ...info, templates: [{ token: '#ManyFields', text: parameters.map(key => `%${key}%`).join(' '), parameters }] },
      presence: { displayToken: '#ManyFields', values: Object.fromEntries(parameters.map(key => [key, 'Value'])) }
    }
  }

  it.each(['idle', 'running'] as const)('allows 17 published variables plus a token and both group fields while %s', async status => {
    const { appInfo, presence } = publishedFields(17)
    const f = await fixture({ initial: { ...base, status, appId: info.appId, appInfo }, presence, groupSize: 3 })
    const label = status === 'running' ? 'Update substatus' : 'Start local simulation'
    expect(f.button(label).disabled).toBe(false)
    await f.click(label)
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: info.appId, presence, groupSize: 3 })
  })

  it.each(['idle', 'running'] as const)('blocks an over-capacity published template with group size while %s and recovers when group size is disabled', async status => {
    const { appInfo, presence } = publishedFields(18)
    const f = await fixture({ initial: { ...base, status, appId: info.appId, appInfo }, presence, groupSize: 3 })
    const label = status === 'running' ? 'Update substatus' : 'Start local simulation'
    expect(f.button(label).disabled).toBe(true)
    expect(text(f.root())).toContain("template needs 19 fields including its display token, and group size needs 2 more, exceeding Steam's 20-entry limit")
    await f.click(label); expect(f.api.start).not.toHaveBeenCalled()
    groupCheckbox(f.root()).onChange({ target: { checked: false } }); f.render()
    expect(f.button(label).disabled).toBe(false)
    expect(text(f.root())).not.toContain("exceeding Steam's 20-entry limit")
    await f.click(label)
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: info.appId, presence })
  })

  it('does not reserve group fields for a 19-variable published template when group size is disabled', async () => {
    const { appInfo, presence } = publishedFields(19)
    const f = await fixture({ initial: { ...base, appInfo }, presence })
    expect(f.button('Start local simulation').disabled).toBe(false)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: info.appId, presence })
  })

  it.each([1, 2147483647])('accepts the canonical inclusive group-size boundary %s', async groupSize => {
    const f = await fixture({ groupSize }); expect(f.button('Start local simulation').disabled).toBe(false)
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, groupSize })
  })

  it.each(['', '0', '-1', '02', '2.5', '2147483648', 'words'])('blocks start and saving while the group-size draft is invalid: %j', async value => {
    const f = await fixture({ groupSize: 2 }); groupInput(f.root()).onChange({ target: { value } }); f.render()
    expect(f.button('Start local simulation').disabled).toBe(true); expect(f.button('Save local draft').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
    expect(f.props.groupSize).toBe(2); expect(groupInput(f.root()).value).toBe(value)
  })

  it('retains a valid numeric group size for saving and clears it explicitly when disabled', async () => {
    const f = await fixture({ groupSize: 3 })
    expect(groupCheckbox(f.root()).checked).toBe(true); expect(groupInput(f.root()).value).toBe('3')
    await f.click('Save local draft'); expect(f.props.onSaveDraft).toHaveBeenCalledOnce(); expect(f.props.groupSize).toBe(3)
    groupCheckbox(f.root()).onChange({ target: { checked: false } }); f.render()
    expect(f.props.groupSize).toBeUndefined(); expect(f.props.onGroupSizeChange).toHaveBeenLastCalledWith(undefined)
    await f.click('Start local simulation'); expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410 })
  })

  it('shows a returned group count as local cache data rather than a confirmed friend display', async () => {
    const f = await fixture({ initial: { ...base, status: 'running', appId: 1329410, fields: { steam_player_group_size: '8' }, verificationSource: 'local-cache' } })
    expect(text(f.root())).toContain('Total group size read from the local cache: 8')
    expect(text(f.root())).toContain('friend-client display still needs confirmation')
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.props.groupSize).toBeUndefined()
  })

  it('allows stopping a running simulation even when its edited group-size draft is invalid', async () => {
    const f = await fixture({ groupSize: 2, initial: { ...base, status: 'running', appId: 1329410 } })
    groupInput(f.root()).onChange({ target: { value: 'invalid' } }); f.render()
    expect(f.button('Update substatus').disabled).toBe(true); expect(f.button('Stop local simulation').disabled).toBe(false)
    await f.click('Stop local simulation'); expect(f.api.stop).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId }); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('opens without any implicit game, metadata query or connection request', async () => {
    const f = await fixture()
    expect(f.api.state).toHaveBeenCalledOnce(); expect(f.api.inspect).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('No personal CM sign-in')
    expect(text(f.root())).not.toContain('Connect a separate simulation session')
  })

  it('reads published information and starts only the selected numeric AppID', async () => {
    const f = await fixture(); await f.click('Read game and substatus templates')
    expect(f.api.inspect).toHaveBeenCalledWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, language: 'english' })
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410 })
    expect(text(f.root())).toContain('friend-client display still needs confirmation')
    expect(f.button('Update substatus').disabled).toBe(false)
  })

  it('allows starting only the game when an unverified old draft would otherwise block it', async () => {
    const f = await fixture({ presence: { displayToken: '#Old', values: { desc: 'Retained draft' } } })
    expect(text(f.root())).toContain('without submitting that substatus')
    await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410 })
    expect(f.props.onPresenceChange).not.toHaveBeenCalled()
  })

  it('lets the user clear an obsolete draft explicitly without writing to Steam', async () => {
    const f = await fixture({ presence: { displayToken: '#Old', values: { desc: 'Retained draft' } } })
    await f.click('Clear substatus selection (game only)')
    expect(f.props.onPresenceChange).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(f.api.start).not.toHaveBeenCalled()
  })

  it('submits a validated template only after it is available', async () => {
    const presence = { displayToken: '#Game', values: { desc: 'Synthetic room' } }
    const f = await fixture({ presence }); await f.click('Read game and substatus templates'); await f.click('Start local simulation')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410, presence })
  })

  it('enables Update only after an enum choice produces a valid published token', async () => {
    const enumInfo: GameStatusAppInfo = { ...info, templates: [
      { token: '#Display', text: '{#Mode_%mode%}', parameters: ['mode'] },
      { token: '#Mode_casual', text: 'Casual', parameters: [] }
    ] }
    const f = await fixture({ presence: { displayToken: '#Display', values: { mode: 'abcd' } } })
    f.emit({ ...base, status: 'running', appId: 1329410, appInfo: enumInfo })
    expect(f.button('Update substatus').disabled).toBe(true)
    await f.click('Update substatus'); expect(f.api.start).not.toHaveBeenCalled()
    f.props.presence = { displayToken: '#Display', values: { mode: 'casual' } }; f.render()
    expect(f.button('Update substatus').disabled).toBe(false)
    await f.click('Update substatus')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, appId: 1329410,
      presence: { displayToken: '#Display', values: { mode: 'casual' } } })
  })

  it.each(['', 'bad', '-1', '0', '16777216'])('does not invoke start for invalid AppID %s', async appIdText => {
    const f = await fixture({ appIdText }); expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
  })

  it('preserves native restore protection at the action boundary', async () => {
    const f = await fixture({ restore: true }); expect(f.button('Start local simulation').disabled).toBe(true)
    await f.click('Start local simulation'); expect(f.api.start).not.toHaveBeenCalled()
  })

  it('can stop an in-flight start and ignores its late result', async () => {
    const f = await fixture(); const delayed = pending<LocalAppSimulationSnapshot>()
    f.api.start.mockReturnValueOnce(delayed.promise); f.button('Start local simulation').onClick(); await f.settle()
    f.emit({ ...base, status: 'starting', busy: true, appId: 1329410 })
    expect(f.button('Stop local simulation').disabled).toBe(false)
    await f.click('Stop local simulation')
    delayed.resolve({ ...base, status: 'running', appId: 1329410 }); await f.settle()
    expect(f.api.stop).toHaveBeenCalledOnce(); expect(text(f.root())).not.toContain('local interface is verified')
  })

  it('does not revive an old session after an invalidation event', async () => {
    const f = await fixture(); const delayed = pending<LocalAppSimulationSnapshot>()
    f.api.start.mockReturnValueOnce(delayed.promise); f.button('Start local simulation').onClick(); await f.settle()
    f.emit({ ...base, sessionId: 'new-local-session' })
    delayed.resolve({ ...base, status: 'running', appId: 1329410 }); await f.settle()
    expect(text(f.root())).not.toContain('local interface is verified')
  })

  it('never displays arbitrary SDK error strings', async () => {
    const f = await fixture(); f.api.inspect.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_COOKIE'))
    await f.click('Read game and substatus templates')
    expect(text(f.root())).not.toContain('SYNTHETIC_PRIVATE_COOKIE')
  })
})
