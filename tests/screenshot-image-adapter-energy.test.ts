import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotBrowserImageAdapter } from '../src/main/screenshot-image-adapter'

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{ destroyed: boolean; destroy: ReturnType<typeof vi.fn>; webContents: { executeJavaScript: ReturnType<typeof vi.fn> } }>,
  execute: vi.fn(), load: vi.fn()
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      executeJavaScript: mocks.execute,
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } }
    })
    constructor() { super(); mocks.windows.push(this) }
    isDestroyed(): boolean { return this.destroyed }
    destroy = vi.fn(() => { this.destroyed = true })
    loadURL = mocks.load
  } }
})

const adapters: ScreenshotBrowserImageAdapter[] = []
const converted = { width: 100, height: 50, preview: Buffer.from('synthetic-preview').toString('base64'),
  jpeg: Buffer.from('synthetic-jpeg').toString('base64'), thumbnail: Buffer.from('synthetic-thumbnail').toString('base64') }
const options = { quality: 85, width: 100, height: 50, thumbnailWidth: 20, thumbnailHeight: 10 }
function fixture(): ScreenshotBrowserImageAdapter { const adapter = new ScreenshotBrowserImageAdapter(); adapters.push(adapter); return adapter }
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve, reject }
}

beforeEach(() => {
  mocks.windows.splice(0)
  mocks.execute.mockReset().mockResolvedValue(converted)
  mocks.load.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); vi.useRealTimers() })

describe('idle screenshot graphics-worker release', () => {
  it('does not create a renderer just to release an idle worker', () => {
    expect(fixture().releaseIdleWorker()).toBe(false)
    expect(mocks.windows).toHaveLength(0)
  })

  it('releases only its idle renderer and creates a new one on later conversion', async () => {
    const adapter = fixture()
    const source = Buffer.from('synthetic-source')
    expect(await adapter.inspect(source)).toEqual({ width: 100, height: 50, previewJpeg: Buffer.from('synthetic-preview') })
    expect(adapter.releaseIdleWorker()).toBe(true)
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(source.toString()).toBe('synthetic-source')
    expect(adapter.releaseIdleWorker()).toBe(false)
    expect(await adapter.encode(source, options)).toEqual({ jpeg: Buffer.from('synthetic-jpeg'), thumbnail: Buffer.from('synthetic-thumbnail') })
    expect(mocks.windows).toHaveLength(2)
    expect(mocks.windows[1]!.destroy).not.toHaveBeenCalled()
  })

  it('defers release while converting and releases immediately after the last result is safe', async () => {
    const adapter = fixture()
    const result = pending<typeof converted>()
    mocks.execute.mockReturnValueOnce(result.promise)
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce())
    expect(adapter.releaseIdleWorker()).toBe(false)
    expect(mocks.windows[0]!.destroy).not.toHaveBeenCalled()
    result.resolve(converted)
    expect((await inspection).previewJpeg).toEqual(Buffer.from('synthetic-preview'))
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('does not interrupt overlapping conversions when an earlier one finishes first', async () => {
    const adapter = fixture()
    const first = pending<typeof converted>(), second = pending<typeof converted>()
    mocks.execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    const encoding = adapter.encode(Buffer.from('synthetic-source'), options)
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    expect(adapter.releaseIdleWorker()).toBe(false)
    first.resolve(converted)
    await inspection
    expect(mocks.windows[0]!.destroy).not.toHaveBeenCalled()
    second.resolve(converted)
    await encoding
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('defers release during renderer initialization too', async () => {
    const adapter = fixture()
    const loaded = pending<void>()
    mocks.load.mockReturnValueOnce(loaded.promise)
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    expect(adapter.releaseIdleWorker()).toBe(false)
    expect(mocks.windows[0]!.destroy).not.toHaveBeenCalled()
    loaded.resolve()
    await inspection
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('releases a renderer after a failed active conversion and permits a retry', async () => {
    const adapter = fixture()
    const result = pending<typeof converted>()
    mocks.execute.mockReturnValueOnce(result.promise)
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    const rejected = expect(inspection).rejects.toThrow('synthetic invalid image')
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce())
    adapter.releaseIdleWorker()
    result.reject(new Error('synthetic invalid image'))
    await rejected
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
    await expect(adapter.inspect(Buffer.from('synthetic-source'))).resolves.toHaveProperty('width', 100)
    expect(mocks.windows).toHaveLength(2)
  })

  it('preserves explicit close and dispose cancellation instead of returning stale graphics results', async () => {
    const adapter = fixture()
    const result = pending<typeof converted>()
    mocks.execute.mockReturnValueOnce(result.promise)
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    const rejected = expect(inspection).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce())
    adapter.dispose()
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
    result.resolve(converted)
    await rejected
    await expect(adapter.inspect(Buffer.from('synthetic-source'))).rejects.toMatchObject({ code: 'SCREENSHOT_CANCELLED' })
    expect(mocks.windows).toHaveLength(1)
  })

  it('keeps conversion timeout bounded and releases its timer and activity count', async () => {
    vi.useFakeTimers()
    const adapter = fixture()
    mocks.execute.mockReturnValueOnce(new Promise(() => undefined))
    const inspection = adapter.inspect(Buffer.from('synthetic-source'))
    const rejected = expect(inspection).rejects.toMatchObject({ code: 'SCREENSHOT_IMAGE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(0)
    adapter.releaseIdleWorker()
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(adapter.releaseIdleWorker()).toBe(false)
    await expect(adapter.inspect(Buffer.from('synthetic-source'))).resolves.toHaveProperty('width', 100)
    expect(mocks.windows).toHaveLength(2)
  })
})
