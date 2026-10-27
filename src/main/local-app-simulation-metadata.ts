import { createRequire } from 'node:module'
import type { GameStatusAppInfo } from '../shared/game-status'
import { readGameStatusAppInfo, type GameStatusAppClient } from './game-status-apps'

export interface AnonymousAppMetadataClient extends GameStatusAppClient {
  on(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  logOn(details: { anonymous: true }): void | Promise<void>
  logOff(): void
}
export interface LocalAppMetadataOptions {
  createClient?(): AnonymousAppMetadataClient
  signal?: AbortSignal
  loginTimeoutMs?: number
  totalTimeoutMs?: number
  includeLocalization?: boolean
}

export function createAnonymousAppMetadataClient(): AnonymousAppMetadataClient {
  const SteamUser = createRequire(import.meta.url)('steam-user') as { new(options: Record<string, unknown>): AnonymousAppMetadataClient }
  class MetadataClient extends SteamUser {
    private retired = false
    private starts = new Set<NodeJS.Immediate>()
    logOn(details: { anonymous: true } | true): void {
      if (this.retired) return
      const pending = setImmediate(() => {
        this.starts.delete(pending)
        if (this.retired) return
        try {
          const result = super.logOn(details as { anonymous: true })
          result?.catch(error => this.emitFailure(error))
        } catch (error) { this.emitFailure(error) }
      })
      this.starts.add(pending)
    }
    private emitFailure(error: unknown): void { if (!this.retired) (this as unknown as EventEmitterLike).emit('error', error) }
    logOff(): void { this.retired = true; for (const pending of this.starts) clearImmediate(pending); this.starts.clear(); super.logOff() }
    webLogOn(): void {}
  }
  return new MetadataClient({ dataDirectory: null, autoRelogin: false, saveAppTickets: false,
    enablePicsCache: false, changelistUpdateInterval: 0, renewRefreshTokens: false }) as AnonymousAppMetadataClient
}
interface EventEmitterLike { emit(event: string, error: unknown): void }

export async function readLocalAppMetadata(appId: number, language: 'schinese' | 'english', options: LocalAppMetadataOptions = {}): Promise<GameStatusAppInfo> {
  const client = (options.createClient ?? createAnonymousAppMetadataClient)()
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let loginTimer: ReturnType<typeof setTimeout> | undefined
  let rejectOperation!: (error: Error) => void
  const unavailable = () => new Error('Anonymous app metadata unavailable')
  const assertCurrent = () => { if (finished || options.signal?.aborted) throw unavailable() }
  const cancel = () => rejectOperation(unavailable())
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject
    timer = setTimeout(cancel, options.totalTimeoutMs ?? 60000); timer.unref?.()
  })
  let ready!: () => void
  const loggedOn = new Promise<void>((resolve, reject) => {
    ready = () => { clearTimeout(loginTimer); resolve() }
    loginTimer = setTimeout(() => reject(unavailable()), options.loginTimeoutMs ?? 12000); loginTimer.unref?.()
  })
  client.on('loggedOn', ready); client.on('error', cancel); client.on('disconnected', cancel); client.on('steamGuard', cancel)
  options.signal?.addEventListener('abort', cancel, { once: true })
  const lateLogin = () => { if (finished) { try { client.logOff() } catch { /* Only this anonymous client is owned. */ } } }
  client.on('loggedOn', lateLogin)
  try {
    assertCurrent()
    const login = client.logOn({ anonymous: true }); login?.catch(cancel)
    return await Promise.race([deadline, (async () => {
      await loggedOn; assertCurrent()
      return await readGameStatusAppInfo({
        ...(client.getProductInfo ? { getProductInfo: (apps, packages) => client.getProductInfo!(apps, packages, false) } : {}),
        ...(options.includeLocalization && client.getAppRichPresenceLocalization ? { getAppRichPresenceLocalization: (app, requested) => client.getAppRichPresenceLocalization!(app, requested) } : {})
      }, appId, language, assertCurrent)
    })()])
  } finally {
    finished = true; clearTimeout(timer); clearTimeout(loginTimer)
    options.signal?.removeEventListener('abort', cancel)
    client.removeListener('loggedOn', ready); client.removeListener('error', cancel)
    client.removeListener('disconnected', cancel); client.removeListener('steamGuard', cancel)
    client.on('error', () => {})
    try { client.logOff() } catch { /* Never retry login or use a personal session. */ }
  }
}
