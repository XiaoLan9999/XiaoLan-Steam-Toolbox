import type { UpdateState } from '../../shared/update-types'

export const DISMISSED_UPDATE_VERSION_KEY = 'xiaolan-steam-toolbox.update-dismissed-through-version'

type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>
let dismissedThisRuntime: string | null = null

function stableVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

export function compareUpdateVersions(left: string | null, right: string | null): number | null {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1
  }
  return 0
}

function highestVersion(left: string | null, right: string | null): string | null {
  if (!stableVersion(left)) return stableVersion(right) ? right : null
  return compareUpdateVersions(right, left) === 1 ? right : left
}

function browserStorage(): DismissalStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage }
  catch { return null }
}

export function readDismissedUpdateVersion(storage?: DismissalStorage | null): string | null {
  const target = storage === undefined ? browserStorage() : storage
  let stored: string | null = null
  try { stored = target?.getItem(DISMISSED_UPDATE_VERSION_KEY) ?? null }
  catch { /* A blocked preference store must not break the toolbox. */ }
  const highest = highestVersion(storage === undefined ? dismissedThisRuntime : null, stored)
  if (storage === undefined) dismissedThisRuntime = highest
  return highest
}

export function dismissUpdateVersion(version: string, storage?: DismissalStorage | null): string | null {
  const highest = highestVersion(readDismissedUpdateVersion(storage), version)
  if (!highest) return null
  if (storage === undefined) dismissedThisRuntime = highest
  try { (storage === undefined ? browserStorage() : storage)?.setItem(DISMISSED_UPDATE_VERSION_KEY, highest) }
  catch { /* Keep dismissal in memory even if storage is unavailable. */ }
  return highest
}

// latestVersion is supplied only after the updater verifies a signed manifest.
export function hasAvailableUpdate(state: UpdateState): boolean {
  return compareUpdateVersions(state.latestVersion, state.currentVersion) === 1
}

export function shouldShowUpdateNotice(state: UpdateState, dismissedThrough: string | null): boolean {
  const comparison = compareUpdateVersions(state.latestVersion, dismissedThrough)
  return hasAvailableUpdate(state) && (comparison === null || comparison === 1)
}
