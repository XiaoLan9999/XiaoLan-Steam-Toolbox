import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { DomainError } from '../shared/domain'
import type {
  ProfileBackgroundCatalog,
  ProfileBackgroundIssue,
  SteamProfileBackground
} from '../shared/profile-backgrounds'

export interface ProfileBackgroundProvider {
  requestText(path: string): Promise<string>
  requestJson(path: string): Promise<unknown>
  requestPlayerJson?(
    method: 'GetProfileItemsOwned' | 'GetProfileItemsEquipped',
    input: Record<string, unknown>
  ): Promise<unknown>
  pause?(milliseconds: number): Promise<void>
}

type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']
const MEDIA_BASE = 'https://shared.akamai.steamstatic.com/community_assets/images/'
const MAX_BACKGROUNDS = 5_000
const MAX_INVENTORY_PAGES = 8
const MEDIA_HOSTS = new Set([
  'shared.akamai.steamstatic.com', 'shared.fastly.steamstatic.com', 'shared.steamstatic.com',
  'community.akamai.steamstatic.com', 'community.fastly.steamstatic.com', 'community.steamstatic.com',
  'cdn.akamai.steamstatic.com', 'cdn.fastly.steamstatic.com', 'cdn.steamstatic.com',
  'cdn.cloudflare.steamstatic.com', 'steamcdn-a.akamaihd.net'
])

export function extractCommunityPageIdentity(html: string): string | null {
  if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) return null
  const identities = new Set<string>()
  for (const element of allElements(parse(html))) {
    if (!isPageBootstrapScript(element)) continue
    const source = element.childNodes.filter(node => node.nodeName === '#text')
      .map(node => 'value' in node ? node.value : '').join('')
    for (const assignment of assignedJsonStrings(source)) {
      if (assignment.name !== 'g_steamID') continue
      if (assignment.guest || assignment.value === '') identities.add('guest')
      else if (assignment.value && /^7656119\d{10}$/.test(assignment.value)) identities.add(assignment.value)
      else return null
    }
  }
  return identities.size === 1 ? [...identities][0]! : null
}

// Steam's own Community service transport reads this page-issued token; it is not persisted or exposed in the catalog.
export function extractProfileWebApiToken(html: string, accountId: string, nowSeconds = Math.floor(Date.now() / 1_000)): string | null {
  if (!/^7656119\d{10}$/.test(accountId) || Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) return null
  const tokens = new Set<string>()
  const accounts = new Set<string>()
  for (const element of allElements(parse(html))) {
    if (!isPageBootstrapScript(element)) continue
    const source = element.childNodes.filter((node) => node.nodeName === '#text')
      .map((node) => 'value' in node ? node.value : '').join('')
    for (const assignment of assignedJsonStrings(source)) {
      if (assignment.name === 'g_wapit') {
        if (assignment.value === null) return null
        tokens.add(assignment.value)
      }
      if (assignment.name === 'g_steamID') {
        if (assignment.value === null) return null
        accounts.add(assignment.value)
      }
    }
  }
  if (tokens.size !== 1 || accounts.size !== 1 || !accounts.has(accountId)) return null
  const token = [...tokens][0]!
  if (token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
  try {
    const [headerPart, payloadPart] = token.split('.') as [string, string, string]
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as unknown
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as unknown
    if (
      !isRecord(header) || !isRecord(payload) || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none' ||
      payload.sub !== accountId || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) ||
      payload.exp <= nowSeconds + 10 ||
      (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds + 60)) ||
      (Array.isArray(payload.aud) && payload.aud.includes('derive'))
    ) return null
    return token
  } catch { return null }
}

// Cookies and access tokens belong in the injected Steam transport, never in these media URLs.
export function normalizeProfileBackgroundMediaUrl(value: unknown, kind: 'image' | 'video'): string | null {
  if (typeof value !== 'string' || !value || value.length > 2_048 || /[\s\\\x00-\x1f]/.test(value)) return null
  const raw = value.startsWith('items/') ? `${MEDIA_BASE}${value}` : value
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search ||
    (!MEDIA_HOSTS.has(url.hostname) && url.hostname !== 'steamcommunity.com')
  ) return null
  const allowedPath = /^\/community_assets\/images\/items\/\d+\/[a-z0-9_.-]+\.(?:png|jpe?g|webm|mp4)$/i
  const oldBackgroundPath = /^\/economy\/profilebackground\/items\/\d+\/[a-z0-9_.-]+\.(?:png|jpe?g)$/i
  if (!allowedPath.test(url.pathname) && !oldBackgroundPath.test(url.pathname)) return null
  if (url.hostname === 'steamcommunity.com' && !oldBackgroundPath.test(url.pathname)) return null
  const extension = kind === 'image' ? /\.(?:png|jpe?g)$/i : /\.(?:webm|mp4)$/i
  return extension.test(url.pathname) ? url.href : null
}

export function parseProfileItemBackground(value: unknown, equipped = false): SteamProfileBackground | null {
  if (!isRecord(value) || !validId(value.communityitemid)) return null
  if (value.item_class !== undefined && Number(value.item_class) !== 3) return null
  const imageUrl = normalizeProfileBackgroundMediaUrl(value.image_large, 'image')
  const videoUrl = normalizeProfileBackgroundMediaUrl(value.movie_mp4, 'video') ||
    normalizeProfileBackgroundMediaUrl(value.movie_webm, 'video')
  const hasMovie = Boolean(value.movie_mp4 || value.movie_webm)
  if (hasMovie && !videoUrl) return null
  if (!imageUrl && !videoUrl) return null
  return {
    id: `item:${value.communityitemid}`,
    title: itemTitle(value.item_title) || itemTitle(value.name) || 'Profile background',
    kind: hasMovie ? 'animated' : 'static', imageUrl, stillImageUrl: imageUrl, videoUrl,
    equipped, source: 'profileItems'
  }
}

export function parseEquippedProfileBackground(html: string): SteamProfileBackground | null {
  if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('BACKGROUND_PAGE_TOO_LARGE')
  const elements = allElements(parse(html))
  const page = elements.find((element) => element.tagName !== 'body' && hasClass(element, 'profile_page'))
  if (!page) throw new Error('BACKGROUND_PROFILE_PAGE_INVALID')
  const content = allElements(page)
  const animated = content.find((element) => hasClass(element, 'profile_animated_background'))
  if (animated) {
    const video = allElements(animated).find((element) => element.tagName === 'video')
    const imageUrl = normalizeProfileBackgroundMediaUrl(video && attribute(video, 'poster'), 'image')
    const sources = video ? allElements(video).filter((element) => element.tagName === 'source') : []
    const videoUrl = sources.map((element) => normalizeProfileBackgroundMediaUrl(attribute(element, 'src'), 'video'))
      .find((value) => value?.endsWith('.mp4')) ||
      sources.map((element) => normalizeProfileBackgroundMediaUrl(attribute(element, 'src'), 'video')).find(Boolean) || null
    if (!videoUrl) throw new Error('BACKGROUND_PROFILE_MEDIA_INVALID')
    return makePageItem('animated', imageUrl, videoUrl)
  }
  const style = attribute(page, 'style') || ''
  const background = style.match(/(?:^|;)\s*background-image\s*:\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/i)
  if (!background) {
    if (hasClass(page, 'has_profile_background')) throw new Error('BACKGROUND_PROFILE_MEDIA_INVALID')
    return null
  }
  const imageUrl = normalizeProfileBackgroundMediaUrl(background[1] || background[2] || background[3], 'image')
  if (!imageUrl) throw new Error('BACKGROUND_PROFILE_MEDIA_INVALID')
  return makePageItem('static', imageUrl, null)
}

export async function getProfileBackgroundCatalog(
  accountId: string,
  provider: ProfileBackgroundProvider
): Promise<ProfileBackgroundCatalog> {
  if (!/^7656119\d{10}$/.test(accountId)) throw new DomainError('INVALID_STEAM_ID', 'INVALID_STEAM_ID')
  const items: SteamProfileBackground[] = []
  const issues = new Set<ProfileBackgroundIssue>()
  let ownedComplete = false
  let equippedRead = false
  if (provider.requestPlayerJson) {
    try {
      const body = unwrapResponse(await provider.requestPlayerJson('GetProfileItemsOwned', { language: 'english', filters: [3] }))
      if (body.profile_backgrounds !== undefined && !Array.isArray(body.profile_backgrounds)) throw new Error('BACKGROUND_ITEMS_INVALID')
      const backgrounds = body.profile_backgrounds ?? []
      if (backgrounds.length > MAX_BACKGROUNDS) throw new Error('BACKGROUND_ITEMS_TOO_MANY')
      ownedComplete = true
      for (const background of backgrounds) {
        const item = parseProfileItemBackground(background)
        if (item) mergeItem(items, item)
        else { issues.add('unsupportedItems'); ownedComplete = false }
      }
    } catch (error) {
      rethrowSessionError(error)
      issues.add('ownedUnavailable')
    }
    try {
      const body = unwrapResponse(await provider.requestPlayerJson('GetProfileItemsEquipped', { steamid: accountId, language: 'english' }))
      const background = body.profile_background
      if (background && (!isRecord(background) || Object.keys(background).length > 0)) {
        const item = parseProfileItemBackground(background, true)
        if (!item) throw new Error('BACKGROUND_ITEMS_INVALID')
        mergeItem(items, item)
      }
      equippedRead = true
    } catch (error) { rethrowSessionError(error) }
  } else issues.add('ownedUnavailable')
  if (!equippedRead) {
    try {
      const item = parseEquippedProfileBackground(await provider.requestText(`/profiles/${accountId}/?l=english`))
      if (item) mergeItem(items, item)
    } catch (error) {
      rethrowSessionError(error)
      issues.add('profileUnavailable')
    }
  }
  if (!ownedComplete && issues.has('ownedUnavailable')) await readInventoryBackgrounds(accountId, provider, items, issues)
  return {
    accountId,
    items: items.sort((left, right) => Number(right.equipped) - Number(left.equipped) || left.title.localeCompare(right.title)),
    ownedComplete, issues: [...issues], fetchedAt: new Date().toISOString()
  }
}

async function readInventoryBackgrounds(
  accountId: string,
  provider: ProfileBackgroundProvider,
  output: SteamProfileBackground[],
  issues: Set<ProfileBackgroundIssue>
): Promise<void> {
  let cursor = ''
  const visited = new Set<string>()
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    try {
      if (page > 0) await (provider.pause ? provider.pause(350) : new Promise((resolve) => setTimeout(resolve, 350)))
      const suffix = cursor ? `&start_assetid=${cursor}` : ''
      const body = await provider.requestJson(`/inventory/${accountId}/753/6?l=english&count=2000${suffix}`)
      if (!isRecord(body) || Number(body.success) !== 1) throw new Error('BACKGROUND_INVENTORY_UNAVAILABLE')
      const moreItems = parseMoreItems(body.more_items)
      if (Number(body.total_inventory_count) === 0 && body.assets === undefined && !moreItems) return
      if (!Array.isArray(body.assets) || !Array.isArray(body.descriptions) || body.assets.length > 2_000 || body.descriptions.length > 2_000) {
        throw new Error('BACKGROUND_INVENTORY_INVALID')
      }
      if (body.assets.some((asset) => !isRecord(asset) || !validId(asset.classid) || !validId(asset.instanceid, true))) {
        throw new Error('BACKGROUND_INVENTORY_INVALID')
      }
      const owned = new Set(body.assets.filter(isRecord).map((asset) => `${asset.classid}:${asset.instanceid}`))
      for (const description of body.descriptions) {
        if (!isRecord(description) || !owned.has(`${description.classid}:${description.instanceid}`)) continue
        if (!Array.isArray(description.tags) || !description.tags.some((tag) => isRecord(tag) && tag.category === 'item_class' && tag.internal_name === 'item_class_3')) continue
        const actions = Array.isArray(description.actions) ? description.actions : []
        const imageUrl = actions.filter(isRecord).map((action) => normalizeProfileBackgroundMediaUrl(action.link, 'image')).find(Boolean) || null
        if (!imageUrl || !validId(description.classid) || !validId(description.instanceid, true)) {
          issues.add('unsupportedItems'); continue
        }
        mergeItem(output, {
          id: `inventory:${description.classid}:${description.instanceid}`,
          title: itemTitle(description.name) || itemTitle(description.market_name) || 'Profile background',
          kind: 'static', imageUrl, stillImageUrl: imageUrl, videoUrl: null, equipped: false, source: 'inventory'
        })
        if (output.length >= MAX_BACKGROUNDS) { issues.add('inventoryPartial'); return }
      }
      if (!moreItems) return
      if (!validId(body.last_assetid) || visited.has(String(body.last_assetid))) throw new Error('BACKGROUND_INVENTORY_CURSOR_INVALID')
      cursor = String(body.last_assetid)
      visited.add(cursor)
    } catch (error) {
      rethrowSessionError(error)
      issues.add(page === 0 ? 'inventoryUnavailable' : 'inventoryPartial')
      return
    }
  }
  issues.add('inventoryPartial')
}

function unwrapResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.response)) throw new Error('BACKGROUND_API_RESPONSE_INVALID')
  return value.response
}

function assignedJsonStrings(source: string): Array<{ name: string; value: string | null; guest: boolean }> {
  const output: Array<{ name: string; value: string | null; guest: boolean }> = []
  let previous = ''
  let beforePrevious = ''
  let braceDepth = 0
  for (let index = 0; index < source.length;) {
    const character = source[index]!
    if (/\s/.test(character)) { index++; continue }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1; continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2; continue
    }
    if (character === '"' || character === "'" || character === '`' || character === '/') {
      const end = skipQuoted(source, index, character)
      beforePrevious = previous; previous = '<quoted>'; index = end; continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0]
    if (!identifier) {
      if (character === '{') braceDepth++
      if (character === '}') braceDepth = Math.max(0, braceDepth - 1)
      beforePrevious = previous; previous = character; index++; continue
    }
    const directVariable = braceDepth === 0 && (previous !== '.' || beforePrevious === 'window' || beforePrevious === 'globalThis')
    index += identifier.length
    if (directVariable && (identifier === 'g_wapit' || identifier === 'g_steamID')) {
      const remainder = source.slice(index)
      const equals = remainder.match(/^\s*=\s*(?!=)/)
      if (equals) {
        const start = index + equals[0].length
        let value: string | null = null
        if (source[start] === '"') {
          const end = skipQuoted(source, start, '"')
          if (/^\s*(?:;|$)/.test(source.slice(end))) {
            try {
              const parsed = JSON.parse(source.slice(start, end)) as unknown
              if (typeof parsed === 'string') value = parsed
            } catch { /* A changed or non-literal script is not a token source. */ }
          }
        }
        output.push({ name: identifier, value, guest: /^(?:false|null)\s*(?:;|$)/.test(source.slice(start)) })
      }
    }
    beforePrevious = previous; previous = identifier
  }
  return output
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === quote) return index + 1
  }
  return source.length
}

function parseMoreItems(value: unknown): boolean {
  if (value === undefined || value === false || value === 0 || value === '0') return false
  if (value === true || value === 1 || value === '1') return true
  throw new Error('BACKGROUND_INVENTORY_INVALID')
}

function mergeItem(items: SteamProfileBackground[], item: SteamProfileBackground): void {
  const existing = items.find((candidate) => candidate.id === item.id || mediaIdentity(candidate) === mediaIdentity(item))
  if (!existing) { items.push(item); return }
  const equipped = existing.equipped || item.equipped
  if (existing.source === 'profilePage' && item.source !== 'profilePage') Object.assign(existing, item)
  existing.equipped = equipped
}

function mediaIdentity(item: SteamProfileBackground): string {
  const media = item.videoUrl || item.imageUrl
  return media ? new URL(media).pathname.replace(/^\/economy\/profilebackground\//, '/community_assets/images/') : item.id
}

function makePageItem(kind: 'static' | 'animated', imageUrl: string | null, videoUrl: string | null): SteamProfileBackground {
  const media = videoUrl || imageUrl!
  return {
    id: `equipped:${new URL(media).pathname}`, title: 'Equipped profile background', kind,
    imageUrl, stillImageUrl: imageUrl, videoUrl, equipped: true, source: 'profilePage'
  }
}

function allElements(node: Node): Element[] {
  const output: Element[] = []
  const queue: Node[] = [node]
  while (queue.length) {
    const current = queue.pop()!
    if ('tagName' in current) output.push(current)
    if ('childNodes' in current) queue.push(...current.childNodes.toReversed())
  }
  return output
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value
}

function hasClass(element: Element, className: string): boolean {
  return (attribute(element, 'class') || '').split(/\s+/).includes(className)
}

function isPageBootstrapScript(element: Element): boolean {
  if (element.tagName !== 'script' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || attribute(element, 'src')) return false
  const type = (attribute(element, 'type') || '').trim().toLowerCase()
  if (!['', 'module', 'text/javascript', 'application/javascript'].includes(type)) return false
  let parent: Node | null = element.parentNode
  let depth = 0
  while (parent && depth++ < 256) {
    if ('tagName' in parent && ['commentthread_comments', 'commentthread_comment', 'commentthread_comment_text', 'bb_code'].some(name => hasClass(parent as Element, name))) return false
    parent = 'parentNode' in parent ? parent.parentNode : null
  }
  return depth < 256
}

function itemTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) : ''
}

function validId(value: unknown, allowZero = false): boolean {
  return typeof value === 'string' && (allowZero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rethrowSessionError(error: unknown): void {
  if (error instanceof DomainError && [
    'SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'SESSION_CHANGED', 'ARTWORK_SESSION_CHANGED',
    'ARTWORK_BACKGROUND_CANCELLED', 'BACKGROUND_CANCELLED', 'WRONG_ACCOUNT', 'NOT_AUTHENTICATED', 'RATE_LIMITED'
  ].includes(error.code)) throw error
}
