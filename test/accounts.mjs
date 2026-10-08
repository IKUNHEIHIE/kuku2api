// Synthetic identities and cookies only. No upstream calls or credit consumption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '../src/gateway.mjs';
import { KukuAccount } from '../src/upstream.mjs';
import { createAccountManager } from '../src/accounts.mjs';
import { openDatabase } from '../src/database.mjs';
import { toRecords } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

const old = { id: 'old', alias: 'kept', priority: 7, disabled: true, bduss: 'old-cookie', stoken: 'old-stoken' };
const candidate = (id, cookie = 'fresh-cookie') => ({ id, bduss: cookie, stoken: 'fresh-stoken' });
function setup(t, accounts = [old], identities = { 'old-cookie': '123', 'fresh-cookie': '123', 'other-cookie': '456' }) {
  const identityCalls = [];
  t.mock.method(KukuAccount.prototype, 'userIdentity', async function () {
    identityCalls.push(this.bduss);
    await Promise.resolve();
    if (!identities[this.bduss]) throw new Error('PRIVATE-UPSTREAM-FAILURE');
    return identities[this.bduss];
  });
  const database = openDatabase({ file: ':memory:' });
  t.after(() => database.close());
  const store = database.store('accounts');
  const pool = new Pool(accounts);
  store.save({ accounts: toRecords(pool.accounts), default_device_id: 'device' });
  return { pool, store, database, identityCalls, manager: createAccountManager({ pool, store, deviceId: 'device' }) };
}

test('different login cookies for the same user cannot add a second account; old identity is backfilled', async (t) => {
  const { pool, store, manager } = setup(t);
  pool.accounts[0].auth_dead = true;
  const r = await manager.add(candidate('new'));
  assert.equal(r.error.status, 409);
  assert.equal(r.error.code, 'account_already_exists');
  assert.equal(r.error.account_id, 'old');
  assert.equal(pool.accounts.length, 1);
  assert.equal(store.load().accounts[0].upstream_user_id, '123');
  assert.equal(pool.accounts[0].auth_dead, true);
  assert.equal(pool.accounts[0].disabled, true);
  assert.equal(pool.accounts[0].client.bduss, 'old-cookie');
});

test('normalized identical cookies are refused without upstream identity calls', async (t) => {
  const { manager, pool, identityCalls } = setup(t);
  const r = await manager.add(candidate('new', ' old-cookie;\n'));
  assert.equal(r.error.status, 409);
  assert.equal(pool.accounts.length, 1);
  assert.equal(identityCalls.length, 0);
});

test('different users with identical aliases remain distinct and client-supplied identity is ignored', async (t) => {
  const { manager, pool, store } = setup(t);
  const r = await manager.add({ ...candidate('new', 'other-cookie'), alias: old.alias, upstream_user_id: '123' });
  assert.equal(r.ok, true);
  assert.equal(pool.accounts.length, 2);
  assert.equal(store.load().accounts.find((a) => a.id === 'new').upstream_user_id, '456');
});

test('concurrent additions of one user serialize verification and insert only once', async (t) => {
  const { manager, pool, store } = setup(t, []);
  const result = await Promise.all([manager.add(candidate('first')), manager.add(candidate('second'))]);
  assert.equal(result.filter((r) => r.ok).length, 1);
  assert.equal(result.filter((r) => r.error?.code === 'account_already_exists').length, 1);
  assert.equal(pool.accounts.length, 1);
  assert.equal(store.load().accounts.length, 1);
});

test('concurrent login sessions allocate local IDs inside the queue for different users', async (t) => {
  const { manager, pool } = setup(t, []);
  const allocateId = () => `kuku-${pool.accounts.length}`;
  const results = await Promise.all([
    manager.add({ ...candidate('kuku-0'), allocateId }),
    manager.add({ ...candidate('kuku-0', 'other-cookie'), allocateId }),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(pool.accounts.map((a) => a.id), ['kuku-0', 'kuku-1']);
});

test('unknown identity of either the new or a legacy account refuses insertion without leaking errors', async (t) => {
  const { manager, pool, store } = setup(t, [old], { 'other-cookie': '456' });
  for (const cookie of ['unknown-cookie', 'other-cookie']) {
    const r = await manager.add(candidate('new', cookie));
    assert.equal(r.error.code, 'account_identity_unavailable');
    assert.equal(r.error.status, 502);
    assert.ok(!JSON.stringify(r).includes('PRIVATE-UPSTREAM-FAILURE'));
  }
  assert.equal(pool.accounts.length, 1);
  assert.equal(store.load().accounts.length, 1);
});

test('credential edits cannot switch an account to a user already in the pool', async (t) => {
  const other = { ...candidate('other', 'other-cookie'), upstream_user_id: '456' };
  const { manager, pool } = setup(t, [{ ...old, upstream_user_id: '123' }, other]);
  const before = toRecords(pool.accounts);
  const r = await manager.patch('old', { bduss: 'other-cookie', alias: 'must not change' });
  assert.equal(r.error.code, 'account_already_exists');
  assert.deepEqual(toRecords(pool.accounts), before);
});

test('refreshing the same user preserves its local ID, metadata, sessions and persisted identity', async (t) => {
  const { manager, pool, store } = setup(t, [{ ...old, upstream_user_id: '123' }]);
  pool.sessions.set('old-chat', { session_id: 'session', turn: 4 });
  pool.accounts[0].auth_dead = true;
  const result = await manager.patch('old', { bduss: 'fresh-cookie', stoken: 'new-stoken' });
  assert.equal(result.ok, true);
  assert.equal(result.account.auth_dead, false);
  assert.equal(result.account.alias, old.alias);
  assert.equal(result.account.priority, old.priority);
  assert.equal(result.account.disabled, old.disabled);
  assert.equal(pool.sessions.get('old-chat').turn, 4);
  assert.equal(store.load().accounts[0].upstream_user_id, '123');
});

test('failed database writes leave neither a newly added account nor rotated credentials live', async (t) => {
  const { pool } = setup(t, [{ ...old, upstream_user_id: '123' }]);
  const manager = createAccountManager({ pool, deviceId: 'device', store: { save() { throw new Error('disk failure'); } } });
  const before = toRecords(pool.accounts);
  await assert.rejects(manager.add(candidate('new', 'other-cookie')), /disk failure/);
  await assert.rejects(manager.patch('old', { bduss: 'fresh-cookie' }), /disk failure/);
  assert.deepEqual(toRecords(pool.accounts), before);
});

test('identity persisted in SQLite still prevents duplicate accounts after restart', async (t) => {
  const { pool } = setup(t, []);
  const parent = path.dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(path.join(parent, '.accounts-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('.accounts-')); rmSync(root, { recursive: true, force: true }); });
  let database = openDatabase({ root });
  let manager = createAccountManager({ pool, store: database.store('accounts'), deviceId: 'device' });
  assert.equal((await manager.add(candidate('old', 'old-cookie'))).ok, true);
  database.close();
  database = openDatabase({ root });
  try {
    const restored = new Pool(database.store('accounts').load().accounts);
    manager = createAccountManager({ pool: restored, store: database.store('accounts'), deviceId: 'device' });
    assert.equal((await manager.add(candidate('new'))).error.code, 'account_already_exists');
    assert.equal(restored.accounts.length, 1);
  } finally { database.close(); }
});

test('profile identity accepts verified integers and rejects absent, unsafe or arbitrary identity fields', async () => {
  const client = new KukuAccount(candidate('fake'));
  for (const uk of [123, '123']) {
    client.json = async (route) => { assert.equal(route, '/api/genflowpro/settings/profile'); return { uk }; };
    assert.equal(await client.userIdentity(), '123');
  }
  for (const uk of [undefined, null, '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, '123x']) {
    client.json = async () => ({ uk });
    await assert.rejects(client.userIdentity(), /Invalid upstream user identity/);
  }
});

test('manual HTTP additions return 409 with a stable code and never expose upstream identity or cookies', async (t) => {
  const { pool, store } = setup(t, [{ ...old, upstream_user_id: '123' }]);
  const app = createApp({ pool, store, adminToken: 'test-admin' });
  const req = { method: 'POST', url: '/pool/admin/accounts', headers: { 'x-admin-token': 'test-admin' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(candidate('new'))); } };
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await app(req, res);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error.code, 'account_already_exists');
  for (const secret of ['fresh-cookie', 'old-cookie', 'upstream_user_id']) assert.ok(!res.body.includes(secret));
});
