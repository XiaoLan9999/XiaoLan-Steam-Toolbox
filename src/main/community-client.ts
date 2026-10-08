import { XMLParser } from 'fast-xml-parser'
import { DomainError, normalizeEmoticonToken } from '../shared/domain'
import { CommentCheckResult, FriendRecord, SteamEmoticon } from '../shared/types'
import { parseFriendPage } from './friend-page-parser'
import { parseCommentEligibility } from './comment-eligibility-parser'

export interface CommunityProfileSummary {
  steamId: string
  displayName: string
  avatarUrl: string
  onlineState: FriendRecord['onlineState']
}

export interface CommunityProfileSummaries {
  profiles: Map<string, CommunityProfileSummary>
  error: Error | null
}

const COMMUNITY_ORIGIN = 'https://steamcommunity.com'
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const PROFILE_BATCH_SIZE = 100
const PROFILE_BATCH_INTERVAL_MS = 5000

export class SteamCommunityClient {
  private readonly cookieHeader: string
  private readonly sessionId: string
  private expiredNotified = false
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    processEntities: false
  })

  constructor(
    private readonly accountId: string,
    cookies: string[],
    private readonly onSessionExpired: () => void
  ) {
    const parsedCookies = parseCommunityCookies(cookies)
    this.cookieHeader = [...parsedCookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
    const rawSessionId = parsedCookies.get('sessionid')
    if (!parsedCookies.has('steamLoginSecure') || !rawSessionId) {
      throw new DomainError('INVALID_WEB_SESSION', 'Steam 未返回完整的 Community 会话 Cookie')
    }
    this.sessionId = safeDecodeURIComponent(rawSessionId)
  }

  async getFriendRelationships(): Promise<Record<string, number>> {
    const body = await this.requestJson<unknown>('/textfilter/ajaxgetfriendslist')
    if (isRecord(body) && (body.success === 21 || body.success === '21')) {
      this.notifyExpired()
      throw new DomainError('SESSION_EXPIRED', 'Steam Community 会话已失效')
    }
    if (!isRecord(body) || (body.success !== 1 && body.success !== '1') || !isRecord(body.friendslist)) {
      throw new Error('Steam returned a malformed friends list')
    }
    const rawFriends = body.friendslist.friends
    if (!Array.isArray(rawFriends)) throw new Error('Steam returned a malformed friends list')
    const relationships: Record<string, number> = {}
    for (const entry of rawFriends) {
      if (!isRecord(entry)) throw new Error('Steam returned a malformed friends list')
      const steamId = entry.ulfriendid
      const rawRelationship = entry.efriendrelationship
      const relationship = typeof rawRelationship === 'number'
        ? rawRelationship
        : typeof rawRelationship === 'string' && /^[0-7]$/.test(rawRelationship)
          ? Number(rawRelationship)
          : NaN
      // A partial parse must never be treated as a complete snapshot that removes friends.
      if (
        typeof steamId !== 'string' || !/^7656119\d{10}$/.test(steamId) ||
        !Number.isInteger(relationship) || relationship < 0 || relationship > 7 ||
        (Object.hasOwn(relationships, steamId) && relationships[steamId] !== relationship)
      ) {
        throw new Error('Steam returned a malformed friends list')
      }
      relationships[steamId] = relationship
    }
    return relationships
  }

  async getProfileSummary(steamId: string): Promise<CommunityProfileSummary> {
    const xml = await this.requestText(`/profiles/${steamId}?xml=1`)
    const parsed = this.xmlParser.parse(xml) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.profile)) {
      throw new Error('Steam returned a malformed profile')
    }
    const profile = parsed.profile
    return {
      steamId: stringValue(profile.steamID64) || steamId,
      displayName: stringValue(profile.steamID) || steamId,
      avatarUrl: stringValue(profile.avatarMedium) || stringValue(profile.avatarFull),
      onlineState: normalizeOnlineState(stringValue(profile.onlineState))
    }
  }

  async getProfileSummaries(steamIds: string[]): Promise<CommunityProfileSummaries> {
    const uniqueIds = [...new Set(steamIds)].filter((steamId) => /^7656119\d{10}$/.test(steamId))
    const output = new Map<string, CommunityProfileSummary>()
    if (uniqueIds.length === 0) return { profiles: output, error: null }
    try {
      // Steam's rendered friends page contains personas without per-batch resolver calls.
      const html = await this.requestText(`/profiles/${this.accountId}/friends/`, {}, 3)
      for (const [steamId, profile] of parseFriendPage(html, uniqueIds)) output.set(steamId, profile)
    } catch (error) {
      if (error instanceof DomainError && ['SESSION_EXPIRED', 'RATE_LIMITED'].includes(error.code)) {
        return { profiles: output, error }
      }
      // Private or changed pages can fall back to the bounded JSON resolver below.
    }
    const missingIds = uniqueIds.filter((steamId) => !output.has(steamId))
    for (let offset = 0; offset < missingIds.length; offset += PROFILE_BATCH_SIZE) {
      try {
        if (offset > 0) await new Promise((resolve) => setTimeout(resolve, PROFILE_BATCH_INTERVAL_MS))
        const chunk = missingIds.slice(offset, offset + PROFILE_BATCH_SIZE)
        // IDs are validated above; keeping commas literal also avoids inflating the GET URL.
        const body = await this.requestJson<unknown>(
          `/actions/ajaxresolveusers?steamids=${chunk.join(',')}`
        )
        if (!Array.isArray(body)) throw new Error('Steam 好友资料接口返回了无法识别的数据')
        const requestedIds = new Set(chunk)
        for (const entry of body) {
          if (!isRecord(entry)) continue
          const steamId = stringValue(entry.steamid)
          const displayName = stringValue(entry.persona_name)
          if (!requestedIds.has(steamId) || !displayName) continue
          const personaState = Number(entry.persona_state)
          output.set(steamId, {
            steamId,
            displayName,
            avatarUrl: avatarUrlFromValue(entry.avatar_url),
            onlineState: personaState === 0 ? 'offline' : personaState > 0 ? 'online' : 'unknown'
          })
        }
      } catch (error) {
        // Do not discard earlier batches or keep hitting a failing/rate-limited endpoint.
        return { profiles: output, error: error instanceof Error ? error : new Error(String(error)) }
      }
    }
    return { profiles: output, error: null }
  }

  async getEmoticons(): Promise<SteamEmoticon[]> {
    // EmoticonList returns [] for both a valid empty inventory and some logged-out sessions.
    await this.getFriendRelationships()
    const body = await this.requestJson<unknown>('/actions/EmoticonList')
    if (!Array.isArray(body) || body.some((entry) => typeof entry !== 'string')) {
      throw new Error('Steam returned a malformed emoticon list')
    }

    const output = new Map<string, SteamEmoticon>()
    for (const entry of body as string[]) {
      const nameWithoutDelimiters = entry.replaceAll(':', '')
      const candidate = `:${nameWithoutDelimiters}:`
      const token = normalizeEmoticonToken(candidate)
      if (!token) continue
      const name = token.slice(1, -1)
      output.set(token, {
        accountId: this.accountId,
        token,
        name,
        imageUrl: `https://community.akamai.steamstatic.com/economy/emoticon/${encodeURIComponent(name)}`,
        count: 1
      })
    }
    return [...output.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async postProfileComment(
    friendSteamId: string,
    message: string
  ): Promise<{ commentId: string | null }> {
    const form = new URLSearchParams({
      comment: message,
      count: '6',
      sessionid: this.sessionId,
      feature2: '-1'
    })
    const body = await this.requestJson<unknown>(
      `/comment/Profile/post/${friendSteamId}/-1/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: COMMUNITY_ORIGIN,
          Referer: `${COMMUNITY_ORIGIN}/profiles/${friendSteamId}/`
        },
        body: form.toString()
      }
    )
    if (!isRecord(body)) throw new Error('Steam returned a malformed comment response')
    if (body.success !== true && Number(body.success) !== 1) {
      throw new Error(typeof body.error === 'string' ? body.error : 'Steam rejected the profile comment')
    }
    const commentsHtml = typeof body.comments_html === 'string' ? body.comments_html : ''
    const commentId = commentsHtml.match(/\bid=["']comment_(\d+)["']/i)?.[1] ?? null
    return { commentId }
  }

  async checkCommentEligibility(steamId: string): Promise<CommentCheckResult> {
    if (!/^7656119\d{10}$/.test(steamId)) {
      throw new DomainError('INVALID_STEAM_ID', '目标 SteamID 无效')
    }
    try {
      const html = await this.requestText(`/profiles/${steamId}/?l=english`, {}, 3, false)
      if (isNotLoggedOnResponse(html)) {
        this.notifyExpired()
        throw new DomainError('SESSION_EXPIRED', 'Steam Community 会话已失效')
      }
      return parseCommentEligibility(html, steamId)
    } catch (error) {
      if (error instanceof DomainError) throw error
      const message = error instanceof Error ? error.message : ''
      if (/fetch failed|network|timeout|timed out|socket|econn|HTTP error 5\d\d/i.test(message)) {
        throw new DomainError('CHECK_REQUEST_FAILED', '资料页面请求失败，检查已暂停，请稍后重试', true)
      }
      return { status: 'unknown', reason: '资料页面请求失败，暂时无法确定留言权限' }
    }
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const text = await this.requestText(path, init)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('Steam returned invalid JSON')
    }
  }

  private async requestText(
    path: string,
    init: RequestInit = {},
    redirectsRemaining = 0,
    forbiddenMeansExpired = true
  ): Promise<string> {
    const url = new URL(path, COMMUNITY_ORIGIN)
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(50_000),
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Cookie: this.cookieHeader,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36',
        ...(init.headers as Record<string, string> | undefined)
      }
    })
    const location = response.headers.get('location') ?? ''
    const redirectedToLogin =
      response.status >= 300 &&
      response.status < 400 &&
      (location.includes('/login/') || location.includes('login.steampowered.com'))
    if (response.status === 401 || (response.status === 403 && forbiddenMeansExpired) || redirectedToLogin) {
      this.notifyExpired()
      throw new DomainError('SESSION_EXPIRED', 'Steam Community 会话已失效')
    }

    if (response.status >= 300 && response.status < 400 && location && redirectsRemaining > 0) {
      const target = new URL(location, url)
      if (
        (!init.method || init.method === 'GET') &&
        target.origin === COMMUNITY_ORIGIN &&
        !target.username && !target.password
      ) {
        await response.body?.cancel()
        return this.requestText(`${target.pathname}${target.search}`, init, redirectsRemaining - 1, forbiddenMeansExpired)
      }
      throw new Error('Steam 好友页面重定向到了不受信任的地址')
    }

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error('Steam response exceeded the size limit')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Steam response exceeded the size limit')
    }
    if (!response.ok) {
      if (isNotLoggedOnResponse(text)) {
        this.notifyExpired()
        throw new DomainError('SESSION_EXPIRED', 'Steam Community 会话已失效')
      }
      if (response.status === 429) {
        throw new DomainError('RATE_LIMITED', 'Steam 请求触发频率限制（HTTP 429），请稍后再试', true)
      }
      throw new Error(`Steam HTTP error ${response.status}`)
    }
    return text
  }

  private notifyExpired(): void {
    if (this.expiredNotified) return
    this.expiredNotified = true
    this.onSessionExpired()
  }
}

function isNotLoggedOnResponse(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) && Number(parsed.success) === 21
  } catch {
    return false
  }
}

function avatarUrlFromValue(value: unknown): string {
  const avatar = stringValue(value)
  if (/^https:\/\//i.test(avatar)) return avatar
  if (/^[a-f0-9]{40}$/i.test(avatar)) {
    return `https://avatars.akamai.steamstatic.com/${avatar}_medium.jpg`
  }
  return ''
}

function parseCommunityCookies(cookieLines: string[]): Map<string, string> {
  const output = new Map<string, string>()
  for (const line of cookieLines) {
    const parts = line.split(';').map((part) => part.trim())
    const first = parts[0]
    if (!first) continue
    const separator = first.indexOf('=')
    if (separator <= 0) continue
    const domainPart = parts.find((part) => part.toLowerCase().startsWith('domain='))
    const domain = domainPart?.slice(7).replace(/^\./, '').toLowerCase()
    if (domain && domain !== 'steamcommunity.com' && !domain.endsWith('.steamcommunity.com')) continue
    output.set(first.slice(0, separator), first.slice(separator + 1))
  }
  return output
}

function normalizeOnlineState(value: string): FriendRecord['onlineState'] {
  if (value === 'in-game' || value === 'online' || value === 'offline') return value
  return 'unknown'
}

function stringValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
