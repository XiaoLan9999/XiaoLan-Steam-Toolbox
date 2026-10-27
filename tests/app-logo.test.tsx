import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AppLogo } from '../src/renderer/src/components/AppLogo'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

describe('bundled application logo', () => {
  it.each(['zh-CN', 'en'] as const)('uses the cropped local artwork with accessible text in %s', language => {
    const html = renderToStaticMarkup(<I18nProvider language={language}><AppLogo className="brand-mark" size={38} /></I18nProvider>)
    expect(html).toContain('<img')
    expect(html).toContain('class="app-logo brand-mark"')
    expect(html).toContain(language === 'en' ? 'alt="XiaoLan Steam Toolbox logo"' : 'alt="小蓝Steam工具箱标志"')
    expect(html).toContain('width="38" height="38"')
    expect(html).toContain('draggable="false"')
    expect(html).not.toMatch(/src="https?:/)
  })

  it('replaces the letter placeholders in both sidebar and loading screen without changing attribution', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/renderer/src/App.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('<AppLogo className="steam-mark" size={56} />')
    expect(source).toContain('<AppLogo className="brand-mark" size={38} />')
    expect(source).not.toContain('className="steam-mark">S')
    expect(source).not.toContain('className="brand-mark">S')
    expect(source).toContain('href={AUTHOR_WEBSITE_URL}')
    expect(source).toContain('{AUTHOR_NAME}')
  })

  it('uses the same bundled image as the page icon and preserves its square proportions', () => {
    const html = readFileSync(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)), 'utf8')
    const css = readFileSync(fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)), 'utf8')
    expect(html).toContain('rel="icon" type="image/png" href="/src/assets/app-logo.png"')
    expect(css).toMatch(/\.app-logo\s*\{[^}]*object-fit:\s*cover;[^}]*aspect-ratio:\s*1;/s)
    expect(css).toMatch(/\.brand-mark,\s*\.steam-mark\s*\{[^}]*flex-shrink:\s*0;/s)
  })
})
