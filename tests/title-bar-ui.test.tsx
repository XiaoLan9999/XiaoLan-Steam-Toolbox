import type { ReactElement, ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WindowUiApi, WindowUiState } from '../src/shared/window-ui'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'zh-CN' | 'en' }))
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
        hooks.slots[index] = entry; hooks.effects.push(() => { entry.cleanup = effect() })
      }
    }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language,
  t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }), I18nProvider: ({ children }: { children: ReactNode }) => children }))
import { TitleBar } from '../src/renderer/src/components/TitleBar'
import { AppLogo } from '../src/renderer/src/components/AppLogo'

const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''

afterEach(() => { for (const entry of hooks.slots) entry?.cleanup?.(); hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en'; vi.unstubAllGlobals() })

async function fixture(options: { language?: 'zh-CN' | 'en'; state?: WindowUiState; initialPromise?: Promise<WindowUiState> } = {}) {
  hooks.language = options.language ?? 'en'
  const listeners = new Set<(state: WindowUiState) => void>()
  const unsubscribe = vi.fn()
  const api = {
    state: vi.fn(async (): Promise<WindowUiState> => options.state ?? { maximized: false, focused: true }),
    minimize: vi.fn(async (): Promise<void> => undefined),
    toggleMaximize: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
    onState: vi.fn((listener: (state: WindowUiState) => void) => { listeners.add(listener); return () => { unsubscribe(); listeners.delete(listener) } })
  } satisfies WindowUiApi
  if (options.initialPromise) api.state.mockReturnValueOnce(options.initialPromise)
  const props = { api: api as WindowUiApi }
  let root: ReactElement<any>
  const render = () => { hooks.cursor = 0; root = TitleBar(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && node.props['aria-label'] === label)
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  render(); await settle()
  return { api, props, root: () => root, render, settle, button, click, unsubscribe,
    async emit(value: WindowUiState) { for (const listener of listeners) listener(value); await settle() }
  }
}

describe('toolbox custom title bar', () => {
  it.each(['zh-CN', 'en'] as const)('shows the actual localized brand and existing app logo without starting window actions in %s', async language => {
    const f = await fixture({ language })
    expect(text(f.root())).toContain(language === 'en' ? 'XiaoLan Steam Toolbox' : '小蓝Steam工具箱')
    expect(text(f.root())).toContain('LOCAL PROJECT')
    expect(nodes(f.root()).find(node => node.type === AppLogo)?.props.size).toBe(22)
    expect(f.api.state).toHaveBeenCalledOnce(); expect(f.api.onState).toHaveBeenCalledOnce()
    expect(f.api.minimize).not.toHaveBeenCalled(); expect(f.api.toggleMaximize).not.toHaveBeenCalled(); expect(f.api.close).not.toHaveBeenCalled()
    expect(nodes(f.root()).filter(node => node.type === 'button')).toHaveLength(3)
  })

  it('uses live Main state for restore and focus appearance rather than guessing from screen dimensions', async () => {
    const f = await fixture()
    expect(f.button('Maximize window')['aria-pressed']).toBe(false)
    await f.emit({ maximized: true, focused: false })
    expect(f.button('Restore window')['aria-pressed']).toBe(true)
    expect(f.root().props.className).toContain('unfocused')
    await f.emit({ maximized: false, focused: true })
    expect(f.button('Maximize window')['aria-pressed']).toBe(false)
    expect(f.root().props.className).toContain('focused')
  })

  it('uses Main language state even outside the App translation provider and retains it across focus-only events', async () => {
    const f = await fixture({ language: 'zh-CN', state: { maximized: false, focused: true, language: 'en' } })
    expect(text(f.root())).toContain('XiaoLan Steam Toolbox')
    expect(f.button('Minimize window')).toBeDefined()
    await f.emit({ maximized: false, focused: false })
    expect(text(f.root())).toContain('XiaoLan Steam Toolbox')
    await f.emit({ maximized: false, focused: true, language: 'zh-CN' })
    expect(text(f.root())).toContain('小蓝Steam工具箱')
    expect(f.button('最小化窗口')).toBeDefined()
  })

  it('does not let a late initial state overwrite a newer Main event', async () => {
    const pending = deferred<WindowUiState>()
    const f = await fixture({ initialPromise: pending.promise })
    await f.emit({ maximized: true, focused: false })
    pending.resolve({ maximized: false, focused: true }); await f.settle()
    expect(f.button('Restore window')['aria-pressed']).toBe(true)
    expect(f.root().props.className).toContain('unfocused')
  })

  it.each([['Minimize window', 'minimize'], ['Maximize window', 'toggleMaximize'], ['Close window', 'close']] as const)('dispatches %s only through its Main API', async (label, method) => {
    const f = await fixture()
    await f.click(label)
    expect(f.api[method]).toHaveBeenCalledExactlyOnceWith()
    for (const name of ['minimize', 'toggleMaximize', 'close'] as const) if (name !== method) expect(f.api[name]).not.toHaveBeenCalled()
  })

  it('routes close through Main without directly invoking browser close or destroy', async () => {
    const close = vi.fn(), destroy = vi.fn()
    vi.stubGlobal('window', { close, destroy })
    const f = await fixture()
    await f.click('Close window')
    expect(f.api.close).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled()
  })

  it('routes a caption double-click to Main toggle, without treating other mouse buttons as maximize', async () => {
    const f = await fixture()
    const caption = nodes(f.root()).find(node => node.props.className === 'window-titlebar-caption')!
    caption.props.onDoubleClick({ button: 0 }); await f.settle()
    expect(f.api.toggleMaximize).toHaveBeenCalledOnce()
    caption.props.onDoubleClick({ button: 2 }); await f.settle()
    expect(f.api.toggleMaximize).toHaveBeenCalledOnce()
  })

  it('isolates caption-control double-clicks from the draggable caption handler', async () => {
    const f = await fixture()
    const stopPropagation = vi.fn()
    for (const node of nodes(f.root()).filter(node => node.type === 'button')) node.props.onDoubleClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledTimes(3)
    expect(f.api.toggleMaximize).not.toHaveBeenCalled()
  })

  it('serializes duplicate window actions until the in-flight Main request settles', async () => {
    const f = await fixture()
    const pending = deferred<void>()
    f.api.toggleMaximize.mockReturnValueOnce(pending.promise)
    const click = f.button('Maximize window').onClick
    click(); click(); await f.settle()
    expect(f.api.toggleMaximize).toHaveBeenCalledOnce()
    expect(f.button('Close window').disabled).toBe(true)
    pending.resolve(); await f.settle()
    expect(f.button('Close window').disabled).toBe(false)
  })

  it('recovers controls after failure without rendering raw Main error details', async () => {
    const f = await fixture()
    f.api.close.mockRejectedValueOnce(new Error('private-path-and-account-fixture'))
    await f.click('Close window')
    expect(f.button('Close window').disabled).toBe(false)
    expect(text(f.root())).toContain('The window operation did not complete')
    expect(text(f.root())).not.toContain('private-path-and-account-fixture')
  })

  it('releases the event subscription and ignores responses from the previous API epoch', async () => {
    const pending = deferred<WindowUiState>()
    const f = await fixture({ initialPromise: pending.promise })
    const previous = f.api.onState.mock.calls[0]![0]
    f.props.api = { ...f.api, state: async () => ({ maximized: true, focused: true }) }
    f.render(); await f.settle()
    pending.resolve({ maximized: false, focused: false }); previous({ maximized: false, focused: false }); await f.settle()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.button('Restore window')['aria-pressed']).toBe(true)
  })

  it('has a scoped static drag surface with explicit no-drag controls and no animated or blurred backdrop', () => {
    const css = readFileSync(new URL('../src/renderer/src/components/title-bar.css', import.meta.url), 'utf8')
    expect(css).toContain('-webkit-app-region: drag')
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css).toContain('background: var(--panel)')
    expect(css).toContain('.desktop-window-content')
    expect(css).toContain('min-height: 0')
    expect(css).not.toMatch(/(?:backdrop-filter|animation|transition|filter)\s*:/)
  })
})
