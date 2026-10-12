// Synthetic phone numbers, cookies and transport only; never sends a real SMS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginManager } from '../src/logins.mjs';
import { sendSmsCode, smsLogin, createJar } from '../src/passport.mjs';

function fixture(overrides = {}) {
  let time = Date.now();
  const calls = { send: [], verify: [], added: [] };
  const logs = [];
  const passport = {
    seedDeviceCookie: async () => new Map(), getApiToken: async () => 'fixture-token',
    sendSmsCode: async args => { calls.send.push(args); return { state: 'sent' }; },
    smsLogin: async args => { calls.verify.push(args); return { state: 'logged_in', bduss: 'fixture-cookie', ptoken: 'fixture-ptoken' }; },
    exchangeStoken: async () => 'fixture-stoken', verifyKukuLogin: async () => {},
    captchaImage: async () => ({ buffer: Buffer.from('fixture-image') }),
    ...overrides,
  };
  const adapter = Object.fromEntries(Object.keys(passport).map(name => [name, (...args) => passport[name](...args)]));
  const manager = createLoginManager({ passport: adapter, now: () => time, logger: { warn: (...args) => logs.push(args.join(' ')) }, addAccount: async account => { calls.added.push(account); return { account }; } });
  return { manager, passport, calls, logs, advance: ms => { time += ms; }, start: () => manager.startSms({ phone: '13800000000', alias: 'fixture', priority: 4 }) };
}

test('invalid phones and SMS codes fail without any upstream request', async () => {
  const f = fixture();
  for (const phone of ['', '12', '10000000000', '138000000000', '1380000000x']) assert.equal((await f.manager.startSms({ phone })).status, 400);
  assert.equal(f.calls.send.length, 0);
  const s = await f.start();
  for (const code of ['', '1234', 'abcdef', '1234567']) assert.equal((await f.manager.verifySms({ login_id: s.login_id, code })).code, 'invalid_sms_code');
  assert.equal(f.calls.verify.length, 0);
});

test('mainland SMS sessions preserve the empty country code on initial send and resend', async () => {
  const f = fixture(), s = await f.manager.startSms({ phone: '13800000000', countrycode: '86' });
  assert.equal(f.calls.send[0].countrycode, '');
  f.advance(60001);
  await f.manager.resendSms(s.login_id);
  assert.equal(f.calls.send[1].countrycode, '');
});

test('passport sends mainland SMS with an empty country code, including captcha retries', async t => {
  const queries = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const query = new URL(url).searchParams;
    queries.push(query);
    return new Response(JSON.stringify(query.get('countrycode') === ''
      ? { errno: 18, vcodestr: 'fixture-challenge', vcodesign: 'fixture-sign' }
      : { errno: 1, msg: '手机号格式错误' }));
  });
  const spec = { phone: '13800000000', token: 'fixture-token', jar: createJar() };
  assert.equal((await sendSmsCode(spec)).state, 'captcha_required');
  await sendSmsCode({ ...spec, captcha: { vcodestr: 'fixture-challenge', vcodesign: 'fixture-sign', code: 'ABCD' } });
  for (const query of queries) {
    assert.equal(query.get('countrycode'), ''); assert.equal(query.get('username'), spec.phone);
  }
  assert.equal(queries[1].get('vcodestr'), 'fixture-challenge');
  assert.equal(queries[1].get('verifycode'), 'ABCD');
});

test('captcha retry uses the server-owned challenge even when the client sends no IDs or forged IDs', async () => {
  const f = fixture();
  f.passport.sendSmsCode = async args => {
    f.calls.send.push(args);
    return args.captcha?.code === 'ABCD' ? { state: 'sent' } : { state: 'captcha_required', vcodestr: 'server-challenge', vcodesign: 'server-sign', captcha_url: 'https://fixture.test/image' };
  };
  const s = await f.start();
  assert.equal(s.captcha_stage, 'send'); assert.equal(s.sends_remaining, 5);
  assert.equal((await f.manager.resendSms(s.login_id)).code, 'captcha_required');
  assert.equal(f.calls.send.length, 1);
  const sent = await f.manager.resendSms(s.login_id, { code: 'ABCD', vcodestr: 'forged', vcodesign: 'forged' });
  assert.equal(sent.state, 'sent'); assert.equal(sent.sends_remaining, 4);
  assert.deepEqual(f.calls.send[1].captcha, { code: 'ABCD', vcodestr: 'server-challenge', vcodesign: 'server-sign' });
});

test('resend cooldown, five actual sends and original ten-minute expiry are enforced by the backend', async () => {
  const f = fixture(), s = await f.start();
  assert.equal(s.expires_in_ms, 600000); assert.equal(s.retry_after_ms, 60000);
  f.advance(15000);
  const limited = await f.manager.resendSms(s.login_id);
  assert.equal(limited.status, 429); assert.equal(limited.retry_after_ms, 45000);
  assert.equal(f.calls.send.length, 1);
  f.advance(45001);
  const resent = await f.manager.resendSms(s.login_id);
  assert.equal(resent.expires_in_ms, 539999, 'resending must not extend the session');
  for (let i = 0; i < 3; i++) { f.advance(60001); assert.equal((await f.manager.resendSms(s.login_id)).state, 'sent'); }
  f.advance(60001); assert.equal((await f.manager.resendSms(s.login_id)).code, 'sms_send_limit');
  assert.equal(f.calls.send.length, 5);
  f.advance(600000);
  assert.equal((await f.manager.resendSms(s.login_id)).code, 'login_session_expired');
  assert.equal((await f.manager.verifySms({ login_id: s.login_id, code: '123456' })).code, 'login_session_expired');
  assert.equal(await f.manager.captcha(s.login_id), null);
  assert.equal(f.calls.verify.length, 0);
});

test('login captcha is submitted to verification with the original SMS code, not sent as a new SMS', async () => {
  const f = fixture();
  f.passport.smsLogin = async args => {
    f.calls.verify.push(args);
    return args.captcha ? { state: 'logged_in', bduss: 'fixture-cookie', ptoken: 'fixture-ptoken' }
      : { state: 'captcha_required', vcodestr: 'login-challenge', captcha_url: 'https://fixture.test/image', slide: false };
  };
  const s = await f.start();
  const challenge = await f.manager.verifySms({ login_id: s.login_id, code: '123456' });
  assert.equal(challenge.captcha_stage, 'verify');
  const missing = await f.manager.verifySms({ login_id: s.login_id, code: '123456' });
  assert.equal(missing.code, 'captcha_required'); assert.equal(f.calls.verify.length, 1);
  const result = await f.manager.verifySms({ login_id: s.login_id, code: '123456', captcha: { code: 'ABCD' } });
  assert.equal(result.state, 'added'); assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.verify[1].code, '123456'); assert.equal(f.calls.verify[1].captcha.vcodestr, 'login-challenge');
  const replay = await f.manager.verifySms({ login_id: s.login_id, code: '123456' });
  assert.equal(replay.account_id, result.account_id); assert.equal(f.calls.added.length, 1);
  assert.equal(f.calls.added[0].alias, 'fixture'); assert.equal(f.calls.added[0].priority, 4);
  assert.equal(await f.manager.captcha(s.login_id), null);
});

test('concurrent resends and verification cannot share or mutate an in-flight SMS operation', async () => {
  const f = fixture(), s = await f.start(); f.advance(60001);
  let release;
  f.passport.sendSmsCode = args => { f.calls.send.push(args); return new Promise(resolve => { release = resolve; }); };
  const resend = f.manager.resendSms(s.login_id); await Promise.resolve();
  assert.equal((await f.manager.resendSms(s.login_id)).code, 'login_in_progress');
  assert.equal((await f.manager.verifySms({ login_id: s.login_id, code: '123456' })).code, 'login_in_progress');
  release({ state: 'sent' }); await resend;
  assert.equal(f.calls.send.length, 2); assert.equal(f.calls.verify.length, 0);
});

test('a failed upstream resend releases the operation lock and preserves the original session expiry', async () => {
  const f = fixture(), s = await f.start(); f.advance(60001);
  f.passport.sendSmsCode = async () => { throw new Error('fixture-network-error'); };
  await assert.rejects(f.manager.resendSms(s.login_id), /fixture-network-error/);
  assert.equal((await f.manager.verifySms({ login_id: s.login_id, code: '123456' })).state, 'added');
});

test('concurrent verification shares one upstream login and one account add', async () => {
  const f = fixture(), s = await f.start();
  let release;
  f.passport.smsLogin = args => { f.calls.verify.push(args); return new Promise(resolve => { release = resolve; }); };
  const spec = { login_id: s.login_id, code: '123456' };
  const first = f.manager.verifySms(spec), second = f.manager.verifySms(spec);
  await Promise.resolve();
  assert.equal(f.calls.verify.length, 1);
  release({ state: 'logged_in', bduss: 'fixture-cookie', ptoken: 'fixture-ptoken' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.state, 'added'); assert.equal(b.account_id, a.account_id);
  assert.equal(f.calls.added.length, 1);
});

test('slider challenges remain detectable even without a plain-image challenge ID', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ errInfo: { no: 257 }, data: { isslide: 1 } })));
  const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar() });
  assert.equal(result.state, 'captcha_required'); assert.equal(result.slide, true);
  assert.equal(result.captcha_url, '');
});

test('passport keeps login captcha fields separate from the SMS send challenge', async t => {
  let fields;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    fields = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ errInfo: { no: 1 }, data: { msg: 'fixture-refused' } }));
  });
  await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar(), vcode: { vcodestr: 'send-challenge', vcodesign: 'send-sign' }, captcha: { vcodestr: 'login-challenge', code: 'ABCD' } });
  assert.equal(fields.get('smsVcodestr'), 'send-challenge');
  assert.equal(fields.get('codestring'), 'login-challenge'); assert.equal(fields.get('verifycode'), 'ABCD');
  assert.equal(fields.get('smsCodeString'), '123456');
  assert.equal(fields.get('staticPage'), 'https://kuku.baidu.com/m-static/genflow-login/thirdparty/pass_v3_jump.html');
});

function loginHtml(query) {
  return '<!DOCTYPE html><html><body><script>var href = decodeURIComponent("https:\\/\\/kuku.baidu.com\\/m-static\\/genflow-login\\/thirdparty\\/pass_v3_jump.html")+"?";\n'
    + `var accounts = '&accounts='; href += ${JSON.stringify(new URLSearchParams(query).toString())} + accounts; window.location.replace(href);</script></body></html>`;
}

test('HTML SMS login success reads the callback error code and accepts only actual credential cookies', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(loginHtml({ err_no: '0', callback: 'parent.fixture' }), {
    headers: { 'content-type': 'text/html', 'set-cookie': 'BDUSS=fixture-cookie; Path=/' },
  }));
  const jar = createJar({ PTOKEN: 'fixture-ptoken' });
  const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar });
  assert.equal(result.state, 'logged_in'); assert.equal(result.bduss, 'fixture-cookie');
  assert.equal(result.ptoken, 'fixture-ptoken');
});

test('HTML login callback errors preserve the numeric code and decode the graphic challenge', async t => {
  const query = { err_no: '400056', codeString: 'challenge+with/slash=', err_msg: '验证码错误', secret_id: 'PRIVATE-CALLBACK-SECRET', access_token: 'PRIVATE-ACCESS-TOKEN' };
  t.mock.method(globalThis, 'fetch', async () => new Response(loginHtml(query)));
  const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar() });
  assert.equal(result.state, 'captcha_required'); assert.equal(result.code, 400056);
  assert.equal(result.vcodestr, query.codeString); assert.equal(result.message, query.err_msg);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
});

test('HTML login refusals without an upstream message show the real error code rather than -1', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(loginHtml({ err_no: '257', codeString: '', isslide: '', err_msg: '' })));
  const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar() });
  assert.equal(result.state, 'refused'); assert.equal(result.code, 257);
  assert.match(result.message, /257/); assert.doesNotMatch(result.message, /errInfo -1/);
});

test('HTML slider challenges remain visible and never become ordinary SMS resends', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(loginHtml({ err_no: '257', isslide: '1' })));
  const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar() });
  assert.equal(result.state, 'captcha_required'); assert.equal(result.slide, true);
});

test('unrecognized HTML, missing success cookies and upstream HTTP errors cannot report a successful login', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response());
  const spec = { phone: '13800000000', code: '123456', token: 'fixture-token' };
  for (const body of ['<html>maintenance</html>', '<script>globalThis.SMS_EXECUTED=true; href += computeQuery()</script>', '{}', '{"errInfo":{"no":""}}']) {
    response = () => new Response(body);
    const result = await smsLogin({ ...spec, jar: createJar({ BDUSS: 'fixture-cookie' }) });
    assert.equal(result.code, 'login_response_unrecognized'); assert.equal(result.state, 'refused');
  }
  assert.equal(globalThis.SMS_EXECUTED, undefined, 'upstream scripts must never execute');
  response = () => new Response(loginHtml({ err_no: '0' }));
  assert.equal((await smsLogin({ ...spec, jar: createJar() })).state, 'no_cookie');
  response = () => new Response(loginHtml({ err_no: '0' }), { status: 503 });
  await assert.rejects(smsLogin({ ...spec, jar: createJar({ BDUSS: 'fixture-cookie' }) }), /HTTP 503/);
});

test('JSON and JSONP login errors still retain structured upstream messages', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  for (const format of [value => JSON.stringify(value), value => `cb(${JSON.stringify(value)})`]) {
    body = format({ errInfo: { errno: '16', msg: '验证码无效' } });
    const result = await smsLogin({ phone: '13800000000', code: '123456', token: 'fixture-token', jar: createJar() });
    assert.equal(result.state, 'refused'); assert.equal(result.code, 16); assert.equal(result.message, '验证码无效');
  }
});

test('SMS business error diagnostics retain the error code without storing phone, OTP or upstream text', async () => {
  const f = fixture(), s = await f.start();
  f.passport.smsLogin = async () => ({ state: 'refused', code: 16, status: 200, message: 'PRIVATE-UPSTREAM-TEXT' });
  const result = await f.manager.verifySms({ login_id: s.login_id, code: '123456' });
  assert.equal(result.code, 16);
  assert.match(f.logs.join('\n'), /"code":16/);
  assert.doesNotMatch(f.logs.join('\n'), /13800000000|123456|PRIVATE-UPSTREAM-TEXT|fixture-token/);
});
