import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchDeliveryPage, BatchSummary, SteamFriendCommenterApi } from '../src/shared/types'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'en' | 'zh-CN' }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks.slots[index]) : next }]
    },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.slots[index]
      if (!previous || deps.some((item, at) => !Object.is(item, previous.deps[at]))) hooks.slots[index] = { deps, callback }
      return hooks.slots[index].callback
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.slots[index]
      if (!previous || deps.some((item, at) => !Object.is(item, previous.deps[at]))) {
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

import { ComposerErrorLog } from '../src/renderer/src/components/ComposerErrorLog'

const a = '76561198000000001'
const b = '76561198000000002'
const task = (overrides: Partial<BatchSummary> = {}): BatchSummary => ({ id: 'task-A', accountId: a,
  status: 'running', total: 1000, completed: 8, pending: 992, sending: 0, uncertain: 0, cancelled: 0,
  sentVerified: 1, acceptedUnverified: 0, failedCount: 7, succeeded: 1, failed: 7, createdAt: '2026-10-26T09:00:00Z',
  startedAt: '2026-10-26T09:00:00Z', finishedAt: null, messageTemplate: 'Fixture', delayMs: 100,
  autoRetryEnabled: false, stopCode: null, stopMessage: null, pausedAt: null, nextRetryAt: null, retryCount: 0, ...overrides })
const resultPage = (batchId = 'task-A', offset = 0, count = 5, total = 7): BatchDeliveryPage => ({ total, offset, limit: 5,
  items: Array.from({ length: count }, (_, index) => ({ id: `delivery-${offset + index}`, batchId,
    friendSteamId: `76561198000000${String(offset + index).padStart(3, '0')}`, friendName: `${batchId} Friend ${offset + index}`,
    status: 'failed', error: '资料页明确提示为私密，当前无法留言', remoteCommentId: null,
    createdAt: '2026-10-26T09:00:00Z', sentAt: null })) })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props?.children)]
const content = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(content).join('') : value && typeof value === 'object' ? content((value as ReactElement<any>).props?.children) : ''

beforeEach(() => { vi.stubGlobal('React', React) })
afterEach(() => {
  for (const entry of hooks.slots) entry?.cleanup?.()
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en'
  vi.unstubAllGlobals()
})

function fixture() {
  let batch = task()
  let enabled = false
  let root: ReactElement | null = null
  const read = vi.fn<SteamFriendCommenterApi['listBatchDeliveries']>(async (_account, batchId, options) => ({ ok: true, data: resultPage(batchId, options?.offset ?? 0) }))
  vi.stubGlobal('window', { steamCommenter: { listBatchDeliveries: read } })
  const render = () => { hooks.cursor = 0; root = ComposerErrorLog({ batch, enabled }); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const node = nodes(root).find(node => node.type === 'button' && content(node.props.children) === label)
    if (!node) throw new Error(`Missing button: ${label}`)
    return node.props
  }
  render()
  return { read, render, settle, root: () => root, text: () => content(root), html: () => root ? renderToStaticMarkup(root) : '',
    button, setBatch(value: BatchSummary) { batch = value; render() },
    setEnabled(value: boolean) { enabled = value; render() },
    async click(label: string) { button(label).onClick(); await settle() },
    unmount() { for (const entry of hooks.slots) entry?.cleanup?.() } }
}

describe('bounded read-only composer error log', () => {
  it('does not mount log content or read the database while the parent details are closed', async () => {
    const f = fixture()
    await f.settle()
    expect(f.root()).toBeNull()
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en'] as const)('reads one five-item page only on opening in %s without repeating on progress events', async language => {
    hooks.language = language
    const f = fixture()
    f.setEnabled(true)
    await f.settle()
    expect(f.read).toHaveBeenCalledExactlyOnceWith(a, 'task-A', { status: 'failed', offset: 0, limit: 5 })
    expect(nodes(f.root()).filter(node => node.type === 'li')).toHaveLength(5)
    expect(f.text()).toContain(language === 'en' ? 'Skipping does not mean sent' : '跳过不代表发送成功')
    if (language === 'en') expect(f.text()).not.toMatch(/\p{Script=Han}/u)
    f.setBatch(task({ failedCount: 8, completed: 9 }))
    await f.settle()
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.text()).toContain(language === 'en' ? 'New records are available' : '有新增记录')
    await f.click(language === 'en' ? 'Refresh log' : '刷新记录')
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('bounds oversized responses and escapes HTML-like friend names and errors', async () => {
    const f = fixture()
    const page = resultPage('task-A', 0, 30, 30)
    page.items[0]!.friendName = '<script>private()</script>'
    page.items[0]!.error = '<img src=x onerror=private()>'
    f.read.mockResolvedValueOnce({ ok: true, data: page })
    f.setEnabled(true)
    await f.settle()
    expect(nodes(f.root()).filter(node => node.type === 'li')).toHaveLength(5)
    expect(f.html()).toContain('&lt;script&gt;private()&lt;/script&gt;')
    expect(f.html()).toContain('&lt;img src=x onerror=private()&gt;')
    expect(f.html()).not.toContain('<script>')
    expect(f.html()).not.toContain('task-A Friend 5')
  })

  it('retains the refresh hint when new failures arrive while a read is in flight', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<SteamFriendCommenterApi['listBatchDeliveries']>>>()
    f.read.mockReturnValueOnce(pending.promise)
    f.setEnabled(true)
    f.setBatch(task({ failedCount: 9, completed: 10 }))
    pending.resolve({ ok: true, data: resultPage() })
    await f.settle()
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.text()).toContain('New records are available')
  })

  it('requests explicit bounded pages and never accumulates page results', async () => {
    const f = fixture()
    f.setEnabled(true)
    await f.settle()
    expect(f.button('Previous').disabled).toBe(true)
    await f.click('Next')
    expect(f.read).toHaveBeenLastCalledWith(a, 'task-A', { status: 'failed', offset: 5, limit: 5 })
    expect(f.text()).toContain('Page 2')
    expect(f.text()).not.toContain('task-A Friend 0')
    expect(f.button('Next').disabled).toBe(true)
    await f.click('Previous')
    expect(f.read).toHaveBeenLastCalledWith(a, 'task-A', { status: 'failed', offset: 0, limit: 5 })
  })

  it('serializes a new account request behind an old request and never exposes stale rows', async () => {
    const f = fixture()
    const old = deferred<Awaited<ReturnType<SteamFriendCommenterApi['listBatchDeliveries']>>>()
    f.read.mockReturnValueOnce(old.promise)
    f.setEnabled(true)
    expect(f.read).toHaveBeenCalledTimes(1)
    f.setBatch(task({ id: 'task-B', accountId: b }))
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.text()).not.toContain('task-A Friend')
    old.resolve({ ok: true, data: resultPage() })
    await f.settle()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.read).toHaveBeenLastCalledWith(b, 'task-B', { status: 'failed', offset: 0, limit: 5 })
    expect(f.text()).toContain('task-B Friend 0')
    expect(f.text()).not.toContain('task-A Friend')
  })

  it('ignores the old page after close/reopen and performs no overlapping refreshes', async () => {
    const f = fixture()
    const old = deferred<Awaited<ReturnType<SteamFriendCommenterApi['listBatchDeliveries']>>>()
    f.read.mockReturnValueOnce(old.promise)
    f.setEnabled(true)
    f.button('Refresh log').onClick()
    expect(f.read).toHaveBeenCalledTimes(1)
    f.setEnabled(false)
    expect(f.root()).toBeNull()
    f.setEnabled(true)
    expect(f.read).toHaveBeenCalledTimes(1)
    old.resolve({ ok: true, data: { ...resultPage(), items: [{ ...resultPage().items[0]!, friendName: 'OLD-PRIVATE-ROW' }] } })
    await f.settle()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.text()).not.toContain('OLD-PRIVATE-ROW')
  })

  it('does not show an unmounted response or leak a backend failure message', async () => {
    const f = fixture()
    f.read.mockRejectedValueOnce(new Error('PRIVATE-BACKEND-COOKIE'))
    f.setEnabled(true)
    await f.settle()
    expect(f.text()).toContain('saved failure log could not be read')
    expect(f.text()).not.toContain('PRIVATE-BACKEND-COOKIE')
    const delayed = deferred<Awaited<ReturnType<SteamFriendCommenterApi['listBatchDeliveries']>>>()
    f.read.mockReturnValueOnce(delayed.promise)
    f.button('Refresh log').onClick()
    f.unmount()
    delayed.resolve({ ok: true, data: resultPage() })
    await f.settle()
    expect(f.text()).not.toContain('task-A Friend')
    expect(f.read).toHaveBeenCalledTimes(2)
  })
})
