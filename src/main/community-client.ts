import { XMLParser } from 'fast-xml-parser'
import { DomainError, normalizeEmoticonToken } from '../shared/domain'
import { CommentCheckResult, FriendRecord, SteamEmoticon } from '../shared/types'
import { parseFriendPage } from './friend-page-parser'
import { parseCommentEligibility } from './comment-eligibility-parser'
import { extractCommunityPageIdentity, extractProfileWebApiToken, getProfileBackgroundCatalog } from './profile-backgrounds'
import type { ProfileBackgroundCatalog } from '../shared/profile-backgrounds'

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

export interface CommunityDiagnosticEvent {
  phase: 'community-request' | 'session-probe'
  outcome: 'success' | 'auth-rejected' | 'access-denied' | 'rate-limited' | 'unverified' | 'request-failed' | 'stale-response'
  reason: 'http-401' | 'login-redirect' | 'not-logged-on' | 'http-403' | 'http-429' | 'identity-match' | 'identity-mismatch' | 'identity-guest' | 'identity-missing' | 'transport-error'
  httpStatus?: number
  method?: 'GET' | 'POST'
}

interface CommunityCookie {
  name: string
  value: string
  path: string
  expiresAt: number | null
}

const COMMUNITY_ORIGIN = 'https://steamcommunity.com'
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const PROFILE_BATCH_SIZE = 100
const PROFILE_BATCH_INTERVAL_MS = 5000

export class SteamCommunityClient {
  private cookies = new Map<string, CommunityCookie>()
  private cookieVersion = 0
  private expiredNotified = false
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    processEntities: false
  })

  constructor(
    private readonly accountId: string,
    cookies: string[],
    private readonly onSessionExpired: () => void,
    private readonly onDiagnostic: (event: CommunityDiagnosticEvent) => void = () => undefined
  ) {
    this.replaceCookies(cookies)
  }

  replaceCookies(cookies: string[]): void {
    const parsed = parseCommunityCookies(cookies, this.accountId)
    this.cookies = parsed
    this.cookieVersion += 1
    this.expiredNotified = false
  }

  getCookies(): string[] {
    return [...this.cookies.values()].filter(cookie => cookie.expiresAt === null || cookie.expiresAt > Date.now())
      .map(cookie => `${cookie.name}=${cookie.value}; Path=${cookie.path}; Secure; Domain=steamcommunity.com${
        cookie.expiresAt === null ? '' : `; Expires=${new Date(cookie.expiresAt).toUTCString()}`
      }`)
  }

  async verifySession(): Promise<void> {
    await this.requestText(`/profiles/${this.accountId}/edit/info?l=english`, {}, 3, () => undefined, (html, version) => {
      const identity = extractCommunityPageIdentity(html)
      if (identity === this.accountId) {
        this.diagnostic({ phase: 'session-probe', outcome: 'success', reason: 'identity-match', method: 'GET' })
        return
      }
      if (identity === 'guest' || identity) {
        this.rejectExpired(version, {
          phase: 'session-probe', outcome: 'auth-rejected',
          reason: identity === 'guest' ? 'identity-guest' : 'identity-mismatch', method: 'GET'
        })
      }
      this.diagnostic({ phase: 'session-probe', outcome: 'unverified', reason: 'identity-missing', method: 'GET' })
      throw new DomainError('SESSION_CHECK_FAILED', '暂时无法核验 Steam 登录状态，请稍后重试', true)
    })
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
    const currentCookies = matchingCookies(this.cookies, '/comment/')
    const rawSessionId = currentCookies.find(cookie => cookie.name === 'sessionid')?.value
    if (!rawSessionId || !currentCookies.some(cookie => cookie.name === 'steamLoginSecure')) {
      this.diagnostic({ phase: 'community-request', outcome: 'auth-rejected', reason: 'not-logged-on', method: 'POST' })
      this.notifyExpired()
      throw new DomainError('SESSION_PREPARATION_FAILED', 'Steam 会话需要更新，尚未提交留言，请稍后继续原任务', true)
    }
    const form = new URLSearchParams({
      comment: message,
      count: '6',
      sessionid: safeDecodeURIComponent(rawSessionId),
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
      const html = await this.requestText(`/profiles/${steamId}/?l=english`, {}, 3, () => undefined, (text, version) => {
        const identity = extractCommunityPageIdentity(text)
        if (identity === 'guest' || (identity && identity !== this.accountId)) {
          this.rejectExpired(version, { phase: 'community-request', outcome: 'auth-rejected',
            reason: identity === 'guest' ? 'identity-guest' : 'identity-mismatch', method: 'GET' })
        }
      })
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

  async getProfileBackgrounds(isCurrent: () => boolean = () => true): Promise<ProfileBackgroundCatalog> {
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new DomainError('ARTWORK_SESSION_CHANGED', '账号或登录会话已变更，请重新打开艺术作品工具')
    }
    const scopedText = async (path: string): Promise<string> => {
      assertCurrent()
      const text = await this.requestText(path, {}, 3, assertCurrent)
      assertCurrent()
      return text
    }
    let tokenPromise: Promise<string> | null = null
    return getProfileBackgroundCatalog(this.accountId, {
      requestText: scopedText,
      requestJson: async (path) => JSON.parse(await scopedText(path)) as unknown,
      requestPlayerJson: async (method, input) => {
        tokenPromise ??= scopedText(`/profiles/${this.accountId}/edit/info`).then(html => {
          const token = extractProfileWebApiToken(html, this.accountId)
          if (!token) throw new Error('BACKGROUND_OWNED_UNAVAILABLE')
          return token
        })
        const token = await tokenPromise
        assertCurrent()
        const url = new URL(`https://api.steampowered.com/IPlayerService/${method}/v1/`)
        url.searchParams.set('access_token', token)
        url.searchParams.set('input_json', JSON.stringify(input))
        try {
          return await withRequestTimeout(20_000, async signal => {
            const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit',
              signal, headers: { Accept: 'application/json' } })
            try {
              assertCurrent()
              if (!response.ok) throw new Error('BACKGROUND_OWNED_UNAVAILABLE')
              return JSON.parse(await readLimitedResponse(response, assertCurrent)) as unknown
            } finally {
              await cancelUnusedBody(response)
            }
          })
        } catch {
          assertCurrent()
          throw new Error('BACKGROUND_OWNED_UNAVAILABLE')
        }
      }
    })
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
    assertCurrent: () => void = () => undefined,
    validateText: (text: string, version: number) => void = () => undefined
  ): Promise<string> {
    assertCurrent()
    const url = new URL(path, COMMUNITY_ORIGIN)
    if (url.origin !== COMMUNITY_ORIGIN || url.username || url.password) throw new Error('Untrusted Community request URL')
    const version = this.cookieVersion
    const method = init.method === 'POST' ? 'POST' : 'GET'
    const cookieHeader = matchingCookies(this.cookies, url.pathname).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    try {
      return await withRequestTimeout(50_000, async signal => {
        const response = await fetch(url, {
          ...init,
          redirect: 'manual',
          signal,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Cookie: cookieHeader,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36',
            ...(init.headers as Record<string, string> | undefined)
          }
        })
        try {
          assertCurrent()
          const location = response.headers.get('location') ?? ''
          const redirectedToLogin =
            response.status >= 300 &&
            response.status < 400 &&
            isLoginRedirect(location, url)
          if (response.status === 429) {
            this.diagnostic({ phase: 'community-request', outcome: 'rate-limited', reason: 'http-429', httpStatus: 429, method })
            throw new DomainError('RATE_LIMITED', 'Steam 请求触发频率限制（HTTP 429），请稍后再试', true)
          }
          if (response.status === 401 || redirectedToLogin) {
            this.rejectExpired(version, { phase: 'community-request', outcome: 'auth-rejected',
              reason: response.status === 401 ? 'http-401' : 'login-redirect', httpStatus: response.status, method })
          }

          if (response.status >= 300 && response.status < 400 && location && redirectsRemaining > 0) {
            const target = new URL(location, url)
            if (
              (!init.method || init.method === 'GET') &&
              target.origin === COMMUNITY_ORIGIN &&
              !target.username && !target.password
            ) {
              await cancelUnusedBody(response)
              assertCurrent()
              if (version === this.cookieVersion) this.acceptResponseCookies(response, url)
              return this.requestText(`${target.pathname}${target.search}`, init, redirectsRemaining - 1, assertCurrent, validateText)
            }
            throw new Error('Steam 好友页面重定向到了不受信任的地址')
          }

          const text = await readLimitedResponse(response, assertCurrent)
          assertCurrent()
          if (isNotLoggedOnResponse(text)) {
            this.rejectExpired(version, { phase: 'community-request', outcome: 'auth-rejected',
              reason: 'not-logged-on', httpStatus: response.status, method })
          }
          if (!response.ok) {
            if (response.status === 403) {
              this.diagnostic({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403, method })
              throw new DomainError('COMMUNITY_ACCESS_DENIED', 'Steam 拒绝了本次请求（HTTP 403），可能是访问或频率限制；尚未确认登录失效，请稍后再试', true)
            }
            throw new Error(`Steam HTTP error ${response.status}`)
          }
          validateText(text, version)
          // Commit rotated cookies only after classifying this response. A rejected response
          // must not make its own authentication error look stale by changing the version.
          if (version === this.cookieVersion) this.acceptResponseCookies(response, url)
          return text
        } finally {
          await cancelUnusedBody(response)
        }
      })
    } catch (error) {
      if (!(error instanceof DomainError)) {
        this.diagnostic({ phase: 'community-request', outcome: 'request-failed', reason: 'transport-error', method })
      }
      throw error
    }
  }

  private acceptResponseCookies(response: Response, url: URL): void {
    let credentialsChanged = false
    for (const line of responseCookieLines(response.headers)) {
      const cookie = parseCommunityCookie(line, this.accountId, defaultCookiePath(url.pathname))
      if (!cookie) continue
      const key = `${cookie.name}\n${cookie.path}`
      const previous = this.cookies.get(key)
      const deleting = cookie.expiresAt !== null && cookie.expiresAt <= Date.now()
      if (!deleting && !previous && this.cookies.size >= 100) continue
      if (deleting) this.cookies.delete(key)
      else this.cookies.set(key, cookie)
      if ((cookie.name === 'steamLoginSecure' || cookie.name === 'sessionid') &&
          (deleting ? !!previous : previous?.value !== cookie.value)) credentialsChanged = true
    }
    if (credentialsChanged) this.cookieVersion += 1
  }

  private rejectExpired(version: number, event: CommunityDiagnosticEvent): never {
    if (version !== this.cookieVersion) {
      this.diagnostic({ ...event, outcome: 'stale-response' })
      throw new DomainError('SESSION_CHANGED', 'Steam 登录会话已更新，旧请求结果待核对，请继续原任务', true)
    }
    this.diagnostic(event)
    this.notifyExpired()
    throw new DomainError('SESSION_EXPIRED', 'Steam Community 会话已失效')
  }

  private diagnostic(event: CommunityDiagnosticEvent): void {
    try { this.onDiagnostic(event) } catch { /* Diagnostics must not affect delivery. */ }
  }

  private notifyExpired(): void {
    if (this.expiredNotified) return
    this.expiredNotified = true
    this.onSessionExpired()
  }
}

async function withRequestTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Steam request timed out', 'TimeoutError')), timeoutMs)
  timer.unref?.()
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function cancelUnusedBody(response: Response): Promise<void> {
  if (response.body && !response.bodyUsed && !response.body.locked) {
    await response.body.cancel().catch(() => undefined)
  }
}

async function readLimitedResponse(response: Response, assertCurrent: () => void): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    throw new Error('Steam response exceeded the size limit')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  let finished = false
  try {
    for (;;) {
      assertCurrent()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        throw new Error('Steam response interrupted', { cause: error })
      }
      assertCurrent()
      if (chunk.done) {
        finished = true
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Steam response exceeded the size limit')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function isNotLoggedOnResponse(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) && (parsed.success === 21 || parsed.success === '21')
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

function parseCommunityCookies(cookieLines: string[], accountId: string): Map<string, CommunityCookie> {
  const output = new Map<string, CommunityCookie>()
  if (!Array.isArray(cookieLines) || cookieLines.length > 100) throw invalidWebSession()
  for (const line of cookieLines) {
    const cookie = parseCommunityCookie(line, accountId, '/')
    if (!cookie || (cookie.expiresAt !== null && cookie.expiresAt <= Date.now())) continue
    const key = `${cookie.name}\n${cookie.path}`
    if (output.has(key) && output.get(key)!.value !== cookie.value) throw invalidWebSession()
    output.set(key, cookie)
  }
  const root = matchingCookies(output, '/')
  if (!root.some(cookie => cookie.name === 'steamLoginSecure') || !root.some(cookie => cookie.name === 'sessionid')) {
    throw invalidWebSession()
  }
  return output
}

function parseCommunityCookie(line: string, accountId: string, defaultPath: string): CommunityCookie | null {
  if (typeof line !== 'string' || line.length > 16_384 || /[\u0000-\u001f\u007f]/.test(line)) return null
  const parts = line.split(';').map(part => part.trim())
  const first = parts.shift() ?? ''
  const separator = first.indexOf('=')
  if (separator <= 0) return null
  const name = first.slice(0, separator)
  const value = first.slice(separator + 1)
  if (!/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) || /[\s,;"\\]/.test(value)) return null
  const attributes = new Map<string, string>()
  for (const part of parts) {
    if (!part) continue
    const index = part.indexOf('=')
    const key = (index < 0 ? part : part.slice(0, index)).toLowerCase()
    if (attributes.has(key)) return null
    attributes.set(key, index < 0 ? '' : part.slice(index + 1))
  }
  const domain = attributes.get('domain')?.replace(/^\./, '').toLowerCase()
  if (domain !== undefined && domain !== 'steamcommunity.com') return null
  const path = attributes.get('path') ?? defaultPath
  if (!path.startsWith('/') || /[\s?#\\]/.test(path)) return null
  if (attributes.has('secure') && attributes.get('secure') !== '') return null
  if (name.startsWith('__Secure-') && !attributes.has('secure')) return null
  if (name.startsWith('__Host-') && (!attributes.has('secure') || domain !== undefined || path !== '/')) return null
  let expiresAt: number | null = null
  if (attributes.has('max-age')) {
    const maxAge = attributes.get('max-age')!
    if (!/^-?\d+$/.test(maxAge) || !Number.isSafeInteger(Number(maxAge))) return null
    expiresAt = Date.now() + Math.min(Number(maxAge), 400 * 86_400) * 1000
  } else if (attributes.has('expires')) {
    expiresAt = Date.parse(attributes.get('expires')!)
    if (!Number.isFinite(expiresAt)) return null
  }
  const deleting = expiresAt !== null && expiresAt <= Date.now()
  if (name === 'steamLoginSecure' || name === 'sessionid') {
    if (path !== '/') return null
    if (!deleting) {
      let decoded: string
      try { decoded = decodeURIComponent(value) } catch { return null }
      if (name === 'steamLoginSecure' && (!decoded.startsWith(`${accountId}||`) || decoded.length <= accountId.length + 2)) return null
      if (name === 'sessionid' && (!decoded || decoded.length > 128 || /[\s\u0000-\u001f\u007f;]/.test(decoded))) return null
    }
  }
  return { name, value, path, expiresAt }
}

function matchingCookies(cookies: Map<string, CommunityCookie>, path: string): CommunityCookie[] {
  return [...cookies.values()].filter(cookie =>
    (cookie.expiresAt === null || cookie.expiresAt > Date.now()) &&
    (path === cookie.path || (path.startsWith(cookie.path) && (cookie.path.endsWith('/') || path[cookie.path.length] === '/')))
  ).sort((left, right) => right.path.length - left.path.length)
}

function defaultCookiePath(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash > 0 ? path.slice(0, lastSlash) : '/'
}

function responseCookieLines(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') return getSetCookie.call(headers)
  return (headers.get('set-cookie') ?? '').split(/,(?=\s*[!#$%&'*+\-.^_`|~\dA-Za-z]+=)/).filter(Boolean)
}

function isLoginRedirect(location: string, source: URL): boolean {
  try {
    const target = new URL(location, source)
    return target.protocol === 'https:' && !target.username && !target.password &&
      (target.origin === 'https://login.steampowered.com' ||
       (target.origin === COMMUNITY_ORIGIN && /^\/login(?:\/|$)/i.test(target.pathname)))
  } catch { return false }
}

function invalidWebSession(): DomainError {
  return new DomainError('INVALID_WEB_SESSION', 'Steam 未返回完整的 Community 会话 Cookie')
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
