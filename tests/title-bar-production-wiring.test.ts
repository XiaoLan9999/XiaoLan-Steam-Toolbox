import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../src/renderer/src/main.tsx', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

describe('custom window chrome production wiring', () => {
  it('uses the existing native close lifecycle rather than destroying the window', () => {
    expect(main).toContain('frame: false')
    expect(main).toContain("handle('windowUi:close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close() })")
    expect(main).toContain("mainWindow.on('close', (event)")
    expect(main).toContain('void closeController.request()')
  })
  it('keeps sender checks before operation gates and allows chrome during import/install', () => {
    const start = main.indexOf('function handle<TArgs')
    const handler = main.slice(start, main.indexOf('function toAppError', start))
    expect(handler.indexOf('INVALID_SENDER')).toBeLessThan(handler.indexOf("channel.startsWith('windowUi:')"))
    expect(handler).toContain("channel !== 'snapshot:get' && !hidingArtwork && !windowControl")
    expect(handler).toContain('dataImportInProgress && !hidingArtwork && !windowControl')
    expect(handler).not.toContain('setInterval')
  })
  it('publishes native state changes and subscribes through a removable preload listener', () => {
    for (const event of ['maximize', 'unmaximize', 'focus', 'blur']) expect(main).toContain(`artworkWindow.on('${event}', publishWindowUiState)`)
    expect(preload).toContain("ipcRenderer.removeListener('windowUi:stateChanged', listener)")
    expect(main).toMatch(/handle\('settings:language',[\s\S]*?store.setLanguage\(language\)[\s\S]*?publishWindowUiState\(\)/)
  })
  it('wraps App startup, error and missing bridge renders with the same titlebar', () => {
    expect(renderer).toContain('<TitleBar api={windowUi} />')
    expect(renderer).toContain("mountRendererApp({ render: renderWithChrome }, () => import('./App'))")
    expect(renderer.match(/renderWithChrome\(<RendererFailureView/g)).toHaveLength(2)
    expect(renderer).not.toContain('root.render(<RendererFailureView')
  })
})
