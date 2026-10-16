import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ScreenshotCatalog, ScreenshotGame, ScreenshotImage, ScreenshotPrepareInput, ScreenshotPrepareResult
} from '../../../shared/steam-screenshots'
import { useI18n, type Translate } from '../i18n'
import { UiError, unwrap } from '../ui'
import type { RunAction } from './types'
import './screenshot-tools.css'

export function validScreenshotAppId(value: string): boolean {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4_294_967_295
}

export function validScreenshotGameId(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
}

export function filterScreenshotGames(games: ScreenshotGame[], query: string): ScreenshotGame[] {
  const term = query.trim().toLocaleLowerCase()
  return term ? games.filter(game => `${game.name}\n${game.appId}`.toLocaleLowerCase().includes(term)) : games
}

export function mergeScreenshotImages(current: ScreenshotImage[], next: ScreenshotImage[]): ScreenshotImage[] {
  const previous = new Map(current.map(image => [image.id, image]))
  return next.map(image => {
    const existing = previous.get(image.id)
    return existing && Object.keys(image).every(key => existing[key as keyof ScreenshotImage] === image[key as keyof ScreenshotImage]) ? existing : image
  })
}

export function screenshotPreparationReady(input: {
  catalog: ScreenshotCatalog | null; userId: string; appId: string; images: ScreenshotImage[];
  quality: string; resize: boolean; busy: boolean; caption: string
}): boolean {
  const quality = Number(input.quality)
  return Boolean(input.catalog?.steamPath && input.catalog.users.some(user => user.id === input.userId)
    && validScreenshotGameId(input.appId)
    && (validScreenshotAppId(input.appId) || input.catalog.games.some(game => game.appId === input.appId))
    && input.images.length && !input.busy
    && input.quality.trim() !== '' && Number.isInteger(quality) && quality >= 1 && quality <= 100
    && (input.resize || !input.images.some(image => image.resizeRequired))
    && input.caption.length <= 500 && !/[\u0000-\u001f\u007f]/.test(input.caption))
}

export function screenshotErrorMessage(code: string, t: Translate): string {
  switch (code) {
    case 'STEAM_RUNNING': case 'SCREENSHOT_STEAM_RUNNING': return t('请完全退出 Steam 客户端后再准备截图。这里只会读取运行状态，不会替你结束 Steam。', 'Fully exit the Steam client before preparing screenshots. The toolbox only checks its running state; it will not terminate Steam.')
    case 'STEAM_NOT_FOUND': case 'SCREENSHOT_STEAM_NOT_FOUND': case 'SCREENSHOT_INVALID_STEAM_PATH': case 'SCREENSHOT_INVALID_PATH': return t('未找到有效的 Steam 目录，请选择包含 steam.exe 和 userdata 的 Steam 安装目录。', 'No valid Steam directory was found. Choose the Steam installation containing steam.exe and userdata.')
    case 'SCREENSHOT_INVALID_APP_ID': case 'INVALID_APP_ID': case 'SCREENSHOT_INVALID_GAME': return t('请输入有效的游戏 AppID（正整数，不是商店链接）。', 'Enter a valid game App ID: a positive integer, not a store URL.')
    case 'SCREENSHOT_USER_NOT_FOUND': case 'SCREENSHOT_INVALID_USER': case 'SCREENSHOT_CATALOG_CHANGED': return t('目标本地用户或目录已变化，请刷新后重新选择。', 'The target local user or directory has changed. Refresh and select it again.')
    case 'SCREENSHOT_IMAGES_EMPTY': case 'SCREENSHOT_IMAGE_NOT_FOUND': case 'SCREENSHOT_STALE_IMAGES': case 'SCREENSHOT_INVALID_QUEUE': case 'SCREENSHOT_FILE_CHANGED': return t('图片队列或源文件已变化，请重新选择图片后重试。', 'The image queue or source files have changed. Select the images again before retrying.')
    case 'SCREENSHOT_INVALID_IMAGE': case 'SCREENSHOT_IMAGE_TOO_LARGE': case 'SCREENSHOT_UNSUPPORTED_IMAGE': case 'SCREENSHOT_UNSAFE_FILE': return t('部分图片无法读取或超过大小限制，请使用有效的静态 PNG / JPEG / WebP / BMP 图片。', 'Some images cannot be read or exceed the size limit. Choose valid static PNG / JPEG / WebP / BMP images.')
    case 'SCREENSHOT_QUEUE_LIMIT': return t('本地图片队列每次最多 100 张，请分批准备，避免大量图片占用内存。', 'The local image queue supports up to 100 images at a time. Prepare them in batches to limit memory use.')
    case 'SCREENSHOT_INVALID_CAPTION': return t('截图说明最多 500 字，不能包含换行或控制字符。', 'Captions must be at most 500 characters, without line breaks or control characters.')
    case 'SCREENSHOT_INVALID_INPUT': return t('请核对目标用户、游戏 AppID 和 JPEG 质量后重试。', 'Check the target user, game App ID and JPEG quality before retrying.')
    case 'SCREENSHOT_RESIZE_REQUIRED': return t('队列包含需要缩小的图片。请开启“大图自动缩小”，或移除这些图片。', 'The queue contains oversized images. Enable automatic resizing or remove those images.')
    case 'SCREENSHOT_BUSY': return t('另一个截图操作仍在进行，请稍后重试。', 'Another screenshot operation is still running. Try again when it finishes.')
    case 'SCREENSHOT_METADATA_INVALID': case 'SCREENSHOT_VDF_INVALID': return t('Steam 截图索引无法安全解析，已停止写入以保护原文件。请先检查截图管理器。', 'The Steam screenshot index could not be parsed safely. Writing was stopped to protect the original. Check the Steam screenshot manager first.')
    case 'SCREENSHOT_METADATA_CHANGED': return t('Steam 截图索引已被其他程序修改。已停止操作，请刷新后重试。', 'Another program changed the Steam screenshot index. The operation was stopped; refresh before retrying.')
    case 'SCREENSHOT_UNSAFE_PATH': return t('目标目录包含符号链接或重解析路径，已停止操作。请选择 Steam 的真实安装目录。', 'The target contains a symbolic link or reparse path. The operation was stopped. Choose the real Steam installation directory.')
    case 'SCREENSHOT_LOCKED': return t('另一个截图工具正在准备此用户的截图，请等它完成后再试。', 'Another screenshot tool is preparing screenshots for this user. Wait for it to finish before retrying.')
    case 'SCREENSHOT_ENCODE_FAILED': return t('图片转换未通过格式校验，未提交本地截图索引。请重新保存图片后再试。', 'The converted images failed format checks. The local screenshot index was not committed. Save the images again before retrying.')
    case 'SCREENSHOT_BACKUP_FAILED': return t('无法创建原截图索引的备份，未继续修改 Steam 数据。请检查目录权限和剩余空间。', 'The original screenshot index could not be backed up. Steam data was not modified further. Check folder permissions and free space.')
    case 'SCREENSHOT_STORE_UNAVAILABLE': return t('暂时无法查询游戏名称。可按 AppID 继续使用，或稍后重新查询。', 'The game name is temporarily unavailable. You can continue with its App ID or look it up again later.')
    default: return t('截图操作未完成，请检查 Steam 目录、图片文件和目录写入权限后重试。', 'The screenshot operation did not finish. Check the Steam directory, image files and folder permissions before retrying.')
  }
}

function warningMessage(code: string, t: Translate): string {
  switch (code) {
    case 'STEAM_NOT_FOUND': return t('尚未找到 Steam 安装目录，可手动定位。', 'The Steam installation has not been found. Locate it manually.')
    case 'USERS_NOT_FOUND': return t('此目录未发现本地 Steam 用户。请先用 Steam 客户端登录一次，再刷新。', 'No local Steam users were found in this directory. Sign in once through the Steam client, then refresh.')
    case 'LOGIN_NAMES_UNAVAILABLE': return t('登录用户资料暂不可读，部分用户将暂时显示 ID。', 'Login-user metadata is unavailable; some users may temporarily show only an ID.')
    case 'LIBRARY_METADATA_UNAVAILABLE': return t('部分游戏库资料暂不可读，可搜索其它游戏或手动填写 AppID。', 'Some library metadata is unavailable. Search another game or enter an App ID manually.')
    case 'USER_METADATA_UNAVAILABLE': return t('部分本地用户资料不可读，显示的用户列表可能不完整。', 'Some local user metadata is unreadable; the user list may be incomplete.')
    case 'SCREENSHOT_METADATA_UNAVAILABLE': return t('部分截图索引暂不可读，游戏列表可能不完整；写入前会再次检查。', 'Some screenshot indexes are unreadable; the game list may be incomplete. They will be checked again before writing.')
    case 'STEAM_RUNNING': return t('Steam 正在运行。可以选图和浏览资料，准备截图前请先完全退出 Steam。', 'Steam is running. You can browse metadata and select images, but must fully exit Steam before preparing screenshots.')
    default: return t('部分本地资料暂不可用，可以手动刷新重试。', 'Some local metadata is unavailable. Refresh to retry.')
  }
}

function imageSize(bytes: number): string {
  return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1_048_576).toFixed(1)} MiB`
}

export function safeScreenshotPreview(value: string): string | undefined {
  return /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : undefined
}

export function ScreenshotImageQueue({ images, busy, onAdd, onRemove, onClear }: {
  images: ScreenshotImage[]; busy: boolean; onAdd: () => void; onRemove: (id: string) => void; onClear: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  return <section className="screenshot-card screenshot-queue" aria-label={t('本地图片队列', 'Local image queue')}>
    <div className="screenshot-card-heading"><div><span className="screenshot-step">03</span><h3>{t('添加你的画面', 'Add your images')}</h3><p>{t('静态图片会转换为 JPEG，并生成 Steam 截图缩略图。原始图片不会被修改。', 'Static images are converted to JPEG with Steam screenshot thumbnails. The source images are not modified.')}</p></div>
      <div className="screenshot-actions"><button className="ghost" disabled={busy || images.length === 0} onClick={onClear}>{t('清空队列', 'Clear queue')}</button><button className="primary" disabled={busy} onClick={onAdd}>{t('选择图片', 'Choose images')}</button></div>
    </div>
    {images.length === 0 ? <button className="screenshot-empty" onClick={onAdd} disabled={busy}><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="9" width="36" height="30" rx="6" /><path d="m8 32 10-10 9 8 5-5 9 9M32 16h.01" /></svg><strong>{t('将喜欢的画面加入 Steam 截图库', 'Bring your favorite images to Steam')}</strong><span>{t('点击选择本地图片 · 无需登录工具箱账号', 'Choose local images · No toolbox sign-in required')}</span></button>
      : <><div className="screenshot-queue-count">{t(`${images.length} 张图片`, `${images.length} images`)}<span>{t('原图只读 · 预览保存在内存中', 'Read-only originals · Previews kept in memory')}</span></div><ul className="screenshot-image-grid">{images.map(image => <li className="screenshot-image" key={image.id}>
        <div className="screenshot-preview">{safeScreenshotPreview(image.previewUrl) ? <img src={safeScreenshotPreview(image.previewUrl)} alt={image.name} loading="lazy" /> : <span>{t('预览不可用', 'Preview unavailable')}</span>}<button className="screenshot-remove" aria-label={t(`移除 ${image.name}`, `Remove ${image.name}`)} disabled={busy} onClick={() => onRemove(image.id)}>×</button></div>
        <strong title={image.name}>{image.name}</strong><span>{image.width} × {image.height} · {imageSize(image.size)}</span>{image.resizeRequired && <small className="screenshot-resize-tag">{t('需缩小尺寸', 'Resizing required')}</small>}
      </li>)}</ul></>}
  </section>
}

export function ScreenshotPreparationResult({ result }: { result: ScreenshotPrepareResult }): React.JSX.Element {
  const { t } = useI18n()
  return <section className="screenshot-result" role="status"><strong>{t(`已准备 ${result.imported} 张本地截图，尚未上传至 Steam 云端`, `${result.imported} local screenshots prepared; not uploaded to Steam Cloud`)}</strong>
    <ol><li>{t('现在打开 Steam，进入「查看 → 录制与截图」或对应游戏的截图管理器。', 'Open Steam, then View → Recordings & Screenshots, or the screenshot manager for this game.')}</li><li>{t('找到刚准备的本地截图，检查内容后由你选择并确认上传。', 'Find the prepared local screenshots, review them, then select and confirm the upload yourself.')}</li></ol>
    <details><summary>{t('查看本地索引和备份位置', 'Show the local index and backup locations')}</summary><dl><div><dt>{t('截图索引', 'Screenshot index')}</dt><dd>{result.vdfPath}</dd></div><div><dt>{t('原始索引备份', 'Original index backup')}</dt><dd>{result.backupPath}</dd></div></dl></details>
  </section>
}

interface ScreenshotToolsProps { visible: boolean; runAction: RunAction }

export function ScreenshotToolsPanel({ visible, runAction }: ScreenshotToolsProps): React.JSX.Element {
  const { t, language } = useI18n()
  const [catalog, setCatalog] = useState<ScreenshotCatalog | null>(null)
  const [images, setImages] = useState<ScreenshotImage[]>([])
  const [userId, setUserId] = useState('')
  const [appId, setAppId] = useState('')
  const [query, setQuery] = useState('')
  const [manualAppId, setManualAppId] = useState('')
  const [manualGame, setManualGame] = useState<ScreenshotGame | null>(null)
  const [quality, setQuality] = useState('95')
  const [resize, setResize] = useState(true)
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [result, setResult] = useState<ScreenshotPrepareResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const games = useMemo(() => {
    const known = catalog?.games ?? []
    return manualGame && !known.some(game => game.appId === manualGame.appId) ? [manualGame, ...known] : known
  }, [catalog?.games, manualGame])
  const filteredGames = useMemo(() => filterScreenshotGames(games, query), [games, query])
  const user = catalog?.users.find(item => item.id === userId)
  const game = games.find(item => item.appId === appId)
  const numericQuality = Number(quality)
  const qualityValid = quality.trim() !== '' && Number.isInteger(numericQuality) && numericQuality >= 1 && numericQuality <= 100
  const captionValid = caption.length <= 500 && !/[\u0000-\u001f\u007f]/.test(caption)
  const requiresResize = images.some(image => image.resizeRequired)
  const ready = screenshotPreparationReady({ catalog, userId, appId, images, quality, resize, busy, caption })
  const refreshedAt = catalog?.refreshedAt && Number.isFinite(Date.parse(catalog.refreshedAt)) ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(catalog.refreshedAt)) : null

  const acceptCatalog = (next: ScreenshotCatalog): void => {
    setCatalog(next)
    setUserId(current => next.users.some(item => item.id === current) ? current : (next.users.find(item => item.mostRecent) ?? next.users[0])?.id ?? '')
  }

  useEffect(() => {
    mounted.current = true
    const serial = ++generation.current
    setLoading(true)
    let reading = false
    let pending = false
    let queuePending = false
    const read = async (includeImages: boolean): Promise<void> => {
      pending = true
      queuePending ||= includeImages
      if (reading) return
      reading = true
      try {
        while (pending && mounted.current && serial === generation.current) {
          pending = false
          const readImages = queuePending
          queuePending = false
          const next = unwrap(await window.steamCommenter.getScreenshotCatalog())
          if (!mounted.current || serial !== generation.current) return
          acceptCatalog(next)
          if (readImages) {
            const queue = unwrap(await window.steamCommenter.getScreenshotImages())
            if (mounted.current && serial === generation.current) setImages(current => mergeScreenshotImages(current, queue))
          }
        }
      } catch (error) {
        if (mounted.current && serial === generation.current) setErrorCode(error instanceof UiError ? error.code : 'SCREENSHOT_LOAD_FAILED')
      } finally {
        reading = false
        if (mounted.current && serial === generation.current) setLoading(false)
      }
    }
    const unsubscribe = window.steamCommenter.onEvent(event => { if (event.type === 'screenshotsChanged') void read(event.scope !== 'catalog') })
    void read(true)
    return () => { unsubscribe(); mounted.current = false; generation.current++ }
  }, [])

  const perform = async <T,>(label: string, action: () => Promise<T>, success: (value: T) => void): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setErrorCode(null)
    const serial = generation.current
    try {
      const value = await runAction(label, async () => {
        try { return await action() }
        catch (error) {
          const code = error instanceof UiError ? error.code : 'SCREENSHOT_OPERATION_FAILED'
          if (mounted.current && serial === generation.current) setErrorCode(code)
          throw new UiError(screenshotErrorMessage(code, t), code)
        }
      })
      if (mounted.current && serial === generation.current && value !== null) success(value)
    } finally {
      inFlight.current = false
      if (mounted.current && serial === generation.current) setBusy(false)
    }
  }

  const refresh = (): void => { void perform(t('正在刷新 Steam 用户和游戏', 'Refreshing Steam users and games'), async () => unwrap(await window.steamCommenter.refreshScreenshotCatalog()), acceptCatalog) }
  const chooseDirectory = (): void => { void perform(t('正在选择 Steam 目录', 'Choosing the Steam directory'), async () => unwrap(await window.steamCommenter.chooseScreenshotSteamDirectory()), next => { if (next) { acceptCatalog(next); setAppId(''); setManualGame(null); setResult(null) } }) }
  const updateQueue = (load: () => Promise<ScreenshotImage[]>): void => { void perform(t('正在更新图片队列', 'Updating the image queue'), load, next => { setImages(current => mergeScreenshotImages(current, next)); setResult(null) }) }
  const chooseImages = (): void => updateQueue(async () => unwrap(await window.steamCommenter.chooseScreenshotImages()))
  const useManualGame = (): void => {
    const id = manualAppId.trim()
    if (!validScreenshotAppId(id)) return
    setAppId(id)
    setManualGame({ appId: id, name: `App ${id}`, nameSource: 'fallback', installed: false, userIds: [] })
    setQuery('')
    void perform(t('正在查询游戏名称', 'Looking up the game name'), async () => unwrap(await window.steamCommenter.resolveScreenshotGame(id)), next => { setManualGame(next); setAppId(next.appId) })
  }
  const prepare = (): void => {
    if (!ready || !catalog?.steamPath || !user) return
    setConfirming(false)
    const input: ScreenshotPrepareInput = { steamPath: catalog.steamPath, userId: user.id, appId, imageIds: images.map(image => image.id), jpegQuality: numericQuality, resizeLargeImages: resize, caption: caption.trim() }
    void perform(t('正在安全准备 Steam 截图', 'Safely preparing Steam screenshots'), async () => unwrap(await window.steamCommenter.prepareScreenshots(input)), next => { setResult(next); setImages([]) })
  }

  return <div className="screenshot-tools" hidden={!visible}>
    <header className="screenshot-hero"><div><span className="screenshot-eyebrow">LOCAL SCREENSHOT STUDIO</span><h2>{t('让每一帧，进入你的 Steam', 'A place for every frame')}</h2><p>{t('选择本地用户与游戏，将喜爱的图片准备为 Steam 截图。全部操作留在工具箱里。', 'Choose a local user and game, then prepare your images as Steam screenshots. Everything stays inside the toolbox.')}</p></div><div className="screenshot-local-badge"><span />{t('本地处理 · 无需网页登录', 'Local processing · No web sign-in')}</div></header>

    <section className="screenshot-directory screenshot-card" aria-label={t('Steam 本地目录', 'Local Steam directory')}><div className="screenshot-directory-main"><span className={`screenshot-status-dot${catalog?.steamRunning ? ' running' : ''}`} /><div><h3>{t('Steam 本地资料', 'Local Steam metadata')}</h3><code>{catalog?.steamPath || t('正在自动发现 Steam 目录…', 'Discovering the Steam directory…')}</code><p>{loading ? t('正在读取启动时刷新的用户和游戏资料…', 'Loading user and game metadata refreshed at startup…') : refreshedAt ? t(`最近刷新 ${refreshedAt} · 每次启动自动刷新一次`, `Updated ${refreshedAt} · Automatically refreshed once at startup`) : t('尚无可用资料，请选择目录或手动刷新。', 'No metadata yet. Choose a directory or refresh manually.')}</p></div></div><div className="screenshot-actions"><button className="ghost" disabled={busy || loading} onClick={chooseDirectory}>{t('更换目录', 'Locate Steam')}</button><button disabled={busy || loading} onClick={refresh}>{t('刷新用户 / 游戏 / 状态', 'Refresh users / games / status')}</button></div></section>

    {errorCode && <p className="screenshot-alert" role="alert">{screenshotErrorMessage(errorCode, t)}</p>}
    {(catalog?.refreshing || Boolean(catalog?.nameLookupPending)) && <p className="screenshot-metadata-progress" role="status">{catalog?.nameLookupPending ? t(`正在补全用户和游戏名称 · 剩余 ${catalog.nameLookupPending} 项`, `Looking up user and game names · ${catalog.nameLookupPending} remaining`) : t('正在刷新本地用户与游戏资料…', 'Refreshing local user and game metadata…')}<span>{t('可继续选择图片，无需等待', 'You can continue selecting images')}</span></p>}
    {!captionValid && <p className="screenshot-alert" role="alert">{screenshotErrorMessage('SCREENSHOT_INVALID_CAPTION', t)}</p>}
    {catalog && catalog.warnings.length > 0 && <ul className="screenshot-warnings">{[...new Set(catalog.warnings)].map(code => <li key={code}>{warningMessage(code, t)}</li>)}</ul>}

    <div className="screenshot-workspace"><div className="screenshot-main-column"><section className="screenshot-card screenshot-targets"><div className="screenshot-user-select"><span className="screenshot-step">01</span><h3>{t('选择本地用户', 'Choose a local user')}</h3><p>{t('名字与 ID 同时显示，避免选错 userdata。与工具箱当前登录账号相互独立。', 'Names and IDs are shown together to avoid the wrong userdata. This is independent of the account signed into the toolbox.')}</p><label htmlFor="screenshot-user">{t('目标 Steam 用户', 'Target Steam user')}</label><select id="screenshot-user" value={userId} disabled={busy || !catalog?.users.length} onChange={event => { setUserId(event.target.value); setResult(null) }}><option value="">{t('请选择本地用户', 'Select a local user')}</option>{catalog?.users.map(item => <option key={item.id} value={item.id}>{item.displayName} · ID {item.id}{item.mostRecent ? t(' · 最近使用', ' · Most recent') : ''}</option>)}</select>{user && <span className="screenshot-meta">SteamID64: {user.steamId}</span>}</div>
      <div className="screenshot-game-select"><span className="screenshot-step">02</span><h3>{t('找到对应游戏', 'Find the right game')}</h3><p>{t('自动读取游戏库与本地记录。找不到的游戏可直接填写 AppID。', 'Read your libraries and local history automatically. Use an App ID if the game is missing.')}</p><label htmlFor="screenshot-game-search">{t('搜索游戏名称或 AppID', 'Search by game name or App ID')}</label><input id="screenshot-game-search" type="search" value={query} placeholder={t('例如：Counter-Strike 或 730', 'For example: Counter-Strike or 730')} disabled={busy} onChange={event => setQuery(event.target.value)} /><div className="screenshot-game-list" role="group" aria-label={t('可选择的游戏', 'Available games')}>{filteredGames.length ? filteredGames.map(item => <button key={item.appId} className={`screenshot-game-option${appId === item.appId ? ' selected' : ''}`} aria-pressed={appId === item.appId} disabled={busy} onClick={() => { setAppId(item.appId); setResult(null) }}><strong>{item.name}</strong><span>AppID {item.appId}{item.installed ? t(' · 已安装', ' · Installed') : item.nameSource === 'fallback' ? t(' · 名称待补全', ' · Name unavailable') : ''}</span></button>) : <p>{query ? t('没有匹配的游戏，可在下方填写 AppID。', 'No matching game. Enter its App ID below.') : t('尚未发现游戏，可填写 AppID 继续。', 'No games discovered. Enter an App ID to continue.')}</p>}</div><div className="screenshot-manual-game"><label htmlFor="screenshot-manual-app">{t('手动填写 AppID', 'Enter an App ID manually')}</label><div><input id="screenshot-manual-app" inputMode="numeric" placeholder="AppID" value={manualAppId} disabled={busy} onChange={event => setManualAppId(event.target.value)} /><button disabled={busy || !validScreenshotAppId(manualAppId.trim())} onClick={useManualGame}>{t('查名并使用', 'Look up & use')}</button></div><small>{t('名称查询不可用时仍可使用有效 AppID，不会把未识别的游戏当成其它游戏。', 'A valid App ID still works if name lookup is unavailable; an unknown game is never substituted with another one.')}</small></div></div></section>
      <ScreenshotImageQueue images={images} busy={busy} onAdd={chooseImages} onClear={() => updateQueue(async () => unwrap(await window.steamCommenter.clearScreenshotImages()))} onRemove={id => updateQueue(async () => unwrap(await window.steamCommenter.clearScreenshotImages([id])))} />
    </div><aside className="screenshot-card screenshot-output"><span className="screenshot-eyebrow">READY FOR STEAM</span><h3>{t('准备上传', 'Prepare for upload')}</h3><p>{t('先备份，再写入本地截图索引。最后的云端上传由你在 Steam 客户端确认。', 'Back up first, then write the local screenshot index. You confirm the final cloud upload in the Steam client.')}</p><dl className="screenshot-summary"><div><dt>{t('目标用户', 'Target user')}</dt><dd>{user?.displayName ?? t('尚未选择', 'Not selected')}{user && <small>ID {user.id}</small>}</dd></div><div><dt>{t('目标游戏', 'Target game')}</dt><dd>{game?.name ?? (appId ? `App ${appId}` : t('尚未选择', 'Not selected'))}{appId && <small>AppID {appId}</small>}</dd></div><div><dt>{t('图片数量', 'Image count')}</dt><dd>{images.length}</dd></div></dl><label className="screenshot-quality" htmlFor="screenshot-quality"><span>{t('JPEG 质量', 'JPEG quality')}<small>{t('1–100 · 推荐 95', '1–100 · Recommended 95')}</small></span><input id="screenshot-quality" type="number" min="1" max="100" step="1" value={quality} aria-invalid={!qualityValid} disabled={busy} onChange={event => setQuality(event.target.value)} /></label>{!qualityValid && <small className="screenshot-field-error">{t('质量应为 1 到 100 的整数。', 'Quality must be a whole number from 1 to 100.')}</small>}<label className="screenshot-resize-choice"><input type="checkbox" checked={resize} disabled={busy} onChange={event => setResize(event.target.checked)} /><span>{t('大图自动缩小', 'Resize oversized images')}<small>{t('保留比例，适配 Steam 截图限制', 'Preserve the aspect ratio and fit Steam screenshot limits')}</small></span></label>{requiresResize && !resize && <small className="screenshot-field-error">{t('请开启自动缩小，或移除队列中的大图。', 'Enable resizing or remove the oversized images.')}</small>}<label className="screenshot-caption" htmlFor="screenshot-caption">{t('截图说明（可选）', 'Caption (optional)')}<textarea id="screenshot-caption" value={caption} maxLength={500} rows={2} disabled={busy} onChange={event => setCaption(event.target.value)} placeholder={t('为这一组画面留下一句话', 'A few words for these images')} /></label><button className="primary screenshot-prepare" disabled={!ready} onClick={() => setConfirming(true)}>{busy ? t('正在处理…', 'Processing…') : t('准备 Steam 上传', 'Prepare Steam upload')}</button><small className="screenshot-write-note">{t('仅添加到本地截图库，不代表已上传。若 Steam 正在运行，会阻止写入并提示先退出。', 'Adds images to the local library only, not to the cloud. Writing is blocked while Steam is running; exit Steam first.')}</small></aside></div>

    {result && <ScreenshotPreparationResult result={result} />}
    <footer className="screenshot-footer">{t('实现参考 SteaScree 的本地截图流程，重新构建用户、游戏识别和安全备份；不修改 Steam 程序。', 'Inspired by the SteaScree local screenshot workflow, with rebuilt user/game discovery and safe backups. Steam program files are not modified.')}</footer>

    {confirming && <div className="modal-backdrop screenshot-confirm-backdrop"><section className="screenshot-confirm" role="alertdialog" aria-modal="true" aria-labelledby="screenshot-confirm-title"><span className="screenshot-eyebrow">CHECK THE DESTINATION</span><h3 id="screenshot-confirm-title">{t('确认本地截图目标', 'Confirm the local screenshot destination')}</h3><p>{t('请再次核对下面的用户与游戏。准备后需要由你在 Steam 中确认上传。', 'Double-check the user and game below. After preparation, you must confirm the upload in Steam.')}</p><dl><div><dt>{t('用户', 'User')}</dt><dd>{user?.displayName} · ID {userId}</dd></div><div><dt>{t('游戏', 'Game')}</dt><dd>{game?.name ?? `App ${appId}`} · AppID {appId}</dd></div><div><dt>{t('图片', 'Images')}</dt><dd>{images.length} · JPEG {quality}</dd></div></dl><p className="screenshot-confirm-note">{t('若 Steam 仍在运行，本次操作会停止，不会强行写入或关闭 Steam。', 'If Steam is still running, this operation stops. The toolbox will not force a write or close Steam.')}</p><div className="screenshot-actions"><button onClick={() => setConfirming(false)}>{t('返回检查', 'Back to review')}</button><button className="primary" disabled={!ready} onClick={prepare}>{t('备份并准备本地截图', 'Back up & prepare locally')}</button></div></section></div>}
  </div>
}

export default ScreenshotToolsPanel
