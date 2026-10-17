import { Agent } from 'node:https'
import type { ClientRequest, RequestOptions } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EAuthTokenPlatformType, LoginSession } from 'steam-session'
import { SteamCommunityClient } from '../src/main/community-client'
import { STEAM_WEB_USER_AGENT } from '../src/main/steam-user-agent'

const accountId = '76561198000000001'
const recipientId = '76561198000000002'

afterEach(() => vi.unstubAllGlobals())

describe('Steam browser identity', () => {
  it('keeps real SDK finalizelogin, transfer, renewal, and Community HTTP headers identical without network access', async () => {
    const agent = new OfflineLoginAgent()
    const login = new LoginSession(EAuthTokenPlatformType.WebBrowser, { agent, userAgent: STEAM_WEB_USER_AGENT })
    login.refreshToken = ['synthetic-header', Buffer.from(JSON.stringify({ sub: accountId, aud: ['web', 'derive'] })).toString('base64url'), 'synthetic-signature'].join('.')
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ success: true, comments_html: '<div id="comment_42"></div>' }))
      : new Response(`<script>g_steamID="${accountId}";</script>`))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const community = new SteamCommunityClient(accountId, await login.getWebCookies(), vi.fn())
      await community.verifySession()
      await community.postProfileComment(recipientId, 'synthetic-comment')
      community.replaceCookies(await login.getWebCookies())
      await community.verifySession()
      await community.postProfileComment(recipientId, 'synthetic-comment-after-renewal')

      expect(agent.capturedRequests.map(request => request.path)).toEqual([
        '/jwt/finalizelogin', '/login/settoken', '/jwt/finalizelogin', '/login/settoken'
      ])
      expect(fetchMock).toHaveBeenCalledTimes(4)
      const userAgents = [
        ...agent.capturedRequests.map(request => request.userAgent),
        ...fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('User-Agent'))
      ]
      expect(userAgents).toHaveLength(8)
      for (const userAgent of userAgents) {
        expect(userAgent).toBe(STEAM_WEB_USER_AGENT)
        expect(userAgent).not.toMatch(/toolbox|xiaolan|Chrome\/136\./i)
      }
    } finally {
      login.cancelLoginAttempt()
      agent.destroy()
    }
  })
})

// Intercept actual Node ClientRequests before a socket is created; never call Agent.addRequest.
class OfflineLoginAgent extends Agent {
  readonly capturedRequests: Array<{ path: string; userAgent: string | number | string[] | undefined }> = []
  private readonly pending: ClientRequest[] = []

  addRequest(request: ClientRequest, options: RequestOptions): void {
    this.pending.push(request)
    const path = options.path ?? ''
    this.capturedRequests.push({ path, userAgent: request.getHeader('User-Agent') })
    const finalize = options.host === 'login.steampowered.com' && path === '/jwt/finalizelogin'
    const transfer = options.host === 'steamcommunity.com' && path === '/login/settoken'
    if (!finalize && !transfer) {
      queueMicrotask(() => request.destroy(new Error('Unexpected SDK request; network is disabled')))
      return
    }
    const body = finalize
      ? { transfer_info: [{ url: 'https://steamcommunity.com/login/settoken', params: { nonce: 'synthetic-nonce', auth: 'synthetic-auth' } }] }
      : { result: 1 }
    const headers = {
      'content-type': 'application/json',
      'set-cookie': [finalize
        ? 'steamRefresh_steam=synthetic-refresh; Path=/; Secure; Domain=login.steampowered.com'
        : `steamLoginSecure=${accountId}%7C%7Csynthetic-cookie; Path=/; Secure; Domain=steamcommunity.com`]
    }
    const response = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      statusCode: 200, statusMessage: 'OK', headers
    })
    queueMicrotask(() => request.emit('response', response))
  }

  override destroy(): void {
    for (const request of this.pending.splice(0)) request.destroy()
    super.destroy()
  }
}
