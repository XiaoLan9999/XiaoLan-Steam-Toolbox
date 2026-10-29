import type { AppEvent } from '../shared/types'

const REFRESH_EVENTS = new Set<AppEvent['type']>(['snapshotChanged', 'friendPolicyChanged', 'batchProgress', 'updateChanged'])

export class BackgroundUiEvents {
  private background = false
  private dirty = false

  setBackground(active: boolean): void {
    if (active === this.background) return
    this.background = active
    this.dirty = false
  }

  project(event: AppEvent): AppEvent | null {
    if (!this.background || !REFRESH_EVENTS.has(event.type)) return event
    if (this.dirty) return null
    this.dirty = true
    // Only invalidate the view; durable task state remains owned by the main process.
    return { type: 'snapshotChanged' }
  }
}
