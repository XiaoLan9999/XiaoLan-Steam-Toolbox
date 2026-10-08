import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPDATE_PREFERENCES, type UpdateState } from '../src/shared/update-types'
import { parseCustomUpdateMirrors, UpdatePanel } from '../src/renderer/src/components/UpdatePanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

const baseState: UpdateState = {
  phase: 'idle', currentVersion: '0.3.1', latestVersion: null, checkedAt: null, releaseUrl: null,
  packageKind: 'setup', sourceRouteId: null, routes: [], downloadedBytes: 0, totalBytes: 0,
  percent: 0, speedBytesPerSecond: 0, error: null
}

function renderUpdate(state: Partial<UpdateState> = {}, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, {
    language,
    children: React.createElement(UpdatePanel, {
      state: { ...baseState, ...state }, preferences: DEFAULT_UPDATE_PREFERENCES, runAction: async () => null
    })
  }))
}

describe('update settings', () => {
  it('explains release updates and public proxies without claiming domestic availability', () => {
    const html = renderUpdate()
    expect(html).toContain('当前版本')
    expect(html).toContain('0.3.1')
    expect(html).toContain('尚未检查')
    expect(html).toContain('代码提交不会触发更新')
    expect(html).toContain('ghfast.top')
    expect(html).toContain('ghproxy.net')
    expect(html).toContain('gh-proxy.com')
    expect(html).toContain('连接质量可能变化')
    expect(html).not.toContain('下载更新</button>')
    expect(html).not.toContain('确认更新并重启</button>')
  })

  it('keeps failed route diagnostics and remote labels escaped', () => {
    const html = renderUpdate({ phase: 'available', latestVersion: '0.3.2', routes: [
      { id: 'official', label: 'GitHub', domain: 'github.com', status: 'available', latencyMs: 125, speedBytesPerSecond: 1048576, error: null },
      { id: 'custom', label: '<img onerror="bad()">', domain: 'custom.example', status: 'failed', latencyMs: null, speedBytesPerSecond: null, error: 'update.timeout' },
      { id: 'unknown', label: 'Custom 2', domain: 'other.example', status: 'failed', latencyMs: null, speedBytesPerSecond: null, error: 'opaque route diagnostic <script>' }
    ] }, 'en')
    expect(html).toContain('125 ms / 1.0 MiB/s')
    expect(html).toContain('The connection timed out')
    expect(html).toContain('update.timeout')
    expect(html).toContain('opaque route diagnostic &lt;script&gt;')
    expect(html).toContain('The operation failed')
    expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;')
    expect(html).not.toContain('<img onerror=')
    expect(html).toContain('<option value="official">')
    expect(html).not.toContain('<option value="custom">')
  })

  it('shows download progress and a usable cancel control', () => {
    const html = renderUpdate({ phase: 'downloading', downloadedBytes: 5242880, totalBytes: 10485760, percent: 50, speedBytesPerSecond: 524288 }, 'en')
    expect(html).toContain('<progress max="100" value="50"')
    expect(html).toContain('50.0%')
    expect(html).toContain('5.0 MiB / 10.0 MiB')
    expect(html).toContain('512.0 KiB/s')
    expect(html).toMatch(/<button>Cancel download<\/button>/)
    expect(html).not.toContain('Confirm update and restart</button>')
  })

  it('requires an explicit ready-state restart action and explains each package kind', () => {
    const installed = renderUpdate({ phase: 'ready', packageKind: 'setup' }, 'en')
    const portable = renderUpdate({ phase: 'ready', packageKind: 'portable' }, 'en')
    expect(installed).toContain('Update downloaded and verified')
    expect(installed).toContain('installing the update')
    expect(portable).toContain('updating the portable app')
    expect(installed).toContain('pause running tasks')
    expect(portable).toContain('Confirm update and restart')
    expect(installed).not.toMatch(/\p{Script=Han}/u)
    expect(portable).not.toMatch(/\p{Script=Han}/u)
  })

  it('localizes known state errors and preserves codes for diagnostics', () => {
    expect(renderUpdate({ phase: 'error', error: 'update.downloadHash' }, 'en')).toContain('downloaded file failed verification')
    expect(renderUpdate({ phase: 'error', error: 'update.downloadHash' })).toContain('下载文件校验失败')
    expect(renderUpdate({ phase: 'error', error: 'update.downloadHash' })).toContain('update.downloadHash')
    expect(renderUpdate({ phase: 'ready', error: 'update.installBusy' }, 'en')).toContain('Pause comment and check tasks')
    expect(renderUpdate({ phase: 'upToDate', checkedAt: '2026-10-09T01:23:45.000Z' }, 'en')).toContain('You are using the latest version')
  })
})

describe('custom proxy input', () => {
  it('normalizes and deduplicates multiline HTTPS prefixes', () => {
    expect(parseCustomUpdateMirrors(' https://mirror.example/proxy\nhttps://mirror.example/proxy/\r\n\nhttps://other.example/ '))
      .toEqual(['https://mirror.example/proxy/', 'https://other.example/'])
    expect(parseCustomUpdateMirrors(' \n ')).toEqual([])
  })

  it.each(['http://mirror.example/', 'https://user:secret@mirror.example/', 'https://mirror.example/?token=value', 'https://mirror.example/#fragment', 'javascript:alert(1)', 'not a url'])('rejects unsuitable proxy prefix %s', value => {
    expect(() => parseCustomUpdateMirrors(value)).toThrow('invalidUrl')
  })

  it('keeps the number of custom probes bounded', () => {
    expect(() => parseCustomUpdateMirrors(Array.from({ length: 6 }, (_, index) => `https://mirror${index}.example/`).join('\n'))).toThrow('tooMany')
  })
})
