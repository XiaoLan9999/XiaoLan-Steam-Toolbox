import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { app, dialog, session, WebContentsView, type BrowserWindow, type Cookie, type DownloadItem, type Session, type WebContents } from 'electron'
import { DomainError } from '../shared/domain'
import {
  APPLY_LONG_ARTWORK_SCRIPT,
  ARTWORK_TOOL_URLS,
  artworkCookieAccountMatches,
  artworkDownloadExtension,
  clampArtworkBounds,
  initialArtworkBrowserState,
  isAllowedArtworkNavigation,
  isArtworkTool,
  isArtworkUploadUrl,
  isSafeArtworkSavePath,
  isSteamArtworkTool,
  parseArtworkSessionCookies,
  type ArtworkBounds,
  type ArtworkBrowserState,
  type ArtworkTool
} from '../shared/artwork-browser'

interface ArtworkBrowserOptions {
  parent: BrowserWindow
  getSessionCookies: (accountId: string) => Promise<string[]>
  isAccountCurrent: (accountId: string) => boolean
  language: () => 'zh-CN' | 'en'
  onStateChange: (state: ArtworkBrowserState) => void
}

interface BrowserRecord {
  view: WebContentsView
  contents: WebContents
  session: Session
  tool: ArtworkTool
  accountId: string | null
  prepared: boolean
  preparing: Promise<void> | null
  pendingCookieWrite: Promise<void> | null
  downloads: Set<DownloadItem>
  releaseCookieListener: (() => void) | null
  disposing: Promise<void> | null
}

export class ArtworkBrowser {
  private state = initialArtworkBrowserState()
  private record: BrowserRecord | null = null
  private bounds: ArtworkBounds | null = null
  private generation = 0
  private stopped = false
  private readonly cleanup = new Set<Promise<void>>()
  private readonly onResize = (): void => { this.bounds = null; this.record?.view.setVisible(false) }
  private readonly onParentClosed = (): void => this.shutdown()

  constructor(private readonly options: ArtworkBrowserOptions) {
    options.parent.on('resize', this.onResize)
    options.parent.on('closed', this.onParentClosed)
  }

  getState(): ArtworkBrowserState {
    return { ...this.state }
  }

  async open(tool: ArtworkTool, accountId?: string): Promise<ArtworkBrowserState> {
    if (!isArtworkTool(tool)) throw artworkError('ARTWORK_INVALID_TOOL')
    if (this.stopped || this.options.parent.isDestroyed()) throw artworkError('ARTWORK_NOT_OPEN')
    const steamTool = isSteamArtworkTool(tool)
    if (steamTool && (!accountId || !this.options.isAccountCurrent(accountId))) {
      throw artworkError('ARTWORK_NOT_AUTHENTICATED')
    }
    const owner = steamTool ? accountId! : null
    const generation = ++this.generation
    const previous = this.record
    const reusable = !!previous && previous.prepared && !previous.contents.isDestroyed() &&
      ((steamTool && isSteamArtworkTool(previous.tool) && previous.accountId === owner) ||
       (!steamTool && previous.tool === tool))
    if (reusable && previous.tool === tool) {
      this.assertCurrentAccount(previous)
      this.applyBounds(previous)
      return this.getState()
    }
    this.setState({ tool, phase: 'loading', accountId: owner, canApplyLongArtwork: false, error: null })
    let record: BrowserRecord
    if (reusable) {
      record = previous
      record.tool = tool
    } else {
      this.record = null
      if (previous) await this.dispose(previous)
      if (generation !== this.generation || this.stopped) return this.getState()
      if (owner && !this.options.isAccountCurrent(owner)) {
        this.setState({ tool, phase: 'error', accountId: owner, canApplyLongArtwork: false, error: 'ARTWORK_SESSION_CHANGED' })
        throw artworkError('ARTWORK_SESSION_CHANGED')
      }
      record = this.createRecord(tool, owner)
      this.record = record
    }
    try {
      if (!record.prepared) {
        record.preparing = this.prepare(record, generation)
        await record.preparing
      }
      if (!this.isCurrent(record, generation)) return this.getState()
      this.applyBounds(record)
      const url = new URL(ARTWORK_TOOL_URLS[tool])
      if (isSteamArtworkTool(tool)) url.searchParams.set('l', this.options.language() === 'en' ? 'english' : 'schinese')
      await record.contents.loadURL(url.toString())
      if (!this.isCurrent(record, generation)) return this.getState()
      this.markReady(record)
      return this.getState()
    } catch (error) {
      if (!this.isCurrent(record, generation)) return this.getState()
      const code = error instanceof DomainError ? error.code : 'ARTWORK_LOAD_FAILED'
      this.setState({ ...this.state, phase: 'error', canApplyLongArtwork: false, error: code })
      throw artworkError(code)
    }
  }

  setBounds(bounds: ArtworkBounds | null): void {
    if (this.stopped || this.options.parent.isDestroyed()) return
    const [width = 0, height = 0] = this.options.parent.getContentSize()
    try { this.bounds = clampArtworkBounds(bounds, width, height) }
    catch { throw artworkError('ARTWORK_INVALID_BOUNDS') }
    if (this.record) this.applyBounds(this.record)
  }

  async applyLongArtwork(): Promise<void> {
    const record = this.requireCurrent()
    if (record.tool !== 'upload' || !isArtworkUploadUrl(record.contents.getURL())) {
      throw artworkError('ARTWORK_UPLOAD_PAGE_REQUIRED')
    }
    if (record.contents.isLoadingMainFrame()) throw artworkError('ARTWORK_IMAGE_LOADING')
    const generation = this.generation
    let result: unknown
    try {
      result = await record.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: APPLY_LONG_ARTWORK_SCRIPT }])
    } catch { throw artworkError('ARTWORK_APPLY_FAILED') }
    if (!this.isCurrent(record, generation)) throw artworkError('ARTWORK_SESSION_CHANGED')
    if (result === 'ok') return
    if (typeof result === 'string' && [
      'ARTWORK_UPLOAD_PAGE_REQUIRED', 'ARTWORK_FORM_UNAVAILABLE', 'ARTWORK_FILE_REQUIRED', 'ARTWORK_IMAGE_LOADING'
    ].includes(result)) throw artworkError(result)
    throw artworkError('ARTWORK_APPLY_FAILED')
  }

  reload(): void {
    const record = this.requireCurrent()
    if (!isAllowedArtworkNavigation(record.tool, record.contents.getURL())) {
      throw artworkError('ARTWORK_NAVIGATION_BLOCKED')
    }
    this.setState({ ...this.state, phase: 'loading', canApplyLongArtwork: false, error: null })
    record.contents.reload()
  }

  async close(): Promise<void> {
    this.generation += 1
    this.bounds = null
    const record = this.record
    this.record = null
    this.setState(initialArtworkBrowserState())
    if (record) await this.dispose(record)
    await Promise.allSettled([...this.cleanup])
  }

  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    this.options.parent.removeListener('resize', this.onResize)
    this.options.parent.removeListener('closed', this.onParentClosed)
    void this.close()
  }

  private createRecord(tool: ArtworkTool, accountId: string | null): BrowserRecord {
    const isolatedSession = session.fromPartition(`artwork-${accountId ?? tool}-${randomUUID()}`, { cache: false })
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setDevicePermissionHandler(() => false)
    const view = new WebContentsView({ webPreferences: {
      session: isolatedSession, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false
    } })
    view.setVisible(false)
    const contents = view.webContents
    const record: BrowserRecord = { view, contents, session: isolatedSession, tool, accountId, prepared: false,
      preparing: null, pendingCookieWrite: null, disposing: null, downloads: new Set(), releaseCookieListener: null }
    if (accountId) {
      const onCookieChanged = (_event: unknown, cookie: Cookie, cause: string, removed: boolean): void => {
        if (!this.isCurrent(record) || cookie.name !== 'steamLoginSecure' ||
            (cookie.domain ?? '').replace(/^\./, '').toLowerCase() !== 'steamcommunity.com') return
        // Chromium removes the old cookie before adding its replacement on refresh.
        if (removed && cause === 'overwrite') return
        if (!removed && artworkCookieAccountMatches(cookie.value, accountId)) return
        // Reset synchronously; a delayed cleanup must not overwrite a newly opened tool.
        void this.close()
        this.setState({ ...initialArtworkBrowserState(), error: 'ARTWORK_SESSION_CHANGED' })
      }
      isolatedSession.cookies.on('changed', onCookieChanged)
      record.releaseCookieListener = () => isolatedSession.cookies.removeListener('changed', onCookieChanged)
    }
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => this.guardNavigation(record, event, event.url, event.isMainFrame))
    contents.on('will-redirect', event => this.guardNavigation(record, event, event.url, event.isMainFrame))
    contents.on('did-start-navigation', event => {
      if (event.isMainFrame && this.isCurrent(record)) {
        this.setState({ ...this.state, phase: 'loading', canApplyLongArtwork: false, error: null })
      }
    })
    contents.on('did-finish-load', () => { if (this.isCurrent(record)) this.markReady(record) })
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame && this.isCurrent(record)) this.markReady(record)
    })
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 && this.isCurrent(record)) {
        this.setState({ ...this.state, phase: 'error', canApplyLongArtwork: false, error: 'ARTWORK_LOAD_FAILED' })
      }
    })
    contents.on('render-process-gone', () => {
      if (this.isCurrent(record)) this.setState({ ...this.state, phase: 'error', canApplyLongArtwork: false, error: 'ARTWORK_RENDERER_FAILED' })
    })
    isolatedSession.on('will-download', (event, item, source) => {
      const url = item.getURL()
      const extension = artworkDownloadExtension(item.getFilename(), item.getMimeType())
      const mimeType = item.getMimeType()
      const blobOrigin = url.startsWith('blob:') ? url.slice(5).split('/').slice(0, 3).join('/') : null
      const supportedUrl = (blobOrigin !== null && isAllowedArtworkNavigation(record.tool, `${blobOrigin}/`)) || url.startsWith('https:')
      if (!this.isCurrent(record) || source.id !== contents.id || !extension || !supportedUrl) {
        event.preventDefault()
        if (this.isCurrent(record)) this.setState({ ...this.state, error: 'ARTWORK_DOWNLOAD_UNSUPPORTED' })
        return
      }
      const cleanName = basename(item.getFilename()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      const fileName = `${cleanName.slice(0, -(extension.length + 1)).slice(0, 160)}.${extension}`
      const generation = this.generation
      try {
        // Keep the original download alive, including revoked blobs and one-use URLs.
        // Set the checked destination inside this callback, before Chromium may write.
        const filePath = dialog.showSaveDialogSync(this.options.parent, {
          title: this.options.language() === 'en' ? 'Save artwork file' : '保存艺术作品文件',
          defaultPath: join(app.getPath('downloads'), fileName),
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
        })
        if (!filePath || !this.isCurrent(record, generation)) { event.preventDefault(); return }
        if (!isSafeArtworkSavePath(filePath, mimeType)) {
          event.preventDefault()
          this.setState({ ...this.state, error: 'ARTWORK_DOWNLOAD_PATH_INVALID' })
          return
        }
        item.setSavePath(filePath)
        record.downloads.add(item)
        item.once('done', () => record.downloads.delete(item))
      } catch {
        event.preventDefault()
        if (this.isCurrent(record, generation)) this.setState({ ...this.state, error: 'ARTWORK_DOWNLOAD_FAILED' })
      }
    })
    this.options.parent.contentView.addChildView(view)
    return record
  }

  private async prepare(record: BrowserRecord, generation: number): Promise<void> {
    if (record.accountId) {
      const lines = await this.options.getSessionCookies(record.accountId)
      if (!this.isCurrent(record, generation)) return
      let cookies
      try { cookies = parseArtworkSessionCookies(lines, record.accountId) }
      catch { throw artworkError('ARTWORK_INVALID_SESSION') }
      for (const cookie of cookies) {
        if (!this.isCurrent(record, generation)) return
        record.pendingCookieWrite = record.session.cookies.set(cookie)
        await record.pendingCookieWrite
        record.pendingCookieWrite = null
      }
    }
    if (this.isCurrent(record, generation)) record.prepared = true
  }

  private guardNavigation(record: BrowserRecord, event: { preventDefault(): void }, url: string, isMainFrame: boolean): void {
    if (!this.isCurrent(record) || !isAllowedArtworkNavigation(record.tool, url, isMainFrame)) {
      event.preventDefault()
      if (isMainFrame && this.record === record && !this.stopped) {
        this.setState({ ...this.state, phase: 'error', canApplyLongArtwork: false, error: 'ARTWORK_NAVIGATION_BLOCKED' })
      }
    }
  }

  private markReady(record: BrowserRecord): void {
    const url = record.contents.getURL()
    if (!isAllowedArtworkNavigation(record.tool, url)) {
      record.view.setVisible(false)
      this.setState({ ...this.state, phase: 'error', canApplyLongArtwork: false, error: 'ARTWORK_NAVIGATION_BLOCKED' })
      return
    }
    this.setState({ tool: record.tool, phase: 'ready', accountId: record.accountId,
      canApplyLongArtwork: record.tool === 'upload' && isArtworkUploadUrl(url), error: null })
  }

  private requireCurrent(): BrowserRecord {
    const record = this.record
    if (!record || this.stopped || this.options.parent.isDestroyed() || record.contents.isDestroyed()) throw artworkError('ARTWORK_NOT_OPEN')
    this.assertCurrentAccount(record)
    return record
  }

  private assertCurrentAccount(record: BrowserRecord): void {
    if (record.accountId && !this.options.isAccountCurrent(record.accountId)) {
      void this.close()
      throw artworkError('ARTWORK_SESSION_CHANGED')
    }
  }

  private isCurrent(record: BrowserRecord, generation?: number): boolean {
    return !this.stopped && !this.options.parent.isDestroyed() && this.record === record && !record.contents.isDestroyed() &&
      (generation === undefined || generation === this.generation) &&
      (!record.accountId || this.options.isAccountCurrent(record.accountId))
  }

  private applyBounds(record: BrowserRecord): void {
    if (!this.isCurrent(record) || !this.bounds || !record.prepared) {
      record.view.setVisible(false)
      return
    }
    record.view.setBounds(this.bounds)
    record.view.setVisible(true)
  }

  private dispose(record: BrowserRecord): Promise<void> {
    if (record.disposing) return record.disposing
    record.releaseCookieListener?.()
    record.releaseCookieListener = null
    record.view.setVisible(false)
    for (const item of record.downloads) item.cancel()
    record.downloads.clear()
    if (!this.options.parent.isDestroyed()) this.options.parent.contentView.removeChildView(record.view)
    if (!record.contents.isDestroyed()) record.contents.close({ waitForBeforeUnload: false })
    // Wait for an in-flight cookie write before clearing the abandoned memory session.
    const cleanup = Promise.resolve(record.pendingCookieWrite).catch(() => {}).then(async () => {
      await Promise.allSettled([
        Promise.resolve().then(() => record.session.clearStorageData()),
        Promise.resolve().then(() => record.session.clearCache())
      ])
      record.session.removeAllListeners('will-download')
    })
    record.disposing = cleanup
    this.cleanup.add(cleanup)
    void cleanup.then(() => this.cleanup.delete(cleanup), () => this.cleanup.delete(cleanup))
    return cleanup
  }

  private setState(state: ArtworkBrowserState): void {
    this.state = state
    if (!this.stopped) this.options.onStateChange(this.getState())
  }
}

function artworkError(code: string): DomainError {
  return new DomainError(code, code)
}
