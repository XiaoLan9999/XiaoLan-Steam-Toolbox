import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamCommunityClient } from '../src/main/community-client'
import { createSteamNetworkRecovery } from '../src/main/steam-network-recovery'
import type { CommentAttemptEvidence } from '../src/main/comment-reconciliation'

afterEach(() => vi.restoreAllMocks())

describe('buffered safe reads preserve comment evidence clocks', () => {
  it.each([403, 503])('retains observed HTTP %s and server cooldown when its verification error body is interrupted', async status => {
    const client = new SteamCommunityClient('76561198000000001', [
      'steamLoginSecure=76561198000000001%7C%7Csynthetic; Path=/; Secure; Domain=steamcommunity.com',
      'sessionid=synthetic; Path=/; Secure; Domain=steamcommunity.com'
    ], () => undefined, () => undefined, async () => new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error('synthetic interrupted body'), { code: 'ECONNRESET' }))
    } }), { status, headers: { 'Retry-After': '120' } }))
    await expect(client.verifySession()).rejects.toMatchObject({ statusCode: status, retryAfterMs: 120000 })
  })

  it('does not narrow submission evidence by treating slow baseline body completion as its header time', async () => {
    const account = '76561198000000001', friend = '76561198000000002'
    const serverNow = Date.parse('2026-10-18T00:00:00.000Z'), seconds = serverNow / 1000
    let monotonic = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    vi.spyOn(Date, 'now').mockImplementation(() => serverNow + monotonic + 5000)
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST') {
        monotonic = 56000
        return Response.json({ success: 1 }, { headers: { Date: new Date(serverNow + 56000).toUTCString() } })
      }
      monotonic = 1000
      const html = `<script>g_steamID="${account}";</script>` +
        `<div id="commentthread_Profile_${friend}_area" class="commentthread_area">` +
        `<div id="commentthread_Profile_${friend}_posts" class="commentthread_comments"></div></div>`
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        monotonic = 11000
        controller.enqueue(new TextEncoder().encode(html))
        controller.close()
      } }, { highWaterMark: 0 })
      return new Response(body, { headers: { Date: new Date(serverNow + 1000).toUTCString() } })
    })
    const recovery = createSteamNetworkRecovery({ createRoute: () => ({
      fetch: fetchImpl, resolveProxy: async () => 'DIRECT', dispose: () => undefined
    }) })
    try {
      const client = new SteamCommunityClient(account, [
        `steamLoginSecure=${account}%7C%7Csynthetic-token; Path=/; Secure; Domain=steamcommunity.com`,
        'sessionid=synthetic; Path=/; Secure; Domain=steamcommunity.com'
      ], () => undefined, () => undefined, recovery.fetch)
      const evidence: CommentAttemptEvidence[] = []
      await expect(client.postProfileComment(friend, 'synthetic fixture', () => undefined,
        value => evidence.push(value))).resolves.toEqual({ commentId: null })
      expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST'])
      expect(evidence[0]!.serverWindow).toEqual({ earliest: seconds + 8, latest: seconds + 63 })
      expect(evidence.at(-1)!.serverWindow).toEqual({ earliest: seconds + 9, latest: seconds + 58 })
    } finally { recovery.dispose() }
  })
})
