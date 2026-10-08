import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from '../src/main/external-links'
import { AUTHOR_NAME, AUTHOR_WEBSITE_URL } from '../src/shared/branding'
import { ARTWORK_SOURCE_URLS } from '../src/shared/artwork-links'

describe('author branding and external links', () => {
  it('uses the requested author and HTTPS homepage', () => {
    expect(AUTHOR_NAME).toBe('XiaoLan9999')
    expect(AUTHOR_WEBSITE_URL).toBe('https://xiaolan9999.net/')
  })

  it.each([
    'https://xiaolan9999.net',
    AUTHOR_WEBSITE_URL,
    'https://steamcommunity.com/profiles/76561198000000001',
    ...Object.values(ARTWORK_SOURCE_URLS)
  ])('allows the homepage and existing Steam profile links: %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it.each([
    'http://xiaolan9999.net/',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/cmd.exe',
    'https://xiaolan9999.net.example.com/',
    'https://xiaolan9999.net@other.example/',
    'https://user:password@xiaolan9999.net/',
    'https://xiaolan9999.net:444/',
    'https://xiaolan9999.net/redirect?url=https://other.example',
    'https://steamcommunity.com.example.com/',
    'not a url'
  ])('rejects unrelated URLs and unsafe schemes: %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false)
  })
})
