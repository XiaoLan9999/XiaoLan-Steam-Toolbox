import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { backup, DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DomainError } from '../shared/domain'
import { SqliteStore, type DataImportSummary } from './store'

const MAX_DATABASE_BYTES = 256 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const owned = new WeakSet<PreparedDataImport>()
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code
const failure = (code: string, message: string): DomainError => new DomainError(`DATA_IMPORT_${code}`, message)

export function sameDataImportFileIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export interface PreparedDataImport {
  readonly id: string
  readonly stagedPath: string
  readonly sha256: string
  readonly summary: DataImportSummary
  /** Private backup directory, populated immediately before applying the import. */
  readonly backupPath: string
}
interface ImportPlan { version: 1; id: string; sha256: string; summary: DataImportSummary }

async function directory(path: string, create = false): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw failure('UNSAFE_PATH', '数据导入目录无效')
  const absolute = resolve(path)
  if (create) {
    try { await fs.lstat(absolute) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      const parent = dirname(absolute)
      if (parent === absolute) throw error
      await directory(parent, true)
      try { await fs.mkdir(absolute, { mode: 0o700 }) } catch (error) { if (errno(error) !== 'EEXIST') throw error }
    }
  }
  const metadata = await fs.lstat(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolve(await fs.realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) {
    throw failure('UNSAFE_PATH', '数据导入目录包含链接或重解析路径，已停止操作')
  }
  return absolute
}

async function regular(path: string, max = MAX_DATABASE_BYTES): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw failure('UNSAFE_PATH', '备份文件路径无效')
  const metadata = await fs.lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > max ||
      resolve(await fs.realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) {
    throw failure('UNSAFE_PATH', '备份文件类型、路径或大小不受支持')
  }
  return metadata
}

async function digestFile(path: string, max = MAX_DATABASE_BYTES): Promise<string> {
  const before = await regular(path, max)
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw failure('FILE_CHANGED', '备份文件已变化，请重新选择')
    const digest = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let offset = 0
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset)
      if (!bytesRead) throw failure('FILE_CHANGED', '备份文件读取不完整')
      digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    const after = await handle.stat()
    if ((await handle.read(buffer, 0, 1, offset)).bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw failure('FILE_CHANGED', '备份文件已变化，请重新选择')
    return digest.digest('hex')
  } finally { await handle.close() }
}

function locations(root: string, id: string): { transaction: string; staged: string; backup: string; pending: string; live: string } {
  if (!UUID.test(id)) throw failure('INVALID_PLAN', '待导入计划无效')
  const transaction = join(root, 'data-imports', id)
  return { transaction, staged: join(transaction, 'prepared.sqlite3'), backup: join(root, 'data-import-backups', `before-import-${id}`),
    pending: join(root, 'pending-data-import.json'), live: join(root, 'steam-friend-commenter.sqlite3') }
}

async function readPlan(root: string): Promise<ImportPlan | null> {
  const path = join(root, 'pending-data-import.json')
  try { await regular(path, 8192) } catch (error) { if (errno(error) === 'ENOENT') return null; throw error }
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    const item = value as Partial<ImportPlan> | null
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'id,sha256,summary,version' || item.version !== 1 ||
        typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) ||
        !item.summary || Object.keys(item.summary).sort().join(',') !== 'accounts,deliveries,friends,groups,tasks' ||
        Object.values(item.summary).some(count => !Number.isSafeInteger(count) || count < 0 || count > 2_000_000)) throw new Error()
    return item as ImportPlan
  } catch { throw failure('INVALID_PLAN', '待导入计划损坏，已停止自动导入并保留现有数据') }
}

async function snapshotSource(source: string, destination: string): Promise<string> {
  const metadata = await regular(source)
  if (metadata.size < 100) throw failure('INVALID', '请选择本工具导出的完整 SQLite 备份')
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output: Awaited<ReturnType<typeof fs.open>> | undefined
  let complete = false
  try {
    output = await fs.open(destination, 'wx', 0o600)
    const opened = await input.stat()
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size || opened.mtimeMs !== metadata.mtimeMs) throw failure('FILE_CHANGED', '备份文件已变化，请重新选择')
    const digest = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let offset = 0
    while (offset < opened.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset)
      if (!bytesRead) throw failure('FILE_CHANGED', '备份文件读取不完整')
      if (offset === 0 && buffer.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') throw failure('INVALID', '请选择本工具导出的 SQLite 数据备份')
      digest.update(buffer.subarray(0, bytesRead)); await output.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    const after = await input.stat(), current = await fs.lstat(source)
    if ((await input.read(buffer, 0, 1, offset)).bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw failure('FILE_CHANGED', '备份文件已变化，请重新选择')
    await output.sync(); complete = true
    return digest.digest('hex')
  } finally {
    const created = await output?.stat().catch(() => null)
    await input.close(); await output?.close()
    if (!complete && created) {
      try { const current = await fs.lstat(destination); if (current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) await fs.unlink(destination) } catch {}
    }
  }
}

async function removeMatching(path: string, expected: string): Promise<void> {
  try {
    const before = await regular(path)
    if (await digestFile(path) !== expected) return
    const after = await fs.lstat(path)
    if (after.isFile() && !after.isSymbolicLink() && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs) await fs.unlink(path)
  } catch (error) { if (errno(error) !== 'ENOENT') throw error }
}

export async function prepareDataImport(sourcePath: string, userDataDir: string): Promise<PreparedDataImport> {
  const root = await directory(userDataDir)
  if (await readPlan(root)) throw failure('PENDING', '已有待导入的数据计划，请先重新启动工具箱')
  const source = resolve(sourcePath)
  await regular(source)
  const sourceIdentity = await fs.lstat(source, { bigint: true })
  if (!sourceIdentity.isFile() || sourceIdentity.isSymbolicLink()) throw failure('UNSAFE_PATH', '备份文件类型无效')
  const live = join(root, 'steam-friend-commenter.sqlite3')
  if ([live, `${live}-wal`, `${live}-shm`, `${live}-journal`].some(path => resolve(path).toLowerCase() === source.toLowerCase())) throw failure('LIVE_DATABASE', '不能选择当前正在使用的数据库，请使用设置导出的备份')
  try { const active = await fs.lstat(live, { bigint: true }); if (sameDataImportFileIdentity(active, sourceIdentity)) throw failure('LIVE_DATABASE', '不能导入当前正在使用的数据库') }
  catch (error) { if (errno(error) !== 'ENOENT') throw error }
  await directory(join(root, 'data-imports'), true)
  const id = randomUUID(), paths = locations(root, id)
  await fs.mkdir(paths.transaction, { mode: 0o700 })
  await directory(paths.transaction)
  const snapshot = join(paths.transaction, 'source.sqlite3')
  let snapshotHash: string | undefined, stagedHash: string | undefined
  try {
    snapshotHash = await snapshotSource(source, snapshot)
    const summary = SqliteStore.createImportedDatabase(snapshot, paths.staged)
    SqliteStore.validatePreparedImportDatabase(paths.staged)
    stagedHash = await digestFile(paths.staged)
    const prepared: PreparedDataImport = Object.freeze({ id, stagedPath: paths.staged, sha256: stagedHash,
      summary: Object.freeze({ ...summary }), backupPath: paths.backup })
    owned.add(prepared)
    return prepared
  } catch (error) {
    if (stagedHash) await removeMatching(paths.staged, stagedHash).catch(() => {})
    if (error instanceof DomainError) throw error
    throw failure('INVALID', '无法读取或校验数据备份，现有数据未修改')
  } finally { if (snapshotHash) await removeMatching(snapshot, snapshotHash).catch(() => {}) }
}

export async function queueDataImport(prepared: PreparedDataImport, userDataDir: string): Promise<void> {
  const root = await directory(userDataDir)
  if (!prepared || !owned.has(prepared)) throw failure('INVALID_PLAN', '数据导入准备信息无效，请重新选择备份')
  const paths = locations(root, prepared.id)
  await directory(paths.transaction)
  if (resolve(prepared.stagedPath).toLowerCase() !== paths.staged.toLowerCase() || prepared.backupPath.toLowerCase() !== paths.backup.toLowerCase() || await digestFile(paths.staged) !== prepared.sha256) throw failure('FILE_CHANGED', '已准备的数据备份发生变化，未安排导入')
  SqliteStore.validatePreparedImportDatabase(paths.staged)
  const temporary = join(root, `.pending-data-import-${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  let identity: Awaited<ReturnType<typeof handle.stat>> | undefined
  try {
    await handle.writeFile(JSON.stringify({ version: 1, id: prepared.id, sha256: prepared.sha256, summary: prepared.summary } satisfies ImportPlan))
    await handle.sync()
    identity = await handle.stat()
    await directory(root)
    try { await fs.link(temporary, paths.pending) }
    catch (error) { if (errno(error) === 'EEXIST') throw failure('PENDING', '已有待导入计划，请先重新启动工具箱'); throw error }
  } finally {
    identity ??= await handle.stat().catch(() => undefined)
    await handle.close()
    if (identity) {
      try {
        await directory(root)
        const current = await fs.lstat(temporary)
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino &&
            current.size === identity.size && current.mtimeMs === identity.mtimeMs) await fs.unlink(temporary)
      } catch {}
    }
  }
}

export async function discardPreparedDataImport(prepared: PreparedDataImport, userDataDir: string): Promise<void> {
  const root = await directory(userDataDir)
  if (!prepared || !owned.has(prepared)) return
  const pending = await readPlan(root)
  if (pending?.id === prepared.id) return
  const paths = locations(root, prepared.id)
  await directory(paths.transaction)
  if (paths.staged.toLowerCase() !== prepared.stagedPath.toLowerCase()) throw failure('INVALID_PLAN', '数据导入准备信息无效')
  await removeMatching(paths.staged, prepared.sha256)
  owned.delete(prepared)
  try { if ((await fs.readdir(paths.transaction)).length === 0) await fs.rmdir(paths.transaction) } catch {}
}

async function backupCurrentDatabase(root: string, backupDirectory: string, livePath: string): Promise<string | null> {
  let metadata: Awaited<ReturnType<typeof fs.lstat>>
  try { metadata = await regular(livePath, Number.MAX_SAFE_INTEGER) } catch (error) { if (errno(error) === 'ENOENT') return null; throw error }
  await directory(backupDirectory, true)
  const target = join(backupDirectory, `original-${randomUUID()}.sqlite3`)
  const database = new DatabaseSync(livePath, { allowExtension: false })
  try {
    database.exec('PRAGMA busy_timeout = 1000;')
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (Number(checkpoint?.busy ?? 0) !== 0) throw failure('BUSY', '原数据库仍被占用，未替换数据，请关闭其它数据库工具后重试')
    const dataVersion = database.prepare('PRAGMA data_version').get()?.data_version
    await backup(database, target)
    const saved = new DatabaseSync(target, { allowExtension: false })
    try {
      saved.exec('PRAGMA journal_mode = DELETE;')
      if (saved.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw failure('BACKUP_FAILED', '无法确认原数据库备份完整，未替换数据')
    } finally { saved.close() }
    if (database.prepare('PRAGMA data_version').get()?.data_version !== dataVersion) throw failure('FILE_CHANGED', '备份期间原数据库发生变化，已停止导入')
  } catch (error) { if (error instanceof DomainError) throw error; throw failure('BACKUP_FAILED', '原数据库备份失败，未替换数据') }
  finally { database.close() }
  const current = await regular(livePath, Number.MAX_SAFE_INTEGER)
  if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw failure('FILE_CHANGED', '原数据库被外部替换，已停止导入')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await fs.lstat(`${livePath}${suffix}`)
      throw failure('BUSY', '原数据库仍有未关闭的日志，未替换数据')
    } catch (error) { if (errno(error) !== 'ENOENT') throw error }
  }
  await directory(root)
  return digestFile(livePath, Number.MAX_SAFE_INTEGER)
}

export async function applyPendingDataImport(userDataDir: string): Promise<{ backupPath: string } | null> {
  const root = await directory(userDataDir)
  const plan = await readPlan(root)
  if (!plan) return null
  const paths = locations(root, plan.id)
  await directory(paths.transaction)
  let stagedExists = true
  try { await regular(paths.staged) } catch (error) { if (errno(error) === 'ENOENT') stagedExists = false; else throw error }
  if (!stagedExists) {
    try {
      if (await digestFile(paths.live) !== plan.sha256) throw new Error()
      SqliteStore.validatePreparedImportDatabase(paths.live)
      await fs.unlink(paths.pending)
      return { backupPath: paths.backup }
    } catch { throw failure('APPLY_UNCONFIRMED', '无法确认上次导入是否完成，已停止打开数据库；请保留待导入计划、当前数据库和备份') }
  }
  if (await digestFile(paths.staged) !== plan.sha256) throw failure('FILE_CHANGED', '待导入数据库发生变化，原数据未替换')
  SqliteStore.validatePreparedImportDatabase(paths.staged)
  const previousHash = await backupCurrentDatabase(root, paths.backup, paths.live)
  await directory(paths.transaction)
  if (await digestFile(paths.staged) !== plan.sha256) throw failure('FILE_CHANGED', '待导入数据库发生变化，原数据未替换')
  if (previousHash === null) {
    try { await fs.lstat(paths.live); throw failure('FILE_CHANGED', '出现新的本机数据库，已停止导入以免覆盖') }
    catch (error) { if (errno(error) !== 'ENOENT') throw error }
  } else if (await digestFile(paths.live, Number.MAX_SAFE_INTEGER) !== previousHash) throw failure('FILE_CHANGED', '原数据库在备份后发生变化，已停止导入')
  try { await fs.rename(paths.staged, paths.live) }
  catch { throw failure('REPLACE_FAILED', '无法原子替换数据库，原数据库及备份已保留') }
  try { await fs.unlink(paths.pending) }
  catch { throw failure('APPLY_UNCONFIRMED', '数据库已替换但导入计划未能清理，已停止打开数据库，避免重复覆盖；请保留备份后重试') }
  return { backupPath: paths.backup }
}
