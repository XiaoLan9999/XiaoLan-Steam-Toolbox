export type Theme = 'light' | 'dark'
const THEME_CACHE_KEY = 'xiaolan-steam-toolbox-theme'

export function normalizeTheme(value: unknown): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme, target?: HTMLElement, storage?: Pick<Storage, 'setItem'>): void {
  const root = target ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  if (root) { root.dataset.theme = theme; root.style.colorScheme = theme }
  try { (storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage))?.setItem(THEME_CACHE_KEY, theme) }
  catch { /* The persisted main-process preference remains authoritative. */ }
}

export function restoreCachedTheme(target?: HTMLElement, storage?: Pick<Storage, 'getItem'>): Theme {
  let theme: Theme = 'light'
  try { theme = normalizeTheme((storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage))?.getItem(THEME_CACHE_KEY)) }
  catch { /* Missing or restricted local cache uses the light startup palette. */ }
  const root = target ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  if (root) { root.dataset.theme = theme; root.style.colorScheme = theme }
  return theme
}
