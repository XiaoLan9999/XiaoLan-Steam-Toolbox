import { describe, expect, it } from 'vitest'
import { LOCAL_APP_DIAGNOSTIC_CODES, LOCAL_APP_DIAGNOSTIC_REASONS, LOCAL_APP_DIAGNOSTIC_STAGES,
  sanitizeLocalAppDiagnostic } from '../src/shared/local-app-diagnostics'
import { sanitizeDiagnosticRecord } from '../src/shared/diagnostics'

const privateText = 'synthetic-private-account-presence-token-path-stderr'

describe('private local AppID lifecycle diagnostics', () => {
  it.each(LOCAL_APP_DIAGNOSTIC_STAGES)('accepts the reviewed stage %s without native content', stage => {
    const safe = sanitizeLocalAppDiagnostic({ stage, code: 'LOCAL_APP_TIMEOUT', reason: 'monitor',
      generation: 1, helperPid: 123, exitCode: 70, signal: null, elapsedMs: 100,
      count: 2, noiseBytes: 4096, operation: 'ping', ok: false,
      steamId: '76561198000000001', accountId: privateText, appId: 4000, fields: { status: privateText },
      sessionId: privateText, requestId: privateText, path: privateText, stdout: privateText,
      stderr: privateText, error: { message: privateText, stack: privateText } })
    expect(safe).toEqual({ stage, code: 'LOCAL_APP_TIMEOUT', reason: 'monitor', generation: 1,
      helperPid: 123, exitCode: 70, signal: null, elapsedMs: 100, count: 2, noiseBytes: 4096,
      operation: 'ping', ok: false })
    expect(JSON.stringify(safe)).not.toMatch(/7656119|synthetic-private|4000/)
  })

  it('accepts every reviewed UI and native failure code, and only reviewed reasons', () => {
    for (const code of LOCAL_APP_DIAGNOSTIC_CODES) {
      expect(sanitizeLocalAppDiagnostic({ stage: 'worker-terminal', code })).toHaveProperty('code', code)
    }
    for (const reason of LOCAL_APP_DIAGNOSTIC_REASONS) {
      expect(sanitizeLocalAppDiagnostic({ stage: 'invalidated', reason })).toHaveProperty('reason', reason)
    }
    for (const value of [privateText, 'LOCAL_APP_TIMEOUT_PRIVATE', '', 12, true, null]) {
      const projected = sanitizeLocalAppDiagnostic({ stage: 'worker-error', code: value, reason: value,
        signal: value, operation: value, ok: value })
      expect(projected).toEqual({ stage: 'worker-error', ...(value === null ? { signal: null, ok: null } :
        typeof value === 'boolean' ? { ok: value } : {}) })
    }
  })

  it('rejects unknown stages and non-record input rather than logging raw values', () => {
    for (const value of [null, undefined, 1, true, privateText, [], {}, { stage: privateText }, { stage: 1 }]) {
      expect(sanitizeLocalAppDiagnostic(value)).toBeNull()
    }
    expect(sanitizeDiagnosticRecord({ event: 'local-app', stage: privateText, stdout: privateText })).toBeNull()
  })

  it('bounds every numeric field and permits explicit native unknowns', () => {
    expect(sanitizeLocalAppDiagnostic({ stage: 'worker-exited', generation: Number.MAX_SAFE_INTEGER,
      helperPid: 0xffffffff, exitCode: 0xffffffff, elapsedMs: 604_800_000, count: 4096,
      noiseBytes: 1024 * 1024 * 1024, signal: 'unknown', operation: 'ready', ok: null })).toEqual({
      stage: 'worker-exited', generation: Number.MAX_SAFE_INTEGER, helperPid: 0xffffffff,
      exitCode: 0xffffffff, elapsedMs: 604_800_000, count: 4096, noiseBytes: 1024 * 1024 * 1024,
      signal: 'unknown', operation: 'ready', ok: null
    })
    expect(sanitizeLocalAppDiagnostic({ stage: 'worker-exited', generation: 0, helperPid: 1,
      exitCode: -0x80000000, elapsedMs: 0, count: 0, noiseBytes: 0, signal: 'SIGTERM' }))
      .toMatchObject({ generation: 0, helperPid: 1, exitCode: -0x80000000, elapsedMs: 0, count: 0, noiseBytes: 0 })
    for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true]) {
      const safe = sanitizeLocalAppDiagnostic({ stage: 'worker-error', generation: value, helperPid: value,
        elapsedMs: value, count: value, noiseBytes: value })
      expect(safe).toEqual({ stage: 'worker-error' })
    }
    expect(sanitizeLocalAppDiagnostic({ stage: 'worker-error', helperPid: 0, exitCode: -0x80000001,
      elapsedMs: 604_800_001, count: 4097, noiseBytes: 1024 * 1024 * 1024 + 1 })).toEqual({ stage: 'worker-error' })
    expect(sanitizeLocalAppDiagnostic({ stage: 'worker-exited', exitCode: null })).toEqual({ stage: 'worker-exited', exitCode: null })
  })

  it('does not let throwing or unstable accessors leak private fields', () => {
    const broken = Object.defineProperty({ stage: 'worker-error' }, 'code', { get: () => { throw new Error(privateText) } })
    expect(() => sanitizeLocalAppDiagnostic(broken)).not.toThrow()
    expect(sanitizeLocalAppDiagnostic(broken)).toBeNull()
    let reads = 0
    const changing = Object.defineProperty({}, 'stage', { get: () => ++reads === 1 ? 'worker-ready' : privateText })
    expect(sanitizeLocalAppDiagnostic(changing)).toEqual({ stage: 'worker-ready' })
    const extra = Object.defineProperty({ stage: 'worker-ready' }, 'stdout', { get: () => { throw new Error(privateText) } })
    expect(sanitizeLocalAppDiagnostic(extra)).toEqual({ stage: 'worker-ready' })
  })

  it('retains only canonical record metadata when projected again for export', () => {
    const safe = sanitizeDiagnosticRecord({ event: 'local-app', at: '2026-11-08T00:01:02.345Z',
      version: '0.16.15', stage: 'monitor-retry', code: 'LOCAL_APP_CONTEXT_UNAVAILABLE', count: 1,
      reason: 'monitor', error: privateText, atSecret: privateText, accountId: privateText })
    expect(safe).toEqual({ event: 'local-app', at: '2026-11-08T00:01:02.345Z', version: '0.16.15',
      stage: 'monitor-retry', code: 'LOCAL_APP_CONTEXT_UNAVAILABLE', count: 1, reason: 'monitor' })
    expect(sanitizeDiagnosticRecord({ event: 'local-app', stage: 'stopped', at: privateText,
      version: privateText, signal: 'SIGKILL' })).toEqual({ event: 'local-app', stage: 'stopped', signal: 'SIGKILL' })
  })
})
