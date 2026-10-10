import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ArtworkBrowserState } from '../src/shared/artwork-browser'
import type { AccountView } from '../src/shared/types'
import { ArtworkBrowserToolbar, ArtworkToolsPanel, artworkBrowserError, artworkHostBounds } from '../src/renderer/src/components/ArtworkToolsPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const account: AccountView = {
  id: 'account-1', steamId: '76561198000000001', accountName: 'TestAccount', displayName: 'Test User',
  avatarUrl: '', createdAt: '2026-10-11T01:00:00.000Z', lastLoginAt: null, lastFriendSyncAt: null,
  lastEmoticonSyncAt: null, sessionState: 'authenticated', sessionMessage: null
}
const uploadState: ArtworkBrowserState = {
  tool: 'upload', phase: 'ready', accountId: account.id, canApplyLongArtwork: true, error: null
}

function renderPanel(currentAccount: AccountView | null, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language, children: React.createElement(ArtworkToolsPanel, { account: currentAccount, visible: true })
  }))
}

function renderToolbar(state: ArtworkBrowserState, busy = false, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: React.createElement(ArtworkBrowserToolbar, {
      state, busy, onApply: () => undefined, onReload: () => undefined, onClose: () => undefined, onNavigate: () => undefined
    })
  }))
}

describe('embedded artwork tools entry points', () => {
  it('offers embedded upload and showcase configuration without external navigation or console instructions', () => {
    const html = renderPanel(account)
    expect(html).toContain('在工具箱内上传')
    expect(html).toContain('配置艺术展柜')
    expect(html).toContain('动画背景工具（内置 Steam.Design）')
    expect(html).toContain('使用账号：Test User')
    expect(html).toContain('自己勾选作品版权声明并保存')
    expect(html).toContain('原作者指南与脚本说明（内置查看）')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('按 F12')
    expect(html).not.toContain('打开艺术作品上传页')
    expect(html).not.toMatch(/disabled=""[^>]*>在工具箱内上传/)
    expect(html).not.toMatch(/disabled=""[^>]*>配置艺术展柜/)
  })

  it.each([null, { ...account, sessionState: 'expired' as const }, { ...account, sessionState: 'restoring' as const }])('requires an authenticated account for upload and showcase, but not local or animation tools', currentAccount => {
    const html = renderPanel(currentAccount)
    expect(html).toMatch(/disabled=""[^>]*>在工具箱内上传/)
    expect(html).toMatch(/disabled=""[^>]*>配置艺术展柜/)
    expect(html).not.toMatch(/disabled=""[^>]*>动画背景工具（内置 Steam.Design）/)
    expect(html).not.toMatch(/disabled=""[^>]*>导入本地背景图/)
    expect(html).toContain('本地裁剪和动画背景工具无需登录')
  })

  it('preserves static local cropping and distinguishes network-backed animation tools in English', () => {
    const html = renderPanel(account, 'en')
    expect(html).toContain('Import local background')
    expect(html).toContain('Artwork: 506 + 100 px')
    expect(html).toContain('Featured Artwork: 630 px')
    expect(html).toContain('It still requires a connection')
    expect(html).toContain('Local cropping does not export animations')
    expect(html).toContain('does not confirm ownership or submit artwork')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('renders untrusted account display names as text', () => {
    const html = renderPanel({ ...account, displayName: '<img onerror="bad()">' })
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toContain('<img onerror=')
  })
})

describe('trusted embedded artwork toolbar', () => {
  it('switches directly between upload and showcase without leaving the toolbox', () => {
    expect(renderToolbar(uploadState)).toContain('<button>配置艺术展柜</button>')
    expect(renderToolbar(uploadState, true)).toMatch(/disabled=""[^>]*>配置艺术展柜/)
    expect(renderToolbar({ ...uploadState, tool: 'showcase' }, false, 'en')).toContain('<button>Upload more artwork</button>')
  })
  it('enables fixed long-artwork application only for an eligible upload page', () => {
    expect(renderToolbar(uploadState)).toMatch(/<button class="primary">应用长图设置<\/button>/)
    expect(renderToolbar({ ...uploadState, phase: 'loading', canApplyLongArtwork: false })).toMatch(/disabled=""[^>]*>应用长图设置/)
    expect(renderToolbar(uploadState, true)).toMatch(/disabled=""[^>]*>应用长图设置/)
    expect(renderToolbar({ ...uploadState, tool: 'showcase', canApplyLongArtwork: false })).not.toContain('应用长图设置')
    expect(renderToolbar({ ...uploadState, tool: 'design', accountId: null, canApplyLongArtwork: false })).not.toContain('应用长图设置')
  })

  it('keeps reload and return-to-local controls available and translates status', () => {
    const html = renderToolbar({ ...uploadState, phase: 'loading', canApplyLongArtwork: false }, false, 'en')
    expect(html).toContain('Loading online page')
    expect(html).toContain('<button>Reload</button>')
    expect(html).toContain('<button>Back to local cropping</button>')
    expect(renderToolbar(uploadState, true, 'en')).toContain('<button>Back to local cropping</button>')
    expect(html).not.toMatch(/\p{Script=Han}/u)
    expect(renderToolbar({ ...uploadState, phase: 'error' }, false, 'en')).toContain('Page failed to load')
  })
})

describe('native artwork host placement', () => {
  it('uses integer CSS coordinates clipped to the app viewport', () => {
    expect(artworkHostBounds({ left: 301.3, top: 140.1, right: 1000.8, bottom: 768.9 }, 1280, 800))
      .toEqual({ x: 302, y: 141, width: 698, height: 627 })
    expect(artworkHostBounds({ left: -20, top: -50, right: 900, bottom: 900 }, 800, 600))
      .toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it.each([
    { left: 1300, top: 200, right: 1600, bottom: 700 },
    { left: 300, top: 900, right: 1000, bottom: 1200 },
    { left: 300, top: 200, right: 300, bottom: 700 },
    { left: 300, top: 200, right: 1000, bottom: 200 },
    { left: Number.NaN, top: 200, right: 1000, bottom: 700 }
  ])('hides invalid, empty, or off-screen hosts %s', rect => {
    expect(artworkHostBounds(rect, 1280, 800)).toBeNull()
  })
})

describe('artwork error localization', () => {
  it.each(['ARTWORK_DOWNLOAD_UNSUPPORTED', 'ARTWORK_DOWNLOAD_PATH_INVALID', 'ARTWORK_DOWNLOAD_FAILED'])('explains %s without requiring a page reload', code => {
    const en = artworkBrowserError(code, (_zh, english) => english)
    expect(en).not.toContain('Reload')
    expect(en).not.toMatch(/\p{Script=Han}/u)
  })
  it.each(['ARTWORK_AUTH_FAILED', 'ARTWORK_NOT_AUTHENTICATED', 'NOT_AUTHENTICATED', 'ARTWORK_SESSION_CHANGED', 'ARTWORK_INVALID_SESSION', 'ARTWORK_FILE_REQUIRED', 'ARTWORK_IMAGE_LOADING', 'ARTWORK_FORM_UNAVAILABLE', 'ARTWORK_UPLOAD_PAGE_REQUIRED', 'ARTWORK_APPLY_FAILED', 'ARTWORK_NAVIGATION_BLOCKED', 'ARTWORK_UNAVAILABLE', 'ARTWORK_LOAD_FAILED', 'ARTWORK_RENDERER_FAILED', 'ARTWORK_NOT_OPEN', 'ARTWORK_INVALID_TOOL', 'ARTWORK_INVALID_BOUNDS', 'UNKNOWN_ARTWORK_FAILURE'])('localizes %s without leaking remote details', code => {
    const en = artworkBrowserError(code, (_zh, english) => english)
    const zh = artworkBrowserError(code, chinese => chinese)
    expect(en.length).toBeGreaterThan(20)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en).not.toContain('https://')
    expect(zh).toMatch(/\p{Script=Han}/u)
  })
})
