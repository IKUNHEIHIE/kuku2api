// Explicit acceptance against one selected account; desktop onboarding only, no AI turns.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/database.mjs';

for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'KUKU_BASE_URL']) delete process.env[name];
const i = process.argv.indexOf('--account');
const account = i >= 0 ? process.argv[i + 1] : null;
assert.ok(account, 'Provide --account for exactly one explicit account');
const root = path.resolve(import.meta.dirname, '..');
const database = openDatabase({ root });
const headers = { 'x-admin-token': process.env.ADMIN_TOKEN || database.store('admin').load().token, 'content-type': 'application/json' };
database.close();
const route = `/pool/admin/accounts/${encodeURIComponent(account)}/desktop-login`;
async function request(method, body) {
  const response = await fetch(`http://127.0.0.1:8787${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200);
  return response.json();
}
const before = await request('GET');
assert.equal(before.configured, true);
const result = await request('POST', {});
const after = await request('GET');
const replay = await request('POST', {});
const { account_id, replayed: fromCache, ...saved } = result;
assert.deepEqual(after.initialization, saved);
assert.equal(replay.replayed, true);
assert.ok(!JSON.stringify(result).includes('BDIMXV2'));
const report = { checked_at: new Date().toISOString(), initialization_attempted_at: result.attempted_at, from_cache: fromCache === true, account_id, ok: result.ok,
  status: result.status, code: result.code ?? null, phase: result.phase ?? null, is_new: result.is_new,
  reported: result.reported, task_status: result.task_status, claimed_points: result.claimed_points,
  balance_before: result.balance_before, balance_after: result.balance_after, balance_delta: result.balance_delta,
  replayed: replay.replayed, inference_calls: 0, credential_or_device_identity_exposed: false };
writeFileSync(path.join(root, 'capture', fromCache ? 'desktop-login-restart-acceptance-2026-10-07.json' : 'desktop-login-acceptance-2026-10-07.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
