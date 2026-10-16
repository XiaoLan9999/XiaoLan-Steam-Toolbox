import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ScreenshotCatalog, ScreenshotGame, ScreenshotImage } from '../src/shared/steam-screenshots'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import {
  ScreenshotImageQueue, ScreenshotPreparationResult, ScreenshotToolsPanel,
  filterScreenshotGames, mergeScreenshotImages, safeScreenshotPreview, screenshotErrorMessage,
  screenshotPreparationReady, validScreenshotAppId, validScreenshotGameId
} from '../src/renderer/src/components/ScreenshotToolsPanel'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const nothing = (): void => undefined
const game: ScreenshotGame = { appId: '730', name: 'Counter-Strike 2', nameSource: 'manifest', installed: true, userIds: ['39734273'] }
const catalog: ScreenshotCatalog = {
  steamPath: 'D:\\Steam', refreshedAt: '2026-10-16T04:00:00.000Z', steamRunning: false,
  users: [{ id: '39734273', steamId: '76561198000000001', displayName: 'Local Player', mostRecent: true, nameSource: 'loginusers' }],
  games: [game], warnings: []
}
const image: ScreenshotImage = { id: 'image-1', name: 'favorite.png', width: 1920, height: 1080, size: 2_097_152, previewUrl: 'data:image/jpeg;base64,/9j/AA==', resizeRequired: false }

function render(children: React.ReactNode, language: Language = 'zh-CN'): string {
  return renderToStaticMarkup(<I18nProvider language={language}>{children}</I18nProvider>)
}

describe('screenshot tool entry and local-only workflow', () => {
  it('offers discovery, manual refresh, named targets, game search and manual App ID without any toolbox account', () => {
    const html = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(html).toContain('更换目录')
    expect(html).toContain('刷新用户 / 游戏 / 状态')
    expect(html).toContain('选择本地用户')
    expect(html).toContain('名字与 ID 同时显示')
    expect(html).toContain('与工具箱当前登录账号相互独立')
    expect(html).toContain('搜索游戏名称或 AppID')
    expect(html).toContain('手动填写 AppID')
    expect(html).toContain('查名并使用')
    expect(html).toContain('名称查询不可用时仍可使用有效 AppID')
    expect(html).toContain('无需登录工具箱账号')
    expect(html).toContain('JPEG 质量')
    expect(html).toContain('大图自动缩小')
    expect(html).toMatch(/disabled=""[^>]*>准备 Steam 上传/)
    expect(html).not.toContain('href=')
    expect(html).not.toContain('type="password"')
  })

  it('explains that Steam must exit before writing, rather than claiming the image is already uploaded', () => {
    const html = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(html).toContain('仅添加到本地截图库，不代表已上传')
    expect(html).toContain('会阻止写入并提示先退出')
    expect(html).toContain('最后的云端上传由你在 Steam 客户端确认')
    expect(html).toContain('先备份，再写入本地截图索引')
  })

  it('fully translates its initial interface and keeps hidden panels non-visible', () => {
    const html = render(<ScreenshotToolsPanel visible={false} runAction={async () => null} />, 'en')
    expect(html).toContain('hidden=""')
    expect(html).toContain('Loading user and game metadata refreshed at startup')
    expect(html).toContain('Search by game name or App ID')
    expect(html).toContain('No toolbox sign-in required')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })
})

describe('screenshot image queue', () => {
  it('renders real geometry, preview, resize warning and per-file removal without exposing a file path', () => {
    const html = render(<ScreenshotImageQueue images={[{ ...image, resizeRequired: true }]} busy={false} onAdd={nothing} onClear={nothing} onRemove={nothing} />)
    expect(html).toContain('1920 × 1080')
    expect(html).toContain('2.0 MiB')
    expect(html).toContain('data:image/jpeg;base64,/9j/AA==')
    expect(html).toContain('移除 favorite.png')
    expect(html).toContain('需缩小尺寸')
    expect(html).toContain('清空队列')
  })

  it('does not load a remote or executable preview, and safely renders untrusted file names', () => {
    const malicious = { ...image, name: '<script>bad()</script>', previewUrl: 'https://external.invalid/tracker.jpg' }
    const html = render(<ScreenshotImageQueue images={[malicious]} busy={false} onAdd={nothing} onClear={nothing} onRemove={nothing} />)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('external.invalid')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).toContain('预览不可用')
  })

  it('disables every queue-changing control during preparation and translates all hints', () => {
    const html = render(<ScreenshotImageQueue images={[{ ...image, resizeRequired: true }]} busy onAdd={nothing} onClear={nothing} onRemove={nothing} />, 'en')
    expect(html).toMatch(/disabled=""[^>]*>Clear queue/)
    expect(html).toMatch(/disabled=""[^>]*>Choose images/)
    expect(html).toMatch(/aria-label="Remove favorite.png" disabled=""/)
    expect(html).toContain('Resizing required')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it('restricts previews to bounded-format JPEG data URLs, never arbitrary protocol or SVG', () => {
    expect(safeScreenshotPreview(image.previewUrl)).toBe(image.previewUrl)
    for (const value of ['javascript:alert(1)', 'file:///D:/secret.jpg', 'data:image/svg+xml;base64,AA==', 'data:image/jpeg;base64,<svg>', 'https://example.invalid/image.jpg', 'data:image/jpeg;base64,AA==\n']) {
      expect(safeScreenshotPreview(value)).toBeUndefined()
    }
  })

  it('uses the authoritative next queue, preserving only unchanged entries', () => {
    const clone = { ...image }
    expect(mergeScreenshotImages([image], [clone])[0]).toBe(image)
    expect(mergeScreenshotImages([image], [])).toEqual([])
    const changed = { ...image, resizeRequired: true }
    expect(mergeScreenshotImages([image], [changed])[0]).toBe(changed)
    const added = { ...image, id: 'image-2' }
    expect(mergeScreenshotImages([image], [added])).toEqual([added])
  })
})

describe('screenshot target validation and search', () => {
  it.each(['1', '730', '1808500', '4294967295'])('accepts valid decimal App ID %s', id => expect(validScreenshotAppId(id)).toBe(true))
  it.each(['', '0', '00', '0730', '-1', '1.1', '1e3', '4294967296', '99999999999', '730/../123', 'https://store.steampowered.com/app/730', ' 730', '730\n'])('rejects malformed or unsafe App ID %j', id => expect(validScreenshotAppId(id)).toBe(false))

  it('searches names case-insensitively and also finds an exact or partial App ID', () => {
    const other: ScreenshotGame = { ...game, appId: '1808500', name: 'Local Game' }
    const games = [game, other]
    expect(filterScreenshotGames(games, 'COUNTER')).toEqual([game])
    expect(filterScreenshotGames(games, ' 8500 ')).toEqual([other])
    expect(filterScreenshotGames(games, '')).toBe(games)
    expect(filterScreenshotGames(games, 'missing')).toEqual([])
  })

  it('accepts discovered 64-bit non-Steam shortcut Game IDs without losing integer precision', () => {
    expect(validScreenshotGameId('18446744073709551615')).toBe(true)
    expect(validScreenshotGameId('18446744073709551616')).toBe(false)
    expect(validScreenshotGameId('001234')).toBe(false)
    expect(validScreenshotAppId('18446744073709551615')).toBe(false)
    const shortcut = { ...game, appId: '13456789012345678901', name: 'Local shortcut' }
    expect(screenshotPreparationReady({ catalog: { ...catalog, games: [shortcut] }, userId: '39734273', appId: shortcut.appId, images: [image], quality: '95', resize: true, busy: false, caption: '' })).toBe(true)
    expect(screenshotPreparationReady({ catalog, userId: '39734273', appId: shortcut.appId, images: [image], quality: '95', resize: true, busy: false, caption: '' })).toBe(false)
  })

  const ready = { catalog, userId: '39734273', appId: '730', images: [image], quality: '95', resize: true, busy: false, caption: '' }
  it('allows local work without a toolbox session and unknown game names without substituting another game', () => {
    expect(screenshotPreparationReady(ready)).toBe(true)
    expect(screenshotPreparationReady({ ...ready, appId: '1808500' })).toBe(true)
    expect(screenshotPreparationReady({ ...ready, catalog: { ...catalog, steamRunning: true } })).toBe(true)
  })

  it.each([
    { catalog: null }, { catalog: { ...catalog, steamPath: null } }, { userId: 'other-user' },
    { appId: '0' }, { images: [] }, { quality: '' }, { quality: '0' }, { quality: '101' },
    { quality: '1.5' }, { quality: 'NaN' }, { busy: true }, { caption: 'first\nsecond' },
    { caption: 'a'.repeat(501) }, { resize: false, images: [{ ...image, resizeRequired: true }] }
  ])('blocks an incomplete or invalid preparation %j', override => {
    expect(screenshotPreparationReady({ ...ready, ...override })).toBe(false)
  })
})

describe('honest preparation result and localized diagnostics', () => {
  it('shows the backup and index locations, then instructs the user to confirm the real Steam upload', () => {
    const html = render(<ScreenshotPreparationResult result={{ imported: 2, files: ['image1.jpg'], backupPath: 'D:\\Steam\\backup\\first', vdfPath: 'D:\\Steam\\userdata\\123\\760\\screenshots.vdf' }} />)
    expect(html).toContain('已准备 2 张本地截图，尚未上传至 Steam 云端')
    expect(html).toContain('由你选择并确认上传')
    expect(html).toContain('D:\\Steam\\backup\\first')
    expect(html).toContain('screenshots.vdf')
    expect(html).not.toContain('href=')
  })

  it('escapes paths and translates the entire result', () => {
    const html = render(<ScreenshotPreparationResult result={{ imported: 1, files: [], backupPath: '<img onerror="bad()">', vdfPath: 'index.vdf' }} />, 'en')
    expect(html).toContain('1 local screenshots prepared; not uploaded to Steam Cloud')
    expect(html).toContain('confirm the upload yourself')
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toMatch(/\p{Script=Han}/u)
  })

  it.each(['SCREENSHOT_STEAM_RUNNING', 'SCREENSHOT_UNSAFE_PATH', 'SCREENSHOT_INVALID_QUEUE', 'SCREENSHOT_FILE_CHANGED', 'SCREENSHOT_INVALID_CAPTION', 'SCREENSHOT_QUEUE_LIMIT', 'SCREENSHOT_LOCKED', 'SCREENSHOT_ENCODE_FAILED', 'SCREENSHOT_METADATA_CHANGED', 'SCREENSHOT_CATALOG_CHANGED', 'SCREENSHOT_STORE_UNAVAILABLE', 'UNKNOWN'])('offers a localized, non-sensitive explanation for %s', code => {
    const zh = screenshotErrorMessage(code, value => value)
    const en = screenshotErrorMessage(code, (_zh, value) => value)
    expect(zh).toMatch(/\p{Script=Han}/u)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.length).toBeGreaterThan(40)
  })
})
