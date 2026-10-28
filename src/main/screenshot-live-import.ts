import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DomainError } from '../shared/domain'
import type { ScreenshotImageOutcome, ScreenshotImportPhase, ScreenshotPrepareInput, ScreenshotPrepareResult } from '../shared/steam-screenshots'
import type { SteamScreenshotService } from './steam-screenshots'
import type { ScreenshotApiContext } from './screenshot-api-host'

type LedgerStatus = 'staged' | 'submitting' | 'confirmed' | 'rejected' | 'uncertain'
interface LedgerImage {
  imageId: string; name: string; sourceSha256: string; sha256: string; filename: string
  width: number; height: number; status: LedgerStatus; code?: string; handle?: number
}
interface Ledger { version: 1; id: string; createdAt: string; userId: string; appId: string; images: LedgerImage[] }
export interface ScreenshotApiResult {
  status: 'confirmed' | 'rejected' | 'uncertain'; mayHaveSubmitted: boolean; code?: string; handle?: number; result?: number
}
export interface ScreenshotLiveHost {
  start(context: ScreenshotApiContext, stageRoot: string): Promise<void>
  add(image: { path: string; width: number; height: number; sha256: string }): Promise<ScreenshotApiResult>
  shutdown(): Promise<void>
}
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const statuses: LedgerStatus[] = ['staged', 'submitting', 'confirmed', 'rejected', 'uncertain']
const failure = (message = '截图导入记录无法安全读取，已停止操作以避免重复导入'): DomainError => new DomainError('SCREENSHOT_LIVE_LEDGER_UNAVAILABLE', message)
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

export async function safeScreenshotLiveDirectory(directory: string, create = false): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw failure()
  const absolute = path.resolve(directory)
  if (create) {
    try { await fs.lstat(absolute) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      const parent = path.dirname(absolute)
      if (parent === absolute) throw failure()
      await safeScreenshotLiveDirectory(parent, true)
      try { await fs.mkdir(absolute) } catch (error) { if (errno(error) !== 'EEXIST') throw error }
    }
  }
  const metadata = await fs.lstat(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.resolve(await fs.realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw failure()
  return absolute
}

async function readLedger(file: string): Promise<Ledger> {
  const metadata = await fs.lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) throw failure()
  const handle = await fs.open(file, 'r')
  try {
    const current = await handle.stat()
    if (metadata.dev !== current.dev || metadata.ino !== current.ino || metadata.size !== current.size || metadata.mtimeMs !== current.mtimeMs) throw failure()
    const content = Buffer.alloc(current.size)
    let offset = 0
    while (offset < content.length) {
      const read = await handle.read(content, offset, content.length - offset, offset)
      if (read.bytesRead === 0) throw failure()
      offset += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, content.length)).bytesRead !== 0) throw failure()
    const value = JSON.parse(content.toString('utf8')) as Ledger
    if (value?.version !== 1 || !idPattern.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.userId !== 'string' || !/^[1-9]\d{0,9}$/.test(value.userId) || BigInt(value.userId) > 4_294_967_295n ||
        typeof value.appId !== 'string' || !/^[1-9]\d{0,9}$/.test(value.appId) || Number(value.appId) > 0xffffff ||
        !Array.isArray(value.images) || value.images.length > 100) throw failure()
    for (const image of value.images) {
      if (!image || typeof image.imageId !== 'string' || image.imageId.length > 128 || typeof image.name !== 'string' || image.name.length > 500 ||
          typeof image.sourceSha256 !== 'string' || !hashPattern.test(image.sourceSha256) || typeof image.sha256 !== 'string' || !hashPattern.test(image.sha256) ||
          typeof image.filename !== 'string' || !/^\d{1,3}\.jpg$/.test(image.filename) ||
          !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 16000 || image.height > 16000 || image.width * image.height > 26210175 || !statuses.includes(image.status)) throw failure()
    }
    return value
  } finally { await handle.close() }
}

export async function screenshotLiveUncertainDigests(directory: string, userId: string, appId: string): Promise<Set<string>> {
  try { await safeScreenshotLiveDirectory(directory) } catch (error) { if (errno(error) === 'ENOENT') return new Set(); throw error instanceof DomainError ? error : failure() }
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    if (entries.length > 1024) throw failure('截图导入历史过多，需先检查本地记录；尚未再次提交图片')
    const blocked = new Set<string>()
    for (const entry of entries) {
      if (!idPattern.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure()
      const child = await safeScreenshotLiveDirectory(path.join(directory, entry.name))
      let ledger: Ledger
      try { ledger = await readLedger(path.join(child, 'ledger.json')) }
      catch (error) {
        if (errno(error) === 'ENOENT') {
          // A crash during initial staging cannot have reached the API.
          continue
        }
        throw error
      }
      if (ledger.id !== entry.name) throw failure()
      if (ledger.userId !== userId || ledger.appId !== appId) continue
      for (const image of ledger.images) if (image.status === 'submitting' || image.status === 'uncertain') blocked.add(image.sourceSha256)
    }
    return blocked
  } catch (error) { throw error instanceof DomainError ? error : failure() }
}

async function saveLedger(directory: string, ledger: Ledger): Promise<void> {
  await safeScreenshotLiveDirectory(directory)
  const temporary = path.join(directory, `ledger-${randomUUID()}.tmp`)
  const target = path.join(directory, 'ledger.json')
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    try { const metadata = await fs.lstat(target); if (!metadata.isFile() || metadata.isSymbolicLink()) throw failure() }
    catch (error) { if (errno(error) !== 'ENOENT') throw error }
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(ledger))
    await handle.sync()
    await handle.close(); handle = undefined
    await safeScreenshotLiveDirectory(directory)
    await fs.rename(temporary, target)
  } catch (error) { throw error instanceof DomainError ? error : failure('无法持久保存截图导入记录，已停止继续提交') }
  finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}) }
}

async function removeFinishedStage(directory: string, filename: string, sha256: string): Promise<void> {
  try {
    await safeScreenshotLiveDirectory(directory)
    if (!/^\d{1,3}\.jpg$/.test(filename)) return
    const file = path.join(directory, filename)
    const before = await fs.lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024 * 1024) return
    const handle = await fs.open(file, 'r')
    try {
      const current = await handle.stat()
      if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) return
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let position = 0
      while (position < current.size) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, current.size - position), position)
        if (!read.bytesRead) return
        hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead
      }
      if ((await handle.read(buffer, 0, 1, position)).bytesRead || hash.digest('hex') !== sha256) return
    } finally { await handle.close() }
    const after = await fs.lstat(file)
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
    await fs.unlink(file)
  } catch { /* Never delete a replacement or turn committed import success into a retry. */ }
}

function publicCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback
}

export class ScreenshotLiveImport {
  private busy = false
  private unconfirmedHost: ScreenshotLiveHost | null = null
  private recoveryCleanup: { directory: string; files: Array<{ filename: string; sha256: string }> } | null = null
  constructor(private readonly options: {
    service: SteamScreenshotService
    directory: string
    createHost(): ScreenshotLiveHost
    discoverContext(steamPath: string, userId: string, appId: string): Promise<ScreenshotApiContext>
    progress(phase: ScreenshotImportPhase): void
  }) { options.service.setLiveLedgerDirectory(options.directory) }

  hasClientWork(): boolean { return this.busy || this.unconfirmedHost !== null }

  async prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> {
    if (this.busy) throw new DomainError('SCREENSHOT_BUSY', '截图工具正忙，请稍后重试')
    if (this.unconfirmedHost) {
      this.busy = true
      try {
        await this.unconfirmedHost.shutdown(); this.unconfirmedHost = null
        if (this.recoveryCleanup) for (const file of this.recoveryCleanup.files) await removeFinishedStage(this.recoveryCleanup.directory, file.filename, file.sha256)
        this.recoveryCleanup = null
      }
      catch { throw new DomainError('SCREENSHOT_LIVE_SHUTDOWN_FAILED', '上一次截图组件尚未确认退出，未继续导入；请关闭工具箱后重试') }
      finally { this.busy = false }
    }
    if (input.preferLive === false || (input.caption ?? '').trim() !== '' || !/^[1-9]\d{0,7}$/.test(input.appId) || Number(input.appId) > 0xffffff || input.appId === '480') return null
    this.busy = true
    let host: ScreenshotLiveHost | undefined
    let opened = false
    let workerClosed = true
    let submitted = false
    let ledger: Ledger | undefined
    let directory: string | undefined
    const cleanup = new Map<string, string>()
    const outcomes: ScreenshotImageOutcome[] = []
    const files: string[] = []
    const completedImageIds: string[] = []
    let result: ScreenshotPrepareResult | undefined
    try {
      await this.options.service.preflight(input)
      this.options.progress('connecting-steam')
      let context: ScreenshotApiContext
      try { context = await this.options.discoverContext(input.steamPath, input.userId, input.appId) }
      catch { return null }
      const root = await safeScreenshotLiveDirectory(this.options.directory, true)
      const id = randomUUID()
      directory = path.join(root, id)
      await fs.mkdir(directory)
      await safeScreenshotLiveDirectory(directory)
      const images = await this.options.service.stageForLive(input, directory)
      for (let index = 0; index < images.length; index++) cleanup.set(`${index}.jpg`, images[index]!.sha256)
      ledger = { version: 1, id, createdAt: new Date().toISOString(), userId: input.userId, appId: input.appId,
        images: images.map((image, index) => ({ imageId: image.imageId, name: image.name, sourceSha256: image.sourceSha256, sha256: image.sha256,
          filename: `${index}.jpg`, width: image.width, height: image.height, status: 'staged' })) }
      await saveLedger(directory, ledger)
      host = this.options.createHost()
      workerClosed = false
      try { await host.start(context, directory); opened = true }
      catch {
        try { await host.shutdown() }
        catch {
          this.unconfirmedHost = host
          this.recoveryCleanup = { directory, files: [...cleanup].map(([filename, sha256]) => ({ filename, sha256 })) }
          throw new DomainError('SCREENSHOT_LIVE_SHUTDOWN_FAILED', '截图组件未确认退出，未转用重启导入；请关闭工具箱后重试')
        }
        workerClosed = true
        host = undefined
        return null
      }
      const knownPaths = new Set(await this.options.service.listLiveScreenshotFiles(input))
      this.options.progress('importing-live')
      for (let index = 0; index < images.length; index++) {
        const image = images[index]!
        const row = ledger.images[index]!
        row.status = 'submitting'
        await saveLedger(directory, ledger)
        cleanup.delete(row.filename)
        submitted = true
        let answer: ScreenshotApiResult
        try { answer = await host.add({ path: image.path, width: image.width, height: image.height, sha256: image.sha256 }) }
        catch { answer = { status: 'uncertain', mayHaveSubmitted: true, code: 'LIVE_RESULT_UNCONFIRMED' } }
        let status = answer.status
        let code = publicCode(answer.code, status === 'uncertain' ? 'LIVE_RESULT_UNCONFIRMED' : 'LIVE_API_REJECTED')
        let verified: string | null = null
        if (status === 'confirmed') {
          try { verified = await this.options.service.findVerifiedLiveScreenshot(input, knownPaths, image.sha256) }
          catch { /* A successful callback without a verified new file remains uncertain. */ }
          if (!verified) { status = 'uncertain'; code = 'LIVE_FILE_UNCONFIRMED' }
        }
        row.status = status
        if (status !== 'confirmed') row.code = code
        if (Number.isSafeInteger(answer.handle) && answer.handle! > 0) row.handle = answer.handle
        let saved = false
        try { await saveLedger(directory, ledger); saved = true }
        catch {
          status = 'uncertain'; code = 'LIVE_LEDGER_SAVE_FAILED'
          // The previous durable 'submitting' record still prevents a repeat.
        }
        this.options.service.recordLiveOutcome(image.imageId, image.sourceSha256, status, status === 'confirmed' ? undefined : code)
        outcomes.push({ imageId: image.imageId, name: image.name, status, ...(status === 'confirmed' ? {} : { code }) })
        if (status === 'confirmed' && verified) { knownPaths.add(verified); files.push(verified); completedImageIds.push(image.imageId) }
        if (saved && status !== 'uncertain') cleanup.set(row.filename, row.sha256)
        if (status === 'uncertain') break
      }
      for (const image of images) if (!outcomes.some(outcome => outcome.imageId === image.imageId)) outcomes.push({ imageId: image.imageId, name: image.name, status: 'rejected', code: 'LIVE_NOT_SUBMITTED' })
      result = this.result(input, outcomes, files, completedImageIds)
      return result
    } catch (error) {
      if (!submitted) throw error
      // Never allow a post-submission failure to enter automatic restart fallback.
      for (const row of ledger?.images ?? []) {
        if (outcomes.some(outcome => outcome.imageId === row.imageId)) continue
        const status = row.status === 'submitting' || row.status === 'uncertain' ? 'uncertain' : 'rejected'
        const code = status === 'uncertain' ? 'LIVE_RESULT_UNCONFIRMED' : 'LIVE_NOT_SUBMITTED'
        if (status === 'uncertain') this.options.service.recordLiveOutcome(row.imageId, row.sourceSha256, status, code)
        outcomes.push({ imageId: row.imageId, name: row.name, status, code })
      }
      result = this.result(input, outcomes, files, completedImageIds)
      return result
    } finally {
      try {
        if (host && opened) {
          try { await host.shutdown(); workerClosed = true }
          catch {
            this.unconfirmedHost = host
            if (directory) this.recoveryCleanup = { directory, files: [...cleanup].map(([filename, sha256]) => ({ filename, sha256 })) }
            if (result) result.warning = 'LIVE_WORKER_STOP_UNCONFIRMED'
            if (!submitted) throw new DomainError('SCREENSHOT_LIVE_SHUTDOWN_FAILED', '截图组件未确认退出，未转用重启导入；请关闭工具箱后重试')
          }
        }
      } finally {
        if (workerClosed && directory) for (const [filename, sha256] of cleanup) await removeFinishedStage(directory, filename, sha256)
        this.busy = false
      }
    }
  }

  private result(input: ScreenshotPrepareInput, outcomes: ScreenshotImageOutcome[], files: string[], completedImageIds: string[]): ScreenshotPrepareResult {
    return { imported: completedImageIds.length, files, backupPath: null, vdfPath: path.join(input.steamPath, 'userdata', input.userId, '760', 'screenshots.vdf'),
      method: 'steam-api', outcomes, completedImageIds }
  }
}
