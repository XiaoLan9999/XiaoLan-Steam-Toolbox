import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { WelcomePanel } from '../src/renderer/src/components/WelcomePanel'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { AppSnapshot, BatchSummary } from '../src/shared/types'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())
const accountId = '76561198000000001'
const at = '2026-10-20T02:00:00.000Z'

function snapshot(): AppSnapshot {
  return { accounts: [{ id: accountId, steamId: accountId, accountName: 'Synthetic', displayName: 'Synthetic Friend',
    avatarUrl: '', createdAt: at, lastLoginAt: at, lastFriendSyncAt: null, lastEmoticonSyncAt: null,
    sessionState: 'authenticated', sessionMessage: null }], activeAccountId: accountId,
    friends: [], friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [], friendPolicies: [],
    settings: null, batches: [], activeBatch: null, commentScan: null, dataDirectory: '', language: 'zh-CN',
    updater: initialUpdateState('0.10.2', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'fixture' } }
}
function render(state: AppSnapshot, language: 'zh-CN' | 'en' = 'zh-CN') {
  const actions = { onNavigate: vi.fn(), onLogin: vi.fn(), onSettings: vi.fn() }
  const html = renderToStaticMarkup(<I18nProvider language={language}><WelcomePanel snapshot={state} {...actions} /></I18nProvider>)
  return { html, actions }
}

describe('toolbox welcome home', () => {
  it('shows the connection recovery notice on home without starting other work', () => {
    const actions = { onNavigate: vi.fn(), onLogin: vi.fn(), onSettings: vi.fn() }
    const html = renderToStaticMarkup(<I18nProvider language="en"><WelcomePanel snapshot={snapshot()} {...actions}
      connectionNotice={<section aria-label="Session connection">Automatic retry scheduled</section>} /></I18nProvider>)
    expect(html).toContain('Automatic retry scheduled')
    expect(html.indexOf('Automatic retry scheduled')).toBeLessThan(html.indexOf('toolbox-home-grid'))
    expect(actions.onLogin).not.toHaveBeenCalled()
    expect(actions.onNavigate).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en'] as const)('offers four separate tools without starting work in %s', language => {
    const { html, actions } = render(snapshot(), language)
    expect(html).toContain(language === 'en' ? 'Your Steam tools, in one place' : '你的 Steam 工具，都在这里')
    expect(html).toContain('LOCAL PROJECT')
    expect((html.match(/class="toolbox-home-card"/g) ?? [])).toHaveLength(4)
    expect(html).toContain(language === 'en' ? 'Open comments' : '打开留言板')
    expect(html).toContain(language === 'en' ? 'Open game status' : '打开游戏状态')
    expect(html).not.toContain(language === 'en' ? 'Opening home does not start sending' : '打开首页不会启动发送')
    expect(html).toContain(language === 'en' ? 'Settings, theme &amp; data transfer' : '设置、主题与数据迁移')
    expect(html).not.toContain('delivery-row')
    expect(html).not.toContain('<textarea')
    expect(actions.onNavigate).not.toHaveBeenCalled()
    expect(actions.onLogin).not.toHaveBeenCalled()
    expect(actions.onSettings).not.toHaveBeenCalled()
  })

  it('shows the existing task without calling processed records sent', () => {
    const state = snapshot()
    state.activeBatch = { id: 'fixture-task', accountId, status: 'running', sentVerified: 23,
      completed: 29, uncertain: 1, pending: 71 } as BatchSummary
    const { html } = render(state)
    expect(html).toContain('留言任务正在进行')
    expect(html).toContain('已确认 23 · 待核对 1 · 待发 71')
    expect(html).toContain('查看原任务')
    expect(html).not.toContain('已发送 29')
  })

  it('keeps a paused task paused and does not borrow another account task', () => {
    const state = snapshot()
    state.activeBatch = { accountId, status: 'paused', sentVerified: 1, uncertain: 1, pending: 8 } as BatchSummary
    expect(render(state).html).toContain('有一项暂停的留言任务')
    state.activeBatch.accountId = '76561198000000002'
    expect(render(state).html).not.toContain('toolbox-home-task')
  })

  it('offers account setup and offline tools without a selected account', () => {
    const state = snapshot()
    state.accounts = []
    state.activeAccountId = null
    const { html } = render(state)
    expect(html).toContain('0 个已保存账号')
    expect(html).toContain('尚未选择账号')
    expect(html).toContain('添加账号')
    expect(html).toContain('打开艺术作品工具')
    expect(html).toContain('打开截图工具')
  })

  it('escapes untrusted display names without making external requests', () => {
    const state = snapshot()
    state.accounts[0]!.displayName = '<img src=x onerror=alert(1)>'
    const { html } = render(state)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })

  it('removes only fixed sentence terminators while preserving internal punctuation and user names', () => {
    const state = snapshot()
    state.accounts[0]!.displayName = 'User.'
    const { html } = render(state)
    expect(html).toContain('你的 Steam 工具，都在这里</h1>')
    expect(html).not.toContain('你的 Steam 工具，都在这里。')
    expect(html).toContain('从一项工具开始。账号与数据保存在本机，各项操作由你决定</p>')
    expect(html).toContain('当前账号：User.</span>')
    expect(html).not.toContain('打开首页不会启动发送')
    const english = render(state, 'en').html
    expect(english).toContain('Your Steam tools, in one place</h1>')
    expect(english).toContain('Choose a tool to get started. Accounts and data stay local; you decide what runs</p>')
    expect(english).toContain('Selected: User.</span>')
  })
})
