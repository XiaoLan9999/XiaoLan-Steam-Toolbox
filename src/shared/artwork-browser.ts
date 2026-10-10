import { ARTWORK_SOURCE_URLS, ARTWORK_UPLOAD_URL } from './artwork-links'

export type ArtworkTool = 'upload' | 'showcase' | 'design' | 'guide' | 'sapic'

export interface ArtworkBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ArtworkBrowserState {
  tool: ArtworkTool | null
  phase: 'closed' | 'loading' | 'ready' | 'error'
  accountId: string | null
  canApplyLongArtwork: boolean
  error: string | null
}

export const ARTWORK_TOOL_URLS: Record<ArtworkTool, string> = {
  upload: ARTWORK_UPLOAD_URL,
  showcase: 'https://steamcommunity.com/my/edit/showcases',
  design: ARTWORK_SOURCE_URLS['steam-design'],
  guide: ARTWORK_SOURCE_URLS.guide,
  sapic: ARTWORK_SOURCE_URLS.sapic
}

export function initialArtworkBrowserState(): ArtworkBrowserState {
  return { tool: null, phase: 'closed', accountId: null, canApplyLongArtwork: false, error: null }
}

export function isArtworkTool(value: unknown): value is ArtworkTool {
  return typeof value === 'string' && Object.hasOwn(ARTWORK_TOOL_URLS, value)
}

export function isSteamArtworkTool(tool: ArtworkTool): boolean {
  return tool === 'upload' || tool === 'showcase'
}

export function isArtworkUploadUrl(value: string): boolean {
  const url = secureUrl(value)
  return !!url && url.hostname === 'steamcommunity.com' &&
    /^\/sharedfiles\/edititem(?:\/|$)/.test(url.pathname)
}

export function isAllowedArtworkNavigation(tool: ArtworkTool, value: string, isMainFrame = true): boolean {
  if (!isMainFrame && value === 'about:blank') return true
  const url = secureUrl(value)
  if (!url) return false
  if (tool === 'upload' || tool === 'showcase' || tool === 'guide') {
    return url.hostname === 'steamcommunity.com'
  }
  if (tool === 'design') return url.hostname === 'steam.design' || url.hostname === 'www.steam.design'
  return url.hostname === 'github.com' && /^\/sapic\/sapic(?:\/|$)/.test(url.pathname)
}

export function clampArtworkBounds(value: unknown, windowWidth: number, windowHeight: number): ArtworkBounds | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || !Number.isFinite(windowWidth) || !Number.isFinite(windowHeight)) {
    throw new Error('ARTWORK_INVALID_BOUNDS')
  }
  const input = value as Partial<ArtworkBounds>
  const numbers = [input.x, input.y, input.width, input.height]
  if (numbers.some(number => typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 100_000) ||
      input.width! < 0 || input.height! < 0) throw new Error('ARTWORK_INVALID_BOUNDS')
  const left = Math.max(0, Math.min(windowWidth, Math.ceil(input.x!)))
  const top = Math.max(0, Math.min(windowHeight, Math.ceil(input.y!)))
  const right = Math.min(windowWidth, Math.floor(input.x! + input.width!))
  const bottom = Math.min(windowHeight, Math.floor(input.y! + input.height!))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export interface ArtworkSessionCookie {
  url: string
  name: 'steamLoginSecure' | 'sessionid'
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'lax'
}

export function artworkCookieAccountMatches(value: unknown, accountId: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const decoded = decodeURIComponent(value)
    return decoded.startsWith(`${accountId}||`) && decoded.length > accountId.length + 2
  } catch { return false }
}

export function parseArtworkSessionCookies(lines: unknown, accountId: string): ArtworkSessionCookie[] {
  if (!/^7656119\d{10}$/.test(accountId) || !Array.isArray(lines) || lines.length > 100) {
    throw new Error('ARTWORK_INVALID_SESSION')
  }
  const values = new Map<string, string>()
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > 16_384 || /[\r\n\u0000]/.test(line)) {
      throw new Error('ARTWORK_INVALID_SESSION')
    }
    const parts = line.split(';').map(part => part.trim())
    const first = parts[0] ?? ''
    const separator = first.indexOf('=')
    if (separator < 1) continue
    const name = first.slice(0, separator)
    if (name !== 'steamLoginSecure' && name !== 'sessionid') continue
    const domains = parts.filter(part => /^domain=/i.test(part))
    if (domains.length > 1) throw new Error('ARTWORK_INVALID_SESSION')
    if (domains.length === 1 && domains[0]!.slice(7).replace(/^\./, '').toLowerCase() !== 'steamcommunity.com') continue
    const value = first.slice(separator + 1)
    if (!value || /[\s\u0000-\u001f\u007f]/.test(value) || (values.has(name) && values.get(name) !== value)) {
      throw new Error('ARTWORK_INVALID_SESSION')
    }
    values.set(name, value)
  }
  const login = values.get('steamLoginSecure')
  const sessionId = values.get('sessionid')
  if (!login || !sessionId || !/^[A-Za-z0-9]{1,128}$/.test(sessionId) ||
      !artworkCookieAccountMatches(login, accountId)) {
    throw new Error('ARTWORK_INVALID_SESSION')
  }
  return [
    { url: 'https://steamcommunity.com/', name: 'steamLoginSecure', value: login, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
    { url: 'https://steamcommunity.com/', name: 'sessionid', value: sessionId, path: '/', secure: true, httpOnly: false, sameSite: 'lax' }
  ]
}

const DOWNLOAD_TYPES: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'video/webm': ['webm'],
  'video/mp4': ['mp4'],
  'application/zip': ['zip'],
  'application/x-zip-compressed': ['zip']
}

export function artworkDownloadExtension(fileName: string, mimeType: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!extension || !DOWNLOAD_TYPES[mime]?.includes(extension) || /[\u0000-\u001f\u007f]/.test(fileName)) return null
  return extension
}

export function isSafeArtworkSavePath(value: unknown, mimeType: string): value is string {
  if (typeof value !== 'string' || value.length > 32_000 || /[\u0000-\u001f\u007f]/.test(value)) return false
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value)
  const posixAbsolute = value.startsWith('/') && !value.startsWith('//')
  if (!windowsAbsolute && !posixAbsolute) return false
  const withoutDrive = windowsAbsolute ? value.slice(2) : value
  // Reject Windows device/UNC paths, alternate data streams and normalized-away suffixes.
  if (withoutDrive.includes(':') || /[<>"|?*]/.test(withoutDrive)) return false
  const segments = withoutDrive.split(/[\\/]/).filter(Boolean)
  if (segments.some(segment => /[. ]$/.test(segment) || segment === '.' || segment === '..' ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return false
  return !!artworkDownloadExtension(value, mimeType)
}

export const APPLY_LONG_ARTWORK_SCRIPT = `(() => {
  if (location.origin !== 'https://steamcommunity.com' || !/^\\/sharedfiles\\/edititem(?:\\/|$)/.test(location.pathname)) return 'ARTWORK_UPLOAD_PAGE_REQUIRED';
  const width = document.querySelector('input[name="image_width"]');
  const height = document.querySelector('input[name="image_height"]');
  const file = document.querySelector('input[type="file"]');
  const preview = document.getElementById('PreviewImage');
  if (!(width instanceof HTMLInputElement) || !(height instanceof HTMLInputElement) || !(file instanceof HTMLInputElement) || !(preview instanceof HTMLImageElement)) return 'ARTWORK_FORM_UNAVAILABLE';
  if (!file.files || file.files.length === 0) return 'ARTWORK_FILE_REQUIRED';
  if (!preview.complete || preview.naturalWidth === 0) return 'ARTWORK_IMAGE_LOADING';
  width.value = '1000';
  height.value = '1';
  width.removeAttribute('id');
  height.removeAttribute('id');
  return 'ok';
})();`

function secureUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url : null
  } catch { return null }
}
