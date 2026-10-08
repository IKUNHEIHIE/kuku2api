import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, createDatabaseLogger } from '../src/database.mjs';
import { resolveAdminToken } from '../src/admin-token.mjs';
import { createKeyRing } from '../src/store.mjs';
import { createAutoClaim } from '../src/scheduler.mjs';
import { Pool, accountSessionKey } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';

function fixture(t) {
  const parent = path.dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(path.join(parent, '.database-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('.database-')); rmSync(root, { recursive: true, force: true }); });
  return root;
}
const fakeAccount = { id: 'fake', alias: 'fake alias', priority: 0, bduss: 'FAKE-BDUSS', stoken: 'FAKE-STOKEN' };
function memory(t) { const database = openDatabase({ file: ':memory:' }); t.after(() => database.close()); return database; }
const silent = { log() {}, warn() {}, error() {} };
function appFor(database) {
  const pool = new Pool([fakeAccount], { database, sessionStore: database.store('sessions'), logger: silent });
  const logger = createDatabaseLogger(database, { secrets: () => ['fake-admin', 'FAKE-BDUSS', 'FAKE-STOKEN'], consoleOutput: silent });
  const autoClaim = createAutoClaim({ pool, store: database.store('settings'), logger });
  const app = createApp({ pool, database, logger, autoClaim, adminToken: 'fake-admin', ledger: database.ledger });
  return { app, pool, autoClaim };
}
async function call(app, method, url, body = null, headers = { 'x-admin-token': 'fake-admin' }, { disconnect = false } = {}) {
  const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)); } };
  const closeListeners = [];
  const res = { statusCode: 200, headersSent: false, writableEnded: false, writableFinished: false, body: '',
    once(event, fn) { if (event === 'close') closeListeners.push(fn); },
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(value) { this.body += value; if (disconnect) { disconnect = false; this.destroyed = true; closeListeners.forEach((fn) => fn()); } },
    end(value = '') { this.body += value; this.writableEnded = true; this.writableFinished = true; } };
  await app(req, res);
  return { status: res.statusCode, body: res.body, json: res.body.startsWith('{') ? JSON.parse(res.body) : null };
}
function fakeUpstream(pool, { multi = false, fail = false } = {}) {
  const client = pool.accounts[0].client;
  let n = 0;
  client.modelList = async () => ({ model_list: [{ model_name: 'fake-model', display_name: 'Fake' }], think_list: [{ id: '1' }] });
  client.allocateIds = async () => ({ chat_id: 'fake-session', query_id: `reply-${++n}` });
  client.sendmsg = async () => ({});
  client.sse = async function* () {
    yield { data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'hello' } } };
    if (multi) yield { data: { type: 'MODEL_CALL_END', data: { input_tokens: 90, output_tokens: 80, reasoning_tokens: 70 } } };
    yield { data: { type: 'MODEL_CALL_END', data: { input_tokens: 10, output_tokens: 2, reasoning_tokens: 1 } } };
    yield { data: { type: 'ACTUAL_POINT', data: { consume_points: 0.01 } } };
    if (fail) yield { data: { type: 'ERROR', data: { message: 'fake failure' } } };
    yield { data: { type: 'TURN_DONE', data: {} } };
  };
}

test('SQLite migration imports every persisted domain once and preserves the original JSON files', (t) => {
  const root = fixture(t);
  const files = {
    'accounts.json': { accounts: [fakeAccount], default_device_id: 'fake-device' },
    'keys.json': { keys: [{ id: 'key-1', key: 'FAKE-API-KEY', label: 'test' }] },
    'sessions.json': { sessions: [{ key: 'conversation', session_id: 'fake-session', client_session_id: 'client', turn: 2 }] },
    'settings.json': { auto_claim: { enabled: false, hour: 12 } },
    'admin-token.json': { token: 'kuku-admin-' + 'a'.repeat(43) },
    'responses.json': { responses: [{ id: 'resp-1', created_at: 1700000000, model: 'fake-model', account: 'fake', session_key: 'conversation', session_id: 'fake-session', output_text: 'old answer', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, kuku: { consume_points: 0.02 } } }] },
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(root, name), JSON.stringify(data));
  mkdirSync(path.join(root, 'capture'));
  writeFileSync(path.join(root, 'capture/server.log'), 'BDUSS=FAKE-BDUSS\nserver started\n');
  let database = openDatabase({ root });
  assert.deepEqual(database.store('accounts').load(), files['accounts.json']);
  assert.deepEqual(database.store('keys').load(), files['keys.json']);
  assert.deepEqual(database.store('sessions').load(), files['sessions.json']);
  assert.deepEqual(database.store('settings').load(), files['settings.json']);
  assert.equal(database.ledger.get('resp-1').output_text, 'old answer');
  assert.equal(database.conversations().total, 1);
  assert.equal(database.tokenStats().summary.total_tokens, 12);
  assert.equal(database.logs().total, 2);
  assert.ok(!JSON.stringify(database.logs()).includes('FAKE-BDUSS'));
  assert.equal(resolveAdminToken({ store: database.store('admin'), envToken: '', logger: silent }), files['admin-token.json'].token);
  database.close();
  writeFileSync(path.join(root, 'accounts.json'), 'broken backup should never be read again');
  database = openDatabase({ root });
  assert.equal(database.store('accounts').load().accounts.length, 1);
  assert.equal(database.conversations().total, 1);
  assert.equal(database.logs().total, 2);
  database.close();
  assert.equal(readFileSync(path.join(root, 'keys.json'), 'utf8'), JSON.stringify(files['keys.json']));
});

test('a corrupt legacy file rolls back the whole migration and a repaired retry imports cleanly', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ accounts: [fakeAccount] }));
  writeFileSync(path.join(root, 'keys.json'), 'PRIVATE-INVALID-JSON');
  assert.throws(() => openDatabase({ root }), (e) => !e.message.includes('PRIVATE-INVALID-JSON'));
  const check = openDatabase({ root, migrate: false });
  assert.equal(check.store('accounts').load().accounts.length, 0);
  assert.equal(check.sql.prepare("SELECT COUNT(*) n FROM metadata WHERE key='legacy_json_v1'").get().n, 0);
  check.close();
  writeFileSync(path.join(root, 'keys.json'), '{"keys":[]}');
  const repaired = openDatabase({ root });
  assert.equal(repaired.store('accounts').load().accounts.length, 1);
  repaired.close();
});

test('duplicate account identifiers fail atomically without overwriting existing database records', (t) => {
  const database = memory(t);
  const store = database.store('accounts');
  store.save({ accounts: [fakeAccount] });
  assert.throws(() => store.save({ accounts: [fakeAccount, fakeAccount] }));
  assert.deepEqual(store.load().accounts, [fakeAccount]);
});

test('a missing key table or newer schema refuses startup rather than silently reopening access', (t) => {
  const root = fixture(t);
  const database = openDatabase({ root });
  database.sql.exec('DROP TABLE api_keys');
  database.close();
  assert.throws(() => openDatabase({ root }), /schema is incomplete/);
  const otherRoot = fixture(t);
  const newer = openDatabase({ root: otherRoot });
  newer.sql.exec('PRAGMA user_version=99'); newer.close();
  assert.throws(() => openDatabase({ root: otherRoot }), /schema is newer/);
});

test('invalid private database JSON refuses reads without quoting the secret', (t) => {
  const database = memory(t);
  database.sql.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('admin', 'PRIVATE-INVALID-SECRET');
  assert.throws(() => resolveAdminToken({ store: database.store('admin'), envToken: '', logger: silent }), (e) => !e.message.includes('PRIVATE-INVALID-SECRET'));
  database.sql.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('settings', 'PRIVATE-BAD-SCHEDULER');
  assert.throws(() => createAutoClaim({ pool: {}, store: database.store('settings'), logger: silent }), (e) => !e.message.includes('PRIVATE-BAD-SCHEDULER'));
  assert.equal(database.sql.prepare("SELECT value FROM settings WHERE key='settings'").get().value, 'PRIVATE-BAD-SCHEDULER');
});

test('SQLite keys, administrator token, scheduler settings and session state survive reopen', (t) => {
  const root = fixture(t);
  let database = openDatabase({ root });
  const ring = createKeyRing({ store: database.store('keys') });
  const issued = ring.add('fake');
  const output = [];
  const admin = resolveAdminToken({ store: database.store('admin'), envToken: '', logger: { log: (s) => output.push(s) } });
  assert.ok(output.some((s) => s === admin));
  const pool = new Pool([fakeAccount], { sessionStore: database.store('sessions') });
  pool.sessions.set(accountSessionKey('fake', 'key'), { session_id: 'session', client_session_id: 'client', turn: 3, account: 'fake', logical_key: 'key', upstream_user_id: null });
  pool.persistSessions();
  const scheduler = createAutoClaim({ pool, store: database.store('settings') });
  scheduler.configure({ enabled: false, hour: 13 });
  database.updateSystemSettings({ site_name: 'Saved Name' });
  database.close();
  database = openDatabase({ root });
  assert.equal(createKeyRing({ store: database.store('keys') }).ok(issued.key), true);
  assert.equal(resolveAdminToken({ store: database.store('admin'), envToken: '', logger: { log() { assert.fail('secret printed again'); } } }), admin);
  assert.equal(new Pool([fakeAccount], { sessionStore: database.store('sessions') }).sessions.get(accountSessionKey('fake', 'key')).turn, 3);
  assert.equal(createAutoClaim({ pool, store: database.store('settings') }).state.hour, 13);
  assert.equal(database.systemSettings().site_name, 'Saved Name');
  database.close();
});

test('SQL response ledger keeps stable insertion order, updates in place and preserves restart chaining', (t) => {
  const root = fixture(t);
  let database = openDatabase({ root });
  database.ledger.put({ id: 'one', created_at: 1, session_key: 'key' });
  database.ledger.put({ id: 'two', created_at: 1, session_key: 'key' });
  database.ledger.put({ id: 'one', created_at: 1, session_key: 'updated' });
  assert.deepEqual(database.ledger.list().map((r) => r.id), ['one', 'two']);
  database.close();
  database = openDatabase({ root });
  assert.equal(database.ledger.get('one').session_key, 'updated');
  assert.equal(database.ledger.del('two'), true);
  assert.equal(database.ledger.size(), 1);
  database.close();
});

test('streamed and nonstreamed Chat and Responses record real prompts, replies and usage through the gateway', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  fakeUpstream(pool);
  for (const stream of [false, true]) {
    assert.equal((await call(app, 'POST', '/v1/chat/completions', { model: 'fake-model', messages: [{ role: 'user', content: 'prompt' }], stream })).status, 200);
    assert.equal((await call(app, 'POST', '/v1/responses', { model: 'fake-model', input: 'response prompt', stream })).status, 200);
  }
  assert.equal(database.conversations().total, 4);
  assert.equal(database.tokenStats().summary.total_tokens, 48);
  assert.equal(database.tokenStats({}, 'source').groups.length, 2);
  const record = database.conversation(database.conversations().data[0].id);
  assert.equal(record.output_text, 'hello');
  assert.equal(record.messages[0].content, 'response prompt');
  assert.equal(record.model_call_count, 1);
  assert.equal(database.ledger.size(), 2);
});

test('multi-call usage keeps raw events and explicitly counts only the final reported call', async (t) => {
  const database = memory(t);
  const { pool } = appFor(database);
  fakeUpstream(pool, { multi: true });
  await pool.chat({ account: pool.accounts[0], model: { id: 'fake-model' }, messages: [{ role: 'user', content: 'test' }] });
  const stats = database.tokenStats();
  assert.equal(stats.summary.total_tokens, 12);
  assert.equal(stats.summary.partial_usage_attempts, 1);
  const record = database.conversation(database.conversations().data[0].id);
  assert.equal(record.usage_events.length, 2);
  assert.equal(record.usage_scope, 'last_model_call');
});

test('SQL Responses paging filters private turns and resolves stable cursors', (t) => {
  const database = memory(t);
  database.ledger.put({ id: 'one', session_key: 'a' });
  database.ledger.put({ id: 'private', session_key: 'a', output_text: 'PRIVATE-ANSWER', response: { store: false, output_text: 'PRIVATE-ANSWER', output: [{ text: 'PRIVATE-ANSWER' }] } });
  database.ledger.put({ id: 'two', session_key: 'a' });
  database.ledger.put({ id: 'other', session_key: 'b' });
  const first = database.ledger.page({ limit: 1, sessionKey: 'a' });
  assert.equal(first.records[0].id, 'two'); assert.equal(first.has_more, true);
  assert.deepEqual(database.ledger.page({ sessionKey: 'a', after: 'two' }).records.map((r) => r.id), ['one']);
  assert.throws(() => database.ledger.page({ sessionKey: 'a', after: 'other' }), (e) => e.cursor);
  assert.ok(!JSON.stringify(database.ledger.get('private')).includes('PRIVATE-ANSWER'));
});

test('private Responses keep only chaining metadata, stay unreadable, and still allow the next turn', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  fakeUpstream(pool);
  const first = await call(app, 'POST', '/v1/responses', { model: 'fake-model', input: 'PRIVATE-INPUT', store: false });
  assert.equal(first.status, 200);
  assert.equal((await call(app, 'GET', `/v1/responses/${first.json.id}`)).status, 404);
  assert.equal((await call(app, 'GET', '/v1/responses')).json.data.length, 0);
  assert.equal((await call(app, 'POST', '/v1/responses', { model: 'fake-model', input: 'next', previous_response_id: first.json.id })).status, 200);
  const privateTurn = database.conversations().data.find((r) => r.content_stored === 0);
  assert.equal(database.conversation(privateTurn.id).messages, null);
});

test('deleting a stored Response removes its corresponding conversation archive without erasing token statistics', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  fakeUpstream(pool);
  const first = await call(app, 'POST', '/v1/responses', { model: 'fake-model', input: 'delete test' });
  assert.equal(database.conversations().total, 1);
  assert.equal((await call(app, 'DELETE', `/v1/responses/${first.json.id}`)).status, 200);
  assert.equal(database.conversations().total, 0);
  assert.equal(database.ledger.size(), 0);
  assert.equal(database.tokenStats().summary.total_tokens, 12);
});

test('failed paid attempts retain observed partial output, tokens and point cost', async (t) => {
  const database = memory(t);
  const { pool } = appFor(database);
  fakeUpstream(pool, { fail: true });
  await assert.rejects(pool.chat({ account: pool.accounts[0], model: { id: 'fake-model' }, messages: [{ role: 'user', content: 'test' }] }));
  const stats = database.tokenStats().summary;
  assert.equal(stats.failed, 1);
  assert.equal(stats.total_tokens, 12);
  assert.equal(stats.consume_points, 0.01);
  assert.equal(database.conversation(database.conversations().data[0].id).output_text, 'hello');
});

test('cancelled turns and explicit reward conversations are recorded with distinct statuses and sources', async (t) => {
  const database = memory(t);
  const { pool } = appFor(database);
  fakeUpstream(pool);
  await pool.chat({ account: pool.accounts[0], model: { id: 'fake-model' }, messages: [{ role: 'user', content: 'cancel' }] }, () => {}, { aborted: true });
  assert.equal(database.tokenStats().summary.cancelled, 1);
  const client = pool.accounts[0].client;
  let ready = false, paid = false;
  client.freePointHome = async () => ({ activities: [{ activity_key: 'daily', period_no: 1, tabs: [{ tasks: [{ task_type: 'CHAT', task_key: 'daily_chat', task_status: paid ? 'FINISHED' : 'UNFINISHED', claimable_point: ready && !paid ? 50 : 0 }] }] }] });
  client.claimTask = async () => { ready = true; return { complete_status: 'SUCCESS' }; };
  client.claimReward = async () => { paid = true; return { claim_status: 'SUCCESS', claimed_point: 50 }; };
  assert.equal((await pool.claimFreePoints({ runChat: true, chatModel: 'fake-model' }))[0].points_earned, 50);
  assert.equal(database.tokenStats({ source: 'claim' }).summary.attempts, 1);
});

test('a disconnected streaming client records a cancelled turn and an HTTP 499 log without another account retry', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  fakeUpstream(pool);
  await call(app, 'POST', '/v1/chat/completions', { model: 'fake-model', messages: [{ role: 'user', content: 'stream' }], stream: true }, undefined, { disconnect: true });
  assert.equal(database.tokenStats().summary.cancelled, 1);
  assert.ok(database.logs().data.some((r) => r.kind === 'http' && r.status === 499));
});

test('store:false avoids new conversation-content storage but retains usage statistics', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  fakeUpstream(pool);
  await call(app, 'POST', '/v1/chat/completions', { model: 'fake-model', messages: [{ role: 'user', content: 'PRIVATE-PROMPT' }], store: false });
  const record = database.conversation(database.conversations().data[0].id);
  assert.equal(record.messages, null);
  assert.equal(record.output_text, null);
  assert.equal(record.content_stored, 0);
  assert.equal(database.tokenStats().summary.total_tokens, 12);
});

test('token statistics filter and group without SQL injection or fabricated usage', (t) => {
  const database = memory(t);
  database.recordTurn({ model: 'one', account: 'a', created_at: Date.parse('2026-10-01T23:00:00Z'), result: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } });
  database.recordTurn({ model: 'two', account: 'b', created_at: Date.parse('2026-10-02T01:00:00Z'), result: {} });
  assert.equal(database.tokenStats({ model: 'one' }).summary.total_tokens, 12);
  assert.equal(database.tokenStats({ model: "' OR 1=1 --" }).summary.attempts, 0);
  assert.equal(database.tokenStats().summary.usage_known_attempts, 1);
  assert.equal(database.tokenStats().summary.points_known_attempts, 0);
  assert.deepEqual(database.tokenStats().groups.map((g) => g.bucket), ['2026-10-01', '2026-10-02']);
});

test('every new administrator API rejects anonymous and ordinary-key requests', async (t) => {
  const database = memory(t);
  const { app } = appFor(database);
  for (const endpoint of ['stats/tokens', 'conversations', 'conversations/missing', 'logs', 'settings']) {
    assert.equal((await call(app, 'GET', '/pool/admin/' + endpoint, null, {})).status, 401);
    assert.equal((await call(app, 'GET', '/pool/admin/' + endpoint, null, { 'x-api-key': 'user-key' })).status, 401);
  }
});

test('statistics, history detail and logs endpoints paginate and validate dates and filters', async (t) => {
  const database = memory(t);
  const { app } = appFor(database);
  database.recordTurn({ id: 'one', model: 'fake-model', account: 'fake', messages: [{ role: 'user', content: 'old prompt' }] });
  database.recordTurn({ id: 'two', model: 'fake-model', account: 'fake' });
  const page = await call(app, 'GET', '/pool/admin/conversations?limit=1&offset=1');
  assert.equal(page.json.total, 2); assert.equal(page.json.data.length, 1);
  assert.equal((await call(app, 'GET', '/pool/admin/conversations/one')).json.data.messages[0].content, 'old prompt');
  assert.equal((await call(app, 'GET', '/pool/admin/conversations/missing')).status, 404);
  assert.equal((await call(app, 'GET', '/pool/admin/stats/tokens?group_by=model')).json.summary.attempts, 2);
  for (const query of ['limit=0', 'offset=-1', 'from=no-date', 'from=2026-02-30', 'from=2026-10-03&to=2026-10-02', 'status=bad']) {
    assert.equal((await call(app, 'GET', '/pool/admin/conversations?' + query)).status, 400);
  }
  assert.equal((await call(app, 'GET', '/pool/admin/stats/tokens?group_by=bad')).status, 400);
  assert.equal((await call(app, 'GET', '/pool/admin/logs?level=bad')).status, 400);
  assert.ok((await call(app, 'GET', '/pool/admin/logs?limit=1')).json.total > 0);
});

test('settings patches are validated before changing any field and persist without exposing private settings', async (t) => {
  const database = memory(t);
  const { app } = appFor(database);
  resolveAdminToken({ store: database.store('admin'), envToken: '', logger: silent });
  assert.equal((await call(app, 'PATCH', '/pool/admin/settings', { site_name: 'Should Not Save', log_retention_days: -1 })).status, 400);
  assert.equal(database.systemSettings().site_name, 'kuku2api');
  const saved = await call(app, 'PATCH', '/pool/admin/settings', { site_name: 'Saved Name', log_retention_days: 0 });
  assert.equal(saved.json.settings.site_name, 'Saved Name');
  assert.ok(!saved.body.includes('kuku-admin-'));
  assert.equal((await call(app, 'PATCH', '/pool/admin/settings', { adminToken: 'no' })).status, 400);
});

test('failed scheduler database writes cannot activate an unsaved automatic claiming configuration', () => {
  const store = { load: () => ({ auto_claim: { enabled: false, hour: 9 } }), save() { throw new Error('fake disk failure'); } };
  const scheduler = createAutoClaim({ pool: {}, store, logger: silent });
  assert.throws(() => scheduler.configure({ enabled: true, hour: 12 }));
  assert.equal(scheduler.state.enabled, false);
  assert.equal(scheduler.state.hour, 9);
});

test('operational logs redact cookies, bearer tokens and known secrets and never record request payloads or queries', async (t) => {
  const database = memory(t);
  const { app } = appFor(database);
  const logger = createDatabaseLogger(database, { secrets: () => ['PRIVATE-KEY'], consoleOutput: silent });
  logger.warn('BDUSS=COOKIE PTOKEN=TICKET STOKEN=SESSION Authorization=Bearer SECRET PRIVATE-KEY');
  logger.error('{"token":"JSON-SECRET"}');
  await call(app, 'POST', '/nonexistent?token=QUERY-SECRET', { token: 'BODY-SECRET' }, { authorization: 'Bearer HEADER-SECRET' });
  const logs = JSON.stringify(database.logs());
  for (const secret of ['COOKIE', 'TICKET', 'SESSION', 'SECRET', 'PRIVATE-KEY', 'JSON-SECRET', 'QUERY-SECRET', 'BODY-SECRET', 'HEADER-SECRET']) assert.ok(!logs.includes(secret), secret);
  assert.ok(logs.includes('<redacted>'));
});

test('history and log retention leave lifetime token statistics intact', (t) => {
  const database = memory(t);
  const now = Date.now();
  database.recordTurn({ id: 'old', created_at: now - 40 * 86400000, result: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } });
  database.ledger.put({ id: 'old-response', created_at: Math.floor((now - 40 * 86400000) / 1000) });
  database.addLog({ created_at: now - 40 * 86400000, message: 'old log' });
  database.updateSystemSettings({ conversation_retention_days: 30 });
  database.prune(now);
  assert.equal(database.conversations().total, 0);
  assert.equal(database.logs().total, 0);
  assert.equal(database.ledger.size(), 0);
  assert.equal(database.tokenStats().summary.total_tokens, 12);
});

test('a persistence failure never causes a second paid upstream inference through failover', async (t) => {
  const database = memory(t);
  const { app, pool } = appFor(database);
  pool.set([fakeAccount, { ...fakeAccount, id: 'other', priority: 1 }]);
  fakeUpstream(pool);
  let calls = 0;
  const first = pool.accounts[0].client.sendmsg;
  pool.accounts[0].client.sendmsg = async (args) => { calls++; return first(args); };
  pool.accounts[1].client.allocateIds = async () => { assert.fail('second account must not be tried'); };
  database.recordTurn = () => { throw new Error('fake storage failure'); };
  assert.equal((await call(app, 'POST', '/v1/chat/completions', { model: 'fake-model', messages: [{ role: 'user', content: 'test' }] })).status, 500);
  assert.equal(calls, 1);
});
