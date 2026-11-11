import type { WindowCloseMode } from '../shared/window-lifecycle'

export interface WindowCloseChoice { action: 'tray' | 'quit' | 'cancel'; remember: boolean }
export function createWindowCloseController(options: {
  mode(): WindowCloseMode
  save(mode: WindowCloseMode): void
  choose(): Promise<WindowCloseChoice>
  ensureTray(): boolean
  hide(): void
  quit(): void
  unavailable(): void
  isQuitting?(): boolean
}) {
  let pending = false
  return {
    async request(): Promise<void> {
      if (pending) return
      pending = true
      try {
        const mode = options.mode()
        const choice = mode === 'ask' ? await options.choose() : { action: mode, remember: false }
        if (options.isQuitting?.()) return
        if (choice.action === 'cancel') return
        if (choice.action === 'tray') {
          if (!options.ensureTray()) { options.unavailable(); return }
          if (choice.remember) options.save('tray')
          options.hide()
        } else {
          if (choice.remember) options.save('quit')
          options.quit()
        }
      } catch { options.unavailable() }
      finally { pending = false }
    }
  }
}
