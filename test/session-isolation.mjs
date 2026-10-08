// No real upstream, credentials or paid calls. Both APIs exercise the actual Pool session path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, MODEL_INDEX, accountSessionKey } from '../src/gateway.mjs';
import { UpstreamError } from '../src/upstream.mjs';
import { createApp } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';
const records = ['a', 'b'].map((id, i) => ({ id, alias: `alias-${id}`, priority: i, bduss: 'synthetic', stoken: 'synthetic', upstream_user_id: String(101 + i) }));
const body = { model: 'isolation-model', messages: [{ role: 'user', content: 'synthetic' }] };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function setup(t, { database = null, onSend = null } = {}) {
  const db = database ?? openDatabase({ file: ':memory:' });
  if (!database) t.after(() => db.close());
  MODEL_INDEX.set('isolation-model', { model_name: 'isolation-model', display_name: 'Synthetic' });
  t.after(() => MODEL_INDEX.delete('isolation-model'));
  const pool = new Pool(records, { database: db, sessionStore: db.store('sessions'), logger: { warn() {}, log() {} } });
  const calls = { alloc: [], send: [], sse: [] };
  let seq = 0;
  for (const a of pool.accounts) {
    a.client.allocateIds = async () => { calls.alloc.push(a.id); return { chat_id: `session-${a.id}-${++seq}`, query_id: `reply-${a.id}-${seq}` }; };
    a.client.sendmsg = async p => { calls.send.push({ account: a.id, ...p }); if (onSend) await onSend(a, p); };
    a.client.ownsSession = async () => true;
    a.client.sse = async function* (p) { calls.sse.push({ account: a.id, ...p }); yield { data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'synthetic' } } }; yield { data: { type: 'TURN_DONE', data: { reply_id: p.reply_id } } }; };
  }
  const app = createApp({ pool, database: db, ledger: db.ledger, adminToken: 'synthetic-admin' });
  const chat = (id, key = 'shared') => pool.chat({ account: pool.accounts.find(a => a.id === id), model: { id: body.model }, messages: body.messages, sessionKey: key });
  return { pool, db, calls, app, chat };
}
async function request(app, route, payload, headers = {}) {
  const req = { url: route, method: 'POST', headers, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
  const res = { statusCode: 200, writableFinished: false, body: '', writeHead(s) { this.statusCode = s; }, write(x) { this.body += x; }, end(x = '') { this.body += x; this.writableFinished = true; } };
  await app(req, res);
  return { status: res.statusCode, json: res.body.startsWith('{') ? JSON.parse(res.body) : null, text: res.body };
}
const response = (s, payload = {}, headers = {}) => request(s.app, '/v1/responses', { model: body.model, input: 'synthetic', ...payload }, headers);

test('identical custom keys and default prompts allocate different upstream sessions per account', async t => {
  const s = setup(t);
  for (const key of ['shared', null]) {
    const a = await s.chat('a', key); const b = await s.chat('b', key);
    assert.notEqual(a.session_id, b.session_id);
    assert.equal((await s.chat('a', key)).session_id, a.session_id);
  }
  assert.ok(s.calls.send.every(c => c.session_id.startsWith(`session-${c.account}-`)));
});

test('external keys resembling internal keys cannot select another account session; tuple encoding avoids separator collisions', async t => {
  const s = setup(t); const other = await s.chat('b');
  const own = await s.chat('a', accountSessionKey('b', 'shared'));
  assert.notEqual(own.session_id, other.session_id);
  assert.notEqual(accountSessionKey('a:b', 'c'), accountSessionKey('a', 'b:c'));
});

test('Chat and Responses reuse the same account-scoped session, and separate another account', async t => {
  const s = setup(t);
  const a = await request(s.app, '/v1/chat/completions', body, { 'x-kuku-account': 'a', 'x-kuku-session': 'shared' });
  const same = await response(s, {}, { 'x-kuku-account': 'a', 'x-kuku-session': 'shared' });
  const other = await response(s, {}, { 'x-kuku-account': 'b', 'x-kuku-session': 'shared' });
  assert.equal(a.json.kuku.session_id, same.json.kuku.session_id);
  assert.notEqual(a.json.kuku.session_id, other.json.kuku.session_id);
});

test('concurrent Chat and Responses on one account/key serialize allocation and complete turns', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred(); let active = 0, maximum = 0;
  const s = setup(t, { onSend: async () => { active++; maximum = Math.max(maximum, active); if (s.calls.send.length === 1) { entered.resolve(); await release.promise; } active--; } });
  const first = request(s.app, '/v1/chat/completions', body, { 'x-kuku-account': 'a', 'x-kuku-session': 'shared' });
  await entered.promise;
  const second = response(s, {}, { 'x-kuku-account': 'a', 'x-kuku-session': 'shared' });
  try { await new Promise(r => setTimeout(r, 20)); assert.equal(s.calls.send.length, 1); }
  finally { release.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.equal(a.json.kuku.session_id, b.json.kuku.session_id);
  assert.equal(s.pool.queues.size, 0);
});

test('the same key on different accounts does not share a queue or block the other account', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred();
  const s = setup(t, { onSend: async a => { if (a.id === 'a') { entered.resolve(); await release.promise; } } });
  const first = s.chat('a'); await entered.promise;
  try { const second = await s.chat('b'); assert.ok(second.session_id.startsWith('session-b-')); }
  finally { release.resolve(); }
  await first;
});

test('SQLite restores owner metadata and reuses each original session after restart', async t => {
  const s = setup(t); const a = await s.chat('a'); const b = await s.chat('b');
  const restarted = setup(t, { database: s.db });
  assert.equal((await restarted.chat('a')).session_id, a.session_id);
  assert.equal((await restarted.chat('b')).session_id, b.session_id);
  assert.equal(restarted.pool.sessions.get(accountSessionKey('a', 'shared')).upstream_user_id, '101');
});

test('legacy ownership proven by saved account history migrates only to that account', async t => {
  const s = setup(t);
  s.pool.sessions.set('shared', { session_id: 'legacy-a', client_session_id: 'legacy', turn: 2 });
  s.db.recordTurn({ account: 'a', session_key: 'shared', result: { session_id: 'legacy-a' } });
  assert.equal((await s.chat('a')).session_id, 'legacy-a');
  assert.notEqual((await s.chat('b')).session_id, 'legacy-a');
  assert.equal(s.pool.sessions.get('shared').turn, 2); // Preserve the original unscoped record.
});

test('a legacy key prefix does not prove account ownership; a fresh conversation leaves unknown history intact', async t => {
  const s = setup(t); const key = 'k:a:synthetic';
  s.pool.sessions.set(key, { session_id: 'unverified', turn: 9 });
  assert.notEqual((await s.chat('a', key)).session_id, 'unverified');
  assert.equal(s.pool.sessions.get(key).turn, 9);
});

test('legacy Responses metadata can restore a verified continuation without allocating another session', async t => {
  const s = setup(t);
  s.pool.sessions.set('old-key', { session_id: 'legacy-a', client_session_id: 'legacy', turn: 2 });
  s.db.ledger.put({ id: 'old-response', account: 'a', session_key: 'old-key', session_id: 'legacy-a' });
  const out = await response(s, { previous_response_id: 'old-response' });
  assert.equal(out.status, 200); assert.equal(out.json.kuku.session_id, 'legacy-a');
  assert.equal(s.calls.alloc.length, 1); // New reply only.
});

test('ambiguous legacy ownership cannot be resumed through previous_response_id', async t => {
  const s = setup(t);
  s.pool.sessions.set('old-key', { session_id: 'mixed', turn: 2 });
  s.db.ledger.put({ id: 'old-response', account: 'a', session_key: 'old-key', session_id: 'mixed' });
  s.db.recordTurn({ account: 'b', status: 'failed', result: { session_id: 'mixed' } });
  const out = await response(s, { previous_response_id: 'old-response' });
  assert.equal(out.status, 409); assert.equal(out.json.error.code, 'session_history_unavailable');
  assert.equal(s.calls.alloc.length, 0);
});

test('stored owner mismatch and replacement of an account identity refuse session reuse before upstream calls', async t => {
  const s = setup(t); await s.chat('a');
  const before = s.calls.alloc.length; const a = s.pool.accounts[0]; a.upstream_user_id = '999';
  await assert.rejects(s.chat('a'), e => e.code === 'session_account_mismatch');
  a.upstream_user_id = '101'; s.pool.sessions.get(accountSessionKey('a', 'shared')).account = 'b';
  await assert.rejects(s.chat('a'), e => e.code === 'session_account_mismatch');
  assert.equal(s.calls.alloc.length, before);
});

test('previous_response_id cannot switch account, but accepts the original account alias', async t => {
  const s = setup(t); const original = await response(s, {}, { 'x-kuku-account': 'a', 'x-kuku-session': 'shared' });
  const before = s.calls.send.length;
  const rejected = await response(s, { previous_response_id: original.json.id }, { 'x-kuku-account': 'b' });
  assert.equal(rejected.status, 409); assert.equal(rejected.json.error.code, 'response_account_mismatch');
  assert.equal(s.calls.send.length, before);
  assert.equal((await response(s, { previous_response_id: original.json.id }, { 'x-kuku-account': 'alias-a' })).status, 200);
});

for (const state of ['disabled', 'auth_dead', 'cooldown_until', 'balance_dead_until']) {
  test(`continuation cannot bypass the original account ${state} gate or select another account`, async t => {
    const s = setup(t); const original = await response(s, {}, { 'x-kuku-account': 'a' }); const before = s.calls.send.length;
    s.pool.accounts[0][state] = state.endsWith('_until') ? Date.now() + 100000 : true;
    const out = await response(s, { previous_response_id: original.json.id });
    assert.equal(out.status, 409); assert.equal(out.json.error.code, 'response_account_unavailable');
    assert.equal(s.calls.send.length, before);
  });
}

test('a deleted continuation account fails instead of silently resuming its session with another credential', async t => {
  const s = setup(t); const original = await response(s, {}, { 'x-kuku-account': 'a' }); const before = s.calls.send.length;
  s.pool.accounts = s.pool.accounts.filter(a => a.id !== 'a');
  const out = await response(s, { previous_response_id: original.json.id });
  assert.equal(out.status, 404); assert.equal(out.json.error.code, 'response_account_not_found');
  assert.equal(s.calls.send.length, before);
});

test('failure while continuing a pinned account never retries another account', async t => {
  const s = setup(t); const original = await response(s, {}, { 'x-kuku-account': 'a' });
  s.pool.accounts[0].client.sendmsg = async () => { throw new UpstreamError('synthetic insufficient balance', { code: 11002, insufficient_balance: true }); };
  const out = await response(s, { previous_response_id: original.json.id });
  assert.equal(out.status, 402); assert.ok(s.calls.send.every(c => c.account === 'a'));
});

test('new Responses may fail over, but allocate in the actual account namespace and pin subsequent continuation', async t => {
  const s = setup(t);
  s.pool.accounts[0].client.sendmsg = async () => { throw new UpstreamError('synthetic insufficient balance', { code: 11002, insufficient_balance: true }); };
  const first = await response(s, {}, { 'x-kuku-session': 'shared' });
  assert.equal(first.status, 200); assert.equal(first.json.kuku.account, 'b');
  assert.notEqual(s.pool.sessions.get(accountSessionKey('a', 'shared')).session_id, first.json.kuku.session_id);
  const next = await response(s, { previous_response_id: first.json.id });
  assert.equal(next.json.kuku.session_id, first.json.kuku.session_id); assert.equal(next.json.kuku.account, 'b');
});

test('missing continuation session and missing historical ownership never silently start a new conversation', async t => {
  const s = setup(t); const original = await response(s); s.pool.sessions.clear(); const before = s.calls.alloc.length;
  const missing = await response(s, { previous_response_id: original.json.id });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error.code, 'session_history_unavailable');
  s.db.ledger.put({ id: 'unowned', session_key: 'old', session_id: 'old' });
  assert.equal((await response(s, { previous_response_id: 'unowned' })).json.error.code, 'response_account_unverified');
  assert.equal(s.calls.alloc.length, before);
});

test('failed persistence rolls back a proposed session migration and prevents upstream calls', async t => {
  const s = setup(t);
  s.pool.sessions.set('shared', { session_id: 'legacy-a', turn: 2 });
  s.db.recordTurn({ account: 'a', result: { session_id: 'legacy-a' } });
  s.pool.sessionStore = { immediate: true, save() { throw new Error('synthetic disk failure'); } };
  await assert.rejects(s.chat('a'), e => e.persistence);
  assert.equal(s.pool.sessions.has(accountSessionKey('a', 'shared')), false);
  assert.equal(s.calls.alloc.length, 0);
});

test('a queued request captured before an account identity replacement cannot send with stale credentials', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred();
  const s = setup(t, { onSend: async () => { entered.resolve(); await release.promise; } });
  const first = s.chat('a'); await entered.promise;
  const captured = s.pool.accounts[0];
  const pending = s.pool.chat({ account: captured, model: { id: body.model }, messages: body.messages, sessionKey: 'shared' });
  const rejected = assert.rejects(pending, e => e.code === 'session_account_mismatch');
  s.pool.set([{ ...records[0], upstream_user_id: '999' }, records[1]]);
  release.resolve(); await first; await rejected;
  assert.equal(s.calls.send.length, 1);
});

test('a stale account object after deletion cannot create or reuse any upstream session', async t => {
  const s = setup(t); const captured = s.pool.accounts[0];
  s.pool.accounts = s.pool.accounts.filter(a => a.id !== captured.id);
  await assert.rejects(s.pool.chat({ account: captured, model: { id: body.model }, messages: body.messages, sessionKey: 'shared' }), e => e.code === 'session_account_mismatch');
  assert.equal(s.calls.alloc.length, 0);
});

test('legacy account labels cannot override a failed upstream ownership check', async t => {
  const s = setup(t);
  s.pool.sessions.set('old-key', { session_id: 'former-user', turn: 2 });
  s.db.ledger.put({ id: 'old-response', account: 'a', session_key: 'old-key', session_id: 'former-user' });
  s.pool.accounts[0].client.ownsSession = async () => false;
  const out = await response(s, { previous_response_id: 'old-response' });
  assert.equal(out.status, 409); assert.equal(out.json.error.code, 'session_history_unavailable');
  assert.equal(s.calls.alloc.length, 0);
});

test('ownership-check network failure does not migrate or send a paid turn', async t => {
  const s = setup(t);
  s.pool.sessions.set('shared', { session_id: 'legacy-a', turn: 2 });
  s.db.recordTurn({ account: 'a', result: { session_id: 'legacy-a' } });
  s.pool.accounts[0].client.ownsSession = async () => { throw new Error('synthetic unreachable'); };
  await assert.rejects(s.chat('a'), e => e.code === 'session_history_unavailable');
  assert.equal(s.pool.sessions.has(accountSessionKey('a', 'shared')), false);
  assert.equal(s.calls.alloc.length, 0);
});

test('legacy ownership probe is read-only, requests no messages and validates the returned session id', async t => {
  const s = setup(t); const client = new (await import('../src/upstream.mjs')).KukuAccount(records[0]);
  client.json = async (path, options) => {
    assert.equal(path, '/api/genflowpro/workspace/getsessiondetail');
    assert.deepEqual(options.body, { session_id: 'existing', offset: 0, size: 0 });
    return { session_id: 'existing' };
  };
  assert.equal(await client.ownsSession('existing'), true);
  client.json = async () => ({ session_id: 'different' });
  assert.equal(await client.ownsSession('existing'), false);
});

test('an alias matching another account id cannot redirect account selection or its continuation', async t => {
  const s = setup(t); s.pool.accounts[0].alias = 'b';
  assert.equal(s.pool.resolve('b').id, 'b');
  const original = await response(s, {}, { 'x-kuku-account': 'b' });
  assert.equal(original.json.kuku.account, 'b');
  const next = await response(s, { previous_response_id: original.json.id }, { 'x-kuku-account': 'b' });
  assert.equal(next.status, 200); assert.equal(next.json.kuku.account, 'b');
});

test('identity replacement during an awaited allocation is rechecked before sending the conversation', { timeout: 2000 }, async t => {
  const s = setup(t); const entered = deferred(), release = deferred(); const a = s.pool.accounts[0];
  const original = a.client.allocateIds; let first = true;
  a.client.allocateIds = async (...args) => { if (first) { first = false; entered.resolve(); await release.promise; } return original(...args); };
  const turn = s.chat('a'); const rejected = assert.rejects(turn, e => e.code === 'session_account_mismatch');
  await entered.promise; s.pool.set([{ ...records[0], upstream_user_id: '999' }, records[1]]); release.resolve(); await rejected;
  assert.equal(s.calls.send.length, 0);
});

test('a session-save failure after sendmsg cannot cause a second paid attempt on another account', async t => {
  const s = setup(t); let saves = 0;
  s.pool.sessionStore = { immediate: true, save() { if (++saves === 2) throw new Error('synthetic disk failure'); } };
  const out = await response(s);
  assert.equal(out.status, 500);
  assert.equal(s.calls.send.length, 1);
  assert.equal(s.calls.send[0].account, 'a');
  assert.equal(s.pool.queues.size, 0);
});
