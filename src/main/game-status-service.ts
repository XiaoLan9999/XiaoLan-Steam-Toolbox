import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GameStatusAction, GameStatusConnectInput, GameStatusDraft, GameStatusGuardInput, GameStatusLiveSnapshot, GameStatusOperation, GameStatusPatchInput, GameStatusPlayInput, GameStatusSaveDraftInput, GameStatusSnapshot } from '../shared/game-status'

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
  requestRichPresence(appId: number, steamIds: string[]): Promise<{ users: Record<string, { richPresence: Record<string, string> }> }>
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
const control = /[\p{Cc}\u2028\u2029]/u
const id = () => randomBytes(24).toString('hex')
const noop = () => {}
const publicKeys = new Set(['status', 'steam_display', 'version', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score', 'game:server', 'state', 'currentmap', 'map', 'mode', 'score', 'activity', 'details'])
const readOnly = new Set(['steam_display', 'version'])
const appNote = '仅提交 status；现代好友列表的二级状态不保证显示。'
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
  return { displayKind: 'app', gameName, details, appId: value.appId }
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
interface Patch { context: LiveContext; original: Record<string, string>; written: Record<string, string>; writtenAt: number }

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
  private disposed = false
  private drafts: Record<string, GameStatusDraft> = {}
  private draftQueue: Promise<void> = Promise.resolve()
  private preparation: { token: object; cancel(): void } | null = null

  constructor(private readonly options: GameStatusServiceOptions) {}
  private empty(): GameStatusSnapshot { return { sessionId: id(), accountId: null, boundSteamId: null, status: 'logged_out', connected: false, accountName: null, steamId: null, guard: null, blocked: false, blockingAppId: null, playing: null, live: null, lastOperation: null, busy: false, limitations: [], error: null } }
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
  private clearLive(): void { this.epoch++; this.observation = null; this.patch = null; this.value.live = null; this.value.lastOperation = null }
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
    this.generation++; this.client = null; this.busyToken = null
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
  play(input: GameStatusPlayInput): GameStatusSnapshot {
    this.logged(input); const value = draft(input)
    if (this.value.blocked) throw new Error('账号正在别处运行真实游戏；请使用真实游戏状态读取，不能模拟游戏。')
    if ('richPresence' in input || 'steam_display' in input) throw new Error('模拟模式不接受任意详细状态令牌。')
    const client = this.client!; const generation = this.generation
    try {
      this.clearSimulation()
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      client.setPersona(1)
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      this.ownsSimulation = true
      if (value.displayKind === 'app') this.ownedApps.add(value.appId!)
      const displayName = value.displayKind === 'custom' ? value.details ? `${value.gameName} · ${value.details}` : value.gameName : value.gameName || `App ${value.appId}`
      client.gamesPlayed(value.displayKind === 'custom' ? displayName : [value.appId!], false)
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      if (value.displayKind === 'app') client.uploadRichPresence(value.appId!, { status: value.details })
      if (!this.current(client, generation) || this.value.blocked) return this.snapshot()
      this.value.playing = { ...value, displayName, delivery: 'submitted', limitations: [value.displayKind === 'custom' ? customNote : appNote] }
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
  private async read(context: LiveContext): Promise<Record<string, string>> {
    this.assertContext(context)
    let response: Awaited<ReturnType<GameStatusSteamClient['requestRichPresence']>>
    try { response = await context.client.requestRichPresence(context.appId, [context.steamId]) } catch { throw new Error('读取 Steam 游戏详细状态失败。') }
    this.assertContext(context)
    const raw = response?.users?.[context.steamId]?.richPresence
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 65536 || Object.values(raw).some(value => typeof value !== 'string')) throw new Error('未取得当前账号有效的游戏详细状态。')
    return { ...raw }
  }
  private publicFields(raw: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(raw).filter(([key, value]) => publicKeys.has(key) && !control.test(value) && Buffer.byteLength(value) <= 255)) }
  private showObservation(context: LiveContext, raw: Record<string, string>): void {
    const snapshotId = id(); this.observation = { context, raw, snapshotId, observedAt: Date.now() }
    const fields = this.publicFields(raw)
    this.value.live = { snapshotId, appId: context.appId, gameEpoch: context.epoch, observedAt: new Date().toISOString(), fields, editableKeys: Object.keys(fields).filter(key => !readOnly.has(key)), readOnlyKeys: Object.keys(fields).filter(key => readOnly.has(key)), patchActive: !!this.patch }
  }
  private outcome(kind: GameStatusOperation['kind'], outcome: GameStatusOperation['outcome'], message: string, changedKeys?: string[]): void { this.value.lastOperation = { kind, outcome, message, at: new Date().toISOString(), ...(changedKeys ? { changedKeys } : {}) }; this.value.error = null }
  private async once(input: GameStatusAction, operation: (context: LiveContext) => Promise<void>): Promise<GameStatusSnapshot> {
    const context = this.context(input)
    if (this.busyToken) throw new Error('上一个真实状态操作尚未结束。')
    const token = {}; this.busyToken = token; this.value.busy = true; this.emit()
    try { await operation(context) } finally { if (this.busyToken === token) { this.busyToken = null; this.value.busy = false; this.emit() } }
    return this.snapshot()
  }
  observeLive(input: GameStatusAction): Promise<GameStatusSnapshot> {
    return this.once(input, async context => {
      const raw = await this.read(context)
      const expired = !!this.patch && Date.now() - this.patch.writtenAt >= LIVE_RESTORE_TTL_MS
      const superseded = !!this.patch && !this.writtenMatches(raw, this.patch.written)
      if (expired || superseded) this.patch = null // Explicit refresh retires only local history; it does not write to Steam.
      this.showObservation(context, raw)
      this.outcome('observe', 'observed', expired ? '旧恢复记录已过期，已仅清除本地记录并重新建立读取基线，可重新编辑。' : superseded ? '游戏已覆盖旧修补，已丢弃旧的本地恢复记录，可重新编辑。' : '已读取本人当前游戏的公开字段；不会自动修改。')
    })
  }
  private upload(context: LiveContext, raw: Record<string, string>): void { this.assertContext(context); try { context.client.uploadRichPresence(context.appId, raw) } catch { throw new Error('提交真实游戏详细状态失败。') }; this.assertContext(context) }
  private writtenMatches(raw: Record<string, string>, expected: Record<string, string>): boolean { return Object.entries(expected).every(([key, value]) => raw[key] === value || (value === '' && raw[key] === undefined)) }
  patchLive(input: GameStatusPatchInput): Promise<GameStatusSnapshot> {
    return this.once(input, async context => {
      const observed = this.observation
      if (!observed || observed.snapshotId !== input.snapshotId || this.patch || observed.context.epoch !== context.epoch) throw new Error('请先重新读取状态，或恢复上一处修补。')
      const fresh = () => { this.assertContext(context); if (Date.now() - observed.observedAt >= LIVE_OBSERVATION_TTL_MS) throw new Error('读取快照已过期，请重新读取后再修改。') }
      fresh()
      if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || !Object.keys(input.changes).length || Object.keys(input.changes).length > 20) throw new Error('请选择已观察到的公开字段进行修改。')
      const changes: Record<string, string> = {}
      for (const [key, value] of Object.entries(input.changes)) {
        if (!publicKeys.has(key) || readOnly.has(key) || !Object.hasOwn(this.value.live!.fields, key) || typeof value !== 'string' || control.test(value) || Buffer.byteLength(value) > 255) throw new Error('只能修改已观察到的公开文本字段，不能修改显示令牌或加入信息。')
        if (value !== observed.raw[key]) changes[key] = value
      }
      if (!Object.keys(changes).length) throw new Error('没有需要提交的字段变化。')
      const latest = await this.read(context)
      fresh()
      if (Object.keys(changes).some(key => latest[key] !== observed.raw[key])) { this.outcome('patch', 'conflict', '游戏已经更新被修改字段，未发送；请重新读取。', Object.keys(changes)); return }
      const original = Object.fromEntries(Object.keys(changes).map(key => [key, observed.raw[key]!]))
      fresh(); this.upload(context, { ...latest, ...changes })
      this.patch = { context, original, written: changes, writtenAt: Date.now() }; this.value.live!.patchActive = true
      let returned: Record<string, string> | null = null
      try { returned = await this.read(context) } catch { this.assertContext(context) }
      this.outcome('patch', returned && this.writtenMatches(returned, changes) ? 'matched' : 'unverified', returned && this.writtenMatches(returned, changes) ? '本人状态回读与提交字段相符；这不代表好友端显示已确认。' : '已单次提交，回读尚未确认；不会循环覆盖游戏。', Object.keys(changes))
      if (returned) this.showObservation(context, returned)
    })
  }
  restoreLive(input: GameStatusAction): Promise<GameStatusSnapshot> {
    return this.once(input, async context => {
      const patch = this.patch
      if (!patch || patch.context.epoch !== context.epoch || patch.context.steamId !== context.steamId) throw new Error('没有可安全恢复的本工具修补记录。')
      const fresh = () => { this.assertContext(context); if (Date.now() - patch.writtenAt >= LIVE_RESTORE_TTL_MS) throw new Error('恢复记录已过期，拒绝覆盖当前游戏状态。') }
      fresh()
      const latest = await this.read(context)
      fresh()
      if (!this.writtenMatches(latest, patch.written)) { this.outcome('restore', 'conflict', '游戏已经覆盖修补字段，拒绝恢复以保护新的状态。', Object.keys(patch.written)); return }
      fresh(); this.upload(context, { ...latest, ...patch.original })
      this.patch = null
      let returned: Record<string, string> | null = null
      try { returned = await this.read(context) } catch { this.assertContext(context) }
      this.outcome('restore', returned && this.writtenMatches(returned, patch.original) ? 'matched' : 'unverified', returned && this.writtenMatches(returned, patch.original) ? '原字段回读相符；好友端显示仍未单独确认。' : '已单次提交恢复，回读尚未确认。', Object.keys(patch.original))
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
