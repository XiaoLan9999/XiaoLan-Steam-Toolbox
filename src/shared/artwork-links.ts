export const ARTWORK_UPLOAD_URL = 'https://steamcommunity.com/sharedfiles/edititem/767/3/'

export const ARTWORK_SOURCE_URLS = {
  guide: 'https://steamcommunity.com/sharedfiles/filedetails/?id=748624905&l=english',
  sapic: 'https://github.com/sapic/sapic/blob/0abb62f34b47fbc65b22e47950849c28c1946873/src/stores/index.ts',
  'steam-design': 'https://steam.design/'
} as const

export type ArtworkSource = keyof typeof ARTWORK_SOURCE_URLS
