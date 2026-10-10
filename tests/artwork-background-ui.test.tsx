import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ArtworkError, MAX_ARTWORK_FILE_BYTES, defaultArtworkCrop } from '../src/shared/artwork'
import type { ProfileBackgroundCatalog } from '../src/shared/profile-backgrounds'
import {
  ArtworkCropUploadButtons,
  ProfileBackgroundPicker,
  artworkBlobBase64,
  artworkBrowserError,
  createArtworkCropPngs,
  profileBackgroundError
} from '../src/renderer/src/components/ArtworkToolsPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const catalog: ProfileBackgroundCatalog = {
  accountId: 'account-1', fetchedAt: '2026-10-11T00:00:00.000Z', ownedComplete: true, issues: [],
  items: [
    { id: 'equipped-static', title: 'Summer background', kind: 'static', imageUrl: 'https://cdn.example.invalid/original.jpg', stillImageUrl: null, videoUrl: null, equipped: true, source: 'profileItems' },
    { id: 'animated', title: 'Animated sky', kind: 'animated', imageUrl: null, stillImageUrl: 'https://cdn.example.invalid/cover.jpg', videoUrl: 'https://cdn.example.invalid/movie.webm', equipped: false, source: 'profileItems' },
    { id: 'missing-original', title: 'No original image', kind: 'static', imageUrl: null, stillImageUrl: null, videoUrl: null, equipped: false, source: 'inventory' }
  ]
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof ProfileBackgroundPicker>> = {}, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language, children: React.createElement(ProfileBackgroundPicker, {
      catalog, authenticated: true, loading: false, imageLoading: false, selectedId: 'equipped-static',
      onRefresh: () => undefined, onSelect: () => undefined, onCancel: () => undefined, ...overrides
    })
  }))
}

describe('account background selection UI', () => {
  it('labels equipped and original static backgrounds and sends animations to the embedded tool', () => {
    const html = renderPicker()
    expect(html).toContain('当前账号的 Steam 背景')
    expect(html).toContain('已获取 3 个背景')
    expect(html).toContain('正在使用')
    expect(html).toContain('静态原图 · 自动裁剪')
    expect(html).toContain('动画 · 打开内置工具')
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('https://cdn.example.invalid')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href=')
  })

  it('does not pretend that a missing original image can be cropped', () => {
    const html = renderPicker()
    expect(html).toMatch(/disabled=""[^>]*><span[^>]*>▧<\/span><strong>No original image/)
    expect(html).toContain('原图暂不可用')
    expect(html).not.toMatch(/disabled=""[^>]*><span[^>]*>▷<\/span><strong>Animated sky/)
  })

  it.each([{ loading: true }, { imageLoading: true }])('keeps cancel available while loading %s', state => {
    const html = renderPicker(state)
    expect(html).toContain('<button>取消获取</button>')
    expect(html).toMatch(/disabled=""[^>]*><span[^>]*>▧<\/span><strong>Summer background/)
  })

  it('disables account retrieval without sign-in but explains independent local cropping', () => {
    const html = renderPicker({ catalog: null, authenticated: false })
    expect(html).toMatch(/disabled=""[^>]*>获取账号背景/)
    expect(html).toContain('仍可导入本地图片裁剪')
    expect(html).not.toContain('Summer background')
  })

  it('shows partial retrieval instead of claiming all owned backgrounds were found', () => {
    const html = renderPicker({ catalog: { ...catalog, ownedComplete: false, issues: ['inventoryPartial', 'unsupportedItems'] } })
    expect(html).toContain('拥有列表可能不完整')
    expect(html).toContain('库存仅获取了部分页面')
    expect(html).toContain('未以缩略图代替')
  })

  it('escapes remote background names and translates all statuses', () => {
    const html = renderPicker({ catalog: { ...catalog, items: [{ ...catalog.items[0]!, title: '<img onerror="bad()">' }], issues: ['profileUnavailable', 'ownedUnavailable', 'inventoryUnavailable', 'inventoryPartial', 'unsupportedItems'] } }, 'en')
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toContain('<img onerror=')
    expect(html).toContain('Original static image · Auto crop')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })
})

describe('generated crop upload controls', () => {
  function renderButtons(authenticated: boolean, busy = false, language: 'zh-CN' | 'en' = 'zh-CN'): string {
    return renderToStaticMarkup(React.createElement(I18nProvider, {
      language, children: React.createElement(ArtworkCropUploadButtons, {
        drafts: [{ name: 'main', width: 506, height: 824 }, { name: 'side', width: 100, height: 824 }],
        authenticated, busy, onPrepare: () => undefined
      })
    }))
  }

  it('offers separate main and side uploads at original dimensions without a publish action', () => {
    const html = renderButtons(true)
    expect(html).toContain('准备主图上传')
    expect(html).toContain('准备侧图上传')
    expect(html).toContain('506 × 824 PNG')
    expect(html).toContain('100 × 824 PNG')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('自动发布')
  })

  it.each([[false, false], [true, true]])('disables preparation for unauthenticated or busy sessions', (authenticated, busy) => {
    expect(renderButtons(authenticated, busy)).toMatch(/disabled=""[^>]*>准备主图上传/)
    expect(renderButtons(authenticated, busy)).toMatch(/disabled=""[^>]*>准备侧图上传/)
  })

  it('translates preparation controls to English', () => {
    const html = renderButtons(true, false, 'en')
    expect(html).toContain('Prepare main upload')
    expect(html).toContain('Prepare side upload')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })
})

describe('automatic original-pixel PNG generation', () => {
  const image = {} as HTMLImageElement
  function canvasFactory(blob: Blob | null = new Blob([new Uint8Array([137, 80, 78, 71])])) {
    const canvases: HTMLCanvasElement[] = []
    const drawImage = vi.fn()
    const toBlob = vi.fn((callback: BlobCallback) => callback(blob))
    const createCanvas = () => {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob } as unknown as HTMLCanvasElement
      canvases.push(canvas)
      return canvas
    }
    return { canvases, drawImage, toBlob, createCanvas }
  }

  it('creates the main and side PNGs with a 9-pixel gap, without resizing the source pixels', async () => {
    const fake = canvasFactory()
    const outputs = await createArtworkCropPngs({ image, width: 1920, height: 1080, fileName: 'summer/background.jpeg' }, defaultArtworkCrop(1920, 1080), fake.createCanvas)
    expect(outputs.map(output => [output.name, output.width, output.height, output.fileName])).toEqual([
      ['main', 506, 824, 'summer_background-main.png'], ['side', 100, 824, 'summer_background-side.png']
    ])
    expect(fake.drawImage.mock.calls).toEqual([
      [image, 493, 256, 506, 824, 0, 0, 506, 824], [image, 1008, 256, 100, 824, 0, 0, 100, 824]
    ])
    expect(fake.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(fake.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('preserves manually adjusted coordinates and featured artwork cropping', async () => {
    const fake = canvasFactory()
    const outputs = await createArtworkCropPngs({ image, width: 1920, height: 1080, fileName: 'custom.png' }, { preset: 'featured', x: 400, y: 300, height: 600 }, fake.createCanvas)
    expect(outputs).toMatchObject([{ name: 'featured', width: 630, height: 600, fileName: 'custom-featured.png' }])
    expect(fake.drawImage).toHaveBeenCalledWith(image, 400, 300, 630, 600, 0, 0, 630, 600)
  })

  it('rejects invalid rectangles before allocating a canvas', async () => {
    const createCanvas = vi.fn()
    await expect(createArtworkCropPngs({ image, width: 1920, height: 1080, fileName: 'bad.png' }, { preset: 'standard', x: 1800, y: 256, height: 824 }, createCanvas)).rejects.toMatchObject({ code: 'invalidCrop' })
    expect(createCanvas).not.toHaveBeenCalled()
  })

  it('clears canvas memory when PNG encoding fails', async () => {
    const fake = canvasFactory(null)
    await expect(createArtworkCropPngs({ image, width: 1920, height: 1080, fileName: 'bad.png' }, defaultArtworkCrop(1920, 1080), fake.createCanvas)).rejects.toBeInstanceOf(ArtworkError)
    expect(fake.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('refuses oversized upload drafts without passing them to IPC', async () => {
    const fake = canvasFactory({ size: MAX_ARTWORK_FILE_BYTES + 1 } as Blob)
    await expect(createArtworkCropPngs({ image, width: 1920, height: 1080, fileName: 'big.png' }, defaultArtworkCrop(1920, 1080), fake.createCanvas)).rejects.toMatchObject({ code: 'fileTooLarge' })
    expect(fake.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('encodes binary bytes losslessly for main-process controlled uploads', async () => {
    expect(await artworkBlobBase64(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]))).toBe('iVBORw0KGgo=')
  })
})

describe('account background error translation', () => {
  it.each(['NOT_AUTHENTICATED', 'BACKGROUND_NOT_AUTHENTICATED', 'BACKGROUND_SESSION_CHANGED', 'BACKGROUND_ACCOUNT_CHANGED', 'WRONG_ACCOUNT', 'BACKGROUND_ANIMATED', 'BACKGROUND_NOT_FOUND', 'BACKGROUND_IMAGE_UNAVAILABLE', 'BACKGROUND_CANCELLED', 'ARTWORK_BACKGROUND_CANCELLED', 'BACKGROUND_FILE_TOO_LARGE', 'RATE_LIMITED', 'NETWORK_FAILURE'])('explains %s without exposing remote URLs', code => {
    expect(profileBackgroundError(code, (_zh, en) => en)).not.toMatch(/\p{Script=Han}|https?:\/\//u)
    expect(profileBackgroundError(code, zh => zh)).toMatch(/\p{Script=Han}/u)
  })
  it.each(['ARTWORK_INVALID_UPLOAD', 'ARTWORK_UPLOAD_INVALID_IMAGE', 'ARTWORK_UPLOAD_TOO_LARGE', 'ARTWORK_UPLOAD_BUSY', 'ARTWORK_UPLOAD_PREPARE_FAILED'])('explains controlled upload failure %s', code => {
    expect(artworkBrowserError(code, (_zh, en) => en)).not.toMatch(/\p{Script=Han}|https?:\/\//u)
    expect(artworkBrowserError(code, zh => zh)).toMatch(/\p{Script=Han}/u)
  })
})
