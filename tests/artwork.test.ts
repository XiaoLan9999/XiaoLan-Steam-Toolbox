import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ArtworkError,
  MAX_ARTWORK_FILE_BYTES,
  artworkCropRects,
  buildLongArtworkScript,
  defaultArtworkCrop,
  inspectStaticArtwork,
  validateArtworkDimensions
} from '../src/shared/artwork'

function png(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(animated ? 65 : 45)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  if (animated) {
    view.setUint32(33, 8)
    bytes.set([97, 99, 84, 76], 37)
  }
  bytes.set([73, 69, 78, 68], animated ? 57 : 37)
  return bytes
}

function scriptContext(options: { origin?: string; pathname?: string; file?: boolean; fields?: boolean } = {}): {
  context: Record<string, unknown>; mutations: string[]
} {
  const mutations: string[] = []
  const field = (name: string): object => ({
    set value(value: string) { mutations.push(`${name}.value=${value}`) },
    removeAttribute(attribute: string) { mutations.push(`${name}.remove=${attribute}`) }
  })
  const width = field('width')
  const height = field('height')
  return {
    mutations,
    context: {
      location: { origin: options.origin ?? 'https://steamcommunity.com', pathname: options.pathname ?? '/sharedfiles/edititem/767/3/' },
      document: {
        querySelector(selector: string) {
          if (options.fields === false) return null
          if (selector === 'input[name="image_width"]') return width
          if (selector === 'input[name="image_height"]') return height
          throw new Error(`Unexpected selector: ${selector}`)
        },
        querySelectorAll(selector: string) {
          if (selector !== 'input[type="file"]') throw new Error(`Unexpected selector: ${selector}`)
          return [{ files: { length: options.file === false ? 0 : 1 } }]
        }
      },
      console: { info() {} }
    }
  }
}

describe('long artwork script', () => {
  it('only changes the two dimension fields and removes their IDs after a file was selected', () => {
    const { context, mutations } = scriptContext()
    runInNewContext(buildLongArtworkScript(), context)
    expect(mutations).toEqual(['width.value=1000', 'height.value=1', 'width.remove=id', 'height.remove=id'])
  })

  it.each([
    { origin: 'https://example.com' },
    { origin: 'http://steamcommunity.com' },
    { pathname: '/my/friends/' },
    { pathname: '/sharedfiles/edititems/767/3/' }
  ])('requires the correct origin and upload path: %o', (options) => {
    const { context, mutations } = scriptContext(options)
    expect(() => runInNewContext(buildLongArtworkScript(), context)).toThrow('Open the Steam Community artwork upload page first.')
    expect(mutations).toEqual([])
  })

  it.each([{ file: false }, { fields: false }])('does not partially mutate an unready upload form: %o', (options) => {
    const { context, mutations } = scriptContext(options)
    expect(() => runInNewContext(buildLongArtworkScript(), context)).toThrow('Select your local artwork file')
    expect(mutations).toEqual([])
  })
})

describe('background crop coordinates', () => {
  it('aligns a 1920px background to the normal 506px and 100px artwork slots with a 9px gap', () => {
    const input = defaultArtworkCrop(1920, 1080)
    expect(input).toEqual({ preset: 'standard', x: 493, y: 256, height: 824 })
    expect(artworkCropRects(1920, 1080, input)).toEqual([
      { name: 'main', x: 493, y: 256, width: 506, height: 824 },
      { name: 'side', x: 1008, y: 256, width: 100, height: 824 }
    ])
  })

  it('supports the featured 630px slot and custom vertical alignment without rescaling', () => {
    expect(artworkCropRects(1921, 1200, { ...defaultArtworkCrop(1921, 1200, 'featured'), y: 300, height: 900 })).toEqual([
      { name: 'featured', x: 493, y: 300, width: 630, height: 900 }
    ])
  })

  it('accepts crops touching the image edges', () => {
    expect(artworkCropRects(615, 500, { preset: 'standard', x: 0, y: 0, height: 500 })[1]?.x).toBe(515)
    expect(artworkCropRects(630, 500, { preset: 'featured', x: 0, y: 0, height: 500 })).toHaveLength(1)
  })

  it.each([
    { x: -1 }, { y: -1 }, { x: 0.5 }, { y: Number.NaN }, { height: 0 },
    { height: 1081 }, { x: 1400 }, { y: 1000 }, { height: Number.POSITIVE_INFINITY }
  ])('rejects invalid or out-of-bounds crop coordinates: %o', (changes) => {
    expect(() => artworkCropRects(1920, 1080, { ...defaultArtworkCrop(1920, 1080), ...changes })).toThrowError(ArtworkError)
  })

  it('exposes invalid defaults on too-small images so the user must choose fitting coordinates', () => {
    expect(() => artworkCropRects(615, 500, defaultArtworkCrop(615, 500))).toThrowError(ArtworkError)
  })
})

describe('static image inspection', () => {
  it('reads PNG dimensions before decoding', () => {
    expect(inspectStaticArtwork(png(1920, 1080))).toEqual({ width: 1920, height: 1080, format: 'png' })
  })

  it('rejects APNG instead of silently dropping animation', () => {
    expect(() => inspectStaticArtwork(png(1920, 1080, true))).toThrowError(expect.objectContaining({ code: 'animatedImage' }))
  })

  it('reads JPEG dimensions across metadata segments', () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xc2, 0, 8, 8, 4, 56, 7, 128, 1])
    expect(inspectStaticArtwork(bytes)).toEqual({ width: 1920, height: 1080, format: 'jpeg' })
  })

  it.each([
    Uint8Array.from([71, 73, 70, 56, 57, 97]),
    Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
    new Uint8Array()
  ])('rejects formats outside static PNG and JPEG: %o', (bytes) => {
    expect(() => inspectStaticArtwork(bytes)).toThrowError(expect.objectContaining({ code: 'unsupportedFormat' }))
  })

  it('rejects truncated PNG and malformed JPEG segment lengths', () => {
    expect(() => inspectStaticArtwork(png(1920, 1080).subarray(0, 33))).toThrowError(ArtworkError)
    expect(() => inspectStaticArtwork(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toThrowError(ArtworkError)
  })

  it('limits file bytes, decoded dimensions and pixel count', () => {
    expect(() => inspectStaticArtwork(new Uint8Array(MAX_ARTWORK_FILE_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'fileTooLarge' }))
    expect(() => validateArtworkDimensions(0, 100)).toThrowError(ArtworkError)
    expect(() => validateArtworkDimensions(16_385, 10)).toThrowError(expect.objectContaining({ code: 'imageTooLarge' }))
    expect(() => inspectStaticArtwork(png(8000, 5000))).toThrowError(expect.objectContaining({ code: 'imageTooLarge' }))
  })
})
