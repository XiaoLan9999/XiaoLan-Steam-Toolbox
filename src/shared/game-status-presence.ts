import type { GameStatusAppInfo, GameStatusPresence, GameStatusTemplate } from './game-status'

export const GAME_STATUS_MAX_TEMPLATES = 1024
export const GAME_STATUS_MAX_CATALOG_BYTES = 524288
const maximumTemplateBytes = 2048
const maximumDepth = 12
const maximumSteps = 4096
const control = /[\p{Cc}\u2028\u2029]/u
const tokenName = /^#[A-Za-z0-9_]{1,127}$/
const parameterName = /^[A-Za-z0-9_:]{1,63}$/
const placeholder = /%([A-Za-z0-9_:]+)%/g
const reference = /\{(#[^{}]+)\}/g
const sensitive = /connect|join|lobby|token|password|secret|auth|ticket|credential|session|group|party|(?:^|[_:])(?:address|ip|port)(?:$|[_:])/i
const forbiddenKeys = new Set(['steam_display', 'steam_player_group', 'steam_player_group_size', '__proto__', 'prototype', 'constructor'])
const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length
const error = (message: string): never => { throw new Error(message) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function isGameStatusPresenceParameter(key: string): boolean {
  return parameterName.test(key) && !forbiddenKeys.has(key.toLowerCase()) && (key.toLowerCase() === 'matchgrouploc' || !sensitive.test(key))
}

export function sanitizeGameStatusPresence(value: unknown): GameStatusPresence {
  if (!object(value) || typeof value.displayToken !== 'string' || !tokenName.test(value.displayToken) || !object(value.values)) return error('请选择游戏已发布的详细状态模板，并填写有效变量。')
  const entries = Object.entries(value.values)
  if (entries.length > 19) return error('详细状态最多包含 19 个变量。')
  const seen = new Set<string>()
  const values: Record<string, string> = {}
  for (const [key, item] of entries) {
    const normalized = key.toLowerCase()
    if (!isGameStatusPresenceParameter(key) || seen.has(normalized) || typeof item !== 'string' || control.test(item) || bytes(item) > 255 || /\{#|%[A-Za-z0-9_:]+%/.test(item)) return error('详细状态变量包含不支持的字段、显示指令或超长文字。')
    seen.add(normalized)
    values[normalized] = item
  }
  return { displayToken: value.displayToken, values }
}

export function isSafeGameStatusIconUrl(value: unknown, appId?: number): value is string {
  if (typeof value !== 'string' || value.length > 256) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['cdn.cloudflare.steamstatic.com', 'cdn.akamai.steamstatic.com', 'steamcdn-a.akamaihd.net', 'shared.akamai.steamstatic.com', 'shared.fastly.steamstatic.com'].includes(url.hostname)) return false
    const match = /^\/steamcommunity\/public\/images\/apps\/([1-9]\d{0,7})\/([a-f0-9]{40})\.jpg$/i.exec(url.pathname)
    return !!match && Number(match[1]) <= 0xffffff && (appId === undefined || Number(match[1]) === appId)
  } catch { return false }
}

interface Token { token: string; text: string }
type Tokens = Map<string, Token>
const dependencyCache = new WeakMap<Tokens, Map<string, string[]>>()

function tokensFromEntries(entries: Array<[string, unknown]>): Tokens {
  if (entries.length > GAME_STATUS_MAX_TEMPLATES) return error('该游戏的状态模板数量超过安全读取上限。')
  const tokens: Tokens = new Map()
  let size = 0
  for (const [token, text] of entries) {
    if (!tokenName.test(token) || typeof text !== 'string' || !text || control.test(text) || bytes(text) > maximumTemplateBytes) continue
    size += bytes(token) + bytes(text)
    if (size > GAME_STATUS_MAX_CATALOG_BYTES) return error('该游戏的状态模板数据过大。')
    const normalized = token.toLowerCase()
    if (tokens.has(normalized)) return error('游戏状态模板存在重复的显示令牌。')
    tokens.set(normalized, { token, text })
  }
  return tokens
}

function parametersIn(text: string): string[] {
  return [...text.matchAll(placeholder)].map(match => match[1]!.toLowerCase())
}

function referencesIn(text: string): string[] {
  const references = [...text.matchAll(reference)]
  const remainder = text.replace(reference, '')
  if (remainder.includes('{#') || /%[^%\s]+%/.test(text.replace(placeholder, ''))) return error('游戏详细状态模板包含不支持的显示指令。')
  return references.map(match => match[1]!)
}

function matchesDynamicToken(pattern: string, name: string): boolean {
  let at = 0; let position = 0; let star = -1; let consumed = 0
  while (position < name.length) {
    if (pattern[at] === '?' || pattern[at] === name[position]) { at++; position++ }
    else if (pattern[at] === '*') { star = at++; consumed = position }
    else if (star !== -1) { at = star + 1; position = ++consumed }
    else return false
  }
  while (pattern[at] === '*') at++
  return at === pattern.length
}

function relatedTokens(pattern: string, tokens: Tokens): string[] {
  const parameters = parametersIn(pattern)
  if (!parameters.length) {
    if (!tokens.has(pattern.toLowerCase())) return error('游戏详细状态引用了未发布的显示令牌。')
    return [pattern.toLowerCase()]
  }
  const fixed = pattern.replace(placeholder, '')
  if (!/^#[A-Za-z0-9_]*$/.test(fixed)) return error('游戏详细状态的动态显示令牌不受支持。')
  let cached = dependencyCache.get(tokens)
  if (!cached) { cached = new Map(); dependencyCache.set(tokens, cached) }
  const normalized = pattern.toLowerCase()
  const found = cached.get(normalized)
  if (found) return found
  // One-or-more wildcards avoid exponential regular-expression backtracking.
  const expression = normalized.replace(placeholder, '?*')
  const matches = [...tokens.keys()].filter(key => matchesDynamicToken(expression, key))
  if (!matches.length) return error('游戏详细状态引用了未发布的显示令牌。')
  cached.set(normalized, matches)
  return matches
}

function supportedParameters(tokens: Tokens, selected: string): string[] {
  const result = new Set<string>()
  const visited = new Set<string>()
  let steps = 0
  const visit = (name: string, depth: number, stack: Set<string>): void => {
    if (++steps > maximumSteps || depth > maximumDepth || stack.has(name)) return error('游戏详细状态模板嵌套过深或存在循环。')
    if (visited.has(name)) return
    const entry = tokens.get(name)
    if (!entry) return error('该详细状态模板尚未由当前游戏发布。')
    const nextStack = new Set(stack).add(name)
    for (const key of parametersIn(entry.text)) {
      if (!isGameStatusPresenceParameter(key)) return error('该详细状态模板需要不允许修改的字段。')
      result.add(key)
      if (result.size > 19) return error('该详细状态模板需要过多变量。')
    }
    for (const ref of referencesIn(entry.text)) for (const dependency of relatedTokens(ref, tokens)) visit(dependency, depth + 1, nextStack)
    visited.add(name)
  }
  visit(selected, 0, new Set())
  return [...result].sort()
}

export function gameStatusTemplatesFromTokens(value: unknown): GameStatusTemplate[] {
  if (!object(value)) return error('Steam 未返回有效的游戏状态模板。')
  const tokens = tokensFromEntries(Object.entries(value))
  const templates: GameStatusTemplate[] = []
  for (const [key, entry] of tokens) {
    try { templates.push({ ...entry, parameters: supportedParameters(tokens, key) }) }
    catch { /* Unsupported graphs are not offered as working templates. */ }
  }
  return templates
}

export function validateGameStatusPresence(info: GameStatusAppInfo, presence: GameStatusPresence): { fields: Record<string, string>; preview: string } {
  const input = sanitizeGameStatusPresence(presence)
  if (!info || !Array.isArray(info.templates)) return error('请先读取当前游戏实际支持的详细状态模板。')
  const tokens = tokensFromEntries(info.templates.map(template => [template.token, template.text]))
  const selected = input.displayToken.toLowerCase()
  const allowed = new Set(supportedParameters(tokens, selected))
  for (const key of Object.keys(input.values)) if (!allowed.has(key)) return error('详细状态包含所选游戏模板不支持的变量。')
  let steps = 0
  const substitute = (text: string): string => text.replace(placeholder, (_match, key: string) => {
    const value = input.values[key.toLowerCase()]
    if (value === undefined || value === '') return error('请填写所选详细状态实际需要的全部变量。')
    return value
  })
  const render = (name: string, depth: number, stack: Set<string>): string => {
    if (++steps > maximumSteps || depth > maximumDepth || stack.has(name)) return error('游戏详细状态模板嵌套过深或存在循环。')
    const entry = tokens.get(name)
    if (!entry) return error('游戏详细状态引用了未发布的显示令牌。')
    const nextStack = new Set(stack).add(name)
    referencesIn(entry.text)
    let result = ''; let offset = 0
    for (const match of entry.text.matchAll(reference)) {
      result += substitute(entry.text.slice(offset, match.index))
      const target = substitute(match[1]!)
      if (!tokenName.test(target)) return error('当前变量无法组成该游戏已发布的显示令牌。')
      result += render(target.toLowerCase(), depth + 1, nextStack)
      offset = match.index! + match[0].length
      if (bytes(result) > maximumTemplateBytes) return error('详细状态渲染结果过长。')
    }
    result += substitute(entry.text.slice(offset))
    if (bytes(result) > maximumTemplateBytes || !result.trim()) return error('详细状态渲染结果为空或过长。')
    return result
  }
  const preview = render(selected, 0, new Set())
  return { fields: { steam_display: tokens.get(selected)!.token, ...input.values }, preview }
}
