import { XMLParser } from 'fast-xml-parser'
import { DomainError, normalizeEmoticonToken } from '../shared/domain'
import { CommentCheckResult, FriendRecord, SteamEmoticon } from '../shared/types'
import { parseFriendPage } from './friend-page-parser'
import { parseCommentEligibility } from './comment-eligibility-parser'
import { extractCommunityPageIdentity, extractProfileWebApiToken, getProfileBackgroundCatalog } from './profile-backgrounds'
import type { ProfileBackgroundCatalog } from '../shared/profile-backgrounds'
import { STEAM_WEB_USER_AGENT } from './steam-user-agent'
import { CommentPreflightError } from '../shared/comment-preflight'
import { CommentPermissionDeniedError } from '../shared/comment-permission'
import { batchInterruption } from '../shared/batch-retry-policy'
import { parseCommentSnapshot, reconcileCommentSnapshots, verifyCommentAttempt,
  type CommentAttemptEvidence, type CommentServerWindow, type CommentSnapshot,
  type CommentVerificationResult } from './comment-reconciliation'

interface CommunityResponseMetadata {
  requestStartedAt: number
  receivedAt: number
  serverDate: number | null
  elapsedMs: number
  receivedMonotonic: number
}

function completedSubmissionWindow(metadata: CommunityResponseMetadata): CommentServerWindow | null {
  if (metadata.serverDate === null || !Number.isFinite(metadata.serverDate) || metadata.serverDate <= 0 ||
    !Number.isFinite(metadata.elapsedMs) || metadata.elapsedMs < 0 || metadata.elapsedMs > 50_000) return null
  return {
    earliest: Math.floor((metadata.serverDate - metadata.elapsedMs) / 1000) - 2,
    latest: Math.floor(metadata.serverDate / 1000) + 2
  }
}

function estimatedSubmissionWindow(metadata: CommunityResponseMetadata | null): CommentServerWindow | null {
  if (!metadata || !completedSubmissionWindow(metadata)) return null
  const sinceResponse = performance.now() - metadata.receivedMonotonic
  if (!Number.isFinite(sinceResponse) || sinceResponse < 0 || sinceResponse > 300_000) return null
  // The server clock anchors the window; monotonic elapsed time survives local clock changes.
  return {
    earliest: Math.floor((metadata.serverDate! - metadata.elapsedMs + sinceResponse) / 1000) - 2,
    latest: Math.floor((metadata.serverDate! + sinceResponse + 50_000) / 1000) + 2
  }
}

function copyAttemptEvidence(evidence: CommentAttemptEvidence): CommentAttemptEvidence {
  return { baselineIds: [...evidence.baselineIds], serverWindow: evidence.serverWindow ? { ...evidence.serverWindow } : null,
    submittedAt: evidence.submittedAt }
}

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
  phase: 'community-request' | 'session-probe' | 'comment-reconcile' | 'comment-preflight'
  outcome: 'success' | 'auth-rejected' | 'access-denied' | 'rate-limited' | 'unverified' | 'request-failed' | 'stale-response'
  reason: 'http-401' | 'login-redirect' | 'not-logged-on' | 'http-403' | 'http-429' | 'identity-match' | 'identity-mismatch' | 'identity-guest' | 'identity-missing' | 'transport-error' | 'comment-reconciled'
    | 'baseline-missing' | 'baseline-incomplete' | 'baseline-unreadable' | 'target-unavailable'
  httpStatus?: number
  method?: 'GET' | 'POST'
  endpoint?: 'profile-comment' | 'session-verify' | 'other'
  responseKind?: 'json' | 'html' | 'empty' | 'other'
  denialKind?: 'access-denied' | 'challenge' | 'unknown'
  responseCode?: number
  retryAfterMs?: number
  commentDenialReason?: CommentDenialReason
  errorPresent?: boolean
}

export type CommentDenialReason = 'unknown' | 'csrf-sessionid' | 'posting-too-frequently'
  | 'target-comments-disabled' | 'friends-only' | 'target-blocked' | 'account-restricted' | 'challenge'

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

// This sentinel is a long server hint, not a timer delay to execute.
export const RETRY_AFTER_TOO_LONG_MS = Number.MAX_SAFE_INTEGER
const MAX_PARSED_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const significant = trimmed.replace(/^0+/, '')
    if (significant.length > 6) return RETRY_AFTER_TOO_LONG_MS
    const milliseconds = Number(significant || '0') * 1000
    return milliseconds > MAX_PARSED_RETRY_AFTER_MS ? RETRY_AFTER_TOO_LONG_MS : milliseconds
  }

  const shortDay = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)'
  const month = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
  const time = '([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)'
  let dateText = trimmed
  let fields = trimmed.match(new RegExp(`^${shortDay}, (\\d{2}) ${month} (\\d{4}) ${time} GMT$`, 'i'))?.slice(1)
  fields ??= trimmed.match(new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${month}-(\\d{2}) ${time} GMT$`, 'i'))?.slice(1)
  if (!fields) {
    const asctime = trimmed.match(new RegExp(`^${shortDay} ${month} ( [1-9]|[12]\\d|3[01]) ${time} (\\d{4})$`, 'i'))
    if (asctime) {
      fields = [asctime[2]!, asctime[1]!, asctime[6]!, asctime[3]!, asctime[4]!, asctime[5]!]
      dateText += ' GMT'
    }
  }
  if (!fields) return undefined
  let deadline = Date.parse(dateText)
  if (!Number.isFinite(deadline)) return undefined
  const date = new Date(deadline)
  if (fields[2]!.length === 2) {
    const currentYear = new Date(now).getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(fields[2])
    if (year > currentYear + 50) year -= 100
    date.setUTCFullYear(year)
    deadline = date.getTime()
  } else if (date.getUTCFullYear() !== Number(fields[2])) return undefined
  const parsedMonth = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(fields[1]!.toLowerCase())
  if (date.getUTCDate() !== Number(fields[0]) || date.getUTCMonth() !== parsedMonth) return undefined
  const milliseconds = Math.max(0, deadline - now)
  return milliseconds > MAX_PARSED_RETRY_AFTER_MS ? RETRY_AFTER_TOO_LONG_MS : milliseconds
}

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

  /** Short-lived CM credential; keep this entirely inside the main process. */
  async getGameStatusLogin(): Promise<{ steamId: string; accountName: string; webLogonToken: string }> {
    let body: unknown
    await this.requestText('/chat/clientjstoken', { cache: 'no-store' }, 0, () => undefined, (raw, version) => {
      try { body = JSON.parse(raw) as unknown } catch { throw new Error('Steam returned invalid JSON') }
      if (isRecord(body) && body.logged_in === false) {
        this.rejectExpired(version, { phase: 'community-request', outcome: 'auth-rejected', reason: 'not-logged-on', method: 'GET' })
      }
    })
    if (!isRecord(body) || body.logged_in !== true || body.steamid !== this.accountId ||
      typeof body.account_name !== 'string' || !body.account_name.trim() || Buffer.byteLength(body.account_name) > 128 ||
      /[\p{Cc}\u2028\u2029]/u.test(body.account_name) ||
      typeof body.token !== 'string' || !body.token || Buffer.byteLength(body.token) > 4096 || /[\s\p{Cc}]/u.test(body.token)) {
      throw new DomainError('GAME_STATUS_AUTH_FAILED', '无法复用当前工具箱登录，请在工具箱账号页确认登录后重试')
    }
    return { steamId: this.accountId, accountName: body.account_name, webLogonToken: body.token }
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
    message: string,
    assertCanSubmit: () => void = () => undefined,
    onEvidence: (evidence: CommentAttemptEvidence) => void = () => undefined
  ): Promise<{ commentId: string | null }> {
    assertCanSubmit()
    this.requireCommentSessionId()
    let baseline: CommentSnapshot
    let baselineMetadata: CommunityResponseMetadata | null = null
    try {
      baseline = await this.getCommentSnapshot(friendSteamId, assertCanSubmit, metadata => { baselineMetadata = metadata }, true)
      if (!baseline.threadExists) throw new DomainError('COMMENT_BASELINE_MISSING', '资料页未提供可核验的目标评论区')
      if (!baseline.complete || baseline.comments.length > 1000) throw new DomainError('COMMENT_BASELINE_INCOMPLETE', '目标评论区内容不完整或结构无法可靠解析')
    } catch (error) {
      if (error instanceof DomainError && ['FRIEND_NOT_FOUND', 'FRIEND_BLACKLISTED', 'COMMENT_TARGET_UNAVAILABLE',
        'SESSION_PREPARATION_FAILED'].includes(error.code)) throw error
      const reason = error instanceof DomainError && error.code === 'COMMENT_BASELINE_MISSING' ? 'baseline-missing'
        : error instanceof DomainError && error.code === 'COMMENT_BASELINE_INCOMPLETE' ? 'baseline-incomplete' : 'baseline-unreadable'
      this.diagnostic({ phase: 'comment-preflight', outcome: 'unverified', reason, method: 'GET', endpoint: 'profile-comment' })
      throw commentPreflightFailure(error)
    }
    assertCanSubmit()
    const rawSessionId = this.requireCommentSessionId()
    const form = new URLSearchParams({
      comment: message,
      count: '6',
      sessionid: safeDecodeURIComponent(rawSessionId),
      feature2: '-1'
    })
    const version = this.cookieVersion
    const submittedAt = Date.now()
    const evidence: CommentAttemptEvidence = {
      baselineIds: baseline.comments.map(comment => comment.id),
      serverWindow: estimatedSubmissionWindow(baselineMetadata),
      submittedAt: new Date(submittedAt).toISOString()
    }
    try {
      onEvidence(copyAttemptEvidence(evidence))
    } catch {
      throw new DomainError('SESSION_PREPARATION_FAILED', '无法保存留言核对证据，尚未提交留言；请检查本地存储后继续原任务', true)
    }
    assertCanSubmit()
    let postMetadata: CommunityResponseMetadata | null = null
    let body: unknown
    try {
      body = await this.requestJson<unknown>(
        `/comment/Profile/post/${friendSteamId}/-1/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Origin: COMMUNITY_ORIGIN,
            Referer: `${COMMUNITY_ORIGIN}/profiles/${friendSteamId}/`
          },
          body: form.toString()
        },
        metadata => {
          postMetadata = metadata
          let serverWindow = completedSubmissionWindow(metadata)
          if (!serverWindow) return
          if (evidence.serverWindow) {
            serverWindow = { earliest: Math.max(evidence.serverWindow.earliest, serverWindow.earliest),
              latest: Math.min(evidence.serverWindow.latest, serverWindow.latest) }
            if (serverWindow.latest < serverWindow.earliest) return
          }
          evidence.serverWindow = serverWindow
          try { onEvidence(copyAttemptEvidence(evidence)) }
          catch {
            throw new DomainError('COMMENT_POST_UNCERTAIN', '留言请求已提交，但无法保存响应核对证据；不会自动重发', false)
          }
        }
      )
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'COMMUNITY_ACCESS_DENIED') throw error
      // A real Steam POST returned 403/success:2 after creating the comment. Never replay it solely on that response.
      try {
        const metadata = postMetadata as CommunityResponseMetadata | null
        const responseWindow = metadata ? completedSubmissionWindow(metadata) : null
        if (responseWindow && version === this.cookieVersion) {
          const earliest = Math.max(responseWindow.earliest, evidence.serverWindow?.earliest ?? responseWindow.earliest)
          const latest = Math.min(responseWindow.latest, evidence.serverWindow?.latest ?? responseWindow.latest)
          if (latest >= earliest && latest - earliest <= 300) {
            const after = await this.getCommentSnapshot(friendSteamId)
            if (version === this.cookieVersion) {
              const result = reconcileCommentSnapshots(baseline, after, this.accountId, message, { earliest, latest })
              if (result.status === 'confirmed') {
                this.diagnostic({ phase: 'comment-reconcile', outcome: 'success', reason: 'comment-reconciled', httpStatus: 200,
                  method: 'GET', endpoint: 'profile-comment' })
                return { commentId: result.comment.id }
              }
            }
          }
        }
      } catch { /* A failed read-back cannot justify another POST or a false success. */ }
      const uncertainMessage = `Steam 拒绝响应，但发送结果待核对；为防重复不会自动重发。${error.message}`
      if (error instanceof CommentPermissionDeniedError) {
        throw new CommentPermissionDeniedError('COMMENT_POST_UNCERTAIN', uncertainMessage, error.retryAfterMs)
      }
      throw new DomainError('COMMENT_POST_UNCERTAIN', uncertainMessage, false, error.retryAfterMs)
    }
    if (!isRecord(body)) throw new Error('Steam returned a malformed comment response')
    if (body.success !== true && Number(body.success) !== 1) {
      const normalized = typeof body.error === 'string' ? normalizeCommentError(body.error) : null
      const safeError = normalized === null ? null : safeCommentErrorMessage(normalized)
      const denial = normalized !== null && safeError !== null ? explicitCommentTargetDenial(normalized) : null
      if (denial) {
        if (typeof body.comments_html === 'string' && /\bid=["']comment_[1-9]\d{0,19}["']/i.test(body.comments_html)) {
          throw new DomainError('COMMENT_POST_UNCERTAIN', 'Steam 返回的留言结果与权限提示不一致，保留待核对且不会重复发送')
        }
        this.diagnostic({ phase: 'community-request', outcome: 'access-denied', reason: 'target-unavailable',
          method: 'POST', endpoint: 'profile-comment', httpStatus: 200, commentDenialReason: denial.reason, errorPresent: true })
        throw new DomainError('COMMENT_TARGET_UNAVAILABLE', denial.message)
      }
      throw new Error(safeError ?? 'Steam rejected the profile comment')
    }
    const commentsHtml = typeof body.comments_html === 'string' ? body.comments_html : ''
    const commentId = commentsHtml.match(/\bid=["']comment_(\d+)["']/i)?.[1] ?? null
    return { commentId }
  }

  async reconcileProfileComment(
    friendSteamId: string,
    message: string,
    evidence: CommentAttemptEvidence | null,
    assertCurrent: () => void = () => undefined
  ): Promise<CommentVerificationResult> {
    assertCurrent()
    const version = this.cookieVersion
    const snapshot = await this.getCommentSnapshot(friendSteamId, assertCurrent)
    assertCurrent()
    if (version !== this.cookieVersion) {
      throw new DomainError('SESSION_CHANGED', '核对期间 Steam 登录会话已更新，本次只读结果已取消，请稍后重试', true)
    }
    return verifyCommentAttempt(snapshot, this.accountId, message, evidence)
  }

  private requireCommentSessionId(): string {
    const currentCookies = matchingCookies(this.cookies, '/comment/')
    const rawSessionId = currentCookies.find(cookie => cookie.name === 'sessionid')?.value
    if (!rawSessionId || !currentCookies.some(cookie => cookie.name === 'steamLoginSecure')) {
      this.diagnostic({ phase: 'community-request', outcome: 'auth-rejected', reason: 'not-logged-on', method: 'POST' })
      this.notifyExpired()
      throw new DomainError('SESSION_PREPARATION_FAILED', 'Steam 会话需要更新，尚未提交留言，请稍后继续原任务', true)
    }
    return rawSessionId
  }

  private async getCommentSnapshot(
    steamId: string,
    assertCurrent: () => void = () => undefined,
    onResponse: (metadata: CommunityResponseMetadata) => void = () => undefined,
    checkAvailability = false
  ): Promise<CommentSnapshot> {
    if (!/^7656119\d{10}$/.test(steamId)) throw new DomainError('INVALID_STEAM_ID', '目标 SteamID 无效')
    const html = await this.requestText(`/profiles/${steamId}/?l=english`, {}, 3, assertCurrent, (text, version) => {
      const identity = extractCommunityPageIdentity(text)
      if (identity !== this.accountId) {
        if (identity) this.rejectExpired(version, { phase: 'community-request', outcome: 'auth-rejected', reason: 'identity-mismatch', method: 'GET' })
        throw new DomainError('SESSION_CHECK_FAILED', '无法核验目标资料页中的当前登录身份', true)
      }
    }, onResponse)
    assertCurrent()
    if (checkAvailability) {
      const eligibility = parseCommentEligibility(html, steamId)
      if (eligibility.status === 'blocked') {
        this.diagnostic({ phase: 'comment-preflight', outcome: 'unverified', reason: 'target-unavailable', method: 'GET', endpoint: 'profile-comment' })
        throw new DomainError('COMMENT_TARGET_UNAVAILABLE', `留言前检查未通过：${eligibility.reason}；尚未提交留言`)
      }
    }
    return parseCommentSnapshot(html, steamId)
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

  private async requestJson<T>(path: string, init?: RequestInit, onResponse?: (metadata: CommunityResponseMetadata) => void): Promise<T> {
    const text = await this.requestText(path, init, 0, () => undefined, () => undefined, onResponse)
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
    validateText: (text: string, version: number) => void = () => undefined,
    onResponse: (metadata: CommunityResponseMetadata) => void = () => undefined
  ): Promise<string> {
    assertCurrent()
    const url = new URL(path, COMMUNITY_ORIGIN)
    if (url.origin !== COMMUNITY_ORIGIN || url.username || url.password) throw new Error('Untrusted Community request URL')
    const version = this.cookieVersion
    const method = init.method === 'POST' ? 'POST' : 'GET'
    const cookieHeader = matchingCookies(this.cookies, url.pathname).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    try {
      return await withRequestTimeout(50_000, async signal => {
        const requestStartedAt = Date.now()
        const requestStartedMonotonic = performance.now()
        const response = await fetch(url, {
          ...init,
          redirect: 'manual',
          signal,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Cookie: cookieHeader,
            'User-Agent': STEAM_WEB_USER_AGENT,
            ...(init.headers as Record<string, string> | undefined)
          }
        })
        try {
          const rawDate = response.headers.get('date')
          const parsedDate = rawDate && /GMT$/i.test(rawDate) ? Date.parse(rawDate) : NaN
          const receivedMonotonic = performance.now()
          onResponse({ requestStartedAt, receivedAt: Date.now(), serverDate: Number.isFinite(parsedDate) ? parsedDate : null,
            elapsedMs: receivedMonotonic - requestStartedMonotonic, receivedMonotonic })
          assertCurrent()
          const location = response.headers.get('location') ?? ''
          const redirectedToLogin =
            response.status >= 300 &&
            response.status < 400 &&
            isLoginRedirect(location, url)
          if (response.status === 429) {
            this.diagnostic({ phase: 'community-request', outcome: 'rate-limited', reason: 'http-429', httpStatus: 429, method })
            throw new DomainError('RATE_LIMITED', 'Steam 请求触发频率限制（HTTP 429），请稍后再试', true,
              parseRetryAfterMs(response.headers.get('retry-after')))
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
              return this.requestText(`${target.pathname}${target.search}`, init, redirectsRemaining - 1, assertCurrent, validateText, onResponse)
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
              const shape = forbiddenResponseShape(text)
              const detail = commentDenialDetail(text)
              const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
              this.diagnostic({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403, method,
                endpoint: communityEndpoint(url.pathname), ...shape,
                ...detail.diagnostic,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
              const responseDescription = shape.denialKind === 'challenge' ? '验证页面拒绝'
                : shape.responseKind === 'json' ? 'JSON 拒绝'
                  : shape.responseKind === 'html' ? 'HTML 拒绝' : '访问拒绝'
              const explanation = detail.message ? `。Steam 原因：${detail.message}` : ''
              const message = `Steam 返回${responseDescription}（HTTP 403）；尚未确认登录失效或具体限制原因，请稍后再试${explanation}`
              if (communityEndpoint(url.pathname) === 'profile-comment' && detail.permissionDenied) {
                throw new CommentPermissionDeniedError('COMMUNITY_ACCESS_DENIED', message, retryAfterMs)
              }
              throw new DomainError('COMMUNITY_ACCESS_DENIED', message, true, retryAfterMs)
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

function commentPreflightFailure(error: unknown): CommentPreflightError {
  let interruption = batchInterruption(error)
  const descriptions: Partial<Record<typeof interruption.code, string>> = {
    RATE_LIMITED: '读取目标评论区触发 Steam 频率限制（HTTP 429）',
    ACCESS_DENIED: 'Steam 拒绝读取目标评论区（HTTP 403），尚不能确定具体限制原因',
    SESSION_EXPIRED: '读取目标评论区时 Steam 网页登录已失效',
    SESSION_PREPARATION: '读取目标评论区时无法核验当前登录身份',
    SESSION_CHANGED: '读取目标评论区时登录会话发生变更',
    LOGIN_REQUIRED: '读取目标评论区前需要登录 Steam',
    ACCOUNT_CHANGED: '读取目标评论区时账号发生变更',
    NETWORK_ERROR: '读取目标评论区时网络请求失败',
    SERVER_ERROR: '读取目标评论区时 Steam 服务暂时异常'
  }
  let description = descriptions[interruption.code]
  if (!description) {
    interruption = { code: 'COMMENT_BASELINE', canRetry: true, rejectedBeforeAcceptance: true,
      retryAfterMs: error instanceof DomainError ? error.retryAfterMs : undefined }
    description = error instanceof DomainError && error.code === 'COMMENT_BASELINE_MISSING'
      ? '资料页未提供可核验的目标评论区，暂不能确定留言权限'
      : error instanceof DomainError && error.code === 'COMMENT_BASELINE_INCOMPLETE'
        ? '目标评论区内容不完整或结构无法可靠解析' : '暂时无法可靠读取目标评论区'
  }
  return new CommentPreflightError(`${description}；尚未提交留言，当前好友保留待发`, interruption)
}

function isNotLoggedOnResponse(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) && (parsed.success === 21 || parsed.success === '21')
  } catch {
    return false
  }
}

function communityEndpoint(path: string): NonNullable<CommunityDiagnosticEvent['endpoint']> {
  if (/^\/comment\/Profile\/post\/\d+\/-1\/?$/.test(path)) return 'profile-comment'
  if (/^\/profiles\/\d+\/edit\/info\/?$/.test(path)) return 'session-verify'
  return 'other'
}

function forbiddenResponseShape(text: string): Pick<CommunityDiagnosticEvent, 'responseKind' | 'denialKind' | 'responseCode'> {
  const trimmed = text.trim()
  if (!trimmed) return { responseKind: 'empty', denialKind: 'unknown' }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    let responseCode: number | undefined
    if (isRecord(parsed) && !Array.isArray(parsed)) {
      // Only small numeric protocol codes are diagnostics; never coerce strings or booleans.
      for (const field of ['eresult', 'error_code', 'errorcode', 'code', 'error', 'success']) {
        if (!Object.hasOwn(parsed, field)) continue
        const value = parsed[field]
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) {
          responseCode = value
          break
        }
      }
    }
    return { responseKind: 'json', denialKind: responseCode === 15 ? 'access-denied' : 'unknown',
      ...(responseCode === undefined ? {} : { responseCode }) }
  } catch { /* Non-JSON rejection pages are classified without retaining their content. */ }
  if (/^(?:<!doctype\s+html\b|<!--|<[a-z][\w:-]*(?:\s|>))/i.test(trimmed)) {
    const challenge = /\b(?:g-recaptcha|h-captcha|cf-turnstile|cf-chl-[\w-]+|challenge-platform)\b|(?:id|name)\s*=\s*["'][^"']*captcha|\b(?:verify (?:that )?you are (?:a )?human|human verification|complete (?:the )?captcha)\b|人机验证/i.test(trimmed)
    const denied = /\baccess\s+denied\b|\bpermission\s+denied\b/i.test(trimmed)
    return { responseKind: 'html', denialKind: challenge ? 'challenge' : denied ? 'access-denied' : 'unknown' }
  }
  return { responseKind: 'other', denialKind: 'unknown' }
}

function commentDenialDetail(text: string): {
  message: string | null
  diagnostic: Pick<CommunityDiagnosticEvent, 'commentDenialReason' | 'errorPresent'>
  permissionDenied?: boolean
} {
  try {
    const body: unknown = JSON.parse(text)
    if (!isRecord(body) || Array.isArray(body) || !Object.hasOwn(body, 'error') || typeof body.error !== 'string') {
      return { message: null, diagnostic: {} }
    }
    const errorPresent = body.error.trim().length > 0
    const normalized = normalizeCommentError(body.error)
    const message = normalized === null ? null : safeCommentErrorMessage(normalized)
    return {
      message,
      permissionDenied: normalized !== null && message !== null && explicitCommentTargetDenial(normalized) !== null,
      diagnostic: { errorPresent, commentDenialReason: normalized === null ? 'unknown' : classifyCommentError(normalized) }
    }
  } catch { return { message: null, diagnostic: {} } }
}

function normalizeCommentError(value: string): string | null {
  if (!value || value.length > 4096) return null
  const removeControls = (input: string) => input.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, '')
  let plain = removeControls(value)
  // Decode only inert character references, never scripts, URLs, or other JSON fields.
  for (let pass = 0; pass < 2; pass++) {
    plain = plain.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (_match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[named.toLowerCase()]!
      const number = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16)
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ''
    })
    plain = removeControls(plain)
  }
  if (/\\(?:u[\da-f]{4}|x[\da-f]{2})|%[\da-f]{2}|&(?:[a-z][a-z\d]{1,31}|#[^;\s]+);/i.test(plain)) return null
  plain = plain.replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '').replace(/\s+/gu, ' ').trim()
  return plain || null
}

function safeCommentErrorMessage(value: string): string | null {
  // Suppress credential-shaped messages entirely; partial redaction is not reliable for tokens.
  if (/\b(?:steam\s*Login\s*(?:Secure)?|steamMachineAuth\d*|session[_ -]*id|(?:access|refresh)[_ -]*token|auth(?:orization|[_ -]*(?:token|key|code))?|bearer|(?:set-)?cookie|api[_ -]*key|password|token|csrf[_ -]*(?:token|key))["']?\s*(?:[=:：]|\bis\s+(?!invalid\b|missing\b|expired\b|incorrect\b))/i.test(value)
    || /\b(?:steamLogin(?:Secure)?|steamMachineAuth\d*|(?:access|refresh)[_ -]?token|authorization|bearer|(?:set-)?cookie|password|api[_ -]?key)\s+(?!invalid\b|missing\b|expired\b|incorrect\b|denied\b|failed\b|required\b|rejected\b)\S+/i.test(value)
    || /\bBearer\s+\S+/i.test(value)
    || /\b[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/.test(value)
    || /[A-Za-z\d_+/=-]{24,}/.test(value)) return null
  let safe = value.replace(/[A-Z\d.!#$%&'*+/=?^_`{|}~-]+@[A-Z\d.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b(?:https?|ftp|file|steam):\/\/[^\s<>]+|\bwww\.[^\s<>]+|\b(?:[A-Z\d](?:[A-Z\d-]*[A-Z\d])?\.)+[A-Z]{2,63}(?::\d{1,5})?(?:\/[^\s<>]*)?/gi, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s<>]*)?|\b[A-Z]:[\\/][^\s<>]+/gi, '[redacted]')
    .replace(/\b\d{17}\b/g, '[redacted]')
    .replace(/[<>]/g, '').trim()
  if (!safe || (!/\s|\p{Script=Han}/u.test(safe) && !/^(?:forbidden|denied|error)[.!]?$/i.test(safe))) return null
  safe = Array.from(safe).slice(0, 160).join('')
  return safe
}

function classifyCommentError(value: string): CommentDenialReason {
  const assertion = value.replace(/^your comment was not posted because /i, '')
    .replace(/^your account does not have permission to post comments\b/i, 'account restriction')
    .replace(/^(?:your|this) account is not (?:allowed|permitted) to (?:post|leave|add) comments?\b/i, 'account restriction')
    .replace(/^you are not (?:allowed|permitted) to (?:post|leave|add) comments? on (?:this|the) profile\b/i, 'account restriction')
    .replace(/^the settings on this account do not allow you to (?:post|leave|add) comments?\b/i, 'account restriction')
  if (/\b(?:example|sample|quotation|quoted|says?|means?)\b|示例|引用|并非|并未|没有|不是|不需要|无需|未(?:被|遭|受)|\b(?:is|are|was|were|has|have|does|do) not\b|\bnot (?:invalid|missing|expired|restricted|limited|banned|blocked|disabled|posting)\b/i.test(assertion)) return 'unknown'
  if (/^(?:(?:invalid|missing|expired|incorrect) (?:csrf )?session\s*id\b|(?:the )?(?:csrf )?session\s*id (?:is|was) (?:invalid|missing|expired|incorrect)\b)/i.test(value)
    || /^(?:(?:您的|你的|当前)?(?:会话标识|会话\s*id|sessionid)(?:无效|已过期|缺失|不匹配))/i.test(value)) return 'csrf-sessionid'
  if (/^(?:(?:you(?:'ve| have) been |you are )?posting too frequently\b|your comment was not posted because you (?:have been|are) posting too frequently\b)/i.test(value)
    || /^(?:由于)?(?:您|你)(?:发帖|发表(?:评论|留言)|留言|评论)(?:过于|太过|太|过)频繁/.test(value)) return 'posting-too-frequently'
  if (/^(?:the profile owner has disabled (?:comments|commenting)\b|comments (?:have been|are) disabled (?:on|for) this profile\b|comments (?:have been|are) disabled by the (?:profile )?owner\b|this user has disabled comments\b)/i.test(value)
    || /^(?:(?:该|此|这个)?(?:用户|个人资料)(?:的)?(?:已关闭|已禁用|关闭了)(?:评论|留言)|(?:该|此)?(?:个人资料|用户)?的?(?:评论|留言)(?:已关闭|被禁用|已禁用))/.test(value)) return 'target-comments-disabled'
  if (/^(?:only friends (?:of this user )?can (?:post|leave|add) comments?\b|you (?:must|need to) be (?:a )?friends? with (?:this user|the (?:profile )?owner) (?:to|before) (?:post|leave|add)\b)/i.test(value)
    || /^(?:只有|仅允许|仅限)(?:(?:该|此)用户的)?好友(?:才能|可以|可)?(?:留言|评论|发表|发布)/.test(value)) return 'friends-only'
  if (/^(?:you (?:have been|are) blocked by (?:this user|the (?:profile )?owner)\b|this user has blocked you\b)/i.test(value)
    || /^(?:(?:该|此)用户(?:已)?(?:将您|将你|把您|把你)(?:加入黑名单|屏蔽|拉黑)|(?:您|你)(?:已)?被(?:该|此)用户(?:屏蔽|拉黑))/.test(value)) return 'target-blocked'
  if (/^(?:your account (?:is|has been) (?:restricted|limited|banned|suspended) from (?:posting|commenting)\b|you (?:are|have been) (?:banned|restricted) from (?:posting|commenting)\b|your account does not have permission to post comments\b|(?:your|this) account is not (?:allowed|permitted) to (?:post|leave|add) comments?\b|you are not (?:allowed|permitted) to (?:post|leave|add) comments? on (?:this|the) profile\b|the settings on this account do not allow you to (?:post|leave|add) comments?\b)/i.test(value)
    || /^(?:您的|你的)账号(?:已被|被|已)?(?:限制|禁止|封禁)[^。！？]*(?:留言|评论|发帖)/.test(value)
    || /^(?:该|此|这个)(?:账户|帐户|账号|个人资料)(?:的设置)?不允许(?:您|你|当前账号)?(?:进行|发表|发布|添加)?(?:留言|评论)/.test(value)) return 'account-restricted'
  if (/^(?:(?:please )?(?:complete|solve) (?:the |a )?(?:captcha|human verification)\b|(?:please )?verify (?:that )?you are (?:a )?human\b)/i.test(value)
    || /^(?:请|需要先|请先)(?:完成|通过|进行)(?:人机验证|验证码验证)/.test(value)) return 'challenge'
  return 'unknown'
}

function explicitCommentTargetDenial(value: string): { reason: CommentDenialReason; message: string } | null {
  if (/\b(?:posting too frequently|too many requests|rate[ -]?limit(?:ed)?|csrf|session|sessionid|authentication|not logged (?:in|on)|logged out|captcha)\b|频率|限流|频繁|会话|登录|人机验证/i.test(value)) return null
  const reason = classifyCommentError(value)
  const messages: Partial<Record<CommentDenialReason, string>> = {
    'target-comments-disabled': 'Steam 明确提示该资料页已关闭留言',
    'friends-only': 'Steam 明确提示该资料页仅允许好友留言，当前请求被拒绝',
    'target-blocked': 'Steam 明确提示该好友已屏蔽当前账号',
    'account-restricted': 'Steam 明确提示当前账号没有此资料页留言权限'
  }
  const message = messages[reason]
  return message ? { reason, message } : null
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
