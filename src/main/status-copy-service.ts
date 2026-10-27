import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DomainError } from '../shared/domain'
import { STATUS_COPY_DEFAULTS, type StatusCopyAction, type StatusCopyCode, type StatusCopyInput, type StatusCopyMode, type StatusCopyReport, type StatusCopySettings, type StatusCopySettingsInput, type StatusCopySnapshot } from '../shared/status-copy'
import type { StatusCopyBackend, StatusCopyBackendContext, StatusCopyLocalContext } from './status-copy-backend'
import { detectNativeGameStatusContext } from './native-game-status-client'
import { isStatusCopyPublicField, ToolboxStatusCopyBackend, type ToolboxStatusCopyOptions } from './status-copy-toolbox'
import { isWellFormedPresenceText, richPresenceContract, richPresenceDisplayToken } from '../shared/rich-presence-contract'

export interface StatusCopyServiceOptions {
  getActiveAccount(): { id: string; steamId: string } | null
  getToolboxLogin?: ToolboxStatusCopyOptions['getToolboxLogin']
  readLocalContext?(): Promise<StatusCopyLocalContext>
  beforeStart?(): void | Promise<void>
  createBackend?(mode: StatusCopyMode): StatusCopyBackend
  preferencesPath?: string
  cipher?: { isAvailable(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
  onChange?(snapshot: StatusCopySnapshot): void
  operationTimeoutMs?: number
  guardIntervalMs?: number
  localTimeoutMs?: number
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const control = /[\p{Cc}\u2028\u2029]/u
const id = () => randomBytes(24).toString('hex')
const failure = (code: StatusCopyCode) => new DomainError(code, code)
function individual(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{17}$/.test(value)) return false
  const delta = BigInt(value) - 76561197960265728n
  return delta > 0n && delta <= 4294967295n
}
const blank = (): StatusCopyReport => ({ source: null, targetAppId: null, appliedAt: null, verification: 'not-verified', waiting: false, warnings: [] })
const codes = new Set<StatusCopyCode>(['COPY_INVALID_INPUT', 'COPY_SOURCE_EQUALS_TARGET', 'COPY_TARGET_IS_LOCAL', 'COPY_LOCAL_UNAVAILABLE', 'COPY_LOGIN_REQUIRED', 'COPY_IDENTITY_MISMATCH', 'COPY_SOURCE_UNAVAILABLE', 'COPY_SOURCE_NOT_FRIEND', 'COPY_SOURCE_NOT_PLAYING', 'COPY_SOURCE_STALE', 'COPY_REQUEST_FAILED', 'COPY_SESSION_CHANGED', 'COPY_BUSY', 'COPY_STOP_UNCONFIRMED', 'COPY_ASF_INCOMPATIBLE', 'COPY_ASF_BOT_UNAVAILABLE', 'COPY_ASF_CONFIG_CONFLICT', 'COPY_ASF_GROUP_UNSUPPORTED', 'COPY_TEMPLATE_UNAVAILABLE', 'COPY_LIVE_RESTORE_REQUIRED', 'COPY_PLAYING_BLOCKED'])
function code(value: unknown): StatusCopyCode { return object(value) && codes.has(value.code as StatusCopyCode) ? value.code as StatusCopyCode : 'COPY_REQUEST_FAILED' }
function validate(value: StatusCopySettingsInput): StatusCopySettingsInput {
  if (!value || !['toolbox', 'asf'].includes(value.mode) || !individual(value.sourceSteamId) || !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < (value.mode === 'asf' ? 15 : 5) || value.intervalSeconds > 120 || typeof value.copyGroupSize !== 'boolean' || !['online', 'away'].includes(value.persona)) throw failure('COPY_INVALID_INPUT')
  const result: StatusCopySettingsInput = { mode: value.mode, sourceSteamId: value.sourceSteamId, intervalSeconds: value.intervalSeconds, copyGroupSize: value.copyGroupSize, persona: value.persona }
  if (value.mode === 'asf' || value.asf !== undefined) {
    if (!value.asf || typeof value.asf.url !== 'string' || value.asf.url.length > 2048 || typeof value.asf.botName !== 'string' || !value.asf.botName.trim() || value.asf.botName.length > 128 || control.test(value.asf.botName) || value.asf.password !== undefined && (typeof value.asf.password !== 'string' || value.asf.password.length > 4096 || control.test(value.asf.password))) throw failure('COPY_INVALID_INPUT')
    let url: URL
    try { url = new URL(value.asf.url) } catch { throw failure('COPY_INVALID_INPUT') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('COPY_INVALID_INPUT')
    result.asf = { url: url.href.replace(/\/$/, ''), botName: value.asf.botName.trim(), ...(value.asf.password !== undefined ? { password: value.asf.password } : {}) }
  }
  return result
}
function publicSettings(settings: StatusCopySettingsInput): StatusCopySettings {
  return { mode: settings.mode, sourceSteamId: settings.sourceSteamId, intervalSeconds: settings.intervalSeconds, copyGroupSize: settings.copyGroupSize, persona: settings.persona, ...(settings.asf ? { asf: { url: settings.asf.url, botName: settings.asf.botName, hasPassword: !!settings.asf.password } } : {}) }
}

export class StatusCopyService {
  private value: StatusCopySnapshot
  private preferences = new Map<string, StatusCopySettingsInput>()
  private loading: Promise<void>
  private generation = 0
  private disposed = false
  private backend: StatusCopyBackend | null = null
  private controller: AbortController | null = null
  private operation: object | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retirement: Promise<void> | null = null
  private retirementUnknown = false
  private guardTimer: ReturnType<typeof setTimeout> | null = null
  private localFlight: Promise<StatusCopyLocalContext> | null = null
  private preferenceWrites: Promise<void> = Promise.resolve()
  private forgetting = new Set<string>()
  constructor(private readonly options: StatusCopyServiceOptions) {
    const active = options.getActiveAccount()
    this.value = { ...blank(), sessionId: id(), accountId: active?.id ?? null, targetSteamId: active?.steamId ?? null, phase: 'idle', busy: false, settings: { ...STATUS_COPY_DEFAULTS }, error: null }
    this.loading = this.load()
  }
  private emit(): void { try { this.options.onChange?.(this.state()) } catch { /* Observers cannot own session retirement. */ } }
  state(): StatusCopySnapshot {
    const active = this.options.getActiveAccount()
    if (!this.disposed && active && (active.id !== this.value.accountId || active.steamId !== this.value.targetSteamId) && !this.backend && !this.retirement && !this.retirementUnknown && !this.operation && !this.value.busy) {
      const saved = this.preferences.get(active.id)
      this.value = { ...blank(), sessionId: id(), accountId: active.id, targetSteamId: active.steamId, phase: 'idle', busy: false, error: null, settings: saved ? publicSettings(saved) : { ...STATUS_COPY_DEFAULTS } }
    }
    return structuredClone(this.value)
  }
  private action(input: StatusCopyAction): { id: string; steamId: string } {
    const active = this.options.getActiveAccount()
    if (this.disposed || !active || !individual(active.steamId) || !input || input.accountId !== active.id || input.accountId !== this.value.accountId || input.sessionId !== this.value.sessionId || active.steamId !== this.value.targetSteamId) throw failure('COPY_SESSION_CHANGED')
    return active
  }
  private current(generation: number): void {
    const active = this.options.getActiveAccount()
    if (this.disposed || this.generation !== generation || !active || active.id !== this.value.accountId || active.steamId !== this.value.targetSteamId || this.controller?.signal.aborted) throw failure('COPY_SESSION_CHANGED')
  }
  private settings(input: StatusCopyInput): StatusCopySettingsInput {
    const active = this.action(input); const settings = validate(input.settings)
    if (this.forgetting.has(active.id)) throw failure('COPY_BUSY')
    if (settings.sourceSteamId === active.steamId) throw failure('COPY_SOURCE_EQUALS_TARGET')
    const saved = this.preferences.get(active.id)
    if (settings.mode === 'toolbox' && !settings.asf && saved?.asf) settings.asf = { ...saved.asf }
    if (settings.asf && settings.asf.password === undefined && saved?.asf?.url === settings.asf.url && saved.asf.botName === settings.asf.botName) settings.asf.password = saved.asf.password
    return settings
  }
  private async load(): Promise<void> {
    if (!this.options.preferencesPath) return
    try {
      const data = await readFile(this.options.preferencesPath)
      if (data.length > 256 * 1024) return
      const document: unknown = JSON.parse(data.toString('utf8'))
      if (!object(document) || document.version !== 1 || !object(document.accounts) || Object.keys(document.accounts).length > 64) return
      for (const [account, entry] of Object.entries(document.accounts)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(account) || !object(entry) || !object(entry.settings)) continue
        try {
          const settings = validate(entry.settings as unknown as StatusCopySettingsInput)
          if (settings.asf?.password !== undefined) continue
          if (settings.asf && typeof entry.secret === 'string' && entry.secret.length < 32768 && this.options.cipher?.isAvailable()) settings.asf.password = this.options.cipher.decrypt(Buffer.from(entry.secret, 'base64'))
          this.preferences.set(account, validate(settings))
        } catch { /* A corrupt or unavailable encrypted preference is not a login request. */ }
      }
      const saved = this.value.accountId ? this.preferences.get(this.value.accountId) : null
      if (saved && this.value.phase === 'idle') { this.value.settings = publicSettings(saved); this.emit() }
    } catch { /* Preferences are optional and never start a connection. */ }
  }
  private async persist(): Promise<void> {
    if (!this.options.preferencesPath) return
    const accounts: Record<string, unknown> = {}
    for (const [account, settings] of this.preferences) {
      const safe = publicSettings(settings)
      const { hasPassword: _ignored, ...asf } = safe.asf ?? { hasPassword: false }
      const stored = { ...safe, ...(safe.asf ? { asf } : {}) }
      let secret: string | undefined
      if (settings.asf?.password) {
        if (!this.options.cipher?.isAvailable()) throw failure('COPY_REQUEST_FAILED')
        secret = this.options.cipher.encrypt(settings.asf.password).toString('base64')
      }
      accounts[account] = { settings: stored, ...(secret ? { secret } : {}) }
    }
    const path = this.options.preferencesPath; const temporary = `${path}.${id()}.tmp`
    const serialized = JSON.stringify({ version: 1, accounts })
    if (Buffer.byteLength(serialized) > 256 * 1024) throw failure('COPY_INVALID_INPUT')
    const writing = this.preferenceWrites.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true })
      try { await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, path) }
      finally { await unlink(temporary).catch(() => {}) }
    }).catch(() => { throw failure('COPY_REQUEST_FAILED') })
    this.preferenceWrites = writing
    await writing
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private clearGuard(): void { if (this.guardTimer) clearTimeout(this.guardTimer); this.guardTimer = null }
  private async readLocal(): Promise<StatusCopyLocalContext> {
    if (!this.localFlight) {
      const pending = Promise.resolve().then(() => (this.options.readLocalContext ?? detectNativeGameStatusContext)())
      this.localFlight = pending
      void pending.finally(() => { if (this.localFlight === pending) this.localFlight = null }).catch(() => {})
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.localFlight, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(failure('COPY_LOCAL_UNAVAILABLE')), this.options.localTimeoutMs ?? 12000); timer.unref?.() })])
    } finally { clearTimeout(timer) }
  }
  private guard(context: StatusCopyBackendContext): void {
    this.clearGuard()
    this.guardTimer = setTimeout(() => {
      this.guardTimer = null
      void (async () => {
        try { await context.checkLocal(); context.assertCurrent(); this.guard(context) }
        catch (caught) { await this.failCurrent(context, code(caught)) }
      })()
    }, this.options.guardIntervalMs ?? 1000)
    this.guardTimer.unref?.()
  }
  private async failCurrent(context: StatusCopyBackendContext, reason: StatusCopyCode): Promise<void> {
    if (this.controller?.signal !== context.signal || context.signal.aborted) return
    this.generation++; this.operation = null; this.value.busy = true; this.value.phase = 'stopping'; this.emit()
    try { await this.retire() } catch { reason = 'COPY_STOP_UNCONFIRMED' }
    this.value.phase = 'error'; this.value.busy = false; this.value.error = { code: reason }; this.emit()
  }
  private async retire(): Promise<void> {
    this.clearTimer(); this.clearGuard(); this.controller?.abort(); this.controller = null
    if (this.retirement) return this.retirement
    const backend = this.backend
    if (!backend) return
    const retiring = Promise.resolve().then(() => backend.stop()).then(() => { if (this.backend === backend) this.backend = null; this.retirementUnknown = false }).catch(() => { this.retirementUnknown = true; throw failure('COPY_STOP_UNCONFIRMED') })
    this.retirement = retiring
    try { await retiring } finally { if (this.retirement === retiring) this.retirement = null }
  }
  private async bounded<T>(context: StatusCopyBackendContext, operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => reject(failure('COPY_SESSION_CHANGED')); context.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(failure('COPY_REQUEST_FAILED')), this.options.operationTimeoutMs ?? 90000); timer.unref?.()
      })
      const result = await Promise.race([Promise.resolve().then(() => { context.assertCurrent(); return operation() }), deadline]); context.assertCurrent(); return result
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort) }
  }
  private context(generation: number, sourceSteamId: string): StatusCopyBackendContext {
    const controller = this.controller!; const target = { accountId: this.value.accountId!, steamId: this.value.targetSteamId! }
    let anchor: StatusCopyLocalContext | null = null
    const assertCurrent = () => { this.current(generation); if (this.controller !== controller || controller.signal.aborted || this.value.settings.sourceSteamId !== sourceSteamId) throw failure('COPY_SESSION_CHANGED') }
    return { target, sourceSteamId, signal: controller.signal, assertCurrent, checkLocal: async () => {
      assertCurrent(); let local: StatusCopyLocalContext
      try { local = await this.readLocal() } catch { assertCurrent(); throw failure('COPY_LOCAL_UNAVAILABLE') }
      assertCurrent()
      if (!local || !individual(local.steamId) || !Number.isInteger(local.appId) || local.appId < 0 || local.appId > 0xffffff) throw failure('COPY_LOCAL_UNAVAILABLE')
      if (local.steamId === target.steamId) throw failure('COPY_TARGET_IS_LOCAL')
      if (anchor && (anchor.steamId !== local.steamId || anchor.steamPid !== local.steamPid || anchor.steamStartTicks !== local.steamStartTicks)) throw failure('COPY_SESSION_CHANGED')
      anchor ??= { ...local }; return { ...local }
    } }
  }
  private newBackend(mode: StatusCopyMode): StatusCopyBackend {
    if (this.options.createBackend) return this.options.createBackend(mode)
    if (mode !== 'toolbox' || !this.options.getToolboxLogin) throw failure(mode === 'asf' ? 'COPY_ASF_INCOMPATIBLE' : 'COPY_LOGIN_REQUIRED')
    return new ToolboxStatusCopyBackend({ getToolboxLogin: this.options.getToolboxLogin, readLocalContext: this.options.readLocalContext })
  }
  async save(input: StatusCopyInput): Promise<StatusCopySnapshot> {
    await this.loading
    const settings = this.settings(input)
    if (this.operation || this.value.busy) throw failure('COPY_BUSY')
    const token = {}; this.operation = token; this.value.busy = true
    const previous = this.preferences.get(input.accountId)
    let committed = false
    try {
      if (this.backend) { this.generation++; await this.retire(); this.action(input) }
      const generation = this.generation
      if (!this.preferences.has(input.accountId) && this.preferences.size >= 64) throw failure('COPY_INVALID_INPUT')
      this.preferences.set(input.accountId, settings)
      await this.persist(); committed = true; this.action(input)
      if (this.generation !== generation || this.operation !== token) throw failure('COPY_SESSION_CHANGED')
      this.value.settings = publicSettings(settings); Object.assign(this.value, blank(), { phase: 'idle', error: null })
    } catch (caught) {
      if (!committed && this.preferences.get(input.accountId) === settings) { if (previous) this.preferences.set(input.accountId, previous); else this.preferences.delete(input.accountId) }
      throw caught
    }
    finally {
      if (this.operation === token) { this.operation = null; this.value.busy = false }
      if (this.value.accountId === input.accountId && !this.operation && !this.backend && !this.retirementUnknown && !this.value.busy) {
        const saved = this.preferences.get(input.accountId)
        this.value.settings = saved ? publicSettings(saved) : { ...STATUS_COPY_DEFAULTS }
      }
      this.emit()
    }
    return this.state()
  }
  private async run(input: StatusCopyInput, preview: boolean): Promise<StatusCopySnapshot> {
    await this.loading
    const settings = this.settings(input)
    if (this.operation || this.value.busy) throw failure('COPY_BUSY')
    if (this.retirementUnknown) throw failure('COPY_STOP_UNCONFIRMED')
    const token = {}; this.operation = token; this.value.busy = true; this.value.error = null; this.value.phase = preview ? 'previewing' : 'starting'; this.emit()
    this.generation++; const generation = this.generation
    try {
      await this.retire(); this.action(input)
      this.controller = new AbortController(); this.value.settings = publicSettings(settings)
      const context = this.context(generation, settings.sourceSteamId)
      this.guard(context)
      await context.checkLocal()
      await this.options.beforeStart?.(); context.assertCurrent(); await context.checkLocal()
      const backend = this.newBackend(settings.mode); this.backend = backend
      if (backend instanceof ToolboxStatusCopyBackend) backend.setFailureHandler(reason => { void this.failCurrent(context, reason) })
      const report = await this.bounded(context, () => preview ? backend.preview(context, settings) : backend.start(context, settings, input.allowAsfConfigReplace === true))
      context.assertCurrent(); Object.assign(this.value, this.safeReport(report), { phase: report.waiting ? 'waiting' : preview ? 'idle' : 'following' })
      if (preview) await this.retire()
      else this.schedule(context, settings)
    } catch (caught) {
      if (this.generation === generation) {
        let reason = code(caught)
        try { await this.retire() } catch { reason = 'COPY_STOP_UNCONFIRMED' }
        this.value.phase = 'error'; this.value.error = { code: reason }
      }
    } finally { if (this.operation === token) { this.operation = null; this.value.busy = false; this.emit() } }
    return this.state()
  }
  private safeReport(report: StatusCopyReport): StatusCopyReport {
    const source = report.source
    const fields: Record<string, string> = {}
    if (source && (source.steamId !== this.value.settings.sourceSteamId || !individual(source.steamId) || !Number.isInteger(source.appId) || source.appId < 1 || source.appId > 0xffffff || !['local-source-session', 'friend-presence', 'asf-source-session'].includes(source.authority) || typeof source.observedAt !== 'string' || source.observedAt.length > 40 || !Number.isFinite(Date.parse(source.observedAt)))) throw failure('COPY_REQUEST_FAILED')
    if (source) for (const [key, value] of Object.entries(source.fields ?? {})) if (typeof value === 'string' && isStatusCopyPublicField(key) && (key !== 'steam_display' || richPresenceDisplayToken.test(value)) && isWellFormedPresenceText(value) && Buffer.byteLength(value) <= richPresenceContract.presence.valueUtf8Bytes && Object.keys(fields).length < richPresenceContract.presence.maxKeys) fields[key] = value
    const targetAppId = Number.isInteger(report.targetAppId) && report.targetAppId! > 0 && report.targetAppId! <= 0xffffff ? report.targetAppId : null
    const appliedAt = typeof report.appliedAt === 'string' && report.appliedAt.length <= 40 && Number.isFinite(Date.parse(report.appliedAt)) ? report.appliedAt : null
    return { source: source ? { steamId: source.steamId, appId: source.appId, gameName: typeof source.gameName === 'string' && !control.test(source.gameName) && source.gameName.length <= 255 ? source.gameName : null, fields, groupSize: Number.isInteger(source.groupSize) && source.groupSize! > 0 && source.groupSize! <= 2147483647 ? source.groupSize : null, observedAt: source.observedAt, authority: source.authority } : null, targetAppId, appliedAt, verification: report.verification === 'target-readback' ? 'target-readback' : 'not-verified', waiting: report.waiting === true, warnings: Array.isArray(report.warnings) ? report.warnings.filter(warning => codes.has(warning)) : [] }
  }
  private schedule(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): void {
    this.clearTimer()
    this.timer = setTimeout(() => { this.timer = null; void this.tick(context, settings) }, settings.intervalSeconds * 1000); this.timer.unref?.()
  }
  private async tick(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<void> {
    if (this.operation) return
    const token = {}; this.operation = token
    try {
      context.assertCurrent(); await context.checkLocal()
      const backend = this.backend; if (!backend) throw failure('COPY_SESSION_CHANGED')
      const report = await this.bounded(context, () => backend.tick(context, settings))
      context.assertCurrent(); Object.assign(this.value, this.safeReport(report), { phase: report.waiting ? 'waiting' : 'following', error: null }); this.schedule(context, settings)
    } catch (caught) {
      if (!context.signal.aborted) {
        let reason = code(caught); try { await this.retire() } catch { reason = 'COPY_STOP_UNCONFIRMED' }
        this.value.phase = 'error'; this.value.error = { code: reason }
      }
    } finally { if (this.operation === token) { this.operation = null; this.emit() } }
  }
  preview(input: StatusCopyInput): Promise<StatusCopySnapshot> { return this.run(input, true) }
  start(input: StatusCopyInput): Promise<StatusCopySnapshot> { return this.run(input, false) }
  async stop(input: StatusCopyAction): Promise<StatusCopySnapshot> {
    this.action(input); this.generation++; this.operation = null; this.value.busy = true; this.value.phase = 'stopping'; this.emit()
    try { await this.retire(); this.value.phase = 'idle'; this.value.error = null }
    catch { this.value.phase = 'error'; this.value.error = { code: 'COPY_STOP_UNCONFIRMED' } }
    finally { this.value.busy = false; this.emit() }
    return this.state()
  }
  async invalidate(): Promise<void> {
    this.generation++; this.operation = null
    try { await this.retire() }
    finally {
      if (this.retirementUnknown) { this.value.phase = 'error'; this.value.busy = false; this.value.error = { code: 'COPY_STOP_UNCONFIRMED' }; this.emit() }
      else {
        const active = this.options.getActiveAccount(); const saved = active ? this.preferences.get(active.id) : null
        this.value = { ...blank(), sessionId: id(), accountId: active?.id ?? null, targetSteamId: active?.steamId ?? null, settings: saved ? publicSettings(saved) : { ...STATUS_COPY_DEFAULTS }, phase: 'idle', busy: false, error: null }; this.emit()
      }
    }
  }
  async forgetAccount(accountId: string): Promise<void> {
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw failure('COPY_INVALID_INPUT')
    if (this.forgetting.has(accountId)) throw failure('COPY_BUSY')
    this.forgetting.add(accountId)
    let active = false
    try {
      await this.loading
      active = this.value.accountId === accountId
      if (active) { this.generation++; this.operation = null; this.value.busy = true; await this.retire() }
      const previous = this.preferences.get(accountId)
      this.preferences.delete(accountId)
      try { await this.persist() } catch (caught) { if (previous && !this.preferences.has(accountId)) this.preferences.set(accountId, previous); throw caught }
      if (this.value.accountId === accountId) { this.value.settings = { ...STATUS_COPY_DEFAULTS }; Object.assign(this.value, blank(), { phase: 'idle', error: null }) }
    } finally { this.forgetting.delete(accountId); if (active) this.value.busy = false; this.emit() }
  }
  async shutdown(): Promise<void> { this.disposed = true; try { await this.invalidate() } finally { await this.preferenceWrites } }
}
