import { parse, type DefaultTreeAdapterMap } from 'parse5'

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']

export interface ProfileCommentSnapshotEntry {
  id: string
  authorSteamId: string | null
  text: string | null
  postedAtSeconds: number | null
}

export interface ProfileCommentSnapshot {
  ownerSteamId: string
  threadExists: boolean
  complete: boolean
  comments: ProfileCommentSnapshotEntry[]
}

export type CommentSnapshot = ProfileCommentSnapshot

/** These bounds must come from the response server clock, not an uncorrected local clock. */
export interface CommentServerWindow {
  earliest: number
  latest: number
}

export interface CommentAttemptEvidence {
  baselineIds: string[]
  serverWindow: CommentServerWindow | null
  submittedAt: string
}

export type CommentVerificationResult =
  | { status: 'confirmed'; commentId: string; postedAtSeconds: number }
  | { status: 'unresolved'; reason: string }

export type CommentReconciliationResult =
  | { status: 'confirmed'; comment: ProfileCommentSnapshotEntry }
  | { status: 'ambiguous' | 'no-match'; reason: string }

const STEAM_INDIVIDUAL_BASE = 76561197960265728n
const UINT32_MAX = 4294967295n
const MAX_HTML_LENGTH = 5 * 1024 * 1024
const MAX_TREE_DEPTH = 256
const MAX_TREE_NODES = 100_000
const MAX_SERVER_WINDOW_SECONDS = 300
const IGNORED_ELEMENTS = new Set(['script', 'style', 'template', 'noscript'])

export function parseCommentSnapshot(html: string, ownerSteamId: string): ProfileCommentSnapshot {
  const snapshot: ProfileCommentSnapshot = {
    ownerSteamId, threadExists: false, complete: false, comments: []
  }
  if (!isIndividualSteamId(ownerSteamId) || html.length > MAX_HTML_LENGTH) return snapshot

  const duplicateAttributeOffsets: number[] = []
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === 'duplicate-attribute') duplicateAttributeOffsets.push(error.startOffset)
    }
  })
  const documentWalk = collectNodes(document, (node) => hasClass(node, 'commentthread_comment_text'))
  const areaId = `commentthread_Profile_${ownerSteamId}_area`
  const roots = documentWalk.nodes.filter((node): node is HtmlElement =>
    isElement(node) && attribute(node, 'id') === areaId
  )
  if (roots.length !== 1 || !documentWalk.complete) return snapshot
  const root = roots[0]!
  if (hasCommentOrThreadAncestor(root)) return snapshot
  snapshot.threadExists = true

  const rootWalk = collectNodes(root, (node) => node !== root && (
    isThread(node) || hasClass(node, 'commentthread_comment_text')
  ))
  const postsId = `commentthread_Profile_${ownerSteamId}_posts`
  const posts = rootWalk.nodes.filter((node): node is HtmlElement =>
    isElement(node) && attribute(node, 'id') === postsId && hasClass(node, 'commentthread_comments')
  )
  if (posts.length !== 1 || !rootWalk.complete) return snapshot
  const postsRoot = posts[0]!
  const postsWalk = collectNodes(postsRoot, (node) => node !== postsRoot && (
    isThread(node) || hasClass(node, 'commentthread_comment_text')
  ))
  snapshot.complete = postsWalk.complete
  const ids = new Set<string>()
  for (const node of postsWalk.nodes) {
    if (!isElement(node) || !hasClass(node, 'commentthread_comment')) continue
    if (hasCommentAncestor(node, postsRoot)) {
      snapshot.complete = false
      continue
    }
    const match = /^comment_([1-9]\d{0,19})$/.exec(attribute(node, 'id'))
    if (!match || ids.has(match[1]!)) {
      snapshot.complete = false
      continue
    }
    const id = match[1]!
    ids.add(id)
    const details = collectNodes(node, (child) => child !== node && (
      isThread(child) || hasClass(child, 'commentthread_comment')
    ))
    if (!details.complete) snapshot.complete = false
    const textNodes = details.nodes.filter((child): child is HtmlElement =>
      isElement(child) && hasClass(child, 'commentthread_comment_text')
    )
    const metadata = collectNodes(node, (child) => child !== node && (
      isThread(child) || hasClass(child, 'commentthread_comment') ||
      hasClass(child, 'commentthread_comment_text')
    ))
    if (!metadata.complete) snapshot.complete = false
    snapshot.comments.push({
      id,
      authorSteamId: readAuthor(metadata.nodes),
      text: textNodes.length === 1 ? readCommentText(textNodes[0]!) : null,
      postedAtSeconds: readTimestamp(metadata.nodes, duplicateAttributeOffsets)
    })
  }
  return snapshot
}

export function reconcileCommentSnapshots(
  before: ProfileCommentSnapshot,
  after: ProfileCommentSnapshot,
  expectedAuthorSteamId: string,
  message: string,
  serverWindow: CommentServerWindow
): CommentReconciliationResult {
  if (!isReliableSnapshot(before) || !isReliableSnapshot(after) ||
    before.ownerSteamId !== after.ownerSteamId || !isIndividualSteamId(before.ownerSteamId)) {
    return { status: 'no-match', reason: 'unreliable-snapshot' }
  }
  if (!isIndividualSteamId(expectedAuthorSteamId) || !isReliableWindow(serverWindow)) {
    return { status: 'no-match', reason: 'invalid-author-or-server-window' }
  }
  const expectedText = normalizeCommentText(message)
  if (!expectedText) return { status: 'no-match', reason: 'empty-message' }
  const oldIds = new Set(before.comments.map((comment) => comment.id))
  const matches: ProfileCommentSnapshotEntry[] = []
  for (const comment of after.comments) {
    if (oldIds.has(comment.id) || comment.authorSteamId !== expectedAuthorSteamId ||
      comment.text === null || normalizeCommentText(comment.text) !== expectedText ||
      comment.postedAtSeconds === null || !Number.isSafeInteger(comment.postedAtSeconds) ||
      comment.postedAtSeconds < serverWindow.earliest || comment.postedAtSeconds > serverWindow.latest) continue
    matches.push(comment)
  }
  if (matches.length === 1) return { status: 'confirmed', comment: matches[0]! }
  return matches.length > 1
    ? { status: 'ambiguous', reason: 'multiple-new-matching-comments' }
    : { status: 'no-match', reason: 'no-new-matching-comment' }
}

export function normalizeCommentText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim()
}

export function verifyCommentAttempt(
  snapshot: ProfileCommentSnapshot,
  expectedAuthorSteamId: string,
  message: string,
  evidence: CommentAttemptEvidence | null
): CommentVerificationResult {
  if (!evidence) return { status: 'unresolved', reason: 'missing-attempt-evidence' }
  if (!Array.isArray(evidence.baselineIds) || evidence.baselineIds.length > 1000 ||
    evidence.baselineIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) ||
    new Set(evidence.baselineIds).size !== evidence.baselineIds.length ||
    typeof evidence.submittedAt !== 'string' || evidence.submittedAt.length > 64 ||
    !Number.isFinite(Date.parse(evidence.submittedAt)) || !evidence.serverWindow ||
    !isReliableWindow(evidence.serverWindow)) {
    return { status: 'unresolved', reason: 'invalid-attempt-evidence' }
  }
  const before: ProfileCommentSnapshot = {
    ownerSteamId: snapshot.ownerSteamId, threadExists: true, complete: true,
    comments: evidence.baselineIds.map(id => ({ id, authorSteamId: null, text: null, postedAtSeconds: null }))
  }
  const result = reconcileCommentSnapshots(before, snapshot, expectedAuthorSteamId, message, evidence.serverWindow)
  return result.status === 'confirmed' && result.comment.postedAtSeconds !== null
    ? { status: 'confirmed', commentId: result.comment.id, postedAtSeconds: result.comment.postedAtSeconds }
    : { status: 'unresolved', reason: result.status === 'confirmed' ? 'missing-comment-timestamp' : result.reason }
}

function isReliableWindow(window: CommentServerWindow): boolean {
  return Number.isSafeInteger(window.earliest) && Number.isSafeInteger(window.latest) &&
    window.earliest > 0 && window.latest >= window.earliest &&
    window.latest - window.earliest <= MAX_SERVER_WINDOW_SECONDS
}

function isReliableSnapshot(snapshot: ProfileCommentSnapshot): boolean {
  if (!snapshot.complete || !snapshot.threadExists) return false
  const ids = new Set<string>()
  for (const comment of snapshot.comments) {
    if (!/^[1-9]\d{0,19}$/.test(comment.id) || ids.has(comment.id)) return false
    ids.add(comment.id)
  }
  return true
}

function isIndividualSteamId(value: string): boolean {
  if (!/^\d{17}$/.test(value)) return false
  const accountId = BigInt(value) - STEAM_INDIVIDUAL_BASE
  return accountId > 0n && accountId <= UINT32_MAX
}

function readAuthor(nodes: HtmlNode[]): string | null {
  const authors = new Set<string>()
  let invalid = false
  for (const node of nodes) {
    if (!isElement(node) || node.tagName !== 'a') continue
    const miniProfile = attribute(node, 'data-miniprofile')
    const isAuthorLink = hasClass(node, 'commentthread_author_link')
    if (!miniProfile && !isAuthorLink) continue
    let fromMiniProfile: string | null = null
    if (miniProfile) {
      if (!/^[1-9]\d{0,9}$/.test(miniProfile) || BigInt(miniProfile) > UINT32_MAX) invalid = true
      else fromMiniProfile = String(STEAM_INDIVIDUAL_BASE + BigInt(miniProfile))
    }
    const fromHref = readProfileHref(attribute(node, 'href'))
    if (fromMiniProfile && fromHref && fromMiniProfile !== fromHref) invalid = true
    if (fromMiniProfile) authors.add(fromMiniProfile)
    else if (fromHref) authors.add(fromHref)
    else if (isAuthorLink) invalid = true
  }
  return !invalid && authors.size === 1 ? [...authors][0]! : null
}

function readProfileHref(href: string): string | null {
  try {
    const url = new URL(href, 'https://steamcommunity.com')
    if (!/^https?:$/.test(url.protocol) || url.hostname !== 'steamcommunity.com' ||
      url.port || url.username || url.password) return null
    const match = /^\/profiles\/(\d{17})\/?$/.exec(url.pathname)
    return match && isIndividualSteamId(match[1]!) ? match[1]! : null
  } catch {
    return null
  }
}

function readTimestamp(nodes: HtmlNode[], duplicateAttributeOffsets: number[]): number | null {
  const timestamps = nodes.filter((node): node is HtmlElement =>
    isElement(node) && hasClass(node, 'commentthread_comment_timestamp') &&
    node.attrs.some(({ name }) => name === 'data-timestamp')
  )
  // Steam nests the actual timestamp inside a same-class wrapper with no timestamp attribute.
  if (timestamps.length !== 1) return null
  const timestamp = timestamps[0]!
  if (hasDuplicateAttribute(timestamp, duplicateAttributeOffsets)) return null
  const value = attribute(timestamp, 'data-timestamp')
  if (!/^[1-9]\d{0,12}$/.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds : null
}

function hasDuplicateAttribute(node: HtmlElement, offsets: number[]): boolean {
  const startTag = node.sourceCodeLocation?.startTag
  if (!startTag) return true
  let lower = 0
  let upper = offsets.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (offsets[middle]! < startTag.startOffset) lower = middle + 1
    else upper = middle
  }
  return lower < offsets.length && offsets[lower]! < startTag.endOffset
}

function readCommentText(root: HtmlElement): string | null {
  const walk = collectNodes(root)
  if (!walk.complete) return null
  const pieces: string[] = []
  for (const node of walk.nodes) {
    if (node.nodeName === '#text' && 'value' in node) pieces.push(node.value)
    else if (isElement(node) && node.tagName === 'br') pieces.push('\n')
    else if (isElement(node) && node.tagName === 'img') {
      const alt = attribute(node, 'alt')
      if (!hasClass(node, 'emoticon') || !/^:[^:\s<>]{1,128}:$/.test(alt)) return null
      pieces.push(alt)
    }
  }
  return normalizeCommentText(pieces.join(''))
}

function collectNodes(
  root: HtmlNode,
  skipElement: (node: HtmlElement) => boolean = () => false
): { nodes: HtmlNode[]; complete: boolean } {
  const pending = [{ node: root, depth: 0 }]
  const nodes: HtmlNode[] = []
  let complete = true
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > MAX_TREE_DEPTH || nodes.length >= MAX_TREE_NODES) {
      complete = false
      continue
    }
    if ('tagName' in node && (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      IGNORED_ELEMENTS.has(node.tagName) || skipElement(node))) continue
    nodes.push(node)
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push({ node: node.childNodes[index]!, depth: depth + 1 })
      }
    }
  }
  return { nodes, complete }
}

function hasCommentOrThreadAncestor(node: HtmlNode): boolean {
  let current = 'parentNode' in node ? node.parentNode : null
  while (current) {
    if (isElement(current) && (isThread(current) || hasClass(current, 'commentthread_comment'))) return true
    current = 'parentNode' in current ? current.parentNode : null
  }
  return false
}

function hasCommentAncestor(node: HtmlNode, stop: HtmlNode): boolean {
  let current = 'parentNode' in node ? node.parentNode : null
  while (current && current !== stop) {
    if (isElement(current) && hasClass(current, 'commentthread_comment')) return true
    current = 'parentNode' in current ? current.parentNode : null
  }
  return false
}

function isThread(node: HtmlElement): boolean {
  return hasClass(node, 'commentthread_area') || /^commentthread_.+_area$/.test(attribute(node, 'id'))
}

function attribute(node: HtmlElement, name: string): string {
  return node.attrs.find((item) => item.name === name)?.value ?? ''
}

function hasClass(node: HtmlElement, name: string): boolean {
  return attribute(node, 'class').split(/\s+/).includes(name)
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
}
