import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { CommunityProfileSummary } from './community-client'

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']

const MAX_TREE_DEPTH = 256
const IGNORED_ELEMENTS = new Set(['script', 'style', 'template', 'noscript'])

export function parseFriendPage(
  html: string,
  friendIds: readonly string[]
): Map<string, CommunityProfileSummary> {
  const allowedIds = new Set(friendIds.filter((id) => /^7656119\d{10}$/.test(id)))
  const profiles = new Map<string, CommunityProfileSummary>()
  if (!allowedIds.size) return profiles

  for (const node of walkNodes(parse(html))) {
    if (!isElement(node) || !hasClass(node, 'friend_block_v2')) continue
    const steamId = attribute(node, 'data-steamid')
    if (!allowedIds.has(steamId) || profiles.has(steamId)) continue

    const content = findElement(node, (element) => hasClass(element, 'friend_block_content'))
    const displayName = content ? readName(content) : ''
    if (!displayName) continue

    const avatar = findElement(node, (element) => hasClass(element, 'player_avatar'))
    const image = avatar ? findElement(avatar, (element) => element.tagName === 'img') : undefined
    profiles.set(steamId, {
      steamId,
      displayName,
      avatarUrl: image ? safeAvatarUrl(attribute(image, 'src')) : '',
      onlineState: hasClass(node, 'in-game')
        ? 'in-game'
        : hasClass(node, 'online')
          ? 'online'
          : hasClass(node, 'offline')
            ? 'offline'
            : 'unknown'
    })
  }
  return profiles
}

// Never walk into another friend row, executable text, or unbounded nesting.
function* walkNodes(root: HtmlNode): Generator<HtmlNode> {
  const pending = [{ node: root, depth: 0 }]
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > MAX_TREE_DEPTH) continue
    if (isElement(node) && IGNORED_ELEMENTS.has(node.tagName)) continue
    yield node
    if (node !== root && isElement(node) && hasClass(node, 'friend_block_v2')) continue
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push({ node: node.childNodes[index]!, depth: depth + 1 })
      }
    }
  }
}

function findElement(
  root: HtmlElement,
  predicate: (element: HtmlElement) => boolean
): HtmlElement | undefined {
  for (const node of walkNodes(root)) {
    if (node !== root && isElement(node) && hasClass(node, 'friend_block_v2')) continue
    if (isElement(node) && predicate(node)) return node
  }
  return undefined
}

function readName(content: HtmlElement): string {
  const pieces: string[] = []
  for (const node of walkNodes(content)) {
    if (isElement(node) && (node.tagName === 'br' || hasClass(node, 'friend_small_text'))) break
    if (node.nodeName === '#text' && 'value' in node) pieces.push(node.value)
  }
  return pieces.join('').trim()
}

function safeAvatarUrl(value: string): string {
  try {
    const url = new URL(value)
    const steamHost = url.hostname.endsWith('.steamstatic.com') || url.hostname === 'steamcdn-a.akamaihd.net'
    return url.protocol === 'https:' && steamHost && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function attribute(node: HtmlElement, name: string): string {
  return node.attrs.find((attribute) => attribute.name === name)?.value ?? ''
}

function hasClass(node: HtmlElement, name: string): boolean {
  return attribute(node, 'class').split(/\s+/).includes(name)
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
}
