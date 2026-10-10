import { createHash } from 'node:crypto'
import { ArtworkError, inspectStaticArtwork, MAX_ARTWORK_FILE_BYTES } from '../shared/artwork'
import { DomainError } from '../shared/domain'
import type { ProfileBackgroundCatalog, ProfileBackgroundImage } from '../shared/profile-backgrounds'
import { normalizeProfileBackgroundMediaUrl } from './profile-backgrounds'

interface BackgroundMediaOptions {
  fetchImpl?: typeof fetch
  isAccountCurrent: (accountId: string) => boolean
}

interface CachedBackground {
  id: string
  kind: 'static' | 'animated'
  imageUrl: string | null
}

interface BackgroundOperation {
  accountId: string
  generation: number
  controller: AbortController
}

const HEADER_TIMEOUT_MS = 8_000
const STREAM_IDLE_TIMEOUT_MS = 45_000
const MAX_REDIRECTS = 5
const MAX_CATALOG_ITEMS = 5_000

export class BackgroundMediaService {
  private readonly catalogs = new Map<string, Map<string, CachedBackground>>()
  private readonly fetchImpl: typeof fetch
  private generation = 0
  private operation: BackgroundOperation | null = null

  constructor(private readonly options: BackgroundMediaOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  setCatalog(catalog: ProfileBackgroundCatalog): void {
    if (!catalog || !validAccountId(catalog.accountId) || !Array.isArray(catalog.items) ||
        catalog.items.length > MAX_CATALOG_ITEMS) throw backgroundError('BACKGROUND_NOT_FOUND')
    if (!this.options.isAccountCurrent(catalog.accountId)) throw backgroundError('BACKGROUND_SESSION_CHANGED')
    const cached = new Map<string, CachedBackground>()
    const conflictingIds = new Set<string>()
    for (const item of catalog.items) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 2_200 || /[\x00-\x1f\x7f]/.test(item.id) ||
          (item.kind !== 'static' && item.kind !== 'animated')) continue
      const imageUrl = normalizeProfileBackgroundMediaUrl(item.imageUrl, 'image')
      const previous = cached.get(item.id)
      if (previous && (previous.imageUrl !== imageUrl || previous.kind !== item.kind)) conflictingIds.add(item.id)
      cached.set(item.id, { id: item.id, kind: item.kind, imageUrl })
    }
    for (const id of conflictingIds) cached.delete(id)
    this.stop('BACKGROUND_CANCELLED')
    this.catalogs.set(catalog.accountId, cached)
  }

  async load(accountId: string, backgroundId: string): Promise<ProfileBackgroundImage> {
    if (!validAccountId(accountId) || !this.options.isAccountCurrent(accountId)) throw backgroundError('BACKGROUND_SESSION_CHANGED')
    if (typeof backgroundId !== 'string') throw backgroundError('BACKGROUND_NOT_FOUND')
    const item = this.catalogs.get(accountId)?.get(backgroundId)
    if (!item) throw backgroundError('BACKGROUND_NOT_FOUND')
    if (item.kind !== 'static') throw backgroundError('BACKGROUND_ANIMATED')
    const imageUrl = normalizeProfileBackgroundMediaUrl(item.imageUrl, 'image')
    if (!imageUrl) throw backgroundError('BACKGROUND_IMAGE_UNAVAILABLE')
    this.stop('BACKGROUND_CANCELLED')
    const operation: BackgroundOperation = {
      accountId, generation: this.generation, controller: new AbortController()
    }
    this.operation = operation
    try {
      const { bytes, mimeType } = await this.download(imageUrl, operation)
      this.assertCurrent(operation)
      let format: 'png' | 'jpeg'
      try { format = inspectStaticArtwork(bytes).format }
      catch (error) {
        if (error instanceof ArtworkError && ['fileTooLarge', 'imageTooLarge'].includes(error.code)) {
          throw backgroundError('BACKGROUND_IMAGE_TOO_LARGE')
        }
        if (error instanceof ArtworkError && error.code === 'animatedImage') throw backgroundError('BACKGROUND_ANIMATED')
        throw backgroundError('BACKGROUND_INVALID_IMAGE')
      }
      if ((format === 'png' ? 'image/png' : 'image/jpeg') !== mimeType) throw backgroundError('BACKGROUND_INVALID_IMAGE')
      this.assertCurrent(operation)
      const identity = createHash('sha256').update(`${accountId}\0${backgroundId}`).digest('hex').slice(0, 12)
      return {
        accountId, backgroundId, name: `steam-background-${identity}.${format === 'png' ? 'png' : 'jpg'}`,
        mimeType, base64: bytes.toString('base64')
      }
    } catch (error) {
      this.assertCurrent(operation)
      if (error instanceof DomainError) throw error
      throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
    } finally {
      if (this.operation === operation) this.operation = null
    }
  }

  cancel(): void {
    this.stop('BACKGROUND_CANCELLED')
  }

  invalidate(): void {
    this.stop('BACKGROUND_SESSION_CHANGED')
    this.catalogs.clear()
  }

  private stop(code: string): void {
    this.generation++
    this.operation?.controller.abort(backgroundError(code))
    this.operation = null
  }

  private assertCurrent(operation: BackgroundOperation): void {
    if (!this.options.isAccountCurrent(operation.accountId)) throw backgroundError('BACKGROUND_SESSION_CHANGED')
    if (operation.controller.signal.aborted) {
      const reason = operation.controller.signal.reason as unknown
      throw reason instanceof DomainError ? reason : backgroundError('BACKGROUND_CANCELLED')
    }
    if (operation.generation !== this.generation) throw backgroundError('BACKGROUND_SESSION_CHANGED')
  }

  private async download(initialUrl: string, operation: BackgroundOperation): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' }> {
    let url = initialUrl
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      this.assertCurrent(operation)
      if (!normalizeProfileBackgroundMediaUrl(url, 'image')) throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
      const headerTimeout = setTimeout(() => operation.controller.abort(backgroundError('BACKGROUND_DOWNLOAD_FAILED')), HEADER_TIMEOUT_MS)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: operation.controller.signal,
          headers: { Accept: 'image/png,image/jpeg' }
        })
      } finally { clearTimeout(headerTimeout) }
      try { this.assertCurrent(operation) }
      catch (error) { await cancelBody(response); throw error }
      if (response.redirected || (response.url && !normalizeProfileBackgroundMediaUrl(response.url, 'image'))) {
        await cancelBody(response); throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await cancelBody(response)
        if (!location || redirects === MAX_REDIRECTS) throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
        let target: URL
        try { target = new URL(location, url) }
        catch { throw backgroundError('BACKGROUND_DOWNLOAD_FAILED') }
        if (!normalizeProfileBackgroundMediaUrl(target.href, 'image')) throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
        url = target.href
        continue
      }
      if (response.status !== 200) {
        await cancelBody(response); throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
        await cancelBody(response); throw backgroundError('BACKGROUND_INVALID_IMAGE')
      }
      const rawLength = response.headers.get('content-length')
      if (rawLength && !/^\d+$/.test(rawLength)) {
        await cancelBody(response); throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
      }
      const expectedLength = rawLength === null ? null : Number(rawLength)
      if (expectedLength !== null && (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_ARTWORK_FILE_BYTES)) {
        await cancelBody(response); throw backgroundError('BACKGROUND_IMAGE_TOO_LARGE')
      }
      if (!response.body) throw backgroundError('BACKGROUND_INVALID_IMAGE')
      const bytes = await this.readBody(response.body, operation)
      if (expectedLength !== null && bytes.length !== expectedLength) throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
      return { bytes, mimeType }
    }
    throw backgroundError('BACKGROUND_DOWNLOAD_FAILED')
  }

  private async readBody(body: ReadableStream<Uint8Array>, operation: BackgroundOperation): Promise<Buffer> {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    let idleTimeout: ReturnType<typeof setTimeout> | null = null
    const armTimeout = (): void => {
      if (idleTimeout) clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => operation.controller.abort(backgroundError('BACKGROUND_DOWNLOAD_FAILED')), STREAM_IDLE_TIMEOUT_MS)
    }
    const abort = (): void => { void reader.cancel().catch(() => {}) }
    operation.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      armTimeout()
      while (true) {
        this.assertCurrent(operation)
        const chunk = await reader.read()
        this.assertCurrent(operation)
        if (chunk.done) break
        if (!(chunk.value instanceof Uint8Array)) throw backgroundError('BACKGROUND_INVALID_IMAGE')
        if (chunk.value.byteLength === 0) continue
        size += chunk.value.byteLength
        if (size > MAX_ARTWORK_FILE_BYTES) throw backgroundError('BACKGROUND_IMAGE_TOO_LARGE')
        chunks.push(Buffer.from(chunk.value))
        armTimeout()
      }
      return Buffer.concat(chunks, size)
    } finally {
      if (idleTimeout) clearTimeout(idleTimeout)
      operation.controller.signal.removeEventListener('abort', abort)
      try { await reader.cancel() } catch { /* Reader errors are replaced by stable, non-sensitive transport errors. */ }
      reader.releaseLock()
    }
  }
}

function validAccountId(accountId: unknown): accountId is string {
  return typeof accountId === 'string' && /^7656119\d{10}$/.test(accountId)
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* Ignore cleanup failures without exposing response URLs. */ }
}

function backgroundError(code: string): DomainError {
  return new DomainError(code, code)
}
