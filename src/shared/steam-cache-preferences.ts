export interface SteamCacheProfilePreference { note?: string; hidden?: boolean }
export function validSteamCachePreference(value: unknown): value is SteamCacheProfilePreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).every(key => key === 'note' || key === 'hidden') &&
    (item.note === undefined || typeof item.note === 'string' && item.note.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(item.note)) &&
    (item.hidden === undefined || typeof item.hidden === 'boolean')
}
