import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, link, symlink, rm, copyFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'
import { applyPendingDataImport, discardPreparedDataImport, prepareDataImport, queueDataImport, sameDataImportFileIdentity } from '../src/main/data-import'
import type { AccountRecord, FriendRecord } from '../src/shared/types'

const roots: string[] = []
const A = '76561198000000001', B = '76561198000000002', F = '76561198000000003'
const NOW = '2026-10-28T00:00:00.000Z'
const cipher: SecretCipher = { isAvailable: () => true, backend: () => 'fixture', encrypt: value => Buffer.from(`fixture:${value}`), decrypt: value => value.toString().replace(/^fixture:/, '') }
const account = (id: string, name: string): AccountRecord => ({ id, steamId: id, accountName: `fixture_${id}`, displayName: name,
  avatarUrl: '', createdAt: NOW, lastLoginAt: null, lastFriendSyncAt: null, lastEmoticonSyncAt: null })
const friend = (id: string, name = 'Friend.'): FriendRecord => ({ accountId: id, steamId: F, displayName: name, avatarUrl: '',
  profileUrl: `https://steamcommunity.com/profiles/${F}/`, onlineState: 'offline', groupIds: [], syncedAt: NOW })
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('toolbox-data-import-')) throw new Error('Invalid fixture cleanup boundary')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(resolve(tmpdir()), 'toolbox-data-import-')); roots.push(root)
  const userData = join(root, 'user-data'); await mkdir(userData)
  const source = join(root, 'export.sqlite3'), originalSource = join(root, 'original.sqlite3')
  const store = new SqliteStore(originalSource, cipher)
  store.upsertAccount(account(A, 'Imported A.'), 'source-private-token')
  store.upsertAccount(account(B, 'Imported B'), 'source-private-token-b')
  store.replaceFriends(A, [friend(A)])
  store.replaceFriends(A, [friend(A, 'Renamed friend.')])
  store.replaceFriends(A, [])
  store.replaceFriends(A, [friend(A, 'Renamed friend.')])
  store.replaceFriends(B, [friend(B)])
  const groupA = store.createGroup(A, 'A group.', '#112233'), groupB = store.createGroup(B, 'B group', '#445566')
  store.setFriendGroups(A, [F], [groupA.id]); store.setFriendGroups(B, [F], [groupB.id])
  store.setBlacklist(A, [F], true)
  store.updateSettings(A, 'A private draft.', 100)
  store.setLanguage('en'); store.setTheme('dark')
  const batch = store.createBatch(A, 'hello.', 100, [{ friendSteamId: F, friendName: 'Friend.', renderedMessage: 'hello.' }])
  store.setBatchAutoRetry(batch.id, true); store.setBatchRunning(batch.id); store.takeNextDelivery(batch.id)
  const scan = store.createCommentScan(B, [F], 100); store.setCommentScanRunning(scan.id); store.takeNextCommentScanItem(scan.id)
  await store.exportDatabase(source)
  store.close()
  const livePath = join(userData, 'steam-friend-commenter.sqlite3')
  const live = new SqliteStore(livePath, cipher)
  live.upsertAccount(account('76561198000000004', 'Original local account'), 'original-private-token')
  live.close()
  return { root, userData, source, originalSource, livePath, batchId: batch.id, scanId: scan.id, groupA, groupB }
}

function edit(path: string, sql: string): void {
  const db = new DatabaseSync(path)
  try { db.exec(sql) } finally { db.close() }
}

describe('validated data import staging', () => {
  it.each(['file:///D:/unrelated-photo.png', 'javascript:alert(1)', 'https://user:password@example.invalid/avatar.png'])('rejects unsafe imported resource URLs without reading them %s', async avatar => {
    const f = await fixture()
    const db = new DatabaseSync(f.source)
    db.prepare('UPDATE accounts SET avatar_url = ?').run(avatar)
    db.close()
    const original = digest(await readFile(f.livePath))
    await expect(prepareDataImport(f.source, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID' })
    expect(digest(await readFile(f.livePath))).toBe(original)
  })
  it('distinguishes adjacent 64-bit file IDs that would collide as JavaScript Numbers', () => {
    const source = { dev: 1n, ino: 0x20000000000000n }
    const unrelated = { dev: 1n, ino: source.ino + 1n }
    expect(Number(source.ino)).toBe(Number(unrelated.ino))
    expect(sameDataImportFileIdentity(source, unrelated)).toBe(false)
    expect(sameDataImportFileIdentity(source, { ...source })).toBe(true)
    expect(sameDataImportFileIdentity(source, { dev: 2n, ino: source.ino })).toBe(false)
  })

  it('round-trips an exported multi-account database into trusted schema without changing source or live data', async () => {
    const f = await fixture(), sourceBefore = digest(await readFile(f.source)), liveBefore = digest(await readFile(f.livePath))
    const prepared = await prepareDataImport(f.source, f.userData)
    expect(prepared.summary).toEqual({ accounts: 2, friends: 2, groups: 2, tasks: 1, deliveries: 1 })
    expect(digest(await readFile(f.source))).toBe(sourceBefore)
    expect(digest(await readFile(f.livePath))).toBe(liveBefore)
    expect(prepared.stagedPath.startsWith(join(f.userData, 'data-imports'))).toBe(true)
    expect((await readdir(dirname(prepared.stagedPath))).sort()).toEqual(['prepared.sqlite3'])
    const imported = new SqliteStore(prepared.stagedPath, cipher)
    try {
      expect(imported.getAccounts()).toHaveLength(2)
      expect(imported.getAccount(A)?.displayName).toBe('Imported A.')
      expect(imported.getFriends(A)[0]?.groupIds).toEqual([f.groupA.id])
      expect(imported.getFriends(B)[0]?.groupIds).toEqual([f.groupB.id])
      expect(imported.isBlacklisted(A, F)).toBe(true)
      expect(imported.isBlacklisted(B, F)).toBe(false)
      expect(imported.getFriendNameChanges(A).length).toBeGreaterThan(0)
      expect(imported.getFriendRemovals(A).length).toBeGreaterThan(0)
      expect(imported.getSettings(A).draft).toBe('A private draft.')
      expect(imported.getTheme()).toBe('dark')
      expect(imported.getLanguage()).toBe('en')
      expect(imported.getRefreshToken(A)).toBeNull()
      expect(imported.getBatch(f.batchId)).toMatchObject({ status: 'paused', autoRetryEnabled: false, nextRetryAt: null })
      expect(imported.getBatch(f.batchId)?.deliveries[0]?.status).toBe('uncertain')
      expect(imported.getCommentScan(f.scanId)?.status).toBe('paused')
    } finally { imported.close() }
  })

  it('does not import secret records even from a compatible raw standalone database', async () => {
    const f = await fixture()
    edit(f.originalSource, 'PRAGMA journal_mode = DELETE;')
    const before = digest(await readFile(f.originalSource))
    const prepared = await prepareDataImport(f.originalSource, f.userData)
    const db = new DatabaseSync(prepared.stagedPath, { readOnly: true })
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get()?.n).toBe(0) }
    finally { db.close() }
    expect(digest(await readFile(f.originalSource))).toBe(before)
    expect((await readFile(prepared.stagedPath)).includes(Buffer.from('source-private-token'))).toBe(false)
  })

  it.each([
    'PRAGMA user_version = 10;',
    'PRAGMA user_version = 8;',
    'CREATE TABLE unrelated (value TEXT);',
    'CREATE VIEW unsafe_view AS SELECT * FROM accounts;',
    'CREATE TRIGGER unsafe_trigger AFTER UPDATE ON friends BEGIN DELETE FROM accounts; END;',
    'ALTER TABLE accounts ADD COLUMN surprise TEXT;',
    'ALTER TABLE friends ADD COLUMN derived TEXT GENERATED ALWAYS AS (display_name) VIRTUAL;',
    "UPDATE batches SET failure_policy = 'invalid json';",
    "UPDATE batches SET status = 'invalid-status';",
    "PRAGMA foreign_keys = OFF; UPDATE friends SET steam_id = 'invalid-id';"
  ])('rejects incompatible or executable source schema/data without touching live data: %s', async sql => {
    const f = await fixture(), before = digest(await readFile(f.livePath))
    edit(f.source, sql)
    await expect(prepareDataImport(f.source, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID' })
    expect(digest(await readFile(f.livePath))).toBe(before)
    for (const id of await readdir(join(f.userData, 'data-imports'))) {
      expect(await readdir(join(f.userData, 'data-imports', id))).toEqual([])
    }
  })

  it('rejects an arbitrary or malformed SQLite file and a non-database file', async () => {
    const f = await fixture()
    const arbitrary = join(f.root, 'arbitrary.sqlite3')
    const db = new DatabaseSync(arbitrary); db.exec('CREATE TABLE settings (x TEXT); PRAGMA user_version = 9'); db.close()
    await expect(prepareDataImport(arbitrary, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID' })
    await writeFile(arbitrary, Buffer.alloc(200, 65))
    await expect(prepareDataImport(arbitrary, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID' })
  })

  it('rejects a live database path and a hardlink to the same live file', async () => {
    const f = await fixture()
    await expect(prepareDataImport(f.livePath, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_LIVE_DATABASE' })
    const alias = join(f.root, 'alias.sqlite3'); await link(f.livePath, alias)
    await expect(prepareDataImport(alias, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_LIVE_DATABASE' })
  })

  it('still rejects imported backups larger than 256 MiB', async () => {
    const f = await fixture(), before = digest(await readFile(f.livePath))
    await truncate(f.source, 256 * 1024 * 1024 + 4096)
    await expect(prepareDataImport(f.source, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_UNSAFE_PATH' })
    expect(digest(await readFile(f.livePath))).toBe(before)
  })

  it('rejects redirected source files and staging directories', async () => {
    const f = await fixture(), alias = join(f.root, 'alias.sqlite3')
    try { await symlink(f.source, alias, 'file') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error }
    await expect(prepareDataImport(alias, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_UNSAFE_PATH' })
    const outside = join(f.root, 'outside'); await mkdir(outside)
    await symlink(outside, join(f.userData, 'data-imports'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareDataImport(f.source, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_UNSAFE_PATH' })
    expect(await readdir(outside)).toEqual([])
  })
})

describe('queued import application and cancellation', () => {
  it('backs up and replaces an existing database larger than the import limit', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await truncate(f.livePath, 256 * 1024 * 1024 + 4096)
    const oversized = new DatabaseSync(f.livePath, { readOnly: true })
    try { expect(oversized.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok') }
    finally { oversized.close() }
    expect((await lstat(f.livePath)).size).toBeGreaterThan(256 * 1024 * 1024)
    await queueDataImport(prepared, f.userData)
    expect(await applyPendingDataImport(f.userData)).toEqual({ backupPath: prepared.backupPath })
    const backups = (await readdir(prepared.backupPath)).filter(name => name.endsWith('.sqlite3'))
    expect(backups).toHaveLength(1)
    const previous = new SqliteStore(join(prepared.backupPath, backups[0]!), cipher)
    try {
      expect(previous.getAccounts()[0]?.displayName).toBe('Original local account')
      expect(previous.getRefreshToken('76561198000000004')).toBe('original-private-token')
    } finally { previous.close() }
    const imported = new SqliteStore(f.livePath, cipher)
    try { expect(imported.getAccounts()).toHaveLength(2); expect(imported.getRefreshToken(A)).toBeNull() }
    finally { imported.close() }
    expect(await applyPendingDataImport(f.userData)).toBeNull()
  }, 30_000)

  it('backs up the original database including its local encrypted secret and atomically replaces on startup', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await queueDataImport(prepared, f.userData)
    const result = await applyPendingDataImport(f.userData)
    expect(result?.backupPath).toBe(prepared.backupPath)
    const backups = (await readdir(prepared.backupPath)).filter(name => name.endsWith('.sqlite3'))
    expect(backups).toHaveLength(1)
    const previous = new SqliteStore(join(prepared.backupPath, backups[0]!), cipher)
    try { expect(previous.getAccounts()[0]?.displayName).toBe('Original local account'); expect(previous.getRefreshToken('76561198000000004')).toBe('original-private-token') }
    finally { previous.close() }
    const imported = new SqliteStore(f.livePath, cipher)
    try { expect(imported.getAccounts()).toHaveLength(2); expect(imported.getRefreshToken(A)).toBeNull() }
    finally { imported.close() }
    expect(await applyPendingDataImport(f.userData)).toBeNull()
  })

  it('cancels only the exact prepared file and leaves live/source databases intact', async () => {
    const f = await fixture(), before = digest(await readFile(f.livePath)), prepared = await prepareDataImport(f.source, f.userData)
    await discardPreparedDataImport(prepared, f.userData)
    await expect(lstat(prepared.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(digest(await readFile(f.livePath))).toBe(before)
    expect((await lstat(f.source)).isFile()).toBe(true)
  })

  it('does not remove a changed prepared file on cancellation and rejects it for queueing', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await writeFile(prepared.stagedPath, 'replacement file')
    await expect(queueDataImport(prepared, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_FILE_CHANGED' })
    await discardPreparedDataImport(prepared, f.userData)
    expect(await readFile(prepared.stagedPath, 'utf8')).toBe('replacement file')
  })

  it('does not accept forged prepared descriptors or remove a queued import on cancellation', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await expect(queueDataImport({ ...prepared }, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID_PLAN' })
    await queueDataImport(prepared, f.userData)
    await discardPreparedDataImport(prepared, f.userData)
    expect((await lstat(prepared.stagedPath)).isFile()).toBe(true)
    await expect(prepareDataImport(f.source, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_PENDING' })
    await expect(queueDataImport(prepared, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_PENDING' })
    expect((await readdir(f.userData)).filter(name => name.startsWith('.pending-data-import-'))).toEqual([])
  })

  it('ignores an unpublished partial plan and publishes only a complete synced plan', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    const abandoned = join(f.userData, '.pending-data-import-fixture.tmp')
    await writeFile(abandoned, '{')
    expect(await applyPendingDataImport(f.userData)).toBeNull()
    await queueDataImport(prepared, f.userData)
    const plan = JSON.parse(await readFile(join(f.userData, 'pending-data-import.json'), 'utf8'))
    expect(plan).toMatchObject({ version: 1, id: prepared.id, sha256: prepared.sha256, summary: prepared.summary })
    expect(await readFile(abandoned, 'utf8')).toBe('{')
    expect((await readdir(f.userData)).filter(name => name.startsWith('.pending-data-import-'))).toEqual(['.pending-data-import-fixture.tmp'])
  })

  it('never replaces an existing pending path when atomic publication cannot claim it', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    const pending = join(f.userData, 'pending-data-import.json')
    await mkdir(pending)
    await expect(queueDataImport(prepared, f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_PENDING' })
    expect((await lstat(pending)).isDirectory()).toBe(true)
    expect(await readdir(pending)).toEqual([])
    expect((await readdir(f.userData)).filter(name => name.startsWith('.pending-data-import-'))).toEqual([])
  })

  it('does not overwrite an existing destination when rebuilding a database', async () => {
    const f = await fixture(), destination = join(f.root, 'keep.sqlite3')
    await writeFile(destination, 'keep user file')
    expect(() => SqliteStore.createImportedDatabase(f.source, destination)).toThrow()
    expect(await readFile(destination, 'utf8')).toBe('keep user file')
  })

  it('preserves data if the backup namespace is redirected outside the application data directory', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData), before = digest(await readFile(f.livePath))
    await queueDataImport(prepared, f.userData)
    const outside = join(f.root, 'backup-outside'); await mkdir(outside)
    await symlink(outside, join(f.userData, 'data-import-backups'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(applyPendingDataImport(f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_UNSAFE_PATH' })
    expect(digest(await readFile(f.livePath))).toBe(before)
    expect(await readdir(outside)).toEqual([])
  })

  it('refuses tampered plans or stage data without replacing the active database', async () => {
    const f = await fixture(), before = digest(await readFile(f.livePath)), prepared = await prepareDataImport(f.source, f.userData)
    await queueDataImport(prepared, f.userData)
    await writeFile(prepared.stagedPath, 'changed data')
    await expect(applyPendingDataImport(f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_FILE_CHANGED' })
    expect(digest(await readFile(f.livePath))).toBe(before)
    await writeFile(join(f.userData, 'pending-data-import.json'), JSON.stringify({ version: 1, id: '../escape', sha256: prepared.sha256, summary: prepared.summary }))
    await expect(applyPendingDataImport(f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_INVALID_PLAN' })
    expect(digest(await readFile(f.livePath))).toBe(before)
  })

  it('recognizes an already committed import after plan-cleanup interruption without replacing again', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await queueDataImport(prepared, f.userData)
    const plan = await readFile(join(f.userData, 'pending-data-import.json'))
    await applyPendingDataImport(f.userData)
    const applied = digest(await readFile(f.livePath))
    await writeFile(join(f.userData, 'pending-data-import.json'), plan)
    expect(await applyPendingDataImport(f.userData)).toEqual({ backupPath: prepared.backupPath })
    expect(digest(await readFile(f.livePath))).toBe(applied)
    expect(await applyPendingDataImport(f.userData)).toBeNull()
  })

  it('fails closed if a missing stage cannot be proven to be the current applied database', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await queueDataImport(prepared, f.userData)
    await rm(prepared.stagedPath)
    await expect(applyPendingDataImport(f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_APPLY_UNCONFIRMED' })
    const original = new SqliteStore(f.livePath, cipher)
    try { expect(original.getAccounts()).toHaveLength(1) } finally { original.close() }
  })

  it('does not overwrite a live database while an external SQLite WAL reader is still present', async () => {
    const f = await fixture(), prepared = await prepareDataImport(f.source, f.userData)
    await queueDataImport(prepared, f.userData)
    const external = new DatabaseSync(f.livePath)
    external.exec('PRAGMA journal_mode=WAL; BEGIN;')
    external.prepare('SELECT COUNT(*) FROM accounts').get()
    try { await expect(applyPendingDataImport(f.userData)).rejects.toMatchObject({ code: 'DATA_IMPORT_BUSY' }) }
    finally { external.exec('ROLLBACK;'); external.close() }
    const original = new SqliteStore(f.livePath, cipher)
    try { expect(original.getAccounts()).toHaveLength(1) } finally { original.close() }
  })
})

describe('stored visual preference', () => {
  it('defaults unknown themes to light and rejects unsupported writes', async () => {
    const f = await fixture(), store = new SqliteStore(f.livePath, cipher)
    try {
      expect(store.getTheme()).toBe('light')
      expect(() => store.setTheme('system' as 'dark')).toThrow()
      store.setTheme('dark'); expect(store.getTheme()).toBe('dark')
    } finally { store.close() }
  })
})
