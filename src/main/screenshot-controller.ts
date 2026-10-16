import { randomUUID } from 'node:crypto'
import { lstat, readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ScreenshotCatalog, ScreenshotGame } from '../shared/steam-screenshots'
import { DomainError } from '../shared/domain'
import { SteamScreenshotService } from './steam-screenshots'
import { ScreenshotNameService } from './steam-screenshot-names'

export class ScreenshotController {
  private path: string | undefined
  private loading: Promise<ScreenshotCatalog> | null = null
  private nameController: AbortController | null = null
  private readonly lookups = new Set<AbortController>()
  private refreshGeneration = 0
  private refreshing = false
  private pending = 0
  private notificationTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly service: SteamScreenshotService, private readonly names: ScreenshotNameService,
    private readonly options: { preferencesPath: string; accounts(): Array<{ steamId: string; displayName: string }>; changed(): void }) {}

  getCatalog(): ScreenshotCatalog {
    return { ...this.names.enrich(this.service.getCatalog(), this.options.accounts()), refreshing: this.refreshing,
      nameLookupPending: this.pending }
  }

  refresh(steamPath?: string): Promise<ScreenshotCatalog> {
    if (this.disposed) return Promise.reject(new DomainError('SCREENSHOT_CANCELLED', '截图工具已关闭'))
    if (this.loading) return steamPath ? this.loading.catch(() => undefined).then(() => this.refresh(steamPath)) : this.loading
    const work = this.performRefresh(steamPath).catch(error => {
      if (!this.disposed) { this.refreshing = false; this.pending = 0; this.notify() }
      throw error
    }).finally(() => { if (this.loading === work) this.loading = null })
    this.loading = work
    return work
  }

  private async performRefresh(steamPath?: string): Promise<ScreenshotCatalog> {
    this.nameController?.abort()
    for (const lookup of this.lookups) lookup.abort()
    this.refreshing = true
    this.notify()
    const generation = ++this.refreshGeneration
    if (!steamPath && !this.path) {
      try {
        const metadata = await lstat(this.options.preferencesPath)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('Invalid screenshot preferences')
        const text = await readFile(this.options.preferencesPath, 'utf8')
        if (text.length <= 16_384) {
          const preferences = JSON.parse(text) as { steamPath?: unknown }
          if (typeof preferences?.steamPath === 'string' && preferences.steamPath.length < 4_096) this.path = preferences.steamPath
        }
      } catch { /* Missing preferences use automatic Steam discovery. */ }
    }
    const catalog = await this.service.refresh(steamPath ?? this.path)
    if (this.disposed || generation !== this.refreshGeneration) throw new DomainError('SCREENSHOT_CANCELLED', '截图目录刷新已取消')
    if (catalog.steamPath) this.path = catalog.steamPath
    if (steamPath && catalog.steamPath) await this.savePreferences(catalog.steamPath)
    if (this.disposed || generation !== this.refreshGeneration) throw new DomainError('SCREENSHOT_CANCELLED', '截图目录刷新已取消')
    const controller = new AbortController()
    this.nameController = controller
    this.refreshing = true
    this.pending = catalog.users.length + catalog.games.filter(game => game.nameSource === 'fallback').length
    this.notify()
    void this.names.refresh(catalog, controller.signal, pending => {
      if (this.disposed || controller.signal.aborted || generation !== this.refreshGeneration) return
      this.pending = pending
      this.notify()
    }).catch(() => {
      // Local metadata and cached names remain usable when public endpoints are unavailable.
    }).finally(() => {
      if (this.disposed || controller.signal.aborted || generation !== this.refreshGeneration) return
      this.refreshing = false
      this.pending = 0
      this.notify()
    })
    return this.getCatalog()
  }

  async resolveGame(appId: string): Promise<ScreenshotGame> {
    if (this.disposed || typeof appId !== 'string' || !/^[1-9]\d{0,19}$/.test(appId) || BigInt(appId) > 18_446_744_073_709_551_615n) {
      throw new DomainError('SCREENSHOT_INVALID_GAME', '请输入有效的 Steam AppID')
    }
    if (BigInt(appId) > 4_294_967_295n) {
      const game = this.getCatalog().games.find(game => game.appId === appId)
      if (game) return game
      throw new DomainError('SCREENSHOT_UNKNOWN_SHORTCUT', '该非 Steam 游戏尚未出现在本地截图或快捷方式中，请先从 Steam 添加游戏')
    }
    const generation = this.refreshGeneration
    const controller = new AbortController()
    this.lookups.add(controller)
    const abort = (): void => controller.abort()
    this.nameController?.signal.addEventListener('abort', abort, { once: true })
    const parent = this.nameController
    try {
      const game = await this.names.resolveGame(appId, controller.signal)
      if (this.disposed || generation !== this.refreshGeneration || controller.signal.aborted) {
        throw new DomainError('SCREENSHOT_CANCELLED', '截图名称查询已取消')
      }
      if (game.nameSource === 'store') this.service.setResolvedGame(game.appId, game.name)
      this.notify()
      return this.getCatalog().games.find(item => item.appId === appId) ?? game
    } finally { this.lookups.delete(controller); parent?.signal.removeEventListener('abort', abort) }
  }

  dispose(): void {
    this.disposed = true
    this.refreshGeneration += 1
    this.nameController?.abort()
    for (const lookup of this.lookups) lookup.abort()
    if (this.notificationTimer) clearTimeout(this.notificationTimer)
    this.service.dispose()
  }

  private notify(): void {
    if (this.disposed || this.notificationTimer) return
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = null
      if (!this.disposed) this.options.changed()
    }, 150)
    this.notificationTimer.unref?.()
  }

  private async savePreferences(steamPath: string): Promise<void> {
    const temporary = `${this.options.preferencesPath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.options.preferencesPath), { recursive: true })
      await writeFile(temporary, JSON.stringify({ steamPath }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.options.preferencesPath)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
}
