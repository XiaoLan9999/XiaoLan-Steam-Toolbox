import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('releases only an idle screenshot renderer and recreates it on demand in real Electron', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-screenshot-energy-test-')))
  try {
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await build({ stdin: { contents: String.raw`
import { app, BrowserWindow, nativeImage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ScreenshotBrowserImageAdapter } from './src/main/screenshot-image-adapter';
mkdirSync(join(__dirname, 'profile'));
app.setPath('userData', join(__dirname, 'profile'));
app.setPath('sessionData', join(__dirname, 'profile'));
app.on('window-all-closed', () => {});
const adapter = new ScreenshotBrowserImageAdapter();
const timer = setTimeout(() => app.exit(1), 50000);
app.whenReady().then(async () => {
  try {
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    const pixels = Buffer.alloc(64 * 64 * 4, 160);
    const png = nativeImage.createFromBitmap(pixels, { width: 64, height: 64 }).toPNG();
    const image = await adapter.inspect(png);
    assert.equal(image.width, 64); assert.equal(image.height, 64);
    assert.ok(image.previewJpeg.length > 0);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(adapter.releaseIdleWorker(), true);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(adapter.releaseIdleWorker(), false);
    const active = adapter.inspect(png);
    assert.equal(adapter.releaseIdleWorker(), false);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal((await active).width, 64);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal((await adapter.inspect(png)).height, 64);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    adapter.dispose();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: true, activeConversionPreserved: true, recreated: true }));
    clearTimeout(timer); app.quit();
  } catch (error) {
    adapter.dispose(); clearTimeout(timer);
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
    app.exit(1);
  }
});
`, resolveDir: resolve('.'), sourcefile: 'screenshot-energy-fixture.ts', loader: 'ts' },
      outfile: script, platform: 'node', format: 'cjs', bundle: true, packages: 'external' })
    const electron = createRequire(import.meta.url)('electron') as string
    await run(electron, [script], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
    expect(JSON.parse(await readFile(result, 'utf8'))).toEqual({ passed: true, activeConversionPreserved: true, recreated: true })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-screenshot-energy-test-')) throw new Error('Unsafe fixture cleanup')
    await rm(directory, { recursive: true, force: true })
  }
}, 75000)
