import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const parent = path.resolve(import.meta.dirname);
const root = path.resolve(parent, '..');
const scratch = mkdtempSync(path.join(parent, '.desktop-mutations-'));
const original = readFileSync(path.join(root, 'src', 'desktop-login.mjs'), 'utf8');
try {
  mkdirSync(path.join(scratch, 'src')); mkdirSync(path.join(scratch, 'test'));
  for (const file of readdirSync(path.join(root, 'src'))) if (file.endsWith('.mjs')) copyFileSync(path.join(root, 'src', file), path.join(scratch, 'src', file));
  copyFileSync(path.join(parent, 'desktop-login.mjs'), path.join(scratch, 'test', 'desktop-login.mjs'));
  const variants = [
    ['ignore-confirmed-cache', original.replace("if (previous.status === 'completed')", 'if (false)')],
    ['omit-auto-claim', original.replace('auto_claim: true', 'auto_claim: false')],
    ['claim-success-without-balance', original.replace("result.status = result.balance_delta > 0", "result.status = result.task_status === 'SUCCESS'")],
    ['omit-initial-checkpoint', original.replace("store.save({ status: 'running', result });", '// broken checkpoint')],
  ];
  for (const [name, source] of variants) {
    assert.notEqual(source, original);
    writeFileSync(path.join(scratch, 'src', 'desktop-login.mjs'), source);
    let detected = false;
    try { execFileSync(process.execPath, ['--test', path.join(scratch, 'test', 'desktop-login.mjs')], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { detected = String(error.stdout).includes('AssertionError') && /(?:ℹ|#) fail [1-9]/.test(String(error.stdout)); }
    assert.ok(detected, `${name} mutation was not caught`);
    console.log(JSON.stringify({ mutation: name, detected: true }));
  }
  assert.equal(readFileSync(path.join(root, 'src', 'desktop-login.mjs'), 'utf8'), original);
} finally {
  assert.equal(path.dirname(scratch), parent); assert.ok(path.basename(scratch).startsWith('.desktop-mutations-'));
  rmSync(scratch, { recursive: true, force: true });
}
