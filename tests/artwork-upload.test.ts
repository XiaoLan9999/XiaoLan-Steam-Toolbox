import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtworkUploadService } from '../src/main/artwork-upload'
import { MAX_ARTWORK_FILE_BYTES } from '../src/shared/artwork'
import type { ArtworkBrowserState } from '../src/shared/artwork-browser'

const account = '76561198000000001'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
const resources: Array<{ directory: string; service: ArtworkUploadService }> = []

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.service.invalidate()
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'xiaolan-upload-test-'))
  const cache = join(directory, 'upload-cache')
  let active: string | null = account
  const state: ArtworkBrowserState = { tool: 'upload', phase: 'ready', accountId: account, canApplyLongArtwork: true, error: null }
  const browser = {
    open: vi.fn(async () => state),
    prepareUploadFile: vi.fn(async (_accountId: string, _filePath: string): Promise<void> => undefined),
    getState: vi.fn(() => ({ ...state }))
  }
  const service = new ArtworkUploadService({ directory: cache, browser: () => browser,
    isAccountCurrent: id => id === active })
  resources.push({ directory, service })
  return { service, browser, cache, setActive: (value: string | null) => { active = value } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('canvas artwork upload preparation', () => {
  it('writes validated PNG only inside an owned temporary directory and returns no file path', async () => {
    const test = fixture()
    const state = await test.service.prepare(account, { name: '../CON:main.png', base64: png })
    expect(test.browser.open).toHaveBeenCalledWith('upload', account, { reload: true })
    const [id, filePath] = test.browser.prepareUploadFile.mock.calls[0]!
    expect(id).toBe(account)
    expect(relative(test.cache, filePath)).not.toMatch(/^\.\./)
    expect(basename(filePath)).toBe('artwork-.._CON_main.png')
    expect(readFileSync(filePath)).toEqual(Buffer.from(png, 'base64'))
    expect(state).toMatchObject({ tool: 'upload', phase: 'ready', accountId: account })
    expect(JSON.stringify(state)).not.toContain(test.cache)
    expect(existsSync(filePath)).toBe(true)
    test.service.invalidate()
    expect(existsSync(filePath)).toBe(false)
  })

  it.each([
    null, {}, { name: '', base64: png }, { name: 'main.png', base64: '' },
    { name: 'main.png', base64: `data:image/png;base64,${png}` },
    { name: 'main.png', base64: `${png}\n` }, { name: 'main.png', base64: 'AA=A' },
    { name: 'main.png', base64: 'AB==' }
  ])('rejects malformed or non-canonical drafts before browser or disk operations', async draft => {
    const test = fixture()
    await expect(test.service.prepare(account, draft)).rejects.toMatchObject({ code: 'ARTWORK_INVALID_UPLOAD' })
    expect(test.browser.open).not.toHaveBeenCalled()
    expect(existsSync(test.cache)).toBe(false)
  })

  it('rejects oversized encoded payloads without decoding or touching the browser', async () => {
    const test = fixture()
    const large = 'A'.repeat(Math.ceil(MAX_ARTWORK_FILE_BYTES / 3) * 4 + 4)
    await expect(test.service.prepare(account, { name: 'main.png', base64: large }))
      .rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_TOO_LARGE' })
    expect(test.browser.open).not.toHaveBeenCalled()
  })

  it('rejects non-PNG content or image dimensions above the existing static artwork boundary', async () => {
    const test = fixture()
    await expect(test.service.prepare(account, { name: 'main.png', base64: Buffer.from('not a PNG').toString('base64') }))
      .rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_INVALID_IMAGE' })
    const image = Buffer.from(png, 'base64')
    image.writeUInt32BE(20_000, 16)
    await expect(test.service.prepare(account, { name: 'main.png', base64: image.toString('base64') }))
      .rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_INVALID_IMAGE' })
    expect(test.browser.open).not.toHaveBeenCalled()
  })

  it('requires the active account before accepting any draft', async () => {
    const test = fixture()
    test.setActive(null)
    await expect(test.service.prepare(account, { name: 'main.png', base64: png }))
      .rejects.toMatchObject({ code: 'ARTWORK_NOT_AUTHENTICATED' })
    expect(test.browser.open).not.toHaveBeenCalled()
  })

  it('cleans abandoned files and rejects account changes during page opening', async () => {
    const test = fixture()
    const opening = deferred<ArtworkBrowserState>()
    test.browser.open.mockImplementationOnce(() => opening.promise)
    const operation = test.service.prepare(account, { name: 'main.png', base64: png })
    await vi.waitFor(() => expect(test.browser.open).toHaveBeenCalledOnce())
    test.setActive(null)
    opening.resolve(test.browser.getState())
    await expect(operation).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    expect(test.browser.prepareUploadFile).not.toHaveBeenCalled()
    expect(readdirSync(test.cache)).toEqual([])
  })

  it('keeps only the newest preparation and ignores the superseded operation', async () => {
    const test = fixture()
    const opening = deferred<ArtworkBrowserState>()
    test.browser.open.mockImplementationOnce(() => opening.promise)
    const first = test.service.prepare(account, { name: 'main.png', base64: png })
    const firstError = first.catch(error => error)
    await vi.waitFor(() => expect(test.browser.open).toHaveBeenCalledOnce())
    const second = test.service.prepare(account, { name: 'side.png', base64: png })
    opening.resolve(test.browser.getState())
    expect(await firstError).toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
    await second
    expect(test.browser.prepareUploadFile).toHaveBeenCalledOnce()
    expect(basename(test.browser.prepareUploadFile.mock.calls[0]![1])).toBe('artwork-side.png')
    expect(readdirSync(test.cache)).toHaveLength(1)
  })

  it('removes previous retained artwork only when preparing the next piece or invalidating', async () => {
    const test = fixture()
    await test.service.prepare(account, { name: 'main.png', base64: png })
    const first = test.browser.prepareUploadFile.mock.calls[0]![1]
    expect(existsSync(first)).toBe(true)
    await test.service.prepare(account, { name: 'side.png', base64: png })
    expect(existsSync(first)).toBe(false)
    expect(existsSync(test.browser.prepareUploadFile.mock.calls[1]![1])).toBe(true)
  })

  it('rejects a result invalidated during file preparation instead of returning stale success', async () => {
    const test = fixture()
    const preparing = deferred<void>()
    test.browser.prepareUploadFile.mockImplementationOnce(() => preparing.promise)
    const operation = test.service.prepare(account, { name: 'main.png', base64: png })
    await vi.waitFor(() => expect(test.browser.prepareUploadFile).toHaveBeenCalledOnce())
    const filePath = test.browser.prepareUploadFile.mock.calls[0]![1]
    test.service.invalidate()
    expect(existsSync(filePath)).toBe(false)
    preparing.resolve()
    await expect(operation).rejects.toMatchObject({ code: 'ARTWORK_SESSION_CHANGED' })
  })

  it('does not expose raw browser errors or retain failed preparation files', async () => {
    const test = fixture()
    test.browser.prepareUploadFile.mockRejectedValueOnce(new Error('private fixture path and URL'))
    await expect(test.service.prepare(account, { name: 'main.png', base64: png }))
      .rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_PREPARE_FAILED', message: 'ARTWORK_UPLOAD_PREPARE_FAILED' })
    expect(readdirSync(test.cache)).toEqual([])
  })
})
