import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeDiagnostics } from '../src/main/runtime-diagnostics'

const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(maxBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-runtime-diagnostics-'))
  directories.push(directory)
  const metrics = vi.fn(() => [{ pid: 123, type: 'Tab', memory: { workingSetSize: 4096, peakWorkingSetSize: 8192, privateBytes: 2048 },
    name: 'synthetic-private-friend', serviceName: 'synthetic-private-token' }])
  const task = vi.fn(() => ({ status: 'paused', total: 1200, completed: 44, pending: 1156, sending: 0, uncertain: 0,
    accountId: 'synthetic-private-account', messageTemplate: 'synthetic-private-body' }))
  const diagnostics = new RuntimeDiagnostics({ directory, version: '0.7.0', metrics, task, maxBytes,
    memory: () => ({ rss: 1024, heapTotal: 512, heapUsed: 256, external: 64, arrayBuffers: 32 }) })
  return { directory, diagnostics, metrics, task }
}

describe('bounded local runtime diagnostics', () => {
  it('samples once per minute and stops without retaining timers or private content', async () => {
    vi.useFakeTimers()
    const { directory, diagnostics, metrics } = fixture()
    diagnostics.start()
    diagnostics.start()
    await vi.advanceTimersByTimeAsync(60_000)
    diagnostics.processGone('renderer', 'oom', -1)
    diagnostics.shutdown()
    const path = join(directory, 'runtime-current.jsonl')
    const contents = readFileSync(path, 'utf8')
    expect(contents).not.toContain('synthetic-private')
    const lines = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.event)).toEqual(['start', 'memory', 'process-gone', 'memory', 'stop'])
    expect(lines[0]).toMatchObject({ main: { heapUsedBytes: 256 }, processes: [{ privateKiB: 2048 }], task: { total: 1200 } })
    expect(lines[2]).toMatchObject({ kind: 'renderer', reason: 'oom', exitCode: -1 })
    await vi.advanceTimersByTimeAsync(300_000)
    diagnostics.processGone('child', 'crashed', 1)
    expect(readFileSync(path, 'utf8')).toBe(contents)
    expect(metrics).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rotates to two bounded files instead of growing indefinitely', () => {
    const { directory, diagnostics } = fixture(16_384)
    for (let index = 0; index < 300; index += 1) diagnostics.sample('memory')
    expect(readdirSync(directory).sort()).toEqual(['runtime-current.jsonl', 'runtime-previous.jsonl'])
    for (const name of readdirSync(directory)) expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(16_384)
  })

  it('records only safe session classifications, not arbitrary diagnostic fields or secret strings', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403, method: 'POST',
      cookie: 'synthetic-private-cookie', url: 'synthetic-private-url' } as never)
    diagnostics.sessionEvent({ phase: 'synthetic-private-phase', outcome: 'synthetic-private-outcome', reason: 'synthetic-private-token', httpStatus: 9999, method: 'synthetic-private-method' })
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('synthetic-private')
    const events = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(events[0]).toMatchObject({ event: 'session', phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403, method: 'POST' })
    expect(events[1]).toMatchObject({ phase: 'unknown', outcome: 'unknown', reason: 'unknown' })
    expect(events[1]).not.toHaveProperty('httpStatus')
    expect(events[1]).not.toHaveProperty('method')
  })

  it('persists only enum response shapes, small integer codes and finite nonnegative retry hints', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403', httpStatus: 403,
      endpoint: 'profile-comment', responseKind: 'json', denialKind: 'access-denied', responseCode: 15, retryAfterMs: 20_000,
      responseBody: 'synthetic-private-body', error: 'synthetic-private-error', headers: { cookie: 'synthetic-private-cookie' } } as never)
    diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
      endpoint: 'synthetic-private-endpoint', responseKind: 'synthetic-private-kind', denialKind: 'synthetic-private-kind',
      responseCode: 76561198000000001, retryAfterMs: Infinity })
    for (const value of [-1, 1.2, NaN, Infinity, '15', true]) {
      diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
        responseCode: value, retryAfterMs: -1 } as never)
    }
    diagnostics.sessionEvent({ phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
      endpoint: 'session-verify', responseKind: 'html', denialKind: 'challenge', responseCode: 0, retryAfterMs: 0 })
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('synthetic-private')
    expect(contents).not.toContain('7656119')
    const events = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(events[0]).toMatchObject({ endpoint: 'profile-comment', responseKind: 'json', denialKind: 'access-denied', responseCode: 15, retryAfterMs: 20_000 })
    for (const event of events.slice(1, -1)) {
      expect(event).not.toHaveProperty('responseCode')
      expect(event).not.toHaveProperty('retryAfterMs')
    }
    expect(events[1]).not.toHaveProperty('endpoint')
    expect(events[1]).not.toHaveProperty('responseKind')
    expect(events[1]).not.toHaveProperty('denialKind')
    expect(events.at(-1)).toMatchObject({ endpoint: 'session-verify', responseKind: 'html', denialKind: 'challenge', responseCode: 0, retryAfterMs: 0 })
  })

  it('ignores collection/storage failures and does not write arbitrary exit strings', () => {
    const { directory, diagnostics, metrics } = fixture()
    metrics.mockImplementation(() => { throw new Error('synthetic-private-error') })
    expect(() => diagnostics.sample('memory')).not.toThrow()
    expect(() => diagnostics.processGone('child', 'synthetic-private-token', Number.NaN)).not.toThrow()
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('synthetic-private')
    expect(JSON.parse(contents.trim())).toMatchObject({ reason: 'unknown', exitCode: null })
  })
})
