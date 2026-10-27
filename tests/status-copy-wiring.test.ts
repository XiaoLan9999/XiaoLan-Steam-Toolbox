import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const main = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
describe('isolated status-copy application wiring', () => {
  it('constructs both backends without starting a copy session automatically', () => {
    const start = main.indexOf('statusCopy = new StatusCopyService({')
    const end = main.indexOf('commentScans = new CommentScanQueue', start)
    const section = main.slice(start, end)
    expect(section).toContain('new AsfStatusCopyBackend()')
    expect(section).toContain('new ToolboxStatusCopyBackend({')
    expect(section).toContain('cipher: createSecretCipher()')
    expect(section).toContain('COPY_LIVE_RESTORE_REQUIRED')
    expect(section).not.toMatch(/statusCopy\.(?:start|preview)\(/)
  })

  it('keeps legacy same-account personal CM entry disabled', () => {
    expect(main).toContain("throw new DomainError('GAME_STATUS_PERSONAL_CM_DISABLED'")
    expect(main).not.toContain('gameStatus.connectWithToolbox(input)')
  })

  it('retires copy work for native-mode switches, renderer loss and account changes', () => {
    const connect = main.slice(main.indexOf("handle('gameStatus:connectLocal'"), main.indexOf("handle('gameStatus:connectWithToolbox'"))
    expect(connect).toContain('await statusCopy?.invalidate()')
    const renderer = main.slice(main.indexOf("mainWindow.webContents.on('render-process-gone'"), main.indexOf('if (process.env.ELECTRON_RENDERER_URL)'))
    expect(renderer).toContain('void statusCopy?.invalidate().catch')
    const accounts = main.slice(main.indexOf("handle('account:activate'"), main.indexOf("handle('auth:startQr'"))
    expect(accounts.match(/await statusCopy\?\.invalidate\(\)/g)).toHaveLength(2)
    expect(main).toContain('statusCopy?.shutdown()')
  })

  it('provides only dedicated copy IPC and blocks updates while copy shutdown is uncertain', () => {
    for (const channel of ['state', 'save', 'preview', 'start', 'stop']) expect(main).toContain(`handle('statusCopy:${channel}'`)
    expect(main).not.toMatch(/handle\('statusCopy:(?:command|login|fetch|execute)'/)
    expect(main).toContain("copy.error?.code === 'COPY_STOP_UNCONFIRMED'")
  })
})
