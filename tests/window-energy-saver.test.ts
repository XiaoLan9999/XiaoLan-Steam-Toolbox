import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowEnergySaver, WINDOW_ENERGY_COMPACT_DELAY_MS } from '../src/main/window-energy-saver'

const resources: Array<ReturnType<typeof createWindowEnergySaver>> = []

function fixture(options: { visible?: boolean; minimized?: boolean; enabled?: boolean } = {}) {
  const window = Object.assign(new EventEmitter(), {
    visible: options.visible ?? true, minimized: options.minimized ?? false, destroyed: false,
    isVisible() { return this.visible }, isMinimized() { return this.minimized }, isDestroyed() { return this.destroyed },
    webContents: { isDestroyed: () => false, setBackgroundThrottling: vi.fn() }
  })
  let enabled = options.enabled ?? true
  const onChange = vi.fn()
  const compact = vi.fn<() => void | Promise<void>>()
  const saver = createWindowEnergySaver({ window: window as unknown as BrowserWindow, enabled: () => enabled, onChange, compact })
  resources.push(saver)
  const hide = () => { window.visible = false; window.emit('hide') }
  const show = () => { window.visible = true; window.minimized = false; window.emit('show') }
  const minimize = () => { window.minimized = true; window.emit('minimize') }
  const restore = () => { window.minimized = false; window.emit('restore') }
  return { window, onChange, compact, saver, hide, show, minimize, restore, enabled: (value: boolean) => { enabled = value; saver.refresh() } }
}

afterEach(() => { for (const saver of resources.splice(0)) saver.shutdown(); vi.useRealTimers() })

describe('main-window background energy saving', () => {
  it('uses normal background throttling without treating blur as hidden', async () => {
    vi.useFakeTimers()
    const f = fixture()
    expect(f.window.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(true)
    f.window.emit('blur')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.compact).not.toHaveBeenCalled()
  })

  it.each(['hide', 'minimize'] as const)('enters on %s and compacts only after 30 background seconds', async action => {
    vi.useFakeTimers()
    const f = fixture()
    f[action]()
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith(true)
    await vi.advanceTimersByTimeAsync(WINDOW_ENERGY_COMPACT_DELAY_MS - 1)
    expect(f.compact).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.compact).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5 * WINDOW_ENERGY_COMPACT_DELAY_MS)
    expect(f.compact).toHaveBeenCalledOnce()
    expect(f.window.webContents.setBackgroundThrottling.mock.calls.every(([value]) => value === true)).toBe(true)
  })

  it('does not postpone or repeat compaction when duplicate background events arrive', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hide()
    await vi.advanceTimersByTimeAsync(15_000)
    f.window.emit('hide')
    f.window.emit('minimize')
    f.saver.refresh()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.onChange).toHaveBeenCalledOnce()
    expect(f.compact).toHaveBeenCalledOnce()
  })

  it('cancels compaction on restore and preserves the foreground UI', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.minimize()
    await vi.advanceTimersByTimeAsync(25_000)
    f.restore()
    expect(f.onChange.mock.calls).toEqual([[true], [false]])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).not.toHaveBeenCalled()
    f.hide()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).toHaveBeenCalledOnce()
    f.show()
    expect(f.onChange).toHaveBeenLastCalledWith(false)
  })

  it('responds to a disabled or re-enabled setting without destroying windows', async () => {
    vi.useFakeTimers()
    const f = fixture({ enabled: false })
    f.hide()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.compact).not.toHaveBeenCalled()
    f.enabled(true)
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith(true)
    await vi.advanceTimersByTimeAsync(20_000)
    f.enabled(false)
    expect(f.onChange).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).not.toHaveBeenCalled()
    expect(f.window.destroyed).toBe(false)
  })

  it('handles an initially hidden window and cancels timers/listeners on close', async () => {
    vi.useFakeTimers()
    const f = fixture({ visible: false })
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(vi.getTimerCount()).toBe(1)
    f.window.destroyed = true
    f.window.emit('closed')
    expect(vi.getTimerCount()).toBe(0)
    for (const event of ['show', 'hide', 'minimize', 'restore', 'closed']) expect(f.window.listenerCount(event)).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    f.saver.refresh()
    expect(f.compact).not.toHaveBeenCalled()
  })

  it('does not compact after an explicit shutdown or a destroyed window', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hide()
    f.window.destroyed = true
    f.saver.refresh()
    f.saver.shutdown()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates observer failures and rejected cleanup from application work', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.onChange.mockImplementation(() => { throw new Error('synthetic observer') })
    f.compact.mockRejectedValue(new Error('synthetic cleanup'))
    expect(() => f.hide()).not.toThrow()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).toHaveBeenCalledOnce()
    expect(() => f.show()).not.toThrow()
    expect(f.window.destroyed).toBe(false)
  })

  it('does not start overlapping cleanup across rapid minimize/restore periods', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let resolve!: () => void
    f.compact.mockReturnValueOnce(new Promise<void>(done => { resolve = done }))
    f.hide()
    await vi.advanceTimersByTimeAsync(30_000)
    f.show()
    f.hide()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).toHaveBeenCalledOnce()
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    f.show()
    f.hide()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.compact).toHaveBeenCalledTimes(2)
  })
})
