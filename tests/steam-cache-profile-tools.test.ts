import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { avatarDimensions, createStaticSteamAvatarCache, publishSteamProfileShortcut, steamProfileShortcutTarget, steamUserdataDirectory } from '../src/main/steam-cache-profile-tools'

const A = '76561198000000001', directories: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'steam-profile-tools-'))); directories.push(root)
  await mkdir(join(root, 'config/avatarcache'), { recursive: true }); await mkdir(join(root, 'userdata/39734273'), { recursive: true })
  return root
}
function png(width = 96, height = 96): Buffer {
  const value = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(value); value.write('IHDR', 12); value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value
}
afterEach(async () => {
  const temporary = await realpath(tmpdir())
  for (const root of directories.splice(0)) { const path = await realpath(root); expect(dirname(path).toLowerCase()).toBe(temporary.toLowerCase()); expect(basename(path).startsWith('steam-profile-tools-')).toBe(true); await rm(path, { recursive: true, force: true }) }
})
describe('bounded static Steam card assets and owner-selected shortcuts', () => {
  it('accepts bounded PNG headers, never GIF or oversized image dimensions', () => {
    expect(avatarDimensions(png())).toEqual({ width: 96, height: 96 })
    expect(avatarDimensions(png(1025))).toBeNull(); expect(avatarDimensions(Buffer.from('GIF89a animated fixture'))).toBeNull()
  })
  it('reads only the named cache image and keeps a bounded reusable static conversion', async () => {
    const root = await fixture(), image = join(root, 'config/avatarcache', `${A}.png`)
    await writeFile(image, png())
    const convert = vi.fn(() => 'data:image/png;base64,c3ludGhldGlj')
    const avatar = createStaticSteamAvatarCache(convert)
    expect(await avatar(root, A)).toBe('data:image/png;base64,c3ludGhldGlj')
    await avatar(root, A); expect(convert).toHaveBeenCalledOnce()
    expect(await avatar(root, '../outside')).toBeNull()
    await writeFile(image, Buffer.alloc(512 * 1024 + 1)); expect(await avatar(root, A)).toBeNull()
    expect(convert).toHaveBeenCalledOnce()
  })
  it('resolves only the selected SteamID32 userdata directory', async () => {
    const root = await fixture()
    expect(await steamUserdataDirectory(root, A)).toBe(join(root, 'userdata/39734273'))
    await expect(steamUserdataDirectory(root, '../other')).rejects.toThrow()
  })
  it('takes one validated account parameter without treating argv as a command', () => {
    expect(steamProfileShortcutTarget(['app.exe', `--steam-cache-profile=${A}`])).toBe(A)
    expect(steamProfileShortcutTarget(['--steam-cache-profile=../secrets'])).toBeNull()
    expect(steamProfileShortcutTarget([`--steam-cache-profile=${A}`, `--steam-cache-profile=${A}`])).toBeNull()
  })
  it('publishes only a fixed account argument and never overwrites an existing shortcut', async () => {
    const root = await fixture(), program = join(root, 'fixture.exe'), target = join(root, 'profile.lnk')
    await writeFile(program, 'synthetic executable, never run')
    const create = vi.fn((path: string, executable: string, args: string) => { expect(executable).toBe(program); expect(args).toBe(`--steam-cache-profile=${A}`); writeFileSync(path, 'synthetic shortcut'); return true })
    await publishSteamProfileShortcut(target, program, A, create)
    expect(await readFile(target, 'utf8')).toBe('synthetic shortcut'); expect((await lstat(target)).nlink).toBe(1)
    await expect(publishSteamProfileShortcut(target, program, A, create)).rejects.toThrow()
    expect(create).toHaveBeenCalledOnce()
  })
  it.each(['CON.lnk', 'target.txt:ads.lnk', 'bad?.lnk'])('rejects a reserved or stream shortcut destination %s', async name => {
    const root = await fixture(), program = join(root, 'fixture.exe'); await writeFile(program, 'synthetic')
    const create = vi.fn(() => true)
    await expect(publishSteamProfileShortcut(join(root, name), program, A, create)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})
