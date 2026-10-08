import { DomainError } from '../shared/domain'
import { AppEvent, CommentCheckResult, CommentScanJob, CommentScanStartInput } from '../shared/types'
import { CommentScanItem, SqliteStore } from './store'
import { publicErrorMessage } from './steam-service'

export interface CommentScanSteam {
  isAuthenticated(accountId: string): boolean
  checkCommentEligibility(accountId: string, steamId: string): Promise<CommentCheckResult>
}

interface InFlightCheck {
  jobId: string
  accountId: string
  item: CommentScanItem
  revision: number
}

export class CommentScanQueue {
  private pumping = false
  private stopped = false
  private nextCheckAt = 0
  private readonly revisions = new Map<string, number>()
  private inFlight: InFlightCheck | null = null
  private wake: (() => void) | null = null

  constructor(
    private readonly store: SqliteStore,
    private readonly steam: CommentScanSteam,
    private readonly emit: (event: AppEvent) => void
  ) {}

  start(input: CommentScanStartInput): CommentScanJob {
    this.requireReady(input.accountId)
    const job = this.store.createCommentScan(
      input.accountId, input.friendSteamIds, input.delayMs ?? 10_000
    )
    this.changed()
    this.kick()
    return this.store.getCommentScan(job.id)!
  }

  pause(jobId: string): void {
    this.requireOpen()
    this.invalidate(jobId)
    this.store.pauseCommentScan(jobId)
    this.changed()
  }

  resume(jobId: string): void {
    this.requireOpen()
    const job = this.store.getCommentScan(jobId)
    if (!job) throw new DomainError('SCAN_NOT_FOUND', '检查任务不存在')
    this.requireReady(job.accountId)
    this.store.setCommentScanRunning(jobId)
    this.changed()
    this.kick()
  }

  cancel(jobId: string): void {
    this.requireOpen()
    this.invalidate(jobId)
    this.store.cancelCommentScan(jobId)
    this.changed()
  }

  pauseForAccount(accountId: string): void {
    if (this.stopped) return
    const job = this.store.getActiveCommentScan(accountId)
    if (!job || job.status !== 'running') return
    const reason = '账号切换或会话中断，检查已暂停，请手动继续'
    const flight = this.inFlight
    if (flight?.jobId === job.id && flight.revision === this.revision(job.id)) {
      this.store.completeCommentScanItem(job.id, flight.item, {
        status: 'unknown', reason: '检查过程中账号切换或会话中断，无法确认留言权限'
      }, reason)
    }
    this.invalidate(job.id)
    this.store.pauseCommentScan(job.id, reason)
    this.changed()
  }

  shutdown(): void {
    if (this.stopped) return
    // Call before closing the store. Late GET completions never touch SQLite.
    this.stopped = true
    this.wake?.()
    for (const account of this.store.getAccounts()) {
      const job = this.store.getActiveCommentScan(account.id)
      if (job?.status === 'running') this.store.pauseCommentScan(job.id)
    }
  }

  private requireOpen(): void {
    if (this.stopped) throw new DomainError('SCAN_QUEUE_CLOSED', '应用正在退出')
  }

  private requireReady(accountId: string): void {
    this.requireOpen()
    if (this.store.getActiveAccountId() !== accountId) {
      throw new DomainError('ACCOUNT_NOT_ACTIVE', '请先切换到要检查的账号')
    }
    if (!this.steam.isAuthenticated(accountId)) {
      throw new DomainError('NOT_AUTHENTICATED', '检查前必须登录对应 Steam 账号')
    }
  }

  private changed(): void {
    if (!this.stopped) this.emit({ type: 'snapshotChanged' })
  }

  private revision(jobId: string): number {
    return this.revisions.get(jobId) ?? 0
  }

  private invalidate(jobId: string): void {
    this.revisions.set(jobId, this.revision(jobId) + 1)
    this.wake?.()
  }

  private runningJob(): CommentScanJob | null {
    const accountId = this.store.getActiveAccountId()
    if (!accountId) return null
    const job = this.store.getActiveCommentScan(accountId)
    return job?.status === 'running' ? job : null
  }

  private kick(): void {
    this.wake?.()
    if (this.pumping || this.stopped) return
    this.pumping = true
    void this.pump().catch((error: unknown) => {
      if (this.stopped) return
      const job = this.runningJob()
      if (job) this.store.pauseCommentScan(job.id, publicErrorMessage(error))
      this.changed()
    }).finally(() => {
      this.pumping = false
      // A resume may arrive while the preceding pump is settling.
      if (!this.stopped && this.runningJob()) this.kick()
    })
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const job = this.runningJob()
      if (!job) return
      if (!this.steam.isAuthenticated(job.accountId)) {
        this.pauseForAccount(job.accountId)
        return
      }
      if (this.nextCheckAt > Date.now()) {
        await this.wait(this.nextCheckAt - Date.now())
        continue
      }

      const item = this.store.takeNextCommentScanItem(job.id)
      this.changed()
      if (!item) continue
      const flight: InFlightCheck = {
        jobId: job.id, accountId: job.accountId, item, revision: this.revision(job.id)
      }
      this.inFlight = flight
      let result: CommentCheckResult
      let pauseReason: string | undefined
      try {
        result = this.store.hasActiveFriend(job.accountId, item.steamId)
          ? await this.steam.checkCommentEligibility(job.accountId, item.steamId)
          : { status: 'unknown', reason: '该用户已不在当前同步的好友列表中' }
      } catch (error) {
        pauseReason = publicErrorMessage(error)
        result = { status: 'unknown', reason: pauseReason }
      }
      this.nextCheckAt = Date.now() + job.delayMs
      if (this.stopped) return
      if (flight.revision !== this.revision(job.id)) {
        this.inFlight = null
        continue
      }
      if (this.store.getActiveAccountId() !== job.accountId) {
        this.pauseForAccount(job.accountId)
        this.inFlight = null
        continue
      }
      if (!pauseReason && !this.steam.isAuthenticated(job.accountId)) {
        this.pauseForAccount(job.accountId)
        this.inFlight = null
        continue
      }
      const accepted = this.store.completeCommentScanItem(job.id, item, result, pauseReason)
      this.inFlight = null
      if (!accepted) continue
      this.changed()
      if (pauseReason) {
        this.emit({
          type: 'notice', level: 'warning',
          message: '留言权限检查遇到会话、网络或请求错误，已标记为未知并暂停；请稍后手动继续'
        })
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        if (this.wake === finish) this.wake = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.wake = finish
    })
  }
}
