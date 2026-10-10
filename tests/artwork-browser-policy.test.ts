import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  APPLY_LONG_ARTWORK_SCRIPT, ARTWORK_TOOL_URLS, artworkDownloadExtension, clampArtworkBounds,
  initialArtworkBrowserState, isAllowedArtworkNavigation, isArtworkTool, isArtworkUploadUrl, isSafeArtworkSavePath,
  parseArtworkSessionCookies, type ArtworkTool
} from '../src/shared/artwork-browser'

const account = '76561198000000001'
const login = `${account}%7C%7Cfixture-token`

describe('artwork embedded browser policy', () => {
  it('starts closed and only accepts the five fixed tools', () => {
    expect(initialArtworkBrowserState()).toEqual({ tool: null, phase: 'closed', accountId: null, canApplyLongArtwork: false, error: null })
    for (const tool of Object.keys(ARTWORK_TOOL_URLS)) expect(isArtworkTool(tool)).toBe(true)
    for (const tool of ['constructor', '__proto__', 'toString', 'https://example.com', null, 3]) expect(isArtworkTool(tool)).toBe(false)
  })

  it.each([
    ['upload', 'https://steamcommunity.com/login/home/?goto=%2Fsharedfiles', true],
    ['showcase', 'https://steamcommunity.com/profiles/76561198000000001/edit/showcases', true],
    ['guide', 'https://steamcommunity.com/sharedfiles/filedetails/?id=748624905', true],
    ['design', 'https://steam.design/', true],
    ['design', 'https://www.steam.design/', true],
    ['sapic', ARTWORK_TOOL_URLS.sapic, true],
    ['sapic', 'https://github.com/sapic/sapic/issues', true],
    ['upload', 'https://steamcommunity.com.evil.example/', false],
    ['upload', 'http://steamcommunity.com/', false],
    ['upload', 'https://steamcommunity.com:8443/', false],
    ['upload', 'https://secret@steamcommunity.com/', false],
    ['upload', 'file:///C:/Windows/notepad.exe', false],
    ['upload', 'javascript:alert(1)', false],
    ['upload', 'https://steam.design/', false],
    ['design', 'https://steamcommunity.com/', false],
    ['sapic', 'https://github.com/sapic/sapic-evil', false],
    ['sapic', 'https://github.com/login', false]
  ] as [ArtworkTool, string, boolean][])('isolates navigation for %s: %s', (tool, url, allowed) => {
    expect(isAllowedArtworkNavigation(tool, url)).toBe(allowed)
  })

  it('allows a blank subframe but not a blank top-level page', () => {
    expect(isAllowedArtworkNavigation('upload', 'about:blank', false)).toBe(true)
    expect(isAllowedArtworkNavigation('upload', 'about:blank')).toBe(false)
    expect(isArtworkUploadUrl('https://steamcommunity.com/sharedfiles/edititem/767/3/?l=english')).toBe(true)
    expect(isArtworkUploadUrl('https://steamcommunity.com/sharedfiles/edititems/767/3/')).toBe(false)
  })

  it('clips fractional CSS bounds inward to the parent content rectangle', () => {
    expect(clampArtworkBounds({ x: 100.3, y: 40.2, width: 950, height: 880 }, 1000, 800))
      .toEqual({ x: 101, y: 41, width: 899, height: 759 })
    expect(clampArtworkBounds({ x: -30, y: -20, width: 100, height: 80 }, 1000, 800))
      .toEqual({ x: 0, y: 0, width: 70, height: 60 })
    expect(clampArtworkBounds({ x: 3000, y: 20, width: 100, height: 80 }, 1000, 800)).toBeNull()
    expect(clampArtworkBounds(null, 1000, 800)).toBeNull()
  })

  it.each([undefined, {}, { x: 0, y: 0, width: -1, height: 1 }, { x: 0, y: NaN, width: 1, height: 1 },
    { x: 0, y: 0, width: 1e12, height: 1 }, { x: '1', y: 0, width: 1, height: 1 }])('rejects invalid bounds: %o', input => {
    expect(() => clampArtworkBounds(input, 1000, 800)).toThrow('ARTWORK_INVALID_BOUNDS')
  })

  it('imports only two account-bound host-only session cookies, never refresh/store cookies', () => {
    const cookies = parseArtworkSessionCookies([
      `steamLoginSecure=${login}; Path=/; Domain=.steamcommunity.com; Secure; HttpOnly`,
      'sessionid=aabb1234; Domain=steamcommunity.com',
      'steamRefresh_steam=private-fixture; Domain=login.steampowered.com',
      `steamLoginSecure=other; Domain=store.steampowered.com`,
      'sessionid=other; Domain=evil.steamcommunity.com'
    ], account)
    expect(cookies.map(cookie => cookie.name)).toEqual(['steamLoginSecure', 'sessionid'])
    expect(cookies[0]).toEqual({ url: 'https://steamcommunity.com/', name: 'steamLoginSecure', value: login,
      path: '/', secure: true, httpOnly: true, sameSite: 'lax' })
    expect(cookies[0]).not.toHaveProperty('domain')
    expect(cookies[0]).not.toHaveProperty('expirationDate')
    expect(cookies[1]?.httpOnly).toBe(false)
    expect(parseArtworkSessionCookies([`steamLoginSecure=${login}`, 'sessionid=aabb1234'], account)).toHaveLength(2)
  })

  it.each(([
    [], [`steamLoginSecure=${login}`], ['steamLoginSecure=76561198000000002%7C%7Cfixture', 'sessionid=abcd'],
    [`steamLoginSecure=${login}; Domain=evil.example`, 'sessionid=abcd'],
    [`steamLoginSecure=${login}; Domain=steamcommunity.com; Domain=evil.example`, 'sessionid=abcd'],
    [`steamLoginSecure=${login}`, 'sessionid=abcd', 'sessionid=conflict'],
    [`steamLoginSecure=${login}`, 'sessionid=abcd\r\nCookie: bad'],
    ['steamLoginSecure=%broken', 'sessionid=abcd'],
    [`steamLoginSecure=${account}%7C%7C`, 'sessionid=abcd'],
    [`steamLoginSecure=${login}`, 'sessionid=with%20space']
  ] as string[][]).map(lines => [lines] as [string[]]))('rejects missing, conflicting or foreign-account cookies without disclosing values', lines => {
    expect(() => parseArtworkSessionCookies(lines, account)).toThrow(/^ARTWORK_INVALID_SESSION$/)
  })

  it.each([
    ['main.png', 'image/png', 'png'], ['side.JPG', 'image/jpeg', 'jpg'], ['animation.gif', 'image/gif', 'gif'],
    ['clip.webm', 'video/webm', 'webm'], ['bundle.zip', 'application/zip', 'zip'],
    ['installer.exe', 'image/png', null], ['installer.exe', 'application/octet-stream', null],
    ['page.html', 'text/html', null], ['shortcut.url', 'image/png', null], ['vector.svg', 'image/svg+xml', null],
    ['wrong.zip', 'image/png', null], ['image.png.exe', 'image/png', null]
  ])('only permits supported content and matching filenames: %s', (name, mime, extension) => {
    expect(artworkDownloadExtension(name!, mime!)).toBe(extension)
  })

  it.each([
    ['C:\\Downloads\\main.png', true], ['D:/Pictures/side.PNG', true], ['/tmp/main.png', true],
    ['C:\\Downloads\\tool.exe', false], ['C:\\Downloads\\main.png:payload.exe', false],
    ['C:\\Downloads\\main:payload.png', false], ['C:\\Downloads\\NUL.png', false],
    ['C:\\Downloads\\main.png.', false], ['C:\\Downloads\\main.png ', false],
    ['C:\\Downloads\\..\\main.png', false], ['C:\\Downloads\\main\n.png', false],
    ['relative/main.png', false], ['C:main.png', false], ['\\\\server\\share\\main.png', false],
    ['\\\\?\\C:\\Downloads\\main.png', false], ['C:\\Downloads\\LPT1\\main.png', false]
  ] as const)('validates the final save path before approving any write: %s', (path, valid) => {
    expect(isSafeArtworkSavePath(path, 'image/png')).toBe(valid)
  })
})

describe('embedded long artwork action', () => {
  function fixture(options: { file?: boolean; previewLoaded?: boolean; fields?: boolean; path?: string } = {}) {
    const mutations: string[] = []
    class Input {
      files = { length: options.file === false ? 0 : 1 }
      constructor(readonly name: string) {}
      set value(value: string) { mutations.push(`${this.name}=${value}`) }
      removeAttribute(name: string) { mutations.push(`${this.name}.remove=${name}`) }
    }
    class Image { complete = options.previewLoaded !== false; naturalWidth = options.previewLoaded === false ? 0 : 506 }
    const width = new Input('width')
    const height = new Input('height')
    const file = new Input('file')
    const context = {
      HTMLInputElement: Input, HTMLImageElement: Image,
      location: { origin: 'https://steamcommunity.com', pathname: options.path ?? '/sharedfiles/edititem/767/3/' },
      document: {
        querySelector: (selector: string) => options.fields === false ? null :
          selector.includes('image_width') ? width : selector.includes('image_height') ? height : file,
        getElementById: () => new Image()
      }
    }
    return { context, mutations }
  }

  it('sets dimensions only, without form submission or ownership checkbox changes', () => {
    const { context, mutations } = fixture()
    expect(runInNewContext(APPLY_LONG_ARTWORK_SCRIPT, context)).toBe('ok')
    expect(mutations).toEqual(['width=1000', 'height=1', 'width.remove=id', 'height.remove=id'])
    expect(APPLY_LONG_ARTWORK_SCRIPT).not.toMatch(/submit\(|agree_terms|\.checked/)
  })

  it.each([
    [{ file: false }, 'ARTWORK_FILE_REQUIRED'], [{ previewLoaded: false }, 'ARTWORK_IMAGE_LOADING'],
    [{ fields: false }, 'ARTWORK_FORM_UNAVAILABLE'], [{ path: '/my/edit/showcases' }, 'ARTWORK_UPLOAD_PAGE_REQUIRED']
  ] as const)('does not mutate an unready or wrong form: %o', (options, result) => {
    const { context, mutations } = fixture(options)
    expect(runInNewContext(APPLY_LONG_ARTWORK_SCRIPT, context)).toBe(result)
    expect(mutations).toEqual([])
  })
})
