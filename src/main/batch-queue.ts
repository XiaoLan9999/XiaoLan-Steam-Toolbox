import {
  DomainError,
  renderMessageTemplate,
  validateBatchSize,
  validateDelay,
  validateMessageTemplate
} from '../shared/domain'
import { AppEvent, BatchSummary, BatchStartInput, BatchStopCode } from '../shared/types'
import { batchInterruption } from '../shared/batch-retry-policy'
import { DeliverySeed, SqliteStore } from './store'
import { publicErrorMessage, SteamService } from './steam-service'
import { BatchRecoveryController } from './batch-recovery'
import { BatchVerificationController } from './batch-verification'

type Emit = (event: AppEvent) => void

export class BatchQueue {
  private readonly workers = new Set<string>()
  private readonly nextDeliveryAt = new Map<string, number>()
  private readonly postingAccounts = new Set<string>()
  private readonly waits = new Set<() => void>()
  private stopped = false
  private readonly recovery: BatchRecoveryController
  private readonly verification: BatchVerificationController
  private readonly verificationRuns = new Set<string>()
  private readonly verificationAccounts = new Set<string>()

  constructor(
    private readonly store: SqliteStore,
    private readonly steam: SteamService,
    private readonly emit: Emit
  ) {
    this.recovery = new BatchRecoveryController(store, steam, {
      resume: batchId => { if (!this.stopped) void this.run(batchId) },
      changed: batchId => { if (!this.stopped) this.emit({ type: 'batchProgress', batchId }) },
      isBusy: (batchId, accountId) => this.workers.has(batchId) || this.postingAccounts.has(accountId)
    })
    this.verification = new BatchVerificationController(store, steam, emit, ms => this.wait(ms))
  }

  start(input: BatchStartInput): BatchSummary {
    this.assertOpen()
    if (this.store.getActiveAccountId() !== input.accountId || !this.steam.isAuthenticated(input.accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '发送前必须登录对应 Steam 账号')
    }
    if (this.store.getActiveBatchSummary(input.accountId)) {
      throw new DomainError('BATCH_ALREADY_ACTIVE', '当前账号已有未完成批次，请先完成或取消')
    }
    if (this.postingAccounts.has(input.accountId) || this.verificationAccounts.has(input.accountId)) {
      throw new DomainError('BATCH_REQUEST_SETTLING', '当前账号仍有留言请求正在结束，请稍后再创建批次')
    }
    const template = validateMessageTemplate(input.messageTemplate)
    const delayMs = validateDelay(input.delayMs)
    const friendIds = validateBatchSize(input.friendSteamIds)
    const account = this.store.getAccount(input.accountId)
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在')
    const friends = new Map(
      this.store.getFriends(input.accountId).map((friend) => [friend.steamId, friend])
    )
    const deliveries: DeliverySeed[] = friendIds.map((friendSteamId) => {
      const friend = friends.get(friendSteamId)
      if (!friend) {
        throw new DomainError('INVALID_RECIPIENT', '收件人必须是当前账号已同步的好友')
      }
      if (this.store.isBlacklisted(input.accountId, friendSteamId)) {
        throw new DomainError('FRIEND_BLACKLISTED', '收件人中包含当前账号黑名单好友，请先移除')
      }
      return {
        friendSteamId,
        friendName: friend.displayName,
        renderedMessage: renderMessageTemplate(template, {
          friend: friend.displayName,
          account: account.displayName
        })
      }
    })
    const batch = this.store.createBatchTask(input.accountId, template, delayMs, deliveries, input.autoRetryEnabled ?? true)
    this.recovery.capture(batch.id)
    this.store.setBatchRunning(batch.id)
    this.emit({ type: 'batchProgress', batchId: batch.id })
    void this.run(batch.id)
    return this.store.getBatchSummary(batch.id)!
  }

  pause(batchId: string, code: BatchStopCode = 'MANUAL_PAUSE', message?: string): void {
    this.assertOpen()
    this.recovery.invalidate(batchId)
    this.verification.stop(batchId)
    const batch = this.store.getBatchSummary(batchId)
    if (batch?.status === 'completed' || batch?.status === 'cancelled') {
      this.wake()
      return
    }
    if (code === 'MANUAL_PAUSE') this.store.pauseBatch(batchId)
    else if (batch?.status !== 'paused' || batch.stopCode !== 'MANUAL_PAUSE') {
      this.store.pauseBatch(batchId, { code, message: message ?? '任务已暂停，需手动继续' })
    }
    this.wake()
    this.emit({ type: 'batchProgress', batchId })
  }

  resume(batchId: string): void {
    this.assertOpen()
    const batch = this.store.getBatchSummary(batchId)
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
    if (this.store.getActiveAccountId() !== batch.accountId || !this.steam.isAuthenticated(batch.accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '恢复批次前必须登录对应 Steam 账号')
    }
    if (batch.uncertain > 0 && typeof this.steam.reconcileProfileComment === 'function') {
      this.verify(batchId)
      return
    }
    if (this.store.quarantineLegacyDeniedPost(batchId)) {
      this.recovery.invalidate(batchId)
      this.wake()
      this.emit({ type: 'batchProgress', batchId })
      this.emit({ type: 'notice', level: 'warning', message: this.store.getBatchSummary(batchId)!.stopMessage! })
      if (typeof this.steam.reconcileProfileComment === 'function') this.verify(batchId)
      return
    }
    if (batch.accessDeniedUntil && Date.parse(batch.accessDeniedUntil) > Date.now()) {
      throw new DomainError('ACCESS_DENIED_COOLDOWN',
        `HTTP 403 冷却尚未结束，最早可再试：${batch.accessDeniedUntil}；手动继续、关闭自动重试或重启不会缩短冷却时间`)
    }
    this.recovery.invalidate(batchId)
    this.store.clearBatchRetryCount(batchId)
    this.store.setBatchRunning(batchId)
    this.emit({ type: 'batchProgress', batchId })
    this.wake()
    void this.run(batchId)
  }

  cancel(batchId: string): void {
    this.assertOpen()
    this.recovery.invalidate(batchId)
    this.verification.stop(batchId)
    this.store.cancelBatch(batchId)
    this.nextDeliveryAt.delete(batchId)
    this.wake()
    this.emit({ type: 'batchProgress', batchId })
    this.recovery.cleanup(batchId)
  }

  setAutoRetry(batchId: string, enabled: boolean): void {
    this.assertOpen()
    const batch = this.store.getBatchSummary(batchId)
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
    if (enabled === true && batch.autoRetryEnabled) return
    if (batch.status !== 'running' && batch.status !== 'queued') this.recovery.invalidate(batchId)
    this.store.setBatchAutoRetry(batchId, enabled)
    this.emit({ type: 'batchProgress', batchId })
  }

  pauseForSessionExpiry(accountId: string): void {
    if (this.stopped) return
    const batch = this.store.getActiveBatchSummary(accountId)
    if (!batch || batch.status === 'paused') return
    try {
      this.recovery.interrupt(batch.id, {
        code: 'SESSION_EXPIRED', message: 'Steam 网页会话失效，正在等待自动恢复', allowAuto: true
      })
      this.wake()
      this.emit({
        type: 'notice',
        level: 'warning',
        message: 'Steam 会话失效，留言批次已暂停'
      })
      this.emit({ type: 'batchProgress', batchId: batch.id })
    } catch {
      // The batch may have completed between the lookup and update.
    }
  }

  pauseForAccountChange(accountId: string): void {
    if (this.stopped) return
    const ids = new Set(this.verificationRuns)
    const active = this.store.getActiveBatchSummary(accountId)
    if (active && (['running', 'queued'].includes(active.status) || active.nextRetryAt ||
      ['checking', 'waiting'].includes(active.verification?.state ?? ''))) ids.add(active.id)
    for (const id of ids) {
      if (this.store.getBatchSummary(id)?.accountId === accountId) {
        this.pause(id, 'ACCOUNT_CHANGED', '当前账号已切换，自动核对和继续已停止，请切回后手动继续')
      }
    }
  }

  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    this.recovery.shutdown()
    this.wake()
    this.nextDeliveryAt.clear()
    for (const account of this.store.getAccounts()) {
      try {
        const batch = this.store.getActiveBatchSummary(account.id)
        if (batch && (batch.status !== 'paused' || batch.nextRetryAt)) {
          this.store.pauseBatch(batch.id, { code: 'APP_SHUTDOWN', message: '软件已退出，自动继续计划已取消，请启动后手动继续' })
        }
      } catch {
        // Startup recovery also pauses tasks if storage cannot be updated during shutdown.
      }
    }
  }

  hasPendingRequests(): boolean {
    return this.postingAccounts.size > 0 || this.verificationRuns.size > 0 || this.verificationAccounts.size > 0
  }

  verify(batchId: string): void {
    this.assertOpen()
    let batch = this.store.getBatchSummary(batchId)
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
    if (this.store.getActiveAccountId() !== batch.accountId || !this.steam.isAuthenticated(batch.accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '核对前必须登录对应 Steam 账号')
    }
    if (this.verificationRuns.has(batchId)) return
    const active = this.store.getActiveBatchSummary(batch.accountId)
    if (this.workers.has(batchId) || this.postingAccounts.has(batch.accountId) || this.verificationAccounts.has(batch.accountId) ||
      (active?.id !== batchId && active && ['running', 'queued'].includes(active.status))) {
      throw new DomainError('BATCH_REQUEST_SETTLING', '当前账号仍有任务请求正在结束，请稍后核对')
    }
    if (!['paused', 'queued', 'completed'].includes(batch.status)) {
      throw new DomainError('INVALID_BATCH_STATE', '当前任务状态不能启动核对')
    }
    if (typeof this.steam.reconcileProfileComment !== 'function') {
      throw new DomainError('VERIFICATION_UNAVAILABLE', '当前运行环境不支持只读核对')
    }
    this.store.quarantineLegacyDeniedPost(batchId)
    batch = this.store.getBatchSummary(batchId)!
    this.recovery.invalidate(batchId)
    const intent = this.recovery.capture(batchId)
    this.verificationRuns.add(batchId)
    this.verificationAccounts.add(batch.accountId)
    void this.verifyAndContinue(batch, intent).catch(error => {
      if (this.stopped) return
      try {
        if (this.recovery.isCurrent(batch!.id, intent) && batch!.status !== 'completed') {
          this.store.pauseBatch(batch!.id, { code: 'QUEUE_ERROR', message: '核对记录存储失败，自动继续已停止；未重复发送' })
        }
      } catch { /* Startup recovery preserves uncertain records if storage is unavailable. */ }
      this.emit({ type: 'notice', level: 'error', message: `留言核对已停止：${publicErrorMessage(error)}` })
      this.emit({ type: 'batchProgress', batchId: batch!.id })
    })
  }

  private async verifyAndContinue(batch: BatchSummary, intent: symbol): Promise<void> {
    const isCurrent = (): boolean => !this.stopped && this.recovery.isCurrent(batch.id, intent) &&
      this.store.getActiveAccountId() === batch.accountId && this.steam.isAuthenticated(batch.accountId) &&
      this.store.getBatchSummary(batch.id)?.status === batch.status
    let resume = false
    try {
      if (!await this.verification.verifyAll(batch.id, isCurrent) || !isCurrent()) return
      if (batch.status !== 'completed') {
        if (this.store.finishBatchIfDone(batch.id)) {
          this.emit({ type: 'batchProgress', batchId: batch.id })
          return
        }
        this.store.clearBatchRetryCount(batch.id)
        this.store.setBatchRunning(batch.id)
        this.emit({ type: 'batchProgress', batchId: batch.id })
        resume = true
      }
    } catch (error) {
      if (!isCurrent()) return
      const detail = batchInterruption(error)
      if (batch.status !== 'completed') {
        if (detail.code === 'ACCESS_DENIED' || detail.code === 'RATE_LIMITED') {
          this.store.extendBatchAccessDeniedCooldown(batch.id, detail.retryAfterMs)
        }
        this.store.pauseBatch(batch.id, { code: detail.code, message: `只读核对暂时停止，未重复发送。${publicErrorMessage(error)}` })
      }
      this.emit({ type: 'notice', level: 'warning', message: `只读核对未完成：${publicErrorMessage(error)}` })
      this.emit({ type: 'batchProgress', batchId: batch.id })
    } finally {
      this.verificationRuns.delete(batch.id)
      this.verificationAccounts.delete(batch.accountId)
      if (!this.stopped) {
        this.verification.stop(batch.id)
        if (resume && this.recovery.isCurrent(batch.id, intent) && this.store.getBatchSummary(batch.id)?.status === 'running') {
          void this.run(batch.id)
        }
      }
    }
  }

  private assertOpen(): void {
    if (this.stopped) throw new DomainError('BATCH_QUEUE_CLOSED', '留言队列已关闭')
  }

  private wake(): void {
    for (const finish of [...this.waits]) finish()
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = (): void => {
        clearTimeout(timer)
        this.waits.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.waits.add(finish)
    })
  }

  private async run(batchId: string): Promise<void> {
    if (this.stopped || this.workers.has(batchId)) return
    this.workers.add(batchId)
    let activeDeliveryId: string | null = null
    let submitted = false
    let mayRestart = true
    try {
      while (true) {
        if (this.stopped) return
        const batch = this.store.getBatchSummary(batchId)
        if (!batch || batch.status !== 'running') return
        const intent = this.recovery.capture(batchId)
        if (batch.accessDeniedUntil && Date.parse(batch.accessDeniedUntil) > Date.now()) {
          this.recovery.interrupt(batchId, { code: 'ACCESS_DENIED',
            message: 'HTTP 403 冷却尚未结束，未提交新留言；当前对象和剩余好友保留待发',
            allowAuto: true, retryAfterMs: Date.parse(batch.accessDeniedUntil) - Date.now() }, intent)
          return
        }
        if (!this.steam.isAuthenticated(batch.accountId)) {
          this.recovery.interrupt(batchId, { code: 'SESSION_PREPARATION',
            message: 'Steam 会话尚未准备完成', allowAuto: true }, intent)
          return
        }

        const nextAt = this.nextDeliveryAt.get(batchId) ?? 0
        if (nextAt > Date.now() && await waitForNextDelivery(this.store, batchId, nextAt,
          () => this.stopped, ms => this.wait(ms))) return
        if (this.stopped) return
        if (typeof this.steam.ensureSessionFresh === 'function') {
          try { await this.steam.ensureSessionFresh(batch.accountId) }
          catch (error) {
            if (this.stopped || !this.recovery.isCurrent(batchId, intent)) return
            const detail = batchInterruption(error)
            const denied = detail.code === 'ACCESS_DENIED'
            if (denied) this.store.extendBatchAccessDeniedCooldown(batchId, detail.retryAfterMs)
            this.recovery.interrupt(batchId, { code: denied && (batch.accessDeniedCount ?? 0) > 0 ? 'ACCESS_DENIED_PERSISTENT'
              : detail.code === 'QUEUE_ERROR' ? 'SESSION_PREPARATION' : detail.code,
              message: publicErrorMessage(error), allowAuto: !denied && !['ACCOUNT_CHANGED', 'LOGIN_REQUIRED'].includes(detail.code),
              retryAfterMs: detail.retryAfterMs }, intent)
            return
          }
          if (this.stopped) return
          const current = this.store.getBatchSummary(batchId)
          if (!current || current.status !== 'running' || !this.recovery.isCurrent(batchId, intent)) return
          if (this.store.getActiveAccountId() !== batch.accountId || !this.steam.isAuthenticated(batch.accountId)) {
            this.recovery.interrupt(batchId, { code: 'ACCOUNT_CHANGED',
              message: '当前账号或登录状态已改变，自动继续已停止', allowAuto: false }, intent)
            return
          }
        }
        if ((batch.accessDeniedCount ?? 0) > 0 && typeof this.steam.verifyCommentSession === 'function') {
          try { await this.steam.verifyCommentSession(batch.accountId) }
          catch (error) {
            if (this.stopped || !this.recovery.isCurrent(batchId, intent)) return
            const detail = batchInterruption(error)
            if (detail.code === 'ACCESS_DENIED') this.store.extendBatchAccessDeniedCooldown(batchId, detail.retryAfterMs)
            this.recovery.interrupt(batchId, {
              code: detail.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED_PERSISTENT' : detail.code,
              message: `恢复前的登录核验未通过，尚未提交新留言。${publicErrorMessage(error)}`,
              allowAuto: detail.canRetry && detail.code !== 'ACCESS_DENIED', retryAfterMs: detail.retryAfterMs
            }, intent)
            return
          }
          if (this.stopped || !this.recovery.isCurrent(batchId, intent)) return
          const checked = this.store.getBatchSummary(batchId)
          if (checked?.status !== 'running') return
          if (this.store.getActiveAccountId() !== batch.accountId || !this.steam.isAuthenticated(batch.accountId)) {
            this.recovery.interrupt(batchId, { code: 'ACCOUNT_CHANGED',
              message: '当前账号或登录状态已改变，自动继续已停止', allowAuto: false }, intent)
            return
          }
        }
        const delivery = this.store.takeNextDelivery(batchId)
        if (!delivery) {
          this.store.finishBatchIfDone(batchId)
          this.emit({ type: 'batchProgress', batchId })
          return
        }
        activeDeliveryId = delivery.id
        submitted = false
        this.emit({ type: 'batchProgress', batchId })

        if (!this.steam.isAuthenticated(batch.accountId)) {
          this.store.resetDeliveryToPending(delivery.id)
          activeDeliveryId = null
          this.recovery.interrupt(batchId, { code: 'SESSION_PREPARATION',
            message: 'Steam 会话尚未准备完成，未提交任何留言', allowAuto: true }, intent)
          return
        }

        const noLongerFriend = !this.store.hasActiveFriend(batch.accountId, delivery.friendSteamId)
        if (noLongerFriend || this.store.isBlacklisted(batch.accountId, delivery.friendSteamId)) {
          this.store.completeDelivery(delivery.id, 'failed', {
            error: noLongerFriend
              ? '已跳过：该用户已不在当前好友列表中，未发送留言'
              : '已跳过：好友已加入当前账号黑名单，未发送留言'
          })
          this.clearRetryCountAfterProgress(batchId)
          activeDeliveryId = null
          this.store.finishBatchIfDone(batchId)
          this.emit({ type: 'batchProgress', batchId })
          continue
        }

        let shouldPause = false
        let interruption: ReturnType<typeof batchInterruption> | null = null
        let stopMessage = ''
        try {
          submitted = true
          this.postingAccounts.add(batch.accountId)
          const result = await this.steam.postProfileComment(
            batch.accountId,
            delivery.friendSteamId,
            delivery.renderedMessage,
            () => !this.stopped && this.recovery.isCurrent(batchId, intent) &&
              this.store.getBatchSummary(batchId)?.status === 'running' &&
              this.store.getDeliveryRecordById(delivery.id)?.status === 'sending',
            evidence => this.store.saveDeliveryCommentEvidence(delivery.id, evidence)
          )
          if (this.stopped) return
          this.store.completeDelivery(
            delivery.id,
            result.commentId ? 'sent_verified' : 'accepted_unverified',
            { remoteCommentId: result.commentId ?? undefined }
          )
          this.store.resetBatchAccessDenials(batchId)
          this.clearRetryCountAfterProgress(batchId)
        } catch (error) {
          if (error instanceof DomainError && error.code === 'SESSION_PREPARATION_FAILED') {
            if (this.stopped) {
              try { this.store.resetDeliveryToPending(delivery.id) } catch { /* Storage may already be closed. */ }
              return
            }
            this.store.resetDeliveryToPending(delivery.id)
            activeDeliveryId = null
            this.recovery.interrupt(batchId, { code: 'SESSION_PREPARATION',
              message: error.message, allowAuto: true, retryAfterMs: error.retryAfterMs }, intent)
            return
          }
          if (this.stopped) return
          const classification = classifyDeliveryError(error)
          interruption = batchInterruption(error)
          const accessDenied = error instanceof DomainError && error.code === 'COMMUNITY_ACCESS_DENIED'
          if (accessDenied) this.store.recordBatchAccessDenied(batchId, error.retryAfterMs)
          const current = this.store.getBatchSummary(batchId)
          if (accessDenied || (classification.pauseBatch && interruption.rejectedBeforeAcceptance && current?.autoRetryEnabled)) {
            this.store.resetDeliveryToPending(delivery.id)
          } else {
            this.store.completeDelivery(delivery.id, classification.status, { error: publicErrorMessage(error) })
            if (!classification.pauseBatch) this.clearRetryCountAfterProgress(batchId)
          }
          stopMessage = publicErrorMessage(error)
          shouldPause = classification.pauseBatch
          this.emit({
            type: 'notice',
            level: 'warning',
            message: `${delivery.friendName}：${classification.status === 'uncertain' ? '发送结果待核对，不会自动重发' : '留言失败'}。${publicErrorMessage(error)}`
          })
        } finally {
          this.postingAccounts.delete(batch.accountId)
        }
        activeDeliveryId = null
        this.nextDeliveryAt.set(batchId, Date.now() + batch.delayMs + Math.floor(Math.random() * 3_001))

        this.emit({ type: 'batchProgress', batchId })
        if (this.store.getDeliveryRecordById(delivery.id)?.status === 'uncertain' &&
          typeof this.steam.reconcileProfileComment === 'function') {
          const isCurrent = (): boolean => !this.stopped && this.recovery.isCurrent(batchId, intent) &&
            this.store.getActiveAccountId() === batch.accountId && this.steam.isAuthenticated(batch.accountId) &&
            this.store.getBatchSummary(batchId)?.status === 'running'
          if (!isCurrent()) return
          this.verificationAccounts.add(batch.accountId)
          try {
            if (!await this.verification.verifyDelivery(delivery, isCurrent)) return
            shouldPause = false
            interruption = null
            const checked = this.store.getBatchSummary(batchId)!
            if (this.store.getDeliveryRecordById(delivery.id)?.status === 'sent_verified' &&
              (!checked.accessDeniedUntil || Date.parse(checked.accessDeniedUntil) <= Date.now())) {
              this.store.resetBatchAccessDenials(batchId)
            }
          } catch (error) {
            if (!isCurrent()) return
            const detail = batchInterruption(error)
            if (detail.code === 'ACCESS_DENIED' || detail.code === 'RATE_LIMITED') {
              this.store.extendBatchAccessDeniedCooldown(batchId, detail.retryAfterMs)
            }
            this.recovery.interrupt(batchId, { code: detail.code,
              message: `只读核对暂时停止；本条不会重复发送。${publicErrorMessage(error)}`,
              allowAuto: detail.canRetry, retryAfterMs: detail.retryAfterMs }, intent)
            return
          } finally {
            this.verificationAccounts.delete(batch.accountId)
          }
        }
        if (interruption?.code === 'UNCERTAIN_RESULT' && !interruption.canRetry) {
          // An unresolved POST still stops the current worker after an in-flight pause/resume.
          this.recovery.interrupt(batchId, {
            code: 'UNCERTAIN_RESULT', message: stopMessage, allowAuto: false
          })
          return
        }
        if (this.store.finishBatchIfDone(batchId)) {
          const finished = this.store.getBatchSummary(batchId)!
          this.emit({
            type: 'notice',
            level: finished.failed ? 'warning' : 'success',
            message: `留言批次已结束：成功 ${finished.succeeded}，失败或待核对 ${finished.failed}`
          })
          this.emit({ type: 'batchProgress', batchId })
          return
        }
        if (shouldPause) {
          this.recovery.interrupt(batchId, {
            code: interruption?.code ?? 'QUEUE_ERROR', message: stopMessage || '留言请求暂时失败',
            allowAuto: interruption?.canRetry ?? false, retryAfterMs: interruption?.retryAfterMs
          }, intent)
          return
        }
      }
    } catch (error) {
      if (this.stopped) return
      mayRestart = false
      try {
        const current = this.store.getBatchSummary(batchId)
        if (activeDeliveryId && this.store.getDeliveryRecordById(activeDeliveryId)?.status === 'sending') {
          if (submitted) this.store.completeDelivery(activeDeliveryId, 'uncertain', { error: '队列异常中断，发送结果待核对；不会自动重发' })
          else this.store.resetDeliveryToPending(activeDeliveryId)
        }
        if (current?.status === 'running' || current?.status === 'queued') {
          this.recovery.interrupt(batchId, { code: 'QUEUE_ERROR',
            message: '任务队列发生错误，请检查记录后手动继续', allowAuto: false })
        }
      } catch {
        // A storage failure may prevent persistence; startup recovery handles sending records.
      }
      this.emit({ type: 'notice', level: 'error', message: `留言队列已停止：${publicErrorMessage(error)}` })
      this.emit({ type: 'batchProgress', batchId })
    } finally {
      this.workers.delete(batchId)
      if (!this.stopped) {
        try {
          const current = this.store.getBatchSummary(batchId)
          // A resume may arrive after the old worker observed pause but before its finally runs.
          if (mayRestart && current?.status === 'running') void this.run(batchId)
          else if (!current || ['completed', 'cancelled'].includes(current.status)) this.nextDeliveryAt.delete(batchId)
          this.recovery.cleanup(batchId)
        } catch {
          this.nextDeliveryAt.delete(batchId)
        }
      }
    }
  }

  private clearRetryCountAfterProgress(batchId: string): void {
    const batch = this.store.getBatchSummary(batchId)
    if (batch && !batch.nextRetryAt) this.store.clearBatchRetryCount(batchId)
  }
}

export function classifyDeliveryError(error: unknown): {
  status: 'failed' | 'uncertain'
  pauseBatch: boolean
} {
  if (error instanceof DomainError) {
    if (['SESSION_CHANGED', 'COMMENT_POST_UNCERTAIN'].includes(error.code)) return { status: 'uncertain', pauseBatch: true }
    if (['COMMUNITY_ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_CHECK_FAILED'].includes(error.code)) {
      return { status: 'failed', pauseBatch: true }
    }
  }
  const message = publicErrorMessage(error).toLowerCase()
  const rateLimited = /rate|limit|too many|\b429\b|频率|限制/.test(message)
  const sessionFailure = /not logged|login|session|access denied|expired|登录|会话/.test(message)
  const ambiguousNetworkFailure =
    /timeout|timed out|socket|econn|network|hang up|connection|fetch failed|abort|invalid json|malformed comment response|response interrupted|response exceeded the size limit|网络|连接/.test(message)
  const serverFailure = /http error 5\d\d|service unavailable|busy/.test(message)

  if (ambiguousNetworkFailure || serverFailure) {
    return { status: 'uncertain', pauseBatch: true }
  }
  if (rateLimited || sessionFailure) {
    return { status: 'failed', pauseBatch: true }
  }
  return { status: 'failed', pauseBatch: false }
}

async function waitForNextDelivery(
  store: SqliteStore,
  batchId: string,
  deadline: number,
  stopped: () => boolean,
  wait: (ms: number) => Promise<void>
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (stopped()) return true
    const batch = store.getBatchSummary(batchId)
    if (!batch || batch.status !== 'running') return true
    await wait(Math.min(250, deadline - Date.now()))
  }
  return stopped()
}
