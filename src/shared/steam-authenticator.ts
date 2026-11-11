export type SteamAuthenticatorTimeSource = 'local' | 'steam'
export type SteamAuthenticatorClockWarning = 'local-clock' | 'steam-time-unavailable' | null

export interface SteamAuthenticatorCapabilities {
  hasConfirmations: boolean
  fullBackup: boolean
  hasRecoveryCode?: boolean
}

export interface SteamAuthenticatorExportResult {
  exported: boolean
  kind?: 'codes-only' | 'sda-backup'
}

export interface SteamAuthenticatorEntry {
  id: string
  name: string
  steamId: string | null
  code: string
  // Local epoch-ms deadline, adjusted back from Steam time for a Date.now() countdown.
  expiresAt: number
  timeSource: SteamAuthenticatorTimeSource
  capabilities: SteamAuthenticatorCapabilities
}

export interface SteamAuthenticatorSnapshot {
  entries: SteamAuthenticatorEntry[]
  secretStorageAvailable: boolean
  timeSource: SteamAuthenticatorTimeSource
  clockWarning: SteamAuthenticatorClockWarning
}

export interface SteamAuthenticatorImportPreview {
  id: string
  name: string
  steamId: string | null
  replacesId: string | null
}

export interface SteamAuthenticatorApi {
  state(): Promise<SteamAuthenticatorSnapshot>
  importFile(): Promise<SteamAuthenticatorSnapshot | null>
  remove(input: { id: string }): Promise<SteamAuthenticatorSnapshot>
  syncTime(): Promise<SteamAuthenticatorSnapshot>
  copyCode(input: { id: string }): Promise<void>
  exportFile(input: { id: string }): Promise<SteamAuthenticatorExportResult>
  showRecoveryCode(input: { id: string }): Promise<{ viewed: boolean }>
}
