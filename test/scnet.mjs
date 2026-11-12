// Synthetic SCNet credentials only. No network: every upstream call is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/gateway.mjs';
import { ScnetAccount, reasoningEffortOf } from '../src/scnet-upstream.mjs';
import { createScnetPassport } from '../src/scnet-passport.mjs';
import { createScnetLoginManager } from '../src/scnet-logins.mjs';
import { createAccountManager } from '../src/accounts.mjs';
import { toRecords } from '../src/store.mjs';
import { handleScnetChat } from '../src/server.mjs';

function response({ status = 200, body = '', setCookies = [], stream = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: () => setCookies },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    body: stream,
  };
}

async function* sse(frames) {
  const encoder = new TextEncoder();
  for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
  yield encoder.encode('data: [DONE]\n\n');
}

const scnetRecord = (over = {}) => ({ id: 'scnet-0', alias: 'scnet', priority: 0, disabled: false, platform: 'scnet',
  access_token: 'fixture-jwt', api_key: 'sk-fixture', cookies: ['jsessionid=fixture', 'Token=fixture'], ...over });

test('passport: SMS login, activity key and auth failures use the client shapes', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body ?? '' });
    if (String(url).includes('sendDesktopClientPhoneCode')) {
      return response({ body: { msg: 'success', code: '0' }, setCookies: ['jsessionid=abc; Path=/; HttpOnly'] });
    }
    if (String(url).includes('loginDesktopClientByPhoneCode')) {
      return response({ body: { code: '0', data: { id: '11049120341', userName: 'fixture', token: 'jwt-243', 'X-Jwt-Refresh-Token': 'refresh-563' } },
        setCookies: ['jsessionid=def; Path=/', 'Token=short; Path=/'] });
    }
    if (String(url).includes('createActivityApiKey')) {
      return response({ body: { code: '0', data: { apiKey: 'sk-activity', baseUrl: 'https://api.scnet.cn/api/llm/v1', model: 'MiniMax-M2.5' } } });
    }
    return response({ status: 401, body: { code: '401', msg: '用户未登录!' } });
  });
  const passport = createScnetPassport();
  const sent = await passport.sendPhoneCode({ phone: '13800000000' });
  assert.equal(sent.cookies[0], 'jsessionid=abc');
  assert.match(calls[0].url, /sendDesktopClientPhoneCode/);
  assert.equal(calls[0].body, 'phoneNum=13800000000');
  assert.equal(calls[0].headers.source, 'Electron');

  const logged = await passport.loginWithPhoneCode({ code: '123456', cookies: sent.cookies });
  assert.equal(logged.accessToken, 'jwt-243');
  assert.equal(logged.user.id, '11049120341');
  assert.ok(logged.cookies.includes('Token=short'));

  const key = await passport.activityApiKey({ token: logged.accessToken, cookies: logged.cookies });
  assert.equal(key.apiKey, 'sk-activity');

  await assert.rejects(() => passport.currentUser({ token: 'dead' }), (e) => e.status === 401);
});

test('account probe is a zero-cost /models call; chat parses both response modes', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.endsWith('/models')) return response({ body: { object: 'list', data: [] } });
    if (u.endsWith('/chat/completions')) {
      return response({ body: { id: 'x', choices: [{ message: { content: 'OK', reasoning_content: 'think' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } });
    }
    return response({ status: 401, body: { error: { message: 'Authentication Failed', code: '401' } } });
  });
  const acct = new ScnetAccount(scnetRecord());
  assert.deepEqual(await acct.probe(), { ok: true });
  const turn = await acct.chat({ messages: [{ role: 'user', content: 'hi' }], params: {} });
  assert.equal(turn.content, 'OK');
  assert.equal(turn.reasoning, 'think');
  assert.equal(turn.usage.total_tokens, 4);

  t.mock.method(globalThis, 'fetch', async () => response({ status: 401, body: { error: { message: 'Authentication Failed', code: '401' } } }));
  await assert.rejects(() => acct.probe(), (e) => e.status === 401);
});

test('account chat streams reasoning and content deltas', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ stream: sse([
    { choices: [{ index: 0, delta: { reasoning_content: 'think' } }] },
    { choices: [{ index: 0, delta: { content: 'OK' } }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ]) }));
  const acct = new ScnetAccount(scnetRecord());
  const deltas = [];
  const turn = await acct.chat({ messages: [{ role: 'user', content: 'hi' }], params: { stream: true, reasoningEffort: 'high' }, onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, [{ reasoning_content: 'think' }, { content: 'OK' }]);
  assert.equal(turn.content, 'OK');
  assert.equal(turn.reasoning, 'think');
  assert.equal(turn.usage.total_tokens, 3);
});

test('reasoning effort maps onto the upstream low/high/max levels', () => {
  assert.equal(reasoningEffortOf({ reasoning_effort: 'medium' }), 'high');
  assert.equal(reasoningEffortOf({ reasoning_effort: 'xhigh' }), 'max');
  assert.equal(reasoningEffortOf({ reasoning: { effort: 'low' } }), 'low');
  assert.equal(reasoningEffortOf({}), null);
});

test('pool dispatches clients by platform and never mixes the two pools', () => {
  const pool = new Pool([{ id: 'b1', bduss: 'cookie', stoken: 'stoken' }, scnetRecord()]);
  const baidu = pool.accounts.find((a) => a.id === 'b1');
  const scnet = pool.accounts.find((a) => a.id === 'scnet-0');
  assert.equal(baidu.platform, 'baidu');
  assert.equal(scnet.platform, 'scnet');
  assert.ok(scnet.client instanceof ScnetAccount);
  assert.equal(pool.pick({ allowUnavailable: true }).id, 'b1');
  assert.equal(pool.pick({ allowUnavailable: true, platform: 'scnet' }).id, 'scnet-0');
  assert.equal(pool.resolve('scnet-0', { platform: 'scnet' }).id, 'scnet-0');
  assert.throws(() => pool.resolve('scnet-0'), (e) => e.status === 404);
  const records = toRecords(pool.accounts);
  const persisted = records.find((r) => r.id === 'scnet-0');
  assert.equal(persisted.platform, 'scnet');
  assert.equal(persisted.access_token, 'fixture-jwt');
  assert.equal(persisted.api_key, 'sk-fixture');
  assert.ok(!('bduss' in persisted));
});

test('a 401 from the SCNet gateway condemns only the SCNet account', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ status: 401, body: { error: { message: 'Authentication Failed', code: '401' } } }));
  const pool = new Pool([scnetRecord()]);
  const account = pool.accounts[0];
  await assert.rejects(() => pool.scnetChat({ account, model: 'SCNet-Max', messages: [{ role: 'user', content: 'hi' }], params: {} }));
  assert.equal(account.auth_dead, true);
  assert.equal(pool.isUnavailable(account), true);
});

test('account manager adds SCNet by token, persists it and refuses the same user twice', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('current-user-info')) return response({ body: { code: '0', data: { id: '11049120341' } } });
    if (u.endsWith('/models')) return response({ body: { object: 'list', data: [] } });
    return response({ status: 404 });
  });
  const saved = { value: null };
  const store = { save: (data) => { saved.value = data; return data; }, load: () => saved.value };
  const pool = new Pool([]);
  const manager = createAccountManager({ pool, store, deviceId: 'device' });
  const added = await manager.add({ platform: 'scnet', id: 'scnet-0', accessToken: 'jwt-a', apiKey: 'sk-a', cookies: ['jsessionid=a'] });
  assert.equal(added.ok, true);
  assert.equal(pool.accounts[0].platform, 'scnet');
  assert.equal(saved.value.accounts[0].access_token, 'jwt-a');
  const dup = await manager.add({ platform: 'scnet', id: 'scnet-1', accessToken: 'jwt-b', apiKey: 'sk-b' });
  assert.equal(dup.error.status, 409);
  assert.equal(dup.error.code, 'account_already_exists');
  const missing = await manager.add({ platform: 'scnet', id: 'scnet-2' });
  assert.equal(missing.error.status, 400);
});

test('login manager derives the activity key and never echoes it', async () => {
  const added = [];
  const passport = {
    sendPhoneCode: async ({ phone }) => ({ cookies: [`jsessionid=${phone}`] }),
    loginWithPhoneCode: async () => ({ accessToken: 'jwt', cookies: ['jsessionid=x', 'Token=y'], user: { id: '11049120341' } }),
    activityApiKey: async () => ({ apiKey: 'sk-activity' }),
  };
  const manager = createScnetLoginManager({ passport, addAccount: async (spec) => { added.push(spec); return { account: { id: spec.id } }; } });
  assert.equal((await manager.start({ phone: '123' })).code, 'invalid_phone');
  const started = await manager.start({ phone: '13800000000', alias: 'fixture' });
  assert.equal(started.state, 'sent');
  const bad = await manager.verify({ login_id: started.login_id, code: '12' });
  assert.equal(bad.code, 'invalid_sms_code');
  const done = await manager.verify({ login_id: started.login_id, code: '123456' });
  assert.equal(done.state, 'added');
  assert.equal(added[0].platform, 'scnet');
  assert.equal(added[0].apiKey, 'sk-activity');
  assert.ok(!JSON.stringify(done).includes('sk-activity'));
  assert.ok(!JSON.stringify(done).includes('jsessionid'));
});

test('passport: password login RSA-encrypts and uses the desktop login shape', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? ''), headers: init.headers ?? {} });
    if (String(url).includes('loginDesktopClient.action')) {
      return response({ body: { code: '0', data: { id: '11049120341', userName: 'acivdbzsj5', token: 'jwt-pw', 'X-Jwt-Refresh-Token': 'refresh-pw' } },
        setCookies: ['Token=pwshort; Path=/'] });
    }
    return response({ status: 404 });
  });
  const passport = createScnetPassport();
  const logged = await passport.loginWithPassword({ username: 'acivdbzsj5', password: 'secret-plaintext' });
  assert.equal(logged.accessToken, 'jwt-pw');
  assert.equal(logged.user.id, '11049120341');
  assert.ok(logged.cookies.includes('Token=pwshort'));
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('username'), 'acivdbzsj5');
  assert.equal(form.get('encrypted'), 'true');
  assert.equal(form.get('isSevenDaysValidity'), 'true');
  // Plaintext must never hit the wire; the password field is 64-byte RSA-512 ciphertext.
  assert.ok(!calls[0].body.includes('secret-plaintext'));
  assert.equal(Buffer.from(form.get('password'), 'base64').length, 64);
  assert.match(calls[0].url, /loginDesktopClient\.action/);
});

test('passport: bad password (1014) is a friendly 401; captcha endpoints parse', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('loginDesktopClient.action')) return response({ body: { code: '1014', msg: 'user not exits or password is not correct' } });
    if (u.includes('isNeedCpatcha')) return response({ body: { code: '0', data: true } });
    if (u.includes('getClientCaptcha')) return response({ body: { code: 0, msg: 'success', data: 'data:image/jpeg;base64,AAAA', captchaKey: 'captcha:KEY' } });
    return response({ status: 404 });
  });
  const passport = createScnetPassport();
  await assert.rejects(() => passport.loginWithPassword({ username: 'x', password: 'y' }), (e) => e.status === 401 && /用户名或密码错误/.test(e.message));
  assert.equal((await passport.captchaNeeded({})).needed, true);
  const cap = await passport.getCaptcha({});
  assert.equal(cap.captchaKey, 'captcha:KEY');
  assert.match(cap.image, /^data:image/);
});

test('login manager: password login (no captcha) derives the key and never echoes secrets', async () => {
  const added = [];
  const passport = {
    encryptPassword: (p) => `enc(${p})`,
    captchaNeeded: async () => ({ needed: false, cookies: ['jsessionid=pw'] }),
    loginWithPassword: async ({ encryptedPassword }) => {
      assert.equal(encryptedPassword, 'enc(secret)');
      return { accessToken: 'jwt', cookies: ['Token=y'], user: { id: '11049120341' } };
    },
    activityApiKey: async () => ({ apiKey: 'sk-activity' }),
  };
  const manager = createScnetLoginManager({ passport, addAccount: async (spec) => { added.push(spec); return { account: { id: spec.id } }; } });
  assert.equal((await manager.startPassword({ username: '', password: 'x' })).code, 'invalid_username');
  assert.equal((await manager.startPassword({ username: 'u', password: '' })).code, 'invalid_password');
  const done = await manager.startPassword({ username: 'acivdbzsj5', password: 'secret', alias: 'fixture' });
  assert.equal(done.state, 'added');
  assert.equal(done.login_type, 'scnet_password');
  assert.equal(added[0].platform, 'scnet');
  assert.equal(added[0].apiKey, 'sk-activity');
  assert.equal(added[0].accessToken, 'jwt');
  const wire = JSON.stringify(done);
  assert.ok(!wire.includes('secret') && !wire.includes('sk-activity') && !wire.includes('enc('));
});

test('login manager: password captcha challenge then verify completes', async () => {
  const added = [];
  let loginCalls = 0;
  const passport = {
    encryptPassword: (p) => `enc(${p})`,
    captchaNeeded: async () => ({ needed: true, cookies: ['jsessionid=c'] }),
    getCaptcha: async () => ({ image: 'data:image/jpeg;base64,AAAA', captchaKey: 'captcha:KEY', cookies: ['jsessionid=c'] }),
    loginWithPassword: async ({ captcha, captchaKey, encryptedPassword }) => {
      loginCalls += 1;
      assert.equal(encryptedPassword, 'enc(secret)');
      assert.equal(captchaKey, 'captcha:KEY');
      assert.equal(captcha, 'abcd');
      return { accessToken: 'jwt', cookies: ['Token=y'], user: { id: '11049120341' } };
    },
    activityApiKey: async () => ({ apiKey: 'sk-activity' }),
  };
  const manager = createScnetLoginManager({ passport, addAccount: async (spec) => { added.push(spec); return { account: { id: spec.id } }; } });
  const challenge = await manager.startPassword({ username: 'u', password: 'secret' });
  assert.equal(challenge.state, 'captcha');
  assert.match(challenge.captcha_image, /^data:image/);
  assert.equal(challenge.captcha_key, 'captcha:KEY');
  assert.equal(loginCalls, 0);
  assert.equal((await manager.verifyPassword({ login_id: challenge.login_id, captcha: '' })).code, 'invalid_captcha');
  const done = await manager.verifyPassword({ login_id: challenge.login_id, captcha: 'abcd' });
  assert.equal(done.state, 'added');
  assert.equal(loginCalls, 1);
  assert.ok(!JSON.stringify(done).includes('secret'));
});

function fakeRes() {
  const chunks = [];
  return {
    status: 0, headers: null, ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(String(chunk)); },
    end(chunk) { if (chunk) chunks.push(String(chunk)); this.ended = true; },
    once() {}, setHeader() {},
    body() { return chunks.join(''); },
  };
}

test('chat completions handler serves SCNet-Max from the scnet pool', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/chat/completions')) {
      return response({ body: { id: 'x', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } });
    }
    return response({ status: 404 });
  });
  const pool = new Pool([scnetRecord()]);
  const res = fakeRes();
  await handleScnetChat(pool, { headers: {} }, res, { model: 'SCNet-Max', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body());
  assert.equal(body.model, 'SCNet-Max');
  assert.equal(body.choices[0].message.content, 'OK');
  assert.equal(body.usage.total_tokens, 3);
});

test('SCNet-Max Chat Completions forwards tools and returns tool calls', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/chat/completions')) {
      requests.push(JSON.parse(init.body));
      return response({ body: { id: 'scnet-tool-turn', choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'upstream-call', type: 'function', function: { name: 'lookup', arguments: '{"q":"kuku"}' } }] },
        finish_reason: 'tool_calls',
      }] } });
    }
    return response({ status: 404 });
  });
  const pool = new Pool([scnetRecord()]);
  const res = fakeRes();
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look up a value', parameters: {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
  } } }];
  await handleScnetChat(pool, { headers: {} }, res, {
    model: 'SCNet-Max', messages: [{ role: 'user', content: 'Find kuku' }], tools, tool_choice: { type: 'function', function: { name: 'lookup' } },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body());
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(body.choices[0].message.tool_calls[0].function, { name: 'lookup', arguments: '{"q":"kuku"}' });
  assert.deepEqual(requests[0].tools, tools);
  assert.deepEqual(requests[0].tool_choice, { type: 'function', function: { name: 'lookup' } });
});

test('SCNet-Max Chat Completions accepts assistant tool calls and tool results', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/chat/completions')) {
      request = JSON.parse(init.body);
      return response({ body: { id: 'scnet-tool-result', choices: [{ message: { role: 'assistant', content: 'The value is ready' }, finish_reason: 'stop' }] } });
    }
    return response({ status: 404 });
  });
  const pool = new Pool([scnetRecord()]);
  const res = fakeRes();
  await handleScnetChat(pool, { headers: {} }, res, {
    model: 'SCNet-Max',
    messages: [
      { role: 'user', content: 'Find kuku' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"kuku"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"value":"ready"}' },
    ],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body()).choices[0].message.content, 'The value is ready');
  assert.deepEqual(request.messages[1], {
    role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"kuku"}' } }],
  });
  assert.deepEqual(request.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '{"value":"ready"}' });
});

test('SCNet-Max Chat Completions streams tool call deltas', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => String(url).endsWith('/chat/completions')
    ? response({ stream: sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q"' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"kuku"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]) })
    : response({ status: 404 }));
  const pool = new Pool([scnetRecord()]);
  const res = fakeRes();
  await handleScnetChat(pool, { headers: {} }, res, {
    model: 'SCNet-Max', messages: [{ role: 'user', content: 'Find kuku' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }], stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.body(), /"tool_calls"/);
  assert.match(res.body(), /"finish_reason":"tool_calls"/);
  assert.match(res.body(), /data: \[DONE\]/);
});

test('SCNet-Max without an SCNet account fails with a pool error instead of using Baidu', async () => {
  const pool = new Pool([{ id: 'b1', bduss: 'cookie', stoken: 'stoken' }]);
  const res = fakeRes();
  await handleScnetChat(pool, { headers: {} }, res, { model: 'SCNet-Max', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body()).error.code, 'pool_unavailable');
});

test('points() probes SCNet with the inference credential and never resurrects a dead key', async (t) => {
  let keyOk = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/models')) {
      return keyOk
        ? response({ body: { object: 'list', data: [] } })
        : response({ status: 401, body: { error: { message: 'Authentication Failed', code: '401' } } });
    }
    return response({ status: 404 });
  });
  const pool = new Pool([scnetRecord()]);
  let out = await pool.points();
  assert.equal(out[0].ok, true);
  pool.markAuthDead(pool.accounts[0]);
  keyOk = false;
  out = await pool.points();
  assert.equal(out[0].ok, false);
  assert.equal(pool.accounts[0].auth_dead, true);
});

test('shared back-off is scoped per platform', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const pool = new Pool([{ id: 'b1', bduss: 'cookie', stoken: 'stoken' },
    scnetRecord({ id: 's1' }), scnetRecord({ id: 's2', access_token: 'jwt-2', api_key: 'sk-2' })]);
  for (const id of ['s1', 's2']) {
    const account = pool.accounts.find((a) => a.id === id);
    await assert.rejects(() => pool.scnetChat({ account, model: 'SCNet-Max', messages: [{ role: 'user', content: 'x' }], params: {} }));
  }
  assert.throws(() => pool.recovery.check('SCNet-Max', false, 'scnet'));
  assert.doesNotThrow(() => pool.recovery.check('SCNet-Max', false, 'baidu'));
  assert.ok(pool.pick({ platform: 'baidu' }));
});
