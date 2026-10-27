import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import type { GameStatusSteamClient } from './game-status-service'
import type { NativePresenceContext, NativePresenceError, NativePresenceRead } from './native-presence-broker'

export interface NativeGameStatusContext {
  appId: number
  steamId: string
  steamPid: number
  steamStartTicks: string
  steamExe: string
}
export interface NativeGameStatusBroker {
  read(context: NativePresenceContext, permitted: () => boolean): Promise<NativePresenceRead>
  stop(): void
  beginContext?(): void
  onContextLost?(listener: (error: NativePresenceError) => void): () => void
}
export interface NativeGameStatusClientOptions {
  broker: NativeGameStatusBroker
  steamId: string
  detectContext?: () => Promise<NativeGameStatusContext>
  createMetadataClient?: () => GameStatusSteamClient
  pollIntervalMs?: number
  metadataTimeoutMs?: number
}

const execute = promisify(execFile)
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{17}$/.test(value)
const safePid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const safeTicks = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{1,18}$/.test(value)
const contextError = () => new DomainError('GAME_STATUS_CONTEXT_CHANGED', '本机 Steam 账号或游戏已经变化，请重新连接。')
const detectionUnavailable = () => new DomainError('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', '暂时无法核实本机 Steam 和游戏，已停止自动维持并保留恢复记录。请手动重新读取核对。')

export async function detectNativeGameStatusContext(): Promise<NativeGameStatusContext> {
  if (process.platform !== 'win32') throw new DomainError('GAME_STATUS_NATIVE_UNAVAILABLE', '本机游戏状态目前仅支持 Windows。')
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$config = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam'
$active = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess'
if ($null -eq $config.RunningAppID -or $null -eq $active.ActiveUser -or $null -eq $active.pid) { throw 'Steam context unavailable' }
$steam = Get-Process -Id ([int]$active.pid)
if ($steam.ProcessName -ine 'steam') { throw 'Steam unavailable' }
$image = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $steam.Id)).ExecutablePath
if (!$image -or !$config.SteamExe -or ![IO.Path]::GetFullPath($image).Equals([IO.Path]::GetFullPath([string]$config.SteamExe), [StringComparison]::OrdinalIgnoreCase)) { throw 'Steam identity unavailable' }
$account = [long]$active.ActiveUser
if ($account -lt 0) { $account += 4294967296 }
$user = [uint64]$account
if ($user -eq 0 -or $user -gt [uint32]::MaxValue) { throw 'Steam user unavailable' }
@{appId=[int]$config.RunningAppID;steamId=([uint64]0x0110000100000000+$user).ToString();steamPid=$steam.Id;steamStartTicks=$steam.StartTime.ToUniversalTime().Ticks.ToString();steamExe=$image} | ConvertTo-Json -Compress`
  try {
    const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' })
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as NativeGameStatusContext
    validateContext(value)
    const image = await realpath(value.steamExe)
    if (basename(image).toLowerCase() !== 'steam.exe' || dirname(image) === image) throw detectionUnavailable()
    return { ...value, steamExe: image }
  } catch { throw detectionUnavailable() }
}

function validateContext(value: NativeGameStatusContext): void {
  if (!value || !Number.isInteger(value.appId) || value.appId < 0 || value.appId > 0xffffff || !safeId(value.steamId) || !safePid(value.steamPid) || !safeTicks(value.steamStartTicks) || typeof value.steamExe !== 'string' || !isAbsolute(value.steamExe) || basename(value.steamExe).toLowerCase() !== 'steam.exe') throw detectionUnavailable()
}
function sameContext(a: NativeGameStatusContext, b: NativeGameStatusContext): boolean {
  return a.appId === b.appId && a.steamId === b.steamId && a.steamPid === b.steamPid && a.steamStartTicks === b.steamStartTicks && a.steamExe.toLowerCase() === b.steamExe.toLowerCase()
}
function brokerContext(context: NativeGameStatusContext): NativePresenceContext {
  return { appId: context.appId, steamId: context.steamId, steamPid: context.steamPid, steamStartTicks: context.steamStartTicks }
}

export class NativeGameStatusClient extends EventEmitter implements GameStatusSteamClient {
  readonly presenceSource = 'local-cache' as const
  steamID: { getSteamID64(): string } | null = null
  playingState = { blocked: false, appid: 0 }
  private generation = 0
  private connecting = false
  private suspended = false
  private context: NativeGameStatusContext | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private detecting: Promise<NativeGameStatusContext> | null = null
  private metadata: GameStatusSteamClient | null = null
  private metadataFlight: Promise<GameStatusSteamClient> | null = null
  private cancelMetadata: (() => void) | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly options: NativeGameStatusClientOptions) {
    super()
    if (!safeId(options.steamId)) throw new DomainError('GAME_STATUS_IDENTITY_MISMATCH', '当前账号身份无效。')
  }
  private current(generation: number): boolean { return this.generation === generation }
  private detect(): Promise<NativeGameStatusContext> {
    if (this.detecting) return this.detecting
    const pending = Promise.resolve().then(() => (this.options.detectContext ?? detectNativeGameStatusContext)()).then(value => { validateContext(value); return { ...value } }).catch(() => { throw detectionUnavailable() })
    this.detecting = pending
    void pending.finally(() => { if (this.detecting === pending) this.detecting = null }).catch(() => {})
    return pending
  }
  private requireIdentity(value: NativeGameStatusContext): void {
    if (value.steamId !== this.options.steamId) throw new DomainError('GAME_STATUS_IDENTITY_MISMATCH', '本机 Steam 与工具箱账号不一致，未连接。')
    if (!value.appId) throw new DomainError('GAME_STATUS_NO_LIVE_GAME', '请先启动真实 Steam 游戏，再连接本机状态。')
  }
  private verifyAttached(value: NativeGameStatusContext, expected: NativeGameStatusContext): boolean {
    if (value.steamId !== expected.steamId) throw new DomainError('GAME_STATUS_IDENTITY_MISMATCH', '本机 Steam 与工具箱账号不一致，未继续操作。')
    if (value.steamPid !== expected.steamPid || value.steamStartTicks !== expected.steamStartTicks || value.steamExe.toLowerCase() !== expected.steamExe.toLowerCase() || (value.appId !== 0 && value.appId !== expected.appId)) throw contextError()
    return value.appId !== 0
  }
  private assertCurrent(generation: number, expected: NativeGameStatusContext): void {
    if (!this.current(generation) || !this.context || !sameContext(this.context, expected)) throw contextError()
    if (this.suspended) throw detectionUnavailable()
  }
  async logOn(details: Record<string, unknown>): Promise<void> {
    if (this.connecting || this.context || this.steamID) throw contextError()
    if (details?.steamID !== undefined && details.steamID !== this.options.steamId) throw new DomainError('GAME_STATUS_IDENTITY_MISMATCH', '请求账号与当前工具箱账号不一致。')
    const generation = ++this.generation
    this.connecting = true
    this.options.broker.beginContext?.()
    this.unsubscribe?.()
    this.unsubscribe = this.options.broker.onContextLost?.(error => {
      if (!this.current(generation)) return
      if (error.nativeCode === 'NATIVE_CONTEXT_CHANGED') this.fail(new DomainError('GAME_STATUS_NATIVE_CONTEXT', '本机游戏进程已经变化，连接已停止。'))
      else if (error.nativeCode === 'NATIVE_CONTEXT_UNAVAILABLE') this.suspend()
    }) ?? null
    try {
      const context = await this.detect()
      if (!this.current(generation)) throw contextError()
      this.requireIdentity(context)
      this.context = context
      await this.options.broker.read(brokerContext(context), () => this.current(generation) && this.context !== null && sameContext(this.context, context))
      this.assertCurrent(generation, context)
      this.connecting = false
      this.steamID = { getSteamID64: () => this.options.steamId }
      this.playingState = { blocked: true, appid: context.appId }
      this.emit('loggedOn')
      if (!this.current(generation)) return
      this.emit('playingState', true, context.appId)
      this.schedule(generation)
    } catch (error) { if (this.current(generation)) this.fail(error); else throw contextError() }
  }
  private schedule(generation: number): void {
    if (!this.current(generation) || !this.context || this.suspended) return
    this.timer = setTimeout(() => { this.timer = null; void this.poll(generation) }, this.options.pollIntervalMs ?? 1000)
    this.timer.unref?.()
  }
  private async poll(generation: number): Promise<void> {
    let current: NativeGameStatusContext
    try {
      current = await this.detect()
    } catch { if (this.current(generation)) this.suspend(); return }
    if (!this.current(generation) || this.suspended) return
    try {
      if (!this.context) throw contextError()
      if (!this.verifyAttached(current, this.context)) { this.suspend(); return }
      this.schedule(generation)
    } catch (error) { if (this.current(generation)) this.fail(error) }
  }
  private suspend(): void {
    if (!this.context || !this.steamID) { this.fail(detectionUnavailable()); return }
    if (this.suspended) return
    this.suspended = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.options.broker.stop()
    this.emit('nativeContextUnavailable', detectionUnavailable())
  }
  private fail(error: unknown): void {
    const safe = error instanceof DomainError ? error : contextError()
    this.logOff()
    this.emit('playingState', false, 0)
    this.emit('error', safe)
  }
  logOff(): void {
    this.generation++
    this.connecting = false
    this.suspended = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribe?.(); this.unsubscribe = null
    this.context = null; this.steamID = null; this.playingState = { blocked: false, appid: 0 }
    this.options.broker.stop()
    this.cancelMetadata?.(); this.cancelMetadata = null
    const metadata = this.metadata; this.metadata = null; this.metadataFlight = null
    if (metadata) { try { metadata.logOff() } catch { /* Only the owned anonymous metadata connection is retired. */ } }
  }
  setPersona(): never { throw new DomainError('GAME_STATUS_NATIVE_UNAVAILABLE', '本机游戏连接不会修改 Steam 在线状态。') }
  gamesPlayed(): never { throw new DomainError('GAME_STATUS_NATIVE_UNAVAILABLE', '本机游戏连接不会抢占或模拟游戏会话。') }
  uploadRichPresence(): never { throw new DomainError('GAME_STATUS_NATIVE_UNAVAILABLE', '真实游戏状态必须通过受约束的本机写入器提交。') }

  async requestRichPresence(appId: number, steamIds: string[]): Promise<{ users: Record<string, { richPresence: Record<string, string>; localizedString: string | null; displayTokenReadable: boolean; verificationSource: 'local-cache' }> }> {
    const context = this.context; const generation = this.generation
    if (!context || !this.steamID || appId !== context.appId || !Array.isArray(steamIds) || steamIds.length !== 1 || steamIds[0] !== this.options.steamId) throw contextError()
    if (this.suspended) throw detectionUnavailable()
    let detected: NativeGameStatusContext
    try {
      detected = await this.detect()
    } catch { if (this.current(generation)) this.suspend(); throw detectionUnavailable() }
    this.assertCurrent(generation, context)
    let verified: boolean
    try {
      verified = this.verifyAttached(detected, context)
    } catch (error) { if (this.current(generation)) this.fail(error); throw error }
    if (!verified) { this.suspend(); throw detectionUnavailable() }
    const result = await this.options.broker.read(brokerContext(context), () => this.current(generation) && !this.suspended && this.context !== null && sameContext(context, this.context))
    this.assertCurrent(generation, context)
    return { users: { [this.options.steamId]: { richPresence: { ...result.fields }, localizedString: result.localizedString, displayTokenReadable: result.displayTokenReadable, verificationSource: 'local-cache' } } }
  }
  async revalidateContext(): Promise<void> {
    if (!this.suspended) return
    const context = this.context; const generation = this.generation
    if (!context || !this.steamID) throw contextError()
    let detected: NativeGameStatusContext
    try { detected = await this.detect() } catch { throw detectionUnavailable() }
    if (!this.current(generation) || !this.context || !sameContext(context, this.context)) throw contextError()
    let verified: boolean
    try { verified = this.verifyAttached(detected, context) }
    catch (error) { this.fail(error); throw error }
    if (!verified) throw detectionUnavailable()
    await this.options.broker.read(brokerContext(context), () => this.current(generation) && this.context !== null && sameContext(context, this.context))
    if (!this.current(generation) || !this.context || !sameContext(context, this.context)) throw contextError()
    this.suspended = false
    this.schedule(generation)
  }
  private metadataClient(): Promise<GameStatusSteamClient> {
    if (this.metadataFlight) return this.metadataFlight
    if (this.suspended) return Promise.reject(detectionUnavailable())
    if (!this.context || !this.steamID || !this.options.createMetadataClient) return Promise.reject(new DomainError('GAME_STATUS_APP_LOOKUP_TIMEOUT', '匿名游戏信息连接不可用。'))
    const generation = this.generation
    const client = this.options.createMetadataClient()
    this.metadata = client
    const pending = new Promise<GameStatusSteamClient>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true; clearTimeout(timer); this.cancelMetadata = null
        client.removeListener('loggedOn', ready)
        if (error) { try { client.logOff() } catch { /* Retired metadata connection. */ }; reject(error) }
        else resolve(client)
      }
      const failed = (): void => {
        if (finished) {
          if (this.metadata === client) { this.metadata = null; this.metadataFlight = null; try { client.logOff() } catch { /* Retired anonymous connection. */ } }
          return
        }
        finish(new DomainError('GAME_STATUS_APP_LOOKUP_TIMEOUT', '匿名游戏信息读取失败；未使用个人账号回退。'))
      }
      const ready = (): void => { if (!this.current(generation) || this.metadata !== client) finish(contextError()); else finish() }
      const timer = setTimeout(failed, this.options.metadataTimeoutMs ?? 12000); timer.unref?.()
      this.cancelMetadata = () => finish(contextError())
      client.on('error', failed); client.on('disconnected', failed); client.on('loggedOn', ready)
      try { const result = client.logOn({ anonymous: true }); result?.catch(failed) } catch { failed() }
    })
    this.metadataFlight = pending
    void pending.catch(() => { if (this.metadataFlight === pending) { this.metadataFlight = null; if (this.metadata === client) this.metadata = null } })
    return pending
  }
  async getProductInfo(apps: number[], packages: number[], includeTokens?: boolean): Promise<unknown> {
    if (!Array.isArray(apps) || apps.length < 1 || apps.length > 32 || apps.some(value => !Number.isInteger(value) || value < 1 || value > 0xffffff) || !Array.isArray(packages) || packages.length || (includeTokens !== undefined && typeof includeTokens !== 'boolean')) throw contextError()
    const generation = this.generation
    const client = await this.metadataClient()
    if (!this.current(generation) || !this.context || !client.getProductInfo) throw contextError()
    const result = await client.getProductInfo(apps, [], includeTokens)
    if (!this.current(generation) || !this.context || this.metadata !== client) throw contextError()
    return result
  }
}
