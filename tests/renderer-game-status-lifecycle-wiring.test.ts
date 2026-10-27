import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('renderer recovery retires game status before showing recovery UI', () => {
  it('enables the local connection using the same broker as its native writer', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('gameStatus = new GameStatusService({')
    const end = source.indexOf('commentScans = new CommentScanQueue', start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const construction = source.slice(start, end)
    expect(construction).toContain('nativeWriter: nativePresence')
    expect(construction).toContain('new NativeGameStatusClient({ broker: nativePresence, steamId,')
    expect(construction).not.toMatch(/localConnectionPaused\s*:\s*true/)
    const connectStart = source.indexOf("handle('gameStatus:connectLocal'")
    const connectEnd = source.indexOf("handle('gameStatus:connectWithToolbox'", connectStart)
    const connect = source.slice(connectStart, connectEnd)
    expect(connect).toContain('await localAppSimulation?.invalidate()')
    expect(connect.indexOf('await localAppSimulation?.invalidate()')).toBeLessThan(connect.indexOf('return gameStatus.connectLocal(input)'))
  })

  it('invalidates only the unexpected renderer-loss branch and does not reconnect or restore on reload', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf("mainWindow.webContents.on('render-process-gone'")
    const end = source.indexOf('if (process.env.ELECTRON_RENDERER_URL)', start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const branch = source.slice(start, end)
    const guard = branch.indexOf("details.reason === 'clean-exit'")
    const invalidate = branch.indexOf('gameStatus.invalidateForRendererLoss()')
    expect(invalidate).toBeGreaterThan(guard)
    expect(invalidate).toBeLessThan(branch.indexOf('for (const account'))
    expect(invalidate).toBeLessThan(branch.indexOf('dialog.showMessageBox'))
    expect(branch).toContain('rendererWindow.reload()')
    expect(branch).not.toMatch(/gameStatus\.(?:connect|restoreLive|unlockLive|play|lockLive)/)
    expect(branch).toContain('Disconnecting does not mean the original game text was restored')
  })

  it('blocks new IPC while draining native helpers before diagnostics and storage close', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf("app.on('before-quit'")
    const end = source.indexOf('function createWindow()', start)
    const branch = source.slice(start, end)
    expect(branch.indexOf('shuttingDown = true')).toBeLessThan(branch.indexOf('quitDrain.begin()'))
    expect(branch).toContain('quitDrain.settled')
    expect(branch).toContain('event.preventDefault()')
    expect(branch).not.toContain('diagnostics?.shutdown()')
    expect(branch).not.toContain('store?.close()')
    expect(source).toContain('Promise.allSettled([gameStatus?.shutdown() ?? nativePresenceForQuit?.shutdown(), localAppSimulation?.shutdown(), statusCopy?.shutdown()])')
    expect(source).toContain('nativePresenceForQuit = nativePresence')
    expect(source).toContain("if (shuttingDown) return { ok: false, error: { code: 'APP_SHUTTING_DOWN'")
  })

  it('checks simulation permission through a read-only local provider before submission', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
    expect(source).toContain('checkSimulationContext: () => readLocalSimulationContext()')
    expect(source).toContain('onDiagnostic: event => diagnostics?.gameStatusEvent(event)')
  })

  it('routes production simulation to local processes and disables the old personal CM entry', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
    expect(source).toContain('new LocalAppSimulationService({')
    expect(source).toContain('await gameStatus.retireConnection()')
    expect(source).toContain("handle('localAppSimulation:start'")
    expect(source).not.toContain('gameStatus.connectWithToolbox(input)')
    const nativeConstruction = source.slice(source.indexOf('gameStatus = new GameStatusService({'), source.indexOf('localAppSimulation = new LocalAppSimulationService({'))
    expect(nativeConstruction).not.toContain('getToolboxLogin')
    expect(source).toContain('statusCopy = new StatusCopyService({')
    expect(source).toContain("throw new DomainError('GAME_STATUS_PERSONAL_CM_DISABLED'")
  })
})
