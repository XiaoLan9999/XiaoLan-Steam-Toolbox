import { useEffect, useState } from 'react'
import { isEnergySavingActive, subscribeEnergySaving } from './energy-saving'

export function startVisibleTick(tick: () => void): () => void {
  let timer: number | undefined
  let active: boolean | null = null
  let stopped = false
  const run = (): void => { if (!stopped && active === false) tick() }
  const sync = (next: boolean): void => {
    if (stopped || next === active) return
    active = next
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
    if (next) return
    run()
    timer = window.setInterval(run, 1000)
  }
  const unsubscribe = subscribeEnergySaving(sync)
  sync(isEnergySavingActive())
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    if (timer !== undefined) window.clearInterval(timer)
  }
}

export function useVisibleTick(enabled: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    return startVisibleTick(() => setNow(Date.now()))
  }, [enabled])
  return now
}
