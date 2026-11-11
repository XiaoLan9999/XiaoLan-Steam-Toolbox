import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamAuthenticatorConfirmationsService, type SteamAuthenticatorConfirmationConnection, type SteamAuthenticatorConfirmationJournal } from '../src/main/steam-authenticator-confirmations'
import type { SteamAuthenticatorConfirmationSnapshot } from '../src/shared/steam-authenticator-confirmations'

const OWNER = '76561198000000001', OTHER = '76561198000000002'
const SECRET = Buffer.from('0123456789abcdefghij').toString('base64')
const DEVICE = 'android:00000000-0000-4000-8000-000000000001'
const NONCE = '18446744073709551614', ID = '9000000000000000001'
const PRIVATE = 'PRIVATE_CONFIRMATION_EXCEPTION_NEVER_RENDER'
const services: SteamAuthenticatorConfirmationsService[] = []
const row = (overrides: Record<string, unknown> = {}) => ({ id: ID, nonce: NONCE, type: 2, headline: 'Synthetic trade', summary: ['Synthetic sent items', 'Synthetic received items'], icon: 'https://untrusted.example/private-image', ...overrides })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }

function fixture(leaseMs?: number, journal?: SteamAuthenticatorConfirmationJournal) {
  let currentTime = 1000000
  let raw: unknown = { success: true, conf: [row(), row({ id: '9000000000000000002', nonce: '123', type: 6, headline: 'Account recovery' })] }
  let currentMaterial = { steamId: OWNER, identitySecret: SECRET, deviceId: DEVICE }
  const connection = {
    steamId: OWNER, contextId: 'context-original',
    assertCurrent: vi.fn(() => {}),
    list: vi.fn(async (_params: URLSearchParams): Promise<unknown> => structuredClone(raw)),
    respond: vi.fn(async (_params: URLSearchParams): Promise<unknown> => ({ success: true }))
  } satisfies SteamAuthenticatorConfirmationConnection
  const options = {
    material: vi.fn(async (_id: string) => ({ ...currentMaterial })),
    connect: vi.fn(async (_steamId: string) => connection),
    timeSeconds: vi.fn(async () => 1700000123),
    confirm: vi.fn(async () => true), now: () => currentTime, leaseMs, journal
  }
  const service = new SteamAuthenticatorConfirmationsService(options)
  services.push(service)
  const list = () => service.list({ entryId: 'auth-entry-1' })
  const respond = (snapshot: SteamAuthenticatorConfirmationSnapshot, action: 'allow' | 'cancel' = 'allow', confirmationId = ID) => service.respond({ entryId: snapshot.entryId, listId: snapshot.listId, confirmationId, action })
  return { service, connection, options, list, respond, raw(value: unknown) { raw = value },
    material(value: Partial<typeof currentMaterial>) { currentMaterial = { ...currentMaterial, ...value } }, advance(milliseconds: number) { currentTime += milliseconds } }
}
function journalFixture() {
  const pairs = new Set<string>()
  const journal = {
    has: vi.fn(async (pair: string) => pairs.has(pair)),
    reserve: vi.fn(async (pair: string) => { if (pairs.has(pair)) return false; pairs.add(pair); return true }),
    finish: vi.fn(async (pair: string, outcome: 'accepted' | 'rejected' | 'unknown') => { if (outcome === 'rejected') pairs.delete(pair); else pairs.add(pair) })
  } satisfies SteamAuthenticatorConfirmationJournal
  return { journal, pairs }
}

function signature(time: number, tag: string): string {
  const timestamp = Buffer.from(BigInt(time).toString(16).padStart(16, '0'), 'hex')
  return createHmac('sha1', Buffer.from(SECRET, 'base64')).update(Buffer.concat([timestamp, Buffer.from(tag)])).digest('base64')
}
function safe(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, NONCE, DEVICE, PRIVATE, 'context-original', 'private-image']) expect(text).not.toContain(secret)
  for (const field of ['identitySecret', 'identity_secret', 'nonce', 'cookies', 'accessToken', 'refreshToken']) expect(text).not.toContain(`"${field}"`)
}
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe('durable financial safety reservations', () => {
  it('persists a hash-only reservation before invoking the only mutable request and then records acceptance', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    f.connection.respond.mockImplementationOnce(async () => { expect(pairs.size).toBe(1); return { success: true } })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'accepted', requestSubmitted: true })
    expect(journal.reserve).toHaveBeenCalledOnce(); expect(journal.finish).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[a-f0-9]{64}$/), 'accepted')
    expect(journal.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.connection.respond.mock.invocationCallOrder[0]!)
    for (const argument of [...journal.has.mock.calls, ...journal.reserve.mock.calls, ...journal.finish.mock.calls].map(call => call[0])) {
      expect(argument).toMatch(/^[a-f0-9]{64}$/); expect(argument).not.toContain(OWNER); expect(argument).not.toContain(NONCE)
    }
  })

  it.each(['accepted', 'unknown'] as const)('disables a historical %s pair in a replacement service, even after a vault entry is reimported under another id', async outcome => {
    const { journal } = journalFixture(), first = fixture(undefined, journal)
    if (outcome === 'unknown') first.connection.respond.mockRejectedValueOnce(new Error(PRIVATE))
    expect(await first.respond(await first.list())).toMatchObject({ outcome, requestSubmitted: true })
    first.service.dispose()
    const next = fixture(undefined, journal), listed = await next.service.list({ entryId: 'auth-entry-reimported' })
    expect(listed.items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
    expect(await next.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(next.options.confirm).not.toHaveBeenCalled(); expect(next.connection.respond).not.toHaveBeenCalled()
  })

  it('returns a stable safety error rather than stale when the safety journal cannot be read', async () => {
    const { journal } = journalFixture(), f = fixture(undefined, journal)
    journal.has.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE', message: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('does not silently fall back to memory or return stale after a disk reservation fails', async () => {
    const { journal } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.reserve.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.respond(listed)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE', message: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(f.connection.respond).not.toHaveBeenCalled(); expect(journal.finish).not.toHaveBeenCalled()
  })

  it('never releases a reservation owned by a different already-submitted request', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.reserve.mockImplementationOnce(async pair => { pairs.add(pair); return false })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(journal.finish).not.toHaveBeenCalled(); expect(f.connection.respond).not.toHaveBeenCalled()
    expect((await f.list()).items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
  })

  it('rechecks the exact material after the durable reserve and releases only proof of non-dispatch', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.reserve.mockImplementationOnce(async pair => { pairs.add(pair); f.material({ steamId: OTHER }); return true })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(journal.finish).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'rejected')
    expect(pairs.size).toBe(0); expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('releases an unsubmitted reservation if the UI lease expires while persistence completes', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.reserve.mockImplementationOnce(async pair => { pairs.add(pair); f.advance(60001); return true })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(journal.finish).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'rejected'); expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('fails safely if even proof-of-nondispatch cleanup cannot be saved', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.reserve.mockImplementationOnce(async pair => { pairs.add(pair); f.service.invalidate(); return true })
    journal.finish.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.respond(listed)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(pairs.size).toBe(1); expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('never releases an unknown outcome after the connection respond method has been invoked', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    f.connection.respond.mockRejectedValueOnce(new Error(PRIVATE))
    expect(await f.respond(listed)).toMatchObject({ outcome: 'unknown', requestSubmitted: true })
    expect(journal.finish).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'unknown'); expect(pairs.size).toBe(1)
  })

  it('keeps a submitted result unknown rather than claiming it was unsubmitted if journal finalization fails', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    journal.finish.mockRejectedValue(new Error(PRIVATE))
    expect(await f.respond(listed)).toMatchObject({ outcome: 'unknown', requestSubmitted: true })
    expect(pairs.size).toBe(1); expect(f.connection.respond).toHaveBeenCalledOnce()
    expect((await f.list()).items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
  })

  it('releases an explicitly rejected endpoint response only after persisting that release', async () => {
    const { journal, pairs } = journalFixture(), f = fixture(undefined, journal), listed = await f.list()
    f.connection.respond.mockResolvedValueOnce({ success: false })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'rejected', requestSubmitted: true })
    expect(journal.finish).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'rejected'); expect(pairs.size).toBe(0)
    expect((await f.list()).items[0]).toMatchObject({ canRespond: true })
  })
})

describe('explicit confirmation list and main-only request material', () => {
  it('does not connect, fetch time, or poll until explicitly listed', () => {
    const f = fixture()
    expect(f.options.connect).not.toHaveBeenCalled(); expect(f.options.timeSeconds).not.toHaveBeenCalled()
    expect(f.connection.list).not.toHaveBeenCalled(); expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('signs a bounded list request with the official list tag and returns only plain safe metadata', async () => {
    const f = fixture(); const listed = await f.list()
    expect(f.options.connect).toHaveBeenCalledExactlyOnceWith(OWNER)
    const params = f.connection.list.mock.calls[0]![0]
    expect(params).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries(params)).toEqual({ p: DEVICE, a: OWNER, k: signature(1700000123, 'list'), t: '1700000123', m: 'react', tag: 'list' })
    expect(listed).toMatchObject({ ownerSteamId: OWNER, listedAt: 1000000, expiresAt: 1060000, items: [{ id: ID, type: 2, canRespond: true }, { type: 6, canRespond: false, blockedReason: 'unsupported-type' }] })
    expect(listed.listId).toMatch(/^[0-9a-f-]{36}$/)
    safe(listed)
  })

  it.each([2, 3, '2', '3'])('only enables trading and market-listing confirmation type %s', async type => {
    const f = fixture(); f.raw({ success: true, conf: [row({ type })] })
    expect((await f.list()).items[0]?.canRespond).toBe(true)
  })

  it.each([0, 1, 4, 5, 6, 15, 65535])('shows unsupported security type %s but blocks it before a native prompt or request', async type => {
    const f = fixture(); f.raw({ success: true, conf: [row({ type })] }); const listed = await f.list()
    expect(listed.items[0]).toMatchObject({ type, canRespond: false })
    await expect(f.respond(listed)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_UNSUPPORTED' })
    expect(f.options.confirm).not.toHaveBeenCalled(); expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('does not render or fetch title markup and never exposes remote icon metadata', async () => {
    const f = fixture(); f.raw({ success: true, conf: [row({ headline: '<script>not executed</script>\u202etitle', summary: ['plain\nline'] })] })
    const listed = await f.list()
    expect(listed.items[0]?.title).toBe('<script>not executed</script> title')
    expect(listed.items[0]?.summary).toEqual(['plain line'])
    expect(listed.items[0]).not.toHaveProperty('icon'); safe(listed)
  })

  it.each([undefined, '', 'AAAA', Buffer.alloc(19).toString('base64'), Buffer.alloc(21).toString('base64')])('rejects invalid identity material without connecting: %s', async identitySecret => {
    const f = fixture(); f.material({ identitySecret: identitySecret as string })
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_UNAVAILABLE' })
    expect(f.options.connect).not.toHaveBeenCalled()
  })

  it('does not use a connection for another Steam identity', async () => {
    const f = fixture(); f.connection.steamId = OTHER
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_IDENTITY' })
    expect(f.connection.list).not.toHaveBeenCalled()
  })

  it('does not fall back to local time if anonymous time retrieval fails', async () => {
    const f = fixture(); f.options.timeSeconds.mockRejectedValueOnce(new Error(PRIVATE))
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_TIME_UNAVAILABLE', message: 'AUTH_CONFIRMATION_TIME_UNAVAILABLE' })
    expect(f.connection.list).not.toHaveBeenCalled()
  })

  it.each([{ success: false, message: PRIVATE }, { success: true, needauth: true }, { success: 'true' }, { success: true, conf: null }, { success: true, conf: [row(), row()] }, { success: true, conf: [row({ id: 9007199254740992 })] }])('rejects failed, contradictory, or unsafe list responses without publishing a snapshot', async response => {
    const f = fixture(); f.raw(response)
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_LIST_FAILED', message: 'AUTH_CONFIRMATION_LIST_FAILED' })
    expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('treats an explicitly successful empty list only as an empty list, never a completed transaction', async () => {
    const f = fixture(); f.raw({ success: true }); const listed = await f.list()
    expect(listed.items).toEqual([]); expect(listed).not.toHaveProperty('completed')
  })

  it('clamps leases to the main-only 15–120 second interval and makes expired data unusable', async () => {
    const short = fixture(1); const listed = await short.list()
    expect(listed.expiresAt - listed.listedAt).toBe(15000)
    short.advance(15000); expect(await short.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(short.options.confirm).not.toHaveBeenCalled()
    const long = fixture(999999); const other = await long.list()
    expect(other.expiresAt - other.listedAt).toBe(120000)
  })

  it('does not publish late list results after the service is invalidated', async () => {
    const f = fixture(); const gate = deferred<unknown>(); f.connection.list.mockReturnValueOnce(gate.promise)
    const pending = f.list(); const rejected = expect(pending).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_CHANGED' })
    await flush(); f.service.invalidate(); gate.resolve({ success: true, conf: [row()] }); await rejected
  })
})

describe('one-shot native-confirmed response and fresh lease revalidation', () => {
  it.each([['allow', 'accept'], ['cancel', 'reject']] as const)('submits only one selected row using op %s and signed tag %s', async (action, tag) => {
    const f = fixture(); const listed = await f.list(); const result = await f.respond(listed, action)
    expect(result).toMatchObject({ action, outcome: 'accepted', requestSubmitted: true })
    expect(f.options.connect).toHaveBeenCalledTimes(1)
    expect(f.options.confirm).toHaveBeenCalledExactlyOnceWith(listed.items[0], action, OWNER)
    expect(f.connection.list).toHaveBeenCalledTimes(2); expect(f.options.timeSeconds).toHaveBeenCalledTimes(3)
    expect(f.connection.respond).toHaveBeenCalledTimes(1)
    const params = f.connection.respond.mock.calls[0]![0]
    expect(Object.keys(Object.fromEntries(params)).sort()).toEqual(['a', 'cid[]', 'ck[]', 'k', 'm', 'op', 'p', 't', 'tag'].sort())
    expect(params.getAll('cid[]')).toEqual([ID]); expect(params.getAll('ck[]')).toEqual([NONCE])
    expect(params.get('op')).toBe(action); expect(params.get('tag')).toBe(tag); expect(params.get('k')).toBe(signature(1700000123, tag))
    expect(await f.respond(listed, action)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).toHaveBeenCalledTimes(1); safe(result)
  })

  it('does not send or consume a live lease when the user cancels the native prompt', async () => {
    const f = fixture(); const listed = await f.list(); f.options.confirm.mockResolvedValueOnce(false)
    expect(await f.respond(listed)).toMatchObject({ outcome: 'cancelled', requestSubmitted: false })
    expect(f.connection.respond).not.toHaveBeenCalled(); expect(f.connection.list).toHaveBeenCalledTimes(1)
    expect(await f.respond(listed)).toMatchObject({ outcome: 'accepted' })
  })

  it.each(['material', 'owner', 'session', 'expiry', 'invalidate'] as const)('aborts before a request if %s changes while the native prompt is open', async change => {
    const f = fixture(); const listed = await f.list()
    f.options.confirm.mockImplementationOnce(async () => {
      if (change === 'material') f.material({ identitySecret: Buffer.alloc(20, 2).toString('base64') })
      if (change === 'owner') f.material({ steamId: OTHER })
      if (change === 'session') f.connection.contextId = 'changed-context'
      if (change === 'expiry') f.advance(120000)
      if (change === 'invalidate') f.service.invalidate()
      return true
    })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).not.toHaveBeenCalled(); expect(f.connection.list).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'nonce', 'summary', 'type'] as const)('refuses a refreshed item whose %s changed instead of treating disappearance as confirmation', async change => {
    const f = fixture(); const listed = await f.list()
    f.raw({ success: true, conf: change === 'missing' ? [] : [row(change === 'nonce' ? { nonce: '7' } : change === 'summary' ? { summary: ['Changed items'] } : { type: 6 })] })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('does not retry a failed read-only refresh or submit with an unverifiable list', async () => {
    const f = fixture(); const listed = await f.list(); f.connection.list.mockRejectedValueOnce(new Error(PRIVATE))
    const result = await f.respond(listed)
    expect(result).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.list).toHaveBeenCalledTimes(2); expect(f.connection.respond).not.toHaveBeenCalled(); safe(result)
  })

  it('does not submit when fresh action-time lookup fails after a successful refresh', async () => {
    const f = fixture(); const listed = await f.list()
    f.options.timeSeconds.mockResolvedValueOnce(1700000124).mockRejectedValueOnce(new Error(PRIVATE))
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).not.toHaveBeenCalled()
  })

  it('does not create another connection or Native prompt for a replayed or unrelated lease', async () => {
    const f = fixture(); const listed = await f.list()
    const result = await f.service.respond({ entryId: 'different-entry', listId: listed.listId, confirmationId: ID, action: 'allow' })
    expect(result).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.options.connect).toHaveBeenCalledTimes(1); expect(f.options.confirm).not.toHaveBeenCalled()
  })

  it('serializes in-flight native prompts and refuses concurrent actions rather than double-sending', async () => {
    const f = fixture(); const listed = await f.list(); const gate = deferred<boolean>(); f.options.confirm.mockReturnValueOnce(gate.promise)
    const pending = f.respond(listed); await flush()
    await expect(f.respond(listed)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_BUSY' })
    await expect(f.list()).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_BUSY' })
    gate.resolve(true); expect(await pending).toMatchObject({ outcome: 'accepted' })
    expect(f.options.confirm).toHaveBeenCalledTimes(1); expect(f.connection.respond).toHaveBeenCalledTimes(1)
  })
})

describe('unknown financial outcomes are never automatically or implicitly retried', () => {
  it.each([new Error(PRIVATE), 'invalid-response', { success: 'true' }, { success: true, needauth: true }])('consumes the lease after a request with an unknown result', async reply => {
    const f = fixture(); const listed = await f.list()
    if (reply instanceof Error) f.connection.respond.mockRejectedValueOnce(reply)
    else f.connection.respond.mockResolvedValueOnce(reply)
    const result = await f.respond(listed)
    expect(result).toMatchObject({ outcome: 'unknown', requestSubmitted: true })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).toHaveBeenCalledTimes(1)
    const fresh = await f.list()
    expect(fresh.items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
    expect(await f.respond(fresh)).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).toHaveBeenCalledTimes(1); safe([result, fresh])
  })

  it('also blocks an accepted pair if a later read still returns the old confirmation', async () => {
    const f = fixture(); const listed = await f.list(); await f.respond(listed)
    const fresh = await f.list()
    expect(fresh.items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
    expect(await f.respond(fresh, 'cancel')).toMatchObject({ outcome: 'stale', requestSubmitted: false })
    expect(f.connection.respond).toHaveBeenCalledTimes(1)
  })

  it('reports a definitive rejection but still requires a new explicit list and prompt before any retry', async () => {
    const f = fixture(); const listed = await f.list(); f.connection.respond.mockResolvedValueOnce({ success: false, message: PRIVATE })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'rejected', requestSubmitted: true })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'stale' }); expect(f.connection.respond).toHaveBeenCalledTimes(1)
    const fresh = await f.list(); expect(fresh.items[0]?.canRespond).toBe(true)
    expect(await f.respond(fresh)).toMatchObject({ outcome: 'accepted' }); expect(f.options.confirm).toHaveBeenCalledTimes(2)
  })

  it('keeps an accepted response unconfirmed if the session or material changes during the POST', async () => {
    const f = fixture(); const listed = await f.list()
    f.connection.respond.mockImplementationOnce(async () => { f.material({ identitySecret: Buffer.alloc(20, 4).toString('base64') }); return { success: true } })
    expect(await f.respond(listed)).toMatchObject({ outcome: 'unknown', requestSubmitted: true })
    expect(f.connection.respond).toHaveBeenCalledTimes(1)
  })

  it('does not discard accepted or unknown tombstones when leases are invalidated', async () => {
    const f = fixture(); const listed = await f.list(); await f.respond(listed); f.service.invalidate()
    const fresh = await f.list()
    expect(fresh.items[0]).toMatchObject({ canRespond: false, blockedReason: 'already-submitted' })
  })
})
