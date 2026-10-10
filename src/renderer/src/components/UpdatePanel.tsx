import { useEffect, useId, useRef, useState } from 'react'
import type { IpcResult } from '../../../shared/types'
import { BUILTIN_UPDATE_ROUTES, type UpdatePreferences, type UpdateState } from '../../../shared/update-types'
import { useI18n, type Translate } from '../i18n'
import { UiError, unwrap } from '../ui'
import type { RunAction } from './types'
import './update-panel.css'

const updateErrors: Record<string, [string, string]> = {
  'update.manifestUnavailable': ['所有更新线路暂时不可用，请稍后重试。', 'Update routes are currently unavailable. Please try again later.'],
  'update.manifestSignature': ['更新清单验证失败，请重新检查更新。', 'The update manifest could not be verified. Check for updates again.'],
  'update.manifestTooLarge': ['更新清单大小异常，请重新检查更新。', 'The update manifest has an unexpected size. Check for updates again.'],
  'update.invalidResponse': ['线路返回的内容无效，请换一条线路。', 'This route returned invalid content. Try another route.'],
  'update.timeout': ['连接超时，请稍后重试或换一条线路。', 'The connection timed out. Try again or choose another route.'],
  'update.httpError': ['线路请求失败，请稍后重试或换一条线路。', 'The route request failed. Try again or choose another route.'],
  'update.staleManifest': ['线路提供的更新清单已过期，请重新检查更新。', 'This route provided an outdated manifest. Check for updates again.'],
  'update.conflictingManifest': ['不同线路的更新清单不一致，请稍后重新检查。', 'The routes returned conflicting manifests. Please check again later.'],
  'update.routeUnavailable': ['所选线路不可用，请重新检查或使用自动选择。', 'The selected route is unavailable. Check again or use automatic selection.'],
  'update.noUpdate': ['暂时没有可下载的新版，请先检查更新。', 'No newer version is available to download. Check for updates first.'],
  'update.downloadSize': ['下载文件大小与更新清单不一致，请重新下载。', 'The download size does not match the manifest. Download it again.'],
  'update.downloadHash': ['下载文件校验失败，请换一条线路重新下载。', 'The downloaded file failed verification. Download it again using another route.'],
  'update.downloadInterrupted': ['下载已中断，请重新下载。', 'The download was interrupted. Download it again.'],
  'update.cacheInvalid': ['已下载文件的校验失败，请重新下载。', 'The downloaded file could no longer be verified. Download it again.'],
  'update.cancelled': ['已取消下载。', 'Download cancelled.'],
  'update.redirectInvalid': ['线路重定向无效，请换一条线路。', 'This route returned an invalid redirect. Try another route.'],
  'update.redirectLimit': ['线路重定向次数过多，请换一条线路。', 'This route redirected too many times. Try another route.'],
  'update.storageError': ['无法保存更新文件，请检查可用磁盘空间后重试。', 'The update could not be saved. Check free disk space and try again.'],
  'update.installBusy': ['请先暂停发送及检查任务，等待当前操作和数据导出完成后更新。', 'Pause comment and check tasks, then wait for current operations and data exports to finish before updating.'],
  'update.installArtworkBusy': ['请先保存作品并关闭内置艺术作品页面，再安装更新。', 'Save your artwork and close the embedded artwork page before installing the update.'],
  'update.notPackaged': ['请使用正式安装版或便携版进行内置更新。', 'Use an installed or portable release to update within the app.'],
  'update.installPlatform': ['内置安装更新目前仅支持 Windows。', 'Installing updates within the app currently supports Windows only.'],
  'update.installLaunch': ['无法启动更新，请打开版本说明页下载新版并手动安装。', 'The update could not be started. Open the release notes to download and install it manually.'],
  'update.portableTarget': ['便携版程序位置已变更，请打开版本说明页下载新版并手动更新。', 'The portable app location has changed. Open the release notes to download and update it manually.']
}

export function describeUpdateError(error: string, t: Translate): string {
  const known = updateErrors[error]
  return known ? t(...known) : t('操作失败，请查看错误信息后重试。', 'The operation failed. Review the error details and try again.')
}

export function parseCustomUpdateMirrors(value: string): string[] {
  const mirrors = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (mirrors.length > 5) throw new Error('tooMany')
  return [...new Set(mirrors.map(value => {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('invalidUrl') }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('invalidUrl')
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.href
  }))]
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

function errorIdentifier(error: unknown): string {
  if (error instanceof UiError && error.code.startsWith('update.')) return error.code
  return error instanceof Error ? error.message : String(error)
}

export function UpdatePanel({ state, preferences, runAction }: {
  state: UpdateState; preferences: UpdatePreferences; runAction: RunAction
}): React.JSX.Element {
  const { language, t } = useI18n()
  const customInputId = useId()
  const [routeId, setRouteId] = useState('')
  const [customMirrors, setCustomMirrors] = useState(preferences.customMirrors.join('\n'))
  const [customError, setCustomError] = useState<string | null>(null)
  const [operation, setOperation] = useState<'check' | 'download' | 'install' | null>(null)
  const [savingPreferences, setSavingPreferences] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const operationPending = useRef(false)
  const preferencesPending = useRef(false)
  const cancelPending = useRef(false)
  const storedCustomMirrors = preferences.customMirrors.join('\n')
  useEffect(() => { setCustomMirrors(storedCustomMirrors) }, [storedCustomMirrors])
  useEffect(() => {
    if (routeId && !state.routes.some(route => route.id === routeId && route.status === 'available')) setRouteId('')
  }, [routeId, state.routes])

  const downloading = state.phase === 'downloading' || operation === 'download'
  const checking = state.phase === 'checking' || operation === 'check'
  const updateBusy = downloading || checking || operation === 'install'
  const disabledPreferences = updateBusy || savingPreferences
  const error = localError ?? state.error
  const percent = Math.min(100, Math.max(0, Number.isFinite(state.percent) ? state.percent : 0))
  const sourceRoute = state.routes.find(route => route.id === state.sourceRouteId)
  const checkedDate = state.checkedAt ? new Date(state.checkedAt) : null
  const checkedAt = checkedDate && Number.isFinite(checkedDate.getTime())
    ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(checkedDate)
    : t('尚未检查', 'Not checked yet')

  const perform = async (next: 'check' | 'download' | 'install', action: () => Promise<IpcResult<unknown>>): Promise<void> => {
    if (updateBusy || operationPending.current) return
    operationPending.current = true
    setLocalError(null)
    setOperation(next)
    try { unwrap(await action()) } catch (error) { setLocalError(errorIdentifier(error)) }
    finally { operationPending.current = false; setOperation(null) }
  }
  const savePreferences = async (next: UpdatePreferences): Promise<void> => {
    if (disabledPreferences || preferencesPending.current) return
    preferencesPending.current = true
    setSavingPreferences(true)
    try {
      await runAction(t('保存更新设置', 'Saving update settings'), async () => unwrap(await window.steamCommenter.setUpdatePreferences(next)))
    } finally { preferencesPending.current = false; setSavingPreferences(false) }
  }
  const saveCustomMirrors = async (): Promise<void> => {
    setCustomError(null)
    try {
      const mirrors = parseCustomUpdateMirrors(customMirrors)
      await savePreferences({ ...preferences, customMirrors: mirrors })
    } catch (error) {
      setCustomError(error instanceof Error && error.message === 'tooMany'
        ? t('最多设置 5 条自定义线路。', 'You can configure up to 5 custom routes.')
        : t('请每行填写一个 HTTPS 代理前缀，不能包含账号密码、查询参数或片段。', 'Enter one HTTPS proxy prefix per line, without credentials, query parameters or fragments.'))
    }
  }
  const cancel = async (): Promise<void> => {
    if (cancelPending.current) return
    cancelPending.current = true
    setCancelling(true)
    try { unwrap(await window.steamCommenter.cancelUpdate()) } catch (error) { setLocalError(errorIdentifier(error)) }
    finally { cancelPending.current = false; setCancelling(false) }
  }
  const phaseText: Record<UpdateState['phase'], string> = {
    idle: t('检查 GitHub 正式版本更新', 'Check GitHub release updates'),
    checking: t('正在检测更新及可用线路…', 'Checking updates and available routes…'),
    upToDate: t('当前已是最新版本', 'You are using the latest version'),
    available: t('发现新版本', 'A newer version is available'),
    downloading: t('正在下载更新…', 'Downloading the update…'),
    ready: t('更新已下载并通过校验', 'Update downloaded and verified'),
    error: t('更新操作未完成', 'The update could not be completed')
  }

  return <section className="update-panel" aria-labelledby="update-panel-heading">
    <div className="update-panel-heading">
      <h3 id="update-panel-heading">{t('软件更新', 'Software updates')}</h3>
      <span className={`update-phase update-phase-${state.phase}`} role="status">{phaseText[state.phase]}</span>
    </div>
    <dl className="update-versions">
      <div><dt>{t('当前版本', 'Current version')}</dt><dd>{state.currentVersion}</dd></div>
      <div><dt>{t('最新版本', 'Latest version')}</dt><dd>{state.latestVersion ?? '—'}</dd></div>
      <div><dt>{t('上次检查', 'Last checked')}</dt><dd>{checkedAt}</dd></div>
    </dl>
    <p>{t('更新跟随 GitHub 正式 Release 发布，代码提交不会触发更新。', 'Updates follow published GitHub releases. Code commits do not trigger an update.')}</p>
    <div className="update-actions">
      <button disabled={updateBusy} onClick={() => void perform('check', () => window.steamCommenter.checkForUpdates())}>
        {checking ? t('正在检查…', 'Checking…') : t('检查更新与线路', 'Check updates and routes')}
      </button>
      {state.releaseUrl && <button className="ghost" disabled={operation === 'install'} onClick={() => void runAction(t('打开版本说明', 'Opening release notes'), async () => unwrap(await window.steamCommenter.openUpdateRelease()))}>
        {t('版本说明', 'Release notes')}
      </button>}
    </div>
    <label className="update-checkbox"><input type="checkbox" checked={preferences.autoCheck} disabled={disabledPreferences}
      onChange={event => void savePreferences({ ...preferences, autoCheck: event.target.checked })} />
      {t('启动后自动检查更新', 'Check for updates after startup')}</label>
    <label className="update-checkbox"><input type="checkbox" checked={preferences.useMirrors} disabled={disabledPreferences}
      onChange={event => void savePreferences({ ...preferences, useMirrors: event.target.checked })} />
      {t('启用代理线路（内置及自定义）', 'Enable proxy routes (built-in and custom)')}</label>
    <p className="update-mirror-note">{t('启用后会访问这些公共代理检测及下载更新：', 'When enabled, these public proxies are used to check and download updates: ')}
      <span>{BUILTIN_UPDATE_ROUTES.filter(route => route.prefix).map(route => route.label).join(' · ')}</span>
      {t('。每次检查实测线路，连接质量可能变化。关闭后仅连接 GitHub。', '. Routes are tested on each check; connection quality can change. When disabled, only GitHub is used.')}</p>
    <details className="update-advanced">
      <summary>{t('高级：自定义更新代理', 'Advanced: custom update proxies')}</summary>
      <label htmlFor={customInputId}>{t('HTTPS 代理前缀，每行一个', 'HTTPS proxy prefixes, one per line')}</label>
      <textarea id={customInputId} value={customMirrors} rows={3} spellCheck={false} disabled={disabledPreferences}
        placeholder="https://your-mirror.example/" onChange={event => { setCustomMirrors(event.target.value); setCustomError(null) }} />
      <small>{t('代理应支持在前缀后拼接完整 GitHub 下载地址；留空即可只使用内置线路。', 'The proxy must accept the complete GitHub download URL after its prefix. Leave this empty to use only built-in routes.')}</small>
      {customError && <p className="update-error" role="alert">{customError}</p>}
      <button disabled={disabledPreferences || customMirrors === storedCustomMirrors} onClick={() => void saveCustomMirrors()}>{t('保存自定义线路', 'Save custom routes')}</button>
    </details>
    {state.routes.length > 0 && <div className="update-route-list" aria-label={t('更新线路检测结果', 'Update route results')}>
      <div className="update-route-headers"><span>{t('线路 / 域名', 'Route / domain')}</span><span>{t('延迟 / 试读速度', 'Latency / sample speed')}</span></div>
      {state.routes.map(route => <div className={`update-route update-route-${route.status}`} key={route.id}>
        <div className="update-route-name"><strong>{route.label}</strong><small>{route.domain}</small></div>
        <div className="update-route-result">
          <span>{route.status === 'available' ? route.error ? t('清单可用，下载待重试', 'Manifest available; download needs retry') : t('可用', 'Available') : route.status === 'failed' ? t('不可用', 'Unavailable') : t('检测中', 'Testing')}</span>
          {route.status === 'available' && <small>{route.latencyMs === null ? '—' : `${Math.round(route.latencyMs)} ms`} / {route.speedBytesPerSecond === null ? '—' : `${formatBytes(route.speedBytesPerSecond)}/s`}</small>}
        </div>
        {route.error && <details className="update-route-error"><summary>{describeUpdateError(route.error, t)}</summary><code>{route.error}</code></details>}
      </div>)}
    </div>}
    {(state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready') && <p className="update-verified">{t('更新清单已验证；下载完成后再次校验文件。', 'The update manifest is verified. The downloaded file is verified again before installation.')}</p>}
    {(state.phase === 'available' || state.phase === 'downloading') && <div className="update-download-controls">
      <label>{t('下载线路', 'Download route')}<select value={routeId} disabled={updateBusy} onChange={event => setRouteId(event.target.value)}>
        <option value="">{t('自动选择最快有效线路', 'Automatically choose the fastest valid route')}</option>
        {state.routes.filter(route => route.status === 'available').map(route => <option value={route.id} key={route.id}>{route.label} · {route.domain}</option>)}
      </select></label>
      {state.phase === 'available' && <button className="primary" disabled={updateBusy || !state.routes.some(route => route.status === 'available')}
        onClick={() => void perform('download', () => window.steamCommenter.downloadUpdate(routeId || undefined))}>{t('下载更新', 'Download update')}</button>}
    </div>}
    {downloading && <div className="update-progress" aria-live="polite">
      {sourceRoute && <p>{t('当前下载线路：', 'Current download route: ')}{sourceRoute.label} · {sourceRoute.domain}</p>}
      <progress max={100} value={percent} aria-label={t('更新下载进度', 'Update download progress')} />
      <div><strong>{percent.toFixed(1)}%</strong><span>{formatBytes(state.downloadedBytes)} / {formatBytes(state.totalBytes)}</span><span>{formatBytes(state.speedBytesPerSecond)}/s</span></div>
      <button disabled={cancelling} onClick={() => void cancel()}>{cancelling ? t('正在取消…', 'Cancelling…') : t('取消下载', 'Cancel download')}</button>
    </div>}
    {state.phase === 'ready' && <div className="update-ready">
      <p>{state.packageKind === 'portable'
        ? t('保存工作并暂停正在运行的任务后，更新便携版并重启工具箱。', 'Save your work and pause running tasks before updating the portable app and restarting the toolbox.')
        : t('保存工作并暂停正在运行的任务后，安装新版并重启工具箱。', 'Save your work and pause running tasks before installing the update and restarting the toolbox.')}</p>
      <button className="primary" disabled={updateBusy} onClick={() => void perform('install', () => window.steamCommenter.installUpdate())}>{operation === 'install' ? t('正在准备更新…', 'Preparing the update…') : t('确认更新并重启', 'Confirm update and restart')}</button>
    </div>}
    {error && <div className="update-error" role="alert"><p>{describeUpdateError(error, t)}</p><details><summary>{t('错误信息', 'Error details')}</summary><code>{error}</code></details></div>}
  </section>
}
