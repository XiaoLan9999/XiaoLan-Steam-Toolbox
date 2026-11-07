import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { win32 as path } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
import type { NativeGameStatusContext } from './native-game-status-client'
import { discoverNativePresenceBinding } from './native-presence-broker'
import type { NativePresenceBinding, NativePresenceContext } from './native-presence-broker'
import { readScreenshotActiveUser } from './screenshot-active-user'
import type { ScreenshotActiveUser } from './screenshot-active-user'

export interface VerifiedNativeProcess { pid: number; startTicks: string; exe: string }
export interface VerifiedNativeInspection {
  registryExe: string
  steamProcesses: VerifiedNativeProcess[]
  runningAppId: number
  runningAppIds: number[]
  activeProcess?: { pid?: number; activeUser?: number | string | null }
  gameProcess?: VerifiedNativeProcess | null
}
export interface VerifiedNativeGameStatusContext extends NativeGameStatusContext {
  identitySource: 'native-user'
  gamePid: number
  gameStartTicks: string
  gameExe: string
}
export interface VerifiedNativeContextDependencies {
  platform: NodeJS.Platform
  inspect(gamePid?: number): Promise<unknown>
  discover(context: NativePresenceContext): Promise<NativePresenceBinding>
  readIdentity(steamPath: string, workerPath: string, options?: { signal?: AbortSignal }): Promise<ScreenshotActiveUser>
  realpath(file: string): Promise<string>
}
export interface VerifiedNativeContextDetector {
  (): Promise<NativeGameStatusContext>
  cancel(): void
}

interface CheckedInspection {
  steam: VerifiedNativeProcess
  candidates: number[]
  activeProcess?: VerifiedNativeInspection['activeProcess']
  game?: VerifiedNativeProcess | null
}
interface AttachedContext {
  context: Readonly<VerifiedNativeGameStatusContext>
  candidates: readonly number[]
}
const execute = promisify(execFile)
const STEAM_ID_BASE = 76_561_197_960_265_728n
const MAX_CANDIDATES = 8
const safePid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const safeTicks = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{1,18}$/.test(value)
const safeApp = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffff
const individual = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value)
  && BigInt(value) > STEAM_ID_BASE && BigInt(value) <= STEAM_ID_BASE + 0xffffffffn
const samePath = (a: string, b: string): boolean => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
const unavailable = (): DomainError => new DomainError('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', '暂时无法可靠核实本机 Steam 和游戏，请保持游戏运行后重新连接')
const changed = (): DomainError => new DomainError('GAME_STATUS_CONTEXT_CHANGED', '本机 Steam 或游戏进程已经变化，请重新连接')
const identityMismatch = (): DomainError => new DomainError('GAME_STATUS_IDENTITY_MISMATCH', '本机 Steam 与工具箱账号不一致，未继续操作')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const localAbsolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value)
  && /^[a-z]:[\\/]/i.test(value) && !/[\x00-\x1f]/.test(value)

async function inspectNativeContext(gamePid?: number): Promise<unknown> {
  if (gamePid !== undefined && !safePid(gamePid)) throw unavailable()
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$config=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam'
$active=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess' -ErrorAction SilentlyContinue
$all=@(Get-Process -Name steam -ErrorAction SilentlyContinue)
$steam=@(foreach($item in $all){$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.Id) -Property ExecutablePath).ExecutablePath;if(!$image){throw 'Steam image unavailable'};@{pid=$item.Id;startTicks=$item.StartTime.ToUniversalTime().Ticks.ToString();exe=$image}})
$runningAppId=0
if($null -ne $config.RunningAppID){$runningAppId=[long]$config.RunningAppID}
$apps='HKCU:\\Software\\Valve\\Steam\\Apps'
$keys=@(if(Test-Path -LiteralPath $apps){Get-ChildItem -LiteralPath $apps -ErrorAction Stop})
if($keys.Count -gt 4096){throw 'Steam activity unavailable'}
$running=@(foreach($key in $keys){$item=Get-ItemProperty -LiteralPath $key.PSPath;if($null -ne $item.Running -and [long]$item.Running -ne 0){if($key.PSChildName -notmatch '^[0-9]+$'){throw 'Steam activity unavailable'};[long]$key.PSChildName}})
if($running.Count -gt ${MAX_CANDIDATES}){throw 'Steam activity ambiguous'}
$game=$null
${gamePid === undefined ? '' : `$process=Get-Process -Id ${gamePid} -ErrorAction SilentlyContinue
if($process){$image=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id) -Property ExecutablePath).ExecutablePath;if(!$image){throw 'Game image unavailable'};$game=@{pid=$process.Id;startTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();exe=$image}}`}
$activeContext=$null
if($active){$activeContext=@{pid=$active.pid;activeUser=$active.ActiveUser}}
@{registryExe=[string]$config.SteamExe;steamProcesses=@($steam);runningAppId=$runningAppId;runningAppIds=@($running);activeProcess=$activeContext;gameProcess=$game}|ConvertTo-Json -Compress -Depth 5`
  const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await execute(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8', shell: false })
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as unknown
}

async function checkedProcess(value: unknown, deps: VerifiedNativeContextDependencies): Promise<VerifiedNativeProcess> {
  if (!object(value) || !safePid(value.pid) || !safeTicks(value.startTicks) || !localAbsolute(value.exe)) throw unavailable()
  const exe = await deps.realpath(value.exe)
  if (!localAbsolute(exe) || !/\.exe$/i.test(path.basename(exe))) throw unavailable()
  return { pid: value.pid, startTicks: value.startTicks, exe: path.normalize(exe) }
}

async function checkedInspection(value: unknown, deps: VerifiedNativeContextDependencies): Promise<CheckedInspection> {
  if (!object(value) || !localAbsolute(value.registryExe) || !Array.isArray(value.steamProcesses) || value.steamProcesses.length !== 1
    || !safeApp(value.runningAppId) || !Array.isArray(value.runningAppIds) || value.runningAppIds.length > 4096 || !value.runningAppIds.every(safeApp)) throw unavailable()
  const steam = await checkedProcess(value.steamProcesses[0], deps)
  const registryExe = await deps.realpath(value.registryExe)
  if (path.basename(steam.exe).toLowerCase() !== 'steam.exe' || !localAbsolute(registryExe) || !samePath(steam.exe, registryExe)) throw unavailable()
  const candidates = [...new Set([value.runningAppId, ...value.runningAppIds].filter(id => id !== 0))].sort((a, b) => a - b)
  if (candidates.length > MAX_CANDIDATES) throw unavailable()
  if (value.activeProcess !== undefined && value.activeProcess !== null && !object(value.activeProcess)) throw unavailable()
  return { steam, candidates, ...(value.activeProcess ? { activeProcess: value.activeProcess as VerifiedNativeInspection['activeProcess'] } : {}),
    ...(value.gameProcess === null ? { game: null } : value.gameProcess === undefined ? {} : { game: await checkedProcess(value.gameProcess, deps) }) }
}

function rejectActiveUserConflict(inspection: CheckedInspection, expectedSteamId: string): void {
  const active = inspection.activeProcess
  if (!active || active.pid !== inspection.steam.pid || active.activeUser === undefined || active.activeUser === null || active.activeUser === 0 || active.activeUser === '0') return
  const text = String(active.activeUser)
  if (!/^-?\d{1,10}$/.test(text) || typeof active.activeUser === 'number' && !Number.isSafeInteger(active.activeUser)) throw unavailable()
  let account = BigInt(text)
  if (account < 0n) account += 0x1_0000_0000n
  if (account <= 0n || account > 0xffff_ffffn) throw unavailable()
  if (String(STEAM_ID_BASE + account) !== expectedSteamId) throw identityMismatch()
}

function sameProcess(a: VerifiedNativeProcess, b: VerifiedNativeProcess): boolean {
  return a.pid === b.pid && a.startTicks === b.startTicks && samePath(a.exe, b.exe)
}
function sameCandidates(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
function bindingProcess(binding: NativePresenceBinding): VerifiedNativeProcess {
  return { pid: binding.gamePid, startTicks: binding.gameStartTicks, exe: binding.gameExe }
}
function verifyAttached(inspection: CheckedInspection, attached: AttachedContext, expectedSteamId: string, strictCandidates = false): void {
  rejectActiveUserConflict(inspection, expectedSteamId)
  const context = attached.context
  if (!sameProcess(inspection.steam, { pid: context.steamPid, startTicks: context.steamStartTicks, exe: context.steamExe })
    || !inspection.game || !sameProcess(inspection.game, { pid: context.gamePid, startTicks: context.gameStartTicks, exe: context.gameExe })
    || strictCandidates && !sameCandidates(inspection.candidates, attached.candidates)) throw changed()
}

export function createVerifiedNativeContextDetector(expectedSteamId: string, workerPath: string,
  options: Partial<VerifiedNativeContextDependencies> = {}): VerifiedNativeContextDetector {
  const raw: VerifiedNativeContextDependencies = { platform: process.platform, inspect: inspectNativeContext,
    discover: discoverNativePresenceBinding, readIdentity: readScreenshotActiveUser, realpath, ...options }
  const cancellation = new AbortController()
  const stage = <T>(action: () => Promise<T>): Promise<T> => new Promise<T>((accept, decline) => {
    let settled = false
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      cancellation.signal.removeEventListener('abort', abort)
      result()
    }
    const abort = (): void => finish(() => decline(cancellation.signal.reason))
    if (cancellation.signal.aborted) { abort(); return }
    cancellation.signal.addEventListener('abort', abort, { once: true })
    try { void action().then(value => finish(() => accept(value)), error => finish(() => decline(error))) }
    catch (error) { finish(() => decline(error)) }
  })
  const deps: VerifiedNativeContextDependencies = { ...raw, inspect: gamePid => stage(() => raw.inspect(gamePid)),
    discover: context => stage(() => raw.discover(context)),
    readIdentity: (root, worker) => stage(() => raw.readIdentity(root, worker, { signal: cancellation.signal })),
    realpath: file => stage(() => raw.realpath(file)) }
  let attached: AttachedContext | undefined
  let flight: Promise<NativeGameStatusContext> | undefined
  let invalid: DomainError | undefined
  let attempted = false

  const initialize = async (): Promise<AttachedContext> => {
    if (attempted) throw invalid ?? changed()
    attempted = true
    if (deps.platform !== 'win32' || !individual(expectedSteamId) || !localAbsolute(workerPath)) throw unavailable()
    const initial = await checkedInspection(await deps.inspect(), deps)
    rejectActiveUserConflict(initial, expectedSteamId)
    if (!initial.candidates.length) throw new DomainError('GAME_STATUS_NO_LIVE_GAME', '请先启动真实 Steam 游戏，再连接本机状态')
    const context: NativePresenceContext & { identitySource: 'native-user' } = { appId: 0, steamId: expectedSteamId,
      steamPid: initial.steam.pid, steamStartTicks: initial.steam.startTicks, identitySource: 'native-user' }
    const candidates: Array<{ appId: number; binding: NativePresenceBinding }> = []
    for (const appId of initial.candidates) {
      try {
        const binding = await deps.discover({ ...context, appId })
        if (!binding || binding.steamPid !== initial.steam.pid || binding.steamStartTicks !== initial.steam.startTicks) throw changed()
        const game = await checkedProcess(bindingProcess(binding), deps)
        if (game.pid === initial.steam.pid || !samePath(game.exe, binding.gameExe)) throw unavailable()
        candidates.push({ appId, binding: { ...binding, gameExe: game.exe } })
      } catch (error) {
        if (object(error) && error.nativeCode === 'NATIVE_GAME_NOT_FOUND') continue
        throw error
      }
    }
    if (candidates.length !== 1) throw unavailable()
    const selected = candidates[0]!
    const value: VerifiedNativeGameStatusContext = { appId: selected.appId, steamId: expectedSteamId, steamPid: initial.steam.pid,
      steamStartTicks: initial.steam.startTicks, steamExe: initial.steam.exe, identitySource: 'native-user',
      gamePid: selected.binding.gamePid, gameStartTicks: selected.binding.gameStartTicks, gameExe: selected.binding.gameExe }
    const candidate: AttachedContext = { context: Object.freeze(value), candidates: Object.freeze([...initial.candidates]) }
    verifyAttached(await checkedInspection(await deps.inspect(value.gamePid), deps), candidate, expectedSteamId, true)
    const identity = await deps.readIdentity(path.dirname(value.steamExe), workerPath)
    if (!identity || identity.steamId !== expectedSteamId) throw identityMismatch()
    if (identity.steamPid !== value.steamPid || identity.steamStartTicks !== value.steamStartTicks
      || typeof identity.steamExe !== 'string' || !samePath(identity.steamExe, value.steamExe)
      || typeof identity.steamPath !== 'string' || !samePath(identity.steamPath, path.dirname(value.steamExe))
      || typeof identity.clientSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.clientSha256)) throw unavailable()
    verifyAttached(await checkedInspection(await deps.inspect(value.gamePid), deps), candidate, expectedSteamId, true)
    cancellation.signal.throwIfAborted()
    return candidate
  }

  const revalidate = async (known: AttachedContext): Promise<void> => {
    const inspection = await checkedInspection(await deps.inspect(known.context.gamePid), deps)
    verifyAttached(inspection, known, expectedSteamId)
    if (sameCandidates(inspection.candidates, known.candidates)) return
    for (const appId of inspection.candidates) {
      if (appId === known.context.appId) continue
      try {
        await deps.discover({ appId, steamId: expectedSteamId, steamPid: known.context.steamPid,
          steamStartTicks: known.context.steamStartTicks, identitySource: 'native-user' } as NativePresenceContext)
      } catch (error) {
        if (object(error) && error.nativeCode === 'NATIVE_GAME_NOT_FOUND') continue
        throw error
      }
      throw changed()
    }
    const current = await checkedInspection(await deps.inspect(known.context.gamePid), deps)
    verifyAttached(current, known, expectedSteamId)
    if (!sameCandidates(current.candidates, inspection.candidates)) throw unavailable()
    cancellation.signal.throwIfAborted()
    known.candidates = Object.freeze([...inspection.candidates])
  }

  const detect: VerifiedNativeContextDetector = (): Promise<NativeGameStatusContext> => {
    if (flight) return flight
    if (invalid) return Promise.reject(invalid)
    const operation = (async () => {
      try {
        if (!attached) {
          const candidate = await initialize()
          cancellation.signal.throwIfAborted()
          attached = candidate
        }
        else await revalidate(attached)
        cancellation.signal.throwIfAborted()
        return { ...attached.context }
      } catch (error) {
        const safe = error instanceof DomainError ? error : unavailable()
        if (!attached || ['GAME_STATUS_CONTEXT_CHANGED', 'GAME_STATUS_IDENTITY_MISMATCH'].includes(safe.code)) invalid = safe
        throw safe
      }
    })()
    flight = operation
    void operation.finally(() => { if (flight === operation) flight = undefined }).catch(() => undefined)
    return operation
  }
  detect.cancel = (): void => {
    if (cancellation.signal.aborted) return
    invalid = changed()
    cancellation.abort(invalid)
  }
  return detect
}
