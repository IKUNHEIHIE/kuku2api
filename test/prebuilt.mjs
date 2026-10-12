import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleFiles, validatePrebuilt } from '../scripts/prebuilt.mjs';
import { buildConsole } from '../scripts/install.mjs';
import { manage } from '../scripts/manage.mjs';
import { stageRelease } from '../scripts/package-release.mjs';
import { openDatabase } from '../src/database.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commit = 'a'.repeat(40);
function put(root, name, text) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), text);
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-prebuilt-test-'));
  for (const name of ['src', 'scripts']) cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  put(root, 'ui/dist/index.html', '<!doctype html><script src="/assets/app.js"></script>');
  put(root, 'ui/dist/assets/app.js', 'console.log("precompiled")');
  put(root, 'ui/package.json', JSON.stringify({ scripts: { build: 'exit 99' } }));
  seal(root);
  return root;
}
function seal(root, sha = commit) {
  put(root, 'release.json', JSON.stringify({ format: 1, commit: sha, version: '0.2.0', console: consoleFiles(root) }));
}
function cleanup(root) {
  assert.equal(path.dirname(root), tmpdir()); assert.match(path.basename(root), /^kuku-prebuilt-test-/);
  rmSync(root, { recursive: true, force: true });
}
const env = { ...process.env, ADMIN_TOKEN: '', PORT: undefined, npm_config_offline: 'true', NPM_CONFIG_OFFLINE: 'true' };

test('default full installation uses prebuilt output without frontend dependencies and preserves SQLite on reinstall', async () => {
  const root = fixture();
  try {
    // Even skip-dependencies must never turn the default mode into a build.
    await buildConsole(root, { ui: true, dependencies: false });
    const file = path.join(root, 'data/kukuai.sqlite');
    const invoke = () => spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--no-start', '--port', '19888', '--lang', 'en'], {
      cwd: root, encoding: 'utf8', timeout: 15000, env: { ...env, DATABASE_FILE: file },
    });
    const first = invoke(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /no frontend dependencies or local build/);
    let db = openDatabase({ root });
    const token = db.store('admin').load().token;
    db.store('accounts').save({ accounts: [{ id: 'existing', bduss: 'fake-test-cookie' }] }); db.close();
    const second = invoke(); assert.equal(second.status, 0, second.stderr); assert(!second.stdout.includes(token));
    db = openDatabase({ root });
    try {
      assert.equal(db.store('admin').load().token, token);
      assert.equal(db.store('accounts').load().accounts[0].id, 'existing');
      assert.equal(db.store('installation').load().port, 19888);
    } finally { db.close(); }
    assert.equal(existsSync(path.join(root, 'ui/node_modules')), false);
  } finally { cleanup(root); }
});

test('missing or corrupt prebuilt output fails without creating storage or falling back to build', async () => {
  const root = fixture();
  try {
    rmSync(path.join(root, 'release.json'));
    await assert.rejects(buildConsole(root, { ui: true, dependencies: false }), /no automatic build/);
    seal(root); put(root, 'ui/dist/assets/app.js', 'corrupt');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--no-start', '--lang', 'en'], {
      cwd: root, encoding: 'utf8', timeout: 15000, env: { ...env, DATABASE_FILE: path.join(root, 'data/kukuai.sqlite') },
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
    assert.equal(existsSync(path.join(root, 'data/kukuai.sqlite')), false);
    assert.equal(existsSync(path.join(root, 'ui/node_modules')), false);
    seal(root); put(root, 'ui/dist/assets/extra.js', 'unexpected');
    assert.throws(() => validatePrebuilt(root), /checksum mismatch/);
  } finally { cleanup(root); }
});

test('prebuilt upgrade preserves token and settings, reuses the release, and repairs missing assets without building', async () => {
  const root = fixture(), source = fixture();
  try {
    const db = openDatabase({ root });
    const token = 'kuku-admin-' + 'B'.repeat(43);
    db.store('admin').save({ token }); db.store('installation').save({ port: 19889 });
    db.store('system').save({ site_name: 'keep' }); db.close();
    put(source, 'ui/dist/assets/app.js', 'new precompiled console'); seal(source, 'b'.repeat(40));
    const update = await manage(root, source, 'upgrade', ['--no-start', '--lang', 'en']);
    assert(update.backupDirectory); assert.equal(validatePrebuilt(root).commit, 'b'.repeat(40));
    const reused = await manage(root, source, 'upgrade', ['--no-start', '--lang', 'en']); assert.equal(reused.unchanged, true);
    rmSync(path.join(root, 'ui/dist/assets/app.js'));
    const repair = await manage(root, source, 'upgrade', ['--no-start', '--lang', 'en']); assert(repair.backupDirectory);
    assert.equal(readFileSync(path.join(root, 'ui/dist/assets/app.js'), 'utf8'), 'new precompiled console');
    const restored = openDatabase({ root });
    try {
      assert.equal(restored.store('admin').load().token, token);
      assert.equal(restored.store('installation').load().port, 19889);
      assert.equal(restored.store('system').load().site_name, 'keep');
    } finally { restored.close(); }
    assert.equal(existsSync(path.join(root, 'ui/node_modules')), false);
  } finally { cleanup(root); cleanup(source); }
});

test('invalid prebuilt update cannot replace source, console or database', async () => {
  const root = fixture(), source = fixture();
  try {
    const db = openDatabase({ root }); db.store('installation').save({ port: 19890 }); db.close();
    const before = readFileSync(path.join(root, 'data/kukuai.sqlite'));
    put(source, 'ui/dist/assets/app.js', 'tampered');
    await assert.rejects(manage(root, source, 'upgrade', ['--no-start']), /checksum mismatch/);
    assert.deepEqual(readFileSync(path.join(root, 'data/kukuai.sqlite')), before);
    assert.equal(readFileSync(path.join(root, 'ui/dist/assets/app.js'), 'utf8'), 'console.log("precompiled")');
    assert.equal(existsSync(path.join(root, '.runtime/backups')), false);
  } finally { cleanup(root); cleanup(source); }
});

test('release staging takes committed public source and excludes private files and node_modules', () => {
  const root = fixture(), destination = path.join(root, '.runtime/package');
  try {
    put(root, 'LICENSE', readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'));
    put(root, 'ui/LICENSE', readFileSync(path.join(ROOT, 'ui/LICENSE'), 'utf8'));
    put(root, '.gitignore', '/data/\n/.runtime/\n/release.json\nui/dist/\nnode_modules/\n');
    put(root, 'ui/src/routeTree.gen.ts', 'committed route tree');
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
    git(['add', '.']); git(['commit', '-qm', 'fixture release']);
    const sha = git(['rev-parse', 'HEAD']);
    put(root, 'ui/src/routeTree.gen.ts', 'build generated order');
    for (const name of ['accounts.json', 'capture/password.txt', 'data/secret.sqlite', 'ui/node_modules/pkg/index.js', 'ui/.env']) put(root, name, 'private');
    const release = stageRelease(root, destination);
    for (const name of ['LICENSE', 'ui/LICENSE']) assert.equal(readFileSync(path.join(destination, name), 'utf8').replace(/\r\n/g, '\n'), readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n'));
    assert.equal(release.commit, sha); assert.equal(validatePrebuilt(destination).commit, sha);
    assert.equal(readFileSync(path.join(destination, 'ui/src/routeTree.gen.ts'), 'utf8'), 'committed route tree');
    for (const name of ['accounts.json', 'capture', 'data', 'ui/node_modules', 'ui/.env', '.git']) assert.equal(existsSync(path.join(destination, name)), false, name);
  } finally { cleanup(root); }
});

test('release validation rejects linked console assets and private outputs', () => {
  const root = fixture();
  try {
    const outside = path.join(root, 'external'); mkdirSync(outside);
    symlinkSync(outside, path.join(root, 'ui/dist/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => consoleFiles(root), /Linked/); rmSync(path.join(root, 'ui/dist/linked'));
    put(root, 'ui/dist/.env', 'private'); assert.throws(() => consoleFiles(root), /Private/);
  } finally { cleanup(root); }
});

test('Git prebuilt upgrade pins the published commit and restores its manifest after failed startup', async () => {
  const root = fixture();
  try {
    const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const token = 'kuku-admin-' + 'C'.repeat(43);
    const db = openDatabase({ root }); db.store('admin').save({ token }); db.store('installation').save({ port }); db.close();
    put(root, '.gitignore', '/data/\n/.runtime/\n/release.json\nui/dist/\nnode_modules/\n');
    const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'old');
    const upstream = path.join(root, '.runtime/upstream');
    execFileSync('git', ['clone', '-q', root, upstream], { windowsHide: true, stdio: 'pipe' });
    git(upstream, 'config', 'core.autocrlf', 'false'); git(upstream, 'config', 'user.email', 'test@example.invalid'); git(upstream, 'config', 'user.name', 'Test');
    put(upstream, 'src/release.txt', 'published'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'published');
    const published = git(upstream, 'rev-parse', 'HEAD');
    cpSync(path.join(root, 'ui/dist'), path.join(upstream, 'ui/dist'), { recursive: true });
    const source = path.join(root, '.runtime/published'); stageRelease(upstream, source);
    put(upstream, 'src/release.txt', 'not yet published'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'unreleased main');
    git(root, 'remote', 'add', 'origin', upstream);
    await manage(root, source, 'upgrade', ['--no-start', '--lang', 'en']);
    assert.equal(git(root, 'rev-parse', 'HEAD'), published);
    assert.equal(validatePrebuilt(root).commit, published); assert.equal(git(root, 'status', '--porcelain'), '');
    const previous = readFileSync(path.join(root, 'release.json'));
    const nextSource = path.join(root, '.runtime/next-release'); stageRelease(upstream, nextSource);
    await assert.rejects(manage(root, nextSource, 'upgrade', ['--lang', 'en'], { launch: () => { throw new Error('fixture launch failed'); } }), /fixture launch failed/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), published); assert.equal(git(root, 'status', '--porcelain'), '');
    assert.deepEqual(readFileSync(path.join(root, 'release.json')), previous); assert.equal(validatePrebuilt(root).commit, published);
    const restored = openDatabase({ root });
    try { assert.equal(restored.store('admin').load().token, token); assert.equal(restored.store('installation').load().port, port); }
    finally { restored.close(); }
  } finally { cleanup(root); }
});
