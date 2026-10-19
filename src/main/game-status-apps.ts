import type { GameStatusAppInfo } from '../shared/game-status'
import { gameStatusTemplatesFromTokens, isSafeGameStatusIconUrl } from '../shared/game-status-presence'

export interface GameStatusAppClient {
  getProductInfo?(apps: number[], packages: number[], inclTokens?: boolean): Promise<unknown>
  getAppRichPresenceLocalization?(appId: number, language: string): Promise<unknown>
}

export const GAME_STATUS_APP_LOOKUP_TIMEOUT_MS = 12000
const control = /[\p{Cc}\u2028\u2029]/u
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

async function bounded<T>(lookup: () => Promise<T>, assertCurrent: () => void): Promise<T> {
  assertCurrent()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('读取游戏信息超时，请重试。')), GAME_STATUS_APP_LOOKUP_TIMEOUT_MS); timer.unref?.() })
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
  if (!client.getAppRichPresenceLocalization) return { appId, name, iconUrl, language, templates: [], templateStatus: 'unavailable' }
  let effectiveLanguage = language
  const localization = async (requested: 'schinese' | 'english'): Promise<unknown> => {
    const response = await bounded(() => client.getAppRichPresenceLocalization!(appId, requested), assertCurrent)
    if (!object(response) || !object(response.tokens)) throw new Error('Steam 未返回有效的游戏状态模板。')
    return response.tokens
  }
  let tokens: unknown
  try { tokens = await localization(language) }
  catch {
    assertCurrent()
    if (language === 'english') return { appId, name, iconUrl, language, templates: [], templateStatus: 'unavailable' }
    try { tokens = await localization('english'); effectiveLanguage = 'english' }
    catch { assertCurrent(); return { appId, name, iconUrl, language, templates: [], templateStatus: 'unavailable' } }
  }
  assertCurrent()
  let templates: GameStatusAppInfo['templates']
  try { templates = gameStatusTemplatesFromTokens(tokens) }
  catch { assertCurrent(); return { appId, name, iconUrl, language: effectiveLanguage, templates: [], templateStatus: 'unavailable' } }
  assertCurrent()
  return { appId, name, iconUrl, language: effectiveLanguage, templates, templateStatus: templates.length ? 'available' : object(tokens) && Object.keys(tokens).length ? 'unavailable' : 'empty' }
}
