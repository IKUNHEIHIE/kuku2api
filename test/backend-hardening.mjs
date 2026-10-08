// Isolated backend regression tests: fake accounts and upstream methods, no network or credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '../src/gateway.mjs';
import { UpstreamError } from '../src/upstream.mjs';
import { createApp } from '../src/server.mjs';
import { createFileStore, createKeyRing, toRecords } from '../src/store.mjs';
import { createAutoClaim } from '../src/scheduler.mjs';
import { resolveAdminToken } from '../src/admin-token.mjs';

function temporaryFile(t, name) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(root, '.hardening-'));
  t.after(() => {
    assert.equal(path.dirname(dir), root);
    assert.ok(path.basename(dir).startsWith('.hardening-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, name);
}

test('administrator bootstrap generates distinct 256-bit secrets, saves them and displays a save reminder', (t) => {
  const file = temporaryFile(t, 'admin-token.json');
  const output = [];
  const token = resolveAdminToken({ file, envToken: '', logger: { log: (s) => output.push(s) } });
  assert.match(token, /^kuku-admin-[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice('kuku-admin-'.length), 'base64url').length, 32);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, token);
  assert.equal(output.filter((s) => s === token).length, 1);
  assert.ok(output.some((s) => s.includes('请立即保存')));
  const other = resolveAdminToken({ file: temporaryFile(t, 'other.json'), envToken: '', logger: { log() {} } });
  assert.notEqual(other, token);
});

test('administrator bootstrap reuses its persisted token without printing it again', (t) => {
  const file = temporaryFile(t, 'admin-token.json');
  const token = resolveAdminToken({ file, envToken: '', logger: { log() {} } });
  assert.equal(resolveAdminToken({ file, envToken: ' ', logger: { log() { assert.fail('secret reprinted'); } } }), token);
});

test('explicit ADMIN_TOKEN overrides the generated token without creating or modifying its file', (t) => {
  const file = temporaryFile(t, 'admin-token.json');
  const options = { file, envToken: 'operator-configured-token', logger: { log() { assert.fail('explicit secret printed'); } } };
  assert.equal(resolveAdminToken(options), options.envToken);
  assert.throws(() => readFileSync(file), { code: 'ENOENT' });
  writeFileSync(file, 'preserved operator data');
  assert.equal(resolveAdminToken(options), options.envToken);
  assert.equal(readFileSync(file, 'utf8'), 'preserved operator data');
});

test('corrupt or invalid administrator token files refuse startup and never rotate or quote secrets', (t) => {
  const file = temporaryFile(t, 'admin-token.json');
  for (const raw of ['{"token":"PRIVATE-SENTINEL",', '{"token":"demo-admin-key"}', '{"token":123}']) {
    writeFileSync(file, raw);
    assert.throws(() => resolveAdminToken({ file, envToken: '', logger: { log() { assert.fail('secret printed'); } } }), (e) => !e.message.includes('PRIVATE-SENTINEL'));
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
});

test('administrator token persistence failure aborts without displaying an unusable secret', (t) => {
  const file = path.join(temporaryFile(t, 'unused'), 'missing-parent', 'admin-token.json');
  assert.throws(() => resolveAdminToken({ file, envToken: '', logger: { log() { assert.fail('unpersisted secret printed'); } } }), /could not be saved/);
});

test('a generated administrator token protects existing routes; the old demo token cannot authorize them', async (t) => {
  const token = resolveAdminToken({ file: temporaryFile(t, 'admin-token.json'), envToken: '', logger: { log() {} } });
  const pool = new Pool([]);
  const app = createApp({ pool, adminToken: token });
  for (const [provided, expected] of [[undefined, 401], ['demo-admin-key', 401], [token, 200]]) {
    const req = { url: '/pool/admin/claim', method: 'GET', headers: provided ? { 'x-admin-token': provided } : {}, async *[Symbol.asyncIterator]() {} };
    const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end(body) { assert.ok(!body.includes(token)); } };
    await app(req, res);
    assert.equal(res.statusCode, expected);
  }
});

function rewardPool({ chatReady = false, failedReward = null, refusedReward = null } = {}) {
  const pool = new Pool([{ id: 'fake', bduss: 'FAKE-BDUSS', stoken: 'FAKE-STOKEN', priority: 0 }]);
  const paid = new Set();
  const ready = new Set(chatReady ? ['LOGIN', 'CHAT'] : ['LOGIN']);
  const calls = { turns: 0, rewards: [], reports: [] };
  const client = pool.accounts[0].client;
  pool.accounts[0].deviceId = 'fake-device';
  client.freePointHome = async () => ({ activities: [{ activity_key: 'daily', period_no: 1, tabs: [{ tasks:
    ['LOGIN', 'CHAT'].map((type) => ({ task_type: type, task_key: type, task_status: paid.has(type) ? 'FINISHED' : 'UNFINISHED', claimable_point: !paid.has(type) && ready.has(type) ? 50 : 0 }))
  }] }] });
  client.claimTask = async ({ task_type }) => {
    calls.reports.push(task_type);
    ready.add(task_type);
    return { complete_status: 'SUCCESS' };
  };
  client.claimReward = async ({ task_key }) => {
    calls.rewards.push(task_key);
    if (task_key === failedReward) throw new UpstreamError('reward refused', { code: 123 });
    if (task_key === refusedReward) return { claim_status: 'FAILED', claimed_point: 999 };
    paid.add(task_key);
    return { claim_status: 'SUCCESS', claimed_point: 50 };
  };
  pool.chat = async () => { calls.turns++; await Promise.resolve(); return { consume_points: 0.01 }; };
  return { pool, calls };
}

test('concurrent earn-and-claim requests spend only one turn and pay each task once', async () => {
  const { pool, calls } = rewardPool();
  const results = await Promise.all([pool.claimFreePoints({ runChat: true }), pool.claimFreePoints({ runChat: true })]);
  assert.equal(calls.turns, 1);
  assert.deepEqual(calls.rewards, ['LOGIN', 'CHAT']);
  assert.equal(results.flat().reduce((n, r) => n + r.points_earned, 0), 100);
});

test('manual claims and the scheduler share the same per-account claim queue', async () => {
  const { pool, calls } = rewardPool();
  const scheduler = createAutoClaim({ pool, logger: { log() {}, warn() {} } });
  await Promise.all([scheduler.run(), pool.claimFreePoints({ runChat: true })]);
  assert.equal(calls.turns, 1);
  assert.deepEqual(calls.rewards, ['LOGIN', 'CHAT']);
});

test('a later reward failure preserves the points already paid in the same request', async () => {
  const { pool } = rewardPool({ chatReady: true, failedReward: 'CHAT' });
  const [r] = await pool.claimFreePoints();
  assert.equal(r.ok, false);
  assert.equal(r.points_earned, 50);
  assert.deepEqual(r.claimed.map((c) => c.task_key), ['LOGIN']);
  assert.equal(r.code, 123);
});

test('HTTP-success envelopes with FAILED claims never count their points as paid', async () => {
  const { pool } = rewardPool({ refusedReward: 'LOGIN' });
  const [r] = await pool.claimFreePoints();
  assert.equal(r.ok, false);
  assert.equal(r.points_earned, 0);
  assert.match(r.message, /FAILED/);
});

test('automatic claims catch up after the scheduled hour and still run once per day', async () => {
  const { pool, calls } = rewardPool({ chatReady: true });
  let ts = new Date(2026, 9, 6, 8, 0).getTime();
  const scheduler = createAutoClaim({ pool, now: () => ts, logger: { log() {}, warn() {} } });
  scheduler.configure({ enabled: true, hour: 9 });
  assert.equal(await scheduler.tick(), null);
  ts = new Date(2026, 9, 6, 12, 0).getTime();
  assert.equal(scheduler.state.next_run_at, ts);
  assert.ok(await scheduler.tick());
  assert.equal(await scheduler.tick(), null);
  assert.deepEqual(calls.rewards, ['LOGIN', 'CHAT']);
  assert.equal(new Date(scheduler.state.next_run_at).getDate(), 7);
});

test('automatic claim results retain progress reports and diagnostic notes across restart', async (t) => {
  const file = temporaryFile(t, 'settings.json');
  const pool = { claimFreePoints: async () => [{ id: 'fake', ok: true, points_earned: 0, claimed: [], reported: ['CHAT'], notes: ['not claimable yet'], chat_turn: { ran: true } }] };
  const scheduler = createAutoClaim({ pool, file, logger: { log() {}, warn() {} } });
  await scheduler.run();
  const reloaded = createAutoClaim({ pool, file });
  assert.deepEqual(reloaded.state.last_result.accounts[0].notes, ['not claimable yet']);
  assert.deepEqual(reloaded.state.last_result.accounts[0].reported, ['CHAT']);
});

test('a corrupt JSON file remains in place and errors never quote its contents', (t) => {
  const file = temporaryFile(t, 'state.json');
  const raw = 'FAKE-PRIVATE-MARKER broken json';
  writeFileSync(file, raw);
  const store = createFileStore(file);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => store.load(), (e) => e.message.includes('state.json') && !e.message.includes('FAKE-PRIVATE-MARKER'));
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
});

test('corrupt persisted keys stop startup instead of reopening anonymous API access', (t) => {
  const file = temporaryFile(t, 'keys.json');
  writeFileSync(file, '{broken');
  assert.throws(() => createKeyRing({ file }));
  assert.throws(() => createKeyRing({ file, envKeys: ['fake-env-key'] }));
});

test('invalid key-file structure is refused while a missing file remains local mode', (t) => {
  const file = temporaryFile(t, 'keys.json');
  assert.equal(createKeyRing({ file }).count(), 0);
  for (const value of [{ keys: {} }, { keys: [{ id: 'fake', key: '' }] }, { accounts: [] }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => createKeyRing({ file }));
  }
});

test('failed key revocation leaves the last key active and authentication enabled', (t) => {
  const file = temporaryFile(t, 'keys.json');
  const ring = createKeyRing({ file });
  const issued = ring.add('fake');
  unlinkSync(file);
  mkdirSync(file); // A directory at the file path reliably makes saving fail on Windows too.
  assert.throws(() => ring.remove(issued.id));
  assert.equal(ring.count(), 1);
  assert.equal(ring.ok(issued.key), true);
});

test('failed key issuance never activates a secret that was not saved or returned', (t) => {
  const file = temporaryFile(t, 'keys.json');
  const ring = createKeyRing({ file });
  mkdirSync(file);
  assert.throws(() => ring.add('fake'));
  assert.equal(ring.count(), 0);
});

async function patch(pool, body) {
  const app = createApp({ pool, adminToken: 'fake-admin' });
  const req = { url: '/pool/admin/accounts/fake', method: 'PATCH', headers: { 'x-admin-token': 'fake-admin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end() {} };
  await app(req, res);
  return res.statusCode;
}

test('invalid priority PATCH leaves earlier account fields untouched', async () => {
  const { pool } = rewardPool();
  const before = toRecords(pool.accounts);
  assert.equal(await patch(pool, { alias: 'changed', priority: 'bad' }), 400);
  assert.deepEqual(toRecords(pool.accounts), before);
});

test('invalid credential PATCH leaves metadata and scheduling state untouched', async () => {
  const { pool } = rewardPool();
  pool.accounts[0].auth_dead = true;
  pool.accounts[0].cooldown_until = 123456;
  const before = toRecords(pool.accounts);
  assert.equal(await patch(pool, { alias: 'changed', disabled: true, bduss: '' }), 400);
  assert.deepEqual(toRecords(pool.accounts), before);
  assert.equal(pool.accounts[0].auth_dead, true);
  assert.equal(pool.accounts[0].cooldown_until, 123456);
});
