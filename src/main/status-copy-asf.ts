import { createHash } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type { StatusCopyCode, StatusCopyReport, StatusCopySettingsInput } from '../shared/status-copy'
import type { StatusCopyBackend, StatusCopyBackendContext, StatusCopyLocalContext } from './status-copy-backend'

type Mode = 'Off' | 'Observe' | 'On'
interface Configuration {
  MainBot: string
  SourceBots: string[]
  AllowedApps: number[]
  StartupMode: Mode
  PollIntervalSeconds: number
}
interface Bot { name: string; steamId: string; online: boolean }
interface State {
  mode: Mode
  main: string
  source: string
  app: number
  available: boolean
  observed: string | null
  uploaded: string | null
  fields: Record<string, string>
}
interface Connection { url: string; password: string; bot: string }
interface Task {
  context: StatusCopyBackendContext
  connection: Connection
  sourceName: string
  config: Configuration | null
  previous: Configuration | null
  expectedMode: Mode
  allowReplace: boolean
  observeSince: number
  restoreAttempted: boolean
  anchor: StatusCopyLocalContext | null
  knownBots: Set<string>
}
export interface AsfStatusCopyBackendOptions { fetch?: typeof fetch; now?: () => number }

const maximumResponse = 1024 * 1024
const requestTimeout = 10_000
const control = /[\p{Cc}\u2028\u2029]/u
const configKeys = ['AllowedApps', 'MainBot', 'PollIntervalSeconds', 'SourceBots', 'StartupMode']
const publicKeys = new Set(['desc', 'status', 'activity', 'details', 'version', 'state', 'currentmap', 'map', 'mode', 'score', 'matchgrouploc', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score'])
const privateValue = /(?:[a-z][a-z0-9+.-]*\s*:\/\/|\bwww\.|\b(?:steam|https?|wss?):|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}|(?<!\d)\d{16,20}(?!\d)|\b(?:connect|join(?:_token)?|lobby|room|session|auth|token|ticket|password|secret|server|ip|address|port|id)\s*[=:]\s*\S)/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const failure = (code: StatusCopyCode): DomainError => new DomainError(code, code)
const fail = (code: StatusCopyCode): never => { throw failure(code) }
const appId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !control.test(value)
function steamId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{16}$/.test(value)) return false
  const id = BigInt(value)
  return id >> 56n === 1n && (id >> 52n & 15n) === 1n && (id >> 32n & 0xfffffn) === 1n && (id & 0xffffffffn) !== 0n
}
function mode(value: unknown): value is Mode { return value === 'Off' || value === 'Observe' || value === 'On' }
function config(value: unknown): Configuration | null {
  if (!object(value) || Object.keys(value).sort().join('|') !== configKeys.join('|')) return fail('COPY_ASF_INCOMPATIBLE')
  if (value.MainBot === '' && Array.isArray(value.SourceBots) && value.SourceBots.length === 0 && JSON.stringify(value.AllowedApps) === '[730]' && value.StartupMode === 'Observe' && value.PollIntervalSeconds === 15) return null
  if (!name(value.MainBot) || !Array.isArray(value.SourceBots) || value.SourceBots.length < 1 || value.SourceBots.length > 32 || !value.SourceBots.every(name) || new Set([value.MainBot, ...value.SourceBots]).size !== value.SourceBots.length + 1 || !Array.isArray(value.AllowedApps) || value.AllowedApps.length < 1 || value.AllowedApps.length > 32 || !value.AllowedApps.every(item => appId(item) && item !== 0) || new Set(value.AllowedApps).size !== value.AllowedApps.length || !mode(value.StartupMode) || !Number.isInteger(value.PollIntervalSeconds) || Number(value.PollIntervalSeconds) < 15 || Number(value.PollIntervalSeconds) > 120) return fail('COPY_ASF_INCOMPATIBLE')
  return { MainBot: value.MainBot, SourceBots: [...value.SourceBots], AllowedApps: [...value.AllowedApps] as number[], StartupMode: value.StartupMode, PollIntervalSeconds: Number(value.PollIntervalSeconds) }
}
function fingerprint(value: Configuration): string {
  // A mode transition persists StartupMode. Bind ownership to the route, not that transition.
  return createHash('sha256').update(JSON.stringify([value.MainBot, value.SourceBots, [...value.AllowedApps].sort((a, b) => a - b), value.PollIntervalSeconds])).digest('hex')
}
function equalConfig(left: Configuration | null, right: Configuration | null): boolean {
  return left === null || right === null ? left === right : fingerprint(left) === fingerprint(right) && left.StartupMode === right.StartupMode
}
function parseJson(text: string): unknown {
  // ASF versions can serialize UInt64 IDs as JSON numbers. Preserve integer tokens, never round them.
  let safe = ''; let index = 0
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index++
      while (index < text.length) {
        const char = text[index++]
        if (char === '\\') index++
        else if (char === '"') break
      }
      safe += text.slice(start, index)
    } else if (text[index] === '-' || /\d/.test(text[index]!)) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))
      if (!match) return fail('COPY_ASF_INCOMPATIBLE')
      const token = match[0]
      safe += /^\d{16,20}$/.test(token) ? JSON.stringify(token) : token
      index += token.length
    } else safe += text[index++]
  }
  try { return JSON.parse(safe) } catch { return fail('COPY_ASF_INCOMPATIBLE') }
}
function commandJson(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximumResponse) return fail('COPY_ASF_INCOMPATIBLE')
  const start = value.indexOf('{')
  if (start < 0 || start > 256 || value.slice(0, start).includes('}')) return fail('COPY_ASF_INCOMPATIBLE')
  return parseJson(value.slice(start).trim())
}
function safeFields(value: unknown): Record<string, string> {
  if (!object(value) || Object.keys(value).length > 20) return fail('COPY_ASF_INCOMPATIBLE')
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  const seen = new Set<string>()
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase()
    if (!(normalized === 'steam_display' || publicKeys.has(normalized))) continue
    if (typeof item !== 'string' || control.test(item) || Buffer.byteLength(item) > 255 || seen.has(normalized)) return fail('COPY_ASF_INCOMPATIBLE')
    if (normalized === 'steam_display' && !/^#[A-Za-z0-9_]{1,127}$/.test(item)) continue
    if (privateValue.test(item)) continue
    seen.add(normalized)
    fields[normalized] = item
  }
  return fields
}
function timestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return fail('COPY_ASF_INCOMPATIBLE')
  return new Date(value).toISOString()
}
function parseState(value: unknown): State {
  if (!object(value) || !mode(value.Mode) || typeof value.MainBot !== 'string' || value.MainBot.length > 128 || typeof value.SelectedSourceBot !== 'string' || value.SelectedSourceBot.length > 128 || !appId(value.ActiveAppId) || typeof value.MainAvailable !== 'boolean') return fail('COPY_ASF_INCOMPATIBLE')
  return { mode: value.Mode, main: value.MainBot, source: value.SelectedSourceBot, app: value.ActiveAppId, available: value.MainAvailable, observed: timestamp(value.ObservedAt), uploaded: timestamp(value.LastUploadAt), fields: safeFields(value.RichPresence) }
}
function validate(settings: StatusCopySettingsInput): Connection {
  if (settings.copyGroupSize) return fail('COPY_ASF_GROUP_UNSUPPORTED')
  if (settings.mode !== 'asf' || !steamId(settings.sourceSteamId) || !Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 15 || settings.intervalSeconds > 120 || !settings.asf || !name(settings.asf.botName)) return fail('COPY_INVALID_INPUT')
  const password = settings.asf.password ?? ''
  if (typeof password !== 'string' || Buffer.byteLength(password) > 4096 || control.test(password)) return fail('COPY_INVALID_INPUT')
  let url: URL
  try { url = new URL(settings.asf.url) } catch { return fail('COPY_INVALID_INPUT') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#') || /^[^:]+:\/\/[^/]*@/.test(settings.asf.url) || url.href.length > 2048) return fail('COPY_INVALID_INPUT')
  return { url: url.href.replace(/\/+$/, ''), password, bot: settings.asf.botName }
}
function waiting(warnings: StatusCopyCode[] = []): StatusCopyReport {
  return { source: null, targetAppId: null, appliedAt: null, verification: 'not-verified', waiting: true, warnings }
}

/** Only the capability-gated ASFStatusRelay 0.3 protocol is exposed, never arbitrary ASF commands. */
export class AsfStatusCopyBackend implements StatusCopyBackend {
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private task: Task | null = null
  private flight: Promise<unknown> | null = null
  private stopFlight: Promise<void> | null = null
  private stopRequested = false

  constructor(options: AsfStatusCopyBackendOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now }

  private async guard(context: StatusCopyBackendContext, expectedApp?: number, stopping = false, task?: Task): Promise<number> {
    // Retirement must still be able to stop our remote route after local Steam exits or changes account.
    if (stopping) return 0
    context.assertCurrent()
    if (context.signal.aborted || this.stopRequested) return fail('COPY_SESSION_CHANGED')
    if (!steamId(context.target.steamId) || !steamId(context.sourceSteamId) || context.target.steamId === context.sourceSteamId) return fail('COPY_SOURCE_EQUALS_TARGET')
    let local
    try { local = await context.checkLocal() } catch { return fail('COPY_LOCAL_UNAVAILABLE') }
    context.assertCurrent()
    if (context.signal.aborted || this.stopRequested) return fail('COPY_SESSION_CHANGED')
    if (local.steamId !== context.sourceSteamId) return fail('COPY_IDENTITY_MISMATCH')
    if (!appId(local.appId)) return fail('COPY_LOCAL_UNAVAILABLE')
    if (task?.anchor && (local.steamPid !== task.anchor.steamPid || local.steamStartTicks !== task.anchor.steamStartTicks)) return fail('COPY_SESSION_CHANGED')
    if (task && !task.anchor) task.anchor = { ...local }
    if (expectedApp !== undefined && local.appId !== expectedApp) return fail('COPY_SOURCE_STALE')
    return local.appId
  }

  private async request(task: Task, route: 'Bot/ASF' | 'Command', command: string | undefined, expectedApp?: number, stopping = false): Promise<unknown> {
    await this.guard(task.context, expectedApp, stopping, task)
    const controller = new AbortController()
    let timedOut = false
    let rejectTimeout!: (error: Error) => void
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject })
    const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(failure('COPY_REQUEST_FAILED')) }, requestTimeout)
    timer.unref?.()
    const abort = (): void => { controller.abort(); rejectTimeout(failure('COPY_SESSION_CHANGED')) }
    if (!stopping) task.context.signal.addEventListener('abort', abort, { once: true })
    const perform = async (): Promise<unknown> => {
      const response = await this.fetcher(`${task.connection.url}/Api/${route}`, {
        method: command === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...(command === undefined ? {} : { 'Content-Type': 'application/json' }), ...(task.connection.password ? { Authentication: task.connection.password } : {}) },
        ...(command === undefined ? {} : { body: JSON.stringify({ Command: command }) })
      })
      if (!response.ok || response.redirected || Number(response.headers.get('content-length') ?? '0') > maximumResponse || !response.body) return fail('COPY_REQUEST_FAILED')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []; let length = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          length += item.value.byteLength
          if (length > maximumResponse) return fail('COPY_REQUEST_FAILED')
          chunks.push(item.value)
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      const data = parseJson(Buffer.concat(chunks).toString('utf8'))
      if (!object(data) || data.Success !== true || !Object.hasOwn(data, 'Result')) return fail('COPY_ASF_INCOMPATIBLE')
      return data.Result
    }
    let result
    try { result = await Promise.race([perform(), timeout]) } catch (error) {
      if (!stopping && task.context.signal.aborted) return fail('COPY_SESSION_CHANGED')
      if (!timedOut && error instanceof Error && error.message === 'COPY_ASF_INCOMPATIBLE') throw error
      return fail('COPY_REQUEST_FAILED')
    } finally {
      clearTimeout(timer)
      if (!stopping) task.context.signal.removeEventListener('abort', abort)
    }
    await this.guard(task.context, expectedApp, stopping, task)
    return result
  }

  private async roster(task: Task, expectedApp?: number, stopping = false): Promise<void> {
    const value = await this.request(task, 'Bot/ASF', undefined, expectedApp, stopping)
    if (!object(value) || Object.keys(value).length > 512) return fail('COPY_ASF_INCOMPATIBLE')
    const bots: Bot[] = []
    task.knownBots = new Set(Object.entries(value).filter(([key, item]) => name(key) && object(item)).map(([key]) => key))
    for (const [key, item] of Object.entries(value)) {
      if (!name(key) || !object(item) || !steamId(item.SteamID ?? item.SSteamID) || typeof item.IsConnectedAndLoggedOn !== 'boolean') continue
      bots.push({ name: key, steamId: (item.SteamID ?? item.SSteamID) as string, online: item.IsConnectedAndLoggedOn })
    }
    const target = bots.find(item => item.name === task.connection.bot)
    if (!target || target.steamId !== task.context.target.steamId) return fail('COPY_IDENTITY_MISMATCH')
    if (stopping) return
    if (!target.online) return fail('COPY_ASF_BOT_UNAVAILABLE')
    const sources = bots.filter(item => item.steamId === task.context.sourceSteamId && item.name !== target.name)
    if (sources.length !== 1 || !sources[0]!.online) return fail('COPY_ASF_BOT_UNAVAILABLE')
    if (task.sourceName && task.sourceName !== sources[0]!.name) return fail('COPY_IDENTITY_MISMATCH')
    task.sourceName = sources[0]!.name
  }

  private async configuration(task: Task, expectedApp?: number, stopping = false): Promise<Configuration | null> {
    return config(commandJson(await this.request(task, 'Command', 'RPRELAY CONFIG', expectedApp, stopping)))
  }
  private async capabilities(task: Task, expectedApp: number): Promise<void> {
    const caps = commandJson(await this.request(task, 'Command', 'RPRELAY COPYCAPS', expectedApp))
    if (!object(caps) || Object.keys(caps).sort().join('|') !== 'groupIdentifiers|groupSize|protocol|safeFields|sources' || caps.protocol !== 1 || caps.safeFields !== true || caps.groupIdentifiers !== false || caps.groupSize !== false || caps.sources !== 'registered-bots') return fail('COPY_ASF_INCOMPATIBLE')
  }
  private async state(task: Task, expectedApp?: number, stopping = false): Promise<State> {
    return parseState(commandJson(await this.request(task, 'Command', 'RPRELAY STATE', expectedApp, stopping)))
  }
  private requireOwned(task: Task, current: Configuration | null, checkMode = true): Configuration {
    if (!task.config || !current || fingerprint(task.config) !== fingerprint(current) || (checkMode && current.StartupMode !== task.expectedMode)) return fail('COPY_ASF_CONFIG_CONFLICT')
    return current
  }
  private async confirm(task: Task, expectedApp?: number, stopping = false): Promise<State> {
    this.requireOwned(task, await this.configuration(task, expectedApp, stopping))
    const state = await this.state(task, expectedApp, stopping)
    if (state.main !== task.connection.bot || state.mode !== task.expectedMode) return fail('COPY_ASF_CONFIG_CONFLICT')
    this.requireOwned(task, await this.configuration(task, expectedApp, stopping))
    return state
  }
  private fresh(task: Task, state: State): boolean {
    if (!state.observed) return false
    const at = Date.parse(state.observed)
    return at >= task.observeSince - 1000 && at <= this.now() + 5000 && this.now() - at <= Math.max(45, (task.config?.PollIntervalSeconds ?? 15) * 3) * 1000
  }
  private report(task: Task, state: State, app: number): StatusCopyReport {
    if (!state.available || state.source !== task.sourceName) return waiting(['COPY_SOURCE_NOT_PLAYING'])
    if (!this.fresh(task, state)) return waiting(['COPY_SOURCE_STALE'])
    if (state.mode === 'On' && state.app !== app) return waiting(['COPY_SOURCE_STALE'])
    return {
      source: { steamId: task.context.sourceSteamId, appId: app, gameName: null, fields: state.fields, groupSize: null, observedAt: state.observed!, authority: 'asf-source-session' },
      targetAppId: state.mode === 'On' && state.app === app ? app : null,
      appliedAt: state.mode === 'On' && state.app === app && state.uploaded && Date.parse(state.uploaded) >= task.observeSince - 1000 ? state.uploaded : null,
      verification: 'not-verified', waiting: state.mode !== 'On' || state.app !== app, warnings: []
    }
  }
  private async setMode(task: Task, next: Mode, app?: number, stopping = false): Promise<void> {
    this.requireOwned(task, await this.configuration(task, app, stopping))
    task.expectedMode = next
    await this.request(task, 'Command', `RPRELAY ${next.toUpperCase()}`, app, stopping)
    await this.confirm(task, app, stopping)
  }
  private async applyConfig(task: Task, next: Configuration, app: number, first = false): Promise<void> {
    const current = await this.configuration(task, app)
    if (first) {
      if (current?.StartupMode === 'On') return fail('COPY_ASF_CONFIG_CONFLICT')
      if (current && ![current.MainBot, ...current.SourceBots].every(bot => task.knownBots.has(bot))) return fail('COPY_ASF_INCOMPATIBLE')
      if (current && !equalConfig(current, next) && !task.allowReplace) return fail('COPY_ASF_CONFIG_CONFLICT')
      task.previous = current
    } else this.requireOwned(task, current)
    task.config = next
    task.expectedMode = 'Observe'
    task.observeSince = this.now()
    await this.request(task, 'Command', `RPRELAY APPLY ${Buffer.from(JSON.stringify(next)).toString('base64')}`, app)
    await this.confirm(task, app)
  }
  private makeTask(context: StatusCopyBackendContext, settings: StatusCopySettingsInput, allowReplace: boolean): Task {
    if (settings.sourceSteamId !== context.sourceSteamId) return fail('COPY_IDENTITY_MISMATCH')
    return { context, connection: validate(settings), sourceName: '', config: null, previous: null, expectedMode: 'Observe', allowReplace, observeSince: this.now(), restoreAttempted: false, anchor: null, knownBots: new Set() }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.flight || this.stopFlight) return Promise.reject(failure('COPY_BUSY'))
    const flight = operation()
    this.flight = flight
    return flight.finally(() => { if (this.flight === flight) this.flight = null })
  }

  preview(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport> {
    return this.run(async () => {
      const task = this.makeTask(context, settings, false)
      const app = await this.guard(context)
      await this.capabilities(task, app)
      await this.roster(task, app)
      const current = await this.configuration(task, app)
      if (!app) return waiting(['COPY_SOURCE_NOT_PLAYING'])
      const desired: Configuration = { MainBot: task.connection.bot, SourceBots: [task.sourceName], AllowedApps: [app], StartupMode: 'Observe', PollIntervalSeconds: settings.intervalSeconds }
      if (!current || fingerprint(current) !== fingerprint(desired)) return waiting(['COPY_ASF_CONFIG_CONFLICT'])
      task.config = current; task.expectedMode = current.StartupMode; task.observeSince = 0
      return this.report(task, await this.confirm(task, app), app)
    })
  }

  start(context: StatusCopyBackendContext, settings: StatusCopySettingsInput, allowAsfConfigReplace: boolean): Promise<StatusCopyReport> {
    return this.run(async () => {
      if (this.task) return fail('COPY_BUSY')
      const task = this.makeTask(context, settings, allowAsfConfigReplace)
      const app = await this.guard(context)
      await this.capabilities(task, app)
      await this.roster(task, app)
      const existing = await this.configuration(task, app)
      if (existing?.StartupMode === 'On') return fail('COPY_ASF_CONFIG_CONFLICT')
      this.task = task
      if (!app) return waiting(['COPY_SOURCE_NOT_PLAYING'])
      return this.advance(task, settings, app)
    })
  }

  tick(context: StatusCopyBackendContext, settings: StatusCopySettingsInput): Promise<StatusCopyReport> {
    return this.run(async () => {
      const task = this.task
      const connection = validate(settings)
      if (!task || context !== task.context || settings.sourceSteamId !== task.context.sourceSteamId || connection.url !== task.connection.url || connection.bot !== task.connection.bot || connection.password !== task.connection.password || (task.config && settings.intervalSeconds !== task.config.PollIntervalSeconds)) return fail('COPY_SESSION_CHANGED')
      const app = await this.guard(context)
      await this.capabilities(task, app)
      await this.roster(task, app)
      if (!app) {
        if (task.config) {
          this.requireOwned(task, await this.configuration(task, app))
          if (task.expectedMode !== 'Off') await this.setMode(task, 'Off', app)
        }
        return waiting(['COPY_SOURCE_NOT_PLAYING'])
      }
      return this.advance(task, settings, app)
    })
  }

  private async advance(task: Task, settings: StatusCopySettingsInput, app: number): Promise<StatusCopyReport> {
    const next: Configuration = { MainBot: task.connection.bot, SourceBots: [task.sourceName], AllowedApps: [app], StartupMode: 'Observe', PollIntervalSeconds: settings.intervalSeconds }
    if (!task.config) await this.applyConfig(task, next, app, true)
    else {
      this.requireOwned(task, await this.configuration(task, app))
      if (fingerprint(task.config) !== fingerprint(next) || task.expectedMode === 'Off') {
        if (task.expectedMode !== 'Off') await this.setMode(task, 'Off', app)
        await this.applyConfig(task, next, app)
      }
    }
    const observed = await this.confirm(task, app)
    const report = this.report(task, observed, app)
    if (!report.source) return report
    if (task.expectedMode !== 'On') {
      await this.roster(task, app)
      await this.setMode(task, 'On', app)
    }
    return this.report(task, await this.confirm(task, app), app)
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight
    this.stopRequested = true
    const pending = this.flight
    const stop = async (): Promise<void> => {
      try { await pending } catch { /* An uncertain mutation still needs an ownership-checked stop. */ }
      const task = this.task
      if (!task) { this.stopRequested = false; return }
      if (!task.config) { this.task = null; this.stopRequested = false; return }
      try {
        await this.roster(task, undefined, true)
        const current = await this.configuration(task, undefined, true)
        if (task.restoreAttempted && equalConfig(current, task.previous) && task.previous) {
          const restored = await this.state(task, undefined, true)
          if (restored.main !== task.previous.MainBot || restored.mode !== task.previous.StartupMode) return fail('COPY_STOP_UNCONFIRMED')
          this.task = null; this.stopRequested = false; return
        }
        this.requireOwned(task, current, false)
        // The ON reply may have been lost; mode is deliberately not part of ownership here.
        task.expectedMode = current!.StartupMode
        await this.setMode(task, 'Off', undefined, true)
        if (task.previous) {
          if (task.previous.StartupMode === 'On') return fail('COPY_STOP_UNCONFIRMED')
          if (![task.previous.MainBot, ...task.previous.SourceBots].every(bot => task.knownBots.has(bot))) return fail('COPY_STOP_UNCONFIRMED')
          this.requireOwned(task, await this.configuration(task, undefined, true))
          task.restoreAttempted = true
          await this.request(task, 'Command', `RPRELAY APPLY ${Buffer.from(JSON.stringify(task.previous)).toString('base64')}`, undefined, true)
          if (!equalConfig(await this.configuration(task, undefined, true), task.previous)) return fail('COPY_STOP_UNCONFIRMED')
          const restored = await this.state(task, undefined, true)
          if (restored.main !== task.previous.MainBot || restored.mode !== task.previous.StartupMode) return fail('COPY_STOP_UNCONFIRMED')
        }
        this.task = null
        this.stopRequested = false
      } catch { return fail('COPY_STOP_UNCONFIRMED') }
    }
    this.stopFlight = stop().finally(() => { this.stopFlight = null })
    return this.stopFlight
  }
}
