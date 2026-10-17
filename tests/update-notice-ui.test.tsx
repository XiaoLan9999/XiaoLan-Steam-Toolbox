import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { initialUpdateState, type UpdateState } from '../src/shared/update-types'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import { UpdateNotice, updateNoticeForState } from '../src/renderer/src/components/UpdateNotice'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const base: UpdateState = initialUpdateState('0.9.0', 'portable')
const available: UpdateState = { ...base, phase: 'available', latestVersion: '0.9.1' }

function render(state: UpdateState, language: Language = 'zh-CN', onOpenSettings = (): void => undefined): string {
  return renderToStaticMarkup(<I18nProvider language={language}><UpdateNotice state={state} onOpenSettings={onOpenSettings} /></I18nProvider>)
}

describe('persistent software update notification', () => {
  it('shows a visible version and explicit settings action without requiring a fresh update event', () => {
    const html = render(available)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('发现新版本 v0.9.1')
    expect(html).toContain('当前 v0.9.0')
    expect(html).toContain('查看更新')
    expect(html).toContain('不会自动安装')
    expect(html).toContain('关闭本次版本提醒')
  })

  it('reports a restored verified download without installing or restarting it', () => {
    const html = render({ ...available, phase: 'ready' }, 'en')
    expect(html).toContain('Update v0.9.1 is ready')
    expect(html).toContain('Downloaded and verified')
    expect(html).toContain('confirm the restart in Settings')
    expect(html).toContain('View update')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it.each(['idle', 'checking', 'upToDate', 'downloading'] as const)('does not falsely notify in %s phase', phase => {
    expect(render({ ...available, phase })).toBe('')
    expect(updateNoticeForState({ ...available, phase })).toBeNull()
  })

  it.each([null, '0.9.0', '0.8.9', '0.10', 'v0.10.0', '01.0.0', '1.0.0-beta.1', '9007199254740992.0.0', '<script>bad()</script>'])('ignores missing, invalid or non-new version %s', latestVersion => {
    expect(render({ ...available, latestVersion })).toBe('')
  })

  it.each(['0.9.10', '0.10.0', '1.0.0', '12.20.30'])('compares stable version components numerically for %s', latestVersion => {
    expect(updateNoticeForState({ ...available, latestVersion })?.version).toBe(latestVersion)
  })

  it('keeps a dismissed version hidden across progress, readiness, refreshes and older-version replays for this run', () => {
    const first = updateNoticeForState(available)!
    const dismissed = new Set([first.key])
    expect(updateNoticeForState({ ...available, phase: 'ready' }, dismissed)).toBeNull()
    expect(updateNoticeForState({ ...available, checkedAt: '2026-10-17T01:00:00.000Z' }, dismissed)).toBeNull()
    expect(updateNoticeForState({ ...available, phase: 'checking' }, dismissed)).toBeNull()
    const second = updateNoticeForState({ ...available, latestVersion: '0.9.2' }, dismissed)!
    expect(second.version).toBe('0.9.2')
    dismissed.add(second.key)
    expect(updateNoticeForState(available, dismissed)).toBeNull()
    expect(updateNoticeForState(available)?.version).toBe('0.9.1')
  })

  it('makes route failures visible without claiming sign-in expired or disturbing the task', () => {
    const html = render({ ...base, phase: 'error', error: 'update.manifestUnavailable' })
    expect(html).toContain('软件更新遇到问题')
    expect(html).toContain('到设置重试')
    expect(html).toContain('不会中断当前任务')
    expect(html).toContain('关闭本次错误提醒')
    expect(html).not.toContain('登录失效')
    expect(html).not.toContain('发现新版本')
  })

  it('dismisses a repeated error independently of version notifications and allows a different error', () => {
    const error: UpdateState = { ...base, phase: 'error', error: 'update.timeout' }
    const dismissed = new Set([updateNoticeForState(error)!.key])
    expect(updateNoticeForState({ ...error, checkedAt: '2026-10-17T01:00:00.000Z' }, dismissed)).toBeNull()
    expect(updateNoticeForState({ ...error, error: 'update.manifestSignature' }, dismissed)?.kind).toBe('error')
    expect(updateNoticeForState(available, dismissed)?.kind).toBe('available')
  })

  it('does not present a user-cancelled operation as a failed update check', () => {
    expect(render({ ...base, phase: 'error', error: 'update.cancelled' })).toBe('')
  })

  it('handles an unspecified error without exposing untrusted technical details', () => {
    expect(render({ ...base, phase: 'error', error: null })).toContain('软件更新遇到问题')
    const html = render({ ...base, phase: 'error', error: '<script>bad()</script>' }, 'en')
    expect(html).toContain('Software update needs attention')
    expect(html).toContain('Retry in Settings')
    expect(html).not.toContain('bad()')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not invoke settings, download, install or any bridge while rendering a new version', () => {
    const onOpenSettings = vi.fn()
    render(available, 'en', onOpenSettings)
    expect(onOpenSettings).not.toHaveBeenCalled()
    const html = render(available, 'en')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('dialog')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('constrains the sidebar grid item and keeps account and update controls reachable in short windows', () => {
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const sidebar = /\.sidebar\s*\{([^}]*)\}/u.exec(css)?.[1]
    const accounts = /\.account-list\s*\{([^}]*)\}/u.exec(css)?.[1]
    expect(sidebar).toMatch(/min-height:\s*0\s*;/u)
    expect(sidebar).toMatch(/overflow-y:\s*auto\s*;/u)
    expect(accounts).toMatch(/min-height:\s*72px\s*;/u)
    expect(accounts).toMatch(/overflow-y:\s*auto\s*;/u)
  })
})
