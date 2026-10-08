import { AUTHOR_WEBSITE_URL } from '../shared/branding'
import { ARTWORK_SOURCE_URLS } from '../shared/artwork-links'

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return url.origin === 'https://steamcommunity.com' || url.href === AUTHOR_WEBSITE_URL ||
      Object.values(ARTWORK_SOURCE_URLS).some((source) => url.href === source)
  } catch {
    return false
  }
}
