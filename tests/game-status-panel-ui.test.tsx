import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GameStatusApi, GameStatusAppInfo, GameStatusLiveLock, GameStatusLiveSnapshot } from '../src/shared/game-status'
import { GameStatusIdentity, GameStatusLockStatus, GameStatusPanel, GameStatusTemplateEditor, gameStatusPresenceResult, isGameStatusFieldEditable } from '../src/renderer/src/components/GameStatusPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const info: GameStatusAppInfo = { appId: 730, name: 'Fixture Game', language: 'schinese', iconUrl: `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/730/${'a'.repeat(40)}.jpg`, templates: [
  { token: '#Playing', text: 'Playing %map%', parameters: ['map'] },
  { token: '#Fixed', text: 'At the menu', parameters: [] }
] }
const lock: GameStatusLiveLock = { appId: 730, gameEpoch: 1, desired: { status: 'Fixture status' }, status: 'locked', matched: true,
  localizedString: 'Server supplied substatus', nextCheckAt: '2026-10-20T12:10:00Z', lastCheckedAt: '2026-10-20T12:09:45Z', consecutiveFailures: 0, error: null }

function render(children: React.ReactNode, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(<I18nProvider language={language}>{children}</I18nProvider>)
}

describe('game status identity and published-template UI', () => {
  it('renders official metadata icon with fixed dimensions and no referrer, not an arbitrary title asset', () => {
    const html = render(<GameStatusIdentity game={info} />)
    expect(html).toContain('Fixture Game'); expect(html).toContain('AppID 730')
    expect(html).toContain(`src="${info.iconUrl}"`); expect(html).toContain('width="40" height="40"')
    expect(html).toContain('referrerPolicy="no-referrer"')
  })

  it.each([
    'https://evil.example/icon.jpg', 'http://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/730/' + 'a'.repeat(40) + '.jpg',
    'https://cdn.cloudflare.steamstatic.com.evil.example/steamcommunity/public/images/apps/730/' + 'a'.repeat(40) + '.jpg',
    'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/570/' + 'a'.repeat(40) + '.jpg',
    'file:///C:/private.png', 'data:image/png;base64,private', 'javascript:alert(1)'
  ])('does not render unsafe or mismatched icon URL %s', iconUrl => {
    const html = render(<GameStatusIdentity game={{ ...info, iconUrl }} />)
    expect(html).not.toContain('<img'); expect(html).toContain('game-status-game-placeholder')
  })

  it('shows a fallback for missing metadata and distinguishes a non-Steam title', () => {
    expect(render(<GameStatusIdentity appId={730} />)).toContain('AppID 730')
    expect(render(<GameStatusIdentity />, 'en')).toContain('No official icon or native second-line status')
  })

  it('permits an absent substatus but rejects an uninspected, unknown, or incomplete template', () => {
    expect(gameStatusPresenceResult(null, undefined)).toEqual({ valid: true, preview: null })
    expect(gameStatusPresenceResult(null, { displayToken: '#Fixed', values: {} }).valid).toBe(false)
    expect(gameStatusPresenceResult(info, { displayToken: '#Unknown', values: {} }).valid).toBe(false)
    expect(gameStatusPresenceResult(info, { displayToken: '#Playing', values: {} }).valid).toBe(false)
  })

  it('renders only the game-published template and named supported variables', () => {
    const html = render(<GameStatusTemplateEditor id="fixture" info={info} presence={{ displayToken: '#Playing', values: { map: 'Fixture Map' } }} onChange={() => undefined} />)
    expect(html).toContain('Playing Fixture Map'); expect(html).toContain('本机模板预览（不是好友端确认）')
    expect(html).toContain('id="fixture-template"'); expect(html).toContain('map<input')
    expect(html).toContain('仅显示游戏，不设置子状态')
    expect(html).not.toContain('status<input')
  })

  it('labels incomplete input as not renderable without inventing a successful preview', () => {
    const html = render(<GameStatusTemplateEditor id="fixture" info={info} presence={{ displayToken: '#Playing', values: {} }} onChange={() => undefined} />, 'en')
    expect(html).toContain('Not renderable yet'); expect(html).toContain('not confirmation from a friend')
  })

  it('does not offer arbitrary details when no safe public templates were returned', () => {
    const html = render(<GameStatusTemplateEditor id="fixture" info={{ ...info, templates: [] }} onChange={() => undefined} />, 'en')
    expect(html).toContain('No safely renderable published template'); expect(html).toContain('Game only, no substatus')
    expect(html).not.toContain('<input')
  })

  it('distinguishes an unavailable lookup from an actual empty template response', () => {
    const unavailable = render(<GameStatusTemplateEditor id="fixture" info={{ ...info, templates: [], templateStatus: 'unavailable' }} onChange={() => undefined} />, 'en')
    const empty = render(<GameStatusTemplateEditor id="fixture" info={{ ...info, templates: [], templateStatus: 'empty' }} onChange={() => undefined} />, 'en')
    expect(unavailable).toContain('does not prove the game lacks support'); expect(unavailable).toContain('Retry the lookup')
    expect(empty).toContain('Steam returned the template result'); expect(empty).not.toContain('Retry the lookup')
  })

  it('escapes metadata, published text and user-entered values rather than injecting HTML', () => {
    const malicious = { ...info, name: '<script>bad()</script>', templates: [{ token: '#Fixed', text: '<img src=x onerror=bad()>', parameters: [] }] }
    const html = render(<><GameStatusIdentity game={malicious} /><GameStatusTemplateEditor id="x" info={malicious} presence={{ displayToken: '#Fixed', values: {} }} onChange={() => undefined} /></>)
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x'); expect(html).toContain('&lt;script&gt;')
  })
})

describe('live substatus lock presentation', () => {
  it.each([['checking', '正在核对'], ['locked', '持续锁定中'], ['retrying', '等待重试'], ['paused', '锁定已暂停'], ['stopped', '锁定已停止']] as const)('shows %s without claiming an uninterruptible game override', (status, label) => {
    const html = render(<GameStatusLockStatus lock={{ ...lock, status }} disabled={false} onUnlock={() => undefined} onRestore={() => undefined} />)
    expect(html).toContain(label); expect(html).toContain('只定期重申这些字段，不阻止游戏瞬间覆写')
    expect(html).toContain('status'); expect(html).toContain('Server supplied substatus')
    expect(html).toContain('解除锁定（保留当前值）'); expect(html).toContain('解除并安全恢复原字段')
  })

  it('keeps unlock available during checking and when paused, but disables it after stop or a foreground action', () => {
    for (const status of ['checking', 'paused'] as const) {
      expect(render(<GameStatusLockStatus lock={{ ...lock, status }} disabled={false} onUnlock={() => undefined} onRestore={() => undefined} />)).not.toContain('disabled=""')
    }
    expect(render(<GameStatusLockStatus lock={{ ...lock, status: 'stopped' }} disabled={false} onUnlock={() => undefined} onRestore={() => undefined} />)).toContain('disabled=""')
    expect(render(<GameStatusLockStatus lock={lock} disabled onUnlock={() => undefined} onRestore={() => undefined} />)).toContain('disabled=""')
  })

  it('shows readback mismatch and retry errors, not a misleading success label', () => {
    const html = render(<GameStatusLockStatus lock={{ ...lock, status: 'retrying', matched: false, localizedString: null, consecutiveFailures: 2, error: 'Fixture read timeout' }} disabled={false} onUnlock={() => undefined} onRestore={() => undefined} />, 'en')
    expect(html).toContain('Not confirmed'); expect(html).toContain('consecutive failures'); expect(html).toContain('Fixture read timeout')
    expect(html).not.toContain('Server supplied substatus')
  })

  it('only permits observed explicitly editable fields and never edits steam_display', () => {
    const live: GameStatusLiveSnapshot = { snapshotId: 'x', appId: 730, gameEpoch: 1, observedAt: '', patchActive: false, fields: { status: 'x', steam_display: '#Fixed', connect: 'private' }, editableKeys: ['status', 'steam_display'], readOnlyKeys: ['steam_display', 'connect'] }
    expect(isGameStatusFieldEditable(live, 'status')).toBe(true)
    expect(isGameStatusFieldEditable(live, 'steam_display')).toBe(false)
    expect(isGameStatusFieldEditable(live, 'connect')).toBe(false)
    expect(isGameStatusFieldEditable(live, 'new')).toBe(false)
  })

  it('the disconnected empty page has no automatic API work or old room presets in either language', () => {
    const api = new Proxy({}, { get: () => vi.fn(() => { throw new Error('Unexpected API call') }) }) as GameStatusApi
    const zh = render(<GameStatusPanel api={api} activeAccount={null} />)
    const en = render(<GameStatusPanel api={api} activeAccount={null} />, 'en')
    expect(zh).toContain('先选择一个工具箱账号'); expect(en).toContain('Select a toolbox account first')
    for (const old of ['雀魂快捷文字', '铜之间', '银之间', '金之间', '玉之间', '王座之间']) expect(zh).not.toContain(old)
  })
})
