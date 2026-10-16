import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'
import {
  SCREENSHOT_MAX_PIXELS, SCREENSHOT_MAX_SIDE,
  type ScreenshotCatalog, type ScreenshotGame, type ScreenshotImage,
  type ScreenshotPrepareInput, type ScreenshotPrepareResult, type ScreenshotUser, type ScreenshotWarning
} from '../shared/steam-screenshots'
import { appendScreenshotMetadata, parseScreenshotVdf, vdfChild, vdfPath, type VdfNode } from './steam-screenshot-vdf'
import { screenshotShortcutNames } from './steam-screenshot-shortcuts'

export interface ScreenshotImageAdapter {
  inspect(data: Buffer): Promise<{ width: number; height: number; previewJpeg: Buffer }>
  encode(data: Buffer, options: {
    quality: number; width: number; height: number; thumbnailWidth: number; thumbnailHeight: number
  }): Promise<{ jpeg: Buffer; thumbnail: Buffer }>
}

export interface SteamScreenshotOptions {
  imageAdapter: ScreenshotImageAdapter
  isSteamRunning(): Promise<boolean>
  findSteamPaths?(): Promise<string[]>
  now?(): Date
}

interface QueuedImage {
  view: ScreenshotImage
  source: string
  digest: string
  mtime: number
}

const execFileAsync = promisify(execFile)
const STEAM_ID_BASE = 76_561_197_960_265_728n
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_INPUT_PIXELS = 64_000_000
const MAX_QUEUE = 100
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const isId = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,9})$/.test(value) && BigInt(value) <= 4_294_967_295n
const isGameId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
function fail(code: string, message: string): never { throw new DomainError(`SCREENSHOT_${code}`, message) }
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const cleanName = (value?: string): string | undefined => value?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || undefined
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

export function screenshotDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, SCREENSHOT_MAX_SIDE / width, SCREENSHOT_MAX_SIDE / height, Math.sqrt(SCREENSHOT_MAX_PIXELS / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

export async function findDefaultSteamPaths(): Promise<string[]> {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    for (const [key, value] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']]) {
      try {
        const { stdout } = await execFileAsync('reg.exe', ['query', key!, '/v', value!], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 })
        const line = stdout.split(/\r?\n/).find(line => new RegExp(`^\\s*${value}\\s+REG_SZ\\s+`, 'i').test(line))
        const found = line?.replace(new RegExp(`^\\s*${value}\\s+REG_SZ\\s+`, 'i'), '').trim()
        if (found && path.isAbsolute(found)) candidates.push(found)
      } catch { /* Standard installation locations remain available. */ }
    }
    for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (root) candidates.push(path.join(root, 'Steam'))
  } else if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'))
  else candidates.push(path.join(os.homedir(), '.local', 'share', 'Steam'), path.join(os.homedir(), '.steam', 'steam'))
  return [...new Set(candidates.map(value => path.resolve(value)))].slice(0, 8)
}

async function regularFile(file: string, maxBytes = MAX_METADATA_BYTES): Promise<Buffer> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('UNSAFE_FILE', '文件类型或大小不受支持')
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) fail('FILE_CHANGED', '文件已被其他程序更改，请刷新后重试')
    const bytes = Buffer.alloc(current.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) fail('FILE_CHANGED', '文件已被其他程序更改，请刷新后重试')
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) fail('FILE_CHANGED', '文件已被其他程序更改，请刷新后重试')
    return bytes
  } finally { await handle.close() }
}

async function optionalFile(file: string, maxBytes = MAX_METADATA_BYTES): Promise<Buffer | null> {
  try { return await regularFile(file, maxBytes) } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
}

async function safeRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) fail('INVALID_PATH', '请选择有效的 Steam 安装目录')
  const absolute = path.resolve(root)
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Steam 目录不能是符号链接或重解析目录')
  if (path.resolve(await fs.realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) fail('UNSAFE_PATH', 'Steam 目录不能通过重解析路径访问')
  await safeDirectory(absolute, ['userdata'], false)
  return absolute
}

async function safeDirectory(root: string, segments: string[], create: boolean): Promise<string> {
  let current = root
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) fail('INVALID_PATH', '目录格式不正确')
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (error) {
      if (!create || errorCode(error) !== 'ENOENT') throw error
      try { await fs.mkdir(current) } catch (createdError) { if (errorCode(createdError) !== 'EEXIST') throw createdError }
      stat = await fs.lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', '目标包含符号链接或非目录文件，已停止操作')
    if (path.resolve(await fs.realpath(current)).toLowerCase() !== path.resolve(current).toLowerCase()) fail('UNSAFE_PATH', '目标包含重解析路径，已停止操作')
  }
  return current
}

async function readVdf(file: string): Promise<VdfNode[] | null> {
  const bytes = await optionalFile(file)
  return bytes === null ? null : parseScreenshotVdf(decodeVdf(bytes))
}

function decodeVdf(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_METADATA', 'Steam 截图索引编码无效，未修改原文件')
  return text
}

function namesFromLoginUsers(nodes: VdfNode[] | null): Map<string, Partial<ScreenshotUser>> {
  const result = new Map<string, Partial<ScreenshotUser>>()
  for (const node of vdfChild(nodes ?? undefined, 'users')?.children ?? []) {
    if (!/^7656119\d{10}$/.test(node.key) || !node.children) continue
    const account = BigInt(node.key) - STEAM_ID_BASE
    if (account < 0 || account > 4_294_967_295n) continue
    const displayName = cleanName(vdfChild(node.children, 'PersonaName')?.value)
    const accountName = cleanName(vdfChild(node.children, 'AccountName')?.value)
    result.set(String(account), {
      ...(displayName ? { displayName, nameSource: 'loginusers' as const } : {}),
      ...(accountName ? { accountName } : {}), mostRecent: vdfChild(node.children, 'MostRecent')?.value === '1'
    })
  }
  return result
}

function headerDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16)
    if (type === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
    if (type === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (type === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) return null
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]!
      if (marker === 0xd9 || marker === 0xda) return null
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) }
      }
      offset += length
    }
  }
  return null
}

function validateGeometry(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 32_000 || height > 32_000 || width * height > MAX_INPUT_PIXELS) fail('IMAGE_TOO_LARGE', '图片尺寸过大，请先缩小图片')
}

async function syncWrite(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

function cloneCatalog(catalog: ScreenshotCatalog): ScreenshotCatalog {
  return { ...catalog, warnings: [...catalog.warnings], users: catalog.users.map(user => ({ ...user })), games: catalog.games.map(game => ({ ...game, userIds: [...game.userIds] })) }
}

export class SteamScreenshotService {
  private catalog: ScreenshotCatalog = { steamPath: null, refreshedAt: '', steamRunning: false, users: [], games: [], warnings: [] }
  private readonly images = new Map<string, QueuedImage>()
  private readonly resolvedNames = new Map<string, string>()
  private busy = false
  private adding = false
  private refreshPromise?: Promise<ScreenshotCatalog>
  private disposed = false

  constructor(private readonly options: SteamScreenshotOptions) {}

  getCatalog(): ScreenshotCatalog { return cloneCatalog(this.catalog) }

  getImages(): ScreenshotImage[] { return [...this.images.values()].map(image => ({ ...image.view })) }

  refresh(steamPath?: string): Promise<ScreenshotCatalog> {
    if (this.disposed) return Promise.reject(new DomainError('SCREENSHOT_CLOSED', '截图工具已关闭'))
    if (this.busy || this.adding) return Promise.reject(new DomainError('SCREENSHOT_BUSY', '正在准备截图，请稍后刷新'))
    if (this.refreshPromise) return this.refreshPromise
    const pending = this.scan(steamPath).finally(() => { if (this.refreshPromise === pending) this.refreshPromise = undefined })
    this.refreshPromise = pending
    return pending
  }

  private async scan(requestedPath?: string): Promise<ScreenshotCatalog> {
    const warnings = new Set<ScreenshotWarning>()
    const steamRunning = await this.options.isSteamRunning()
    if (steamRunning) warnings.add('STEAM_RUNNING')
    let root: string | undefined
    const candidates = requestedPath ? [requestedPath] : this.catalog.steamPath ? [this.catalog.steamPath] : await (this.options.findSteamPaths ?? findDefaultSteamPaths)()
    for (const candidate of candidates) {
      try { root = await safeRoot(candidate); break } catch (error) { if (requestedPath) throw error }
    }
    if (!root) {
      this.catalog = { steamPath: null, refreshedAt: this.now().toISOString(), steamRunning, users: [], games: [], warnings: ['STEAM_NOT_FOUND', ...warnings] }
      return this.getCatalog()
    }
    const userdata = await safeDirectory(root, ['userdata'], false)
    let loginNames = new Map<string, Partial<ScreenshotUser>>()
    try {
      await safeDirectory(root, ['config'], false)
      loginNames = namesFromLoginUsers(await readVdf(path.join(root, 'config', 'loginusers.vdf')))
      if (!loginNames.size) warnings.add('LOGIN_NAMES_UNAVAILABLE')
    } catch { warnings.add('LOGIN_NAMES_UNAVAILABLE') }
    const users: ScreenshotUser[] = []
    const games = new Map<string, ScreenshotGame>()
    const addGame = (appId: string, name: string | undefined, nameSource: ScreenshotGame['nameSource'], installed = false, userId?: string) => {
      if (!isGameId(appId)) return
      const previous = games.get(appId)
      if (!previous) games.set(appId, { appId, name: name ?? `App ${appId}`, nameSource: name ? nameSource : 'fallback', installed, userIds: userId ? [userId] : [] })
      else {
        previous.installed ||= installed
        if (userId && !previous.userIds.includes(userId)) previous.userIds.push(userId)
        if (name && (previous.nameSource === 'fallback' || nameSource === 'manifest')) { previous.name = name; previous.nameSource = nameSource }
      }
    }
    const dirs = (await fs.readdir(userdata, { withFileTypes: true })).filter(dir => dir.isDirectory() && !dir.isSymbolicLink() && isId(dir.name) && dir.name !== '0').slice(0, 500)
    for (const dir of dirs) {
      try {
        await safeDirectory(root, ['userdata', dir.name], false)
        const metadata = loginNames.get(dir.name)
        const user: ScreenshotUser = { id: dir.name, steamId: String(STEAM_ID_BASE + BigInt(dir.name)), displayName: `User ${dir.name}`, mostRecent: false, nameSource: 'fallback', ...metadata }
        try {
          await safeDirectory(root, ['userdata', dir.name, 'config'], false)
          const local = await readVdf(path.join(userdata, dir.name, 'config', 'localconfig.vdf'))
          const store = vdfChild(local ?? undefined, 'UserLocalConfigStore')?.children
          const persona = cleanName(vdfPath(store ?? [], 'friends', 'PersonaName')?.value)
          if (persona) { user.displayName = persona; user.nameSource = 'localconfig' }
          for (const app of vdfPath(store ?? [], 'Software', 'Valve', 'Steam', 'apps')?.children ?? []) {
            if (!isId(app.key)) continue
            const name = cleanName(vdfChild(app.children, 'name')?.value)
            if (name) addGame(app.key, name, 'localconfig', false, dir.name)
          }
        } catch { warnings.add('USER_METADATA_UNAVAILABLE') }
        let shortcutNames = new Map<string, string>()
        try {
          await safeDirectory(root, ['userdata', dir.name, 'config'], false)
          const shortcutBytes = await optionalFile(path.join(userdata, dir.name, 'config', 'shortcuts.vdf'))
          if (shortcutBytes) shortcutNames = screenshotShortcutNames(shortcutBytes)
        } catch { warnings.add('USER_METADATA_UNAVAILABLE') }
        users.push(user)
        try {
          await safeDirectory(root, ['userdata', dir.name, '760'], false)
          const screenshots = await readVdf(path.join(userdata, dir.name, '760', 'screenshots.vdf'))
          const screenshotRoot = vdfChild(screenshots ?? undefined, 'screenshots')?.children
          for (const shortcut of vdfChild(screenshotRoot, 'shortcutnames')?.children ?? []) addGame(shortcut.key, cleanName(shortcut.value), 'screenshot', false, dir.name)
          for (const app of screenshotRoot ?? []) if (isGameId(app.key)) addGame(app.key, shortcutNames.get(app.key), 'localconfig', false, dir.name)
          const remote = await safeDirectory(root, ['userdata', dir.name, '760', 'remote'], false)
          for (const app of (await fs.readdir(remote, { withFileTypes: true })).slice(0, 20_000)) if (app.isDirectory() && !app.isSymbolicLink() && isGameId(app.name)) addGame(app.name, shortcutNames.get(app.name), 'localconfig', false, dir.name)
        } catch (error) { if (errorCode(error) !== 'ENOENT') warnings.add('SCREENSHOT_METADATA_UNAVAILABLE') }
      } catch { warnings.add('USER_METADATA_UNAVAILABLE') }
    }
    if (!users.length) warnings.add('USERS_NOT_FOUND')
    const libraryRoots = new Set<string>([root])
    try {
      await safeDirectory(root, ['steamapps'], false)
      const libraries = await readVdf(path.join(root, 'steamapps', 'libraryfolders.vdf'))
      for (const library of vdfChild(libraries ?? undefined, 'libraryfolders')?.children ?? []) {
        if (!/^\d+$/.test(library.key)) continue
        const directory = library.value ?? vdfChild(library.children, 'path')?.value
        if (directory && path.isAbsolute(directory)) libraryRoots.add(path.resolve(directory))
      }
    } catch { warnings.add('LIBRARY_METADATA_UNAVAILABLE') }
    for (const library of [...libraryRoots].slice(0, 32)) {
      try {
        const libraryStat = await fs.lstat(library)
        if (!libraryStat.isDirectory() || libraryStat.isSymbolicLink()) continue
        const steamapps = await safeDirectory(library, ['steamapps'], false)
        const manifests = (await fs.readdir(steamapps, { withFileTypes: true })).filter(file => file.isFile() && /^appmanifest_\d+\.acf$/i.test(file.name)).slice(0, 20_000)
        for (const manifest of manifests) {
          try {
            const nodes = await readVdf(path.join(steamapps, manifest.name))
            const state = vdfChild(nodes ?? undefined, 'AppState')?.children
            const appId = vdfChild(state, 'appid')?.value
            if (appId && manifest.name.toLowerCase() === `appmanifest_${appId}.acf`) addGame(appId, cleanName(vdfChild(state, 'name')?.value), 'manifest', true)
          } catch { warnings.add('LIBRARY_METADATA_UNAVAILABLE') }
        }
      } catch { warnings.add('LIBRARY_METADATA_UNAVAILABLE') }
    }
    for (const [appId, name] of this.resolvedNames) if (games.get(appId)?.nameSource === 'fallback') { games.get(appId)!.name = name; games.get(appId)!.nameSource = 'store' }
    this.catalog = { steamPath: root, refreshedAt: this.now().toISOString(), steamRunning, users: users.sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent) || a.displayName.localeCompare(b.displayName)), games: [...games.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings: [...warnings] }
    return this.getCatalog()
  }

  setResolvedGame(appId: string, name: string): ScreenshotGame {
    if (!isId(appId) || appId === '0' || !cleanName(name)) fail('INVALID_GAME', '游戏编号或名称不正确')
    this.resolvedNames.set(appId, cleanName(name)!)
    let game = this.catalog.games.find(game => game.appId === appId)
    if (!game) { game = { appId, name: cleanName(name)!, nameSource: 'store', installed: false, userIds: [] }; this.catalog.games.push(game) }
    else if (game.nameSource === 'fallback' || game.nameSource === 'store') { game.name = cleanName(name)!; game.nameSource = 'store' }
    return { ...game, userIds: [...game.userIds] }
  }

  setResolvedUser(steamId: string, name: string, source: 'account' | 'profile' = 'profile'): void {
    const user = this.catalog.users.find(user => user.steamId === steamId)
    if (user?.nameSource === 'fallback' && cleanName(name)) { user.displayName = cleanName(name)!; user.nameSource = source }
  }

  async addImages(paths: string[]): Promise<ScreenshotImage[]> {
    if (this.busy || this.adding || this.disposed) fail('BUSY', '正在准备截图，请稍后添加图片')
    if (!Array.isArray(paths) || !paths.length || paths.length + this.images.size > MAX_QUEUE) fail('QUEUE_LIMIT', '截图队列最多可添加 100 张图片')
    this.adding = true
    try {
      const added: QueuedImage[] = []
      for (const source of [...new Set(paths)]) {
        if (typeof source !== 'string' || !path.isAbsolute(source) || !/\.(png|jpe?g|webp|bmp)$/i.test(source)) fail('UNSUPPORTED_IMAGE', '请选择 PNG、JPEG、WebP 或 BMP 图片')
        if ([...this.images.values(), ...added].some(image => image.source.toLowerCase() === source.toLowerCase())) continue
        const bytes = await regularFile(source, MAX_IMAGE_BYTES)
        const geometry = headerDimensions(bytes)
        if (!geometry) fail('INVALID_IMAGE', '无法识别图片格式或图片已损坏')
        validateGeometry(geometry.width, geometry.height)
        const inspected = await this.options.imageAdapter.inspect(bytes)
        validateGeometry(inspected.width, inspected.height)
        if (inspected.width !== geometry.width || inspected.height !== geometry.height) fail('INVALID_IMAGE', '图片尺寸校验失败，请重新保存图片')
        if (!inspected.previewJpeg.length || inspected.previewJpeg.length > 256 * 1024) fail('INVALID_IMAGE', '图片预览生成失败')
        const stat = await fs.lstat(source)
        const id = randomUUID()
        const target = screenshotDimensions(inspected.width, inspected.height)
        const view: ScreenshotImage = { id, name: path.basename(source), width: inspected.width, height: inspected.height, size: bytes.length, previewUrl: `data:image/jpeg;base64,${inspected.previewJpeg.toString('base64')}`, resizeRequired: target.width !== inspected.width || target.height !== inspected.height }
        added.push({ view, source, digest: digest(bytes), mtime: stat.mtimeMs })
      }
      if (this.disposed || this.busy) fail('BUSY', '截图队列已更改，请重试')
      for (const image of added) this.images.set(image.view.id, image)
      return added.map(image => ({ ...image.view }))
    } finally { this.adding = false }
  }

  clearImages(ids?: string[]): void {
    if (this.busy || this.adding) fail('BUSY', '正在准备截图，请稍后修改队列')
    if (ids) for (const id of ids) this.images.delete(id)
    else this.images.clear()
  }

  private now(): Date { return this.options.now?.() ?? new Date() }

  async prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult> {
    if (this.busy || this.adding || this.refreshPromise || this.disposed) fail('BUSY', '截图工具正忙，请稍后重试')
    if (!input || !isId(input.userId) || input.userId === '0' || !isGameId(input.appId) || typeof input.steamPath !== 'string') fail('INVALID_INPUT', '请选择有效的 Steam 用户和游戏')
    if (!Number.isInteger(input.jpegQuality) || input.jpegQuality < 1 || input.jpegQuality > 100 || typeof input.resizeLargeImages !== 'boolean') fail('INVALID_INPUT', '图片质量或缩放选项不正确')
    if (!Array.isArray(input.imageIds) || !input.imageIds.length || input.imageIds.length > MAX_QUEUE || new Set(input.imageIds).size !== input.imageIds.length || input.imageIds.some(id => typeof id !== 'string' || !this.images.has(id))) fail('INVALID_QUEUE', '截图队列已失效，请重新选择图片')
    const caption = input.caption ?? ''
    if (typeof caption !== 'string' || caption.length > 500 || /[\u0000-\u001f\u007f]/.test(caption)) fail('INVALID_CAPTION', '截图说明不能包含控制字符且最多 500 字')
    if (input.steamPath !== this.catalog.steamPath || !this.catalog.users.some(user => user.id === input.userId)) fail('CATALOG_CHANGED', 'Steam 用户或目录已变化，请刷新后重试')
    const queued = input.imageIds.map(id => this.images.get(id)!)
    if (!input.resizeLargeImages && queued.some(image => image.view.resizeRequired)) fail('RESIZE_REQUIRED', '图片超过 Steam 截图尺寸限制，请启用自动缩放')
    this.busy = true
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined
    let lockPath: string | undefined
    let stage: string | undefined
    const published: { file: string; hash: string }[] = []
    let committed = false
    try {
      if (await this.options.isSteamRunning()) fail('STEAM_RUNNING', '请先完全退出 Steam 客户端，再准备截图，避免截图索引被覆盖')
      const root = await safeRoot(input.steamPath)
      await safeDirectory(root, ['userdata', input.userId], false)
      const base = await safeDirectory(root, ['userdata', input.userId, '760'], true)
      lockPath = path.join(base, '.xiaolan-screenshot-import.lock')
      lock = await this.acquireLock(lockPath)
      const token = randomUUID()
      stage = await safeDirectory(base, [`.xiaolan-screenshot-stage-${token}`], true)
      const vdfPath = path.join(base, 'screenshots.vdf')
      const previous = await optionalFile(vdfPath)
      const originalText = previous === null ? null : decodeVdf(previous)
      // Validate before touching existing screenshot directories.
      appendScreenshotMetadata(originalText, input.appId, [])
      const dest = await safeDirectory(root, ['userdata', input.userId, '760', 'remote', input.appId, 'screenshots'], true)
      const thumbnails = await safeDirectory(root, ['userdata', input.userId, '760', 'remote', input.appId, 'screenshots', 'thumbnails'], true)
      const metadata: Parameters<typeof appendScreenshotMetadata>[2] = []
      const staged: { source: string; dest: string; hash: string }[] = []
      const files: string[] = []
      for (let index = 0; index < queued.length; index++) {
        const image = queued[index]!
        const bytes = await regularFile(image.source, MAX_IMAGE_BYTES)
        if (digest(bytes) !== image.digest) fail('FILE_CHANGED', '选中的图片已被更改，请重新添加图片')
        const size = screenshotDimensions(image.view.width, image.view.height)
        const thumbnailWidth = Math.min(200, size.width)
        const thumbnailHeight = Math.max(1, Math.round(size.height * thumbnailWidth / size.width))
        const converted = await this.options.imageAdapter.encode(bytes, { quality: input.jpegQuality, ...size, thumbnailWidth, thumbnailHeight })
        if (!converted.jpeg.length || !converted.thumbnail.length || converted.jpeg.length > MAX_IMAGE_BYTES || converted.thumbnail.length > 4 * 1024 * 1024) fail('ENCODE_FAILED', '截图转换失败或输出图片过大')
        const jpgSize = headerDimensions(converted.jpeg)
        const thumbSize = headerDimensions(converted.thumbnail)
        if (!jpgSize || jpgSize.width !== size.width || jpgSize.height !== size.height || !thumbSize || thumbSize.width !== thumbnailWidth || thumbSize.height !== thumbnailHeight || converted.jpeg[0] !== 0xff || converted.jpeg[1] !== 0xd8 || converted.thumbnail[0] !== 0xff || converted.thumbnail[1] !== 0xd8) fail('ENCODE_FAILED', '截图转换结果格式或尺寸不正确')
        const date = new Date(image.mtime)
        const timestamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const filename = `${timestamp}_${token.replaceAll('-', '').slice(0, 12)}_${index + 1}.jpg`
        const full = path.join(dest, filename)
        const thumb = path.join(thumbnails, filename)
        const jpgStage = path.join(stage, `${index}.jpg`)
        const thumbStage = path.join(stage, `${index}.thumb.jpg`)
        await syncWrite(jpgStage, converted.jpeg)
        await syncWrite(thumbStage, converted.thumbnail)
        staged.push({ source: jpgStage, dest: full, hash: digest(converted.jpeg) }, { source: thumbStage, dest: thumb, hash: digest(converted.thumbnail) })
        files.push(full)
        metadata.push({ filename: `${input.appId}/screenshots/${filename}`, thumbnail: `${input.appId}/screenshots/thumbnails/${filename}`, ...size, creation: Math.max(0, Math.floor(image.mtime / 1000)), caption })
      }
      const nextText = appendScreenshotMetadata(originalText, input.appId, metadata)
      const newVdf = path.join(stage, 'screenshots.vdf')
      await syncWrite(newVdf, nextText)
      const backupRoot = await safeDirectory(base, ['.xiaolan-screenshot-backups'], true)
      const backupPath = await safeDirectory(backupRoot, [`${this.now().toISOString().replace(/[:.]/g, '-')}-${token}`], true)
      if (previous) await syncWrite(path.join(backupPath, 'screenshots.vdf'), previous)
      await syncWrite(path.join(backupPath, 'manifest.json'), JSON.stringify({ version: 1, createdAt: this.now().toISOString(), userId: input.userId, appId: input.appId, originalExisted: previous !== null, originalSha256: previous ? digest(previous) : null, nextSha256: digest(Buffer.from(nextText)), files: metadata.map(entry => ({ filename: entry.filename, thumbnail: entry.thumbnail })) }, null, 2))
      if (await this.options.isSteamRunning()) fail('STEAM_RUNNING', 'Steam 已启动，已停止准备截图；请退出 Steam 后重试')
      if (this.disposed) fail('CLOSED', '截图工具已关闭')
      await safeDirectory(root, ['userdata', input.userId, '760', 'remote', input.appId, 'screenshots', 'thumbnails'], false)
      const sameMetadata = async () => {
        const current = await optionalFile(vdfPath)
        if (current === null ? previous !== null : previous === null || digest(current) !== digest(previous)) fail('METADATA_CHANGED', 'Steam 截图索引已被其他程序修改，请刷新后重试')
      }
      await sameMetadata()
      for (const file of staged) {
        await fs.copyFile(file.source, file.dest, constants.COPYFILE_EXCL)
        published.push({ file: file.dest, hash: file.hash })
        const handle = await fs.open(file.dest, 'r+')
        try { await handle.sync() } finally { await handle.close() }
      }
      if (await this.options.isSteamRunning()) fail('STEAM_RUNNING', 'Steam 已启动，已停止准备截图；请退出 Steam 后重试')
      if (this.disposed) fail('CLOSED', '截图工具已关闭')
      await safeDirectory(root, ['userdata', input.userId, '760', 'remote', input.appId, 'screenshots', 'thumbnails'], false)
      await sameMetadata()
      await fs.rename(newVdf, vdfPath)
      committed = true
      for (const id of input.imageIds) this.images.delete(id)
      return { imported: metadata.length, files, backupPath, vdfPath }
    } catch (error) {
      if (!committed) {
        for (const publishedFile of published.reverse()) {
          try {
            const root = await safeRoot(input.steamPath)
            await safeDirectory(root, ['userdata', input.userId, '760', 'remote', input.appId, 'screenshots', 'thumbnails'], false)
            if (digest(await regularFile(publishedFile.file, MAX_IMAGE_BYTES)) === publishedFile.hash) await fs.unlink(publishedFile.file)
          } catch { /* Never delete through a changed path or remove a file that no longer matches our output. */ }
        }
      }
      throw error
    } finally {
      if (stage) {
        try {
          const stat = await fs.lstat(stage)
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            for (const file of await fs.readdir(stage, { withFileTypes: true })) if (file.isFile() && /^(\d+(\.thumb)?\.jpg|screenshots\.vdf)$/.test(file.name)) await fs.unlink(path.join(stage, file.name))
            await fs.rmdir(stage)
          }
        } catch { /* A crash or external change may leave a harmless staging directory. */ }
      }
      if (lock) {
        try {
          const held = await lock.stat()
          const current = lockPath ? await fs.lstat(lockPath) : null
          if (lockPath && current?.isFile() && !current.isSymbolicLink() && held.dev === current.dev && held.ino === current.ino) await fs.unlink(lockPath)
        } catch { /* An externally replaced lock belongs to its new owner. */ }
        await lock.close().catch(() => {})
      }
      this.busy = false
    }
  }

  private async acquireLock(file: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
    let handle
    try { handle = await fs.open(file, 'wx', 0o600) } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      let dead = false
      try {
        const lock = JSON.parse((await regularFile(file, 1024)).toString('utf8')) as { pid?: unknown }
        if (Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) {
          try { process.kill(Number(lock.pid), 0) } catch (error) { dead = errorCode(error) === 'ESRCH' }
        }
      } catch { /* Unknown locks are not removed. */ }
      if (!dead) fail('LOCKED', '另一个截图准备任务仍在运行，请关闭其他工具后重试')
      await fs.unlink(file)
      handle = await fs.open(file, 'wx', 0o600)
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: this.now().toISOString() })); await handle.sync(); return handle }
    catch (error) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error }
  }

  dispose(): void { this.disposed = true; if (!this.busy) this.images.clear() }
}
