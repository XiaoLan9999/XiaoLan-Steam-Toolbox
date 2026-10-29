import type { BrowserWindow } from 'electron'

export const WINDOW_ENERGY_COMPACT_DELAY_MS = 30_000

export interface WindowEnergySaverOptions {
  window: BrowserWindow
  enabled(): boolean
  onChange(active: boolean): void
  compact(): void | Promise<void>
}

export interface WindowEnergySaver {
  refresh(): void
  shutdown(): void
}

export function createWindowEnergySaver(options: WindowEnergySaverOptions): WindowEnergySaver {
  let closed = false
  let active = false
  let compacting = false
  let compactTimer: ReturnType<typeof setTimeout> | undefined
  const window = options.window

  const background = (): boolean => !window.isDestroyed() && options.enabled() &&
    (window.isMinimized() || !window.isVisible())

  const clearCompaction = (): void => {
    clearTimeout(compactTimer)
    compactTimer = undefined
  }

  const refresh = (): void => {
    if (closed) return
    if (window.isDestroyed()) { shutdown(); return }
    try {
      // This applies to ordinary BrowserWindows; offscreen frame-rate APIs do not.
      if (!window.webContents.isDestroyed()) window.webContents.setBackgroundThrottling(true)
      const next = background()
      if (next === active) return
      active = next
      clearCompaction()
      try { options.onChange(active) } catch { /* Observers cannot stop background work. */ }
      if (!active) return
      compactTimer = setTimeout(() => {
        compactTimer = undefined
        if (closed || !active || compacting) return
        try { if (!background()) return } catch { return }
        compacting = true
        void Promise.resolve().then(() => {
          if (!closed && active && background()) return options.compact()
        }).catch(() => {
          // Releasing optional graphics resources is best effort, never task cancellation.
        }).finally(() => { compacting = false })
      }, WINDOW_ENERGY_COMPACT_DELAY_MS)
      compactTimer.unref?.()
    } catch { /* A closing window must not make lifecycle callbacks throw. */ }
  }

  function shutdown(): void {
    if (closed) return
    closed = true
    clearCompaction()
    window.removeListener('minimize', refresh)
    window.removeListener('hide', refresh)
    window.removeListener('show', refresh)
    window.removeListener('restore', refresh)
    window.removeListener('closed', shutdown)
  }

  window.on('minimize', refresh)
  window.on('hide', refresh)
  window.on('show', refresh)
  window.on('restore', refresh)
  window.on('closed', shutdown)
  refresh()
  return { refresh, shutdown }
}
