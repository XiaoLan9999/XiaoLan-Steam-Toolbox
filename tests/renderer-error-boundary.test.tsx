import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRendererFailure, mountRendererApp, RendererErrorBoundary, RendererFailureView,
  reportRendererEvent, reportRendererFailure
} from '../src/renderer/src/components/RendererErrorBoundary'

afterEach(() => vi.restoreAllMocks())

describe('renderer recovery boundary', () => {
  it('classifies failures without reading messages, stacks or untrusted object properties', () => {
    const sensitive = { get message(): never { throw new Error('must not read') }, get name(): never { throw new Error('must not read') } }
    expect(classifyRendererFailure('startup', sensitive)).toEqual({ stage: 'startup', category: 'unknown' })
    expect(classifyRendererFailure('render', new TypeError('private account content'))).toEqual({ stage: 'render', category: 'type-error' })
    expect(classifyRendererFailure('render', new Proxy({}, { getPrototypeOf: () => { throw new Error('untrusted prototype') } }))).toEqual({ stage: 'render', category: 'unknown' })
    for (const [error, category] of [[new ReferenceError(), 'reference-error'], [new RangeError(), 'range-error'], [new SyntaxError(), 'syntax-error'], [new Error(), 'error']] as const) {
      expect(classifyRendererFailure('render', error).category).toBe(category)
    }
  })

  it('logs only the exact safe category protocol, even when logging itself fails', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reportRendererFailure(classifyRendererFailure('render', new Error('SECRET account token')))
    reportRendererFailure(classifyRendererFailure('startup', new TypeError('SECRET local path')))
    reportRendererFailure({ stage: 'startup', category: 'bridge-unavailable' })
    reportRendererEvent('window-error')
    reportRendererEvent('unhandled-rejection')
    expect(output.mock.calls).toEqual([
      ['[toolbox-ui] render-error'], ['[toolbox-ui] startup-error'], ['[toolbox-ui] bridge-unavailable'],
      ['[toolbox-ui] window-error'], ['[toolbox-ui] unhandled-rejection']
    ])
    output.mockImplementation(() => { throw new Error('console unavailable') })
    expect(() => reportRendererFailure({ stage: 'render', category: 'error' })).not.toThrow()
  })

  it('renders bilingual recovery controls honestly without claiming background tasks were paused', () => {
    for (const language of ['zh-CN', 'en'] as const) {
      const html = renderToStaticMarkup(<RendererFailureView failure={{ stage: 'render', category: 'type-error' }} language={language} diagnostics={null} />)
      expect(html).toContain('render/type-error')
      expect(html).toContain(language === 'en' ? 'Reload interface' : '重新载入界面')
      expect(html).toContain(language === 'en' ? 'Existing background tasks may still be running' : '已有后台任务可能仍在运行')
      expect(html).toContain(language === 'en' ? 'does not create or resend comment tasks' : '不会新建或重发留言任务')
      expect(html).toContain(language === 'en' ? 'unsaved interface input' : '未保存的界面输入')
      expect(html).toContain('disabled=""')
      expect(html).not.toContain(language === 'en' ? 'Tasks are paused' : '任务已暂停')
      if (language === 'en') expect(html).not.toMatch(/\p{Script=Han}/u)
    }
    expect(renderToStaticMarkup(<RendererErrorBoundary><p>Healthy child</p></RendererErrorBoundary>)).toContain('Healthy child')
  })

  it('handles rejected module evaluation and synchronous root startup failures without retrying', async () => {
    const report = vi.fn()
    const render = vi.fn()
    const load = vi.fn(async () => { throw new SyntaxError('private module path') })
    await mountRendererApp({ render }, load, report)
    expect(load).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ stage: 'startup', category: 'syntax-error' })
    expect(renderToStaticMarkup(render.mock.calls[0]![0])).toContain('startup/syntax-error')
    const synchronousRender = vi.fn().mockImplementationOnce(() => { throw new Error('private mount data') })
    await mountRendererApp({ render: synchronousRender }, async () => ({ default: () => <p>Healthy</p> }), report)
    expect(synchronousRender).toHaveBeenCalledTimes(2)
    expect(renderToStaticMarkup(synchronousRender.mock.calls[1]![0])).toContain('startup/error')
    await mountRendererApp({ render: vi.fn() }, load, () => { throw new Error('report unavailable') })
  })
})

it('catches real React render errors and keeps explicit recovery/export controls usable offline in an isolated renderer', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-renderer-boundary-test-')))
  try {
    const renderer = join(directory, 'renderer.js')
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await build({ stdin: { contents: String.raw`
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { mountRendererApp, RendererErrorBoundary, RendererFailureView, reportRendererFailure } from './src/renderer/src/components/RendererErrorBoundary';
window.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const safeLogs = [];
const originalError = console.error;
console.error = (...values) => { safeLogs.push(values); };
const root = createRoot(document.getElementById('root'), { onCaughtError: () => undefined });
const secret = 'SYNTHETIC_PRIVATE_TOKEN_PATH_ACCOUNT';
let exports = [], reloads = 0, taskCalls = 0;
window.steamCommenter = new Proxy({ exportDiagnosticLogs: () => { const operation = pending(); exports.push(operation); return operation.promise; } }, {
  get(target, key) { if (key in target) return target[key]; taskCalls++; throw new Error('Unexpected task API: ' + key); }
});
const paint = async child => { await act(async () => root.render(child)); };
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const click = async label => { const node = button(label); check(node, 'Missing button: ' + label); await act(async () => node.click()); };
window.exercise = async () => {
  document.documentElement.lang = 'en';
  document.documentElement.dataset.theme = 'dark';
  const Throw = () => { throw new TypeError(secret); };
  await paint(<RendererErrorBoundary><Throw /></RendererErrorBoundary>);
  check(document.body.textContent.includes('interface encountered an error'), 'Real render error did not show the boundary');
  check(!document.body.textContent.includes(secret), 'Raw render error leaked into the fallback');
  check(safeLogs.length === 1 && safeLogs[0].length === 1 && safeLogs[0][0] === '[toolbox-ui] render-error', 'Render diagnostics are not the fixed safe protocol');
  check(exports.length === 0 && reloads === 0 && taskCalls === 0, 'Recovery page must not automatically export/reload/control tasks');
  check(getComputedStyle(document.querySelector('.renderer-failure-screen')).backgroundColor === 'rgb(14, 25, 35)', 'Dark recovery palette not applied');
  check(getComputedStyle(document.querySelector('.renderer-failure-card')).color === 'rgb(224, 237, 245)', 'Dark recovery text is not readable');

  await paint(<RendererFailureView language="en" failure={{ stage: 'render', category: 'type-error' }} onReload={() => { reloads++; }} />);
  const exportButton = button('Export diagnostic logs');
  await act(async () => { exportButton.click(); exportButton.click(); });
  check(exports.length === 1 && button('Exporting diagnostic logs…').disabled, 'Export is not single-flight');
  await act(async () => exports[0].resolve({ ok: false, error: { code: 'SYNTHETIC', message: secret } }));
  check(document.querySelector('[role=alert]') && !document.body.textContent.includes(secret), 'IPC failure exposed private details or hid export controls');
  await click('Export diagnostic logs');
  await act(async () => exports[1].reject(new Error(secret)));
  check(!document.body.textContent.includes(secret), 'Rejected export exposed private details');
  await click('Export diagnostic logs');
  await act(async () => exports[2].resolve({ ok: true, data: null }));
  check(!document.querySelector('[role=alert]') && !document.querySelector('[role=status]'), 'Cancelled export must not claim failure or success');
  await click('Export diagnostic logs');
  await act(async () => exports[3].resolve({ ok: true, data: { path: secret, records: 3 } }));
  check(document.querySelector('[role=status]') && !document.body.textContent.includes(secret), 'Successful export did not report completion safely');
  check(reloads === 0 && taskCalls === 0, 'Export must never trigger reloads or task actions');
  await click('Reload interface');
  check(reloads === 1 && taskCalls === 0, 'Only explicit reload is allowed, with no task actions');

  let loads = 0;
  await act(async () => mountRendererApp(root, async () => { loads++; throw new SyntaxError(secret); }));
  check(loads === 1 && document.body.textContent.includes('could not start'), 'Module startup rejection not handled');
  await new Promise(resolve => setTimeout(resolve, 25));
  check(loads === 1 && !document.body.textContent.includes(secret), 'Startup failure retried automatically or leaked details');
  check(safeLogs.some(values => values.length === 1 && values[0] === '[toolbox-ui] startup-error'), 'Startup error not reported safely');
  check(!JSON.stringify(safeLogs).includes(secret), 'Safe logs contain exception or IPC content');

  await paint(<RendererFailureView language="zh-CN" failure={{ stage: 'startup', category: 'bridge-unavailable' }} diagnostics={null} />);
  check(button('导出诊断日志').disabled && document.body.textContent.includes('诊断导出连接尚未就绪'), 'Missing bridge should disable export visibly');
  await act(async () => root.unmount());
  console.error = originalError;
  return { realRenderError: true, moduleFailure: true, darkPalette: true, explicitReloadOnly: true, exportSingleFlight: true, noTaskApiCalls: taskCalls === 0 };
};
`, resolveDir: resolve('.'), loader: 'tsx' }, outfile: renderer, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>', 'utf8')
    await build({ entryPoints: [resolve('src/renderer/src/main.tsx')], outfile: join(directory, 'bootstrap.js'),
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
      plugins: [{ name: 'offline-bootstrap-app', setup(builder) {
        builder.onResolve({ filter: /^\.\/App$/ }, args => args.importer.endsWith('main.tsx')
          ? { path: 'offline-app', namespace: 'fixture' } : null)
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
          import React from 'react';
          window.fixtureModuleLoads = (window.fixtureModuleLoads || 0) + 1;
          if (window.fixtureMode === 'module-error') throw new Error('SYNTHETIC_PRIVATE_MODULE_PATH');
          export default function App() { return <p id="healthy-bootstrap">Healthy isolated app</p>; }
        `, loader: 'tsx', resolveDir: resolve('.') }))
      } }] })
    await writeFile(join(directory, 'bootstrap-init.js'), `
      window.fixtureMode = new URL(window.location.href).searchParams.get('mode');
      window.fixtureLogs = [];
      console.error = (...values) => window.fixtureLogs.push(values);
      if (window.fixtureMode !== 'missing-bridge') window.steamCommenter = { exportDiagnosticLogs: async () => ({ ok: true, data: null }) };
    `, 'utf8')
    await writeFile(join(directory, 'bootstrap.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="bootstrap.css"></head><body><div id="root"></div><script src="bootstrap-init.js"></script><script type="module" src="bootstrap.js"></script></body></html>', 'utf8')
    await writeFile(script, String.raw`
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.setPath('sessionData', ${JSON.stringify(join(directory, 'session-data'))});
let window;
const requests = [];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:|^wss?:/i.test(details.url)) { requests.push(details.url); done({ cancel: true }); } else done({});
  });
  window = new BrowserWindow({ show: false, width: 900, height: 720, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } });
  await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  const result = await window.webContents.executeJavaScript('window.exercise()');
  const bootstrapChecks = [];
  for (const mode of ['healthy', 'missing-bridge', 'module-error']) {
    await window.loadFile(${JSON.stringify(join(directory, 'bootstrap.html'))}, { query: { mode } });
    const bootstrap = await window.webContents.executeJavaScript(
      '(async () => {' +
      'for (let attempt = 0; attempt < 100 && !document.body.textContent.trim(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));' +
      'if (window.fixtureMode === "healthy") {' +
      'window.dispatchEvent(new ErrorEvent("error", { error: new Error("SYNTHETIC_PRIVATE_WINDOW_ERROR"), message: "SYNTHETIC_PRIVATE_WINDOW_ERROR" }));' +
      'window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("SYNTHETIC_PRIVATE_REJECTION") }));' +
      '}' +
      'return { healthy: !!document.getElementById("healthy-bootstrap"), text: document.body.textContent, logs: window.fixtureLogs, loads: window.fixtureModuleLoads || 0, exportDisabled: !!document.querySelector("button:disabled") };' +
      '})()'
    );
    if (bootstrap.text.includes('SYNTHETIC_PRIVATE') || JSON.stringify(bootstrap.logs).includes('SYNTHETIC_PRIVATE')) throw new Error('Bootstrap exposed private error details');
    if (mode === 'healthy' && (!bootstrap.healthy || bootstrap.loads !== 1 || JSON.stringify(bootstrap.logs) !== JSON.stringify([['[toolbox-ui] window-error'], ['[toolbox-ui] unhandled-rejection']]))) throw new Error('Global error reporting tore down the healthy interface or did not use the safe protocol');
    if (mode === 'missing-bridge' && (bootstrap.healthy || bootstrap.loads !== 0 || !bootstrap.exportDisabled || !bootstrap.text.includes('startup/bridge-unavailable') || JSON.stringify(bootstrap.logs) !== JSON.stringify([['[toolbox-ui] bridge-unavailable']]))) throw new Error('Missing bridge bootstrap guard failed');
    if (mode === 'module-error' && (bootstrap.healthy || bootstrap.loads !== 1 || !bootstrap.text.includes('startup/error') || JSON.stringify(bootstrap.logs) !== JSON.stringify([['[toolbox-ui] startup-error']]))) throw new Error('Module evaluation failure did not reach startup recovery');
    bootstrapChecks.push(mode);
  }
  if (requests.length) throw new Error('Offline boundary fixture attempted network access');
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ...result, bootstrapChecks, externalRequests: requests.length }));
  window.destroy(); app.quit();
}).catch(error => { writeFileSync(${JSON.stringify(result)}, JSON.stringify({ failure: error.stack || String(error), requests })); if (window && !window.isDestroyed()) window.destroy(); app.exit(1); });
`, 'utf8')
    const require = createRequire(import.meta.url)
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      await promisify(execFile)(require('electron') as string, [script], { cwd: dirname(script), env: environment,
        windowsHide: true, timeout: 45_000, maxBuffer: 1_048_576 })
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${await readFile(result, 'utf8').catch(() => 'No fixture result')}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    expect(JSON.parse(await readFile(result, 'utf8'))).toEqual({ realRenderError: true, moduleFailure: true, darkPalette: true,
      explicitReloadOnly: true, exportSingleFlight: true, noTaskApiCalls: true, bootstrapChecks: ['healthy', 'missing-bridge', 'module-error'], externalRequests: 0 })
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-renderer-boundary-test-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe renderer boundary fixture cleanup boundary')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 60_000)
