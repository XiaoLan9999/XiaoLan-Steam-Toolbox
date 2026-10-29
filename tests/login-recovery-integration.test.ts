import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EAuthSessionGuardType } from 'steam-session'
import { SteamService } from '../src/main/steam-service'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import type { AppEvent } from '../src/shared/types'
import type { LoginDiagnosticEvent } from '../src/shared/diagnostics'

const ACCOUNT = '76561198000000001'
const OTHER_ACCOUNT = '76561198000000002'
const TEMPORARY = realpathSync(tmpdir())
const fixtures: Array<{ directory: string; service: SteamService; store: SqliteStore }> = []
const cipher: SecretCipher = {
  isAvailable: () => true, backend: () => 'synthetic-test',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString('utf8')
}

function integer(value: number): Buffer {
  const bytes: number[] = []
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7 } while (value)
  return Buffer.from(bytes)
}

function bytes(field: number, value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([integer((field << 3) | 2), integer(body.length), body])
}

function refreshToken(): string {
  return [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: ACCOUNT, aud: ['derive', 'web'], exp: 4_000_000_000 })).toString('base64url'),
    Buffer.from('synthetic-signature-not-a-real-token').toString('base64url')].join('.')
}

function qrResponse(): Response {
  const interval = Buffer.alloc(5)
  interval[0] = 0x25
  interval.writeFloatLE(5, 1)
  return protobuf(Buffer.concat([
    Buffer.from([8, 123]), bytes(2, 'https://example.invalid/synthetic-qr'), bytes(3, Buffer.from([1, 2, 3])), interval,
    bytes(5, Buffer.from([8, EAuthSessionGuardType.DeviceConfirmation]))
  ]))
}

function protobuf(body: Buffer): Response {
  return new Response(Uint8Array.from(body), { headers: { 'x-eresult': '1', 'content-type': 'application/octet-stream' } })
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}

function pending<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}

type Fault = 'transfer-http' | 'missing-cookie' | 'cookie-mismatch' | 'page-mismatch'

function fixture(options: { retryPoll?: boolean; fault?: Fault; verification?: Promise<Response> } = {}) {
  const directory = realpathSync(mkdtempSync(join(TEMPORARY, 'xiaolan-login-recovery-')))
  const store = new SqliteStore(join(directory, 'synthetic.sqlite3'), cipher)
  const events: AppEvent[] = []
  const diagnostics: LoginDiagnosticEvent[] = []
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  let polls = 0
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push({ url, init })
    if (url.hostname === 'api.steampowered.com') {
      if (url.pathname === '/IAuthenticationService/BeginAuthSessionViaQR/v1/') return qrResponse()
      if (url.pathname === '/IAuthenticationService/PollAuthSessionStatus/v1/') {
        polls++
        if (options.retryPoll && polls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
        return protobuf(Buffer.concat([bytes(3, refreshToken()), Buffer.from([0x28, 1]), bytes(6, 'synthetic-user')]))
      }
    }
    if (url.href === 'https://login.steampowered.com/jwt/finalizelogin') {
      expect((init!.body as FormData).get('nonce')).toBe(refreshToken())
      return json({ steamID: ACCOUNT, transfer_info: [
        { url: 'https://store.steampowered.com/login/settoken', params: { nonce: 'synthetic-store', auth: 'synthetic-store-auth' } },
        { url: 'https://help.steampowered.com/login/settoken', params: { nonce: 'synthetic-help', auth: 'synthetic-help-auth' } },
        { url: 'https://checkout.steampowered.com/login/settoken', params: { nonce: 'synthetic-checkout', auth: 'synthetic-checkout-auth' } },
        { url: 'https://steamcommunity.com/login/settoken', params: { nonce: 'synthetic-community', auth: 'synthetic-community-auth' } }
      ] })
    }
    if (url.href === 'https://steamcommunity.com/login/settoken') {
      expect((init!.body as FormData).get('steamID')).toBe(ACCOUNT)
      if (options.fault === 'transfer-http') return json({ result: 15 }, { status: 403 })
      if (options.fault === 'missing-cookie') return json({ result: 1 })
      const owner = options.fault === 'cookie-mismatch' ? OTHER_ACCOUNT : ACCOUNT
      return json({ result: 1 }, { headers: {
        'set-cookie': `steamLoginSecure=${owner}%7C%7Csynthetic-cookie; Path=/; Secure; HttpOnly; Domain=steamcommunity.com`
      } })
    }
    if (url.hostname === 'steamcommunity.com') {
      expect(new Headers(init?.headers).get('cookie')).toContain(`steamLoginSecure=${ACCOUNT}%7C%7Csynthetic-cookie`)
      if (url.pathname === `/profiles/${ACCOUNT}/edit/info`) {
        if (options.verification) return options.verification
        return new Response(`<script>g_steamID="${options.fault === 'page-mismatch' ? OTHER_ACCOUNT : ACCOUNT}";</script>`)
      }
      if (url.pathname === `/profiles/${ACCOUNT}` && url.searchParams.get('xml') === '1') {
        return new Response(`<profile><steamID64>${ACCOUNT}</steamID64><steamID>Synthetic fixture</steamID><onlineState>online</onlineState></profile>`)
      }
      if (url.pathname === '/textfilter/ajaxgetfriendslist') return json({ success: 1, friendslist: { friends: [] } })
      if (url.pathname === '/actions/EmoticonList') return json([])
    }
    throw new Error('Unexpected offline login route')
  })
  vi.stubGlobal('fetch', fetchMock)
  // These are fail-closed tripwires, not a fallback to the machine's network.
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Real HTTPS is forbidden in login fixtures') })
  vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Real HTTP is forbidden in login fixtures') })
  const service = new SteamService(store, event => events.push(event), () => undefined,
    { onLoginDiagnostic: event => diagnostics.push(event) })
  fixtures.push({ directory, store, service })
  return { service, store, events, diagnostics, requests, fetchMock }
}

afterEach(() => {
  for (const { directory, service, store } of fixtures.splice(0)) {
    service.dispose()
    store.close()
    if (dirname(directory) !== TEMPORARY || !basename(directory).startsWith('xiaolan-login-recovery-')) {
      throw new Error('Unsafe synthetic login fixture cleanup')
    }
    rmSync(directory, { recursive: true, force: true })
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('actual SDK and Community login recovery integration', () => {
  it('recovers the same QR poll, skips optional sites, and only commits after actual Community identity verification', async () => {
    const verification = pending<Response>()
    const f = fixture({ retryPoll: true, verification: verification.promise })
    const login = await f.service.startQrLogin()
    expect(login.qrChallengeUrl).toBe('https://example.invalid/synthetic-qr')
    await vi.waitFor(() => expect(f.requests.some(({ url }) => url.pathname.endsWith('/edit/info'))).toBe(true), { timeout: 3000 })
    expect(f.events).toContainEqual({ type: 'authCompleting', loginId: login.loginId })
    expect(f.events.some(event => event.type === 'authFinished')).toBe(false)
    expect(f.store.getAccounts()).toEqual([])
    // A second Guard submission is harmless once the SDK has authenticated/cancelled its polling.
    await expect(f.service.submitSteamGuard(login.loginId, 'synthetic-unused')).resolves.toBeUndefined()
    verification.resolve(new Response(`<script>g_steamID="${ACCOUNT}";</script>`))
    await vi.waitFor(() => expect(f.events).toContainEqual({ type: 'authFinished', loginId: login.loginId, accountId: ACCOUNT }))
    expect(f.events.some(event => event.type === 'authFailed')).toBe(false)
    expect(f.store.getAccounts()).toHaveLength(1)
    expect(f.store.getAccount(ACCOUNT)?.displayName).toBe('Synthetic fixture')
    expect(f.store.getRefreshToken(ACCOUNT)).toBe(refreshToken())
    expect(f.service.isAuthenticated(ACCOUNT)).toBe(true)
    const ordered = f.events.filter(event => event.type === 'authCompleting' || event.type === 'authFinished').map(event => event.type)
    expect(ordered).toEqual(['authCompleting', 'authFinished'])
    expect(f.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'request', endpoint: 'poll', outcome: 'failed', networkCode: 'ECONNRESET' }),
      expect.objectContaining({ stage: 'web-cookies', outcome: 'success' }),
      expect.objectContaining({ stage: 'session-verify', outcome: 'success' }),
      expect.objectContaining({ stage: 'completed', outcome: 'success' })
    ]))
    const polls = f.requests.filter(({ url }) => url.pathname.includes('/PollAuthSessionStatus/'))
    expect(polls).toHaveLength(2)
    expect((polls[0]!.init!.body as FormData).get('input_protobuf_encoded'))
      .toBe((polls[1]!.init!.body as FormData).get('input_protobuf_encoded'))
    expect(f.requests.filter(({ url }) => url.pathname.includes('/BeginAuthSessionViaQR/'))).toHaveLength(1)
    expect(f.requests.some(({ url }) => ['store.steampowered.com', 'help.steampowered.com', 'checkout.steampowered.com'].includes(url.hostname))).toBe(false)
    expect(JSON.stringify(f.diagnostics)).not.toContain(refreshToken())
    expect(JSON.stringify(f.diagnostics)).not.toContain('synthetic-cookie')
  })

  it.each<Fault>(['transfer-http', 'missing-cookie', 'cookie-mismatch', 'page-mismatch'])(
    'does not declare success or persist an account when Community verification fails: %s', async fault => {
      const f = fixture({ fault })
      const login = await f.service.startQrLogin()
      await vi.waitFor(() => expect(f.events.some(event => event.type === 'authFailed' && event.loginId === login.loginId)).toBe(true))
      expect(f.events).toContainEqual({ type: 'authCompleting', loginId: login.loginId })
      expect(f.events.some(event => event.type === 'authFinished')).toBe(false)
      expect(f.store.getAccounts()).toEqual([])
      expect(f.store.getRefreshToken(ACCOUNT)).toBeNull()
      expect(f.service.isAuthenticated(ACCOUNT)).toBe(false)
      expect(f.diagnostics.some(event => event.stage === 'completed')).toBe(false)
      expect(f.requests.some(({ url }) => ['store.steampowered.com', 'help.steampowered.com', 'checkout.steampowered.com'].includes(url.hostname))).toBe(false)
      if (fault === 'page-mismatch') expect(f.diagnostics.some(event => event.stage === 'session-verify' && event.outcome === 'started')).toBe(true)
      else expect(f.requests.some(({ url }) => url.pathname.endsWith('/edit/info'))).toBe(false)
    })
})
