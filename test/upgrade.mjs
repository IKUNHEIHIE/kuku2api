import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.mjs';
import { createApp } from '../src/server.mjs';
import { createAutoClaim } from '../src/scheduler.mjs';
import { manage, publicFiles } from '../scripts/manage.mjs';
import { installationState, runtimeAt, stopRuntime, launchVerified, samePath } from '../scripts/service.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'kuku-admin-' + 'U'.repeat(43);
const offline = ['--backend-only', '--no-start', '--lang', 'en'];
function put(root, name, text) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), text);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'kuku-upgrade-test-'));
  const root = path.join(base, 'installed'), source = path.join(base, 'staging');
  for (const target of [root, source]) {
    mkdirSync(target);
    for (const directory of ['src', 'scripts']) cpSync(path.join(ROOT, directory), path.join(target, directory), { recursive: true });
    cpSync(path.join(ROOT, 'package.json'), path.join(target, 'package.json'));
    put(target, '.gitignore', 'data/\n.runtime/\nui/dist/\n');
    put(target, 'ui/dist/index.html', target === root ? 'old console' : 'new console');
    put(target, 'src/release.txt', target === root ? 'old' : 'new');
  }
  const port = await freePort();
  const db = openDatabase({ root });
  db.store('admin').save({ token });
  db.store('installation').save({ port });
  db.store('system').save({ site_name: 'preserved' });
  db.store('accounts').save({ accounts: [] });
  db.close();
  return { base, root, source, port, file: path.join(root, 'data/kukuai.sqlite') };
}
function cleanup(base) {
  assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir()));
  assert.match(path.basename(base), /^kuku-upgrade-test-/);
  rmSync(base, { recursive: true, force: true });
}
function state(root) {
  const db = openDatabase({ root });
  try { return { admin: db.store('admin').load(), accounts: db.store('accounts').load(), system: db.store('system').load(), installation: db.store('installation').load() }; }
  finally { db.close(); }
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function gitUpdate(f) {
  git(f.root, 'init', '-q', '-b', 'main');
  git(f.root, 'config', 'user.email', 'fixture@example.invalid');
  git(f.root, 'config', 'user.name', 'Upgrade test');
  git(f.root, 'config', 'core.autocrlf', 'false');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'old');
  const previous = git(f.root, 'rev-parse', 'HEAD');
  const upstream = path.join(f.base, 'upstream');
  execFileSync('git', ['clone', '-q', f.root, upstream], { windowsHide: true, stdio: 'pipe' });
  git(upstream, 'config', 'user.email', 'fixture@example.invalid'); git(upstream, 'config', 'user.name', 'Upgrade test');
  git(upstream, 'config', 'core.autocrlf', 'false');
  for (const name of publicFiles(f.source).keys()) cpSync(path.join(f.source, name), path.join(upstream, name), { recursive: true });
  git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'new');
  git(f.root, 'remote', 'add', 'origin', upstream);
  return { previous, next: git(upstream, 'rev-parse', 'HEAD') };
}

test('upgrade file selection preserves frontend source data but excludes credentials and generated files', async () => {
  const f = await fixture();
  try {
    for (const name of ['ui/src/features/users/data/data.ts', 'ui/.env.example']) put(f.source, name, 'public');
    const privateFiles = ['ui/.env', 'ui/node_modules/pkg/index.js', 'data/secret.sqlite', 'accounts.json', 'capture/private.txt', '.runtime/private.txt', 'ui/private.db-wal', 'ui/private.sqlite.backup', 'ui/.idea/local.xml', 'ui/.github/private.yml'];
    for (const name of privateFiles) put(f.source, name, 'private');
    const files = publicFiles(f.source);
    assert(files.has('ui/src/features/users/data/data.ts')); assert(files.has('ui/.env.example'));
    for (const name of [...privateFiles, 'ui/dist/index.html']) assert.equal(files.has(name), false, name);
  } finally { cleanup(f.base); }
});

test('installation identity accepts directory aliases and Windows casing but rejects other paths', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.base, 'alias');
    symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(samePath(alias, f.root), true);
    assert.equal(samePath(f.root, f.source), false);
    assert.equal(samePath(f.file, path.join(f.source, 'package.json')), false);
    assert.equal(samePath('relative', f.root), false);
    if (process.platform === 'win32') assert.equal(samePath(f.root.toUpperCase(), f.root), true);
    await assert.rejects(manage(f.root, alias, 'upgrade', offline), /separate staging/);
  } finally { cleanup(f.base); }
});

test('archive upgrade backs up SQLite, preserves accounts/token/settings/port and removes obsolete source', async () => {
  const f = await fixture();
  try {
    const db = openDatabase({ root: f.root });
    db.store('accounts').save({ accounts: [{ id: 'fixture-account', bduss: 'fixture-cookie' }] }); db.close();
    put(f.root, 'src/obsolete.txt', 'old extension'); put(f.root, 'operator-notes.txt', 'keep');
    put(f.root, 'ui/.env', 'keep private'); put(f.source, 'src/added.txt', 'new');
    const before = state(f.root);
    const result = await manage(f.root, f.source, 'upgrade', offline);
    assert.deepEqual(state(f.root), before);
    assert.equal(readFileSync(path.join(f.root, 'src/release.txt'), 'utf8'), 'new');
    assert.equal(existsSync(path.join(f.root, 'src/obsolete.txt')), false);
    assert.equal(readFileSync(path.join(result.backupDirectory, 'source/src/obsolete.txt'), 'utf8'), 'old extension');
    assert.equal(readFileSync(path.join(f.root, 'operator-notes.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(path.join(f.root, 'ui/.env'), 'utf8'), 'keep private');
    assert(existsSync(path.join(result.backupDirectory, 'database.sqlite')));
    assert.equal(existsSync(path.join(f.root, '.runtime/maintenance.lock')), false);
  } finally { cleanup(f.base); }
});

test('an already current installation skips rebuilding and database writes', async () => {
  const f = await fixture();
  try {
    put(f.source, 'src/release.txt', 'old'); const before = readFileSync(f.file);
    const result = await manage(f.root, f.source, 'upgrade', offline, { build: () => assert.fail('unnecessary build') });
    assert.equal(result.unchanged, true); assert.deepEqual(readFileSync(f.file), before);
  } finally { cleanup(f.base); }
});

test('staging build failure leaves installed source, database and console intact', async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.file);
    await assert.rejects(manage(f.root, f.source, 'upgrade', ['--no-start'], { build: () => { throw new Error('fixture build failure'); } }), /fixture build failure/);
    assert.deepEqual(readFileSync(f.file), before);
    assert.equal(readFileSync(path.join(f.root, 'src/release.txt'), 'utf8'), 'old');
    assert.equal(readFileSync(path.join(f.root, 'ui/dist/index.html'), 'utf8'), 'old console');
  } finally { cleanup(f.base); }
});

test('failed startup restores source, database initialization changes and the old console', async () => {
  const f = await fixture();
  try {
    const before = state(f.root);
    put(f.source, 'src/added.txt', 'remove on rollback');
    await assert.rejects(manage(f.root, f.source, 'upgrade', ['--port', String(await freePort())], {
      build: () => {}, launch: () => { throw new Error('fixture startup failure'); },
    }), /fixture startup failure/);
    assert.deepEqual(state(f.root), before);
    assert.equal(existsSync(path.join(f.root, 'src/added.txt')), false);
    assert.equal(readFileSync(path.join(f.root, 'src/release.txt'), 'utf8'), 'old');
    assert.equal(readFileSync(path.join(f.root, 'ui/dist/index.html'), 'utf8'), 'old console');
  } finally { cleanup(f.base); }
});

test('maintenance lock prevents overlapping upgrades', async () => {
  const f = await fixture();
  try {
    put(f.root, '.runtime/maintenance.lock', 'other task');
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /Another maintenance/);
    assert.equal(readFileSync(path.join(f.root, '.runtime/maintenance.lock'), 'utf8'), 'other task');
  } finally { cleanup(f.base); }
});

test('linked destination directories are rejected before replacement', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.base, 'outside'); mkdirSync(outside);
    symlinkSync(outside, path.join(f.root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    put(f.source, 'docs/api.md', 'new');
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /linked path/);
    assert.equal(existsSync(path.join(outside, 'api.md')), false);
  } finally { cleanup(f.base); }
});

test('upgrade refuses an unrelated service and never sends it a shutdown request', async () => {
  const f = await fixture(); const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); res.end('{}'); });
  try {
    await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /could not be verified/);
    assert.equal(requests.includes('/pool/admin/shutdown'), false);
    assert.equal(readFileSync(path.join(f.root, 'src/release.txt'), 'utf8'), 'old');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(f.base); }
});

test('runtime control requires the administrator token and the current instance id', async () => {
  let calls = 0;
  const server = createServer(createApp({ pool: {}, adminToken: token, apiKeys: ['fixture-model-key'],
    runtime: { info: { instance_id: 'fixture-instance', pid: 123 }, shutdown: () => calls++ } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/pool/admin`;
  try {
    assert.equal((await fetch(base + '/runtime')).status, 401);
    assert.equal((await fetch(base + '/runtime', { headers: { authorization: 'Bearer fixture-model-key' } })).status, 401);
    assert.equal((await fetch(base + '/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-model-key' }, body: '{}' })).status, 401);
    const runtime = await fetch(base + '/runtime', { headers: { 'x-admin-token': token } });
    assert.equal(runtime.status, 200); assert.equal(runtime.headers.get('cache-control'), 'no-store');
    for (const body of [{ instance_id: 'stale' }, { instance_id: 'fixture-instance', extra: true }]) {
      assert.equal((await fetch(base + '/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify(body) })).status, 409);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(base + '/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ instance_id: 'fixture-instance' }) })).status, 202);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('graceful scheduler shutdown waits for the active claim and never starts another one', async () => {
  let resolveClaim, calls = 0, finished = false;
  const scheduler = createAutoClaim({ pool: { claimFreePoints: () => { calls++; return new Promise(resolve => { resolveClaim = resolve; }); } }, logger: { log() {} } });
  await scheduler.stop(); assert.equal(calls, 0);
  const running = scheduler.run();
  const stopped = scheduler.stop().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  resolveClaim([]); await running; await stopped;
  assert.equal(finished, true); assert.equal(calls, 1); assert.equal(scheduler.state.running, false);
});

test('verified backend can be started, detected, restarted and gracefully stopped without upstream requests', async () => {
  const f = await fixture(); let first, second;
  try {
    first = await launchVerified(f.root, f.port, undefined, 15000);
    const firstClosed = once(first, 'close');
    const initial = await runtimeAt(f.root, installationState(f.root));
    assert.equal(initial.pid, first.pid);
    await manage(f.root, f.source, 'start', [], { launch: () => assert.fail('already running') });
    await manage(f.root, f.source, 'restart', [], { launch: async (...args) => { second = await launchVerified(...args, 15000); } });
    await firstClosed;
    const secondClosed = once(second, 'close');
    const current = await runtimeAt(f.root, installationState(f.root));
    assert.notEqual(current.instance_id, initial.instance_id);
    await stopRuntime(installationState(f.root), current);
    await secondClosed;
    assert.equal(await runtimeAt(f.root, installationState(f.root)), null);
  } finally {
    for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    cleanup(f.base);
  }
});

test('verified stop waits for process exit even when its listener closes before background work finishes', async () => {
  const f = await fixture(); let child;
  try {
    put(f.root, 'src/scheduler.mjs', `export function createAutoClaim() { return { state: { enabled: false }, start() {}, stop() { return new Promise(resolve => setTimeout(resolve, 700)); } }; }`);
    child = await launchVerified(f.root, f.port, undefined, 15000);
    const closed = once(child, 'close');
    const initial = await runtimeAt(f.root, installationState(f.root));
    const before = Date.now(); await stopRuntime(installationState(f.root), initial);
    assert(Date.now() - before >= 600, 'must wait for draining process, not just a free port');
    await closed; assert.equal(child.exitCode, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    cleanup(f.base);
  }
});

test('clean Git installation upgrades by fast forward and keeps its repository intact', async () => {
  const f = await fixture();
  try {
    for (const root of [f.root, f.source]) put(root, '.gitattributes', '*.ps1 text eol=crlf\n');
    put(f.root, 'start.ps1', 'Write-Host "fixture"\n');
    put(f.source, 'start.ps1', 'Write-Host "fixture"\r\n');
    const { previous, next } = gitUpdate(f);
    const result = await manage(f.root, f.source, 'upgrade', offline);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), next);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    assert.equal(JSON.parse(readFileSync(path.join(result.backupDirectory, 'upgrade.json'))).previous_git, previous);
  } finally { cleanup(f.base); }
});

test('Git local edits are preserved and divergent history is refused', async () => {
  const f = await fixture();
  try {
    gitUpdate(f); put(f.root, 'src/release.txt', 'my local edit');
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /local changes/);
    assert.equal(readFileSync(path.join(f.root, 'src/release.txt'), 'utf8'), 'my local edit');
    git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'local fork');
    const head = git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /merge-base failed/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  } finally { cleanup(f.base); }
});

test('Git archive mismatch is refused before any installed source changes', async () => {
  const f = await fixture();
  try {
    const { previous } = gitUpdate(f); put(f.source, 'src/release.txt', 'different archive');
    await assert.rejects(manage(f.root, f.source, 'upgrade', offline), /archive differ/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), previous);
  } finally { cleanup(f.base); }
});

test('Git startup failure rolls back the fast forward and SQLite settings', async () => {
  const f = await fixture();
  try {
    const before = state(f.root), { previous } = gitUpdate(f);
    await assert.rejects(manage(f.root, f.source, 'upgrade', ['--backend-only'], { launch: () => { throw new Error('fixture startup failure'); } }), /fixture startup failure/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), previous);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    assert.deepEqual(state(f.root), before);
  } finally { cleanup(f.base); }
});
