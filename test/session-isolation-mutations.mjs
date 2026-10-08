import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const parent = path.resolve(import.meta.dirname), root = path.resolve(parent, '..');
const scratch = mkdtempSync(path.join(parent, '.session-isolation-mutations-'));
const gateway = readFileSync(path.join(root, 'src/gateway.mjs'), 'utf8');
const server = readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
try {
  mkdirSync(path.join(scratch, 'src')); mkdirSync(path.join(scratch, 'test'));
  for (const f of readdirSync(path.join(root, 'src'))) if (f.endsWith('.mjs')) copyFileSync(path.join(root, 'src', f), path.join(scratch, 'src', f));
  copyFileSync(path.join(parent, 'session-isolation.mjs'), path.join(scratch, 'test/session-isolation.mjs'));
  const variants = [
    ['omit-account-namespace', 'gateway.mjs', gateway.replace('return `account-v1:${JSON.stringify([String(accountId), String(logicalKey)])}`;', 'return String(logicalKey);'), 'identical custom keys'],
    ['omit-shared-session-queue', 'gateway.mjs', gateway.replace('return this.serialize(`chat:${accountSessionKey(args.account.id, logicalKey)}`, () => this.recordedChat(args, onDelta, signal));', 'return this.recordedChat(args, onDelta, signal);'), 'concurrent Chat and Responses'],
    ['accept-mixed-legacy-owners', 'gateway.mjs', gateway.replace('owners.size === 1 && owners.has(account.id)', 'true'), 'ambiguous legacy ownership'],
    ['allow-account-switch-on-continuation', 'server.mjs', server.replace('if (wanted && requested?.id !== prev.account)', 'if (false)'), 'cannot switch account'],
    ['allow-continuation-failover', 'server.mjs', server.replace('if (prev || paramError || sentAny', 'if (paramError || sentAny'), 'failure while continuing'],
    ['invent-a-missing-history-session', 'gateway.mjs', gateway.replace('if (requiredSessionId && (!s || s.session_id !== requiredSessionId))', 'if (false)'), 'missing continuation session'],
    ['allow-stale-queued-account', 'gateway.mjs', gateway.replace(/    const current = this.accounts.find[\s\S]*?    account = current;\r?\n/, '').replace(/    const beforeSend = this.accounts.find[\s\S]*?    account = beforeSend;\r?\n/, ''), 'queued request captured'],
    ['omit-upstream-legacy-owner-check', 'gateway.mjs', gateway.replace('if (verified)', 'if (true)'), 'legacy account labels'],
  ];
  for (const [name, file, source, pattern] of variants) {
    for (const [f, original] of [['gateway.mjs', gateway], ['server.mjs', server]]) writeFileSync(path.join(scratch, 'src', f), original);
    assert.notEqual(source, readFileSync(path.join(scratch, 'src', file), 'utf8'));
    writeFileSync(path.join(scratch, 'src', file), source);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, path.join(scratch, 'test/session-isolation.mjs')], { encoding: 'utf8', timeout: 5000 });
    assert.ok(result.status !== 0 && /AssertionError|session_account_mismatch|test timed out/.test(result.stdout), `${name} escaped: ${result.stdout}`);
    console.log(JSON.stringify({ mutation: name, detected: true }));
  }
  for (const [f, original] of [['gateway.mjs', gateway], ['server.mjs', server]]) assert.equal(readFileSync(path.join(root, 'src', f), 'utf8'), original);
} finally {
  assert.equal(path.dirname(scratch), parent); assert.ok(path.basename(scratch).startsWith('.session-isolation-mutations-'));
  rmSync(scratch, { recursive: true, force: true });
}
