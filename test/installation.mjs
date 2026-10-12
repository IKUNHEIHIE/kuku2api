import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStaticUi } from '../src/static-ui.mjs';
import { createApp } from '../src/server.mjs';
import { installOptions, supportedNode, availablePort, choosePort } from '../scripts/install.mjs';
import { directEnvironment } from '../scripts/start.mjs';
import { installerLanguage } from '../scripts/install-language.mjs';
import { listenPort, listenHost, savedListenPort } from '../src/listen-port.mjs';
import { consoleAddress } from '../scripts/install-output.mjs';
import { openDatabase } from '../src/database.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-install-test-'));
  mkdirSync(path.join(root, 'ui/dist/assets'), { recursive: true });
  writeFileSync(path.join(root, 'ui/dist/index.html'), '<html>test console</html>');
  writeFileSync(path.join(root, 'ui/dist/assets/main-a123.js'), 'console.log("test")');
  writeFileSync(path.join(root, 'ui/dist/.env'), 'must never be served');
  return root;
}
async function http(app, fn) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('installer accepts supported Node versions and rejects old or malformed versions', () => {
  for (const v of ['24.15.0','24.16.1','26.4.0','v24.15.0']) assert.equal(supportedNode(v), true);
  for (const v of ['24.14.9','22.99.0','24','invalid']) assert.equal(supportedNode(v), false);
  assert.deepEqual(installOptions(['--backend-only','--no-start']), { start: false, ui: false, dependencies: true });
  assert.throws(() => installOptions(['--delete-data']), /Unknown/);
});

test('launcher disables every case of upstream proxy variables without changing operator authentication', () => {
  const input = { HTTPS_PROXY:'private', http_proxy:'private', All_Proxy:'private', NODE_USE_ENV_PROXY:'1', ADMIN_TOKEN:'test-explicit', API_KEYS:'test-key', PORT:'9999' };
  const out = directEnvironment(input);
  assert.equal(out.NODE_USE_ENV_PROXY, '0');
  assert.equal(Object.keys(out).some(k => /^(http|https|all)_proxy$/i.test(k)), false);
  assert.equal(out.ADMIN_TOKEN, input.ADMIN_TOKEN); assert.equal(out.API_KEYS, input.API_KEYS);
  assert.equal(input.HTTPS_PROXY, 'private');
});

test('console address uses the public IPv4, tolerates discovery failure and respects explicit bindings', async () => {
  const interfaces = { eth0: [{ address: '10.0.0.7', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] };
  const options = { host: '0.0.0.0', interfaces };
  assert.equal(await consoleAddress(8789, { ...options, request: async () => new Response('203.0.113.8\n') }), 'http://203.0.113.8:8789');
  const requested = [];
  assert.equal(await consoleAddress(8789, { ...options, request: async url => {
    requested.push(url); return new Response(url.includes('169.254.169.254') ? '203.0.113.9' : '203.0.113.8');
  } }), 'http://203.0.113.9:8789');
  assert.deepEqual(requested, ['http://169.254.169.254/latest/meta-data/public-ipv4']);
  assert.equal(await consoleAddress(8789, { ...options, request: async url => new Response(url.includes('169.254.169.254') ? '' : '203.0.113.8') }), 'http://203.0.113.8:8789');
  for (const request of [async () => { throw new Error('offline'); }, async () => new Response('<html>proxy error</html>'), async () => new Response('203.0.113.8', { status: 503 })]) {
    assert.equal(await consoleAddress(8789, { ...options, request }), 'http://10.0.0.7:8789');
  }
  const request = async () => { throw new Error('explicit bindings must not discover a different address'); };
  assert.equal(await consoleAddress(8789, { host: '127.0.0.1', request }), 'http://127.0.0.1:8789');
  assert.equal(await consoleAddress(8789, { host: '::1', request }), 'http://[::1]:8789');
  for (const host of ['0.0.0.0', '::', '127.0.0.1', '192.168.1.2']) assert.equal(listenHost(host), host);
  for (const host of ['localhost', 'http://127.0.0.1', '', null]) assert.throws(() => listenHost(host), /LISTEN_HOST/);
});

test('a publicly bound backend requires a model key even before the first key is created', async () => {
  const pool = { accounts: [], sessions: new Map(), pick: () => null };
  await http(createApp({ pool, adminToken: 'test-admin', allowUnkeyedModels: false }), async base => {
    assert.equal((await fetch(base + '/pool/state')).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { 'x-admin-token': 'test-admin' } })).status, 401);
    const state = await fetch(base + '/pool/state', { headers: { 'x-admin-token': 'test-admin' } });
    assert.equal(state.status, 200); assert.equal((await state.json()).api_open, false);
    const headers = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' };
    assert.equal((await (await fetch(base + '/pool/admin/keys', { headers })).json()).open, false);
    const issued = await (await fetch(base + '/pool/admin/keys', { method: 'POST', headers, body: JSON.stringify({ label: 'test-public-key' }) })).json();
    assert.equal((await fetch(base + '/v1/models', { headers: { 'x-api-key': issued.key.secret } })).status, 200);
    const revoked = await (await fetch(base + '/pool/admin/keys/' + issued.key.id, { method: 'DELETE', headers })).json();
    assert.equal(revoked.api_now_unauthenticated, false);
    assert.equal((await fetch(base + '/v1/models')).status, 401);
  });
});

test('quiet installation persists public listening and only prints the two requested Chinese lines', async () => {
  const root = fixture();
  try {
    for (const directory of ['src', 'scripts']) cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'kuku2api', type: 'module' }));
    // Avoid external IP discovery while exercising the default public binding.
    const preload = path.join(root, 'offline-ip.mjs');
    writeFileSync(preload, "globalThis.fetch = async () => new Response('203.0.113.8');");
    const env = directEnvironment({ ...process.env, KUKU_INSTALLER_QUIET: '1', KUKU_INSTALLER_SUMMARY: undefined, LISTEN_HOST: undefined, ADMIN_TOKEN: '', DATABASE_FILE: path.join(root, 'data/kukuai.sqlite') });
    const invoke = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'scripts/install.mjs'), '--backend-only', '--no-start', '--port', '19876', '--lang', 'zh'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    const first = invoke(); assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^控制台地址：http:\/\/203\.0\.113\.8:19876\r?\n管理员密钥：kuku-admin-[A-Za-z0-9_-]{43}\r?\n$/);
    const db = openDatabase({ root, file: env.DATABASE_FILE });
    try { assert.equal(db.store('installation').load().host, '0.0.0.0'); } finally { db.close(); }
    const second = invoke(); assert.equal(second.status, 0, second.stderr); assert.equal(second.stdout, first.stdout);
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], { cwd: root, env: { ...env, KUKU_INSTALLER_QUIET: undefined, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Public backend did not start')), 10000);
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Public backend exited before listening')); });
        child.stdout.on('data', data => { if (data.toString().includes(`http://0.0.0.0:${port}`)) { clearTimeout(timer); resolve(); } });
      });
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
      const token = first.stdout.match(/kuku-admin-[A-Za-z0-9_-]{43}/)[0];
      assert.equal((await fetch(`http://127.0.0.1:${port}/pool/state`, { headers: { 'x-admin-token': token } })).status, 200);
    } finally {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer detects occupied and invalid ports without disturbing the running service', async () => {
  await http((_req, res) => res.end('alive'), async base => {
    await assert.rejects(availablePort(Number(new URL(base).port)), /in use/);
    await assert.rejects(availablePort(new URL(base).port, 'zh'), /端口.*无法使用/);
    assert.equal(await (await fetch(base)).text(), 'alive');
  });
  await assert.rejects(availablePort(0), /PORT/);
});

test('unattended installation chooses a free port on conflict but respects an explicit port', async () => {
  const checked = [], warnings = [];
  const check = async port => { checked.push(port); if (port === 8787 || port === 8788) throw new Error('in use'); };
  assert.equal(await choosePort({ envPort: undefined, interactive: false, autoAvailable: true, check, warn: message => warnings.push(message) }), 8789);
  assert.deepEqual(checked, [8787, 8788, 8789]); assert.match(warnings[0], /8789/);
  assert.equal(await choosePort({ envPort: undefined, interactive: true, autoAvailable: true, check, warn() {}, ask: async prompt => { assert.match(prompt, /8789/); return ''; } }), 8789);
  await assert.rejects(choosePort({ port: 8787, interactive: false, autoAvailable: true, check }), /in use/);
  assert.equal(await choosePort({ envPort: '65535', interactive: false, autoAvailable: true, check: async p => { if (p === 65535) throw new Error('in use'); }, warn() {} }), 1024);
});

test('production console, SPA routes and hashed assets work with API keys enabled; API authentication stays enforced', async () => {
  const root = fixture();
  try {
    const app = createApp({ pool:{}, apiKeys:['test-required-key'], adminToken:'test-admin', uiDirectory:path.join(root,'ui/dist') });
    await http(app, async base => {
      for (const p of ['/', '/users', '/settings']) {
        const res = await fetch(base+p); assert.equal(res.status, 200); assert.match(await res.text(), /test console/);
        assert.equal(res.headers.get('cache-control'), 'no-cache');
      }
      const asset = await fetch(base+'/assets/main-a123.js');
      assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
      assert.match(asset.headers.get('cache-control'), /immutable/);
      const head = await fetch(base+'/users', {method:'HEAD'});
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal((await fetch(base+'/pool/state')).status, 401);
      assert.equal((await fetch(base+'/pool/admin/accounts')).status, 401);
      assert.equal((await fetch(base+'/v1/responses')).status, 401);
      assert.equal((await fetch(base+'/healthz')).status, 200);
    });
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('static handler refuses missing assets, source paths, dotfiles, encoded escapes and non-GET requests', async () => {
  const root = fixture();
  const serve = createStaticUi(path.join(root,'ui/dist'));
  try {
    for (const url of ['/assets/missing.js','/src/server.mjs','/data/kukuai.sqlite','/.env','/%2eenv','/foo%5c..%5c.env','/v1%2fmodels','/pool/state','/%00','/%zz']) {
      assert.equal(await serve({ method:'GET', url }, {}), false, url);
    }
    assert.equal(await serve({method:'POST',url:'/users'}, {}), false);
    assert.equal(await createStaticUi(path.join(root,'absent'))({method:'GET',url:'/'}, {}), false);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('fresh offline installation initializes SQLite once, preserves accounts/settings and never repeats the strong token', () => {
  const root = fixture();
  try {
    cpSync(path.join(ROOT,'src'), path.join(root,'src'), {recursive:true});
    cpSync(path.join(ROOT,'scripts'), path.join(root,'scripts'), {recursive:true});
    writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'kuku2api',version:'0.2.0',type:'module'}));
    const env = directEnvironment({ ...process.env, PORT: undefined, ADMIN_TOKEN:'', DATABASE_FILE:path.join(root,'data/kukuai.sqlite') });
    const invoke = (...args) => spawnSync(process.execPath, [path.join(root,'scripts/install.mjs'),'--backend-only','--no-start','--lang','zh', ...args], {cwd:root,env,encoding:'utf8'});
    const first = invoke('--port', '19876'); assert.equal(first.status, 0, 'Fresh install must succeed');
    assert.match(first.stdout, /kuku2api 0\.2\.0 安装完成/);
    const tokens = first.stdout.match(/kuku-admin-[A-Za-z0-9_-]{43}/g) ?? [];
    assert.equal(tokens.length, 1); assert.match(first.stdout, /保存/);
    assert.equal(savedListenPort(root, env.DATABASE_FILE), 19876);
    const db = new DatabaseSync(env.DATABASE_FILE);
    db.prepare('INSERT INTO accounts VALUES (?,?)').run('fixture-account', JSON.stringify({id:'fixture-account'}));
    db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('installation-test', JSON.stringify({preserved:true}));
    db.close();
    const second = invoke(); assert.equal(second.status, 0);
    assert.match(second.stdout, /127\.0\.0\.1:19876/);
    assert.equal(second.stdout.includes(tokens[0]), false, 'Saved token must not be printed again');
    const restored = new DatabaseSync(env.DATABASE_FILE);
    try {
      assert.equal(restored.prepare('SELECT count(*) n FROM accounts').get().n, 1);
      assert.equal(JSON.parse(restored.prepare('SELECT value FROM settings WHERE key=?').get('installation-test').value).preserved, true);
      assert.equal(Object.values(restored.prepare('PRAGMA integrity_check').get())[0], 'ok');
    } finally { restored.close(); }
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('installer selects language from Chinese time zones rather than a shared UTC offset', () => {
  for (const zone of ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei', 'PRC', 'China Standard Time', 'Taipei Standard Time']) {
    assert.equal(installerLanguage('auto', zone), 'zh', zone);
  }
  for (const zone of ['Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'UTC', '']) assert.equal(installerLanguage('auto', zone), 'en', zone);
  assert.equal(installerLanguage('en', 'Asia/Shanghai'), 'en');
  assert.equal(installerLanguage('zh', 'UTC'), 'zh');
  assert.throws(() => installerLanguage('invalid'), /--lang/);
});

test('installer flags accept explicit ports and reject missing, fractional or unsafe input', () => {
  assert.equal(installOptions(['--port', '12345', '--lang', 'en']).port, 12345);
  assert.equal(installOptions(['--lang', 'zh']).lang, 'zh');
  for (const value of ['0', '65536', '-1', '1.2', '1e3', '', ' ', 'Infinity']) assert.throws(() => listenPort(value), /PORT/);
  for (const args of [['--port'], ['--lang'], ['--port', '--no-start'], ['--lang', 'fr']]) assert.throws(() => installOptions(args));
});

test('interactive port selection retries invalid and occupied ports without touching running services', async () => {
  const answers = ['not-a-port', '19998', '19999'];
  const warnings = [], checked = [], prompts = [];
  const port = await choosePort({ interactive: true, envPort: undefined, savedPort: 19876, language: 'zh',
    ask: async prompt => { prompts.push(prompt); return answers.shift(); }, warn: text => warnings.push(text),
    check: async value => { checked.push(value); if (value === 19998) throw new Error('占用'); },
  });
  assert.equal(port, 19999); assert.deepEqual(checked, [19998, 19999]);
  assert.equal(warnings.length, 2); assert.match(warnings[0], /整数/); assert.match(prompts[0], /19876/);
});

test('port defaults, explicit flags and non-interactive installs never wait for input', async () => {
  const ask = async () => { throw new Error('must not prompt'); };
  const check = async () => {};
  assert.equal(await choosePort({ port: 19001, envPort: '19002', savedPort: 19003, interactive: true, ask, check }), 19001);
  assert.equal(await choosePort({ envPort: '19002', savedPort: 19003, interactive: false, ask, check }), 19002);
  assert.equal(await choosePort({ envPort: undefined, savedPort: 19003, interactive: false, ask, check }), 19003);
  assert.equal(await choosePort({ envPort: undefined, interactive: false, ask, check }), 8787);
  assert.equal(await choosePort({ envPort: undefined, savedPort: 19003, interactive: true, ask: async () => '', check }), 19003);
  assert.equal(await choosePort({ port: 19001, start: false, check: async () => { throw new Error('must not check availability'); } }), 19001);
  await assert.rejects(choosePort({ port: 19001, check: async () => { throw new Error('in use'); } }), /in use/);
});

test('timezone language and explicit override apply to token reminders in non-interactive installation', () => {
  const root = fixture();
  try {
    cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    cpSync(path.join(ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'kuku2api', type: 'module' }));
    for (const [zone, override, expected] of [['Asia/Shanghai', null, '首次初始化'], ['America/New_York', null, 'Save this token'], ['Asia/Shanghai', 'en', 'Save this token']]) {
      const file = path.join(root, `data/${override ?? zone.replaceAll('/', '-')}.sqlite`);
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--backend-only', '--no-start', ...(override ? ['--lang', override] : [])], {
        cwd: root, encoding: 'utf8', timeout: 15000, env: directEnvironment({ ...process.env, PORT: '19997', TZ: zone, ADMIN_TOKEN: '', DATABASE_FILE: file }),
      });
      assert.equal(result.status, 0); assert.match(result.stdout, new RegExp(expected));
      if (expected === 'Save this token') assert.equal(/[\u4e00-\u9fff]/u.test(result.stdout), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saved port lookup is read-only and never creates a missing database', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'data/kukuai.sqlite');
    assert.equal(savedListenPort(root, file), undefined);
    assert.equal(existsSync(file), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backend restarts use the SQLite port and allow a temporary PORT override', async () => {
  const root = fixture();
  try {
    cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    cpSync(path.join(ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'kuku2api', type: 'module' }));
    const env = directEnvironment({ ...process.env, PORT: undefined, ADMIN_TOKEN: '', AUTO_CLAIM: '0', DATABASE_FILE: path.join(root, 'data/kukuai.sqlite') });
    const savedPort = await freePort(), temporaryPort = await freePort();
    const install = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--backend-only', '--no-start', '--port', String(savedPort)], { cwd: root, env, encoding: 'utf8' });
    assert.equal(install.status, 0);
    for (const override of [undefined, String(temporaryPort)]) {
      const child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], { cwd: root, env: { ...env, PORT: override }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      try {
        const actual = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Backend did not start')), 10000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited before listening')); });
          child.stdout.on('data', data => {
            const match = /kuku2api on http:\/\/127\.0\.0\.1:(\d+)/.exec(data.toString());
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
          });
        });
        assert.equal(actual, Number(override ?? savedPort));
        assert.equal((await fetch(`http://127.0.0.1:${actual}/healthz`)).status, 200);
      } finally {
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill(); await closed;
      }
    }
    assert.equal(savedListenPort(root, env.DATABASE_FILE), savedPort);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('static files cannot escape the public directory through a symlink or Windows junction', async () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root,'private'));
    writeFileSync(path.join(root,'private/leak.js'), 'private');
    symlinkSync(path.join(root,'private'), path.join(root,'ui/dist/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await createStaticUi(path.join(root,'ui/dist'))({method:'GET',url:'/linked/leak.js'}, {}), false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('a failed console build stops installation before initializing a database or token', () => {
  const root = fixture();
  try {
    cpSync(path.join(ROOT,'src'),path.join(root,'src'),{recursive:true});
    cpSync(path.join(ROOT,'scripts'),path.join(root,'scripts'),{recursive:true});
    writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'kuku2api',type:'module'}));
    const database = path.join(root,'data/kukuai.sqlite');
    const result = spawnSync(process.execPath,[path.join(root,'scripts/install.mjs'),'--skip-dependencies','--no-start'],{
      cwd:root,encoding:'utf8',env:directEnvironment({...process.env,ADMIN_TOKEN:'',DATABASE_FILE:database}),
    });
    assert.equal(result.status,1); assert.equal(existsSync(database),false);
    assert.equal(/kuku-admin-[A-Za-z0-9_-]{43}/.test(result.stdout),false);
    const existing = openDatabase({ root, file: database });
    existing.store('installation').save({ port: 19877, other_setting: true }); existing.close();
    const retry = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--skip-dependencies', '--no-start', '--port', '19878'], {
      cwd: root, encoding: 'utf8', env: directEnvironment({ ...process.env, ADMIN_TOKEN: '', DATABASE_FILE: database }),
    });
    assert.equal(retry.status, 1);
    assert.equal(savedListenPort(root, database), 19877);
    const restored = openDatabase({ root, file: database });
    try {
      assert.equal(restored.store('installation').load().other_setting, true);
      assert.equal(restored.store('admin').load().token, undefined);
    } finally { restored.close(); }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
