import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installationState, runtimeAt, stopRuntime } from '../scripts/service.mjs';
import { launchBackground, serviceName, systemdUnit, environmentFile, savedServiceEnvironment } from '../scripts/background-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-background-'));
  for (const name of ['src', 'scripts']) cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"kuku2api","type":"module"}');
  return root;
}
async function freePort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

test('quiet installer exits after verified startup and the detached service survives its parent', async () => {
  const root = fixture(), port = await freePort();
  let info;
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--backend-only', '--port', String(port), '--lang', 'en'], {
      cwd: root, timeout: 15000, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, KUKU_INSTALLER_QUIET: '1', KUKU_INSTALLER_SUMMARY: '1', LISTEN_HOST: '127.0.0.1',
        DATABASE_FILE: path.join(root, 'data/kukuai.sqlite'), ADMIN_TOKEN: 'background-test-admin', AUTO_CLAIM: '0' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Installation complete\. Service is running in the background\.\r?\nConsole address:/);
    assert.match(result.stdout, /Administrator key: background-test-admin/);
    const state = installationState(root); info = await runtimeAt(root, state);
    assert(info?.pid); assert.equal(state.port, port); assert.equal(state.token, 'background-test-admin');
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    await stopRuntime(state, info); info = null;
  } finally {
    if (info) await stopRuntime(installationState(root), info);
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed background startup exits with an error, without a completion message or key', async () => {
  const root = fixture(), port = await freePort();
  try {
    writeFileSync(path.join(root, 'src/server.mjs'), "throw new Error('fixture startup failure');");
    const entry = pathToFileURL(path.join(root, 'scripts/service.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {launchVerified} from ${JSON.stringify(entry)}; await launchVerified(${JSON.stringify(root)}, ${port}, undefined, 1800); console.log('Installation complete');`], {
      cwd: root, timeout: 10000, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, KUKU_INSTALLER_QUIET: '1', LISTEN_HOST: '127.0.0.1', DATABASE_FILE: path.join(root, 'data/kukuai.sqlite') },
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /failed its startup check/);
    assert.doesNotMatch(result.stdout, /Installation complete|Administrator key/);
    assert.match(readFileSync(path.join(root, '.runtime/server.log'), 'utf8'), /fixture startup failure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('systemd installation persists only application settings, enables boot startup and supports explicit stop', async () => {
  const root = fixture(), units = path.join(root, 'units'), calls = [];
  const previous = process.env.API_KEYS;
  try {
    process.env.API_KEYS = 'test-$key%"\\value';
    const state = { file: path.join(root, 'data/kukuai.sqlite'), port: 19276, host: '0.0.0.0' };
    const service = await launchBackground(root, state, { available: true, unitDirectory: units, run: args => {
      calls.push(args); return args.includes('--property=MainPID') ? '12345' : args.includes('--property=ActiveState') ? 'active' : '';
    } });
    assert.equal(service.pid(), 12345); assert.equal(service.ended(), false);
    await service.stop();
    assert.deepEqual(calls.filter(args => args[0] !== 'show').map(args => args[0]), ['daemon-reload', 'enable', 'start', 'stop']);
    const unit = readFileSync(path.join(units, serviceName(root)), 'utf8');
    assert.match(unit, /Restart=on-failure/); assert.match(unit, /TimeoutStopSec=130/); assert.match(unit, /WantedBy=multi-user.target/);
    assert.doesNotMatch(unit, /test-\$key|ADMIN_TOKEN|API_KEYS/);
    const env = readFileSync(path.join(root, '.runtime/service.env'), 'utf8');
    const values = Object.fromEntries(env.trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), JSON.parse(line.slice(split + 1))]; }));
    assert.equal(values.API_KEYS, process.env.API_KEYS); assert.equal(values.PORT, '19276');
    assert.equal(values.DATABASE_FILE, state.file); assert.equal(values.NODE_USE_ENV_PROXY, '0');
    assert.equal(values.PATH, undefined); assert.equal(values.HTTP_PROXY, undefined);
    assert.equal(savedServiceEnvironment(root).API_KEYS, process.env.API_KEYS);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(root, '.runtime/service.env')).mode & 0o777, 0o600);
    assert.notEqual(serviceName(root), serviceName(path.join(root, 'other')));
  } finally {
    if (previous === undefined) delete process.env.API_KEYS; else process.env.API_KEYS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('systemd failures stop the pending service and refuse to overwrite an unrelated unit', async () => {
  const root = fixture(), units = path.join(root, 'units'), calls = [];
  const state = { file: path.join(root, 'data/kukuai.sqlite'), port: 19276, host: '127.0.0.1' };
  try {
    await assert.rejects(launchBackground(root, state, { available: true, unitDirectory: units, run: args => {
      calls.push(args[0]); if (args[0] === 'start') throw new Error('fixture start failure'); return '';
    } }), /fixture start failure/);
    assert.deepEqual(calls, ['daemon-reload', 'enable', 'start', 'stop']);
    await assert.rejects(launchBackground(root, state, { available: true, unitDirectory: units, run: args => {
      if (args[0] === 'start' || args[0] === 'stop') throw new Error('fixture control failure'); return '';
    } }), error => error.serviceStopFailed === true);
    writeFileSync(path.join(units, serviceName(root)), '# unrelated unit\n');
    await assert.rejects(launchBackground(root, state, { available: true, unitDirectory: units, run() { throw new Error('must not run'); } }), /unrelated systemd unit/);
    assert.equal(readFileSync(path.join(units, serviceName(root)), 'utf8'), '# unrelated unit\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('service unit paths escape systemd specifiers and executable dollar expansion', () => {
  const unit = systemdUnit('/opt/kuku %x $ROOT', '/opt/node $exe%f');
  assert.match(unit, /WorkingDirectory=\/opt\/kuku %%x \$ROOT/);
  assert.match(unit, /ExecStart="\/opt\/node \$\$exe%%f"/);
  assert.throws(() => systemdUnit('/opt/kuku\nInjected=yes'), /control characters/);
  assert.throws(() => environmentFile({ API_KEYS: 'bad\nvalue' }), /control characters/);
});
