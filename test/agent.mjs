import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
import { createLedger } from '../src/ledger.mjs';
import { openDatabase } from '../src/database.mjs';
import { KukuAccount } from '../src/upstream.mjs';
import { prepareAgent, validateAgentTurn } from '../src/agent.mjs';
import { checkToolSchema, matchesToolSchema } from '../src/tool-schema.mjs';

const model = 'synthetic-native-agent';
const definitions = ['read_file', 'write_file', 'run_command'].map(name => ({ type: 'function', function: {
  name, description: name, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: true,
} }));
const user = { role: 'user', content: [{ type: 'text', text: 'Read, edit, then verify the sandbox file.' }] };
function queue(signal) {
  const values = []; let wake;
  return { push(value) { values.push(value); wake?.(); }, async *read() {
    while (!signal?.aborted) {
      if (values.length) { yield values.shift(); continue; }
      await new Promise(resolve => { wake = resolve; signal?.addEventListener('abort', resolve, { once: true }); });
    }
  } };
}
function setup(t, plan = ({ messages }) => {
  const results = messages.filter(m => m.role === 'tool');
  return results.length < 3 ? { calls: [{ name: definitions[results.length].function.name, arguments: { value: ['demo.txt', 'edited', 'verify'][results.length] } }] }
    : { text: `Verified: ${results.at(-1).content}` };
}, ledger = createLedger()) {
  MODEL_INDEX.set(model, { model_name: model, display_name: model }); t.after(() => MODEL_INDEX.delete(model));
  const pool = new Pool([{ id: 'one', upstream_user_id: '111', bduss: 'fake', stoken: 'fake' }, { id: 'two', upstream_user_id: '222', bduss: 'fake', stoken: 'fake' }], { logger: { warn() {} } });
  const seen = { send: [], close: [], definitions: [], callbacks: [], channels: [], allocations: 0 };
  for (const a of pool.accounts) {
    let sandbox, base, stream, args;
    const emit = (type, data = {}) => stream.push({ data: { type, data: { reply_id: args.reply_id, ...data } } });
    a.client.allocateIds = async () => ({ chat_id: `native-${++seen.allocations}`, query_id: `reply-${seen.allocations}` });
    a.client.controlStream = async function* (kind, body, signal) {
      const q = queue(signal); if (kind === 'sandbox') sandbox = q; else base = q;
      seen.channels.push({ kind, body });
      yield { data: { type: kind === 'base' ? 'connected' : 'sandbox', sub_type: 'connected' } };
      yield* q.read();
    };
    a.client.sendmsg = async body => {
      args = body; stream = queue(body.signal); seen.send.push(body);
      sandbox.push({ data: { type: 'sandbox', sub_type: 'task', task_id: `list-${body.session_id}`, data: {
        method: 'local_connector', params: { session_id: body.session_id, device_id: body.device_id, server_name: body.connector_list?.[0]?.name,
          sub_method: 'tools/list', request_id: 1 },
      } } });
    };
    a.client.nativeToolResult = async result => {
      seen.callbacks.push(result); if (!result.result?.tools) return;
      seen.definitions.push(result.result.tools);
      const messages = JSON.parse(args.text.split('CONVERSATION_JSON: ')[1].split('\nContinue the next')[0]);
      const turn = await plan({ messages, tools: result.result.tools, args, sandbox, emit, account: a });
      emit('MODEL_CALL_END', { input_tokens: 10, output_tokens: 3 }); emit('ACTUAL_POINT', { consume_points: 0.1 });
      if (turn.text != null) emit('TEXT_BLOCK_DELTA', { delta: turn.text });
      if (turn.reasoning) emit('THINKING_BLOCK_DELTA', { delta: turn.reasoning });
      for (const [index, call] of (turn.calls ?? []).entries()) sandbox.push({ data: { type: 'sandbox', sub_type: 'task', task_id: `call-${args.session_id}-${index}`, data: {
        method: call.method ?? 'local_connector', params: { session_id: args.session_id, device_id: args.device_id, server_name: args.connector_list?.[0]?.name,
          sub_method: 'tools/call', tool_name: call.name, arguments: call.arguments, request_id: index + 2 },
      } } });
      if (!turn.calls?.length) emit(turn.incomplete ? 'REPLY_END' : 'TURN_DONE');
      else if (turn.completeWithCalls) setTimeout(() => emit('TURN_DONE'), 10);
    };
    a.client.sse = body => stream.read();
    a.client.closeTurn = async body => { seen.close.push(body); emit('TURN_DONE'); };
  }
  return { pool, seen, ledger, app: createApp({ pool, ledger }) };
}
async function request(app, route, body, headers = {}) {
  const req = { url: route, method: 'POST', headers, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model, ...body })); } };
  const res = { body: '', status: null, writableFinished: false, writeHead(status) { this.status = status; },
    write(value) { this.body += value; }, end(value = '') { this.body += value; this.writableFinished = true; } };
  await app(req, res);
  return { ...res, json: res.body.startsWith('{') ? JSON.parse(res.body) : null,
    events: res.body.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6))) };
}
const chat = (s, body) => request(s.app, '/v1/chat/completions', { tools: definitions, ...body });
const responses = (s, body) => request(s.app, '/v1/responses', { tools: definitions.map(t => ({ type: 'function', ...t.function })), ...body });

for (const stream of [false, true]) test(`Chat native tool loop reads, writes and executes a real sandbox verification (stream=${stream})`, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kuku-agent-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'demo.txt'), 'original');
  const s = setup(t), messages = [{ role: 'system', content: 'Use only the test sandbox; preserve this instruction.' }, user];
  for (let i = 0; i < 4; i++) {
    const r = await chat(s, { messages, stream }); assert.equal(r.status, 200, r.body);
    const message = stream ? { role: 'assistant', content: r.events.map(e => e.choices?.[0]?.delta?.content ?? '').join(''),
      tool_calls: r.events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }) => call) } : r.json.choices[0].message;
    const finish = stream ? r.events.find(e => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason : r.json.choices[0].finish_reason;
    if (i === 3) { assert.equal(finish, 'stop'); assert.match(message.content, /Verified: edited/); break; }
    assert.equal(finish, 'tool_calls'); assert.equal(message.tool_calls.length, 1);
    const call = message.tool_calls[0]; assert.match(call.id, /^call_/); assert.equal(call.function.name, definitions[i].function.name);
    let output;
    if (i === 0) output = readFileSync(path.join(dir, 'demo.txt'), 'utf8');
    if (i === 1) { writeFileSync(path.join(dir, 'demo.txt'), JSON.parse(call.function.arguments).value); output = 'written'; }
    if (i === 2) output = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync("demo.txt","utf8"))'], { cwd: dir, encoding: 'utf8' });
    messages.push(message, { role: 'tool', tool_call_id: call.id, content: output });
  }
  assert.equal(s.seen.send.length, 4); assert.equal(s.seen.close.length, 3);
  assert.equal(new Set(s.seen.send.map(s => s.session_id)).size, 4); assert.equal(s.pool.sessions.size, 0);
  assert(s.seen.send.every(s => s.text.includes('preserve this instruction') && !s.text.includes('[object Object]') && !s.text.includes('CLIENT_TOOLS_JSON')));
  assert(s.seen.send.every(s => s.custom_instructions.includes('preserve this instruction')));
  assert(s.seen.definitions.every(tools => tools[0].inputSchema.required[0] === 'value'));
  assert(s.seen.callbacks.every(c => c.result?.tools)); // Backend never executes caller commands.
});

test('Responses tool IDs, argument SSE and previous_response_id survive SQLite restart', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-agent-db-'));
  let db = openDatabase({ root }), s = setup(t, undefined, db.ledger);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const first = await responses(s, { input: 'start', stream: true, instructions: 'FIRST_INSTRUCTIONS' });
  const final = first.events.find(e => e.type === 'response.completed').response;
  const call = final.output.find(o => o.type === 'function_call'); assert(call); assert.equal(final.kuku.tool_adapter, 'native-mcp');
  const delta = first.events.find(e => e.type === 'response.function_call_arguments.delta'); assert.equal(delta.item_id, call.id); assert.equal(delta.delta, call.arguments);
  assert.deepEqual(first.events.map(e => e.sequence_number), first.events.map((_, i) => i));
  assert(first.events.find(e => e.type === 'response.output_item.done' && e.item.id === call.id));
  db.close(); db = openDatabase({ root }); s = setup(t, ({ messages }) => ({ text: messages.at(-1).content }), db.ledger);
  const second = await responses(s, { previous_response_id: final.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'actual tool output' }] });
  assert.equal(second.status, 200, second.body); assert.equal(second.json.output_text, 'actual tool output');
  assert(s.seen.send[0].text.includes(call.call_id)); assert(!s.seen.send[0].text.includes('FIRST_INSTRUCTIONS'));
  assert.equal(second.json.kuku.account, final.kuku.account);
  assert(!s.seen.send[0].custom_instructions.includes('FIRST_INSTRUCTIONS'));
});

test('Responses custom free-text tool retains multiline input and output across rounds', async t => {
  const input = '*** Begin Patch\n+hello\n*** End Patch';
  const s = setup(t, ({ messages }) => messages.at(-1).role === 'tool' ? { text: messages.at(-1).content } : { calls: [{ name: 'apply_patch', arguments: { input } }] });
  const tools = [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }];
  const r = await responses(s, { input: 'patch', tools, stream: true }); const final = r.events.find(e => e.type === 'response.completed').response;
  const call = final.output.find(o => o.type === 'custom_tool_call'); assert.equal(call.input, input);
  assert.equal(r.events.find(e => e.type === 'response.custom_tool_call_input.delta').delta, input);
  const next = await responses(s, { previous_response_id: final.id, tools, input: [{ type: 'custom_tool_call_output', call_id: call.call_id, output: 'applied\nverified' }] });
  assert.equal(next.json.output_text, 'applied\nverified');
});

test('parallel calls can receive results in reverse order; histories cannot cross IDs', async t => {
  const s = setup(t, ({ messages }) => messages.at(-1).role === 'tool' ? { text: 'done' } : { calls: [0,1].map(i => ({ name: 'read_file', arguments: { value: `${i}.txt` } })) });
  const first = await chat(s, { messages: [user] }), m = first.json.choices[0].message; assert.equal(m.tool_calls.length, 2);
  const results = m.tool_calls.toReversed().map(c => ({ role: 'tool', tool_call_id: c.id, content: 'read' }));
  assert.equal((await chat(s, { messages: [user, m, ...results] })).status, 200);
  for (const output of [[results[0]], [...results, results[0]], [{ role: 'tool', tool_call_id: 'unknown', content: 'bad' }]]) {
    const before = s.seen.send.length, r = await chat(s, { messages: [user, m, ...output] });
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'invalid_tool_history'); assert.equal(s.seen.send.length, before);
  }
});

for (const [label, plan, patch] of [
  ['undefined tool', { calls: [{ name: 'unknown', arguments: {} }] }, {}],
  ['schema mismatch', { calls: [{ name: 'read_file', arguments: { value: 4 } }] }, {}],
  ['parallel false', { calls: [0,1].map(() => ({ name: 'read_file', arguments: { value: 'x' } })) }, { parallel_tool_calls: false }],
  ['required with final text', { text: 'done' }, { tool_choice: 'required' }],
  ['none with tool call', { calls: [{ name: 'read_file', arguments: { value: 'x' } }] }, { tool_choice: 'none' }],
  ['built-in command', { calls: [{ name: 'bash', method: 'shell.exec', arguments: {} }] }, {}],
]) test(`${label} emits no tools and never retries another account`, async t => {
  const s = setup(t, () => plan), r = await chat(s, { messages: [user], stream: true, ...patch });
  assert.equal(r.status, 502, r.body); assert.equal(s.seen.send.length, 1); assert(!r.body.includes('"finish_reason":"tool_calls"'));
  assert(s.pool.accounts.every(a => !a.cooldown_until)); assert.equal(s.seen.close.length, plan.calls?.length ? 1 : 0);
});

test('store:false removes all agent history and refuses unsafe previous-ID continuation', async t => {
  const s = setup(t), r = await responses(s, { input: 'PRIVATE_USER', store: false });
  const saved = JSON.stringify(s.ledger.get(r.json.id)); assert(!saved.includes('PRIVATE_USER')); assert(!saved.includes('read_file'));
  const before = s.seen.send.length, next = await responses(s, { previous_response_id: r.json.id, input: 'next' });
  assert.equal(next.status, 400); assert.equal(next.json.error.code, 'agent_history_unavailable'); assert.equal(s.seen.send.length, before);
});

test('previous agent response cannot continue after its account identity changes', async t => {
  const s = setup(t), r = await responses(s, { input: 'start' }), call = r.json.output.find(o => o.type === 'function_call');
  s.pool.accounts.find(a => a.id === r.json.kuku.account).upstream_user_id = 'changed';
  const next = await responses(s, { previous_response_id: r.json.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }] });
  assert.equal(next.status, 409); assert.equal(s.seen.send.length, 1);
});

test('native wire fields and callback envelopes match measured desktop protocol', async () => {
  const client = new KukuAccount({ bduss: 'fake', stoken: 'fake' }); const seen = [];
  client.json = async (path, options) => { seen.push({ path, ...options }); return {}; };
  const connector_list = [{ name: 'external_agent_x', type: 'custom' }];
  await client.sendmsg({ text: 'hi', think_mode: 1, connector_list, memory_sign: false });
  assert.deepEqual(seen[0].body.data.connector_list, connector_list); assert.equal(seen[0].body.data.memory_sign, false);
  await client.nativeToolResult({ task_id: 'task', device_id: 'device', client_session_id: 'sandbox', request_id: 7, result: { tools: [] } });
  const callback = seen[1]; assert.equal(callback.path, '/api/genflowprosse/callback'); assert.equal(callback.body.sub_type, 'result');
  assert.deepEqual(JSON.parse(callback.body.payload[0]).data, { jsonrpc: '2.0', id: 7, result: { tools: [] } });
  await client.closeTurn({ session_id: 'session', reply_id: 'reply', client_session_id: 'base' }); assert.equal(seen[2].body.sub_type, 'close');
});

test('tool schemas support local refs, union, nested requirements and reject unsupported strict keywords', () => {
  const schema = { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, required: ['value'], additionalProperties: false,
    $defs: { value: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true }] } } };
  checkToolSchema(schema, true); assert(matchesToolSchema({ value: [1,2] }, schema)); assert(matchesToolSchema({ value: null }, schema));
  for (const value of [{}, { value: [0] }, { value: [1,1] }, { value: '1' }, { value: null, extra: 1 }]) assert(!matchesToolSchema(value, schema));
  assert.throws(() => checkToolSchema({ $ref: 'https://example.invalid/schema' }, true));
  assert.throws(() => checkToolSchema({ type: 'string', format: 'email' }, true));
  assert.throws(() => checkToolSchema({ type: [] }, true));
  assert.throws(() => checkToolSchema({ uniqueItems: 'yes' }, true));
  assert.throws(() => prepareAgent({ tools: [{ type: 'function', function: { parameters: {} } }], messages: [user] }, 'chat'));
  assert.throws(() => validateAgentTurn({ content: '', tool_calls: [] }, { tools: [], choice: 'auto', parallel: true }));
});

test('foreign desktop tasks are ignored and identical schemas keep a stable connector', async t => {
  const s = setup(t, ({ args, sandbox }) => {
    for (const params of [{ session_id: 'another-session', device_id: args.device_id }, { session_id: args.session_id, device_id: 'another-device' }]) {
      sandbox.push({ data: { type: 'sandbox', sub_type: 'task', task_id: 'foreign-' + params.device_id, data: { method: 'shell.exec', params } } });
    }
    return { text: 'done' };
  });
  for (let i = 0; i < 2; i++) assert.equal((await chat(s, { messages: [user] })).status, 200);
  assert.equal(s.seen.send[0].connector_list[0].name, s.seen.send[1].connector_list[0].name);
  const tools = structuredClone(definitions); tools[0].function.parameters.properties.value.enum = ['different'];
  assert.equal((await chat(s, { messages: [user], tools })).status, 200);
  assert.notEqual(s.seen.send[1].connector_list[0].name, s.seen.send[2].connector_list[0].name);
  assert(s.seen.callbacks.every(c => c.result?.tools));
});

test('TURN_DONE racing the handoff timer returns calls once and does not hang', async t => {
  const s = setup(t, () => ({ calls: [{ name: 'read_file', arguments: { value: 'demo.txt' } }], completeWithCalls: true }));
  const r = await chat(s, { messages: [user] });
  assert.equal(r.status, 200, r.body); assert.equal(r.json.choices[0].message.tool_calls.length, 1);
  assert.equal(s.seen.close.length, 0);
});

test('identity rotation during a native tool turn cannot emit a call', async t => {
  const s = setup(t, ({ account }) => {
    account.upstream_user_id = 'rotated';
    return { calls: [{ name: 'read_file', arguments: { value: 'demo.txt' } }] };
  });
  const r = await chat(s, { messages: [user], stream: true });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'session_account_mismatch');
  assert.equal(s.seen.send.length, 1); assert.equal(s.seen.close.length, 1);
});

test('aborting a pending native turn closes it and releases its control streams', async t => {
  const controller = new AbortController();
  const s = setup(t, () => { setTimeout(() => controller.abort(), 10); return { incomplete: true }; });
  const agent = prepareAgent({ messages: [user], tools: definitions }, 'chat');
  await assert.rejects(s.pool.chat({ account: s.pool.accounts[0], model: { id: model }, agent, messages: agent.messages }, () => {}, controller.signal), e => e.retryUnsafe === true);
  assert.equal(s.seen.send.length, 1); assert.equal(s.seen.close.length, 1);
  assert(s.seen.send[0].signal.aborted);
});

test('Responses image attachments survive SQLite restart and are not rendered as base64 prose', async t => {
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW4kAAAAASUVORK5CYII=';
  const root=mkdtempSync(path.join(tmpdir(),'kuku-image-history-'));let db=openDatabase({root});t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const plan=({messages})=>messages.at(-1).role==='tool'?{text:'image result received'}:{calls:[{name:'read_file',arguments:{value:'demo.txt'}}]};
  const s=setup(t,plan,db.ledger);
  let uploaded=0,attached=0;const stub=s=>{for(const account of s.pool.accounts){account.client.uploadImage=async()=>({fsId:String(++uploaded),name:'fixture.png'});account.client.attachImages=async()=>{attached++;};}};stub(s);
  const first=await responses(s,{input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+png}]}]});assert.equal(first.status,200,first.body);
  const call=first.json.output.find(o=>o.type==='function_call');
  db.close();db=openDatabase({root});const restarted=setup(t,plan,db.ledger);stub(restarted);
  const next=await responses(restarted,{previous_response_id:first.json.id,input:[{type:'function_call_output',call_id:call.call_id,output:'done'}]});
  assert.equal(next.status,200,next.body);assert.equal(uploaded,2);assert.equal(attached,2);
  assert([...s.seen.send,...restarted.seen.send].every(r=>r.attachments.length===1&&!r.text.includes(png)));
});
