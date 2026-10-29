import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateScheduler, UPDATE_PERIODIC_CHECK_INTERVAL_MS, UPDATE_STARTUP_CHECK_DELAY_MS,
  type UpdateScheduler, type UpdateSchedulerOptions } from '../src/main/update-scheduler'
import type { UpdateState } from '../src/shared/update-types'

const schedulers: UpdateScheduler[] = []
const start = Date.parse('2026-10-29T00:00:00.000Z')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start) })
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.shutdown()
  vi.useRealTimers()
})

function fixture(overrides: Partial<UpdateSchedulerOptions> = {}) {
  const check = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
  const enabled = vi.fn(() => true)
  const phase = vi.fn<() => UpdateState['phase']>(() => 'idle')
  const checkedAt = vi.fn<() => string | null>(() => null)
  const scheduler = createUpdateScheduler({ check, enabled, phase, checkedAt, ...overrides })
  schedulers.push(scheduler)
  return { scheduler, check, enabled, phase, checkedAt }
}

describe('automatic update scheduler', () => {
  it('waits eight seconds, then checks every thirty minutes without a one-hour first gap', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS - 1)
    expect(f.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.check).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS - 1)
    expect(f.check).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledTimes(3)
  })

  it('reads the current preference on every attempt and can resume after re-enabling', async () => {
    const f = fixture()
    f.enabled.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).not.toHaveBeenCalled()
    f.enabled.mockReturnValue(true)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    f.enabled.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledOnce()
    f.enabled.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledTimes(2)
  })

  it.each(['checking', 'downloading'] as const)('skips %s without moving the last-attempt deadline', async state => {
    const f = fixture()
    f.phase.mockReturnValue(state)
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    expect(f.check).not.toHaveBeenCalled()
    f.phase.mockReturnValue('available')
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
  })

  it('coalesces repeated resume events and respects the latest automatic attempt', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    for (let index = 0; index < 10; index++) f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    // Simulate suspension: the wall clock moves forward without delivering interval callbacks.
    vi.setSystemTime(Date.now() + UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    for (let index = 0; index < 10; index++) f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledTimes(3)
  })

  it('honors a recent manual check, including one newer than the last automatic attempt', async () => {
    const f = fixture()
    f.checkedAt.mockReturnValue(new Date(start).toISOString())
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    expect(f.check).not.toHaveBeenCalled()
    vi.setSystemTime(start + UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    f.checkedAt.mockReturnValue(new Date().toISOString())
    vi.setSystemTime(Date.now() + 20 * 60 * 1000)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledTimes(2)
  })

  it.each([null, 'invalid-date', '2030-01-01T00:00:00.000Z'])('ignores missing, malformed or future checkedAt=%s', async checkedAt => {
    const f = fixture({ checkedAt: () => checkedAt })
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    expect(f.check).toHaveBeenCalledOnce()
  })

  it('does not overlap a long-running automatic check with a timer or resume event', async () => {
    let complete!: () => void
    const check = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
    const f = fixture({ check })
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    expect(check).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledOnce()
    complete()
    await vi.advanceTimersByTimeAsync(0)
    // A skipped interval does not falsely claim a check happened while the first was busy.
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('contains rejected checks and waits thirty minutes before trying again', async () => {
    const f = fixture()
    f.check.mockRejectedValue(new Error('Synthetic offline update failure'))
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.check).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS - 100)
    expect(f.check).toHaveBeenCalledTimes(2)
  })

  it('contains a synchronously throwing check callback', async () => {
    const f = fixture()
    f.check.mockImplementation(() => { throw new Error('Synthetic callback failure') })
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledTimes(2)
  })

  it('recovers from a wall-clock rollback instead of waiting for the old future timestamp', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    vi.setSystemTime(start - 24 * 60 * 60 * 1000)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.check).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).toHaveBeenCalledTimes(2)
  })

  it('does not execute a queued check after shutdown and clears every timer', async () => {
    const f = fixture()
    f.scheduler.resume()
    f.scheduler.shutdown()
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(2 * UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    expect(f.check).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.scheduler.shutdown()).not.toThrow()
  })

  it('clears active periodic callbacks on shutdown without owning download/install behavior', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS)
    f.scheduler.shutdown()
    await vi.advanceTimersByTimeAsync(3 * UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    f.scheduler.resume()
    expect(f.check).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
