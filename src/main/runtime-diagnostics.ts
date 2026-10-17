import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

interface Metric {
  pid: number
  type: string
  memory: { workingSetSize: number; peakWorkingSetSize: number; privateBytes?: number }
}

interface TaskMetric {
  status: string
  total: number
  completed: number
  pending: number
  sending: number
  uncertain: number
}

interface Options {
  directory: string
  version: string
  metrics(): Metric[]
  task(): TaskMetric | null
  memory?: () => NodeJS.MemoryUsage
  maxBytes?: number
}

const processTypes = new Set(['Browser', 'Tab', 'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Unknown'])
const exitReasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])
const taskStatuses = new Set(['queued', 'running', 'paused', 'completed', 'cancelled'])
const sessionPhases = new Set(['restore', 'refresh', 'recover', 'community-request', 'session-probe', 'comment-reconcile'])
const sessionOutcomes = new Set(['success', 'transient', 'expired', 'auth-rejected', 'access-denied', 'rate-limited', 'unverified', 'request-failed', 'stale-response'])
const sessionReasons = new Set(['http-401', 'login-redirect', 'not-logged-on', 'http-403', 'http-429', 'identity-match',
  'identity-mismatch', 'identity-guest', 'identity-missing', 'transport-error', 'network', 'timeout', 'token-rejected',
  'token-missing', 'session-changed', 'scheduled', 'on-demand', 'cookie-expired', 'unknown', 'verified',
  'credentials_rejected', 'network_or_service', 'rate_limited', 'community_access_denied', 'session_check_failed', 'session_changed', 'comment-reconciled'])
const communityEndpoints = new Set(['profile-comment', 'session-verify', 'other'])
const responseKinds = new Set(['json', 'html', 'empty', 'other'])
const denialKinds = new Set(['access-denied', 'challenge', 'unknown'])
const commentDenialReasons = new Set(['unknown', 'csrf-sessionid', 'posting-too-frequently',
  'target-comments-disabled', 'friends-only', 'target-blocked', 'account-restricted', 'challenge'])
const number = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

export class RuntimeDiagnostics {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(private readonly options: Options) {}

  start(): void {
    if (this.timer || this.stopped) return
    this.sample('start')
    this.timer = setInterval(() => this.sample('memory'), 60_000)
    this.timer.unref()
  }

  sample(event: 'start' | 'memory' | 'stop'): void {
    if (this.stopped) return
    try {
      const memory = (this.options.memory ?? (() => process.memoryUsage()))()
      const task = this.options.task()
      this.write({ event, main: {
        rssBytes: number(memory.rss), heapUsedBytes: number(memory.heapUsed),
        heapTotalBytes: number(memory.heapTotal), externalBytes: number(memory.external),
        arrayBufferBytes: number(memory.arrayBuffers)
      }, processes: this.options.metrics().slice(0, 32).map(metric => ({
        pid: number(metric.pid), type: processTypes.has(metric.type) ? metric.type : 'Unknown',
        workingSetKiB: number(metric.memory.workingSetSize),
        peakWorkingSetKiB: number(metric.memory.peakWorkingSetSize), privateKiB: number(metric.memory.privateBytes)
      })), task: task ? {
        status: taskStatuses.has(task.status) ? task.status : 'unknown', total: number(task.total),
        completed: number(task.completed), pending: number(task.pending), sending: number(task.sending),
        uncertain: number(task.uncertain)
      } : null })
    } catch {
      // Diagnostics must never prevent delivery persistence or shutdown.
    }
  }

  processGone(kind: 'renderer' | 'child', reason: string, exitCode: number): void {
    if (this.stopped) return
    this.write({ event: 'process-gone', kind,
      reason: exitReasons.has(reason) ? reason : 'unknown',
      exitCode: Number.isFinite(exitCode) ? Math.trunc(exitCode) : null })
    this.sample('memory')
  }

  sessionEvent(event: { phase: string; outcome: string; reason: string; httpStatus?: number; method?: string;
    endpoint?: string; responseKind?: string; denialKind?: string; responseCode?: number; retryAfterMs?: number;
    commentDenialReason?: string; errorPresent?: boolean }): void {
    if (this.stopped) return
    this.write({ event: 'session', phase: sessionPhases.has(event.phase) ? event.phase : 'unknown',
      outcome: sessionOutcomes.has(event.outcome) ? event.outcome : 'unknown',
      reason: sessionReasons.has(event.reason) ? event.reason : 'unknown',
      ...(Number.isInteger(event.httpStatus) && event.httpStatus! >= 100 && event.httpStatus! <= 599 ? { httpStatus: event.httpStatus } : {}),
      ...(event.method === 'GET' || event.method === 'POST' ? { method: event.method } : {}),
      ...(event.endpoint && communityEndpoints.has(event.endpoint) ? { endpoint: event.endpoint } : {}),
      ...(event.responseKind && responseKinds.has(event.responseKind) ? { responseKind: event.responseKind } : {}),
      ...(event.denialKind && denialKinds.has(event.denialKind) ? { denialKind: event.denialKind } : {}),
      ...(event.commentDenialReason && commentDenialReasons.has(event.commentDenialReason) ? { commentDenialReason: event.commentDenialReason } : {}),
      ...(typeof event.errorPresent === 'boolean' ? { errorPresent: event.errorPresent } : {}),
      ...(Number.isInteger(event.responseCode) && event.responseCode! >= 0 && event.responseCode! <= 255 ? { responseCode: event.responseCode } : {}),
      ...(typeof event.retryAfterMs === 'number' && Number.isFinite(event.retryAfterMs) && event.retryAfterMs >= 0 ? { retryAfterMs: event.retryAfterMs } : {}) })
  }

  shutdown(): void {
    if (this.stopped) return
    clearInterval(this.timer)
    this.timer = undefined
    this.sample('stop')
    this.stopped = true
  }

  private write(fields: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), version: this.options.version, ...fields }) + '\n'
      if (Buffer.byteLength(line) > 16_384) return
      const current = join(this.options.directory, 'runtime-current.jsonl')
      const previous = join(this.options.directory, 'runtime-previous.jsonl')
      const maxBytes = Math.max(16_384, this.options.maxBytes ?? 1_048_576)
      mkdirSync(this.options.directory, { recursive: true })
      if (existsSync(current) && statSync(current).size + Buffer.byteLength(line) > maxBytes) {
        if (existsSync(previous)) unlinkSync(previous)
        renameSync(current, previous)
      }
      appendFileSync(current, line, 'utf8')
    } catch {
      // Full disks, permissions, and exhausted resources are non-fatal here.
    }
  }
}
