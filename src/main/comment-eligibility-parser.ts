import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { CommentCheckResult } from '../shared/types'

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']

const IGNORED_ELEMENTS = new Set(['script', 'style', 'template', 'noscript'])
const MAX_TREE_DEPTH = 256

export function parseCommentEligibility(html: string, steamId: string): CommentCheckResult {
  if (!/^7656119\d{10}$/.test(steamId)) return unknown('目标 SteamID 无效，无法检查')
  const prefix = `commentthread_Profile_${steamId}`
  const document = parse(html)
  const pageNodes = [...walkNodes(document)]
  const roots = pageNodes.filter(
    (node): node is HtmlElement => isElement(node) && attribute(node, 'id') === `${prefix}_area`
  )
  if (isPrivateTargetProfile(pageNodes, steamId)) {
    if (pageNodes.some(node => isElement(node) && (hasCommentContentClass(node) || hasClass(node, 'commentthread_area')))) {
      return unknown('资料私密提示与评论区不一致，暂无法确认')
    }
    return { status: 'blocked', reason: '资料页明确提示为私密，当前无法留言' }
  }
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
      // Steam binds CCommentThread.OnSubmit to the id, including its styled span button.
      (node.tagName === 'button' || node.tagName === 'a' || node.tagName === 'span' ||
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

function isPrivateTargetProfile(nodes: HtmlNode[], steamId: string): boolean {
  const elements = nodes.filter(isElement)
  const bodies = elements.filter(node => node.tagName === 'body')
  const templates = elements.filter(node => attribute(node, 'id') === 'responsive_page_template_content')
  const profiles = elements.filter(node => node.tagName !== 'body' && hasClass(node, 'profile_page'))
  if (bodies.length !== 1 || templates.length !== 1 || profiles.length !== 1) return false
  const body = bodies[0]!
  const template = templates[0]!
  const profile = profiles[0]!
  if (!hasClass(body, 'profile_page') || !hasClass(body, 'private_profile') ||
    !hasClass(body, 'responsive_page') || template.tagName !== 'div' ||
    !hasClass(template, 'responsive_page_template_content') ||
    profile.tagName !== 'div' || !hasClass(profile, 'private_profile') ||
    !hasLayoutAncestor(template, body) || !hasLayoutAncestor(profile, template) ||
    hasUnavailableAncestor(profile)) return false
  // Steam emits this owner bootstrap beside the private profile, not in user-authored HTML.
  const owners: Array<string | null> = []
  for (const node of template.childNodes) {
    if (!isElement(node) || node.tagName !== 'script' || attribute(node, 'src') ||
      !['', 'text/javascript', 'application/javascript'].includes(attribute(node, 'type').trim().toLowerCase())) continue
    const source = node.childNodes.filter(child => child.nodeName === '#text')
      .map(child => 'value' in child ? child.value : '').join('')
    owners.push(...profileOwnerAssignments(source))
  }
  return owners.length === 1 && owners[0] === steamId
}

function hasLayoutAncestor(node: HtmlNode, expected: HtmlNode): boolean {
  let current: HtmlNode | null = node
  for (let depth = 0; current && depth <= MAX_TREE_DEPTH; depth++) {
    if (current === expected) return true
    if (isElement(current) && (IGNORED_ELEMENTS.has(current.tagName) ||
      hasCommentContentClass(current) || hasClass(current, 'commentthread_area') ||
      hasClass(current, 'profile_summary') || hasClass(current, 'bb_code'))) return false
    current = 'parentNode' in current ? current.parentNode : null
  }
  return false
}

function profileOwnerAssignments(source: string): Array<string | null> {
  const owners: Array<string | null> = []
  let depth = 0
  let previous = ''
  let beforePrevious = ''
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
    if ('"\'`/'.includes(character)) {
      index = quotedEnd(source, index, character)
      beforePrevious = previous; previous = '<quoted>'; continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0]
    if (!identifier) {
      if ('{(['.includes(character)) depth++
      if ('})]'.includes(character)) depth = Math.max(0, depth - 1)
      beforePrevious = previous; previous = character; index++; continue
    }
    index += identifier.length
    if (identifier === 'g_rgProfileData' && depth === 0) {
      const direct = previous === '' || previous === ';' ||
        (['var', 'let', 'const'].includes(previous) && ['', ';'].includes(beforePrevious))
      const assignment = source.slice(index).match(/^\s*=\s*(?!=)/)
      let owner: string | null = null
      if (direct && assignment) {
        const start = index + assignment[0].length
        let end = start
        let objectDepth = 0
        let ownerKeys = 0
        if (source[start] === '{') {
          for (; end < source.length; end++) {
            if (source[end] === '"') {
              const stringEnd = quotedEnd(source, end, '"')
              if (objectDepth === 1 && /^\s*:/.test(source.slice(stringEnd))) {
                try { if (JSON.parse(source.slice(end, stringEnd)) === 'steamid') ownerKeys++ }
                catch { /* The enclosing JSON parse rejects malformed strings. */ }
              }
              end = stringEnd - 1; continue
            }
            if (source[end] === '{') objectDepth++
            if (source[end] === '}' && --objectDepth === 0) { end++; break }
          }
          if (ownerKeys === 1 && /^\s*(?:;|$)/.test(source.slice(end))) {
            try {
              const data: unknown = JSON.parse(source.slice(start, end))
              if (typeof data === 'object' && data !== null && !Array.isArray(data) &&
                'steamid' in data && typeof data.steamid === 'string' && /^7656119\d{10}$/.test(data.steamid)) owner = data.steamid
            } catch { /* Non-literal or malformed owner data cannot establish a target. */ }
          }
        }
      }
      owners.push(owner)
    }
    beforePrevious = previous; previous = identifier
  }
  return owners
}

function quotedEnd(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === quote) return index + 1
  }
  return source.length
}

function hasCommentContentClass(node: HtmlElement): boolean {
  return ['commentthread_comments', 'commentthread_comment', 'commentthread_comment_text']
    .some(name => hasClass(node, name))
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
      if (hasClass(current, 'disabled') || hasClass(current, 'btn_disabled') || hasClass(current, 'hidden')) return true
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
