import { randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'
import type { PersonaLockAction, PersonaLockError, PersonaLockSnapshot, PersonaLockStart } from '../shared/persona-lock'
import { personaNativeFailureCode } from '../shared/persona-lock'

export interface PersonaReadback { currentState: number; originalState: number | null; locked: boolean; restored: boolean | null }
export interface PersonaSession {
  ready: PersonaReadback
  request(op: 'read' | 'lock' | 'unlock' | 'stop'): Promise<PersonaReadback>
  close(): Promise<void>
}
export interface PersonaLockOptions {
  enableWrites?: boolean
  getActiveAccount(): { id: string; steamId: string } | null
  connect(steamId: string, signal: AbortSignal): Promise<PersonaSession>
  onChange?(state: PersonaLockSnapshot): void
  now?(): number
  checkIntervalMs?: number
}
const code = (error: unknown): PersonaLockError => {
  const value = error instanceof DomainError ? error.code : ''
  return ['PERSONA_CONTEXT_CHANGED', 'PERSONA_PRIVATE_STATE', 'PERSONA_UNCONFIRMED', 'PERSONA_BUSY'].includes(value)
    ? value as PersonaLockError : 'PERSONA_UNAVAILABLE'
}

export class PersonaLockService {
  private value: PersonaLockSnapshot = { available: false, sessionId: randomUUID(), accountId: null, steamId: null, status: 'idle', currentState: null, originalState: null, lastCheckedAt: null, restored: null, error: null, busy: false }
  private session: PersonaSession | null = null
  private timer?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private operation: Promise<unknown> | null = null
  private stopping: Promise<void> | null = null
  private closing = false
  constructor(private readonly options: PersonaLockOptions) { this.value.available = options.enableWrites === true }
  state(): PersonaLockSnapshot { return { ...this.value } }
  private emit(patch: Partial<PersonaLockSnapshot>): void {
    this.value = { ...this.value, ...patch }
    try { this.options.onChange?.(this.state()) } catch { /* UI delivery does not own the native lock. */ }
  }
  private selected(input: PersonaLockAction): { id: string; steamId: string } {
    const account = this.options.getActiveAccount()
    if (!input || input.sessionId !== this.value.sessionId || !account || account.id !== input.accountId) throw new DomainError('PERSONA_CONTEXT_CHANGED', 'PERSONA_CONTEXT_CHANGED')
    return account
  }
  private current(account: { id: string; steamId: string }, signal: AbortSignal): void {
    const active = this.options.getActiveAccount()
    if (signal.aborted || !active || active.id !== account.id || active.steamId !== account.steamId) throw new DomainError('PERSONA_CONTEXT_CHANGED', 'PERSONA_CONTEXT_CHANGED')
  }
  private apply(read: PersonaReadback): void {
    this.emit({ currentState: read.currentState, originalState: read.originalState, restored: read.restored,
      lastCheckedAt: new Date((this.options.now ?? Date.now)()).toISOString() })
  }
  async start(input: PersonaLockStart): Promise<PersonaLockSnapshot> {
    const account = this.selected(input)
    if (!this.value.available) throw new DomainError('PERSONA_UNAVAILABLE', 'PERSONA_UNAVAILABLE')
    if (input.mode !== 'snooze') throw new DomainError('PERSONA_UNAVAILABLE', 'PERSONA_UNAVAILABLE')
    if (this.operation || this.stopping || this.session || this.closing) throw new DomainError('PERSONA_BUSY', 'PERSONA_BUSY')
    const controller = new AbortController(); this.abort = controller
    this.emit({ accountId: account.id, steamId: account.steamId, status: 'checking', busy: true, error: null, nativeCode: null, restored: null })
    const work = async (): Promise<void> => {
      try {
        const session = await this.options.connect(account.steamId, controller.signal)
        this.session = session
        this.current(account, controller.signal)
        this.apply(session.ready)
        const read = await session.request('lock')
        this.current(account, controller.signal)
        this.apply(read)
        if (!read.locked || read.currentState !== 4) throw new DomainError(read.currentState === 0 || read.currentState === 7 ? 'PERSONA_PRIVATE_STATE' : 'PERSONA_UNCONFIRMED', 'PERSONA_UNCONFIRMED')
        this.emit({ status: 'locked', busy: false })
        this.schedule(account, controller)
      } catch (error) {
        this.emit({ status: 'error', busy: false, error: code(error), nativeCode: personaNativeFailureCode(error) })
        if (this.session) { try { await this.session.close() } catch { this.emit({ restored: null }) } this.session = null }
      }
    }
    this.operation = work()
    try { await this.operation } finally { this.operation = null }
    return this.state()
  }
  private schedule(account: { id: string; steamId: string }, controller: AbortController): void {
    if (controller.signal.aborted || !this.session || this.closing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const work = async (): Promise<void> => {
        try {
          this.current(account, controller.signal)
          const read = await this.session!.request('lock')
          this.current(account, controller.signal)
          this.apply(read)
          if (!read.locked || read.currentState !== 4) throw new DomainError(read.currentState === 0 || read.currentState === 7 ? 'PERSONA_PRIVATE_STATE' : 'PERSONA_UNCONFIRMED', 'PERSONA_UNCONFIRMED')
          this.schedule(account, controller)
        } catch (error) {
          this.emit({ status: 'error', busy: false, error: code(error), nativeCode: personaNativeFailureCode(error) })
          if (this.session) { try { await this.session.close() } catch { this.emit({ restored: null }) } this.session = null }
        }
      }
      this.operation = work().finally(() => { this.operation = null })
    }, Math.max(1000, Math.min(10000, this.options.checkIntervalMs ?? 5000)))
    this.timer.unref?.()
  }
  async stop(input: PersonaLockAction): Promise<PersonaLockSnapshot> {
    this.selected(input)
    await this.shutdown()
    return this.state()
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true
    if (!this.session) this.abort?.abort()
    clearTimeout(this.timer); this.timer = undefined
    this.stopping = (async () => {
      await this.operation
      const session = this.session; this.session = null
      if (session) {
        this.emit({ busy: true })
        try { this.apply(await session.request('stop')); await session.close(); this.emit({ status: 'idle', error: null }) }
        catch (error) { try { await session.close() } catch { /* Keep the unconfirmed result visible. */ } this.emit({ status: 'error', error: 'PERSONA_UNCONFIRMED', nativeCode: personaNativeFailureCode(error), restored: null }) }
      } else if (this.value.status !== 'error') this.emit({ status: 'idle' })
      this.emit({ sessionId: randomUUID(), busy: false })
    })().finally(() => { this.stopping = null; this.closing = false })
    return this.stopping
  }
}
