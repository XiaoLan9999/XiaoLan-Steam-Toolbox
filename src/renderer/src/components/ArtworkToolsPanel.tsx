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
import { ARTWORK_SOURCE_URLS, ARTWORK_UPLOAD_URL } from '../../../shared/artwork-links'
import type { IpcResult } from '../../../shared/types'
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
    case 'unsupportedFormat': return t('请选择静态 PNG 或 JPEG 图片。GIF、WebM 和 WebP 请使用 Steam.Design。', 'Choose a static PNG or JPEG image. Use Steam.Design for GIF, WebM or WebP.')
    case 'animatedImage': return t('检测到 APNG 动画。此工具只裁剪静态图片，请使用 Steam.Design 处理动画。', 'APNG animation detected. This tool crops static images; use Steam.Design for animation.')
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

export function ArtworkToolsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const [asset, setAsset] = useState<LocalArtwork | null>(null)
  const [crop, setCrop] = useState<ArtworkCropInput>({ preset: 'standard', x: 493, y: 256, height: 824 })
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [ipcBusy, setIpcBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [imageError, setImageError] = useState<ArtworkErrorCode | null>(null)
  const generation = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const script = useMemo(buildLongArtworkScript, [])
  const cropResult = useMemo((): { rectangles: ArtworkCropRect[]; error: ArtworkErrorCode | null } => {
    if (!asset) return { rectangles: [], error: null }
    try { return { rectangles: artworkCropRects(asset.width, asset.height, crop), error: null } }
    catch (error) { return { rectangles: [], error: error instanceof ArtworkError ? error.code : 'invalidCrop' } }
  }, [asset, crop])

  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => () => { if (asset) URL.revokeObjectURL(asset.url) }, [asset])

  const runTool = async (operation: () => Promise<IpcResult<void>>, success?: string): Promise<void> => {
    setIpcBusy(true)
    setNotice(null)
    try {
      const result = await operation()
      if (!result.ok) throw new Error(result.error.message)
      if (success) setNotice({ kind: 'success', message: success })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('操作失败，请重试。', 'The action failed. Please retry.') })
    } finally { setIpcBusy(false) }
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

  return <div className="artwork-tools-panel">
    <div className="artwork-heading">
      <div><span className="artwork-eyebrow">STEAM ARTWORK</span><h2>{t('艺术作品展柜工具', 'Artwork showcase tools')}</h2><p>{t('准备适配个人资料背景的艺术作品，裁剪预览和导出都在本机完成。', 'Prepare artwork that matches your profile background. Crop previews and exports run locally.')}</p></div>
      <button className="ghost" disabled={ipcBusy} onClick={() => void runTool(() => window.steamCommenter.openArtworkSource('steam-design'))}>{t('打开 Steam.Design', 'Open Steam.Design')} ↗</button>
    </div>
    {notice && <p role="status" className={`artwork-notice ${notice.kind}`}>{notice.message}</p>}

    <section className="artwork-card artwork-upload-card">
      <div className="artwork-section-title"><span className="artwork-step">1</span><div><h3>{t('长图上传脚本', 'Long artwork upload script')}</h3><p>{t('在 Steam 上传页面手动执行；每张图片都需要执行一次。', 'Run it manually on the Steam upload page, once for each image.')}</p></div></div>
      <ol className="artwork-upload-steps">
        <li>{t('打开下方的 Steam 艺术作品上传页，登录并选择要上传的本地图片。等待图片载入后再执行脚本。', 'Open the Steam artwork upload page below, sign in and select your local image. Wait for it to load before running the script.')}</li>
        <li>{t('按 F12 打开开发者工具，切换到 Console（控制台），复制下方脚本，粘贴并执行。', 'Press F12, switch to Console, copy the script below, paste it and run it.')}</li>
        <li>{t('检查标题、可见性等上传设置，按页面要求确认作品版权，然后自己点击保存。脚本仅设置两个尺寸字段为 1000 × 1，并移除它们的 id，以免上传页重新覆盖。', 'Review the title and visibility, confirm ownership as required by the page, then save the artwork yourself. The script only sets the two dimension fields to 1000 × 1 and removes their IDs so the page does not overwrite them.')}</li>
        <li>{t('上传成功后，在“编辑个人资料 → 精选展柜”选择艺术作品展柜，再选择刚上传的主图 / 侧图；精选艺术作品使用单张 630 像素宽的图。展柜需要账号已解锁。', 'After upload, open Edit Profile → Featured Showcase, choose an Artwork Showcase and select the uploaded main / side images. Featured Artwork uses one 630px-wide image. Your account must have unlocked the showcase.')}</li>
      </ol>
      <div className="artwork-actions">
        <button className="primary" disabled={ipcBusy} onClick={() => void runTool(() => window.steamCommenter.openArtworkPage())}>{t('打开艺术作品上传页', 'Open artwork upload page')} ↗</button>
        <button disabled={ipcBusy} onClick={() => void runTool(() => window.steamCommenter.copyArtworkScript(), t('脚本已复制。选择图片后，在 Steam 上传页 Console 执行。', 'Script copied. Select your image, then run it in the Steam upload page Console.'))}>{t('复制长图脚本', 'Copy long artwork script')}</button>
      </div>
      <pre className="artwork-script" tabIndex={0} aria-label={t('可查看的长图脚本', 'Readable long artwork script')}><code>{script}</code></pre>
      <p className="artwork-help">{t('实际上传文件不被缩放，文件大小仍须满足 Steam 页面要求。展柜位置、边框、背景缩放方式会影响对齐，可在下方调整裁剪坐标。', 'The uploaded file is not resized and must meet the upload page file limit. Showcase position, borders and background scaling affect alignment; adjust crop coordinates below.')}</p>
      <div className="artwork-source-links"><span>{t('公开来源', 'Public sources')}:</span>
        <a href={ARTWORK_SOURCE_URLS.guide} onClick={event => { event.preventDefault(); void runTool(() => window.steamCommenter.openArtworkSource('guide')) }}>{t('长图上传原作者指南', 'Original long artwork guide')} ↗</a>
        <a href={ARTWORK_SOURCE_URLS.sapic} onClick={event => { event.preventDefault(); void runTool(() => window.steamCommenter.openArtworkSource('sapic')) }}>SAPIC / Steam.Design ↗</a>
        <a href={ARTWORK_UPLOAD_URL} onClick={event => { event.preventDefault(); void runTool(() => window.steamCommenter.openArtworkPage()) }}>Steam {t('上传页', 'upload page')} ↗</a>
      </div>
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
      <p className="artwork-animation-note">{t('动画背景 / GIF / WebM：使用 Steam.Design 的在线裁剪工具。本机工具不导出动画，避免丢失帧。', 'Animated backgrounds / GIF / WebM: use the online Steam.Design crop tool. The local tool does not export animations, so frames are not discarded.')} <button className="artwork-text-button" disabled={ipcBusy} onClick={() => void runTool(() => window.steamCommenter.openArtworkSource('steam-design'))}>{t('前往 Steam.Design', 'Go to Steam.Design')} ↗</button></p>
    </section>
  </div>
}

export default ArtworkToolsPanel
