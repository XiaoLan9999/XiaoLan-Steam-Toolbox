import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../shared/domain'

const fail = (): DomainError => new DomainError('STEAM_CACHE_ACTION_UNAVAILABLE', 'STEAM_CACHE_ACTION_UNAVAILABLE')
const individual = (id: string): boolean => /^\d{17}$/.test(id) && BigInt(id) > 76561197960265728n && BigInt(id) <= 76561197960265728n + 0xffffffffn
export function steamProfileShortcutTarget(args: string[]): string | null {
  const matches = args.filter(value => value.startsWith('--steam-cache-profile='))
  if (matches.length !== 1) return null
  const id = matches[0]!.slice('--steam-cache-profile='.length)
  return individual(id) ? id : null
}
async function directory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.startsWith('\\\\') || /[\x00-\x1f]/.test(path)) throw fail()
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw fail()
}
export function avatarDimensions(bytes: Buffer): { width: number; height: number } | null {
  let width = 0, height = 0
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at++] !== 0xff) return null
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]!
      if (marker === 0xd9 || marker === 0xda) return null
      if (at + 2 > bytes.length) return null
      const size = bytes.readUInt16BE(at)
      if (size < 2 || at + size > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break }
      at += size
    }
  }
  return width > 0 && height > 0 && width <= 1024 && height <= 1024 ? { width, height } : null
}
export function createStaticSteamAvatarCache(convert: (bytes: Buffer) => string | null) {
  const cache = new Map<string, { stamp: string; value: string }>()
  return async (root: string, id: string): Promise<string | null> => {
    try {
      if (!individual(id)) return null
      await directory(root); await directory(join(root, 'config')); const folder = join(root, 'config', 'avatarcache'); await directory(folder)
      for (const extension of ['png', 'jpg']) {
        const path = join(folder, `${id}.${extension}`)
        let before
        try { before = await lstat(path) } catch { continue }
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 24 || before.size > 512 * 1024 || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) continue
        const stamp = `${before.dev}:${before.ino}:${before.mtimeMs}:${before.size}`, previous = cache.get(path)
        if (previous?.stamp === stamp) return previous.value
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let bytes: Buffer
        try {
          const proof = await handle.stat(), bounded = Buffer.alloc(before.size + 1)
          let length = 0
          while (length < bounded.length) { const read = await handle.read(bounded, length, bounded.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
          bytes = bounded.subarray(0, Math.min(length, before.size)); const after = await handle.stat()
          if (proof.ino !== before.ino || proof.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.size !== before.size || length !== before.size) continue
        } finally { await handle.close() }
        if (!avatarDimensions(bytes)) continue
        const value = convert(bytes)
        if (!value || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) || value.length > 128 * 1024) continue
        cache.delete(path); cache.set(path, { stamp, value })
        while (cache.size > 32) cache.delete(cache.keys().next().value!)
        return value
      }
    } catch { /* A missing or invalid optional static image is not an account failure. */ }
    return null
  }
}
export async function steamUserdataDirectory(root: string, id: string): Promise<string> {
  if (!individual(id)) throw fail()
  await directory(root); await directory(join(root, 'userdata'))
  const path = join(root, 'userdata', (BigInt(id) - 76561197960265728n).toString())
  await directory(path)
  return path
}
export async function publishSteamProfileShortcut(destination: string, executable: string, id: string,
  create: (path: string, target: string, args: string) => boolean): Promise<void> {
  const name = basename(destination)
  if (!individual(id) || !isAbsolute(destination) || destination.startsWith('\\\\') || /[<>:"|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || extname(name).toLowerCase() !== '.lnk' ||
    !isAbsolute(executable) || extname(executable).toLowerCase() !== '.exe') throw fail()
  await directory(dirname(destination)); await directory(dirname(executable))
  const program = await lstat(executable)
  if (!program.isFile() || program.isSymbolicLink() || program.nlink !== 1) throw fail()
  try { await lstat(destination); throw fail() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = join(dirname(destination), `.xiaolan-shortcut-${randomUUID()}.lnk`)
  try {
    if (!create(temporary, executable, `--steam-cache-profile=${id}`)) throw fail()
    const source = await lstat(temporary)
    if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) throw fail()
    await link(temporary, destination)
  } finally { await directory(dirname(destination)); await unlink(temporary).catch(() => {}) }
}
