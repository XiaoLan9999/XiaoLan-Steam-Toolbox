import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SteamAuthenticatorSetupPanel } from '../src/renderer/src/components/SteamAuthenticatorSetupPanel'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

function render(language: 'zh-CN' | 'en'): string {
  return renderToStaticMarkup(<I18nProvider language={language}><SteamAuthenticatorSetupPanel /></I18nProvider>)
}

describe('mobile authenticator enrollment guide', () => {
  it.each(['zh-CN', 'en'] as const)('clearly explains that enrollment is not executable in %s', language => {
    const html = render(language)
    expect(html).toContain(language === 'en' ? 'Direct enrollment is not enabled' : '当前工具箱尚未开放直接绑定')
    expect(html).toContain(language === 'en' ? 'not an executable enrollment wizard' : '不是可执行的绑定向导')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('href=')
  })

  it('requires independent MobileApp authentication rather than reusing a browser token', () => {
    const html = render('en')
    expect(html).toContain('Authenticate separately as MobileApp and verify the SteamID')
    expect(html).toContain('WebBrowser token cannot be treated as a MobileApp token')
    expect(html).toContain('official Steam transfer flow')
    expect(html).toContain('must not be removed or reset automatically')
  })

  it('places encrypted pending persistence and recovery backup before finalization', () => {
    const html = render('en')
    const add = html.indexOf('Request enrollment once')
    const backup = html.indexOf('Encrypt pending material immediately')
    const finalize = html.indexOf('Enter the SMS code and finalize')
    const verified = html.indexOf('Read the server state again')
    expect(add).toBeGreaterThan(-1)
    expect(backup).toBeGreaterThan(add)
    expect(finalize).toBeGreaterThan(backup)
    expect(verified).toBeGreaterThan(finalize)
    expect(html).toContain('Stop on an unknown confirm_type')
    expect(html).toContain('not proof of successful enrollment')
  })

  it('translates the full process without claiming that tests or a local cache prove enrollment', () => {
    const html = render('en')
    expect(html).not.toMatch(/\p{Script=Han}/u)
    expect(html).toContain('later protocol verification and your explicit authorization')
    expect(html).toContain('does not sign in as mobile or call Add, Finalize or Remove')
  })
})
