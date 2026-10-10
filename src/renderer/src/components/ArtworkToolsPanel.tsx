import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  ArtworkError,
  MAX_ARTWORK_FILE_BYTES,
  artworkCropRects,
  buildLongArtworkScript,
  defaultArtworkCrop,
  inspectStaticArtwork,
  type ArtworkCropInput,
  type ArtworkCropRect,
  type ArtworkErrorCode
} from '../../../shared/artwork'
import type { ArtworkBounds, ArtworkBrowserState, ArtworkTool } from '../../../shared/artwork-browser'
import type { AccountView, IpcResult } from '../../../shared/types'
import { useI18n, type Translate } from '../i18n'
import './artwork-tools.css'

interface LocalArtwork {
  url: string
  image: HTMLImageElement
  width: number
  height: number
  fileName: string
}

function errorMessage(code: ArtworkErrorCode, t: Translate): string {
  switch (code) {
    case 'unsupportedFormat': return t('请选择静态 PNG 或 JPEG 图片。GIF、WebM 和 WebP 请使用本页的内置动画背景工具。', 'Choose a static PNG or JPEG image. Use the embedded animated background tool on this page for GIF, WebM or WebP.')
    case 'animatedImage': return t('检测到 APNG 动画。本地裁剪只支持静态图片，请使用本页的内置动画背景工具。', 'APNG animation detected. Local cropping supports static images only; use the embedded animated background tool on this page.')
    case 'fileTooLarge': return t('图片超过本地裁剪工具的 30 MiB 文件上限。', 'The image exceeds the local crop tool limit of 30 MiB.')
    case 'imageTooLarge': return t('图片不能超过 3200 万像素，任一边不能超过 16384 像素。', 'The image must be at most 32 million pixels, with no side longer than 16384 pixels.')
    case 'invalidImage': return t('图片无法读取或文件不完整，请重新选择 PNG / JPEG。', 'The image cannot be read or is incomplete. Choose a valid PNG / JPEG.')
    case 'invalidCrop': return t('裁剪范围超出原图。X、Y 和高度必须是整数，整个裁剪框必须位于图片内。', 'The crop is outside the original image. X, Y and height must be whole numbers, and every crop must fit inside the image.')
  }
}

function cropLabel(name: ArtworkCropRect['name'], t: Translate): string {
  return name === 'main' ? t('主图', 'Main') : name === 'side' ? t('侧图', 'Side') : t('精选图', 'Featured')
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new ArtworkError('invalidImage'))
  }, 'image/png'))
}

function saveLocalPng(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const CLOSED_BROWSER: ArtworkBrowserState = { tool: null, phase: 'closed', accountId: null, canApplyLongArtwork: false, error: null }

export function artworkHostBounds(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>, width: number, height: number): ArtworkBounds | null {
  if (![rect.left, rect.top, rect.right, rect.bottom, width, height].every(Number.isFinite)) return null
  const x = Math.max(0, Math.ceil(rect.left))
  const y = Math.max(0, Math.ceil(rect.top))
  const right = Math.min(Math.floor(width), Math.floor(rect.right))
  const bottom = Math.min(Math.floor(height), Math.floor(rect.bottom))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

function toolName(tool: ArtworkTool, t: Translate): string {
  switch (tool) {
    case 'upload': return t('艺术作品上传', 'Artwork upload')
    case 'showcase': return t('艺术展柜设置', 'Artwork showcase settings')
    case 'design': return t('动画背景工具 · Steam.Design', 'Animated background tool · Steam.Design')
    case 'guide': return t('长图上传指南', 'Long artwork guide')
    case 'sapic': return t('SAPIC 工具说明', 'SAPIC tools guide')
  }
}

export function artworkBrowserError(code: string, t: Translate): string {
  switch (code) {
    case 'ARTWORK_AUTH_FAILED': case 'ARTWORK_NOT_AUTHENTICATED': case 'NOT_AUTHENTICATED': return t('请先添加 Steam 账号或重新登录当前账号。', 'Add a Steam account or sign in again first.')
    case 'ARTWORK_SESSION_CHANGED': case 'ARTWORK_INVALID_SESSION': return t('Steam 账号会话已变化，请重新打开工具。', 'The Steam account session changed. Open the tool again.')
    case 'ARTWORK_FILE_REQUIRED': return t('请先选择要上传的图片，再应用长图设置。', 'Select an image to upload before applying long artwork settings.')
    case 'ARTWORK_IMAGE_LOADING': return t('图片仍在载入，请等待预览后再应用长图设置。', 'The image is still loading. Wait for its preview before applying long artwork settings.')
    case 'ARTWORK_FORM_UNAVAILABLE': return t('未找到 Steam 上传表单，请重新载入页面并检查账号登录状态。', 'The Steam upload form was not found. Reload the page and check your sign-in status.')
    case 'ARTWORK_UPLOAD_PAGE_REQUIRED': return t('请返回艺术作品上传页面，再应用长图设置。', 'Return to the artwork upload page before applying long artwork settings.')
    case 'ARTWORK_APPLY_FAILED': return t('长图设置未能应用，请重新选择图片或载入页面后重试。', 'Long artwork settings could not be applied. Select the image again or reload the page and retry.')
    case 'ARTWORK_NAVIGATION_BLOCKED': return t('此链接不属于当前内置工具允许的页面，已停止导航。', 'This link is outside the pages allowed by the embedded tool. Navigation was stopped.')
    case 'ARTWORK_UNAVAILABLE': case 'ARTWORK_LOAD_FAILED': return t('在线页面载入失败，请检查网络后重新载入。', 'The online page failed to load. Check your connection and reload.')
    case 'ARTWORK_RENDERER_FAILED': return t('内置页面已停止响应，请重新载入。', 'The embedded page stopped responding. Reload it.')
    case 'ARTWORK_DOWNLOAD_UNSUPPORTED': return t('此下载不是受支持的图片、视频或 ZIP 文件，已取消。', 'This download is not a supported image, video or ZIP file and was cancelled.')
    case 'ARTWORK_DOWNLOAD_PATH_INVALID': return t('保存路径无效。请选择普通本地文件位置，并保留正确的图片、视频或 ZIP 后缀。', 'The save path is invalid. Choose a normal local file location and keep the correct image, video or ZIP extension.')
    case 'ARTWORK_DOWNLOAD_FAILED': return t('未能保存该文件，请重新点击页面中的下载按钮。', 'The file could not be saved. Click the page download button again.')
    case 'ARTWORK_NOT_OPEN': return t('当前没有打开内置工具，请重新打开。', 'No embedded tool is currently open. Open it again.')
    case 'ARTWORK_INVALID_TOOL': case 'ARTWORK_INVALID_BOUNDS': return t('内置工具参数无效，请关闭后重新打开。', 'The embedded tool received invalid parameters. Close it and open it again.')
    default: return t('内置工具操作失败，请重新载入后重试。', 'The embedded tool operation failed. Reload it and retry.')
  }
}

interface ArtworkToolsProps {
  account: AccountView | null
  visible: boolean
}

export function ArtworkBrowserToolbar({ state, busy, onApply, onReload, onClose, onNavigate }: {
  state: ArtworkBrowserState
  busy: boolean
  onApply: () => void
  onReload: () => void
  onClose: () => void
  onNavigate?: (tool: 'upload' | 'showcase') => void
}): React.JSX.Element {
  const { t } = useI18n()
  return <div className="artwork-browser-toolbar">
    <div className="artwork-browser-title"><strong>{state.tool ? toolName(state.tool, t) : t('内置艺术工具', 'Embedded artwork tool')}</strong><span>{state.phase === 'loading' ? t('正在载入在线页面…', 'Loading online page…') : state.phase === 'error' ? t('页面载入失败', 'Page failed to load') : t('在工具箱内完成，无需外部浏览器', 'Stay in the toolbox; no external browser needed')}</span></div>
    <div className="artwork-actions">
      {state.tool === 'upload' && <button className="primary" disabled={busy || !state.canApplyLongArtwork} onClick={onApply}>{t('应用长图设置', 'Apply long artwork settings')}</button>}
      {state.tool === 'upload' && onNavigate && <button disabled={busy} onClick={() => onNavigate('showcase')}>{t('配置艺术展柜', 'Configure artwork showcase')}</button>}
      {state.tool === 'showcase' && onNavigate && <button disabled={busy} onClick={() => onNavigate('upload')}>{t('继续上传作品', 'Upload more artwork')}</button>}
      <button disabled={busy} onClick={onReload}>{t('重新载入', 'Reload')}</button>
      <button onClick={onClose}>{t('返回本地裁剪', 'Back to local cropping')}</button>
    </div>
  </div>
}

export function ArtworkToolsPanel({ account, visible }: ArtworkToolsProps): React.JSX.Element {
  const { t } = useI18n()
  const [asset, setAsset] = useState<LocalArtwork | null>(null)
  const [crop, setCrop] = useState<ArtworkCropInput>({ preset: 'standard', x: 493, y: 256, height: 824 })
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [ipcBusy, setIpcBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [imageError, setImageError] = useState<ArtworkErrorCode | null>(null)
  const [browser, setBrowser] = useState<ArtworkBrowserState>(CLOSED_BROWSER)
  const generation = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const browserHost = useRef<HTMLDivElement>(null)
  const accountId = useRef(account?.id ?? null)
  const operationInFlight = useRef(false)
  const operationSerial = useRef(0)
  const toolGeneration = useRef(0)
  const closingTool = useRef(false)
  const script = useMemo(buildLongArtworkScript, [])
  const cropResult = useMemo((): { rectangles: ArtworkCropRect[]; error: ArtworkErrorCode | null } => {
    if (!asset) return { rectangles: [], error: null }
    try { return { rectangles: artworkCropRects(asset.width, asset.height, crop), error: null } }
    catch (error) { return { rectangles: [], error: error instanceof ArtworkError ? error.code : 'invalidCrop' } }
  }, [asset, crop])

  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => () => { if (asset) URL.revokeObjectURL(asset.url) }, [asset])

  useEffect(() => {
    let active = true
    let eventReceived = false
    const unsubscribe = window.steamCommenter.onEvent(event => {
      if (event.type === 'artworkChanged') { eventReceived = true; if (active) setBrowser(event.state) }
    })
    void window.steamCommenter.getArtworkToolState().then(result => {
      if (active && !eventReceived && result.ok) setBrowser(result.data)
    }).catch(() => undefined)
    return () => {
      active = false
      toolGeneration.current += 1
      operationSerial.current += 1
      unsubscribe()
      void window.steamCommenter.setArtworkToolBounds(null).catch(() => undefined)
      void window.steamCommenter.closeArtworkTool().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const nextAccountId = account?.id ?? null
    const switchedAccount = accountId.current !== nextAccountId
    accountId.current = nextAccountId
    const lostAuthentication = (browser.tool === 'upload' || browser.tool === 'showcase') &&
      (account?.sessionState !== 'authenticated' || browser.accountId !== nextAccountId)
    if (!switchedAccount && !lostAuthentication) return
    toolGeneration.current += 1
    operationSerial.current += 1
    operationInFlight.current = false
    setIpcBusy(false)
    setBrowser(CLOSED_BROWSER)
    setNotice(null)
    void window.steamCommenter.setArtworkToolBounds(null).catch(() => undefined)
    void window.steamCommenter.closeArtworkTool().catch(() => undefined)
  }, [account?.id, account?.sessionState, browser.tool, browser.accountId])

  useEffect(() => {
    const host = browserHost.current
    const authenticatedTool = browser.tool === 'upload' || browser.tool === 'showcase'
    if (!visible || !browser.tool || !host || (authenticatedTool && (account?.sessionState !== 'authenticated' || browser.accountId !== account.id))) {
      void window.steamCommenter.setArtworkToolBounds(null).catch(() => undefined)
      return
    }
    let frame = 0
    const measure = (): void => {
      frame = 0
      const bounds = artworkHostBounds(host.getBoundingClientRect(), window.innerWidth, window.innerHeight)
      void window.steamCommenter.setArtworkToolBounds(bounds).catch(() => undefined)
    }
    const schedule = (): void => { if (!frame) frame = window.requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      void window.steamCommenter.setArtworkToolBounds(null).catch(() => undefined)
    }
  }, [visible, browser.tool, account?.id, account?.sessionState, browser.accountId])

  const runTool = async (operation: () => Promise<IpcResult<unknown>>, success?: string): Promise<void> => {
    if (operationInFlight.current) return
    operationInFlight.current = true
    const serial = ++operationSerial.current
    setIpcBusy(true)
    setNotice(null)
    try {
      const result = await operation()
      if (!result.ok) throw new Error(result.error.code.startsWith('ARTWORK_') || result.error.code === 'NOT_AUTHENTICATED'
        ? `${artworkBrowserError(result.error.code, t)} (${result.error.code})` : result.error.message)
      if (success && operationSerial.current === serial) setNotice({ kind: 'success', message: success })
    } catch (error) {
      if (operationSerial.current === serial) setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('操作失败，请重试。', 'The action failed. Please retry.') })
    } finally {
      if (operationSerial.current === serial) { operationInFlight.current = false; setIpcBusy(false) }
    }
  }

  const canUseAccount = account?.sessionState === 'authenticated'
  const openTool = async (tool: ArtworkTool): Promise<void> => {
    const requiresAccount = tool === 'upload' || tool === 'showcase'
    if (requiresAccount && !canUseAccount) {
      setNotice({ kind: 'error', message: t('请先添加 Steam 账号或重新登录当前账号，再使用上传和展柜设置。', 'Add a Steam account or sign in again before uploading artwork or configuring a showcase.') })
      return
    }
    if (operationInFlight.current) return
    const intent = ++toolGeneration.current
    await runTool(async () => {
      const result = await window.steamCommenter.openArtworkTool(tool, requiresAccount ? account!.id : undefined)
      if (result.ok && toolGeneration.current === intent) setBrowser(result.data)
      return result
    })
  }

  const closeTool = async (): Promise<void> => {
    if (closingTool.current) return
    closingTool.current = true
    toolGeneration.current += 1
    operationSerial.current += 1
    operationInFlight.current = false
    setBrowser(CLOSED_BROWSER)
    void window.steamCommenter.setArtworkToolBounds(null).catch(() => undefined)
    try { await runTool(() => window.steamCommenter.closeArtworkTool()) }
    finally { closingTool.current = false }
  }

  const loadFile = async (file: File): Promise<void> => {
    const currentGeneration = ++generation.current
    let url: string | null = null
    setLoading(true)
    setAsset(null)
    setImageError(null)
    setNotice(null)
    try {
      if (file.size > MAX_ARTWORK_FILE_BYTES) throw new ArtworkError('fileTooLarge')
      const info = inspectStaticArtwork(new Uint8Array(await file.arrayBuffer()))
      url = URL.createObjectURL(file)
      const image = new Image()
      image.src = url
      await image.decode()
      const matchesDimensions = (image.naturalWidth === info.width && image.naturalHeight === info.height) ||
        (image.naturalWidth === info.height && image.naturalHeight === info.width)
      if (!matchesDimensions) throw new ArtworkError('invalidImage')
      if (generation.current !== currentGeneration) return
      setAsset({ url, image, width: image.naturalWidth, height: image.naturalHeight, fileName: file.name })
      url = null
      setCrop(defaultArtworkCrop(image.naturalWidth, image.naturalHeight, crop.preset))
    } catch (error) {
      if (generation.current === currentGeneration) setImageError(error instanceof ArtworkError ? error.code : 'invalidImage')
    } finally {
      if (url) URL.revokeObjectURL(url)
      if (generation.current === currentGeneration) setLoading(false)
    }
  }

  const fileChanged = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void loadFile(file)
  }

  const exportCrops = async (): Promise<void> => {
    if (!asset || cropResult.error || cropResult.rectangles.length === 0) return
    setExporting(true)
    setNotice(null)
    try {
      const outputs: { blob: Blob; name: string }[] = []
      const baseName = asset.fileName.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 96) || 'steam-background'
      for (const rectangle of cropResult.rectangles) {
        const canvas = document.createElement('canvas')
        canvas.width = rectangle.width
        canvas.height = rectangle.height
        const context = canvas.getContext('2d')
        if (!context) throw new ArtworkError('invalidImage')
        context.drawImage(asset.image, rectangle.x, rectangle.y, rectangle.width, rectangle.height, 0, 0, rectangle.width, rectangle.height)
        outputs.push({ blob: await canvasBlob(canvas), name: `${baseName}-${rectangle.name}.png` })
        canvas.width = 0
        canvas.height = 0
      }
      for (const output of outputs) saveLocalPng(output.blob, output.name)
      setNotice({ kind: 'success', message: t(`已生成 ${outputs.length} 张 PNG，请在保存窗口选择位置。`, `${outputs.length} PNG file(s) created. Choose a location in the save dialog.`) })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof ArtworkError ? errorMessage(error.code, t) : t('裁剪导出失败，请重试。', 'Crop export failed. Please retry.') })
    } finally { setExporting(false) }
  }

  const updateNumber = (key: 'x' | 'y' | 'height', value: string): void => {
    setCrop(previous => ({ ...previous, [key]: value === '' ? Number.NaN : Number(value) }))
  }

  return <div className={`artwork-tools-panel${browser.tool ? ' artwork-tools-embedded' : ''}`}>
    <div className="artwork-heading">
      <div><span className="artwork-eyebrow">STEAM ARTWORK</span><h2>{t('艺术作品展柜工具', 'Artwork showcase tools')}</h2><p>{browser.tool ? t('在线工具直接内嵌于工具箱，Steam 账号会话与当前账号隔离。', 'Online tools are embedded in the toolbox, with Steam sessions isolated by account.') : t('本地裁剪、作品上传和展柜配置都在工具箱中完成。在线页面仍需网络。', 'Crop locally, upload artwork and configure showcases within the toolbox. Online pages still require a connection.')}</p></div>
      {!browser.tool && <button className="ghost" disabled={ipcBusy} onClick={() => void openTool('design')}>{t('动画背景工具', 'Animated background tool')}</button>}
    </div>
    {notice && <p role="status" className={`artwork-notice ${notice.kind}`}>{notice.message}</p>}
    {!browser.tool && browser.error && <p role="alert" className="artwork-notice error">{artworkBrowserError(browser.error, t)} <code>{browser.error}</code></p>}
    {browser.tool ? <section className="artwork-browser-card" aria-label={t('工具箱内置艺术页面', 'Embedded artwork page')}>
      <ArtworkBrowserToolbar state={browser} busy={ipcBusy} onApply={() => void runTool(() => window.steamCommenter.applyLongArtwork(), t('长图设置已应用。请自行确认作品版权、标题和可见性，再点击 Steam 页面保存。', 'Long artwork settings applied. Review ownership, title and visibility, then save on the Steam page yourself.'))} onReload={() => void runTool(() => window.steamCommenter.reloadArtworkTool())} onClose={() => void closeTool()} onNavigate={tool => void openTool(tool)} />
      {(browser.tool === 'upload' || browser.tool === 'showcase') && <p className="artwork-browser-account">{t('当前账号', 'Current account')}: <strong>{account?.displayName ?? account?.accountName}</strong><span>{t('不会自动勾选版权声明或提交作品。', 'Ownership is not checked and artwork is not submitted automatically.')}</span></p>}
      {browser.tool === 'upload' && <p className="artwork-browser-instructions">{t('选择本地图片并等待预览载入，点击上方“应用长图设置”，然后自行保存。每张图片都需再次应用；无需 F12 或手动粘贴脚本。', 'Choose a local image, wait for the preview, apply the long artwork settings above, then save yourself. Apply again for each image; no F12 or manual script pasting is needed.')}</p>}
      {browser.error && <p role="alert" className="artwork-notice error">{artworkBrowserError(browser.error, t)} <code>{browser.error}</code></p>}
      <div ref={browserHost} className="artwork-browser-host" data-artwork-host="true" aria-label={t('内置在线工具显示区域', 'Embedded online tool display area')}>
        <div className="artwork-browser-placeholder">{browser.phase === 'loading' ? t('正在准备内置页面…', 'Preparing embedded page…') : browser.phase === 'error' ? t('使用上方“重新载入”重试。', 'Use Reload above to retry.') : t('在线页面在此显示。', 'The online page is displayed here.')}</div>
      </div>
    </section> : <>
    <section className="artwork-card artwork-upload-card">
      <div className="artwork-section-title"><span className="artwork-step">1</span><div><h3>{t('内置上传与展柜配置', 'Embedded upload and showcase setup')}</h3><p>{t('使用当前已登录的 Steam 账号，不离开工具箱。', 'Use the current signed-in Steam account without leaving the toolbox.')}</p></div></div>
      <ol className="artwork-upload-steps">
        <li>{t('在下方本地裁剪背景图，或使用内置动画背景工具准备图片。', 'Crop a static background below, or prepare images with the embedded animated background tool.')}</li>
        <li>{t('点击“在工具箱内上传”，选择图片并等待预览，然后点击工具栏“应用长图设置”。', 'Select Upload in toolbox, choose your image and wait for its preview, then click Apply long artwork settings in the toolbar.')}</li>
        <li>{t('核对标题、可见性，自己勾选作品版权声明并保存。上传完成后点击“配置艺术展柜”选择主图 / 侧图；展柜须账号已解锁。', 'Review the title and visibility, confirm ownership yourself and save. Then open Configure artwork showcase to select the main / side artwork. Your account must have unlocked the showcase.')}</li>
      </ol>
      <div className="artwork-actions">
        <button className="primary" disabled={ipcBusy || !canUseAccount} onClick={() => void openTool('upload')}>{t('在工具箱内上传', 'Upload in toolbox')}</button>
        <button disabled={ipcBusy || !canUseAccount} onClick={() => void openTool('showcase')}>{t('配置艺术展柜', 'Configure artwork showcase')}</button>
        <button disabled={ipcBusy} onClick={() => void openTool('design')}>{t('动画背景工具（内置 Steam.Design）', 'Animated backgrounds (embedded Steam.Design)')}</button>
      </div>
      <p className="artwork-account-help">{canUseAccount ? t(`使用账号：${account.displayName || account.accountName}。切换账号会关闭当前内置页面。`, `Using account: ${account.displayName || account.accountName}. Switching accounts closes the embedded page.`) : t('请先添加 Steam 账号或重新登录当前账号，才能上传和配置展柜。本地裁剪和动画背景工具无需登录。', 'Add a Steam account or sign in again to upload artwork and configure showcases. Local cropping and the animated background tool do not require sign-in.')}</p>
      <p className="artwork-help">{t('实际上传文件不被缩放，文件大小仍须满足 Steam 页面要求。展柜位置、边框、背景缩放方式会影响对齐，可在下方调整裁剪坐标。', 'The uploaded file is not resized and must meet the upload page file limit. Showcase position, borders and background scaling affect alignment; adjust crop coordinates below.')}</p>
      <details className="artwork-reference-details"><summary>{t('原作者指南与脚本说明（内置查看）', 'Original guides and script details (embedded)')}</summary><div className="artwork-source-links"><button className="artwork-text-button" disabled={ipcBusy} onClick={() => void openTool('guide')}>{t('长图上传原作者指南', 'Original long artwork guide')}</button><button className="artwork-text-button" disabled={ipcBusy} onClick={() => void openTool('sapic')}>SAPIC / Steam.Design</button></div><p className="artwork-help">{t('“应用长图设置”只把尺寸字段设置为 1000 × 1 并移除它们的 id，避免页面覆盖；不会代替版权声明或提交作品。', 'Apply long artwork settings only sets the dimension fields to 1000 × 1 and removes their IDs to prevent page overrides; it does not confirm ownership or submit artwork.')}</p><pre className="artwork-script" tabIndex={0} aria-label={t('可查看的长图脚本', 'Readable long artwork script')}><code>{script}</code></pre></details>
    </section>

    <section className="artwork-card artwork-crop-card">
      <div className="artwork-section-title"><span className="artwork-step">2</span><div><h3>{t('背景适配裁剪', 'Crop artwork from a background')}</h3><p>{t('导入已经保存的原始静态背景图，输出原分辨率的 PNG。', 'Import a saved, original static background and export PNG crops at the original resolution.')}</p></div></div>
      <div className="artwork-crop-layout">
        <div className="artwork-crop-controls">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={fileChanged} hidden />
          <button className="primary artwork-import" disabled={loading || exporting} onClick={() => fileInput.current?.click()}>{loading ? t('正在读取图片…', 'Reading image…') : t('导入本地背景图', 'Import local background')}</button>
          <small>{t('仅静态 PNG / JPEG · 最大 30 MiB、3200 万像素', 'Static PNG / JPEG only · Up to 30 MiB and 32 million pixels')}</small>
          {asset && <p className="artwork-file-name" title={asset.fileName}><strong>{asset.fileName}</strong><span>{asset.width} × {asset.height} px</span></p>}
          {imageError && <p className="artwork-notice error" role="alert">{errorMessage(imageError, t)}</p>}
          <label>{t('展柜类型', 'Showcase type')}<select value={crop.preset} disabled={exporting} onChange={event => setCrop(previous => ({ ...previous, preset: event.target.value as ArtworkCropInput['preset'] }))}>
            <option value="standard">{t('普通艺术作品：506 + 100 px', 'Artwork: 506 + 100 px')}</option>
            <option value="featured">{t('精选艺术作品：630 px', 'Featured Artwork: 630 px')}</option>
          </select></label>
          <div className="artwork-coordinate-inputs">
            <label>X <span>{t('横坐标', 'left')}</span><input aria-label={t('裁剪 X 坐标', 'Crop X coordinate')} type="number" step="1" min="0" value={Number.isNaN(crop.x) ? '' : crop.x} disabled={!asset || exporting} onChange={event => updateNumber('x', event.target.value)} /></label>
            <label>Y <span>{t('纵坐标', 'top')}</span><input aria-label={t('裁剪 Y 坐标', 'Crop Y coordinate')} type="number" step="1" min="0" value={Number.isNaN(crop.y) ? '' : crop.y} disabled={!asset || exporting} onChange={event => updateNumber('y', event.target.value)} /></label>
            <label>{t('高度', 'Height')}<input aria-label={t('裁剪高度', 'Crop height')} type="number" step="1" min="1" value={Number.isNaN(crop.height) ? '' : crop.height} disabled={!asset || exporting} onChange={event => updateNumber('height', event.target.value)} /></label>
          </div>
          <button disabled={!asset || exporting} onClick={() => { if (asset) setCrop(defaultArtworkCrop(asset.width, asset.height, crop.preset)) }}>{t('恢复默认对齐', 'Reset alignment')}</button>
          <p className="artwork-help">{t('默认 X = 原图宽度 ÷ 2 向下取整 − 467，Y = 256；侧图从 X + 515 开始，两张图之间留 9 px。高度默认取原图底部。不同展柜顺序可能需要调整 Y。', 'Default X = floor(image width / 2) − 467, Y = 256. The side image starts at X + 515, leaving a 9px gap. Default height extends to the bottom. Different showcase positions may need another Y value.')}</p>
          {cropResult.error && <p className="artwork-notice error" role="alert">{errorMessage(cropResult.error, t)}</p>}
          {cropResult.rectangles.length > 0 && <ul className="artwork-output-sizes">{cropResult.rectangles.map(rectangle => <li key={rectangle.name}>{cropLabel(rectangle.name, t)} <code>{rectangle.width} × {rectangle.height}</code></li>)}</ul>}
          <button className="primary artwork-export" disabled={!asset || !!cropResult.error || loading || exporting} onClick={() => void exportCrops()}>{exporting ? t('正在生成 PNG…', 'Creating PNG…') : crop.preset === 'standard' ? t('导出主图与侧图 PNG', 'Export main and side PNG') : t('导出精选图 PNG', 'Export featured PNG')}</button>
        </div>
        <div className="artwork-preview-wrap">
          {asset ? <div className="artwork-preview-scroll"><div className="artwork-preview-stage"><img src={asset.url} alt={t('本地背景与裁剪范围预览', 'Local background and crop preview')} draggable={false} />{cropResult.rectangles.map(rectangle => <div key={rectangle.name} className={`artwork-crop-overlay ${rectangle.name}`} style={{ left: `${rectangle.x / asset.width * 100}%`, top: `${rectangle.y / asset.height * 100}%`, width: `${rectangle.width / asset.width * 100}%`, height: `${rectangle.height / asset.height * 100}%` }}><span>{cropLabel(rectangle.name, t)}<small>{rectangle.width} px</small></span></div>)}</div></div> : <div className="artwork-preview-empty"><span>▧</span><strong>{t('选择背景图查看对齐预览', 'Choose a background to preview alignment')}</strong><p>{t('裁剪框保留原始像素，不拉伸。导出的主图 / 侧图可按上方步骤上传。', 'Crop boxes preserve original pixels without stretching. Upload the exported images using the steps above.')}</p></div>}
          <p className="artwork-preview-caption">{t('预览按可用宽度缩小；导出使用原图坐标和像素。图片只在当前工具页临时使用，不加入软件数据库。', 'The preview scales to fit; exports use original coordinates and pixels. Images are temporary on this page and are not added to the app database.')}</p>
        </div>
      </div>
      <p className="artwork-animation-note">{t('动画背景 / GIF / WebM：使用工具箱内置的 Steam.Design 在线页面，仍需网络。本地裁剪不导出动画，避免丢失帧。', 'Animated backgrounds / GIF / WebM: use the Steam.Design page embedded in the toolbox. It still requires a connection. Local cropping does not export animations, so frames are not discarded.')} <button className="artwork-text-button" disabled={ipcBusy} onClick={() => void openTool('design')}>{t('打开内置动画背景工具', 'Open embedded animated background tool')}</button></p>
    </section>
    </>}
  </div>
}

export default ArtworkToolsPanel
