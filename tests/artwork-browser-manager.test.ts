import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtworkBrowser } from '../src/main/artwork-browser'
import type { ArtworkBrowserState } from '../src/shared/artwork-browser'

const mock = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[], cookieWrite: null as null | (() => Promise<void>),
  saveDialog: vi.fn<(...args: unknown[]) => string | undefined>(() => 'C:\\fixture-downloads\\main.png') }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class MockContents extends Emitter {
    id = mock.views.length + 100
    destroyed = false
    url = ''
    loading = false
    windowOpenHandler: (() => unknown) | null = null
    scriptResult: unknown = 'ok'
    loadURL = vi.fn(async (url: string) => {
      this.url = url
      this.emit('did-start-navigation', { isMainFrame: true })
      this.emit('did-finish-load')
    })
    reload = vi.fn(() => this.emit('did-finish-load'))
    downloadURL = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => this.scriptResult)
    setWindowOpenHandler(handler: () => unknown) { this.windowOpenHandler = handler }
    isDestroyed() { return this.destroyed }
    isLoadingMainFrame() { return this.loading }
    getURL() { return this.url }
    close = vi.fn(() => { this.destroyed = true })
  }
  class MockView {
    webContents = new MockContents()
    visible = false
    bounds: unknown = null
    constructor(readonly options: unknown) { mock.views.push(this) }
    setVisible(value: boolean) { this.visible = value }
    setBounds(value: unknown) { this.bounds = value }
  }
  function fromPartition(partition: string, options: unknown) {
    const ses = Object.assign(new Emitter(), {
      partition, options, values: [] as unknown[],
      cookies: Object.assign(new Emitter(), { set: vi.fn(async (cookie: any) => {
        await mock.cookieWrite?.()
        ses.values.push(cookie)
        ses.cookies.emit('changed', {}, { ...cookie, domain: 'steamcommunity.com' }, 'explicit', false)
      }) }),
      clearStorageData: vi.fn(async () => { ses.values = [] }), clearCache: vi.fn(async () => {}),
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn()
    })
    mock.sessions.push(ses)
    return ses
  }
  return { app: { getPath: () => 'C:\\fixture-downloads' }, dialog: { showSaveDialogSync: mock.saveDialog }, session: { fromPartition }, WebContentsView: MockView }
})

const account = '76561198000000001'
const anotherAccount = '76561198000000002'
const cookies = (id = account): string[] => [`steamLoginSecure=${id}%7C%7Cfixture; Domain=steamcommunity.com`, 'sessionid=abcd1234; Domain=steamcommunity.com']

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class Parent extends EventEmitter {
  destroyed = false
  children: unknown[] = []
  contentView = {
    addChildView: (view: unknown) => this.children.push(view),
    removeChildView: (view: unknown) => { this.children = this.children.filter(child => child !== view) }
  }
  isDestroyed() { return this.destroyed }
  getContentSize() { return [1000, 800] }
}

function fakeDownload(options: { name?: string; mime?: string; url?: string } = {}) {
  const url = options.url ?? 'blob:https://steam.design/fixture'
  return Object.assign(new EventEmitter(), { getFilename: () => options.name ?? 'main.png',
    getMimeType: () => options.mime ?? 'image/png', getURL: () => url, getURLChain: () => [url],
    getSavePath: () => '', setSavePath: vi.fn(), cancel: vi.fn() })
}

describe('embedded artwork browser lifecycle', () => {
  let parent: Parent
  let browser: ArtworkBrowser
  let active: string | null
  let changes: ArtworkBrowserState[]
  let getCookies: ReturnType<typeof vi.fn<(accountId: string) => Promise<string[]>>>

  beforeEach(() => {
    mock.views.length = 0
    mock.sessions.length = 0
    mock.cookieWrite = null
    mock.saveDialog.mockReset().mockReturnValue('C:\\fixture-downloads\\main.png')
    parent = new Parent()
    active = account
    changes = []
    getCookies = vi.fn(async id => cookies(id))
    browser = new ArtworkBrowser({ parent: parent as unknown as BrowserWindow, getSessionCookies: getCookies,
      isAccountCurrent: id => id === active, language: () => 'zh-CN', onStateChange: state => changes.push(state) })
  })

  afterEach(async () => { await browser.close(); browser.shutdown() })

  it('embeds a sandboxed page with no preload, imports only Steam session cookies, and applies fixed isolated-world code', async () => {
    browser.setBounds({ x: 40, y: 160, width: 850, height: 550 })
    expect(await browser.open('upload', account)).toMatchObject({ tool: 'upload', phase: 'ready', accountId: account, canApplyLongArtwork: true })
    const view = mock.views[0]
    const ses = mock.sessions[0]
    expect(view.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, webSecurity: true, session: ses })
    expect(view.options.webPreferences).not.toHaveProperty('preload')
    expect(ses.partition).not.toMatch(/^persist:/)
    expect(ses.values.map((cookie: any) => cookie.name)).toEqual(['steamLoginSecure', 'sessionid'])
    expect(view.visible).toBe(true)
    expect(parent.children).toEqual([view])
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://steamcommunity.com/sharedfiles/edititem/767/3/?l=schinese')
    await browser.applyLongArtwork()
    expect(view.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0][0]).toBe(1001)
    expect(view.webContents.windowOpenHandler()).toEqual({ action: 'deny' })
    expect(ses.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const callback = vi.fn()
    ses.setPermissionRequestHandler.mock.calls[0][0](null, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('retains the same page on repeated opens and shares only the same account Steam tools', async () => {
    await browser.open('upload', account)
    const view = mock.views[0]
    await browser.open('upload', account)
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    await browser.open('showcase', account)
    expect(mock.views).toHaveLength(1)
    expect(mock.sessions).toHaveLength(1)
    expect(getCookies).toHaveBeenCalledTimes(1)
    expect(browser.getState()).toMatchObject({ tool: 'showcase', canApplyLongArtwork: false })
    await expect(browser.applyLongArtwork()).rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_PAGE_REQUIRED' })
  })

  it('uses clean anonymous sessions for design and sources, including guide on the same Steam origin', async () => {
    await browser.open('upload', account)
    for (const tool of ['guide', 'design', 'sapic'] as const) {
      await browser.open(tool)
      expect(mock.sessions.at(-1).values).toEqual([])
      expect(browser.getState().accountId).toBeNull()
    }
    expect(mock.sessions).toHaveLength(4)
    expect(new Set(mock.sessions.map(ses => ses.partition)).size).toBe(4)
    expect(getCookies).toHaveBeenCalledTimes(1)
    expect(mock.views[0].webContents.destroyed).toBe(true)
    expect(mock.sessions[0].clearStorageData).toHaveBeenCalled()
  })

  it('never imports or navigates after a pending session lookup is closed or superseded', async () => {
    const lookup = deferred<string[]>()
    getCookies.mockImplementationOnce(() => lookup.promise)
    const opening = browser.open('upload', account)
    await browser.close()
    await browser.open('design')
    lookup.resolve(cookies())
    await opening
    expect(mock.sessions[0].cookies.set).not.toHaveBeenCalled()
    expect(mock.views[0].webContents.loadURL).not.toHaveBeenCalled()
    expect(browser.getState()).toMatchObject({ tool: 'design', phase: 'ready' })
    expect(mock.sessions[0].values).toEqual([])
  })

  it('waits for an in-flight cookie write before clearing, without writing the next cookie', async () => {
    const write = deferred<void>()
    mock.cookieWrite = () => write.promise
    const opening = browser.open('upload', account)
    await vi.waitFor(() => expect(mock.sessions[0].cookies.set).toHaveBeenCalledTimes(1))
    const closing = browser.close()
    expect(mock.views[0].webContents.destroyed).toBe(true)
    expect(mock.sessions[0].clearStorageData).not.toHaveBeenCalled()
    write.resolve()
    await Promise.all([opening, closing])
    expect(mock.sessions[0].cookies.set).toHaveBeenCalledTimes(1)
    expect(mock.sessions[0].values).toEqual([])
    expect(browser.getState().phase).toBe('closed')
  })

  it('uses a different view/session for another current account and rejects foreign cookies', async () => {
    await browser.open('upload', account)
    active = anotherAccount
    await browser.open('upload', anotherAccount)
    expect(mock.views[0].webContents.destroyed).toBe(true)
    expect(mock.sessions[0].values).toEqual([])
    expect(mock.sessions[1].values[0].value).toContain(anotherAccount)
    await browser.close()
    getCookies.mockResolvedValueOnce(cookies(account))
    await expect(browser.open('upload', anotherAccount)).rejects.toMatchObject({ code: 'ARTWORK_INVALID_SESSION' })
    expect(mock.sessions[2].cookies.set).not.toHaveBeenCalled()
    expect(mock.views[2].webContents.loadURL).not.toHaveBeenCalled()
  })

  it('rejects an old account during the root transition guard even while its session cleanup is pending', async () => {
    const write = deferred<void>()
    mock.cookieWrite = () => write.promise
    const opening = browser.open('upload', account)
    await vi.waitFor(() => expect(mock.sessions[0].cookies.set).toHaveBeenCalledOnce())
    active = null
    const closing = browser.close()
    await expect(browser.open('upload', account)).rejects.toMatchObject({ code: 'ARTWORK_NOT_AUTHENTICATED' })
    expect(mock.views).toHaveLength(1)
    expect(mock.views[0].webContents.destroyed).toBe(true)
    write.resolve()
    await Promise.all([opening, closing])
    expect(mock.sessions[0].values).toEqual([])
    expect(mock.views[0].webContents.loadURL).not.toHaveBeenCalled()
    active = anotherAccount
    mock.cookieWrite = null
    await browser.open('upload', anotherAccount)
    expect(mock.sessions[1].values[0].value).toContain(anotherAccount)
  })

  it('accepts a token refresh for the same account without closing or reloading its upload form', async () => {
    await browser.open('upload', account)
    const ses = mock.sessions[0]
    const contents = mock.views[0].webContents
    expect(ses.cookies.listenerCount('changed')).toBe(1)
    ses.cookies.emit('changed', {}, { name: 'steamLoginSecure', value: `${account}%7C%7Cfixture`, domain: 'steamcommunity.com' }, 'overwrite', true)
    ses.cookies.emit('changed', {}, { name: 'steamLoginSecure', value: `${account}%7C%7Crefreshed-fixture`, domain: '.steamcommunity.com' }, 'explicit', false)
    expect(browser.getState()).toMatchObject({ tool: 'upload', accountId: account, phase: 'ready', error: null })
    expect(contents.destroyed).toBe(false)
    expect(contents.loadURL).toHaveBeenCalledOnce()
  })

  it.each([
    { value: `${anotherAccount}%7C%7Cdifferent-fixture`, removed: false },
    { value: `${account}%7C%7Cfixture`, removed: true }
  ])('immediately closes an account-changed or logged-out browser without disclosing cookies: %o', async change => {
    await browser.open('upload', account)
    const ses = mock.sessions[0]
    ses.cookies.emit('changed', {}, { name: 'steamLoginSecure', value: change.value, domain: 'steamcommunity.com' }, 'explicit', change.removed)
    expect(browser.getState()).toMatchObject({ tool: null, accountId: null, phase: 'closed', error: 'ARTWORK_SESSION_CHANGED' })
    expect(mock.views[0].webContents.destroyed).toBe(true)
    expect(ses.cookies.listenerCount('changed')).toBe(0)
    expect(JSON.stringify(changes)).not.toContain(change.value)
    await vi.waitFor(() => expect(ses.values).toEqual([]))
  })

  it('ignores unrelated cookies/domains and anonymous-source sessions', async () => {
    await browser.open('upload', account)
    const ses = mock.sessions[0]
    ses.cookies.emit('changed', {}, { name: 'sessionid', value: 'changed', domain: 'steamcommunity.com' }, 'explicit', false)
    ses.cookies.emit('changed', {}, { name: 'steamLoginSecure', value: `${anotherAccount}%7C%7Cfixture`, domain: 'sub.steamcommunity.com' }, 'explicit', false)
    expect(browser.getState().phase).toBe('ready')
    await browser.open('guide')
    expect(mock.sessions[1].cookies.listenerCount('changed')).toBe(0)
  })

  it('does not let delayed account-change cleanup overwrite a subsequently opened tool', async () => {
    await browser.open('upload', account)
    const ses = mock.sessions[0]
    const cleanup = deferred<void>()
    ses.clearStorageData.mockImplementationOnce(async () => { await cleanup.promise; ses.values = [] })
    ses.cookies.emit('changed', {}, { name: 'steamLoginSecure', value: `${anotherAccount}%7C%7Cfixture`, domain: 'steamcommunity.com' }, 'explicit', false)
    expect(browser.getState()).toMatchObject({ phase: 'closed', error: 'ARTWORK_SESSION_CHANGED' })
    await browser.open('design')
    cleanup.resolve()
    await vi.waitFor(() => expect(ses.values).toEqual([]))
    expect(browser.getState()).toMatchObject({ tool: 'design', phase: 'ready', error: null })
  })

  it('blocks foreign navigation, redirects, popups and remote webviews without leaking query strings', async () => {
    await browser.open('upload', account)
    const contents = mock.views[0].webContents
    for (const type of ['will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      contents.emit(type, { url: 'https://evil.example/?token=private-fixture', isMainFrame: true, preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(browser.getState().error).toBe('ARTWORK_NAVIGATION_BLOCKED')
    }
    const preventDefault = vi.fn()
    contents.emit('will-attach-webview', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(JSON.stringify(changes)).not.toContain('private-fixture')
  })

  it('hides immediately on resize and null bounds until the UI supplies a new rectangle', async () => {
    browser.setBounds({ x: 0, y: 100, width: 1000, height: 700 })
    await browser.open('design')
    const view = mock.views[0]
    expect(view.visible).toBe(true)
    parent.emit('resize')
    expect(view.visible).toBe(false)
    await browser.open('design')
    expect(view.visible).toBe(false)
    browser.setBounds({ x: 400, y: 200, width: 1200, height: 1000 })
    expect(view.bounds).toEqual({ x: 400, y: 200, width: 600, height: 600 })
    expect(view.visible).toBe(true)
    browser.setBounds(null)
    expect(view.visible).toBe(false)
    expect(() => browser.setBounds({ x: NaN, y: 1, width: 1, height: 1 })).toThrow('ARTWORK_INVALID_BOUNDS')
  })

  it('checks page readiness and returns stable script errors rather than raw remote errors', async () => {
    await browser.open('upload', account)
    const contents = mock.views[0].webContents
    for (const code of ['ARTWORK_FILE_REQUIRED', 'ARTWORK_IMAGE_LOADING', 'ARTWORK_FORM_UNAVAILABLE']) {
      contents.scriptResult = code
      await expect(browser.applyLongArtwork()).rejects.toMatchObject({ code })
    }
    contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('token=private-fixture'))
    await expect(browser.applyLongArtwork()).rejects.toThrow(/^ARTWORK_APPLY_FAILED$/)
    contents.loading = true
    await expect(browser.applyLongArtwork()).rejects.toMatchObject({ code: 'ARTWORK_IMAGE_LOADING' })
  })

  it('allows image/video/zip downloads only through the native save confirmation and cancels them on close', async () => {
    await browser.open('design')
    const ses = mock.sessions[0]
    const contents = mock.views[0].webContents
    function download(name: string, mime: string) {
      return Object.assign(new EventEmitter(), { getFilename: () => name, getMimeType: () => mime,
        getURL: () => 'blob:https://steam.design/fixture', getURLChain: () => ['blob:https://steam.design/fixture'],
        getSavePath: () => '', setSavePath: vi.fn(), cancel: vi.fn() })
    }
    const unsafe = download('installer.exe', 'application/octet-stream')
    const prevented = vi.fn()
    ses.emit('will-download', { preventDefault: prevented }, unsafe, contents)
    expect(prevented).toHaveBeenCalledOnce()
    expect(mock.saveDialog).not.toHaveBeenCalled()
    const png = download('main.png', 'image/png')
    const blocked = vi.fn()
    ses.emit('will-download', { preventDefault: blocked }, png, contents)
    expect(blocked).not.toHaveBeenCalled()
    expect(mock.saveDialog).toHaveBeenCalledWith(parent, expect.objectContaining({
      title: '保存艺术作品文件', filters: [{ name: 'PNG', extensions: ['png'] }]
    }))
    expect(png.setSavePath).toHaveBeenCalledWith('C:\\fixture-downloads\\main.png')
    expect(contents.downloadURL).not.toHaveBeenCalled()
    await browser.close()
    expect(png.cancel).toHaveBeenCalledOnce()
  })

  it.each(['C:\\fixture-downloads\\renamed.exe', 'C:\\fixture-downloads\\main.png:payload.png', 'relative/main.png'])
    ('does not initiate a writable download when the chosen path is unsafe: %s', async path => {
      await browser.open('design')
      mock.saveDialog.mockReturnValueOnce(path)
      const item = fakeDownload()
      const preventDefault = vi.fn()
      mock.sessions[0].emit('will-download', { preventDefault }, item, mock.views[0].webContents)
      expect(preventDefault).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(browser.getState().error).toBe('ARTWORK_DOWNLOAD_PATH_INVALID'))
      expect(item.setSavePath).not.toHaveBeenCalled()
      expect(mock.views[0].webContents.downloadURL).not.toHaveBeenCalled()
    })

  it('ignores a modal save result if its view was closed while the native dialog was shown', async () => {
    await browser.open('design')
    mock.saveDialog.mockImplementationOnce(() => {
      void browser.close()
      return 'C:\\fixture-downloads\\main.png'
    })
    const contents = mock.views[0].webContents
    const item = fakeDownload()
    const preventDefault = vi.fn()
    mock.sessions[0].emit('will-download', { preventDefault }, item, contents)
    expect(mock.saveDialog).toHaveBeenCalledOnce()
    await browser.close()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(contents.downloadURL).not.toHaveBeenCalled()
  })

  it('cancels unsupported schemes and foreign blob origins without a save prompt/replay', async () => {
    await browser.open('design')
    const contents = mock.views[0].webContents
    const ses = mock.sessions[0]
    for (const url of ['data:image/png;base64,fixture', 'file:///tmp/main.png', 'blob:https://evil.example/fixture']) {
      const preventDefault = vi.fn()
      ses.emit('will-download', { preventDefault }, fakeDownload({ url }), contents)
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(mock.saveDialog).not.toHaveBeenCalled()
    expect(contents.downloadURL).not.toHaveBeenCalled()
    expect(browser.getState().error).toBe('ARTWORK_DOWNLOAD_UNSUPPORTED')
  })

  it('cancels when the user declines the save prompt, without writing or replaying the resource', async () => {
    await browser.open('design')
    const contents = mock.views[0].webContents
    const ses = mock.sessions[0]
    mock.saveDialog.mockReturnValueOnce(undefined)
    const item = fakeDownload()
    const failed = vi.fn()
    ses.emit('will-download', { preventDefault: failed }, item, contents)
    expect(failed).toHaveBeenCalledOnce()
    expect(mock.saveDialog).toHaveBeenCalledOnce()
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(contents.downloadURL).not.toHaveBeenCalled()
  })

  it('does not write a modal result if the native parent was destroyed before its closed event', async () => {
    await browser.open('design')
    const contents = mock.views[0].webContents
    const item = fakeDownload()
    const prevented = vi.fn()
    mock.saveDialog.mockImplementationOnce(() => {
      parent.destroyed = true
      return 'C:\\fixture-downloads\\main.png'
    })
    mock.sessions[0].emit('will-download', { preventDefault: prevented }, item, contents)
    expect(prevented).toHaveBeenCalledOnce()
    expect(item.setSavePath).not.toHaveBeenCalled()
    await expect(browser.applyLongArtwork()).rejects.toMatchObject({ code: 'ARTWORK_NOT_OPEN' })
    const previousChanges = changes.length
    contents.emit('did-finish-load')
    expect(changes).toHaveLength(previousChanges)
  })

  it('settles memory cleanup when native APIs throw synchronously, while never reusing the retired session', async () => {
    await browser.open('upload', account)
    const previous = mock.sessions[0]
    previous.clearStorageData.mockImplementationOnce(() => { throw new Error('Fixture native storage closed') })
    previous.clearCache.mockImplementationOnce(() => { throw new Error('Fixture native cache closed') })
    await expect(browser.close()).resolves.toBeUndefined()
    expect(mock.views[0].webContents.destroyed).toBe(true)
    await browser.open('upload', account)
    expect(mock.sessions[1].partition).not.toBe(previous.partition)
    expect(mock.sessions[1].values).toHaveLength(2)
  })

  it('removes and destroys remote views and clears memory cookies/cache on shutdown', async () => {
    await browser.open('upload', account)
    const previousChanges = changes.length
    browser.shutdown()
    await browser.close()
    expect(parent.children).toEqual([])
    expect(mock.views[0].webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(mock.sessions[0].values).toEqual([])
    expect(mock.sessions[0].clearCache).toHaveBeenCalled()
    mock.views[0].webContents.emit('did-finish-load')
    expect(changes).toHaveLength(previousChanges)
    await expect(browser.open('design')).rejects.toMatchObject({ code: 'ARTWORK_NOT_OPEN' })
  })
})
