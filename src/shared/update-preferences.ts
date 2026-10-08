import { DEFAULT_UPDATE_PREFERENCES, type UpdatePreferences } from './update-types'

export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid update preferences')
  const input = value as Partial<UpdatePreferences>
  if (typeof input.autoCheck !== 'boolean' || typeof input.useMirrors !== 'boolean' ||
    !Array.isArray(input.customMirrors) || input.customMirrors.length > 5) {
    throw new Error('Invalid update preferences')
  }
  const mirrors = input.customMirrors.map((item) => {
    if (typeof item !== 'string' || item.length > 2048) throw new Error('Invalid mirror URL')
    const url = new URL(item.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname === 'localhost') {
      throw new Error('Invalid mirror URL')
    }
    return url.href.endsWith('/') ? url.href : `${url.href}/`
  })
  return { autoCheck: input.autoCheck, useMirrors: input.useMirrors, customMirrors: [...new Set(mirrors)] }
}

export function defaultUpdatePreferences(): UpdatePreferences {
  return { ...DEFAULT_UPDATE_PREFERENCES, customMirrors: [] }
}
