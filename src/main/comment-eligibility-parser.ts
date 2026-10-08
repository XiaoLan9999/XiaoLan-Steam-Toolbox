import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { CommentCheckResult } from '../shared/types'

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']

const IGNORED_ELEMENTS = new Set(['script', 'style', 'template', 'noscript'])
const MAX_TREE_DEPTH = 256

export function parseCommentEligibility(html: string, steamId: string): CommentCheckResult {
  if (!/^7656119\d{10}$/.test(steamId)) return unknown('目标 SteamID 无效，无法检查')
  const prefix = `commentthread_Profile_${steamId}`
  const roots = [...walkNodes(parse(html))].filter(
    (node): node is HtmlElement => isElement(node) && attribute(node, 'id') === `${prefix}_area`
  )
  if (roots.length !== 1) return unknown('未找到唯一的目标评论区；资料可能私密或页面结构已变化')
  const root = roots[0]!
  if (hasUnavailableAncestor(root)) return unknown('目标评论区当前不可见，无法确定留言权限')

  const nodes = [...walkNodes(root, true)]
  const visibleText = nodes
    .filter((node) => node.nodeName === '#text' && !hasUnavailableAncestor(node))
    .map((node) => ('value' in node ? node.value : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
  const blockedReason = explicitRestriction(visibleText)

  const textareas = nodes.filter(
    (node): node is HtmlElement =>
      isElement(node) && node.tagName === 'textarea' && attribute(node, 'id') === `${prefix}_textarea`
  )
  const submits = nodes.filter(
    (node): node is HtmlElement =>
      isElement(node) &&
      attribute(node, 'id') === `${prefix}_submit` &&
      (node.tagName === 'button' || node.tagName === 'a' ||
        (node.tagName === 'input' && /^(submit|button)$/i.test(attribute(node, 'type'))))
  )
  if (
    textareas.length === 1 && submits.length === 1 &&
    !hasUnavailableAncestor(textareas[0]!) &&
    !hasUnavailableAncestor(submits[0]!, `${prefix}_submit_container`)
  ) {
    if (blockedReason) return unknown('页面权限提示与留言入口不一致，暂无法确认')
    return { status: 'allowed', reason: '页面当前提供留言入口；不保证实际发送成功' }
  }
  if (blockedReason) return { status: 'blocked', reason: blockedReason }
  return unknown('未找到启用的留言输入框和提交入口，暂无法确定权限')
}

function explicitRestriction(text: string): string | null {
  if (/comments? (?:have been |are |is )?disabled|(?:不允许|禁止|已关闭|已禁用)(?:.{0,8})(?:留言|评论)|(?:留言|评论)(?:.{0,8})(?:已关闭|已禁用)/i.test(text)) {
    return '页面明确提示已关闭或禁用评论'
  }
  if (/only friends (?:are allowed to |can |may )?(?:post |leave )?comments?|you must be (?:a )?friend.{0,60}(?:comment|post)|(?:仅|只有|只允许)(?:.{0,8})好友(?:.{0,16})(?:留言|评论)/i.test(text)) {
    return '页面明确提示当前仅允许好友评论'
  }
  if (/you (?:have been|are) blocked.{0,60}(?:comment|user|profile)|this user has blocked you|该用户已(?:将您|将你|把您|把你)?(?:屏蔽|拉黑)/i.test(text)) {
    return '页面明确提示当前账号被目标屏蔽'
  }
  if (/your account (?:does not have sufficient privileges|is not (?:allowed|permitted) to (?:post|comment)|is (?:limited|restricted|banned) from (?:posting|commenting))|(?:您的|你的|当前)账号(?:.{0,30})(?:无法|不能|禁止)(?:.{0,8})(?:留言|评论)/i.test(text)) {
    return '页面明确提示当前账号没有留言权限'
  }
  return null
}

function* walkNodes(root: HtmlNode, skipCommentContent = false): Generator<HtmlNode> {
  const pending = [{ node: root, depth: 0 }]
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > MAX_TREE_DEPTH) continue
    if (isElement(node)) {
      if (IGNORED_ELEMENTS.has(node.tagName)) continue
      if (skipCommentContent && node !== root && (
        hasClass(node, 'commentthread_comments') ||
        hasClass(node, 'commentthread_comment') ||
        hasClass(node, 'commentthread_comment_text') ||
        (hasClass(node, 'commentthread_area') && attribute(node, 'id') !== attribute(root as HtmlElement, 'id'))
      )) continue
    }
    yield node
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push({ node: node.childNodes[index]!, depth: depth + 1 })
      }
    }
  }
}

function hasUnavailableAncestor(node: HtmlNode, conditionalSubmitContainer?: string): boolean {
  let current: HtmlNode | null = node
  let depth = 0
  while (current && depth++ <= MAX_TREE_DEPTH) {
    if (isElement(current)) {
      if (current.attrs.some(({ name }) => ['hidden', 'disabled', 'readonly', 'inert'].includes(name))) return true
      if (attribute(current, 'aria-hidden') === 'true' || attribute(current, 'aria-disabled') === 'true') return true
      if (hasClass(current, 'disabled') || hasClass(current, 'hidden')) return true
      const style = attribute(current, 'style')
      if (/(?:^|;)\s*(?:visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(style)) return true
      // Steam's CCommentThread reveals this specific container only after text input.
      if (/(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(style) &&
        attribute(current, 'id') !== conditionalSubmitContainer) return true
    }
    current = 'parentNode' in current ? current.parentNode : null
  }
  return depth > MAX_TREE_DEPTH
}

function unknown(reason: string): CommentCheckResult {
  return { status: 'unknown', reason }
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
