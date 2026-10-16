import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotNameService } from '../src/main/steam-screenshot-names'
import type { ScreenshotCatalog, ScreenshotGame, ScreenshotUser } from '../src/shared/steam-screenshots'

const STEAM_ID = '76561198000000001'
const OTHER_STEAM_ID = '76561198000000002'
const NOW = Date.parse('2026-10-16T04:00:00.000Z')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('steam-screenshot-names-')) {
      throw new Error('Refusing to remove a directory outside the test workspace')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(fetchImpl: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'steam-screenshot-names-'))
  directories.push(directory)
  const cachePath = join(directory, 'names.json')
  return { directory, cachePath, service: new ScreenshotNameService({ cachePath, fetchImpl, now: () => NOW }) }
}

function fakeFetch(callback: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => Promise.resolve(callback(new URL(String(input)), init ?? {}))) as unknown as typeof fetch
}

function game(appId = '440', overrides: Partial<ScreenshotGame> = {}): ScreenshotGame {
  return { appId, name: `AppID ${appId}`, nameSource: 'fallback', installed: false, userIds: [], ...overrides }
}

function user(steamId = STEAM_ID, overrides: Partial<ScreenshotUser> = {}): ScreenshotUser {
  return { id: '39734273', steamId, displayName: '39734273', mostRecent: false, nameSource: 'fallback', ...overrides }
}

function catalog(games: ScreenshotGame[] = [], users: ScreenshotUser[] = []): ScreenshotCatalog {
  return { steamPath: null, refreshedAt: new Date(NOW).toISOString(), steamRunning: false, games, users, warnings: [] }
}

function storeResponse(appId = '440', name: unknown = 'Test Game', overrides: Record<string, unknown> = {}): Response {
  return Response.json({ [appId]: { success: true, data: { steam_appid: Number(appId), name, ...overrides } } })
}

function profileResponse(steamId = STEAM_ID, name = 'Test Player'): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><profile><steamID64>${steamId}</steamID64><steamID><![CDATA[${name}]]></steamID></profile>`, {
    headers: { 'Content-Type': 'application/xml' }
  })
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function tick(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe('screenshot public name transport', () => {
  it('uses anonymous GETs to fixed official endpoints with redirect errors and no cookie or bearer credentials', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) })
      const headers = new Headers(init.headers)
      expect(headers.has('Cookie')).toBe(false)
      expect(headers.has('Authorization')).toBe(false)
      expect([...headers.keys()]).toEqual(['accept'])
      if (url.hostname === 'store.steampowered.com') {
        expect(url.href).toBe('https://store.steampowered.com/api/appdetails?appids=440&filters=basic&l=schinese')
        expect(headers.get('accept')).toBe('application/json')
        return storeResponse()
      }
      expect(url.href).toBe(`https://steamcommunity.com/profiles/${STEAM_ID}/?xml=1`)
      expect(headers.get('accept')).toBe('application/xml')
      return profileResponse()
    })
    const { service } = fixture(fetchImpl)
    const input = catalog([game()], [user()])
    await service.refresh(input, new AbortController().signal, () => {})
    const output = service.enrich(input)
    expect(output.games[0]).toMatchObject({ appId: '440', name: 'Test Game', nameSource: 'store' })
    expect(output.users[0]).toMatchObject({ steamId: STEAM_ID, displayName: 'Test Player', nameSource: 'profile' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['0', '-1', '1.2', '001', '4294967296', '9999999999', '440/../../', 'https://other.invalid/', '440?appids=570'])('rejects invalid manually selected AppID %s before any request', async appId => {
    const fetchImpl = fakeFetch(() => { throw new Error('Unexpected request') })
    const { service, cachePath } = fixture(fetchImpl)
    await expect(service.resolveGame(appId, new AbortController().signal)).rejects.toMatchObject({ code: 'SCREENSHOT_INVALID_GAME' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(existsSync(cachePath)).toBe(false)
  })

  it('never turns an untrusted user ID or AppID into another hostname or path', async () => {
    const fetchImpl = fakeFetch(() => { throw new Error('Unexpected request') })
    const { service } = fixture(fetchImpl)
    await service.refresh(catalog([game('440/evil')], [user('https://other.invalid/')]), new AbortController().signal, () => {})
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves local names on network or redirect failures without following the target', async () => {
    const fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed: redirect mode error') })
    const { service } = fixture(fetchImpl)
    const input = catalog([game()], [user()])
    await expect(service.refresh(input, new AbortController().signal, () => {})).resolves.toBeUndefined()
    expect(service.enrich(input)).toEqual(input)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not persist Set-Cookie or any other response headers into the name cache', async () => {
    const { service, cachePath } = fixture(fakeFetch(() => {
      const response = storeResponse('440', 'Test Game', { access_token: 'synthetic-response-token' })
      response.headers.set('Set-Cookie', 'unit-test-cookie=not-a-real-cookie')
      response.headers.set('Authorization', 'unit-test-bearer')
      return response
    }))
    await service.refresh(catalog([game()]), new AbortController().signal, () => {})
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(persisted).toEqual({ version: 1, games: { '440': { name: 'Test Game', checkedAt: new Date(NOW).toISOString() } }, users: {} })
    expect(readFileSync(cachePath, 'utf8')).not.toMatch(/cookie|token|session|authorization|https:\/\//i)
  })
})

describe('screenshot name identity and schema validation', () => {
  it.each([
    { '570': { success: true, data: { steam_appid: 570, name: 'Wrong Game' } } },
    { '440': { success: false, data: { steam_appid: 440, name: 'Rejected Game' } } },
    { '440': { success: true, data: { steam_appid: 570, name: 'Other AppID' } } },
    { '440': { success: true, data: { name: 'Missing AppID' } } },
    { '440': { success: true, data: null } },
    [{ steam_appid: 440, name: 'Wrong Shape' }],
    null
  ])('does not attach store names without the matching key and Steam AppID: %j', async body => {
    const { service } = fixture(fakeFetch(() => Response.json(body)))
    const input = catalog([game()])
    await service.refresh(input, new AbortController().signal, () => {})
    expect(service.enrich(input).games).toEqual(input.games)
  })

  it('accepts a matching numeric or string Steam AppID and trims the display name', async () => {
    const { service } = fixture(fakeFetch(() => storeResponse('440', '  Friendly Game  ', { steam_appid: '440' })))
    expect(await service.resolveGame('440', new AbortController().signal)).toMatchObject({ appId: '440', name: 'Friendly Game', nameSource: 'store' })
  })

  it('does not round a SteamID64 or borrow a different profile name', async () => {
    const { service } = fixture(fakeFetch(() => profileResponse(OTHER_STEAM_ID, 'Someone Else')))
    const input = catalog([], [user()])
    await service.refresh(input, new AbortController().signal, () => {})
    expect(service.enrich(input).users).toEqual(input.users)
  })

  it.each([
    '<profile><steamID>Missing Identity</steamID></profile>',
    '<response><steamID64>76561198000000001</steamID64><steamID>Wrong Root</steamID></response>',
    '<profile><steamID64>76561198000000001</steamID64><steamID><nested>Not Text</nested></steamID></profile>',
    '<html><body>Login required</body></html>'
  ])('leaves userdata fallback names intact for malformed or identity-free profiles: %s', async xml => {
    const { service } = fixture(fakeFetch(() => new Response(xml)))
    const input = catalog([], [user()])
    await service.refresh(input, new AbortController().signal, () => {})
    expect(service.enrich(input).users).toEqual(input.users)
  })

  it.each(['', '   ', 'a'.repeat(257), 'bad\u0000name', 'bad\nname', 123, null, { name: 'Object' }])('rejects blank, oversized, control-bearing or non-string names: %j', async name => {
    const { service } = fixture(fakeFetch(() => storeResponse('440', name)))
    const input = catalog([game()])
    await service.refresh(input, new AbortController().signal, () => {})
    expect(service.enrich(input).games).toEqual(input.games)
  })

  it('preserves a trusted local manifest game name instead of replacing it with the online cache', async () => {
    const { service } = fixture(fakeFetch(() => storeResponse('440', 'Store Title')))
    await service.resolveGame('440', new AbortController().signal)
    const input = catalog([game('440', { name: 'Installed Manifest Title', nameSource: 'manifest', installed: true })])
    expect(service.enrich(input).games[0]).toEqual(input.games[0])
  })

  it('uses a matching toolbox account name as the offline userdata fallback without altering the local login identity', () => {
    const { service } = fixture(fakeFetch(() => { throw new Error('Offline') }))
    const input = catalog([], [user(), user(OTHER_STEAM_ID, { id: '39734274', displayName: 'Known Login Name', nameSource: 'loginusers' })])
    const output = service.enrich(input, [{ steamId: STEAM_ID, displayName: 'Toolbox Player' }, { steamId: OTHER_STEAM_ID, displayName: 'Other Alias' }])
    expect(output.users[0]).toMatchObject({ steamId: STEAM_ID, displayName: 'Toolbox Player', nameSource: 'account' })
    expect(output.users[1]).toEqual(input.users[1])
    expect(input.users[0]?.displayName).toBe('39734273')
  })
})

describe('screenshot name cache and bounded responses', () => {
  it('reopens a persisted game and profile name cache offline without transmitting credentials', async () => {
    const { service, cachePath } = fixture(fakeFetch(url => url.hostname === 'store.steampowered.com' ? storeResponse() : profileResponse()))
    const input = catalog([game()], [user()])
    await service.refresh(input, new AbortController().signal, () => {})
    const offlineFetch = fakeFetch(() => { throw new Error('Offline') })
    const reopened = new ScreenshotNameService({ cachePath, fetchImpl: offlineFetch })
    expect(reopened.enrich(input).games[0]?.name).toBe('Test Game')
    expect(reopened.enrich(input).users[0]?.displayName).toBe('Test Player')
    await reopened.refresh(input, new AbortController().signal, () => {})
    expect(reopened.enrich(input).games[0]?.name).toBe('Test Game')
    expect(reopened.enrich(input).users[0]?.displayName).toBe('Test Player')
    expect(readdirSync(dirname(cachePath))).toEqual(['names.json'])
  })

  it('resolves a manually entered known AppID using the cache when the public store request is offline', async () => {
    const { service, cachePath } = fixture(fakeFetch(() => storeResponse()))
    await service.resolveGame('440', new AbortController().signal)
    const reopened = new ScreenshotNameService({ cachePath, fetchImpl: fakeFetch(() => { throw new TypeError('Offline') }) })
    await expect(reopened.resolveGame('440', new AbortController().signal)).resolves.toEqual({
      appId: '440', name: 'Test Game', nameSource: 'store', installed: false, userIds: []
    })
  })

  it('keeps a valid unknown manual AppID usable as a fallback if its store name cannot be fetched', async () => {
    const { service } = fixture(fakeFetch(() => { throw new TypeError('Offline') }))
    await expect(service.resolveGame('440', new AbortController().signal)).resolves.toEqual({
      appId: '440', name: 'AppID 440', nameSource: 'fallback', installed: false, userIds: []
    })
  })

  it('does not hide a manual AppID query rate limit behind a cached name', async () => {
    const { service, cachePath } = fixture(fakeFetch(() => storeResponse()))
    await service.resolveGame('440', new AbortController().signal)
    const limited = new ScreenshotNameService({ cachePath, fetchImpl: fakeFetch(() => new Response(null, { status: 429 })) })
    await expect(limited.resolveGame('440', new AbortController().signal)).rejects.toMatchObject({ code: 'SCREENSHOT_NAMES_RATE_LIMITED' })
  })

  it.each(['not json', JSON.stringify({ version: 9, games: { '440': { name: 'Untrusted', checkedAt: new Date(NOW).toISOString() } } }), 'x'.repeat(4 * 1024 * 1024 + 1)])('ignores a malformed, unknown-version or oversized cache', cache => {
    const { cachePath } = fixture(fakeFetch(() => { throw new Error('Unexpected request') }))
    writeFileSync(cachePath, cache)
    const reopened = new ScreenshotNameService({ cachePath, fetchImpl: fakeFetch(() => { throw new Error('Offline') }) })
    expect(reopened.enrich(catalog([game()], [user()])).games[0]?.nameSource).toBe('fallback')
    expect(reopened.enrich(catalog([game()], [user()])).users[0]?.nameSource).toBe('fallback')
  })

  it('loads only validated names and timestamps and drops unknown or credential-shaped cache fields on save', async () => {
    const { cachePath } = fixture(fakeFetch(() => { throw new Error('Unexpected request') }))
    writeFileSync(cachePath, JSON.stringify({ version: 1, token: 'unit-test-secret', games: {
      '440': { name: 'Cached Game', checkedAt: new Date(NOW).toISOString(), cookie: 'unit-test-cookie' },
      '570': { name: 'Bad Time', checkedAt: 'yesterday' },
      'bad/path': { name: 'Wrong ID', checkedAt: new Date(NOW).toISOString() }
    }, users: { [STEAM_ID]: { name: 'Cached Player', checkedAt: new Date(NOW).toISOString(), accessToken: 'unit-test-token' } } }))
    const service = new ScreenshotNameService({ cachePath, fetchImpl: fakeFetch(() => { throw new Error('Offline') }) })
    const input = catalog([game(), game('570')], [user()])
    expect(service.enrich(input).games.map(item => item.name)).toEqual(['Cached Game', 'AppID 570'])
    await service.refresh(catalog(), new AbortController().signal, () => {})
    const persisted = readFileSync(cachePath, 'utf8')
    expect(persisted).not.toMatch(/token|cookie|unit-test-secret|bad\/path|Bad Time/i)
    expect(JSON.parse(persisted).users[STEAM_ID]).toEqual({ name: 'Cached Player', checkedAt: new Date(NOW).toISOString() })
  })

  it('bounds streamed public responses to one MiB and cancels the rejected reader', async () => {
    const cancelled = vi.fn()
    const fetchImpl = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel: cancelled
    })))
    const { service, cachePath } = fixture(fetchImpl)
    const input = catalog([game()])
    await service.refresh(input, new AbortController().signal, () => {})
    expect(service.enrich(input).games).toEqual(input.games)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).games).toEqual({})
  })

  it('cancels unread non-success and rate-limited response bodies', async () => {
    const cancelled = vi.fn()
    const { service } = fixture(fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status: 403 })))
    await service.refresh(catalog([game()]), new AbortController().signal, () => {})
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})

describe('screenshot name work scheduling and cancellation', () => {
  it('covers every fallback game without the old 30-target or arbitrary catalog-size limit', async () => {
    const fetchImpl = fakeFetch(url => {
      const id = url.searchParams.get('appids')!
      return storeResponse(id, `Game ${id}`)
    })
    const { service } = fixture(fetchImpl)
    const input = catalog(Array.from({ length: 1001 }, (_, index) => game(String(index + 1))))
    const progress: number[] = []
    await service.refresh(input, new AbortController().signal, pending => progress.push(pending))
    expect(fetchImpl).toHaveBeenCalledTimes(1001)
    expect(service.enrich(input).games.every(item => item.nameSource === 'store')).toBe(true)
    expect(progress[0]).toBe(1001)
    expect(progress.at(-1)).toBe(0)
    expect(progress).toHaveLength(1002)
  })

  it('never has more than three public-name requests in flight', async () => {
    let active = 0
    let maximum = 0
    const fetchImpl = fakeFetch(async url => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return storeResponse(url.searchParams.get('appids')!)
    })
    const { service } = fixture(fetchImpl)
    await service.refresh(catalog(Array.from({ length: 24 }, (_, index) => game(String(index + 1)))), new AbortController().signal, () => {})
    expect(fetchImpl).toHaveBeenCalledTimes(24)
    expect(maximum).toBe(3)
    expect(active).toBe(0)
  })

  it('shares the three-request budget across overlapping catalog refreshes and manual AppID queries', async () => {
    let active = 0
    let maximum = 0
    const fetchImpl = fakeFetch(async url => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return storeResponse(url.searchParams.get('appids')!)
    })
    const { service } = fixture(fetchImpl)
    const first = catalog(Array.from({ length: 12 }, (_, index) => game(String(index + 1))))
    const second = catalog(Array.from({ length: 12 }, (_, index) => game(String(index + 101))))
    await Promise.all([
      service.refresh(first, new AbortController().signal, () => {}),
      service.refresh(second, new AbortController().signal, () => {}),
      ...Array.from({ length: 6 }, (_, index) => service.resolveGame(String(index + 201), new AbortController().signal))
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(30)
    expect(maximum).toBe(3)
    expect(active).toBe(0)
  })

  it('removes a cancelled waiting query without occupying a request slot or starving the next query', async () => {
    const release = deferred<void>()
    const ids: string[] = []
    const fetchImpl = fakeFetch(async url => {
      const id = url.searchParams.get('appids')!
      ids.push(id)
      if (Number(id) <= 3) await release.promise
      return storeResponse(id)
    })
    const { service } = fixture(fetchImpl)
    const first = ['1', '2', '3'].map(id => service.resolveGame(id, new AbortController().signal))
    const cancellation = new AbortController()
    const abandoned = service.resolveGame('4', cancellation.signal)
    const rejected = expect(abandoned).rejects.toBeDefined()
    const next = service.resolveGame('5', new AbortController().signal)
    await tick()
    expect(ids).toEqual(['1', '2', '3'])
    cancellation.abort()
    await rejected
    release.resolve()
    await Promise.all([...first, next])
    expect(ids).toEqual(['1', '2', '3', '5'])
    expect(service.enrich(catalog([game('4')])).games[0]?.nameSource).toBe('fallback')
  })

  it('starts a fresh lookup instead of reusing a cancelled in-flight lookup for the same AppID', async () => {
    const staleResponse = deferred<Response>()
    let requests = 0
    const fetchImpl = fakeFetch(() => ++requests === 1 ? staleResponse.promise : storeResponse('440', 'Fresh Game'))
    const { service, cachePath } = fixture(fetchImpl)
    const cancellation = new AbortController()
    const oldRefresh = service.refresh(catalog([game()]), cancellation.signal, () => {})
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    cancellation.abort()
    await expect(service.resolveGame('440', new AbortController().signal)).resolves.toMatchObject({ name: 'Fresh Game' })
    staleResponse.resolve(storeResponse('440', 'Cancelled Stale Game'))
    await oldRefresh
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(service.enrich(catalog([game()])).games[0]?.name).toBe('Fresh Game')
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).games['440'].name).toBe('Fresh Game')
  })

  it('stops scheduling more work after HTTP 429 rather than attempting the whole game list', async () => {
    const cancellations = vi.fn()
    const fetchImpl = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancellations }), { status: 429 }))
    const { service } = fixture(fetchImpl)
    const input = catalog(Array.from({ length: 1001 }, (_, index) => game(String(index + 1))))
    const progress: number[] = []
    await expect(service.refresh(input, new AbortController().signal, pending => progress.push(pending))).rejects.toMatchObject({ code: 'SCREENSHOT_NAMES_RATE_LIMITED' })
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThanOrEqual(3)
    expect(cancellations).toHaveBeenCalledTimes(vi.mocked(fetchImpl).mock.calls.length)
    expect(progress.at(-1)).toBeGreaterThan(0)
    expect(service.enrich(input).games.every(item => item.nameSource === 'fallback')).toBe(true)
  })

  it('does not request or create a cache for an already-cancelled catalog refresh', async () => {
    const fetchImpl = fakeFetch(() => storeResponse())
    const { service, cachePath } = fixture(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    await service.refresh(catalog([game()], [user()]), controller.signal, () => {})
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(existsSync(cachePath)).toBe(false)
  })

  it('does not overwrite an existing cache when a refresh is cancelled while the response is pending', async () => {
    const response = deferred<Response>()
    const fetchImpl = fakeFetch(() => response.promise)
    const { service, cachePath } = fixture(fetchImpl)
    const previous = JSON.stringify({ version: 1, games: {}, users: {} })
    writeFileSync(cachePath, previous)
    const controller = new AbortController()
    const input = catalog([game()])
    const refresh = service.refresh(input, controller.signal, () => {})
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    controller.abort()
    response.resolve(storeResponse())
    await refresh
    expect(readFileSync(cachePath, 'utf8')).toBe(previous)
    expect(service.enrich(input).games).toEqual(input.games)
    expect(readdirSync(dirname(cachePath))).toEqual(['names.json'])
  })

  it('does not save a cancelled manual AppID resolution after its delayed response arrives', async () => {
    const response = deferred<Response>()
    const { service, cachePath } = fixture(fakeFetch(() => response.promise))
    const controller = new AbortController()
    const resolution = service.resolveGame('440', controller.signal)
    await tick()
    controller.abort()
    response.resolve(storeResponse())
    await expect(resolution).rejects.toBeDefined()
    expect(existsSync(cachePath)).toBe(false)
    expect(service.enrich(catalog([game()])).games[0]?.nameSource).toBe('fallback')
  })
})
