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
    expect(html).toContain('不再提醒此版本')
  })

  it('reports a restored verified download without installing or restarting it', () => {
    const html = render({ ...available, phase: 'ready' }, 'en')
    expect(html).toContain('Update v0.9.1 is ready')
    expect(html).toContain('Downloaded and verified')
    expect(html).toContain('confirm the restart in Settings')
    expect(html).toContain('View update')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it.each(['idle', 'checking', 'upToDate', 'downloading', 'error'] as const)('retains a verified new version while the phase is %s', phase => {
    expect(render({ ...available, phase })).toContain('发现新版本 v0.9.1')
    expect(updateNoticeForState({ ...available, phase })?.version).toBe('0.9.1')
    expect(render({ ...base, phase })).toBe('')
  })

  it.each([null, '0.9.0', '0.8.9', '0.10', 'v0.10.0', '01.0.0', '1.0.0-beta.1', '9007199254740992.0.0', '<script>bad()</script>'])('ignores missing, invalid or non-new version %s', latestVersion => {
    expect(render({ ...available, latestVersion })).toBe('')
  })

  it.each(['0.9.10', '0.10.0', '1.0.0', '12.20.30'])('compares stable version components numerically for %s', latestVersion => {
    expect(updateNoticeForState({ ...available, latestVersion })?.version).toBe(latestVersion)
  })

  it('keeps a dismissed version and older replays hidden across progress, readiness and refreshes', () => {
    const dismissed = updateNoticeForState(available)!.version
    expect(updateNoticeForState({ ...available, phase: 'ready' }, dismissed)).toBeNull()
    expect(updateNoticeForState({ ...available, checkedAt: '2026-10-17T01:00:00.000Z' }, dismissed)).toBeNull()
    expect(updateNoticeForState({ ...available, phase: 'checking' }, dismissed)).toBeNull()
    const second = updateNoticeForState({ ...available, latestVersion: '0.9.2' }, dismissed)!
    expect(second.version).toBe('0.9.2')
    expect(updateNoticeForState(available, second.version)).toBeNull()
    expect(updateNoticeForState(available)?.version).toBe('0.9.1')
  })

  it.each(['update.manifestUnavailable', 'update.timeout', 'update.manifestSignature', '<script>bad()</script>', null])('does not interrupt the user with the automatic check error %s', error => {
    expect(render({ ...base, phase: 'error', error })).toBe('')
    expect(updateNoticeForState({ ...base, phase: 'error', error })).toBeNull()
    expect(updateNoticeForState({ ...available, phase: 'error', error }, available.latestVersion)).toBeNull()
  })

  it('does not present a user-cancelled operation as a failed update check', () => {
    expect(render({ ...base, phase: 'error', error: 'update.cancelled' })).toBe('')
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
