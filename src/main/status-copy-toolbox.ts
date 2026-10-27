import { randomBytes } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type { StatusCopyCode, StatusCopyReport, StatusCopySettingsInput, StatusCopySource } from '../shared/status-copy'
import { GROUP_SIZE_KEY, readGroupSize } from '../shared/game-status-group'
import { gameStatusPresenceParameterHints, isGameStatusPresenceParameter, validateGameStatusPresence } from '../shared/game-status-presence'
import { isWellFormedPresenceText, richPresenceContract, richPresenceDisplayToken } from '../shared/rich-presence-contract'
import { createGameStatusSteamClient, GAME_STATUS_CLIENT_OPTIONS, type GameStatusSteamClient } from './game-status-service'
import { readGameStatusAppInfo } from './game-status-apps'
import { detectNativeGameStatusContext } from './native-game-status-client'
import type { StatusCopyBackend, StatusCopyBackendContext, StatusCopyLocalContext } from './status-copy-backend'

export interface StatusCopyToolboxClient extends GameStatusSteamClient {
  myFriends?: Record<string, number>
  getPersonas?(ids: string[]): Promise<{ personas: Record<string, Record<string, unknown>> }>
}
export interface ToolboxStatusCopyOptions {
  getToolboxLogin(accountId: string): Promise<{ steamId: string; accountName: string; webLogonToken: string }>
  createClient?(options: Record<string, unknown>): StatusCopyToolboxClient
  readLocalContext?(): Promise<StatusCopyLocalContext>
  loginTimeoutMs?: number
  requestTimeoutMs?: number
  retireTimeoutMs?: number
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const control = /[\p{Cc}\u2028\u2029]/u
const error = (code: StatusCopyCode) => new DomainError(code, code)
const empty = (warning?: StatusCopyCode): StatusCopyReport => ({ source: null, targetAppId: null, appliedAt: null, verification: 'not-verified', waiting: true, warnings: warning ? [warning] : [] })
const publicParameters = new Set(['status', 'desc', 'map', 'mode', 'score', 'activity', 'details', 'state', 'currentmap', 'gamestatus', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score', 'matchgrouploc', 'level', 'chapter', 'difficulty', 'character', 'hero', 'team', 'health', 'players', 'maxplayers', 'kills', 'deaths', 'round', 'rounds', 'time', 'elapsed', 'remaining', 'scene', 'zone', 'music_track', 'displayname', 'display_name', 'description'])
export function isStatusCopyPublicField(key: string): boolean { return key === 'steam_display' || publicParameters.has(key.toLowerCase()) && isGameStatusPresenceParameter(key) }
function app(value: unknown): number | null {
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^[0-9]{1,8}$/.test(String(value))) return null
  const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : null
}
function publicRaw(value: unknown): Record<string, string> {
  if (!object(value) || Object.keys(value).length > richPresenceContract.presence.maxKeys) throw error('COPY_REQUEST_FAILED')
  const result: Record<string, string> = {}; const seen = new Set<string>()
  for (const [name, item] of Object.entries(value)) {
    const key = name.toLowerCase()
    if (!isStatusCopyPublicField(key)) continue
    if (seen.has(key)) throw error('COPY_REQUEST_FAILED')
    seen.add(key)
    if (typeof item !== 'string' || !isWellFormedPresenceText(item) || Buffer.byteLength(item) > richPresenceContract.presence.valueUtf8Bytes) throw error('COPY_REQUEST_FAILED')
    if (key === 'steam_display' || isGameStatusPresenceParameter(name)) result[key] = item
  }
  return result
}

export class ToolboxStatusCopyBackend implements StatusCopyBackend {
  private client: StatusCopyToolboxClient | null = null
  private context: StatusCopyBackendContext | null = null
  private listeners: Array<[string, (...args: any[]) => void]> = []
  private fatal: StatusCopyCode | null = null
  private closed = false
  private loggedOn = false
  private disconnected = false
  private stopFlight: Promise<void> | null = null
  private cancelLogin: (() => void) | null = null
  private ownedApps = new Set<number>()
  private payload: string | null = null
  private appliedAt: string | null = null
  private targetAppId: number | null = null
  private ownGroup = randomBytes(16).toString('hex')
  private sourceRevision = 0
  private peerApp: number | null = null
  private friendshipReady = false
  private playingKnown = false
  private playingReady: (() => void) | null = null
  private localAnchor: StatusCopyLocalContext | null = null
  private failureHandler: ((code: StatusCopyCode) => void) | null = null

  constructor(private readonly options: ToolboxStatusCopyOptions) {}
  setFailureHandler(listener: (code: StatusCopyCode) => void): void { this.failureHandler = listener }
  private failed(code: StatusCopyCode): void { this.fatal = code; if (!this.closed) this.failureHandler?.(code) }
  private assert(context: StatusCopyBackendContext): void {
    context.assertCurrent()
    if (this.closed || context.signal.aborted || this.context !== context) throw error('COPY_SESSION_CHANGED')
    if (this.fatal) throw error(this.fatal)
    if (this.client && this.loggedOn && this.client.steamID?.getSteamID64() !== context.target.steamId) throw error('COPY_IDENTITY_MISMATCH')
    if (this.client?.playingState?.blocked) throw error('COPY_PLAYING_BLOCKED')
  }
  private async check(context: StatusCopyBackendContext, expectedSourceApp?: number): Promise<StatusCopyLocalContext> {
    this.assert(context)
    const local = await context.checkLocal()
    this.assert(context)
    if (local.steamId === context.target.steamId) throw error('COPY_TARGET_IS_LOCAL')
    this.localAnchor ??= { ...local }
    if (expectedSourceApp !== undefined && local.steamId === context.sourceSteamId && local.appId !== expectedSourceApp) throw error('COPY_SOURCE_STALE')
    return local
  }
  private async bounded<T>(context: StatusCopyBackendContext, operation: () => Promise<T>, expectedSourceApp?: number): Promise<T> {
    await this.check(context, expectedSourceApp)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => reject(error('COPY_SESSION_CHANGED'))
        context.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(error('COPY_REQUEST_FAILED')), this.options.requestTimeoutMs ?? 15000); timer.unref?.()
      })
      const result = await Promise.race([Promise.resolve().then(() => { this.assert(context); return operation() }), deadline])
      await this.check(context, expectedSourceApp)
      return result
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort) }
  }
  private listen(event: string, listener: (...args: any[]) => void): void { this.client!.on(event, listener); this.listeners.push([event, listener]) }
  private async open(context: StatusCopyBackendContext): Promise<void> {
    if (this.client) { this.assert(context); return }
    if (this.closed || this.context && this.context !== context) throw error('COPY_SESSION_CHANGED')
    this.context = context
    const login = await this.bounded(context, () => this.options.getToolboxLogin(context.target.accountId))
    if (!login || login.steamId !== context.target.steamId) throw error('COPY_IDENTITY_MISMATCH')
    if (typeof login.accountName !== 'string' || !login.accountName.trim() || control.test(login.accountName) || login.accountName.length > 128 || typeof login.webLogonToken !== 'string' || !login.webLogonToken || control.test(login.webLogonToken) || login.webLogonToken.length > 16384) throw error('COPY_LOGIN_REQUIRED')
    await this.check(context)
    const client = (this.options.createClient ?? createGameStatusSteamClient)({ ...GAME_STATUS_CLIENT_OPTIONS }) as StatusCopyToolboxClient
    this.client = client
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (failure?: StatusCopyCode) => { if (settled) return; settled = true; clearTimeout(timer); this.cancelLogin = null; failure ? reject(error(failure)) : resolve() }
      const timer = setTimeout(() => finish('COPY_LOGIN_REQUIRED'), this.options.loginTimeoutMs ?? 20000); timer.unref?.()
      this.cancelLogin = () => finish('COPY_SESSION_CHANGED')
      this.listen('loggedOn', () => {
        if (this.closed || context.signal.aborted) { finish('COPY_SESSION_CHANGED'); return }
        this.loggedOn = true
        if (client.steamID?.getSteamID64() !== context.target.steamId) { finish('COPY_IDENTITY_MISMATCH'); this.failed('COPY_IDENTITY_MISMATCH'); return }
        finish()
      })
      this.listen('friendsList', () => { this.friendshipReady = true })
      this.listen('playingState', (blocked: boolean) => { this.playingKnown = true; this.playingReady?.(); this.playingReady = null; if (blocked) this.failed('COPY_PLAYING_BLOCKED') })
      this.listen('user', (id: { getSteamID64?(): string } | string, data: Record<string, unknown>) => {
        let steamId: string | undefined
        try { steamId = typeof id === 'string' ? id : id?.getSteamID64?.() } catch { return }
        if (steamId === context.sourceSteamId) {
          const next = app(data?.gameid ?? data?.game_played_app_id)
          if (next !== null && next !== this.peerApp) { this.peerApp = next; this.sourceRevision++ }
        }
      })
      this.listen('error', () => { finish('COPY_REQUEST_FAILED'); this.failed('COPY_REQUEST_FAILED') })
      this.listen('steamGuard', () => { finish('COPY_LOGIN_REQUIRED'); this.failed('COPY_LOGIN_REQUIRED') })
      this.listen('disconnected', () => { this.disconnected = true; if (!this.closed) { finish('COPY_SESSION_CHANGED'); this.failed('COPY_SESSION_CHANGED') } })
      context.signal.addEventListener('abort', () => finish('COPY_SESSION_CHANGED'), { once: true })
      try {
        this.assert(context)
        const started = client.logOn({ steamID: login.steamId, accountName: login.accountName.trim(), webLogonToken: login.webLogonToken })
        started?.catch(() => finish('COPY_LOGIN_REQUIRED'))
      } catch { finish(this.fatal ?? (client.playingState?.blocked ? 'COPY_PLAYING_BLOCKED' : 'COPY_LOGIN_REQUIRED')) }
    })
    await ready
    await this.check(context)
  }
  private async friendApp(context: StatusCopyBackendContext): Promise<number | null> {
    if (!this.client!.getPersonas) return null
    const response = await this.bounded(context, () => this.client!.getPersonas!([context.sourceSteamId]))
    const persona = response?.personas?.[context.sourceSteamId]
    if (!object(persona) || !Object.hasOwn(persona, 'gameid') && !Object.hasOwn(persona, 'game_played_app_id')) return null
    const next = app(persona.gameid ?? persona.game_played_app_id)
    if (next !== this.peerApp) { this.peerApp = next; this.sourceRevision++ }
    return next
  }
  private async source(context: StatusCopyBackendContext): Promise<{ source: StatusCopySource; revision: number; warnings: StatusCopyCode[] } | StatusCopyReport> {
    const local = await this.check(context)
    const relation = this.client!.myFriends?.[context.sourceSteamId]
    if (relation !== 3) {
      if (relation === undefined && !this.friendshipReady) return empty('COPY_SOURCE_UNAVAILABLE')
      throw error('COPY_SOURCE_NOT_FRIEND')
    }
    const nativeSource = local.steamId === context.sourceSteamId
    const appId = nativeSource ? local.appId : await this.friendApp(context)
    if (appId === null) return empty('COPY_SOURCE_STALE')
    if (!appId) return empty('COPY_SOURCE_NOT_PLAYING')
    const revision = this.sourceRevision
    const response = await this.bounded(context, () => this.client!.requestRichPresence(appId, [context.sourceSteamId], 'english'), appId)
    const values = response?.users?.[context.sourceSteamId]?.richPresence
    if (!object(values)) return empty('COPY_SOURCE_UNAVAILABLE')
    const raw = publicRaw(values)
    const groupSize = readGroupSize(values[GROUP_SIZE_KEY])
    const info = await this.bounded(context, () => readGameStatusAppInfo(this.client!, appId, 'english', () => this.assert(context)), appId)
    if (!nativeSource && (await this.friendApp(context)) !== appId || revision !== this.sourceRevision) return empty('COPY_SOURCE_STALE')
    let fields: Record<string, string> = {}; const warnings: StatusCopyCode[] = []
    if (raw.steam_display && richPresenceDisplayToken.test(raw.steam_display) && info.templateStatus === 'available') {
      try {
        const template = info.templates.find(entry => entry.token.toLowerCase() === raw.steam_display!.toLowerCase())
        if (!template) throw error('COPY_TEMPLATE_UNAVAILABLE')
        const required = new Set(template.parameters.map(key => key.toLowerCase()))
        const values = Object.fromEntries(Object.entries(raw).filter(([key]) => required.has(key)))
        const active = new Set(gameStatusPresenceParameterHints(info, { displayToken: raw.steam_display, values }).map(hint => hint.key))
        if ([...active].some(key => !isStatusCopyPublicField(key))) throw error('COPY_TEMPLATE_UNAVAILABLE')
        fields = validateGameStatusPresence(info, { displayToken: raw.steam_display, values: Object.fromEntries(Object.entries(values).filter(([key]) => active.has(key))) }).fields
      }
      catch { warnings.push('COPY_TEMPLATE_UNAVAILABLE') }
    } else warnings.push('COPY_TEMPLATE_UNAVAILABLE')
    return { source: { steamId: context.sourceSteamId, appId, gameName: info.name, fields, groupSize, observedAt: new Date().toISOString(), authority: nativeSource ? 'local-source-session' : 'friend-presence' }, revision: this.sourceRevision, warnings }
  }
  private async write(context: StatusCopyBackendContext, source: StatusCopySource, revision: number, operation: () => void): Promise<void> {
    await this.check(context, source.appId)
    if (revision !== this.sourceRevision || this.client!.myFriends?.[context.sourceSteamId] !== 3) throw error('COPY_SOURCE_STALE')
    this.assert(context)
    try { operation() } catch { throw error('COPY_REQUEST_FAILED') }
    this.assert(context)
    await this.check(context, source.appId)
  }
  private async follow(context: StatusCopyBackendContext, settings: StatusCopySettingsInput, publish: boolean): Promise<StatusCopyReport> {
    await this.open(context)
    const sampled = await this.source(context)
    if ('waiting' in sampled) {
      if (publish && this.ownedApps.size) await this.clearOwned(context)
      return { ...sampled, targetAppId: this.targetAppId, appliedAt: this.appliedAt }
    }
    const { source, revision, warnings } = sampled
    const report: StatusCopyReport = { source, targetAppId: this.targetAppId, appliedAt: this.appliedAt, verification: 'not-verified', waiting: false, warnings }
    if (!publish) return report
    if (!this.playingKnown) await this.bounded(context, () => this.playingKnown ? Promise.resolve() : new Promise<void>(resolve => { this.playingReady = resolve }), source.appId)
    const fields = { ...source.fields }
    if (settings.copyGroupSize && source.groupSize !== null) { fields.steam_player_group = this.ownGroup; fields[GROUP_SIZE_KEY] = String(source.groupSize) }
    if (Object.keys(fields).length > richPresenceContract.presence.maxKeys) throw error('COPY_REQUEST_FAILED')
    const payload = JSON.stringify([source.appId, settings.persona, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))])
    if (payload === this.payload) return report
    this.payload = null
    if (this.targetAppId !== null && this.targetAppId !== source.appId) {
      const previous = this.targetAppId
      await this.write(context, source, revision, () => this.client!.uploadRichPresence(previous, {}))
      this.ownedApps.delete(previous)
    }
    await this.write(context, source, revision, () => this.client!.setPersona(settings.persona === 'online' ? 1 : 3))
    this.ownedApps.add(source.appId)
    await this.write(context, source, revision, () => this.client!.gamesPlayed([source.appId], false))
    await this.write(context, source, revision, () => this.client!.uploadRichPresence(source.appId, fields))
    this.targetAppId = source.appId; this.appliedAt = new Date().toISOString()
    const returned = await this.bounded(context, () => this.client!.requestRichPresence(source.appId, [context.target.steamId], 'english'), source.appId)
    if (revision !== this.sourceRevision) throw error('COPY_SOURCE_STALE')
    const target = returned?.users?.[context.target.steamId]?.richPresence
    const matched = Object.keys(fields).length > 0 && object(target) && Object.entries(fields).every(([key, value]) => target[key] === value)
    this.payload = payload
    return { ...report, targetAppId: this.targetAppId, appliedAt: this.appliedAt, verification: matched ? 'target-readback' : 'not-verified' }
  }
  private async clearOwned(context: StatusCopyBackendContext): Promise<void> {
    this.payload = null
    for (const own of this.ownedApps) { await this.check(context); this.client!.uploadRichPresence(own, {}); await this.check(context) }
    await this.check(context); this.client!.gamesPlayed([], false); await this.check(context)
    this.ownedApps.clear(); this.targetAppId = null; this.appliedAt = null
  }
  private async run(context: StatusCopyBackendContext, settings: StatusCopySettingsInput, publish: boolean): Promise<StatusCopyReport> {
    try { return await this.follow(context, settings, publish) }
    catch (caught) {
      const known: StatusCopyCode[] = ['COPY_SESSION_CHANGED', 'COPY_TARGET_IS_LOCAL', 'COPY_LOCAL_UNAVAILABLE', 'COPY_IDENTITY_MISMATCH', 'COPY_LOGIN_REQUIRED', 'COPY_PLAYING_BLOCKED', 'COPY_SOURCE_NOT_FRIEND', 'COPY_SOURCE_STALE', 'COPY_REQUEST_FAILED']
      throw error(caught instanceof DomainError && known.includes(caught.code as StatusCopyCode) ? caught.code as StatusCopyCode : 'COPY_REQUEST_FAILED')
    }
  }
  preview(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport> { return this.run(context, settings, false) }
  start(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport> { return this.run(context, settings, true) }
  tick(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport> { return this.run(context, settings, true) }
  stop(): Promise<void> {
    if (this.stopFlight) {
      if (this.disconnected) { this.detach(); return Promise.resolve() }
      return this.stopFlight
    }
    this.closed = true; this.cancelLogin?.(); this.cancelLogin = null
    const client = this.client; const context = this.context
    if (!client) return Promise.resolve()
    this.stopFlight = (async () => {
      // An abort invalidates writes, not the obligation to retire this owned connection.
      const cleanupCurrent = () => {
        try { return !!context && this.client === client && this.loggedOn && !this.disconnected && !this.fatal && !client.playingState?.blocked && client.steamID?.getSteamID64() === context.target.steamId }
        catch { return false }
      }
      const canClear = async () => {
        if (!context || !cleanupCurrent()) return false
        try {
          const local = await (this.options.readLocalContext ?? detectNativeGameStatusContext)()
          const anchor = this.localAnchor
          return cleanupCurrent() && local.steamId !== context.target.steamId && !!anchor && local.steamId === anchor.steamId && local.steamPid === anchor.steamPid && local.steamStartTicks === anchor.steamStartTicks
        }
        catch { return false }
      }
      try {
        for (const own of this.ownedApps) { if (!await canClear() || !cleanupCurrent()) break; client.uploadRichPresence(own, {}) }
        if (this.ownedApps.size && await canClear() && cleanupCurrent()) client.gamesPlayed([], false)
      } catch { /* Closing the owned CM is still mandatory after cleanup fails. */ }
      await new Promise<void>((resolve, reject) => {
        const authenticated = this.loggedOn && !this.disconnected
        let settled = false
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); client.removeListener('disconnected', finish); resolve() }
        const timer = setTimeout(() => { if (settled) return; settled = true; client.removeListener('disconnected', finish); reject(error('COPY_STOP_UNCONFIRMED')) }, this.options.retireTimeoutMs ?? 5500); timer.unref?.()
        client.on('disconnected', finish)
        try { client.logOff(); if (!authenticated) finish() } catch { clearTimeout(timer); client.removeListener('disconnected', finish); reject(error('COPY_STOP_UNCONFIRMED')) }
      })
      this.detach()
    })()
    return this.stopFlight
  }
  private detach(): void {
    const client = this.client
    if (client) {
      for (const [event, listener] of this.listeners) client.removeListener(event, listener)
      client.on('error', () => {})
    }
    this.listeners = []; this.client = null; this.ownedApps.clear(); this.payload = null; this.playingReady = null; this.failureHandler = null
  }
}
