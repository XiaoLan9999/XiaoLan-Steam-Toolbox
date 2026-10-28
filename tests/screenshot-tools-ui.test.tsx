import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ScreenshotCatalog, ScreenshotGame, ScreenshotImage, ScreenshotPrepareResult } from '../src/shared/steam-screenshots'
import { I18nProvider, type Language } from '../src/renderer/src/i18n'
import {
  ScreenshotImageQueue, ScreenshotImportConfirmation, ScreenshotImportProgress, ScreenshotModeChoice, ScreenshotPreparationResult, ScreenshotRestartChoice, ScreenshotToolsPanel,
  filterScreenshotGames, mergeScreenshotImages, safeScreenshotPreview, screenshotErrorMessage,
  applyScreenshotImportResult, pendingScreenshotImages, screenshotPreparationReady, validScreenshotAppId, validScreenshotGameId
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

  it('clearly separates current-account API and selected-account local modes without automatic fallback', () => {
    const html = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(html).toContain('仅添加到本地截图库，不代表已上传')
    expect(html).toContain('模式一：当前账号免重启导入')
    expect(html).toContain('模式二：指定账号本地导入')
    expect(html).toContain('两种模式互不自动切换')
    expect(html).toContain('非当前账号本地导入始终不退出或重启 Steam')
    expect(html).toContain('假游戏辅助进程和 Steam 截图接口')
    expect(html).not.toContain('screenshot-restart-choice')
    expect(html).not.toContain('优先免重启导入')
    expect(html).not.toContain('会阻止写入并提示先退出')
    expect(html).toContain('最后的云端上传由你在 Steam 客户端确认')
    expect(html).toContain('非当前 Steam 账号直接导入，不退出 Steam')
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

describe('screenshot restart consent and progress', () => {
  const confirmation = { userName: 'Local Player', userId: '39734273', gameName: game.name, appId: game.appId,
    imageCount: 2, quality: '95', mode: 'local-account' as const, restartSteam: true, ready: true, onCancel: nothing, onConfirm: nothing }

  it('keeps automatic restart a separate local-mode option, off by default and absent from Mode 1', () => {
    const initial = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(initial).not.toContain('screenshot-restart-choice')
    const manual = render(<ScreenshotRestartChoice checked={false} disabled={false} onChange={nothing} />)
    expect(manual).not.toContain('checked=""')
    expect(manual).toContain('独立选项，默认关闭')
    expect(manual).toContain('非当前账号始终不退出、不重启')
    const disabled = render(<ScreenshotRestartChoice checked disabled onChange={nothing} />, 'en')
    expect(disabled).toMatch(/type="checkbox" disabled="" checked=""/)
    expect(disabled).not.toMatch(/\p{Script=Han}/u)
  })

  it('puts the exit/import/restart sequence and interruption warning in the confirmation dialog before consent', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const html = render(<ScreenshotImportConfirmation {...confirmation} onCancel={cancel} onConfirm={confirm} />)
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-describedby="screenshot-confirm-note"')
    expect(html).toContain('模式二：指定账号本地导入')
    expect(html).toContain('目标是非当前账号时，不退出、不重启 Steam')
    expect(html).toContain('仅目标正是当前 Steam 账号时才会再次询问')
    expect(html).toContain('非当前账号始终不触发')
    expect(html).toContain('取消提示不会退出 Steam')
    expect(html).toContain('返回检查')
    expect(html).toContain('Local Player')
    expect(html).toContain('AppID 730')
    expect(confirm).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('clearly distinguishes manual exit and translates all confirmation text', () => {
    const manual = render(<ScreenshotImportConfirmation {...confirmation} restartSteam={false} />)
    expect(manual).toContain('自动退出并重启已关闭')
    expect(manual).toContain('若目标是当前 Steam 账号，请先手动完全退出 Steam')
    expect(manual).toContain('非当前账号无需退出')
    for (const restartSteam of [false, true]) {
      const html = render(<ScreenshotImportConfirmation {...confirmation} restartSteam={restartSteam} ready={false} />, 'en')
      expect(html).not.toMatch(/\p{Script=Han}/u)
      expect(html).toMatch(/class="primary" disabled=""/)
    }
  })

  it('escapes destination labels instead of interpreting external metadata', () => {
    const html = render(<ScreenshotImportConfirmation {...confirmation} gameName="<script>bad()</script>" userName={'<img onerror="bad()">'} />)
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
  })

  it.each([
    ['connecting-steam', '不退出客户端', 'without exiting the client'],
    ['importing-live', '免重启导入并逐张核实', 'Importing without restart'],
    ['closing-steam', '尚未写入截图', 'no screenshots have been written yet'],
    ['importing', '请勿启动或切换 Steam 账号', 'Do not start or switch Steam accounts'],
    ['starting-steam', '正在重新打开 Steam', 'Reopening Steam']
  ] as const)('renders localized progress for %s without implying cloud upload', (phase, zh, en) => {
    const html = render(<ScreenshotImportProgress phase={phase} />)
    expect(html).toContain('role="status"')
    expect(html).toContain(zh)
    const english = render(<ScreenshotImportProgress phase={phase} />, 'en')
    expect(english).toContain(en)
    expect(english).not.toMatch(/\p{Script=Han}/u)
    expect(english).not.toContain('uploaded')
  })

  it('does not leave a progress message in the idle state', () => {
    expect(render(<ScreenshotImportProgress phase="idle" />)).toBe('')
  })
})

describe('no-restart screenshot choice and duplicate prevention', () => {
  const confirmation = { userName: 'Local Player', userId: '39734273', gameName: game.name, appId: game.appId,
    imageCount: 2, quality: '95', mode: 'current-account' as const, restartSteam: true, ready: true, onCancel: nothing, onConfirm: nothing }

  it('selects the no-restart route by default and explains the active-account and game-context constraints', () => {
    const html = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(html).toMatch(/type="radio"[^>]*name="screenshot-import-mode"[^>]*checked=""[^>]*value="current-account"/)
    expect(html).toContain('只允许本机 Steam 当前登录账号')
    expect(html).toContain('请先退出真实游戏与状态模拟')
    expect(html).toContain('空说明')
    const selectedLocal = render(<ScreenshotModeChoice value="local-account" disabled={false} onChange={nothing} />)
    expect(selectedLocal).toMatch(/type="radio"[^>]*checked=""[^>]*value="local-account"/)
    expect(selectedLocal).not.toMatch(/type="radio"[^>]*checked=""[^>]*value="current-account"/)
    const english = render(<ScreenshotModeChoice value="current-account" disabled onChange={nothing} />, 'en')
    expect(english).toContain('<fieldset class="screenshot-mode-choice" disabled=""')
    expect(english).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not grant automatic restart from the initial API confirmation', () => {
    const html = render(<ScreenshotImportConfirmation {...confirmation} />)
    expect(html).toContain('模式一：当前账号免重启导入')
    expect(html).toContain('不会退出 Steam，也不会自动切换模式')
    expect(html).toContain('选项在本模式不生效')
    expect(html).not.toContain('再次询问')
    expect(html).not.toContain('Steam 正在运行时，将退出并重新启动客户端')
    const disabledFallback = render(<ScreenshotImportConfirmation {...confirmation} restartSteam={false} />)
    expect(disabledFallback).toContain('不会退出 Steam，也不会自动切换模式')
    expect(disabledFallback).not.toContain('重启兜底')
    for (const restartSteam of [true, false]) {
      const english = render(<ScreenshotImportConfirmation {...confirmation} restartSteam={restartSteam} />, 'en')
      expect(english).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it('removes only confirmed images and retains uncertain and rejected images independently', () => {
    const first = { ...image, id: 'confirmed' }
    const second = { ...image, id: 'uncertain' }
    const third = { ...image, id: 'pending' }
    const result: ScreenshotPrepareResult = { imported: 1, files: [], backupPath: null, vdfPath: 'index.vdf', method: 'steam-api', completedImageIds: ['confirmed'],
      outcomes: [{ imageId: 'confirmed', name: first.name, status: 'confirmed' }, { imageId: 'uncertain', name: second.name, status: 'uncertain', code: 'LIVE_RESULT_UNCONFIRMED' }, { imageId: 'pending', name: third.name, status: 'rejected', code: 'LIVE_NOT_SUBMITTED' }] }
    const next = applyScreenshotImportResult([first, second, third], result, ['confirmed', 'uncertain', 'pending'])
    expect(next).toEqual([{ ...second, importStatus: 'uncertain', importReason: 'LIVE_RESULT_UNCONFIRMED' }, third])
    expect(pendingScreenshotImages(next)).toEqual([third])
    expect(second.importStatus).toBeUndefined()
    const withoutCompletedIds = { ...result, completedImageIds: undefined }
    expect(applyScreenshotImportResult([first, second, third], withoutCompletedIds, [first.id, second.id, third.id])).toEqual(next)
  })

  it('never treats an unknown API completion count as permission to clear every image', () => {
    const result: ScreenshotPrepareResult = { method: 'steam-api', imported: 1, files: [], backupPath: null, vdfPath: 'index.vdf' }
    expect(applyScreenshotImportResult([image], result, [image.id])).toEqual([image])
    expect(applyScreenshotImportResult([image], { ...result, method: 'index' }, [image.id])).toEqual([])
  })

  it('keeps an explicit uncertain result blocked even if a contradictory completed-id list is received', () => {
    const result: ScreenshotPrepareResult = { method: 'steam-api', imported: 0, files: [], backupPath: null, vdfPath: 'index.vdf', completedImageIds: [image.id], outcomes: [{ imageId: image.id, name: image.name, status: 'uncertain' }] }
    expect(applyScreenshotImportResult([image], result, [image.id])).toMatchObject([{ id: image.id, importStatus: 'uncertain' }])
  })

  it('blocks a queue containing only uncertain images but allows other pending images without clearing them', () => {
    const uncertain: ScreenshotImage = { ...image, id: 'uncertain', importStatus: 'uncertain', resizeRequired: true }
    const base = { catalog, userId: '39734273', appId: '730', quality: '95', resize: false, busy: false, caption: '', mode: 'local-account' as const }
    expect(screenshotPreparationReady({ ...base, images: [uncertain] })).toBe(false)
    expect(screenshotPreparationReady({ ...base, images: [uncertain, image] })).toBe(true)
    const html = render(<ScreenshotImageQueue images={[uncertain]} busy={false} onAdd={nothing} onRemove={nothing} onClear={nothing} />)
    expect(html).toContain('待核对：已排除，禁止重复导入')
    expect(render(<ScreenshotImageQueue images={[uncertain]} busy={false} onAdd={nothing} onRemove={nothing} onClear={nothing} />, 'en')).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not invent a VDF backup or ask to reopen Steam after API import', () => {
    const result: ScreenshotPrepareResult = { imported: 1, files: [], backupPath: null, vdfPath: 'index.vdf', method: 'steam-api', outcomes: [{ imageId: image.id, name: image.name, status: 'confirmed' }] }
    const html = render(<ScreenshotPreparationResult result={result} />)
    expect(html).toContain('Steam 未被关闭或重启')
    expect(html).toContain('直接在当前 Steam 中')
    expect(html).toContain('已确认导入')
    expect(html).not.toContain('原始索引备份')
    expect(html).not.toContain('现在打开 Steam')
    expect(html).not.toContain('Steam 已重新启动')
    const en = render(<ScreenshotPreparationResult result={result} />, 'en')
    expect(en).toContain('No exit or restart is needed')
    expect(en).not.toMatch(/\p{Script=Han}/u)
  })

  it('keeps confirmed import success while prominently warning that worker retirement is still unconfirmed', () => {
    const result: ScreenshotPrepareResult = { imported: 1, files: [], backupPath: null, vdfPath: 'index.vdf', method: 'steam-api', warning: 'LIVE_WORKER_STOP_UNCONFIRMED' }
    const zh = render(<ScreenshotPreparationResult result={result} />)
    expect(zh).toContain('已准备 1 张本地截图')
    expect(zh).toContain('screenshot-native-stop-warning')
    expect(zh).toContain('role="alert"')
    expect(zh).toContain('已经确认成功的截图仍然有效，不要重复导入')
    expect(zh).toContain('下次导入会先重试清理')
    expect(zh).toContain('模拟、锁定、状态复制及重启操作暂时受限')
    const en = render(<ScreenshotPreparationResult result={result} />, 'en')
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en).toContain('Confirmed imports remain valid')
  })

  it('lists confirmed, rejected and uncertain per-image results and safely escapes file names', () => {
    const result: ScreenshotPrepareResult = { imported: 1, files: [], backupPath: null, vdfPath: 'index.vdf', method: 'steam-api', outcomes: [
      { imageId: 'one', name: 'Good.jpg', status: 'confirmed' }, { imageId: 'two', name: '<img onerror="bad()">', status: 'uncertain', code: 'CALLBACK_TIMEOUT' }, { imageId: 'three', name: 'Pending.jpg', status: 'rejected', code: 'LIVE_NOT_SUBMITTED' }] }
    const html = render(<ScreenshotPreparationResult result={result} />)
    expect(html).toContain('已确认 1 · 未导入 1 · 待核对 1')
    expect(html).toContain('待核对（禁止重复导入）')
    expect(html).toContain('尚未提交，可继续处理')
    expect(html).toContain('data-status="confirmed"')
    expect(html).toContain('data-status="uncertain"')
    expect(html).toContain('data-status="rejected"')
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toContain('<img')
    expect(render(<ScreenshotPreparationResult result={result} />, 'en')).not.toMatch(/\p{Script=Han}/u)
  })

  it.each(['SCREENSHOT_LIVE_LEDGER_UNAVAILABLE', 'SCREENSHOT_LIVE_SHUTDOWN_FAILED', 'SCREENSHOT_LIVE_STOP_FAILED', 'SCREENSHOT_LIVE_BUSY', 'LIVE_BUSY', 'SCREENSHOT_LIVE_UNAVAILABLE', 'SCREENSHOT_LIVE_UNCERTAIN'])('explains the current live-import error code %s without a generic fallback', code => {
    const zh = screenshotErrorMessage(code, value => value)
    const en = screenshotErrorMessage(code, (_zh, value) => value)
    expect(zh).not.toBe(screenshotErrorMessage('UNKNOWN', value => value))
    expect(zh).toMatch(/\p{Script=Han}/u)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.length).toBeGreaterThan(40)
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
    expect(screenshotPreparationReady({ catalog: { ...catalog, games: [shortcut] }, userId: '39734273', appId: shortcut.appId, images: [image], quality: '95', resize: true, busy: false, caption: '', mode: 'local-account' })).toBe(true)
    expect(screenshotPreparationReady({ catalog, userId: '39734273', appId: shortcut.appId, images: [image], quality: '95', resize: true, busy: false, caption: '', mode: 'local-account' })).toBe(false)
  })

  const ready = { catalog, userId: '39734273', appId: '730', images: [image], quality: '95', resize: true, busy: false, caption: '', mode: 'local-account' as const }
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

describe('explicit screenshot mode constraints and activation', () => {
  const ready = { catalog: { ...catalog, steamRunning: true }, userId: '39734273', appId: '730', images: [image], quality: '95', resize: true, busy: false, caption: '' }
  it('uses Mode 1 constraints when the mode is omitted and requires Steam to be running', () => {
    expect(screenshotPreparationReady(ready)).toBe(true)
    expect(screenshotPreparationReady({ ...ready, catalog })).toBe(false)
    expect(screenshotPreparationReady({ ...ready, mode: 'local-account', catalog })).toBe(true)
  })
  it.each([{ caption: 'A caption' }, { appId: '480' }, { appId: '16777216' }])('does not silently fallback from a Mode 1-incompatible request %j', change => {
    expect(screenshotPreparationReady({ ...ready, ...change, mode: 'current-account' })).toBe(false)
    expect(screenshotPreparationReady({ ...ready, ...change, mode: 'local-account' })).toBe(true)
  })
  it('offers exactly two exclusive radio modes with Mode 1 selected by default', () => {
    const html = render(<ScreenshotToolsPanel visible runAction={async () => null} />)
    expect(html.match(/type="radio"/g)).toHaveLength(2)
    expect(html.match(/name="screenshot-import-mode"/g)).toHaveLength(2)
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="current-account"/)
    expect(html).not.toMatch(/type="radio"[^>]*checked=""[^>]*value="local-account"/)
    expect(html).not.toContain('screenshot-live-choice')
    expect(html).not.toContain('screenshot-restart-choice')
  })
  it('reports a prepared inactive account as waiting for account switch, never as cloud upload or restart', () => {
    const result: ScreenshotPrepareResult = { method: 'index', activation: 'after-account-switch', imported: 1, files: ['local.jpg'], backupPath: 'local-backup', vdfPath: 'index.vdf' }
    const zh = render(<ScreenshotPreparationResult result={result} />)
    expect(zh).toContain('当前 Steam 未被退出或重启')
    expect(zh).toContain('切换到该账号后查看并确认上传即可')
    expect(zh).toContain('无需现在进行额外操作')
    expect(zh).toContain('工具箱不会自动替你切号')
    expect(zh).toContain('local-backup')
    expect(zh).not.toContain('现在打开 Steam')
    expect(zh).not.toContain('Steam 已重新启动')
    expect(zh).not.toContain('已经上传')
    const en = render(<ScreenshotPreparationResult result={result} />, 'en')
    expect(en).toContain('no extra action is needed now')
    expect(en).not.toMatch(/\p{Script=Han}/u)
  })
  it.each(['SCREENSHOT_MODE_ONE_UNAVAILABLE', 'SCREENSHOT_MODE_ONE_REQUIRES_STEAM', 'SCREENSHOT_MODE_ONE_CAPTION_UNSUPPORTED', 'SCREENSHOT_ACTIVE_USER_UNAVAILABLE', 'SCREENSHOT_TARGET_NOT_CURRENT', 'SCREENSHOT_TARGET_CHANGED'])('explains mode or identity failure %s rather than suggesting automatic fallback', code => {
    const zh = screenshotErrorMessage(code, value => value)
    const en = screenshotErrorMessage(code, (_zh, value) => value)
    expect(zh).not.toBe(screenshotErrorMessage('UNKNOWN', value => value))
    expect(zh).toMatch(/\p{Script=Han}/u)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.length).toBeGreaterThan(40)
  })
})

describe('honest preparation result and localized diagnostics', () => {
  it('explains uncertain delayed shutdown without claiming that Steam has safely reopened', () => {
    for (const code of ['SCREENSHOT_STEAM_EXIT_TIMEOUT', 'SCREENSHOT_STEAM_SHUTDOWN_UNCONFIRMED']) {
      const zh = screenshotErrorMessage(code, value => value)
      const en = screenshotErrorMessage(code, (_zh, value) => value)
      expect(zh).toContain('截图没有导入')
      expect(zh).toContain('随后自行关闭')
      expect(en).toContain('no screenshots were imported')
      expect(en).not.toMatch(/\p{Script=Han}/u)
    }
    expect(screenshotErrorMessage('SCREENSHOT_PROCESS_CHECK_FAILED', value => value)).toContain('无法可靠检查 Steam 进程')
  })
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

  it('reports a confirmed local import independently of whether Steam restarts', () => {
    const result = { imported: 2, files: ['image1.jpg'], backupPath: 'backup', vdfPath: 'screenshots.vdf' }
    const restarted = render(<ScreenshotPreparationResult result={{ ...result, steamRestart: 'restarted' }} />)
    expect(restarted).toContain('Steam 已重新启动')
    expect(restarted).toContain('在重新打开的 Steam 中')
    expect(restarted).not.toContain('不要再次导入')
    const failed = render(<ScreenshotPreparationResult result={{ ...result, steamRestart: 'failed' }} />)
    expect(failed).toContain('已准备 2 张本地截图，尚未上传至 Steam 云端')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('截图已导入，但 Steam 未能自动重新启动')
    expect(failed).toContain('不要再次导入同一批图片')
    for (const steamRestart of ['restarted', 'failed'] as const) {
      const html = render(<ScreenshotPreparationResult result={{ ...result, steamRestart }} />, 'en')
      expect(html).not.toMatch(/\p{Script=Han}/u)
      expect(html).toContain('not uploaded to Steam Cloud')
    }
  })

  it.each(['SCREENSHOT_STEAM_RUNNING', 'SCREENSHOT_STEAM_GAME_RUNNING', 'SCREENSHOT_STEAM_RESTART_UNSUPPORTED', 'SCREENSHOT_STEAM_IDENTITY_FAILED', 'SCREENSHOT_STEAM_CLIENT_UNVERIFIED', 'SCREENSHOT_STEAM_CLIENT_CHANGED', 'SCREENSHOT_STEAM_SHUTDOWN_FAILED', 'SCREENSHOT_STEAM_SHUTDOWN_TIMEOUT', 'SCREENSHOT_STEAM_EXIT_TIMEOUT', 'SCREENSHOT_STEAM_START_FAILED', 'SCREENSHOT_STEAM_RESTART_TIMEOUT', 'SCREENSHOT_IMPORT_AND_RESTART_FAILED', 'SCREENSHOT_STEAM_WORK_BUSY', 'SCREENSHOT_UNSAFE_PATH', 'SCREENSHOT_INVALID_QUEUE', 'SCREENSHOT_FILE_CHANGED', 'SCREENSHOT_INVALID_CAPTION', 'SCREENSHOT_QUEUE_LIMIT', 'SCREENSHOT_LOCKED', 'SCREENSHOT_ENCODE_FAILED', 'SCREENSHOT_METADATA_CHANGED', 'SCREENSHOT_CATALOG_CHANGED', 'SCREENSHOT_STORE_UNAVAILABLE', 'UNKNOWN'])('offers a localized, non-sensitive explanation for %s', code => {
    const zh = screenshotErrorMessage(code, value => value)
    const en = screenshotErrorMessage(code, (_zh, value) => value)
    expect(zh).toMatch(/\p{Script=Han}/u)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.length).toBeGreaterThan(40)
  })
})
