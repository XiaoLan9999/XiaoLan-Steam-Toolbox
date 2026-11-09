import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { renameSync, mkdirSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePackageKind } from '../src/shared/update-types'

const hooks = vi.hoisted(() => ({
  afterLstat: undefined as undefined | ((path: string) => void | Promise<void>),
  beforeOpen: undefined as undefined | ((path: string, flags: string | number) => void | Promise<void>),
  afterOpen: undefined as undefined | ((path: string) => void | Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => void | Promise<void>),
  opens: [] as Array<{ path: string; flags: string | number; handle: FileHandle }>,
  renames: [] as Array<[string, string]>,
  aliases: new Map<string, string>()
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    lstat: async (...args: any[]) => {
      const requested = String(args[0])
      if (hooks.aliases.has(requested)) args[0] = hooks.aliases.get(requested)
      const result = await (actual.lstat as (...values: any[]) => Promise<unknown>)(...args)
      await hooks.afterLstat?.(requested)
      return result
    },
    realpath: (path: string) => actual.realpath(hooks.aliases.get(String(path)) ?? path),
    open: async (path: string, flags: string | number, mode?: number) => {
      await hooks.beforeOpen?.(String(path), flags)
      const handle = await actual.open(path, flags, mode)
      hooks.opens.push({ path: String(path), flags, handle })
      await hooks.afterOpen?.(String(path))
      return handle
    },
    rename: async (from: string, to: string) => {
      await actual.rename(from, to)
      hooks.renames.push([from, to])
      await hooks.afterRename?.(from, to)
    }
  }
})

import { confirmUpdateStartup, type ConfirmUpdateStartupOptions } from '../src/main/update-startup'

const VERSION = '0.16.18'
const ID = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const executable = (label: string): Buffer => Buffer.from(`MZ-synthetic-${label}-not-an-executable`)
const directories: string[] = []

beforeEach(() => {
  hooks.afterLstat = undefined; hooks.beforeOpen = undefined; hooks.afterOpen = undefined; hooks.afterRename = undefined
  hooks.opens.length = 0; hooks.renames.length = 0
  hooks.aliases.clear()
})
afterEach(async () => {
  hooks.afterLstat = undefined; hooks.beforeOpen = undefined; hooks.afterOpen = undefined; hooks.afterRename = undefined
  hooks.aliases.clear()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== await realpath(tmpdir()) || !basename(directory).startsWith('xiaolan-update-startup-test-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe update-startup fixture cleanup')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function fixture(kind: UpdatePackageKind = 'portable', cacheTarget = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xiaolan-update-startup-test-')))
  directories.push(directory)
  const cache = join(directory, 'update-cache'), installer = join(cache, 'installer')
  const targetDirectory = cacheTarget ? join(cache, 'v0.16.17') : join(directory, "user's installed toolbox")
  const sourceDirectory = join(cache, `v${VERSION}`)
  await mkdir(installer, { recursive: true }); await mkdir(targetDirectory, { recursive: true }); await mkdir(sourceDirectory, { recursive: true })
  const target = join(targetDirectory, "renamed user's toolbox.exe")
  const source = join(sourceDirectory, kind === 'portable' ? 'fixture portable.exe' : 'fixture setup.exe')
  const backup = join(targetDirectory, `renamed user's toolbox.previous-${ID.replaceAll('-', '')}.exe`)
  const oldBytes = executable('old'), sourceBytes = executable(kind === 'portable' ? 'new-portable' : 'new-installer')
  const targetBytes = kind === 'portable' ? sourceBytes : executable('new-installed-app')
  await writeFile(target, targetBytes); await writeFile(source, sourceBytes)
  if (kind === 'portable') await writeFile(backup, oldBytes)
  const receipt = join(installer, `${ID}.transaction.json`), acknowledgment = join(installer, `${ID}.healthy.json`)
  const record = { schema: 1, id: ID, kind, version: VERSION, source, expectedHash: digest(sourceBytes), expectedSize: sourceBytes.length,
    target, originalHash: digest(oldBytes), backup: kind === 'portable' ? backup : null, phase: kind === 'portable' ? 'replaced' : 'setup-started' }
  await writeFile(receipt, JSON.stringify(record))
  const options: ConfirmUpdateStartupOptions = { cacheDirectory: cache, currentVersion: VERSION, packageKind: kind, currentExecutable: target, transactionId: ID }
  return { directory, cache, installer, target, source, backup, receipt, acknowledgment, oldBytes, sourceBytes, targetBytes, record, options,
    save: (patch: Record<string, unknown> = {}) => writeFile(receipt, JSON.stringify({ ...record, ...patch })),
    confirm: (patch: Partial<ConfirmUpdateStartupOptions> = {}) => confirmUpdateStartup({ ...options, ...patch }) }
}

async function absent(path: string): Promise<void> { await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }) }
async function unchanged(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  expect(await readFile(f.source)).toEqual(f.sourceBytes)
  expect(await readFile(f.target)).toEqual(f.targetBytes)
  if (f.record.kind === 'portable') expect(await readFile(f.backup)).toEqual(f.oldBytes)
}

function nativeShortPaths(paths: string[]): Array<string | null> {
  const encoded = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnTempShortPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern uint GetShortPathNameW(string path, StringBuilder output, uint capacity);
  public static string Read(string path) {
    StringBuilder output=new StringBuilder(32768);
    uint count=GetShortPathNameW(path,output,(uint)output.Capacity);
    return count==0 || count>=output.Capacity ? null : output.ToString();
  }
}
'@
$paths=@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))
$result=@(foreach($path in $paths){[OwnTempShortPath]::Read([string]$path)})
ConvertTo-Json -Compress -InputObject $result`
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 })
  return JSON.parse(output.trim().replace(/^\uFEFF/, '')) as Array<string | null>
}

function fixtureAliases(f: Awaited<ReturnType<typeof fixture>>) {
  const cache = join(f.directory, 'UPDATE~1'), installed = join(f.directory, 'INSTAL~1'), target = join(installed, 'RENAME~1.EXE')
  hooks.aliases.set(cache, f.cache); hooks.aliases.set(installed, dirname(f.target)); hooks.aliases.set(target, f.target)
  return { cache, target }
}

describe('healthy startup update acknowledgment without deleting or executing files', () => {
  it.each(['portable', 'setup'] as const)('writes only the fixed %s acknowledgment after validating stable source and actual current target', async kind => {
    const f = await fixture(kind)
    expect(await f.confirm()).toEqual({ confirmed: true })
    expect(JSON.parse(await readFile(f.acknowledgment, 'utf8'))).toEqual({ schema: 1, id: ID, version: VERSION,
      kind, target: f.target, targetHash: digest(f.targetBytes) })
    expect(hooks.renames).toHaveLength(1)
    expect(hooks.renames[0]![0]).toMatch(/\.healthy\.json\.[a-f0-9-]+\.tmp$/)
    expect(hooks.renames[0]![1]).toBe(f.acknowledgment)
    expect(hooks.opens.filter(value => value.flags === 'wx')).toHaveLength(1)
    expect(hooks.opens.some(value => value.path === f.backup)).toBe(false)
    await unchanged(f)
    for (const opened of hooks.opens) await expect(opened.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('allows a portable target still in an old cache version while permanently leaving that target untouched', async () => {
    const f = await fixture('portable', true)
    expect(f.target).toContain('v0.16.17')
    expect(f.source).toContain(`v${VERSION}`)
    expect(await f.confirm()).toEqual({ confirmed: true })
    await unchanged(f)
    expect((await readdir(dirname(f.target))).sort()).toEqual([basename(f.backup), basename(f.target)].sort())
  })

  it('accepts an equivalent UTF-8 BOM receipt but writes a minimal BOM-free fixed acknowledgment', async () => {
    const f = await fixture()
    await writeFile(f.receipt, `\uFEFF${JSON.stringify(f.record)}`)
    expect(await f.confirm()).toEqual({ confirmed: true })
    expect((await readFile(f.acknowledgment, 'utf8'))[0]).toBe('{')
  })

  it('does not guess historical portable transactions when no startup nonce is supplied', async () => {
    const f = await fixture()
    expect(await f.confirm({ transactionId: undefined })).toEqual({ confirmed: false })
    expect(hooks.opens).toHaveLength(0)
    await absent(f.acknowledgment); await unchanged(f)
  })

  it('can discover exactly one matching setup transaction without a startup nonce', async () => {
    const f = await fixture('setup')
    await writeFile(join(f.installer, `${secondId}.transaction.json`), JSON.stringify({ ...f.record, id: secondId, version: '0.16.17' }))
    expect(await f.confirm({ transactionId: undefined })).toEqual({ confirmed: true })
    expect(JSON.parse(await readFile(f.acknowledgment, 'utf8')).targetHash).toBe(digest(f.targetBytes))
    expect(digest(f.targetBytes)).not.toBe(f.record.expectedHash)
    await unchanged(f)
  })

  it('does not select a newest file when two setup receipts match the current version and target', async () => {
    const f = await fixture('setup')
    await writeFile(join(f.installer, `${secondId}.transaction.json`), JSON.stringify({ ...f.record, id: secondId }))
    expect(await f.confirm({ transactionId: undefined })).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await absent(join(f.installer, `${secondId}.healthy.json`))
  })

  it.each([32, 33])('bounds setup discovery at %i transaction files', async count => {
    const f = await fixture('setup')
    for (let index = 1; index < count; index++) {
      const id = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
      await writeFile(join(f.installer, `${id}.transaction.json`), JSON.stringify({ ...f.record, id, version: '0.16.17' }))
    }
    expect(await f.confirm({ transactionId: undefined })).toEqual({ confirmed: count === 32 })
    if (count === 33) await absent(f.acknowledgment)
  })

  it('is idempotent for an already matching healthy receipt and never replaces unrelated existing output', async () => {
    const f = await fixture()
    expect(await f.confirm()).toEqual({ confirmed: true })
    const before = await lstat(f.acknowledgment)
    expect(await f.confirm()).toEqual({ confirmed: true })
    expect((await lstat(f.acknowledgment)).ino).toBe(before.ino)
    expect(hooks.renames).toHaveLength(1)
    await writeFile(f.acknowledgment, JSON.stringify({ schema: 1, id: secondId }))
    expect(await f.confirm()).toEqual({ confirmed: false })
    expect(JSON.parse(await readFile(f.acknowledgment, 'utf8'))).toEqual({ schema: 1, id: secondId })
    await unchanged(f)
  })

  it.each([
    { transactionId: '../outside' }, { transactionId: ID.toUpperCase().replace('11111111', 'AAAAAAAA') },
    { transactionId: '00000000-0000-0000-0000-000000000000' }, { currentVersion: 'v0.16.18' },
    { currentVersion: '0.16.018' }, { currentVersion: '0.16.18-beta' }, { packageKind: 'unknown' },
    { cacheDirectory: 'relative/cache' }, { currentExecutable: 'relative/app.exe' },
    { currentExecutable: join(resolve(tmpdir()), 'app.exe:private.exe') }
  ])('quietly refuses invalid startup options %#', async patch => {
    const f = await fixture()
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await f.confirm(patch as Partial<ConfirmUpdateStartupOptions>)).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
    expect(output).not.toHaveBeenCalled()
  })

  it.each([
    { schema: 2 }, { id: secondId }, { kind: 'setup' }, { version: '0.16.17' }, { phase: 'prepared' },
    { phase: 'setup-started' }, { expectedHash: 'A'.repeat(64) }, { originalHash: '' },
    { expectedSize: 0 }, { expectedSize: 1.5 }, { expectedSize: 513 * 1024 * 1024 },
    { source: 'relative.exe' }, { target: 'relative.exe' }, { backup: null }, { extra: 'private payload' }
  ])('rejects malformed, stale or mismatched transaction metadata %#', async patch => {
    const f = await fixture()
    await f.save(patch)
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  it.each(['duplicate', 'nested', 'trailing', 'missing', 'invalid-utf8', 'oversized', 'non-json-whitespace'] as const)
  ('does not accept %s transaction JSON', async kind => {
    const f = await fixture()
    let bytes: string | Buffer = JSON.stringify(f.record)
    if (kind === 'duplicate') bytes = bytes.replace('"schema":1', '"schema":1,"schema":1')
    if (kind === 'nested') bytes = bytes.replace('"schema":1', '"schema":{"schema":1}')
    if (kind === 'trailing') bytes += ' synthetic-private-trailing-data'
    if (kind === 'missing') { const value = { ...f.record } as Partial<typeof f.record>; delete value.originalHash; bytes = JSON.stringify(value) }
    if (kind === 'invalid-utf8') bytes = Buffer.from([0xff, 0xfe, 0xff])
    if (kind === 'oversized') bytes = ' '.repeat(16 * 1024 + 1) + bytes
    if (kind === 'non-json-whitespace') bytes = `\u00a0${bytes}`
    await writeFile(f.receipt, bytes)
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
  })

  it('requires the exact current executable rather than another same-hash file', async () => {
    const f = await fixture()
    const other = join(f.directory, 'different current app.exe')
    await writeFile(other, f.targetBytes)
    expect(await f.confirm({ currentExecutable: other })).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  it.skipIf(process.platform !== 'win32')('preserves canonical receipt target spelling when Windows supplies a case-variant current executable', async () => {
    const f = await fixture()
    const currentExecutable = f.target.toUpperCase()
    expect(currentExecutable).not.toBe(f.record.target)
    expect(await f.confirm({ currentExecutable })).toEqual({ confirmed: true })
    expect(JSON.parse(await readFile(f.acknowledgment, 'utf8')).target).toBe(f.record.target)
    await unchanged(f)
  })

  it.each(['cache', 'target', 'both'] as const)('supports verified non-symlink filesystem %s aliases using actual file identities', async kind => {
    const f = await fixture()
    const aliases = fixtureAliases(f)
    expect(await f.confirm({ ...(kind !== 'target' ? { cacheDirectory: aliases.cache } : {}),
      ...(kind !== 'cache' ? { currentExecutable: aliases.target } : {}) })).toEqual({ confirmed: true })
    expect(JSON.parse(await readFile(f.acknowledgment, 'utf8')).target).toBe(f.record.target)
    await unchanged(f)
  })

  it('revalidates an original input alias even when its previously canonical target remains unchanged', async () => {
    const f = await fixture()
    const aliases = fixtureAliases(f)
    const other = join(dirname(f.target), 'other same bytes.exe')
    await writeFile(other, f.targetBytes)
    hooks.beforeOpen = (_path, flags) => { if (flags === 'wx') hooks.aliases.set(aliases.target, other) }
    expect(await f.confirm({ currentExecutable: aliases.target })).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
    expect(await readFile(other)).toEqual(f.targetBytes)
  })

  it('does not expand short aliases embedded in untrusted transaction paths', async () => {
    const f = await fixture()
    const aliases = fixtureAliases(f)
    await f.save({ target: aliases.target })
    expect(await f.confirm({ currentExecutable: aliases.target })).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  for (const kind of ['cache', 'target', 'both'] as const) {
    it.skipIf(process.platform !== 'win32')(`confirms real Windows GetShortPathName ${kind} inputs without changing canonical transaction metadata`, async context => {
      const f = await fixture()
      const [shortCache, shortTarget] = nativeShortPaths([f.cache, f.target])
      if (!shortCache || !shortTarget || kind !== 'target' && shortCache.toLowerCase() === f.cache.toLowerCase()
        || kind !== 'cache' && shortTarget.toLowerCase() === f.target.toLowerCase()) { context.skip('The fixture volume does not provide a distinct 8.3 alias'); return }
      expect(await f.confirm({ ...(kind !== 'target' ? { cacheDirectory: shortCache } : {}),
        ...(kind !== 'cache' ? { currentExecutable: shortTarget } : {}) })).toEqual({ confirmed: true })
      expect(JSON.parse(await readFile(f.acknowledgment, 'utf8')).target).toBe(f.record.target)
      await unchanged(f)
    })
  }

  it.skipIf(process.platform !== 'win32')('still rejects a junction used through a real Windows short input path', async context => {
    const f = await fixture()
    const junction = join(f.directory, 'junction alias to cache')
    await symlink(f.cache, junction, 'junction')
    const [short] = nativeShortPaths([junction])
    if (!short || short.toLowerCase() === junction.toLowerCase()) { context.skip('The fixture volume does not provide a distinct 8.3 alias'); return }
    expect(await f.confirm({ cacheDirectory: short })).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  it.skipIf(process.platform !== 'win32')('rejects a replaced real Windows short-path input object', async context => {
    const f = await fixture()
    const [short] = nativeShortPaths([f.target])
    if (!short || short.toLowerCase() === f.target.toLowerCase()) { context.skip('The fixture volume does not provide a distinct 8.3 alias'); return }
    hooks.beforeOpen = (_path, flags) => {
      if (flags === 'wx') { renameSync(f.target, `${f.target}.retired.exe`); writeFileSync(f.target, f.targetBytes) }
    }
    expect(await f.confirm({ currentExecutable: short })).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it('refuses a current target in installer metadata and refuses source equal to target', async () => {
    const f = await fixture()
    const metadataTarget = join(f.installer, 'app.exe')
    await writeFile(metadataTarget, f.targetBytes)
    await f.save({ target: metadataTarget })
    expect(await f.confirm({ currentExecutable: metadataTarget })).toEqual({ confirmed: false })
    await f.save({ source: f.target })
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
  })

  it('never accepts a backup path chosen by a transaction outside its exact same-directory naming rule', async () => {
    const f = await fixture()
    const unrelated = join(f.directory, 'unrelated private file.exe')
    await writeFile(unrelated, 'unrelated private bytes')
    await f.save({ backup: unrelated })
    expect(await f.confirm()).toEqual({ confirmed: false })
    expect(hooks.opens.some(value => value.path === unrelated)).toBe(false)
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated private bytes')
    await unchanged(f)
  })

  it('rejects a setup receipt carrying any portable backup', async () => {
    const f = await fixture('setup')
    await f.save({ backup: f.target })
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
  })

  it.each(['outside', 'metadata', 'hash', 'size', 'source-mz', 'target-mz', 'oversized-source'] as const)
  ('verifies source and target limits and refuses %s package content', async kind => {
    const f = await fixture(kind === 'target-mz' ? 'setup' : 'portable')
    if (kind === 'outside') { const source = join(f.directory, 'outside.exe'); await writeFile(source, f.sourceBytes); await f.save({ source }) }
    if (kind === 'metadata') { const source = join(f.installer, 'source.exe'); await writeFile(source, f.sourceBytes); await f.save({ source }) }
    if (kind === 'hash') await f.save({ expectedHash: '0'.repeat(64) })
    if (kind === 'size') await f.save({ expectedSize: f.sourceBytes.length + 1 })
    if (kind === 'source-mz') { const bytes = Buffer.from('NO-not-an-executable'); await writeFile(f.source, bytes); await f.save({ expectedSize: bytes.length, expectedHash: digest(bytes) }) }
    if (kind === 'target-mz') await writeFile(f.target, 'NO-not-an-executable')
    if (kind === 'oversized-source') await truncate(f.source, 513 * 1024 * 1024)
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
  })

  it('requires a portable target to contain exactly the expected new executable, not the previous version', async () => {
    const f = await fixture()
    await writeFile(f.target, f.oldBytes)
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it.each(['source', 'target', 'receipt'] as const)('rejects a hard-linked %s even when its hash and path otherwise match', async name => {
    const f = await fixture()
    const original = f[name]
    await link(original, join(f.directory, `extra-${name}.link`))
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
  })

  it.each(['cache', 'installer', 'source-parent', 'target-parent'] as const)('rejects a symlink/junction in the %s directory chain', async name => {
    const f = await fixture()
    const path = name === 'cache' ? f.cache : name === 'installer' ? f.installer : name === 'source-parent' ? dirname(f.source) : dirname(f.target)
    const moved = join(f.directory, `moved-${name}`)
    renameSync(path, moved)
    await symlink(moved, path, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.confirm()).toEqual({ confirmed: false })
    expect(hooks.opens.some(value => value.flags === 'wx')).toBe(false)
  })

  it('refuses a source symlink rather than following a same-hash outside file', async context => {
    const f = await fixture()
    const outside = join(f.directory, 'outside same hash.exe')
    await writeFile(outside, f.sourceBytes); await unlink(f.source)
    try { await symlink(outside, f.source, 'file') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return }; throw error }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
    expect(await readFile(outside)).toEqual(f.sourceBytes)
  })

  it.each(['source', 'receipt'] as const)('detects %s replacement after initial hashing and before acknowledgment publication', async name => {
    const f = await fixture()
    let targetReads = 0
    hooks.afterLstat = async path => {
      if (path !== f.target || !hooks.opens.some(opened => opened.path === f.target) || ++targetReads !== 1) return
      if (name === 'source') writeFileSync(f.source, executable('tampered-source'))
      else writeFileSync(f.receipt, JSON.stringify({ ...f.record, expectedHash: '0'.repeat(64) }))
    }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it('detects target tampering while preparing the atomic acknowledgment and leaves all backups untouched', async () => {
    const f = await fixture()
    hooks.beforeOpen = (path, flags) => { if (flags === 'wx' && path.endsWith('.tmp')) writeFileSync(f.target, executable('tampered-target')) }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
    expect(await readFile(f.source)).toEqual(f.sourceBytes)
  })

  it('does not publish a tampered temporary acknowledgment even when it remains a regular file', async () => {
    const f = await fixture()
    hooks.beforeOpen = (path, flags) => {
      if (flags !== 'wx' && path.endsWith('.tmp')) writeFileSync(path, '{"schema":1,"private":"tampered"}')
    }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  it('detects a replaced installer directory before publishing an acknowledgment', async () => {
    const f = await fixture()
    let changed = false
    hooks.beforeOpen = (path, flags) => {
      if (changed || flags !== 'wx' || !path.endsWith('.tmp')) return
      changed = true; renameSync(f.installer, join(f.directory, 'retired-installer')); mkdirSync(f.installer)
    }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await absent(f.acknowledgment); await unchanged(f)
  })

  it('does not report failure merely because the isolated installer consumes the source after atomic acknowledgment', async () => {
    const f = await fixture()
    hooks.afterRename = async (_from, to) => { if (to === f.acknowledgment) await unlink(f.source) }
    expect(await f.confirm()).toEqual({ confirmed: true })
    expect(await readFile(f.target)).toEqual(f.targetBytes)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it('confirms successful publication when the isolated installer immediately consumes source, transaction and acknowledgment', async () => {
    const f = await fixture()
    hooks.afterRename = async (_from, to) => {
      if (to === f.acknowledgment) for (const path of [f.source, f.receipt, f.acknowledgment]) await unlink(path)
    }
    expect(await f.confirm()).toEqual({ confirmed: true })
    for (const path of [f.source, f.receipt, f.acknowledgment]) await absent(path)
    expect(await readFile(f.target)).toEqual(f.targetBytes)
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it('allows acknowledgment consumption during its post-publication file validation', async () => {
    const f = await fixture()
    let published = false
    hooks.afterRename = (_from, to) => { if (to === f.acknowledgment) published = true }
    hooks.afterOpen = async path => { if (published && path === f.acknowledgment) await unlink(path) }
    expect(await f.confirm()).toEqual({ confirmed: true })
    await absent(f.acknowledgment)
    await unchanged(f)
  })

  it.each(['content', 'identity', 'installer-directory'] as const)('still rejects changed %s after the installer consumes its metadata', async change => {
    const f = await fixture()
    hooks.afterRename = async (_from, to) => {
      if (to !== f.acknowledgment) return
      for (const path of [f.source, f.receipt, f.acknowledgment]) await unlink(path)
      if (change === 'content') await writeFile(f.target, executable('changed-after-publication'))
      if (change === 'identity') { await unlink(f.target); await writeFile(f.target, f.targetBytes) }
      if (change === 'installer-directory') { renameSync(f.installer, join(f.directory, 'consumed-installer')); mkdirSync(f.installer) }
    }
    expect(await f.confirm()).toEqual({ confirmed: false })
    expect(await readFile(f.backup)).toEqual(f.oldBytes)
  })

  it('does not accept an existing but tampered health acknowledgment after publication', async () => {
    const f = await fixture()
    hooks.afterRename = async (_from, to) => {
      if (to === f.acknowledgment) await writeFile(to, JSON.stringify({ schema: 1, id: ID, version: VERSION,
        kind: 'portable', target: f.target, targetHash: '0'.repeat(64) }))
    }
    expect(await f.confirm()).toEqual({ confirmed: false })
    await unchanged(f)
  })
})
