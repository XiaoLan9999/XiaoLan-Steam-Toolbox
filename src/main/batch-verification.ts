import { DomainError } from '../shared/domain'
import type { AppEvent, DeliveryRecord } from '../shared/types'
import type { SqliteStore } from './store'
import type { SteamService } from './steam-service'
import { publicErrorMessage } from './steam-service'

const CHECK_DELAYS = [5_000, 15_000]
const MAX_CHECKS = CHECK_DELAYS.length + 1

export class BatchVerificationController {
  constructor(
    private readonly store: SqliteStore,
    private readonly steam: SteamService,
    private readonly emit: (event: AppEvent) => void,
    private readonly wait: (ms: number) => Promise<void>
  ) {}

  stop(batchId: string): void {
    const progress = this.store.getBatchSummary(batchId)?.verification
    if (!progress || !['checking', 'waiting'].includes(progress.state)) return
    this.record(progress.deliveryId, batchId, 'unresolved', progress.attempt,
      '核对已停止，未确认的记录仍保留待核对，未重复发送')
  }

  async verifyAll(batchId: string, isCurrent: () => boolean): Promise<boolean> {
    let cursor: { createdAt: string; id: string } | undefined
    while (isCurrent()) {
      const delivery = this.store.getNextUncertainDelivery(batchId, cursor)
      if (!delivery) return true
      cursor = { createdAt: delivery.createdAt, id: delivery.id }
      if (!await this.verifyDelivery(delivery, isCurrent)) return false
      if (this.store.getNextUncertainDelivery(batchId, cursor)) {
        await this.wait(1_000)
      }
    }
    return false
  }

  async verifyDelivery(delivery: DeliveryRecord, isCurrent: () => boolean): Promise<boolean> {
    const batch = this.store.getBatchSummary(delivery.batchId)
    if (!batch || !isCurrent()) return false
    const evidence = this.store.getDeliveryCommentEvidence(delivery.id)
    let detail = '当前可见评论未找到足够的送达证据'
    for (let attempt = 1; attempt <= MAX_CHECKS; attempt += 1) {
      if (!isCurrent()) return false
      this.record(delivery.id, batch.id, 'checking', attempt, '正在只读核对好友主页；不会提交或重发留言')
      try {
        const result = await this.steam.reconcileProfileComment(batch.accountId, delivery.friendSteamId,
          delivery.renderedMessage, evidence, isCurrent)
        if (!isCurrent()) return false
        if (result.status === 'confirmed') {
          if (this.store.confirmUncertainDelivery(delivery.id, batch.accountId, result.commentId, result.postedAtSeconds)) {
            this.record(delivery.id, batch.id, 'confirmed', attempt, '已在好友主页确认送达，未重复发送')
            this.emit({ type: 'notice', level: 'success', message: `${delivery.friendName}：已只读核实送达，留言编号 #${result.commentId}，未重复发送` })
            return true
          }
          detail = '核对结果与已有记录冲突，不能将同一留言重复计为成功'
          break
        }
        detail = result.reason === 'missing-attempt-evidence'
          ? '旧记录缺少发送前基线或可信时间窗，无法准确归属原请求'
          : result.reason.includes('multiple') ? '发现多个匹配留言，无法唯一确定原请求'
            : '当前可见评论未找到足够的送达证据，不能据此认定未发送'
        if (!evidence?.serverWindow || result.reason.includes('multiple')) break
      } catch (error) {
        if (!isCurrent()) return false
        if (error instanceof DomainError && ['SESSION_EXPIRED', 'SESSION_CHANGED', 'SESSION_CHECK_FAILED',
          'SESSION_PREPARATION_FAILED', 'NOT_AUTHENTICATED', 'CHECK_CANCELLED', 'COMMUNITY_ACCESS_DENIED', 'RATE_LIMITED'].includes(error.code)) {
          this.record(delivery.id, batch.id, 'unresolved', attempt,
            `核对请求暂时无法继续；未重复发送。${publicErrorMessage(error)}`)
          throw error
        }
        detail = `只读核对失败：${publicErrorMessage(error)}`
      }
      if (attempt < MAX_CHECKS) {
        const delay = CHECK_DELAYS[attempt - 1]!
        this.record(delivery.id, batch.id, 'waiting', attempt,
          '等待下一次只读核对；本条不会重发', new Date(Date.now() + delay).toISOString())
        const deadline = Date.now() + delay
        while (isCurrent() && Date.now() < deadline) await this.wait(Math.min(250, deadline - Date.now()))
      }
    }
    if (!isCurrent()) return false
    const attempt = this.store.getBatchSummary(batch.id)?.verification?.attempt ?? 1
    this.record(delivery.id, batch.id, 'unresolved', attempt,
      `${detail}；本条保留待核对并跳过，不会重发，将继续其余待发`)
    this.emit({ type: 'notice', level: 'warning', message: `${delivery.friendName}：尚未证实送达，保留待核对且不重发；继续处理其余待发好友` })
    return true
  }

  private record(deliveryId: string, batchId: string, state: 'checking' | 'waiting' | 'confirmed' | 'unresolved',
    attempt: number, message: string, nextCheckAt: string | null = null): void {
    this.store.recordDeliveryVerification(deliveryId, { state, attempt, maxAttempts: MAX_CHECKS, nextCheckAt, message })
    this.emit({ type: 'batchProgress', batchId })
  }
}
