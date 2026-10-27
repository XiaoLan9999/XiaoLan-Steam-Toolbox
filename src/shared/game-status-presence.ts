import type { GameStatusAppInfo, GameStatusPresence, GameStatusTemplate } from './game-status'
import { isRichPresenceParameter, isWellFormedPresenceText, richPresenceContract, richPresenceDisplayToken } from './rich-presence-contract'

export const GAME_STATUS_MAX_TEMPLATES = richPresenceContract.catalog.tokenCount
export const GAME_STATUS_MAX_CATALOG_BYTES = richPresenceContract.render.catalogPayloadBytes
const maximumTemplateBytes = richPresenceContract.render.templateUtf8Bytes
const maximumDepth = richPresenceContract.render.maximumDepth
const maximumSteps = richPresenceContract.render.maximumSteps
const tokenName = richPresenceDisplayToken
const placeholder = /%([A-Za-z0-9_:]+)%/g
const reference = /\{(#(?=[A-Za-z0-9_:.%\-])[A-Za-z0-9_:.\-]*(?:%[A-Za-z0-9_:]+%[A-Za-z0-9_:.\-]*)*)\}/g
const tokenFragment = /^[A-Za-z0-9_:.\-]+$/
const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length
const error = (message: string): never => { throw new Error(message) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function isGameStatusPresenceParameter(key: string): boolean {
  return isRichPresenceParameter(key)
}

export function sanitizeGameStatusPresence(value: unknown): GameStatusPresence {
  if (!object(value) || typeof value.displayToken !== 'string' || !tokenName.test(value.displayToken) || !object(value.values)) return error('请选择游戏已发布的详细状态模板，并填写有效变量。')
  const entries = Object.entries(value.values)
  if (entries.length > richPresenceContract.presence.maxKeys - 1) return error(`详细状态最多包含 ${richPresenceContract.presence.maxKeys - 1} 个变量。`)
  const seen = new Set<string>()
  const values: Record<string, string> = {}
  for (const [key, item] of entries) {
    const normalized = key.toLowerCase()
    if (!isGameStatusPresenceParameter(key) || seen.has(normalized) || typeof item !== 'string' || !isWellFormedPresenceText(item) || bytes(item) > richPresenceContract.presence.valueUtf8Bytes || /\{#|%[A-Za-z0-9_:]+%/.test(item)) return error('详细状态变量包含不支持的字段、显示指令或超长文字。')
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
    if (!tokenName.test(token) || typeof text !== 'string' || !isWellFormedPresenceText(text) || bytes(text) > maximumTemplateBytes) continue
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
  return [...text.matchAll(reference)].map(match => match[1]!)
}

interface PatternPart { literal?: string; parameter?: string }
interface TokenAssignment { token: string; values: Record<string, string> }

function patternParts(pattern: string): PatternPart[] {
  const result: PatternPart[] = []; let offset = 0
  for (const match of pattern.matchAll(placeholder)) {
    if (match.index! > offset) result.push({ literal: pattern.slice(offset, match.index).toLowerCase() })
    result.push({ parameter: match[1]!.toLowerCase() })
    offset = match.index! + match[0].length
  }
  if (offset < pattern.length) result.push({ literal: pattern.slice(offset).toLowerCase() })
  return result
}

// Match catalog names, never arbitrary regular expressions or a Cartesian product
// of parameter domains. Repeated names share one binding, including adjacent ones.
function assignmentsFor(pattern: string, entry: Token, known: Record<string, string>, step: () => void, firstOnly = false): Record<string, string>[] {
  const parts = patternParts(pattern); const name = entry.token.toLowerCase()
  const last = parts.at(-1)
  if (last?.literal && !name.endsWith(last.literal)) return []
  const results: Record<string, string>[] = []
  const visit = (index: number, at: number, values: Record<string, string>): void => {
    step()
    if (results.length >= (firstOnly ? 1 : richPresenceContract.render.maximumAssignmentsPerToken)) return
    if (index === parts.length) { if (at === name.length) results.push(values); return }
    const part = parts[index]!
    if (part.literal !== undefined) {
      if (name.startsWith(part.literal, at)) visit(index + 1, at + part.literal.length, values)
      return
    }
    const key = part.parameter!; const bound = values[key] ?? known[key]
    if (bound !== undefined) {
      if (name.startsWith(bound.toLowerCase(), at)) visit(index + 1, at + bound.length, { ...values, [key]: bound })
      return
    }
    let remaining = 0
    for (const rest of parts.slice(index + 1)) remaining += rest.literal?.length ?? (values[rest.parameter!] ?? known[rest.parameter!])?.length ?? 1
    const end = name.length - remaining
    const nextLiteral = parts[index + 1]?.literal
    for (let to = at + 1; to <= end; to++) {
      step()
      if (nextLiteral && !name.startsWith(nextLiteral, to)) continue
      const value = entry.token.slice(at, to)
      if (tokenFragment.test(value)) visit(index + 1, to, { ...values, [key]: value })
      if (results.length >= (firstOnly ? 1 : richPresenceContract.render.maximumAssignmentsPerToken)) break
    }
  }
  visit(0, 0, Object.create(null) as Record<string, string>)
  return results
}

function matchingAssignments(pattern: string, tokens: Tokens, known: Record<string, string>, step: () => void, firstPerToken = false): TokenAssignment[] {
  const result: TokenAssignment[] = []
  for (const [name, entry] of tokens) {
    step()
    for (const values of assignmentsFor(pattern, entry, known, step, firstPerToken)) result.push({ token: name, values })
  }
  return result
}

function relatedTokens(pattern: string, tokens: Tokens): string[] {
  const parameters = parametersIn(pattern)
  if (!parameters.length) {
    if (!tokens.has(pattern.toLowerCase())) return error('游戏详细状态引用了未发布的显示令牌。')
    return [pattern.toLowerCase()]
  }
  let cached = dependencyCache.get(tokens)
  if (!cached) { cached = new Map(); dependencyCache.set(tokens, cached) }
  const normalized = pattern.toLowerCase()
  const found = cached.get(normalized)
  if (found) return found
  let work = 0
  const matches = matchingAssignments(pattern, tokens, {}, () => { if (++work > richPresenceContract.render.maximumHintSteps) throw new Error('Dynamic token work limit') }, true).map(match => match.token)
  if (!matches.length) return error('游戏详细状态引用了未发布的显示令牌。')
  cached.set(normalized, matches)
  return matches
}

function supportedParameters(tokens: Tokens, selected: string): string[] {
  let steps = 0
  const visit = (name: string, depth: number, stack: Set<string>): Set<string> => {
    if (++steps > maximumSteps || depth > maximumDepth || stack.has(name)) return error('游戏详细状态模板嵌套过深或存在循环。')
    const entry = tokens.get(name)
    if (!entry) return error('该详细状态模板尚未由当前游戏发布。')
    const result = new Set<string>()
    const nextStack = new Set(stack).add(name)
    for (const key of parametersIn(entry.text)) {
      if (!isGameStatusPresenceParameter(key)) return error('该详细状态模板需要不允许修改的字段。')
      result.add(key)
    }
    for (const ref of referencesIn(entry.text)) {
      const dynamic = parametersIn(ref).length > 0
      let found = false
      for (const dependency of relatedTokens(ref, tokens)) {
        try { for (const key of visit(dependency, depth + 1, nextStack)) result.add(key); found = true }
        catch (cause) { if (!dynamic || steps > maximumSteps) throw cause }
      }
      if (!found) return error('游戏详细状态没有可安全读取的已发布分支。')
    }
    return result
  }
  return [...visit(selected, 0, new Set())].sort()
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
  const allowed = new Set<string>()
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
    for (const key of parametersIn(entry.text)) {
      if (!isGameStatusPresenceParameter(key)) return error('该详细状态模板需要不允许修改的字段。')
      allowed.add(key)
    }
    const nextStack = new Set(stack).add(name)
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
    if (bytes(result) > maximumTemplateBytes) return error('详细状态渲染结果过长。')
    return result
  }
  const preview = render(selected, 0, new Set())
  if (!preview.trim()) return error('详细状态渲染结果为空或过长。')
  for (const key of Object.keys(input.values)) if (!allowed.has(key)) return error('详细状态包含所选游戏模板不支持的变量。')
  return { fields: { steam_display: tokens.get(selected)!.token, ...input.values }, preview }
}

export interface GameStatusPresenceParameterHint {
  key: string
  kind: 'text' | 'choice' | 'dependent'
  options: Array<{ value: string; label: string }>
}

// Hints describe the current branch, not a relaxation of submission validation.
export function gameStatusPresenceParameterHints(info: GameStatusAppInfo, presence: GameStatusPresence): GameStatusPresenceParameterHint[] {
  let fallback: GameStatusPresenceParameterHint[] = []
  try {
    if (!info || !Array.isArray(info.templates) || info.templates.length > GAME_STATUS_MAX_TEMPLATES) return []
    if (!object(presence) || typeof presence.displayToken !== 'string' || !tokenName.test(presence.displayToken) || !object(presence.values)) return []
    const entries = Object.entries(presence.values)
    if (entries.length > richPresenceContract.presence.maxKeys - 1) return []
    const normalized = new Set<string>()
    const editableValues: Record<string, string> = {}
    for (const [name, value] of entries) {
      const key = name.toLowerCase()
      if (!isGameStatusPresenceParameter(name) || normalized.has(key) || typeof value !== 'string') return []
      normalized.add(key)
      // Invalid text remains editable, but must not influence token resolution.
      editableValues[key] = !isWellFormedPresenceText(value) || bytes(value) > richPresenceContract.presence.valueUtf8Bytes || /\{#|%[A-Za-z0-9_:]+%/.test(value) ? '' : value
    }
    const input = { displayToken: presence.displayToken, values: editableValues }
    const tokens = tokensFromEntries(info.templates.map(template => [template.token, template.text]))
    const selected = input.displayToken.toLowerCase()
    const allowed = supportedParameters(tokens, selected)
    if (Object.keys(input.values).some(key => !allowed.includes(key))) return []
    fallback = allowed.map(key => ({ key, kind: 'dependent', options: [] }))
    let work = 0; let outputBytes = 0
    const step = () => { if (++work > richPresenceContract.render.maximumHintSteps) throw new Error('Parameter hint work limit') }
    const values = input.values
    const fragment = (value: string | undefined): value is string => typeof value === 'string' && tokenFragment.test(value)
    const resolveReference = (pattern: string, context: Record<string, string>): string | null => {
      let complete = true
      const result = pattern.replace(placeholder, (_match, name: string) => {
        const value = context[name.toLowerCase()]
        if (!fragment(value)) { complete = false; return '' }
        return value
      })
      return complete && tokenName.test(result) ? result.toLowerCase() : null
    }
    interface Occurrence { pattern: string; parameters: string[]; ancestors: Set<string> }
    const occurrences: Occurrence[] = []
    const required = new Set<string>()
    const walk = (name: string, ancestors: Set<string>, depth: number, stack: Set<string>): void => {
      step()
      if (depth > maximumDepth || stack.has(name)) throw new Error('Invalid parameter hint graph')
      const entry = tokens.get(name)
      if (!entry) throw new Error('Unknown parameter hint token')
      const nextStack = new Set(stack).add(name)
      for (const key of parametersIn(entry.text.replace(reference, ''))) {
        if (!isGameStatusPresenceParameter(key)) throw new Error('Unsafe parameter hint field')
        required.add(key)
      }
      for (const pattern of referencesIn(entry.text)) {
        const parameters = [...new Set(parametersIn(pattern))]
        for (const key of parameters) required.add(key)
        if (parameters.length) occurrences.push({ pattern, parameters, ancestors })
        const target = resolveReference(pattern, values)
        if (target && tokens.has(target)) walk(target, new Set([...ancestors, ...parameters]), depth + 1, nextStack)
      }
    }
    walk(selected, new Set(), 0, new Set())
    fallback = [...required].sort().map(key => ({ key, kind: 'dependent', options: [] }))

    interface Candidate { value: string; token: string; values: Record<string, string> }
    const candidatesFor = (occurrence: Occurrence, key: string): Map<string, Candidate> => {
      const known: Record<string, string> = {}
      for (const parameter of occurrence.parameters) if (parameter !== key && fragment(values[parameter])) known[parameter] = values[parameter]
      const found = new Map<string, Candidate>()
      for (const match of matchingAssignments(occurrence.pattern, tokens, known, step)) {
        const value = match.values[key]
        if (!value || !checkCandidate({ ...values, ...match.values, [key]: value })) continue
        const normalized = value.toLowerCase()
        if (!found.has(normalized)) found.set(normalized, { value, token: match.token, values: match.values })
      }
      return found
    }
    const renderLabel = (name: string, context: Record<string, string>, depth: number, stack: Set<string>): string | null => {
      step()
      if (depth > maximumDepth || stack.has(name)) return null
      const entry = tokens.get(name)
      if (!entry) return null
      const nextStack = new Set(stack).add(name)
      let complete = true; let result = ''; let offset = 0
      const substitute = (text: string) => text.replace(placeholder, (_match, key: string) => {
        const value = context[key.toLowerCase()]
        if (!value) { complete = false; return '' }
        return value
      })
      for (const match of entry.text.matchAll(reference)) {
        result += substitute(entry.text.slice(offset, match.index))
        const target = resolveReference(match[1]!, context)
        const rendered = target ? renderLabel(target, context, depth + 1, nextStack) : null
        if (rendered === null) return null
        result += rendered; offset = match.index! + match[0].length
        if (bytes(result) > maximumTemplateBytes) return null
      }
      result += substitute(entry.text.slice(offset))
      return complete && bytes(result) <= maximumTemplateBytes ? result : null
    }
    const checkCandidate = (context: Record<string, string>): boolean => {
      const visit = (name: string, depth: number, stack: Set<string>): boolean => {
        step()
        if (depth > maximumDepth || stack.has(name)) return false
        const entry = tokens.get(name)
        if (!entry) return false
        if (parametersIn(entry.text).some(key => !isGameStatusPresenceParameter(key))) return false
        const nextStack = new Set(stack).add(name)
        for (const pattern of referencesIn(entry.text)) {
          const target = resolveReference(pattern, context)
          if (target === null) continue
          if (!tokens.has(target)) return false
          if (!visit(target, depth + 1, nextStack)) return false
        }
        return true
      }
      return visit(selected, 0, new Set())
    }

    return [...required].sort().map<GameStatusPresenceParameterHint>(key => {
      const constraints = occurrences.filter(occurrence => occurrence.parameters.includes(key) && !occurrence.ancestors.has(key))
      if (!constraints.length) return { key, kind: 'text', options: [] }
      let candidates: Map<string, Candidate> | null = null; let dependent = false
      for (const occurrence of constraints) {
        const found = candidatesFor(occurrence, key)
        if (occurrence.parameters.some(parameter => parameter !== key && !fragment(values[parameter])) || !found.size && occurrence.parameters.length > 1) dependent = true
        if (candidates === null) candidates = found
        else for (const candidate of candidates.keys()) if (!found.has(candidate)) candidates.delete(candidate)
      }
      if (candidates === null) return { key, kind: 'dependent', options: [] }
      const options: GameStatusPresenceParameterHint['options'] = []
      for (const candidate of candidates.values()) {
        const label = renderLabel(candidate.token, { ...values, ...candidate.values, [key]: candidate.value }, 0, new Set()) ?? tokens.get(candidate.token)!.text
        outputBytes += bytes(candidate.value) + bytes(label)
        if (outputBytes > GAME_STATUS_MAX_CATALOG_BYTES) throw new Error('Parameter hint output limit')
        options.push({ value: candidate.value, label })
      }
      options.sort((left, right) => left.value.toLowerCase().localeCompare(right.value.toLowerCase()))
      return { key, kind: dependent ? 'dependent' : 'choice', options }
    })
  } catch { return fallback }
}
