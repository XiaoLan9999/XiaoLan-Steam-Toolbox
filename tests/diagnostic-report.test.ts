import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_DIAGNOSTIC_FILE_BYTES, sameDiagnosticFileIdentity, writeDiagnosticReport, type DiagnosticReportOptions } from '../src/main/diagnostic-report'
import { LOGIN_NETWORK_CODES, sanitizeDiagnosticRecord } from '../src/shared/diagnostics'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

const roots: string[] = []
const at = '2026-10-28T12:34:56.789Z'
const canary = 'PRIVATE-canary-account-friend-message-token-cookie-QR-user-path-stack'

afterEach(async () => {
  const temporary = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    if (dirname(root) !== temporary || !basename(root).startsWith('sfc-diagnostic-report-') ||
        await realpath(root) !== root) throw new Error('Unsafe diagnostic fixture cleanup boundary')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'sfc-diagnostic-report-')))
  roots.push(root)
  const userDataDirectory = join(root, 'private-data')
  const diagnosticsDirectory = join(userDataDirectory, 'diagnostics')
  await mkdir(diagnosticsDirectory, { recursive: true })
  const options: DiagnosticReportOptions = { userDataDirectory, diagnosticsDirectory, appVersion: '0.16.7',
    electronVersion: '43.4.0', nodeVersion: '22.20.0', chromiumVersion: '149.0.7827.0', now: () => new Date(at) }
  return { root, options, current: join(diagnosticsDirectory, 'runtime-current.jsonl'),
    previous: join(diagnosticsDirectory, 'runtime-previous.jsonl'), destination: join(root, 'report.json') }
}

const line = (value: unknown): string => JSON.stringify(value) + '\n'
const login = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ event: 'login', at, version: '0.16.7',
  attempt: 1, mode: 'qr', stage: 'request', outcome: 'response', ...fields })

describe('diagnostic event projection', () => {
  it('projects every supported event without retaining nested private fields', () => {
    const sensitive = { accountId: canary, steamId: canary, accountName: canary, friend: canary, body: canary,
      qr: canary, token: canary, cookie: canary, path: canary, message: canary, stack: canary }
    const events = [
      { event: 'start', main: { rssBytes: 1024, heapUsedBytes: 256, ...sensitive },
        processes: [{ pid: 123, type: 'Tab', workingSetKiB: 4096, ...sensitive }],
        task: { status: 'paused', total: 10, completed: 2, pending: 8, sending: 0, uncertain: 0, ...sensitive } },
      { event: 'memory', main: sensitive, processes: [null, canary, sensitive], task: sensitive },
      { event: 'stop', main: null, processes: [], task: null },
      { event: 'process-gone', kind: 'renderer', reason: 'oom', exitCode: -1 },
      { event: 'session', phase: 'community-request', outcome: 'access-denied', reason: 'http-403',
        httpStatus: 403, method: 'POST', endpoint: 'profile-comment', responseKind: 'json', denialKind: 'access-denied',
        commentDenialReason: 'friends-only', errorPresent: true, responseCode: 15, retryAfterMs: 20_000 },
      { event: 'native-presence', stage: 'worker-closed', ok: false, elapsedMs: 12, helperPid: 123,
        exitCode: 0, forced: false, retiringCount: 0 },
      { event: 'game-status', stage: 'simulation-submit', connectionKind: 'cm', generation: 3 },
      login({ endpoint: 'poll', reason: 'network', networkCode: 'ECONNRESET', httpStatus: 502, eresult: 15, elapsedMs: 100 })
    ].map(event => ({ at, version: '0.16.7', ...event, ...sensitive }))
    const projected = events.map(sanitizeDiagnosticRecord)
    expect(projected.every(Boolean)).toBe(true)
    expect(JSON.stringify(projected)).not.toContain(canary)
    expect(projected[0]).toMatchObject({ event: 'start', at, version: '0.16.7', main: { rssBytes: 1024 },
      processes: [{ pid: 123, type: 'Tab', workingSetKiB: 4096 }], task: { status: 'paused', total: 10 } })
    expect(projected[4]).toMatchObject({ httpStatus: 403, method: 'POST', responseCode: 15, retryAfterMs: 20_000 })
    expect(projected[7]).toMatchObject({ attempt: 1, endpoint: 'poll', reason: 'network', networkCode: 'ECONNRESET' })
    expect(events[0]).toHaveProperty('accountId', canary)
  })

  it('rejects unknown event types, bad timestamps, identity-like versions and arbitrary enum strings', () => {
    for (const value of [null, true, [], canary, {}, { event: canary }]) expect(sanitizeDiagnosticRecord(value)).toBeNull()
    const value = sanitizeDiagnosticRecord({ event: 'session', at: `${at}${canary}`, version: `0.16.7-${canary}`,
      phase: canary, outcome: canary, reason: canary, method: canary, endpoint: canary, responseKind: canary,
      denialKind: canary, commentDenialReason: canary, errorPresent: canary, responseCode: 76561198000000001,
      httpStatus: 9999, retryAfterMs: Infinity })
    expect(value).toEqual({ event: 'session', phase: 'unknown', outcome: 'unknown', reason: 'unknown' })
    expect(sanitizeDiagnosticRecord({ event: 'game-status', at: '2026-02-30T12:34:56.789Z', version: canary,
      stage: canary, connectionKind: canary, generation: -1 })).toEqual({ event: 'game-status', stage: 'unknown' })
    expect(sanitizeDiagnosticRecord({ event: 'process-gone', kind: canary, reason: canary, exitCode: canary }))
      .toEqual({ event: 'process-gone', kind: 'unknown', reason: 'unknown', exitCode: null })
  })

  it('bounds login fields and uses an explicit network-code allowlist', () => {
    for (const networkCode of LOGIN_NETWORK_CODES) expect(sanitizeDiagnosticRecord(login({ networkCode }))).toHaveProperty('networkCode', networkCode)
    for (const networkCode of [canary, 'ECONNRESET_PRIVATE', 'SOME_SECRET', 42]) expect(sanitizeDiagnosticRecord(login({ networkCode }))).not.toHaveProperty('networkCode')
    for (const attempt of [0, -1, 0x100000000, 1.5, '1', true, Infinity]) expect(sanitizeDiagnosticRecord(login({ attempt }))).toBeNull()
    for (const mode of [canary, '', 1]) expect(sanitizeDiagnosticRecord(login({ mode }))).toBeNull()
    for (const stage of [canary, '', 1]) expect(sanitizeDiagnosticRecord(login({ stage }))).toBeNull()
    for (const outcome of [canary, '', 1]) expect(sanitizeDiagnosticRecord(login({ outcome }))).toBeNull()
    expect(sanitizeDiagnosticRecord(login({ attempt: 0xffffffff, mode: 'restore', stage: 'timeout', outcome: 'failed',
      endpoint: 'other', reason: 'timeout', httpStatus: 599, eresult: 255, elapsedMs: 600_000 })))
      .toMatchObject({ attempt: 0xffffffff, httpStatus: 599, eresult: 255, elapsedMs: 600_000 })
    const value = sanitizeDiagnosticRecord(login({ endpoint: canary, reason: canary, httpStatus: 99, eresult: 256, elapsedMs: 600_001 }))
    for (const field of ['endpoint', 'reason', 'httpStatus', 'eresult', 'elapsedMs']) expect(value).not.toHaveProperty(field)
  })

  it('bounds nested collections and numeric metadata', () => {
    const value = sanitizeDiagnosticRecord({ event: 'memory', main: { rssBytes: Infinity, heapUsedBytes: -1 },
      processes: Array.from({ length: 100 }, () => ({ pid: 76561198000000001, type: canary, workingSetKiB: canary })),
      task: { status: canary, total: 76561198000000001 } })
    expect(value?.processes).toHaveLength(32)
    expect(value?.main).toMatchObject({ rssBytes: null, heapUsedBytes: null })
    expect(value?.task).toMatchObject({ status: 'unknown', total: null })
    expect(JSON.stringify(value)).not.toContain('7656119')
    expect(JSON.stringify(value)).not.toContain(canary)
  })
})

describe('safe bounded diagnostic export', () => {
  it('compares adjacent 64-bit file identifiers without number rounding', () => {
    const file = { dev: 3n, ino: 0x20000000000000n }
    const adjacent = { dev: 3n, ino: 0x20000000000001n }
    expect(Number(file.ino)).toBe(Number(adjacent.ino))
    expect(sameDiagnosticFileIdentity(file, adjacent)).toBe(false)
    expect(sameDiagnosticFileIdentity(file, { ...file })).toBe(true)
    expect(sameDiagnosticFileIdentity(file, { ...file, dev: 4n })).toBe(false)
  })

  it('exports sanitized rotation history and runtime versions, without copying private files or paths', async () => {
    const { root, options, current, previous, destination } = await fixture()
    const privateFields = { accountName: canary, friendId: canary, comment: canary, qr: canary, token: canary,
      cookie: canary, error: { message: canary, stack: canary }, path: root }
    const older = line({ event: 'process-gone', at, version: '0.16.6', kind: 'renderer', reason: 'oom', exitCode: -1, ...privateFields })
    const newer = line(login({ stage: 'failed', outcome: 'failed', reason: 'tls', networkCode: 'CERT_HAS_EXPIRED', ...privateFields }))
    await writeFile(previous, older)
    await writeFile(current, newer)
    await writeFile(join(options.diagnosticsDirectory, 'other.log'), canary)
    await writeFile(join(options.userDataDirectory, 'accounts.json'), canary)
    const result = await writeDiagnosticReport(destination, options)
    expect(result).toEqual({ path: destination, records: 2 })
    const contents = await readFile(destination, 'utf8')
    expect(contents).not.toContain(canary)
    expect(contents).not.toContain(root)
    expect(contents).not.toContain('accounts.json')
    expect(JSON.parse(contents)).toMatchObject({ schemaVersion: 1, generatedAt: at,
      application: { version: '0.16.7' }, runtime: { electron: '43.4.0', node: '22.20.0', chromium: '149.0.7827.0' },
      system: { platform: process.platform, architecture: process.arch, release: expect.any(String) },
      records: [{ event: 'process-gone', version: '0.16.6' }, { event: 'login', reason: 'tls' }] })
    expect(await readFile(previous, 'utf8')).toBe(older)
    expect(await readFile(current, 'utf8')).toBe(newer)
    expect((await lstat(destination)).isFile()).toBe(true)
  })

  it('exports an empty report before any log has been recorded', async () => {
    const { options, destination } = await fixture()
    await rm(options.diagnosticsDirectory, { recursive: true })
    expect(await writeDiagnosticReport(destination, options)).toEqual({ path: destination, records: 0 })
  })

  it('discards malformed records, oversized lines, unsupported events and an incomplete final write', async () => {
    const { options, current, destination } = await fixture()
    await writeFile(current, '{malformed}\nnull\n[]\n' + line({ event: canary }) +
      line(login({ body: canary.repeat(1000) })) + line(login({ attempt: 2 })) + JSON.stringify(login({ attempt: 3 })))
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 1 })
    const report = JSON.parse(await readFile(destination, 'utf8'))
    expect(report.records.map((record: Record<string, unknown>) => record.attempt)).toEqual([2])
  })

  it('reads only the final MiB of each file and drops a leading partial record', async () => {
    const { options, current, previous, destination } = await fixture()
    await writeFile(previous, line(login({ attempt: 1 })) + 'x'.repeat(MAX_DIAGNOSTIC_FILE_BYTES) + '\n' + line(login({ attempt: 2 })))
    await writeFile(current, line(login({ attempt: 3 })) + 'x'.repeat(MAX_DIAGNOSTIC_FILE_BYTES) + '\n' + line(login({ attempt: 4 })))
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 2 })
    const report = JSON.parse(await readFile(destination, 'utf8'))
    expect(report.records.map((record: Record<string, unknown>) => record.attempt)).toEqual([2, 4])
  })

  it('retains at most the latest 5000 events across both files', async () => {
    const { options, current, previous, destination } = await fixture()
    await writeFile(previous, Array.from({ length: 3000 }, (_, index) => line(login({ attempt: index + 1 }))).join(''))
    await writeFile(current, Array.from({ length: 3000 }, (_, index) => line(login({ attempt: index + 3001 }))).join(''))
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 5000 })
    const report = JSON.parse(await readFile(destination, 'utf8'))
    expect(report.records[0].attempt).toBe(1001)
    expect(report.records.at(-1).attempt).toBe(6000)
  })

  it('does not copy malicious version metadata', async () => {
    const { options, current, destination } = await fixture()
    await writeFile(current, line(login({ at: canary, version: canary, networkCode: canary })))
    await writeDiagnosticReport(destination, { ...options, appVersion: canary, nodeVersion: canary,
      electronVersion: canary, chromiumVersion: canary })
    expect(await readFile(destination, 'utf8')).not.toContain(canary)
  })

  it('rejects destination extensions, relative names, alternate data streams and private-data destinations', async () => {
    const { root, options } = await fixture()
    for (const destination of ['relative.json', join(root, 'report.txt'), join(root, 'report.json.exe'),
      join(root, 'report:private.json'), join(root, 'CON.json'), join(options.userDataDirectory, 'report.json'),
      join(options.diagnosticsDirectory, 'report.json')]) {
      await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    }
    expect(await readdir(root)).toEqual(['private-data'])
  })

  it('never overwrites existing files or truncates an existing destination', async () => {
    const { options, destination } = await fixture()
    await writeFile(destination, canary)
    await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    expect(await readFile(destination, 'utf8')).toBe(canary)
  })

  it('does not overwrite a destination created between validation and exclusive open', async () => {
    const { options, destination } = await fixture()
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await writeFile(destination, canary)
      return original.open(...args)
    })
    await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    expect(await readFile(destination, 'utf8')).toBe(canary)
  })

  it('revalidates once when rotation changes the current file between stat and open', async () => {
    const { options, current, previous, destination } = await fixture()
    await writeFile(current, line(login({ attempt: 1 })))
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(current, previous)
      await writeFile(current, line(login({ attempt: 2 })))
      return original.open(...args)
    })
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 1 })
    expect(JSON.parse(await readFile(destination, 'utf8')).records[0].attempt).toBe(2)
    expect(JSON.parse((await readFile(previous, 'utf8')).trim()).attempt).toBe(1)
  })

  it('reads the already opened snapshot when current is rotated and replaced after open', async () => {
    const { options, current, previous, destination } = await fixture()
    await writeFile(current, line(login({ attempt: 1 })))
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args)
      await rename(current, previous)
      await writeFile(current, line(login({ attempt: 2 })))
      return handle
    })
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 1 })
    expect(JSON.parse(await readFile(destination, 'utf8')).records[0].attempt).toBe(1)
    expect(JSON.parse((await readFile(current, 'utf8')).trim()).attempt).toBe(2)
  })

  it('allows log appends while reading without requiring a stable modification timestamp', async () => {
    const { options, current, destination } = await fixture()
    await writeFile(current, line(login({ attempt: 1 })))
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args)
      await writeFile(current, line(login({ attempt: 2 })), { flag: 'a' })
      return handle
    })
    expect(await writeDiagnosticReport(destination, options)).toMatchObject({ records: 2 })
    expect(JSON.parse(await readFile(destination, 'utf8')).records.map((record: Record<string, unknown>) => record.attempt)).toEqual([1, 2])
  })

  it('rejects a destination directory and a nonexistent destination parent', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'directory.json'))
    await expect(writeDiagnosticReport(join(root, 'directory.json'), options)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    await expect(writeDiagnosticReport(join(root, 'missing', 'report.json'), options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects a diagnostics directory outside the application data root', async () => {
    const { root, options, destination } = await fixture()
    await expect(writeDiagnosticReport(destination, { ...options, diagnosticsDirectory: root })).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects directory junctions on input and output', async () => {
    const { root, options, destination } = await fixture()
    const linkedOutput = join(root, 'linked-output')
    await symlink(options.diagnosticsDirectory, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeDiagnosticReport(join(linkedOutput, 'report.json'), options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    const linkedInput = join(options.userDataDirectory, 'linked-diagnostics')
    await symlink(options.diagnosticsDirectory, linkedInput, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeDiagnosticReport(destination, { ...options, diagnosticsDirectory: linkedInput })).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    const linkedUserData = join(root, 'linked-data')
    await symlink(options.userDataDirectory, linkedUserData, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeDiagnosticReport(destination, { ...options, userDataDirectory: linkedUserData,
      diagnosticsDirectory: join(linkedUserData, 'diagnostics') })).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects a linked ancestor even when the final parent is not itself a link', async () => {
    const { root, options } = await fixture()
    const actual = join(root, 'actual')
    await mkdir(join(actual, 'child'), { recursive: true })
    const alias = join(root, 'alias')
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeDiagnosticReport(join(alias, 'child', 'report.json'), options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects nonregular source files and multiply linked sources without reading their contents', async () => {
    const { root, options, current, destination } = await fixture()
    await mkdir(current)
    await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await rm(current, { recursive: true })
    const privateSource = join(root, 'private-source')
    await writeFile(privateSource, line(login({ token: canary })))
    await link(privateSource, current)
    await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    expect(await readFile(privateSource, 'utf8')).toContain(canary)
    expect(await readdir(root)).not.toContain('report.json')
  })

  it('removes only its newly created report after a partial write failure and never returns the raw error', async () => {
    const { root, options, destination } = await fixture()
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const existing = join(root, 'existing-report.json')
    await writeFile(existing, canary)
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args)
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async () => {
        await write('{partial-report')
        throw Object.assign(new Error(canary), { code: 'ENOSPC' })
      }
      return handle
    })
    await expect(writeDiagnosticReport(destination, options)).rejects.toMatchObject({ code: 'WRITE_FAILED', message: 'Could not write diagnostic report' })
    expect(await readdir(root)).not.toContain('report.json')
    expect(await readFile(existing, 'utf8')).toBe(canary)
  })
})
