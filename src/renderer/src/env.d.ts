import type { SteamFriendCommenterApi } from '../../shared/types'

declare global {
  interface Window {
    steamCommenter: SteamFriendCommenterApi
  }
}

export {}
