import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('runs the embedded artwork workflow in a real isolated Electron view without accounts, uploads or external network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolan-artwork-browser-test-'))
  try {
    const bundle = join(directory, 'artwork-browser.cjs')
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await build({ entryPoints: [resolve('src/main/artwork-browser.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    await writeFile(script, String.raw`
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const { app, BrowserWindow, dialog, session } = require('electron');
const { ArtworkBrowser } = require(${JSON.stringify(bundle)});
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
const outputPath = ${JSON.stringify(result)};
const account = '76561198000000001';
const requests = [];
const sessions = [];
let httpDownloadRequests = 0;
const checkpoints = [];
function checkpoint(name) { checkpoints.push(name); writeFileSync(outputPath, JSON.stringify({ checkpoints })); }
checkpoint('script-started');
const nativeFromPartition = session.fromPartition.bind(session);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(png.split(',')[1], 'base64');
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<form id="SubmitItemForm" action="/fixture-submit" method="post">' +
  '<input id="file" type="file"><input id="image_width" name="image_width" value="506">' +
  '<input id="image_height" name="image_height" value="824"><input id="agree_terms" type="checkbox">' +
  '<img id="PreviewImage" src="' + png + '"></form>' +
  '<script>window.submissions=0;document.getElementById("SubmitItemForm").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>' +
  '</body></html>';
session.fromPartition = (partition, options) => {
  const isolated = nativeFromPartition(partition, options);
  sessions.push({ partition, isolated });
  isolated.protocol.handle('https', request => {
    requests.push({ method: request.method, origin: new URL(request.url).origin });
    if (new URL(request.url).pathname === '/fixture-redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://example.com/blocked?private=fixture' } });
    }
    if (new URL(request.url).pathname === '/fixture-download.png') {
      httpDownloadRequests++;
      if (httpDownloadRequests > 1) return new Response('One-time URL already consumed', { status: 410 });
      return new Response(pngBytes, { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="http-main.png"' } });
    }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  return isolated;
};
const pause = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out'); await pause(20); }
}
let parent;
let browser;
app.whenReady().then(async () => {
  checkpoint('app-ready');
  parent = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await parent.loadURL('data:text/html,<main>Local toolbox fixture</main>');
  checkpoint('parent-ready');
  let cookieLookups = 0;
  const changes = [];
  browser = new ArtworkBrowser({ parent,
    getSessionCookies: async id => { cookieLookups++; return ['steamLoginSecure=' + id + '%7C%7Cfixture-token; Domain=steamcommunity.com', 'sessionid=abcd1234; Domain=steamcommunity.com']; },
    isAccountCurrent: id => id === account, language: () => 'en', onStateChange: state => changes.push(state) });
  browser.setBounds({ x: 40, y: 120, width: 880, height: 600 });
  await browser.open('upload', account);
  checkpoint('upload-ready');
  function view() { return parent.contentView.children.find(child => child.webContents && child.webContents.id !== parent.webContents.id); }
  const uploadView = view();
  assert(uploadView);
  const uploadContents = uploadView.webContents;
  uploadView.webContents.setBackgroundThrottling(false);
  assert.equal(uploadView.getVisible(), true);
  assert.equal(browser.getState().canApplyLongArtwork, true);
  const preferences = uploadView.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert(!preferences.preload);
  checkpoint('preferences-checked');
  assert.equal(await uploadView.webContents.executeJavaScript('typeof require + ":" + typeof window.steamCommenter + ":" + typeof window.electron'), 'undefined:undefined:undefined');
  checkpoint('remote-isolation-checked');
  await assert.rejects(browser.applyLongArtwork(), error => error.code === 'ARTWORK_FILE_REQUIRED');
  checkpoint('file-required-checked');
  await uploadView.webContents.executeJavaScript('const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71])], "fixture.png", {type:"image/png"})); document.getElementById("file").files = transfer.files; document.getElementById("PreviewImage").decode()');
  checkpoint('file-selected');
  await browser.applyLongArtwork();
  checkpoint('long-artwork-applied');
  const formState = await uploadView.webContents.executeJavaScript('({width:document.querySelector("[name=image_width]").value,height:document.querySelector("[name=image_height]").value,ids:[document.querySelector("[name=image_width]").id,document.querySelector("[name=image_height]").id],copyright:document.getElementById("agree_terms").checked,submissions:window.submissions})');
  assert.deepEqual(formState, { width: '1000', height: '1', ids: ['', ''], copyright: false, submissions: 0 });
  await browser.open('upload', account);
  assert.equal(view().webContents.id, uploadView.webContents.id);
  assert.equal(await uploadView.webContents.executeJavaScript('document.getElementById("file").files.length'), 1);
  await browser.open('showcase', account);
  checkpoint('showcase-ready');
  assert.equal(view().webContents.id, uploadView.webContents.id);
  assert.equal(cookieLookups, 1);
  await browser.open('upload', account);
  await uploadView.webContents.executeJavaScript('location.href="https://example.com/blocked?private=fixture"; undefined');
  await waitFor(() => browser.getState().error === 'ARTWORK_NAVIGATION_BLOCKED');
  assert(!requests.some(request => request.origin === 'https://example.com'));
  browser.reload();
  await waitFor(() => browser.getState().phase === 'ready');
  await uploadView.webContents.executeJavaScript('location.href="https://steamcommunity.com/fixture-redirect"; undefined');
  await waitFor(() => browser.getState().error === 'ARTWORK_NAVIGATION_BLOCKED');
  assert(!requests.some(request => request.origin === 'https://example.com'));
  browser.setBounds(null);
  assert.equal(uploadView.getVisible(), false);
  browser.setBounds({ x: 40, y: 120, width: 800, height: 500 });
  assert.equal(uploadView.getVisible(), true);
  parent.emit('resize');
  assert.equal(uploadView.getVisible(), false);
  await browser.open('showcase', account);
  const steamSession = uploadView.webContents.session;
  await steamSession.cookies.set({ url: 'https://steamcommunity.com/', name: 'steamLoginSecure',
    value: account + '%7C%7Crefreshed-fixture', path: '/', secure: true, httpOnly: true });
  await pause(50);
  assert.equal(browser.getState().phase, 'ready');
  assert.equal(view().webContents.id, uploadView.webContents.id);
  assert.equal(uploadView.webContents.isDestroyed(), false);
  checkpoint('same-account-cookie-refresh-accepted');
  await steamSession.cookies.set({ url: 'https://steamcommunity.com/', name: 'steamLoginSecure',
    value: '76561198000000002%7C%7Cdifferent-fixture', path: '/', secure: true, httpOnly: true });
  await waitFor(() => browser.getState().phase === 'closed');
  assert.equal(browser.getState().error, 'ARTWORK_SESSION_CHANGED');
  await waitFor(() => uploadContents.isDestroyed());
  checkpoint('different-account-cookie-closed');
  await browser.open('upload', account);
  const logoutView = view();
  const logoutContents = logoutView.webContents;
  await logoutContents.session.cookies.remove('https://steamcommunity.com/', 'steamLoginSecure');
  await waitFor(() => browser.getState().phase === 'closed');
  assert.equal(browser.getState().error, 'ARTWORK_SESSION_CHANGED');
  await waitFor(() => logoutContents.isDestroyed());
  checkpoint('removed-session-cookie-closed');
  await browser.open('guide');
  checkpoint('guide-ready');
  assert.equal(browser.getState().accountId, null);
  assert.notEqual(view().webContents.session, steamSession);
  assert.equal((await view().webContents.session.cookies.get({ url: 'https://steamcommunity.com/' })).length, 0);
  assert.equal((await steamSession.cookies.get({ url: 'https://steamcommunity.com/' })).length, 0);
  await browser.open('design');
  assert.equal((await view().webContents.session.cookies.get({})).length, 0);
  assert.equal(cookieLookups, 2);
  const designView = view();
  designView.webContents.setBackgroundThrottling(false);
  const validPath = ${JSON.stringify(join(directory, 'downloaded.png'))};
  const httpPath = ${JSON.stringify(join(directory, 'http-downloaded.png'))};
  const unsafePath = ${JSON.stringify(join(directory, 'unsafe.exe'))};
  const adsBase = ${JSON.stringify(join(directory, 'ads-base.png'))};
  let chosenPath = validPath;
  let prompts = 0;
  dialog.showSaveDialogSync = () => {
    prompts++;
    if (chosenPath === 'cancel') return undefined;
    if (chosenPath === 'close') { void browser.close(); return ${JSON.stringify(join(directory, 'late-download.png'))}; }
    return chosenPath;
  };
  async function triggerBlob(name = 'main.png') {
    return designView.webContents.executeJavaScript('(() => { const bytes=Uint8Array.from(atob(' + JSON.stringify(png.split(',')[1]) + '), c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:"image/png"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=' + JSON.stringify(name) + ';document.body.append(link);link.click();URL.revokeObjectURL(link.href);link.remove(); })()', true);
  }
  await triggerBlob();
  await waitFor(() => existsSync(validPath));
  await waitFor(() => readFileSync(validPath).length === pngBytes.length);
  assert.deepEqual(readFileSync(validPath), pngBytes);
  assert.equal(prompts, 1);
  checkpoint('blob-download-verified');
  chosenPath = httpPath;
  await designView.webContents.executeJavaScript('(() => {const link=document.createElement("a");link.href="https://steam.design/fixture-download.png";link.download="http-main.png";document.body.append(link);link.click();link.remove()})()', true);
  await waitFor(() => existsSync(httpPath));
  await waitFor(() => readFileSync(httpPath).length === pngBytes.length);
  assert.deepEqual(readFileSync(httpPath), pngBytes);
  assert.equal(prompts, 2);
  assert.equal(httpDownloadRequests, 1);
  checkpoint('http-download-verified');
  chosenPath = unsafePath;
  await triggerBlob('unsafe.png');
  await waitFor(() => prompts === 3 && browser.getState().error === 'ARTWORK_DOWNLOAD_PATH_INVALID');
  assert(!existsSync(unsafePath));
  chosenPath = adsBase + ':payload.png';
  await triggerBlob('ads.png');
  await waitFor(() => prompts === 4);
  await pause(50);
  assert(!existsSync(adsBase));
  checkpoint('unsafe-download-paths-rejected');
  chosenPath = 'cancel';
  await triggerBlob('cancel.png');
  await waitFor(() => prompts === 5);
  await pause(50);
  assert.equal(prompts, 5);
  assert.equal(new Set(sessions.map(item => item.partition)).size, sessions.length);
  assert(sessions.every(item => !item.partition.startsWith('persist:')));
  const remoteContents = view().webContents;
  const latePath = ${JSON.stringify(join(directory, 'late-download.png'))};
  chosenPath = 'close';
  await triggerBlob('close.png').catch(() => {});
  await browser.close();
  await pause(50);
  assert(!existsSync(latePath));
  await waitFor(() => remoteContents.isDestroyed());
  assert.equal(parent.contentView.children.filter(child => child.webContents && child.webContents.id !== parent.webContents.id).length, 0);
  assert(requests.every(request => request.method === 'GET'));
  assert(!JSON.stringify(changes).includes('fixture-token'));
  writeFileSync(outputPath, JSON.stringify({ isolated: true, cookieLookups, requests: requests.length,
    sessions: sessions.length, formState, navigationBlocked: true, redirectsBlocked: true, allRequestsReadOnly: true,
    blobDownloadVerified: true, immediateBlobRevokeVerified: true, httpDownloadVerified: true,
    httpDownloadRequests, unsafePathsRejected: true, lateSaveIgnored: true,
    sameAccountRefreshAccepted: true, differentAccountClosed: true, removedSessionClosed: true }));
  browser.shutdown();
  parent.destroy();
  app.quit();
}).catch(error => {
  console.error(error.stack || String(error));
  if (browser) browser.shutdown();
  if (parent && !parent.isDestroyed()) parent.destroy();
  app.exit(1);
});
`, 'utf8')
    const require = createRequire(import.meta.url)
    const electronPath = require('electron') as string
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      await run(electronPath, [script], { cwd: dirname(script), env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 })
    } catch (error) {
      const progress = await readFile(result, 'utf8').catch(() => 'No fixture checkpoint')
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${progress}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(result, 'utf8'))).toMatchObject({ isolated: true, cookieLookups: 2,
      navigationBlocked: true, redirectsBlocked: true, allRequestsReadOnly: true,
      blobDownloadVerified: true, immediateBlobRevokeVerified: true, httpDownloadVerified: true,
      httpDownloadRequests: 1, unsafePathsRejected: true, lateSaveIgnored: true,
      sameAccountRefreshAccepted: true, differentAccountClosed: true, removedSessionClosed: true,
      formState: { width: '1000', height: '1', ids: ['', ''], copyright: false, submissions: 0 } })
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
