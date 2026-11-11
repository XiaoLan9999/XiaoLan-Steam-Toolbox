import { useEffect, useRef, useState } from 'react'
import { APP_NAME_EN, APP_NAME_ZH } from '../../../shared/branding'
import type { WindowUiApi, WindowUiState } from '../../../shared/window-ui'
import { I18nProvider, useI18n, type Translate } from '../i18n'
import { AppLogo } from './AppLogo'
import '../theme.css'
import './title-bar.css'

type WindowAction = 'minimize' | 'toggleMaximize' | 'close'
const initialState: WindowUiState = { maximized: false, focused: true }

export function TitleBar({ api }: { api: WindowUiApi }): React.JSX.Element {
  const { language: contextLanguage } = useI18n()
  const [state, setState] = useState<WindowUiState>(initialState)
  const [operation, setOperation] = useState<WindowAction | null>(null)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    const epoch = ++generation.current
    let received = false
    setOperation(null); pending.current = false; setFailed(false)
    const unsubscribe = api.onState(value => {
      if (epoch === generation.current) { received = true; setState(previous => ({ ...value, language: value.language ?? previous.language })) }
    })
    void api.state().then(value => { if (epoch === generation.current && !received) setState(value) }, () => {
      if (epoch === generation.current && !received) setFailed(true)
    })
    return () => { generation.current++; unsubscribe() }
  }, [api])
  const run = async (action: WindowAction): Promise<void> => {
    if (pending.current) return
    const epoch = generation.current
    pending.current = true; setOperation(action); setFailed(false)
    try { await api[action]() }
    catch { if (epoch === generation.current) setFailed(true) }
    finally { if (epoch === generation.current) { pending.current = false; setOperation(null) } }
  }
  const language = state.language ?? contextLanguage
  const t: Translate = (zh, en) => language === 'en' ? en : zh
  const title = language === 'en' ? APP_NAME_EN : APP_NAME_ZH
  const maximizeLabel = state.maximized ? t('还原窗口', 'Restore window') : t('最大化窗口', 'Maximize window')
  return <header className={`window-titlebar${state.focused ? ' focused' : ' unfocused'}`} aria-label={t('工具箱窗口标题栏', 'Toolbox window title bar')}>
    <div className="window-titlebar-caption" title={title} onDoubleClick={event => { if (event.button === 0) void run('toggleMaximize') }}>
      <I18nProvider language={language}><AppLogo className="window-titlebar-logo" size={22} /></I18nProvider>
      <strong className="window-titlebar-name">{title}</strong>
      <span className="window-titlebar-project">LOCAL PROJECT</span>
    </div>
    <div className="window-titlebar-controls">
      <button type="button" aria-label={t('最小化窗口', 'Minimize window')} title={t('最小化窗口', 'Minimize window')} disabled={operation !== null}
        onClick={() => void run('minimize')} onDoubleClick={event => event.stopPropagation()}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M3 8h10" /></svg>
      </button>
      <button type="button" aria-label={maximizeLabel} title={maximizeLabel} aria-pressed={state.maximized} disabled={operation !== null}
        onClick={() => void run('toggleMaximize')} onDoubleClick={event => event.stopPropagation()}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">{state.maximized
          ? <><path d="M5.5 5.5v-3h8v8h-3" /><path d="M2.5 5.5h8v8h-8z" /></>
          : <path d="M3 3h10v10H3z" />}</svg>
      </button>
      <button type="button" className="window-titlebar-close" aria-label={t('关闭窗口', 'Close window')} title={t('关闭窗口', 'Close window')} disabled={operation !== null}
        onClick={() => void run('close')} onDoubleClick={event => event.stopPropagation()}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>
    {failed && <span className="window-titlebar-status" role="status">{t('窗口操作未完成，请重试', 'The window operation did not complete; try again')}</span>}
  </header>
}
