// Synthetic accounts, streams and isolated SQLite only; never contact the real upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';
import { KukuAccount, UpstreamError } from '../src/upstream.mjs';
import { createLedger } from '../src/ledger.mjs';
import { toRecords } from '../src/store.mjs';

const model = 'audit-fixture-model';
function setup(t, count = 1) {
  const db = openDatabase({ file: ':memory:' });
  MODEL_INDEX.set(model, { model_name: model });
  t.after(() => { db.close(); MODEL_INDEX.delete(model); });
  const records = Array.from({ length: count }, (_, i) => ({ id: `fake-${i}`, priority: 5-i, bduss: 'synthetic', stoken: 'synthetic' }));
  const pool = new Pool(records, { database: db, sessionStore: db.store('sessions'), logger: { warn() {} } });
  let seq = 0;
  const sends = [];
  for (const a of pool.accounts) {
    a.client.allocateIds = async () => ({ chat_id: `session-${++seq}`, query_id: `reply-${seq}` });
    a.client.sendmsg = async p => { sends.push({ account: a.id, ...p }); };
    a.client.sse = async function*(p) {
      yield { data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'synthetic answer' } } };
      yield { data: { type: 'TURN_DONE', data: { reply_id: p.reply_id } } };
    };
  }
  const app = createApp({ pool, database: db, ledger: db.ledger, adminToken: 'synthetic-admin', logger: { warn() {} } });
  return { db, pool, sends, app };
}
async function call(app, url, body, headers = {}, method = 'POST') {
  const req = { url, method, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: 200, body: '', writeHead(s) { this.statusCode=s; }, write(s) { this.body+=s; }, end(s='') { this.body+=s; } };
  await app(req, res);
  return { status: res.statusCode, text: res.body, json: res.body.startsWith('{') ? JSON.parse(res.body) : null };
}
const responses = (app, extra = {}, headers = {}) => call(app, '/v1/responses', { model, input: 'same opening', ...extra }, headers);
const events = text => text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));

for (const reasoningOnly of [false, true]) {
  test(`Responses stream failure after ${reasoningOnly ? 'reasoning' : 'text'} preserves partial data and never reports completion or fails over`, async t => {
    const s = setup(t, 2);
    for (const a of s.pool.accounts) a.client.sse = async function*() {
      yield { data: { type: reasoningOnly ? 'THINKING_BLOCK_DELTA' : 'TEXT_BLOCK_DELTA', data: { delta: 'synthetic partial' } } };
      yield { data: { type: 'MODEL_CALL_END', data: { input_tokens: 8, output_tokens: 2 } } };
      yield { data: { type: 'ACTUAL_POINT', data: { consume_points: 0.03 } } };
      throw new UpstreamError('synthetic stream failure', { network: true, status: 502 });
    };
    const result = await responses(s.app, { stream: true });
    const frames = events(result.text);
    assert.ok(!frames.some(e => e.type === 'response.completed'));
    const failed = frames.at(-1);
    assert.equal(failed.type, 'response.failed');
    assert.equal(failed.response.status, 'failed');
    assert.equal(failed.response.usage.total_tokens, 10);
    assert.equal(failed.response.kuku.consume_points, 0.03);
    assert.equal(reasoningOnly ? failed.response.output[0].summary[0].text : failed.response.output_text, 'synthetic partial');
    assert.equal(s.sends.length, 1);
    const saved = s.db.ledger.get(failed.response.id);
    assert.equal(saved.response.status, 'failed');
    assert.equal((await call(s.app, '/v1/responses/'+saved.id, undefined, {}, 'GET')).json.status, 'failed');
    const usage = s.db.sql.prepare('SELECT u.status,u.total_tokens,u.consume_points,c.session_key FROM usage_records u JOIN conversation_turns c ON c.id=u.id').all();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.equal(usage[0].session_key, saved.session_key);
    assert.equal(usage[0].total_tokens, 10);
  });
}

test('identical independent requests get new sessions; explicit headers and previous_response_id still continue', async t => {
  const s = setup(t);
  for (const input of ['same opening', 'x'.repeat(201)]) {
    const a = (await responses(s.app, { input })).json;
    const b = (await responses(s.app, { input })).json;
    assert.notEqual(a.kuku.session_id, b.kuku.session_id);
    const c = (await responses(s.app, { input: 'continue', previous_response_id: a.id })).json;
    assert.equal(c.kuku.session_id, a.kuku.session_id);
  }
  const payload = { model, messages: [{ role: 'user', content: 'same opening' }] };
  const a = (await call(s.app, '/v1/chat/completions', payload)).json;
  const b = (await call(s.app, '/v1/chat/completions', payload)).json;
  assert.notEqual(a.kuku.session_id, b.kuku.session_id);
  const headers = { 'x-kuku-session': 'explicit-test-session' };
  const c = (await call(s.app, '/v1/chat/completions', payload, headers)).json;
  const d = (await responses(s.app, {}, headers)).json;
  assert.equal(c.kuku.session_id, d.kuku.session_id);
  for (const row of s.db.sql.prepare('SELECT session_key,session_id FROM conversation_turns').all()) {
    assert.ok([...s.pool.sessions.values()].some(v => v.session_id === row.session_id && v.logical_key === row.session_key));
  }
});

test('store:false removes instructions and arbitrary content from SQLite and memory while retaining continuation', async t => {
  const s = setup(t);
  const first = (await responses(s.app, { store: false, instructions: 'PRIVATE-INSTRUCTION', input: 'PRIVATE-INPUT' })).json;
  assert.equal(first.instructions, 'PRIVATE-INSTRUCTION', 'the immediate response may echo caller instructions');
  const raw = s.db.sql.prepare('SELECT data FROM responses WHERE id=?').get(first.id).data;
  assert.ok(!raw.includes('PRIVATE-'));
  assert.ok(!raw.includes('synthetic answer'));
  assert.equal((await call(s.app, '/v1/responses/'+first.id, undefined, {}, 'GET')).status, 404);
  const second = (await responses(s.app, { previous_response_id: first.id })).json;
  assert.equal(second.kuku.session_id, first.kuku.session_id);
  const memory = createLedger();
  memory.put({ id:'private', messages:'PRIVATE-INPUT', response: { store:false, instructions:'PRIVATE-INSTRUCTION', metadata:'PRIVATE-METADATA' } });
  assert.ok(!JSON.stringify(memory.get('private')).includes('PRIVATE-'));
});

test('opening an older SQLite database scrubs previously retained store:false content only', () => {
  const dir = mkdtempSync(path.join(import.meta.dirname, '.audit-'));
  let db;
  try {
    const file = path.join(dir, 'fixture.sqlite');
    db = openDatabase({ file });
    const old = { id:'old', session_key:'explicit', session_id:'fake-session', account:'fake-0', response:{store:false,instructions:'PRIVATE-INSTRUCTION',metadata:'PRIVATE-METADATA',output_text:'PRIVATE-ANSWER'} };
    db.sql.prepare('INSERT INTO responses(id,created_at,data) VALUES (?,?,?)').run(old.id, 1, JSON.stringify(old));
    db.ledger.put({ id:'stored', response:{store:true,instructions:'preserve stored instruction'} });
    db.close(); db = openDatabase({ file });
    const saved = db.sql.prepare('SELECT data FROM responses WHERE id=?').get('old').data;
    assert.ok(!saved.includes('PRIVATE-'));
    assert.equal(db.ledger.get('old').session_id, 'fake-session');
    assert.equal(db.ledger.get('stored').response.instructions, 'preserve stored instruction');
  } finally {
    db?.close();
    assert.equal(path.dirname(dir), import.meta.dirname);
    assert.ok(path.basename(dir).startsWith('.audit-'));
    rmSync(dir, { recursive:true, force:true });
  }
});

test('HTTP 200 business failures and malformed upstream replies become gateway errors, not successful inference', async t => {
  const s = setup(t);
  const original = globalThis.fetch;
  try {
    for (const reply of [JSON.stringify({ status:{code:200001,msg:'synthetic rejected'} }), 'not JSON']) {
      globalThis.fetch = async () => new Response(reply, { status:200 });
      let error;
      try { await new KukuAccount({ bduss:'synthetic', stoken:'synthetic' }).probe(); }
      catch (e) { error=e; }
      assert.equal(error.status, 502);
      s.pool.chat = async () => { throw error; };
      s.pool.accounts[0].auth_dead=false; s.pool.accounts[0].cooldown_until=0;
      const result = await call(s.app, '/v1/chat/completions', { model, messages:[{role:'user',content:'synthetic'}] });
      assert.equal(result.status, 502);
      assert.ok(result.json.error);
    }
    s.pool.accounts[0].cooldown_until=0;
    s.pool.chat = async () => { throw new UpstreamError('legacy business error', { status:200 }); };
    assert.equal((await responses(s.app)).status, 502, 'defend against old or custom error producers too');
  } finally { globalThis.fetch=original; }
});

for (const route of ['/pool/admin/accounts/fake-0', '/pool/admin/resequence']) {
  test(`${route} persists before changing memory and preserves runtime state on failure`, async t => {
    const s = setup(t, 2);
    s.pool.accounts[0].auth_dead=true; s.pool.accounts[1].cooldown_until=12345;
    const before = s.pool.accounts;
    const records = toRecords(before);
    const store = { save() { throw new Error('synthetic disk failure'); } };
    const app = createApp({ pool:s.pool, store, adminToken:'synthetic-admin', logger:{warn(){}} });
    const method = route.endsWith('resequence') ? 'POST' : 'DELETE';
    const failed = await call(app, route, {}, {'x-admin-token':'synthetic-admin'}, method);
    assert.equal(failed.status, 500);
    assert.equal(s.pool.accounts, before);
    assert.deepEqual(toRecords(s.pool.accounts), records);
    assert.equal(s.pool.accounts[0].auth_dead, true);
    let saved;
    store.save = value => { assert.equal(s.pool.accounts, before); saved=value; };
    const result = await call(app, route, {}, {'x-admin-token':'synthetic-admin'}, method);
    assert.equal(result.status, 200);
    assert.deepEqual(toRecords(s.pool.accounts), saved.accounts);
    if (method === 'DELETE') assert.equal(s.pool.accounts.length, 1);
    else assert.deepEqual(s.pool.accounts.map(a=>a.priority), [0,1]);
  });
}
