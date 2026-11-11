export type SteamAuthenticatorConfirmationAction = 'allow' | 'cancel'
export type SteamAuthenticatorConfirmationOutcome = 'accepted' | 'rejected' | 'unknown' | 'cancelled' | 'stale'
export type SteamAuthenticatorConfirmationError = 'AUTH_CONFIRMATION_INVALID' | 'AUTH_CONFIRMATION_UNAVAILABLE' |
  'AUTH_CONFIRMATION_IDENTITY' | 'AUTH_CONFIRMATION_CHANGED' | 'AUTH_CONFIRMATION_EXPIRED' |
  'AUTH_CONFIRMATION_BUSY' | 'AUTH_CONFIRMATION_UNSUPPORTED' | 'AUTH_CONFIRMATION_LIST_FAILED' |
  'AUTH_CONFIRMATION_TIME_UNAVAILABLE' | 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE'

export interface SteamAuthenticatorConfirmationItem {
  id: string
  type: number
  title: string
  summary: string[]
  canRespond: boolean
  blockedReason?: 'unsupported-type' | 'already-submitted'
}
export interface SteamAuthenticatorConfirmationSnapshot {
  entryId: string
  ownerSteamId: string
  listId: string
  listedAt: number
  expiresAt: number
  items: SteamAuthenticatorConfirmationItem[]
}
export interface SteamAuthenticatorConfirmationListInput { entryId: string }
export interface SteamAuthenticatorConfirmationRespondInput extends SteamAuthenticatorConfirmationListInput {
  listId: string
  confirmationId: string
  action: SteamAuthenticatorConfirmationAction
}
export interface SteamAuthenticatorConfirmationResult {
  entryId: string
  listId: string
  confirmationId: string
  action: SteamAuthenticatorConfirmationAction
  outcome: SteamAuthenticatorConfirmationOutcome
  requestSubmitted: boolean
}
export interface SteamAuthenticatorConfirmationsApi {
  list(input: SteamAuthenticatorConfirmationListInput): Promise<SteamAuthenticatorConfirmationSnapshot>
  respond(input: SteamAuthenticatorConfirmationRespondInput): Promise<SteamAuthenticatorConfirmationResult>
}
