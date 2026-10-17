import { vi } from 'vitest'

export function emptyCommentProfile(account: string, recipient: string): Response {
  return new Response(`<script>g_steamID="${account}";</script>` +
    `<div id="commentthread_Profile_${recipient}_area" class="commentthread_area">` +
    `<div id="commentthread_Profile_${recipient}_posts" class="commentthread_comments"></div></div>`)
}

// The caller's mock still records every POST and non-baseline operation separately.
export function stubCommentBaseline<T extends (...args: any[]) => any>(
  operation: T,
  account: string,
  recipient: string
) {
  const baselineReads = vi.fn(async (_url: URL, _init?: RequestInit) => emptyCommentProfile(account, recipient))
  const wrappedFetch = vi.fn(async (url: URL, init: RequestInit = {}) => {
    const target = new URL(String(url))
    if ((init.method ?? 'GET') === 'GET' && target.origin === 'https://steamcommunity.com' &&
        target.pathname === `/profiles/${recipient}/` && target.search === '?l=english') {
      return baselineReads(url, init)
    }
    return operation(url, init)
  })
  vi.stubGlobal('fetch', wrappedFetch)
  return { baselineReads, wrappedFetch }
}
