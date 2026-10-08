// Offline onboarding regression: synthetic accounts, native context and balances only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.mjs';
import { Pool } from '../src/gateway.mjs';
import { KukuAccount, UpstreamError } from '../src/upstream.mjs';
import { createDesktopLogin, validDesktopContext } from '../src/desktop-login.mjs';
import { createAccountManager } from '../src/accounts.mjs';
import { createApp } from '../src/server.mjs';
import { toRecords } from '../src/store.mjs';

const context = { source: 'installed_native_client', devuid: 'BDIMXV2-SYNTHETIC-DEVICE-123', device_id: '123456789012345678', clienttype: '401', version: '1.6.5.130', channel: '00000000000000000000000000000000', win64: '1' };
const account = { id: 'fake', bduss: 'FAKE-COOKIE', stoken: 'FAKE-STOKEN', upstream_user_id: '123' };
function setup(t, { configured = true, grant = 500, tasks = [] } = {}) {
  const database = openDatabase({ file: ':memory:' });
  t.after(() => database.close());
  if (configured) database.store('desktop_context').save(context);
  const pool = new Pool([account]);
  database.store('accounts').save({ accounts: toRecords(pool.accounts) });
  const a = pool.accounts[0];
  let points = 50;
  const calls = { report: 0, task: 0, balance: 0, rewards: [] };
  a.client.vipRemain = async () => { calls.balance++; return { list: [{ assetType: 1, totalPoint: String(points) }] }; };
  a.client.desktopLoginReport = async (c) => { calls.report++; assert.deepEqual(c, context); return { is_new: true, upstream_user_id: '123' }; };
  a.client.claimTask = async (params) => {
    calls.task++; assert.deepEqual(params, { task_type: 'SELF_DOWNLOAD', device_id: context.device_id, auto_claim: true });
    points += grant;
    return { complete_status: 'SUCCESS', reward_point: 9999 };
  };
  a.client.freePointHome = async () => ({ activities: [{ activity_key: 'free', period_no: 1, tabs: [{ tasks }] }] });
  a.client.claimReward = async ({ task_key }) => { calls.rewards.push(task_key); points += 20; return { claim_status: 'SUCCESS', claimed_point: 20 }; };
  const initialize = createDesktopLogin({ database, pool });
  return { database, pool, a, initialize, calls, addPoints: (n) => { points += n; } };
}
const ready = (key, type = 'SELF_DOWNLOAD') => ({ task_key: key, task_type: type, task_status: 'UNFINISHED', claimable_point: 20 });

test('normal desktop initialization reports the login and SELF_DOWNLOAD and verifies actual balance', async (t) => {
  const { initialize, a, calls } = setup(t);
  const result = await initialize.run(a);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'credited');
  assert.deepEqual(result.reported, ['USER_REPORT', 'SELF_DOWNLOAD']);
  assert.equal(result.balance_before, 50);
  assert.equal(result.balance_after, 550);
  assert.equal(result.balance_delta, 500);
  assert.equal(result.claimed_points, 0, 'auto-claim amount is not invented from reward_point');
  assert.equal(calls.task, 1);
});

test('SUCCESS and reward_point alone never imply credits if the actual balance stays unchanged', async (t) => {
  const { initialize, a } = setup(t, { grant: 0 });
  const result = await initialize.run(a);
  assert.equal(result.status, 'no_credit');
  assert.equal(result.balance_delta, 0);
  assert.equal(result.claimed_points, 0);
});

test('missing or malformed real desktop context cannot send reward requests', async (t) => {
  const { initialize, a, calls, database } = setup(t, { configured: false });
  assert.equal((await initialize.run(a)).code, 'desktop_context_unavailable');
  database.store('desktop_context').save({ ...context, device_id: '0' });
  assert.equal((await initialize.run(a)).status, 'unavailable');
  assert.deepEqual(calls, { report: 0, task: 0, balance: 0, rewards: [] });
  assert.equal(validDesktopContext({ ...context, source: 'random_device' }), false);
});

test('concurrent requests and duplicate local rows of the same user initialize once', async (t) => {
  const { initialize, a, calls } = setup(t);
  const duplicate = { ...a, id: 'duplicate' };
  const [first, second] = await Promise.all([initialize.run(a), initialize.run(duplicate)]);
  assert.equal(first.status, 'credited');
  assert.equal(second.replayed, true);
  assert.equal(calls.report, 1);
  assert.equal(calls.task, 1);
});

test('initialization checkpoints survive a new service instance without repeating upstream writes', async (t) => {
  const { initialize, a, calls, database, pool } = setup(t);
  await initialize.run(a);
  const restored = createDesktopLogin({ database, pool });
  assert.equal((await restored.run(a, { retry: true })).replayed, true);
  assert.equal(calls.task, 1);
  assert.equal(restored.state(a).initialization.balance_delta, 500);
});

test('unknown network outcome after auto-credit is verified read-only and never automatically repeated', async (t) => {
  const { initialize, a, calls, addPoints } = setup(t);
  a.client.claimTask = async () => { calls.task++; addPoints(500); throw new UpstreamError('SENSITIVE NETWORK TEXT', { network: true }); };
  const first = await initialize.run(a);
  assert.equal(first.status, 'verification_pending');
  assert.equal(first.balance_delta, 500);
  const again = await initialize.run(a, { retry: true });
  assert.equal(again.status, 'verification_pending');
  assert.equal(calls.task, 1);
  assert.ok(!JSON.stringify(first).includes('SENSITIVE'));
});

test('explicit refusal allows manual retry but skips an already successful login report', async (t) => {
  const { initialize, a, calls } = setup(t);
  a.client.claimTask = async () => { calls.task++; return { complete_status: 'FAILED' }; };
  assert.equal((await initialize.run(a)).status, 'failed');
  assert.equal((await initialize.run(a)).replayed, true);
  a.client.claimTask = async () => { calls.task++; return { complete_status: 'SUCCESS' }; };
  assert.equal((await initialize.run(a, { retry: true })).status, 'no_credit');
  assert.equal(calls.report, 1);
  assert.equal(calls.task, 2);
});

test('reward fallback only claims existing ready SELF_DOWNLOAD tasks and never invitations or daily tasks', async (t) => {
  const { initialize, a, calls } = setup(t, { grant: 0, tasks: [ready('self'), ready('invite', 'INVITE_DOWNLOAD'), ready('chat', 'CHAT'), ready('login', 'LOGIN')] });
  const result = await initialize.run(a);
  assert.deepEqual(calls.rewards, ['self']);
  assert.equal(result.claimed_points, 20);
  assert.equal(result.balance_delta, 20);
});

test('retry preserves partial claims and never reclaims an already confirmed task', async (t) => {
  const { initialize, a, calls, addPoints } = setup(t, { grant: 0, tasks: [ready('self-one'), ready('self-two')] });
  let refuse = true;
  a.client.claimReward = async ({ task_key }) => {
    calls.rewards.push(task_key);
    if (task_key === 'self-two' && refuse) return { claim_status: 'FAILED' };
    addPoints(20); return { claim_status: 'SUCCESS', claimed_point: 20 };
  };
  const first = await initialize.run(a);
  assert.equal(first.status, 'failed');
  assert.equal(first.claimed_points, 20);
  refuse = false;
  const second = await initialize.run(a, { retry: true });
  assert.equal(second.claimed_points, 40);
  assert.deepEqual(calls.rewards, ['self-one', 'self-two', 'self-two']);
  assert.equal(calls.report, 1);
  assert.equal(calls.task, 1);
});

test('missing balance remains null and cannot be replaced by zero or inferred from rewards', async (t) => {
  const { initialize, a } = setup(t);
  a.client.vipRemain = async () => ({ list: [] });
  const result = await initialize.run(a);
  assert.equal(result.status, 'balance_unknown');
  assert.equal(result.balance_before, null);
  assert.equal(result.balance_after, null);
  assert.equal(result.balance_delta, null);
});

test('persistent checkpoint failure blocks upstream writes before spending or requesting rewards', async (t) => {
  const { initialize, a, database, calls } = setup(t);
  const original = database.store;
  t.mock.method(database, 'store', (name) => {
    const store = original(name);
    return name.startsWith('desktop_login:') ? { ...store, save() { throw new Error('disk failed'); } } : store;
  });
  await assert.rejects(initialize.run(a), /disk failed/);
  assert.equal(calls.report, 0);
  assert.equal(calls.task, 0);
});

test('account admission remains successful and persisted if onboarding fails; duplicate admission never initializes', async (t) => {
  const { pool, database } = setup(t);
  t.mock.method(KukuAccount.prototype, 'userIdentity', async () => '456');
  let called = 0;
  const manager = createAccountManager({ pool, store: database.store('accounts'), deviceId: '123', initializeDesktop: async () => { called++; throw new Error('failed'); } });
  const result = await manager.add({ id: 'new', bduss: 'NEW-COOKIE', stoken: 'NEW-STOKEN' });
  assert.equal(result.ok, true);
  assert.equal(result.desktop_login.status, 'verification_pending');
  assert.ok(database.store('accounts').load().accounts.some((a) => a.id === 'new'));
  assert.equal((await manager.add({ id: 'newer', bduss: 'NEW-COOKIE', stoken: 'NEW-STOKEN' })).error.code, 'account_already_exists');
  assert.equal(called, 1);
});

test('identity mismatch between profile and login report never requests a desktop reward', async (t) => {
  const { initialize, a, calls } = setup(t);
  a.client.desktopLoginReport = async () => ({ is_new: true, upstream_user_id: 'other' });
  const result = await initialize.run(a);
  assert.equal(result.code, 'desktop_identity_mismatch');
  assert.equal(calls.task, 0);
});

test('daily claiming and desktop initialization serialize on the same account queue', async (t) => {
  const { initialize, a, pool, calls } = setup(t);
  let release;
  const first = pool.serialize(`claim:${a.id}`, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const onboarding = initialize.run(a);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.task, 0);
  release();
  await Promise.all([first, onboarding]);
  assert.equal(calls.task, 1);
});

test('upstream desktop login query uses real context and drops private session fields from its result', async () => {
  const client = new KukuAccount(account);
  client.json = async (route, options) => {
    assert.equal(route, '/api/genflowpro/common/userreport');
    assert.equal(options.query.devuid, context.devuid);
    assert.equal(options.query.clienttype, '401');
    return { uk: 123, is_new: '1', bdstoken: 'PRIVATE-TOKEN', uinfo: 'PRIVATE-SIGN-KEY' };
  };
  assert.deepEqual(await client.desktopLoginReport(context), { is_new: true, upstream_user_id: '123' });
  client.json = async (_, options) => { assert.equal(options.form.auto_claim, 'true'); return {}; };
  await client.claimTask({ task_type: 'SELF_DOWNLOAD', device_id: context.device_id, auto_claim: true });
  client.json = async (_, options) => { assert.ok(!('auto_claim' in options.form)); return {}; };
  await client.claimTask({ task_type: 'LOGIN', device_id: context.device_id });
});

async function call(app, method, url, body = {}, token = 'admin') {
  const req = { method, url, headers: { 'x-admin-token': token }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: 200, writeHead(status) { this.statusCode = status; }, end(body) { this.body = body; } };
  await app(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
test('desktop admin routes enforce authentication and read-only status; context and session tokens stay private', async (t) => {
  const { pool, database, calls } = setup(t);
  const app = createApp({ pool, database, adminToken: 'admin' });
  const route = '/pool/admin/accounts/fake/desktop-login';
  assert.equal((await call(app, 'POST', route, {}, 'wrong')).status, 401);
  const status = await call(app, 'GET', route);
  assert.equal(status.json.configured, true);
  assert.equal(calls.report, 0);
  const run = await call(app, 'POST', route);
  assert.equal(run.json.balance_delta, 500);
  const saved = await call(app, 'GET', route);
  assert.equal(saved.json.initialization.status, 'credited');
  assert.ok(!JSON.stringify(saved.json).includes(context.devuid));
  assert.equal((await call(app, 'POST', route, { devuid: 'fake-device' })).status, 400);
  assert.equal((await call(app, 'POST', route, { retry: 'true' })).status, 400);
  assert.equal((await call(app, 'PUT', route)).status, 405);
  assert.equal((await call(app, 'GET', '/pool/admin/accounts/missing/desktop-login')).status, 404);
});
