import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SteamScreenshotService, screenshotDimensions, type ScreenshotImageAdapter } from '../src/main/steam-screenshots'
import { appendScreenshotMetadata, parseScreenshotVdf, vdfChild, vdfPath } from '../src/main/steam-screenshot-vdf'
import { screenshotShortcutNames } from '../src/main/steam-screenshot-shortcuts'
import type { ScreenshotPrepareInput } from '../src/shared/steam-screenshots'

const roots: string[] = []
const SID = '76561198000000123'
const USER = String(BigInt(SID) - 76_561_197_960_265_728n)
const APP = '570'
const ORIGINAL = '// preserved comment\r\n"screenshots"\r\n{\r\n\t"570"\r\n\t{\r\n\t\t"3"\r\n\t\t{\r\n\t\t\t"filename" "570/screenshots/existing.jpg"\r\n\t\t\t"futureMetadata" "preserve-me"\r\n\t\t}\r\n\t}\r\n\t"shortcutnames" { "1234" "A shortcut" }\r\n}\r\n'
const png = (width = 640, height = 480): Buffer => {
  const data = Buffer.alloc(32)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.write('IHDR', 12)
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}
const jpeg = (width = 640, height = 480): Buffer => {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0, 0xff, 0xd9])
  data.writeUInt16BE(height, 7)
  data.writeUInt16BE(width, 9)
  return data
}
const adapter = (): ScreenshotImageAdapter => ({
  inspect: vi.fn(async data => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20), previewJpeg: jpeg(160, 120) })),
  encode: vi.fn(async (_data, options) => ({ jpeg: jpeg(options.width, options.height), thumbnail: jpeg(options.thumbnailWidth, options.thumbnailHeight) }))
})
async function fixture(options: { original?: string | null; imageWidth?: number; imageHeight?: number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'steam-screenshots-fixture-')))
  roots.push(root)
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.mkdir(path.join(root, 'steamapps'), { recursive: true })
  await fs.mkdir(path.join(root, 'userdata', USER, '760', 'remote', APP, 'screenshots', 'thumbnails'), { recursive: true })
  await fs.mkdir(path.join(root, 'userdata', USER, 'config'), { recursive: true })
  await fs.writeFile(path.join(root, 'config', 'loginusers.vdf'), `"users" { "${SID}" { "PersonaName" "Readable user" "AccountName" "local-user" "MostRecent" "1" "RememberPassword" "1" "UnrelatedSecret" "do-not-export" } }`)
  await fs.writeFile(path.join(root, 'steamapps', 'appmanifest_570.acf'), '"AppState" { "appid" "570" "name" "Dota 2" "installdir" "dota 2 beta" }')
  await fs.writeFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders" { }')
  const vdf = path.join(root, 'userdata', USER, '760', 'screenshots.vdf')
  if (options.original !== null) await fs.writeFile(vdf, options.original ?? ORIGINAL)
  const source = path.join(root, 'source.png')
  await fs.writeFile(source, png(options.imageWidth, options.imageHeight))
  const imageAdapter = adapter()
  const running = vi.fn(async () => false)
  const service = new SteamScreenshotService({ imageAdapter, isSteamRunning: running, findSteamPaths: async () => [root], now: () => new Date('2026-10-16T00:00:00Z') })
  await service.refresh()
  const images = await service.addImages([source])
  const input: ScreenshotPrepareInput = { steamPath: root, userId: USER, appId: APP, imageIds: images.map(image => image.id), jpegQuality: 95, resizeLargeImages: true }
  return { root, vdf, source, imageAdapter, running, service, images, input }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('bounded Steam text KeyValues and screenshot metadata', () => {
  it('handles comments, UTF-8 names, escaped paths and names without evaluating directives', () => {
    const tree = parseScreenshotVdf('\ufeff// comment\n"a" { "x" "C:\\\\Steam\\\\库" "q" "say \\"hi\\"" }')
    expect(vdfPath(tree, 'a', 'x')?.value).toBe('C:\\Steam\\库')
    expect(vdfPath(tree, 'A', 'q')?.value).toBe('say "hi"')
  })

  it('accepts quoted bracket-prefixed scalar data used by real Steam localconfig files', () => {
    const tree = parseScreenshotVdf('"UserLocalConfigStore" { "friends" { "PersonaName" "[TAG] Player" } "controller" "[1,2,3]" "#literal" "[$NOT_A_CONDITION]" }')
    expect(vdfPath(tree, 'UserLocalConfigStore', 'friends', 'PersonaName')?.value).toBe('[TAG] Player')
    expect(vdfPath(tree, 'UserLocalConfigStore', 'controller')?.value).toBe('[1,2,3]')
    expect(vdfPath(tree, 'UserLocalConfigStore', '#literal')?.value).toBe('[$NOT_A_CONDITION]')
  })

  it.each(['"a" {', '"a" "unterminated', '"a" {} garbage', '"a" {} }', '"a" "b" [$WIN32]', '"a" { #include "secret" }'])('rejects malformed or conditional input: %s', source => {
    expect(() => parseScreenshotVdf(source)).toThrow()
  })

  it('rejects depth and size exhaustion and ambiguous keys', () => {
    expect(() => parseScreenshotVdf('"a" {'.repeat(34) + '}'.repeat(34))).toThrow('VDF_TOO_DEEP')
    expect(() => parseScreenshotVdf('x'.repeat(16 * 1024 * 1024 + 1))).toThrow('VDF_TOO_LARGE')
    expect(() => vdfChild(parseScreenshotVdf('"x" "1" "X" "2"'), 'x')).toThrow('VDF_DUPLICATE_KEY')
  })

  it('preserves existing bytes/comments/unknown fields and uses a noncolliding index', () => {
    const entry = { filename: '570/screenshots/new.jpg', thumbnail: '570/screenshots/thumbnails/new.jpg', width: 640, height: 480, creation: 1234, caption: 'say "hello" \\ world' }
    const next = appendScreenshotMetadata(ORIGINAL, APP, [entry])
    expect(next).toContain(ORIGINAL.slice(0, ORIGINAL.indexOf('\t}\r\n\t"shortcutnames"')))
    expect(next).toContain('"futureMetadata" "preserve-me"')
    expect(next).toContain('"shortcutnames" { "1234" "A shortcut" }')
    const game = vdfPath(parseScreenshotVdf(next), 'screenshots', APP)
    expect(game?.children?.map(node => node.key)).toEqual(['3', '4'])
    expect(vdfPath(game?.children ?? [], '4', 'caption')?.value).toBe(entry.caption)
    expect(next.replaceAll('\r\n', '').includes('\n')).toBe(false)
  })

  it('supports new and 64-bit shortcut games and missing VDF', () => {
    const next = appendScreenshotMetadata(null, '12345678901234567890', [{ filename: '12345678901234567890/screenshots/new.jpg', thumbnail: '12345678901234567890/screenshots/thumbnails/new.jpg', width: 10, height: 10, creation: 0, caption: '' }])
    expect(vdfPath(parseScreenshotVdf(next), 'screenshots', '12345678901234567890', '0', 'gameid')?.value).toBe('12345678901234567890')
  })

  it('does not replace unknown or malformed screenshot roots and entries', () => {
    expect(() => appendScreenshotMetadata('"other" {}', APP, [])).toThrow()
    expect(() => appendScreenshotMetadata('"screenshots" { "570" "not an object" }', APP, [])).toThrow()
    expect(() => appendScreenshotMetadata('"screenshots" { "570" { "0" "bad" } }', APP, [])).toThrow()
    expect(() => appendScreenshotMetadata('"screenshots" { "570" { "0" {} "0" {} } }', APP, [])).toThrow('VDF_DUPLICATE_KEY')
  })
})

describe('Steam screenshot discovery and image queue', () => {
  it('resolves names locally, exposes only whitelisted account metadata, and clones snapshots', async () => {
    const { service, root } = await fixture()
    const catalog = service.getCatalog()
    expect(catalog.steamPath).toBe(root)
    expect(catalog.users).toEqual([{ id: USER, steamId: SID, displayName: 'Readable user', accountName: 'local-user', mostRecent: true, nameSource: 'loginusers' }])
    expect(catalog.games.find(game => game.appId === APP)).toEqual({ appId: APP, name: 'Dota 2', nameSource: 'manifest', installed: true, userIds: [USER] })
    expect(JSON.stringify(catalog)).not.toContain('do-not-export')
    catalog.users[0]!.displayName = 'mutated'
    expect(service.getCatalog().users[0]?.displayName).toBe('Readable user')
  })

  it('refreshes changed local names and manifest names', async () => {
    const { service, root } = await fixture()
    await fs.writeFile(path.join(root, 'userdata', USER, 'config', 'localconfig.vdf'), '"UserLocalConfigStore" { "friends" { "PersonaName" "New nickname" } }')
    await fs.writeFile(path.join(root, 'steamapps', 'appmanifest_570.acf'), '"AppState" { "appid" "570" "name" "Updated game name" }')
    const next = await service.refresh()
    expect(next.users[0]?.displayName).toBe('New nickname')
    expect(next.users[0]?.nameSource).toBe('localconfig')
    expect(next.games.find(game => game.appId === APP)?.name).toBe('Updated game name')
  })

  it('discovers users without a screenshots.vdf and names from additional library manifests', async () => {
    const { service, root } = await fixture({ original: null })
    await fs.mkdir(path.join(root, 'userdata', '456'), { recursive: true })
    const library = path.join(root, 'library')
    await fs.mkdir(path.join(library, 'steamapps'), { recursive: true })
    await fs.writeFile(path.join(library, 'steamapps', 'appmanifest_730.acf'), '"AppState" { "appid" "730" "name" "Counter-Strike 2" }')
    await fs.writeFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${library.replaceAll('\\', '\\\\')}" } }`)
    const next = await service.refresh()
    expect(next.users.find(user => user.id === '456')?.nameSource).toBe('fallback')
    expect(next.games.find(game => game.appId === '730')?.name).toBe('Counter-Strike 2')
  })

  it('keeps 64-bit non-Steam screenshot game IDs selectable', async () => {
    const { service, root } = await fixture()
    await fs.mkdir(path.join(root, 'userdata', USER, '760', 'remote', '12345678901234567890'))
    expect((await service.refresh()).games.some(game => game.appId === '12345678901234567890')).toBe(true)
  })

  it('reports no Steam and running Steam without modifying local files', async () => {
    const service = new SteamScreenshotService({ imageAdapter: adapter(), isSteamRunning: async () => true, findSteamPaths: async () => [] })
    expect((await service.refresh()).warnings).toEqual(['STEAM_NOT_FOUND', 'STEAM_RUNNING'])
  })

  it('retains no source path in public image metadata and handles duplicates and clearing', async () => {
    const { service, source, images } = await fixture()
    expect(JSON.stringify(images)).not.toContain(source)
    expect(images[0]?.previewUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(await service.addImages([source])).toEqual([])
    service.clearImages([images[0]!.id])
    expect(service.getImages()).toEqual([])
  })

  it('rejects image bombs before decoding and ignores misleading extension claims', async () => {
    const { service, source, imageAdapter } = await fixture()
    service.clearImages()
    vi.mocked(imageAdapter.inspect).mockClear()
    await fs.writeFile(source, png(32_000, 32_000))
    await expect(service.addImages([source])).rejects.toMatchObject({ code: 'SCREENSHOT_IMAGE_TOO_LARGE' })
    expect(imageAdapter.inspect).not.toHaveBeenCalled()
    await fs.writeFile(source, 'not an image')
    await expect(service.addImages([source])).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_IMAGE' })
  })

  it('bounds queues and converts oversized dimensions without exceeding either Steam limit', async () => {
    const { service } = await fixture()
    await expect(service.addImages(Array.from({ length: 101 }, (_, i) => `D:\\${i}.png`))).rejects.toMatchObject({ code: 'SCREENSHOT_QUEUE_LIMIT' })
    for (const [width, height] of [[16001, 1000], [8000, 8000], [16000, 16000], [100, 200]]) {
      const size = screenshotDimensions(width!, height!)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(16000)
      expect(size.width * size.height).toBeLessThanOrEqual(26210175)
    }
  })
})

describe('transactional local Steam screenshot preparation', () => {
  it('creates JPEG and thumbnail, preserves the exact backup and existing entries, and consumes only imported queue items', async () => {
    const { service, input, vdf, imageAdapter } = await fixture()
    const result = await service.prepare(input)
    expect(result.imported).toBe(1)
    expect(result.files).toHaveLength(1)
    expect(await fs.readFile(path.join(result.backupPath, 'screenshots.vdf'), 'utf8')).toBe(ORIGINAL)
    const tree = parseScreenshotVdf(await fs.readFile(vdf, 'utf8'))
    const item = vdfPath(tree, 'screenshots', APP, '4')!
    expect(vdfChild(item.children, 'width')?.value).toBe('640')
    expect(vdfChild(item.children, 'height')?.value).toBe('480')
    expect(vdfChild(item.children, 'gameid')?.value).toBe(APP)
    const bytes = await fs.readFile(result.files[0]!)
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(await fs.stat(path.join(path.dirname(result.files[0]!), 'thumbnails', path.basename(result.files[0]!)))).toMatchObject({ size: 16 })
    expect(service.getImages()).toEqual([])
    expect(imageAdapter.encode).toHaveBeenCalledWith(expect.any(Buffer), { quality: 95, width: 640, height: 480, thumbnailWidth: 200, thumbnailHeight: 150 })
  })

  it('safely initializes a missing screenshot index and handles full 64-bit game IDs', async () => {
    const { service, input, vdf } = await fixture({ original: null })
    input.appId = '12345678901234567890'
    const result = await service.prepare(input)
    expect(JSON.parse(await fs.readFile(path.join(result.backupPath, 'manifest.json'), 'utf8')).originalExisted).toBe(false)
    expect(vdfPath(parseScreenshotVdf(await fs.readFile(vdf, 'utf8')), 'screenshots', input.appId, '0', 'gameid')?.value).toBe(input.appId)
  })

  it('blocks running Steam before writing and preserves pending images', async () => {
    const { service, input, running, vdf } = await fixture()
    running.mockResolvedValue(true)
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RUNNING' })
    expect(await fs.readFile(vdf, 'utf8')).toBe(ORIGINAL)
    expect(service.getImages()).toHaveLength(1)
  })

  it('rolls back published images when Steam starts immediately before the VDF commit', async () => {
    const { service, input, running, vdf, root } = await fixture()
    running.mockClear().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RUNNING' })
    expect(await fs.readFile(vdf, 'utf8')).toBe(ORIGINAL)
    const files = await fs.readdir(path.join(root, 'userdata', USER, '760', 'remote', APP, 'screenshots'))
    expect(files).toEqual(['thumbnails'])
    expect(service.getImages()).toHaveLength(1)
  })

  it('does not overwrite another program\'s changed metadata', async () => {
    const { service, input, running, vdf, root } = await fixture()
    running.mockClear().mockResolvedValueOnce(false).mockImplementationOnce(async () => { await fs.writeFile(vdf, 'external metadata'); return false })
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_METADATA_CHANGED' })
    expect(await fs.readFile(vdf, 'utf8')).toBe('external metadata')
    expect(await fs.readdir(path.join(root, 'userdata', USER, '760', 'remote', APP, 'screenshots'))).toEqual(['thumbnails'])
  })

  it('rejects changed source images and malformed VDF without modifying the index', async () => {
    const { service, input, source, vdf } = await fixture()
    await fs.writeFile(source, png(100, 100))
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_FILE_CHANGED' })
    expect(await fs.readFile(vdf, 'utf8')).toBe(ORIGINAL)
    await fs.writeFile(vdf, '"screenshots" {')
    await expect(service.prepare(input)).rejects.toThrow('VDF_UNCLOSED_OBJECT')
    expect(await fs.readFile(vdf, 'utf8')).toBe('"screenshots" {')
  })

  it('does not rewrite invalid UTF-8 screenshot indexes', async () => {
    const { service, input, vdf } = await fixture()
    const invalid = Buffer.concat([Buffer.from('"screenshots" { "future" "'), Buffer.from([0xff]), Buffer.from('" }')])
    await fs.writeFile(vdf, invalid)
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_METADATA' })
    expect(await fs.readFile(vdf)).toEqual(invalid)
  })

  it('does not delete an external replacement lock when preparation finishes', async () => {
    const { service, input, running, root } = await fixture()
    const lockPath = path.join(root, 'userdata', USER, '760', '.xiaolan-screenshot-import.lock')
    running.mockClear().mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      await fs.unlink(lockPath)
      await fs.writeFile(lockPath, 'external lock owner')
      return false
    })
    await service.prepare(input)
    expect(await fs.readFile(lockPath, 'utf8')).toBe('external lock owner')
  })

  it('rejects malformed input, unknown images, path traversal, and unapproved catalog roots', async () => {
    const { service, input } = await fixture()
    for (const overrides of [{ userId: '../123' }, { appId: '../570' }, { appId: '18446744073709551616' }, { jpegQuality: 0 }, { caption: 'bad\ncaption' }, { imageIds: ['unknown'] }, { steamPath: 'C:\\unapproved' }]) {
      await expect(service.prepare({ ...input, ...overrides })).rejects.toThrow()
    }
  })

  it('requires resizing oversized images when the user explicitly disabled automatic scaling', async () => {
    const { service, input } = await fixture({ imageWidth: 8000, imageHeight: 4000 })
    await expect(service.prepare({ ...input, resizeLargeImages: false })).rejects.toMatchObject({ code: 'SCREENSHOT_RESIZE_REQUIRED' })
    const result = await service.prepare(input)
    const game = vdfPath(parseScreenshotVdf(await fs.readFile(result.vdfPath, 'utf8')), 'screenshots', APP, '4')!
    expect(Number(vdfChild(game.children, 'width')?.value) * Number(vdfChild(game.children, 'height')?.value)).toBeLessThanOrEqual(26210175)
  })

  it('blocks parallel preparation and survives conversion failure without losing queue images', async () => {
    const { service, input, imageAdapter, vdf } = await fixture()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.mocked(imageAdapter.encode).mockImplementationOnce(async () => { await pending; throw new Error('encode fixture failure') })
    const first = service.prepare(input)
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_BUSY' })
    release()
    await expect(first).rejects.toThrow('encode fixture failure')
    expect(await fs.readFile(vdf, 'utf8')).toBe(ORIGINAL)
    expect(service.getImages()).toHaveLength(1)
  })

  it('rejects active import locks and does not remove locks it did not own', async () => {
    const { service, input, root } = await fixture()
    const lock = path.join(root, 'userdata', USER, '760', '.xiaolan-screenshot-import.lock')
    const content = JSON.stringify({ pid: process.pid })
    await fs.writeFile(lock, content)
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_LOCKED' })
    expect(await fs.readFile(lock, 'utf8')).toBe(content)
  })

  it('refuses symlink destinations and never writes outside Steam userdata', async () => {
    const { service, input, root } = await fixture()
    const outside = path.join(root, 'outside')
    const screenshots = path.join(root, 'userdata', USER, '760', 'remote', APP, 'screenshots')
    await fs.mkdir(outside)
    await fs.rm(screenshots, { recursive: true })
    await fs.symlink(outside, screenshots, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_UNSAFE_PATH' })
    expect(await fs.readdir(outside)).toEqual([])
  })
})

describe('bounded local non-Steam shortcut names', () => {
  const shortcutFixture = () => {
    const str = (type: number, key: string, value: string | number): Buffer => {
      const data = typeof value === 'number' ? Buffer.alloc(4) : Buffer.from(`${value}\0`)
      if (typeof value === 'number') data.writeUInt32LE(value)
      return Buffer.concat([Buffer.from([type]), Buffer.from(`${key}\0`), data])
    }
    return Buffer.concat([Buffer.from('\0shortcuts\0\x000\0'), str(2, 'appid', 3212345678), str(1, 'AppName', 'Named shortcut'), str(1, 'Exe', 'never-executed.exe'), Buffer.from([8, 8, 8])])
  }
  it('reads only app names and covers both app IDs and 64-bit game IDs', () => {
    const names = screenshotShortcutNames(shortcutFixture())
    expect(names.get('3212345678')).toBe('Named shortcut')
    expect(names.get(String((3212345678n << 32n) | 0x02000000n))).toBe('Named shortcut')
    expect(JSON.stringify([...names])).not.toContain('never-executed')
  })
  it('rejects unsupported binary types, truncated strings, and incomplete object endings', () => {
    expect(() => screenshotShortcutNames(Buffer.from([99, 0]))).toThrow('SHORTCUTS_UNSUPPORTED_TYPE')
    expect(() => screenshotShortcutNames(Buffer.from([1, 65]))).toThrow('SHORTCUTS_INVALID_STRING')
    expect(() => screenshotShortcutNames(shortcutFixture().subarray(0, -1))).toThrow('SHORTCUTS_UNCLOSED_OBJECT')
  })
})
