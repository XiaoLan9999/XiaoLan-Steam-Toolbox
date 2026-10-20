import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

interface WorkerMetadata { architecture: 'x86' | 'x64'; bytes: number; sha256: string; fileName?: string }
interface BuildOptions { root?: string; platform?: string; windowsDirectory?: string; compiler?: string; run?: typeof spawnSync }
interface BuildModule {
  inspectNativeWorker(binary: Buffer, architecture: string): WorkerMetadata
  nativePresenceBuildPlan(options?: BuildOptions): { source: string; output: string; compiler: string; workers: Array<{ architecture: string; fileName: string }> }
  buildNativePresence(options?: BuildOptions): WorkerMetadata[]
}
interface Reply { v: number; requestId: string; op: string; ok: boolean; acceptedKeys: string[]; mayHaveWritten: boolean; code?: string; keyCount?: number }

const project = fileURLToPath(new URL('../', import.meta.url))
const { inspectNativeWorker, nativePresenceBuildPlan, buildNativePresence } = await import(new URL('../scripts/build-native-presence.mjs', import.meta.url).href) as BuildModule
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const folders: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'native-presence-test-'))
  folders.push(root)
  return root
}
function clean() {
  for (const root of folders.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
}
function pe(architecture: string) {
  const bytes = Buffer.alloc(256)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(architecture === 'x86' ? 0x14c : 0x8664, 68)
  bytes.writeUInt16LE(architecture === 'x86' ? 0x10b : 0x20b, 88)
  return bytes
}
function buildFixture() {
  const root = temporary()
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'native-presence-worker.cs'), 'fixture-source')
  const csc = join(root, 'fixture-csc.exe')
  writeFileSync(csc, 'fixture-compiler')
  return { root, platform: 'win32', windowsDirectory: root, compiler: csc }
}
function compileFixture(_command: string, args: readonly string[]) {
  const architecture = args.find(argument => argument.startsWith('/platform:'))!.slice('/platform:'.length)
  const target = args.find(argument => argument.startsWith('/out:'))!.slice('/out:'.length)
  writeFileSync(target, pe(architecture))
  return { status: 0 }
}
afterAll(clean)

describe('source-built native presence workers', () => {
  it('creates the agreed separate x86/x64 resource names without a Valve dependency', () => {
    const fixture = buildFixture()
    const plan = nativePresenceBuildPlan(fixture)
    expect(plan.output).toBe(join(fixture.root, 'resources', 'native-presence'))
    expect(plan.workers).toEqual([{ architecture: 'x86', fileName: 'worker-x86.exe' }, { architecture: 'x64', fileName: 'worker-x64.exe' }])
    expect(plan.source).toBe(join(fixture.root, 'scripts', 'native-presence-worker.cs'))
  })
  it('refuses unsupported hosts instead of silently packaging a missing worker', () => {
    expect(() => nativePresenceBuildPlan({ platform: 'linux' })).toThrow('requires Windows')
  })
  it('requires absolute compiler and root paths', () => {
    expect(() => nativePresenceBuildPlan({ ...buildFixture(), root: 'relative' })).toThrow('absolute')
    expect(() => nativePresenceBuildPlan({ ...buildFixture(), compiler: 'relative' })).toThrow('not found')
  })
  it('compiles both architectures with no shell and validates the PE header before publishing', () => {
    const fixture = buildFixture()
    const run = vi.fn(compileFixture)
    const workers = buildNativePresence({ ...fixture, run: run as unknown as typeof spawnSync })
    expect(workers.map(worker => worker.fileName)).toEqual(['worker-x86.exe', 'worker-x64.exe'])
    expect(workers.every(worker => worker.bytes === 256 && /^[a-f0-9]{64}$/.test(worker.sha256))).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    for (const call of run.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>) {
      expect(call[2]).toMatchObject({ windowsHide: true, cwd: fixture.root, timeout: 120000 })
      expect(call[2].shell).toBeUndefined()
      expect(call[1]).toContain('/warnaserror+')
      expect(call[1]).not.toContain('/define:NATIVE_PRESENCE_TEST')
    }
    expect(readdirSync(join(fixture.root, 'resources', 'native-presence')).sort()).toEqual(['worker-x64.exe', 'worker-x86.exe'])
    expect(JSON.stringify(workers)).not.toContain(fixture.root)
  })
  it('keeps old packaged workers if either staged compilation fails, without exposing compiler output', () => {
    const fixture = buildFixture()
    const output = join(fixture.root, 'resources', 'native-presence')
    mkdirSync(output, { recursive: true })
    for (const architecture of ['x86', 'x64']) writeFileSync(join(output, `worker-${architecture}.exe`), 'previous-worker')
    const run = (command: string, args: readonly string[]) => args.includes('/platform:x64') ? { status: 1, stdout: 'must-not-expose-sensitive-compiler-output' } : compileFixture(command, args)
    expect(() => buildNativePresence({ ...fixture, run: run as unknown as typeof spawnSync })).toThrow('Native presence x64 compilation failed')
    for (const architecture of ['x86', 'x64']) expect(readFileSync(join(output, `worker-${architecture}.exe`), 'utf8')).toBe('previous-worker')
    expect(readdirSync(output).sort()).toEqual(['worker-x64.exe', 'worker-x86.exe'])
  })
  it.each(['x86', 'x64'])('recognizes %s PE output and rejects cross-architecture output', architecture => {
    expect(inspectNativeWorker(pe(architecture), architecture)).toMatchObject({ architecture, bytes: 256 })
    expect(() => inspectNativeWorker(pe(architecture === 'x86' ? 'x64' : 'x86'), architecture)).toThrow('architecture mismatch')
  })
  it.each([Buffer.alloc(0), Buffer.alloc(256), Buffer.alloc(2 * 1024 * 1024 + 1)])('rejects malformed or oversized compiler output', bytes => {
    expect(() => inspectNativeWorker(bytes, 'x86')).toThrow('Invalid native presence worker')
  })
  it('rejects overflowing PE offsets without an out-of-bounds read', () => {
    const bytes = pe('x86')
    bytes.writeUInt32LE(0xffffffff, 0x3c)
    expect(() => inspectNativeWorker(bytes, 'x86')).toThrow('architecture mismatch')
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('compiled worker protocol with test-only fake API', () => {
  let testExe = ''
  beforeAll(() => {
    const folder = temporary()
    testExe = join(folder, 'test-worker-x86.exe')
    const result = spawnSync(compiler, ['/nologo', '/platform:x86', '/target:exe', '/optimize+', '/warnaserror+', '/define:NATIVE_PRESENCE_TEST', `/out:${testExe}`, join(project, 'scripts', 'native-presence-worker.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(inspectNativeWorker(readFileSync(testExe), 'x86').bytes).toBeGreaterThan(1000)
  })
  afterEach(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    children.clear()
  })
  function once(line: string, rejectAt = 0, guardAt = 0): { response: Reply; stdout: string } {
    const result = spawnSync(testExe, ['--test-once', line, String(rejectAt), String(guardAt)], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\{"v":1,/)
    expect(result.stderr).toBe('')
    return { response: JSON.parse(result.stdout.trim()) as Reply, stdout: result.stdout }
  }
  const request = (op: string, changes?: unknown) => JSON.stringify({ v: 1, requestId: 'fixture_request', op, ...(changes !== undefined ? { changes } : {}) })
  it('reads only safe key-count and guard metadata, never native rich-presence values', () => {
    expect(once(request('read')).response).toMatchObject({ v: 1, requestId: 'fixture_request', op: 'read', ok: true, keyCount: 3, acceptedKeys: [], mayHaveWritten: false })
  })
  it('sets only requested fields, applies steam_display last, and exposes no values', () => {
    const result = once(request('apply', { steam_display: '#Fixture', status: 'must-not-expose-status', desc: 'must-not-expose-desc' }))
    expect(result.response).toMatchObject({ op: 'applied', ok: true, acceptedKeys: ['desc', 'status', 'steam_display'], mayHaveWritten: true })
    expect(result.stdout).not.toContain('#Fixture')
    expect(result.stdout).not.toContain('must-not-expose')
    expect(result.stdout).not.toContain('confirmed')
  })
  it('handles Chinese UTF-8 values and an empty string single-key removal without clearing other keys', () => {
    expect(once(request('apply', { desc: '\u738b\u5ea7\u4e4b\u95f4 \u56db\u4eba\u4e1c' })).response.acceptedKeys).toEqual(['desc'])
    expect(once(request('apply', { desc: '' })).response.acceptedKeys).toEqual(['desc'])
  })
  it('reports a rejected first Set as potentially written, not successful', () => {
    expect(once(request('apply', { desc: 'fixture' }), 1).response).toMatchObject({ op: 'error', code: 'NATIVE_SET_REJECTED', ok: false, acceptedKeys: [], mayHaveWritten: true })
  })
  it('preserves exact partial-acceptance keys when the second Set fails', () => {
    expect(once(request('apply', { desc: 'fixture', steam_display: '#Fixture' }), 2).response).toMatchObject({ code: 'NATIVE_SET_REJECTED', acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each([1, 2])('does zero Set calls when context guard %i fails before writing', guardAt => {
    expect(once(request('apply', { desc: 'fixture' }), 0, guardAt).response).toMatchObject({ code: 'NATIVE_CONTEXT_CHANGED', acceptedKeys: [], mayHaveWritten: false })
  })
  it('does not write the next key after context changes during an apply', () => {
    expect(once(request('apply', { desc: 'fixture', steam_display: '#Fixture' }), 0, 3).response).toMatchObject({ code: 'NATIVE_CONTEXT_CHANGED', acceptedKeys: ['desc'], mayHaveWritten: true })
  })
  it.each(['connect', 'session', 'lobby', 'authToken', '__proto__', 'constructor', 'steam_player_group', 'version', 'server:ip'])('rejects unsafe key %s before writing', key => {
    expect(once(request('apply', { [key]: 'fixture' })).response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it.each([null, {}, { desc: null }, { desc: 1 }, { desc: 'x'.repeat(256) }, { ['k'.repeat(64)]: 'v' }, { desc: '\n' }, { steam_display: 'arbitrary text' }, { desc: 'a', DESC: 'b' }])('rejects invalid changes without coercion: %j', changes => {
    expect(once(request('apply', changes)).response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
  })
  it.each([
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"a","desc":"b"}}',
    '{"v":1,"requestId":"fixture","op":"read","op":"apply"}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"\\ud800"}}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"\\u12zz"}}',
    '{"v":1,"requestId":"fixture","op":"apply","changes":{"desc":"x"},"unknown":"must-not-expose"}',
    '{"v":1,"requestId":"startup","op":"read"}',
    '{"v":2,"requestId":"fixture","op":"read"}',
    '{"v":1,"requestId":"fixture","op":"read"} trailing',
    '{"v":1,"requestId":"fixture","op":"read","changes":{}}',
    '{"v":1,"requestId":"fixture","op":"restart"}'
  ])('fails closed on malformed or ambiguous JSONL without echoing payload: %s', line => {
    const result = once(line)
    expect(result.response).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
    expect(result.stdout).not.toContain('must-not-expose')
  })
  it('measures value limits in UTF-8 bytes and bounds changes to 20 keys', () => {
    expect(once(request('apply', { desc: '\u4e00'.repeat(85) })).response.ok).toBe(true)
    expect(once(request('apply', { desc: '\u4e00'.repeat(86) })).response.code).toBe('NATIVE_PROTOCOL_INVALID')
    expect(once(request('apply', Object.fromEntries(Array.from({ length: 20 }, (_, index) => ['field' + index, 'v'])))).response.acceptedKeys).toHaveLength(20)
    expect(once(request('apply', Object.fromEntries(Array.from({ length: 21 }, (_, index) => ['field' + index, 'v'])))).response.code).toBe('NATIVE_PROTOCOL_INVALID')
  })
  it('acknowledges stop without touching native presence', () => {
    expect(once(request('stop')).response).toMatchObject({ op: 'stopped', ok: true, acceptedKeys: [], mayHaveWritten: false })
  })

  function session(args = ['--test-loop']) {
    const child = spawn(testExe, args, { stdio: 'pipe', windowsHide: true })
    children.add(child)
    let buffer = ''
    const lines: Reply[] = []
    const waiters: Array<(line: Reply) => void> = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, index)) as Reply
        buffer = buffer.slice(index + 1)
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else lines.push(line)
      }
    })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    const next = () => lines.length ? Promise.resolve(lines.shift()!) : new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture worker response timed out')), 3000)
      waiters.push(line => { clearTimeout(timeout); resolve(line) })
    })
    return { child, next, exited }
  }
  it('supports owned JSONL request/reply and graceful stop', async () => {
    const worker = session()
    expect(await worker.next()).toMatchObject({ requestId: 'startup', op: 'ready', ok: true })
    worker.child.stdin.write(request('read') + '\n')
    expect(await worker.next()).toMatchObject({ requestId: 'fixture_request', op: 'read', keyCount: 3 })
    worker.child.stdin.write(JSON.stringify({ v: 1, requestId: 'stop_request', op: 'stop' }) + '\n')
    expect(await worker.next()).toMatchObject({ op: 'stopped' })
    expect(await worker.exited).toBe(0)
  })
  it('shuts down in less than one second after owned stdin closes', async () => {
    const worker = session()
    await worker.next()
    const started = Date.now()
    worker.child.stdin.end()
    expect(await worker.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('rejects duplicate request IDs without repeating a Set', async () => {
    const worker = session()
    await worker.next()
    const line = request('apply', { desc: 'must-not-expose' }) + '\n'
    worker.child.stdin.write(line)
    expect(await worker.next()).toMatchObject({ op: 'applied', acceptedKeys: ['desc'] })
    worker.child.stdin.write(line)
    expect(await worker.next()).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', acceptedKeys: [], mayHaveWritten: false })
    expect(await worker.exited).toBe(0)
  })
  it('bounds incomplete stdin lines before a newline and rejects invalid UTF-8', async () => {
    for (const input of [Buffer.from('x'.repeat(16385)), Buffer.from([255, 10])]) {
      const worker = session()
      await worker.next()
      worker.child.stdin.write(input)
      expect(await worker.next()).toMatchObject({ code: 'NATIVE_PROTOCOL_INVALID', mayHaveWritten: false })
      expect(await worker.exited).toBe(0)
    }
  })
  it.each(['parent', 'game'])('independently exits only the blocked worker when its bound %s fixture exits', async binding => {
    const fixture = session(['--test-fixture-child'])
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    expect(info.fixturePid).toBe(fixture.child.pid)
    const worker = session([`--test-watchdog-${binding}`, String(info.fixturePid), info.fixtureTicks])
    expect(await worker.next()).toMatchObject({ op: 'ready' })
    const started = Date.now()
    fixture.child.kill()
    await fixture.exited
    expect(await worker.exited).toBe(70)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('detects an instance start-time mismatch without stopping the live fixture', async () => {
    const fixture = session(['--test-fixture-child'])
    const info = await fixture.next() as unknown as { fixturePid: number; fixtureTicks: string }
    const worker = session(['--test-watchdog-parent', String(info.fixturePid), String(BigInt(info.fixtureTicks) + 1n)])
    await worker.next()
    expect(await worker.exited).toBe(70)
    expect(fixture.child.exitCode).toBeNull()
    expect(fixture.child.signalCode).toBeNull()
  })
  it('independently exits a blocked worker within one second after owned stdin EOF', async () => {
    const worker = session(['--test-watchdog-eof'])
    await worker.next()
    const started = Date.now()
    worker.child.stdin.end()
    expect(await worker.exited).toBe(70)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
