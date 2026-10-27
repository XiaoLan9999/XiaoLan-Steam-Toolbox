import type { GameStatusAppInfo, GameStatusTemplateDiagnostics } from '../shared/game-status'
import { GAME_STATUS_MAX_CATALOG_BYTES, GAME_STATUS_MAX_TEMPLATES, gameStatusTemplatesFromTokens, isSafeGameStatusIconUrl } from '../shared/game-status-presence'

export interface GameStatusAppClient {
  getProductInfo?(apps: number[], packages: number[], inclTokens?: boolean): Promise<unknown>
  getAppRichPresenceLocalization?(appId: number, language: string): Promise<unknown>
}

export const GAME_STATUS_APP_LOOKUP_TIMEOUT_MS = 12000
const control = /[\p{Cc}\u2028\u2029]/u
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const plainObject = (value: unknown): value is Record<string, unknown> => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
type Language = GameStatusAppInfo['language']
type LookupCode = NonNullable<GameStatusTemplateDiagnostics['lookupCode']>
interface LookupFailure { code: LookupCode; steamResult?: number }
type CatalogLookup = { tokens: Record<string, unknown>; failure?: never; invalid?: never } | { tokens?: never; failure: LookupFailure; invalid?: boolean }
class LookupTimeout extends Error {}
const lookupCodes: Record<string, LookupCode> = {
  LOCAL_APP_CATALOG_UNAVAILABLE: 'unavailable', LOCAL_APP_CATALOG_TIMEOUT: 'timeout',
  LOCAL_APP_CATALOG_RESPONSE_INVALID: 'invalid-response', LOCAL_APP_CATALOG_CANCELLED: 'cancelled',
  LOCAL_APP_CATALOG_LANGUAGE_MISSING: 'language-missing', LOCAL_APP_CATALOG_APP_MISMATCH: 'app-mismatch'
}

function sdkLocalizationTokens(value: unknown): Record<string, unknown> {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Steam 游戏状态模板格式无效。')
  const entries = Object.entries(value)
  if (entries.length > GAME_STATUS_MAX_TEMPLATES * 2) throw new Error('Steam 游戏状态模板数量过大。')
  const folded = new Map<string, { token: string; text: unknown }>()
  let bytes = 0
  for (const [token, text] of entries) {
    bytes += Buffer.byteLength(token) + (typeof text === 'string' ? Buffer.byteLength(text) : 0)
    if (bytes > GAME_STATUS_MAX_CATALOG_BYTES * 2) throw new Error('Steam 游戏状态模板数据过大。')
    const normalized = token.toLowerCase()
    const previous = folded.get(normalized)
    if (previous) {
      if (typeof text !== 'string' || previous.text !== text) throw new Error('Steam 游戏状态模板包含冲突别名。')
      continue
    }
    // The SDK adds lowercase aliases to its cached map while localizing RP.
    // Collapse only identical aliases here; shared/renderer validation stays strict.
    folded.set(normalized, { token, text })
  }
  const normalized = Object.fromEntries([...folded.values()].map(entry => [entry.token, entry.text]))
  checkCatalogBounds(normalized)
  return normalized
}

function checkCatalogBounds(tokens: Record<string, unknown>): void {
  const entries = Object.entries(tokens)
  if (entries.length > GAME_STATUS_MAX_TEMPLATES || entries.reduce((size, [token, text]) => size + Buffer.byteLength(token) + (typeof text === 'string' ? Buffer.byteLength(text) : 0), 0) > GAME_STATUS_MAX_CATALOG_BYTES) throw new Error('Steam 游戏状态模板数据过大。')
}

function mergedCatalog(base: Record<string, unknown>, preferred: Record<string, unknown>): Record<string, unknown> {
  const folded = new Map<string, [string, unknown]>()
  for (const entry of Object.entries(base)) folded.set(entry[0].toLowerCase(), entry)
  for (const entry of Object.entries(preferred)) {
    const key = entry[0].toLowerCase()
    const previous = folded.get(key)?.[1]
    if (entry[1] === '' && typeof previous === 'string' && previous !== '') continue
    folded.set(key, entry)
  }
  const result = Object.fromEntries(folded.values())
  checkCatalogBounds(result)
  return result
}

async function bounded<T>(lookup: () => Promise<T>, assertCurrent: () => void): Promise<T> {
  assertCurrent()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LookupTimeout('读取游戏信息超时，请重试。')), GAME_STATUS_APP_LOOKUP_TIMEOUT_MS); timer.unref?.() })
    const value = await Promise.race([Promise.resolve().then(() => { assertCurrent(); return lookup() }), expired])
    assertCurrent()
    return value
  } finally { if (timer) clearTimeout(timer) }
}

export async function readGameStatusAppInfo(client: GameStatusAppClient, appId: number, language: 'schinese' | 'english', assertCurrent: () => void): Promise<GameStatusAppInfo> {
  assertCurrent()
  if (!Number.isInteger(appId) || appId < 1 || appId > 0xffffff || !['schinese', 'english'].includes(language)) throw new Error('请输入有效的 Steam AppID 和游戏状态语言。')
  let name = `App ${appId}`; let iconUrl: string | null = null
  if (client.getProductInfo) {
    try {
      const response = await bounded(() => client.getProductInfo!([appId], [], true), assertCurrent)
      const app = object(response) && object(response.apps) ? response.apps[String(appId)] : null
      const common = object(app) && object(app.appinfo) && object(app.appinfo.common) ? app.appinfo.common : null
      if (common && typeof common.name === 'string' && common.name.trim() && !control.test(common.name) && Buffer.byteLength(common.name) <= 255) name = common.name.trim()
      if (common && typeof common.icon === 'string' && /^[a-f0-9]{40}$/i.test(common.icon)) {
        const candidate = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${common.icon.toLowerCase()}.jpg`
        if (isSafeGameStatusIconUrl(candidate, appId)) iconUrl = candidate
      }
    } catch { assertCurrent() }
  }
  assertCurrent()
  const result = (diagnostics: GameStatusTemplateDiagnostics, effectiveLanguage: Language = language, templates: GameStatusAppInfo['templates'] = []): GameStatusAppInfo => ({
    appId, name, iconUrl, language: effectiveLanguage, templates,
    templateStatus: templates.length ? 'available' : diagnostics.reason === 'empty' ? 'empty' : 'unavailable', templateDiagnostics: diagnostics
  })
  const diagnostic = (reason: GameStatusTemplateDiagnostics['reason'], sourceLanguage: GameStatusTemplateDiagnostics['sourceLanguage'], rawTokenCount: number | null, usedEnglishFallback: boolean, failed?: LookupFailure): GameStatusTemplateDiagnostics => ({
    reason, requestedLanguage: language, sourceLanguage, rawTokenCount, usedEnglishFallback,
    ...(failed ? { lookupCode: failed.code, ...(failed.steamResult !== undefined ? { steamResult: failed.steamResult } : {}) } : {})
  })
  if (!client.getAppRichPresenceLocalization) return result(diagnostic('lookup-unavailable', null, null, false, { code: 'unavailable' }))
  const localization = async (requested: Language): Promise<CatalogLookup> => {
    let response: unknown
    try { response = await bounded(() => client.getAppRichPresenceLocalization!(appId, requested), assertCurrent) }
    catch (error) { assertCurrent(); return { failure: { code: error instanceof LookupTimeout ? 'timeout' : 'unavailable' } } }
    assertCurrent()
    if (!plainObject(response) || !plainObject(response.tokens) || response.available !== undefined && typeof response.available !== 'boolean' || response.steamResult !== undefined && (!Number.isInteger(response.steamResult) || Number(response.steamResult) < 0 || Number(response.steamResult) > 255)) return { failure: { code: 'invalid-response' }, invalid: true }
    const steamResult = typeof response.steamResult === 'number' ? response.steamResult : undefined
    if (response.available === false) {
      if (Object.keys(response.tokens).length) return { failure: { code: 'invalid-response' }, invalid: true }
      return { failure: { code: typeof response.code === 'string' && Object.hasOwn(lookupCodes, response.code) ? lookupCodes[response.code]! : 'unavailable', ...(steamResult !== undefined ? { steamResult } : {}) } }
    }
    try { return { tokens: sdkLocalizationTokens(response.tokens) } }
    catch { assertCurrent(); return { failure: { code: 'invalid-response', ...(steamResult !== undefined ? { steamResult } : {}) }, invalid: true } }
  }
  const preferred = await localization(language)
  if (preferred.invalid) return result(diagnostic('invalid-catalog', null, null, false, preferred.failure))
  const english = language === 'english' ? preferred : await localization('english')
  if (english.invalid) return result(diagnostic('invalid-catalog', null, null, false, english.failure))
  assertCurrent()
  const failed = preferred.failure ?? english.failure
  if (!preferred.tokens && !english.tokens) return result(diagnostic('lookup-unavailable', null, null, false, failed))
  const preferredNames = new Set(Object.entries(preferred.tokens ?? {}).filter(([, text]) => typeof text === 'string' && text !== '').map(([token]) => token.toLowerCase()))
  const englishContributes = language !== 'english' && Object.entries(english.tokens ?? {}).some(([token, text]) => typeof text === 'string' && text !== '' && !preferredNames.has(token.toLowerCase()))
  const preferredContributes = preferredNames.size > 0
  const sourceLanguage = language === 'english' ? 'english' : englishContributes ? preferredContributes ? 'mixed' : 'english' : preferred.tokens ? 'schinese' : 'english'
  const effectiveLanguage = sourceLanguage === 'english' ? 'english' : language
  let tokens: Record<string, unknown>; let templates: GameStatusAppInfo['templates']
  try {
    tokens = language === 'english' ? preferred.tokens! : mergedCatalog(english.tokens ?? {}, preferred.tokens ?? {})
    templates = gameStatusTemplatesFromTokens(tokens)
  } catch { assertCurrent(); return result(diagnostic('invalid-catalog', sourceLanguage, null, englishContributes, { code: 'invalid-response' }), effectiveLanguage) }
  assertCurrent()
  const count = Object.keys(tokens).length
  const reason = templates.length ? 'available' : failed ? 'lookup-unavailable' : count ? 'no-safe-templates' : 'empty'
  return result(diagnostic(reason, sourceLanguage, count, englishContributes, failed), effectiveLanguage, templates)
}
