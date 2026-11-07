import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { observeRendererHealth } from '../src/main/renderer-health'
import { sanitizeDiagnosticRecord } from '../src/shared/diagnostics'

function fixture() {
  const contents = new EventEmitter()
  const window = Object.assign(new EventEmitter(), { webContents: contents })
  const record = vi.fn(), hideEmbeddedView = vi.fn()
  let now = 0
  const stop = observeRendererHealth(window as unknown as BrowserWindow, { record, hideEmbeddedView, now: () => now })
  return { contents, window, record, hideEmbeddedView, stop, advance: (ms: number) => { now += ms } }
}

describe('bounded renderer health observability', () => {
  it('accepts only exact reviewed markers, never console contents or source paths', () => {
    const f = fixture()
    for (const message of ['PRIVATE-token', '[toolbox-ui] render-error PRIVATE', '[toolbox-ui] arbitrary', 123, null]) f.contents.emit('console-message', { message })
    expect(f.record).not.toHaveBeenCalled()
    f.contents.emit('console-message', { message: '[toolbox-ui] render-error', sourceId: 'PRIVATE-path', lineNumber: 999 })
    expect(f.record).toHaveBeenCalledExactlyOnceWith({ stage: 'render-error' })
    expect(f.hideEmbeddedView).toHaveBeenCalledOnce()
    f.stop()
  })

  it('does not hide a healthy interface for event-handler errors or rejections', () => {
    const f = fixture()
    for (const stage of ['window-error', 'unhandled-rejection']) f.contents.emit('console-message', { message: `[toolbox-ui] ${stage}` })
    expect(f.record).toHaveBeenCalledTimes(2)
    expect(f.hideEmbeddedView).not.toHaveBeenCalled()
    f.stop()
  })

  it('bounds repeated markers and detaches every listener on window close', () => {
    const f = fixture()
    for (let i = 0; i < 1000; i++) f.contents.emit('console-message', { message: '[toolbox-ui] render-error' })
    expect(f.record).toHaveBeenCalledTimes(1)
    expect(f.hideEmbeddedView).toHaveBeenCalledTimes(1)
    f.advance(60_000)
    f.contents.emit('console-message', { message: '[toolbox-ui] render-error' })
    expect(f.record).toHaveBeenCalledTimes(2)
    expect(f.hideEmbeddedView).toHaveBeenCalledTimes(2)
    f.window.emit('closed')
    expect(f.contents.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
    f.stop()
  })

  it('ignores subframe failures and expected navigation cancellations; records only numeric load facts', () => {
    const f = fixture()
    f.contents.emit('did-fail-load', {}, -3, 'PRIVATE-description', 'PRIVATE-url', true)
    f.contents.emit('did-fail-load', {}, -105, 'PRIVATE-description', 'PRIVATE-url', false)
    expect(f.record).not.toHaveBeenCalled()
    f.contents.emit('did-fail-load', {}, -105, 'PRIVATE-description', 'PRIVATE-url', true)
    f.contents.emit('preload-error', {}, 'PRIVATE-path', new Error('PRIVATE-token'))
    f.contents.emit('unresponsive')
    f.contents.emit('responsive')
    f.contents.emit('did-finish-load')
    for (const event of ['minimize', 'restore', 'hide', 'show']) f.window.emit(event)
    expect(f.record.mock.calls.map(([e]) => e.stage)).toEqual(['load-failed', 'preload-error', 'unresponsive', 'responsive', 'document-loaded', 'window-minimized', 'window-restored', 'window-hidden', 'window-shown'])
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('PRIVATE')
    f.stop()
  })

  it('does not allow a diagnostics observer failure to interrupt window lifecycle', () => {
    const contents = new EventEmitter()
    const window = Object.assign(new EventEmitter(), { webContents: contents })
    const stop = observeRendererHealth(window as unknown as BrowserWindow, {
      record: () => { throw new Error('PRIVATE') }, hideEmbeddedView: () => { throw new Error('PRIVATE') }
    })
    expect(() => contents.emit('console-message', { message: '[toolbox-ui] startup-error' })).not.toThrow()
    stop()
  })
})

describe('new diagnostics write/export privacy projections', () => {
  it('projects renderer stages without error strings, file locations or arbitrary fields', () => {
    expect(sanitizeDiagnosticRecord({ event: 'renderer-ui', stage: 'load-failed', errorCode: -105,
      message: 'PRIVATE', stack: 'PRIVATE', url: 'PRIVATE', path: 'PRIVATE' })).toEqual({ event: 'renderer-ui', stage: 'load-failed', errorCode: -105 })
    expect(sanitizeDiagnosticRecord({ event: 'renderer-ui', stage: 'PRIVATE' })).toBeNull()
    expect(sanitizeDiagnosticRecord({ event: 'renderer-ui', stage: 'render-error', errorCode: -105 })).toEqual({ event: 'renderer-ui', stage: 'render-error' })
  })

  it('projects only reviewed network routes and bounded values without proxy addresses or credentials', () => {
    expect(sanitizeDiagnosticRecord({ event: 'steam-network', stage: 'route-failed', route: 'fresh-system', endpoint: 'community-transfer',
      attempt: 2, elapsedMs: 700, networkCode: 'ERR_CONNECTION_CLOSED', proxyMode: 'proxy',
      proxy: 'PRIVATE', cookie: 'PRIVATE', body: 'PRIVATE', url: 'PRIVATE', error: new Error('PRIVATE') })).toEqual({
      event: 'steam-network', stage: 'route-failed', route: 'fresh-system', endpoint: 'community-transfer',
      attempt: 2, elapsedMs: 700, networkCode: 'ERR_CONNECTION_CLOSED', proxyMode: 'proxy'
    })
    for (const route of ['PRIVATE', null, 4]) expect(sanitizeDiagnosticRecord({ event: 'steam-network', stage: 'route-failed', route, endpoint: 'api', attempt: 1 })).toBeNull()
    for (const attempt of [-1, 0, 5, Infinity, '1']) expect(sanitizeDiagnosticRecord({ event: 'steam-network', stage: 'route-failed', route: 'system', endpoint: 'api', attempt })).toBeNull()
  })
})
