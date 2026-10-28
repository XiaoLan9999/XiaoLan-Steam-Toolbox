import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SteamScreenshotService, type ScreenshotImageAdapter } from '../src/main/steam-screenshots'
import { ScreenshotLiveImport, screenshotLiveUncertainDigests, type ScreenshotApiResult } from '../src/main/screenshot-live-import'
import type { ScreenshotPrepareInput, ScreenshotImportPhase } from '../src/shared/steam-screenshots'
import type { ScreenshotApiContext } from '../src/main/screenshot-api-host'

const roots: string[] = []
const USER = '39734273'
const APP = '730'
const ORIGINAL = '"screenshots" { "730" { "0" { "filename" "730/screenshots/old.jpg" } } }'
function png(mark = 0, width = 640, height = 480): Buffer {
  const data = Buffer.alloc(32)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20); data[31] = mark
  return data
}
function jpeg(width = 640, height = 480): Buffer {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0, 0xff, 0xd9])
  data.writeUInt16BE(height, 7); data.writeUInt16BE(width, 9); return data
}
const adapter = (): ScreenshotImageAdapter => ({
  inspect: async data => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20), previewJpeg: jpeg(100, 75) }),
  encode: vi.fn(async (_data, options) => ({ jpeg: jpeg(options.width, options.height), thumbnail: jpeg(options.thumbnailWidth, options.thumbnailHeight) }))
})
async function fixture(count = 1) {
  const temporaryDirectory = await fs.realpath(os.tmpdir())
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryDirectory, 'screenshot-live-fixture-')))
  roots.push(root)
  const steamPath = path.join(root, 'Steam')
  const base = path.join(steamPath, 'userdata', USER, '760')
  const screenshots = path.join(base, 'remote', APP, 'screenshots')
  await fs.mkdir(screenshots, { recursive: true })
  const vdf = path.join(base, 'screenshots.vdf')
  await fs.writeFile(vdf, ORIGINAL)
  const directory = path.join(root, 'ledger')
  const imageAdapter = adapter()
  const service = new SteamScreenshotService({ imageAdapter, isSteamRunning: async () => true, findSteamPaths: async () => [steamPath] })
  await service.refresh()
  const sources: string[] = []
  for (let index = 0; index < count; index++) { const source = path.join(root, `source-${index}.png`); await fs.writeFile(source, png(index)); sources.push(source) }
  const images = await service.addImages(sources)
  const input: ScreenshotPrepareInput = { steamPath, userId: USER, appId: APP, imageIds: images.map(image => image.id), jpegQuality: 95, resizeLargeImages: true }
  const context: ScreenshotApiContext = { steamExe: path.join(steamPath, 'steam.exe'), clientDll: path.join(steamPath, 'steamclient64.dll'), clientSha256: 'a'.repeat(64), steamPid: 1234, steamStartTicks: '638964000000000001', steamId: (76561197960265728n + BigInt(USER)).toString(), appId: Number(APP), ownerPid: 5678, ownerStartTicks: '638964000000000002' }
  const answers: ScreenshotApiResult[] = []
  let submitted = 0
  const host = {
    start: vi.fn(async (_context: ScreenshotApiContext, _stageRoot: string) => {}),
    add: vi.fn(async (image: { path: string; width: number; height: number; sha256: string }): Promise<ScreenshotApiResult> => {
      const answer = answers.shift() ?? { status: 'confirmed', mayHaveSubmitted: true, handle: ++submitted, result: 1 }
      if (answer.status === 'confirmed') await fs.copyFile(image.path, path.join(screenshots, `new-${host.add.mock.calls.length}.jpg`))
      return answer
    }),
    shutdown: vi.fn(async () => {})
  }
  const discoverContext = vi.fn(async (_steamPath: string, _userId: string, _appId: string) => context)
  const phases: ScreenshotImportPhase[] = []
  const operation = new ScreenshotLiveImport({ service, directory, createHost: () => host, discoverContext, progress: phase => phases.push(phase) })
  const ledgers = async () => {
    const names = await fs.readdir(directory)
    return Promise.all(names.map(async name => ({ path: path.join(directory, name, 'ledger.json'), value: JSON.parse(await fs.readFile(path.join(directory, name, 'ledger.json'), 'utf8')) })))
  }
  return { root, steamPath, directory, base, screenshots, vdf, service, imageAdapter, sources, images, input, operation, host, answers, discoverContext, phases, ledgers }
}

afterEach(async () => {
  const temporaryDirectory = await fs.realpath(os.tmpdir())
  for (const root of roots.splice(0)) {
    if (path.dirname(root).toLowerCase() !== temporaryDirectory.toLowerCase() || !path.basename(root).startsWith('screenshot-live-fixture-')) throw new Error('Unsafe fixture cleanup')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('Steam API screenshot staging and confirmation', () => {
  it('stages converted JPEGs outside Steam and only trusts a confirmed callback plus a new matching file', async () => {
    const f = await fixture(2)
    const sourceBefore = await fs.readFile(f.sources[0]!)
    const result = await f.operation.prepare(f.input)
    expect(result).toMatchObject({ method: 'steam-api', imported: 2, backupPath: null, completedImageIds: f.input.imageIds })
    expect(result?.outcomes?.map(row => row.status)).toEqual(['confirmed', 'confirmed'])
    expect(result?.files).toHaveLength(2)
    expect(await fs.readFile(f.vdf, 'utf8')).toBe(ORIGINAL)
    expect(await fs.readFile(f.sources[0]!)).toEqual(sourceBefore)
    expect(f.service.getImages()).toEqual([])
    expect(f.phases).toEqual(['connecting-steam', 'importing-live'])
    expect(f.host.shutdown).toHaveBeenCalledTimes(1)
    const ledger = (await f.ledgers())[0]!.value
    expect(ledger.images.map((row: { status: string }) => row.status)).toEqual(['confirmed', 'confirmed'])
    expect(JSON.stringify(ledger)).not.toContain(f.sources[0])
  })

  it('durably records submitting before the host receives any image', async () => {
    const f = await fixture()
    f.host.add.mockImplementationOnce(async image => {
      expect((await f.ledgers())[0]!.value.images[0].status).toBe('submitting')
      await fs.copyFile(image.path, path.join(f.screenshots, 'native-created.jpg'))
      return { status: 'confirmed', mayHaveSubmitted: true, handle: 10, result: 1 }
    })
    expect((await f.operation.prepare(f.input))?.imported).toBe(1)
  })

  it.each([{ caption: 'keep this caption' }, { appId: '13456789012345678901' }, { appId: '480' }, { preferLive: false }])('declines unsupported live qualification without contacting Steam %j', async override => {
    const f = await fixture()
    expect(await f.operation.prepare({ ...f.input, ...override })).toBeNull()
    expect(f.host.start).not.toHaveBeenCalled()
    expect(f.discoverContext).not.toHaveBeenCalled()
  })

  it('allows a supported caption-free small image and lets Steam generate its thumbnail', async () => {
    const f = await fixture()
    await fs.writeFile(f.sources[0]!, png(0, 80, 60))
    f.service.clearImages()
    const images = await f.service.addImages(f.sources)
    const result = await f.operation.prepare({ ...f.input, imageIds: images.map(image => image.id) })
    expect(result?.imported).toBe(1)
    expect(f.host.add).toHaveBeenCalledWith(expect.objectContaining({ width: 80, height: 60 }))
    expect(Object.keys(f.host.add.mock.calls[0]![0])).not.toContain('thumbnail')
  })

  it('returns null for unavailable initialization only after the host has exited, with no submission', async () => {
    const f = await fixture(); f.host.start.mockRejectedValue(new Error('Fixture unsupported API'))
    expect(await f.operation.prepare(f.input)).toBeNull()
    expect(f.host.add).not.toHaveBeenCalled()
    expect(f.host.shutdown).toHaveBeenCalledTimes(1)
    expect(f.service.getImages()).toHaveLength(1)
  })

  it('does not permit fallback when a failed initialization helper cannot be confirmed stopped', async () => {
    const f = await fixture(); f.host.start.mockRejectedValue(new Error('Fixture init failure'))
    f.host.shutdown.mockRejectedValue(new Error('Fixture exit unconfirmed'))
    await expect(f.operation.prepare(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_SHUTDOWN_FAILED' })
    expect(f.host.add).not.toHaveBeenCalled()
    expect(f.operation.hasClientWork()).toBe(true)
  })

  it('declines context mismatch before creating a helper or transaction', async () => {
    const f = await fixture(); f.discoverContext.mockRejectedValue(new Error('Fixture account mismatch'))
    expect(await f.operation.prepare(f.input)).toBeNull()
    expect(f.host.start).not.toHaveBeenCalled()
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans completed staged JPEGs if a later image fails conversion, before any host exists', async () => {
    const f = await fixture(2)
    vi.mocked(f.imageAdapter.encode).mockImplementationOnce(async (_bytes, options) => ({ jpeg: jpeg(options.width, options.height), thumbnail: jpeg(options.thumbnailWidth, options.thumbnailHeight) }))
      .mockRejectedValueOnce(new Error('Fixture second conversion failure'))
    await expect(f.operation.prepare(f.input)).rejects.toThrow('Fixture second conversion failure')
    expect(f.host.start).not.toHaveBeenCalled()
    const transactions = await fs.readdir(f.directory)
    expect(transactions).toHaveLength(1)
    expect(await fs.readdir(path.join(f.directory, transactions[0]!))).toEqual([])
  })
})

describe('per-image outcomes and durable duplicate prevention', () => {
  it('retains a definitively rejected image, but removes only confirmed images', async () => {
    const f = await fixture(2)
    f.answers.push({ status: 'confirmed', mayHaveSubmitted: true, handle: 1, result: 1 }, { status: 'rejected', mayHaveSubmitted: true, handle: 0, code: 'INVALID_SCREENSHOT_HANDLE' })
    const result = await f.operation.prepare(f.input)
    expect(result?.imported).toBe(1)
    expect(result?.outcomes?.map(row => row.status)).toEqual(['confirmed', 'rejected'])
    expect(f.service.getImages().map(image => image.id)).toEqual([f.input.imageIds[1]])
    expect(f.service.getImages()[0]?.importStatus).toBeUndefined()
    expect(await screenshotLiveUncertainDigests(f.directory, USER, APP)).toEqual(new Set())
  })

  it('marks callback timeout uncertain, retains later unsubmitted images, and never resends this attempt', async () => {
    const f = await fixture(3)
    f.answers.push({ status: 'confirmed', mayHaveSubmitted: true, handle: 1, result: 1 }, { status: 'uncertain', mayHaveSubmitted: true, handle: 2, code: 'CALLBACK_TIMEOUT' })
    const result = await f.operation.prepare(f.input)
    expect(result?.imported).toBe(1)
    expect(result?.outcomes?.map(row => row.status)).toEqual(['confirmed', 'uncertain', 'rejected'])
    expect(result?.outcomes?.[2]?.code).toBe('LIVE_NOT_SUBMITTED')
    expect(f.host.add).toHaveBeenCalledTimes(2)
    expect(f.service.getImages()).toMatchObject([{ id: f.input.imageIds[1], importStatus: 'uncertain' }, { id: f.input.imageIds[2] }])
    const pending = { ...f.input, imageIds: [f.input.imageIds[1]!] }
    await expect(f.service.prepare(pending)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    await expect(f.operation.prepare(pending)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    expect(f.host.add).toHaveBeenCalledTimes(2)
  })

  it('treats an accepted callback without a new matching JPEG as uncertain', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.screenshots, 'old-with-same-hash.jpg'), jpeg())
    f.host.add.mockResolvedValue({ status: 'confirmed', mayHaveSubmitted: true, handle: 1, result: 1 })
    const result = await f.operation.prepare(f.input)
    expect(result).toMatchObject({ imported: 0, outcomes: [{ status: 'uncertain', code: 'LIVE_FILE_UNCONFIRMED' }] })
    expect(f.service.getImages()[0]?.importStatus).toBe('uncertain')
  })

  it('treats an exception after handing the command to the host as uncertain, with no fallback', async () => {
    const f = await fixture(); f.host.add.mockRejectedValue(new Error('Fixture disconnected pipe'))
    const result = await f.operation.prepare(f.input)
    expect(result).toMatchObject({ imported: 0, method: 'steam-api', outcomes: [{ status: 'uncertain' }] })
    expect(f.host.add).toHaveBeenCalledTimes(1)
    expect((await f.ledgers())[0]!.value.images[0].status).toBe('uncertain')
  })

  it('blocks the same content even after removal and selection under a different file name', async () => {
    const f = await fixture(); f.answers.push({ status: 'uncertain', mayHaveSubmitted: true, code: 'CALLBACK_TIMEOUT' })
    await f.operation.prepare(f.input)
    f.service.clearImages()
    const renamed = path.join(f.root, 'renamed.png')
    await fs.copyFile(f.sources[0]!, renamed)
    const selected = await f.service.addImages([renamed])
    const retry = { ...f.input, imageIds: selected.map(image => image.id), preferLive: false }
    await expect(f.service.preflight(retry)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    await expect(f.service.prepare(retry)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    expect(f.service.getImages()[0]?.importStatus).toBe('uncertain')
  })

  it('recovers a crash-time submitting record and keeps blocks scoped to account and game', async () => {
    const f = await fixture(); f.answers.push({ status: 'uncertain', mayHaveSubmitted: true, code: 'CALLBACK_TIMEOUT' })
    await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    ledger.value.images[0].status = 'submitting'
    await fs.writeFile(ledger.path, JSON.stringify(ledger.value))
    const restarted = new SteamScreenshotService({ imageAdapter: adapter(), isSteamRunning: async () => false, findSteamPaths: async () => [f.steamPath], liveLedgerDirectory: f.directory })
    await restarted.refresh()
    const selected = await restarted.addImages(f.sources)
    await expect(restarted.prepare({ ...f.input, imageIds: selected.map(image => image.id) })).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
    expect((await screenshotLiveUncertainDigests(f.directory, USER, APP)).size).toBe(1)
    expect(await screenshotLiveUncertainDigests(f.directory, '999', APP)).toEqual(new Set())
    expect(await screenshotLiveUncertainDigests(f.directory, USER, '570')).toEqual(new Set())
  })

  it('does not carry an uncertain view flag into a different game target', async () => {
    const f = await fixture(); f.answers.push({ status: 'uncertain', mayHaveSubmitted: true, code: 'CALLBACK_TIMEOUT' })
    await f.operation.prepare(f.input)
    expect(f.service.getImages()[0]?.importStatus).toBe('uncertain')
    await f.service.preflight({ ...f.input, appId: '570' })
    expect(f.service.getImages()[0]?.importStatus).toBeUndefined()
    await expect(f.service.preflight(f.input)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_UNCERTAIN' })
  })

  it('fails closed for a corrupt ledger rather than silently allowing an offline duplicate', async () => {
    const f = await fixture(); await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    await fs.writeFile(ledger.path, '{ broken')
    f.service.clearImages(); const selected = await f.service.addImages(f.sources)
    await expect(f.service.preflight({ ...f.input, imageIds: selected.map(image => image.id) })).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_LEDGER_UNAVAILABLE' })
  })

  it('keeps successful callbacks separate from a later helper shutdown failure', async () => {
    const f = await fixture(); f.host.shutdown.mockRejectedValue(new Error('Fixture stop failure'))
    expect(await f.operation.prepare(f.input)).toMatchObject({ imported: 1, outcomes: [{ status: 'confirmed' }], warning: 'LIVE_WORKER_STOP_UNCONFIRMED' })
    expect(f.service.getImages()).toEqual([])
    expect(f.operation.hasClientWork()).toBe(true)
  })

  it('cleans confirmed and rejected staging JPEGs only after helper close, retaining the small ledger', async () => {
    const f = await fixture(2)
    f.answers.push({ status: 'confirmed', mayHaveSubmitted: true, handle: 1, result: 1 }, { status: 'rejected', mayHaveSubmitted: true, handle: 0, code: 'INVALID_SCREENSHOT_HANDLE' })
    f.host.shutdown.mockImplementationOnce(async () => {
      const ledger = (await f.ledgers())[0]!
      expect((await fs.readdir(path.dirname(ledger.path))).sort()).toEqual(['0.jpg', '1.jpg', 'ledger.json'])
    })
    await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    expect(await fs.readdir(path.dirname(ledger.path))).toEqual(['ledger.json'])
  })

  it('retains uncertain JPEGs but cleans safely unsubmitted images after the helper has closed', async () => {
    const f = await fixture(2)
    f.answers.push({ status: 'uncertain', mayHaveSubmitted: true, handle: 1, code: 'CALLBACK_TIMEOUT' })
    await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    expect((await fs.readdir(path.dirname(ledger.path))).sort()).toEqual(['0.jpg', 'ledger.json'])
  })

  it('cleans never-submitted stages when API initialization fails but helper exit is confirmed', async () => {
    const f = await fixture(2); f.host.start.mockRejectedValue(new Error('Fixture unsupported'))
    expect(await f.operation.prepare(f.input)).toBeNull()
    const ledger = (await f.ledgers())[0]!
    expect(await fs.readdir(path.dirname(ledger.path))).toEqual(['ledger.json'])
  })

  it('does not clean any stages while a successful helper remains unconfirmed alive', async () => {
    const f = await fixture(); f.host.shutdown.mockRejectedValue(new Error('Fixture stop unconfirmed'))
    expect((await f.operation.prepare(f.input))?.imported).toBe(1)
    const ledger = (await f.ledgers())[0]!
    expect((await fs.readdir(path.dirname(ledger.path))).sort()).toEqual(['0.jpg', 'ledger.json'])
    expect(f.operation.hasClientWork()).toBe(true)
  })

  it('cleans retained finished files after a later confirmed retirement, before any other attempt', async () => {
    const f = await fixture(); f.host.shutdown.mockRejectedValueOnce(new Error('Fixture stop unconfirmed'))
    await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    expect(f.operation.hasClientWork()).toBe(true)
    expect(await f.operation.prepare({ ...f.input, preferLive: false })).toBeNull()
    expect(f.operation.hasClientWork()).toBe(false)
    expect(await fs.readdir(path.dirname(ledger.path))).toEqual(['ledger.json'])
  })

  it('rejects coerced ledger hashes and filenames instead of losing duplicate guards', async () => {
    const f = await fixture(); await f.operation.prepare(f.input)
    const ledger = (await f.ledgers())[0]!
    ledger.value.images[0].sourceSha256 = [ledger.value.images[0].sourceSha256]
    await fs.writeFile(ledger.path, JSON.stringify(ledger.value))
    await expect(screenshotLiveUncertainDigests(f.directory, USER, APP)).rejects.toMatchObject({ code: 'SCREENSHOT_LIVE_LEDGER_UNAVAILABLE' })
  })

  it('does not reveal backend exception text or source paths in result codes', async () => {
    const f = await fixture(); f.host.add.mockRejectedValue(new Error('private paths / secrets'))
    const result = await f.operation.prepare(f.input)
    expect(JSON.stringify(result)).not.toContain('private paths')
    expect(JSON.stringify(result)).not.toContain(f.sources[0])
  })
})
