export type SteamAuthenticatorEnrollmentPhase = 'idle' | 'login-required' | 'guard-required' | 'phone-needed' |
  'email-required' | 'sms-required' | 'ready-to-add' | 'adding' | 'add-uncertain' | 'backup-required' |
  'ready-to-finalize' | 'finalizing' | 'finalize-wait' | 'verifying' | 'complete' | 'paused' | 'error'

export interface SteamAuthenticatorEnrollmentSnapshot {
  id: string | null
  phase: SteamAuthenticatorEnrollmentPhase
  accountName: string | null
  steamId: string | null
  guardType: 'email' | 'device' | 'confirmation' | null
  confirmationKind: 'sms' | 'email' | 'unknown' | null
  hint: string | null
  backupExported: boolean
  backupAcknowledged: boolean
  retryAt: number | null
  entryId: string | null
  error: string | null
  busy: boolean
  metadataIncomplete?: boolean
  hasRescueMaterials?: boolean
}

export interface SteamAuthenticatorEnrollmentAction { id: string }
export interface SteamAuthenticatorEnrollmentApi {
  state(): Promise<SteamAuthenticatorEnrollmentSnapshot>
  login(input: { accountName: string; password: string; expectedSteamId?: string }): Promise<SteamAuthenticatorEnrollmentSnapshot>
  submitGuard(input: SteamAuthenticatorEnrollmentAction & { code: string }): Promise<SteamAuthenticatorEnrollmentSnapshot>
  refreshLogin(input: SteamAuthenticatorEnrollmentAction): Promise<SteamAuthenticatorEnrollmentSnapshot>
  phone(input: SteamAuthenticatorEnrollmentAction & { op: 'status' | 'begin' | 'send-sms' | 'submit-sms'; phoneNumber?: string; countryCode?: string; code?: string }): Promise<SteamAuthenticatorEnrollmentSnapshot>
  add(input: SteamAuthenticatorEnrollmentAction): Promise<SteamAuthenticatorEnrollmentSnapshot>
  showRecoveryCode(input: SteamAuthenticatorEnrollmentAction): Promise<{ shown: boolean }>
  exportBackup(input: SteamAuthenticatorEnrollmentAction): Promise<{ exported: boolean }>
  acknowledgeRecoverySaved(input: SteamAuthenticatorEnrollmentAction): Promise<SteamAuthenticatorEnrollmentSnapshot>
  finalize(input: SteamAuthenticatorEnrollmentAction & { activationCode: string }): Promise<SteamAuthenticatorEnrollmentSnapshot>
  resume(input: SteamAuthenticatorEnrollmentAction): Promise<SteamAuthenticatorEnrollmentSnapshot>
  pause(input: SteamAuthenticatorEnrollmentAction): Promise<SteamAuthenticatorEnrollmentSnapshot>
}
