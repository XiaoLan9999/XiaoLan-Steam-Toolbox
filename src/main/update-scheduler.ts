import type { UpdateState } from '../shared/update-types'

export const UPDATE_STARTUP_CHECK_DELAY_MS = 8_000
export const UPDATE_PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000

export interface UpdateSchedulerOptions {
  enabled(): boolean
  phase(): UpdateState['phase']
  checkedAt(): string | null
  check(): Promise<unknown>
  now?: () => number
}

export interface UpdateScheduler {
  resume(): void
  shutdown(): void
}

export function createUpdateScheduler(options: UpdateSchedulerOptions): UpdateScheduler {
  let closed = false
  let busy = false
  let lastAttempt: number | null = null
  let periodic: ReturnType<typeof setInterval> | undefined

  const resetPeriodic = (): void => {
    clearInterval(periodic)
    periodic = setInterval(run, UPDATE_PERIODIC_CHECK_INTERVAL_MS)
    periodic.unref?.()
  }

  function run(): void {
    if (closed || busy) return
    try {
      if (!options.enabled() || ['checking', 'downloading'].includes(options.phase())) return
      const now = (options.now ?? Date.now)()
      if (!Number.isFinite(now)) return
      // A clock rollback must not suppress checks until the old wall clock catches up.
      if (lastAttempt !== null && now < lastAttempt) lastAttempt = now
      const checkedAt = options.checkedAt()
      const checked = checkedAt === null ? NaN : Date.parse(checkedAt)
      const previous = Math.max(lastAttempt ?? -Infinity, Number.isFinite(checked) && checked <= now ? checked : -Infinity)
      if (now - previous < UPDATE_PERIODIC_CHECK_INTERVAL_MS) return
      lastAttempt = now
      busy = true
      resetPeriodic()
      void Promise.resolve().then(() => {
        if (!closed) return options.check()
      }).catch(() => {
        // Automatic checks are best effort; failures never interrupt user tasks.
      }).finally(() => { busy = false })
    } catch {
      // Teardown or unavailable state must not escape a timer/resume callback.
    }
  }

  const startup = setTimeout(run, UPDATE_STARTUP_CHECK_DELAY_MS)
  startup.unref?.()
  resetPeriodic()
  return {
    resume: run,
    shutdown(): void {
      if (closed) return
      closed = true
      clearTimeout(startup)
      clearInterval(periodic)
    }
  }
}
