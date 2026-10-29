import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)

async function electronFixture(source: string): Promise<Record<string, unknown>> {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-steam-network-')))
  try {
    const script = join(directory, 'fixture.cjs')
    const result = join(directory, 'result.json')
    await mkdir(join(directory, 'profile'))
    await build({ stdin: { contents: source, resolveDir: resolve('.'), sourcefile: 'steam-network-fixture.ts', loader: 'ts' },
      outfile: script, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      banner: { js: `module.paths.unshift(${JSON.stringify(resolve('node_modules'))});` } })
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
    return JSON.parse(await readFile(result, 'utf8')) as Record<string, unknown>
  } finally {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-steam-network-') ||
      await realpath(directory) !== directory) throw new Error('Unsafe network fixture cleanup')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

it('sends explicit synthetic cookies but no session-jar cookies with real Chromium credentials omitted', async () => {
  const result = await electronFixture(String.raw`
import { app, net, session } from 'electron';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
app.setPath('userData', join(__dirname, 'profile'));
app.setPath('sessionData', join(__dirname, 'profile'));
const timer = setTimeout(() => app.exit(1), 50000);
const sockets = new Set();
let server;
app.whenReady().then(async () => {
  try {
    let received;
    server = createServer((request, response) => {
      received = request.headers.cookie;
      response.end('synthetic-response');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = 'http://127.0.0.1:' + address.port + '/cookie';
    const isolated = session.fromPartition('steam-network-cookie-' + process.pid, { cache: false });
    await isolated.setProxy({ mode: 'direct' });
    let blocked = 0;
    for (const context of [isolated, session.defaultSession]) context.webRequest.onBeforeRequest((details, done) => {
      const target = new URL(details.url);
      const allowed = target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.port === String(address.port);
      if (!allowed) blocked++;
      done({ cancel: !allowed });
    });
    await isolated.cookies.set({ url, name: 'isolated_sentinel', value: 'synthetic-isolated-secret' });
    await session.defaultSession.cookies.set({ url, name: 'default_sentinel', value: 'synthetic-default-secret' });
    const manual = 'sessionid=synthetic-manual-session; steamLoginSecure=76561198000000001%7C%7Csynthetic-token';
    const body = await new Promise((resolve, reject) => {
      const request = net.request({ url, method: 'GET', session: isolated, credentials: 'omit', useSessionCookies: false,
        headers: { Cookie: manual } });
      request.on('response', response => {
        const data = [];
        response.on('data', chunk => data.push(chunk));
        response.on('end', () => resolve(Buffer.concat(data).toString('utf8')));
        response.on('error', reject);
      });
      request.on('error', reject); request.end();
    });
    assert.equal(body, 'synthetic-response');
    assert.equal(received, manual);
    assert.equal(blocked, 0);
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: true, explicitCookieSent: true, jarCookiesExcluded: true, externalRequests: blocked }));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(timer); app.quit();
  } catch (error) {
    for (const socket of sockets) socket.destroy(); server?.close(); clearTimeout(timer);
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: error.stack || String(error) }));
    app.exit(1);
  }
});
`)
  expect(result).toEqual({ passed: true, explicitCookieSent: true, jarCookiesExcluded: true, externalRequests: 0 })
}, 75_000)

it('completes an actual SDK and Community login over the real Chromium adapter using synthetic loopback responses only', async () => {
  const result = await electronFixture(String.raw`
import { app, net, session } from 'electron';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { EAuthSessionGuardType } from 'steam-session';
import { SteamService } from './src/main/steam-service';
import { SqliteStore } from './src/main/store';
import { createSteamNetworkFetch } from './src/main/steam-network-fetch';
app.setPath('userData', join(__dirname, 'profile'));
app.setPath('sessionData', join(__dirname, 'profile'));
const timer = setTimeout(() => app.exit(1), 50000);
const sockets = new Set();
const requests = [], events = [], diagnostics = [], nativeErrors = [], blockedUrls = [], startedRequests = [];
const account = '76561198000000001';
const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub: account, aud: ['derive', 'web'], exp: 4000000000 })).toString('base64url'),
  Buffer.from('synthetic-signature-not-a-real-token').toString('base64url')].join('.');
const integer = value => {
  const data = [];
  do { data.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  return Buffer.from(data);
};
const bytes = (field, value) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([integer((field << 3) | 2), integer(data.length), data]);
};
const interval = Buffer.alloc(5); interval[0] = 0x25; interval.writeFloatLE(5, 1);
const qr = Buffer.concat([Buffer.from([8,123]), bytes(2, 'https://example.invalid/synthetic-qr'),
  bytes(3, Buffer.from([1,2,3])), interval, bytes(5, Buffer.from([8,EAuthSessionGuardType.DeviceConfirmation]))]);
const poll = Buffer.concat([bytes(3, token), Buffer.from([0x28,1]), bytes(6,'synthetic-user')]);
const cipher = { isAvailable: () => true, backend: () => 'synthetic-test',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString('utf8') };
let server, store, service, reopened, blocked = 0, disposed = 0, verificationStarted = 0;
const cleanup = async () => {
  service?.dispose(); store?.close(); store = undefined; reopened?.close(); reopened = undefined;
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
};
app.whenReady().then(async () => {
  try {
    server = createServer((request, response) => {
      startedRequests.push(request.url);
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk)); request.on('error', () => {});
      request.on('end', () => {
        const target = new URL(request.url, 'http://127.0.0.1');
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ path: target.pathname, headers: request.headers, body: raw });
        const json = (value, headers = {}) => { response.writeHead(200, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
        if (target.pathname === '/api/IAuthenticationService/BeginAuthSessionViaQR/v1/') {
          response.writeHead(200, { 'x-eresult': '1', 'content-type': 'application/octet-stream' }); response.end(qr);
        } else if (target.pathname === '/api/IAuthenticationService/PollAuthSessionStatus/v1/') {
          response.writeHead(200, { 'x-eresult': '1', 'content-type': 'application/octet-stream' }); response.end(poll);
        } else if (target.pathname === '/login/jwt/finalizelogin') {
          assert.ok(raw.includes(token));
          json({ steamID: account, transfer_info: [
            { url: 'https://store.steampowered.com/login/settoken', params: { nonce: 'synthetic-store', auth: 'synthetic-store-auth' } },
            { url: 'https://steamcommunity.com/login/settoken', params: { nonce: 'synthetic-community', auth: 'synthetic-community-auth' } }
          ] });
        } else if (target.pathname === '/community/login/settoken') {
          assert.ok(raw.includes(account));
          json({ result: 1 }, { 'set-cookie': [
            'steamLoginSecure=' + account + '%7C%7Csynthetic-community-cookie; Path=/; Secure; HttpOnly; Domain=steamcommunity.com; Expires=Tue, 01 Jan 2030 00:00:00 GMT',
            'sessionid=synthetic-server-session; Path=/; Secure; Domain=steamcommunity.com'
          ] });
        } else if (target.pathname === '/community/profiles/' + account + '/edit/info') {
          assert.ok(request.headers.cookie.includes('steamLoginSecure=' + account + '%7C%7Csynthetic-community-cookie'));
          assert.ok(/(?:^|; )sessionid=[a-f0-9]{24}(?:;|$)/.test(request.headers.cookie));
          assert.ok(!request.headers.cookie.includes('sentinel') && !request.headers.cookie.includes('synthetic-server-session'));
          verificationStarted = performance.now();
          response.writeHead(200, { 'content-type': 'text/html' });
          // Cross the SDK's normal two-second post-auth transport close without stopping Community work.
          setTimeout(() => response.end('<script>g_steamID="' + account + '";</script>'), 2100);
        } else if (target.searchParams.get('xml') === '1') {
          response.writeHead(200, { 'content-type': 'text/xml' });
          response.end('<profile><steamID64>' + account + '</steamID64><steamID>Synthetic Chromium fixture</steamID><onlineState>online</onlineState></profile>');
        } else if (target.pathname === '/community/textfilter/ajaxgetfriendslist') json({ success: 1, friendslist: { friends: [] } });
        else if (target.pathname === '/community/actions/EmoticonList') json([]);
        else { response.writeHead(500); response.end('Unexpected synthetic route'); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const isolated = session.fromPartition('steam-network-full-' + process.pid, { cache: false });
    await isolated.setProxy({ mode: 'direct' });
    for (const context of [isolated, session.defaultSession]) context.webRequest.onBeforeRequest((details, done) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) { blocked++; blockedUrls.push(details.url); }
      done({ cancel: !allowed });
    });
    await isolated.cookies.set({ url: origin, name: 'isolated_sentinel', value: 'synthetic-isolated-secret' });
    await session.defaultSession.cookies.set({ url: origin, name: 'default_sentinel', value: 'synthetic-default-secret' });
    const pendingRequests = new Set();
    const fetch = createSteamNetworkFetch(options => {
      const logical = new URL(options.url);
      const prefix = logical.hostname === 'api.steampowered.com' ? '/api'
        : logical.hostname === 'login.steampowered.com' ? '/login'
        : logical.hostname === 'steamcommunity.com' ? '/community' : null;
      assert.ok(prefix, 'Non-official hostname attempted');
      const headers = { ...options.headers };
      // Match only the test-owned HTTP origin when rewriting the official HTTPS destination.
      if (headers.origin) headers.origin = origin;
      if (headers.referer) headers.referer = origin + '/';
      const request = net.request({ ...options, headers, url: origin + prefix + logical.pathname + logical.search, session: isolated });
      request.on('error', error => nativeErrors.push(String(error)));
      pendingRequests.add(request); request.on('close', () => pendingRequests.delete(request));
      return request;
    });
    globalThis.fetch = async () => { throw new Error('Node fetch is forbidden in the Chromium login fixture'); };
    http.request = () => { throw new Error('Node HTTP is forbidden in the Chromium login fixture'); };
    https.request = () => { throw new Error('Node HTTPS is forbidden in the Chromium login fixture'); };
    const path = join(__dirname, 'synthetic.sqlite3');
    store = new SqliteStore(path, cipher);
    let finishedResolve, finishedReject;
    const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
    service = new SteamService(store, event => {
      events.push(event);
      if (event.type === 'authFinished') finishedResolve(event);
      if (event.type === 'authFailed') finishedReject(new Error(event.message));
    }, () => {}, {
      createNetwork: () => ({ fetch, transport: 'chromium', dispose: () => {
        disposed++;
        for (const request of pendingRequests) request.abort();
      } }),
      onLoginDiagnostic: event => diagnostics.push(event)
    });
    const login = await service.startQrLogin();
    assert.equal(login.qrChallengeUrl, 'https://example.invalid/synthetic-qr');
    const complete = await finished;
    assert.equal(complete.accountId, account);
    assert.ok(performance.now() - verificationStarted >= 2000);
    assert.equal(disposed, 0);
    assert.deepEqual(events.filter(event => ['authCompleting','authFinished'].includes(event.type)).map(event => event.type), ['authCompleting','authFinished']);
    assert.equal(service.isAuthenticated(account), true);
    assert.equal(store.getAccounts().length, 1);
    assert.equal(store.getAccount(account).displayName, 'Synthetic Chromium fixture');
    assert.equal(store.getRefreshToken(account), token);
    assert.ok(diagnostics.some(event => event.stage === 'session-verify' && event.outcome === 'success' && event.transport === 'chromium'));
    assert.ok(diagnostics.some(event => event.stage === 'completed' && event.transport === 'chromium'));
    assert.ok(diagnostics.filter(event => event.stage === 'request').every(event => event.transport === 'chromium'));
    assert.equal(blocked, 0);
    assert.ok(requests.some(row => row.path.endsWith('/edit/info')));
    assert.ok(!requests.some(row => row.path.includes('store.steampowered.com')));
    assert.ok(!JSON.stringify(diagnostics).includes(token));
    await new Promise(resolve => setTimeout(resolve, 100));
    service.dispose(); assert.equal(disposed, 1); service = undefined;
    store.close(); store = undefined;
    reopened = new SqliteStore(path, cipher);
    assert.equal(reopened.getAccounts().length, 1);
    assert.equal(reopened.getRefreshToken(account), token);
    await cleanup();
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: true, actualSdk: true,
      actualCommunityClient: true, actualChromiumTransport: true, identityVerified: true,
      accountPersisted: true, chromiumDiagnostics: true, sdkCloseDidNotAbortCommunity: true, externalRequests: blocked }));
    clearTimeout(timer); app.quit();
  } catch (error) {
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: error.stack || String(error),
      requestPaths: requests.map(row => row.path), startedRequests, blockedUrls, nativeErrors,
      loginStages: diagnostics.map(row => [row.stage,row.outcome,row.endpoint,row.networkCode]) }));
    await cleanup().catch(() => {}); clearTimeout(timer); app.exit(1);
  }
});
`)
  expect(result).toEqual({ passed: true, actualSdk: true, actualCommunityClient: true,
    actualChromiumTransport: true, identityVerified: true, accountPersisted: true,
    chromiumDiagnostics: true, sdkCloseDidNotAbortCommunity: true, externalRequests: 0 })
}, 75_000)

it('uses real Chromium for multipart, response cookies, redirects, proxy routing and cancellation without external networking', async () => {
  const result = await electronFixture(String.raw`
import { app, net, session } from 'electron';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createSteamNetworkFetch } from './src/main/steam-network-fetch';
app.setPath('userData', join(__dirname, 'profile'));
app.setPath('sessionData', join(__dirname, 'profile'));
let phase = 'initial';
const progress = value => { phase = value; writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ phase })); };
const timer = setTimeout(() => {
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, phase, timedOut: true }));
  app.exit(1);
}, 50000);
const sockets = new Set();
const requests = [];
let server, proxy;
const cleanup = async () => {
  for (const socket of sockets) socket.destroy();
  for (const instance of [proxy, server]) if (instance) await new Promise(resolve => instance.close(resolve));
};
app.whenReady().then(async () => {
  try {
    const manual = 'sessionid=synthetic-manual-session; steamLoginSecure=76561198000000001%7C%7Csynthetic-token';
    const cookies = [
      'steamLoginSecure=76561198000000001%7C%7Csynthetic-response; Path=/; Secure; Expires=Tue, 01 Jan 2030 00:00:00 GMT',
      'sessionid=synthetic-response-session; Path=/; Secure; Expires=Tue, 01 Jan 2030 00:00:00 GMT'
    ];
    let blocked = 0, proxyHits = 0, stallClosed;
    const stallClosedPromise = new Promise(resolve => { stallClosed = resolve; });
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('error', () => {});
      request.on('end', () => {
        requests.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (request.url === '/stall') {
          request.socket.once('close', () => stallClosed(true));
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.flushHeaders();
          response.write('synthetic-start' + 'x'.repeat(65536));
        } else if (request.url === '/redirect') {
          response.writeHead(302, { Location: '/redirect-target' }); response.end();
        } else if (request.url === '/transfer') {
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
          response.end('{"result":1}');
        } else {
          response.writeHead(200, { 'content-type': 'text/plain' }); response.end('synthetic-response');
        }
      });
    });
    const own = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
    server.on('connection', own);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    proxy = createServer((request, response) => {
      proxyHits++;
      let target;
      try { target = new URL(request.url); assert.equal(target.origin, origin); }
      catch { response.writeHead(502); response.end(); return; }
      const forward = httpRequest(target, { method: request.method, headers: request.headers, agent: false }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      });
      forward.on('error', () => { response.writeHead(502); response.end(); });
      request.pipe(forward);
    });
    proxy.on('connection', own);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const isolated = session.fromPartition('steam-network-real-' + process.pid, { cache: false });
    await isolated.setProxy({ mode: 'direct' });
    const guard = (details, done) => {
      const target = new URL(details.url);
      const allowed = target.origin === origin;
      if (!allowed) blocked++;
      done({ cancel: !allowed });
    };
    isolated.webRequest.onBeforeRequest(guard);
    session.defaultSession.webRequest.onBeforeRequest(guard);
    await isolated.cookies.set({ url: origin, name: 'isolated_sentinel', value: 'synthetic-isolated-secret' });
    await session.defaultSession.cookies.set({ url: origin, name: 'default_sentinel', value: 'synthetic-default-secret' });
    const factoryCalls = [];
    const fetch = createSteamNetworkFetch(options => {
      const logical = new URL(options.url);
      assert.ok(['api.steampowered.com', 'login.steampowered.com', 'steamcommunity.com'].includes(logical.hostname));
      assert.equal(logical.protocol, 'https:');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.useSessionCookies, false);
      factoryCalls.push({ url: logical.href, method: options.method });
      const path = logical.pathname.endsWith('/stall') ? '/stall'
        : logical.pathname.endsWith('/redirect') ? '/redirect'
        : logical.pathname.endsWith('/settoken') ? '/transfer'
        : logical.hostname === 'api.steampowered.com' ? '/multipart' : '/cookie';
      // Only this test-owned factory rewrites destinations; the adapter still validates official logical URLs.
      return net.request({ ...options, url: origin + path, session: isolated });
    });
    const profile = 'https://steamcommunity.com/profiles/76561198000000001/';
    progress('cookie');
    const cookieResponse = await fetch(profile, { credentials: 'omit', redirect: 'error', headers: { Cookie: manual } });
    assert.equal(await cookieResponse.text(), 'synthetic-response');
    assert.equal(cookieResponse.url, profile);
    assert.equal(requests[0].headers.cookie, manual);
    assert.ok(!requests[0].headers.cookie.includes('sentinel'));

    const form = new FormData();
    progress('multipart');
    form.set('input_protobuf_encoded', 'AQIDBA==');
    form.set('nonce', 'synthetic-nonce');
    const apiUrl = 'https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaQR/v1/';
    const multipart = await fetch(apiUrl, { method: 'POST', body: form, credentials: 'omit', redirect: 'error' });
    await multipart.text();
    assert.equal(multipart.url, apiUrl);
    const posted = requests.find(row => row.path === '/multipart');
    assert.equal(posted.method, 'POST');
    const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(posted.headers['content-type']);
    assert.ok(match);
    const boundary = match[1] || match[2];
    assert.ok(posted.body.includes('--' + boundary + '\r\n'));
    assert.ok(posted.body.includes('name="input_protobuf_encoded"\r\n\r\nAQIDBA==\r\n'));
    assert.ok(posted.body.includes('name="nonce"\r\n\r\nsynthetic-nonce\r\n'));
    assert.ok(posted.body.includes('--' + boundary + '--'));

    const transferUrl = 'https://steamcommunity.com/login/settoken';
    progress('transfer');
    const transfer = await fetch(transferUrl, { method: 'POST', body: new URLSearchParams({ nonce: 'synthetic-nonce' }), redirect: 'error' });
    assert.equal(transfer.url, transferUrl);
    assert.deepEqual(transfer.headers.getSetCookie(), cookies);
    assert.deepEqual(await transfer.json(), { result: 1 });

    const redirectUrl = profile + 'redirect';
    progress('redirects');
    const manualRedirect = await fetch(redirectUrl, { redirect: 'manual' });
    assert.equal(manualRedirect.status, 302);
    assert.equal(manualRedirect.headers.get('location'), '/redirect-target');
    assert.equal(manualRedirect.url, redirectUrl);
    await manualRedirect.body?.cancel();
    await assert.rejects(fetch(redirectUrl, { redirect: 'error' }));
    assert.equal(requests.filter(row => row.path === '/redirect').length, 2);
    assert.equal(requests.filter(row => row.path === '/redirect-target').length, 0);

    const controller = new AbortController();
    progress('cancel');
    const stalled = await fetch(profile + 'stall', { redirect: 'error', signal: controller.signal });
    progress('cancel-response');
    const reader = stalled.body.getReader();
    assert.ok(new TextDecoder().decode((await reader.read()).value).startsWith('synthetic-start'));
    progress('cancel-first-data');
    const waiting = reader.read();
    controller.abort();
    progress('cancel-aborted');
    await assert.rejects(waiting);
    progress('cancel-reader-rejected');
    assert.equal(await Promise.race([stallClosedPromise, new Promise(resolve => setTimeout(() => resolve(false), 5000))]), true);

    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:' + proxy.address().port, proxyBypassRules: '<-loopback>' });
    progress('proxy');
    const proxied = await fetch(profile, { redirect: 'error', credentials: 'omit', headers: { Cookie: manual } });
    await proxied.text();
    assert.equal(proxyHits, 1);
    assert.equal(requests.at(-1).headers.cookie, manual);
    assert.equal(blocked, 0);
    assert.equal(factoryCalls.length, 7);
    progress('cleanup');
    await cleanup();
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: true, multipart: true, explicitCookieSent: true,
      jarCookiesExcluded: true, responseCookieValues: 2, redirectsNotFollowed: true, abortClosedSocket: true,
      isolatedProxyHonored: true, externalRequests: blocked }));
    clearTimeout(timer); app.quit();
  } catch (error) {
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, phase, error: error.stack || String(error), requestPaths: requests.map(row => row.path) }));
    await cleanup().catch(() => {}); clearTimeout(timer);
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: error.stack || String(error), requestPaths: requests.map(row => row.path) }));
    app.exit(1);
  }
});
`)
  expect(result).toEqual({ passed: true, multipart: true, explicitCookieSent: true,
    jarCookiesExcluded: true, responseCookieValues: 2, redirectsNotFollowed: true, abortClosedSocket: true,
    isolatedProxyHonored: true, externalRequests: 0 })
}, 75_000)
