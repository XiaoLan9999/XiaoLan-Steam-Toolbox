export type ScreenshotWarning =
  | 'STEAM_NOT_FOUND'
  | 'USERS_NOT_FOUND'
  | 'LOGIN_NAMES_UNAVAILABLE'
  | 'LIBRARY_METADATA_UNAVAILABLE'
  | 'USER_METADATA_UNAVAILABLE'
  | 'SCREENSHOT_METADATA_UNAVAILABLE'
  | 'STEAM_RUNNING'

export interface ScreenshotUser {
  id: string
  steamId: string
  displayName: string
  accountName?: string
  mostRecent: boolean
  nameSource: 'loginusers' | 'localconfig' | 'account' | 'profile' | 'fallback'
}

export interface ScreenshotGame {
  appId: string
  name: string
  nameSource: 'manifest' | 'screenshot' | 'localconfig' | 'store' | 'fallback'
  installed: boolean
  userIds: string[]
}

export interface ScreenshotCatalog {
  steamPath: string | null
  refreshedAt: string
  steamRunning: boolean
  users: ScreenshotUser[]
  games: ScreenshotGame[]
  warnings: ScreenshotWarning[]
  refreshing?: boolean
  nameLookupPending?: number
}

export interface ScreenshotImage {
  id: string
  name: string
  width: number
  height: number
  size: number
  previewUrl: string
  resizeRequired: boolean
}

export interface ScreenshotPrepareInput {
  steamPath: string
  userId: string
  appId: string
  imageIds: string[]
  jpegQuality: number
  resizeLargeImages: boolean
  caption?: string
}

export interface ScreenshotPrepareResult {
  imported: number
  files: string[]
  backupPath: string
  vdfPath: string
}

export const SCREENSHOT_MAX_SIDE = 16_000
export const SCREENSHOT_MAX_PIXELS = 26_210_175
