import { describe, expect, it } from 'vitest'
import { BackgroundUiEvents } from '../src/main/background-ui-events'
import { initialUpdateState } from '../src/shared/update-types'
import type { AppEvent } from '../src/shared/types'

describe('background interface event coalescing', () => {
  it('passes foreground progress through unchanged', () => {
    const gate = new BackgroundUiEvents()
    const event: AppEvent = { type: 'batchProgress', batchId: 'synthetic-task' }
    expect(gate.project(event)).toBe(event)
    expect(gate.project(event)).toBe(event)
  })

  it('invalidates once for thousands of hidden progress and update events', () => {
    const gate = new BackgroundUiEvents()
    gate.setBackground(true)
    expect(gate.project({ type: 'batchProgress', batchId: 'synthetic-task' })).toEqual({ type: 'snapshotChanged' })
    for (let index = 0; index < 1000; index++) {
      expect(gate.project({ type: 'batchProgress', batchId: 'synthetic-task' })).toBeNull()
      expect(gate.project({ type: 'snapshotChanged' })).toBeNull()
      expect(gate.project({ type: 'updateChanged', state: initialUpdateState('0.16.12', 'portable') })).toBeNull()
    }
  })

  it('never hides login, security, lifecycle or user notices', () => {
    const gate = new BackgroundUiEvents()
    gate.setBackground(true)
    const events: AppEvent[] = [{ type: 'authCompleting', loginId: 'synthetic-login' },
      { type: 'authFailed', loginId: 'synthetic-login', message: 'Synthetic rejection' },
      { type: 'authFinished', loginId: 'synthetic-login', accountId: 'synthetic-account' },
      { type: 'energySavingChanged', enabled: true, active: false },
      { type: 'notice', level: 'warning', message: 'Synthetic notice' }]
    for (const event of events) expect(gate.project(event)).toBe(event)
  })

  it('starts a fresh invalidation period after each restore/minimize cycle', () => {
    const gate = new BackgroundUiEvents()
    for (let index = 0; index < 3; index++) {
      gate.setBackground(true)
      expect(gate.project({ type: 'snapshotChanged' })).toEqual({ type: 'snapshotChanged' })
      gate.setBackground(true)
      expect(gate.project({ type: 'snapshotChanged' })).toBeNull()
      gate.setBackground(false)
      const event: AppEvent = { type: 'batchProgress', batchId: 'synthetic-task' }
      expect(gate.project(event)).toBe(event)
    }
  })
})
