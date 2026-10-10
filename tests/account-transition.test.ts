import { describe, expect, it, vi } from 'vitest'
import { AccountTransition } from '../src/main/account-transition'

describe('account transitions and embedded Steam sessions', () => {
  it('blocks new old-account views synchronously before asynchronous cleanup', async () => {
    const transition = new AccountTransition()
    let owner = 'account-a'
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const allowed = (account: string): boolean => !transition.active && owner === account
    expect(allowed('account-a')).toBe(true)
    const switching = transition.run(async () => { await cleanup; owner = 'account-b' })
    expect(transition.active).toBe(true)
    expect(allowed('account-a')).toBe(false)
    const concurrent = vi.fn(async () => undefined)
    await expect(transition.run(concurrent)).rejects.toMatchObject({ code: 'ACCOUNT_SWITCH_BUSY' })
    expect(concurrent).not.toHaveBeenCalled()
    finishCleanup()
    await switching
    expect(transition.active).toBe(false)
    expect(allowed('account-a')).toBe(false)
    expect(allowed('account-b')).toBe(true)
  })

  it('releases the guard after a rejected or synchronously thrown operation', async () => {
    const transition = new AccountTransition()
    await expect(transition.run(() => { throw new Error('failed cleanup') })).rejects.toThrow('failed cleanup')
    expect(transition.active).toBe(false)
    await expect(transition.run(async () => { throw new Error('failed activation') })).rejects.toThrow('failed activation')
    expect(transition.active).toBe(false)
    await expect(transition.run(async () => 'next')).resolves.toBe('next')
  })
})
