import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisibleTick } from '../src/renderer/src/use-visible-tick'

const energy = vi.hoisted(() => ({ active: false, listeners: new Set<(active: boolean) => void>() }))
vi.mock('../src/renderer/src/energy-saving', () => ({
  isEnergySavingActive: () => energy.active,
  subscribeEnergySaving: (listener: (active: boolean) => void) => {
    energy.listeners.add(listener)
    return () => { energy.listeners.delete(listener) }
  }
}))

const setEnergy = (active: boolean): void => {
  energy.active = active
  for (const listener of energy.listeners) listener(active)
}

beforeEach(() => {
  vi.useFakeTimers()
  energy.active = false
  energy.listeners.clear()
  vi.stubGlobal('window', { setInterval, clearInterval })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('energy-aware display ticker', () => {
  it('stops UI intervals in the background and immediately catches up on restoration', () => {
    const tick = vi.fn(() => Date.now())
    const stop = startVisibleTick(tick)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(2)
    setEnergy(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(30_000)
    expect(tick).toHaveBeenCalledTimes(2)
    setEnergy(false)
    expect(tick).toHaveBeenCalledTimes(3)
    expect(tick.mock.results.at(-1)?.value).toBe(Date.now())
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(4)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(energy.listeners.size).toBe(0)
  })

  it('does not create timers when a component initially mounts in the background', () => {
    energy.active = true
    const tick = vi.fn()
    const stop = startVisibleTick(tick)
    expect(tick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    setEnergy(false)
    expect(tick).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    stop()
  })

  it('deduplicates repeated visibility events without restarting an interval', () => {
    const tick = vi.fn()
    const stop = startVisibleTick(tick)
    setEnergy(false)
    setEnergy(false)
    expect(tick).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    setEnergy(true)
    setEnergy(true)
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('cleans up idempotently and cannot be revived by later visibility events', () => {
    const tick = vi.fn()
    const stop = startVisibleTick(tick)
    stop()
    stop()
    setEnergy(true)
    setEnergy(false)
    vi.advanceTimersByTime(5000)
    expect(tick).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
