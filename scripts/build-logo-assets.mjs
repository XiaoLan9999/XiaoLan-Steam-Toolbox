import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
if (!input) throw new Error('Usage: electron scripts/build-logo-assets.mjs <source-image>')
const runtime = join(root, 'out', 'logo-build-runtime')
mkdirSync(runtime, { recursive: true })
app.setPath('userData', runtime)
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  try {
    const original = nativeImage.createFromPath(resolve(input))
    if (original.isEmpty()) throw new Error('The logo source could not be decoded')
    const size = original.getSize()
    if (Math.abs(size.width / size.height - 3 / 4) > 0.01) throw new Error('Expected the original portrait illustration')
    const edge = Math.round(size.width * 710 / 1086)
    const rect = { x: Math.round(size.width * 210 / 1086), y: Math.round(size.height * 25 / 1448), width: edge, height: edge }
    const cropped = original.crop(rect)
    const master = cropped.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
    const build = join(root, 'build')
    const assets = join(root, 'src', 'renderer', 'src', 'assets')
    mkdirSync(build, { recursive: true })
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(build, 'icon.png'), master)
    writeFileSync(join(assets, 'app-logo.png'), master)

    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const frames = sizes.map(edge => cropped.resize({ width: edge, height: edge, quality: 'best' }).toPNG())
    const header = Buffer.alloc(6 + sizes.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    for (let index = 0; index < sizes.length; index++) {
      const at = 6 + index * 16
      header[at] = sizes[index] === 256 ? 0 : sizes[index]
      header[at + 1] = header[at]
      header.writeUInt16LE(1, at + 4)
      header.writeUInt16LE(32, at + 6)
      header.writeUInt32LE(frames[index].length, at + 8)
      header.writeUInt32LE(offset, at + 12)
      offset += frames[index].length
    }
    const ico = Buffer.concat([header, ...frames])
    writeFileSync(join(build, 'icon.ico'), ico)
    console.log(JSON.stringify({ original: size, crop: rect, master: [1024, 1024], windowsSizes: sizes,
      pngBytes: master.length, icoBytes: ico.length, pngSha256: createHash('sha256').update(master).digest('hex'),
      icoSha256: createHash('sha256').update(ico).digest('hex') }))
    app.quit()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Logo build failed')
    app.exit(1)
  }
})
