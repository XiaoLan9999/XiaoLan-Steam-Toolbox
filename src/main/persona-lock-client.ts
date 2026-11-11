import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import type { PersonaReadback, PersonaSession } from './persona-lock-service'
import { personaNativeFailureCode, type PersonaNativeFailureCode } from '../shared/persona-lock'

const HASH = '253e0a11a4415b38c78a42f7bdd6ecc426455f06c1ba6453a48090df3142dbbc'
const execute = promisify(execFile)
const ownedSessions = new Set<NativePersonaSession>()
export const hasNativePersonaWork = (): boolean => ownedSessions.size > 0
export async function shutdownNativePersonaSessions(): Promise<void> { await Promise.all([...ownedSessions].map(session => session.close())) }
class PersonaNativeError extends DomainError {
  constructor(code: string, readonly nativeCode: PersonaNativeFailureCode | null) { super(code, code) }
}
const fail = (code = 'PERSONA_UNAVAILABLE', nativeCode: PersonaNativeFailureCode | null = null): DomainError => new PersonaNativeError(code, nativeCode)
const same = (a: string, b: string): boolean => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const ticks = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{1,18}$/.test(value)
const individual = (value: string): boolean => /^\d{17}$/.test(value) && BigInt(value) > 76561197960265728n && BigInt(value) <= 76561197960265728n + 0xffffffffn
const validState = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 7
export function readPersonaFrame(value: unknown): PersonaReadback {
  const frame = value as Record<string, unknown> | null
  if (!frame || !validState(frame.currentState) || frame.originalState !== null && !validState(frame.originalState) ||
    typeof frame.locked !== 'boolean' || frame.restored !== null && typeof frame.restored !== 'boolean' || frame.locked && frame.originalState === null) throw fail()
  return { currentState: frame.currentState, originalState: frame.originalState as number | null, locked: frame.locked, restored: frame.restored as boolean | null }
}

export class NativePersonaSession implements PersonaSession {
  ready!: PersonaReadback
  private pending: { id: string; resolve(value: PersonaReadback): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  private closed = false
  private stopping = false
  private stopRestored: boolean | null | undefined
  private terminalError: Error | null = null
  private exited: Promise<void>
  private readyPromise: Promise<void>
  constructor(private readonly child: ChildProcessWithoutNullStreams, steamId: string, steamPid: number, steamStartTicks: string, signal: AbortSignal) {
    ownedSessions.add(this)
    let text = '', noise = 0, ready = false, cleanup = false, failed = false
    let acceptReady!: () => void, rejectReady!: (error: Error) => void
    this.readyPromise = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject })
    const readyTimer = setTimeout(() => fault(fail()), 10000); readyTimer.unref?.()
    const fault = (error: Error): void => {
      failed = true
      this.terminalError ??= error
      clearTimeout(readyTimer); rejectReady(error)
      const pending = this.pending; this.pending = null
      if (pending) { clearTimeout(pending.timer); pending.reject(error) }
      // EOF asks the helper to restore only its owned value, never another account's state.
      if (!this.closed) this.child.stdin.end()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed || failed) return
      text += chunk.toString('utf8')
      if (Buffer.byteLength(text) > 16384) { fault(fail()); return }
      let end: number
      while ((end = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, end).trim(); text = text.slice(end + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line) as Record<string, unknown>
          if (frame.v !== 1) throw fail()
          if (frame.op === 'error') throw fail(frame.code === 'PERSONA_PRIVATE_STATE' ? 'PERSONA_PRIVATE_STATE' : frame.code === 'PERSONA_IDENTITY_MISMATCH' || frame.code === 'PERSONA_CONTEXT_CHANGED' ? 'PERSONA_CONTEXT_CHANGED' : frame.code === 'PERSONA_SET_REJECTED' || frame.code === 'PERSONA_RESTORE_REJECTED' ? 'PERSONA_UNCONFIRMED' : 'PERSONA_UNAVAILABLE', personaNativeFailureCode({ nativeCode: frame.code }))
          if (frame.op === 'ready') {
            if (ready || frame.steamId !== steamId || frame.steamPid !== steamPid || frame.steamStartTicks !== steamStartTicks) throw fail('PERSONA_CONTEXT_CHANGED')
            this.ready = readPersonaFrame({ restored: null, ...frame })
            if (this.ready.locked || this.ready.originalState !== null) throw fail()
            ready = true; clearTimeout(readyTimer); acceptReady()
          } else if (frame.op === 'result') {
            if (!ready || !this.pending || frame.requestId !== this.pending.id) throw fail()
            const value = readPersonaFrame(frame), pending = this.pending
            if (this.stopping) this.stopRestored = value.restored
            this.pending = null; clearTimeout(pending.timer); pending.resolve(value)
          } else if (frame.op === 'lifecycle') {
            if (cleanup || frame.stage !== 'cleanup' || ['userReleased', 'pipeReleased', 'threadMemoryReleased', 'libraryReleased'].some(key => frame[key] !== true)) throw fail()
            if (frame.restored !== null && typeof frame.restored !== 'boolean' || this.stopRestored === true && frame.restored !== true) throw fail('PERSONA_UNCONFIRMED')
            cleanup = true
          } else throw fail()
        } catch (error) { fault(error instanceof DomainError ? error : fail()); return }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { noise += chunk.length; if (noise > 32768) fault(fail()) })
    child.on('error', () => fault(fail()))
    child.stdin.on('error', () => fault(fail()))
    this.exited = new Promise((accept, reject) => {
      child.on('close', (exitCode: number | null) => {
        ownedSessions.delete(this)
        this.closed = true; clearTimeout(readyTimer); signal.removeEventListener('abort', cancel)
        if (!ready || this.pending) fault(fail('PERSONA_UNCONFIRMED'))
        if (exitCode === 0 && cleanup && !failed && !text.trim()) accept(); else reject(fail('PERSONA_UNCONFIRMED'))
      })
    })
    void this.exited.catch(() => {})
    const cancel = (): void => fault(fail('PERSONA_CONTEXT_CHANGED'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  }
  async initialized(): Promise<this> { try { await this.readyPromise; return this } catch (error) { await this.close().catch(() => {}); throw error } }
  request(op: 'read' | 'lock' | 'unlock' | 'stop'): Promise<PersonaReadback> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    if (this.closed) return Promise.reject(fail('PERSONA_UNCONFIRMED'))
    if (this.stopping || this.pending) return Promise.reject(fail('PERSONA_BUSY'))
    if (op === 'stop') this.stopping = true
    return new Promise((accept, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending = null; this.child.stdin.end(); reject(fail('PERSONA_UNCONFIRMED')) }, 8000)
      timer.unref?.()
      this.pending = { id, resolve: accept, reject, timer }
      this.child.stdin.write(JSON.stringify({ v: 1, requestId: id, op }) + '\n')
    })
  }
  async close(): Promise<void> {
    if (!this.closed) this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      try {
        await Promise.race([this.exited, new Promise<never>((_accept, reject) => {
          timer = setTimeout(() => reject(fail('PERSONA_UNCONFIRMED')), 5000); timer.unref?.()
        })])
      } catch (error) {
        clearTimeout(timer)
        if (!this.closed) {
          this.child.kill()
          await Promise.race([this.exited, new Promise<never>((_accept, reject) => {
            timer = setTimeout(() => reject(fail('PERSONA_UNCONFIRMED')), 3000); timer.unref?.()
          })])
        }
        throw error
      }
    } finally { clearTimeout(timer) }
  }
}

export async function connectNativePersona(workerPath: string, steamId: string, signal: AbortSignal): Promise<PersonaSession> {
  if (ownedSessions.size) throw fail('PERSONA_BUSY')
  if (process.platform !== 'win32' || process.arch !== 'x64' || !individual(steamId) || signal.aborted || !isAbsolute(workerPath)) throw fail()
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$all=@(Get-Process -Name steam -ErrorAction Stop)
if($all.Count -ne 1){throw 'Steam unavailable'}
$steam=$all[0]
$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$steam.Id) -Property ExecutablePath).ExecutablePath
$registered=Get-ItemPropertyValue -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -Name SteamExe
$owner=Get-Process -Id ${process.pid}
@{exe=$image;registered=$registered;pid=$steam.Id;start=$steam.StartTime.ToUniversalTime().Ticks.ToString();ownerStart=$owner.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`
  const powershell = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000, maxBuffer: 16384, encoding: 'utf8', shell: false, signal })
  const context = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as Record<string, unknown>
  if (typeof context.exe !== 'string' || typeof context.registered !== 'string' || !same(context.exe, context.registered) || win32.basename(context.exe).toLowerCase() !== 'steam.exe' ||
    !pid(context.pid) || !ticks(context.start) || !ticks(context.ownerStart)) throw fail()
  const dll = win32.join(win32.dirname(context.exe), 'steamclient64.dll'), worker = resolve(workerPath)
  for (const path of [context.exe, dll, worker]) {
    if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0')) throw fail()
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !same(await realpath(path), path)) throw fail()
  }
  const before = await lstat(dll)
  if (before.size < 256 || before.size > 128 * 1024 * 1024) throw fail()
  const bytes = await readFile(dll), after = await lstat(dll)
  if (before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size || createHash('sha256').update(bytes).digest('hex') !== HASH || signal.aborted) throw fail()
  if (ownedSessions.size) throw fail('PERSONA_BUSY')
  const child = spawn(worker, ['--persona-session', dll, HASH, String(context.pid), context.start, String(process.pid), context.ownerStart, steamId], { windowsHide: true, stdio: 'pipe', shell: false })
  return new NativePersonaSession(child, steamId, context.pid, context.start, signal).initialized()
}
