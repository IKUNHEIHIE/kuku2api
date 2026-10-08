// Explicit operator acceptance only: read-only upstream profiles, no AI turns or rewards.
// --backfill runs while the backend is stopped; default verifies the running service.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { KukuAccount } from '../src/upstream.mjs';
import { Pool } from '../src/gateway.mjs';
import { createAccountManager } from '../src/accounts.mjs';

for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'KUKU_BASE_URL']) delete process.env[name];
const root = path.resolve(import.meta.dirname, '..');
const database = openDatabase({ root });
try {
  const store = database.store('accounts');
  const saved = store.load();
  if (process.argv.includes('--backfill')) {
    const groups = new Map();
    const records = [];
    for (const record of saved.accounts) {
      const identity = await new KukuAccount(record).userIdentity();
      records.push({ ...record, upstream_user_id: identity });
      groups.set(identity, (groups.get(identity) ?? 0) + 1);
    }
    mkdirSync(path.join(root, 'data', 'backups'), { recursive: true });
    const backup = path.join(root, 'data', 'backups', `before-account-identity-${Date.now()}.sqlite`);
    database.sql.prepare('VACUUM INTO ?').run(backup);
    store.save({ ...saved, accounts: records });
    console.log(JSON.stringify({ backfilled: records.length, unique_users: groups.size, duplicate_group_sizes: [...groups.values()].filter((n) => n > 1), backup: path.relative(root, backup), existing_records_preserved: true }));
  } else {
    const base = 'http://127.0.0.1:8787';
    const headers = { 'x-admin-token': process.env.ADMIN_TOKEN || database.store('admin').load().token, 'content-type': 'application/json' };
    const request = async (route, options = {}) => {
      const res = await fetch(`${base}${route}`, { headers, ...options });
      return { status: res.status, body: await res.json() };
    };
    const before = await request('/pool/state');
    assert.equal(before.status, 200);
    const record = saved.accounts[0];
    assert.ok(record);
    const result = await request('/pool/admin/accounts', { method: 'POST', body: JSON.stringify({ id: `dedup-accept-${Date.now()}`, bduss: record.bduss, stoken: record.stoken }) });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'account_already_exists');
    const after = await request('/pool/state');
    assert.equal(after.body.accounts.length, before.body.accounts.length);
    assert.ok(!JSON.stringify(result.body).includes(record.bduss));
    // Two real logins for one user, checked against an isolated in-memory pool. This
    // exercises changed cookies through real profile reads without changing production.
    const groups = new Map();
    for (const a of saved.accounts) {
      assert.ok(a.upstream_user_id);
      const list = groups.get(a.upstream_user_id) ?? [];
      list.push(a); groups.set(a.upstream_user_id, list);
    }
    let changedCookieChecks = 0;
    for (const list of groups.values()) {
      const first = list[0];
      const second = list.find((a) => a.bduss !== first.bduss);
      if (!second) continue;
      const pool = new Pool([first]);
      const manager = createAccountManager({ pool, deviceId: saved.default_device_id });
      const duplicate = await manager.add({ id: `isolated-dedup-${changedCookieChecks}`, bduss: second.bduss, stoken: second.stoken });
      assert.equal(duplicate.error?.code, 'account_already_exists');
      assert.equal(pool.accounts.length, 1);
      changedCookieChecks++;
    }
    const report = { checked_at: new Date().toISOString(), live_duplicate_status: result.status,
      code: result.body.error.code, accounts_before: before.body.accounts.length, accounts_after: after.body.accounts.length,
      unique_verified_users: groups.size, real_changed_cookie_duplicate_checks: changedCookieChecks,
      credentials_exposed: false, inference_calls: 0, claim_calls: 0 };
    writeFileSync(path.join(root, 'capture', 'account-dedup-acceptance-2026-10-07.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} finally { database.close(); }
