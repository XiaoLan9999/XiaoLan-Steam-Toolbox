import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures: string[] = []
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
function chunk(type: string, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(payload.length + 12)
  bytes.writeUInt32BE(payload.length)
  bytes.write(type, 4)
  payload.copy(bytes, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, bytes.length - 4)) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
function png(size = 256, metadata?: string): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(metadata ? [chunk('tEXt', Buffer.from(metadata))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc((size * 4 + 1) * size))), chunk('IEND', Buffer.alloc(0))])
}
function ico(sizes = [16, 32, 48, 256]): Buffer {
  const images = sizes.map(size => png(size))
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach((image, index) => {
    const entry = 6 + index * 16, size = sizes[index]!
    directory[entry] = size === 256 ? 0 : size; directory[entry + 1] = directory[entry]
    directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.length, entry + 8); directory.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([directory, ...images])
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sfc-source-audit-'))
  fixtures.push(directory)
  mkdirSync(join(directory, 'scripts'))
  copyFileSync(join(root, 'scripts/audit-source.mjs'), join(directory, 'scripts/audit-source.mjs'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  execFileSync('git', ['init', '--quiet'], { cwd: directory, env, windowsHide: true })
  const put = (path: string, bytes: Buffer | string) => {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
  }
  const audit = (candidates = true, options: { scriptRoot?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const script = options.scriptRoot ? join(options.scriptRoot, 'scripts/audit-source.mjs') : 'scripts/audit-source.mjs'
    const result = spawnSync(process.execPath, [script, ...(candidates ? ['--candidates'] : [])],
      { cwd: directory, env: { ...env, ...options.env }, encoding: 'utf8', windowsHide: true })
    return { status: result.status, output: result.stdout + result.stderr }
  }
  return { directory, put, audit, env }
}
afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('sfc-source-audit-')) throw new Error('Unexpected audit fixture path')
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('reviewed logo source audit boundary', () => {
  it.skipIf(process.platform !== 'win32')('accepts a case alias of the same Windows repository', () => {
    const f = fixture()
    f.put('build/icon.png', png())
    expect(f.audit(true, { scriptRoot: f.directory.toUpperCase() })).toMatchObject({ status: 0 })
  })

  it('still rejects an active Git work tree belonging to a different repository', () => {
    const f = fixture(), other = fixture()
    expect(f.audit(true, { env: { GIT_DIR: join(other.directory, '.git'), GIT_WORK_TREE: other.directory } }))
      .toMatchObject({ status: 1, output: expect.stringContaining('Audit must run in this project repository') })
  })

  it('isolates temporary fixture commands from inherited Git work-tree and index variables', () => {
    const other = fixture()
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']
    const previous = keys.map(key => process.env[key])
    try {
      process.env.GIT_DIR = join(other.directory, '.git')
      process.env.GIT_WORK_TREE = other.directory
      process.env.GIT_INDEX_FILE = join(other.directory, '.git', 'unrelated-index')
      const f = fixture()
      f.put('build/icon.png', png())
      expect(f.audit()).toMatchObject({ status: 0 })
    } finally {
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })

  it('recognizes the existing synthetic ID range only in the two reviewed test trees', () => {
    const f = fixture()
    f.put('integrations/asf-status-copy/tests/Program.cs', 'const string fixtureId = "76561198000000001";')
    expect(f.audit().status).toBe(0)
    f.put('integrations/asf-status-copy/src/Plugin.cs', 'const string fixtureId = "76561198000000001";')
    expect(f.audit().status).toBe(1)
  })

  it('accepts only the three named and structurally valid square logo assets', () => {
    const f = fixture()
    f.put('build/icon.png', png(512)); f.put('build/icon.ico', ico()); f.put('src/renderer/src/assets/app-logo.png', png())
    expect(f.audit()).toMatchObject({ status: 0 })
    execFileSync('git', ['add', '--all'], { cwd: f.directory, env: f.env, windowsHide: true })
    expect(f.audit(false)).toMatchObject({ status: 0 })
  })

  it.each(['build/other.png', 'build/other.ico', 'src/renderer/src/assets/private-logo.png', 'out/icon.png'])
  ('does not widen the binary allowance to %s', path => {
    const f = fixture(); f.put(path, path.endsWith('.ico') ? ico() : png())
    expect(f.audit().status).toBe(1)
  })

  it.each([
    ['fake PNG', Buffer.from('not an image')], ['short logo', png(32)],
    ['metadata', png(256, 'private fixture metadata')], ['trailing data', Buffer.concat([png(), Buffer.from('extra')])],
    ['bad checksum', (() => { const value = png(); value[29] = value[29]! ^ 1; return value })()],
    ['oversize', Buffer.alloc(2 * 1024 * 1024 + 1)]
  ])('rejects %s at an otherwise reviewed PNG path', (_label, bytes) => {
    const f = fixture(); f.put('build/icon.png', bytes)
    expect(f.audit().status).toBe(1)
  })

  it.each([
    ['fake ICO', Buffer.from('not an icon')], ['duplicate sizes', ico([32, 32])],
    ['trailing data', Buffer.concat([ico(), Buffer.from('extra')])],
    ['out-of-range offset', (() => { const value = ico(); value.writeUInt32LE(value.length + 1, 18); return value })()],
    ['overlapping payload', (() => { const value = ico(); value.writeUInt32LE(value.readUInt32LE(18), 34); return value })()]
  ])('rejects %s at the reviewed ICO path', (_label, bytes) => {
    const f = fixture(); f.put('build/icon.ico', bytes)
    expect(f.audit().status).toBe(1)
  })

  it('does not admit a symlink as a reviewed logo in the Git index', () => {
    const f = fixture()
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.directory, env: f.env, input: '../outside.png', encoding: 'utf8', windowsHide: true }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},build/icon.png`], { cwd: f.directory, env: f.env, windowsHide: true })
    expect(f.audit(false)).toMatchObject({ status: 1, output: expect.stringContaining('symlink, submodule, or unresolved index entry') })
  })
})
