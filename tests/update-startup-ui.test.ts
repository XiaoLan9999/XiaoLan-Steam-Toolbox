import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('confirms startup only after the actual App has committed a valid snapshot and cancels confirmation on failure or unmount', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-update-ui-test-')))
  try {
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RendererErrorBoundary } from './src/renderer/src/components/RendererErrorBoundary';
import { initialUpdateState, DEFAULT_UPDATE_PREFERENCES } from './src/shared/update-types';
window.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
const originalTimeout = window.setTimeout.bind(window);
const originalClearTimeout = window.clearTimeout.bind(window);
const requestedDelays = [];
const healthTimers = new Map();
let nextHealthTimer = 1000000000;
window.setTimeout = (callback, delay, ...args) => {
  if (delay === 5000) { requestedDelays.push(delay); const id = nextHealthTimer++; healthTimers.set(id, () => callback(...args)); return id; }
  return originalTimeout(callback, delay, ...args);
};
window.clearTimeout = id => { if (!healthTimers.delete(id)) originalClearTimeout(id); };
const confirmGrace = async () => { const callbacks = [...healthTimers.values()]; healthTimers.clear(); await act(async () => { callbacks.forEach(callback => callback()); }); };
const sleep = milliseconds => new Promise(resolve => originalTimeout(resolve, milliseconds));
let confirmations = 0, resolveSnapshot;
let snapshotOperation = new Promise(resolve => { resolveSnapshot = resolve; });
window.steamCommenter = {
  getSnapshot: () => snapshotOperation,
  onEvent: () => () => undefined,
  confirmUpdateStartup: async () => { confirmations++; return { ok: true }; }
};
const valid = { accounts: [], activeAccountId: null, friends: [], friendRemovals: [], friendNameChanges: [],
  groups: [], emoticons: [], settings: null, batches: [], activeBatch: null, friendPolicies: [], commentScan: null,
  dataDirectory: 'synthetic', language: 'en', theme: 'dark', energySavingEnabled: false, energySavingActive: false,
  updater: initialUpdateState('0.16.18', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
  security: { secretStorageAvailable: true, secretStorageBackend: 'synthetic' } };
window.exercise = async () => {
  const App = (await import('./src/renderer/src/App')).default;
  const paint = async root => { await act(async () => { root.render(<RendererErrorBoundary><App /></RendererErrorBoundary>); }); };
  let root = createRoot(document.getElementById('root'), { onCaughtError: () => undefined });
  await paint(root);
  check(document.querySelector('.loading-screen'), 'Loading interface failed before receiving a snapshot');
  await act(async () => { await sleep(55); });
  check(confirmations === 0, 'Loading without a snapshot must not confirm update health');
  await act(async () => { resolveSnapshot({ ok: true, data: valid }); });
  check(document.querySelector('.app-shell') && confirmations === 0, 'The interface must commit before the grace timer confirms: ' + document.body.textContent.slice(0, 100));
  await confirmGrace();
  check(confirmations === 1 && requestedDelays.length === 1, 'Healthy committed startup must confirm once after the five-second grace');
  await act(async () => root.unmount());
  snapshotOperation = Promise.resolve({ ok: true, data: { ...valid, security: null } });
  root = createRoot(document.getElementById('root'), { onCaughtError: () => undefined });
  await paint(root);
  await act(async () => { await sleep(55); });
  await confirmGrace();
  check(document.querySelector('.renderer-failure-screen') && confirmations === 1, 'A renderer failure must preserve rollback materials');
  await act(async () => root.unmount());
  snapshotOperation = Promise.resolve({ ok: true, data: valid });
  root = createRoot(document.getElementById('root'), { onCaughtError: () => undefined });
  await paint(root);
  await act(async () => root.unmount());
  await confirmGrace();
  check(confirmations === 1, 'Unmounting before the grace period must cancel confirmation');
  return { confirmations, loadingPreserved: true, errorPreserved: true, unmountPreserved: true, graceMs: requestedDelays[0] };
};
`, resolveDir: resolve('.'), sourcefile: 'update-startup-ui-fixture.tsx', loader: 'tsx' },
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' } })
    await writeFile(join(directory, 'index.html'), '<html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
    await writeFile(join(directory, 'fixture.cjs'), `
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync(join(__dirname,'profile'));
app.setName('XiaoLan isolated startup UI fixture');
app.setPath('appData',join(__dirname,'profile')); app.setPath('userData',join(__dirname,'profile'));
const timeout=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel: !/^(file:|data:|blob:)/.test(details.url)}));
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  try {
    await win.loadFile(join(__dirname,'index.html'));
    const result=await win.webContents.executeJavaScript('window.exercise()');
    writeFileSync(join(__dirname,'result.json'),JSON.stringify(result));
  } catch(error) { writeFileSync(join(__dirname,'failure.txt'),String(error)); app.exitCode=1; }
  finally { win.destroy(); clearTimeout(timeout); app.exit(app.exitCode||0); }
});`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await run(createRequire(import.meta.url)('electron') as string, [join(directory, 'fixture.cjs')],
      { cwd: resolve('.'), env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 }).catch(async () => {
      throw new Error(await readFile(join(directory, 'failure.txt'), 'utf8').catch(() => 'Isolated startup UI fixture failed'))
    })
    expect(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))).toEqual({ confirmations: 1,
      loadingPreserved: true, errorPreserved: true, unmountPreserved: true, graceMs: 5000 })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-update-ui-test-') || await realpath(directory) !== directory) throw new Error('Unsafe startup fixture cleanup')
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
