export interface SteamProfileBackground {
  id: string
  title: string
  kind: 'static' | 'animated'
  imageUrl: string | null
  stillImageUrl: string | null
  videoUrl: string | null
  equipped: boolean
  source: 'profileItems' | 'inventory' | 'profilePage'
}

export type ProfileBackgroundIssue =
  | 'profileUnavailable'
  | 'ownedUnavailable'
  | 'inventoryUnavailable'
  | 'inventoryPartial'
  | 'unsupportedItems'

export interface ProfileBackgroundCatalog {
  accountId: string
  items: SteamProfileBackground[]
  issues: ProfileBackgroundIssue[]
  ownedComplete: boolean
  fetchedAt: string
}

export interface ProfileBackgroundImage {
  accountId: string
  backgroundId: string
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  base64: string
}

export interface ArtworkUploadDraft {
  name: string
  base64: string
}
