export const MAX_ARTWORK_FILE_BYTES = 30 * 1024 * 1024
export const MAX_ARTWORK_PIXELS = 32_000_000
export const MAX_ARTWORK_DIMENSION = 16_384

export type ArtworkPreset = 'standard' | 'featured'
export type ArtworkErrorCode = 'unsupportedFormat' | 'animatedImage' | 'fileTooLarge' | 'invalidImage' | 'imageTooLarge' | 'invalidCrop'

export class ArtworkError extends Error {
  constructor(public readonly code: ArtworkErrorCode) {
    super(code)
    this.name = 'ArtworkError'
  }
}

export interface ArtworkImageInfo {
  width: number
  height: number
  format: 'png' | 'jpeg'
}

export interface ArtworkCropInput {
  preset: ArtworkPreset
  x: number
  y: number
  height: number
}

export interface ArtworkCropRect {
  name: 'main' | 'side' | 'featured'
  x: number
  y: number
  width: number
  height: number
}

export function buildLongArtworkScript(): string {
  return `(() => {
  if (location.origin !== 'https://steamcommunity.com' ||
      !/^\\/sharedfiles\\/edititem(?:\\/|$)/.test(location.pathname)) {
    throw new Error('Open the Steam Community artwork upload page first.');
  }
  const width = document.querySelector('input[name="image_width"]');
  const height = document.querySelector('input[name="image_height"]');
  const hasFile = Array.from(document.querySelectorAll('input[type="file"]'))
    .some((input) => input.files && input.files.length > 0);
  if (!width || !height || !hasFile) {
    throw new Error('Select your local artwork file before running this script.');
  }
  width.value = '1000';
  height.value = '1';
  width.removeAttribute('id');
  height.removeAttribute('id');
  console.info('Artwork dimensions prepared. Review the form, then save the artwork yourself.');
})();`
}

export function validateArtworkDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ArtworkError('invalidImage')
  }
  if (width > MAX_ARTWORK_DIMENSION || height > MAX_ARTWORK_DIMENSION || width * height > MAX_ARTWORK_PIXELS) {
    throw new ArtworkError('imageTooLarge')
  }
}

export function inspectStaticArtwork(bytes: Uint8Array): ArtworkImageInfo {
  if (bytes.byteLength > MAX_ARTWORK_FILE_BYTES) throw new ArtworkError('fileTooLarge')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (pngSignature.every((value, index) => bytes[index] === value)) {
    if (bytes.byteLength < 33 || view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
      throw new ArtworkError('invalidImage')
    }
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    validateArtworkDimensions(width, height)
    let offset = 8
    let ended = false
    while (offset + 12 <= bytes.byteLength) {
      const length = view.getUint32(offset)
      const type = ascii(bytes, offset + 4, 4)
      if (length > bytes.byteLength - offset - 12) throw new ArtworkError('invalidImage')
      if (type === 'acTL') throw new ArtworkError('animatedImage')
      offset += length + 12
      if (type === 'IEND') {
        ended = true
        break
      }
    }
    if (!ended) throw new ArtworkError('invalidImage')
    return { width, height, format: 'png' }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new ArtworkError('unsupportedFormat')
  }
  let offset = 2
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new ArtworkError('invalidImage')
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) break
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.byteLength) throw new ArtworkError('invalidImage')
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new ArtworkError('invalidImage')
      const height = view.getUint16(offset + 3)
      const width = view.getUint16(offset + 5)
      validateArtworkDimensions(width, height)
      return { width, height, format: 'jpeg' }
    }
    offset += length
  }
  throw new ArtworkError('invalidImage')
}

export function defaultArtworkCrop(width: number, height: number, preset: ArtworkPreset = 'standard'): ArtworkCropInput {
  validateArtworkDimensions(width, height)
  return { preset, x: Math.floor(width / 2) - 467, y: 256, height: height - 256 }
}

export function artworkCropRects(width: number, height: number, input: ArtworkCropInput): ArtworkCropRect[] {
  validateArtworkDimensions(width, height)
  if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) || !Number.isSafeInteger(input.height) ||
      input.x < 0 || input.y < 0 || input.height <= 0 || input.y + input.height > height) {
    throw new ArtworkError('invalidCrop')
  }
  const rectangles: ArtworkCropRect[] = input.preset === 'standard'
    ? [
      { name: 'main', x: input.x, y: input.y, width: 506, height: input.height },
      { name: 'side', x: input.x + 515, y: input.y, width: 100, height: input.height }
    ]
    : input.preset === 'featured'
      ? [{ name: 'featured', x: input.x, y: input.y, width: 630, height: input.height }]
      : []
  if (rectangles.length === 0 || rectangles.some(rectangle => rectangle.x + rectangle.width > width)) {
    throw new ArtworkError('invalidCrop')
  }
  return rectangles
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
