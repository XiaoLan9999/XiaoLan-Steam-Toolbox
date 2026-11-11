import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DomainError } from '../shared/domain'
import type { SteamCachedAccount, SteamCachedAccountSwitch, SteamCachedAccountsError, SteamCachedAccountsSnapshot } from '../shared/steam-cached-accounts'
import { parseScreenshotVdf, quoteVdf, vdfChild, type VdfNode } from './steam-screenshot-vdf'
import type { ScreenshotSteamClient, ScreenshotSteamRuntime } from './steam-screenshot-lifecycle-runtime'
import type { SecretCipher } from './store'

const error = (code: SteamCachedAccountsError): DomainError => new DomainError(code, code)
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const individual = (value: string): boolean => /^\d{17}$/.test(value) && BigInt(value) > 76561197960265728n && BigInt(value) <= 76561197960265728n + 0xffffffffn
const flag = (nodes: VdfNode[] | undefined, key: string): boolean => {
  const value = vdfChild(nodes, key)
  if (value && (value.children || !['0', '1'].includes(value.value ?? ''))) throw error('STEAM_CACHE_INVALID')
  return value?.value === '1'
}
function users(text: string): VdfNode[] {
  const roots = parseScreenshotVdf(text)
  if (roots.length !== 1 || roots[0]?.key.toLowerCase() !== 'users' || !roots[0].children || roots[0].children.length > 2048) throw error('STEAM_CACHE_INVALID')
  return roots[0].children
}
export function parseSteamCachedAccounts(text: string): SteamCachedAccount[] {
  try {
    const ids = new Set<string>(), names = new Set<string>()
    return users(text).map(node => {
      if (!individual(node.key) || !node.children || ids.has(node.key)) throw error('STEAM_CACHE_INVALID')
      ids.add(node.key)
      const accountName = vdfChild(node.children, 'AccountName')?.value
      const displayName = vdfChild(node.children, 'PersonaName')?.value ?? accountName
      if (!accountName || !/^[A-Za-z0-9_][A-Za-z0-9_.@+\-]{1,127}$/.test(accountName) || names.has(accountName.toLowerCase()) || !displayName || displayName.length > 512) throw error('STEAM_CACHE_INVALID')
      names.add(accountName.toLowerCase())
      const timestamp = vdfChild(node.children, 'timestamp')?.value
      let lastLoginAt: string | null = null
      if (timestamp && /^\d{1,12}$/.test(timestamp)) { const at = Number(timestamp) * 1000; if (at > 0 && at < 8_640_000_000_000_000) lastLoginAt = new Date(at).toISOString() }
      const auto = vdfChild(node.children, 'AutoLogin') ? flag(node.children, 'AutoLogin') : flag(node.children, 'AllowAutoLogin')
      flag(node.children, 'AutoLogin'); flag(node.children, 'AllowAutoLogin'); flag(node.children, 'MostRecent')
      flag(node.children, 'WantsOfflineMode'); flag(node.children, 'SkipOfflineModeWarning')
      return { steamId: node.key, accountName, displayName: displayName.replace(/[\x00-\x1f\x7f]/g, ''), remembered: flag(node.children, 'RememberPassword'),
        mostRecent: vdfChild(node.children, 'MostRecent') ? flag(node.children, 'MostRecent') : auto, lastLoginAt }
    })
  } catch { throw error('STEAM_CACHE_INVALID') }
}
interface Edit { start: number; end: number; text: string }
function selectorEdits(parent: VdfNode, values: Record<string, string>, text: string): Edit[] {
  if (!parent.children || parent.close === undefined) throw error('STEAM_CACHE_INVALID')
  const edits: Edit[] = [], additions: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const node = vdfChild(parent.children, key)
    if (node?.children) throw error('STEAM_CACHE_INVALID')
    if (node) edits.push({ start: node.start, end: node.end, text: `${quoteVdf(node.key)}\t\t${quoteVdf(value)}` })
    else additions.push(`\t\t${quoteVdf(key)}\t\t${quoteVdf(value)}`)
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  if (additions.length) edits.push({ start: parent.close, end: parent.close, text: `${newline}${additions.join(newline)}${newline}\t` })
  return edits
}
function edited(text: string, changes: Edit[]): string {
  for (const edit of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return text
}
export function selectSteamCachedAccount(text: string, steamId: string, mode?: 'online' | 'offline'): string {
  const accounts = parseSteamCachedAccounts(text)
  if (!accounts.some(value => value.steamId === steamId)) throw error('STEAM_CACHE_CHANGED')
  const changes = users(text).flatMap(node => selectorEdits(node, { AutoLogin: node.key === steamId ? '1' : '0', MostRecent: node.key === steamId ? '1' : '0',
    ...(node.key === steamId ? { AllowAutoLogin: '1', ...(mode ? { WantsOfflineMode: mode === 'offline' ? '1' : '0', SkipOfflineModeWarning: mode === 'offline' ? '1' : '0' } : {}) } : {}) }, text))
  return edited(text, changes)
}
export function skipSteamAccountChooser(text: string): string {
  try {
    const roots = parseScreenshotVdf(text)
    const children = roots.length === 1 && roots[0]?.key.toLowerCase() === 'installconfigstore' && roots[0].children ? roots[0].children : roots
    const web = vdfChild(children, 'WebStorage'), auth = vdfChild(web?.children, 'Auth'), setting = vdfChild(auth?.children, 'AlwaysShowUserChooser')
    if (!setting) return text
    if (!auth || !setting.value || !['0', '1'].includes(setting.value)) throw error('STEAM_CACHE_INVALID')
    return edited(text, selectorEdits(auth, { AlwaysShowUserChooser: '0' }, text))
  } catch { throw error('STEAM_CACHE_INVALID') }
}

interface FileRecord { path: string; bytes: Buffer; digest: string; ino: number | bigint; dev: number | bigint; mtimeMs: number }
async function directory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0')) throw error('STEAM_CACHE_UNAVAILABLE')
  const value = await fs.lstat(path)
  if (!value.isDirectory() || value.isSymbolicLink() || !same(await fs.realpath(path), path)) throw error('STEAM_CACHE_UNAVAILABLE')
}
async function regular(path: string, maximum = 4 * 1024 * 1024): Promise<FileRecord> {
  await directory(dirname(path))
  const before = await fs.lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum || !same(await fs.realpath(path), path)) throw error('STEAM_CACHE_UNAVAILABLE')
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat(), bounded = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bounded.length) { const read = await handle.read(bounded, length, bounded.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
    const bytes = bounded.subarray(0, Math.min(length, before.size)), after = await handle.stat()
    if (stat.ino !== before.ino || stat.dev !== before.dev || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw error('STEAM_CACHE_CHANGED')
    return { path, bytes, digest: hash(bytes), ino: after.ino, dev: after.dev, mtimeMs: after.mtimeMs }
  } finally { await handle.close() }
}
const decode = (value: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)
async function matches(file: FileRecord, digest = file.digest): Promise<void> {
  const current = await regular(file.path, Math.max(4 * 1024 * 1024, file.bytes.length + 4096))
  if (current.digest !== digest || digest === file.digest && (current.ino !== file.ino || current.dev !== file.dev || current.mtimeMs !== file.mtimeMs)) throw error('STEAM_CACHE_CHANGED')
}
async function replace(file: FileRecord, bytes: Buffer, expect: string, ensureStopped: () => Promise<void>): Promise<void> {
  const temporary = `${file.path}.xiaolan-${randomUUID()}.tmp`
  let staged = false
  try {
    const stream = await fs.open(temporary, 'wx', 0o600); staged = true
    try { await stream.writeFile(bytes); await stream.sync() } finally { await stream.close() }
    await ensureStopped(); await matches(file, expect)
    await fs.rename(temporary, file.path); staged = false
  } finally {
    if (staged) { await directory(dirname(file.path)); await fs.unlink(temporary).catch(() => {}) }
  }
}
function recoverySelectors(cache: Cache, target: string, mode: 'online' | 'offline'): unknown[] {
  const login = users(decode(cache.login.bytes)).flatMap(node => ['AutoLogin', 'MostRecent', ...(node.key === target ? ['AllowAutoLogin', 'WantsOfflineMode', 'SkipOfflineModeWarning'] : [])].map(key => {
    const leaf = vdfChild(node.children, key)
    return { steamId: node.key, key, existed: Boolean(leaf), originalValue: leaf?.value ?? null,
      selectedValue: key === 'WantsOfflineMode' || key === 'SkipOfflineModeWarning' ? mode === 'offline' ? '1' : '0' : node.key === target ? '1' : '0' }
  }))
  let chooser: { existed: boolean; originalValue: string | null; selectedValue: string } | null = null
  if (cache.config) {
    const roots = parseScreenshotVdf(decode(cache.config.bytes))
    const children = roots.length === 1 && roots[0]?.key.toLowerCase() === 'installconfigstore' && roots[0].children ? roots[0].children : roots
    const leaf = vdfChild(vdfChild(vdfChild(children, 'WebStorage')?.children, 'Auth')?.children, 'AlwaysShowUserChooser')
    if (leaf) chooser = { existed: true, originalValue: leaf.value ?? null, selectedValue: '0' }
  }
  return [{ file: 'loginusers.vdf', fields: login }, ...(chooser ? [{ file: 'config.vdf', chooser }] : [])]
}
async function saveRecovery(path: string, encrypted: string, pending: boolean, expected?: string): Promise<void> {
  await directory(dirname(path))
  if (expected !== undefined) {
    const current = JSON.parse(decode((await regular(path, MAX_RECOVERY_BYTES)).bytes)) as { encrypted?: unknown }
    if (current.encrypted !== expected) throw error('STEAM_CACHE_RECOVERY_REQUIRED')
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ schema: 1, encrypted, pending })); await handle.sync() } finally { await handle.close() }
    try { const old = await fs.lstat(path); if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) throw error('STEAM_CACHE_WRITE_FAILED') } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
    await fs.rename(temporary, path)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

export interface SteamCachedAccountsOptions {
  getSteamPath(): Promise<string>
  runtime: ScreenshotSteamRuntime
  cipher: Pick<SecretCipher, 'isAvailable' | 'encrypt'>
  recoveryPath: string
  readAutoLogin(): Promise<string | null>
  writeAutoLogin(value: string | null): Promise<void>
  launch(executable: string, accountName: string): Promise<void>
  confirm(account: SteamCachedAccount, steamRunning: boolean, mode: 'online' | 'offline'): Promise<boolean>
  assertIdle(): void
  assertGamesIdle?(): Promise<void>
  sleep?(ms: number): Promise<void>
  now?(): number
  exitTimeoutMs?: number
}
interface Cache { root: string; login: FileRecord; config: FileRecord | null; exe: FileRecord; accounts: SteamCachedAccount[]; revision: string }
export class SteamCachedAccountsService {
  private cache: Pick<Cache, 'revision'> | null = null
  private busy = false
  private closing = false
  private finished = Promise.resolve()
  private finish?: () => void
  private recoveryRequired = false
  private value: SteamCachedAccountsSnapshot = { revision: '', steamPath: null, accounts: [], steamRunning: false, busy: false, status: 'idle', error: null }
  constructor(private readonly options: SteamCachedAccountsOptions) {}
  hasWork(): boolean { return this.busy }
  dispose(): void { this.closing = true }
  shutdown(): Promise<void> { this.dispose(); return this.finished }
  peekAccount(steamId: string, revision: string): { root: string; account: SteamCachedAccount } {
    const account = this.value.accounts.find(value => value.steamId === steamId)
    if (!revision || revision !== this.value.revision || revision !== this.cache?.revision || !account || !this.value.steamPath) throw error('STEAM_CACHE_CHANGED')
    return { root: this.value.steamPath, account: { ...account } }
  }
  private async checkRecovery(): Promise<void> {
    if (this.recoveryRequired) throw error('STEAM_CACHE_RECOVERY_REQUIRED')
    try {
      const value = JSON.parse(decode((await regular(this.options.recoveryPath, MAX_RECOVERY_BYTES)).bytes)) as { schema?: unknown; pending?: unknown; encrypted?: unknown }
      if (value.schema !== 1 || value.pending !== false || typeof value.encrypted !== 'string') { this.recoveryRequired = true; throw error('STEAM_CACHE_RECOVERY_REQUIRED') }
    } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') { this.recoveryRequired = true; throw error('STEAM_CACHE_RECOVERY_REQUIRED') } }
  }
  private async read(): Promise<Cache> {
    const configured = await this.options.getSteamPath()
    if (!isAbsolute(configured) || configured.startsWith('\\\\') || configured.includes('\0')) throw error('STEAM_CACHE_UNAVAILABLE')
    const root = resolve(configured)
    await directory(root); await directory(join(root, 'config'))
    const login = await regular(join(root, 'config', 'loginusers.vdf'))
    const exe = await regular(join(root, 'steam.exe'), 64 * 1024 * 1024)
    let config: FileRecord | null = null
    try { config = await regular(join(root, 'config', 'config.vdf'), 16 * 1024 * 1024) } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
    const accounts = parseSteamCachedAccounts(decode(login.bytes))
    if (config) skipSteamAccountChooser(decode(config.bytes))
    return { root, login, config, exe, accounts, revision: hash(`${root.toLowerCase()}|${login.digest}|${config?.digest ?? ''}|${exe.digest}`) }
  }
  async state(): Promise<SteamCachedAccountsSnapshot> {
    if (this.busy) return { ...this.value, busy: true }
    try {
      await this.checkRecovery()
      const current = await this.read()
      this.cache = { revision: current.revision }
      this.value = { ...this.value, revision: current.revision, steamPath: current.root, accounts: current.accounts, steamRunning: await this.options.runtime.isRunning(), busy: false, error: null }
    } catch (failure) {
      this.cache = null; this.value = { ...this.value, revision: '', accounts: [], steamPath: null, busy: false, status: 'error', error: failure instanceof DomainError ? failure.code as SteamCachedAccountsError : 'STEAM_CACHE_UNAVAILABLE' }
    }
    return { ...this.value, accounts: this.value.accounts.map(value => ({ ...value })) }
  }
  async switchAccount(input: SteamCachedAccountSwitch): Promise<SteamCachedAccountsSnapshot> {
    if (this.busy || this.closing) throw error('STEAM_CACHE_BUSY')
    if (this.recoveryRequired) throw error('STEAM_CACHE_RECOVERY_REQUIRED')
    if (!input || typeof input.revision !== 'string' || input.revision !== this.cache?.revision || !individual(input.steamId ?? '')) throw error('STEAM_CACHE_CHANGED')
    const mode = input.mode ?? 'online'
    if (mode !== 'online' && mode !== 'offline') throw error('STEAM_CACHE_INVALID')
    this.options.assertIdle()
    if (!this.options.cipher.isAvailable()) throw error('STEAM_CACHE_UNAVAILABLE')
    this.busy = true; this.value = { ...this.value, busy: true, status: 'switching', error: null }
    this.finished = new Promise(resolve => { this.finish = resolve })
    let client: ScreenshotSteamClient | undefined, stoppedByUs = false, committed = false
    const changed: Array<{ file: FileRecord; digest: string }> = []
    let originalAuto: string | null = null, selectedName: string | null = null, registryChanged = false
    let recovery: string | undefined
    let recoveryWritten = false
    const ensureStopped = async (): Promise<void> => {
      this.options.assertIdle()
      if (this.closing || await this.options.runtime.isRunning()) throw error('STEAM_CACHE_CLIENT_CHANGED')
    }
    const ensureRecoveryStopped = async (): Promise<void> => { if (await this.options.runtime.isRunning()) throw error('STEAM_CACHE_CLIENT_CHANGED') }
    try {
      let current = await this.read()
      if (current.revision !== input.revision) throw error('STEAM_CACHE_CHANGED')
      const target = current.accounts.find(value => value.steamId === input.steamId)
      if (!target) throw error('STEAM_CACHE_CHANGED')
      const running = await this.options.runtime.isRunning()
      if (running) await this.options.assertGamesIdle?.()
      if (!await this.options.confirm({ ...target }, running, mode)) { this.value.status = 'cancelled'; return { ...this.value, busy: false } }
      this.options.assertIdle()
      if (this.closing) throw error('STEAM_CACHE_BUSY')
      if (running) {
        await this.options.assertGamesIdle?.()
        client = await this.options.runtime.resolveRunningClient(current.root)
        await this.options.runtime.requestShutdown(client); stoppedByUs = true
        const end = (this.options.now ?? Date.now)() + Math.min(60000, this.options.exitTimeoutMs ?? 60000)
        while (await this.options.runtime.isRunning()) {
          if ((this.options.now ?? Date.now)() >= end) throw error('STEAM_CACHE_EXIT_UNCONFIRMED')
          await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(500)
        }
      } else await ensureStopped()
      // Steam legitimately saves metadata during shutdown; re-read before patching it.
      const saved = await this.read()
      const selected = saved.accounts.find(value => value.steamId === target.steamId)
      if (!selected || selected.accountName !== target.accountName || saved.root !== current.root || saved.exe.digest !== current.exe.digest) throw error('STEAM_CACHE_CHANGED')
      current = saved; selectedName = selected.accountName
      originalAuto = await this.options.readAutoLogin()
      const patches = [{ file: current.login, bytes: Buffer.from(selectSteamCachedAccount(decode(current.login.bytes), selected.steamId, mode)) },
        ...(current.config ? [{ file: current.config, bytes: Buffer.from(skipSteamAccountChooser(decode(current.config.bytes))) }] : [])]
      await ensureStopped()
      await directory(dirname(this.options.recoveryPath))
      await this.checkRecovery()
      recovery = this.options.cipher.encrypt(JSON.stringify({ schema: 1, root: current.root, autoLoginUser: originalAuto, selectors: recoverySelectors(current, selected.steamId, mode),
        files: patches.filter(value => hash(value.bytes) !== value.file.digest).map(value => ({ file: value.file.path.endsWith('loginusers.vdf') ? 'loginusers.vdf' : 'config.vdf', originalSha256: value.file.digest, selectedSha256: hash(value.bytes) })) })).toString('base64')
      await saveRecovery(this.options.recoveryPath, recovery, true)
      recoveryWritten = true
      for (const patch of patches) {
        if (hash(patch.bytes) === patch.file.digest) continue
        await replace(patch.file, patch.bytes, patch.file.digest, ensureStopped)
        changed.push({ file: patch.file, digest: hash(patch.bytes) })
      }
      await ensureStopped()
      if (await this.options.readAutoLogin() !== originalAuto) throw error('STEAM_CACHE_CHANGED')
      registryChanged = true
      await this.options.writeAutoLogin(selected.accountName)
      await ensureStopped(); await matches(current.exe)
      await this.options.launch(current.exe.path, selected.accountName)
      committed = true; this.cache = null
      await saveRecovery(this.options.recoveryPath, recovery, false, recovery)
      this.value = { ...this.value, revision: '', status: 'awaiting-login', error: null, steamRunning: true }
    } catch (failure) {
      let restored = !committed
      if (!committed && (changed.length || registryChanged)) {
        try {
          await ensureRecoveryStopped()
          if (registryChanged) {
            const current = await this.options.readAutoLogin()
            if (current !== selectedName && current !== originalAuto) throw error('STEAM_CACHE_CHANGED')
            if (current === selectedName) await this.options.writeAutoLogin(originalAuto)
          }
          for (const value of changed.reverse()) await replace(value.file, value.file.bytes, value.digest, ensureRecoveryStopped)
        } catch { restored = false }
      }
      if (recovery && recoveryWritten) {
        try { await saveRecovery(this.options.recoveryPath, recovery, !restored, recovery) } catch { restored = false }
      }
      if (!restored) this.recoveryRequired = true
      if (stoppedByUs && client && !committed && restored && !this.closing && !await this.options.runtime.isRunning()) {
        try { await this.options.runtime.start(client) } catch { /* Keep the failure visible; do not claim that Steam restarted. */ }
      }
      const code = failure instanceof DomainError ? failure.code : ''
      this.value = { ...this.value, status: 'error', error: !restored ? 'STEAM_CACHE_RECOVERY_REQUIRED' : code === 'SCREENSHOT_STEAM_GAME_RUNNING' ? 'STEAM_CACHE_GAME_RUNNING'
        : code === 'SCREENSHOT_STEAM_SHUTDOWN_FAILED' ? 'STEAM_CACHE_EXIT_UNCONFIRMED'
        : code.startsWith('SCREENSHOT_STEAM_') ? 'STEAM_CACHE_CLIENT_CHANGED'
        : code.startsWith('STEAM_CACHE_') ? code as SteamCachedAccountsError : 'STEAM_CACHE_WRITE_FAILED' }
    } finally { this.busy = false; this.value.busy = false; this.finish?.(); this.finish = undefined }
    return { ...this.value, accounts: this.value.accounts.map(value => ({ ...value })) }
  }
}
