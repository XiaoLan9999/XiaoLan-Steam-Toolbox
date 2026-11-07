import React, { Component, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { SteamFriendCommenterApi } from '../../../shared/types'
import './renderer-error-boundary.css'

export interface RendererFailure {
  stage: 'startup' | 'render'
  category: 'type-error' | 'reference-error' | 'range-error' | 'syntax-error' | 'error' | 'unknown' | 'bridge-unavailable'
}

export function classifyRendererFailure(stage: RendererFailure['stage'], error: unknown): RendererFailure {
  let category: RendererFailure['category'] = 'unknown'
  try {
    if (error instanceof TypeError) category = 'type-error'
    else if (error instanceof ReferenceError) category = 'reference-error'
    else if (error instanceof RangeError) category = 'range-error'
    else if (error instanceof SyntaxError) category = 'syntax-error'
    else if (error instanceof Error) category = 'error'
  } catch { /* Untrusted thrown objects must not break the fallback. */ }
  return { stage, category }
}

export function reportRendererEvent(event: 'render-error' | 'startup-error' | 'bridge-unavailable' | 'window-error' | 'unhandled-rejection'): void {
  // Main-process diagnostics accept only these exact strings, never exception details.
  try { console.error(`[toolbox-ui] ${event}`) } catch { /* Logging is best-effort. */ }
}

export function reportRendererFailure(failure: RendererFailure): void {
  reportRendererEvent(failure.category === 'bridge-unavailable' ? 'bridge-unavailable'
    : failure.stage === 'startup' ? 'startup-error' : 'render-error')
}

type DiagnosticsApi = Pick<SteamFriendCommenterApi, 'exportDiagnosticLogs'>

interface FailureViewProps {
  failure: RendererFailure
  language?: 'zh-CN' | 'en'
  diagnostics?: DiagnosticsApi | null
  onReload?: () => void
}

export function RendererFailureView({ failure, language, diagnostics, onReload }: FailureViewProps): React.JSX.Element {
  const english = (language ?? (typeof document !== 'undefined' ? document.documentElement.lang : 'zh-CN')) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const api = diagnostics === undefined ? (typeof window === 'undefined' ? undefined : window.steamCommenter) : diagnostics
  const available = typeof api?.exportDiagnosticLogs === 'function'
  const exportingRef = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<'saved' | 'failed' | null>(null)

  const exportLogs = async (): Promise<void> => {
    if (exportingRef.current || !available || !api) return
    exportingRef.current = true
    setExporting(true)
    setExportResult(null)
    try {
      const result = await api.exportDiagnosticLogs()
      if (!result.ok) setExportResult('failed')
      else if (result.data) setExportResult('saved')
    } catch { setExportResult('failed') }
    finally { exportingRef.current = false; setExporting(false) }
  }

  return <main className="renderer-failure-screen">
    <section className="renderer-failure-card" aria-labelledby="renderer-failure-heading">
      <span className="renderer-failure-eyebrow">XIAOLAN STEAM TOOLBOX</span>
      <h1 id="renderer-failure-heading">{failure.stage === 'startup'
        ? t('工具箱界面未能启动', 'The toolbox interface could not start')
        : t('工具箱界面出现错误', 'The toolbox interface encountered an error')}</h1>
      <p>{t('界面没有自动重新载入，你可以先导出诊断日志再重试', 'The interface has not reloaded automatically. You can export diagnostic logs before retrying')}</p>
      <p>{t('重新载入不会新建或重发留言任务；已有后台任务可能仍在运行，请恢复界面后在任务列表核对', 'Reloading does not create or resend comment tasks. Existing background tasks may still be running; check the task list after reloading')}</p>
      <p className="renderer-failure-warning">{t('手动重新载入会清除未保存的界面输入', 'Reloading clears unsaved interface input')}</p>
      <code className="renderer-failure-code">{failure.stage}/{failure.category}</code>
      <div className="renderer-failure-actions">
        <button type="button" onClick={() => { if (onReload) onReload(); else window.location.reload() }}>{t('重新载入界面', 'Reload interface')}</button>
        <button type="button" disabled={!available || exporting} onClick={() => void exportLogs()}>{exporting
          ? t('正在导出诊断日志…', 'Exporting diagnostic logs…') : t('导出诊断日志', 'Export diagnostic logs')}</button>
      </div>
      <small>{available
        ? t('仅导出本机诊断文件，不会自动上传', 'Only exports a local diagnostic file; nothing is uploaded automatically')
        : t('诊断导出连接尚未就绪，请重新载入界面后重试', 'Diagnostic export is not connected yet; reload the interface before retrying')}</small>
      {exportResult === 'saved' && <p role="status">{t('诊断日志已导出，可将文件交给排查人员', 'Diagnostic logs exported. You can share the file with your support contact')}</p>}
      {exportResult === 'failed' && <p role="alert">{t('诊断日志暂时无法导出，请重新载入界面后重试', 'Diagnostic logs could not be exported. Reload the interface before retrying')}</p>}
    </section>
  </main>
}

interface BoundaryProps { children: ReactNode; report?: (failure: RendererFailure) => void }
interface BoundaryState { failure: RendererFailure | null }

export class RendererErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failure: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: classifyRendererFailure('render', error) }
  }

  componentDidCatch(): void {
    if (this.state.failure) {
      try { (this.props.report ?? reportRendererFailure)(this.state.failure) } catch { /* Keep the recovery controls available. */ }
    }
  }

  render(): ReactNode {
    return this.state.failure ? <RendererFailureView failure={this.state.failure} /> : this.props.children
  }
}

export async function mountRendererApp(root: Pick<Root, 'render'>, loadApp: () => Promise<{ default: ComponentType }>,
  report: (failure: RendererFailure) => void = reportRendererFailure): Promise<void> {
  let App: ComponentType
  try { App = (await loadApp()).default }
  catch (error) {
    const failure = classifyRendererFailure('startup', error)
    try { report(failure) } catch { /* Diagnostic failure must not hide the recovery controls. */ }
    root.render(<RendererFailureView failure={failure} />)
    return
  }
  try {
    root.render(<React.StrictMode><RendererErrorBoundary report={report}><App /></RendererErrorBoundary></React.StrictMode>)
  } catch (error) {
    const failure = classifyRendererFailure('startup', error)
    try { report(failure) } catch { /* Diagnostic failure must not hide the recovery controls. */ }
    root.render(<RendererFailureView failure={failure} />)
  }
}
