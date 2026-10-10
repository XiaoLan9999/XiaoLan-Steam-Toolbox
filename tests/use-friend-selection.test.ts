/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useFriendSelection } from '../src/renderer/src/use-friend-selection'

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>)
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect) }
}))

type Pointer = ReactPointerEvent<HTMLDivElement>
let cleanups: Array<() => void>
let frames: Map<number, FrameRequestCallback>

beforeEach(() => {
  cleanups = []
  effects.length = 0
  frames = new Map()
  let frameId = 0
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerHeight: 220 }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})

afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  vi.unstubAllGlobals()
})

function mount(ids = ['a', 'b', 'c', 'd', 'e'], initial = new Set<string>()) {
  let controls!: ReturnType<typeof useFriendSelection>
  let selected = initial
  const onChange = vi.fn((value: Set<string>) => { selected = value })
  function Harness() {
    controls = useFriendSelection('account', ids, initial, onChange)
    return null
  }
  // Render real React hooks without a DOM; only their browser effects are deferred.
  renderToStaticMarkup(createElement(Harness))
  const rows = ids.map((id, index) => ({
    dataset: { friendId: id },
    getBoundingClientRect: () => ({ bottom: (index + 1) * 40 })
  }))
  let capture: number | null = null
  const container = {
    scrollTop: 0,
    contains: (row: unknown) => rows.includes(row as typeof rows[number]),
    getBoundingClientRect: () => ({ top: 0, bottom: 220 }),
    querySelectorAll: () => rows,
    setPointerCapture: (pointerId: number) => { capture = pointerId },
    hasPointerCapture: (pointerId: number) => capture === pointerId,
    releasePointerCapture: () => { capture = null }
  }
  controls.containerRef.current = container as unknown as HTMLDivElement
  for (const effect of effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  function pointer(index: number, overrides: Partial<Pointer> = {}, interactive = false): Pointer {
    return {
      button: 0,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 100,
      clientY: index * 40 + 20,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      target: { closest: (selector: string) => selector.startsWith('tr') ? rows[index] : interactive ? {} : null },
      ...overrides
    } as unknown as Pointer
  }
  function click(index: number, overrides: Partial<Pointer> = {}) {
    controls.beginDrag(pointer(index, overrides))
    controls.finishDrag(pointer(index, overrides))
  }
  return { controls, onChange, pointer, click, container, selected: () => selected, capture: () => capture }
}

describe('friend selection pointer gestures', () => {
  it('does not modify selection or auto-scroll while a click is pending', () => {
    const test = mount(undefined, new Set(['a', 'hidden']))
    test.controls.beginDrag(test.pointer(4))
    test.controls.moveDrag(test.pointer(4, { clientX: 103, clientY: 184 }))
    expect(test.onChange).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(test.container.scrollTop).toBe(0)
    test.controls.finishDrag(test.pointer(4, { clientX: 103, clientY: 184 }))
    expect([...test.selected()]).toEqual(['a', 'hidden', 'e'])
    expect(test.onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps 1000 selections when clicking another row and removes only a clicked selected row', () => {
    const ids = Array.from({ length: 1005 }, (_, index) => String(index))
    const test = mount(ids, new Set(ids.slice(0, 1000)))
    test.click(1000)
    expect(test.selected().size).toBe(1001)
    test.click(1)
    expect(test.selected().size).toBe(1000)
    expect(test.selected().has('1')).toBe(false)
    expect(test.selected().has('1000')).toBe(true)
    expect(test.selected().has('999')).toBe(true)
  })

  it('treats a fast down/up displacement as a drag, not a toggle', () => {
    const test = mount(undefined, new Set(['hidden', 'e']))
    test.controls.beginDrag(test.pointer(0))
    test.controls.finishDrag(test.pointer(2))
    expect([...test.selected()]).toEqual(['hidden', 'e', 'a', 'b', 'c'])
    expect(test.onChange).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    expect(test.capture()).toBeNull()
  })

  it('starts horizontal dragging only after crossing the threshold', () => {
    const test = mount(undefined, new Set(['hidden', 'a']))
    test.controls.beginDrag(test.pointer(1))
    test.controls.moveDrag(test.pointer(1, { clientX: 105 }))
    expect(test.onChange).not.toHaveBeenCalled()
    test.controls.moveDrag(test.pointer(1, { clientX: 106 }))
    expect([...test.selected()]).toEqual(['hidden', 'a', 'b'])
    expect(frames.size).toBe(1)
    test.controls.finishDrag(test.pointer(1, { clientX: 106 }))
    expect([...test.selected()]).toEqual(['hidden', 'a', 'b'])
  })

  it.each([false, true])('keeps earlier single selections and hidden friends when ordinary dragging starts on a selected=%s row', (originSelected) => {
    const test = mount(undefined, new Set(['hidden']))
    test.click(4)
    if (originSelected) test.click(1)
    test.controls.beginDrag(test.pointer(1))
    expect(test.selected()).toEqual(new Set(['hidden', 'e', ...(originSelected ? ['b'] : [])]))
    test.controls.moveDrag(test.pointer(3))
    expect(test.selected()).toEqual(new Set(['hidden', 'e', 'b', 'c', 'd']))
    test.controls.finishDrag(test.pointer(3))
    expect(test.selected()).toEqual(new Set(['hidden', 'e', 'b', 'c', 'd']))
    test.click(2)
    expect(test.selected()).toEqual(new Set(['hidden', 'e', 'b', 'd']))
  })

  it('preserves 1000 existing selections through drag updates, range shrink and pointer release', () => {
    const ids = Array.from({ length: 1005 }, (_, index) => String(index))
    const initial = new Set([...ids.slice(5), 'hidden'])
    const test = mount(ids, initial)
    test.controls.beginDrag(test.pointer(0))
    test.controls.moveDrag(test.pointer(4))
    expect(test.selected().size).toBe(1006)
    expect([...initial].every((id) => test.selected().has(id))).toBe(true)
    test.controls.moveDrag(test.pointer(2))
    expect(test.selected().size).toBe(1004)
    expect([...initial].every((id) => test.selected().has(id))).toBe(true)
    expect(test.selected().has('3')).toBe(false)
    expect(test.selected().has('4')).toBe(false)
    test.controls.finishDrag(test.pointer(2))
    expect(test.selected().size).toBe(1004)
    expect([...initial].every((id) => test.selected().has(id))).toBe(true)
    expect(test.capture()).toBeNull()
    expect(frames.size).toBe(0)
    expect(initial.size).toBe(1001)
  })

  it.each(['ctrlKey', 'metaKey'] as const)('preserves %s additive and subtractive dragging', (modifier) => {
    const test = mount(undefined, new Set(['a', 'hidden']))
    test.controls.beginDrag(test.pointer(1, { [modifier]: true }))
    test.controls.moveDrag(test.pointer(3))
    test.controls.finishDrag(test.pointer(3))
    expect([...test.selected()]).toEqual(['a', 'hidden', 'b', 'c', 'd'])
    test.controls.beginDrag(test.pointer(1, { [modifier]: true }))
    test.controls.finishDrag(test.pointer(2))
    expect([...test.selected()]).toEqual(['a', 'hidden', 'd'])
  })

  it('supports Shift-click and Shift-drag from the established anchor', () => {
    const test = mount(undefined, new Set(['hidden']))
    test.click(1)
    test.click(3, { shiftKey: true })
    expect([...test.selected()]).toEqual(['hidden', 'b', 'c', 'd'])
    test.controls.beginDrag(test.pointer(3, { shiftKey: true }))
    test.controls.finishDrag(test.pointer(0))
    expect([...test.selected()]).toEqual(['hidden', 'b', 'c', 'd', 'a'])
  })

  it('runs edge scrolling only for an actual drag and cancels its animation frame', () => {
    const test = mount()
    test.controls.beginDrag(test.pointer(3))
    test.controls.moveDrag(test.pointer(4, { clientY: 210 }))
    const [id, callback] = [...frames.entries()][0]!
    frames.delete(id)
    callback(0)
    expect(test.container.scrollTop).toBeGreaterThan(0)
    expect(frames.size).toBe(1)
    test.controls.stopDrag()
    expect(frames.size).toBe(0)
  })

  it.each(['cancel', 'blur', 'unmount'])('does not toggle a pending click after %s', (reason) => {
    const test = mount(undefined, new Set(['hidden']))
    test.controls.beginDrag(test.pointer(0))
    if (reason === 'blur') window.dispatchEvent(new Event('blur'))
    else if (reason === 'unmount') for (const cleanup of cleanups.splice(0)) cleanup()
    else test.controls.stopDrag()
    test.controls.finishDrag(test.pointer(0))
    expect(test.onChange).not.toHaveBeenCalled()
    expect(test.capture()).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('does not hijack interactive controls or another pointer', () => {
    const test = mount()
    const controlEvent = test.pointer(0, {}, true)
    test.controls.beginDrag(controlEvent)
    test.controls.finishDrag(controlEvent)
    expect(controlEvent.preventDefault).not.toHaveBeenCalled()
    expect(test.onChange).not.toHaveBeenCalled()
    test.controls.beginDrag(test.pointer(1))
    test.controls.finishDrag(test.pointer(4, { pointerId: 2 }))
    expect(test.onChange).not.toHaveBeenCalled()
    test.controls.finishDrag(test.pointer(1))
    expect([...test.selected()]).toEqual(['b'])
  })
})
