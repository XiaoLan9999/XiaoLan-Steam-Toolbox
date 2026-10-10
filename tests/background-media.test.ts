import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundMediaService } from '../src/main/background-media'
import { MAX_ARTWORK_FILE_BYTES } from '../src/shared/artwork'
import type { ProfileBackgroundCatalog, SteamProfileBackground } from '../src/shared/profile-backgrounds'

const ACCOUNT = '76561198000000001'
const OTHER_ACCOUNT = '76561198000000002'
const IMAGE = 'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.png'
const services: BackgroundMediaService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.invalidate()
  vi.useRealTimers()
})

function png(width = 1920, height = 1080, animated = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(animated ? 65 : 45)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  if (animated) { view.setUint32(33, 8); bytes.set([97, 99, 84, 76], 37) }
  bytes.set([73, 69, 78, 68], animated ? 57 : 37)
  return bytes
}

function jpeg(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x04, 0x38, 0x07, 0x80, 0x01, 0xff, 0xd9])
}

function background(overrides: Partial<SteamProfileBackground> = {}): SteamProfileBackground {
  return {
    id: 'item:1', title: 'Background', kind: 'static', imageUrl: IMAGE, stillImageUrl: IMAGE,
    videoUrl: null, equipped: true, source: 'profileItems', ...overrides
  }
}

function catalog(items = [background()], accountId = ACCOUNT): ProfileBackgroundCatalog {
  return { accountId, items, issues: [], ownedComplete: true, fetchedAt: new Date().toISOString() }
}

function createService(fetchImpl: typeof fetch, isAccountCurrent = (_accountId: string) => true): BackgroundMediaService {
  const service = new BackgroundMediaService({ fetchImpl, isAccountCurrent })
  services.push(service)
  service.setCatalog(catalog())
  return service
}

function imageResponse(bytes = png(), contentType = 'image/png', headers: Record<string, string> = {}): Response {
  return new Response(bytes, { headers: { 'Content-Type': contentType, ...headers } })
}

function fakeFetch(callback: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => Promise.resolve(callback(String(input), init ?? {}))) as unknown as typeof fetch
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe('BackgroundMediaService catalog and anonymous image transport', () => {
  it('loads an approved static PNG and returns only safe image data, never transport URLs', async () => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const image = await createService(fetchImpl).load(ACCOUNT, 'item:1')
    expect(image).toEqual({
      accountId: ACCOUNT, backgroundId: 'item:1', name: expect.stringMatching(/^steam-background-[a-f0-9]{12}\.png$/),
      mimeType: 'image/png', base64: Buffer.from(png()).toString('base64')
    })
    expect(JSON.stringify(image)).not.toContain('https://')
    expect(fetchImpl).toHaveBeenCalledWith(IMAGE, expect.objectContaining({
      method: 'GET', redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal),
      headers: { Accept: 'image/png,image/jpeg' }
    }))
  })

  it('accepts JPEG media with matching MIME and emits a safe .jpg filename', async () => {
    const service = createService(fakeFetch(() => imageResponse(jpeg(), 'image/jpeg; charset=binary')))
    service.setCatalog(catalog([background({ imageUrl: IMAGE.replace('.png', '.jpg') })]))
    expect(await service.load(ACCOUNT, 'item:1')).toMatchObject({
      name: expect.stringMatching(/\.jpg$/), mimeType: 'image/jpeg', base64: Buffer.from(jpeg()).toString('base64')
    })
  })

  it('does not trust catalog titles or background IDs as filenames', async () => {
    const service = createService(fakeFetch(() => imageResponse()))
    service.setCatalog(catalog([background({ id: 'item:1/../小蓝', title: '../../unsafe\r\nfilename.jpg' })]))
    const image = await service.load(ACCOUNT, 'item:1/../小蓝')
    expect(image.name).toMatch(/^steam-background-[a-f0-9]{12}\.png$/)
  })

  it.each(['item:missing', IMAGE, 'https://evil.example/image.png', '../arbitrary-file'])('does not request unregistered ID %s', async (id) => {
    const fetchImpl = fakeFetch(() => imageResponse())
    await expect(createService(fetchImpl).load(ACCOUNT, id)).rejects.toMatchObject({ code: 'BACKGROUND_NOT_FOUND' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an animated background without downloading its poster or video', async () => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl)
    service.setCatalog(catalog([background({ kind: 'animated', videoUrl: IMAGE.replace('.png', '.mp4') })]))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_ANIMATED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([null, 'https://evil.example/main.png', `${IMAGE}?access_token=secret`])('refuses a missing or unsafe cached image URL %s', async (imageUrl) => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl)
    service.setCatalog(catalog([background({ imageUrl })]))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_IMAGE_UNAVAILABLE' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clones cached metadata so outside mutations cannot change the approved media URL', async () => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl)
    const entries = catalog()
    service.setCatalog(entries)
    entries.items[0]!.imageUrl = 'https://evil.example/main.png'
    await service.load(ACCOUNT, 'item:1')
    expect(fetchImpl).toHaveBeenCalledWith(IMAGE, expect.anything())
  })

  it('does not accept conflicting duplicate IDs', async () => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl)
    service.setCatalog(catalog([background(), background({ imageUrl: IMAGE.replace('main.png', 'other.png') })]))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_NOT_FOUND' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects oversized catalogs and invalid accounts', () => {
    const service = createService(fakeFetch(() => imageResponse()))
    expect(() => service.setCatalog(catalog(Array.from({ length: 5001 }, () => background())))).toThrowError(expect.objectContaining({ code: 'BACKGROUND_NOT_FOUND' }))
    expect(() => service.setCatalog(catalog([], 'bad-account'))).toThrowError(expect.objectContaining({ code: 'BACKGROUND_NOT_FOUND' }))
  })

  it('keeps catalogs scoped per account without allowing IDs from another catalog', async () => {
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl)
    service.setCatalog(catalog([background({ id: 'item:2' })], OTHER_ACCOUNT))
    await expect(service.load(ACCOUNT, 'item:2')).rejects.toMatchObject({ code: 'BACKGROUND_NOT_FOUND' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('BackgroundMediaService HTTP boundaries and image validation', () => {
  it('follows at most five anonymous redirects to validated Steam CDN images', async () => {
    const fetchImpl = fakeFetch((url) => url.endsWith('/main.png')
      ? new Response(null, { status: 302, headers: { Location: IMAGE.replace('shared.akamai.', 'shared.fastly.').replace('main.png', 'final.png') } })
      : imageResponse())
    await createService(fetchImpl).load(ACCOUNT, 'item:1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [, init] of vi.mocked(fetchImpl).mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', method: 'GET' })
      expect(init?.headers).toEqual({ Accept: 'image/png,image/jpeg' })
    }
  })

  it('supports bounded same-CDN relative redirects', async () => {
    const fetchImpl = fakeFetch((url) => url.endsWith('/main.png')
      ? new Response(null, { status: 307, headers: { Location: 'final.png' } }) : imageResponse())
    await createService(fetchImpl).load(ACCOUNT, 'item:1')
    expect(fetchImpl).toHaveBeenLastCalledWith(IMAGE.replace('main.png', 'final.png'), expect.anything())
  })

  it.each([
    'https://evil.example/main.png', 'http://shared.akamai.steamstatic.com/community_assets/images/items/440/main.png',
    'https://user:pass@shared.akamai.steamstatic.com/community_assets/images/items/440/main.png',
    'https://shared.akamai.steamstatic.com/community_assets/images/items/440/main.png?token=secret',
    'https://shared.akamai.steamstatic.com/login/home/', 'https://127.0.0.1/main.png'
  ])('rejects a malicious redirect before requesting %s', async (location) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchImpl = fakeFetch(() => new Response(body, { status: 302, headers: { Location: location } }))
    await expect(createService(fetchImpl).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects redirect cycles after the initial request plus five redirects', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 302, headers: { Location: IMAGE } }))
    await expect(createService(fetchImpl).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('rejects silently followed redirects instead of bypassing the manual hop limit', async () => {
    const response = imageResponse()
    Object.defineProperty(response, 'redirected', { value: true })
    await expect(createService(fakeFetch(() => response)).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
  })

  it('rejects an untrusted final response URL even if an injected transport reports status 200', async () => {
    const response = imageResponse()
    Object.defineProperty(response, 'url', { value: 'https://evil.example/main.png?access_token=secret' })
    await expect(createService(fakeFetch(() => response)).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
  })

  it.each([204, 206, 304, 401, 403, 404, 429, 500])('requires a whole status 200 image instead of HTTP %d', async (status) => {
    const service = createService(fakeFetch(() => new Response(null, { status, headers: { 'Content-Type': 'image/png' } })))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
  })

  it.each(['text/html', 'application/octet-stream', 'image/svg+xml', 'image/gif'])('rejects unsupported MIME %s and cancels the body', async (contentType) => {
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': contentType } })))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_INVALID_IMAGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('requires declared MIME to agree with the actual image signature', async () => {
    await expect(createService(fakeFetch(() => imageResponse(png(), 'image/jpeg'))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_INVALID_IMAGE' })
  })

  it('rejects an animated PNG instead of treating it as a static background', async () => {
    await expect(createService(fakeFetch(() => imageResponse(png(1920, 1080, true)))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_ANIMATED' })
  })

  it('rejects truncated signatures and oversized pixel dimensions', async () => {
    await expect(createService(fakeFetch(() => imageResponse(png().slice(0, 33)))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_INVALID_IMAGE' })
    await expect(createService(fakeFetch(() => imageResponse(png(8000, 5000)))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_IMAGE_TOO_LARGE' })
  })

  it('cancels a response with declared length over 30 MiB before reading it', async () => {
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_ARTWORK_FILE_BYTES + 1) }
    })))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_IMAGE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a streamed response as soon as actual bytes exceed 30 MiB', async () => {
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_ARTWORK_FILE_BYTES + 1)) }, cancel
    }), { headers: { 'Content-Type': 'image/png' } })))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_IMAGE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['nope', '-1', '1.5'])('rejects malformed Content-Length %s', async (length) => {
    await expect(createService(fakeFetch(() => imageResponse(png(), 'image/png', { 'Content-Length': length }))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
  })

  it('does not accept a shorter body than its declared full size', async () => {
    await expect(createService(fakeFetch(() => imageResponse(png(), 'image/png', { 'Content-Length': '100' }))).load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
  })

  it('accepts a normal whole image with matching declared length', async () => {
    expect((await createService(fakeFetch(() => imageResponse(png(), 'image/png', { 'Content-Length': String(png().length) }))).load(ACCOUNT, 'item:1')).mimeType).toBe('image/png')
  })

  it('does not expose raw failed transport messages, URLs, or tokens to the renderer', async () => {
    const service = createService(fakeFetch(() => { throw new Error('failed https://evil.example/?access_token=super-secret') }))
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED', message: 'BACKGROUND_DOWNLOAD_FAILED' })
  })
})

describe('BackgroundMediaService cancellation, deadlines, and account races', () => {
  it('rejects account changes before any image request', async () => {
    let active = true
    const fetchImpl = fakeFetch(() => imageResponse())
    const service = createService(fetchImpl, () => active)
    active = false
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_SESSION_CHANGED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels a late response after account switches instead of leaking stale image bytes', async () => {
    let active = true
    const pending = deferred<Response>()
    const service = createService(fakeFetch(() => pending.promise), () => active)
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_SESSION_CHANGED' })
    const cancel = vi.fn()
    active = false
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'image/png' } }))
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a pending body read immediately when the user cancels', async () => {
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'image/png' } })))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_CANCELLED' })
    await flush()
    service.cancel()
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a late ignored-cancellation header response and closes its stream', async () => {
    const pending = deferred<Response>()
    const service = createService(fakeFetch(() => pending.promise))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_CANCELLED' })
    service.cancel()
    const cancel = vi.fn()
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'image/png' } }))
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('invalidates pending work and removes every cached account catalog', async () => {
    const pending = deferred<Response>()
    const service = createService(fakeFetch(() => pending.promise))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_SESSION_CHANGED' })
    service.invalidate()
    pending.resolve(imageResponse())
    await failure
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_NOT_FOUND' })
  })

  it('starts a new load without accepting the previous late result', async () => {
    const pending = deferred<Response>()
    let requests = 0
    const service = createService(fakeFetch(() => ++requests === 1 ? pending.promise : imageResponse()))
    const old = service.load(ACCOUNT, 'item:1')
    const oldFailure = expect(old).rejects.toMatchObject({ code: 'BACKGROUND_CANCELLED' })
    const current = await service.load(ACCOUNT, 'item:1')
    pending.resolve(imageResponse())
    await oldFailure
    expect(current.mimeType).toBe('image/png')
  })

  it('replacing a catalog cancels downloads based on its previous metadata', async () => {
    const pending = deferred<Response>()
    const service = createService(fakeFetch(() => pending.promise))
    const old = service.load(ACCOUNT, 'item:1')
    const failure = expect(old).rejects.toMatchObject({ code: 'BACKGROUND_CANCELLED' })
    service.setCatalog(catalog([background({ id: 'item:2' })]))
    pending.resolve(imageResponse())
    await failure
    await expect(service.load(ACCOUNT, 'item:1')).rejects.toMatchObject({ code: 'BACKGROUND_NOT_FOUND' })
  })

  it('aborts slow headers at eight seconds and returns a stable error', async () => {
    vi.useFakeTimers()
    let signal!: AbortSignal
    const service = createService(fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expect(signal.aborted).toBe(true)
  })

  it('aborts an idle stream at 45 seconds and cancels the reader', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'image/png' } })))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
    await flush()
    await vi.advanceTimersByTimeAsync(44_999)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('resets the idle deadline when real image bytes arrive', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { headers: { 'Content-Type': 'image/png' } })))
    const result = service.load(ACCOUNT, 'item:1')
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    controller.enqueue(png().slice(0, 33))
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    controller.enqueue(png().slice(33))
    controller.close()
    expect((await result).mimeType).toBe('image/png')
  })

  it('does not reset its deadline for zero-length non-progress chunks', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const service = createService(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel }), { headers: { 'Content-Type': 'image/png' } })))
    const result = service.load(ACCOUNT, 'item:1')
    const failure = expect(result).rejects.toMatchObject({ code: 'BACKGROUND_DOWNLOAD_FAILED' })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    controller.enqueue(new Uint8Array(0))
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })
})
