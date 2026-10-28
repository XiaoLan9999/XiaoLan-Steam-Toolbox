import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SteamScreenshotService, type ScreenshotImageAdapter } from '../src/main/steam-screenshots'
import { ScreenshotLocalImport, type ScreenshotInactivePermit } from '../src/main/screenshot-local-import'
import type { ScreenshotActiveUser } from '../src/main/screenshot-active-user'
import type { ScreenshotPrepareInput } from '../src/shared/steam-screenshots'
import { parseScreenshotVdf, vdfPath, vdfChild } from '../src/main/steam-screenshot-vdf'

const USER = '39734273'
const TARGET = '76561198000000001'
const CURRENT = '76561198000000002'
const ORIGINAL = '// preserve bytes\r\n"screenshots" { "730" { "0" { "filename" "730/screenshots/existing.jpg" "future" "keep" } } }\r\n'
const roots: string[] = []
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function png(): Buffer {
  const data = Buffer.alloc(32)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.write('IHDR', 12); data.writeUInt32BE(640, 16); data.writeUInt32BE(480, 20)
  return data
}
function jpeg(width: number, height: number): Buffer {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0, 0xff, 0xd9])
  data.writeUInt16BE(height, 7); data.writeUInt16BE(width, 9); return data
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-local-fixture-')))
  roots.push(root)
  const steamPath = path.join(root, 'Steam')
  const base = path.join(steamPath, 'userdata', USER, '760')
  const screenshots = path.join(base, 'remote', '730', 'screenshots')
  await fs.mkdir(path.join(screenshots, 'thumbnails'), { recursive: true })
  const index = path.join(base, 'screenshots.vdf')
  await fs.writeFile(index, ORIGINAL)
  await fs.writeFile(path.join(screenshots, 'existing.jpg'), 'existing-image-bytes')
  const source = path.join(root, 'source.png')
  await fs.writeFile(source, png())
  const adapter: ScreenshotImageAdapter = {
    inspect: async () => ({ width: 640, height: 480, previewJpeg: jpeg(160, 120) }),
    encode: vi.fn(async (_bytes, options) => ({ jpeg: jpeg(options.width, options.height), thumbnail: jpeg(options.thumbnailWidth, options.thumbnailHeight) }))
  }
  const running = vi.fn(async () => true)
  const service = new SteamScreenshotService({ imageAdapter: adapter, isSteamRunning: running })
  await service.refresh(steamPath)
  const images = await service.addImages([source])
  const input: ScreenshotPrepareInput = { mode: 'local-account', steamPath, userId: USER, appId: '730', imageIds: images.map(image => image.id), jpegQuality: 95, resizeLargeImages: true, caption: 'Fixture local import', restartSteam: false }
  const identity: ScreenshotActiveUser = { steamPath, steamExe: path.join(steamPath, 'steam.exe'), steamPid: 1234, steamStartTicks: '638964000000000001', steamId: CURRENT, clientSha256: 'a'.repeat(64) }
  const readActiveUser = vi.fn(async (_path: string) => ({ ...identity }))
  const local = new ScreenshotLocalImport({ service, readActiveUser })
  return { root, steamPath, base, screenshots, index, source, adapter, running, service, input, identity, readActiveUser, local }
}

afterEach(async () => {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('screenshot-local-fixture-')) throw new Error('Unsafe fixture cleanup target')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('specified inactive Steam account local screenshot import', () => {
  it('uses three fresh identity guards to import B while A stays running, retaining backup and original images', async () => {
    const f = await fixture()
    f.running.mockClear()
    const sourceBefore = await fs.readFile(f.source)
    const result = await f.local.prepareIfInactive(f.input)
    expect(result).toMatchObject({ imported: 1, method: 'index', activation: 'after-account-switch', completedImageIds: f.input.imageIds })
    expect(result?.steamRestart).toBeUndefined()
    expect(f.readActiveUser).toHaveBeenCalledTimes(4)
    expect(f.readActiveUser.mock.calls.every(([root]) => root === f.steamPath)).toBe(true)
    expect(f.running).not.toHaveBeenCalled()
    expect(await fs.readFile(f.source)).toEqual(sourceBefore)
    expect(await fs.readFile(path.join(f.screenshots, 'existing.jpg'), 'utf8')).toBe('existing-image-bytes')
    expect(await fs.readFile(path.join(result!.backupPath!, 'screenshots.vdf'), 'utf8')).toBe(ORIGINAL)
    expect(f.service.getImages()).toEqual([])
    const entries = vdfPath(parseScreenshotVdf(await fs.readFile(f.index, 'utf8')), 'screenshots', '730')!.children!
    expect(entries).toHaveLength(2)
    expect(vdfChild(entries[0]!.children, 'future')?.value).toBe('keep')
    expect(vdfChild(entries[1]!.children, 'caption')?.value).toBe('Fixture local import')
    expect(result!.files).toHaveLength(1)
  })

  it('does not let local mode or renderer flags bypass the ordinary Steam-running guard', async () => {
    const f = await fixture()
    await expect(f.service.prepare({ ...f.input, restartSteam: false, preferLive: false })).rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RUNNING' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(f.readActiveUser).not.toHaveBeenCalled()
    expect(f.service.getImages()).toHaveLength(1)
  })

  it.each([{}, { assertInactive: async () => {} }, { steamId: CURRENT, userId: USER }])('rejects a forged main-process authorization %j', async fake => {
    const f = await fixture()
    await expect(f.service.prepareInactive(f.input, fake)).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
    expect(f.adapter.encode).not.toHaveBeenCalled()
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('consumes the real permit once and refuses replay after a successful import', async () => {
    const f = await fixture()
    const actual = f.service.prepareInactive.bind(f.service)
    let permit!: ScreenshotInactivePermit
    vi.spyOn(f.service, 'prepareInactive').mockImplementationOnce((input, value) => { permit = value; return actual(input, value) })
    await f.local.prepareIfInactive(f.input)
    await expect(actual(f.input, permit)).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
  })

  it('binds the permit to the same service instance', async () => {
    const f = await fixture(); const other = await fixture()
    vi.spyOn(f.service, 'prepareInactive').mockImplementationOnce((input, permit) => other.service.prepareInactive(input, permit))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(await fs.readFile(other.index, 'utf8')).toBe(ORIGINAL)
  })

  it('binds the permit to the exact target and image options', async () => {
    const f = await fixture(); const actual = f.service.prepareInactive.bind(f.service)
    vi.spyOn(f.service, 'prepareInactive').mockImplementationOnce((input, permit) => actual({ ...input, appId: '570' }, permit))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('declines the current account without encoding or writing, leaving restart decisions to the caller', async () => {
    const f = await fixture(); f.identity.steamId = TARGET
    expect(await f.local.prepareIfInactive(f.input)).toBeNull()
    expect(f.readActiveUser).toHaveBeenCalledTimes(1)
    expect(f.adapter.encode).not.toHaveBeenCalled()
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(f.service.getImages()).toHaveLength(1)
  })

  it.each([2, 3, 4])('aborts and rolls back only newly published images if target becomes active at identity check %s', async check => {
    const f = await fixture()
    f.readActiveUser.mockImplementation(async () => ({ ...f.identity, steamId: f.readActiveUser.mock.calls.length >= check ? TARGET : CURRENT }))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_CHANGED' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect((await fs.readdir(f.screenshots)).sort()).toEqual(['existing.jpg', 'thumbnails'])
    expect(await fs.readdir(path.join(f.screenshots, 'thumbnails'))).toEqual([])
    expect(f.service.getImages()).toHaveLength(1)
  })

  it.each([
    { steamPid: 5678 }, { steamStartTicks: '638964000000000002' }, { steamId: '76561198000000003' }, { clientSha256: 'b'.repeat(64) }
  ])('aborts a replacement client or changed user at the final guard %j', async changes => {
    const f = await fixture()
    f.readActiveUser.mockImplementation(async () => ({ ...f.identity, ...(f.readActiveUser.mock.calls.length >= 4 ? changes : {}) }))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_CHANGED' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect((await fs.readdir(f.screenshots)).sort()).toEqual(['existing.jpg', 'thumbnails'])
  })

  it.each([1, 3, 4])('fails closed and sanitizes a failed current-user probe at stage %s', async check => {
    const f = await fixture()
    f.readActiveUser.mockImplementation(async () => { if (f.readActiveUser.mock.calls.length >= check) throw new Error('private-sdk-path'); return { ...f.identity } })
    const rejected = await f.local.prepareIfInactive(f.input).catch(error => error)
    expect(rejected).toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(rejected.message).not.toContain('private-sdk-path')
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it.each([
    { steamPid: 0 }, { steamStartTicks: '' }, { steamId: '0' }, { steamId: String(0x0110000100000000n) }, { clientSha256: 'unverified' }, { steamExe: 'D:/Other/steam.exe' }
  ])('never grants a permit for malformed or mismatched identity evidence %j', async changes => {
    const f = await fixture(); f.readActiveUser.mockResolvedValue({ ...f.identity, ...changes })
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE' })
    expect(f.adapter.encode).not.toHaveBeenCalled()
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('requires explicit mode two and validates the selected source before probing identity', async () => {
    const f = await fixture()
    await expect(f.local.prepareIfInactive({ ...f.input, mode: 'current-account' })).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
    await fs.writeFile(f.source, Buffer.from('changed source'))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_FILE_CHANGED' })
    expect(f.readActiveUser).not.toHaveBeenCalled()
  })

  it.each(['automatic', null, false])('rejects an invalid mode value at the underlying service boundary %j', async mode => {
    const f = await fixture()
    const input = { ...f.input, mode } as unknown as ScreenshotPrepareInput
    await expect(f.service.preflight(input)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_MODE' })
    await expect(f.service.prepare(input)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_MODE' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('serializes inactive preparation before even the first identity probe finishes', async () => {
    const f = await fixture()
    let release!: (identity: ScreenshotActiveUser) => void
    f.readActiveUser.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.local.prepareIfInactive(f.input)
    await vi.waitFor(() => expect(f.readActiveUser).toHaveBeenCalledTimes(1))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_BUSY' })
    release({ ...f.identity, steamId: TARGET })
    expect(await first).toBeNull()
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('preserves conversion failure and source/queue without changing the target index', async () => {
    const f = await fixture(); vi.mocked(f.adapter.encode).mockRejectedValue(new Error('synthetic encode failure'))
    await expect(f.local.prepareIfInactive(f.input)).rejects.toThrow('synthetic encode failure')
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(f.service.getImages()).toHaveLength(1)
    expect(await fs.readFile(f.source)).toEqual(png())
  })

  it('retains existing metadata compare-and-swap protection during inactive imports', async () => {
    const f = await fixture()
    const update = ORIGINAL.replace('preserve bytes', 'external newer version')
    f.readActiveUser.mockImplementation(async () => { if (f.readActiveUser.mock.calls.length === 3) await fs.writeFile(f.index, update); return { ...f.identity } })
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_METADATA_CHANGED' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(update)
    expect(f.service.getImages()).toHaveLength(1)
  })

  it('keeps durable uncertain-image protection even for a different currently logged-in user', async () => {
    const f = await fixture()
    const ledgerRoot = path.join(f.root, 'ledger'); const id = randomUUID(); const transaction = path.join(ledgerRoot, id)
    await fs.mkdir(transaction, { recursive: true })
    await fs.writeFile(path.join(transaction, 'ledger.json'), JSON.stringify({ version: 1, id, createdAt: new Date().toISOString(), userId: USER, appId: '730',
      images: [{ imageId: f.input.imageIds[0], name: 'source.png', sourceSha256: digest(png()), sha256: digest(jpeg(640, 480)), filename: '0.jpg', width: 640, height: 480, status: 'submitting' }] }))
    f.service.setLiveLedgerDirectory(ledgerRoot)
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    expect(f.readActiveUser).not.toHaveBeenCalled()
    expect(f.service.getImages()[0]?.importStatus).toBe('uncertain')
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
  })

  it('guards direct input mutation while a conversion is in progress', async () => {
    const f = await fixture()
    const encode = f.adapter.encode
    vi.mocked(f.adapter.encode).mockImplementationOnce(async (...args) => { f.input.caption = 'changed without fresh authorization'; return { jpeg: jpeg(args[1].width, args[1].height), thumbnail: jpeg(args[1].thumbnailWidth, args[1].thumbnailHeight) } })
    await expect(f.local.prepareIfInactive(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID' })
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('supports an existing non-Steam 64-bit GameID without using the current user game context', async () => {
    const f = await fixture(); const id = '13456789012345678901'
    const result = await f.local.prepareIfInactive({ ...f.input, appId: id })
    expect(result).toMatchObject({ activation: 'after-account-switch', imported: 1 })
    expect(vdfPath(parseScreenshotVdf(await fs.readFile(f.index, 'utf8')), 'screenshots', id, '0', 'gameid')?.value).toBe(id)
  })
})

describe('current-account target revalidation without writing', () => {
  it('confirms the actual selected account before current-account API use', async () => {
    const f = await fixture(); f.identity.steamId = TARGET
    await f.local.assertCurrentTarget(f.input)
    expect(f.readActiveUser).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(f.index, 'utf8')).toBe(ORIGINAL)
    expect(f.adapter.encode).not.toHaveBeenCalled()
  })

  it('rejects a different target before starting the wrong fake-game context', async () => {
    const f = await fixture()
    await expect(f.local.assertCurrentTarget(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_NOT_CURRENT' })
    expect(f.adapter.encode).not.toHaveBeenCalled()
  })

  it.each([{ pid: 5678 }, { startTicks: '638964000000000002' }, { executable: 'D:/Other/steam.exe' }])('rejects a changed client around restart confirmation %j', async changedClient => {
    const f = await fixture(); f.identity.steamId = TARGET
    const client = { pid: f.identity.steamPid, startTicks: f.identity.steamStartTicks, executable: f.identity.steamExe, ...changedClient }
    await expect(f.local.assertCurrentTarget(f.input, client)).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_CHANGED' })
  })

  it('rejects an account mismatch after client confirmation even if the client fields match', async () => {
    const f = await fixture()
    await expect(f.local.assertCurrentTarget(f.input, { pid: f.identity.steamPid, startTicks: f.identity.steamStartTicks, executable: f.identity.steamExe })).rejects.toMatchObject({ code: 'SCREENSHOT_TARGET_CHANGED' })
  })
})
