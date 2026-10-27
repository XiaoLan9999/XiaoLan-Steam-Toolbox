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
  it('records simulation stages without account, title or login data', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.gameStatusEvent({ stage: 'simulation-submit', connectionKind: 'cm', generation: 3,
      steamId: '76561198000000001', accountName: 'synthetic-private-account', gameName: 'synthetic-private-title',
      webLogonToken: 'synthetic-private-token' } as never)
    diagnostics.gameStatusEvent({ stage: 'synthetic-private-stage', connectionKind: 'synthetic-private-kind', generation: -1 })
    diagnostics.gameStatusEvent({ stage: 'simulation-context-confirmed', connectionKind: 'cm', generation: Infinity })
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('synthetic-private'); expect(contents).not.toContain('7656119')
    const entries = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(entries[0]).toEqual({ at: expect.any(String), version: '0.7.0', event: 'game-status',
      stage: 'simulation-submit', connectionKind: 'cm', generation: 3 })
    expect(entries[1]).toEqual({ at: expect.any(String), version: '0.7.0', event: 'game-status', stage: 'unknown' })
    expect(entries[2]).not.toHaveProperty('generation')
  })

  it('does not append simulation events after shutdown', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.gameStatusEvent({ stage: 'connect-requested', connectionKind: 'cm', generation: 1 })
    diagnostics.shutdown()
    const path = join(directory, 'runtime-current.jsonl'); const contents = readFileSync(path, 'utf8')
    diagnostics.gameStatusEvent({ stage: 'cm-retired', connectionKind: 'cm', generation: 1 })
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })

  it('records bounded native cleanup facts without account, message, pipe or path data', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.nativePresenceEvent({ stage: 'release-pipe-returned', ok: false, elapsedMs: 12, helperPid: 123,
      accountId: 'synthetic-private-account', steamId: '76561198000000001', pipe: 2001, desc: 'synthetic-private-body', path: 'synthetic-private-path' } as never)
    diagnostics.nativePresenceEvent({ stage: 'worker-closed', exitCode: 0, forced: false, retiringCount: 0 })
    diagnostics.nativePresenceEvent({ stage: 'synthetic-private-stage', ok: 'synthetic-private', helperPid: -1, elapsedMs: Infinity, exitCode: 76561198000000001, forced: 'synthetic-private', retiringCount: -1 } as never)
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('synthetic-private'); expect(contents).not.toContain('7656119')
    const events = contents.trim().split('\n').map(line => JSON.parse(line))
    expect(events[0]).toMatchObject({ event: 'native-presence', stage: 'release-pipe-returned', ok: false, elapsedMs: 12, helperPid: 123 })
    expect(events[0]).not.toHaveProperty('pipe')
    expect(events[1]).toMatchObject({ stage: 'worker-closed', exitCode: 0, forced: false, retiringCount: 0 })
    expect(events[2]).toEqual({ at: expect.any(String), version: '0.7.0', event: 'native-presence', stage: 'unknown' })
  })

  it('does not record native lifecycle events after diagnostics shutdown', () => {
    const { directory, diagnostics } = fixture()
    diagnostics.nativePresenceEvent({ stage: 'cleanup-complete', ok: true, elapsedMs: 0 })
    diagnostics.shutdown()
    const path = join(directory, 'runtime-current.jsonl')
    const contents = readFileSync(path, 'utf8')
    diagnostics.nativePresenceEvent({ stage: 'forced-kill', forced: true })
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })
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

  it.each(['baseline-missing', 'baseline-incomplete', 'baseline-unreadable', 'target-unavailable'])
  ('records a safe preflight reason %s without profile data', reason => {
    const { directory, diagnostics } = fixture()
    diagnostics.sessionEvent({ phase: 'comment-preflight', outcome: 'unverified', reason,
      method: 'GET', endpoint: 'profile-comment', profileHtml: 'private-fixture', steamId: '76561198000000002' } as never)
    const contents = readFileSync(join(directory, 'runtime-current.jsonl'), 'utf8')
    expect(contents).not.toContain('private-fixture')
    expect(contents).not.toContain('7656119')
    expect(JSON.parse(contents.trim())).toMatchObject({ phase: 'comment-preflight', reason, method: 'GET' })
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
