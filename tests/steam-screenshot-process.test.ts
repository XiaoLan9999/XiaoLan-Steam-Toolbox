import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasScreenshotSteamProcesses, isSteamClientRunning } from '../src/main/steam-screenshot-runtime'
import { SteamScreenshotService } from '../src/main/steam-screenshots'

const csv = (image: string, pid = 1234): string => `"${image}","${pid}","Console","1","1,024 K"`
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('screenshot-process-')) throw new Error('Unexpected process test root')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('screenshot-specific Steam process guard', () => {
  it.each(['steam.exe', 'steamwebhelper.exe', 'STEAMWEBHELPER.EXE'])('detects %s even when it is the only remaining process', image => {
    expect(hasScreenshotSteamProcesses(csv(image), 'win32')).toBe(true)
  })

  it.each(['steamservice.exe', 'steamerrorreporter.exe', 'steamerrorreporter64.exe', 'notsteam.exe', 'steamwebhelper.exe.fake', 'steam.exe.exe'])('does not block screenshot import for %s alone', image => {
    expect(hasScreenshotSteamProcesses(csv(image), 'win32')).toBe(false)
  })

  it('reads only exact image-name CSV fields, not translated informational messages or other columns', () => {
    expect(hasScreenshotSteamProcesses('INFO: No tasks are running which match the specified criteria.', 'win32')).toBe(false)
    expect(hasScreenshotSteamProcesses('信息: 没有运行的任务匹配指定标准。', 'win32')).toBe(false)
    expect(hasScreenshotSteamProcesses('"other.exe","1234","steamwebhelper.exe","1","100 K"', 'win32')).toBe(false)
    expect(hasScreenshotSteamProcesses('\uFEFF' + csv('steamservice.exe') + '\r\n' + csv('steamwebhelper.exe', 5678), 'win32')).toBe(true)
  })

  it.each([
    ['linux', '1234 steam', true], ['linux', '1234 steamwebhelper', true], ['linux', '1234 steamservice', false],
    ['darwin', '1234 steam_osx', true], ['darwin', '1234 steamwebhelper', true], ['darwin', '1234 steamservice', false],
    ['linux', '1234 steamwebhelper_extra', false], ['linux', '1234 /tmp/steamwebhelper', false], ['linux', 'not-a-pid steam', false]
  ] as const)('parses exact %s pgrep process output %s', (platform, output, running) => {
    expect(hasScreenshotSteamProcesses(output, platform)).toBe(running)
  })

  it('checks broad Steam image candidates once, then filters persistent services out locally', async () => {
    const run = vi.fn(async () => ({ stdout: csv('steamservice.exe') + '\r\n' + csv('steamwebhelper.exe', 5678) }))
    expect(await isSteamClientRunning({ platform: 'win32', execute: run })).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('tasklist.exe', ['/FI', 'IMAGENAME eq steam*', '/FO', 'CSV', '/NH'], {
      windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false
    })
    run.mockResolvedValueOnce({ stdout: csv('steamservice.exe') })
    expect(await isSteamClientRunning({ platform: 'win32', execute: run })).toBe(false)
  })

  it.each(['linux', 'darwin'] as const)('uses bounded exact-name pgrep matching for %s without a shell', async platform => {
    const run = vi.fn(async () => ({ stdout: '1234 steamwebhelper\n' }))
    expect(await isSteamClientRunning({ platform, execute: run })).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('pgrep', ['-x', '-l', platform === 'darwin' ? 'steam_osx|steamwebhelper' : 'steam|steamwebhelper'], {
      timeout: 5000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false
    })
  })

  it('treats only pgrep no-match exit 1 as stopped and fails closed on real inspection errors', async () => {
    const none = vi.fn(async () => { throw Object.assign(new Error('fixture no matches'), { code: 1 }) })
    expect(await isSteamClientRunning({ platform: 'linux', execute: none })).toBe(false)
    await expect(isSteamClientRunning({ platform: 'win32', execute: none })).rejects.toMatchObject({ code: 'SCREENSHOT_PROCESS_CHECK_FAILED' })
    const failed = vi.fn(async () => { throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) })
    await expect(isSteamClientRunning({ platform: 'linux', execute: failed })).rejects.toMatchObject({ code: 'SCREENSHOT_PROCESS_CHECK_FAILED' })
  })

  it('keeps queued images and the original VDF untouched when only a screenshot webhelper remains', async () => {
    const root = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'screenshot-process-'))
    roots.push(root)
    const base = path.join(root, 'userdata', '123', '760')
    await fs.mkdir(base, { recursive: true })
    const original = '"screenshots" {}'
    const vdf = path.join(base, 'screenshots.vdf')
    await fs.writeFile(vdf, original)
    const image = Buffer.alloc(32)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
    image.write('IHDR', 12); image.writeUInt32BE(100, 16); image.writeUInt32BE(100, 20)
    const source = path.join(root, 'source.png')
    await fs.writeFile(source, image)
    const encode = vi.fn(async () => { throw new Error('The guard must run before encoding') })
    const service = new SteamScreenshotService({
      imageAdapter: { inspect: async () => ({ width: 100, height: 100, previewJpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }), encode },
      findSteamPaths: async () => [root],
      isSteamRunning: () => isSteamClientRunning({ platform: 'win32', execute: async () => ({ stdout: csv('steamwebhelper.exe') }) })
    })
    try {
      const catalog = await service.refresh()
      const images = await service.addImages([source])
      await expect(service.prepare({ steamPath: catalog.steamPath!, userId: '123', appId: '730', imageIds: images.map(item => item.id), jpegQuality: 95, resizeLargeImages: true }))
        .rejects.toMatchObject({ code: 'SCREENSHOT_STEAM_RUNNING' })
      expect(encode).not.toHaveBeenCalled()
      expect(await fs.readFile(vdf, 'utf8')).toBe(original)
      expect(await fs.readdir(base)).toEqual(['screenshots.vdf'])
      expect(service.getImages()).toHaveLength(1)
    } finally { service.dispose() }
  })
})
