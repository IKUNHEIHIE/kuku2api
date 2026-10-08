import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStaticUi } from '../src/static-ui.mjs';
import { createApp } from '../src/server.mjs';
import { installOptions, supportedNode, availablePort } from '../scripts/install.mjs';
import { directEnvironment } from '../scripts/start.mjs';

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

test('installer detects occupied and invalid ports without disturbing the running service', async () => {
  await http((_req, res) => res.end('alive'), async base => {
    await assert.rejects(availablePort(Number(new URL(base).port)), /in use/);
    assert.equal(await (await fetch(base)).text(), 'alive');
  });
  await assert.rejects(availablePort(0), /PORT/);
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
    writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'kuku2api',type:'module'}));
    const env = directEnvironment({ ...process.env, ADMIN_TOKEN:'', DATABASE_FILE:path.join(root,'data/kukuai.sqlite') });
    const invoke = () => spawnSync(process.execPath, [path.join(root,'scripts/install.mjs'),'--backend-only','--no-start'], {cwd:root,env,encoding:'utf8'});
    const first = invoke(); assert.equal(first.status, 0, 'Fresh install must succeed');
    const tokens = first.stdout.match(/kuku-admin-[A-Za-z0-9_-]{43}/g) ?? [];
    assert.equal(tokens.length, 1); assert.match(first.stdout, /保存/);
    const db = new DatabaseSync(env.DATABASE_FILE);
    db.prepare('INSERT INTO accounts VALUES (?,?)').run('fixture-account', JSON.stringify({id:'fixture-account'}));
    db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('installation-test', JSON.stringify({preserved:true}));
    db.close();
    const second = invoke(); assert.equal(second.status, 0);
    assert.equal(second.stdout.includes(tokens[0]), false, 'Saved token must not be printed again');
    const restored = new DatabaseSync(env.DATABASE_FILE);
    try {
      assert.equal(restored.prepare('SELECT count(*) n FROM accounts').get().n, 1);
      assert.equal(JSON.parse(restored.prepare('SELECT value FROM settings WHERE key=?').get('installation-test').value).preserved, true);
      assert.equal(Object.values(restored.prepare('PRAGMA integrity_check').get())[0], 'ok');
    } finally { restored.close(); }
  } finally { rmSync(root, {recursive:true,force:true}); }
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
  } finally { rmSync(root,{recursive:true,force:true}); }
});
