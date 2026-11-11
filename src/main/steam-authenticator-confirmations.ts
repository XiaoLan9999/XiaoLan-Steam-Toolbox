import { createHash, createHmac, randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type {
  SteamAuthenticatorConfirmationAction, SteamAuthenticatorConfirmationError,
  SteamAuthenticatorConfirmationItem, SteamAuthenticatorConfirmationListInput,
  SteamAuthenticatorConfirmationRespondInput, SteamAuthenticatorConfirmationResult,
  SteamAuthenticatorConfirmationSnapshot
} from '../shared/steam-authenticator-confirmations'

export interface SteamAuthenticatorConfirmationMaterial { steamId: string; identitySecret: string; deviceId: string }
export interface SteamAuthenticatorConfirmationConnection {
  readonly steamId: string
  readonly contextId: string
  assertCurrent(): void | Promise<void>
  list(params: URLSearchParams): Promise<unknown>
  respond(params: URLSearchParams): Promise<unknown>
}
export interface SteamAuthenticatorConfirmationJournal {
  has(pairHash: string): boolean | Promise<boolean>
  reserve(pairHash: string): Promise<boolean>
  finish(pairHash: string, outcome: 'accepted' | 'rejected' | 'unknown'): Promise<void>
}
export interface SteamAuthenticatorConfirmationsOptions {
  material(entryId: string): SteamAuthenticatorConfirmationMaterial | Promise<SteamAuthenticatorConfirmationMaterial>
  connect(steamId: string): SteamAuthenticatorConfirmationConnection | Promise<SteamAuthenticatorConfirmationConnection>
  timeSeconds(): Promise<number>
  confirm(item: SteamAuthenticatorConfirmationItem, action: SteamAuthenticatorConfirmationAction, ownerSteamId: string): Promise<boolean>
  now?(): number
  leaseMs?: number
  journal?: SteamAuthenticatorConfirmationJournal
}

interface PrivateItem { item: SteamAuthenticatorConfirmationItem; nonce: string; fingerprint: string; pair: string }
interface Lease {
  entryId: string; steamId: string; materialHash: string; contextId: string
  listId: string; issuedAt: number; expiresAt: number; generation: number
  connection: SteamAuthenticatorConfirmationConnection; items: Map<string, PrivateItem>
}
const ERROR_CODES = new Set<SteamAuthenticatorConfirmationError>([
  'AUTH_CONFIRMATION_INVALID', 'AUTH_CONFIRMATION_UNAVAILABLE', 'AUTH_CONFIRMATION_IDENTITY',
  'AUTH_CONFIRMATION_CHANGED', 'AUTH_CONFIRMATION_EXPIRED', 'AUTH_CONFIRMATION_BUSY',
  'AUTH_CONFIRMATION_UNSUPPORTED', 'AUTH_CONFIRMATION_LIST_FAILED', 'AUTH_CONFIRMATION_TIME_UNAVAILABLE', 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE'
])
const fail = (code: SteamAuthenticatorConfirmationError): DomainError => new DomainError(code, code)
const safeFailure = (failure: unknown, fallback: SteamAuthenticatorConfirmationError): DomainError => {
  const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined
  return fail(typeof code === 'string' && ERROR_CODES.has(code as SteamAuthenticatorConfirmationError) ? code as SteamAuthenticatorConfirmationError : fallback)
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const entryId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const steamId = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > 76561197960265728n && BigInt(value) <= 76561197960265728n + 0xffffffffn
const uint64 = (value: unknown, zero = false): string => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(text) || BigInt(text) > 0xffffffffffffffffn || !zero && text === '0') throw fail('AUTH_CONFIRMATION_LIST_FAILED')
  return text
}
function material(value: SteamAuthenticatorConfirmationMaterial): SteamAuthenticatorConfirmationMaterial {
  if (!value || !steamId(value.steamId) || typeof value.identitySecret !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value.identitySecret) ||
    Buffer.from(value.identitySecret, 'base64').length !== 20 || Buffer.from(value.identitySecret, 'base64').toString('base64') !== value.identitySecret ||
    typeof value.deviceId !== 'string' || !/^android:[a-fA-F0-9-]{32,36}$/.test(value.deviceId)) throw fail('AUTH_CONFIRMATION_UNAVAILABLE')
  return { steamId: value.steamId, identitySecret: value.identitySecret, deviceId: value.deviceId }
}
function plain(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim()
}
function parsedList(value: unknown, owner: string): Map<string, PrivateItem> {
  if (!object(value) || !(value.success === true || value.success === 1) || value.needauth === true || value.needauth === 1 ||
    Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 || value.conf !== undefined && !Array.isArray(value.conf)) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
  const raw = (value.conf ?? []) as unknown[]
  if (raw.length > 2048) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
  const result = new Map<string, PrivateItem>()
  for (const row of raw) {
    if (!object(row)) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
    const id = uint64(row.id), nonce = uint64(row.nonce, true)
    const type = typeof row.type === 'string' && /^(0|[1-9]\d{0,4})$/.test(row.type) ? Number(row.type) : row.type
    if (!Number.isInteger(type) || Number(type) < 0 || Number(type) > 65535 || result.has(id)) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
    if (row.summary !== undefined && (!Array.isArray(row.summary) || row.summary.length > 16)) throw fail('AUTH_CONFIRMATION_LIST_FAILED')
    const item: SteamAuthenticatorConfirmationItem = { id, type: Number(type), title: plain(row.headline ?? '', 1024),
      summary: ((row.summary ?? []) as unknown[]).map(value => plain(value, 2048)), canRespond: type === 2 || type === 3 }
    if (!item.canRespond) item.blockedReason = 'unsupported-type'
    result.set(id, { item, nonce, fingerprint: hash([id, nonce, item.type, item.title, item.summary]), pair: hash(['steam-confirmation-pair-v1', owner, id, nonce]) })
  }
  return result
}
function params(value: SteamAuthenticatorConfirmationMaterial, time: number, tag: 'list' | 'accept' | 'reject'): URLSearchParams {
  const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64BE(BigInt(time))
  const key = Buffer.from(value.identitySecret, 'base64')
  try {
    const signature = createHmac('sha1', key).update(timestamp).update(tag, 'ascii').digest('base64')
    return new URLSearchParams({ p: value.deviceId, a: value.steamId, k: signature, t: String(time), m: 'react', tag })
  } finally { key.fill(0); timestamp.fill(0) }
}
const clone = (item: SteamAuthenticatorConfirmationItem): SteamAuthenticatorConfirmationItem => ({ ...item, summary: [...item.summary] })

export class SteamAuthenticatorConfirmationsService {
  private leases = new Map<string, Lease>()
  private attempted = new Set<string>()
  private generation = 0
  private busy = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly lifetime: number
  constructor(private readonly options: SteamAuthenticatorConfirmationsOptions) {
    const requested = options.leaseMs ?? 60000
    if (!Number.isFinite(requested)) throw fail('AUTH_CONFIRMATION_INVALID')
    this.lifetime = Math.max(15000, Math.min(120000, Math.floor(requested)))
  }
  invalidate(): void { this.generation++; this.leases.clear(); if (this.timer) clearTimeout(this.timer); this.timer = null }
  dispose(): void { this.disposed = true; this.invalidate() }
  private now(): number { const value = (this.options.now ?? Date.now)(); if (!Number.isFinite(value)) throw fail('AUTH_CONFIRMATION_UNAVAILABLE'); return value }
  private prune(): void {
    const now = this.now()
    for (const [key, lease] of this.leases) if (now < lease.issuedAt || now >= lease.expiresAt || lease.generation !== this.generation) this.leases.delete(key)
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.leases.size || this.disposed) return
    const end = Math.min(...[...this.leases.values()].map(value => value.expiresAt))
    this.timer = setTimeout(() => { this.timer = null; this.prune(); this.schedule() }, Math.max(1, end - this.now()))
    this.timer.unref?.()
  }
  private consume(lease: Lease): void { this.leases.delete(lease.listId); this.schedule() }
  private assertGeneration(generation: number): void { if (this.disposed || generation !== this.generation) throw fail('AUTH_CONFIRMATION_CHANGED') }
  private async current(lease: Lease, requireLease = true): Promise<SteamAuthenticatorConfirmationMaterial> {
    this.assertGeneration(lease.generation)
    if (requireLease) {
      this.prune()
      if (this.leases.get(lease.listId) !== lease) throw fail('AUTH_CONFIRMATION_EXPIRED')
    }
    if (lease.connection.steamId !== lease.steamId || lease.connection.contextId !== lease.contextId) throw fail('AUTH_CONFIRMATION_IDENTITY')
    await lease.connection.assertCurrent()
    this.assertGeneration(lease.generation)
    const value = material(await this.options.material(lease.entryId))
    this.assertGeneration(lease.generation)
    if (value.steamId !== lease.steamId || hash(value) !== lease.materialHash || lease.connection.steamId !== lease.steamId || lease.connection.contextId !== lease.contextId) throw fail('AUTH_CONFIRMATION_CHANGED')
    await lease.connection.assertCurrent()
    this.assertGeneration(lease.generation)
    if (lease.connection.steamId !== lease.steamId || lease.connection.contextId !== lease.contextId) throw fail('AUTH_CONFIRMATION_CHANGED')
    if (requireLease && (this.now() < lease.issuedAt || this.now() >= lease.expiresAt || this.leases.get(lease.listId) !== lease)) throw fail('AUTH_CONFIRMATION_EXPIRED')
    return value
  }
  private async time(): Promise<number> {
    try {
      const time = await this.options.timeSeconds()
      if (!Number.isSafeInteger(time) || time < 1) throw fail('AUTH_CONFIRMATION_TIME_UNAVAILABLE')
      return time
    } catch { throw fail('AUTH_CONFIRMATION_TIME_UNAVAILABLE') }
  }
  private snapshot(lease: Lease): SteamAuthenticatorConfirmationSnapshot {
    return { entryId: lease.entryId, ownerSteamId: lease.steamId, listId: lease.listId, listedAt: lease.issuedAt, expiresAt: lease.expiresAt,
      items: [...lease.items.values()].map(value => this.attempted.has(value.pair) ? { ...clone(value.item), canRespond: false, blockedReason: 'already-submitted' } : clone(value.item)) }
  }
  private async alreadySubmitted(pair: string): Promise<boolean> {
    if (this.attempted.has(pair)) return true
    if (!this.options.journal) return false
    try {
      const blocked = await this.options.journal.has(pair)
      if (typeof blocked !== 'boolean') throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')
      if (blocked) this.attempted.add(pair)
      return blocked
    } catch { throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE') }
  }
  async list(input: SteamAuthenticatorConfirmationListInput): Promise<SteamAuthenticatorConfirmationSnapshot> {
    if (this.disposed) throw fail('AUTH_CONFIRMATION_UNAVAILABLE')
    if (this.busy) throw fail('AUTH_CONFIRMATION_BUSY')
    if (!input || !entryId(input.entryId)) throw fail('AUTH_CONFIRMATION_INVALID')
    this.busy = true
    const generation = this.generation
    try {
      this.prune()
      for (const value of this.leases.values()) if (value.entryId === input.entryId) this.leases.delete(value.listId)
      const value = material(await this.options.material(input.entryId))
      this.assertGeneration(generation)
      const connection = await this.options.connect(value.steamId)
      this.assertGeneration(generation)
      if (!connection || connection.steamId !== value.steamId || !entryId(connection.contextId)) throw fail('AUTH_CONFIRMATION_IDENTITY')
      const issuedAt = this.now()
      const lease: Lease = { entryId: input.entryId, steamId: value.steamId, materialHash: hash(value), contextId: connection.contextId,
        listId: randomUUID(), issuedAt, expiresAt: issuedAt + this.lifetime, generation, connection, items: new Map() }
      await this.current(lease, false)
      const time = await this.time()
      await this.current(lease, false)
      const response = await connection.list(params(value, time, 'list'))
      await this.current(lease, false)
      lease.items = parsedList(response, value.steamId)
      for (const item of lease.items.values()) await this.alreadySubmitted(item.pair)
      await this.current(lease, false)
      if (this.now() >= lease.expiresAt || this.now() < lease.issuedAt) throw fail('AUTH_CONFIRMATION_EXPIRED')
      while (this.leases.size >= 32) this.leases.delete(this.leases.keys().next().value!)
      this.leases.set(lease.listId, lease); this.schedule()
      return this.snapshot(lease)
    } catch (failure) { throw safeFailure(failure, 'AUTH_CONFIRMATION_LIST_FAILED') }
    finally { this.busy = false }
  }
  async respond(input: SteamAuthenticatorConfirmationRespondInput): Promise<SteamAuthenticatorConfirmationResult> {
    if (this.busy) throw fail('AUTH_CONFIRMATION_BUSY')
    if (!input || !entryId(input.entryId) || !entryId(input.listId) || !['allow', 'cancel'].includes(input.action)) throw fail('AUTH_CONFIRMATION_INVALID')
    let id: string
    try { id = uint64(input.confirmationId) } catch { throw fail('AUTH_CONFIRMATION_INVALID') }
    const result = (outcome: SteamAuthenticatorConfirmationResult['outcome'], requestSubmitted = false): SteamAuthenticatorConfirmationResult => ({ entryId: input.entryId, listId: input.listId, confirmationId: id, action: input.action, outcome, requestSubmitted })
    this.prune()
    const lease = this.leases.get(input.listId)
    if (this.disposed || !lease || lease.entryId !== input.entryId) return result('stale')
    const selected = lease.items.get(id)
    if (!selected) return result('stale')
    if (!selected.item.canRespond) throw fail('AUTH_CONFIRMATION_UNSUPPORTED')
    if (this.attempted.has(selected.pair)) { this.consume(lease); return result('stale') }
    if (this.attempted.size >= 4096) throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')
    this.busy = true
    let submitted = false, reserved = false, journalFinished = false
    const finish = async (outcome: 'accepted' | 'rejected' | 'unknown'): Promise<void> => {
      if (!reserved || !this.options.journal) return
      try { await this.options.journal.finish(selected.pair, outcome); journalFinished = true }
      catch { throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE') }
    }
    try {
      if (await this.alreadySubmitted(selected.pair)) { this.consume(lease); return result('stale') }
      await this.current(lease)
      const approved = await this.options.confirm(clone(selected.item), input.action, lease.steamId)
      const value = await this.current(lease)
      if (approved !== true) return result('cancelled')
      const listTime = await this.time()
      await this.current(lease)
      const refreshed = parsedList(await lease.connection.list(params(value, listTime, 'list')), lease.steamId)
      await this.current(lease)
      if (refreshed.get(id)?.fingerprint !== selected.fingerprint) { this.consume(lease); return result('stale') }
      const time = await this.time()
      const finalMaterial = await this.current(lease)
      const request = params(finalMaterial, time, input.action === 'allow' ? 'accept' : 'reject')
      request.set('op', input.action); request.append('cid[]', id); request.append('ck[]', selected.nonce)
      if (this.options.journal) {
        let claimed: boolean
        try { claimed = await this.options.journal.reserve(selected.pair) }
        catch { throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE') }
        if (typeof claimed !== 'boolean') throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')
        if (!claimed) { this.attempted.add(selected.pair); this.consume(lease); return result('stale') }
        reserved = true
        await this.current(lease)
      }
      this.consume(lease)
      this.attempted.add(selected.pair); submitted = true
      const response = await lease.connection.respond(request)
      await this.current(lease, false)
      if (!object(response) || response.needauth === true || response.needauth === 1) { await finish('unknown'); return result('unknown', true) }
      if (response.success === true || response.success === 1) { await finish('accepted'); return result('accepted', true) }
      if (response.success === false || response.success === 0) { await finish('rejected'); this.attempted.delete(selected.pair); return result('rejected', true) }
      await finish('unknown')
      return result('unknown', true)
    } catch (failure) {
      this.consume(lease)
      let safetyFailed = false
      if (reserved && !journalFinished) {
        try { await finish(submitted ? 'unknown' : 'rejected') } catch { safetyFailed = true }
      }
      if (!submitted && (safetyFailed || safeFailure(failure, 'AUTH_CONFIRMATION_CHANGED').code === 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')) throw fail('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')
      return result(submitted ? 'unknown' : 'stale', submitted)
    } finally { this.busy = false }
  }
}
