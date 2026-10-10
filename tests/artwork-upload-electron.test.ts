import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('prepares canvas PNG in a real isolated Steam-shaped form without posting or agreeing to copyright', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolan-upload-electron-test-'))
  try {
    const bundle = join(directory, 'upload.cjs')
    const script = join(directory, 'fixture.cjs')
    const resultPath = join(directory, 'result.json')
    await build({ stdin: { contents:
      `export { ArtworkUploadService } from ${JSON.stringify(resolve('src/main/artwork-upload.ts'))};` +
      `export { ArtworkBrowser } from ${JSON.stringify(resolve('src/main/artwork-browser.ts'))};`,
      resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    await writeFile(script, String.raw`
const assert = require('node:assert/strict');
const { writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { ArtworkBrowser, ArtworkUploadService } = require(${JSON.stringify(bundle)});
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
const outputPath = ${JSON.stringify(resultPath)};
const cache = ${JSON.stringify(join(directory, 'upload-cache'))};
const account = '76561198000000001';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const requests = [];
const checkpoints = [];
function checkpoint(name) { checkpoints.push(name); writeFileSync(outputPath, JSON.stringify({ checkpoints })); }
const originalFromPartition = session.fromPartition.bind(session);
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<form id="SubmitItemForm" method="post" action="/fixture-must-not-submit">' +
  '<input id="title" name="title" value="">' +
  '<input id="file" type="file"><input id="image_width" name="image_width" value="506">' +
  '<input id="image_height" name="image_height" value="824"><input id="agree_terms" type="checkbox">' +
  '<img id="PreviewImage"><button type="submit">Submit</button></form>' +
  '<script>window.submissions=0;window.picked=0;' +
  'document.getElementById("SubmitItemForm").addEventListener("submit",e=>{e.preventDefault();window.submissions++});' +
  'document.getElementById("file").addEventListener("change",e=>{' +
  'window.picked++;const reader=new FileReader();reader.onload=()=>{' +
  'const image=document.getElementById("PreviewImage");image.onload=()=>{' +
  'document.querySelector("[name=image_width]").value=image.naturalWidth;' +
  'document.querySelector("[name=image_height]").value=image.naturalHeight;};image.src=reader.result;};' +
  'reader.readAsDataURL(e.target.files[0]);});</script></body></html>';
session.fromPartition = (partition, options) => {
  const isolated = originalFromPartition(partition, options);
  isolated.protocol.handle('https', request => {
    requests.push({ method: request.method, origin: new URL(request.url).origin });
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  return isolated;
};
let parent;
let browser;
let service;
app.whenReady().then(async () => {
  checkpoint('app-ready');
  parent = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  await parent.loadURL('data:text/html,<main>Local toolbox</main>');
  browser = new ArtworkBrowser({ parent,
    getSessionCookies: async id => ['steamLoginSecure=' + id + '%7C%7Cfixture; Domain=steamcommunity.com', 'sessionid=abcd1234; Domain=steamcommunity.com'],
    isAccountCurrent: id => id === account, language: () => 'en',
    onStateChange: state => { if (state.phase === 'closed' && service) service.invalidate(); } });
  service = new ArtworkUploadService({ directory: cache, browser: () => browser, isAccountCurrent: id => id === account });
  browser.setBounds({ x: 30, y: 100, width: 850, height: 550 });
  const first = await service.prepare(account, { name: 'main.png', base64: png });
  checkpoint('main-prepared');
  assert.equal(first.phase, 'ready');
  const view = parent.contentView.children.find(child => child.webContents && child.webContents.id !== parent.webContents.id);
  assert(view);
  const contents = view.webContents;
  contents.setBackgroundThrottling(false);
  assert.equal(contents.debugger.isAttached(), false);
  const readForm = () => contents.executeJavaScript('({name:document.getElementById("file").files[0].name,title:document.getElementById("title").value,width:document.querySelector("[name=image_width]").value,height:document.querySelector("[name=image_height]").value,copyright:document.getElementById("agree_terms").checked,submissions:window.submissions,picked:window.picked,preview:document.getElementById("PreviewImage").naturalWidth,bridge:typeof window.steamCommenter})');
  assert.deepEqual(await readForm(), { name: 'artwork-main.png', title: '', width: '1000', height: '1', copyright: false, submissions: 0, picked: 1, preview: 1, bridge: 'undefined' });
  assert.equal(readdirSync(cache).length, 1);
  await contents.executeJavaScript('document.getElementById("title").value="Manually entered title";document.getElementById("agree_terms").checked=true;undefined');
  await browser.open('upload', account);
  const retained = await readForm();
  assert.equal(retained.title, 'Manually entered title');
  assert.equal(retained.copyright, true);
  assert.equal(retained.name, 'artwork-main.png');
  checkpoint('ordinary-open-keeps-unsubmitted-form');
  await contents.loadURL('https://steamcommunity.com/sharedfiles/filedetails/?id=123456');
  assert.equal(new URL(contents.getURL()).pathname, '/sharedfiles/filedetails/');
  checkpoint('simulated-main-details-get');
  await service.prepare(account, { name: 'side.png', base64: png });
  const side = await readForm();
  assert.equal(new URL(contents.getURL()).pathname, '/sharedfiles/edititem/767/3/');
  assert.equal(side.name, 'artwork-side.png');
  assert.equal(side.title, '');
  assert.equal(side.width, '1000');
  assert.equal(side.height, '1');
  assert.equal(side.copyright, false);
  assert.equal(side.submissions, 0);
  assert.equal(side.picked, 1);
  assert.equal(contents.debugger.isAttached(), false);
  assert.equal(readdirSync(cache).length, 1);
  checkpoint('side-prepared');
  const ownedDirectory = join(cache, readdirSync(cache)[0]);
  const currentFile = join(ownedDirectory, readdirSync(ownedDirectory)[0]);
  await assert.rejects(browser.prepareUploadFile('76561198000000002', currentFile), error => error.code === 'ARTWORK_SESSION_CHANGED');
  await contents.loadURL('https://steamcommunity.com/sharedfiles/edititem/123/4/');
  await assert.rejects(browser.prepareUploadFile(account, currentFile), error => error.code === 'ARTWORK_UPLOAD_PAGE_REQUIRED');
  assert.equal(contents.debugger.isAttached(), false);
  checkpoint('owner-and-exact-page-guarded');
  contents.debugger.attach('1.3');
  await assert.rejects(service.prepare(account, { name: 'busy.png', base64: png }), error => error.code === 'ARTWORK_UPLOAD_BUSY');
  assert.equal(contents.debugger.isAttached(), true);
  contents.debugger.detach();
  checkpoint('occupied-debugger-preserved');
  await browser.close();
  assert.equal(readdirSync(cache).length, 0);
  assert(requests.every(request => request.method === 'GET' && request.origin === 'https://steamcommunity.com'));
  writeFileSync(outputPath, JSON.stringify({ prepared: true, debuggerPreserved: true, cleanup: true,
    allRequestsReadOnly: true, noRemoteBridge: true, side }));
  browser.shutdown();parent.destroy();app.quit();
}).catch(error => {
  console.error(error.stack || String(error));
  if (service) service.invalidate();if(browser) browser.shutdown();
  if (parent && !parent.isDestroyed()) parent.destroy();app.exit(1);
});
`, 'utf8')
    const require = createRequire(import.meta.url)
    const electron = require('electron') as string
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      await run(electron, [script], { cwd: dirname(script), env: environment, windowsHide: true,
        timeout: 45_000, maxBuffer: 1_048_576 })
    } catch (error) {
      const progress = await readFile(resultPath, 'utf8').catch(() => 'No fixture checkpoint')
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${progress}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({ prepared: true, debuggerPreserved: true,
      cleanup: true, allRequestsReadOnly: true, noRemoteBridge: true,
      side: { name: 'artwork-side.png', title: '', width: '1000', height: '1', copyright: false, submissions: 0, picked: 1 } })
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
