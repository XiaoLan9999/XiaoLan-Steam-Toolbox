import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_DOWNLOAD_TIMEOUT_MS, UPDATE_MANIFEST_LIMIT, UPDATE_PROBE_BYTES,
  UPDATE_PROBE_TIMEOUT_MS, UpdateService
} from '../src/main/update-service'
import { UPDATE_KEY_ID } from '../src/shared/update-public-key'
import {
  BUILTIN_UPDATE_ROUTES, DEFAULT_UPDATE_PREFERENCES, UPDATE_MANIFEST_URL, UPDATE_REPOSITORY,
  type SignedUpdateManifest, type UpdateManifest, type UpdatePreferences, type UpdateState
} from '../src/shared/update-types'

const key = generateKeyPairSync('ed25519')
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(160 * 1024 - 2, 0x58)])
const directories: string[] = []
const services: UpdateService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.shutdown()
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('UpdateService manifest routing', () => {
  it('waits for all verified manifests and selects the newest rather than the fastest old mirror', async () => {
    const current = fixture('0.3.0')
    const latest = fixture('0.4.0')
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    const started = deferred()
    const fetchImpl = fakeFetch(async (url) => {
      started.resolve()
      if (url.startsWith('https://ghfast.top/')) {
        await delayed
        return json(latest.envelope)
      }
      return json(current.envelope)
    })
    const service = await createService(fetchImpl)
    const result = service.checkForUpdates()
    await started.promise
    expect(service.getState().phase).toBe('checking')
    release()
    const state = await result
    expect(state.phase).toBe('available')
    expect(state.latestVersion).toBe('0.4.0')
    expect(state.routes.find((route) => route.id === 'github')).toMatchObject({ status: 'failed', error: 'update.staleManifest' })
    expect(state.routes.find((route) => route.id === 'ghfast')).toMatchObject({ status: 'available', error: null })
  })

  it('does not let a forged higher version displace a signed release', async () => {
    const latest = fixture('0.4.0')
    const forged = { ...fixture('99.0.0').envelope, signature: latest.envelope.signature }
    const service = await createService(fakeFetch(async (url) => json(url.startsWith('https://github.com/') ? latest.envelope : forged)))
    const state = await service.checkForUpdates()
    expect(state.latestVersion).toBe('0.4.0')
    expect(state.routes.filter((route) => route.status === 'failed').every((route) => route.error === 'update.manifestSignature')).toBe(true)
  })

  it.each([
    ['HTML response', () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'update.invalidResponse'],
    ['invalid JSON', () => new Response('{oops'), 'update.invalidResponse'],
    ['HTTP error', () => new Response('blocked', { status: 403 }), 'update.httpError'],
    ['untrusted object', () => json({ version: '0.4.0' }), 'update.manifestSignature'],
    ['declared oversized body', () => new Response('{}', { headers: { 'Content-Length': String(UPDATE_MANIFEST_LIMIT + 1) } }), 'update.manifestTooLarge'],
    ['streamed oversized body', () => new Response(new Uint8Array(UPDATE_MANIFEST_LIMIT + 1)), 'update.manifestTooLarge']
  ])('rejects %s without accepting an update', async (_name, response, code) => {
    const service = await createService(fakeFetch(async () => response()), { preferences: officialOnly })
    const state = await service.checkForUpdates()
    expect(state.phase).toBe('error')
    expect(state.latestVersion).toBeNull()
    expect(state.routes[0]?.error).toBe(code)
  })

  it('uses only anonymous headers and sanitized HTTPS redirects', async () => {
    const latest = fixture('0.4.0')
    const calls: { url: string; init?: RequestInit }[] = []
    const service = await createService(fakeFetch(async (url, init) => {
      calls.push({ url, init })
      if (url === UPDATE_MANIFEST_URL) return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/signed-manifest?token=opaque' } })
      return json(latest.envelope)
    }), { preferences: officialOnly })
    expect((await service.checkForUpdates()).phase).toBe('available')
    expect(calls).toHaveLength(2)
    for (const { init } of calls) {
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('cookie')).toBeNull()
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
    }
    expect(JSON.stringify(service.getState())).not.toContain('token=opaque')
  })

  it.each(['http://unsafe.example/file', 'https://user:password@example.com/file'])('rejects unsafe redirect %s', async (location) => {
    const service = await createService(fakeFetch(async () => new Response(null, { status: 302, headers: { Location: location } })), { preferences: officialOnly })
    expect((await service.checkForUpdates()).routes[0]?.error).toBe('update.redirectInvalid')
  })

  it('limits redirect chains and never displays the redirect target', async () => {
    const fetchImpl = fakeFetch(async () => new Response(null, { status: 302, headers: { Location: 'https://cdn.example/auth?secret=opaque' } }))
    const service = await createService(fetchImpl, { preferences: officialOnly })
    const state = await service.checkForUpdates()
    expect(state.routes[0]?.error).toBe('update.redirectLimit')
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(JSON.stringify(state)).not.toContain('opaque')
  })

  it('times out a stalled manifest request even if the fetch mock ignores AbortSignal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = deferred()
    const service = await createService(fakeFetch(async () => { started.resolve(); return new Promise<Response>(() => undefined) }), { preferences: officialOnly })
    const result = service.checkForUpdates()
    await started.promise
    await vi.advanceTimersByTimeAsync(UPDATE_PROBE_TIMEOUT_MS + 1)
    expect((await result).routes[0]?.error).toBe('update.timeout')
  })

  it('coalesces concurrent checks and returns an isolated state copy', async () => {
    const latest = fixture('0.4.0')
    const fetchImpl = fakeFetch(async () => json(latest.envelope))
    const service = await createService(fetchImpl, { preferences: officialOnly })
    const first = service.checkForUpdates()
    expect(service.checkForUpdates()).toBe(first)
    await first
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const copy = service.getState()
    copy.routes.length = 0
    expect(service.getState().routes).toHaveLength(1)
  })

  it('normalizes custom prefixes, excludes unsafe routes, and disables all mirrors together', async () => {
    const latest = fixture('0.4.0')
    let preferences: UpdatePreferences = { autoCheck: false, useMirrors: true, customMirrors: [
      'https://mirror.example/prefix', 'https://mirror.example/prefix/', 'http://insecure.example/',
      'https://user:pass@mirror.example/', 'https://mirror.example/?token=x', 'https://mirror.example/#hash'
    ] }
    const calls: string[] = []
    const service = await createService(fakeFetch(async (url) => { calls.push(url); return json(latest.envelope) }), { preferences: () => preferences })
    const state = await service.checkForUpdates()
    expect(state.routes).toHaveLength(BUILTIN_UPDATE_ROUTES.length + 1)
    expect(calls).toContain(`https://mirror.example/prefix/${UPDATE_MANIFEST_URL}`)
    preferences = { ...preferences, useMirrors: false }
    expect((await service.checkForUpdates()).routes.map((route) => route.id)).toEqual(['github'])
  })
})

describe('UpdateService streaming download', () => {
  it('downloads the selected package, verifies hash and size, and rechecks it before installation', async () => {
    const latest = fixture('0.4.0')
    const fetchImpl = standardFetch(latest)
    const states: UpdateState[] = []
    const service = await createService(fetchImpl, { preferences: officialOnly, onStateChange: (state) => states.push(state) })
    await service.checkForUpdates()
    expect((await service.downloadUpdate()).phase).toBe('ready')
    const ready = await service.getReadyUpdate()
    expect(ready.asset.kind).toBe('portable')
    expect(await readFile(ready.path)).toEqual(body)
    expect(states.some((state) => state.phase === 'downloading' && state.downloadedBytes > 0)).toBe(true)
    await writeFile(ready.path, Buffer.alloc(body.length, 0))
    await expect(service.getReadyUpdate()).rejects.toThrow('update.downloadHash')
    expect(service.getState().phase).toBe('error')
  })

  it('streams progress with at least 250 ms between intermediate byte updates', async () => {
    const latest = fixture('0.4.0')
    const progress: { bytes: number; time: number }[] = []
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).has('range')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      let offset = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (offset === body.length) { controller.close(); return }
          await new Promise((resolve) => setTimeout(resolve, 20))
          controller.enqueue(new Uint8Array(body.subarray(offset, offset + 8192)))
          offset += 8192
        }
      }))
    }), { preferences: officialOnly, onStateChange: (state) => {
      if (state.phase === 'downloading' && state.downloadedBytes > 0 && state.downloadedBytes < body.length &&
          progress.at(-1)?.bytes !== state.downloadedBytes) {
        progress.push({ bytes: state.downloadedBytes, time: performance.now() })
      }
    } })
    await service.checkForUpdates()
    expect((await service.downloadUpdate()).phase).toBe('ready')
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.length).toBeLessThan(20)
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.time - progress[index - 1]!.time).toBeGreaterThanOrEqual(249)
    }
  })

  it('caps an ignored Range probe at 64 KiB even when the server advertises a 100 MB body', async () => {
    const latest = fixture('0.4.0')
    let produced = 0
    let cancelled = false
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).get('range')?.startsWith('bytes=0-')) {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(body.subarray(produced, produced + 16 * 1024)))
            produced += 16 * 1024
          },
          cancel() { cancelled = true }
        }), { headers: { 'Content-Length': String(100 * 1024 * 1024) } })
      }
      return binary(body)
    })
    const service = await createService(fetchImpl, { preferences: officialOnly })
    await service.checkForUpdates()
    expect((await service.downloadUpdate()).phase).toBe('ready')
    expect(cancelled).toBe(true)
    expect(produced).toBeLessThanOrEqual(UPDATE_PROBE_BYTES + 16 * 1024)
  })

  it.each([
    ['HTML disguised as binary', Buffer.from('<html>Sign in first</html>')],
    ['one-byte EXE prefix', Buffer.from('M')]
  ])('does not rank a %s probe as a fast download route and can retry a full transfer', async (_name, probeBody) => {
    const latest = fixture('0.4.0')
    const observed: UpdateState[] = []
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).has('range')) {
        return new Response(new Uint8Array(probeBody), { headers: { 'Content-Type': 'application/octet-stream' } })
      }
      return binary(body)
    })
    const service = await createService(fetchImpl, { preferences: officialOnly, onStateChange: (state) => observed.push(state) })
    await service.checkForUpdates()
    expect((await service.downloadUpdate()).phase).toBe('ready')
    expect(observed.some((state) => state.routes[0]?.error === 'update.invalidResponse' &&
      state.routes[0]?.speedBytesPerSecond === 0)).toBe(true)
    expect(await readFile((await service.getReadyUpdate()).path)).toEqual(body)
  })

  it('falls back after a disconnect and resumes only with a validated 206 start and total', async () => {
    const latest = fixture('0.4.0')
    const calls: { url: string; range: string | null }[] = []
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      const range = new Headers(init?.headers).get('range')
      calls.push({ url, range })
      if (range?.startsWith('bytes=0-')) return binary(body.subarray(0, UPDATE_PROBE_BYTES), 206, `bytes 0-${UPDATE_PROBE_BYTES - 1}/${body.length}`)
      if (url.startsWith('https://github.com/')) return interrupted(body.subarray(0, 32 * 1024))
      const position = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0
      return binary(body.subarray(position), position > 0 ? 206 : 200, position > 0 ? `bytes ${position}-${body.length - 1}/${body.length}` : undefined)
    })
    const service = await createService(fetchImpl)
    await service.checkForUpdates()
    expect((await service.downloadUpdate('github')).phase).toBe('ready')
    expect(calls.some((call) => !call.url.startsWith('https://github.com/') && call.range === 'bytes=32768-')).toBe(true)
    expect(await readFile((await service.getReadyUpdate()).path)).toEqual(body)
  })

  it('restarts from zero when a fallback server ignores the resume Range', async () => {
    const latest = fixture('0.4.0')
    let resumeRequested = false
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      const range = new Headers(init?.headers).get('range')
      if (range?.startsWith('bytes=0-')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      if (url.startsWith('https://github.com/')) return interrupted(body.subarray(0, 32 * 1024))
      resumeRequested ||= range === 'bytes=32768-'
      return binary(body)
    })
    const service = await createService(fetchImpl)
    await service.checkForUpdates()
    expect((await service.downloadUpdate('github')).phase).toBe('ready')
    expect(resumeRequested).toBe(true)
    expect((await stat((await service.getReadyUpdate()).path)).size).toBe(body.length)
  })

  it('discards a wrong hash before downloading from another verified route', async () => {
    const latest = fixture('0.4.0')
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).has('range')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      return binary(url.startsWith('https://github.com/') ? Buffer.alloc(body.length, 0) : body)
    }))
    await service.checkForUpdates()
    const state = await service.downloadUpdate('github')
    expect(state.phase).toBe('ready')
    expect(state.routes.find((route) => route.id === 'github')?.error).toBe('update.downloadHash')
    expect(await readFile((await service.getReadyUpdate()).path)).toEqual(body)
  })

  it.each([
    ['wrong hash', () => binary(Buffer.alloc(body.length, 0)), 'update.downloadHash'],
    ['too much data', () => binary(Buffer.alloc(body.length + 1)), 'update.downloadSize'],
    ['short completed stream', () => binary(body.subarray(0, 100), 200, undefined, false), 'update.downloadInterrupted'],
    ['HTML installer', () => new Response('<html>not a download</html>', { headers: { 'Content-Type': 'text/html' } }), 'update.invalidResponse'],
    ['incorrect content range', () => binary(body, 206, `bytes 1-${body.length}/${body.length + 1}`), 'update.downloadSize']
  ])('never marks a %s ready', async (_name, response, code) => {
    const latest = fixture('0.4.0')
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).get('range')?.startsWith('bytes=0-')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      return response()
    }), { preferences: officialOnly })
    await service.checkForUpdates()
    const state = await service.downloadUpdate()
    expect(state.phase).toBe('error')
    expect(state.error).toBe(code)
    await expect(service.getReadyUpdate()).rejects.toThrow('update.noUpdate')
  })

  it('rejects a manually selected stale or unknown route before downloading', async () => {
    const latest = fixture('0.4.0')
    const old = fixture('0.3.0')
    const fetchImpl = fakeFetch(async (url) => json(url.startsWith('https://github.com/') ? latest.envelope : old.envelope))
    const service = await createService(fetchImpl)
    await service.checkForUpdates()
    expect((await service.downloadUpdate('ghfast')).error).toBe('update.routeUnavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(BUILTIN_UPDATE_ROUTES.length)
    expect((await service.downloadUpdate('custom-not-listed')).error).toBe('update.routeUnavailable')
  })

  it('coalesces concurrent download and check calls into the existing operation', async () => {
    const latest = fixture('0.4.0')
    const service = await createService(standardFetch(latest), { preferences: officialOnly })
    await service.checkForUpdates()
    const download = service.downloadUpdate()
    expect(service.downloadUpdate()).toBe(download)
    expect(service.checkForUpdates()).toBe(download)
    expect((await download).phase).toBe('ready')
  })

  it('cancels a stalled request immediately and allows a later check', async () => {
    const latest = fixture('0.4.0')
    let stalled = true
    const started = deferred()
    const service = await createService(fakeFetch(async () => {
      if (stalled) { started.resolve(); return new Promise<Response>(() => undefined) }
      return json(latest.envelope)
    }), { preferences: officialOnly })
    const checking = service.checkForUpdates()
    await started.promise
    service.cancel()
    expect((await checking).error).toBe('update.cancelled')
    stalled = false
    expect((await service.checkForUpdates()).phase).toBe('available')
  })

  it('cancels a partial stream without ever becoming ready and keeps the safe partial for resumption', async () => {
    const latest = fixture('0.4.0')
    const wrote = deferred()
    let resumed = false
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      const range = new Headers(init?.headers).get('range')
      if (range?.startsWith('bytes=0-')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      if (range === 'bytes=32768-') { resumed = true; return binary(body.subarray(32768), 206, `bytes 32768-${body.length - 1}/${body.length}`) }
      let delivered = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) { delivered = true; controller.enqueue(new Uint8Array(body.subarray(0, 32768))); return }
          return new Promise<void>(() => undefined)
        }
      }))
    }), { preferences: officialOnly, onStateChange: (state) => { if (state.downloadedBytes === 32768) wrote.resolve() } })
    await service.checkForUpdates()
    const downloading = service.downloadUpdate()
    await wrote.promise
    service.cancel()
    expect((await downloading).phase).toBe('available')
    expect(service.getState().error).toBe('update.cancelled')
    expect((await service.downloadUpdate()).phase).toBe('ready')
    expect(resumed).toBe(true)
  })

  it('times out a stalled download body and returns a sanitized error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const latest = fixture('0.4.0')
    const started = deferred()
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      if (new Headers(init?.headers).has('range')) return binary(body.subarray(0, UPDATE_PROBE_BYTES))
      started.resolve()
      return new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined) } }))
    }), { preferences: officialOnly })
    await service.checkForUpdates()
    const downloading = service.downloadUpdate()
    await started.promise
    await vi.advanceTimersByTimeAsync(UPDATE_DOWNLOAD_TIMEOUT_MS + 1)
    const state = await downloading
    expect(state.phase).toBe('error')
    expect(state.error).toBe('update.timeout')
  })
})

describe('UpdateService signed persistent cache', () => {
  it('restores a ready cache across restarts only after signature, size and hash verification', async () => {
    const latest = fixture('0.4.0')
    const cacheDirectory = await temporaryDirectory()
    const first = await createService(standardFetch(latest), { cacheDirectory, preferences: officialOnly })
    await first.checkForUpdates()
    await first.downloadUpdate()
    first.shutdown()
    const fetchImpl = fakeFetch(async () => { throw new Error('must not fetch') })
    const restored = await createService(fetchImpl, { cacheDirectory })
    expect(await restored.getReadyUpdate()).toMatchObject({ manifest: { version: '0.4.0' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves the highest signed version and excludes replayed older mirror manifests across restarts', async () => {
    const newest = fixture('0.5.0')
    const older = fixture('0.4.0')
    const cacheDirectory = await temporaryDirectory()
    const first = await createService(standardFetch(newest), { cacheDirectory, preferences: officialOnly })
    await first.checkForUpdates()
    first.shutdown()
    const restored = await createService(standardFetch(older), { cacheDirectory })
    const state = await restored.checkForUpdates()
    expect(state.latestVersion).toBe('0.5.0')
    expect(state.phase).toBe('error')
    expect(state.routes.every((route) => route.error === 'update.staleManifest')).toBe(true)
    const saved = JSON.parse(await readFile(join(cacheDirectory, 'highest-manifest.json'), 'utf8')) as SignedUpdateManifest
    expect(saved.payload).toBe(newest.envelope.payload)
  })

  it('rejects a modified signed cache again immediately before installation', async () => {
    const latest = fixture('0.4.0')
    const cacheDirectory = await temporaryDirectory()
    const service = await createService(standardFetch(latest), { cacheDirectory, preferences: officialOnly })
    await service.checkForUpdates()
    await service.downloadUpdate()
    await writeFile(join(cacheDirectory, 'highest-manifest.json'), JSON.stringify({ ...latest.envelope, signature: fixture('0.5.0').envelope.signature }))
    await expect(service.getReadyUpdate()).rejects.toThrow('update.manifestSignature')
    expect(service.getState().phase).toBe('error')
  })

  it('does not inherit ready from an older package when a newer signed manifest arrives', async () => {
    let latest = fixture('0.4.0')
    const observed: UpdateState[] = []
    const service = await createService(fakeFetch(async (url, init) => {
      if (url.endsWith('update-manifest.json')) return json(latest.envelope)
      return new Headers(init?.headers).has('range') ? binary(body.subarray(0, UPDATE_PROBE_BYTES)) : binary(body)
    }), { preferences: officialOnly, onStateChange: (state) => observed.push(state) })
    await service.checkForUpdates()
    await service.downloadUpdate()
    latest = fixture('0.5.0')
    observed.length = 0
    const state = await service.checkForUpdates()
    expect(state.phase).toBe('available')
    expect(state.latestVersion).toBe('0.5.0')
    expect(observed.some((entry) => entry.latestVersion === '0.5.0' && entry.phase === 'ready')).toBe(false)
    await expect(service.getReadyUpdate()).rejects.toThrow('update.noUpdate')
  })

  it('a cache for the current or older installed version cannot be installed as an update', async () => {
    const cacheDirectory = await temporaryDirectory()
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(join(cacheDirectory, 'highest-manifest.json'), JSON.stringify(fixture('0.3.0').envelope))
    const service = await createService(standardFetch(fixture('0.3.0')), { cacheDirectory, preferences: officialOnly })
    expect((await service.checkForUpdates()).phase).toBe('upToDate')
    expect((await service.downloadUpdate()).error).toBe('update.noUpdate')
  })
})

function officialOnly(): UpdatePreferences {
  return { ...DEFAULT_UPDATE_PREFERENCES, useMirrors: false }
}

function fixture(version: string, data = body): { manifest: UpdateManifest; envelope: SignedUpdateManifest; data: Buffer } {
  const manifest: UpdateManifest = {
    schema: 1, repository: UPDATE_REPOSITORY, version,
    publishedAt: new Date().toISOString(), releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,
    assets: (['setup', 'portable'] as const).map((kind) => {
      const fileName = `XiaoLan-Steam-Toolbox-${kind === 'setup' ? 'Setup' : 'Portable'}-${version}-x64.exe`
      return { kind, fileName, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
        downloadUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${fileName}` }
    })
  }
  const payload = Buffer.from(JSON.stringify(manifest))
  return { manifest, data, envelope: { schema: 1, keyId: UPDATE_KEY_ID, payload: payload.toString('base64'), signature: sign(null, payload, key.privateKey).toString('base64') } }
}

function fakeFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => implementation(String(input), init)) as typeof fetch
}

function standardFetch(latest: ReturnType<typeof fixture>): typeof fetch {
  return fakeFetch(async (url, init) => {
    if (url.endsWith('update-manifest.json')) return json(latest.envelope)
    const range = new Headers(init?.headers).get('range')
    if (range?.startsWith('bytes=0-')) return binary(latest.data.subarray(0, UPDATE_PROBE_BYTES))
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0
    return binary(latest.data.subarray(start), start > 0 ? 206 : 200,
      start > 0 ? `bytes ${start}-${latest.data.length - 1}/${latest.data.length}` : undefined)
  })
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

function binary(data: Buffer, status = 200, range?: string, declareSize = true): Response {
  return new Response(new Uint8Array(data), { status, headers: {
    ...(declareSize ? { 'Content-Length': String(data.length) } : {}), ...(range ? { 'Content-Range': range } : {})
  } })
}

function interrupted(data: Buffer): Response {
  let delivered = false
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) { delivered = true; controller.enqueue(new Uint8Array(data)) }
      else controller.error(new Error('connection closed at https://cdn.example/?auth=do-not-show'))
    }
  }))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'xiaolan-update-test-'))
  directories.push(path)
  return path
}

async function createService(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}): Promise<UpdateService> {
  const cacheDirectory = extra.cacheDirectory ?? await temporaryDirectory()
  const service = new UpdateService({ currentVersion: '0.3.0', packageKind: 'portable', cacheDirectory,
    preferences: () => ({ ...DEFAULT_UPDATE_PREFERENCES }), onStateChange: () => undefined, fetchImpl, publicKey, ...extra })
  services.push(service)
  return service
}
