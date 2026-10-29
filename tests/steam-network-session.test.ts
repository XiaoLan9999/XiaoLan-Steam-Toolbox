import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(), request: vi.fn(),
  fetch: vi.fn<typeof fetch>(), factory: null as null | ((options: Record<string, unknown>) => unknown)
}))
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition }, net: { request: mocks.request } }))
vi.mock('../src/main/steam-network-fetch', () => ({ createSteamNetworkFetch: (factory: typeof mocks.factory) => {
  mocks.factory = factory
  return mocks.fetch
} }))
import { createSteamNetworkSession } from '../src/main/steam-network-session'

function partition() {
  return { closeAllConnections: vi.fn(async () => undefined), clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined) }
}
beforeEach(() => { vi.resetAllMocks(); mocks.factory = null })

describe('private Chromium Steam session lifetime', () => {
  it('binds requests to a unique nonpersistent partition without selecting the default session', async () => {
    const isolated = partition()
    mocks.fromPartition.mockReturnValue(isolated)
    mocks.fetch.mockResolvedValue(new Response('synthetic'))
    const network = createSteamNetworkSession()
    expect(network.transport).toBe('chromium')
    expect(mocks.fromPartition).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^steam-network-[a-f0-9-]{36}$/), { cache: false })
    await network.fetch('https://steamcommunity.com/')
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const options = { url: 'https://steamcommunity.com/', method: 'GET', session: 'untrusted-session' }
    mocks.factory!(options)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ ...options, session: isolated })
    network.dispose()
    await Promise.resolve()
  })

  it('aborts only its own requests and clears its own partition exactly once', async () => {
    const first = partition(), second = partition()
    mocks.fromPartition.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.fetch.mockResolvedValue(new Response('synthetic'))
    const a = createSteamNetworkSession(), b = createSteamNetworkSession()
    await a.fetch('https://steamcommunity.com/')
    const signalA = mocks.fetch.mock.calls.at(-1)![1]!.signal!
    await b.fetch('https://steamcommunity.com/')
    const signalB = mocks.fetch.mock.calls.at(-1)![1]!.signal!
    a.dispose()
    a.dispose()
    await Promise.resolve()
    expect(signalA.aborted).toBe(true)
    expect(signalB.aborted).toBe(false)
    expect(first.closeAllConnections).toHaveBeenCalledOnce()
    expect(first.clearStorageData).toHaveBeenCalledOnce()
    expect(first.clearCache).toHaveBeenCalledOnce()
    expect(second.closeAllConnections).not.toHaveBeenCalled()
    await expect(a.fetch('https://steamcommunity.com/')).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    b.dispose()
    await Promise.resolve()
  })

  it('honors a caller cancellation independently from the network lifetime', async () => {
    mocks.fromPartition.mockReturnValue(partition())
    mocks.fetch.mockResolvedValue(new Response('synthetic'))
    const network = createSteamNetworkSession()
    const caller = new AbortController()
    await network.fetch('https://steamcommunity.com/', { signal: caller.signal })
    const signal = mocks.fetch.mock.calls.at(-1)![1]!.signal!
    caller.abort()
    expect(signal.aborted).toBe(true)
    await network.fetch('https://steamcommunity.com/')
    expect(mocks.fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(false)
    network.dispose()
    await Promise.resolve()
  })
})
