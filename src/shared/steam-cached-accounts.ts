export type SteamCachedAccountsError = 'STEAM_CACHE_UNAVAILABLE' | 'STEAM_CACHE_INVALID' | 'STEAM_CACHE_CHANGED' |
  'STEAM_CACHE_BUSY' | 'STEAM_CACHE_GAME_RUNNING' | 'STEAM_CACHE_EXIT_UNCONFIRMED' | 'STEAM_CACHE_LAUNCH_FAILED' |
  'STEAM_CACHE_WRITE_FAILED' | 'STEAM_CACHE_CLIENT_CHANGED' | 'STEAM_CACHE_RECOVERY_REQUIRED' | 'STEAM_CACHE_ACTIVITY_UNAVAILABLE' | 'STEAM_CACHE_ACTION_UNAVAILABLE'

export interface SteamCachedAccount {
  steamId: string
  accountName: string
  displayName: string
  remembered: boolean
  mostRecent: boolean
  lastLoginAt: string | null
  avatarDataUrl?: string | null
  note?: string | null
}
export interface SteamCachedAccountsSnapshot {
  revision: string
  steamPath: string | null
  accounts: SteamCachedAccount[]
  steamRunning: boolean
  busy: boolean
  status: 'idle' | 'switching' | 'awaiting-login' | 'cancelled' | 'error'
  error: SteamCachedAccountsError | null
  hiddenCount?: number
}
export interface SteamCachedAccountSwitch { steamId: string; revision: string; mode?: 'online' | 'offline' }
export interface SteamCachedAccountAction {
  steamId: string
  revision: string
  action: 'copy-id' | 'copy-login' | 'copy-name' | 'profile' | 'userdata' | 'shortcut' | 'note' | 'hide'
  note?: string
}
export interface SteamCachedAccountActionResult { performed: boolean; state: SteamCachedAccountsSnapshot }
export interface SteamCachedAccountsApi {
  state(): Promise<SteamCachedAccountsSnapshot>
  switchAccount(input: SteamCachedAccountSwitch): Promise<SteamCachedAccountsSnapshot>
  action?(input: SteamCachedAccountAction): Promise<SteamCachedAccountActionResult>
  avatar?(input: { steamId: string; revision: string }): Promise<string | null>
  restoreHidden?(): Promise<SteamCachedAccountsSnapshot>
}
