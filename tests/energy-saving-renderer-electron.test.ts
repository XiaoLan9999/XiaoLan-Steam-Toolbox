import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('pauses owned visual work and coalesces background App updates without touching task or account APIs', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-energy-renderer-test-')))
  const resultPath = join(directory, 'result.json')
  try {
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRendererEnergySaver, isEnergySavingActive, subscribeEnergySaving } from './src/renderer/src/energy-saving';
import './src/renderer/src/energy-saving.css';
import { initialUpdateState, DEFAULT_UPDATE_PREFERENCES } from './src/shared/update-types';
window.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.syntheticVisibility || 'visible' });
const check = (value, message) => { if (!value) throw new Error(message); };
const flush = async () => { await Promise.resolve(); await new Promise(done => setTimeout(done, 0)); };
window.exercise = async () => {
  const visual = document.createElement('div');
  document.body.append(visual);
  const running = visual.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: Infinity });
  const userPaused = visual.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(5px)' }], { duration: 10000, iterations: Infinity });
  userPaused.pause();
  await Promise.all([running.ready, userPaused.ready]);
  const media = (playing, src) => {
    const element = document.createElement('video');
    element.setAttribute('src', src);
    let paused = !playing, pauses = 0, plays = 0;
    Object.defineProperty(element, 'paused', { get: () => paused });
    Object.defineProperty(element, 'ended', { get: () => false });
    element.pause = () => { paused = true; pauses++; };
    element.play = () => { paused = false; plays++; return Promise.reject(new Error('Synthetic autoplay denial')); };
    document.body.append(element);
    return { element, counts: () => ({ pauses, plays }) };
  };
  const playing = media(true, 'data:video/mp4,synthetic-playing');
  const alreadyPaused = media(false, 'data:video/mp4,synthetic-paused');
  const changed = media(true, 'data:video/mp4,synthetic-before');
  const disconnected = media(true, 'data:video/mp4,synthetic-disconnected');
  const states = [];
  const unsubscribe = subscribeEnergySaving(active => states.push(active));
  const saver = createRendererEnergySaver();
  saver.update(true, true);
  check(isEnergySavingActive() && running.playState === 'paused', 'Running animation did not pause');
  check(userPaused.playState === 'paused', 'An originally paused animation changed');
  check(playing.counts().pauses === 1 && alreadyPaused.counts().pauses === 0, 'Media ownership is incorrect');
  check(document.documentElement.dataset.energySaving === 'active', 'Background CSS gate is missing');
  const late = media(true, 'data:video/mp4,synthetic-late');
  await flush();
  check(late.counts().pauses === 1, 'New background media was not paused');
  changed.element.setAttribute('src', 'data:video/mp4,synthetic-after');
  disconnected.element.remove();
  saver.update(true, true);
  check(playing.counts().pauses === 1, 'Repeated background notification paused media twice');
  saver.update(true, false);
  await flush();
  check(!isEnergySavingActive() && running.playState === 'running', 'Owned animation did not resume');
  check(userPaused.playState === 'paused', 'User-paused animation was restarted');
  check(playing.counts().plays === 1 && late.counts().plays === 1, 'Owned media was not restored exactly once');
  check(alreadyPaused.counts().plays === 0 && changed.counts().plays === 0 && disconnected.counts().plays === 0, 'Unowned or changed media was restarted');
  check(!document.documentElement.hasAttribute('data-energy-saving'), 'Background CSS gate did not restore');
  window.syntheticVisibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  check(isEnergySavingActive(), 'Document visibility did not activate saving');
  saver.update(false, true);
  check(!isEnergySavingActive(), 'Disabling the mode must remove extra restrictions');
  saver.dispose(); unsubscribe();
  running.cancel(); userPaused.cancel();
  for (const element of [visual, playing.element, alreadyPaused.element, changed.element, late.element]) element.remove();
  window.syntheticVisibility = 'visible';
  const listeners = new Set();
  let snapshots = 0, taskCalls = 0, heldSnapshot = null;
  const snapshot = {
    accounts: [], activeAccountId: null, friends: [], friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [],
    settings: null, batches: [], activeBatch: null, friendPolicies: [], commentScan: null, dataDirectory: 'synthetic-test',
    language: 'en', theme: 'light', updater: initialUpdateState('0.16.12', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES,
    energySavingEnabled: true, energySavingActive: false, security: { secretStorageAvailable: false, secretStorageBackend: 'synthetic' }
  };
  window.steamCommenter = {
    getSnapshot: async () => { snapshots++; return heldSnapshot ? heldSnapshot : { ok: true, data: structuredClone(snapshot) }; },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    gameStatus: {},
    pauseBatch: () => { taskCalls++; throw new Error('Energy saver must not pause a task'); },
    cancelBatch: () => { taskCalls++; throw new Error('Energy saver must not cancel a task'); },
    activateAccount: () => { taskCalls++; throw new Error('Energy saver must not switch an account'); }
  };
  const { default: App } = await import('./src/renderer/src/App');
  const appRoot = createRoot(document.getElementById('root'));
  await act(async () => { appRoot.render(<App />); await flush(); });
  check(snapshots === 1 && document.body.textContent.includes('Settings'), 'App fixture did not load one initial snapshot');
  const emit = async event => { await act(async () => { for (const listener of [...listeners]) listener(event); await flush(); }); };
  await emit({ type: 'energySavingChanged', enabled: true, active: true });
  check(isEnergySavingActive(), 'Main background event was not applied');
  await act(async () => {
    for (let index = 0; index < 500; index++) for (const listener of [...listeners]) {
      listener({ type: 'snapshotChanged' });
      listener({ type: 'batchProgress', batchId: 'synthetic', summary: null });
      listener({ type: 'friendPolicyChanged', policy: { accountId: 'synthetic' } });
      listener({ type: 'updateChanged', state: snapshot.updater });
    }
    await flush();
  });
  check(snapshots === 1, 'Background state events repeatedly loaded a large snapshot');
  await emit({ type: 'notice', level: 'warning', message: 'Synthetic background notice is preserved' });
  check(document.body.textContent.includes('Synthetic background notice is preserved'), 'A background notice was lost');
  snapshot.updater = { ...snapshot.updater, phase: 'available', latestVersion: '0.16.13' };
  await emit({ type: 'energySavingChanged', enabled: true, active: false });
  check(!isEnergySavingActive() && snapshots === 2, 'Restoring the window must perform exactly one merged refresh');
  check(document.querySelector('.update-sidebar-badge'), 'Restore did not refresh the latest update badge');
  let releaseSnapshot;
  heldSnapshot = new Promise(done => { releaseSnapshot = done; });
  await emit({ type: 'snapshotChanged' });
  check(snapshots === 3, 'Did not begin the controlled in-flight snapshot');
  await emit({ type: 'energySavingChanged', enabled: true, active: true });
  await emit({ type: 'energySavingChanged', enabled: true, active: false });
  check(!isEnergySavingActive(), 'Foreground signal did not wake the renderer');
  heldSnapshot = null;
  await act(async () => {
    releaseSnapshot({ ok: true, data: { ...snapshot, energySavingActive: true } });
    await flush();
  });
  check(!isEnergySavingActive() && snapshots === 4, 'A late background snapshot reversed restore or failed to converge with one fresh read');
  check(taskCalls === 0, 'Visual saving called a task or account operation');
  await act(async () => appRoot.unmount());
  check(listeners.size === 0 && !isEnergySavingActive(), 'Unmount leaked event listeners or saving state');
  return { mediaOwnership: true, animationOwnership: true, backgroundEvents: 2000, snapshots, staleSnapshotSafe: true,
    restoredOnce: true, taskCalls, realReact: true, realDom: true, transitions: states };
};
`, resolveDir: resolve('.'), loader: 'tsx' }, outfile: join(directory, 'renderer.js'), bundle: true,
      platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
    const script = join(directory, 'fixture.cjs')
    await writeFile(script, `
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
let window; let requests = 0;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:|^wss?:/i.test(details.url)) { requests++; done({ cancel: true }); } else done({});
  });
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true,
    nodeIntegration: false, backgroundThrottling: false } });
  await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  const result = await window.webContents.executeJavaScript('window.exercise()');
  if (requests) throw new Error('Renderer fixture accessed external networking');
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ...result, requests }));
  window.destroy(); app.quit();
}).catch(error => { writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: error.stack || String(error), requests })); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
`)
    const require = createRequire(import.meta.url)
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    try {
      await run(require('electron') as string, [script], { cwd: directory, env, windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 })
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${await readFile(resultPath, 'utf8').catch(() => 'No renderer result')}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({ mediaOwnership: true, animationOwnership: true,
      backgroundEvents: 2000, snapshots: 4, staleSnapshotSafe: true, restoredOnce: true, taskCalls: 0, realReact: true, realDom: true, requests: 0 })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-energy-renderer-test-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe renderer fixture cleanup')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
