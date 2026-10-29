import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('keeps a dismissed update hidden across renderer reloads while preserving the settings badge offline', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-update-notice-test-')))
  try {
    const renderer = join(directory, 'renderer.js')
    const script = join(directory, 'fixture.cjs')
    const firstResult = join(directory, 'result-first.json')
    const secondResult = join(directory, 'result-second.json')
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateNotice } from './src/renderer/src/components/UpdateNotice';
import { I18nProvider } from './src/renderer/src/i18n';
import { initialUpdateState } from './src/shared/update-types';
import { DISMISSED_UPDATE_VERSION_KEY, hasAvailableUpdate } from './src/renderer/src/update-notification';
window.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
const base = initialUpdateState('0.16.12', 'portable');
let state, language = 'en', root, settingsCalls = 0;
const container = document.getElementById('root');
const notice = () => document.querySelector('.update-notice');
const badge = () => document.querySelector('[data-test=badge]');
const paint = async (version = '0.16.13', phase = 'available') => {
  state = { ...base, latestVersion: version, phase, error: phase === 'error' ? 'update.timeout' : null };
  if (!root) root = createRoot(container);
  await act(async () => root.render(<I18nProvider language={language}>
    <UpdateNotice state={state} onOpenSettings={() => { settingsCalls++; }} />
    <button data-test="settings">Settings {hasAvailableUpdate(state) && <b data-test="badge">NEW</b>}</button>
  </I18nProvider>));
};
const dismiss = async () => {
  const button = document.querySelector('.update-notice-close');
  check(button, 'Missing dismissal control');
  await act(async () => button.click());
};
const remount = async () => { await act(async () => root.unmount()); root = null; await paint(state.latestVersion, state.phase); };
window.exerciseFirstRun = async () => {
  check(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) === null, 'Fixture did not start with isolated preferences');
  await paint();
  check(notice() && badge(), 'New version needs both a notice and settings badge');
  const view = [...notice().querySelectorAll('button')].find(button => button.textContent === 'View update');
  await act(async () => view.click());
  check(settingsCalls === 1, 'View update did not open settings');
  await dismiss();
  check(!notice() && badge(), 'Dismissal must not clear the badge');
  check(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) === '0.16.13', 'Dismissal was not persisted');
  for (const phase of ['checking', 'downloading', 'ready', 'error', 'available']) {
    await paint('0.16.13', phase);
    check(!notice() && badge(), 'A phase transition revived a dismissed version: ' + phase);
  }
  await remount();
  check(!notice() && badge(), 'Unmount/remount revived the same version');
  await paint('0.16.14');
  check(notice() && notice().textContent.includes('0.16.14'), 'A genuinely newer version must notify again');
  await dismiss();
  check(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) === '0.16.14', 'New dismissal was not persisted');
  return { settingsCalls, firstRunPassed: true };
};
window.exerciseReloaded = async () => {
  check(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) === '0.16.14', 'Reload lost the version-scoped preference');
  for (const version of ['0.16.13', '0.16.14']) {
    await paint(version, 'ready');
    check(!notice() && badge(), 'Page reload revived a dismissed or older version');
  }
  language = 'zh-CN';
  await paint('0.16.15');
  check(notice().textContent.includes('发现新版本 v0.16.15'), 'New version or Chinese notice missing after reload');
  check(!notice().getAttribute('role').includes('dialog'), 'Update notice must not block the task');
  await dismiss();
  check(!notice() && badge(), 'Chinese dismissal cleared the badge or left the notice visible');
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;
  Storage.prototype.getItem = () => { throw new Error('synthetic storage denied'); };
  Storage.prototype.setItem = () => { throw new Error('synthetic storage denied'); };
  try {
    await paint('0.16.16');
    check(notice(), 'New version missing with blocked storage');
    await dismiss();
    await remount();
    check(!notice() && badge(), 'Blocked storage must preserve dismissal for this runtime');
    await paint('0.16.17');
    check(notice() && badge(), 'Blocked storage must not suppress a genuinely newer version');
  } finally { Storage.prototype.getItem = getItem; Storage.prototype.setItem = setItem; }
  await act(async () => root.unmount());
  return { reloadedPassed: true, storageDeniedPassed: true, realReact: true, realDom: true };
};
`, resolveDir: resolve('.'), loader: 'tsx' }, outfile: renderer, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>', 'utf8')
    await mkdir(join(directory, 'moved-package'))
    await writeFile(join(directory, 'moved-package', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../renderer.css"></head><body><div id="root"></div><script src="../renderer.js"></script></body></html>', 'utf8')
    await writeFile(script, String.raw`
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
const phase = process.argv[2];
const output = phase === 'first' ? ${JSON.stringify(firstResult)} : ${JSON.stringify(secondResult)};
const requests = [];
let window;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:|^wss?:/i.test(details.url)) { requests.push(details.url); done({ cancel: true }); } else done({});
  });
  window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } });
  await window.loadFile(phase === 'first' ? ${JSON.stringify(join(directory, 'index.html'))} : ${JSON.stringify(join(directory, 'moved-package', 'index.html'))});
  const result = await window.webContents.executeJavaScript(phase === 'first' ? 'window.exerciseFirstRun()' : 'window.exerciseReloaded()');
  if (requests.length) throw new Error('Offline update fixture attempted network access');
  session.defaultSession.flushStorageData();
  writeFileSync(output, JSON.stringify({ ...result, phase, externalRequests: requests.length }));
  window.destroy(); app.quit();
}).catch(error => { writeFileSync(output, JSON.stringify({ failure: error.stack || String(error), requests })); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
`, 'utf8')
    const require = createRequire(import.meta.url)
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      for (const phase of ['first', 'second']) {
        await run(require('electron') as string, [script, phase], { cwd: dirname(script), env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 })
      }
    } catch (error) {
      const progress = await readFile(secondResult, 'utf8').catch(() => readFile(firstResult, 'utf8').catch(() => 'No fixture result'))
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${progress}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(firstResult, 'utf8'))).toMatchObject({ firstRunPassed: true, phase: 'first', externalRequests: 0, settingsCalls: 1 })
    expect(JSON.parse(await readFile(secondResult, 'utf8'))).toMatchObject({ reloadedPassed: true, phase: 'second',
      storageDeniedPassed: true, realReact: true, realDom: true, externalRequests: 0 })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-update-notice-test-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe update fixture cleanup boundary')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
