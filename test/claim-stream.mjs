// Synthetic HTTP upstream only. Reproduce an official terminal frame on a still-open socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { KukuAccount } from '../src/upstream.mjs';
import { createApp } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

async function fixture(t, { terminal = 'TURN_DONE', newline = '\n', incomplete = false, stall = false, stallJson = null, wrongReply = false, requiresClient = null } = {}) {
  const previous = process.env.KUKU_BASE_URL;
  const calls = { turns: 0, reports: 0, rewards: 0, released: 0, sent: [] };
  let ready = false, paid = false;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const path = new URL(req.url, 'http://synthetic').pathname;
    const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: { code: 0 }, data })); };
    if (path === stallJson) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    if (path === '/wenchain/genflow/idallochstr') return json({ chat_id: 'session', query_id: 'reply' });
    if (path === '/wenchain/genflowpro/sendmsg') { calls.turns++; calls.sent.push(JSON.parse(raw).data); return json({}); }
    if (path === '/api/genflowpro/freepoint/homenew') return json({ activities: [{ activity_key: 'daily', period_no: 1, tabs: [{ tasks: [{ task_key: 'chat', task_type: 'CHAT', task_status: paid ? 'FINISHED' : 'UNFINISHED', claimable_point: ready && !paid ? 50 : 0 }] }] }] });
    if (path === '/api/genflowpro/freepoint/taskComplete') { assert.equal(new URLSearchParams(raw).get('task_type'), 'CHAT'); calls.reports++; ready = true; return json({ complete_status: 'SUCCESS' }); }
    if (path === '/api/genflowpro/freepoint/rewardClaim') { calls.rewards++; paid = true; return json({ claim_status: 'SUCCESS', claimed_point: 50 }); }
    if (path !== '/wenchain/genflowpro/sse/getchatcontent') { res.writeHead(404); return res.end(); }
    res.on('close', () => { calls.released++; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (type, data = {}) => `data: ${JSON.stringify({ type, data: { reply_id: 'reply', ...data } })}${newline}${newline}`;
    res.write(frame('TEXT_BLOCK_DELTA', { delta: 'synthetic' }));
    res.write(frame('MODEL_CALL_END', { input_tokens: 12, output_tokens: 3 }));
    res.write(frame('REPLY_END'));
    res.write(frame('ACTUAL_POINT', { consume_points: 0.02 }));
    if (wrongReply) res.write(frame('TURN_DONE', { reply_id: 'another-reply' }));
    if (requiresClient) { res.write(frame(requiresClient)); return; }
    if (incomplete) return res.end();
    if (stall) return; // Including MODEL_CALL_END/REPLY_END must not mean success.
    const ending = terminal === '[DONE]' ? `data: [DONE]${newline}${newline}` : frame(terminal);
    // Split CRLF and the terminal event across network writes.
    res.write(ending.slice(0, -1));
    setImmediate(() => { if (!res.destroyed) res.write(ending.slice(-1)); });
    // Intentionally leave the response open; the backend must close it itself.
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  process.env.KUKU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const database = openDatabase({ file: ':memory:' });
  const pool = new Pool([{ id: 'fake', bduss: 'synthetic', stoken: 'synthetic' }], { database, logger: { warn() {}, log() {} } });
  pool.accounts[0].client = new KukuAccount({ bduss: 'synthetic', stoken: 'synthetic' }, { requestTimeoutMs: 150, streamTimeoutMs: 200 });
  MODEL_INDEX.set('synthetic', { model_name: 'synthetic', display_name: 'synthetic' });
  pool.refreshModelIndex = async () => {};
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    database.close();
    MODEL_INDEX.delete('synthetic');
    if (previous === undefined) delete process.env.KUKU_BASE_URL; else process.env.KUKU_BASE_URL = previous;
  });
  const chat = (signal) => pool.chat({ account: pool.accounts[0], model: { id: 'synthetic' }, messages: [{ role: 'user', content: 'synthetic' }], think_mode: 1 }, () => {}, signal);
  return { pool, database, calls, chat };
}

for (const terminal of ['TURN_DONE', 'FINISH', '[DONE]']) {
  test(`${terminal} finishes a still-open upstream socket and retains final usage and points`, { timeout: 2000 }, async t => {
    const { chat, calls } = await fixture(t, { terminal, newline: '\r\n' });
    const result = await chat();
    assert.equal(result.content, 'synthetic');
    assert.equal(result.usage.total_tokens, 15);
    assert.equal(result.consume_points, 0.02);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls.released, 1);
  });
}

test('actual admin claim path pays +50 after TURN_DONE without waiting for socket EOF; repeat spends nothing', { timeout: 2000 }, async t => {
  const { pool, calls } = await fixture(t);
  const app = createApp({ pool, adminToken: 'synthetic-admin' });
  const claim = async () => {
    let result;
    const req = { url: '/pool/admin/claim', method: 'POST', headers: { 'x-admin-token': 'synthetic-admin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ id: 'fake', chat: true, model: 'synthetic' })); } };
    const res = { writeHead(status) { assert.equal(status, 200); }, end(body) { result = JSON.parse(body); } };
    await app(req, res);
    return result;
  };
  const first = await claim();
  assert.equal(first.accounts[0].ok, true);
  assert.equal(first.points_earned, 50);
  assert.deepEqual(first.accounts[0].reported, ['CHAT']);
  assert.equal((await claim()).points_earned, 0);
  assert.deepEqual([calls.turns, calls.reports, calls.rewards], [1, 1, 1]);
  assert.match(calls.sent[0].text, /只回复 OK/);
  assert.match(calls.sent[0].text, /不要调用工具/);
  assert.ok([...pool.sessions.values()].every(session => session.logical_key.startsWith('claim:fake:')));
});

test('socket EOF without a turn terminal fails, preserves observed cost and never reports or pays CHAT', { timeout: 2000 }, async t => {
  const { pool, calls, database } = await fixture(t, { incomplete: true });
  const [result] = await pool.claimFreePoints({ only: 'fake', runChat: true, chatModel: 'synthetic' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'upstream_incomplete');
  assert.equal(result.points_earned, 0);
  assert.deepEqual([calls.reports, calls.rewards], [0, 0]);
  assert.deepEqual({ ...database.sql.prepare('SELECT status,consume_points FROM usage_records').get() }, { status: 'failed', consume_points: 0.02 });
});

test('MODEL_CALL_END, REPLY_END and another reply TURN_DONE cannot finish a stalled turn; timeout releases its claim queue', { timeout: 2000 }, async t => {
  const { pool, calls } = await fixture(t, { stall: true, wrongReply: true });
  const [result] = await pool.claimFreePoints({ only: 'fake', runChat: true, chatModel: 'synthetic' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'upstream_timeout');
  assert.deepEqual([calls.reports, calls.rewards], [0, 0]);
  assert.equal(pool.queues.size, 0);
});

test('JSON deadline also aborts a hanging response body', { timeout: 2000 }, async t => {
  const { pool } = await fixture(t, { stallJson: '/api/genflowpro/freepoint/homenew' });
  await assert.rejects(pool.accounts[0].client.freePointHome(), e => e.network && e.code === 'upstream_timeout' && e.status === 504);
});

test('caller cancellation interrupts a live SSE body promptly', { timeout: 2000 }, async t => {
  const { chat } = await fixture(t, { stall: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70);
  try { await assert.rejects(chat(controller.signal), e => e.network && e.retryUnsafe && e.code !== 'upstream_timeout'); }
  finally { clearTimeout(timer); }
});

test('an ambiguous paid turn cannot automatically fail over to another account', { timeout: 2000 }, async t => {
  const { pool, calls } = await fixture(t, { incomplete: true });
  pool.accounts.push({ ...pool.accounts[0], id: 'second', priority: 1 });
  const app = createApp({ pool, adminToken: 'synthetic-admin' });
  const req = { url: '/v1/chat/completions', method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model: 'synthetic', messages: [{ role: 'user', content: 'synthetic' }] })); } };
  let status;
  let body;
  const res = { writeHead(s) { status = s; }, end(value) { body = JSON.parse(value); } };
  await app(req, res);
  assert.equal(status, 502);
  assert.equal(body.error.code, 'upstream_incomplete');
  assert.equal(calls.turns, 1);
});

for (const requiresClient of ['REQUIRE_EXTERNAL_EXECUTION', 'AWAITING_INPUT']) {
  test(`${requiresClient} immediately stops a paused tool workflow without reporting or paying CHAT`, { timeout: 2000 }, async t => {
    const { pool, calls } = await fixture(t, { requiresClient });
    const [result] = await pool.claimFreePoints({ only: 'fake', runChat: true, chatModel: 'synthetic' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'upstream_requires_client');
    assert.equal(result.unreachable, undefined);
    assert.deepEqual([calls.reports, calls.rewards], [0, 0]);
    assert.equal(pool.queues.size, 0);
  });
}

test('reward earning allocates an isolated session instead of resuming an old paused conversation', { timeout: 2000 }, async t => {
  const { pool } = await fixture(t);
  pool.sessions.set('fake:old', { session_id: 'old-paused', client_session_id: 'old-client', turn: 2 });
  const [result] = await pool.claimFreePoints({ only: 'fake', runChat: true, chatModel: 'synthetic' });
  assert.equal(result.ok, true);
  assert.equal(pool.sessions.get('fake:old').turn, 2);
  assert.ok([...pool.sessions.values()].some(session => session.logical_key?.startsWith('claim:fake:')));
});
