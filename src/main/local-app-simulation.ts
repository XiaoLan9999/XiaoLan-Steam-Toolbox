import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DomainError } from '../shared/domain'
import type { GameStatusAppInfo } from '../shared/game-status'
import { isGameStatusPresenceParameter, validateGameStatusPresence } from '../shared/game-status-presence'
import { richPresenceContract as contract, isWellFormedPresenceText, richPresenceDisplayToken } from '../shared/rich-presence-contract'
import { GROUP_SIZE_KEY, readGroupSize, validGroupSize } from '../shared/game-status-group'
import { validateExperimentalPresence } from '../shared/local-app-experimental'
import { readGameStatusAppInfo } from './game-status-apps'
import type { LocalAppSimulationAction, LocalAppSimulationErrorCode, LocalAppSimulationInspectInput, LocalAppSimulationSnapshot, LocalAppSimulationStartInput } from '../shared/local-app-simulation'
import { readLocalAppMetadata } from './local-app-simulation-metadata'
import { readLocalAppSimulationContext, sameLocalAppSteam, validLocalAppContext, type LocalAppSimulationContext } from './local-app-simulation-context'

const messages: Record<LocalAppSimulationErrorCode, string> = {
  LOCAL_APP_CONTEXT_CHANGED: '工具箱账号、本机 Steam 或模拟任务已变化，已停止旧操作。',
  LOCAL_APP_CONTEXT_UNAVAILABLE: '无法核实本机 Steam 与游戏状态，未继续模拟。',
  LOCAL_APP_GAME_ACTIVE: 'Steam 已将目标 AppID 标记为运行中，请使用真实游戏状态工具修改，或停止该 AppID 后再启动模拟',
  LOCAL_APP_BUSY: '本机模拟操作尚未结束，请稍候。',
  LOCAL_APP_INVALID_INPUT: '请输入有效的 Steam AppID，并检查官方模板或实验性公开字段。',
  LOCAL_APP_METADATA_UNAVAILABLE: '暂时无法读取官方游戏信息，请重试。',
  LOCAL_APP_TEMPLATE_UNAVAILABLE: '尚未取得该游戏的官方状态模板。可重试读取，或显式选择实验性手动模式尝试公开字段。',
  LOCAL_APP_WORKER_UNAVAILABLE: '本机模拟组件缺失或不可用，请检查工具箱文件是否完整。',
  LOCAL_APP_PROFILE_UNSUPPORTED: '当前 Steam 客户端版本尚未适配，已拒绝使用不匹配的接口。请更新工具箱；这不是目标游戏未安装。',
  LOCAL_APP_NOT_LICENSED: '当前 Steam 会话未确认此 AppID 的可用许可。请核对账号游戏许可；模拟无需先下载或安装目标游戏。',
  LOCAL_APP_INIT_FAILED: '本机 Steam 接口初始化失败。请确认 Steam 已正常运行并登录；未自动改用个人 CM 登录。',
  LOCAL_APP_IDENTITY_MISMATCH: '本机 Steam 返回的账号身份与工具箱所选账号不同，未继续模拟。',
  LOCAL_APP_APP_MISMATCH: 'Steam 未建立请求 AppID 的本机接口上下文，未继续模拟。',
  LOCAL_APP_DLL_INVALID: '本机 Steam 客户端 DLL 未通过完整性校验，未加载该文件。',
  LOCAL_APP_PROTOCOL_INVALID: '本机模拟组件响应异常，已停止操作。',
  LOCAL_APP_TIMEOUT: '本机模拟组件响应超时，已停止操作。',
  LOCAL_APP_EXITED: '本机模拟组件已退出，请重新启动模拟。',
  LOCAL_APP_SET_REJECTED: 'Steam 未接受全部公开状态字段，已停止模拟，未自动重发。',
  LOCAL_APP_STOP_FAILED: '尚未确认旧模拟组件已经退出，暂不启动替代组件。',
  LOCAL_APP_LIVE_RESTORE_REQUIRED: '真实游戏仍有锁定或恢复记录，请先解除锁定并安全恢复，再启动本机模拟。'
}
const failure = (code: LocalAppSimulationErrorCode) => new DomainError(code, messages[code])
const safeError = (error: unknown): DomainError => error instanceof DomainError && Object.hasOwn(messages, error.code) ? failure(error.code as LocalAppSimulationErrorCode) : failure('LOCAL_APP_WORKER_UNAVAILABLE')
const appIdValid = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffff
const textValid = (value: unknown): value is string => typeof value === 'string' && isWellFormedPresenceText(value) && Buffer.byteLength(value) <= contract.presence.valueUtf8Bytes
const fieldValid = (key: string) => key === 'steam_display' || key === GROUP_SIZE_KEY || isGameStatusPresenceParameter(key)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = () => randomBytes(24).toString('hex')
const noop = () => {}
const interfaces = { client: 'SteamClient021', user: 'SteamUser023', friends: 'SteamFriends018', utils: 'SteamUtils010', apps: 'STEAMAPPS_INTERFACE_VERSION008' }
const workerCodes = new Set(['LOCAL_APP_ARGUMENTS_INVALID', 'LOCAL_APP_DLL_INVALID', 'LOCAL_APP_PROFILE_UNSUPPORTED', 'LOCAL_APP_INIT_FAILED', 'LOCAL_APP_IDENTITY_MISMATCH', 'LOCAL_APP_APP_MISMATCH', 'LOCAL_APP_NOT_LICENSED', 'LOCAL_APP_CONTEXT_CHANGED', 'LOCAL_APP_CONTEXT_UNAVAILABLE', 'LOCAL_APP_SET_REJECTED', 'LOCAL_APP_READ_FAILED', 'LOCAL_APP_PROTOCOL_INVALID', 'LOCAL_APP_TIMEOUT', 'LOCAL_APP_INTERNAL_ERROR'])
export interface LocalAppSimulationRead { fields: Record<string, string>; localizedString: string | null; verificationSource: 'local-cache' }
const catalogCodes = contract.lookup.catalogCodes
export type LocalAppCatalogCode = 'LOCAL_APP_CATALOG_UNAVAILABLE' | 'LOCAL_APP_CATALOG_TIMEOUT' | 'LOCAL_APP_CATALOG_RESPONSE_INVALID' | 'LOCAL_APP_CATALOG_CANCELLED' | 'LOCAL_APP_CATALOG_LANGUAGE_MISSING' | 'LOCAL_APP_CATALOG_APP_MISMATCH'
export interface LocalAppCatalogResult { tokens: Record<string, string>; available?: boolean; code?: LocalAppCatalogCode; steamResult?: number }
export interface LocalAppSimulationHost {
  begin(context: LocalAppSimulationContext, appId: number, permitted: () => boolean): Promise<LocalAppSimulationRead>
  apply(changes: Record<string, string | null>, permitted: () => boolean): Promise<LocalAppSimulationRead>
  read(permitted: () => boolean): Promise<LocalAppSimulationRead>
  catalog?(language: 'schinese' | 'english', permitted: () => boolean): Promise<LocalAppCatalogResult>
  stop(): void
  shutdown(): Promise<void>
  onExit?(listener: (error: DomainError) => void): () => void
  hasClientWork?(): boolean
}
export interface LocalAppHostBinding { worker: string; clientDll: string; clientSha256: string }
export interface LocalAppHostBrokerOptions {
  getWorkerPath(): string
  discover?(context: LocalAppSimulationContext): Promise<LocalAppHostBinding>
  spawn?(worker: string, args: string[]): ChildProcessWithoutNullStreams
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  retireTimeoutMs?: number
}
interface Pending { op: string; keys: string[]; promise: Promise<Record<string, unknown>>; resolve(value: Record<string, unknown>): void; reject(error: DomainError): void; timer: ReturnType<typeof setTimeout> }
interface Session {
  child: ChildProcessWithoutNullStreams
  pending: Map<string, Pending>
  decoder: StringDecoder
  buffer: string
  noise: number
  closing: boolean
  closed: boolean
  ready: boolean
  lease: ReturnType<typeof setInterval> | null
  stopTimer?: ReturnType<typeof setTimeout>
  retirement?: { promise: Promise<void>; resolve(): void; reject(error: DomainError): void; timer: ReturnType<typeof setTimeout> }
}

async function localAppHostBinding(context: LocalAppSimulationContext, getWorkerPath: () => string): Promise<LocalAppHostBinding> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
  const worker = getWorkerPath()
  if (!isAbsolute(worker)) throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
  const workerInfo = await lstat(worker)
  if (!workerInfo.isFile() || workerInfo.isSymbolicLink() || workerInfo.size > 2 * 1024 * 1024) throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
  const clientDll = await realpath(join(dirname(context.steamExe), 'steamclient64.dll'))
  const before = await lstat(clientDll)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 256 || before.size > 128 * 1024 * 1024) throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
  const bytes = await readFile(clientDll); const after = await lstat(clientDll)
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length
  if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino ||
    bytes.readUInt16LE(0) !== 0x5a4d || offset > bytes.length - 26 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
  return { worker: await realpath(worker), clientDll, clientSha256: createHash('sha256').update(bytes).digest('hex') }
}

export class LocalAppHostBroker implements LocalAppSimulationHost {
  private session: Session | null = null
  private retiring = new Set<Session>()
  private listeners = new Set<(error: DomainError) => void>()
  private starting = false
  private version = 0
  private sequence = 0
  constructor(private readonly options: LocalAppHostBrokerOptions) {}
  hasClientWork(): boolean { return this.starting || this.session !== null || this.retiring.size > 0 }
  onExit(listener: (error: DomainError) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private notify(error: DomainError): void { for (const listener of this.listeners) { try { listener(error) } catch { /* Observers do not own cleanup. */ } } }
  private reject(session: Session, error: DomainError): void {
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    session.pending.clear()
  }
  private fault(session: Session, error: DomainError): void {
    if (session.closing || session.closed) return
    this.reject(session, error); this.retire(session); this.notify(error)
  }
  private closed(session: Session): void {
    if (session.closed) return
    session.closed = true
    clearInterval(session.lease ?? undefined); clearTimeout(session.stopTimer)
    this.reject(session, failure('LOCAL_APP_EXITED'))
    if (this.session === session) this.session = null
    if (session.retirement) { clearTimeout(session.retirement.timer); this.retiring.delete(session); session.retirement.resolve() }
    if (!session.closing) this.notify(failure('LOCAL_APP_EXITED'))
  }
  private retire(session: Session): void {
    if (session.closing || session.closed) return
    session.closing = true
    if (this.session === session) this.session = null
    clearInterval(session.lease ?? undefined)
    this.reject(session, failure('LOCAL_APP_CONTEXT_CHANGED'))
    let resolve!: () => void; let reject!: (error: DomainError) => void
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    void promise.catch(noop)
    const timer = setTimeout(() => reject(failure('LOCAL_APP_STOP_FAILED')), this.options.retireTimeoutMs ?? 5000); timer.unref?.()
    session.retirement = { promise, resolve, reject, timer }; this.retiring.add(session)
    try { session.child.stdin.write(JSON.stringify({ v: 1, requestId: `stop_${++this.sequence}`, op: 'stop' }) + '\n') } catch { /* Graceful exit remains bounded below. */ }
    session.stopTimer = setTimeout(() => { if (!session.closed) { try { session.child.kill() } catch { /* A failed kill is not confirmed exit. */ } } }, this.options.stopTimeoutMs ?? 2500)
    session.stopTimer.unref?.()
  }
  stop(): void { this.version++; if (this.session) this.retire(this.session) }
  async shutdown(): Promise<void> {
    this.stop()
    while (this.retiring.size) {
      const results = await Promise.allSettled([...this.retiring].map(session => session.retirement!.promise))
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected) throw rejected.reason
    }
  }
  private receive(session: Session, chunk: Buffer | string): void {
    if (session.closed || session.closing) return
    session.buffer += typeof chunk === 'string' ? chunk : session.decoder.write(chunk)
    if (Buffer.byteLength(session.buffer) > contract.transport.receiveBufferBytes) { this.fault(session, failure('LOCAL_APP_PROTOCOL_INVALID')); return }
    let newline: number
    while ((newline = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, newline).replace(/\r$/, ''); session.buffer = session.buffer.slice(newline + 1)
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > contract.transport.catalogFrameBytes) { this.fault(session, failure('LOCAL_APP_PROTOCOL_INVALID')); return }
      if (session.closing) continue
      if (!line.startsWith('{')) { session.noise += Buffer.byteLength(line); if (session.noise > 128 * 1024) this.fault(session, failure('LOCAL_APP_PROTOCOL_INVALID')); continue }
      try {
        const message = JSON.parse(line) as Record<string, unknown>
        if (!object(message) || message.v !== 1 || typeof message.requestId !== 'string') throw new Error()
        if (message.op === 'lifecycle' && message.requestId === 'lifecycle') continue
        const pending = session.pending.get(message.requestId)
        if (lineBytes > contract.transport.ordinaryFrameBytes && pending?.op !== 'catalog') throw new Error()
        if (!pending || typeof message.ok !== 'boolean' || typeof message.mayHaveWritten !== 'boolean' || !Array.isArray(message.acceptedKeys) || message.acceptedKeys.length > contract.presence.maxKeys || message.acceptedKeys.some(key => typeof key !== 'string' || !fieldValid(key)) || new Set(message.acceptedKeys).size !== message.acceptedKeys.length) throw new Error()
        if (!message.ok) {
          if (message.op !== pending.op && message.op !== 'error' || typeof message.code !== 'string' || !workerCodes.has(message.code) ||
            message.acceptedKeys.some(key => !pending.keys.includes(key)) || message.acceptedKeys.length > 0 && !message.mayHaveWritten || message.mayHaveWritten && pending.op !== 'applied') throw new Error()
          const code: LocalAppSimulationErrorCode = Object.hasOwn(messages, message.code) ? message.code as LocalAppSimulationErrorCode : message.code === 'LOCAL_APP_ARGUMENTS_INVALID' ? 'LOCAL_APP_INVALID_INPUT' : 'LOCAL_APP_WORKER_UNAVAILABLE'
          this.fault(session, failure(code)); return
        }
        if (message.op !== pending.op) throw new Error()
        if (pending.op === 'ready' && (message.mayHaveWritten || message.identityMatch !== true || message.appMatch !== true || message.licensed !== true || !object(message.selectedInterfaces) || Object.keys(interfaces).some(key => message.selectedInterfaces && (message.selectedInterfaces as Record<string, unknown>)[key] !== interfaces[key as keyof typeof interfaces]) || message.acceptedKeys.length)) throw new Error()
        if (pending.op === 'applied' && (pending.keys.length !== message.acceptedKeys.length || pending.keys.some(key => !(message.acceptedKeys as string[]).includes(key)))) throw new Error()
        if (pending.op === 'catalog' && (message.mayHaveWritten || message.acceptedKeys.length)) throw new Error()
        clearTimeout(pending.timer); session.pending.delete(message.requestId); pending.resolve(message)
      } catch { this.fault(session, failure('LOCAL_APP_PROTOCOL_INVALID')); return }
    }
  }
  private pending(session: Session, requestId: string, op: string, keys: string[] = []): Promise<Record<string, unknown>> {
    let resolve!: (value: Record<string, unknown>) => void; let reject!: (error: DomainError) => void
    const promise = new Promise<Record<string, unknown>>((done, failed) => { resolve = done; reject = failed })
    const timer = setTimeout(() => this.fault(session, failure('LOCAL_APP_TIMEOUT')), this.options.requestTimeoutMs ?? 12000); timer.unref?.()
    session.pending.set(requestId, { op, keys, promise, resolve, reject, timer })
    return promise
  }
  private async request(op: 'ping' | 'read' | 'apply' | 'catalog', permitted: () => boolean, changes?: Record<string, string | null>, language?: 'schinese' | 'english'): Promise<Record<string, unknown>> {
    const session = this.session
    if (!session || !session.ready || session.closing || !permitted()) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    const heartbeat = [...session.pending.values()].find(pending => pending.op === 'pong')
    if (heartbeat) await heartbeat.promise.catch(noop)
    if (this.session !== session || session.closing || !permitted()) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    if (session.pending.size) throw failure('LOCAL_APP_BUSY')
    const requestId = String(++this.sequence)
    const frame = JSON.stringify({ v: 1, requestId, op, ...(changes ? { changes } : {}), ...(language ? { language } : {}) })
    if (Buffer.byteLength(frame) > contract.transport.requestLineBytes) throw failure('LOCAL_APP_INVALID_INPUT')
    const pending = this.pending(session, requestId, op === 'ping' ? 'pong' : op === 'apply' ? 'applied' : op, Object.keys(changes ?? {}))
    try { session.child.stdin.write(frame + '\n') }
    catch { this.fault(session, failure('LOCAL_APP_EXITED')) }
    const message = await pending
    if (this.session !== session || !permitted()) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    return message
  }
  async begin(context: LocalAppSimulationContext, appId: number, permitted: () => boolean): Promise<LocalAppSimulationRead> {
    if (this.starting || this.session) throw failure('LOCAL_APP_BUSY')
    this.starting = true
    const version = this.version
    try {
      while (this.retiring.size) await Promise.all([...this.retiring].map(session => session.retirement!.promise))
      if (!permitted() || this.version !== version || !validLocalAppContext(context) || !appIdValid(appId)) throw failure('LOCAL_APP_CONTEXT_CHANGED')
      const binding = await (this.options.discover ?? (value => localAppHostBinding(value, this.options.getWorkerPath)))(context)
      if (!permitted() || this.version !== version) throw failure('LOCAL_APP_CONTEXT_CHANGED')
      if (!binding || !isAbsolute(binding.worker) || !isAbsolute(binding.clientDll) || !/^[a-f0-9]{64}$/.test(binding.clientSha256)) throw failure('LOCAL_APP_WORKER_UNAVAILABLE')
      const args = ['--client-dll', binding.clientDll, '--client-sha256', binding.clientSha256, '--app-id', String(appId), '--steam-id', context.steamId, '--owner-pid', String(context.ownerPid), '--owner-start', context.ownerStartTicks, '--steam-pid', String(context.steamPid), '--steam-start', context.steamStartTicks]
      const child = (this.options.spawn ?? ((worker, values) => spawn(worker, values, { windowsHide: true, stdio: 'pipe' })))(binding.worker, args)
      const session: Session = { child, pending: new Map(), decoder: new StringDecoder('utf8'), buffer: '', noise: 0, closing: false, closed: false, ready: false, lease: null }
      this.session = session
      const ready = this.pending(session, 'startup', 'ready')
      child.stdout.on('data', chunk => this.receive(session, chunk))
      child.stderr.on('data', chunk => { session.noise += Buffer.byteLength(chunk); if (session.noise > 128 * 1024) this.fault(session, failure('LOCAL_APP_PROTOCOL_INVALID')) })
      child.on('error', () => this.fault(session, failure('LOCAL_APP_EXITED')))
      child.on('close', () => this.closed(session))
      child.stdin.on('error', () => this.fault(session, failure('LOCAL_APP_EXITED')))
      await ready
      if (this.session !== session || this.version !== version || !permitted()) { this.retire(session); throw failure('LOCAL_APP_CONTEXT_CHANGED') }
      session.ready = true
      session.lease = setInterval(() => {
        if (!session.pending.size && !session.closing) void this.request('ping', permitted).catch(error => this.fault(session, safeError(error)))
      }, 5000); session.lease.unref?.()
      return await this.read(permitted)
    } finally { this.starting = false }
  }
  async read(permitted: () => boolean): Promise<LocalAppSimulationRead> {
    const message = await this.request('read', permitted)
    const localizedValid = message.localizedString === null || (typeof message.localizedString === 'string' && isWellFormedPresenceText(message.localizedString) && Buffer.byteLength(message.localizedString) <= contract.presence.localizedReadUtf8Bytes)
    if (!object(message.fields) || Object.keys(message.fields).length > contract.presence.maxKeys || !Number.isInteger(message.keyCount) || Number(message.keyCount) < Object.keys(message.fields).length || Number(message.keyCount) > contract.presence.maxKeys || message.verificationSource !== 'local-cache' || !localizedValid || Object.entries(message.fields).some(([key, value]) => !fieldValid(key) || !textValid(value) || key === GROUP_SIZE_KEY && readGroupSize(value) === null)) {
      if (this.session) this.fault(this.session, failure('LOCAL_APP_PROTOCOL_INVALID'))
      throw failure('LOCAL_APP_PROTOCOL_INVALID')
    }
    return { fields: { ...message.fields } as Record<string, string>, localizedString: message.localizedString as string | null, verificationSource: 'local-cache' }
  }
  async apply(changes: Record<string, string | null>, permitted: () => boolean): Promise<LocalAppSimulationRead> {
    if (!object(changes) || !Object.keys(changes).length || Object.keys(changes).length > contract.presence.maxKeys || Object.entries(changes).some(([key, value]) => !fieldValid(key) || (value !== null && (!textValid(value) || key === GROUP_SIZE_KEY && readGroupSize(value) === null || key === 'steam_display' && value !== '' && !richPresenceDisplayToken.test(value))))) throw failure('LOCAL_APP_INVALID_INPUT')
    await this.request('apply', permitted, changes)
    return await this.read(permitted)
  }
  async catalog(language: 'schinese' | 'english', permitted: () => boolean): Promise<LocalAppCatalogResult & { available: boolean }> {
    if (!contract.lookup.languages.includes(language)) throw failure('LOCAL_APP_INVALID_INPUT')
    const message = await this.request('catalog', permitted, undefined, language)
    if (typeof message.available !== 'boolean' || !object(message.tokens) || Object.keys(message.tokens).length > contract.catalog.tokenCount || Buffer.byteLength(JSON.stringify(message.tokens)) > contract.catalog.jsonBytes ||
      Object.entries(message.tokens).some(([key, value]) => !key || !isWellFormedPresenceText(key) || Buffer.byteLength(key) > contract.catalog.tokenNameUtf8Bytes || typeof value !== 'string' || !isWellFormedPresenceText(value.replace(/[\p{Cc}\u2028\u2029]/gu, '')) || Buffer.byteLength(value) > contract.catalog.tokenValueUtf8Bytes) ||
      message.code !== undefined && !catalogCodes.includes(message.code as LocalAppCatalogCode) ||
      message.steamResult !== undefined && (!Number.isInteger(message.steamResult) || Number(message.steamResult) < contract.lookup.steamResultMin || Number(message.steamResult) > contract.lookup.steamResultMax) ||
      message.available && (message.code !== undefined || message.steamResult !== undefined) ||
      !message.available && Object.keys(message.tokens).length > 0) throw failure('LOCAL_APP_PROTOCOL_INVALID')
    return { tokens: { ...message.tokens } as Record<string, string>, available: message.available,
      ...(message.code === undefined ? {} : { code: message.code as LocalAppCatalogCode }),
      ...(message.steamResult === undefined ? {} : { steamResult: Number(message.steamResult) }) }
  }
}

export interface LocalAppSimulationServiceOptions {
  getActiveAccount(): { id: string; steamId: string } | null
  getWorkerPath(): string
  onChange?(snapshot: LocalAppSimulationSnapshot): void
  beforeStart?(): void | Promise<void>
  readContext?(): Promise<LocalAppSimulationContext>
  readMetadata?(appId: number, language: 'schinese' | 'english', signal: AbortSignal): Promise<GameStatusAppInfo>
  host?: LocalAppSimulationHost
  pollIntervalMs?: number
}
export class LocalAppSimulationService {
  private value: LocalAppSimulationSnapshot
  private host: LocalAppSimulationHost
  private generation = 0
  private operation: object | null = null
  private context: LocalAppSimulationContext | null = null
  private desired: Record<string, string> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private metadata = new Map<number, GameStatusAppInfo>()
  private metadataAbort = new Set<AbortController>()
  private disposed = false
  private hostError: DomainError | null = null
  private shutdownFlight: Promise<void> | null = null
  private invalidations = 0
  private activityRevision = 0
  constructor(private readonly options: LocalAppSimulationServiceOptions) {
    this.value = this.empty()
    this.host = options.host ?? new LocalAppHostBroker({ getWorkerPath: options.getWorkerPath })
    this.host.onExit?.(error => {
      this.hostError = safeError(error)
      if (this.value.status !== 'running') return
      this.generation++; this.operation = null; this.context = null; this.desired = {}; this.clearTimer()
      for (const controller of this.metadataAbort) controller.abort()
      const safe = safeError(error)
      this.value.status = 'error'; this.value.busy = false; this.value.fields = {}; this.value.localizedString = null; this.value.verificationSource = null; delete this.value.submissionMode
      this.value.error = { code: safe.code as LocalAppSimulationErrorCode, message: safe.message }; this.emit()
    })
  }
  private empty(): LocalAppSimulationSnapshot {
    const account = this.options.getActiveAccount()
    return { sessionId: id(), accountId: account?.id ?? null, steamId: account?.steamId ?? null, status: 'idle', busy: false, appId: null, appInfo: null, fields: {}, localizedString: null, verificationSource: null, error: null }
  }
  snapshot(): LocalAppSimulationSnapshot { return structuredClone(this.value) }
  hasClientWork(): boolean { return this.invalidations > 0 || this.host.hasClientWork?.() === true }
  state(): LocalAppSimulationSnapshot {
    const account = this.options.getActiveAccount()
    if ((account?.id ?? null) !== this.value.accountId || (account?.steamId ?? null) !== this.value.steamId) void this.invalidate().catch(noop)
    return this.snapshot()
  }
  private emit(): void { try { this.options.onChange?.(this.snapshot()) } catch { /* Renderer observers cannot change ownership. */ } }
  private selected(input: LocalAppSimulationAction): { id: string; steamId: string } {
    const account = this.options.getActiveAccount()
    if (this.disposed || !account || !/^\d{17}$/.test(account.steamId) || !input || input.accountId !== account.id || input.sessionId !== this.value.sessionId || this.value.accountId !== account.id || this.value.steamId !== account.steamId) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    return account
  }
  private current(generation: number): boolean {
    const account = this.options.getActiveAccount()
    return !this.disposed && this.generation === generation && !!account && account.id === this.value.accountId && account.steamId === this.value.steamId
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private async checkedContext(steamId: string, targetAppId: number, ownAppId?: number): Promise<LocalAppSimulationContext> {
    let context: LocalAppSimulationContext
    try { context = await (this.options.readContext ?? readLocalAppSimulationContext)() } catch { throw failure('LOCAL_APP_CONTEXT_UNAVAILABLE') }
    if (!validLocalAppContext(context)) throw failure('LOCAL_APP_CONTEXT_UNAVAILABLE')
    if (context.steamId !== steamId) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    if (targetAppId !== ownAppId && (context.appId === targetAppId || context.activeAppIds.includes(targetAppId))) throw failure('LOCAL_APP_GAME_ACTIVE')
    if (this.context && !sameLocalAppSteam(this.context, context)) throw failure('LOCAL_APP_CONTEXT_CHANGED')
    return context
  }
  async inspect(input: LocalAppSimulationInspectInput): Promise<GameStatusAppInfo> {
    this.selected(input)
    if (!appIdValid(input.appId) || (input.language !== undefined && !['schinese', 'english'].includes(input.language))) throw failure('LOCAL_APP_INVALID_INPUT')
    if (this.operation || this.value.status === 'stopping') throw failure('LOCAL_APP_BUSY')
    const generation = this.generation; const token = {}; const controller = new AbortController()
    this.operation = token; this.metadataAbort.add(controller); this.value.busy = true; this.emit()
    try {
      let info = await (this.options.readMetadata ?? ((app, language, signal) => readLocalAppMetadata(app, language, { signal })))(input.appId, input.language ?? 'schinese', controller.signal)
      this.selected(input)
      if (!this.current(generation) || this.operation !== token || info.appId !== input.appId) throw failure('LOCAL_APP_CONTEXT_CHANGED')
      if (this.value.status === 'running' && this.value.appId === input.appId && this.host.catalog) {
        info = await this.withCatalog(info, () => this.current(generation) && this.operation === token)
        this.selected(input)
      }
      this.cache(info); this.value.appInfo = structuredClone(info); this.value.error = null
      return structuredClone(info)
    } catch (error) { throw this.setError(error instanceof DomainError ? error : failure('LOCAL_APP_METADATA_UNAVAILABLE'), generation) }
    finally { this.metadataAbort.delete(controller); if (this.operation === token) { this.operation = null; this.value.busy = false; this.emit() } }
  }
  private setError(error: unknown, generation: number): DomainError {
    const safe = safeError(error)
    if (this.current(generation)) { this.value.error = { code: safe.code as LocalAppSimulationErrorCode, message: safe.message }; this.emit() }
    return safe
  }
  private cache(info: GameStatusAppInfo): void {
    this.metadata.delete(info.appId); this.metadata.set(info.appId, structuredClone(info))
    while (this.metadata.size > 32) this.metadata.delete(this.metadata.keys().next().value!)
  }
  private async withCatalog(info: GameStatusAppInfo, permitted: () => boolean): Promise<GameStatusAppInfo> {
    if (!this.host.catalog) return info
    const current = () => { if (this.hostError) throw this.hostError; if (!permitted()) throw failure('LOCAL_APP_CONTEXT_CHANGED') }
    const templates = await readGameStatusAppInfo({ getAppRichPresenceLocalization: async (_app, language) => {
      const catalog = await this.host.catalog!(language as 'schinese' | 'english', permitted)
      return catalog
    } }, info.appId, info.language, current)
    current()
    return { ...info, templates: templates.templates, templateStatus: templates.templateStatus, language: templates.language, templateDiagnostics: templates.templateDiagnostics }
  }
  async start(input: LocalAppSimulationStartInput): Promise<LocalAppSimulationSnapshot> {
    const account = this.selected(input)
    if (!appIdValid(input.appId)) throw failure('LOCAL_APP_INVALID_INPUT')
    if (this.operation || this.value.status === 'stopping') throw failure('LOCAL_APP_BUSY')
    if (input.presence !== undefined && input.unverifiedPresence !== undefined) throw failure('LOCAL_APP_INVALID_INPUT')
    const hasGroup = input.groupSize !== undefined && input.groupSize !== null
    if (hasGroup && !validGroupSize(input.groupSize)) throw failure('LOCAL_APP_INVALID_INPUT')
    const info = this.metadata.get(input.appId) ?? null
    let fields: Record<string, string> = {}
    if (input.unverifiedPresence !== undefined) {
      try { fields = validateExperimentalPresence(input.unverifiedPresence, hasGroup ? 2 : 0) } catch { throw failure('LOCAL_APP_INVALID_INPUT') }
    } else if (input.presence !== undefined) {
      if (!info || info.templateStatus !== 'available') throw failure('LOCAL_APP_TEMPLATE_UNAVAILABLE')
      try { fields = validateGameStatusPresence(info, input.presence).fields } catch { throw failure('LOCAL_APP_INVALID_INPUT') }
    }
    if (hasGroup) {
      fields[GROUP_SIZE_KEY] = String(input.groupSize)
    }
    if (Object.keys(fields).length > contract.presence.maxKeys - (Object.hasOwn(fields, GROUP_SIZE_KEY) ? contract.presence.reservedGroupKeys - 1 : 0)) throw failure('LOCAL_APP_INVALID_INPUT')
    const generation = this.generation; const token = {}; const oldApp = this.value.status === 'running' ? this.value.appId : null
    this.activityRevision++; this.operation = token; this.hostError = null; this.clearTimer(); this.value.status = 'starting'; this.value.busy = true; this.value.error = null; this.emit()
    const permitted = () => this.current(generation) && this.operation === token
    const owned = () => this.current(generation) && this.context !== null && (this.value.status === 'starting' || this.value.status === 'running')
    const assert = () => { this.selected(input); if (!permitted()) throw failure('LOCAL_APP_CONTEXT_CHANGED'); if (this.hostError) throw this.hostError }
    try {
      assert()
      await this.options.beforeStart?.(); assert()
      if (oldApp !== null && oldApp !== input.appId) { await this.host.shutdown(); assert(); this.context = null; this.desired = {} }
      const context = await this.checkedContext(account.steamId, input.appId, oldApp ?? undefined); assert()
      let read: LocalAppSimulationRead
      if (oldApp !== input.appId || !this.context) {
        await this.host.shutdown(); assert()
        const fresh = await this.checkedContext(account.steamId, input.appId); assert()
        this.context = fresh
        read = await this.host.begin(fresh, input.appId, owned); assert()
      } else { if (!sameLocalAppSteam(this.context, context)) throw failure('LOCAL_APP_CONTEXT_CHANGED'); read = await this.host.read(owned); assert() }
      const changes: Record<string, string | null> = {}
      for (const key of Object.keys(this.desired)) if (!Object.hasOwn(fields, key)) changes[key] = null
      for (const [key, value] of Object.entries(fields)) if (this.desired[key] !== value) changes[key] = value
      const removals = Object.entries(changes).filter(([, value]) => value === null)
      const additions = Object.entries(changes).filter(([, value]) => value !== null).sort(([left], [right]) => Number(left === 'steam_display') - Number(right === 'steam_display'))
      // Free old Steam slots before adding replacements, including when a display token is removed.
      for (const entries of [removals, additions]) {
        for (let offset = 0; offset < entries.length; offset += contract.presence.maxKeys) { read = await this.host.apply(Object.fromEntries(entries.slice(offset, offset + contract.presence.maxKeys)), owned); assert() }
      }
      this.desired = { ...fields }; this.value.appId = input.appId; this.value.appInfo = info ? structuredClone(info) : null
      this.value.fields = { ...read.fields }; this.value.localizedString = read.localizedString; this.value.verificationSource = 'local-cache'
      if (input.unverifiedPresence !== undefined) this.value.submissionMode = 'experimental'
      else if (input.presence !== undefined) this.value.submissionMode = 'published-template'
      else delete this.value.submissionMode
      if (this.host.catalog && input.unverifiedPresence === undefined) {
        const base = info ?? { appId: input.appId, name: `App ${input.appId}`, iconUrl: null, language: 'schinese' as const, templates: [], templateStatus: 'unavailable' as const }
        const catalog = await this.withCatalog(base, owned); assert()
        this.cache(catalog); this.value.appInfo = catalog
      }
      this.value.status = 'running'
      this.schedule(generation)
    } catch (error) {
      if (permitted()) {
        this.context = null; this.desired = {}; this.clearTimer(); this.host.stop()
        this.value.status = 'error'; this.value.fields = {}; this.value.localizedString = null; this.value.verificationSource = null; delete this.value.submissionMode
        throw this.setError(error, generation)
      }
      throw failure('LOCAL_APP_CONTEXT_CHANGED')
    } finally { if (this.operation === token) { this.operation = null; this.value.busy = false; this.emit() } }
    return this.snapshot()
  }
  private schedule(generation: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.current(generation) || this.value.status !== 'running' || !this.context || !this.value.appId) {
        if (!this.current(generation) && !this.disposed) void this.invalidate().catch(noop)
        return
      }
      const revision = this.activityRevision
      void this.checkedContext(this.context.steamId, this.value.appId, this.value.appId).then(() => {
        if (this.current(generation) && this.activityRevision === revision && this.value.status === 'running') this.schedule(generation)
      }, error => {
        if (!this.current(generation)) { void this.invalidate().catch(noop); return }
        if (this.value.status !== 'running' || this.activityRevision !== revision) return
        const stoppedGeneration = ++this.generation
        this.operation = null
        for (const controller of this.metadataAbort) controller.abort()
        this.host.stop(); this.context = null; this.desired = {}; this.value.status = 'error'; this.value.busy = false
        this.value.fields = {}; this.value.localizedString = null; this.value.verificationSource = null; delete this.value.submissionMode; this.setError(error, stoppedGeneration)
      })
    }, this.options.pollIntervalMs ?? 3000); this.timer.unref?.()
  }
  async stop(input: LocalAppSimulationAction): Promise<LocalAppSimulationSnapshot> {
    this.selected(input)
    const generation = ++this.generation; this.operation = null; this.clearTimer()
    for (const controller of this.metadataAbort) controller.abort()
    this.context = null; this.desired = {}; this.value.status = 'stopping'; this.value.busy = true; this.emit()
    try { await this.host.shutdown(); if (this.current(generation)) { this.value.status = 'idle'; this.value.appId = null; this.value.fields = {}; this.value.localizedString = null; this.value.verificationSource = null; this.value.error = null; delete this.value.submissionMode } }
    catch { if (this.current(generation)) { this.value.status = 'error'; this.setError(failure('LOCAL_APP_STOP_FAILED'), generation) } }
    finally { if (this.current(generation)) { this.value.busy = false; this.emit() } }
    return this.snapshot()
  }
  async invalidate(): Promise<void> {
    this.invalidations++
    try {
      this.generation++; this.operation = null; this.clearTimer()
      for (const controller of this.metadataAbort) controller.abort()
      this.host.stop(); this.context = null; this.desired = {}; this.metadata.clear(); this.value = this.empty(); this.emit()
      await this.host.shutdown()
    } finally { this.invalidations-- }
  }
  shutdown(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight
    const draining = this.invalidate(); this.disposed = true; this.shutdownFlight = draining
    return draining
  }
}
