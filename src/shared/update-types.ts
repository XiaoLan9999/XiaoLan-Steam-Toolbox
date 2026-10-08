export type UpdatePackageKind = 'setup' | 'portable'

export interface UpdateAsset {
  kind: UpdatePackageKind
  fileName: string
  size: number
  sha256: string
  downloadUrl: string
}

export interface UpdateManifest {
  schema: 1
  repository: string
  version: string
  publishedAt: string
  releaseUrl: string
  assets: UpdateAsset[]
}

export interface SignedUpdateManifest {
  schema: 1
  keyId: string
  payload: string
  signature: string
}

export interface UpdatePreferences {
  autoCheck: boolean
  useMirrors: boolean
  customMirrors: string[]
}

export interface UpdateRouteStatus {
  id: string
  label: string
  domain: string
  status: 'pending' | 'available' | 'failed'
  latencyMs: number | null
  speedBytesPerSecond: number | null
  error: string | null
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'error'
  currentVersion: string
  latestVersion: string | null
  checkedAt: string | null
  releaseUrl: string | null
  packageKind: UpdatePackageKind
  sourceRouteId: string | null
  routes: UpdateRouteStatus[]
  downloadedBytes: number
  totalBytes: number
  percent: number
  speedBytesPerSecond: number
  error: string | null
}

export const UPDATE_REPOSITORY = 'XiaoLan9999/XiaoLan-Steam-Toolbox'
export const UPDATE_MANIFEST_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/update-manifest.json`
export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { autoCheck: true, useMirrors: true, customMirrors: [] }

export function initialUpdateState(currentVersion: string, packageKind: UpdatePackageKind): UpdateState {
  return { phase: 'idle', currentVersion, latestVersion: null, checkedAt: null, releaseUrl: null,
    packageKind, sourceRouteId: null, routes: [], downloadedBytes: 0, totalBytes: 0,
    percent: 0, speedBytesPerSecond: 0, error: null }
}

export const BUILTIN_UPDATE_ROUTES = [
  { id: 'github', label: 'GitHub', prefix: null },
  { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'gh-proxy-org', label: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
  { id: 'monlor', label: 'gh.monlor.com', prefix: 'https://gh.monlor.com/' },
  { id: 'imciel', label: 'ghproxy.imciel.com', prefix: 'https://ghproxy.imciel.com/' },
  { id: 'fastgit', label: 'fastgit.cc', prefix: 'https://fastgit.cc/' },
  { id: 'ednovas', label: 'github.ednovas.xyz', prefix: 'https://github.ednovas.xyz/' },
  { id: 'vvvv', label: 'proxy.vvvv.ee', prefix: 'https://proxy.vvvv.ee/' },
  { id: 'keleyaa', label: 'ghp.keleyaa.com', prefix: 'https://ghp.keleyaa.com/' }
] as const
