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
  importStatus?: 'uncertain'
  importReason?: string
}

export interface ScreenshotPrepareInput {
  mode?: ScreenshotImportMode
  steamPath: string
  userId: string
  appId: string
  imageIds: string[]
  jpegQuality: number
  resizeLargeImages: boolean
  caption?: string
  restartSteam?: boolean
  preferLive?: boolean
}

export type ScreenshotImportMode = 'current-account' | 'local-account'

export type ScreenshotImportPhase = 'connecting-steam' | 'importing-live' | 'closing-steam' | 'importing' | 'starting-steam' | 'idle'

export interface ScreenshotImageOutcome {
  imageId: string
  name: string
  status: 'confirmed' | 'rejected' | 'uncertain'
  code?: string
}

export interface ScreenshotPrepareResult {
  imported: number
  files: string[]
  backupPath: string | null
  vdfPath: string
  steamRestart?: 'restarted' | 'failed'
  method?: 'steam-api' | 'index'
  outcomes?: ScreenshotImageOutcome[]
  completedImageIds?: string[]
  warning?: 'LIVE_WORKER_STOP_UNCONFIRMED'
  activation?: 'after-account-switch'
}

export const SCREENSHOT_MAX_SIDE = 16_000
export const SCREENSHOT_MAX_PIXELS = 26_210_175
