// Real handlers and Pool, synthetic upstream only: no network, credentials or credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
const model = 'synthetic-text-compat';
const question = [{ type: 'text', text: '第一段上下文\n' }, { type: 'text', text: '请解释第二段' }];
function setup(t, { event = null, partial = false } = {}) {
  MODEL_INDEX.set(model, { model_name: model, display_name: model });
  t.after(() => MODEL_INDEX.delete(model));
  const pool = new Pool(['a', 'b'].map((id, priority) => ({ id, priority, bduss: 'fake', stoken: 'fake' })), { logger: { warn() {} } });
  const calls = { alloc: 0, send: [], stream: [] };
  for (const account of pool.accounts) {
    account.client.allocateIds = async () => ({ chat_id: `session-${++calls.alloc}`, query_id: `reply-${calls.alloc}` });
    account.client.sendmsg = async body => calls.send.push(body);
    account.client.sse = async function* (body) {
      calls.stream.push(body);
      if (!event || partial) yield { data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'synthetic answer' } } };
      yield { data: { type: event ?? 'TURN_DONE', data: { reply_id: body.reply_id } } };
    };
  }
  return { pool, calls, app: createApp({ pool }) };
}
async function request(app, route, payload) {
  const req = { url: route, method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model, ...payload })); } };
  const res = { status: null, body: '', writableFinished: false, writeHead(status) { this.status = status; },
    write(value) { this.body += value; }, end(value = '') { this.body += value; this.writableFinished = true; } };
  await app(req, res);
  return { ...res, json: res.body.startsWith('{') ? JSON.parse(res.body) : null };
}
const chat = (app, payload = {}) => request(app, '/v1/chat/completions', { messages: [{ role: 'user', content: question }], ...payload });
const responses = (app, payload = {}) => request(app, '/v1/responses', { input: [{ role: 'user', content: question.map(p => ({ ...p, type: 'input_text' })) }], ...payload });

for (const stream of [false, true]) {
  test(`Chat text parts reach sendmsg and SSE intact (stream=${stream})`, async t => {
    const s = setup(t), result = await chat(s.app, { stream });
    assert.equal(result.status, 200);
    assert.equal(s.calls.send[0].text, '第一段上下文\n请解释第二段');
    assert.equal(s.calls.stream[0].text, s.calls.send[0].text);
    assert.equal(s.calls.send.length, 1);
    if (stream) assert(result.body.includes('[DONE]')); else assert.equal(result.json.choices[0].message.content, 'synthetic answer');
  });
}
test('direct Pool callers normalize arrays too', async t => {
  const s = setup(t);
  await s.pool.chat({ account: s.pool.accounts[0], model: { id: model }, messages: [{ role: 'user', content: question }] });
  assert.equal(s.calls.send[0].text, '第一段上下文\n请解释第二段');
});
test('Responses preserves text parts', async t => {
  const s = setup(t), result = await responses(s.app);
  assert.equal(result.status, 200);
  assert.equal(s.calls.send[0].text, '第一段上下文\n请解释第二段');
});
for (const [name, invoke] of [['Chat', chat], ['Responses', responses]]) {
  for (const patch of [
    { tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] },
    { tools: [], tool_choice: 'required' },
    { tool_choice: { type: 'function', function: { name: 'read' } } },
    { functions: [{ name: 'read' }], function_call: 'auto' },
  ]) {
    test(`${name} rejects unsupported tools before any upstream request: ${JSON.stringify(patch)}`, async t => {
      const s = setup(t), result = await invoke(s.app, { ...patch, stream: true });
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'unsupported_tools');
      assert.equal(s.calls.alloc, 0);
      assert.equal(s.calls.send.length, 0);
      assert.equal(s.pool.sessions.size, 0);
      assert(s.pool.accounts.every(a => !a.cooldown_until));
    });
  }
  test(`${name} accepts empty tools or explicitly disabled definitions`, async t => {
    const s = setup(t);
    for (const patch of [{ tools: [], tool_choice: 'auto' }, { tools: [{ type: 'function', function: { name: 'read' } }], tool_choice: 'none' }]) {
      assert.equal((await invoke(s.app, patch)).status, 200);
    }
    assert.equal(s.calls.send.length, 2);
  });
}
for (const content of [null, {}, [{ type: 'text', text: {} }], [{ type: 'text', text: 'valid' }, { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }], [{ type: 'file', file: {} }], []]) {
  test(`Chat rejects malformed or non-text content without dropping parts: ${JSON.stringify(content)}`, async t => {
    const s = setup(t), result = await chat(s.app, { messages: [{ role: 'user', content }] });
    assert.equal(result.status, 400);
    assert.equal(s.calls.alloc, 0);
    assert.equal(s.calls.send.length, 0);
  });
}
test('Chat rejects tool history instead of resending an earlier user turn', async t => {
  const s = setup(t), result = await chat(s.app, { messages: [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call1', content: 'file content' },
  ] });
  assert.equal(result.json.error.code, 'unsupported_tools');
  assert.equal(s.calls.alloc, 0);
});
for (const input of [
  [{ role: 'user', content: 'read a file' }, { type: 'function_call_output', call_id: 'call1', output: 'file content' }],
  [{ role: 'user', content: [{ type: 'input_text', text: 'valid' }, { type: 'input_image', image_url: 'https://example.invalid/a.png' }] }],
]) {
  test('Responses rejects unsupported input instead of silently deleting parts', async t => {
    const s = setup(t), result = await responses(s.app, { input, stream: true });
    assert.equal(result.status, 400);
    assert.equal(s.calls.alloc, 0);
    assert.equal(s.calls.send.length, 0);
  });
}
for (const event of ['REQUIRE_EXTERNAL_EXECUTION', 'AWAITING_INPUT']) {
  for (const partial of [false, true]) {
    test(`${event} fails without account failover (partial=${partial})`, async t => {
      const s = setup(t, { event, partial }), result = await chat(s.app, { stream: true });
      if (partial) {
        assert.equal(result.status, 200);
        assert(result.body.includes('"code":"upstream_requires_client"'));
        assert(!result.body.includes('"finish_reason":"stop"'));
      } else {
        assert.equal(result.status, 422);
        assert.equal(result.json.error.code, 'upstream_requires_client');
      }
      assert.equal(s.calls.send.length, 1);
      assert(s.pool.accounts.every(a => !a.cooldown_until));
    });
  }
}
