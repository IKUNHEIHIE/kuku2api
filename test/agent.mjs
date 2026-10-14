import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
import { createLedger } from '../src/ledger.mjs';
import { openDatabase, createDatabaseLogger } from '../src/database.mjs';
import { KukuAccount, UpstreamError } from '../src/upstream.mjs';
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
      seen.channels.push({ kind, body, signal });
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
      else if (turn.waitWithCalls) setTimeout(() => emit(turn.waitWithCalls), 10);
    };
    a.client.sse = body => stream.read();
    a.client.closeTurn = async body => { seen.close.push(body); emit('TURN_DONE'); };
  }
  return { pool, seen, ledger, app: createApp({ pool, ledger }) };
}
async function request(app, route, body, headers = {}, onWrite = () => {}) {
  const req = { url: route, method: 'POST', headers, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model, ...body })); } };
  const res = { body: '', status: null, writableFinished: false, writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    write(value) { this.body += value; onWrite(value, this); }, end(value = '') { this.body += value; this.writableFinished = true; } };
  await app(req, res);
  return { ...res, json: res.body.startsWith('{') ? JSON.parse(res.body) : null,
    events: res.body.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6))) };
}
const chat = (s, body) => request(s.app, '/v1/chat/completions', { tools: definitions, ...body });
const responses = (s, body) => request(s.app, '/v1/responses', { tools: definitions.map(t => ({ type: 'function', ...t.function })), ...body });

for(const native of [false,true])test(`upstream error frames are classified as transient generation errors without replay (native=${native})`,async t=>{
  const s=setup(t),first=s.pool.accounts[0];let sends=0;
  const send=first.client.sendmsg;
  first.client.sendmsg=async args=>{sends++;if(native)await send(args);};
  first.client.sse=async function*(){yield{data:{type:'ERROR',data:{message:'PRIVATE-UPSTREAM-TEXT'}}};};
  const result=await chat(s,{messages:[user],...(native?{}:{tools:undefined})});
  assert.equal(result.status,502);assert.equal(result.json.error.code,'upstream_turn_error');
  assert.equal(sends,1);assert.equal(first.consecutive_failures,1);
  assert(!result.body.includes('PRIVATE-UPSTREAM-TEXT'));
});

for (const surface of ['chat', 'responses']) for (const stream of [false, true]) for (const reason of ['auth', 'network', 'send-refused']) {
  test(`${surface} fails over before generation after ${reason} (stream=${stream})`, async t => {
    const s = setup(t, ({ account }) => ({ text: account.id }));
    const first = s.pool.accounts[0];
    const error = reason === 'network' ? new UpstreamError('connection failed', { network: true, status: 502 })
      : new UpstreamError('not login', { code: 200001, status: 502, definitiveRefusal: reason === 'send-refused' });
    first.client[reason === 'send-refused' ? 'sendmsg' : 'allocateIds'] = async () => { throw error; };
    const r = surface === 'chat' ? await chat(s, { messages: [user], stream }) : await responses(s, { input: 'synthetic', stream });
    assert.equal(r.status, 200, r.body);
    const text = surface === 'chat' ? stream ? r.events.map(e => e.choices?.[0]?.delta?.content ?? '').join('') : r.json.choices[0].message.content
      : stream ? r.events.find(e => e.type === 'response.completed')?.response.output_text : r.json.output_text;
    assert.equal(text, 'two');
    if (reason === 'network') assert(first.cooldown_until > Date.now());
    else assert.equal(first.auth_dead, true);
    assert.equal(s.seen.send.length, 1);
  });
}

for (const native of [false, true]) for (const surface of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`${surface} does not resend an accepted turn on stream failure, but the next request skips that account (native=${native}, stream=${stream})`, async t => {
    const s = setup(t, ({ account }) => ({ text: account.id }));
    const first = s.pool.accounts[0];
    const sent = first.client.sendmsg;
    let sends = 0;
    first.client.sendmsg = async body => { sends++; if (native) await sent(body); };
    first.client.sse = async function* () { throw new UpstreamError('stream unavailable', { status: 503, network: true }); };
    if (!native) {
      s.pool.accounts[1].client.sendmsg = async () => {};
      s.pool.accounts[1].client.sse = async function* () {
        yield { data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'two' } } }; yield { data: { type: 'TURN_DONE' } };
      };
    }
    const body = surface === 'chat' ? { messages: [user], stream, ...(native ? {} : { tools: undefined }) }
      : { input: 'synthetic', stream, ...(native ? {} : { tools: undefined }) };
    const call = surface === 'chat' ? chat : responses;
    const failed = await call(s, body);
    if (surface === 'responses' && stream) assert(failed.events.some(e => e.type === 'response.failed'));
    else assert.equal(failed.status, 503, failed.body);
    assert.equal(sends, 1); assert(first.cooldown_until > Date.now());
    const next = await call(s, body);
    assert.equal(next.status, 200, next.body); assert.equal(sends, 1);
    assert.match(next.body, /two/);
  });
}

test('explicitly selected accounts never silently fail over', async t => {
  const s = setup(t);
  s.pool.accounts[0].client.allocateIds = async () => { throw new UpstreamError('not login', { code: 200001, status: 502 }); };
  const r = await request(s.app, '/v1/chat/completions', { tools: definitions, messages: [user] }, { 'x-kuku-account': 'one' });
  assert.equal(r.status, 502); assert.equal(s.seen.send.length, 0); assert.equal(s.pool.accounts[0].auth_dead, true);
});

test('an in-flight failure still updates the live account after another account is saved', async t => {
  const s = setup(t);
  s.pool.accounts[0].client.sse = async function* () {
    s.pool.set(s.pool.accounts.map(a => ({ id: a.id, upstream_user_id: a.upstream_user_id, bduss: a.client.bduss, stoken: a.client.stoken })));
    throw new UpstreamError('expired', { code: 200001, status: 502 });
  };
  const r = await chat(s, { messages: [user] });
  assert.equal(r.status, 502); assert.equal(s.pool.accounts[0].auth_dead, true);
  assert.equal(s.pool.pick().id, 'two');
});

test('failure after waiting for renewal condemns the actual new credential and fails over', async t => {
  const s = setup(t, ({ account }) => ({ text: account.id }));
  let release;
  s.pool.credentialRefreshes.set('one', new Promise(resolve => { release = resolve; }));
  const pending = chat(s, { messages: [user] });
  await new Promise(resolve => setImmediate(resolve));
  const current = { ...s.pool.accounts[0], client: Object.assign(new KukuAccount({ bduss: 'new-cookie', stoken: 'new-token' }), {
    allocateIds: async () => { throw new UpstreamError('new token refused', { code: 200001, status: 502 }); },
    controlStream: s.pool.accounts[0].client.controlStream,
  }) };
  s.pool.accounts[0] = current;
  release();
  const response = await pending;
  assert.equal(response.status, 200, response.body); assert.equal(response.json.choices[0].message.content, 'two');
  assert.equal(current.auth_dead, true); assert.equal(s.pool.pick().id, 'two');
});

for(const explicit of [false,true]) test(`waiting requests recheck disabled accounts after renewal (explicit=${explicit})`,async t=>{
  const s=setup(t,({account})=>({text:account.id}));
  let release;
  s.pool.credentialRefreshes.set('one',new Promise(resolve=>{release=resolve;}));
  const pending=request(s.app,'/v1/chat/completions',{tools:definitions,messages:[user]},explicit?{'x-kuku-account':'one'}:{});
  await new Promise(resolve=>setImmediate(resolve));
  s.pool.accounts[0].disabled=true;release();
  const result=await pending;
  assert.equal(result.status,explicit?409:200,result.body);
  assert.equal(s.seen.send.length,explicit?0:1);
  if(!explicit)assert.equal(result.json.choices[0].message.content,'two');
});

for(const native of [false,true])test(`account disabled during preparation is not sent a conversation (native=${native})`,async t=>{
  const s=setup(t,({account})=>({text:account.id}));
  const first=s.pool.accounts[0],allocate=first.client.allocateIds;
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  first.client.allocateIds=async(...args)=>{started();await gate;return allocate(...args);};
  if(!native){s.pool.accounts[1].client.sendmsg=async()=>{};s.pool.accounts[1].client.sse=async function*(){yield {data:{type:'TEXT_BLOCK_DELTA',data:{delta:'two'}}};yield{data:{type:'TURN_DONE'}};};}
  const pending=chat(s,{messages:[user],...(native?{}:{tools:undefined})});
  await ready;first.disabled=true;release();
  const result=await pending;assert.equal(result.status,200,result.body);assert.equal(result.json.choices[0].message.content,'two');
  assert.equal(s.seen.send.length,native?1:0);
});

test('native balance refusal before any generated work safely fails over', async t => {
  const s = setup(t, ({ account }) => ({ text: account.id }));
  s.pool.accounts[0].client.nativeToolResult = async () => {};
  s.pool.accounts[0].client.sse = async function* () {
    yield { data: { type: 'COMMERCIAL', data: { reason: 'insufficient_balance', errno: 11002 } } };
  };
  const result = await chat(s, { messages: [user] });
  assert.equal(result.status, 200, result.body); assert.equal(result.json.choices[0].message.content, 'two');
  assert(s.pool.accounts[0].balance_dead_until > Date.now());
});

for (const unavailable of [true, false]) test(`Responses agent continuation restores complete tool history on a healthy account (already unavailable=${unavailable})`, async t => {
  const s = setup(t, ({ messages, account }) => messages.at(-1).role === 'tool'
    ? { text: `${account.id}:${messages.at(-1).content}` } : { calls: [{ name: 'read_file', arguments: { value: 'synthetic' } }] });
  const initial = (await responses(s, { input: 'start' })).json;
  const call = initial.output.find(o => o.type === 'function_call');
  if (unavailable) s.pool.markAuthDead(s.pool.accounts[0]);
  else s.pool.accounts[0].client.allocateIds = async () => { throw new UpstreamError('expired', { code: 200001, status: 502 }); };
  const next = await responses(s, { previous_response_id: initial.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'REAL_RESULT' }] });
  assert.equal(next.status, 200, next.body); assert.equal(next.json.output_text, 'two:REAL_RESULT');
  assert.equal(next.json.kuku.account, 'two'); assert.notEqual(next.json.kuku.session_id, initial.kuku.session_id);
  assert(s.seen.send.at(-1).text.includes(call.call_id));
});

for (const surface of ['chat', 'responses']) for (const stream of [false, true]) for (const large of ['count', 'size']) {
  test(`${surface} passes ${large === 'count' ? 'more than 128 tools' : 'more than 2 MiB of tool definitions'} through native discovery without truncation (stream=${stream})`, async t => {
    const tools = large === 'count'
      ? Array.from({ length: 129 }, (_, i) => ({ type: 'function', function: { ...definitions[0].function, name: `tool_${i}` } }))
      : [{ type: 'function', function: { ...definitions[0].function, name: 'large_tool', description: 'X'.repeat(2 * 1024 * 1024) + 'definition-tail' } }];
    const last = tools.at(-1).function;
    const s = setup(t, ({ tools: native }) => ({ calls: [{ name: native.at(-1).name, arguments: { value: 'synthetic' } }] }));
    const result = surface === 'chat'
      ? await chat(s, { tools, messages: [user], stream })
      : await responses(s, { tools: tools.map(t => ({ type: 'function', ...t.function })), input: 'Use the final defined tool.', stream });
    assert.equal(result.status, 200);
    assert.equal(s.seen.send.length, 1);
    assert.equal(s.seen.definitions[0].length, tools.length);
    assert.equal(s.seen.definitions[0].at(-1).name, last.name);
    assert.equal(s.seen.definitions[0].at(-1).description.length, last.description.length);
    if (large === 'size') assert.ok(s.seen.definitions[0][0].description.endsWith('definition-tail'));
    const name = surface === 'chat'
      ? stream ? result.events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? [])[0]?.function.name : result.json.choices[0].message.tool_calls[0].function.name
      : (stream ? result.events.find(e => e.type === 'response.completed').response : result.json).output.find(o => o.type === 'function_call').name;
    assert.equal(name, last.name);
  });
}

test('removing tool count limits still rejects duplicate names before contacting upstream', async t => {
  const s = setup(t);
  const tools = Array.from({ length: 129 }, (_, i) => ({ type: 'function', function: { ...definitions[0].function, name: `tool_${i}` } }));
  tools.at(-1).function.name = tools[0].function.name;
  const result = await chat(s, { tools, messages: [user] });
  assert.equal(result.status, 400);
  assert.equal(result.json.error.code, 'invalid_tools');
  assert.equal(s.seen.send.length, 0);
});

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
  assert(s.seen.send.every(s => !s.text.includes('preserve this instruction') && !s.text.includes('[object Object]') && !s.text.includes('CLIENT_TOOLS_JSON')));
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
  assert.equal(r.status, plan.text ? 200 : 502, r.body);
  if (plan.text) assert(r.events.some(e => e.error?.code === 'invalid_tool_response'));
  assert.equal(s.seen.send.length, 1); assert(!r.body.includes('"finish_reason":"tool_calls"'));
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

for (const surface of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`${surface} stabilizes discovery bytes and connector for reordered object keys while tool calls/results still roundtrip (stream=${stream})`, async t => {
    const tools = structuredClone(definitions);
    tools[0].function.description = '保持描述中的  空白\r\n与 Unicode';
    tools[0].function.parameters.properties.value = { description: 'Choose unchanged values.', type: 'string', enum: ['z', 'a'], default: 'z' };
    const reorderedObjects = value => Array.isArray(value) ? value.map(reorderedObjects)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorderedObjects(v)])) : value;
    const reordered = reorderedObjects(tools), snapshot = JSON.stringify(tools);
    const s = setup(t, ({ messages }) => messages.some(m => m.role === 'tool') ? { text: 'completed safely' }
      : { calls: [{ name: 'read_file', arguments: { value: 'z' } }] });
    const send = (defs, history = null) => surface === 'chat'
      ? chat(s, { tools: defs, messages: history ?? [user], stream })
      : responses(s, { tools: defs.map(t => ({ type: 'function', ...t.function })), input: history ?? 'start', stream });
    const first = await send(tools), second = await send(reordered);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(s.seen.send[0].connector_list[0].name, s.seen.send[1].connector_list[0].name);
    assert.equal(JSON.stringify(s.seen.definitions[0]), JSON.stringify(s.seen.definitions[1]));
    assert.deepEqual(s.seen.definitions[0].map(t => t.name), tools.map(t => t.function.name));
    assert.deepEqual(s.seen.definitions[0][0].inputSchema, tools[0].function.parameters);
    assert.equal(s.seen.definitions[0][0].description, tools[0].function.description);
    assert.equal(JSON.stringify(tools), snapshot);
    let history;
    if (surface === 'chat') {
      const wire = stream ? first.events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? [])[0] : first.json.choices[0].message.tool_calls[0];
      const call = { id: wire.id, type: wire.type, function: wire.function };
      assert.equal(call.function.name, 'read_file'); assert.deepEqual(JSON.parse(call.function.arguments), { value: 'z' });
      history = [user, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'synthetic completion' }];
    } else {
      const call = (stream ? first.events.find(e => e.type === 'response.completed').response : first.json).output.find(o => o.type === 'function_call');
      assert.equal(call.name, 'read_file'); assert.deepEqual(JSON.parse(call.arguments), { value: 'z' });
      history = [{ role: 'user', content: 'start' }, { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: 'synthetic completion' }];
    }
    const final = await send(reordered, history);
    assert.equal(final.status, 200); assert.ok(final.body.includes('completed safely'));
    assert.equal(JSON.stringify(s.seen.definitions[0]), JSON.stringify(s.seen.definitions[2]));
    assert.equal(s.seen.send[0].connector_list[0].name, s.seen.send[2].connector_list[0].name);
  });
}

test('actual description/schema changes and every array order change still get distinct connectors', async t => {
  const s = setup(t, () => ({ text: 'done' }));
  const baseline = structuredClone(definitions);
  baseline[0].function.parameters.properties.value.enum = ['z', 'a'];
  const description = structuredClone(baseline); description[0].function.description += ' ';
  const schema = structuredClone(baseline); schema[0].function.parameters.properties.value.enum = ['z', 'different'];
  const enumeration = structuredClone(baseline); enumeration[0].function.parameters.properties.value.enum.reverse();
  const order = structuredClone(baseline).reverse();
  for (const tools of [baseline, description, schema, enumeration, order]) assert.equal((await chat(s, { messages: [user], tools })).status, 200);
  assert.equal(new Set(s.seen.send.map(args => args.connector_list[0].name)).size, 5);
  assert.deepEqual(s.seen.definitions.at(-1).map(t => t.name), order.map(t => t.function.name));
  assert.deepEqual(s.seen.definitions[3][0].inputSchema.properties.value.enum, ['a', 'z']);
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

function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected progress before upstream completion')), 1500); })]); }
  finally { clearTimeout(timer); }
}
for (const surface of ['chat', 'responses']) for (const textFirst of [false, true]) test(`${surface} streams text and reasoning before TURN_DONE without replay (textFirst=${textFirst})`, async t => {
  const release = gate(), first = gate(); let upstreamFinished = false, deliveredBeforeCompletion = false;
  t.after(() => release.resolve());
  const s = setup(t, async ({ emit }) => {
    emit(textFirst ? 'TEXT_BLOCK_DELTA' : 'THINKING_BLOCK_DELTA', { delta: textFirst ? 'FIRST ' : 'THINK ' });
    await release.promise;
    emit(textFirst ? 'THINKING_BLOCK_DELTA' : 'TEXT_BLOCK_DELTA', { delta: textFirst ? 'THINK ' : 'FIRST ' });
    upstreamFinished = true;
    return { text: 'LAST', reasoning: 'DONE' };
  });
  const route = surface === 'chat' ? '/v1/chat/completions' : '/v1/responses';
  const tools = surface === 'chat' ? definitions : definitions.map(t => ({ type: 'function', ...t.function }));
  const pending = request(s.app, route, { stream: true, tools, ...(surface === 'chat' ? { messages: [user] } : { input: 'test' }) }, {}, value => {
    if (value.includes(textFirst ? 'FIRST ' : 'THINK ')) { deliveredBeforeCompletion = !upstreamFinished; first.resolve(); }
  });
  try { await within(first.promise); assert(deliveredBeforeCompletion); }
  finally { release.resolve(); }
  const r = await pending; assert.equal(r.status, 200); assert.equal(r.headers['x-accel-buffering'], 'no');
  if (surface === 'chat') {
    assert.equal(r.events.map(e => e.choices?.[0]?.delta?.content ?? '').join(''), 'FIRST LAST');
    assert.equal(r.events.map(e => e.choices?.[0]?.delta?.reasoning_content ?? '').join(''), 'THINK DONE');
  } else {
    const final = r.events.find(e => e.type === 'response.completed').response;
    assert.equal(r.events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'FIRST LAST');
    assert.equal(r.events.filter(e => e.type === 'response.reasoning_summary_text.delta').map(e => e.delta).join(''), 'THINK DONE');
    assert.deepEqual(final.output.map(o => o.type), textFirst ? ['message', 'reasoning'] : ['reasoning', 'message']);
    for (const [index, item] of final.output.entries()) {
      const added = r.events.filter(e => e.type === 'response.output_item.added' && e.item.id === item.id);
      const done = r.events.filter(e => e.type === 'response.output_item.done' && e.item.id === item.id);
      assert.equal(added.length, 1); assert.equal(done.length, 1);
      assert.equal(added[0].output_index, index); assert.equal(done[0].output_index, index);
      assert(r.events.filter(e => e.item_id === item.id).every(e => e.output_index === index));
    }
    assert.deepEqual(s.ledger.get(final.id).response.output, final.output);
    assert.deepEqual(r.events.map(e => e.sequence_number), r.events.map((_, i) => i));
  }
});

for (const surface of ['chat', 'responses']) test(`${surface} reports an invalid call after streamed text without exposing tools or retrying`, async t => {
  const release = gate(), first = gate(); t.after(() => release.resolve());
  const s = setup(t, async ({ emit }) => { emit('TEXT_BLOCK_DELTA', { delta: 'Checking ' }); await release.promise; return { calls: [{ name: 'read_file', arguments: { value: 123 } }] }; });
  const tools = surface === 'chat' ? definitions : definitions.map(t => ({ type: 'function', ...t.function }));
  const pending = request(s.app, surface === 'chat' ? '/v1/chat/completions' : '/v1/responses', { tools, stream: true, ...(surface === 'chat' ? { messages: [user] } : { input: 'test' }) }, {}, v => { if (v.includes('Checking ')) first.resolve(); });
  try { await within(first.promise); } finally { release.resolve(); }
  const r = await pending;
  assert.equal(r.status, 200, r.body); assert.equal(s.seen.send.length, 1); assert.equal(s.seen.close.length, 1);
  assert(!r.events.some(e => e.choices?.[0]?.delta?.tool_calls || e.type === 'response.function_call_arguments.delta' || e.type === 'response.completed'));
  if (surface === 'chat') assert(r.events.some(e => e.error?.code === 'invalid_tool_response'));
  else {
    const failed = r.events.find(e => e.type === 'response.failed').response;
    assert.equal(failed.output_text, 'Checking '); assert.equal(failed.error.code, 'invalid_tool_response');
  }
});

test('native preparation overlaps both ID requests with control connections and cancels siblings on failure', async t => {
  const s = setup(t, () => ({ text: 'ready' })), allocations = [], started = gate();
  s.pool.accounts[0].client.allocateIds = () => {
    assert.equal(s.seen.channels.length, 2);
    const allocation = gate(); allocations.push(allocation); if (allocations.length === 2) started.resolve();
    return allocation.promise;
  };
  t.after(() => allocations.forEach((g, i) => g.resolve({ chat_id: 'session-' + i, query_id: 'reply-' + i })));
  const pending = chat(s, { messages: [user] });
  try { await within(started.promise); assert.equal(s.seen.send.length, 0); }
  finally { allocations.forEach((g, i) => g.resolve({ chat_id: 'session-' + i, query_id: 'reply-' + i })); }
  assert.equal((await pending).status, 200); assert.equal(s.seen.send[0].session_id, 'session-0'); assert.equal(s.seen.send[0].reply_id, 'reply-1');
  const failed = setup(t); failed.pool.accounts[0].client.allocateIds = async () => { throw Object.assign(new Error('allocation failed'), { retryUnsafe: true }); };
  const r = await chat(failed, { messages: [user] }); assert.equal(r.status, 500); assert.equal(failed.seen.send.length, 0);
  assert(failed.seen.channels.every(c => c.signal.aborted));
});

test('account rotation after a streamed fragment blocks later fragments and executable calls', async t => {
  const release = gate(), first = gate(); t.after(() => release.resolve());
  const s = setup(t, async ({ emit, account }) => {
    emit('TEXT_BLOCK_DELTA', { delta: 'safe first' }); await release.promise;
    account.upstream_user_id = 'rotated'; return { text: 'forbidden later', calls: [{ name: 'read_file', arguments: { value: 'x' } }] };
  });
  const pending = request(s.app, '/v1/chat/completions', { messages: [user], tools: definitions, stream: true }, {}, v => { if (v.includes('safe first')) first.resolve(); });
  try { await within(first.promise); } finally { release.resolve(); }
  const r = await pending; assert.equal(r.status, 200); assert(!r.body.includes('forbidden later'));
  assert(r.events.some(e => e.error?.code === 'session_account_mismatch')); assert(!r.body.includes('"tool_calls":[')); assert.equal(s.seen.send.length, 1);
});

for (const surface of ['chat', 'responses']) test(`${surface} delivers the first text through a real HTTP stream before upstream completion`, async t => {
  const release = gate(), first = gate(); let finished = false;
  t.after(() => release.resolve());
  const s = setup(t, async ({ emit }) => { emit('TEXT_BLOCK_DELTA', { delta: 'HTTP_FIRST' }); await release.promise; finished = true; return { text: '_LAST' }; });
  const server = createServer(s.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const tools = surface === 'chat' ? definitions : definitions.map(t => ({ type: 'function', ...t.function }));
  const body = JSON.stringify({ model, tools, stream: true, ...(surface === 'chat' ? { messages: [user] } : { input: 'test' }) });
  const completed = new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: surface === 'chat' ? '/v1/chat/completions' : '/v1/responses', headers: { 'content-type': 'application/json' } }, res => {
      assert.equal(res.headers['x-accel-buffering'], 'no'); let text = '';
      res.on('data', chunk => { text += chunk; if (text.includes('HTTP_FIRST')) first.resolve(!finished); });
      res.on('end', () => resolve(text)); res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
  try { assert.equal(await within(first.promise), true); } finally { release.resolve(); }
  assert((await completed).includes('_LAST')); assert.equal(s.seen.send.length, 1);
});

for (const surface of ['chat', 'responses']) test(`${surface} disconnect after first text closes the native turn without retrying`, async t => {
  const release = gate(); t.after(() => release.resolve());
  const s = setup(t, async ({ emit }) => { emit('TEXT_BLOCK_DELTA', { delta: 'first' }); await release.promise; return { incomplete: true }; });
  const res = Object.assign(new EventEmitter(), { writableFinished: false, writeHead() {}, write(value) {
    if (value.includes('first')) { this.emit('close'); release.resolve(); }
  }, end() { this.writableFinished = true; } });
  const tools = surface === 'chat' ? definitions : definitions.map(t => ({ type: 'function', ...t.function }));
  const req = { url: surface === 'chat' ? '/v1/chat/completions' : '/v1/responses', method: 'POST', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model, tools, stream: true, ...(surface === 'chat' ? { messages: [user] } : { input: 'test' }) })); } };
  await within(s.app(req, res));
  assert.equal(s.seen.send.length, 1); assert.equal(s.seen.close.length, 1); assert(s.seen.channels.every(c => c.signal.aborted));
});

for (const type of ['AWAITING_INPUT', 'REQUIRE_EXTERNAL_EXECUTION']) test(`${type} after a validated native client call permits handoff instead of a false desktop-tool error`, async t => {
  const s = setup(t, () => ({ calls: [{ name: 'read_file', arguments: { value: 'demo.txt' } }], waitWithCalls: type }));
  const r = await chat(s, { messages: [user], stream: true });
  assert.equal(r.status, 200, r.body); assert.equal(s.seen.close.length, 1); assert.equal(s.seen.send.length, 1);
  assert.equal(r.events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []).length, 1);
  assert(!r.events.some(e => e.error));
});

test('caller instructions are sent once with role labels while all user and tool history remains intact', async t => {
  const s = setup(t, () => ({ text: 'done' }));
  const system = 'SYSTEM_ONLY_' + '规则'.repeat(2000), developer = 'DEVELOPER_ONLY_' + 'detail '.repeat(1000);
  const messages = [{ role: 'system', content: system }, { role: 'developer', content: developer }, user];
  const r = await chat(s, { messages }); assert.equal(r.status, 200, r.body);
  const sent = s.seen.send[0], transcript = JSON.parse(sent.text.split('CONVERSATION_JSON: ')[1].split('\nContinue the next')[0]);
  assert.deepEqual(transcript, [user].map(m=>({role:m.role,content:m.content.map(p=>p.text).join('')})));
  assert.equal((sent.text + sent.custom_instructions).split(system).length - 1, 1);
  assert.equal((sent.text + sent.custom_instructions).split(developer).length - 1, 1);
  assert(sent.custom_instructions.includes('CALLER_SYSTEM_INSTRUCTIONS:\n'+system));
  assert(sent.custom_instructions.includes('CALLER_DEVELOPER_INSTRUCTIONS:\n'+developer));
  const instructions = 'RESPONSES_INSTRUCTIONS_UNIQUE';
  const response = await responses(s, { input: 'next request', instructions }); assert.equal(response.status, 200);
  const next = s.seen.send[1]; assert.equal((next.text + next.custom_instructions).split(instructions).length - 1, 1);
});

test('bounded agent timing metadata is saved to SQLite logs without caller text or tool arguments', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-agent-timing-')), db = openDatabase({ root });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const s = setup(t, () => ({ text: 'PRIVATE_ANSWER', reasoning: 'PRIVATE_REASONING' }), db.ledger);
  s.pool.database = db;
  s.pool.logger = createDatabaseLogger(db, { consoleOutput: { log() {}, warn() {}, error() {} } });
  const r = await responses(s, { input: 'PRIVATE_PROMPT', instructions: 'PRIVATE_INSTRUCTIONS', store: false }); assert.equal(r.status, 200);
  const rows = db.sql.prepare("SELECT message FROM logs WHERE message LIKE 'agent timing:%'").all();
  assert.equal(rows.length, 1); const log = rows[0].message;
  for (const text of ['PRIVATE_PROMPT','PRIVATE_ANSWER','PRIVATE_REASONING','PRIVATE_INSTRUCTIONS']) assert(!log.includes(text));
  const timing = JSON.parse(log.slice('agent timing: '.length));
  assert.equal(timing.model, model); assert.equal(timing.tool_count, definitions.length); assert.equal(timing.status, 'completed');
  for (const key of ['controls_ready_ms','ids_ready_ms','prepared_ms','send_started_ms','send_ack_ms','tool_list_ms','tools_ready_ms','first_text_ms','first_reasoning_ms','total_ms']) assert(Number.isInteger(timing[key]) && timing[key] >= 0, key);
  assert.equal(timing.tool_list_count, 1); assert.equal(timing.tool_call_count, 0); assert.equal(timing.model_ends_ms.length, 1);
  assert(timing.prepared_ms <= timing.send_started_ms); assert(timing.total_ms >= timing.first_text_ms);
  assert(timing.prompt_bytes > 0 && timing.instruction_bytes > 0);
  assert.match(timing.tool_fingerprint, /^[a-f0-9]{24}$/);
  assert.equal(s.seen.send[0].connector_list[0].name, `external_agent_${timing.tool_fingerprint}`);
  assert.equal(timing.tool_definition_bytes, Buffer.byteLength(JSON.stringify(s.seen.definitions[0])));
  assert(!log.includes(definitions[0].function.name));
  assert(db.sql.prepare('SELECT 1 FROM usage_records WHERE id=?').get(timing.turn_id));
});
