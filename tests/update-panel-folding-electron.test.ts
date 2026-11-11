import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('keeps update diagnostics folded by default, expandable, and independent from download actions offline', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-update-panel-test-')))
  try {
    const resultPath = join(directory, 'result.json')
    const script = join(directory, 'fixture.cjs')
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UpdatePanel } from './src/renderer/src/components/UpdatePanel';
import { I18nProvider } from './src/renderer/src/i18n';
import { DEFAULT_UPDATE_PREFERENCES, initialUpdateState } from './src/shared/update-types';
import './src/renderer/src/styles.css';
window.IS_REACT_ACT_ENVIRONMENT = true;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const visible = node => !!node && node.checkVisibility();
let root, state, language, checks = 0, cancels = 0, downloads = [];
const routes = [
  { id: 'github', label: 'GitHub', domain: 'github.com', status: 'available', latencyMs: 10, speedBytesPerSecond: 1024, error: null },
  { id: 'fast', label: 'Fast mirror', domain: 'fast.example', status: 'available', latencyMs: 200, speedBytesPerSecond: 2097152, error: null },
  { id: 'failed', label: 'Failed mirror', domain: 'failed.example', status: 'failed', latencyMs: null, speedBytesPerSecond: 0, error: 'update.timeout' }
];
window.steamCommenter = {
  downloadUpdate: async route => { downloads.push(route ?? null); return { ok: true, data: null }; },
  checkForUpdates: async () => { checks++; return { ok: true, data: null }; },
  cancelUpdate: async () => { cancels++; return { ok: true, data: null }; }
};
const paint = async patch => {
  state = { ...state, ...patch };
  await act(async () => root.render(<I18nProvider language={language}><div className="settings-modal">
    <UpdatePanel state={state} preferences={DEFAULT_UPDATE_PREFERENCES} runAction={async (_label, action) => action()} />
  </div></I18nProvider>));
};
const click = async node => { check(node, 'Missing control'); await act(async () => node.click()); };
const button = (zh, en) => [...document.querySelectorAll('button')].find(node => node.textContent === (language === 'en' ? en : zh));
window.exercise = async () => {
  const combinations = [];
  for (const theme of ['light', 'dark']) for (language of ['zh-CN', 'en']) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language;
    root = createRoot(document.getElementById('root'));
    state = { ...initialUpdateState('0.18.1', 'portable'), phase: 'available', latestVersion: '0.18.2', routes };
    await paint({});
    const routeDetails = document.querySelector('.update-route-details');
    const routeList = document.querySelector('.update-route-list');
    const select = document.querySelector('.update-download-controls select');
    check(!routeDetails.open && !visible(routeList), 'Route tests must start hidden');
    check(select.value === '' && ![...select.options].some(option => option.value === 'failed'), 'Default must be automatic with no failed manual route');
    await click(routeDetails.querySelector('summary'));
    check(routeDetails.open && visible(routeList) && routeList.textContent.includes('fast.example'), 'Route tests must expand');
    const before = downloads.length;
    await click(button('下载更新', 'Download update'));
    check(downloads.length === before + 1 && downloads.at(-1) === null, 'Default download must request automatic fastest selection');
    await act(async () => { select.value = 'fast'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('下载更新', 'Download update'));
    check(downloads.at(-1) === 'fast', 'Manual override must remain usable');
    await click(routeDetails.querySelector('summary'));
    await paint({ phase: 'downloading', sourceRouteId: 'fast', percent: 50, downloadedBytes: 5242880, totalBytes: 10485760, speedBytesPerSecond: 2097152 });
    const speedDetails = document.querySelector('.update-speed-details');
    const speed = speedDetails.querySelector('strong');
    const cancel = button('取消下载', 'Cancel download');
    check(!routeDetails.open && !speedDetails.open && !visible(speed), 'Progress must not unfold diagnostics automatically');
    check(visible(document.querySelector('progress')) && visible(cancel) && document.querySelector('.update-progress-summary').textContent.includes('50.0%'), 'Progress and cancel must stay visible');
    await click(speedDetails.querySelector('summary'));
    check(speedDetails.open && visible(speed) && speed.textContent === '2.0 MiB/s', 'Download speed must expand');
    await paint({ percent: 60, speedBytesPerSecond: 1048576 });
    check(speedDetails.open && speed.textContent === '1.0 MiB/s', 'Progress refresh must preserve user-expanded details');
    await click(speedDetails.querySelector('summary'));
    await paint({ percent: 65, error: 'update.timeout' });
    check(!speedDetails.open && !routeDetails.open && visible(document.querySelector('.update-error[role="alert"]')), 'Errors must be visible without forcing diagnostics open');
    const beforeCancel = cancels;
    await click(cancel);
    check(cancels === beforeCancel + 1 && !cancel.disabled, 'Cancel must work with hidden diagnostics');
    check(document.documentElement.scrollWidth <= window.innerWidth, 'Update layout overflow');
    check(checks === 0, 'Opening diagnostics must not trigger update checks');
    combinations.push({ theme, language });
    await act(async () => root.unmount());
  }
  return { combinations: combinations.length, downloads: downloads.length, cancels, checks, realDom: true };
};
`, resolveDir: resolve('.'), loader: 'tsx' }, outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
    await writeFile(script, `
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
let window, requests = 0;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:|^wss?:/i.test(details.url)) { requests++; done({ cancel: true }); } else done({});
  });
  window = new BrowserWindow({ show: false, width: 1040, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  const result = await window.webContents.executeJavaScript('window.exercise()');
  if (requests) throw new Error('Offline fixture tried network requests');
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ...result, externalRequests: requests }));
  window.destroy(); app.quit();
}).catch(error => { writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ failure: error.stack || String(error), requests })); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
`)
    const require = createRequire(import.meta.url)
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    try { await promisify(execFile)(require('electron') as string, [script], { cwd: directory, env, windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 }) }
    catch (error) { throw new Error(`${await readFile(resultPath, 'utf8').catch(() => 'No fixture result')}\n${String(error)}`) }
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({ combinations: 4, downloads: 8, cancels: 4, checks: 0, realDom: true, externalRequests: 0 })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-update-panel-test-') || await realpath(directory) !== directory) throw new Error('Unsafe update fixture cleanup boundary')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
