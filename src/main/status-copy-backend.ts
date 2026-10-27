import type { StatusCopyReport, StatusCopySettingsInput } from '../shared/status-copy'

export interface StatusCopyLocalContext { steamId: string; appId: number; steamPid?: number; steamStartTicks?: string }
export interface StatusCopyBackendContext {
  target: { accountId: string; steamId: string }
  sourceSteamId: string
  signal: AbortSignal
  assertCurrent(): void
  checkLocal(): Promise<StatusCopyLocalContext>
}
export interface StatusCopyBackend {
  preview(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport>
  start(context: StatusCopyBackendContext, settings: StatusCopySettingsInput, allowAsfConfigReplace: boolean): Promise<StatusCopyReport>
  tick(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport>
  stop(): Promise<void>
}
