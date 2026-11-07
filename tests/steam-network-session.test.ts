import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(), request: vi.fn(),
  fetch: vi.fn<typeof fetch>(), factory: null as null | ((options: Record<string, unknown>) => unknown),
  factories: [] as Array<(options: Record<string, unknown>) => unknown>,
  nodeFetch: vi.fn<typeof fetch>(), nodeDispose: vi.fn(), nodeAllowed: vi.fn(), nodeCreate: vi.fn()
}))
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition }, net: { request: mocks.request } }))
vi.mock('../src/main/steam-network-fetch', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/steam-network-fetch')>(),
  createSteamNetworkFetch: (factory: typeof mocks.factory) => {
  mocks.factory = factory
  if (factory) mocks.factories.push(factory)
  return mocks.fetch
} }))
vi.mock('../src/main/steam-node-network', () => ({
  isNodeSteamNetworkAllowed: mocks.nodeAllowed,
  createNodeSteamNetwork: mocks.nodeCreate
}))
import { createSteamNetworkSession } from '../src/main/steam-network-session'

function partition() {
  return { closeAllConnections: vi.fn(async () => undefined), clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    setProxy: vi.fn<(options: { mode: string }) => Promise<void>>(async () => undefined),
    resolveProxy: vi.fn<(url: string) => Promise<string>>(async () => 'DIRECT') }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.factory = null
  mocks.factories.splice(0)
  mocks.nodeAllowed.mockReturnValue(true)
  mocks.nodeFetch.mockImplementation(async () => new Response('synthetic-node'))
  mocks.nodeCreate.mockImplementation(() => ({ fetch: mocks.nodeFetch, dispose: mocks.nodeDispose }))
})

describe('private Chromium Steam session lifetime', () => {
  it('binds requests to a unique nonpersistent partition without selecting the default session', async () => {
    const isolated = partition()
    mocks.fromPartition.mockReturnValue(isolated)
    mocks.fetch.mockImplementation(async () => new Response('synthetic'))
    const network = createSteamNetworkSession()
    expect(network.transport).toBe('adaptive')
    expect(mocks.fromPartition).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^steam-network-[a-f0-9-]{36}$/), { cache: false })
    await network.fetch('https://steamcommunity.com/')
    expect(isolated.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
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
    mocks.fetch.mockImplementation(async () => new Response('synthetic'))
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
    mocks.fetch.mockImplementation(async () => new Response('synthetic'))
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

  it('owns all fresh/direct routes and clears each only on disposal', async () => {
    const partitions = [partition(), partition(), partition()]
    for (const isolated of partitions) mocks.fromPartition.mockReturnValueOnce(isolated)
    mocks.fetch.mockRejectedValue(Object.assign(new Error('synthetic connection failure'), { code: 'ERR_CONNECTION_CLOSED' }))
    const network = createSteamNetworkSession()
    expect(await (await network.fetch('https://steamcommunity.com/')).text()).toBe('synthetic-node')
    expect(mocks.fromPartition).toHaveBeenCalledTimes(3)
    expect(new Set(mocks.fromPartition.mock.calls.map(([name]) => name)).size).toBe(3)
    expect(partitions.map(value => value.setProxy.mock.calls[0]![0])).toEqual([{ mode: 'system' }, { mode: 'system' }, { mode: 'direct' }])
    expect(mocks.nodeCreate).toHaveBeenCalledOnce()
    for (const [index, factory] of mocks.factories.entries()) {
      factory({ url: 'https://steamcommunity.com/', session: 'untrusted' })
      expect(mocks.request.mock.calls.at(-1)![0].session).toBe(partitions[index])
    }
    network.dispose()
    network.dispose()
    await Promise.resolve()
    expect(mocks.nodeDispose).toHaveBeenCalledOnce()
    for (const isolated of partitions) {
      expect(isolated.closeAllConnections).toHaveBeenCalledOnce()
      expect(isolated.clearStorageData).toHaveBeenCalledOnce()
      expect(isolated.clearCache).toHaveBeenCalledOnce()
    }
  })

  it('never issues a request after disposal while private proxy initialization is pending', async () => {
    let ready!: () => void
    const isolated = partition()
    isolated.setProxy.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve }))
    mocks.fromPartition.mockReturnValue(isolated)
    const network = createSteamNetworkSession()
    const pending = network.fetch('https://steamcommunity.com/')
    const checked = expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    await vi.waitFor(() => expect(isolated.setProxy).toHaveBeenCalledOnce())
    network.dispose()
    ready()
    await checked
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.nodeFetch).not.toHaveBeenCalled()
    expect(isolated.closeAllConnections).toHaveBeenCalledOnce()
  })
})
