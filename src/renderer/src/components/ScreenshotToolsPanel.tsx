import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ScreenshotCatalog, ScreenshotGame, ScreenshotImage, ScreenshotImportMode, ScreenshotImportPhase, ScreenshotPrepareInput, ScreenshotPrepareResult
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
  quality: string; resize: boolean; busy: boolean; caption: string; mode?: ScreenshotImportMode
}): boolean {
  const quality = Number(input.quality)
  const pending = pendingScreenshotImages(input.images)
  const mode = input.mode ?? 'current-account'
  return Boolean(input.catalog?.steamPath && input.catalog.users.some(user => user.id === input.userId)
    && validScreenshotGameId(input.appId)
    && (validScreenshotAppId(input.appId) || input.catalog.games.some(game => game.appId === input.appId))
    && pending.length && !input.busy
    && input.quality.trim() !== '' && Number.isInteger(quality) && quality >= 1 && quality <= 100
    && (input.resize || !pending.some(image => image.resizeRequired))
    && input.caption.length <= 500 && !/[\u0000-\u001f\u007f]/.test(input.caption))
    && (mode === 'local-account' || Boolean(input.catalog?.steamRunning && input.caption.trim() === '' && validScreenshotAppId(input.appId) && Number(input.appId) <= 0xffffff && input.appId !== '480'))
}

export function pendingScreenshotImages(images: ScreenshotImage[]): ScreenshotImage[] {
  return images.filter(image => image.importStatus !== 'uncertain')
}

export function applyScreenshotImportResult(images: ScreenshotImage[], result: ScreenshotPrepareResult, submittedIds: string[]): ScreenshotImage[] {
  const completed = new Set(result.completedImageIds ?? (result.method === 'steam-api'
    ? result.outcomes?.filter(row => row.status === 'confirmed').map(row => row.imageId) ?? [] : submittedIds))
  const uncertain = new Map(result.outcomes?.filter(row => row.status === 'uncertain').map(row => [row.imageId, row]))
  return images.filter(image => !completed.has(image.id) || uncertain.has(image.id)).map(image => uncertain.has(image.id)
    ? { ...image, importStatus: 'uncertain', importReason: uncertain.get(image.id)?.code } : image)
}

export function screenshotErrorMessage(code: string, t: Translate): string {
  switch (code) {
    case 'SCREENSHOT_MODE_ONE_UNAVAILABLE': return t('模式一的当前账号截图接口不可用，已停止操作，不会退出 Steam 或自动改用模式二。你可以检查本机 Steam，或自行选择“模式二：指定账号本地导入”', 'Mode 1 could not use the current-account screenshot API. The operation stopped without exiting Steam or switching to Mode 2. Check the local Steam client, or select Mode 2 yourself')
    case 'SCREENSHOT_MODE_ONE_REQUIRES_STEAM': return t('模式一需要本机 Steam 已启动并登录。请打开 Steam 后刷新资料，或自行选择模式二；不会自动启动或退出 Steam', 'Mode 1 requires the local Steam client to be running and signed in. Open Steam and refresh the metadata, or select Mode 2. Steam will not be started or closed automatically')
    case 'SCREENSHOT_MODE_ONE_CAPTION_UNSUPPORTED': return t('模式一暂不支持截图说明。请清空说明后重试，或自行选择模式二；不会自动切换模式或退出 Steam', 'Mode 1 does not support captions. Clear the caption and retry, or select Mode 2 yourself. The mode will not change automatically and Steam will not exit')
    case 'SCREENSHOT_TARGET_CHANGED': return t('Steam 账号、进程或导入目标在操作中发生变化，已停止写入。请刷新并重新核对目标，不会强行继续或自动重启', 'The Steam account, client process or import target changed during the operation, so writing stopped. Refresh and review the target. The operation will not continue forcibly or restart Steam automatically')
    case 'SCREENSHOT_TARGET_NOT_CURRENT': return t('模式一只能导入本机 Steam 当前登录账号。所选账号不一致，请先在 Steam 中切到该账号，或自行选择模式二；不会退出 Steam', 'Mode 1 can import only to the account currently signed into the local Steam client. Switch Steam to the selected account, or select Mode 2 yourself. Steam will not be closed')
    case 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE': return t('尚未可靠核实本机 Steam 当前账号，已停止写入与重启。请等待 Steam 登录完成后刷新重试；不会凭缓存昵称或旧进程号判断账号', 'The current local Steam account could not be verified reliably. Writing and restart were stopped. Wait for Steam to finish signing in, then refresh and retry. Cached names or stale process IDs are not treated as account identity')
    case 'SCREENSHOT_LIVE_UNCERTAIN': return t('这张图片上次可能已经导入，已禁止重复提交。请先在 Steam 截图管理器核对；待核对图片会自动排除，其它待处理图片可继续导入', 'This image may already have been imported, so resubmission is blocked. Check Steam screenshots first. Uncertain images are excluded automatically; other pending images can still be imported')
    case 'SCREENSHOT_LIVE_LEDGER_INVALID': case 'SCREENSHOT_LIVE_LEDGER_FAILED': case 'SCREENSHOT_LIVE_LEDGER_UNAVAILABLE': return t('无法可靠读取或保存导入记录，已停止后续操作以避免重复导入。原图未修改，请保留导入记录并先在 Steam 中核对，不要删除记录后重复提交', 'Import records could not be read or saved reliably. Further operations stopped to avoid duplicates. Originals were not modified. Preserve the import records and check Steam first; do not delete records to resubmit images')
    case 'SCREENSHOT_LIVE_SHUTDOWN_FAILED': case 'SCREENSHOT_LIVE_STOP_FAILED': return t('尚未确认免重启截图组件已经退出，已停止后续操作，也不会转为重启导入。部分图片可能已经导入，请先核对 Steam 中的结果，再关闭并重新打开工具箱', 'The no-restart screenshot component has not confirmed exit. Further operations and restart fallback are blocked. Some images may already be imported. Check Steam first, then close and reopen the toolbox')
    case 'SCREENSHOT_LIVE_BUSY': case 'LIVE_BUSY': return t('免重启截图组件正在处理另一项操作，请等待完成后再试。不会重复提交图片或关闭 Steam', 'The no-restart screenshot component is processing another operation. Wait for it to finish. No images will be submitted again and Steam will not be closed')
    case 'SCREENSHOT_LIVE_UNAVAILABLE': return t('当前免重启截图接口不可用，未退出 Steam，也未自动改用其它模式。请检查本机 Steam，或自行选择模式二', 'The no-restart screenshot API is unavailable. Steam was not closed and no other mode was selected automatically. Check the local Steam client, or select Mode 2 yourself')
    case 'STEAM_RUNNING': case 'SCREENSHOT_STEAM_RUNNING': return t('Steam 仍在使用所选账号的索引，尚未写入截图。请在模式二下手动完全退出，或单独勾选自动退出并重启后重新确认；给非当前账号导入不需要退出', 'Steam is still using the selected account\'s index, so no screenshots were written. In Mode 2, fully exit manually or separately enable automatic exit/restart and confirm again. Importing to a different account does not require exit')
    case 'SCREENSHOT_STEAM_GAME_RUNNING': return t('Steam 检测到游戏仍在运行。请先保存并退出游戏，再重新确认截图导入；不会强制结束游戏', 'Steam reports a running game. Save and exit the game, then confirm the screenshot import again. The toolbox will not force the game to close')
    case 'SCREENSHOT_STEAM_RESTART_UNSUPPORTED': return t('当前系统不支持自动重启 Steam，请取消自动重启选项，手动完全退出 Steam 后再导入', 'Automatic Steam restart is not supported on this system. Disable it, fully exit Steam manually, then import again')
    case 'SCREENSHOT_STEAM_IDENTITY_FAILED': case 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED': case 'SCREENSHOT_STEAM_CLIENT_CHANGED': return t('无法核实当前 Steam 进程与所选安装目录一致，未自动关闭 Steam。请核对目录，或手动完全退出后再导入', 'The running Steam client could not be matched to the selected installation. It was not closed automatically. Check the directory, or fully exit Steam manually before importing')
    case 'SCREENSHOT_STEAM_SHUTDOWN_FAILED': case 'SCREENSHOT_STEAM_SHUTDOWN_TIMEOUT': return t('Steam 未能正常完全退出，截图尚未导入。请自行退出 Steam 后重试；工具箱不会强制结束进程', 'Steam did not fully exit normally; the screenshots have not been imported. Exit Steam manually and retry. The toolbox will not force-terminate processes')
    case 'SCREENSHOT_STEAM_EXIT_TIMEOUT': case 'SCREENSHOT_STEAM_SHUTDOWN_UNCONFIRMED': return t('尚未确认 Steam 完全退出，截图没有导入。退出请求可能仍在处理；若 Steam 随后自行关闭，请手动重新打开，再检查并重试。不会强杀进程', 'Steam exit could not be confirmed; no screenshots were imported. The exit request may still be pending. If Steam closes later, reopen it manually, review and retry. No process is force-terminated')
    case 'SCREENSHOT_STEAM_START_FAILED': case 'SCREENSHOT_STEAM_RESTART_TIMEOUT': return t('Steam 未能自动重新启动。请手动打开 Steam 并检查截图管理器，确认本地结果后再决定是否需要重试', 'Steam could not restart automatically. Open Steam manually and check the screenshot manager before deciding whether another import is needed')
    case 'SCREENSHOT_IMPORT_AND_RESTART_FAILED': return t('截图导入未完成，且 Steam 未能自动重新启动。请手动打开 Steam；图片队列已保留，检查错误和本地截图后再重试', 'Screenshot import did not finish and Steam could not restart automatically. Open Steam manually. The image queue is retained; review the error and local screenshots before retrying')
    case 'SCREENSHOT_STEAM_WORK_BUSY': return t('工具箱的游戏模拟、状态锁定或本机状态组件仍在工作，未关闭 Steam。请先停止这些功能，再重新确认截图导入', 'Game simulation, a status lock or a local status component is still active in the toolbox. Steam was not closed. Stop those features before confirming the screenshot import again')
    case 'SCREENSHOT_PROCESS_CHECK_FAILED': return t('无法可靠检查 Steam 进程，已停止截图操作。请检查系统权限后重试；不会在无法核实客户端状态时写入截图索引', 'Steam processes could not be checked reliably, so the screenshot operation stopped. Check system permissions and retry. The screenshot index is never written when client state cannot be verified')
    case 'STEAM_NOT_FOUND': case 'SCREENSHOT_STEAM_NOT_FOUND': case 'SCREENSHOT_INVALID_STEAM_PATH': case 'SCREENSHOT_INVALID_PATH': return t('未找到有效的 Steam 目录，请选择包含 steam.exe 和 userdata 的 Steam 安装目录', 'No valid Steam directory was found. Choose the Steam installation containing steam.exe and userdata')
    case 'SCREENSHOT_INVALID_APP_ID': case 'INVALID_APP_ID': case 'SCREENSHOT_INVALID_GAME': return t('请输入有效的游戏 AppID（正整数，不是商店链接）', 'Enter a valid game App ID: a positive integer, not a store URL')
    case 'SCREENSHOT_USER_NOT_FOUND': case 'SCREENSHOT_INVALID_USER': case 'SCREENSHOT_CATALOG_CHANGED': return t('目标本地用户或目录已变化，请刷新后重新选择', 'The target local user or directory has changed. Refresh and select it again')
    case 'SCREENSHOT_IMAGES_EMPTY': case 'SCREENSHOT_IMAGE_NOT_FOUND': case 'SCREENSHOT_STALE_IMAGES': case 'SCREENSHOT_INVALID_QUEUE': case 'SCREENSHOT_FILE_CHANGED': return t('图片队列或源文件已变化，请重新选择图片后重试', 'The image queue or source files have changed. Select the images again before retrying')
    case 'SCREENSHOT_INVALID_IMAGE': case 'SCREENSHOT_IMAGE_TOO_LARGE': case 'SCREENSHOT_UNSUPPORTED_IMAGE': case 'SCREENSHOT_UNSAFE_FILE': return t('部分图片无法读取或超过大小限制，请使用有效的静态 PNG / JPEG / WebP / BMP 图片', 'Some images cannot be read or exceed the size limit. Choose valid static PNG / JPEG / WebP / BMP images')
    case 'SCREENSHOT_QUEUE_LIMIT': return t('本地图片队列每次最多 100 张，请分批准备，避免大量图片占用内存', 'The local image queue supports up to 100 images at a time. Prepare them in batches to limit memory use')
    case 'SCREENSHOT_INVALID_CAPTION': return t('截图说明最多 500 字，不能包含换行或控制字符', 'Captions must be at most 500 characters, without line breaks or control characters')
    case 'SCREENSHOT_INVALID_INPUT': return t('请核对目标用户、游戏 AppID 和 JPEG 质量后重试', 'Check the target user, game App ID and JPEG quality before retrying')
    case 'SCREENSHOT_RESIZE_REQUIRED': return t('队列包含需要缩小的图片。请开启“大图自动缩小”，或移除这些图片', 'The queue contains oversized images. Enable automatic resizing or remove those images')
    case 'SCREENSHOT_BUSY': return t('另一个截图操作仍在进行，请稍后重试', 'Another screenshot operation is still running. Try again when it finishes')
    case 'SCREENSHOT_METADATA_INVALID': case 'SCREENSHOT_VDF_INVALID': return t('Steam 截图索引无法安全解析，已停止写入以保护原文件。请先检查截图管理器', 'The Steam screenshot index could not be parsed safely. Writing was stopped to protect the original. Check the Steam screenshot manager first')
    case 'SCREENSHOT_METADATA_CHANGED': return t('Steam 截图索引已被其他程序修改。已停止操作，请刷新后重试', 'Another program changed the Steam screenshot index. The operation was stopped; refresh before retrying')
    case 'SCREENSHOT_UNSAFE_PATH': return t('目标目录包含符号链接或重解析路径，已停止操作。请选择 Steam 的真实安装目录', 'The target contains a symbolic link or reparse path. The operation was stopped. Choose the real Steam installation directory')
    case 'SCREENSHOT_LOCKED': return t('另一个截图工具正在准备此用户的截图，请等它完成后再试', 'Another screenshot tool is preparing screenshots for this user. Wait for it to finish before retrying')
    case 'SCREENSHOT_ENCODE_FAILED': return t('图片转换未通过格式校验，未提交本地截图索引。请重新保存图片后再试', 'The converted images failed format checks. The local screenshot index was not committed. Save the images again before retrying')
    case 'SCREENSHOT_BACKUP_FAILED': return t('无法创建原截图索引的备份，未继续修改 Steam 数据。请检查目录权限和剩余空间', 'The original screenshot index could not be backed up. Steam data was not modified further. Check folder permissions and free space')
    case 'SCREENSHOT_STORE_UNAVAILABLE': return t('暂时无法查询游戏名称。可按 AppID 继续使用，或稍后重新查询', 'The game name is temporarily unavailable. You can continue with its App ID or look it up again later')
    default: return t('截图操作未完成，请检查 Steam 目录、图片文件和目录写入权限后重试', 'The screenshot operation did not finish. Check the Steam directory, image files and folder permissions before retrying')
  }
}

function warningMessage(code: string, t: Translate): string {
  switch (code) {
    case 'STEAM_NOT_FOUND': return t('尚未找到 Steam 安装目录，可手动定位', 'The Steam installation has not been found. Locate it manually')
    case 'USERS_NOT_FOUND': return t('此目录未发现本地 Steam 用户。请先用 Steam 客户端登录一次，再刷新', 'No local Steam users were found in this directory. Sign in once through the Steam client, then refresh')
    case 'LOGIN_NAMES_UNAVAILABLE': return t('登录用户资料暂不可读，部分用户将暂时显示 ID', 'Login-user metadata is unavailable; some users may temporarily show only an ID')
    case 'LIBRARY_METADATA_UNAVAILABLE': return t('部分游戏库资料暂不可读，可搜索其它游戏或手动填写 AppID', 'Some library metadata is unavailable. Search another game or enter an App ID manually')
    case 'USER_METADATA_UNAVAILABLE': return t('部分本地用户资料不可读，显示的用户列表可能不完整', 'Some local user metadata is unreadable; the user list may be incomplete')
    case 'SCREENSHOT_METADATA_UNAVAILABLE': return t('部分截图索引暂不可读，游戏列表可能不完整；写入前会再次检查', 'Some screenshot indexes are unreadable; the game list may be incomplete. They will be checked again before writing')
    case 'STEAM_RUNNING': return t('Steam 正在运行。模式一仅导入当前 Steam 账号；模式二给非当前账号写入本地图库，不退出 Steam，切到该账号后生效', 'Steam is running. Mode 1 imports only to the current Steam account. Mode 2 writes another account\'s local library without exiting Steam; switch to that account to see the images')
    default: return t('部分本地资料暂不可用，可以手动刷新重试', 'Some local metadata is unavailable. Refresh to retry')
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
    <div className="screenshot-card-heading"><div><span className="screenshot-step">03</span><h3>{t('添加你的画面', 'Add your images')}</h3><p>{t('静态图片会转换为 JPEG，并生成 Steam 截图缩略图。原始图片不会被修改', 'Static images are converted to JPEG with Steam screenshot thumbnails. The source images are not modified')}</p></div>
      <div className="screenshot-actions"><button className="ghost" disabled={busy || images.length === 0} onClick={onClear}>{t('清空队列', 'Clear queue')}</button><button className="primary" disabled={busy} onClick={onAdd}>{t('选择图片', 'Choose images')}</button></div>
    </div>
    {images.length === 0 ? <button className="screenshot-empty" onClick={onAdd} disabled={busy}><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="9" width="36" height="30" rx="6" /><path d="m8 32 10-10 9 8 5-5 9 9M32 16h.01" /></svg><strong>{t('将喜欢的画面加入 Steam 截图库', 'Bring your favorite images to Steam')}</strong><span>{t('点击选择本地图片 · 无需登录工具箱账号', 'Choose local images · No toolbox sign-in required')}</span></button>
      : <><div className="screenshot-queue-count">{t(`${images.length} 张图片`, `${images.length} images`)}<span>{t('原图只读 · 预览保存在内存中', 'Read-only originals · Previews kept in memory')}</span></div><ul className="screenshot-image-grid">{images.map(image => <li className="screenshot-image" key={image.id}>
        <div className="screenshot-preview">{safeScreenshotPreview(image.previewUrl) ? <img src={safeScreenshotPreview(image.previewUrl)} alt={image.name} loading="lazy" /> : <span>{t('预览不可用', 'Preview unavailable')}</span>}<button className="screenshot-remove" aria-label={t(`移除 ${image.name}`, `Remove ${image.name}`)} disabled={busy} onClick={() => onRemove(image.id)}>×</button></div>
        <strong title={image.name}>{image.name}</strong><span>{image.width} × {image.height} · {imageSize(image.size)}</span>{image.resizeRequired && <small className="screenshot-resize-tag">{t('需缩小尺寸', 'Resizing required')}</small>}{image.importStatus === 'uncertain' && <small className="screenshot-field-error screenshot-uncertain-tag">{t('待核对：已排除，禁止重复导入', 'Uncertain: excluded; reimport blocked')}</small>}
      </li>)}</ul></>}
  </section>
}

export function ScreenshotPreparationResult({ result }: { result: ScreenshotPrepareResult }): React.JSX.Element {
  const { t } = useI18n()
  const live = result.method === 'steam-api'
  const afterSwitch = result.activation === 'after-account-switch'
  const outcomes = result.outcomes ?? []
  const rejected = outcomes.filter(row => row.status === 'rejected').length
  const uncertain = outcomes.filter(row => row.status === 'uncertain').length
  return <section className={`screenshot-result${rejected || uncertain ? ' has-issues' : ''}`} role="status"><strong>{t(`已准备 ${result.imported} 张本地截图，尚未上传至 Steam 云端`, `${result.imported} local screenshots prepared; not uploaded to Steam Cloud`)}</strong>
    {live && <p className="screenshot-restart-result">{t('本次使用免重启截图接口，Steam 未被关闭或重启；由 Steam 自行写入截图与索引', 'The no-restart screenshot API was used. Steam was not closed or restarted; Steam wrote its own images and index')}</p>}
    {afterSwitch && <p className="screenshot-after-switch" role="status">{t('已导入所选账号的本地截图库。当前 Steam 未被退出或重启；切换到该账号后查看并确认上传即可，无需现在进行额外操作', 'The selected account\'s local screenshot library is prepared. The current Steam client was not closed or restarted. Switch to that account later to view the images and confirm any cloud upload; no extra action is needed now')}</p>}
    {result.warning === 'LIVE_WORKER_STOP_UNCONFIRMED' && <p className="screenshot-native-stop-warning" role="alert">{t('截图组件尚未确认退出，模拟、锁定、状态复制及重启操作暂时受限。已经确认成功的截图仍然有效，不要重复导入；下次导入会先重试清理，或关闭并重新打开工具箱后再继续', 'The screenshot component has not confirmed exit. Simulation, status locking, copying and restart operations are temporarily restricted. Confirmed imports remain valid; do not import them again. The next import will retry cleanup first, or close and reopen the toolbox before continuing')}</p>}
    {outcomes.length > 0 && <div className="screenshot-live-results"><p className="screenshot-outcome-counts">{t(`已确认 ${result.imported} · 未导入 ${rejected} · 待核对 ${uncertain}`, `Confirmed ${result.imported} · Not imported ${rejected} · Uncertain ${uncertain}`)}</p><p>{t('已确认成功的图片已移出队列。待核对图片会自动排除，不会重试或通过其它模式重复导入；请先在 Steam 中检查。其它明确失败或尚未提交的图片可继续处理', 'Confirmed images were removed from the queue. Uncertain images are excluded automatically and will not be retried or reimported through another mode; check Steam first. Other rejected or unsubmitted images can still be processed')}</p><details open={rejected + uncertain > 0}><summary>{t('逐张导入结果', 'Per-image import results')}</summary><ul>{outcomes.map(row => <li key={row.imageId} data-status={row.status}><span>{row.name}</span><small>{row.status === 'confirmed' ? t('已确认导入', 'Import confirmed') : row.status === 'uncertain' ? t('待核对（禁止重复导入）', 'Uncertain (reimport blocked)') : row.code === 'LIVE_NOT_SUBMITTED' ? t('尚未提交，可继续处理', 'Not submitted; ready to process') : t('未导入，可重试或自行选择模式二', 'Not imported; retry or select Mode 2 yourself')}{row.code && ` · ${row.code}`}</small></li>)}</ul></details></div>}
    {result.steamRestart === 'restarted' && <p className="screenshot-restart-result">{t('Steam 已重新启动，截图索引已在退出期间写入', 'Steam has restarted. The screenshot index was written while the client was closed')}</p>}
    {result.steamRestart === 'failed' && <p className="screenshot-restart-failed" role="alert">{t('截图已导入，但 Steam 未能自动重新启动。请手动打开 Steam；不要再次导入同一批图片', 'The screenshots were imported, but Steam could not restart automatically. Open Steam manually; do not import the same images again')}</p>}
    <ol><li>{afterSwitch ? t('方便时在 Steam 中切换到本次所选账号，再进入「查看 → 录制与截图」。工具箱不会自动替你切号', 'When convenient, switch Steam to the selected account, then open View → Recordings & Screenshots. The toolbox will not switch accounts for you') : live ? t('直接在当前 Steam 中进入「查看 → 录制与截图」或对应游戏的截图管理器，无需退出或重新打开 Steam', 'In the current Steam client, go to View → Recordings & Screenshots, or the screenshot manager for this game. No exit or restart is needed') : result.steamRestart === 'restarted' ? t('在重新打开的 Steam 中进入「查看 → 录制与截图」或对应游戏的截图管理器', 'In the reopened Steam client, go to View → Recordings & Screenshots, or the screenshot manager for this game') : t('现在打开 Steam，进入「查看 → 录制与截图」或对应游戏的截图管理器', 'Open Steam, then View → Recordings & Screenshots, or the screenshot manager for this game')}</li><li>{t('找到刚准备的本地截图，检查内容后由你选择并确认上传', 'Find the prepared local screenshots, review them, then select and confirm the upload yourself')}</li></ol>
    <details><summary>{result.backupPath ? t('查看本地索引和备份位置', 'Show the local index and backup locations') : t('查看本地截图索引位置', 'Show the local screenshot index location')}</summary><dl><div><dt>{t('截图索引', 'Screenshot index')}</dt><dd>{result.vdfPath}</dd></div>{result.backupPath && <div><dt>{t('原始索引备份', 'Original index backup')}</dt><dd>{result.backupPath}</dd></div>}</dl></details>
  </section>
}

export function ScreenshotRestartChoice({ checked, disabled, onChange }: {
  checked: boolean; disabled: boolean; onChange: (checked: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return <label className="screenshot-resize-choice screenshot-restart-choice"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{t('自动退出并重启 Steam', 'Automatically exit and restart Steam')}<small>{t('独立选项，默认关闭。仅模式二写入当前 Steam 账号、确实需要退出时适用，并会再次确认。非当前账号始终不退出、不重启；模式一不会使用此选项', 'Separate option, off by default. Applies only when Mode 2 targets the current Steam account and requires exit, with another confirmation. A different account never closes or restarts Steam. Mode 1 never uses this option')}</small></span></label>
}

export function ScreenshotModeChoice({ value, disabled, onChange }: { value: ScreenshotImportMode; disabled: boolean; onChange: (value: ScreenshotImportMode) => void }): React.JSX.Element {
  const { t } = useI18n()
  return <fieldset className="screenshot-mode-choice" disabled={disabled}><legend>{t('截图导入模式', 'Screenshot import mode')}</legend>
    <label className={`screenshot-mode-option${value === 'current-account' ? ' selected' : ''}`}><input type="radio" name="screenshot-import-mode" value="current-account" checked={value === 'current-account'} onChange={() => onChange('current-account')} /><span><strong>{t('模式一：当前账号免重启导入', 'Mode 1: current-account no-restart import')}<em>{t('默认', 'Default')}</em></strong><small>{t('使用本机假游戏辅助进程和 Steam 截图接口传输，只允许本机 Steam 当前登录账号、有效 Steam AppID 和空说明。请先退出真实游戏与状态模拟。不会退出 Steam，失败也不会自动改为模式二', 'Transfers through a local fake-game helper and the Steam screenshot API. Requires the account currently signed into Steam, a valid Steam App ID and no caption. Exit real games and presence simulation first. Steam is not closed, and failure never switches to Mode 2 automatically')}</small></span></label>
    <label className={`screenshot-mode-option${value === 'local-account' ? ' selected' : ''}`}><input type="radio" name="screenshot-import-mode" value="local-account" checked={value === 'local-account'} onChange={() => onChange('local-account')} /><span><strong>{t('模式二：指定账号本地导入', 'Mode 2: selected-account local import')}</strong><small>{t('备份后写入所选账号的本地截图库，不启动假游戏。非当前 Steam 账号直接导入，不退出 Steam；切到该账号后生效。目标若是当前 Steam 账号，需先退出，或单独选择自动退出并重启', 'Backs up and writes the selected account\'s local screenshot library without a fake game. A different Steam account is prepared without exiting Steam; switch to it later to see the images. If the target is the current Steam account, exit Steam first or separately enable automatic exit and restart')}</small></span></label>
  </fieldset>
}

export function screenshotImportPhaseMessage(phase: ScreenshotImportPhase, t: Translate): string {
  switch (phase) {
    case 'connecting-steam': return t('正在连接当前 Steam 的截图接口，不退出客户端…', 'Connecting to the current Steam screenshot API without exiting the client…')
    case 'importing-live': return t('正在免重启导入并逐张核实，请勿切换 Steam 账号或退出工具箱…', 'Importing without restart and verifying each image. Do not switch Steam accounts or close the toolbox…')
    case 'closing-steam': return t('正在等待 Steam 正常完全退出，尚未写入截图…', 'Waiting for Steam to exit fully; no screenshots have been written yet…')
    case 'importing': return t('正在备份并写入所选账号的本地图库，请勿启动或切换 Steam 账号，也不要退出工具箱…', 'Backing up and writing the selected account\'s local library. Do not start or switch Steam accounts, or close the toolbox…')
    case 'starting-steam': return t('本地导入处理已结束，正在重新打开 Steam…', 'Local import processing has ended. Reopening Steam…')
    case 'idle': return ''
  }
}

export function ScreenshotImportProgress({ phase }: { phase: ScreenshotImportPhase }): React.JSX.Element | null {
  const { t } = useI18n()
  if (phase === 'idle') return null
  return <p className="screenshot-import-progress" role="status" aria-live="polite">{screenshotImportPhaseMessage(phase, t)}</p>
}

export function ScreenshotImportConfirmation(props: {
  userName: string; userId: string; gameName: string; appId: string; imageCount: number; quality: string;
  restartSteam: boolean; mode?: ScreenshotImportMode; ready: boolean; onCancel: () => void; onConfirm: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const current = (props.mode ?? 'current-account') === 'current-account'
  return <div className="modal-backdrop screenshot-confirm-backdrop"><section className="screenshot-confirm" role="alertdialog" aria-modal="true" aria-labelledby="screenshot-confirm-title" aria-describedby="screenshot-confirm-note">
    <span className="screenshot-eyebrow">CHECK THE DESTINATION</span><h3 id="screenshot-confirm-title">{t('确认本地截图目标', 'Confirm the local screenshot destination')}</h3>
    <p>{t('请核对本次明确选择的模式、账号与游戏。这里只导入本地截图库，不上传云端', 'Check the explicitly selected mode, account and game. This imports into the local screenshot library only, not the cloud')}</p>
    <dl><div><dt>{t('用户', 'User')}</dt><dd>{props.userName} · ID {props.userId}</dd></div><div><dt>{t('游戏', 'Game')}</dt><dd>{props.gameName} · AppID {props.appId}</dd></div><div><dt>{t('图片', 'Images')}</dt><dd>{props.imageCount} · JPEG {props.quality}</dd></div></dl>
    <div id="screenshot-confirm-note" className="screenshot-confirm-note"><strong>{current ? t('模式一：当前账号免重启导入', 'Mode 1: current-account no-restart import') : t('模式二：指定账号本地导入', 'Mode 2: selected-account local import')}</strong>
      {current ? <><p>{t('仅通过本机假游戏辅助进程与 Steam 截图接口传输。所选账号必须是 Steam 当前登录账号；目标不一致或接口不可用时停止，不会退出 Steam，也不会自动切换模式', 'Transfers only through the local fake-game helper and Steam screenshot API. The selected account must be the one currently signed into Steam. A mismatch or unavailable API stops the operation without exiting Steam or changing modes')}</p><p>{t('请先退出真实游戏与状态模拟。已确认或待核对的图片不会自动重复导入；“自动退出并重启”选项在本模式不生效', 'Exit real games and presence simulation first. Confirmed or uncertain images are never automatically reimported. The automatic exit/restart option does not apply to this mode')}</p></>
        : <><p>{t('将先核实本机 Steam 当前账号，再备份并写入所选账号的本地截图索引。目标是非当前账号时，不退出、不重启 Steam，也不启动假游戏；切到目标账号后查看即可', 'The current local Steam account is verified before the selected account\'s index is backed up and written. For a different account, Steam is never closed or restarted and no fake game starts. Switch to the target account later to view the images')}</p><p>{props.restartSteam ? t('已单独勾选自动退出并重启：仅目标正是当前 Steam 账号时才会再次询问是否正常退出、导入并重开。非当前账号始终不触发；取消提示不会退出 Steam', 'Automatic exit and restart was selected separately. Only if the target is the current Steam account will another prompt ask to exit normally, import and reopen. A different account never triggers it. Cancelling the prompt does not close Steam') : t('自动退出并重启已关闭。若目标是当前 Steam 账号，请先手动完全退出 Steam；工具箱不会替你结束进程。非当前账号无需退出', 'Automatic exit and restart is off. If the target is the current Steam account, fully exit Steam manually first. The toolbox will not terminate it for you. A different account does not require exit')}</p></>}
    </div><div className="screenshot-actions"><button autoFocus onClick={props.onCancel}>{t('返回检查', 'Back to review')}</button><button className="primary" disabled={!props.ready} onClick={props.onConfirm}>{t('确认并继续导入', 'Confirm & continue import')}</button></div>
  </section></div>
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
  const [restartSteam, setRestartSteam] = useState(false)
  const [mode, setMode] = useState<ScreenshotImportMode>('current-account')
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [result, setResult] = useState<ScreenshotPrepareResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [importPhase, setImportPhase] = useState<ScreenshotImportPhase>('idle')
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
  const pendingImages = useMemo(() => pendingScreenshotImages(images), [images])
  const requiresResize = pendingImages.some(image => image.resizeRequired)
  const ready = screenshotPreparationReady({ catalog, userId, appId, images, quality, resize, busy, caption, mode })
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
    const unsubscribe = window.steamCommenter.onEvent(event => {
      if (event.type === 'screenshotsChanged') void read(event.scope !== 'catalog')
      if (event.type === 'screenshotImportProgress') setImportPhase(event.phase)
    })
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
      if (mounted.current && serial === generation.current) { setBusy(false); setImportPhase('idle') }
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
    const input: ScreenshotPrepareInput = { steamPath: catalog.steamPath, userId: user.id, appId, imageIds: pendingImages.map(image => image.id), jpegQuality: numericQuality, resizeLargeImages: resize, caption: caption.trim(), mode, restartSteam: mode === 'local-account' && restartSteam }
    void perform(t('正在安全准备 Steam 截图', 'Safely preparing Steam screenshots'), async () => unwrap(await window.steamCommenter.prepareScreenshots(input)), next => { if (next) { setResult(next); setImages(current => applyScreenshotImportResult(current, next, input.imageIds)) } })
  }

  return <div className="screenshot-tools" hidden={!visible}>
    <header className="screenshot-hero"><div><span className="screenshot-eyebrow">LOCAL SCREENSHOT STUDIO</span><h2>{t('让每一帧，进入你的 Steam', 'A place for every frame')}</h2><p>{t('选择本地用户与游戏，将喜爱的图片准备为 Steam 截图。全部操作留在工具箱里', 'Choose a local user and game, then prepare your images as Steam screenshots. Everything stays inside the toolbox')}</p></div><div className="screenshot-local-badge"><span />{t('本地处理 · 无需网页登录', 'Local processing · No web sign-in')}</div></header>

    <section className="screenshot-directory screenshot-card" aria-label={t('Steam 本地目录', 'Local Steam directory')}><div className="screenshot-directory-main"><span className={`screenshot-status-dot${catalog?.steamRunning ? ' running' : ''}`} /><div><h3>{t('Steam 本地资料', 'Local Steam metadata')}</h3><code>{catalog?.steamPath || t('正在自动发现 Steam 目录…', 'Discovering the Steam directory…')}</code><p>{loading ? t('正在读取启动时刷新的用户和游戏资料…', 'Loading user and game metadata refreshed at startup…') : refreshedAt ? t(`最近刷新 ${refreshedAt} · 每次启动自动刷新一次`, `Updated ${refreshedAt} · Automatically refreshed once at startup`) : t('尚无可用资料，请选择目录或手动刷新', 'No metadata yet. Choose a directory or refresh manually')}</p></div></div><div className="screenshot-actions"><button className="ghost" disabled={busy || loading} onClick={chooseDirectory}>{t('更换目录', 'Locate Steam')}</button><button disabled={busy || loading} onClick={refresh}>{t('刷新用户 / 游戏 / 状态', 'Refresh users / games / status')}</button></div></section>

    {errorCode && <p className="screenshot-alert" role="alert">{screenshotErrorMessage(errorCode, t)}</p>}
    {busy && <ScreenshotImportProgress phase={importPhase} />}
    {(catalog?.refreshing || Boolean(catalog?.nameLookupPending)) && <p className="screenshot-metadata-progress" role="status">{catalog?.nameLookupPending ? t(`正在补全用户和游戏名称 · 剩余 ${catalog.nameLookupPending} 项`, `Looking up user and game names · ${catalog.nameLookupPending} remaining`) : t('正在刷新本地用户与游戏资料…', 'Refreshing local user and game metadata…')}<span>{t('可继续选择图片，无需等待', 'You can continue selecting images')}</span></p>}
    {!captionValid && <p className="screenshot-alert" role="alert">{screenshotErrorMessage('SCREENSHOT_INVALID_CAPTION', t)}</p>}
    {catalog && catalog.warnings.length > 0 && <ul className="screenshot-warnings">{[...new Set(catalog.warnings)].map(code => <li key={code}>{warningMessage(code, t)}</li>)}</ul>}

    <ScreenshotModeChoice value={mode} disabled={busy} onChange={next => { setMode(next); setResult(null); setErrorCode(null) }} />
    {mode === 'current-account' && caption.trim() !== '' && <p className="screenshot-alert" role="alert">{screenshotErrorMessage('SCREENSHOT_MODE_ONE_CAPTION_UNSUPPORTED', t)}</p>}
    {mode === 'current-account' && catalog && !catalog.steamRunning && <p className="screenshot-alert" role="status">{screenshotErrorMessage('SCREENSHOT_MODE_ONE_REQUIRES_STEAM', t)}</p>}

    <div className="screenshot-workspace"><div className="screenshot-main-column"><section className="screenshot-card screenshot-targets"><div className="screenshot-user-select"><span className="screenshot-step">01</span><h3>{t('选择本地用户', 'Choose a local user')}</h3><p>{t('名字与 ID 同时显示，避免选错 userdata。与工具箱当前登录账号相互独立；免重启导入须与本机 Steam 当前账号一致', 'Names and IDs are shown together to avoid the wrong userdata. This is independent of the account signed into the toolbox; no-restart import must match the current local Steam account')}</p><label htmlFor="screenshot-user">{t('目标 Steam 用户', 'Target Steam user')}</label><select id="screenshot-user" value={userId} disabled={busy || !catalog?.users.length} onChange={event => { setUserId(event.target.value); setResult(null) }}><option value="">{t('请选择本地用户', 'Select a local user')}</option>{catalog?.users.map(item => <option key={item.id} value={item.id}>{item.displayName} · ID {item.id}{item.mostRecent ? t(' · 最近使用', ' · Most recent') : ''}</option>)}</select>{user && <span className="screenshot-meta">SteamID64: {user.steamId}</span>}</div>
      <div className="screenshot-game-select"><span className="screenshot-step">02</span><h3>{t('找到对应游戏', 'Find the right game')}</h3><p>{t('自动读取游戏库与本地记录。找不到的游戏可直接填写 AppID', 'Read your libraries and local history automatically. Use an App ID if the game is missing')}</p><label htmlFor="screenshot-game-search">{t('搜索游戏名称或 AppID', 'Search by game name or App ID')}</label><input id="screenshot-game-search" type="search" value={query} placeholder={t('例如：Counter-Strike 或 730', 'For example: Counter-Strike or 730')} disabled={busy} onChange={event => setQuery(event.target.value)} /><div className="screenshot-game-list" role="group" aria-label={t('可选择的游戏', 'Available games')}>{filteredGames.length ? filteredGames.map(item => <button key={item.appId} className={`screenshot-game-option${appId === item.appId ? ' selected' : ''}`} aria-pressed={appId === item.appId} disabled={busy} onClick={() => { setAppId(item.appId); setResult(null) }}><strong>{item.name}</strong><span>AppID {item.appId}{item.installed ? t(' · 已安装', ' · Installed') : item.nameSource === 'fallback' ? t(' · 名称待补全', ' · Name unavailable') : ''}</span></button>) : <p>{query ? t('没有匹配的游戏，可在下方填写 AppID', 'No matching game. Enter its App ID below') : t('尚未发现游戏，可填写 AppID 继续', 'No games discovered. Enter an App ID to continue')}</p>}</div><div className="screenshot-manual-game"><label htmlFor="screenshot-manual-app">{t('手动填写 AppID', 'Enter an App ID manually')}</label><div><input id="screenshot-manual-app" inputMode="numeric" placeholder="AppID" value={manualAppId} disabled={busy} onChange={event => setManualAppId(event.target.value)} /><button disabled={busy || !validScreenshotAppId(manualAppId.trim())} onClick={useManualGame}>{t('查名并使用', 'Look up & use')}</button></div><small>{t('名称查询不可用时仍可使用有效 AppID，不会把未识别的游戏当成其它游戏', 'A valid App ID still works if name lookup is unavailable; an unknown game is never substituted with another one')}</small></div></div></section>
      <ScreenshotImageQueue images={images} busy={busy} onAdd={chooseImages} onClear={() => updateQueue(async () => unwrap(await window.steamCommenter.clearScreenshotImages()))} onRemove={id => updateQueue(async () => unwrap(await window.steamCommenter.clearScreenshotImages([id])))} />
    </div><aside className="screenshot-card screenshot-output"><span className="screenshot-eyebrow">READY FOR STEAM</span><h3>{t('准备上传', 'Prepare for upload')}</h3>
      <p>{mode === 'current-account' ? t('模式一使用假游戏辅助进程和 Steam 截图接口，只导入当前 Steam 账号，不退出客户端。失败时保持本模式，不自动退出。最后的云端上传由你在 Steam 客户端确认', 'Mode 1 uses a fake-game helper and the Steam screenshot API for the current Steam account without exiting the client. Failure stays in this mode without automatic exit. You confirm the final cloud upload in Steam') : t('模式二先核实当前 Steam 账号，再备份并写入所选账号本地索引。非当前账号不退出 Steam，切到该账号后生效。最后的云端上传由你在 Steam 客户端确认', 'Mode 2 verifies the current Steam account, then backs up and writes the selected account\'s local index. A different account does not exit Steam; switch to that account later to see the images. You confirm the final cloud upload in Steam')}</p>
      <dl className="screenshot-summary"><div><dt>{t('目标用户', 'Target user')}</dt><dd>{user?.displayName ?? t('尚未选择', 'Not selected')}{user && <small>ID {user.id}</small>}</dd></div><div><dt>{t('目标游戏', 'Target game')}</dt><dd>{game?.name ?? (appId ? `App ${appId}` : t('尚未选择', 'Not selected'))}{appId && <small>AppID {appId}</small>}</dd></div><div><dt>{t('待处理图片', 'Pending images')}</dt><dd>{pendingImages.length}{images.length > pendingImages.length && <small>{t(`另有 ${images.length - pendingImages.length} 张待核对，已排除`, `${images.length - pendingImages.length} uncertain images excluded`)}</small>}</dd></div></dl>
      <label className="screenshot-quality" htmlFor="screenshot-quality"><span>{t('JPEG 质量', 'JPEG quality')}<small>{t('1–100 · 推荐 95', '1–100 · Recommended 95')}</small></span><input id="screenshot-quality" type="number" min="1" max="100" step="1" value={quality} aria-invalid={!qualityValid} disabled={busy} onChange={event => setQuality(event.target.value)} /></label>{!qualityValid && <small className="screenshot-field-error">{t('质量应为 1 到 100 的整数', 'Quality must be a whole number from 1 to 100')}</small>}
      <label className="screenshot-resize-choice"><input type="checkbox" checked={resize} disabled={busy} onChange={event => setResize(event.target.checked)} /><span>{t('大图自动缩小', 'Resize oversized images')}<small>{t('保留比例，适配 Steam 截图限制', 'Preserve the aspect ratio and fit Steam screenshot limits')}</small></span></label>{requiresResize && !resize && <small className="screenshot-field-error">{t('请开启自动缩小，或移除队列中的大图', 'Enable resizing or remove the oversized images')}</small>}
      <label className="screenshot-caption" htmlFor="screenshot-caption">{t('截图说明（可选）', 'Caption (optional)')}<textarea id="screenshot-caption" value={caption} maxLength={500} rows={2} disabled={busy} onChange={event => setCaption(event.target.value)} placeholder={t('为这一组画面留下一句话', 'A few words for these images')} /></label>
      {mode === 'local-account' && <ScreenshotRestartChoice checked={restartSteam} disabled={busy} onChange={setRestartSteam} />}
      <button className="primary screenshot-prepare" disabled={!ready} onClick={() => setConfirming(true)}>{busy ? t('正在处理…', 'Processing…') : t('准备 Steam 上传', 'Prepare Steam upload')}</button><small className="screenshot-write-note">{t('仅添加到本地截图库，不代表已上传。两种模式互不自动切换；非当前账号本地导入始终不退出或重启 Steam', 'Adds images to the local library only, not to the cloud. The two modes never switch automatically. Local import for a different account never exits or restarts Steam')}</small></aside></div>

    {result && <ScreenshotPreparationResult result={result} />}
    <footer className="screenshot-footer">{t('实现参考 SteaScree 的本地截图流程，重新构建用户、游戏识别和安全备份；不修改 Steam 程序', 'Inspired by the SteaScree local screenshot workflow, with rebuilt user/game discovery and safe backups. Steam program files are not modified')}</footer>

    {confirming && <ScreenshotImportConfirmation userName={user?.displayName ?? ''} userId={userId} gameName={game?.name ?? `App ${appId}`} appId={appId} imageCount={pendingImages.length} quality={quality} restartSteam={restartSteam} mode={mode} ready={ready} onCancel={() => setConfirming(false)} onConfirm={prepare} />}
  </div>
}

export default ScreenshotToolsPanel
