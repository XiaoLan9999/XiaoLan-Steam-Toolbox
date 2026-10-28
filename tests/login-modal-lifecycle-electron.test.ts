import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('exercises real React login lifetimes and diagnostic controls offline in an isolated Electron renderer', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-login-lifecycle-test-')))
  try {
    const renderer = join(directory, 'renderer.js')
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LoginModal } from './src/renderer/src/components/LoginModal';
import { SettingsModal } from './src/renderer/src/components/SettingsModal';
import { I18nProvider } from './src/renderer/src/i18n';
import { initialUpdateState, DEFAULT_UPDATE_PREFERENCES } from './src/shared/update-types';
import './src/renderer/src/styles.css';
import './src/renderer/src/theme.css';
window.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ok = data => ({ ok: true, data });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const qrResult = id => ok({ loginId: id, mode: 'qr', actionRequired: true, guardTypes: [], qrChallengeUrl: 'https://example.invalid/fixture/' + id });
const snapshot = language => ({ accounts: [], activeAccountId: null, friends: [], friendRemovals: [], friendNameChanges: [], groups: [], emoticons: [], settings: null, batches: [], activeBatch: null, friendPolicies: [], commentScan: null, dataDirectory: 'D:/SyntheticData', language, theme: document.documentElement.dataset.theme,
  updater: initialUpdateState('0.16.7', 'portable'), updatePreferences: DEFAULT_UPDATE_PREFERENCES, security: { secretStorageAvailable: true, secretStorageBackend: 'fixture' } });
let root;
async function fixture(language = 'en', theme = 'light') {
  if (root) await act(async () => root.unmount());
  document.documentElement.dataset.theme = theme;
  document.getElementById('root').replaceChildren();
  root = createRoot(document.getElementById('root'));
  const requests = [], exports = [], cancellations = [], listeners = new Set();
  let closeCalls = 0, credentialCalls = 0, directoryCalls = 0, successCalls = 0;
  let open = true, screen = 'login';
  window.fixtureQr = () => Promise.resolve(image);
  window.steamCommenter = {
    startQrLogin: () => { const next = pending(); requests.push(next); return next.promise; },
    startCredentialsLogin: () => { credentialCalls++; throw new Error('Credential requests are forbidden in this fixture'); },
    submitSteamGuard: () => { throw new Error('Guard requests are forbidden in this fixture'); },
    cancelLogin: async id => { cancellations.push(id); return ok(undefined); },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    exportDiagnosticLogs: () => { const next = pending(); exports.push(next); return next.promise; },
    openDiagnosticsDirectory: async () => { directoryCalls++; return ok(undefined); }
  };
  const paint = async () => { await act(async () => root.render(<I18nProvider language={language}>{screen === 'login'
    ? <LoginModal open={open} onClose={() => { closeCalls++; }} onSuccess={async () => { successCalls++; }} />
    : <SettingsModal snapshot={snapshot(language)} onClose={() => { closeCalls++; }} runAction={async (_label, action) => action()} />}</I18nProvider>)); };
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  const click = async label => { const node = button(label); check(node, 'Missing button: ' + label); await act(async () => node.click()); };
  const emit = async event => { await act(async () => { for (const listener of listeners) listener(event); }); };
  const resolveQr = async (index, id) => { check(requests[index], 'Missing QR request ' + index); await act(async () => requests[index].resolve(qrResult(id))); };
  const resolveExport = async (index, value) => { check(exports[index], 'Missing export request ' + index); await act(async () => exports[index].resolve(value)); };
  await paint();
  return { requests, exports, cancellations, button, click, emit, resolveQr, resolveExport, text: () => document.body.textContent,
    async setOpen(value) { open = value; await paint(); }, async settings() { open = false; screen = 'settings'; await paint(); },
    counts: () => ({ closeCalls, credentialCalls, directoryCalls, successCalls }),
    hasQr: () => !!document.querySelector('.qr-frame img'),
    async destroy() { await act(async () => root.unmount()); root = null; }
  };
}
window.runFixture = async () => {
  const checkpoints = [];
  let f = await fixture();
  await f.resolveQr(0, 'failed-qr');
  check(f.hasQr(), 'Initial QR image missing');
  await f.emit({ type: 'authRemoteInteraction', loginId: 'failed-qr' });
  check(f.text().includes('Scanned'), 'Scan status not rendered');
  await f.emit({ type: 'authFailed', loginId: 'failed-qr', message: 'Synthetic ECONNRESET' });
  check(!f.hasQr(), 'Failed QR must disappear');
  check(f.text().includes('previous QR code is no longer valid'), 'Failure must explain the old code is invalid');
  check(!f.text().includes('Loading QR code'), 'Failure must not fall back to a loading status');
  check(f.requests.length === 1 && f.counts().credentialCalls === 0, 'Failure must not retry or read credentials');
  await f.click('Export diagnostic logs');
  check(f.button('Exporting diagnostic logs…').disabled, 'Log export must be busy');
  await f.click('Exporting diagnostic logs…');
  check(f.exports.length === 1, 'Duplicate log export escaped the single-flight gate');
  await f.resolveExport(0, ok(null));
  check(!document.querySelector('.diagnostic-export-error'), 'Save cancellation is not an export error');
  check(f.text().includes('Synthetic ECONNRESET'), 'Cancellation hid the original login error');
  await f.click('Export diagnostic logs');
  await f.resolveExport(1, { ok: false, error: { code: 'SYNTHETIC_EXPORT_FAILURE', message: 'Synthetic export denied' } });
  check(f.text().includes('Synthetic ECONNRESET') && f.text().includes('Synthetic export denied'), 'Export error replaced the login error');
  await f.click('Export diagnostic logs');
  await f.resolveExport(2, ok({ path: 'D:/Fixture/login-diagnostics.json', records: 7 }));
  check(f.text().includes('7 diagnostic records') && f.text().includes('D:/Fixture/login-diagnostics.json'), 'Log export result must show count and path');
  await f.click('Account & password');
  check(document.querySelector('input[type=password]'), 'authFailed must clear the stale auth object');
  checkpoints.push('auth-failure-and-login-export');

  f = await fixture();
  await f.click('Close');
  check(f.counts().closeCalls === 1, 'Close must remain available while QR IPC is pending');
  await f.setOpen(false);
  await f.setOpen(true);
  await f.resolveQr(1, 'reopened-qr');
  await f.resolveQr(0, 'closed-late-qr');
  check(f.cancellations.includes('closed-late-qr'), 'A late closed QR session must be cancelled');
  check(f.hasQr(), 'Late IPC from a closed generation replaced the reopened UI');
  await f.emit({ type: 'authFailed', loginId: 'closed-late-qr', message: 'STALE_FAILURE' });
  check(!f.text().includes('STALE_FAILURE'), 'Old generation events contaminated the reopened login');
  await f.emit({ type: 'authRemoteInteraction', loginId: 'reopened-qr' });
  check(f.text().includes('Scanned'), 'Reopened session lost ownership');
  checkpoints.push('close-reopen-late-ipc');

  f = await fixture();
  await f.click('Account & password');
  await f.resolveQr(0, 'mode-late-qr');
  check(f.cancellations.includes('mode-late-qr'), 'A late mode-switch QR session must be cancelled');
  check(document.querySelector('input[type=password]') && !f.hasQr(), 'Late QR response contaminated credentials mode');
  check(!f.button('Continue').disabled, 'Late QR finalizer left the credentials mode busy');
  await f.click('Scan QR code');
  check(f.requests.length === 2, 'Only explicit QR switching should start another request');
  const pixels = pending(); window.fixtureQr = () => pixels.promise;
  await f.resolveQr(1, 'pending-pixels');
  await f.click('Account & password');
  await act(async () => pixels.resolve(image));
  check(f.cancellations.includes('pending-pixels'), 'Switching during QR rendering did not cancel the session');
  check(document.querySelector('input[type=password]') && !document.querySelector('.confirmation-wait'), 'Late QR rendering retained an auth object in credentials mode');
  check(f.counts().credentialCalls === 0, 'Mode switching must not submit credentials');
  checkpoints.push('mode-switch-late-ipc-and-pixels');

  f = await fixture();
  const failingPixels = pending(); window.fixtureQr = () => failingPixels.promise;
  await f.resolveQr(0, 'failed-during-pixels');
  await f.emit({ type: 'authFailed', loginId: 'failed-during-pixels', message: 'Synthetic first-poll failure' });
  await act(async () => failingPixels.resolve(image));
  check(!f.hasQr() && f.text().includes('previous QR code is no longer valid'), 'QR rendering completed after authFailed and revived an invalid code');
  checkpoints.push('failure-during-qr-render');

  for (const language of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
    f = await fixture(language, theme);
    await f.settings();
    const exportLabel = language === 'en' ? 'Export diagnostic logs' : '导出诊断日志';
    const directoryLabel = language === 'en' ? 'Open log directory' : '打开日志目录';
    check(f.text().includes(language === 'en' ? 'sign-in stages' : '登录阶段'), 'Missing diagnostic coverage explanation');
    check(f.text().includes(language === 'en' ? 'not be shared as logs' : '不要当作日志分享'), 'Missing backup privacy warning');
    check(f.text().includes(language === 'en' ? 'not automatically uploaded' : '不会自动上传'), 'Missing manual submission boundary');
    await f.click(exportLabel);
    check(f.button(directoryLabel).disabled, 'Diagnostic actions must be single flight');
    await f.resolveExport(0, ok(null));
    check(!document.querySelector('.diagnostic-export-error'), 'Settings treated save cancellation as an error');
    await f.click(exportLabel);
    await f.resolveExport(1, ok({ path: 'D:/Fixture/settings-diagnostics.json', records: 13 }));
    check(f.text().includes('13') && f.text().includes('D:/Fixture/settings-diagnostics.json'), 'Settings export omitted records or path');
    const output = document.querySelector('.diagnostic-export-result');
    check(getComputedStyle(output).color === (theme === 'dark' ? 'rgb(139, 209, 165)' : 'rgb(52, 118, 83)'), 'Export success uses the wrong theme palette');
    await f.click(directoryLabel);
    check(f.counts().directoryCalls === 1, 'Open directory must use the diagnostic bridge');
    await f.click(exportLabel);
    await f.resolveExport(2, { ok: false, error: { code: 'SYNTHETIC_EXPORT_FAILURE', message: 'Synthetic export failure' } });
    const failure = document.querySelector('.diagnostic-export-error');
    check(failure && getComputedStyle(failure).color === (theme === 'dark' ? 'rgb(242, 155, 152)' : 'rgb(179, 72, 70)'), 'Export failure uses the wrong theme palette');
    checkpoints.push('settings-' + language + '-' + theme);
  }
  await f.destroy();
  return { checkpoints, realReact: true, realDom: true, realAccounts: false, automaticRetries: false };
};
`, resolveDir: resolve('.'), loader: 'tsx' }, outfile: renderer, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent', plugins: [{ name: 'offline-qr-pixels', setup(builder) {
        builder.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qrcode', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default { toDataURL: (...args) => window.fixtureQr(...args) }' }))
      } }] })
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>', 'utf8')
    await writeFile(script, String.raw`
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
const output = ${JSON.stringify(result)};
const requests = [];
let window;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:|^wss?:/i.test(details.url)) { requests.push(details.url); done({ cancel: true }); } else done({});
  });
  window = new BrowserWindow({ show: false, width: 1080, height: 900, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  const result = await window.webContents.executeJavaScript('window.runFixture()');
  if (requests.length) throw new Error('Offline fixture attempted network access');
  writeFileSync(output, JSON.stringify({ ...result, externalRequests: requests.length }));
  window.destroy(); app.quit();
}).catch(error => { writeFileSync(output, JSON.stringify({ failure: error.stack || String(error), requests })); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
`, 'utf8')
    const require = createRequire(import.meta.url)
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      await run(require('electron') as string, [script], { cwd: dirname(script), env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 })
    } catch (error) {
      const progress = await readFile(result, 'utf8').catch(() => 'No fixture result')
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${progress}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(result, 'utf8'))).toMatchObject({ realReact: true, realDom: true, realAccounts: false,
      automaticRetries: false, externalRequests: 0, checkpoints: ['auth-failure-and-login-export', 'close-reopen-late-ipc',
        'mode-switch-late-ipc-and-pixels', 'failure-during-qr-render', 'settings-zh-CN-light', 'settings-zh-CN-dark', 'settings-en-light', 'settings-en-dark'] })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-login-lifecycle-test-') ||
        await realpath(directory) !== directory) throw new Error('Unsafe login fixture cleanup boundary')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
