import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pool } from '../src/gateway.mjs';
import { createAutoClaim } from '../src/scheduler.mjs';
import { createApp, claimJson } from '../src/server.mjs';

function fixture({ slow = 0, failure = false, onWait = () => {} } = {}) {
  let now = 0, active = 0;
  const waits = [], events = [];
  const records = ['a', 'b', 'c'].map(id => ({ id, bduss: 'synthetic', stoken: 'synthetic', upstream_user_id: id }));
  const pool = new Pool(records, {
    claimNow: () => now,
    claimWait: async ms => { assert.equal(active, 0); waits.push(ms); now += ms; onWait(pool, records); },
  });
  for (const account of pool.accounts) {
    let reads = 0;
    account.client.freePointHome = async () => {
      if (++reads === 1) {
        assert.equal(active++, 0, 'account work must not overlap');
        events.push({ id: account.id, start: now });
        await Promise.resolve();
        now += slow;
        if (failure && account.id === 'a') {
          active--; events.at(-1).end = now;
          throw new Error('synthetic upstream failure');
        }
      }
      if (reads % 2 === 0) { active--; events.at(-1).end = now; reads = 0; }
      return {};
    };
  }
  return { pool, waits, events };
}

test('batch claims process one account then wait exactly 15 seconds, with no trailing delay', async () => {
  const { pool, waits, events } = fixture();
  const result = await pool.claimFreePoints();
  assert.deepEqual(result.map(r => [r.id, r.ok]), [['a', true], ['b', true], ['c', true]]);
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.deepEqual(events.map(e => e.start), [0, 15_000, 30_000]);
});

test('simultaneous single-account requests share the queue even for an account named global', async () => {
  const { pool, waits, events } = fixture({ slow: 20_000 });
  pool.accounts[1].id = 'global';
  await Promise.all(['a', 'global', 'c'].map(only => pool.claimFreePoints({ only })));
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.deepEqual(events.map(e => e.start), [0, 35_000, 70_000]);
});

test('scheduled, manual batch and single-account claims all obey the same cooldown', async () => {
  const { pool, events } = fixture({ slow: 100 });
  const auto = createAutoClaim({ pool, logger: { log() {}, warn() {} } });
  await Promise.all([auto.run(), pool.claimFreePoints(), pool.claimFreePoints({ only: 'b' })]);
  assert.equal(events.length, 7);
  for (let i = 1; i < events.length; i++) assert.equal(events[i].start - events[i - 1].end, 15_000);
});

test('a failed account still waits 15 seconds before proceeding to the next account', async () => {
  const { pool, waits, events } = fixture({ failure: true });
  const results = await pool.claimFreePoints();
  assert.deepEqual(results.map(r => r.ok), [false, true, true]);
  assert.match(results[0].message, /synthetic upstream failure/);
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.deepEqual(events.map(e => e.start), [0, 15_000, 30_000]);
});

test('separate completed batches retain cooldown and ordinary pool work is not blocked', async () => {
  const { pool, waits, events } = fixture();
  await pool.claimFreePoints({ only: 'a' });
  assert.equal((await pool.serialize('ordinary-model', async () => pool.pick())).id, 'a');
  await pool.claimFreePoints({ only: 'b' });
  assert.deepEqual(waits, [15_000]);
  assert.deepEqual(events.map(e => e.start), [0, 15_000]);
});

test('an account removed during queue wait is skipped without sending upstream requests', async () => {
  const { pool, events } = fixture({ onWait(pool) { pool.accounts = pool.accounts.filter(a => a.id !== 'b'); } });
  const results = await pool.claimFreePoints();
  assert.equal(results[1].ok, false);
  assert.match(results[1].message, /已跳过/);
  assert.deepEqual(events.map(e => e.id), ['a', 'c']);
});

test('queued claims use refreshed credentials but refuse a changed upstream identity', async () => {
  const refreshed = [];
  const { pool, events } = fixture({ onWait(pool, records) {
    pool.set(records.map(a => a.id === 'c' ? { ...a, upstream_user_id: 'other-person' } : a));
    for (const a of pool.accounts) a.client.freePointHome = async () => { refreshed.push(a.id); return {}; };
  } });
  const results = await pool.claimFreePoints();
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, false);
  assert.deepEqual(refreshed, ['b', 'b']);
  assert.deepEqual(events.map(e => e.id), ['a']);
});

function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
  res.write = chunk => res.chunks.push(chunk);
  res.end = chunk => { if (chunk) res.chunks.push(chunk); res.writableEnded = true; };
  return res;
}

function heartbeat(t) {
  let tick, cleared = 0;
  const token = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (fn, delay) => { assert.equal(delay, 10_000); tick = fn; return token; });
  t.mock.method(globalThis, 'clearInterval', id => { assert.equal(id, token); cleared++; });
  return { tick: () => tick(), cleared: () => cleared };
}

test('manual and automatic HTTP claim routes keep long batches alive as compatible JSON', async t => {
  for (const url of ['/pool/admin/claim', '/pool/admin/auto-claim/run']) {
    const h = heartbeat(t), res = response();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const app = createApp({ pool: { claimFreePoints: () => pending }, autoClaim: { run: () => pending }, adminToken: 'synthetic', logger: { log() {}, warn() {} } });
    const req = { url, method: 'POST', headers: { 'x-admin-token': 'synthetic' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
    const running = app(req, res);
    await new Promise(resolve => setImmediate(resolve));
    h.tick(); h.tick();
    assert.equal(res.chunks.join(''), '  ');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.equal(res.headers['content-length'], undefined);
    finish([]);
    await running;
    assert.equal(JSON.parse(res.chunks.join('')).ok, true);
    assert.equal(h.cleared(), 1);
    assert.equal(res.listenerCount('close'), 1); // createApp also tracks HTTP disconnects.
    t.mock.restoreAll();
  }
});

test('claim errors before heartbeat preserve HTTP error handling; late errors remain readable', async t => {
  const h = heartbeat(t), res = response();
  await assert.rejects(claimJson(res, async () => { throw new Error('early'); }), /early/);
  assert.equal(res.headersSent, undefined);
  let fail;
  const running = claimJson(res, () => new Promise((resolve, reject) => { fail = reject; }));
  h.tick();
  fail(new Error('late BDUSS=synthetic-secret'));
  await running;
  assert.deepEqual(JSON.parse(res.chunks.join('')), { ok: false, error: { message: 'late BDUSS=<redacted>', type: 'server_error' } });
  assert.equal(h.cleared(), 2);
});

test('disconnect stops heartbeat without cancelling or repeating an already submitted claim', async t => {
  const h = heartbeat(t), res = response();
  let finish, calls = 0;
  const running = claimJson(res, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.tick();
  res.destroyed = true;
  res.emit('close');
  h.tick();
  finish({ ok: true });
  await running;
  assert.equal(calls, 1);
  assert.equal(res.chunks.join(''), ' ');
  assert.equal(res.writableEnded, undefined);
  assert.equal(res.listenerCount('close'), 0);
});
