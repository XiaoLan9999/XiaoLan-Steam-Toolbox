import ReactDOM from 'react-dom/client'
import { classifyRendererFailure, mountRendererApp, RendererFailureView, reportRendererEvent, reportRendererFailure } from './components/RendererErrorBoundary'
import { restoreCachedTheme } from './theme'
import './styles.css'

restoreCachedTheme()

window.addEventListener('error', () => reportRendererEvent('window-error'))
window.addEventListener('unhandledrejection', () => reportRendererEvent('unhandled-rejection'))

let displayingRootFailure = false
const root = ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: () => undefined,
  onUncaughtError: error => {
    if (displayingRootFailure) return
    displayingRootFailure = true
    const failure = classifyRendererFailure('render', error)
    reportRendererFailure(failure)
    root.render(<RendererFailureView failure={failure} />)
  }
})

if (window.steamCommenter) void mountRendererApp(root, () => import('./App'))
else {
  const failure = { stage: 'startup', category: 'bridge-unavailable' } as const
  reportRendererFailure(failure)
  root.render(<RendererFailureView failure={failure} />)
}
