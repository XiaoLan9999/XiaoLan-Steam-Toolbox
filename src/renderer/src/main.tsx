import ReactDOM from 'react-dom/client'
import type { ReactNode } from 'react'
import type { IpcResult } from '../../shared/types'
import type { WindowUiApi } from '../../shared/window-ui'
import { TitleBar } from './components/TitleBar'
import { classifyRendererFailure, mountRendererApp, RendererFailureView, reportRendererEvent, reportRendererFailure } from './components/RendererErrorBoundary'
import { restoreCachedTheme } from './theme'
import './styles.css'

restoreCachedTheme()

window.addEventListener('error', () => reportRendererEvent('window-error'))
window.addEventListener('unhandledrejection', () => reportRendererEvent('unhandled-rejection'))

let displayingRootFailure = false
async function windowRequest<T>(request: Promise<IpcResult<T>> | undefined): Promise<T> {
  if (!request) throw new Error('Window bridge unavailable')
  const result = await request
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}
const windowUi: WindowUiApi = {
  state: () => windowRequest(window.steamCommenter?.windowUi?.state()),
  minimize: () => windowRequest(window.steamCommenter?.windowUi?.minimize()),
  toggleMaximize: () => windowRequest(window.steamCommenter?.windowUi?.toggleMaximize()),
  close: () => windowRequest(window.steamCommenter?.windowUi?.close()),
  onState: listener => window.steamCommenter?.windowUi?.onState(listener) ?? (() => undefined)
}
const renderWithChrome = (children: ReactNode): void => root.render(
  <div className="desktop-window">
    <TitleBar api={windowUi} />
    <div className="desktop-window-content">{children}</div>
  </div>
)
const root = ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: () => undefined,
  onUncaughtError: error => {
    if (displayingRootFailure) return
    displayingRootFailure = true
    const failure = classifyRendererFailure('render', error)
    reportRendererFailure(failure)
    renderWithChrome(<RendererFailureView failure={failure} />)
  }
})

if (window.steamCommenter) void mountRendererApp({ render: renderWithChrome }, () => import('./App'))
else {
  const failure = { stage: 'startup', category: 'bridge-unavailable' } as const
  reportRendererFailure(failure)
  renderWithChrome(<RendererFailureView failure={failure} />)
}
