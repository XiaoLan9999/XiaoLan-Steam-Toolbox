import { setTimeout as sleep } from 'node:timers/promises'
import {
  DomainError,
  renderMessageTemplate,
  validateBatchSize,
  validateDelay,
  validateMessageTemplate
} from '../shared/domain'
import { AppEvent, BatchRecord, BatchStartInput } from '../shared/types'
import { DeliverySeed, SqliteStore } from './store'
import { publicErrorMessage, SteamService } from './steam-service'

type Emit = (event: AppEvent) => void

export class BatchQueue {
  private readonly workers = new Set<string>()
  private readonly nextDeliveryAt = new Map<string, number>()

  constructor(
    private readonly store: SqliteStore,
    private readonly steam: SteamService,
    private readonly emit: Emit
  ) {}

  start(input: BatchStartInput): BatchRecord {
    if (this.store.getActiveAccountId() !== input.accountId || !this.steam.isAuthenticated(input.accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '发送前必须登录对应 Steam 账号')
    }
    if (this.store.getActiveBatch(input.accountId)) {
      throw new DomainError('BATCH_ALREADY_ACTIVE', '当前账号已有未完成批次，请先完成或取消')
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
    const batch = this.store.createBatch(input.accountId, template, delayMs, deliveries)
    this.store.setBatchRunning(batch.id)
    this.emit({ type: 'batchProgress', batchId: batch.id })
    this.emit({ type: 'snapshotChanged' })
    void this.run(batch.id)
    return this.store.getBatch(batch.id)!
  }

  pause(batchId: string): void {
    this.store.pauseBatch(batchId)
    this.emit({ type: 'batchProgress', batchId })
    this.emit({ type: 'snapshotChanged' })
  }

  resume(batchId: string): void {
    const batch = this.store.getBatch(batchId)
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
    if (this.store.getActiveAccountId() !== batch.accountId || !this.steam.isAuthenticated(batch.accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '恢复批次前必须登录对应 Steam 账号')
    }
    this.store.setBatchRunning(batchId)
    this.emit({ type: 'batchProgress', batchId })
    this.emit({ type: 'snapshotChanged' })
    void this.run(batchId)
  }

  cancel(batchId: string): void {
    this.store.cancelBatch(batchId)
    this.emit({ type: 'batchProgress', batchId })
    this.emit({ type: 'snapshotChanged' })
  }

  pauseForSessionExpiry(accountId: string): void {
    const batch = this.store.getActiveBatch(accountId)
    if (!batch || batch.status === 'paused') return
    try {
      this.store.pauseBatch(batch.id)
      this.emit({
        type: 'notice',
        level: 'warning',
        message: 'Steam 会话失效，留言批次已暂停'
      })
      this.emit({ type: 'snapshotChanged' })
    } catch {
      // The batch may have completed between the lookup and update.
    }
  }

  private async run(batchId: string): Promise<void> {
    if (this.workers.has(batchId)) return
    this.workers.add(batchId)
    let activeDeliveryId: string | null = null
    let submitted = false
    let mayRestart = true
    try {
      while (true) {
        const batch = this.store.getBatch(batchId)
        if (!batch || batch.status !== 'running') return
        if (!this.steam.isAuthenticated(batch.accountId)) {
          this.store.pauseBatch(batchId)
          this.emit({ type: 'snapshotChanged' })
          return
        }

        const nextAt = this.nextDeliveryAt.get(batchId) ?? 0
        if (nextAt > Date.now() && await waitForNextDelivery(this.store, batchId, nextAt)) return
        const delivery = this.store.takeNextDelivery(batchId)
        if (!delivery) {
          this.store.finishBatchIfDone(batchId)
          this.emit({ type: 'batchProgress', batchId })
          this.emit({ type: 'snapshotChanged' })
          return
        }
        activeDeliveryId = delivery.id
        submitted = false

        if (!this.steam.isAuthenticated(batch.accountId)) {
          this.store.resetDeliveryToPending(delivery.id)
          activeDeliveryId = null
          this.store.pauseBatch(batchId)
          this.emit({ type: 'snapshotChanged' })
          return
        }

        const noLongerFriend = !this.store.hasActiveFriend(batch.accountId, delivery.friendSteamId)
        if (noLongerFriend || this.store.isBlacklisted(batch.accountId, delivery.friendSteamId)) {
          this.store.completeDelivery(delivery.id, 'failed', {
            error: noLongerFriend
              ? '已跳过：该用户已不在当前好友列表中，未发送留言'
              : '已跳过：好友已加入当前账号黑名单，未发送留言'
          })
          activeDeliveryId = null
          this.store.finishBatchIfDone(batchId)
          this.emit({ type: 'batchProgress', batchId })
          this.emit({ type: 'snapshotChanged' })
          continue
        }

        let shouldPause = false
        try {
          submitted = true
          const result = await this.steam.postProfileComment(
            batch.accountId,
            delivery.friendSteamId,
            delivery.renderedMessage
          )
          this.store.completeDelivery(
            delivery.id,
            result.commentId ? 'sent_verified' : 'accepted_unverified',
            { remoteCommentId: result.commentId ?? undefined }
          )
        } catch (error) {
          const classification = classifyDeliveryError(error)
          this.store.completeDelivery(delivery.id, classification.status, {
            error: publicErrorMessage(error)
          })
          shouldPause = classification.pauseBatch
          this.emit({
            type: 'notice',
            level: 'warning',
            message: `${delivery.friendName}：${classification.status === 'uncertain' ? '发送结果待核对，不会自动重发' : '留言失败'}。${publicErrorMessage(error)}`
          })
        }
        activeDeliveryId = null
        this.nextDeliveryAt.set(batchId, Date.now() + batch.delayMs + Math.floor(Math.random() * 3_001))

        this.emit({ type: 'batchProgress', batchId })
        this.emit({ type: 'snapshotChanged' })
        if (this.store.finishBatchIfDone(batchId)) {
          const finished = this.store.getBatch(batchId)!
          this.emit({
            type: 'notice',
            level: finished.failed ? 'warning' : 'success',
            message: `留言批次已结束：成功 ${finished.succeeded}，失败或待核对 ${finished.failed}`
          })
          this.emit({ type: 'snapshotChanged' })
          return
        }
        if (shouldPause) {
          const current = this.store.getBatch(batchId)
          if (current?.status === 'running' || current?.status === 'queued') this.store.pauseBatch(batchId)
          this.emit({
            type: 'notice',
            level: 'warning',
            message: '检测到会话、网络或频率问题，批次已暂停'
          })
          this.emit({ type: 'snapshotChanged' })
          return
        }
      }
    } catch (error) {
      mayRestart = false
      try {
        const current = this.store.getBatch(batchId)
        if (activeDeliveryId && current?.deliveries.some((item) => item.id === activeDeliveryId && item.status === 'sending')) {
          if (submitted) this.store.completeDelivery(activeDeliveryId, 'uncertain', { error: '队列异常中断，发送结果待核对；不会自动重发' })
          else this.store.resetDeliveryToPending(activeDeliveryId)
        }
        if (current?.status === 'running' || current?.status === 'queued') this.store.pauseBatch(batchId)
      } catch {
        // A storage failure may prevent persistence; startup recovery handles sending records.
      }
      this.emit({ type: 'notice', level: 'error', message: `留言队列已停止：${publicErrorMessage(error)}` })
      this.emit({ type: 'snapshotChanged' })
    } finally {
      this.workers.delete(batchId)
      if (mayRestart) {
        const current = this.store.getBatch(batchId)
        // A resume may arrive after the old worker observed pause but before its finally runs.
        if (current?.status === 'running') void this.run(batchId)
        else if (!current || ['completed', 'cancelled'].includes(current.status)) this.nextDeliveryAt.delete(batchId)
      }
    }
  }
}

export function classifyDeliveryError(error: unknown): {
  status: 'failed' | 'uncertain'
  pauseBatch: boolean
} {
  const message = publicErrorMessage(error).toLowerCase()
  const rateLimited = /rate|limit|too many|\b429\b|频率|限制/.test(message)
  const sessionFailure = /not logged|login|session|access denied|expired|登录|会话/.test(message)
  const ambiguousNetworkFailure =
    /timeout|timed out|socket|econn|network|hang up|connection|fetch failed|abort|invalid json|malformed comment response|网络|连接/.test(message)
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
  deadline: number
): Promise<boolean> {
  while (Date.now() < deadline) {
    const batch = store.getBatch(batchId)
    if (!batch || batch.status !== 'running') return true
    await sleep(Math.min(250, deadline - Date.now()))
  }
  return false
}
