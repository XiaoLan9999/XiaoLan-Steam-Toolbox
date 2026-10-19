import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GameStatusAction, GameStatusAppInfo, GameStatusAppInput, GameStatusConnectInput, GameStatusDraft, GameStatusGuardInput, GameStatusLiveDisplayInput, GameStatusOperation, GameStatusPatchInput, GameStatusPlayInput, GameStatusSaveDraftInput, GameStatusSnapshot, GameStatusUnlockInput } from '../shared/game-status'
import { isGameStatusPresenceParameter, sanitizeGameStatusPresence, validateGameStatusPresence } from '../shared/game-status-presence'
import { readGameStatusAppInfo } from './game-status-apps'

type Listener = (...args: any[]) => void
export interface GameStatusSteamClient {
  on(event: string, listener: Listener): this
  removeListener(event: string, listener: Listener): this
  steamID: { getSteamID64(): string } | null
  playingState?: { blocked: boolean; appid: number }
  logOn(details: Record<string, unknown>): void | Promise<void>
  logOff(): void
  setPersona(state: number): void
  gamesPlayed(games: string | number[], force?: boolean): void
  uploadRichPresence(appId: number, values: Record<string, string>): void
  requestRichPresence(appId: number, steamIds: string[], language?: 'schinese' | 'english'): Promise<{ users: Record<string, { richPresence: Record<string, string>; localizedString?: string | null }> }>
  getProductInfo?(apps: number[], packages: number[], includeTokens?: boolean): Promise<unknown>
  getAppRichPresenceLocalization?(appId: number, language: string): Promise<unknown>
}
export interface GameStatusServiceOptions {
  getActiveAccount(): { id: string; steamId: string } | null
  onChange?(state: GameStatusSnapshot): void
  createClient?(options: Record<string, unknown>): GameStatusSteamClient
  getToolboxLogin?(accountId: string): Promise<{ steamId: string; accountName: string; webLogonToken: string }>
  draftPath?: string
}

export const GAME_STATUS_CLIENT_OPTIONS = Object.freeze({ dataDirectory: null, autoRelogin: false, saveAppTickets: false, enablePicsCache: false, changelistUpdateInterval: 0, renewRefreshTokens: false })
export const LIVE_OBSERVATION_TTL_MS = 120000
export const LIVE_RESTORE_TTL_MS = 600000
export const LIVE_LOCK_INTERVAL_MS = 5000
export const LIVE_LOCK_MAX_FAILURES = 5
export const GAME_STATUS_APP_INFO_TTL_MS = 3600000
const control = /[\p{Cc}\u2028\u2029]/u
const id = () => randomBytes(24).toString('hex')
const noop = () => {}
const publicKeys = new Set(['status', 'steam_display', 'version', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score', 'game:server', 'state', 'currentmap', 'map', 'mode', 'score', 'activity', 'details'])
const readOnly = new Set(['steam_display', 'version'])
const appNote = '仅提交游戏；该游戏的二级状态需要选择有效显示模板。'
const presenceNote = '已提交游戏公开的显示模板；预览不是好友端显示确认。'
const customNote = '名称与子信息合并为一行，作为非 Steam 游戏提交。'
const toolboxLoginMessage = '工具箱登录状态无法用于游戏会话，请回到工具箱账号页面重新登录后重试。'

function text(value: unknown, maximum: number, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || control.test(value) || Buffer.byteLength(value.trim()) > maximum || (required && !value.trim())) throw new Error('请输入符合长度限制、没有控制字符的单行文字。')
  return value.trim()
}
function draft(value: GameStatusDraft): GameStatusDraft {
  if (!value || !['custom', 'app'].includes(value.displayKind)) throw new Error('游戏状态模式不正确。')
  const gameName = text(value.gameName, 128, value.displayKind === 'custom')
  const details = text(value.details, 128)
  if (value.displayKind === 'custom') {
    if (Buffer.byteLength(details ? `${gameName} · ${details}` : gameName) > 255) throw new Error('合并后的名称超过 255 字节。')
    return { displayKind: 'custom', gameName, details }
  }
  if (!Number.isInteger(value.appId) || !value.appId || value.appId < 1 || value.appId > 0xffffff) throw new Error('请输入有效的 Steam 应用编号。')
  return { displayKind: 'app', gameName, details, appId: value.appId, ...(value.presence ? { presence: sanitizeGameStatusPresence(value.presence) } : {}) }
}

export function createGameStatusSteamClient(options: Record<string, unknown> = GAME_STATUS_CLIENT_OPTIONS): GameStatusSteamClient {
  const require = createRequire(import.meta.url)
  const SteamUser = require('steam-user') as { new(options: Record<string, unknown>): GameStatusSteamClient }
  // 5.3.0 internally re-enters public logOn(true), even after a late auth timeout.
  // Retire at that public boundary; never patch private SDK authentication fields.
  class PresenceClient extends SteamUser {
    #retired = false
    #starts = new Set<NodeJS.Immediate>()
    logOn(details: Record<string, unknown> | true): void {
      if (this.#retired) return
      const pending = setImmediate(() => {
        this.#starts.delete(pending)
        if (this.#retired) return
        try {
          const result = super.logOn(details as Record<string, unknown>)
          if (result?.catch) result.catch(error => { if (!this.#retired) this.emitError(error) })
        } catch (error) { if (!this.#retired) this.emitError(error) }
      })
      this.#starts.add(pending)
    }
    private emitError(error: unknown): void { (this as unknown as { emit(event: string, error: unknown): void }).emit('error', error) }
    logOff(): void { this.#retired = true; for (const pending of this.#starts) clearImmediate(pending); this.#starts.clear(); super.logOff() }
    webLogOn(): void {} // Disable the SDK's automatic web-cookie request through its public method.
  }
  return new PresenceClient(options)
}

interface LiveContext { client: GameStatusSteamClient; generation: number; appId: number; epoch: number; accountId: string; steamId: string }
interface Observation { context: LiveContext; raw: Record<string, string>; snapshotId: string; observedAt: number }
interface Patch { context: LiveContext; original: Record<string, string | undefined>; written: Record<string, string>; writtenAt: number }
interface PresenceRead { raw: Record<string, string>; localizedString: string | null }
interface LiveLockController { context: LiveContext; version: number; desired: Record<string, string>; original: Record<string, string | undefined>; timer: ReturnType<typeof setTimeout> | null }

export class GameStatusService {
  private value: GameStatusSnapshot = this.empty()
  private bound: { id: string; steamId: string } | null = null
  private client: GameStatusSteamClient | null = null
  private listeners: Array<[string, Listener]> = []
  private generation = 0
  private epoch = 0
  private seenPlayingState = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private challenge: { id: string; callback(code: string): void; retryAt: number } | null = null
  private ownedApps = new Set<number>()
  private ownsSimulation = false
  private pendingSimulationClear = false
  private observation: Observation | null = null
  private patch: Patch | null = null
  private busyToken: object | null = null
  private busyDone: Promise<void> | null = null
  private lockVersion = 0
  private liveLock: LiveLockController | null = null
  private appInfoCache = new Map<string, { info: GameStatusAppInfo; at: number }>()
  private appInfoPending = new Map<string, Promise<GameStatusAppInfo>>()
  private disposed = false
  private drafts: Record<string, GameStatusDraft> = {}
  private draftQueue: Promise<void> = Promise.resolve()
  private preparation: { token: object; cancel(): void } | null = null

  constructor(private readonly options: GameStatusServiceOptions) {}
  private empty(): GameStatusSnapshot { return { sessionId: id(), accountId: null, boundSteamId: null, status: 'logged_out', connected: false, accountName: null, steamId: null, guard: null, blocked: false, blockingAppId: null, playing: null, live: null, liveLock: null, appInfo: null, lastOperation: null, busy: false, limitations: [], error: null } }
  getSnapshot(): GameStatusSnapshot {
    const value = structuredClone(this.value)
    if (value.guard) value.guard.retryAfterSeconds = Math.max(0, Math.ceil(((this.challenge?.retryAt ?? 0) - Date.now()) / 1000))
    return value
  }
  snapshot(): GameStatusSnapshot { return this.getSnapshot() }
  state(): GameStatusSnapshot { return this.getSnapshot() }
  private emit(): void { try { this.options.onChange?.(this.getSnapshot()) } catch { /* UI cannot interrupt cleanup. */ } }
  private selected(input: GameStatusAction): { id: string; steamId: string } {
    if (this.disposed) throw new Error('游戏状态服务已关闭。')
    const selected = this.options.getActiveAccount()
    if (!selected || !input || input.accountId !== selected.id || input.sessionId !== this.value.sessionId) throw new Error('当前工具箱账号或游戏状态会话已经变化，请刷新。')
    if (this.bound && (this.bound.id !== selected.id || this.bound.steamId !== selected.steamId)) throw new Error('当前工具箱账号已经变化，请重新登录游戏状态会话。')
    return selected
  }
  private current(client: GameStatusSteamClient, generation: number): boolean {
    const selected = this.options.getActiveAccount()
    return !this.disposed && this.client === client && this.generation === generation && !!selected && selected.id === this.bound?.id && selected.steamId === this.bound.steamId
  }
  private logged(input: GameStatusAction): void { this.selected(input); if (!this.client || !this.value.connected) throw new Error('请先单独登录当前账号的游戏状态会话。') }
  private bind(client: GameStatusSteamClient, event: string, listener: Listener): void { client.on(event, listener); this.listeners.push([event, listener]) }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private timeout(client: GameStatusSteamClient, generation: number, ms: number, message = 'Steam 登录等待超时，请重试。'): void {
    this.clearTimer()
    this.timer = setTimeout(() => { if (this.current(client, generation)) this.fail(message) }, ms)
    this.timer.unref?.()
  }
  private stopLiveLock(): void {
    this.lockVersion++
    if (this.liveLock?.timer) clearTimeout(this.liveLock.timer)
    this.liveLock = null
    if (this.value.liveLock) Object.assign(this.value.liveLock, { status: 'stopped', nextCheckAt: null })
  }
  private clearLive(): void { this.stopLiveLock(); this.epoch++; this.observation = null; this.patch = null; this.value.live = null; this.value.liveLock = null; this.value.lastOperation = null }
  private clearSimulation(): void {
    const needed = this.ownsSimulation || this.ownedApps.size > 0 || this.pendingSimulationClear
    this.value.playing = null; this.value.limitations = []
    if (!this.client || !this.value.connected || this.value.blocked || !needed) { if (needed) this.pendingSimulationClear = true; return }
    const client = this.client; const generation = this.generation
    this.pendingSimulationClear = false; this.ownsSimulation = false
    for (const app of [...this.ownedApps]) {
      if (!this.current(client, generation) || this.value.blocked) return
      client.uploadRichPresence(app, {}); this.ownedApps.delete(app)
    }
    if (this.current(client, generation) && !this.value.blocked) client.gamesPlayed([], false)
  }
  private retire(clear: boolean): void {
    const client = this.client
    const preparation = this.preparation; this.preparation = null; preparation?.cancel()
    this.clearTimer(); this.challenge = null
    if (clear) { try { this.clearSimulation() } catch { /* Logoff still releases this CM session. */ } }
    this.generation++; this.client = null; this.busyToken = null; this.busyDone = null
    this.appInfoCache.clear(); this.appInfoPending.clear()
    this.ownedApps.clear(); this.ownsSimulation = this.pendingSimulationClear = false; this.seenPlayingState = false
    this.clearLive()
    if (client) {
      for (const [event, listener] of this.listeners) client.removeListener(event, listener)
      client.on('error', noop); client.on('steamGuard', noop)
      client.on('loggedOn', () => { try { client.logOff() } catch { /* Retired login. */ } })
      try { client.logOff() } catch { /* Already disconnected. */ }
    }
    this.listeners = []
  }
  private fail(message: string): void {
    this.retire(false)
    Object.assign(this.value, { status: 'error', connected: false, steamId: null, guard: null, blocked: false, blockingAppId: null, playing: null, live: null, busy: false, error: message })
    this.emit()
  }

  connect(input: GameStatusConnectInput): GameStatusSnapshot {
    const selected = this.selected(input)
    if (!/^\d{17}$/.test(selected.steamId)) throw new Error('当前工具箱账号的 SteamID 不正确。')
    const accountName = text(input.accountName, 128, true)
    if (typeof input.password !== 'string' || !input.password || control.test(input.password) || Buffer.byteLength(input.password) > 1024) throw new Error('请填写有效的 Steam 密码。')
    this.retire(true); this.bound = { ...selected }
    this.value = { ...this.empty(), accountId: selected.id, boundSteamId: selected.steamId, status: 'connecting', accountName }
    return this.startClient({ accountName, password: input.password, logonID: randomBytes(4).readUInt32LE() || 1, machineName: 'XiaoLan Steam Toolbox' }, false)
  }

  async connectWithToolbox(input: GameStatusAction): Promise<GameStatusSnapshot> {
    const selected = this.selected(input)
    if (!/^\d{17}$/.test(selected.steamId)) throw new Error('当前工具箱账号的 SteamID 不正确。')
    this.retire(true); this.bound = { ...selected }
    this.value = { ...this.empty(), accountId: selected.id, boundSteamId: selected.steamId, status: 'connecting', busy: true }
    const token = {}; const generation = this.generation; const sessionId = this.value.sessionId
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error('游戏状态登录请求已经变化。')) })
    const preparation = { token, cancel }; this.preparation = preparation
    const sameOperation = () => !this.disposed && this.preparation === preparation && this.generation === generation && this.value.sessionId === sessionId
    const assertPreparation = () => {
      if (!sameOperation()) throw new Error('当前账号或游戏状态登录请求已经变化，已丢弃旧结果。')
      const active = this.options.getActiveAccount()
      if (!active || active.id !== selected.id || active.steamId !== selected.steamId || this.bound?.id !== selected.id || this.bound.steamId !== selected.steamId) {
        this.invalidate()
        throw new Error('当前工具箱账号已经变化，已丢弃旧登录结果。')
      }
    }
    const acquired = Promise.resolve().then(() => {
      assertPreparation()
      if (!this.options.getToolboxLogin) throw new Error('Toolbox login unavailable')
      return this.options.getToolboxLogin(selected.id)
    })
    const awaiting = Promise.race([acquired, cancelled])
    this.timer = setTimeout(cancel, 120000); this.timer.unref?.()
    this.emit()
    try {
      const login = await awaiting
      assertPreparation()
      if (!login || login.steamId !== selected.steamId || typeof login.webLogonToken !== 'string' || !login.webLogonToken.trim() || control.test(login.webLogonToken) || Buffer.byteLength(login.webLogonToken) > 16384) throw new Error('Invalid toolbox login')
      const accountName = text(login.accountName, 128, true)
      // Official 5.3.0 nonce login accepts only these three fields. In particular,
      // logonID/machineName/clientOS/password must not be sent on this path.
      this.preparation = null; this.clearTimer(); this.value.busy = false; this.value.accountName = accountName
      return this.startClient({ accountName, steamID: login.steamId, webLogonToken: login.webLogonToken }, true)
    } catch {
      assertPreparation()
      this.fail(toolboxLoginMessage)
      return this.snapshot()
    }
  }

  private startClient(logonDetails: Record<string, unknown>, toolboxLogin: boolean): GameStatusSnapshot {
    let client: GameStatusSteamClient
    try { client = (this.options.createClient ?? createGameStatusSteamClient)({ ...GAME_STATUS_CLIENT_OPTIONS }) } catch { this.fail(toolboxLogin ? toolboxLoginMessage : '无法初始化 Steam 会话。'); return this.snapshot() }
    this.client = client
    const generation = this.generation
    this.bind(client, 'steamGuard', (domain: unknown, callback: (code: string) => void, wrong: boolean) => {
      if (!this.current(client, generation)) return
      if (toolboxLogin) { this.fail(toolboxLoginMessage); return }
      const challengeId = id(); this.challenge = { id: challengeId, callback, retryAt: Date.now() + (wrong ? 30000 : 0) }
      this.value.status = 'guard_required'; this.value.guard = { challengeId, type: domain ? 'email' : 'authenticator', emailDomain: typeof domain === 'string' && /^[\w.-]{1,128}$/.test(domain) ? domain : null, lastCodeWrong: !!wrong, retryAfterSeconds: wrong ? 30 : 0 }
      this.timeout(client, generation, 300000); this.emit()
    })
    this.bind(client, 'loggedOn', () => {
      if (!this.current(client, generation)) return
      let steamId: string | null = null
      try { steamId = client.steamID?.getSteamID64() ?? null } catch { /* Reject unknown identity. */ }
      if (steamId !== this.bound?.steamId) { this.fail(toolboxLogin ? '工具箱登录身份与当前账号不一致，请回到工具箱账号页面重新登录。' : '登录的 Steam 账号与当前工具箱账号不一致，已退出本机会话。'); return }
      this.clearTimer(); this.challenge = null
      this.value.status = 'logged_on'; this.value.connected = true; this.value.steamId = steamId; this.value.guard = null
      if (!this.seenPlayingState) { this.value.blocked = !!client.playingState?.blocked; this.value.blockingAppId = this.value.blocked ? client.playingState?.appid || null : null }
      // Login and real-game inspection never force a persona change.
      this.emit()
    })
    this.bind(client, 'playingState', (blocked: boolean, app: number) => {
      if (!this.current(client, generation)) return
      const appId = blocked && Number.isInteger(app) && app > 0 && app <= 0xffffff ? app : null
      if (this.value.blocked !== !!blocked || this.value.blockingAppId !== appId) this.clearLive()
      this.seenPlayingState = true; this.value.blocked = !!blocked; this.value.blockingAppId = appId
      if (blocked) { if (this.ownsSimulation || this.ownedApps.size) this.pendingSimulationClear = true; this.value.playing = null }
      else if (this.pendingSimulationClear) { try { this.clearSimulation() } catch { this.value.error = '旧模拟状态清理失败，请重试停止。' } }
      this.emit()
    })
    this.bind(client, 'error', () => { if (this.current(client, generation)) this.fail(toolboxLogin ? toolboxLoginMessage : 'Steam 登录或连接失败，请检查账号、安全验证和网络。') })
    this.bind(client, 'disconnected', () => { if (this.current(client, generation)) { this.fail(toolboxLogin ? toolboxLoginMessage : 'Steam 连接已经断开。'); this.value.status = 'disconnected'; this.emit() } })
    this.timeout(client, generation, 120000, toolboxLogin ? toolboxLoginMessage : undefined); this.emit()
    if (!this.current(client, generation)) return this.snapshot()
    try { const pending = client.logOn(logonDetails); pending?.catch(() => { if (this.current(client, generation)) this.fail(toolboxLogin ? toolboxLoginMessage : '无法启动 Steam 登录。') }) } catch { if (this.current(client, generation)) this.fail(toolboxLogin ? toolboxLoginMessage : '无法启动 Steam 登录。') }
    return this.snapshot()
  }

  respondGuard(input: GameStatusGuardInput): GameStatusSnapshot {
    this.selected(input)
    const challenge = this.challenge
    if (!challenge || challenge.id !== input.challengeId || this.value.status !== 'guard_required') throw new Error('安全验证请求已经过期。')
    if (Date.now() < challenge.retryAt) throw new Error('请等待新的安全验证码后重试。')
    if (typeof input.code !== 'string' || control.test(input.code) || !/^[A-Za-z0-9]{5,8}$/.test(input.code.trim())) throw new Error('安全验证码格式不正确。')
    this.challenge = null; this.value.guard = null; this.value.status = 'connecting'
    this.timeout(this.client!, this.generation, 120000)
    try { challenge.callback(input.code.trim().toUpperCase()) } catch { this.fail('提交安全验证码失败。') }
    this.emit(); return this.snapshot()
  }
  private cachedAppInfo(appId: number): GameStatusAppInfo | null {
    let latest: { info: GameStatusAppInfo; at: number } | null = null
    let available: { info: GameStatusAppInfo; at: number } | null = null
    const now = Date.now()
    for (const entry of this.appInfoCache.values()) {
      if (entry.info.appId !== appId || now - entry.at >= GAME_STATUS_APP_INFO_TTL_MS) continue
      if (!latest || entry.at >= latest.at) latest = entry
      if (entry.info.templates.length && (!available || entry.at >= available.at)) available = entry
    }
    return (available ?? latest)?.info ?? null
  }
  private async appInfo(appId: number, language: 'schinese' | 'english', assertCurrent: () => void, force = false): Promise<GameStatusAppInfo> {
    assertCurrent()
    const key = `${appId}:${language}`
    const cached = this.appInfoCache.get(key)
    if (cached && !force && Date.now() - cached.at < GAME_STATUS_APP_INFO_TTL_MS) { assertCurrent(); return structuredClone(cached.info) }
    if (cached && Date.now() - cached.at >= GAME_STATUS_APP_INFO_TTL_MS) this.appInfoCache.delete(key)
    let pending = this.appInfoPending.get(key)
    if (!pending) {
      if (this.appInfoPending.size >= 20) throw new Error('正在读取的游戏信息过多，请稍后重试。')
      const client = this.client!; const generation = this.generation
      const valid = () => { if (!this.current(client, generation) || !this.value.connected) throw new Error('游戏状态会话已经变化，已丢弃旧游戏信息。') }
      pending = readGameStatusAppInfo(client, appId, language, valid).then(info => {
        valid()
        this.appInfoCache.delete(key)
        this.appInfoCache.set(key, { info: structuredClone(info), at: Date.now() })
        while (this.appInfoCache.size > 20) this.appInfoCache.delete(this.appInfoCache.keys().next().value!)
        return info
      })
      this.appInfoPending.set(key, pending)
      void pending.finally(() => { if (this.appInfoPending.get(key) === pending) this.appInfoPending.delete(key) }).catch(noop)
    }
    const info = await pending
    assertCurrent()
    return structuredClone(info)
  }
  async inspectApp(input: GameStatusAppInput): Promise<GameStatusAppInfo> {
    this.logged(input)
    if (!Number.isInteger(input.appId) || input.appId < 1 || input.appId > 0xffffff || (input.language !== undefined && !['schinese', 'english'].includes(input.language))) throw new Error('请输入有效的 Steam 应用编号和语言。')
    const client = this.client!; const generation = this.generation
    const valid = () => { this.selected(input); if (!this.current(client, generation) || !this.value.connected) throw new Error('游戏状态会话已经变化，请重新读取。') }
    const info = await this.appInfo(input.appId, input.language ?? 'schinese', valid, true)
    valid(); this.value.appInfo = info; this.emit()
    return structuredClone(info)
  }
  play(input: GameStatusPlayInput): GameStatusSnapshot {
    this.logged(input); const value = draft(input)
    if (this.value.blocked) throw new Error('账号正在别处运行真实游戏；请使用真实游戏状态读取，不能模拟游戏。')
    if ('richPresence' in input || 'steam_display' in input) throw new Error('模拟模式不接受任意详细状态令牌。')
    const game = value.displayKind === 'app' ? this.cachedAppInfo(value.appId!) : null
    let fields: Record<string, string> | null = null
    let preview: string | null = null
    if (value.displayKind === 'app' && value.presence) {
      if (!game) throw new Error('请先读取该游戏的公开信息和显示模板。')
      const validated = validateGameStatusPresence(game, value.presence)
      fields = validated.fields; preview = validated.preview
    } else if (value.displayKind === 'app' && value.details) throw new Error('该子状态不能只提交 status；请先读取游戏信息并选择有效的显示模板。')
    const client = this.client!; const generation = this.generation
    try {
      this.clearSimulation()
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      client.setPersona(1)
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      this.ownsSimulation = true
      if (value.displayKind === 'app') this.ownedApps.add(value.appId!)
      const displayName = value.displayKind === 'custom' ? value.details ? `${value.gameName} · ${value.details}` : value.gameName : game?.name || value.gameName || `App ${value.appId}`
      client.gamesPlayed(value.displayKind === 'custom' ? displayName : [value.appId!], false)
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      if (value.displayKind === 'app' && fields) client.uploadRichPresence(value.appId!, fields)
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      this.value.playing = { ...value, displayName, delivery: 'submitted', limitations: [value.displayKind === 'custom' ? customNote : fields ? presenceNote : appNote], ...(game ? { game: { appId: game.appId, name: game.name, iconUrl: game.iconUrl } } : {}), ...(value.displayKind === 'app' ? { preview } : {}) }
      this.value.limitations = [...this.value.playing.limitations]; this.value.error = null
    } catch { throw new Error('提交模拟游戏状态失败。') }
    this.emit(); return this.snapshot()
  }
  stop(input: GameStatusAction): GameStatusSnapshot { this.selected(input); try { this.clearSimulation() } catch { throw new Error('清理模拟状态失败。') }; this.emit(); return this.snapshot() }
  logout(input: GameStatusAction): GameStatusSnapshot { this.selected(input); this.invalidate(); return this.snapshot() }
  invalidate(): void { this.retire(true); this.bound = null; this.value = this.empty(); this.emit() }
  dispose(): void { if (this.disposed) return; this.invalidate(); this.disposed = true }

  private context(input: GameStatusAction): LiveContext {
    this.logged(input)
    if (!this.value.blocked || !this.value.blockingAppId) throw new Error('只有账号在其他会话实际运行游戏时才能读取或修补真实状态。')
    return { client: this.client!, generation: this.generation, appId: this.value.blockingAppId, epoch: this.epoch, accountId: input.accountId, steamId: this.bound!.steamId }
  }
  private assertContext(context: LiveContext): void {
    if (!this.current(context.client, context.generation) || !this.value.connected || !this.value.blocked || this.value.blockingAppId !== context.appId || this.epoch !== context.epoch || this.bound?.steamId !== context.steamId) throw new Error('账号、真实游戏或登录会话已经变化，已丢弃旧操作。')
  }
  private async read(context: LiveContext): Promise<PresenceRead> {
    this.assertContext(context)
    let response: Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>>
    try { response = await context.client.requestRichPresence(context.appId, [context.steamId], this.cachedAppInfo(context.appId)?.language ?? 'english') } catch { throw new Error('读取 Steam 游戏详细状态失败。') }
    this.assertContext(context)
    const user = response?.users?.[context.steamId]
    const raw = user?.richPresence
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 65536 || Object.values(raw).some(value => typeof value !== 'string')) throw new Error('未取得当前账号有效的游戏详细状态。')
    const localized = user?.localizedString
    const privateValues = Object.entries(raw).filter(([key, value]) => key !== 'steam_display' && !isGameStatusPresenceParameter(key) && value).map(([, value]) => value)
    return { raw: { ...raw }, localizedString: typeof localized === 'string' && !control.test(localized) && Buffer.byteLength(localized) <= 2048 && !privateValues.some(value => localized.includes(value)) ? localized : null }
  }
  private publicFields(raw: Record<string, string>, appId: number): Record<string, string> {
    const published = new Set(this.cachedAppInfo(appId)?.templates.flatMap(template => template.parameters).filter(isGameStatusPresenceParameter) ?? [])
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => (publicKeys.has(key) || published.has(key.toLowerCase()) || !!this.patch && Object.hasOwn(this.patch.written, key)) && !control.test(value) && Buffer.byteLength(value) <= 255))
  }
  private localizedReadback(context: LiveContext, read: PresenceRead): string | null {
    // Return the SDK's text only when a safe published graph explains it exactly.
    const localized = read.localizedString
    const info = this.cachedAppInfo(context.appId)
    if (!localized || !info || typeof read.raw.steam_display !== 'string') return null
    const template = info.templates.find(value => value.token.toLowerCase() === read.raw.steam_display!.toLowerCase())
    if (!template) return null
    const parameters = new Set(template.parameters)
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.publicFields(read.raw, context.appId))) {
      const normalized = key.toLowerCase()
      if (!parameters.has(normalized)) continue
      if (Object.hasOwn(values, normalized)) return null
      values[normalized] = value
    }
    try {
      const rendered = validateGameStatusPresence(info, { displayToken: template.token, values })
      return rendered.preview === localized ? localized : null
    } catch { return null }
  }
  private showObservation(context: LiveContext, read: PresenceRead): void {
    const raw = read.raw
    const snapshotId = id(); this.observation = { context, raw, snapshotId, observedAt: Date.now() }
    const fields = this.publicFields(raw, context.appId)
    const game = this.cachedAppInfo(context.appId)
    this.value.live = { snapshotId, appId: context.appId, gameEpoch: context.epoch, observedAt: new Date().toISOString(), fields, editableKeys: Object.keys(fields).filter(key => !readOnly.has(key)), readOnlyKeys: Object.keys(fields).filter(key => readOnly.has(key)), patchActive: !!this.patch, localizedString: this.localizedReadback(context, read), ...(game ? { game: { appId: game.appId, name: game.name, iconUrl: game.iconUrl } } : {}) }
  }
  private outcome(kind: GameStatusOperation['kind'], outcome: GameStatusOperation['outcome'], message: string, changedKeys?: string[]): void { this.value.lastOperation = { kind, outcome, message, at: new Date().toISOString(), ...(changedKeys ? { changedKeys } : {}) }; this.value.error = null }
  private async once(input: GameStatusAction, operation: (context: LiveContext) => Promise<void>): Promise<GameStatusSnapshot> {
    const context = this.context(input)
    if (this.busyToken) throw new Error('上一个真实状态操作尚未结束。')
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const token = {}; this.busyToken = token; this.busyDone = done; this.value.busy = true; this.emit()
    try { await operation(context) } finally { finish(); if (this.busyToken === token) { this.busyToken = null; this.busyDone = null; this.value.busy = false; this.emit() } }
    return this.snapshot()
  }
  observeLive(input: GameStatusAction): Promise<GameStatusSnapshot> {
    return this.once(input, async context => {
      const cached = this.cachedAppInfo(context.appId)
      if (!cached || cached.templateStatus === 'unavailable') {
        try { await this.appInfo(context.appId, 'schinese', () => this.assertContext(context), true) } catch { this.assertContext(context) }
      }
      const read = await this.read(context); const raw = read.raw
      const expired = !!this.patch && Date.now() - this.patch.writtenAt >= LIVE_RESTORE_TTL_MS
      const superseded = !!this.patch && !this.writtenMatches(raw, this.patch.written)
      if (!this.liveLock && (expired || superseded)) this.patch = null // Explicit refresh retires only local history; it does not write to Steam.
      this.showObservation(context, read)
      this.outcome('observe', 'observed', expired ? '旧恢复记录已过期，已仅清除本地记录并重新建立读取基线，可重新编辑。' : superseded ? '游戏已覆盖旧修补，已丢弃旧的本地恢复记录，可重新编辑。' : '已读取本人当前游戏的公开字段；不会自动修改。')
    })
  }
  private upload(context: LiveContext, raw: Record<string, string>): void {
    this.assertContext(context)
    const entries = Object.entries(raw)
    if (entries.length > 20 || entries.some(([key, value]) => !key || control.test(key) || Buffer.byteLength(key) > 63 || control.test(value) || Buffer.byteLength(value) > 255)) throw new Error('完整游戏详细状态超过 Steam 协议限制；未删减游戏字段，也未提交。')
    try { context.client.uploadRichPresence(context.appId, raw) } catch { throw new Error('提交真实游戏详细状态失败。') }
    this.assertContext(context)
  }
  private writtenMatches(raw: Record<string, string>, expected: Record<string, string | undefined>): boolean { return Object.entries(expected).every(([key, value]) => raw[key] === value || (value === '' && raw[key] === undefined)) }
  patchLive(input: GameStatusPatchInput): Promise<GameStatusSnapshot> {
    return this.once(input, context => this.applyLiveChanges(context, input.snapshotId, input.changes, false, false, this.lockVersion))
  }
  lockLive(input: GameStatusPatchInput): Promise<GameStatusSnapshot> {
    const version = this.lockVersion
    return this.once(input, context => this.applyLiveChanges(context, input.snapshotId, input.changes, false, true, version))
  }
  setLiveDisplay(input: GameStatusLiveDisplayInput): Promise<GameStatusSnapshot> {
    const version = this.lockVersion
    return this.once(input, async context => {
      if (typeof input.lock !== 'boolean') throw new Error('请选择是否锁定显示状态。')
      const cached = this.cachedAppInfo(context.appId)
      const info = cached?.templates.length ? cached : await this.appInfo(context.appId, 'schinese', () => this.assertContext(context), true)
      if (input.lock && version !== this.lockVersion) throw new Error('锁定请求已经取消。')
      const { fields } = validateGameStatusPresence(info, input.presence)
      await this.applyLiveChanges(context, input.snapshotId, fields, true, input.lock, version)
    })
  }
  private async applyLiveChanges(context: LiveContext, snapshotId: string, requested: Record<string, string>, template: boolean, lock: boolean, version: number): Promise<void> {
    const observed = this.observation
    if (!observed || observed.snapshotId !== snapshotId || this.patch || observed.context.epoch !== context.epoch || this.liveLock) throw new Error('请先重新读取状态，或解除锁定并恢复上一处修补。')
    const fresh = () => {
      this.assertContext(context)
      if (lock && version !== this.lockVersion) throw new Error('锁定请求已经取消。')
      if (Date.now() - observed.observedAt >= LIVE_OBSERVATION_TTL_MS) throw new Error('读取快照已过期，请重新读取后再修改。')
    }
    fresh()
    if (!requested || typeof requested !== 'object' || Array.isArray(requested) || !Object.keys(requested).length || Object.keys(requested).length > 20) throw new Error('请选择已观察到的公开字段进行修改。')
    const changes: Record<string, string> = {}
    for (const [key, value] of Object.entries(requested)) {
      if ((!template && (!isGameStatusPresenceParameter(key) || readOnly.has(key) || !Object.hasOwn(this.value.live!.fields, key))) || typeof value !== 'string' || control.test(value) || Buffer.byteLength(value) > 255) throw new Error('只能修改已观察到的公开文本字段，不能修改显示令牌或加入信息。')
      if (lock || template || value !== observed.raw[key]) changes[key] = value
    }
    if (!Object.keys(changes).length) throw new Error('没有需要提交的字段变化。')
    const latest = await this.read(context)
    fresh()
    const kind = lock ? 'lock' : 'patch'
    if (Object.keys(changes).some(key => latest.raw[key] !== observed.raw[key])) { this.outcome(kind, 'conflict', '游戏已经更新被修改字段，未发送；请重新读取。', Object.keys(changes)); return }
    const original = Object.fromEntries(Object.keys(changes).map(key => [key, latest.raw[key]]))
    const matchedBefore = this.writtenMatches(latest.raw, changes)
    if (!matchedBefore) { fresh(); this.upload(context, { ...latest.raw, ...changes }) }
    this.patch = { context, original, written: changes, writtenAt: Date.now() }; this.value.live!.patchActive = true
    let returned: PresenceRead | null = matchedBefore ? latest : null
    if (!matchedBefore) { try { returned = await this.read(context) } catch { fresh() } }
    fresh()
    const matched = !!returned && this.writtenMatches(returned.raw, changes)
    if (returned) this.showObservation(context, returned)
    if (lock) {
      const controller: LiveLockController = { context, version, desired: { ...changes }, original: { ...original }, timer: null }
      this.liveLock = controller
      this.value.liveLock = { appId: context.appId, gameEpoch: context.epoch, desired: { ...changes }, status: matched ? 'locked' : 'retrying', matched, localizedString: returned ? this.localizedReadback(context, returned) : null, nextCheckAt: null, lastCheckedAt: new Date().toISOString(), consecutiveFailures: matched ? 0 : 1, error: matched ? null : '本次回读未确认锁定字段，稍后重查。' }
      this.scheduleLiveLock(controller, LIVE_LOCK_INTERVAL_MS)
    }
    this.outcome(kind, matched ? 'matched' : 'unverified', lock ? matched ? '锁定字段本人回读相符，将定期维持；不代表好友端显示已确认。' : '已启用定期维持，本次回读尚未确认；不会抢占真实游戏。' : matched ? '本人状态回读与提交字段相符；这不代表好友端显示已确认。' : '已单次提交，回读尚未确认；不会循环覆盖游戏。', Object.keys(changes))
  }
  private liveLockCurrent(controller: LiveLockController): boolean {
    if (this.liveLock !== controller || this.lockVersion !== controller.version) return false
    try { this.assertContext(controller.context); return true } catch { return false }
  }
  private assertLiveLock(controller: LiveLockController): void {
    this.assertContext(controller.context)
    if (this.liveLock !== controller || this.lockVersion !== controller.version) throw new Error('锁定请求已经取消。')
  }
  private scheduleLiveLock(controller: LiveLockController, delay: number): void {
    if (!this.liveLockCurrent(controller) || this.value.liveLock?.status === 'paused') return
    if (controller.timer) clearTimeout(controller.timer)
    this.value.liveLock!.nextCheckAt = new Date(Date.now() + delay).toISOString()
    controller.timer = setTimeout(() => { controller.timer = null; void this.checkLiveLock(controller) }, delay)
    controller.timer.unref?.()
  }
  private async checkLiveLock(controller: LiveLockController): Promise<void> {
    if (!this.liveLockCurrent(controller)) { if (this.liveLock === controller) { this.stopLiveLock(); this.emit() }; return }
    if (this.busyToken) { this.scheduleLiveLock(controller, LIVE_LOCK_INTERVAL_MS); this.emit(); return }
    const state = this.value.liveLock!
    state.status = 'checking'; state.nextCheckAt = null; this.emit()
    try {
      await this.once({ accountId: controller.context.accountId, sessionId: this.value.sessionId }, async () => {
        this.assertLiveLock(controller)
        let returned = await this.read(controller.context)
        this.assertLiveLock(controller)
        if (!this.writtenMatches(returned.raw, controller.desired)) {
          for (const [key, expected] of Object.entries(controller.desired)) if (!this.writtenMatches(returned.raw, { [key]: expected })) controller.original[key] = returned.raw[key]
          this.assertLiveLock(controller)
          this.upload(controller.context, { ...returned.raw, ...controller.desired })
          this.patch = { context: controller.context, original: { ...controller.original }, written: { ...controller.desired }, writtenAt: Date.now() }
          returned = await this.read(controller.context)
          this.assertLiveLock(controller)
        }
        state.lastCheckedAt = new Date().toISOString(); state.localizedString = this.localizedReadback(controller.context, returned)
        state.matched = this.writtenMatches(returned.raw, controller.desired)
        this.showObservation(controller.context, returned)
        if (!state.matched) throw new Error('回读未确认锁定字段。')
        state.status = 'locked'; state.consecutiveFailures = 0; state.error = null
      })
    } catch {
      if (!this.liveLockCurrent(controller)) { if (this.liveLock === controller) { this.stopLiveLock(); this.emit() }; return }
      state.matched = false; state.lastCheckedAt = new Date().toISOString(); state.consecutiveFailures++
      state.status = state.consecutiveFailures >= LIVE_LOCK_MAX_FAILURES ? 'paused' : 'retrying'
      state.error = state.status === 'paused' ? '连续多次无法确认锁定字段，已暂停自动维持；可解除锁定后重新读取。' : '读取或回读未确认锁定字段，将退避重试。'
    }
    if (!this.liveLockCurrent(controller)) return
    if (state.status !== 'paused') this.scheduleLiveLock(controller, state.consecutiveFailures ? Math.min(30000, LIVE_LOCK_INTERVAL_MS * 2 ** (state.consecutiveFailures - 1)) : LIVE_LOCK_INTERVAL_MS)
    this.emit()
  }
  async unlockLive(input: GameStatusUnlockInput): Promise<GameStatusSnapshot> {
    this.selected(input)
    if (input.restore !== undefined && typeof input.restore !== 'boolean') throw new Error('解除锁定的恢复选项不正确。')
    const pending = this.busyDone
    this.stopLiveLock(); this.emit()
    if (input.restore) {
      if (pending) await pending
      this.selected(input)
      return this.restoreLive(input)
    }
    this.outcome('unlock', 'observed', '已解除锁定并停止自动维持，保留当前游戏字段；可由游戏继续更新。')
    this.emit(); return this.snapshot()
  }
  async restoreLive(input: GameStatusAction): Promise<GameStatusSnapshot> {
    this.selected(input)
    if (this.liveLock) throw new Error('请先解除锁定，再恢复游戏字段。')
    return this.once(input, async context => {
      const patch = this.patch
      if (!patch || patch.context.epoch !== context.epoch || patch.context.steamId !== context.steamId) throw new Error('没有可安全恢复的本工具修补记录。')
      const fresh = () => { this.assertContext(context); if (Date.now() - patch.writtenAt >= LIVE_RESTORE_TTL_MS) throw new Error('恢复记录已过期，拒绝覆盖当前游戏状态。') }
      fresh()
      const latest = await this.read(context)
      fresh()
      if (!this.writtenMatches(latest.raw, patch.written)) { this.outcome('restore', 'conflict', '游戏已经覆盖修补字段，拒绝恢复以保护新的状态。', Object.keys(patch.written)); return }
      const restored = { ...latest.raw }
      for (const [key, value] of Object.entries(patch.original)) { if (value === undefined) delete restored[key]; else restored[key] = value }
      fresh(); this.upload(context, restored)
      this.patch = null
      let returned: PresenceRead | null = null
      try { returned = await this.read(context) } catch { this.assertContext(context) }
      this.outcome('restore', returned && this.writtenMatches(returned.raw, patch.original) ? 'matched' : 'unverified', returned && this.writtenMatches(returned.raw, patch.original) ? '原字段回读相符；好友端显示仍未单独确认。' : '已单次提交恢复，回读尚未确认。', Object.keys(patch.original))
      if (returned) this.showObservation(context, returned)
      else if (this.value.live) this.value.live.patchActive = false
    })
  }

  async loadDraft(input: GameStatusAction): Promise<GameStatusDraft | null> {
    this.selected(input)
    if (this.options.draftPath) {
      try {
        const content = await readFile(this.options.draftPath, 'utf8')
        if (Buffer.byteLength(content) > 65536) throw new Error()
        const parsed = JSON.parse(content) as { version?: number; drafts?: Record<string, GameStatusDraft> }
        if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== 'object') throw new Error()
        this.selected(input)
        this.drafts = Object.fromEntries(Object.entries(parsed.drafts).map(([accountId, value]) => [accountId, draft(value)]))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本地游戏状态草稿。') }
    }
    const saved = this.drafts[input.accountId]
    return saved ? structuredClone(saved) : null
  }
  saveDraft(input: GameStatusSaveDraftInput): Promise<GameStatusDraft> {
    const pending = this.draftQueue.then(() => this.writeDraft(input))
    this.draftQueue = pending.then(noop, noop)
    return pending
  }
  private async writeDraft(input: GameStatusSaveDraftInput): Promise<GameStatusDraft> {
    this.selected(input); const value = draft(input.draft)
    if (this.options.draftPath) await this.loadDraft(input)
    const next = { ...this.drafts, [input.accountId]: value }
    if (this.options.draftPath) {
      const path = this.options.draftPath; const temporary = `${path}.${id()}.tmp`
      const content = JSON.stringify({ version: 1, drafts: next })
      if (Buffer.byteLength(content) > 65536) throw new Error('本地草稿超过允许大小。')
      try { await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 }); this.selected(input); await rename(temporary, path) }
      catch { throw new Error('无法保存本地游戏状态草稿。') }
      finally { await unlink(temporary).catch(noop) }
    }
    this.selected(input); this.drafts = next
    return structuredClone(value)
  }
}
