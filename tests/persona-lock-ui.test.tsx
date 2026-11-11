import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import type { PersonaLockApi, PersonaLockSnapshot } from '../src/shared/persona-lock'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'zh' | 'en' }))
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value }]
    },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
      const index = hooks.cursor++, previous = hooks.slots[index]
      if (!previous || dependencies.some((value, item) => !Object.is(previous.dependencies[item], value))) {
        previous?.cleanup?.()
        const entry = { dependencies, cleanup: undefined as void | (() => void) }
        hooks.slots[index] = entry
        hooks.effects.push(() => { entry.cleanup = effect() })
      }
    }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language,
  t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }) }))
import { PersonaLockPanel } from '../src/renderer/src/components/PersonaLockPanel'

const accountA = { id: 'persona-ui-A', steamId: '76561198000000001' } as AccountView
const accountB = { id: 'persona-ui-B', steamId: '76561198000000002' } as AccountView
const base: PersonaLockSnapshot = { available: true, sessionId: 'persona-ui-session', accountId: null, steamId: null, status: 'idle',
  currentState: null, originalState: null, lastCheckedAt: null, restored: null, error: null, busy: false }
const locked: PersonaLockSnapshot = { ...base, accountId: accountA.id, steamId: accountA.steamId, status: 'locked',
  currentState: 4, originalState: 1, lastCheckedAt: '2026-11-09T01:00:00.000Z' }
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''

afterEach(() => { for (const entry of hooks.slots) entry?.cleanup?.(); hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en' })

async function fixture(options: { initial?: PersonaLockSnapshot; language?: 'zh' | 'en'; account?: AccountView | null; initialPromise?: Promise<PersonaLockSnapshot> } = {}) {
  hooks.language = options.language ?? 'en'
  let snapshot = options.initial ?? base
  const listeners = new Set<(snapshot: PersonaLockSnapshot) => void>()
  const api = {
    state: vi.fn(async (): Promise<PersonaLockSnapshot> => snapshot),
    start: vi.fn(async (): Promise<PersonaLockSnapshot> => ({ ...locked, accountId: props.account!.id, steamId: props.account!.steamId, sessionId: snapshot.sessionId })),
    stop: vi.fn(async (): Promise<PersonaLockSnapshot> => ({ ...base, accountId: props.account!.id, steamId: props.account!.steamId,
      sessionId: 'persona-ui-after-stop', currentState: 1, restored: true })),
    onChange: vi.fn((listener: (value: PersonaLockSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  } satisfies PersonaLockApi
  if (options.initialPromise) api.state.mockReturnValueOnce(options.initialPromise)
  const props: { account: AccountView | null; api: PersonaLockApi } = { account: options.account === undefined ? accountA : options.account, api }
  let root: ReactElement
  const render = () => { hooks.cursor = 0; root = PersonaLockPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && text(node.props.children) === label)
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  render(); await settle()
  return { api, props, render, settle, button, click, root: () => root,
    emit(value: PersonaLockSnapshot) { snapshot = value; for (const listener of listeners) listener(value); render() } }
}

describe('persona lock UI without native activity', () => {
  it.each(['zh', 'en'] as const)('does not expose a working lock when live verification failed in %s', async language => {
    const f = await fixture({ language, initial: { ...base, available: false } })
    const start = language === 'zh' ? '锁定睡觉状态' : 'Lock snooze state'
    expect(f.button(start).disabled).toBe(true)
    await f.click(start)
    expect(f.api.start).not.toHaveBeenCalled()
    expect(text(f.root())).toContain(language === 'zh' ? '本机实测尚未确认生效' : 'live verification has not confirmed it works')
  })
  it.each(['zh', 'en'] as const)('loads only a snapshot and explicitly documents unsupported device icons in %s', async language => {
    const f = await fixture({ language })
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.stop).not.toHaveBeenCalled()
    const content = text(f.root())
    expect(content).toContain(language === 'zh' ? '重开工具箱不会自动锁定' : 'locking never restarts automatically')
    expect(content).toContain(language === 'zh' ? '不创建假游戏，也不改写游戏富状态' : 'without signing in again, creating a fake game or rewriting game Rich Presence')
    expect(content).toContain(language === 'zh' ? 'VR／Steam Deck 是独立设备标识，目前尚未接入可安全验证的本机修改接口' : 'VR and Steam Deck are separate device indicators; a verified local setter is not available yet')
    expect(content).toContain(language === 'zh' ? '不会用大屏幕模式或文字冒充' : 'neither Big Picture mode nor text is used to imitate them')
    expect(nodes(f.root()).filter(node => node.type === 'input' || node.type === 'select')).toHaveLength(0)
    expect(nodes(f.root()).filter(node => node.type === 'button')).toHaveLength(2)
  })

  it.each(['zh', 'en'] as const)('requires explicit Snooze start and stop actions with current account and session in %s', async language => {
    const f = await fixture({ language })
    const start = language === 'zh' ? '锁定睡觉状态' : 'Lock snooze state'
    const stop = language === 'zh' ? '解除锁定并恢复' : 'Unlock and restore'
    expect(f.button(start).disabled).toBe(false)
    expect(f.button(stop).disabled).toBe(true)
    await f.click(start)
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: accountA.id, sessionId: base.sessionId, mode: 'snooze' })
    expect(f.button(start).disabled).toBe(true)
    expect(f.button(stop).disabled).toBe(false)
    expect(text(f.root())).toContain(language === 'zh' ? '这不是好友端显示确认' : 'this does not confirm a friend-client display')
    await f.click(stop)
    expect(f.api.stop).toHaveBeenCalledExactlyOnceWith({ accountId: accountA.id, sessionId: base.sessionId })
    expect(text(f.root())).toContain(language === 'zh' ? '原在线状态已在本机回读恢复' : 'The original online state was restored on local readback')
  })

  it('does not start while account selection or the initial snapshot is missing', async () => {
    const state = pending<PersonaLockSnapshot>()
    const f = await fixture({ initialPromise: state.promise })
    expect(f.button('Lock snooze state').disabled).toBe(true)
    await f.click('Lock snooze state')
    expect(f.api.start).not.toHaveBeenCalled()
    state.resolve(base); await f.settle()
    f.props.account = null; f.render(); await f.settle()
    expect(f.button('Lock snooze state').disabled).toBe(true)
    await f.click('Lock snooze state')
    expect(f.api.start).not.toHaveBeenCalled()
  })

  it('ignores a stale account start result after switching and sends only the new session on a later explicit click', async () => {
    const f = await fixture()
    const start = pending<PersonaLockSnapshot>()
    f.api.start.mockReturnValueOnce(start.promise)
    await f.click('Lock snooze state')
    expect(f.api.start).toHaveBeenCalledOnce()
    const next = { ...base, sessionId: 'persona-ui-B-session' }
    f.api.state.mockResolvedValue(next)
    f.props.account = accountB; f.render(); await f.settle()
    start.resolve(locked); await f.settle()
    expect(text(f.root())).not.toContain('Snooze matched on local readback')
    expect(f.button('Lock snooze state').disabled).toBe(false)
    await f.click('Lock snooze state')
    expect(f.api.start).toHaveBeenLastCalledWith({ accountId: accountB.id, sessionId: next.sessionId, mode: 'snooze' })
    expect(f.api.stop).not.toHaveBeenCalled()
  })

  it('ignores both a late initial snapshot and an old subscription callback after account change', async () => {
    const initial = pending<PersonaLockSnapshot>()
    const f = await fixture({ initialPromise: initial.promise })
    const staleListener = f.api.onChange.mock.calls[0]![0]
    f.api.state.mockResolvedValue({ ...base, sessionId: 'B-current' })
    f.props.account = accountB; f.render(); await f.settle()
    initial.resolve(locked)
    staleListener({ ...locked, error: 'PERSONA_UNCONFIRMED' })
    await f.settle()
    expect(text(f.root())).not.toContain('Snooze matched on local readback')
    expect(nodes(f.root()).some(node => node.props.role === 'alert')).toBe(false)
    await f.click('Lock snooze state')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: accountB.id, sessionId: 'B-current', mode: 'snooze' })
  })

  it('shows a privacy interruption without claiming restoration or automatically restarting the lock', async () => {
    const f = await fixture({ initial: locked })
    f.emit({ ...locked, status: 'error', currentState: 7, originalState: null, restored: false, error: 'PERSONA_PRIVATE_STATE' })
    expect(text(f.root())).toContain('Offline or invisible state detected; locking stopped and that state was preserved')
    expect(text(f.root())).not.toContain('The original online state was restored on local readback')
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.stop).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'] as const)('keeps rejected native details private and provides a local-only explanation in %s', async language => {
    const f = await fixture({ language })
    f.api.start.mockRejectedValueOnce({ code: 'NATIVE_PRIVATE_DETAIL', message: 'synthetic private DLL path/token payload' })
    await f.click(language === 'zh' ? '锁定睡觉状态' : 'Lock snooze state')
    const alert = nodes(f.root()).find(node => node.props.role === 'alert')
    expect(text(alert)).toContain(language === 'zh' ? '不会启动 SteamVR 或大屏幕模式' : 'no separate login, SteamVR or Big Picture mode is started')
    expect(text(f.root())).not.toContain('synthetic private')
  })
})
