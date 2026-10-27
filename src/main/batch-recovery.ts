import { DomainError } from '../shared/domain'
import { batchInterruption, batchRetryDelay, MAX_ACCESS_DENIED_RETRIES, MAX_BATCH_RETRIES, MAX_BATCH_RETRY_DELAY_MS } from '../shared/batch-retry-policy'
import type { AccountView, BatchStopCode, BatchSummary } from '../shared/types'
import type { SqliteStore } from './store'

interface RecoverySteam {
  isAuthenticated(accountId: string): boolean
  ensureSessionFresh?(accountId: string): Promise<void>
  getAccountViews?(): Array<Pick<AccountView, 'id' | 'sessionState' | 'sessionMessage'>>
}

interface RecoveryCallbacks {
  resume(batchId: string): void
  changed(batchId: string): void
  isBusy(batchId: string, accountId: string): boolean
}

export interface BatchRecoveryInterruption {
  code: BatchStopCode
  message: string
  allowAuto: boolean
  retryAfterMs?: number
  advance?: boolean
}

const protectedStops = new Set<BatchStopCode>([
  'MANUAL_PAUSE', 'CANCELLED', 'APP_RESTARTED', 'ACCOUNT_CHANGED', 'APP_SHUTDOWN'
])

export class BatchRecoveryController {
  private readonly intents = new Map<string, symbol>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly attempting = new Set<string>()
  private closed = false

  constructor(
    private readonly store: Pick<SqliteStore,
      'getBatchSummary' | 'getActiveAccountId' | 'pauseBatch' | 'setBatchRunning'>
      & Partial<Pick<SqliteStore, 'extendBatchAccessDeniedCooldown'>>,
    private readonly steam: RecoverySteam,
    private readonly callbacks: RecoveryCallbacks
  ) {}

  capture(batchId: string): symbol {
    if (this.closed) return Symbol('closed batch recovery')
    let token = this.intents.get(batchId)
    if (!token) {
      token = Symbol(batchId)
      this.intents.set(batchId, token)
    }
    return token
  }

  isCurrent(batchId: string, token: symbol): boolean {
    return !this.closed && this.intents.get(batchId) === token
  }

  invalidate(batchId: string): void {
    this.clearTimer(batchId)
    if (!this.closed) this.intents.set(batchId, Symbol(batchId))
  }

  interrupt(batchId: string, reason: BatchRecoveryInterruption, token = this.capture(batchId)): void {
    if (!this.isCurrent(batchId, token)) return
    const batch = this.store.getBatchSummary(batchId)
    if (!batch || !['queued', 'running', 'paused'].includes(batch.status)) return
    if (batch.status === 'paused' && batch.stopCode && protectedStops.has(batch.stopCode)) return

    this.clearTimer(batchId)
    const message = safeMessage(reason.message)
    if (reason.code === 'UNCERTAIN_RESULT' && !reason.allowAuto) {
      this.pause(batchId, reason.code, message, batch.retryCount)
      return
    }
    if (this.store.getActiveAccountId() !== batch.accountId) {
      this.pause(batchId, 'ACCOUNT_CHANGED', '当前账号已切换，任务保持暂停，请切回原账号后手动继续', batch.retryCount)
      return
    }
    const loginMessage = this.loginRequiredMessage(batch.accountId)
    if (loginMessage) {
      this.pause(batchId, 'LOGIN_REQUIRED', loginMessage, batch.retryCount)
      return
    }
    if (reason.code === 'ACCESS_DENIED_PERSISTENT' ||
      (reason.code === 'ACCESS_DENIED' && (batch.accessDeniedCount ?? 0) > MAX_ACCESS_DENIED_RETRIES)) {
      this.pause(batchId, 'ACCESS_DENIED_PERSISTENT',
        `留言请求持续被拒绝（HTTP 403），已停止自动重试。当前对象和剩余好友保留待发；尚不能确定是好友权限、账号限制或网络拦截，请处理原因后再手动继续。${message}`,
        batch.retryCount)
      return
    }
    if (!reason.allowAuto || !batch.autoRetryEnabled || batch.pending === 0) {
      this.pause(batchId, reason.code, message, batch.retryCount)
      return
    }

    const sameIncident = batch.status === 'paused' && batch.nextRetryAt !== null && !reason.advance
    const attempt = sameIncident ? batch.retryCount : batch.retryCount + 1
    if (attempt > MAX_BATCH_RETRIES) {
      this.pause(batchId, 'RETRY_EXHAUSTED',
        `连续自动恢复已达 ${MAX_BATCH_RETRIES} 次，请检查原因后手动继续。${message}`, MAX_BATCH_RETRIES)
      return
    }
    const delay = batchRetryDelay(reason.code, attempt, reason.retryAfterMs)
    if (delay === null) {
      this.pause(batchId, reason.code,
        `服务器要求的等待时间超出自动恢复范围，请稍后手动继续。${message}`, batch.retryCount)
      return
    }
    if (batch.accessDeniedUntil && Date.parse(batch.accessDeniedUntil) - Date.now() > MAX_BATCH_RETRY_DELAY_MS) {
      this.pause(batchId, reason.code, `HTTP 403 冷却时间超出自动恢复范围，请等待后手动继续。${message}`, batch.retryCount)
      return
    }
    const nextRetryAt = new Date(Math.max(sameIncident ? Date.parse(batch.nextRetryAt!) : 0,
      batch.accessDeniedUntil ? Date.parse(batch.accessDeniedUntil) : 0, Date.now() + delay)).toISOString()
    this.store.pauseBatch(batchId, { code: reason.code, message, retryCount: attempt, nextRetryAt })
    this.callbacks.changed(batchId)
    if (this.isCurrent(batchId, token)) this.arm(batchId, token, nextRetryAt)
  }

  cleanup(batchId: string): void {
    if (this.closed) return
    const batch = this.store.getBatchSummary(batchId)
    if (batch && (!['completed', 'cancelled'].includes(batch.status) ||
      this.callbacks.isBusy(batchId, batch.accountId))) return
    this.clearTimer(batchId)
    this.intents.delete(batchId)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.intents.clear()
  }

  private pause(batchId: string, code: BatchStopCode, message: string, retryCount: number): void {
    this.store.pauseBatch(batchId, { code, message: safeMessage(message), retryCount })
    this.callbacks.changed(batchId)
  }

  private clearTimer(batchId: string): void {
    const timer = this.timers.get(batchId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(batchId)
  }

  private arm(batchId: string, token: symbol, deadline: string, pollDelay?: number): void {
    if (!this.isCurrent(batchId, token)) return
    this.clearTimer(batchId)
    const timer = setTimeout(() => {
      if (this.timers.get(batchId) === timer) this.timers.delete(batchId)
      void this.tryResume(batchId, token, deadline).catch(() => {
        // A storage failure must not create a timer loop or an unhandled rejection.
      })
    }, pollDelay ?? Math.max(0, Date.parse(deadline) - Date.now()))
    timer.unref?.()
    this.timers.set(batchId, timer)
  }

  private scheduled(batchId: string, token: symbol, deadline: string): BatchSummary | null {
    if (!this.isCurrent(batchId, token)) return null
    const batch = this.store.getBatchSummary(batchId)
    return batch?.status === 'paused' && batch.autoRetryEnabled && batch.nextRetryAt === deadline &&
      (!batch.stopCode || !protectedStops.has(batch.stopCode)) ? batch : null
  }

  private async tryResume(batchId: string, token: symbol, deadline: string): Promise<void> {
    const batch = this.scheduled(batchId, token, deadline)
    if (!batch) return
    if (Date.now() < Date.parse(deadline)) {
      this.arm(batchId, token, deadline)
      return
    }
    if (this.store.getActiveAccountId() !== batch.accountId) {
      this.interrupt(batchId, { code: 'ACCOUNT_CHANGED', message: '当前账号已切换，任务保持暂停', allowAuto: false }, token)
      return
    }
    const loginMessage = this.loginRequiredMessage(batch.accountId)
    if (loginMessage) {
      this.interrupt(batchId, { code: 'LOGIN_REQUIRED', message: loginMessage, allowAuto: false }, token)
      return
    }
    if (this.attempting.has(batchId) || this.callbacks.isBusy(batchId, batch.accountId)) {
      this.arm(batchId, token, deadline, 1_000)
      return
    }

    this.attempting.add(batchId)
    try {
      await this.steam.ensureSessionFresh?.(batch.accountId)
      const current = this.scheduled(batchId, token, deadline)
      if (!current) return
      if (this.store.getActiveAccountId() !== current.accountId) {
        this.interrupt(batchId, { code: 'ACCOUNT_CHANGED', message: '当前账号已切换，任务保持暂停', allowAuto: false }, token)
        return
      }
      const expiredMessage = this.loginRequiredMessage(current.accountId)
      if (expiredMessage) {
        this.interrupt(batchId, { code: 'LOGIN_REQUIRED', message: expiredMessage, allowAuto: false }, token)
        return
      }
      if (!this.steam.isAuthenticated(current.accountId)) {
        throw new DomainError('SESSION_PREPARATION_FAILED', 'Steam 会话仍在恢复，尚未发送留言')
      }
      if (this.callbacks.isBusy(batchId, current.accountId)) {
        this.arm(batchId, token, deadline, 1_000)
        return
      }
      this.store.setBatchRunning(batchId)
      this.callbacks.changed(batchId)
      if (this.isCurrent(batchId, token)) this.callbacks.resume(batchId)
    } catch (error) {
      if (!this.isCurrent(batchId, token) || !this.scheduled(batchId, token, deadline)) return
      const expiredMessage = this.loginRequiredMessage(batch.accountId)
      if (expiredMessage) {
        this.interrupt(batchId, { code: 'LOGIN_REQUIRED', message: expiredMessage, allowAuto: false }, token)
        return
      }
      const interruption = batchInterruption(error)
      const denied = interruption.code === 'ACCESS_DENIED'
      if (denied) this.store.extendBatchAccessDeniedCooldown?.(batchId, interruption.retryAfterMs)
      this.interrupt(batchId, { code: denied && (batch.accessDeniedCount ?? 0) > 0 ? 'ACCESS_DENIED_PERSISTENT'
        : interruption.code === 'QUEUE_ERROR' ? 'SESSION_PREPARATION' : interruption.code,
        message: safeMessage(error), allowAuto: !denied && interruption.code !== 'ACCOUNT_CHANGED',
        retryAfterMs: interruption.retryAfterMs, advance: true }, token)
    } finally {
      this.attempting.delete(batchId)
    }
  }

  private loginRequiredMessage(accountId: string): string | null {
    const account = this.steam.getAccountViews?.().find(view => view.id === accountId)
    return account && ['expired', 'offline'].includes(account.sessionState)
      ? safeMessage(`Steam 登录已失效或退出，请重新登录后手动继续。${account.sessionMessage ?? ''}`) : null
  }
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/eyJ[A-Za-z0-9._-]+/g, '[token]')
    .replace(/steamLoginSecure=[^\s;]+/gi, 'steamLoginSecure=[redacted]')
    .replace(/\b(access_token|refresh_token|sessionid)\b(\s*["']?\s*[:=]\s*["']?)[^\s,;"'&}]+/gi,
      '$1$2[redacted]').slice(0, 1_000) || '未知原因'
}
