import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUILTIN_UPDATE_ROUTES,
  UPDATE_MANIFEST_URL,
  type SignedUpdateManifest,
  type UpdateAsset,
  type UpdateManifest,
  type UpdatePackageKind,
  type UpdatePreferences,
  type UpdateRouteStatus,
  type UpdateState
} from '../shared/update-types'
import { compareVersions, verifySignedUpdateManifest } from './update-security'

export const UPDATE_MANIFEST_LIMIT = 128 * 1024
export const UPDATE_PROBE_BYTES = 64 * 1024
export const UPDATE_PROBE_TIMEOUT_MS = 8_000
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 45_000

interface UpdateServiceOptions {
  currentVersion: string
  packageKind: UpdatePackageKind
  cacheDirectory: string
  preferences: () => UpdatePreferences
  onStateChange: (state: UpdateState) => void
  fetchImpl?: typeof fetch
  publicKey?: string
}

interface Route {
  id: string
  label: string
  domain: string
  prefix: string | null
}

interface Candidate {
  envelope: SignedUpdateManifest
  manifest: UpdateManifest
}

class UpdateError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export class UpdateService {
  private state: UpdateState
  private readonly fetchImpl: typeof fetch
  private readonly initialized: Promise<void>
  private candidate: Candidate | null = null
  private availableRoutes: Route[] = []
  private operation: Promise<UpdateState> | null = null
  private controller: AbortController | null = null
  private closed = false

  constructor(private readonly options: UpdateServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.state = {
      phase: 'idle', currentVersion: options.currentVersion, latestVersion: null,
      checkedAt: null, releaseUrl: null, packageKind: options.packageKind,
      sourceRouteId: null, routes: [], downloadedBytes: 0, totalBytes: 0,
      percent: 0, speedBytesPerSecond: 0, error: null
    }
    this.initialized = this.restoreCache()
  }

  getState(): UpdateState {
    return structuredClone(this.state)
  }

  checkForUpdates(): Promise<UpdateState> {
    return this.startOperation((signal) => this.check(signal))
  }

  downloadUpdate(routeId?: string): Promise<UpdateState> {
    return this.startOperation(async (signal) => {
      if (this.state.phase === 'ready') {
        try {
          await this.getReadyUpdate()
          return this.getState()
        } catch {
          this.setState({ phase: 'available', error: 'update.cacheInvalid' })
        }
      }
      if (this.availableRoutes.length === 0) await this.check(signal)
      throwIfAborted(signal)
      return this.download(signal, routeId)
    })
  }

  cancel(): void {
    if (!this.controller) return
    this.controller.abort()
    this.setState({
      phase: this.hasNewVersion() ? 'available' : 'idle',
      speedBytesPerSecond: 0, error: 'update.cancelled'
    })
  }

  shutdown(): void {
    this.closed = true
    this.controller?.abort()
  }

  async getReadyUpdate(): Promise<{ path: string; asset: UpdateAsset; manifest: UpdateManifest }> {
    await this.initialized
    if (this.state.phase !== 'ready' || !this.candidate) throw new UpdateError('update.noUpdate')
    try {
      const candidate = await this.readCachedManifest()
      if (!candidate || compareVersions(candidate.manifest.version, this.options.currentVersion) <= 0 ||
          !sameManifest(candidate.manifest, this.candidate.manifest)) {
        throw new UpdateError('update.cacheInvalid')
      }
      const asset = this.assetFor(candidate.manifest)
      const path = this.assetPath(candidate.manifest, asset)
      await verifyFile(path, asset)
      return { path, asset: structuredClone(asset), manifest: structuredClone(candidate.manifest) }
    } catch (error) {
      this.setState({ phase: 'error', error: errorCode(error, 'update.cacheInvalid'), speedBytesPerSecond: 0 })
      throw new UpdateError(errorCode(error, 'update.cacheInvalid'))
    }
  }

  private startOperation(action: (signal: AbortSignal) => Promise<UpdateState>): Promise<UpdateState> {
    if (this.operation) return this.operation
    if (this.closed) return Promise.resolve(this.getState())
    const controller = new AbortController()
    this.controller = controller
    const operation = (async () => {
      await this.initialized
      throwIfAborted(controller.signal)
      return action(controller.signal)
    })().catch((error: unknown) => {
      if (!controller.signal.aborted && !this.closed) {
        this.setState({ phase: 'error', error: errorCode(error, 'update.storageError'), speedBytesPerSecond: 0 })
      }
      return this.getState()
    }).finally(() => {
      if (this.operation === operation) this.operation = null
      if (this.controller === controller) this.controller = null
    })
    this.operation = operation
    return operation
  }

  private async restoreCache(): Promise<void> {
    try {
      this.candidate = await this.readCachedManifest()
      if (!this.candidate || this.closed) return
      const manifest = this.candidate.manifest
      const asset = this.assetFor(manifest)
      this.setState({ latestVersion: manifest.version, releaseUrl: manifest.releaseUrl, totalBytes: asset.size })
      if (!this.hasNewVersion()) return
      try {
        await verifyFile(this.assetPath(manifest, asset), asset)
        if (!this.closed) this.setState({ phase: 'ready', downloadedBytes: asset.size, percent: 100 })
      } catch {
        if (!this.closed) this.setState({ phase: 'available' })
      }
    } catch {
      // A corrupt cache cannot establish a trusted version or a ready installer.
      this.candidate = null
    }
  }

  private async readCachedManifest(): Promise<Candidate | null> {
    const path = join(this.options.cacheDirectory, 'highest-manifest.json')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > UPDATE_MANIFEST_LIMIT) throw new UpdateError('update.cacheInvalid')
      const envelope: unknown = JSON.parse(await readFile(path, 'utf8'))
      return this.verifyCandidate(envelope)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  private verifyCandidate(envelope: unknown): Candidate {
    try {
      const manifest = verifySignedUpdateManifest(envelope, this.options.publicKey)
      return { envelope: envelope as SignedUpdateManifest, manifest }
    } catch {
      throw new UpdateError('update.manifestSignature')
    }
  }

  private async persistCandidate(candidate: Candidate): Promise<void> {
    await mkdir(this.options.cacheDirectory, { recursive: true })
    const temporary = join(this.options.cacheDirectory, 'highest-manifest.tmp')
    await writeFile(temporary, JSON.stringify(candidate.envelope), { mode: 0o600 })
    await rename(temporary, join(this.options.cacheDirectory, 'highest-manifest.json'))
  }

  private async check(signal: AbortSignal): Promise<UpdateState> {
    const hadReady = this.state.phase === 'ready'
    const routes = this.routesFromPreferences()
    this.availableRoutes = []
    this.setState({ phase: 'checking', error: null, sourceRouteId: null, routes: routes.map(routeStatus) })
    const found = await Promise.all(routes.map(async (route): Promise<{ route: Route; candidate: Candidate } | null> => {
      const started = performance.now()
      try {
        const envelope = await withDeadline(signal, UPDATE_PROBE_TIMEOUT_MS, async (requestSignal) => {
          const response = await this.request(this.routeUrl(route, UPDATE_MANIFEST_URL), requestSignal)
          assertResponse(response)
          const bytes = await readLimited(response, UPDATE_MANIFEST_LIMIT, requestSignal)
          try {
            return JSON.parse(new TextDecoder().decode(bytes)) as unknown
          } catch {
            throw new UpdateError('update.invalidResponse')
          }
        })
        const candidate = this.verifyCandidate(envelope)
        throwIfAborted(signal)
        this.updateRoute(route.id, { status: 'available', latencyMs: Math.round(performance.now() - started), error: null })
        return { route, candidate }
      } catch (error) {
        if (!signal.aborted) this.updateRoute(route.id, {
          status: 'failed', latencyMs: Math.round(performance.now() - started), error: errorCode(error, 'update.manifestUnavailable')
        })
        return null
      }
    }))
    throwIfAborted(signal)
    let selected = this.candidate
    for (const entry of found) {
      if (entry && (!selected || compareVersions(entry.candidate.manifest.version, selected.manifest.version) > 0)) {
        selected = entry.candidate
      }
    }
    if (!selected) {
      this.setState({ phase: 'error', checkedAt: new Date().toISOString(), error: 'update.manifestUnavailable' })
      return this.getState()
    }
    this.candidate = selected
    await this.persistCandidate(selected)
    throwIfAborted(signal)
    for (const entry of found) {
      if (!entry) continue
      const comparison = compareVersions(entry.candidate.manifest.version, selected.manifest.version)
      if (comparison < 0) this.updateRoute(entry.route.id, { status: 'failed', error: 'update.staleManifest' })
      else if (!sameManifest(entry.candidate.manifest, selected.manifest)) {
        this.updateRoute(entry.route.id, { status: 'failed', error: 'update.conflictingManifest' })
      } else this.availableRoutes.push(entry.route)
    }
    const asset = this.assetFor(selected.manifest)
    this.setState({
      latestVersion: selected.manifest.version, releaseUrl: selected.manifest.releaseUrl,
      checkedAt: new Date().toISOString(), totalBytes: asset.size,
      phase: compareVersions(selected.manifest.version, this.options.currentVersion) > 0
        ? (this.availableRoutes.length > 0 ? 'available' : 'error') : 'upToDate',
      error: this.hasVersionAboveCurrent(selected.manifest) && !hadReady && this.availableRoutes.length === 0
        ? 'update.manifestUnavailable' : null
    })
    // A newer manifest must not inherit an older installer's ready state.
    if (hadReady && this.hasNewVersion()) {
      try {
        await verifyFile(this.assetPath(selected.manifest, asset), asset, signal)
        throwIfAborted(signal)
        this.setState({ phase: 'ready', downloadedBytes: asset.size, percent: 100 })
      } catch {
        throwIfAborted(signal)
        this.setState({ phase: this.availableRoutes.length > 0 ? 'available' : 'error', downloadedBytes: 0, percent: 0 })
      }
    }
    throwIfAborted(signal)
    return this.getState()
  }

  private async download(signal: AbortSignal, preferredRouteId?: string): Promise<UpdateState> {
    if (!this.candidate || !this.hasNewVersion()) throw new UpdateError('update.noUpdate')
    if (preferredRouteId && !this.availableRoutes.some((route) => route.id === preferredRouteId)) {
      throw new UpdateError('update.routeUnavailable')
    }
    if (this.availableRoutes.length === 0) throw new UpdateError('update.routeUnavailable')
    const { manifest } = this.candidate
    const asset = this.assetFor(manifest)
    this.setState({ phase: 'downloading', error: null, downloadedBytes: 0, percent: 0, totalBytes: asset.size })
    await Promise.all(this.availableRoutes.map((route) => this.probe(route, asset, signal)))
    throwIfAborted(signal)
    const routes = [...this.availableRoutes].sort((left, right) => {
      if (left.id === preferredRouteId) return -1
      if (right.id === preferredRouteId) return 1
      return this.routeSpeed(right.id) - this.routeSpeed(left.id)
    })
    const destination = this.assetPath(manifest, asset)
    const partialPath = `${destination}.part`
    await mkdir(join(this.options.cacheDirectory, `v${manifest.version}`), { recursive: true })
    let lastError = 'update.downloadInterrupted'
    for (const route of routes) {
      throwIfAborted(signal)
      this.setState({ sourceRouteId: route.id, error: null, speedBytesPerSecond: 0 })
      try {
        await this.downloadRoute(route, asset, partialPath, signal)
        throwIfAborted(signal)
        await verifyFile(partialPath, asset, signal)
        throwIfAborted(signal)
        await rm(destination, { force: true })
        await rename(partialPath, destination)
        throwIfAborted(signal)
        this.updateRoute(route.id, { status: 'available', error: null })
        this.setState({ phase: 'ready', downloadedBytes: asset.size, percent: 100, speedBytesPerSecond: 0, error: null })
        return this.getState()
      } catch (error) {
        throwIfAborted(signal)
        lastError = errorCode(error, 'update.downloadInterrupted')
        this.updateRoute(route.id, { status: 'failed', error: lastError })
        if (lastError === 'update.downloadHash' || lastError === 'update.downloadSize') {
          await rm(partialPath, { force: true })
        }
      }
    }
    this.setState({ phase: 'error', error: lastError, speedBytesPerSecond: 0 })
    return this.getState()
  }

  private async probe(route: Route, asset: UpdateAsset, signal: AbortSignal): Promise<void> {
    const started = performance.now()
    try {
      const bytes = await withDeadline(signal, UPDATE_PROBE_TIMEOUT_MS, async (requestSignal) => {
        const response = await this.request(this.routeUrl(route, asset.downloadUrl), requestSignal, {
          Range: `bytes=0-${Math.min(asset.size, UPDATE_PROBE_BYTES) - 1}`
        })
        assertResponse(response, [200, 206])
        if (response.status === 206) validateContentRange(response, 0, asset.size)
        return readLimited(response, Math.min(asset.size, UPDATE_PROBE_BYTES), requestSignal, true)
      })
      throwIfAborted(signal)
      if (bytes.byteLength < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
        throw new UpdateError('update.invalidResponse')
      }
      const speed = Math.round(bytes.byteLength / Math.max((performance.now() - started) / 1000, 0.001))
      this.updateRoute(route.id, { speedBytesPerSecond: speed })
    } catch (error) {
      if (!signal.aborted) this.updateRoute(route.id, {
        speedBytesPerSecond: 0, error: errorCode(error, 'update.downloadInterrupted')
      })
    }
  }

  private async downloadRoute(route: Route, asset: UpdateAsset, path: string, signal: AbortSignal): Promise<void> {
    let position = await partialSize(path)
    if (position > asset.size) {
      await rm(path, { force: true })
      position = 0
    }
    if (position === asset.size) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, UPDATE_DOWNLOAD_TIMEOUT_MS)
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      throwIfAborted(signal)
      resetTimeout()
      const response = await this.request(this.routeUrl(route, asset.downloadUrl), controller.signal,
        position > 0 ? { Range: `bytes=${position}-` } : undefined)
      assertResponse(response, [200, 206])
      if (response.status === 206) validateContentRange(response, position, asset.size)
      else if (position > 0) position = 0
      const remaining = asset.size - position
      const declared = contentLength(response)
      if (declared !== null && (declared > remaining || (response.status === 200 && declared !== asset.size))) {
        throw new UpdateError('update.downloadSize')
      }
      if (!response.body) throw new UpdateError('update.downloadInterrupted')
      handle = await open(path, position === 0 ? 'w' : 'r+')
      reader = response.body.getReader()
      const startPosition = position
      const started = performance.now()
      let lastPublished = started - 250
      this.setState({ downloadedBytes: position, percent: percent(position, asset.size) })
      while (true) {
        resetTimeout()
        const chunk = await raceAbort(reader.read(), controller.signal)
        if (chunk.done) break
        throwIfAborted(signal)
        if (position + chunk.value.byteLength > asset.size) throw new UpdateError('update.downloadSize')
        let written = 0
        while (written < chunk.value.byteLength) {
          const result = await handle.write(chunk.value, written, chunk.value.byteLength - written, position + written)
          if (result.bytesWritten === 0) throw new UpdateError('update.storageError')
          written += result.bytesWritten
        }
        position += written
        const now = performance.now()
        if (now - lastPublished >= 250) {
          lastPublished = now
          this.setState({
            downloadedBytes: position, percent: percent(position, asset.size),
            speedBytesPerSecond: Math.round((position - startPosition) / Math.max((now - started) / 1000, 0.001))
          })
        }
      }
      if (position !== asset.size) throw new UpdateError('update.downloadInterrupted')
      await handle.sync()
      this.setState({ downloadedBytes: position, percent: 100 })
    } catch (error) {
      if (timedOut && !signal.aborted) throw new UpdateError('update.timeout')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      if (reader) await reader.cancel().catch(() => undefined)
      if (handle) await handle.close()
    }
  }

  private async request(url: string, signal: AbortSignal, extraHeaders?: Record<string, string>): Promise<Response> {
    let target = url
    for (let redirects = 0; redirects <= 5; redirects++) {
      throwIfAborted(signal)
      const response = await raceAbort(this.fetchImpl(target, {
        method: 'GET', credentials: 'omit', redirect: 'manual', signal,
        headers: { Accept: 'application/json, application/octet-stream;q=0.9', ...extraHeaders }
      }), signal)
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new UpdateError('update.redirectInvalid')
      let next: URL
      try { next = new URL(location, target) } catch { throw new UpdateError('update.redirectInvalid') }
      if (next.protocol !== 'https:' || next.username || next.password) throw new UpdateError('update.redirectInvalid')
      if (redirects === 5) throw new UpdateError('update.redirectLimit')
      target = next.href
    }
    throw new UpdateError('update.redirectLimit')
  }

  private routesFromPreferences(): Route[] {
    const preferences = this.options.preferences()
    const routes: Route[] = BUILTIN_UPDATE_ROUTES.filter((route) => preferences.useMirrors || route.id === 'github')
      .map((route) => ({ ...route, domain: new URL(route.prefix ?? UPDATE_MANIFEST_URL).hostname }))
    if (preferences.useMirrors) {
      for (const [index, input] of preferences.customMirrors.slice(0, 5).entries()) {
        try {
          const prefix = new URL(input)
          if (prefix.protocol !== 'https:' || prefix.username || prefix.password || prefix.search || prefix.hash || input.length > 2048) continue
          const normalized = `${prefix.href.replace(/\/+$/, '')}/`
          if (routes.some((route) => route.prefix === normalized)) continue
          routes.push({ id: `custom-${index}`, label: prefix.hostname, domain: prefix.hostname, prefix: normalized })
        } catch { /* Invalid custom routes are excluded from all network requests. */ }
      }
    }
    return routes
  }

  private routeUrl(route: Route, url: string): string {
    return route.prefix ? `${route.prefix}${url}` : url
  }

  private assetFor(manifest: UpdateManifest): UpdateAsset {
    const asset = manifest.assets.find((entry) => entry.kind === this.options.packageKind)
    if (!asset) throw new UpdateError('update.manifestSignature')
    return asset
  }

  private assetPath(manifest: UpdateManifest, asset: UpdateAsset): string {
    return join(this.options.cacheDirectory, `v${manifest.version}`, asset.fileName)
  }

  private hasVersionAboveCurrent(manifest: UpdateManifest): boolean {
    return compareVersions(manifest.version, this.options.currentVersion) > 0
  }

  private hasNewVersion(): boolean {
    return this.candidate !== null && this.hasVersionAboveCurrent(this.candidate.manifest)
  }

  private routeSpeed(id: string): number {
    return this.state.routes.find((route) => route.id === id)?.speedBytesPerSecond ?? 0
  }

  private updateRoute(id: string, patch: Partial<UpdateRouteStatus>): void {
    this.setState({ routes: this.state.routes.map((route) => route.id === id ? { ...route, ...patch } : route) })
  }

  private setState(patch: Partial<UpdateState>): void {
    if (this.closed) return
    this.state = { ...this.state, ...patch }
    try { this.options.onStateChange(this.getState()) } catch { /* UI observers cannot break a download. */ }
  }
}

function routeStatus(route: Route): UpdateRouteStatus {
  return { id: route.id, label: route.label, domain: route.domain, status: 'pending', latencyMs: null, speedBytesPerSecond: null, error: null }
}

function sameManifest(left: UpdateManifest, right: UpdateManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UpdateError('update.cancelled')
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof UpdateError ? error.code : fallback
}

function contentLength(response: Response): number | null {
  const header = response.headers.get('content-length')
  if (header === null) return null
  if (!/^\d+$/.test(header)) throw new UpdateError('update.invalidResponse')
  const length = Number(header)
  if (!Number.isSafeInteger(length)) throw new UpdateError('update.invalidResponse')
  return length
}

function assertResponse(response: Response, allowed = [200]): void {
  if (!allowed.includes(response.status)) throw new UpdateError('update.httpError')
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new UpdateError('update.invalidResponse')
}

function validateContentRange(response: Response, start: number, total: number): void {
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
  if (!range || Number(range[1]) !== start || Number(range[3]) !== total ||
      Number(range[2]) < start || Number(range[2]) >= total) throw new UpdateError('update.downloadSize')
  const declared = contentLength(response)
  if (declared !== null && declared !== Number(range[2]) - start + 1) throw new UpdateError('update.downloadSize')
}

async function readLimited(response: Response, limit: number, signal: AbortSignal, truncate = false): Promise<Uint8Array> {
  if (!truncate && (contentLength(response) ?? 0) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new UpdateError('update.manifestTooLarge')
  }
  if (!response.body) throw new UpdateError('update.invalidResponse')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await raceAbort(reader.read(), signal)
      if (result.done) break
      const remaining = limit - size
      if (!truncate && result.value.byteLength > remaining) throw new UpdateError('update.manifestTooLarge')
      const chunk = result.value.subarray(0, remaining)
      chunks.push(chunk)
      size += chunk.byteLength
      if (truncate && size === limit) break
    }
    const output = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    return output
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function withDeadline<T>(parent: AbortSignal, timeout: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
  try {
    throwIfAborted(parent)
    return await action(controller.signal)
  } catch (error) {
    if (timedOut && !parent.aborted) throw new UpdateError('update.timeout')
    throw error
  } finally {
    clearTimeout(timer)
    parent.removeEventListener('abort', abort)
    controller.abort()
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new UpdateError('update.cancelled'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new UpdateError('update.cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function partialSize(path: string): Promise<number> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new UpdateError('update.cacheInvalid')
    return info.size
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
}

async function verifyFile(path: string, asset: UpdateAsset, signal?: AbortSignal): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.size !== asset.size) throw new UpdateError('update.downloadSize')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (signal) throwIfAborted(signal)
    hash.update(chunk as Buffer)
  }
  if (hash.digest('hex') !== asset.sha256.toLowerCase()) throw new UpdateError('update.downloadHash')
}

function percent(downloaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : 0
}
