import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const parent = path.resolve(import.meta.dirname);
const root = path.resolve(parent, '..');
const scratch = mkdtempSync(path.join(parent, '.accounts-mutations-'));
const original = readFileSync(path.join(root, 'src', 'accounts.mjs'), 'utf8');
try {
  mkdirSync(path.join(scratch, 'src'));
  mkdirSync(path.join(scratch, 'test'));
  for (const name of readdirSync(path.join(root, 'src'))) if (name.endsWith('.mjs')) copyFileSync(path.join(root, 'src', name), path.join(scratch, 'src', name));
  copyFileSync(path.join(parent, 'accounts.mjs'), path.join(scratch, 'test', 'accounts.mjs'));
  const variants = [
    ['skip-stable-identity', original.replace('a.upstream_user_id && a.upstream_user_id === identity', 'false').replace('verified.id === identity', 'false')],
    ['skip-add-serialization', original.replace('const result = pending.then(fn);', 'const result = Promise.resolve().then(fn);')],
    ['skip-durable-commit', original.replace('store?.save({ default_device_id: deviceId, accounts: records });', '// intentionally broken durable commit')],
  ];
  for (const [name, source] of variants) {
    assert.notEqual(source, original);
    writeFileSync(path.join(scratch, 'src', 'accounts.mjs'), source);
    let caught = false;
    try { execFileSync(process.execPath, ['--test', path.join(scratch, 'test', 'accounts.mjs')], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { const output = String(e.stdout); caught = output.includes('AssertionError') && /(?:ℹ|#) fail [1-9]/.test(output); }
    assert.ok(caught, `${name} was not detected by regression tests`);
    console.log(JSON.stringify({ mutation: name, detected: true }));
  }
  assert.equal(readFileSync(path.join(root, 'src', 'accounts.mjs'), 'utf8'), original);
} finally {
  assert.equal(path.dirname(scratch), parent);
  assert.ok(path.basename(scratch).startsWith('.accounts-mutations-'));
  rmSync(scratch, { recursive: true, force: true });
}
