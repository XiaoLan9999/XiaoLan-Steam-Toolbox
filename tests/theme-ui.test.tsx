import React from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../src/renderer/src/components/SettingsModal'
import { I18nProvider } from '../src/renderer/src/i18n'
import { applyTheme, normalizeTheme, restoreCachedTheme } from '../src/renderer/src/theme'
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from '../src/shared/update-types'
import type { AppSnapshot } from '../src/shared/types'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())
const root = fileURLToPath(new URL('../', import.meta.url))
function snapshot(): AppSnapshot {
  return { accounts: [], activeAccountId: null, friends: [], friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [],
    settings: null, batches: [], activeBatch: null, friendPolicies: [], commentScan: null, dataDirectory: 'D:/SyntheticData', language: 'zh-CN',
    theme: 'dark', updater: initialUpdateState('0.16.5', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    security: { secretStorageAvailable: true, secretStorageBackend: 'fixture' } }
}
const element = () => ({ dataset: {} as Record<string, string>, style: { colorScheme: '' } })

describe('persisted renderer theme', () => {
  it.each([['dark', 'dark'], ['light', 'light'], [undefined, 'light'], [null, 'light'], ['system', 'light'], [{}, 'light']])('normalizes %j safely', (value, expected) => {
    expect(normalizeTheme(value)).toBe(expected)
  })

  it('applies the root palette and caches only the chosen theme', () => {
    const target = element(), setItem = vi.fn()
    applyTheme('dark', target as unknown as HTMLElement, { setItem })
    expect(target).toEqual({ dataset: { theme: 'dark' }, style: { colorScheme: 'dark' } })
    expect(setItem).toHaveBeenCalledExactlyOnceWith('xiaolan-steam-toolbox-theme', 'dark')
    applyTheme('light', target as unknown as HTMLElement, { setItem })
    expect(target.dataset.theme).toBe('light')
  })

  it('warms the palette from cache, with safe fallback on cache restrictions', () => {
    const target = element()
    expect(restoreCachedTheme(target as unknown as HTMLElement, { getItem: () => 'dark' })).toBe('dark')
    expect(target.style.colorScheme).toBe('dark')
    expect(restoreCachedTheme(target as unknown as HTMLElement, { getItem: () => { throw new Error('fixture restriction') } })).toBe('light')
    expect(target.dataset.theme).toBe('light')
    expect(() => applyTheme('dark', target as unknown as HTMLElement, { setItem: () => { throw new Error('fixture restriction') } })).not.toThrow()
  })

  it('lets authoritative snapshots override the startup preview without touching account data', () => {
    const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
    expect(app).toContain('restoreCachedTheme()')
    expect(app).toContain('applyTheme(normalizeTheme(next.theme))')
    expect(app).not.toContain('invert(')
  })

  it('has dark variables for every fixed-color token used across module styles', () => {
    const directory = join(root, 'src/renderer/src')
    const styles = ['styles.css', 'task-list.css', ...readdirSync(join(directory, 'components')).filter(name => name.endsWith('.css')).map(name => `components/${name}`)]
    const references = new Set(styles.flatMap(file => [...readFileSync(join(directory, file), 'utf8').matchAll(/var\((--tone-[\da-z-]+),/g)].map(match => match[1])))
    const palette = readFileSync(join(directory, 'theme-colors.css'), 'utf8')
    expect(references.size).toBeGreaterThan(150)
    for (const token of references) expect(palette).toContain(`${token}:`)
    expect(palette).toContain(':root[data-theme="dark"]')
    expect(readFileSync(join(directory, 'theme.css'), 'utf8')).toContain('color-scheme: dark')
    expect(styles.map(file => readFileSync(join(directory, file), 'utf8')).join('\n')).not.toMatch(/filter:\s*invert/)
  })
})

describe('theme and data import settings', () => {
  it.each(['zh-CN', 'en'] as const)('offers theme selection and import with accurate replace/restart semantics in %s', language => {
    const action = vi.fn(async () => null), onClose = vi.fn()
    const html = renderToStaticMarkup(<I18nProvider language={language}><SettingsModal snapshot={snapshot()} onClose={onClose} runAction={action} /></I18nProvider>)
    expect(html).toContain('value="dark" selected=""')
    expect(html).toContain('value="light"')
    expect(html).toContain(language === 'en' ? 'Import data' : '导入数据')
    expect(html).toContain(language === 'en' ? 'does not merge' : '不合并')
    expect(html).toContain(language === 'en' ? 'restarts without exiting Steam' : '重启工具箱，不退出 Steam')
    expect(html).toContain(language === 'en' ? 'Unfinished tasks stay paused' : '未完成任务保持暂停')
    expect(html).toContain(language === 'en' ? 'Local screenshots' : '本地截图')
    if (language === 'en') expect(html.replace('>中文<', '>Chinese<')).not.toMatch(/\p{Script=Han}/u)
    expect(action).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
