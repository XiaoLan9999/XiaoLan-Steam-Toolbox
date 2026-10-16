import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import { AccountStatusPanel } from '../src/renderer/src/components/AccountStatusPanel'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const account: AccountView = {
  id: '76561198000000001', steamId: '76561198000000001', displayName: 'Synthetic Player', accountName: 'fixture-player',
  avatarUrl: '', createdAt: '2026-10-16T04:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null,
  lastEmoticonSyncAt: null, sessionState: 'authenticated', sessionMessage: null
}

function render(value: Partial<AccountView> = {}, language: Language = 'zh-CN'): string {
  return renderToStaticMarkup(<I18nProvider language={language}><AccountStatusPanel account={{ ...account, ...value }} runAction={async () => null} /></I18nProvider>)
}

describe('toolbox account refresh status', () => {
  it('offers an explicit read-only refresh without implying a previous successful verification', () => {
    const html = render()
    expect(html).toContain('账号状态检查')
    expect(html).toContain('刷新检查')
    expect(html).toContain('点击检查，不发送留言')
    expect(html).not.toContain('网页登录身份已核验')
    expect(html).not.toContain('<time')
  })

  it('reports verified web identity but explicitly does not certify comment permissions or the Steam client online status', () => {
    const html = render({ statusCheckState: 'verified', statusCheckedAt: '2026-10-16T04:00:00.000Z', statusCheckMessage: '已核验当前 Steam 网页登录身份；不代表留言权限或客户端在线状态' })
    expect(html).toContain('status-verified')
    expect(html).toContain('网页登录身份已核验')
    expect(html).toContain('不代表留言权限或客户端在线状态')
    expect(html).toContain('<time dateTime="2026-10-16T04:00:00.000Z"')
  })

  it('shows an unverified HTTP 403 with its honest cause rather than claiming that sign-in expired', () => {
    const html = render({ statusCheckState: 'unverified', statusCheckMessage: 'Steam 拒绝了本次请求（HTTP 403），可能是访问或频率限制；尚未确认登录失效，请稍后再试' }, 'en')
    expect(html).toContain('Could not verify; see the reason')
    expect(html).toContain('Steam denied this request (HTTP 403)')
    expect(html).toContain('Sign-in expiry is not confirmed')
    expect(html).not.toContain('Web sign-in verified')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('disables repeat checks while the service is checking', () => {
    const html = render({ statusCheckState: 'checking' })
    expect(html).toMatch(/<button class="ghost" disabled="">检查中…/)
    expect(html).toContain('正在核验 Steam 网页登录身份')
    expect(html).not.toContain('网页登录身份已核验')
  })

  it.each([undefined, 'checking', 'verified', 'unverified'] as const)('fully translates state %s', state => {
    const html = render({ statusCheckState: state, statusCheckMessage: '已核验当前 Steam 网页登录身份；不代表留言权限或客户端在线状态' }, 'en')
    expect(html).toContain('Account status check')
    expect(html).toContain('This does not verify comment permissions or Steam client online status')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('safely escapes untrusted status details and ignores invalid check timestamps', () => {
    const html = render({ statusCheckState: 'unverified', statusCheckMessage: '<script>bad()</script>', statusCheckedAt: 'invalid-date' })
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<time')
  })
})
