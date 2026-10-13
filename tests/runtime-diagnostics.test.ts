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
