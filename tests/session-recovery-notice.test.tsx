import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'zh-CN' | 'en' }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = initial
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? (value as (old: unknown) => unknown)(hooks.slots[index]) : value }]
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.slots[index]
      if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) {
        previous?.cleanup?.()
        const entry = { deps, cleanup: undefined as void | (() => void) }
        hooks.slots[index] = entry
        hooks.effects.push(() => { entry.cleanup = effect() })
      }
    }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language,
  t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }) }))
import { SessionRecoveryNotice } from '../src/renderer/src/components/SessionRecoveryNotice'

const now = '2026-10-26T10:00:00.000Z'
const account = (patch: Partial<AccountView> = {}): AccountView => ({ id: '76561198000000001', steamId: '76561198000000001',
  accountName: 'Fixture', displayName: 'Fixture', avatarUrl: '', createdAt: now, lastLoginAt: now,
  lastFriendSyncAt: null, lastEmoticonSyncAt: null, sessionState: 'restoring', sessionMessage: null, ...patch })
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props?.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props?.children) : ''

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  vi.stubGlobal('React', React)
  vi.stubGlobal('window', { setInterval, clearInterval, steamCommenter: new Proxy({}, { get: () => { throw new Error('IPC prohibited') } }) })
})
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.()
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en'
  vi.unstubAllGlobals(); vi.useRealTimers()
})

function fixture(initial = account(), initialBusy = false) {
  let value = initial
  let busy = initialBusy
  let root: ReactElement | null = null
  const retry = vi.fn()
  const signIn = vi.fn()
  const render = () => {
    hooks.cursor = 0
    root = SessionRecoveryNotice({ account: value, busy, onRetry: retry, onSignIn: signIn })
    hooks.effects.splice(0).forEach(effect => effect())
    return root
  }
  render()
  const button = (label: string) => {
    const item = nodes(root).find(node => node.type === 'button' && text(node.props.children) === label)
    if (!item) throw new Error(`Missing button ${label}`)
    return item.props
  }
  return { render, root: () => root, text: () => text(root), button, retry, signIn,
    update(patch: Partial<AccountView>) { value = { ...value, ...patch }; render() },
    setBusy(next: boolean) { busy = next; render() } }
}

describe('Steam session recovery notice', () => {
  it('does not offer an immediate retry during a server-required cooldown', () => {
    const f = fixture(account({ sessionRetryAt: '2026-10-26T10:01:00.000Z', sessionRetryBlocked: true }))
    const button = f.button('Waiting for sign-in retry window')
    expect(button.disabled).toBe(true)
    button.onClick()
    expect(f.retry).not.toHaveBeenCalled()
    expect(f.text()).toContain('Next automatic connection in')
  })

  it('stays absent for an authenticated account, even with stale retry metadata', () => {
    const f = fixture(account({ sessionState: 'authenticated', sessionRetryAt: '2026-10-26T10:01:00.000Z' }))
    expect(f.root()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.retry).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en'] as const)('explains automatic token reuse and offers a guarded retry in %s', language => {
    hooks.language = language
    const f = fixture(account({ sessionRetryAt: '2026-10-26T10:00:30.000Z', sessionRetryAttempt: 2,
      sessionMessage: 'Steam 自动登录暂时失败，将稍后重试；无需反复扫码' }))
    expect(f.text()).toContain('00:30')
    expect(f.text()).toContain(language === 'en' ? 'Retry 2' : '第 2 次重试')
    expect(f.text()).toContain(language === 'en' ? 'repeated QR scans are unnecessary' : '不需要反复扫码')
    if (language === 'en') expect(f.text()).not.toMatch(/\p{Script=Han}/u)
    const retry = f.button(language === 'en' ? 'Retry connection now' : '立即重试连接')
    retry.onClick()
    expect(f.retry).toHaveBeenCalledOnce()
    expect(f.signIn).not.toHaveBeenCalled()
    f.setBusy(true)
    const blocked = f.button(language === 'en' ? 'Retry connection now' : '立即重试连接')
    expect(blocked.disabled).toBe(true)
    blocked.onClick()
    expect(f.retry).toHaveBeenCalledOnce()
  })

  it('updates its countdown locally, stops ticking at the deadline, and never polls IPC', async () => {
    const f = fixture(account({ sessionRetryAt: '2026-10-26T10:00:02.000Z' }))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000); f.render()
    expect(f.text()).toContain('00:01')
    await vi.advanceTimersByTimeAsync(1000); f.render()
    expect(f.text()).toContain('Retry time reached')
    expect(vi.getTimerCount()).toBe(0)
    expect(f.retry).not.toHaveBeenCalled()
    expect(f.signIn).not.toHaveBeenCalled()
    f.update({ sessionState: 'authenticated' })
    expect(f.root()).toBeNull()
  })

  it('does not offer a duplicate retry while an attempt is already connecting', () => {
    const f = fixture()
    expect(f.text()).toContain('Connecting to Steam')
    const retry = f.button('Connecting…')
    expect(retry.disabled).toBe(true)
    retry.onClick()
    expect(f.retry).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    f.button('Sign in again instead').onClick()
    expect(f.signIn).toHaveBeenCalledOnce()
  })

  it.each(['offline', 'error'] as const)('permits saved-token retry before manual sign-in for %s without a plan', sessionState => {
    const f = fixture(account({ sessionState }))
    expect(f.text()).toContain('Try reconnecting with saved sign-in details first')
    expect(f.text()).not.toContain('automatic recovery is active')
    f.button('Retry connection now').onClick()
    expect(f.retry).toHaveBeenCalledOnce()
    expect(f.signIn).not.toHaveBeenCalled()
  })

  it('requires renewed sign-in for an expired account and does not claim an old plan is active', () => {
    const f = fixture(account({ sessionState: 'expired', sessionRetryAt: '2026-10-26T10:01:00.000Z' }))
    expect(f.text()).toContain('saved sign-in has expired or is unavailable')
    expect(f.text()).not.toContain('automatic recovery is active')
    expect(nodes(f.root()).filter(node => node.type === 'button')).toHaveLength(1)
    f.setBusy(true)
    const blocked = f.button('Sign in to this account again')
    expect(blocked.disabled).toBe(true)
    blocked.onClick()
    expect(f.signIn).not.toHaveBeenCalled()
    f.setBusy(false)
    f.button('Sign in to this account again').onClick()
    expect(f.signIn).toHaveBeenCalledOnce()
    expect(f.retry).not.toHaveBeenCalled()
  })

  it('handles invalid retry metadata without a NaN countdown or invented automatic plan', () => {
    const f = fixture(account({ sessionState: 'error', sessionRetryAt: 'invalid', sessionRetryAttempt: NaN }))
    expect(f.text()).not.toContain('NaN')
    expect(f.text()).not.toContain('automatic recovery is active')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses controlled TLS guidance and escapes HTML-like status messages', () => {
    const f = fixture(account({ sessionRetryAt: '2026-10-26T10:01:00.000Z',
      sessionMessage: 'Client network socket disconnected before secure TLS connection was established' }))
    expect(f.text()).toContain('before the TLS handshake completed')
    expect(f.text()).not.toContain('Client network socket disconnected')
    f.update({ sessionMessage: '<img src=x onerror=secret()>' })
    expect(renderToStaticMarkup(f.root()!)).toContain('&lt;img src=x onerror=secret()&gt;')
    expect(renderToStaticMarkup(f.root()!)).not.toContain('<img src=x')
  })

  it('clears the prior countdown when switching account or removing a retry plan', () => {
    const f = fixture(account({ sessionRetryAt: '2026-10-26T10:01:00.000Z' }))
    expect(vi.getTimerCount()).toBe(1)
    f.update({ id: '76561198000000002', sessionState: 'offline', sessionRetryAt: null })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.text()).not.toContain('01:00')
  })
})
