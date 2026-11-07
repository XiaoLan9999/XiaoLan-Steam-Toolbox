import type { BrowserWindow } from 'electron'
import type { RendererDiagnosticEvent, RendererDiagnosticStage } from '../shared/renderer-diagnostics'

const UI_STAGES = new Set<RendererDiagnosticStage>(['render-error', 'startup-error', 'bridge-unavailable', 'window-error', 'unhandled-rejection'])

export function observeRendererHealth(window: BrowserWindow, options: {
  record(event: RendererDiagnosticEvent): void
  hideEmbeddedView(): void
  now?(): number
}): () => void {
  const contents = window.webContents
  const last = new Map<RendererDiagnosticStage, number>()
  const listeners: Array<() => void> = []
  let stopped = false
  const record = (stage: RendererDiagnosticStage, errorCode?: number): boolean => {
    if (stopped) return false
    const now = (options.now ?? Date.now)()
    if (now - (last.get(stage) ?? -Infinity) < 60_000) return false
    last.set(stage, now)
    try { options.record({ stage, ...(errorCode !== undefined ? { errorCode } : {}) }) } catch { /* Observability must not interrupt a task. */ }
    return true
  }
  const bind = (target: NodeJS.EventEmitter, name: string, listener: (...args: any[]) => void): void => {
    target.on(name, listener)
    listeners.push(() => target.removeListener(name, listener))
  }
  bind(contents, 'console-message', details => {
    const message: unknown = details?.message
    if (typeof message !== 'string' || !message.startsWith('[toolbox-ui] ')) return
    const stage = message.slice('[toolbox-ui] '.length) as RendererDiagnosticStage
    if (!UI_STAGES.has(stage)) return
    if (record(stage) && ['render-error', 'startup-error', 'bridge-unavailable'].includes(stage)) {
      try { options.hideEmbeddedView() } catch { /* The error page must remain available when a child view closes. */ }
    }
  })
  bind(contents, 'preload-error', () => record('preload-error'))
  bind(contents, 'did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame === true && Number.isSafeInteger(code) && code !== -3) record('load-failed', code)
  })
  bind(contents, 'did-finish-load', () => record('document-loaded'))
  bind(contents, 'unresponsive', () => record('unresponsive'))
  bind(contents, 'responsive', () => record('responsive'))
  for (const [event, stage] of [['minimize', 'window-minimized'], ['restore', 'window-restored'], ['hide', 'window-hidden'], ['show', 'window-shown']] as const) {
    bind(window, event, () => record(stage))
  }
  const dispose = (): void => { if (stopped) return; stopped = true; for (const remove of listeners.splice(0)) remove(); last.clear() }
  bind(window, 'closed', dispose)
  return dispose
}
