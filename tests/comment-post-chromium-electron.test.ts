import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('sends generated comments over Chromium and distinguishes HTTP failures from truncated response bodies offline', async () => {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-comment-post-chromium-')))
  try {
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await mkdir(join(directory, 'profile'))
    await build({ stdin: { contents: String.raw`
import { app, net, session } from 'electron';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SteamCommunityClient } from './src/main/community-client';
import { createSteamNetworkFetch } from './src/main/steam-network-fetch';
app.setPath('userData', join(__dirname, 'profile'));
app.setPath('sessionData', join(__dirname, 'profile'));
const account = '76561198000000001', friend = '76561198000000002';
const message = 'Synthetic comment :star13: + & = ' + String.fromCodePoint(0x4e2d, 0x6587);
const csrf = 'synthetic-csrf';
const secure = account + '%7C%7Csynthetic-token';
const requests = [], diagnostics = [], sockets = new Set();
let server, isolated, mode = 'success', blocked = 0, phase = 'initial';
const timer = setTimeout(() => {
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, timedOut: true, phase, requests, diagnostics }));
  app.exit(1);
}, 50000);
const cleanup = async () => {
  if (isolated) await isolated.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
};
app.whenReady().then(async () => {
  try {
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('error', () => {});
      request.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const path = new URL(request.url, 'http://127.0.0.1').pathname;
          requests.push({ method: request.method, path, contentType: request.headers['content-type'] || null,
            cookie: request.headers.cookie || null, body: raw });
          assert.ok(request.headers.cookie.includes('steamLoginSecure=' + secure));
          assert.ok(request.headers.cookie.includes('sessionid=' + csrf));
          assert.ok(!request.headers.cookie.includes('sentinel'));
          if (request.method === 'GET') assert.equal(request.headers['x-requested-with'], undefined);
          if (request.method === 'GET' && path === '/profiles/' + account + '/edit/info') {
            response.setHeader('Content-Type', 'text/html; charset=UTF-8');
            response.end('<script>g_steamID="' + account + '";</script>');
          } else if (request.method === 'GET' && path === '/profiles/' + friend + '/') {
            response.setHeader('Content-Type', 'text/html; charset=UTF-8');
            response.end('<script>g_steamID="' + account + '";</script>' +
              '<div id="commentthread_Profile_' + friend + '_area" class="commentthread_area">' +
              '<div id="commentthread_Profile_' + friend + '_posts" class="commentthread_comments"></div></div>');
          } else if (request.method === 'POST' && path === '/comment/Profile/post/' + friend + '/-1/') {
            assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
            assert.equal(request.headers['x-requested-with'], 'XMLHttpRequest');
            const form = new URLSearchParams(raw);
            assert.deepEqual(Object.fromEntries(form), { comment: message, count: '6', sessionid: csrf, feature2: '-1' });
            response.setHeader('Content-Type', 'application/json; charset=UTF-8');
            if (mode === 'truncated') {
              response.statusCode = 200;
              response.setHeader('Content-Length', 131072);
              response.flushHeaders();
              response.write('{"success":true,"comments_html":"' + 'x'.repeat(65536));
              setTimeout(() => response.destroy(), 350);
              return;
            }
            if (mode === 'http502') {
              response.statusCode = 502;
              response.end(JSON.stringify({ success: 2, error: 'Synthetic upstream gateway failure' }));
              return;
            }
            if (mode === 'forbidden') response.statusCode = 403;
            response.end(JSON.stringify(mode === 'success'
              ? { success: true, comments_html: '<div id="comment_42"></div>' }
              : { success: 2, error: 'The settings on this account do not allow you to add comments.' }));
          } else { response.statusCode = 500; response.end('Unexpected synthetic route'); }
        } catch (error) { response.statusCode = 500; response.end(String(error)); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    isolated = session.fromPartition('comment-post-' + process.pid, { cache: false });
    await isolated.setProxy({ mode: 'direct' });
    for (const context of [isolated, session.defaultSession]) context.webRequest.onBeforeRequest((details, done) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) blocked++;
      done({ cancel: !allowed });
    });
    await isolated.cookies.set({ url: origin, name: 'isolated_sentinel', value: 'synthetic-jar' });
    const fetch = createSteamNetworkFetch(options => {
      const logical = new URL(options.url);
      assert.equal(logical.origin, 'https://steamcommunity.com');
      const headers = { ...options.headers };
      // Only the loopback fixture changes origin: production keeps official HTTPS headers.
      if (headers.origin) headers.origin = origin;
      if (headers.referer) headers.referer = origin + logical.pathname;
      return net.request({ ...options, url: origin + logical.pathname + logical.search, headers, session: isolated });
    });
    const community = new SteamCommunityClient(account, [
      'steamLoginSecure=' + secure + '; Path=/; Secure; Domain=steamcommunity.com',
      'sessionid=' + csrf + '; Path=/; Secure; Domain=steamcommunity.com'
    ], () => { throw new Error('Synthetic session must remain authenticated'); }, event => diagnostics.push(event), fetch);
    phase = 'verify';
    await community.verifySession();
    phase = 'success-post';
    const success = await community.postProfileComment(friend, message);
    assert.equal(success.commentId, '42');
    const outcomes = [{ mode, status: 'success', commentId: success.commentId }];
    for (mode of ['denied', 'forbidden', 'http502', 'truncated']) {
      phase = mode + '-post';
      const postsBefore = requests.filter(row => row.method === 'POST').length;
      let rejected;
      try { await community.postProfileComment(friend, message); }
      catch (error) { rejected = { code: error.code || null, message: error.message }; }
      assert.ok(rejected, 'A rejected comment must not report success');
      assert.equal(requests.filter(row => row.method === 'POST').length, postsBefore + 1, 'A failed comment must never be automatically retried');
      outcomes.push({ mode, status: 'rejected', ...rejected });
    }
    assert.equal(requests.filter(row => row.method === 'POST').length, 5);
    assert.equal(blocked, 0);
    assert.equal(diagnostics.filter(row => row.reason === 'transport-error').length, 0);
    const httpFailure = diagnostics.find(row => row.reason === 'http-error');
    assert.ok(httpFailure, 'An observed HTTP 502 needs an HTTP error diagnostic');
    assert.equal(httpFailure.requestStage, 'validation');
    assert.equal(httpFailure.httpStatus, 502);
    assert.equal(httpFailure.endpoint, 'profile-comment');
    assert.equal(httpFailure.method, 'POST');
    assert.equal(httpFailure.networkCode, undefined);
    const readFailure = diagnostics.find(row => row.reason === 'response-read-error');
    assert.ok(readFailure, 'A truncated observed HTTP 200 needs a response-read diagnostic');
    assert.equal(readFailure.requestStage, 'body');
    assert.equal(readFailure.httpStatus, 200);
    assert.equal(readFailure.endpoint, 'profile-comment');
    assert.equal(readFailure.method, 'POST');
    for (const failure of [httpFailure, readFailure]) assert.ok(failure.elapsedMs >= 0 && failure.elapsedMs <= 600000);
    await cleanup();
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: true, realCommunityClient: true,
      realChromium: true, urlEncodedFormCorrect: true, smallJsonRead: true,
      cookieCorrect: true, externalRequests: blocked, postCount: 5, outcomes, diagnostics }));
    clearTimeout(timer); app.quit();
  } catch (error) {
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, phase, error: error.stack || String(error),
      requests, diagnostics, externalRequests: blocked }));
    await cleanup().catch(() => {}); clearTimeout(timer); app.exit(1);
  }
});
`, resolveDir: resolve('.'), sourcefile: 'comment-post-fixture.ts', loader: 'ts' },
      outfile: script, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      banner: { js: `module.paths.unshift(${JSON.stringify(resolve('node_modules'))});` } })
    await writeFile(join(directory, 'fixture-marker.txt'), 'synthetic-only')
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    try {
      await run(createRequire(import.meta.url)('electron') as string, [script], {
        cwd: directory, env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 1_048_576
      })
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string }
      throw new Error(`${await readFile(result, 'utf8').catch(() => 'Missing fixture result')}\n${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    }
    const value = JSON.parse(await readFile(result, 'utf8')) as Record<string, unknown>
    expect(value).toMatchObject({ passed: true, realCommunityClient: true, realChromium: true,
      urlEncodedFormCorrect: true, smallJsonRead: true, cookieCorrect: true, externalRequests: 0, postCount: 5 })
    expect(value.outcomes).toEqual([
      { mode: 'success', status: 'success', commentId: '42' },
      expect.objectContaining({ mode: 'denied', status: 'rejected', code: 'COMMENT_TARGET_UNAVAILABLE' }),
      expect.objectContaining({ mode: 'forbidden', status: 'rejected', code: 'COMMENT_POST_UNCERTAIN' }),
      expect.objectContaining({ mode: 'http502', status: 'rejected', code: null, message: 'Steam HTTP error 502' }),
      expect.objectContaining({ mode: 'truncated', status: 'rejected', code: null, message: 'Steam response interrupted' })
    ])
    expect(value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'http-error', requestStage: 'validation', httpStatus: 502,
        method: 'POST', endpoint: 'profile-comment' }),
      expect.objectContaining({ reason: 'response-read-error', requestStage: 'body', httpStatus: 200,
        method: 'POST', endpoint: 'profile-comment' })
    ]))
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-comment-post-chromium-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe comment fixture cleanup')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 75_000)
