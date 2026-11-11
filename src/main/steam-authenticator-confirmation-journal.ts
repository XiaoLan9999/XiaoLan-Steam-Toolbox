import { DomainError } from '../shared/domain'
import type { SecretCipher } from './store'
import { EncryptedAuthenticatorStateStore } from './steam-authenticator'
import type { SteamAuthenticatorConfirmationJournal } from './steam-authenticator-confirmations'

export interface SteamAuthenticatorConfirmationSafetyJournalOptions {
  path: string
  cipher: SecretCipher
  now?(): number
  capacity?: number
}
interface Row { hash: string; at: number; status: 'accepted' | 'unknown' }
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ROWS = 1024
const fail = (): DomainError => new DomainError('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE', 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE')
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
function rows(value: unknown): Map<string, Row> {
  if (!object(value) || !keys(value, ['schema', 'entries']) || value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ROWS) throw fail()
  const result = new Map<string, Row>()
  for (const item of value.entries) {
    if (!object(item) || !keys(item, ['hash', 'at', 'status']) || !hash(item.hash) || !Number.isSafeInteger(item.at) || Number(item.at) < 0 ||
      !['accepted', 'unknown'].includes(String(item.status)) || result.has(item.hash)) throw fail()
    result.set(item.hash, { hash: item.hash, at: Number(item.at), status: item.status as Row['status'] })
  }
  return result
}

// Unknown reservations survive crashes. Only proof of non-dispatch or an explicit
// endpoint rejection may remove one; elapsed time never releases an unknown.
// Main's single-instance lock must provide the sole writer for this store.
export class SteamAuthenticatorConfirmationSafetyJournal implements SteamAuthenticatorConfirmationJournal {
  private readonly store: EncryptedAuthenticatorStateStore
  private readonly ready: Promise<void>
  private readonly capacity: number
  private values = new Map<string, Row>()
  private tail: Promise<unknown> = Promise.resolve()
  private broken = false
  constructor(private readonly options: SteamAuthenticatorConfirmationSafetyJournalOptions) {
    this.capacity = options.capacity ?? MAX_ROWS
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > MAX_ROWS) throw fail()
    this.store = new EncryptedAuthenticatorStateStore(options.path, options.cipher)
    this.ready = this.load()
    void this.ready.catch(() => {})
  }
  private async load(): Promise<void> {
    try { const saved = await this.store.read(); this.values = saved === null ? new Map() : rows(saved) }
    catch { this.broken = true; throw fail() }
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw fail()
    return now
  }
  private expired(row: Row, now: number): boolean { return row.status === 'accepted' && now >= row.at && now - row.at >= RETENTION_MS }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      await this.ready
      if (this.broken) throw fail()
      return action()
    }).catch(() => { throw fail() })
    this.tail = operation.catch(() => {})
    return operation
  }
  private async commit(next: Map<string, Row>): Promise<void> {
    try { await this.store.write({ schema: 1, entries: [...next.values()] }); this.values = next }
    catch { this.broken = true; throw fail() }
  }
  has(pairHash: string): Promise<boolean> {
    if (!hash(pairHash)) return Promise.reject(fail())
    return this.serial(async () => { const row = this.values.get(pairHash); return !!row && !this.expired(row, this.now()) })
  }
  reserve(pairHash: string): Promise<boolean> {
    if (!hash(pairHash)) return Promise.reject(fail())
    return this.serial(async () => {
      const now = this.now(), current = this.values.get(pairHash)
      if (current && !this.expired(current, now)) return false
      const next = new Map([...this.values].filter(([, row]) => !this.expired(row, now)))
      if (next.size >= this.capacity) throw fail()
      next.set(pairHash, { hash: pairHash, at: now, status: 'unknown' })
      await this.commit(next)
      return true
    })
  }
  finish(pairHash: string, outcome: 'accepted' | 'rejected' | 'unknown'): Promise<void> {
    if (!hash(pairHash) || !['accepted', 'rejected', 'unknown'].includes(outcome)) return Promise.reject(fail())
    return this.serial(async () => {
      const current = this.values.get(pairHash)
      if (!current) { if (outcome === 'rejected') return; throw fail() }
      if (outcome === 'unknown' && current.status === 'unknown') return
      const next = new Map(this.values)
      if (outcome === 'rejected') next.delete(pairHash)
      else next.set(pairHash, { hash: pairHash, at: this.now(), status: outcome })
      await this.commit(next)
    })
  }
}
