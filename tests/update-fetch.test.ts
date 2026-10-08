import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ClientRequestConstructorOptions, IncomingMessage } from 'electron'
import { createUpdateFetch, type UpdateRequestFactory } from '../src/main/update-fetch'

class FakeRequest extends EventEmitter {
  aborted = false
  followRedirect = vi.fn()
  start: (() => void) | null = null
  end(): this { this.start?.(); return this }
  abort(): void { this.aborted = true; this.emit('abort'); this.emit('close') }
}

function fixture(start?: (request: FakeRequest) => void) {
  const request = new FakeRequest()
  request.start = () => start?.(request)
  const factory = vi.fn((options: ClientRequestConstructorOptions) => {
    void options
    return request
  })
  return { request, factory, fetch: createUpdateFetch(factory as unknown as UpdateRequestFactory) }
}

function incoming(chunks: Iterable<Buffer> | AsyncIterable<Buffer> = [Buffer.from('package')]): IncomingMessage & Readable {
  return Object.assign(Readable.from(chunks), {
    statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/octet-stream' }
  }) as unknown as IncomingMessage & Readable
}

describe('anonymous Electron update requests', () => {
  it('returns manual redirects with their real status and Location without following them', async () => {
    const { request, factory, fetch } = fixture(request => request.emit('redirect', 302, 'GET', 'https://release-assets.example/file', {
      location: ['https://release-assets.example/file'], 'cache-control': ['no-cache'], 'set-cookie': ['private=value']
    }))
    const response = await fetch('https://github.com/release', { redirect: 'manual', headers: {
      Range: 'bytes=0-65535', Cookie: 'private-cookie', Authorization: 'Bearer private-token', 'Proxy-Authorization': 'private-proxy'
    } })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://release-assets.example/file')
    expect(response.url).toBe('https://github.com/release')
    expect(response.body).toBeNull()
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(request.followRedirect).not.toHaveBeenCalled()
    expect(request.aborted).toBe(true)
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ redirect: 'manual', credentials: 'omit', useSessionCookies: false, headers: { range: 'bytes=0-65535' } })
    expect(factory.mock.calls[0]?.[0].headers).not.toHaveProperty('cookie')
    expect(factory.mock.calls[0]?.[0].headers).not.toHaveProperty('authorization')
    expect(factory.mock.calls[0]?.[0].headers).not.toHaveProperty('proxy-authorization')
  })

  it('preserves invalid and relative redirects for the existing service boundary to decide', async () => {
    const relative = fixture(request => request.emit('redirect', 307, 'GET', 'https://github.com/next', { location: ['/next'] }))
    expect((await relative.fetch('https://github.com/release', { redirect: 'manual' })).headers.get('location')).toBe('/next')
    const insecure = fixture(request => request.emit('redirect', 302, 'GET', 'http://unsafe.example/file', {}))
    expect((await insecure.fetch('https://github.com/release', { redirect: 'manual' })).headers.get('location')).toBe('http://unsafe.example/file')
    expect(insecure.request.followRedirect).not.toHaveBeenCalled()
  })

  it('streams actual response bytes and headers', async () => {
    const native = incoming([Buffer.from('part1'), Buffer.from('part2')])
    const { fetch } = fixture(request => request.emit('response', native))
    const response = await fetch('https://assets.example/package', { redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toBe('part1part2')
  })

  it('accepts response events after the request writable side has already closed', async () => {
    const { fetch } = fixture(request => {
      request.emit('close')
      request.emit('response', incoming())
    })
    expect(await (await fetch('https://assets.example/package', { redirect: 'manual' })).text()).toBe('package')
  })

  it('does not start pre-aborted requests and cancels requests waiting for headers', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const before = fixture()
    await expect(before.fetch('https://github.com/release', { signal: preAborted.signal, redirect: 'manual' })).rejects.toMatchObject({ name: 'AbortError', message: 'update.cancelled' })
    expect(before.factory).not.toHaveBeenCalled()
    const waiting = new AbortController()
    const active = fixture()
    const pending = active.fetch('https://github.com/release', { signal: waiting.signal, redirect: 'manual' })
    waiting.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'update.cancelled' })
    expect(active.request.aborted).toBe(true)
  })

  it('propagates cancellation while reading the body and aborts the underlying native request', async () => {
    const native = incoming((async function* () { yield Buffer.from('first'); await new Promise(() => undefined) })())
    const signal = new AbortController()
    const { request, fetch } = fixture(request => request.emit('response', native))
    const response = await fetch('https://assets.example/package', { signal: signal.signal, redirect: 'manual' })
    const reader = response.body!.getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('first')
    const pending = reader.read()
    signal.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'update.cancelled' })
    expect(request.aborted).toBe(true)
  })

  it('cancels a probe body without downloading the rest of the file', async () => {
    const native = incoming((async function* () { yield Buffer.alloc(65536); await new Promise(() => undefined) })())
    const { request, fetch } = fixture(request => request.emit('response', native))
    const response = await fetch('https://assets.example/package', { redirect: 'manual' })
    await response.body!.cancel()
    expect(request.aborted).toBe(true)
  })

  it('applies backpressure instead of buffering an entire package when its reader is slow', async () => {
    let produced = 0
    const native = incoming((function* () {
      for (let index = 0; index < 1024; index++) { produced++; yield Buffer.alloc(65536) }
    })())
    const { request, fetch } = fixture(request => request.emit('response', native))
    const response = await fetch('https://assets.example/package', { redirect: 'manual' })
    await new Promise(done => setTimeout(done, 20))
    expect(produced).toBeLessThanOrEqual(5)
    expect(produced).toBeGreaterThan(0)
    await response.body!.cancel()
    expect(request.aborted).toBe(true)
  })

  it('sanitizes failures before headers and during the body', async () => {
    const before = fixture(request => request.emit('error', new Error('secret-path or signed URL')))
    await expect(before.fetch('https://github.com/release', { redirect: 'manual' })).rejects.toThrow('update.downloadInterrupted')
    const native = incoming((async function* () { yield Buffer.from('first'); throw new Error('private native diagnostic') })())
    const active = fixture(request => request.emit('response', native))
    const response = await active.fetch('https://assets.example/package', { redirect: 'manual' })
    await expect(response.arrayBuffer()).rejects.toThrow('update.downloadInterrupted')
  })

  it.each(['status', 'headers'])('rejects malformed response %s without leaving the fetch promise pending', async field => {
    const native = incoming()
    if (field === 'status') native.statusCode = 0
    else native.headers = { 'invalid header': 'private value' }
    const { request, fetch } = fixture(request => request.emit('response', native))
    await expect(fetch('https://assets.example/package', { redirect: 'manual' })).rejects.toThrow('update.invalidResponse')
    expect(request.aborted).toBe(true)
  })

  it('rejects credentialed or insecure URL inputs and non-manual modes before issuing a request', async () => {
    const { factory, fetch } = fixture()
    await expect(fetch('http://github.com/release')).rejects.toThrow('update.redirectInvalid')
    await expect(fetch('https://user:secret@github.com/release')).rejects.toThrow('update.redirectInvalid')
    await expect(fetch('https://github.com/release', { redirect: 'follow' })).rejects.toThrow('update.invalidResponse')
    expect(factory).not.toHaveBeenCalled()
  })
})
