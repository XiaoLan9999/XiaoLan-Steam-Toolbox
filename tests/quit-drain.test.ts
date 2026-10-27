import { describe, expect, it, vi } from 'vitest'
import { QuitDrain } from '../src/main/quit-drain'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

describe('bounded native quit drain coordination', () => {
  it('prepares every subsystem and waits before allowing the final quit', async () => {
    const gate = deferred(); const calls: string[] = []
    const drain = new QuitDrain({ prepare: [() => { calls.push('tasks') }, () => { calls.push('status') }],
      drain: () => { calls.push('drain'); return gate.promise }, onSettled: () => { calls.push('quit') } })
    const pending = drain.begin()
    await Promise.resolve()
    expect(calls).toEqual(['tasks', 'status', 'drain'])
    expect(drain.settled).toBe(false)
    gate.resolve(); await pending
    expect(calls).toEqual(['tasks', 'status', 'drain', 'quit'])
    expect(drain.settled).toBe(true)
  })

  it('coalesces repeated quit requests before and after settlement', async () => {
    const gate = deferred(); const prepare = vi.fn(); const finish = vi.fn()
    const wait = vi.fn(() => gate.promise)
    const drain = new QuitDrain({ prepare: [prepare], drain: wait, onSettled: finish })
    const pending = drain.begin()
    expect(drain.begin()).toBe(pending)
    gate.resolve(); await pending
    expect(drain.begin()).toBe(pending)
    expect(prepare).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce()
  })

  it('still drains when one preparation step throws', async () => {
    const last = vi.fn(); const wait = vi.fn(); const finish = vi.fn()
    const drain = new QuitDrain({ prepare: [() => { throw new Error('Synthetic storage failure') }, last],
      drain: wait, onSettled: finish })
    await drain.begin()
    expect(last).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce()
  })

  it('allows final quit after a bounded failure without declaring native cleanup successful', async () => {
    const gate = deferred(); const finish = vi.fn()
    const drain = new QuitDrain({ prepare: [], drain: () => gate.promise, onSettled: finish })
    const pending = drain.begin(); await Promise.resolve()
    expect(finish).not.toHaveBeenCalled()
    gate.reject(new Error('Synthetic retirement timeout'))
    await pending
    expect(drain.settled).toBe(true); expect(finish).toHaveBeenCalledOnce()
  })
})
