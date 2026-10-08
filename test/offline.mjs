// Offline regression suite. Zero credentials, zero credits, never touches kuku.baidu.com.
// It proves only that our own parsing/normalisation/scheduling/limiting logic did not regress.
// Live acceptance against the real pool is a separate script and must stay out of this gate.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1';
const profileIdentities = new Map();
// Upstream item shape, measured verbatim from the real account's list (titles here are fake).
function sessionItem(id, i) {
  return {
    ctime: 1791116000 + i, mtime: 1791116800 + i, is_read: i % 2, session_type: 1, status: 3,
    session_id: id, title: `stub conversation ${i}`, download_list: i === 0 ? [{ data_url: 'https://example.invalid/f', message_id: 'm1' }] : [],
  };
}
const FIXTURE_SESSIONS = Array.from({ length: 3 }, (_, i) => sessionItem(`f${i}`.padEnd(40, 'x'), i + 1));
const allocatedChats = [];

const hits = { alloc: 0, modelList: 0, sendmsg: 0, sse: 0, probe: 0, points: 0, sessions: 0, homenew: 0, taskComplete: 0, rewardClaim: 0, getapi: 0, seed: 0, getqrcode: 0, qrimg: 0, unicast: 0, bdusslogin: 0, stoken: 0, senddpass: 0, login: 0, captcha: 0 };
// Guard totals never reset, so the "are we really stubbed" assertions survive the suite.
const totals = { ...hits };
const seen = { cookies: [], userAgents: [], sendBodies: [], sseBodies: [], stokenBodies: [], claimBodies: [], rewardBodies: [] };
// What the real bdusslogin plants: a 192-char BDUSS and a 32-char PTOKEN. The scanned ticket is
// only 32 chars, so a flow that mistakes the ticket for the BDUSS is caught by these lengths.
const STUB_COOKIE_BDUSS = 'B'.repeat(192);
const STUB_COOKIE_PTOKEN = 'T'.repeat(32);
const STUB_QR_TICKET = 'v'.repeat(32);
const MODE_DEFAULT = {
  failSse: null,
  failSendmsg: null,
  failAlloc: null,
  dropContent: false,
  probeLoginRequired: false,
  pointsLoginRequired: false,
  sessionLoginRequired: false,
  // Login stub scripts: the QR poll answers from qrScript in order, so a test can drive
  // pending → scanned → confirmed deterministically.
  qrScript: [],
  smsNeedCaptcha: false,
  smsSendFail: false,
  smsBadCode: false,
  stokenRefuse: false,
  bdussloginRefuse: false,
  bdussloginHtml: false,
  // How many leading QR-image fetches answer 200 with an empty body (0 = always a real PNG).
  qrimgEmptyTimes: 0,
  // Drained-account legs: the SSE commercial pair, and a zeroed token bucket on the balance read.
  sseDrained: false,
  pointsZero: false,
  pointsNoList: false,
  // Free-point legs: which tasks homenew lists, and whether claiming is refused.
  freePointTasks: null,
  claimRefuse: false,
  claimReward: 50,
  // Measured on the user's main account: a proxied conversation does not always make daily_chat
  // claimable. Without this leg the earn step looked infallible.
  freePointChatNeverCounts: false,
  freePointChatReportRefuse: false,
};
const mode = { ...MODE_DEFAULT };

// Verbatim from the measured getgfvipremain response: four buckets, `token` is fractional,
// and only `token` is what inference actually drains.
const VIP_REMAIN = {
  isVip: false,
  isExpire: false,
  isTrial: false,
  vipType: 0,
  vipEndTime: '0',
  busAllLeftPoint: '',
  list: [
    { assetType: 1, assetName: 'token', totalPoint: '2567.39', bonusPoint: '2567.39', vipPoint: '0', chargePoint: '0', freezePoint: '0' },
    { assetType: 2, assetName: 'duration', totalPoint: '7200', bonusPoint: '0', vipPoint: '0', chargePoint: '0', freezePoint: '0' },
    { assetType: 3, assetName: 'scheduled_task', totalPoint: '2', bonusPoint: '0', vipPoint: '0', chargePoint: '0', freezePoint: '0' },
    { assetType: 4, assetName: 'realtime_t', totalPoint: '0', bonusPoint: '0', vipPoint: '0', chargePoint: '0', freezePoint: '0' },
  ],
};

// Capability table copied from the measured model/list response. A stub that is more capable
// than the real upstream turns offline green into a false green.
const MODEL_LIST = {
  model_list: [
    { id: '1', model_name: 'auto', display_name: 'Auto', description: '', cost_ratio: '', vip_type: 0 },
    { id: '5', model_name: 'gateway-glm-5.3-flash', display_name: 'GLM-5.3-Flash', description: '', cost_ratio: '0.07x', vip_type: 0 },
    { id: '6', model_name: 'glm-5.3', display_name: 'GLM-5.3', description: '会员优先', cost_ratio: '0.77x', vip_type: 1 },
    // Real upstream id contains a slash — the stub must not be simpler than reality.
    { id: '13', model_name: 'ali-minimax/minimax-m3', display_name: 'MiniMax-M3', description: '', cost_ratio: '0.35x', vip_type: 0 },
  ],
  // Upstream really returns string ids and marks the default inside the description.
  think_list: [
    { id: '1', think_name: '低', description: '快速问答' },
    { id: '2', think_name: '中', description: '一般性任务' },
    { id: '3', think_name: '高', description: '专业办公场景（默认）' },
    { id: '4', think_name: '极高', description: '高度复杂任务、中大型任务' },
  ],
  // Upstream sends both defaults as strings, keyed to model_list[].id / think_list[].id.
  default_model_id: '5',
  default_think_id: '3',
};

function sseFrames(res, body) {
  const rid = body.reply_id;
  const sid = body.session_id;
  const f = (id, obj) => res.write(`id: ${id}\ndata: ${JSON.stringify(obj)}\n\n`);
  if (mode.sseDrained) {
    // Verbatim from a real drained account: no text frames at all, just the commercial notice
    // pair and TURN_DONE. Returning an empty 200 here is the bug this suite now guards.
    f('1791157794990-0', { type: 'USER_QUERY', msg_id: 'm1', data: { client_added: '{}' } });
    f('1791157794991-0', {
      type: 'COMMERCIAL_NOTICE', msg_id: 'm1', data_from: 'commercial',
      data: { reason: 'insufficient_balance', reply_id: rid, session_id: sid, text: '积分不足，无法继续任务。' },
    });
    f('1791157794993-0', {
      type: 'COMMERCIAL', msg_id: 'm1', data_from: 'commercial',
      data: { errno: 11002, reason: 'insufficient_balance', reply_id: rid, session_id: sid, uk: 'fixture-upstream-user' },
    });
    f('1791157794994-0', { type: 'TURN_DONE', data: { reply_id: rid, session_id: sid } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  f('1791080803013-0', { type: 'USER_QUERY', msg_id: 'm1', data: { client_added: '{}' } });
  f('1791080803013-1', { type: 'REPLY_START', data: { reply_id: rid, session_id: sid } });
  f('1791080803013-2', {
    type: 'HINT_BLOCK',
    data: { block_id: 'b0', hint: '<system-reminder>\n<workspace-root>/app/workspace/SECRETPATH/sessions/1</workspace-root>\n</system-reminder>', reply_id: rid },
  });
  f('1791080803013-3', { type: 'THINKING_BLOCK_DELTA', data: { delta: 'thinking…', reply_id: rid } });
  f('1791080803013-4', { type: 'TEXT_BLOCK_START', data: { block_id: 'b1', reply_id: rid } });
  if (!mode.dropContent) {
    f('1791080803013-5', { type: 'TEXT_BLOCK_DELTA', data: { block_id: 'b1', delta: 'he', reply_id: rid } });
    f('1791080803013-6', { type: 'TEXT_BLOCK_DELTA', data: { block_id: 'b1', delta: 'llo', reply_id: rid } });
  }
  f('1791080803013-7', { type: 'TEXT_BLOCK_END', data: { block_id: 'b1', reply_id: rid } });
  f('1791080803013-8', {
    type: 'MODEL_CALL_END',
    data: {
      reply_id: rid, model_name: body.model_name, input_tokens: 30102, output_tokens: 9,
      reasoning_tokens: 4, cache_read_tokens: 29824, cache_input_tokens: 29824, cache_write_tokens: 0,
      cache_creation_input_tokens: 0, finish_reasons: ['stop'], finished_reason: 'completed',
      completion_status: 'ok', usage_status: 'reported',
    },
  });
  f('1791080803013-9', { type: 'ACTUAL_POINT', data: { consume_points: 0.01, reply_id: rid, session_id: sid } });
  f('1791080803013-10', { type: 'TURN_DONE', data: { reply_id: rid, session_id: sid } });
  res.write('data: [DONE]\n\n');
  res.end();
}

const stub = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  // Passport posts urlencoded forms, kuku posts JSON — a strict JSON.parse here would crash the
  // stub on the login legs and look like a product failure.
  let body = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
  }
  seen.cookies.push(req.headers.cookie ?? '');
  seen.userAgents.push(req.headers['user-agent'] ?? '');

  const ok = (data) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: { code: 0, msg: 'success', sLogid: '999' }, data }));
  };
  const bump = (k) => { hits[k]++; totals[k]++; };

  if (url.pathname === '/wenchain/genflow/idallochstr') {
    bump('alloc');
    if (mode.failAlloc) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 21004, msg: '鉴权不通过，请升级最新版本' } }));
    }
    // The stub remembers the sessions it handed out, so the "created by this pool" flag is
    // testable against something real rather than a hardcoded id.
    if (hits.alloc % 2 === 1) allocatedChats.push(`chat-${hits.alloc}`);
    return ok({ chat_id: `chat-${hits.alloc}`, query_id: `q-${hits.alloc}` });
  }
  if (url.pathname === '/wenchain/genflowpro/model/list') {
    bump('modelList');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: { code: 0, msg: 'success', sLogid: '1' }, data: MODEL_LIST }));
  }
  if (url.pathname === '/wenchain/genflowpro/sendmsg') {
    bump('sendmsg');
    seen.sendBodies.push(body);
    if (mode.failSendmsg === 'auth') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 200001, msg: 'uid unavailable: user not login' } }));
    }
    if (mode.failSendmsg === 'param') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 118, msg: 'invalid param' } }));
    }
    if (mode.failSendmsg === 'business') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 21004, msg: '登录态失效' } }));
    }
    return ok({ session_id: body.session_id, reply_id: body.reply_id, traceparent: '00-x-x-01' });
  }
  if (url.pathname === '/wenchain/genflowpro/sse/getchatcontent') {
    bump('sse');
    seen.sseBodies.push(body);
    if (mode.failSse === 'business') {
      // Measured shape: business failure on the SSE route still arrives as JSON with HTTP 200.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: { code: 402, msg: '积分不足' } }));
    }
    if (mode.failSse === 'http500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('boom');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    return sseFrames(res, body);
  }
  if (url.pathname === '/api/genflowpro/settings/profile') {
    bump('profile');
    const bduss = /BDUSS=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    if (!profileIdentities.has(bduss)) profileIdentities.set(bduss, String(profileIdentities.size + 1));
    return ok({ uk: profileIdentities.get(bduss) });
  }
  if (url.pathname === '/wenchain/genflowpro/clientmessage/list') {
    bump('probe');
    if (mode.probeLoginRequired) {
      // Measured shape for a dead credential: HTTP 200 with business code 1000004 "not login".
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 1000004, msg: 'not login' } }));
    }
    return ok({ list: [], next_cursor: 0, has_more: false });
  }
  if (url.pathname === '/bizapi/gfpro/getgfvipremain') {
    bump('points');
    if (mode.pointsLoginRequired) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { code: 200001, msg: 'user not login' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    if (mode.pointsNoList) {
      // A degraded-but-successful read: status.code 0 with the asset list missing entirely.
      const { list, ...rest } = VIP_REMAIN;
      return res.end(JSON.stringify({ status: { code: 0, msg: 'success' }, data: rest }));
    }
    if (mode.pointsZero) {
      // What a freshly scanned account really answers: every bucket zero, errno-less, no message.
      const zeroed = { ...VIP_REMAIN, list: VIP_REMAIN.list.map((x) => ({ ...x, totalPoint: '0', bonusPoint: '0' })) };
      return res.end(JSON.stringify({ status: { code: 0, msg: 'success' }, data: zeroed }));
    }
    return res.end(JSON.stringify({ status: { code: 0, msg: 'success' }, data: VIP_REMAIN }));
  }
  // ---- free-point tasks (homenew is a read, taskComplete is a write on the account) ----
  if (url.pathname === '/api/genflowpro/freepoint/homenew') {
    bump('homenew');
    const task = (key, type, status, reward, claimable) => ({
      claimable_point: claimable, max_reward_point: reward, single_reward_point: reward,
      task_key: key, task_name: key, task_status: status, task_type: type,
    });
    const reported = (type) => seen.claimBodies.some((b) => new URLSearchParams(b).get('task_type') === type);
    const paid = (key) => seen.rewardBodies.some((b) => new URLSearchParams(b).get('task_key') === key);
    const tasks = mode.freePointTasks ?? [
      // The client must report CHAT after a successful turn; sendmsg alone does not earn it.
      // Finished rewards are no longer claimable, so a second run cannot spend another turn.
      task('daily_login', 'LOGIN', paid('daily_login') ? 'FINISHED' : 'UNFINISHED',
        50, !paid('daily_login') && reported('LOGIN') ? 50 : 0),
      task('daily_chat', 'CHAT', paid('daily_chat') ? 'FINISHED' : 'UNFINISHED',
        50, !paid('daily_chat') && reported('CHAT') && hits.sse > 0 && !mode.freePointChatNeverCounts && !mode.freePointChatReportRefuse ? 50 : 0),
    ];
    const data = { activities: [{ activity_key: 'genflow_free_points', activity_name: '免费领积分', period_no: 4, tabs: [{ tab_key: 'daily', tab_name: '每日免费领', tasks }] }] };
    res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
    return res.end(JSON.stringify({ errno: 0, show_msg: '', data }));
  }
  if (url.pathname === '/api/genflowpro/freepoint/taskComplete') {
    bump('taskComplete');
    seen.claimBodies.push(raw.replace(/^\s+/, ''));
    // Measured: taskComplete only *reports* progress. It answers SUCCESS with reward_point 0 and
    // leaves the task claimable — treating it as the claim is the mistake this leg pins down.
    const fam = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      return res.end(JSON.stringify(obj));
    };
    if (mode.claimRefuse) return fam({ errno: 1, show_msg: '上报失败' });
    const form = new URLSearchParams(raw.replace(/^\s+/, ''));
    if (form.get('task_type') === 'CHAT' && mode.freePointChatReportRefuse) return fam({ errno: 0, data: { complete_status: 'FAILED', reward_point: 0 } });
    return fam({ errno: 0, show_msg: '', data: { complete_status: 'SUCCESS', reward_point: 0, task_type: form.get('task_type') } });
  }
  if (url.pathname === '/api/genflowpro/freepoint/rewardClaim') {
    bump('rewardClaim');
    seen.rewardBodies.push(raw.replace(/^\s+/, ''));
    const fam = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      return res.end(JSON.stringify(obj));
    };
    if (mode.claimRefuse) return fam({ errno: 1, show_msg: '领取失败' });
    const form = new URLSearchParams(raw.replace(/^\s+/, ''));
    return fam({ errno: 0, show_msg: '', data: { claim_status: 'SUCCESS', claimed_point: mode.claimReward ?? 50, task_key: form.get('task_key') } });
  }
  if (url.pathname === '/api/genflowpro/workspace/getsessionlist') {
    bump('sessions');
    // Measured: this family answers with `errno` and no `status` block at all.
    if (mode.sessionLoginRequired) {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      return res.end(JSON.stringify({ data: {}, errno: -6, newno: '', request_id: 1, server_time: 1791116830, show_msg: '未登录' }));
    }
    const offset = body?.offset ?? 0;
    const size = body?.size ?? 20;
    const all = [...allocatedChats.map((id) => sessionItem(id, 0)), ...FIXTURE_SESSIONS];
    res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
    return res.end(JSON.stringify({
      data: { list: all.slice(offset, offset + size), total: all.length, offset, size },
      errno: 0, newno: '', request_id: 2, server_time: 1791116830, show_msg: '',
    }));
  }
  // ---- passport stub (login-to-add-account) ----
  // Shapes are the measured ones; docs/API.md §14 records which leg each line stands for.
  // `?getapi` / `?login` arrive with the verb in the QUERY, so the pathname alone is '/v2/api/'.
  const pjam = (obj) => {
    const cb = url.searchParams.get('callback');
    res.writeHead(200, { 'content-type': 'application/javascript; charset=UTF-8' });
    res.end(cb ? `${cb}(${JSON.stringify(obj)})` : JSON.stringify(obj));
  };
  const PNG1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  if (url.pathname === '/' ) {
    // The device-cookie seeding hop; passport plants BAIDUID here and getapi insists on seeing it.
    bump('seed');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['BAIDUID=STUBBAIDUID:fg=1; Path=/; Domain=.baidu.com'] });
    return res.end('<html>stub</html>');
  }
  if (url.pathname === '/v2/api/' && url.search.includes('getapi')) {
    bump('getapi');
    return pjam({ errInfo: { no: '0' }, data: { token: 'ab12cd34ef56ab78cd90ef12ab34cd56', cookie: '1', spLogin: 'rate', disable: '' } });
  }
  if (url.pathname === '/v2/api/' && url.search.includes('login')) {
    bump('login');
    const body2 = JSON.parse(JSON.stringify(body ?? {}));
    if (mode.smsBadCode) return pjam({ errInfo: { no: '400056' }, data: { codeString: 'vcstub', msg: '验证码错误' } });
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=UTF-8',
      'set-cookie': ['BDUSS=STUBBDUSSVALUE-abcdefghijklmnop; Path=/; Domain=.baidu.com', 'PTOKEN=STUBPTOKENVALUE-abcdefghijklmnop; Path=/; Domain=.baidu.com'],
    });
    return res.end(`${url.searchParams.get('callback') ?? 'cb'}(${JSON.stringify({ errInfo: { no: '0' }, data: { u: body2.u ?? '' } })})`);
  }
  if (url.pathname === '/v2/api/getqrcode') {
    bump('getqrcode');
    return pjam({ errno: 0, imgurl: `127.0.0.1:${stub.address().port}/v2/api/qrcode?sign=stub-sign`, sign: 'stub-sign', prompt: '登录后某应用将获得百度账号的公开信息' });
  }
  if (url.pathname === '/v2/api/qrcode') {
    bump('qrimg');
    // Measured against the real passport: the image fetched right after getqrcode can answer
    // 200 with a zero-length body, and the same sign serves a real PNG a moment later.
    if (mode.qrimgEmptyTimes > 0) {
      mode.qrimgEmptyTimes -= 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end('');
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG1PX);
  }
  if (url.pathname === '/cgi-bin/genimage') {
    bump('captcha');
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(PNG1PX);
  }
  if (url.pathname === '/channel/unicast') {
    bump('unicast');
    const step = mode.qrScript.shift() ?? { errno: 1 };
    return pjam(step);
  }
  if (url.pathname === '/v2/api/bdusslogin') {
    bump('bdusslogin');
    const ticket = url.searchParams.get('bduss');
    if (!ticket) return pjam({ errno: 1 });
    if (mode.bdussloginHtml) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html>not found</html>');
    }
    // Measured against the real passport: a refusal carries errno (a fake ticket answers
    // {"errno":-9999}) while SUCCESS answers {data, errInfo} with no errno at all, and the real
    // BDUSS (192 chars) + PTOKEN (32) arrive as cookies — the scanned `v` is only a 32-char ticket.
    if (mode.bdussloginRefuse) return pjam({ errno: -9999 });
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=UTF-8',
      'set-cookie': [
        `BDUSS=${STUB_COOKIE_BDUSS}; Path=/; Domain=.baidu.com`,
        `PTOKEN=${STUB_COOKIE_PTOKEN}; Path=/; Domain=.baidu.com`,
        `STOKEN=${'S'.repeat(64)}; Path=/; Domain=.baidu.com`,
      ],
    });
    return res.end(`${url.searchParams.get('callback') ?? 'cb'}(${JSON.stringify({ data: { u: url.searchParams.get('u') ?? '' }, errInfo: { errno: 0, msg: '' } })})`);
  }
  if (url.pathname === '/v3/login/api/auth') {
    bump('stoken');
    const form = new URLSearchParams(raw.replace(/^\s+/, ''));
    seen.stokenBodies.push({ bduss: form.get('bduss') ?? '', ptoken: form.get('ptoken') ?? '', sig: form.get('sig') ?? '' });
    if (mode.stokenRefuse) return pjam({ errno: 2, errmsg: 'Auth Login Params Not Corret' });
    // The real passport refuses a bare bduss+ptoken form with 110003; only the engine-signed
    // body works, so the stub enforces the same contract shape.
    const expected = ['appid', 'bduss', 'ptoken', 'return_type', 'tpl', 'tpl_list', 'sig'];
    const signed = expected.every((k) => form.get(k)) && /^[0-9a-f]{32}$/.test(form.get('sig'));
    if (!signed) return pjam({ errno: 4, errmsg: 'unknow error(110003)' });
    return pjam({ errno: 0, errmsg: '', stoken_list: { genflowpro: `STUBSTOKEN${form.get('ptoken').slice(0, 6)}` } });
  }
  if (url.pathname === '/v2/api/senddpass') {
    bump('senddpass');
    if (mode.smsNeedCaptcha && !url.searchParams.get('vcodestr')) {
      return pjam({ errno: 19, msg: '请输入验证码', data: { vcodestr: 'vcstub', vcodesign: 'vcsign' } });
    }
    if (mode.smsSendFail) return pjam({ errno: 27, msg: '该手机号未注册' });
    return pjam({ errno: 0, msg: '', data: {} });
  }
  res.writeHead(404);
  res.end('{}');
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubAddr = stub.address().port;
process.env.KUKU_BASE_URL = `${BASE}:${stubAddr}`;
process.env.PASSPORT_BASE_URL = `${BASE}:${stubAddr}`;

const { KukuAccount, UpstreamError, parseSseBlock, cmpFrameId } = await import('../src/upstream.mjs');
const { Pool, frameToDelta, MODEL_INDEX, flattenTasks, accountSessionKey } = await import('../src/gateway.mjs');
const { handleChat, createApp } = await import('../src/server.mjs');
const { loginAuthBody } = await import('../src/passport.mjs');

let passed = 0;
const failures = [];
async function t(name, fn) {
  reset();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push([name, e.message]);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function reset() {
  for (const k of Object.keys(hits)) hits[k] = 0;
  seen.sendBodies = []; seen.sseBodies = []; seen.stokenBodies = []; seen.claimBodies = []; seen.rewardBodies = []; // cookies/userAgents stay cumulative for the end-of-suite guard
  // Restoring every flag at once: a test that fails halfway used to leave the stub poisoned
  // for the next one, which reads as a product regression.
  Object.assign(mode, MODE_DEFAULT);
}

const FAKE_BDUSS = 'Z'.repeat(192);
const FAKE_STOKEN = 'Y'.repeat(64);
const ACCT = { id: 'stub-0', alias: 'stub', priority: 0, bduss: FAKE_BDUSS, stoken: FAKE_STOKEN };

function mkPool(n) {
  const p = new Pool(Array.from({ length: n }, (_, i) => ({ ...ACCT, id: `a${i}`, priority: i })), { cooldownMs: 60_000 });
  for (const a of p.accounts) a.deviceId = 'dev-stub';
  return p;
}

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    parts: [],
    get body() { return this.parts.join(''); },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h); },
    setHeader(k, v) { this.headers[k] = v; },
    write(s) { this.parts.push(s); },
    end(s) { if (s) this.parts.push(s); },
  };
}
function mockReq(headers = {}, url = '/v1/chat/completions', method = 'POST', body = null) {
  return {
    headers,
    url,
    method,
    async *[Symbol.asyncIterator]() {
      // The route reads the body off the stream, so the harness must feed it the same way.
      if (body != null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
}
async function callChat(p, body, headers = {}) {
  const res = mockRes();
  await handleChat(p, mockReq(headers), res, body);
  return res;
}

console.log('\n== SSE frame parsing ==');
await t('data/event/id captured', () => {
  const f = parseSseBlock('event: foo\nid: 1791080803013-7\ndata: {"type":"X","a":1}');
  assert.equal(f.event, 'foo');
  assert.equal(f.id, '1791080803013-7');
  assert.equal(f.data.type, 'X');
});
await t('[DONE] becomes event done', () => assert.equal(parseSseBlock('data: [DONE]').event, 'done'));
await t('garbage data line yields null, not a throw', () => assert.equal(parseSseBlock('data: ~~~'), null));
await t('cmpFrameId orders across digit counts', () => {
  assert.ok(cmpFrameId('1791080803013-9', '1791080803013-10') < 0);
  assert.ok(cmpFrameId('999-0', '1000-0') < 0);
});

console.log('\n== event -> OpenAI delta mapping ==');
await t('TEXT_BLOCK_DELTA -> content', () => assert.deepEqual(frameToDelta({ data: { type: 'TEXT_BLOCK_DELTA', data: { delta: 'hi' } } }), { content: 'hi' }));
await t('THINKING_BLOCK_DELTA -> reasoning_content only', () => {
  const d = frameToDelta({ data: { type: 'THINKING_BLOCK_DELTA', data: { delta: 'hmm' } } });
  assert.equal(d.reasoning_content, 'hmm');
  assert.equal(d.content, undefined);
});
await t('HINT_BLOCK yields nothing (internal system-reminder must stay internal)', () => {
  assert.equal(frameToDelta({ data: { type: 'HINT_BLOCK', data: { hint: '<system-reminder>SECRET</system-reminder>' } } }), null);
});
await t('MODEL_CALL_END -> real usage, not an estimate', () => {
  const d = frameToDelta({ data: { type: 'MODEL_CALL_END', data: { input_tokens: 30102, output_tokens: 9, reasoning_tokens: 4, cache_read_tokens: 29824, finished_reason: 'completed', finish_reasons: ['stop'] } } });
  assert.equal(d.usage.prompt_tokens, 30102);
  assert.equal(d.usage.completion_tokens, 9);
  assert.equal(d.usage.total_tokens, 30111);
  assert.equal(d.usage.reasoning_tokens, 4);
  assert.equal(d.finish_reason, 'stop');
});
await t('ACTUAL_POINT -> consume_points', () => assert.equal(frameToDelta({ data: { type: 'ACTUAL_POINT', data: { consume_points: 0.96 } } }).consume_points, 0.96));
await t('COMMERCIAL_NOTICE/COMMERCIAL -> commercial, never a silent empty turn', () => {
  const notice = frameToDelta({ data: { type: 'COMMERCIAL_NOTICE', data: { reason: 'insufficient_balance', text: '积分不足，无法继续任务。' } } });
  assert.equal(notice.commercial.reason, 'insufficient_balance');
  assert.equal(notice.commercial.text, '积分不足，无法继续任务。');
  const com = frameToDelta({ data: { type: 'COMMERCIAL', data: { errno: 11002, reason: 'insufficient_balance' } } });
  assert.equal(com.commercial.errno, 11002);
});
await t('control events yield no delta', () => {
  for (const ty of ['USER_QUERY', 'REPLY_START', 'REPLY_END', 'TURN_DONE', 'SUG', 'FINISH', 'SESSION_TITLE', 'TEXT_BLOCK_START', 'TEXT_BLOCK_END', 'MODEL_CALL_START']) {
    assert.equal(frameToDelta({ data: { type: ty, data: {} } }), null, ty);
  }
});

console.log('\n== upstream contract handling ==');
await t('cookie is exactly BDUSS/STOKEN/gfprotpl, whitespace stripped', () => {
  const a = new KukuAccount({ bduss: `  ${FAKE_BDUSS}\n`, stoken: FAKE_STOKEN });
  assert.equal(a.headers().Cookie, `BDUSS=${FAKE_BDUSS}; STOKEN=${FAKE_STOKEN}; gfprotpl=genflowpro`);
});
await t('HTTP 200 + business code raises UpstreamError(code, network=false)', async () => {
  mode.failAlloc = true;
  await assert.rejects(new KukuAccount(ACCT).allocateIds(), (e) => e instanceof UpstreamError && e.code === 21004 && e.network === false);
});
await t('JSON business failure on the SSE route is detected', async () => {
  mode.failSse = 'business';
  const it = new KukuAccount(ACCT).sse({ text: 'x', session_id: 's', reply_id: 'r', client_session_id: 'c', device_id: 'd', model_name: 'm', model_display_name: 'M', think_mode: 3 });
  await assert.rejects(it.next(), (e) => e instanceof UpstreamError && e.code === 402);
});
await t('http 500 on sse raises non-network error', async () => {
  mode.failSse = 'http500';
  const it = new KukuAccount(ACCT).sse({ text: 'x', session_id: 's', reply_id: 'r', client_session_id: 'c', device_id: 'd', model_name: 'm', model_display_name: 'M', think_mode: 3 });
  await assert.rejects(it.next(), (e) => e instanceof UpstreamError && e.status === 500 && !e.network);
});

console.log('\n== pool scheduling and gates ==');
await t('lowest priority drained completely, not round-robined', () => {
  const p = mkPool(3);
  for (let i = 0; i < 5; i++) assert.equal(p.pick().id, 'a0');
});
await t('cooldown moves to next account, expiry releases it', () => {
  const p = mkPool(2);
  p.cool(p.accounts[0]);
  assert.equal(p.pick().id, 'a1');
  p.accounts[0].cooldown_until = 0;
  assert.equal(p.pick().id, 'a0');
});
await t('missing priority does not become highest priority', () => {
  const bare = { ...ACCT, id: 'noprio' }; delete bare.priority;
  const p = new Pool([bare, { ...ACCT, id: 'zero', priority: 0 }]);
  assert.equal(p.accounts[0].id, 'zero');
  assert.equal(p.accounts.find((a) => a.id === 'noprio').priority, 9999);
});
await t('client-directed account cannot bypass disabled', () => {
  const p = mkPool(2);
  p.accounts[0].disabled = true;
  assert.throws(() => p.resolve('a0'), (e) => e.status === 409);
});
await t('client-directed account cannot bypass cooldown', () => {
  const p = mkPool(2);
  p.cool(p.accounts[0]);
  assert.throws(() => p.resolve('a0'), (e) => e.status === 409);
});
await t('allowUnavailable may reach a cooled account (admin only)', () => {
  const p = mkPool(2);
  p.cool(p.accounts[0]);
  assert.equal(p.resolve('a0', { allowUnavailable: true }).id, 'a0');
});
await t('unknown account is 404, not silent fallback', () => {
  const p = mkPool(1);
  assert.throws(() => p.resolve('nope'), (e) => e.status === 404);
});
await t('http 400 is a client param error, network fault is not', () => {
  const p = mkPool(1);
  assert.equal(p.isClientParamError(new UpstreamError('bad', { status: 400 })), true);
  assert.equal(p.isClientParamError(new UpstreamError('net', { network: true })), false);
});

console.log('\n== session state ==');
await t('only the newest user turn goes on the wire', async () => {
  const p = mkPool(1);
  let out = '';
  await p.chat({ account: p.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'r1' }, { role: 'user', content: 'second' }] }, (d) => (out += d.content ?? ''));
  assert.equal(seen.sendBodies[0].data.text, 'second');
  assert.ok(!seen.sendBodies[0].data.text.includes('first'));
  assert.equal(out, 'hello');
});
await t('session_id stable across turns, reply_id fresh each turn', async () => {
  const p = mkPool(1);
  const a = p.pick();
  const m = (t) => [{ role: 'user', content: t }];
  const r1 = await p.chat({ account: a, model: { id: 'gateway-glm-5.3-flash' }, messages: m('hello'), sessionKey: 'k1' });
  const r2 = await p.chat({ account: a, model: { id: 'gateway-glm-5.3-flash' }, messages: m('again'), sessionKey: 'k1' });
  assert.equal(r1.session_id, r2.session_id);
  assert.notEqual(r1.reply_id, r2.reply_id);
  assert.equal(hits.alloc, 3);
});
await t('turn 2 does not carry turn 1 resume cursor', async () => {
  const p = mkPool(1);
  const a = p.pick();
  const m = (t) => [{ role: 'user', content: t }];
  await p.chat({ account: a, model: { id: 'gateway-glm-5.3-flash' }, messages: m('a'), sessionKey: 'k9' });
  await p.chat({ account: a, model: { id: 'gateway-glm-5.3-flash' }, messages: m('b'), sessionKey: 'k9' });
  assert.equal(seen.sseBodies[1].msg_id, undefined);
});
await t('content-less turn resolves without crashing', async () => {
  mode.dropContent = true;
  const p = mkPool(1);
  const r = await p.chat({ account: p.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, '');
  assert.equal(r.usage.prompt_tokens, 30102);
});

console.log('\n== http surface ==');
await t('non-stream default; content excludes hint and thinking; usage upstream', async () => {
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  const j = JSON.parse(res.body);
  assert.equal(j.choices[0].message.content, 'hello');
  assert.ok(!res.body.includes('system-reminder'));
  assert.ok(!res.body.includes('SECRETPATH'));
  assert.ok(!res.body.includes('thinking'));
  assert.equal(j.usage.prompt_tokens, 30102);
  assert.equal(j.kuku.consume_points, 0.01);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
});
await t('stream emits deltas then stop then [DONE]', async () => {
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(res.headers['content-type'].includes('text/event-stream'));
  assert.ok(res.body.endsWith('data: [DONE]\n\n'));
  assert.ok(/"reasoning_content":"thinking…"/.test(res.body));
  assert.ok(/"finish_reason":"stop"/.test(res.body));
  assert.ok(!res.body.includes('SECRETPATH'));
});
await t('stream_options.include_usage adds a usage frame', async () => {
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(/"usage":\{.*"prompt_tokens":30102/.test(res.body));
});
await t('business failure cools the account and retries the next', async () => {
  mode.failSendmsg = 'business';
  const p = mkPool(2);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(p.accounts[0].cooldown_until > Date.now(), 'deterministic failure must cool the account');
  assert.equal(res.statusCode, 200);
});
await t('http 400 cools nothing and returns 400', async () => {
  mode.failSendmsg = 'param';
  const p = mkPool(2);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(p.accounts.every((a) => a.cooldown_until === 0), 'caller error must not punish the pool');
  assert.equal(res.statusCode, 400);
});
await t('credentials never appear in the client-facing error', async () => {
  mode.failSendmsg = 'business';
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!res.body.includes(FAKE_BDUSS));
  assert.ok(!res.body.includes(FAKE_STOKEN));
});
await t('missing messages is a 400', async () => {
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash' });
  assert.equal(res.statusCode, 400);
});

console.log('\n== liveness probe ==');
await t('probe succeeds on a live account and clears auth_dead', async () => {
  const p = mkPool(1);
  p.accounts[0].auth_dead = true;
  const [r] = await p.healthCheck();
  assert.equal(r.ok, true);
  assert.equal(p.accounts[0].auth_dead, false);
});
await t('probe maps not-login to auth_dead and keeps it out of rotation', async () => {
  mode.probeLoginRequired = true;
  const p = mkPool(2);
  const results = await p.healthCheck({ only: 'a0' });
  assert.equal(results.length, 1, 'only the named account should be probed');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].code, 1000004);
  assert.equal(p.accounts[0].auth_dead, true);
  assert.equal(p.accounts[1].auth_dead, false, 'sick-list scoping must not condemn bystanders');
  assert.equal(p.pick().id, 'a1', 'auth-dead account must not be picked');
});
await t('sendmsg login rejection classifies as auth failure', () => {
  const p = mkPool(1);
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: 1000004 })), true);
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: 200001 })), true);
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: -6 })), true, 'the /api/genflowpro family says not-login as errno -6');
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: -7 })), true);
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: 3 })), false, 'RISK_REJECTED is not a logout');
  assert.equal(p.isAuthFailure(new UpstreamError('x', { code: 402 })), false);
});
await t('unreachable link does not condemn an account', async () => {
  process.env.KUKU_BASE_URL = 'http://127.0.0.1:1';
  try {
    const p = mkPool(1);
    const [r] = await p.healthCheck();
    assert.equal(r.ok, false);
    assert.equal(r.unreachable, true);
    assert.equal(p.accounts[0].cooldown_until, 0, 'network jitter must not cool anyone');
    assert.equal(p.accounts[0].auth_dead, false);
  } finally {
    process.env.KUKU_BASE_URL = `${BASE}:${stubAddr}`;
  }
});
await t('auth failure during a turn marks the account dead and fails over', async () => {
  mode.failSendmsg = 'auth';
  const p = mkPool(2);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(p.accounts[0].auth_dead, true);
  assert.equal(res.statusCode, 200, 'second account served it');
});

console.log('\n== points balance ==');
await t('GET /pool/points reports the token bucket as the balance, not a sum of buckets', async () => {
  const p = mkPool(1);
  reset();
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/pool/points', 'GET'), res);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.accounts.length, 1);
  const a = j.accounts[0];
  assert.equal(a.ok, true);
  assert.equal(a.balance_points, 2567.39, 'assetType 1 (token) is the spendable balance, fractional precision preserved');
  assert.equal(a.duration_points, 7200, 'duration is a separate quota, not money');
  assert.equal(a.assets.length, 4);
  assert.deepEqual(a.assets.map((x) => x.asset_name), ['token', 'duration', 'scheduled_task', 'realtime_t'], 'upstream bucket names pass through');
  assert.equal(j.total_balance_points, 2567.39, 'pool total must ignore non-token buckets');
});
await t('a dead credential on the balance route marks auth_dead without cooling', async () => {
  mode.pointsLoginRequired = true;
  const p = mkPool(2);
  const results = await p.points({ only: 'a0' });
  assert.equal(results.length, 1, 'only= must scope the upstream calls');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].code, 200001, 'this family says not-login as 200001, not 1000004');
  assert.equal(p.accounts[0].auth_dead, true);
  assert.ok(p.accounts[0].cooldown_until - Date.now() > 50_000 && p.accounts[0].cooldown_until - Date.now() <= p.authCooldownMs,
    'a dead login takes the long auth cooldown window, not the short failure one');
  assert.equal(p.accounts[1].auth_dead, false);
  mode.pointsLoginRequired = false;
});
await t('inference never spends a call on the balance endpoint', async () => {
  const p = mkPool(1);
  reset();
  await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(hits.points, 0, 'balance must stay off the hot path');
});
await t('link failure on the balance route does not condemn the account', async () => {
  process.env.KUKU_BASE_URL = 'http://127.0.0.1:1';
  try {
    const p = mkPool(1);
    const [r] = await p.points();
    assert.equal(r.ok, false);
    assert.equal(r.unreachable, true);
    assert.equal(p.accounts[0].auth_dead, false, 'jitter is not a logout');
    assert.equal(p.accounts[0].cooldown_until, 0);
  } finally {
    process.env.KUKU_BASE_URL = `${BASE}:${stubAddr}`;
  }
});

console.log('\n== upstream conversation list ==');
await t('the errno envelope family is parsed as success, not failure', async () => {
  const p = mkPool(1);
  reset();
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [], ledger: null })(mockReq({}, '/pool/sessions', 'GET'), res);
  assert.equal(res.statusCode, 200);
  const a = JSON.parse(res.body).accounts[0];
  assert.equal(a.ok, true, 'a response with errno:0 and no status block must count as success');
  // The stub is shared across the suite, so assert shape and self-consistency, not a fixed count.
  assert.ok(a.total >= 3, `expected at least the 3 fixture sessions, got ${a.total}`);
  assert.equal(a.sessions.length, Math.min(a.size, a.total));
  const s = a.sessions[0];
  assert.equal(typeof s.title, 'string', 'titles pass through');
  assert.equal(typeof s.is_read, 'boolean', 'upstream sends 0/1, we normalise');
  assert.equal(typeof s.session_id, 'string');
  assert.equal(s.status, 3);
  assert.ok(a.sessions.some((x) => x.artifact_count === 1), 'download_list should reduce to a count');
  assert.ok(!JSON.stringify(a.sessions).includes('data_url'), 'expiring artifact URLs must not be echoed');
});
await t('offset and size are forwarded upstream', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/pool/sessions?offset=1&size=2', 'GET'), res);
  const a = JSON.parse(res.body).accounts[0];
  assert.deepEqual([a.offset, a.size], [1, 2], 'the page window must be echoed from upstream');
  assert.equal(a.sessions.length, 2, 'and actually applied');
  assert.ok(a.total > 2, 'paging only means something over a longer list');
});
await t('sessions this proxy created are flagged as continuable', async () => {
  const p = mkPool(1);
  reset();
  await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'make a session' }] });
  const made = [...p.sessions.values()].map((s) => s.session_id);
  assert.ok(made.length >= 1, 'the chat should have opened an upstream session');
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/pool/sessions', 'GET'), res);
  const list = JSON.parse(res.body).accounts[0].sessions;
  const flagged = list.filter((s) => s.created_by_this_pool).map((s) => s.session_id);
  assert.ok(flagged.length >= 1, 'our own session must be recognisable in the list');
  assert.ok(made.some((id) => flagged.includes(id)), 'the flagged id must be the one we opened');
  assert.ok(list.some((s) => !s.created_by_this_pool), 'client-side sessions must be visibly marked non-continuable');
});
await t('errno -6 on this family is a logout, and it condemns the account', async () => {
  mode.sessionLoginRequired = true;
  const p = mkPool(1);
  const [r] = await p.sessionList();
  assert.equal(r.ok, false);
  assert.equal(r.code, -6, 'measured: /api/genflowpro/* says not-login as errno -6, not 1000004/200001');
  assert.equal(p.accounts[0].auth_dead, true);
  mode.sessionLoginRequired = false;
});

console.log('\n== per-request kuku metadata ==');
await t('non-stream exposes session_id and reply_id for the console', async () => {
  const p = mkPool(1);
  const res = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  const j = JSON.parse(res.body);
  assert.match(j.kuku.session_id, /^chat-/);
  assert.match(j.kuku.reply_id, /^q-/);
  assert.equal(j.kuku.account, 'a0');
});
await t('stream omits the kuku frame unless kuku_meta is requested', async () => {
  const p = mkPool(1);
  const plain = await callChat(p, { model: 'gateway-glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!/"kuku":/.test(plain.body), 'default stream must stay pure OpenAI shaped');
  const meta = await callChat(p, { model: 'gateway-glm-5.3-flash', stream: true, kuku_meta: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.match(meta.body, /"kuku":\{.*"consume_points":0\.01/);
  assert.ok(meta.body.endsWith('data: [DONE]\n\n'), 'kuku frame must come before [DONE]');
});

console.log('\n== model index resolution ==');
await t('cold index refreshes instead of dropping the requested model', async () => {
  const p = mkPool(1);
  MODEL_INDEX.clear();
  reset();
  await p.chat({ account: p.pick(), model: { id: 'glm-5.3' }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(hits.modelList, 1, 'an unindexed model id must trigger one catalog refresh');
  assert.equal(seen.sendBodies[0].data.model_name, 'glm-5.3', 'requested model must survive a cold index');
  assert.equal(seen.sendBodies[0].data.model_display_name, 'GLM-5.3', 'display_name comes from the catalog, not the id');
  assert.equal(seen.sseBodies[0].model_name, 'glm-5.3');
});
await t('unknown model id is sent verbatim rather than as undefined', async () => {
  const p = mkPool(1);
  reset();
  await p.chat({ account: p.pick(), model: { id: 'no-such-model' }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seen.sendBodies[0].data.model_name, 'no-such-model');
  assert.equal(seen.sendBodies[0].data.model_display_name, 'no-such-model');
  assert.equal(hits.modelList, 0, 'a second miss must not re-fetch the catalog on every request');
});
await t('a typo at the route is a 400 that costs the account nothing', async () => {
  const p = mkPool(1);
  reset();
  const before = p.accounts[0].cooldown_until;
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/v1/chat/completions', 'POST', { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'model_not_found');
  assert.equal(hits.sendmsg, 0, 'must never spend an upstream turn on a name we know is bad');
  assert.equal(hits.alloc, 0, 'id allocation is an upstream call too');
  assert.equal(p.accounts[0].cooldown_until, before, 'a client typo must not cool the account');
  const r2 = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/v1/responses', 'POST', { model: 'no-such-model', input: 'x' }), r2);
  assert.equal(r2.statusCode, 400, 'Responses must reject the same way');
});
await t('an empty catalog fails open rather than 400-ing every request', async () => {
  const p = mkPool(1);
  MODEL_INDEX.clear();
  reset();
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/v1/chat/completions', 'POST', { model: 'anything', messages: [{ role: 'user', content: 'x' }] }), res);
  assert.equal(res.statusCode, 200, 'model/list being down must not block inference');
  assert.ok(hits.sendmsg > 0);
});

console.log('\n== drained account (COMMERCIAL/insufficient_balance) ==');
await t('a drained account is a 402 with a code, not an empty 200', async () => {
  const p = mkPool(1);
  reset();
  mode.sseDrained = true;
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(
    mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }),
    res,
  );
  assert.equal(res.statusCode, 402, JSON.stringify(JSON.parse(res.body)));
  const err = JSON.parse(res.body).error;
  assert.equal(err.code, 'insufficient_balance');
  assert.match(err.message, /积分不足/);
  assert.ok(p.accounts[0].balance_dead_until > Date.now(), 'the account must leave rotation');
  assert.equal(p.accounts[0].cooldown_until, 0, 'a drained account is not "cooling", it is empty');
  assert.ok(p.accounts[0].balance_dead_until - Date.now() <= 10 * 60_000, 'and it must retry on a window, not latch forever');
});
await t('a drained first account fails over to the next one', async () => {
  const p = mkPool(2);
  reset();
  mode.sseDrained = true;
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(
    mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }),
    res,
  );
  // Every account answers drained, so the caller still gets the 402 — but both were tried.
  assert.equal(res.statusCode, 402);
  assert.equal(p.accounts.filter((a) => a.balance_dead_until > Date.now()).length, 2, 'both accounts must be marked, not just the first');
  assert.ok(hits.sendmsg >= 2, 'the turn must be retried on the next account');
});
await t('Responses surfaces the same 402 instead of an empty output', async () => {
  const p = mkPool(1);
  reset();
  mode.sseDrained = true;
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'x' }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(JSON.parse(res.body).error.code, 'insufficient_balance');
});
await t('a balance read repairs the flag in both directions', async () => {
  const p = mkPool(1);
  reset();
  mode.pointsZero = true;
  const zero = await p.points({});
  assert.equal(zero[0].balance_points, 0);
  assert.ok(p.accounts[0].balance_dead_until > Date.now(), 'a zero token bucket must take the account out of rotation');
  assert.equal(p.pick(), null, 'nothing left to serve with');
  mode.pointsZero = false;
  const full = await p.points({});
  assert.ok(full[0].balance_points > 0);
  assert.equal(p.accounts[0].balance_dead_until, 0, 'refilled free points must rejoin rotation without a manual reset');
  assert.equal(p.pick().id, 'a0');
});
await t('a degraded balance read (no asset list) must not condemn the account', async () => {
  const p = mkPool(1);
  reset();
  mode.pointsNoList = true;
  const out = await p.points({});
  assert.equal(out[0].ok, true, 'upstream answered status.code 0, so the read itself succeeded');
  assert.equal(out[0].balance_points, 0);
  assert.equal(p.accounts[0].balance_dead_until, 0, 'an absent list is not evidence of an empty wallet');
  assert.equal(p.pick()?.id, 'a0', 'the account must stay in rotation');
});
await t('a streamed turn against a drained account must not be a silent empty 200', async () => {
  const p = mkPool(1);
  reset();
  mode.sseDrained = true;
  const res = mockRes();
  await handleChat(p, mockReq({ 'content-type': 'application/json' }), res, {
    model: 'gateway-glm-5.3-flash',
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
  });
  const body = res.parts.join('');
  // A stream that already sent a 200 header cannot turn into a 402, so the contract has to be
  // carried in-band: an SSE error frame naming the real reason. A bare [DONE] is the bug.
  assert.ok(/"error"/.test(body), `streamed drained turn produced nothing usable: status=${res.statusCode} body=${body.slice(0, 200)}`);
  assert.match(body, /积分不足|insufficient/);
});
await t('an all-drained pool keeps answering 402 on the second attempt', async () => {
  const p = mkPool(2);
  reset();
  mode.sseDrained = true;
  const app = createApp({ pool: p, apiKeys: [] });
  const first = mockRes();
  await app(mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }), first);
  assert.equal(first.statusCode, 402, JSON.stringify(JSON.parse(first.body || '{}')));
  const again = mockRes();
  await app(mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }), again);
  const err = JSON.parse(again.body).error;
  // Once every account is flagged, resolve() throws first: the contract must not degrade to 409.
  assert.equal(err.code, 'insufficient_balance', `second attempt changed contract: ${JSON.stringify(err)}`);
});
await t('the balance window expires on its own so a provisioning hiccup heals', async () => {
  // Measured upstream behaviour: a brand-new STOKEN can answer 11002 and then work minutes later.
  const p = new Pool([ACCT], { balanceRetryMs: 30 });
  reset();
  p.markBalanceDead(p.accounts[0]);
  assert.equal(p.pick(), null, 'marked, so out of rotation');
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(p.pick()?.id, 'stub-0', 'and back in rotation once the window passes, no operator action');
});

await t('a refused login is sticky: later polls do not re-run the passport exchange', async () => {
  const p = mkPool(1);
  // adminApp() closes over createFileStore, which is initialised further down the module; these
  // two cases never add an account, so a store-less app is both legal and hoisting-safe.
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', deviceId: 'dev-stub' });
  reset();
  mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) },
    // the channel keeps answering confirmed while the UI keeps polling
    { errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) },
    { errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) }];
  mode.stokenRefuse = true;
  const s = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const poll = () => call(app, 'GET', `/pool/admin/login/qr/${s.json.login_id}`, null, { authorization: 'Bearer adm' });
  const first = await poll();
  assert.equal(first.json.state, 'failed');
  const exchanges = hits.stoken;
  const second = await poll();
  const third = await poll();
  assert.equal(second.json.state, 'failed');
  assert.equal(third.json.state, 'failed');
  assert.equal(hits.stoken, exchanges, 'a second poll must not mint a second exchange');
  assert.equal(hits.bdusslogin, 1, 'nor a second bdusslogin');
  assert.equal(second.json.reason, first.json.reason, 'the stated failure is replayed verbatim');
});
await t('an unparsed bdusslogin body is a refusal, not a silent success', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', deviceId: 'dev-stub' });
  reset();
  mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) }];
  mode.bdussloginHtml = true;
  mode.stokenRefuse = true; // would be refused anyway; the point is it must never be reached
  const s = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const r = await call(app, 'GET', `/pool/admin/login/qr/${s.json.login_id}`, null, { authorization: 'Bearer adm' });
  assert.equal(r.json.state, 'failed', JSON.stringify(r.json));
  assert.match(r.json.reason, /no PTOKEN|bdusslogin returned no usable/, 'the missing cookies must be named');
  assert.equal(hits.stoken, 0, 'a page that never logged in may not reach the exchange');
  assert.ok(!JSON.stringify(r.json).includes(STUB_COOKIE_BDUSS), 'no credential may appear in a failure');
  assert.equal(p.accounts.length, 1);
});

await t('a transiently empty QR image is retried instead of handed to the UI as a blank box', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', deviceId: 'dev-stub' });
  reset();
  mode.qrimgEmptyTimes = 2; // the two measured blips, then a real PNG
  const s = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const png = await call(app, 'GET', s.json.image_path, null, { authorization: 'Bearer adm' });
  assert.equal(png.res.statusCode, 200);
  const bytes = Buffer.concat(png.res.parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)))));
  assert.ok(bytes.length > 0, 'the caller must never be handed a zero-length image');
  assert.equal(hits.qrimg, 3, 'two retries plus the success');
});
await t('a QR image that never fills in is a stated failure, not an empty 200', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', deviceId: 'dev-stub' });
  reset();
  mode.qrimgEmptyTimes = 99;
  const s = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const png = await call(app, 'GET', s.json.image_path, null, { authorization: 'Bearer adm' });
  assert.equal(png.res.statusCode, 502, `expected a stated failure, got ${png.res.statusCode}`);
  assert.match(JSON.stringify(png.json), /empty/);
});

await t('an account whose chat task refuses to count says so instead of failing silently', async () => {
  // Real case: kuku-0 held four proxied conversations over ~1h45m and daily_chat stayed
  // UNFINISHED / claimable 0 — the desktop client's own UI showed 未完成 too.
  const p = mkPool(1);
  reset();
  mode.freePointChatNeverCounts = true;
  const out = await p.claimFreePoints({ runChat: true });
  assert.equal(out[0].chat_turn.ran, true, 'the turn was really spent');
  assert.deepEqual(out[0].claimed.map((c) => c.task_type), ['LOGIN'], 'the login pays; the chat still does not');
  assert.equal(out[0].points_earned, 50);
  assert.deepEqual(out[0].reported, ['LOGIN', 'CHAT']);
  assert.match(out[0].notes.join(' '), /上游仍未/);
});

console.log('\n== think_mode wire type ==');
await t('string think_mode from the catalog is sent as a number', async () => {
  const p = mkPool(1);
  await p.chat({ account: p.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'x' }], think_mode: '4' });
  assert.equal(typeof seen.sendBodies[0].data.think_mode, 'number');
  assert.equal(seen.sendBodies[0].data.think_mode, 4);
  assert.equal(typeof seen.sseBodies[0].think_mode, 'number');
});
await t('omitted think_mode falls back to the upstream default marker, not a hardcoded 3', async () => {
  const p = mkPool(1);
  await p.chat({ account: p.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seen.sendBodies[0].data.think_mode, 3);
});
await t('think_mode from the HTTP body reaches the wire on both calls', async () => {
  const p = mkPool(1);
  reset();
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(
    mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', think_mode: 2, messages: [{ role: 'user', content: 'x' }] }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(seen.sendBodies[0].data.think_mode, 2, 'the route must forward the body knob, not drop it');
  assert.equal(seen.sseBodies[0].think_mode, 2, 'the SSE poll must carry the same value sendmsg got');
});
await t('an out-of-range think_mode is refused at the route, not by upstream', async () => {
  const p = mkPool(1);
  reset();
  const before = p.accounts[0].cooldown_until;
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(
    mockReq({}, '/v1/chat/completions', 'POST', { model: 'gateway-glm-5.3-flash', think_mode: 99, messages: [{ role: 'user', content: 'x' }] }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'invalid_think_mode');
  assert.equal(hits.sendmsg, 0, 'measured: upstream runs and charges for think_mode=99 instead of rejecting it');
  assert.equal(p.accounts[0].cooldown_until, before);
});

console.log('\n== admin surface ==');
const { createFileStore } = await import('../src/store.mjs');
const os = await import('node:os');
const nodePath = await import('node:path');
const tmpStore = nodePath.join(os.tmpdir(), `kuku2api-test-${process.pid}.json`);

function adminApp(p, { adminToken = 'adm', apiKeys = [] } = {}) {
  const st = createFileStore(tmpStore);
  st.save({ default_device_id: 'dev-stub', accounts: toRecordsForStore(p.accounts) });
  return { app: createApp({ pool: p, apiKeys, adminToken, store: st, deviceId: 'dev-stub' }), st };
}
function toRecordsForStore(accounts) {
  return accounts.map((a) => ({ id: a.id, alias: a.alias, priority: a.priority, disabled: a.disabled, bduss: a.client.bduss, stoken: a.client.stoken }));
}
async function call(app, method, path, body, headers = {}) {
  const res = mockRes();
  const req = { headers, url: path, method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  await app(req, res);
  return { res, json: (() => { try { return JSON.parse(res.body); } catch { return null; } })() };
}

await t('reset-cooldown clears balance_dead and /pool/state reports it', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  p.accounts[0].balance_dead_until = Date.now() + 60_000;
  const st = await call(app, 'GET', '/pool/state', null, { authorization: 'Bearer adm' });
  assert.equal(st.json.accounts[0].balance_dead, true, 'the UI has to be able to see why an account is idle');
  const r = await call(app, 'POST', '/pool/admin/reset-cooldown', {}, { authorization: 'Bearer adm' });
  assert.equal(r.json.accounts[0].balance_dead, false);
});
await t('admin routes refuse anonymous even when no api key is configured', async () => {
  const { app } = adminApp(mkPool(1));
  const r = await call(app, 'GET', '/pool/admin/resequence', null);
  assert.equal(r.res.statusCode, 401);
});
await t('admin routes refuse the ordinary api key', async () => {
  const p = mkPool(1);
  const st = createFileStore(tmpStore);
  const app = createApp({ pool: p, apiKeys: ['user-key'], adminToken: 'adm', store: st, deviceId: 'dev-stub' });
  const r = await call(app, 'POST', '/pool/admin/reset-cooldown', {}, { authorization: 'Bearer user-key' });
  assert.equal(r.res.statusCode, 401);
});
await t('add then reorder then delete then resequence', async () => {
  const { app, st } = adminApp(mkPool(2));
  const add = await call(app, 'POST', '/pool/admin/accounts', { id: 'a2', alias: '三号', bduss: 'B'.repeat(100), stoken: 'S'.repeat(60), priority: 5 }, { authorization: 'Bearer adm' });
  assert.equal(add.res.statusCode, 201);
  assert.equal(add.json.accounts.length, 3);
  const dup = await call(app, 'POST', '/pool/admin/accounts', { id: 'a2', bduss: 'x', stoken: 'y' }, { authorization: 'Bearer adm' });
  assert.equal(dup.res.statusCode, 409);
  const patch = await call(app, 'PATCH', '/pool/admin/accounts/a2', { priority: 0 }, { authorization: 'Bearer adm' });
  assert.equal(patch.json.account.priority, 0);
  const del = await call(app, 'DELETE', '/pool/admin/accounts/a0', null, { authorization: 'Bearer adm' });
  assert.equal(del.json.gap, true, 'delete must report the priority gap it leaves');
  const rese = await call(app, 'POST', '/pool/admin/resequence', {}, { authorization: 'Bearer adm' });
  assert.deepEqual(rese.json.accounts.map((a) => a.priority), [0, 1], 'priorities closed to 0..N-1');
  const onDisk = st.load();
  assert.equal(onDisk.accounts.length, 2, 'store persisted the mutation');
});
await t('no admin response ever echoes credential material', async () => {
  const { app } = adminApp(mkPool(1));
  const add = await call(app, 'POST', '/pool/admin/accounts', { id: 'a9', bduss: 'SECRETBDUSSVALUE', stoken: 'SECRETTOKENVALUE', priority: 1 }, { authorization: 'Bearer adm' });
  assert.equal(add.res.statusCode, 201);
  assert.ok(!add.res.body.includes('SECRETBDUSSVALUE'));
  assert.ok(!add.res.body.includes('SECRETTOKENVALUE'));
  assert.equal(add.json.accounts.find((a) => a.id === 'a9').has_credential, true);
  const state = await call(app, 'GET', '/pool/state', null);
  assert.ok(!state.res.body.includes('SECRETBDUSSVALUE'));
});
await t('reset-cooldown clears both cooldown and auth_dead, scoped by id', async () => {
  const p = mkPool(3);
  const st = createFileStore(tmpStore);
  st.save({ default_device_id: 'dev-stub', accounts: toRecordsForStore(p.accounts) });
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', store: st, deviceId: 'dev-stub' });
  p.accounts[0].cooldown_until = Date.now() + 9000;
  p.accounts[0].auth_dead = true;
  p.accounts[1].cooldown_until = Date.now() + 9000;
  const r = await call(app, 'POST', '/pool/admin/reset-cooldown', { id: 'a0' }, { authorization: 'Bearer adm' });
  assert.equal(r.json.accounts[0].cooldown_remaining_ms, 0);
  assert.equal(r.json.accounts[0].auth_dead, false);
  assert.ok(r.json.accounts[1].cooldown_remaining_ms > 0, 'scoping must not clear bystanders');
});

console.log('\n== rotation, cold start, and restart continuity ==');
await t('PATCH rotates bduss/stoken in place and puts the account back in rotation', async () => {
  const p = mkPool(1);
  const { app, st } = adminApp(p);
  p.accounts[0].auth_dead = true;
  p.accounts[0].cooldown_until = Date.now() + 60_000;
  const r = await call(app, 'PATCH', '/pool/admin/accounts/a0', { bduss: 'N'.repeat(192), stoken: 'M'.repeat(64) }, { authorization: 'Bearer adm' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(p.accounts[0].client.bduss, 'N'.repeat(192));
  assert.equal(p.accounts[0].auth_dead, false, 'a fresh cookie means the login state is no longer dead');
  assert.equal(p.accounts[0].cooldown_until, 0, 'and it must re-enter rotation without waiting out the old cooldown');
  assert.equal(st.load().accounts[0].bduss, 'N'.repeat(192), 'the new credential must reach disk, not just memory');
  assert.ok(!r.res.body.includes('N'.repeat(20)), 'and must not be echoed back');
});
await t('rotating one half of the credential pair keeps the other half', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  const r = await call(app, 'PATCH', '/pool/admin/accounts/a0', { stoken: 'Q'.repeat(64) }, { authorization: 'Bearer adm' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(p.accounts[0].client.bduss, FAKE_BDUSS, 'a stoken-only rotation must not blank the bduss');
  assert.equal(p.accounts[0].client.stoken, 'Q'.repeat(64));
});
await t('a blank credential in PATCH is a 400 that changes nothing', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  const r = await call(app, 'PATCH', '/pool/admin/accounts/a0', { bduss: '   ' }, { authorization: 'Bearer adm' });
  assert.equal(r.res.statusCode, 400);
  assert.equal(p.accounts[0].client.bduss, FAKE_BDUSS, 'a rejected rotation must leave the working credential intact');
});
await t('concurrent cold-start catalog refreshes collapse into one upstream fetch', async () => {
  const p = mkPool(3);
  MODEL_INDEX.clear();
  reset();
  await Promise.all([1, 2, 3, 4, 5].map(() => p.refreshModelIndex(p.pick())));
  assert.equal(hits.modelList, 1, `5 concurrent refreshes must cost 1 fetch, got ${hits.modelList}`);
  assert.equal(MODEL_INDEX.size, 4, 'and the index must still end up populated');
});
await t('an unusable after cursor is a 400 carrying error.code', async () => {
  const ledgerStub = { list: () => [{ id: 'resp_known', session_key: 'k', created_at: 1, response: { id: 'resp_known', object: 'response', created_at: 1 } }] };
  const app = createApp({ pool: mkPool(1), apiKeys: [], ledger: ledgerStub });
  const bad = await call(app, 'GET', '/v1/responses?after=resp_gone', null);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.json.error.code, 'cursor_not_found', 'the UI must branch on a code, not on message text');
  const good = await call(app, 'GET', '/v1/responses?after=resp_known', null);
  assert.equal(good.res.statusCode, 200, 'a real cursor at the end of the list is not an error');
  assert.deepEqual(good.json.data, []);
  assert.equal(good.json.has_more, false);
});
console.log('\n== api key management ==');
await t('issued keys work without a restart, list without leaking, revoke on the next request', async () => {
  const fs = await import('node:fs');
  const { createKeyRing } = await import('../src/store.mjs');
  const file = nodePath.join(os.tmpdir(), `kuku2api-keys-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const ring = createKeyRing({ file, envKeys: ['env-key'] });
  const app = createApp({ pool: mkPool(1), adminToken: 'adm', keyRing: ring });
  assert.equal((await call(app, 'GET', '/v1/models', null)).res.statusCode, 401, 'a configured key ring must not be open');
  assert.equal((await call(app, 'GET', '/v1/models', null, { authorization: 'Bearer env-key' })).res.statusCode, 200);
  const a = await call(app, 'POST', '/pool/admin/keys', { label: 'frontend' }, { authorization: 'Bearer adm' });
  const b = await call(app, 'POST', '/pool/admin/keys', {}, { authorization: 'Bearer adm' });
  assert.equal(a.res.statusCode, 201);
  const secret = a.json.key.secret;
  assert.match(secret, /^sk-kuku-[0-9a-f]{32}$/, 'keys must look like keys');
  assert.equal((await call(app, 'GET', '/v1/models', null, { authorization: `Bearer ${secret}` })).res.statusCode, 200);
  const listed = await call(app, 'GET', '/pool/admin/keys', null, { authorization: 'Bearer adm' });
  assert.ok(!JSON.stringify(listed.json).includes(secret.slice(8)), 'the list is hints only; the secret is shown once');
  assert.equal(listed.json.keys.filter((k) => !k.from_env).length, 2);
  assert.equal((await call(app, 'DELETE', `/pool/admin/keys/${a.json.key.id}`, null, { authorization: 'Bearer adm' })).res.statusCode, 200);
  assert.equal((await call(app, 'GET', '/v1/models', null, { authorization: `Bearer ${secret}` })).res.statusCode, 401, 'revocation takes effect immediately');
  // the survivor must come back from disk in a fresh process
  const ring2 = createKeyRing({ file, envKeys: [] });
  assert.ok(ring2.ok(b.json.key.secret), 'issued keys are persisted');
  assert.ok(!ring2.ok(secret), 'and revoked keys stay revoked');
  fs.rmSync(file, { force: true });
});
await t('API_KEYS from the environment cannot be revoked through the admin api', async () => {
  const { createKeyRing } = await import('../src/store.mjs');
  const ring = createKeyRing({ envKeys: ['env-key'] });
  const app = createApp({ pool: mkPool(1), adminToken: 'adm', keyRing: ring });
  const listed = await call(app, 'GET', '/pool/admin/keys', null, { authorization: 'Bearer adm' });
  assert.equal(listed.json.keys[0].from_env, true);
  const del = await call(app, 'DELETE', '/pool/admin/keys/env-0', null, { authorization: 'Bearer adm' });
  assert.equal(del.res.statusCode, 400);
  assert.ok(ring.ok('env-key'), 'the operator config survives an admin-token mistake');
});

console.log('\n== 登录加号：扫码 / 短信 ==');
await t('a scanned QR becomes a pooled account without any cookie crossing the api', async () => {
  const p = mkPool(1);
  const { app, st } = adminApp(p);
  reset();
  mode.qrScript = [
    { errno: 1 },
    { errno: 0, channel_v: JSON.stringify({ status: '1' }) },
    { errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) },
  ];
  const anon = await call(app, 'POST', '/pool/admin/login/qr', {});
  assert.equal(anon.res.statusCode, 401, 'login routes are admin-only');
  const start = await call(app, 'POST', '/pool/admin/login/qr', { alias: '扫码来的' }, { authorization: 'Bearer adm' });
  assert.equal(start.res.statusCode, 201);
  const id = start.json.login_id;
  assert.equal(start.json.image_path, `/pool/admin/login/qr/${id}.png`);
  assert.ok(hits.getapi > 0 && hits.getqrcode > 0, 'the QR must be issued through the measured legs');
  const png = await call(app, 'GET', start.json.image_path, null, { authorization: 'Bearer adm' });
  assert.equal(png.res.statusCode, 200);
  assert.equal(png.res.headers['content-type'], 'image/png', 'the UI must be able to use a plain <img> on our own origin');
  const poll = () => call(app, 'GET', `/pool/admin/login/qr/${id}`, null, { authorization: 'Bearer adm' });
  assert.equal((await poll()).json.state, 'pending');
  assert.equal((await poll()).json.state, 'scanned', 'status 1 is "已扫码待确认"');
  const done = await poll();
  assert.equal(done.json.state, 'added', JSON.stringify(done.json));
  assert.equal(p.accounts.length, 2, 'the account must be in the pool by the time the poll says added');
  const [added] = p.accounts.filter((a) => a.id === done.json.account_id);
  assert.ok(added, 'account_id must name a real account');
  assert.equal(added.client.bduss, STUB_COOKIE_BDUSS, 'the account must carry the 192-char BDUSS bdusslogin planted, not the 32-char scan ticket');
  assert.equal(added.client.stoken, 'STUBSTOKENTTTTTT', 'stoken is minted from the ptoken the login handed back');
  assert.equal(seen.stokenBodies.length, 1);
  assert.equal(seen.stokenBodies[0].bduss, STUB_COOKIE_BDUSS, 'the exchange must be signed over the cookie BDUSS');
  assert.equal(seen.stokenBodies[0].ptoken, STUB_COOKIE_PTOKEN);
  assert.equal(added.alias, '扫码来的');
  assert.ok(hits.probe > 0, 'the fresh pair must be validated against 库库AI before it joins the pool');
  assert.ok(st.load().accounts.some((a) => a.id === added.id), 'persisted, not just in memory');
  const all = JSON.stringify([start.json, done.json]);
  assert.ok(!all.includes(STUB_COOKIE_BDUSS) && !all.includes(STUB_COOKIE_PTOKEN) && !all.includes('STUBSTOKEN'), 'no credential may appear in a login response');
  // A second poll of an already-added session is idempotent, not a second account.
  const again = await poll();
  assert.equal(again.json.state, 'added');
  assert.equal(p.accounts.length, 2);
});
await t('scanning the same user in a new QR session refuses duplication and replays the failure', async () => {
  const p = mkPool(0);
  const { app, st } = adminApp(p);
  reset();
  const headers = { authorization: 'Bearer adm' };
  const scan = async () => {
    mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) }];
    const s = await call(app, 'POST', '/pool/admin/login/qr', {}, headers);
    return { path: `/pool/admin/login/qr/${s.json.login_id}`, result: await call(app, 'GET', `/pool/admin/login/qr/${s.json.login_id}`, null, headers) };
  };
  const first = await scan();
  assert.equal(first.result.json.state, 'added');
  const second = await scan();
  assert.equal(second.result.json.state, 'failed');
  assert.equal(second.result.json.code, 'account_already_exists');
  assert.equal(second.result.json.account_id, first.result.json.account_id);
  const callsBefore = { ...hits };
  const replay = await call(app, 'GET', second.path, null, headers);
  assert.deepEqual(replay.json, second.result.json);
  assert.deepEqual(hits, callsBefore, 'terminal duplicate failure must not repeat upstream calls');
  assert.equal(p.accounts.length, 1);
  assert.equal(st.load().accounts.length, 1);
});
await t('loginAuthBody reproduces the engine-signed STOKEN exchange form', async () => {
  // Vectors measured by calling the real genflowengine.dll's
  // genflow_engine_get_login_auth_param on synthetic inputs; the same formula also matched the
  // captured real request's sig byte-for-byte. A bare bduss+ptoken form gets 110003 upstream.
  const v1 = loginAuthBody({ bduss: 'A'.repeat(192), ptoken: 'P'.repeat(64) });
  assert.equal(v1, 'appid=1&bduss=' + 'A'.repeat(192) + '&ptoken=' + 'P'.repeat(64) + '&return_type=1&tpl=genflowpro&tpl_list=genflowpro|netdisk&sig=9cf3a33e3b6f19324853970abf2d00a2');
  const v2 = loginAuthBody({ bduss: 'X'.repeat(192), ptoken: 'Y'.repeat(64) });
  assert.ok(v2.endsWith('&sig=a3d861ea0946b617a7235b6b36c65add'), 'sig must depend on both credentials');
});
await t('adding an account must not wipe the runtime state of the others', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  p.accounts[0].cooldown_until = Date.now() + 600_000;
  p.accounts[0].auth_dead = true;
  p.accounts[0].balance_dead_until = Date.now() + 600_000;
  const r = await call(app, 'POST', '/pool/admin/accounts', { id: 'a7', alias: '新加的', bduss: 'N'.repeat(192), stoken: 'M'.repeat(64) }, { authorization: 'Bearer adm' });
  assert.equal(r.res.statusCode, 201, JSON.stringify(r.json));
  const old = r.json.accounts.find((a) => a.id === 'a0');
  assert.equal(old.auth_dead, true, 'a new account must not launder a dead login state');
  assert.equal(old.balance_dead, true, 'nor a drained balance flag');
  assert.ok(old.cooldown_remaining_ms > 0, 'nor an active cooldown');
});
await t('a passport network blip on the unwrapped SMS legs answers 502 instead of killing the process', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  const started = await call(app, 'POST', '/pool/admin/login/sms', { phone: '13800000000' }, { authorization: 'Bearer adm' });
  assert.ok(started.json?.login_id, JSON.stringify(started.json));
  const saved = process.env.PASSPORT_BASE_URL;
  process.env.PASSPORT_BASE_URL = 'http://127.0.0.1:1';
  try {
    // resendSms has no try/catch of its own; the app-level guard is what keeps this in-process.
    const r = await call(app, 'POST', '/pool/admin/login/sms/resend', { login_id: started.json.login_id }, { authorization: 'Bearer adm' });
    assert.equal(r.res.statusCode, 502, `expected a 502, got ${r.res.statusCode} ${r.res.body}`);
    const v = await call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: started.json.login_id, code: '123456' }, { authorization: 'Bearer adm' });
    assert.equal(v.res.statusCode, 502, 'verify must survive the same blip');
  } finally {
    process.env.PASSPORT_BASE_URL = saved;
  }
  // The suite continuing past this point is itself the assertion that nothing rejected unhandled.
  const alive = await call(app, 'POST', '/pool/admin/login/sms', { phone: '13800000000' }, { authorization: 'Bearer adm' });
  assert.ok(alive.json?.login_id, 'the process must still serve afterwards');
});
await t('an expired QR and a refused stoken exchange both end in a stated failure', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '2' }) }];
  const s1 = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const e1 = await call(app, 'GET', `/pool/admin/login/qr/${s1.json.login_id}`, null, { authorization: 'Bearer adm' });
  assert.equal(e1.json.state, 'expired');
  assert.equal(p.accounts.length, 1, 'nothing may be added on an expired code');
  mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET, u: 'https://kuku.baidu.com' }) }];
  mode.stokenRefuse = true;
  const s2 = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const e2 = await call(app, 'GET', `/pool/admin/login/qr/${s2.json.login_id}`, null, { authorization: 'Bearer adm' });
  assert.equal(e2.json.state, 'failed', JSON.stringify(e2.json));
  assert.match(e2.json.reason, /stoken/i);
  // The failure must carry the non-secret diagnostics, or a real refusal is undiagnosable.
  assert.equal(e2.json.diag.bduss_len, 192, 'diag reports lengths, never values');
  assert.equal(e2.json.diag.ptoken_len, 32);
  assert.equal(e2.json.diag.unicast_fields, 'status,v,u');
  assert.ok(!JSON.stringify(e2.json).includes(STUB_COOKIE_BDUSS), 'diag must not leak the credential');
  assert.equal(p.accounts.length, 1, 'a refused exchange must not add anything');
  const unknown = await call(app, 'GET', '/pool/admin/login/qr/lq-nope', null, { authorization: 'Bearer adm' });
  assert.equal(unknown.res.statusCode, 404);
});
await t('a refused bdusslogin falls back to the ticket and says so in diag', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  mode.qrScript = [{ errno: 0, channel_v: JSON.stringify({ status: '0', v: STUB_QR_TICKET }) }];
  mode.bdussloginRefuse = true;
  mode.stokenRefuse = true;
  const s = await call(app, 'POST', '/pool/admin/login/qr', {}, { authorization: 'Bearer adm' });
  const r = await call(app, 'GET', `/pool/admin/login/qr/${s.json.login_id}`, null, { authorization: 'Bearer adm' });
  assert.equal(r.json.state, 'failed');
  assert.match(r.json.diag.bdusslogin, /errno -9999/, 'the refusal must be reported, not swallowed');
  assert.equal(r.json.diag.bduss_len, 32, 'with no cookie planted only the 32-char ticket remains');
  assert.equal(p.accounts.length, 1);
});
await t('sms login stops for a captcha, then lands the account on the typed code', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  mode.smsNeedCaptcha = true;
  const bad = await call(app, 'POST', '/pool/admin/login/sms', { phone: '12' }, { authorization: 'Bearer adm' });
  assert.equal(bad.res.statusCode, 502, 'a phone that is not digits must not even reach passport');
  const start = await call(app, 'POST', '/pool/admin/login/sms', { phone: '13800000000', alias: '短信来的' }, { authorization: 'Bearer adm' });
  assert.equal(start.json.state, 'captcha_required', JSON.stringify(start.json));
  assert.equal(start.json.captcha_path, `/pool/admin/login/sms/captcha/${start.json.login_id}`, 'the image must come from us: passport binds it to this process device cookie');
  const cap = await call(app, 'GET', start.json.captcha_path, null, { authorization: 'Bearer adm' });
  assert.equal(cap.res.statusCode, 200);
  assert.ok(cap.res.headers['content-type'].startsWith('image/'));
  const sent = await call(app, 'POST', '/pool/admin/login/sms/resend', { login_id: start.json.login_id, captcha: { vcodestr: 'vcstub', vcodesign: 'vcsign', code: '9x7q' } }, { authorization: 'Bearer adm' });
  assert.equal(sent.json.state, 'sent', JSON.stringify(sent.json));
  mode.smsBadCode = true;
  const wrong = await call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: start.json.login_id, code: '000000' }, { authorization: 'Bearer adm' });
  assert.equal(wrong.res.statusCode, 200, 'a rejected code is a 200 carrying a state, not an http error');
  assert.equal(wrong.json.state, 'captcha_required', 'a wrong code asks for a graphic captcha again');
  assert.match(wrong.json.message, /验证码/);
  mode.smsBadCode = false;
  const done = await call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: start.json.login_id, code: '123456' }, { authorization: 'Bearer adm' });
  assert.equal(done.json.state, 'added', JSON.stringify(done.json));
  const acct = p.accounts.find((a) => a.id === done.json.account_id);
  assert.equal(acct.client.bduss, 'STUBBDUSSVALUE-abcdefghijklmnop', 'the jar cookie is what becomes the account');
  assert.equal(acct.alias, '短信来的');
  assert.ok(!JSON.stringify(done.json).includes('STUBBDUSS'), 'verify must not echo credentials either');
  const beforeReplay = { ...hits };
  const again = await call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: start.json.login_id, code: '123456' }, { authorization: 'Bearer adm' });
  assert.equal(again.json.account_id, done.json.account_id);
  assert.deepEqual(hits, beforeReplay, 'a completed SMS verification is idempotent');
  mode.smsNeedCaptcha = false;
});

await t('two concurrent SMS confirmations for a duplicate user return one sticky refusal', async () => {
  const p = mkPool(0);
  const { app, st } = adminApp(p);
  reset();
  const headers = { authorization: 'Bearer adm' };
  const start = () => call(app, 'POST', '/pool/admin/login/sms', { phone: '13800000000' }, headers);
  const first = await start();
  const done = await call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: first.json.login_id, code: '123456' }, headers);
  assert.equal(done.json.state, 'added');
  const second = await start();
  const before = hits.login;
  const verify = () => call(app, 'POST', '/pool/admin/login/sms/verify', { login_id: second.json.login_id, code: '123456' }, headers);
  const [a, b] = await Promise.all([verify(), verify()]);
  assert.equal(a.json.state, 'failed');
  assert.equal(a.json.code, 'account_already_exists');
  assert.equal(a.json.account_id, done.json.account_id);
  assert.deepEqual(a.json, b.json);
  assert.equal(hits.login - before, 1);
  assert.deepEqual((await verify()).json, a.json);
  assert.equal(p.accounts.length, 1);
  assert.equal(st.load().accounts.length, 1);
});

await t('upstream sessions survive a process restart', async () => {
  const fs = await import('node:fs');
  const file = nodePath.join(os.tmpdir(), `kuku2api-sessions-${process.pid}-restart.json`);
  try {
    const p1 = new Pool([ACCT], { sessionStore: createFileStore(file) });
    reset();
    await p1.chat({ account: p1.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'hey' }], sessionKey: 'persist-me' });
    const first = p1.sessions.get(accountSessionKey(p1.pick().id, 'persist-me'));
    assert.ok(first?.session_id, 'the first process should hold an upstream session');
    await new Promise((r) => setTimeout(r, 700)); // the writer is debounced

    const p2 = new Pool([ACCT], { sessionStore: createFileStore(file) });
    assert.equal(p2.sessions.get(accountSessionKey(p2.pick().id, 'persist-me'))?.session_id, first.session_id, 'a restart must reuse the same upstream session_id');
    const before = totals.alloc;
    await p2.chat({ account: p2.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'and now?' }], sessionKey: 'persist-me' });
    assert.equal(totals.alloc - before, 1, 'a resumed session must allocate only a reply_id, not a brand new chat_id');
    // sendmsg carries session_id/client_session_id on the envelope, not inside data.
    const landed = seen.sendBodies.at(-1).session_id;
    assert.equal(landed, first.session_id, `the follow-up turn must land in the original upstream session, got ${landed}`);
    assert.equal(seen.sendBodies.at(-1).client_session_id, first.client_session_id, 'and reuse the same client_session_id');
  } finally {
    for (const f of [file, `${file}.bak`]) { try { fs.rmSync(f); } catch {} }
  }
});

await t('preflight answers with CORS headers and admin headers are allowed', async () => {
  const { app } = adminApp(mkPool(1));
  const res = mockRes();
  await app({ headers: { origin: 'http://localhost:5173' }, url: '/pool/admin/accounts', method: 'OPTIONS', async *[Symbol.asyncIterator]() {} }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.ok(res.headers['access-control-allow-headers'].includes('x-kuku-account'));
  assert.ok(res.headers['access-control-allow-headers'].includes('x-admin-token'));
  assert.match(res.headers['access-control-allow-methods'], /PATCH/);
});
await t('json and streamed responses both carry CORS', async () => {
  const p = mkPool(1);
  const plain = await callChat(p, { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.headers['access-control-allow-origin'], '*');
  const st = await callChat(p, { model: 'gateway-glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(st.headers['access-control-allow-origin'], '*');
});

console.log('\n== 免费积分：领取与每日定时 ==');
const { createAutoClaim } = await import('../src/scheduler.mjs');
const task = (key, type, status, reward, claimable) => ({
  claimable_point: claimable, max_reward_point: reward, single_reward_point: reward,
  task_key: key, task_name: key, task_status: status, task_type: type,
});
await t('flattenTasks unwinds activities -> tabs -> tasks and carries the claim pairing', () => {
  const flat = flattenTasks({ activities: [{ activity_key: 'genflow_free_points', period_no: 4, tabs: [{ tab_key: 'daily', tasks: [task('daily_login', 'LOGIN', 'FINISHED', 50, 0), task('daily_chat', 'CHAT', 'UNFINISHED', 50, 50)] }] }] });
  assert.equal(flat.length, 2);
  assert.deepEqual({ k: flat[0].task_key, c: flat[0].claimable_point, r: flat[0].reward_point }, { k: 'daily_login', c: 0, r: 50 });
  assert.equal(flat[1].claimable_point, 50, 'claimable_point is the only field that says "claim now"');
  assert.equal(flat[1].activity_key, 'genflow_free_points');
  assert.equal(flat[1].period_id, 4, 'rewardClaim needs period_id, which arrives as period_no');
  assert.deepEqual(flattenTasks({}), [], 'a missing payload must not throw');
});
await t('GET /pool/admin/claim reads the task list without spending or writing anything', async () => {
  const p = mkPool(1);
  const { app } = adminApp(p);
  reset();
  mode.freePointTasks = [task('daily_login', 'LOGIN', 'FINISHED', 50, 0), task('daily_chat', 'CHAT', 'UNFINISHED', 50, 50)];
  const r = await call(app, 'GET', '/pool/admin/claim', null, { authorization: 'Bearer adm' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json.accounts[0].ok, true);
  assert.equal(r.json.accounts[0].tasks.length, 2);
  assert.equal(hits.taskComplete, 0, 'a read must never report progress');
  assert.equal(hits.rewardClaim, 0, 'a read must never claim');
  assert.equal(hits.sendmsg, 0, 'a read must never spend a turn');
});
await t('claiming pays through rewardClaim, not taskComplete', async () => {
  const p = mkPool(1);
  reset();
  mode.freePointTasks = [task('daily_login', 'LOGIN', 'FINISHED', 50, 50), task('daily_chat', 'CHAT', 'UNFINISHED', 50, 0)];
  const out = await p.claimFreePoints({});
  assert.equal(out[0].ok, true);
  assert.equal(out[0].claimed.length, 1, 'only the claimable task is touched');
  assert.equal(out[0].claimed[0].task_key, 'daily_login');
  assert.equal(out[0].claimed[0].claimed_point, 50);
  assert.equal(out[0].claimed[0].claim_status, 'SUCCESS');
  assert.equal(out[0].points_earned, 50, 'points come from claimed_point, not reward_point');
  assert.equal(hits.rewardClaim, 1);
  assert.equal(hits.taskComplete, 0, 'taskComplete must not be used to claim: it answers SUCCESS with 0 points');
  const form = new URLSearchParams(seen.rewardBodies[0]);
  assert.equal(form.get('task_key'), 'daily_login');
  assert.equal(form.get('activity_key'), 'genflow_free_points');
  assert.equal(form.get('period_id'), '4');
  assert.equal(hits.sendmsg, 0, 'without runChat no turn may be spent');
});
await t('runChat reports the login, earns the chat task, then claims both', async () => {
  const p = mkPool(1);
  reset();
  const out = await p.claimFreePoints({ runChat: true });
  assert.deepEqual(out[0].reported, ['LOGIN', 'CHAT'], 'the client reports the completed conversation too');
  assert.equal(hits.taskComplete, 2);
  assert.deepEqual(seen.claimBodies.map((b) => new URLSearchParams(b).get('task_type')), ['LOGIN', 'CHAT']);
  assert.equal(new URLSearchParams(seen.claimBodies[1]).get('device_id'), 'dev-stub');
  assert.equal(hits.sendmsg, 1, 'exactly one earned conversation, no more');
  assert.equal(out[0].chat_turn.ran, true);
  assert.equal(out[0].claimed.length, 2);
  assert.deepEqual(out[0].claimed.map((c) => c.task_type), ['LOGIN', 'CHAT']);
  assert.equal(out[0].points_earned, 100);
  assert.equal(hits.rewardClaim, 2);
  assert.equal(out[0].tasks_after.find((t) => t.task_key === 'daily_login').task_status, 'FINISHED');
});
await t('a completed chat task is not earned or reported again', async () => {
  const p = mkPool(1);
  reset();
  mode.freePointTasks = [task('daily_chat', 'CHAT', 'FINISHED', 50, 0)];
  const out = await p.claimFreePoints({ runChat: true });
  assert.equal(out[0].ok, true);
  assert.equal(out[0].chat_turn, null);
  assert.equal(hits.sendmsg, 0);
  assert.equal(hits.taskComplete, 0);
  assert.equal(hits.rewardClaim, 0);
});
await t('rerunning a successful claim does not spend another turn', async () => {
  const p = mkPool(1);
  reset();
  const first = await p.claimFreePoints({ runChat: true });
  assert.equal(first[0].points_earned, 100);
  const second = await p.claimFreePoints({ runChat: true });
  assert.equal(second[0].points_earned, 0);
  assert.equal(second[0].chat_turn, null);
  assert.equal(hits.sendmsg, 1);
  assert.equal(hits.taskComplete, 2);
  assert.equal(hits.rewardClaim, 2);
});
await t('a failed conversation never reports CHAT completion', async () => {
  const p = mkPool(1);
  reset();
  mode.failSse = 'http500';
  const out = await p.claimFreePoints({ runChat: true });
  assert.equal(out[0].ok, false);
  assert.ok(seen.claimBodies.every((b) => new URLSearchParams(b).get('task_type') !== 'CHAT'));
});
await t('a refused CHAT report keeps its note and still claims the login reward', async () => {
  const p = mkPool(1);
  reset();
  mode.freePointChatReportRefuse = true;
  const out = await p.claimFreePoints({ runChat: true });
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[0].reported, ['LOGIN']);
  assert.deepEqual(out[0].claimed.map((c) => c.task_type), ['LOGIN']);
  assert.equal(out[0].points_earned, 50);
  assert.match(out[0].notes.join(' '), /上报.*FAILED/);
  assert.equal(hits.sendmsg, 1);
});
await t('ordinary inference never reports or claims free-point tasks', async () => {
  const p = mkPool(1);
  reset();
  await p.chat({ account: p.pick(), model: { id: 'gateway-glm-5.3-flash' }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(hits.taskComplete, 0);
  assert.equal(hits.rewardClaim, 0);
});
await t('a refused claim is reported per account and does not stop the others', async () => {
  const p = mkPool(2);
  reset();
  mode.freePointTasks = [task('daily_chat', 'CHAT', 'UNFINISHED', 50, 50)];
  mode.claimRefuse = true;
  const out = await p.claimFreePoints({});
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, false);
  assert.match(out[0].message, /领取失败|code=1/);
  assert.equal(out[1].ok, false, 'both accounts must report independently');
});
await t('the scheduler is off by default, claims once per day, and survives a restart', async () => {
  const p = mkPool(1);
  reset();
  mode.freePointTasks = [task('daily_chat', 'CHAT', 'UNFINISHED', 50, 50)];
  const file = nodePath.join(os.tmpdir(), `kuku-claim-${process.pid}.json`);
  const fs2 = await import('node:fs');
  fs2.rmSync(file, { force: true });
  try {
    // Fake clock so the daily rule is tested instead of depending on when the suite runs.
    let ts = new Date(2026, 9, 5, 3, 0, 0).getTime();
    const ac = createAutoClaim({ pool: p, file, now: () => ts });
    assert.equal(ac.state.enabled, false, 'default must be off: claiming writes to the user account');
    assert.equal(ac.state.next_run_at, null);
    ts = new Date(2026, 9, 5, 9, 0, 0).getTime();
    assert.equal(await ac.tick(), null, 'a disabled scheduler must never claim on a tick');
    assert.equal(hits.rewardClaim, 0);

    ac.configure({ enabled: true, hour: 9 });
    assert.equal(ac.state.enabled, true);
    assert.ok(ac.state.next_run_at >= ts, 'a due run is pending the next tick');

    ts = new Date(2026, 9, 5, 9, 30, 0).getTime();
    const first = await ac.tick();
    assert.equal(first.accounts[0].points_earned, 50);
    assert.equal(hits.rewardClaim, 1);

    ts = new Date(2026, 9, 5, 9, 45, 0).getTime();
    assert.equal(await ac.tick(), null, 'one claim per day, not one per tick');
    assert.equal(hits.rewardClaim, 1);

    ts = new Date(2026, 9, 6, 9, 5, 0).getTime();
    assert.equal((await ac.tick()).accounts[0].points_earned, 50);
    assert.equal(hits.rewardClaim, 2);

    const reloaded = createAutoClaim({ pool: p, file, now: () => ts });
    assert.equal(reloaded.state.enabled, true, 'the operator switch must survive a restart');
    assert.equal(reloaded.state.hour, 9);
    assert.equal(reloaded.state.last_result.accounts[0].points_earned, 50);
    // The settings file belongs to the scheduler: createFileStore.load() defaults to the account
    // store's shape, and merging that would write "accounts": [] into a settings file.
    const onDisk = JSON.parse(fs2.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), ['auto_claim'], 'settings.json must hold only auto_claim');
    ac.stop();
  } finally {
    fs2.rmSync(file, { force: true });
  }
});
await t('auto-claim routes expose and toggle the scheduler', async () => {
  const p = mkPool(1);
  reset();
  const file = nodePath.join(os.tmpdir(), `kuku-claim-route-${process.pid}.json`);
  const ac = createAutoClaim({ pool: p, file });
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', autoClaim: ac });
  const off = await call(app, 'GET', '/pool/admin/auto-claim', null, { authorization: 'Bearer adm' });
  assert.equal(off.json.enabled, false);
  const st = await call(app, 'GET', '/pool/state', null, { authorization: 'Bearer adm' });
  assert.equal(st.json.auto_claim.enabled, false, '/pool/state has to show it too');
  const on = await call(app, 'POST', '/pool/admin/auto-claim', { enabled: true, hour: 7 }, { authorization: 'Bearer adm' });
  assert.equal(on.json.auto_claim.enabled, true);
  assert.equal(on.json.auto_claim.hour, 7);
  const bad = await call(app, 'POST', '/pool/admin/auto-claim', { enabled: true, hour: 99 }, { authorization: 'Bearer adm' });
  assert.equal(bad.json.auto_claim.hour, 9, 'an out-of-range hour falls back to the default');
  const anon = await call(app, 'GET', '/pool/admin/auto-claim');
  assert.equal(anon.res.statusCode, 401, 'the scheduler is admin-only');
  ac.stop();
  const fs2 = await import('node:fs');
  fs2.rmSync(file, { force: true });
});

console.log('\n== Responses API ==');
const { createLedger } = await import('../src/ledger.mjs');
const ledgerFile = nodePath.join(os.tmpdir(), `kuku2api-ledger-${process.pid}.json`);
function respApp(p, opts = {}) {
  const ledger = createLedger(createFileStore(ledgerFile), { max: 10 });
  return createApp({ pool: p, apiKeys: [], adminToken: 'adm', store: null, deviceId: 'dev-stub', ledger, ...opts });
}
async function callResp(p, body, headers = {}, opts = {}) {
  const res = mockRes();
  const app = respApp(p, opts);
  await app(mockReq(headers, '/v1/responses', 'POST', body), res);
  return { res, json: (() => { try { return JSON.parse(res.body); } catch { return null; } })() };
}
const sseEvents = (body) =>
  body.split('\n\n').filter(Boolean).map((blk) => {
    const t = blk.split('\n').find((l) => l.startsWith('data: '));
    return t ? JSON.parse(t.slice(6)) : null;
  }).filter(Boolean);

await t('non-stream response object carries the contract fields', async () => {
  const p = mkPool(1);
  const { json: j } = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi' });
  assert.match(j.id, /^resp_[0-9a-f]{32}$/);
  assert.equal(j.object, 'response');
  assert.equal(j.status, 'completed');
  assert.equal(typeof j.created_at, 'number');
  assert.equal(j.error, null);
  assert.equal(j.incomplete_details, null);
  assert.equal(j.previous_response_id, null);
  assert.deepEqual(j.tools, []);
  assert.equal(j.tool_choice, 'auto');
  assert.equal(j.parallel_tool_calls, true);
  const msg = j.output.at(-1);
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.status, 'completed');
  assert.equal(msg.content[0].type, 'output_text');
  assert.equal(msg.content[0].text, 'hello');
  assert.deepEqual(msg.content[0].annotations, []);
  assert.equal(j.output_text, 'hello');
});
await t('usage uses Responses naming and carries cache details', async () => {
  const p = mkPool(1);
  const { json: j } = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi' });
  assert.equal(j.usage.input_tokens, 30102);
  assert.equal(j.usage.output_tokens, 9);
  assert.equal(j.usage.total_tokens, 30111);
  assert.equal(j.usage.input_tokens_details.cached_tokens, 29824);
  assert.equal(typeof j.usage.input_tokens_details.cache_write_tokens, 'number');
  assert.equal(j.usage.output_tokens_details.reasoning_tokens, 4);
});
await t('instructions are echoed back on the response object', async () => {
  const p = mkPool(1);
  const { json: j } = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', instructions: 'be terse' });
  assert.equal(j.instructions, 'be terse');
});
await t('input item array is accepted and the newest user turn is what goes upstream', async () => {
  const p = mkPool(1);
  await callResp(p, {
    model: 'gateway-glm-5.3-flash',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'earlier' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'prior answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'latest question' }] },
    ],
  });
  assert.equal(seen.sendBodies[0].data.text, 'latest question');
});
await t('empty input is a 400', async () => {
  const { res } = await callResp(mkPool(1), { model: 'gateway-glm-5.3-flash', input: [] });
  assert.equal(res.statusCode, 400);
});
await t('reasoning.effort maps onto upstream think_mode', async () => {
  const p = mkPool(1);
  await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', reasoning: { effort: 'xhigh' } });
  assert.equal(seen.sendBodies[0].data.think_mode, 4);
});
await t('flat reasoning_effort is honoured too, not only the nested object', async () => {
  const p = mkPool(1);
  await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', reasoning_effort: 'xhigh' });
  // 4, not the catalog default 3 — otherwise a dropped knob would still "pass".
  assert.equal(seen.sendBodies[0].data.think_mode, 4, 'OpenAI clients send this flat spelling as often as the object');
});
await t('an explicit think_mode wins over reasoning.effort', async () => {
  const p = mkPool(1);
  await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', think_mode: 1, reasoning: { effort: 'xhigh' } });
  assert.equal(seen.sendBodies[0].data.think_mode, 1, 'mixing both knobs must not be a coin flip');
});
// Measured against the real upstream: think_mode=99 is NOT rejected — the turn runs and the
// account is charged, so the caller can never tell the knob was ignored.
await t('an out-of-range think_mode is a 400 that spends no turn', async () => {
  const p = mkPool(1);
  reset();
  const { res } = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', think_mode: 99 });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'invalid_think_mode');
  assert.equal(hits.sendmsg, 0, 'must never burn an upstream turn on a knob we know is dead');
  const bad = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', reasoning: { effort: 'ultra' } });
  assert.equal(bad.res.statusCode, 400, 'an unmapped effort string is the same class of typo');
});
await t('think_mode is unchecked while the catalog is unreachable', async () => {
  const p = mkPool(1);
  MODEL_INDEX.clear();
  reset();
  const { res } = await callResp(p, { model: 'gateway-glm-5.3-flash', input: 'hi', think_mode: 99 });
  assert.equal(res.statusCode, 200, 'no catalog means we cannot know the valid set');
  assert.ok(hits.sendmsg > 0);
});
await t('unknown previous_response_id is 404, not a silent new session', async () => {
  const { res } = await callResp(mkPool(1), { model: 'gateway-glm-5.3-flash', input: 'hi', previous_response_id: 'resp_nope' });
  assert.equal(res.statusCode, 404);
});
await t('previous_response_id chains onto the same upstream session', async () => {
  const p = mkPool(1);
  const app = respApp(p); // one service process = one ledger; a fresh ledger per call would never resolve the id
  const send = async (body) => {
    const res = mockRes();
    await app(mockReq({}, '/v1/responses', 'POST', body), res);
    return JSON.parse(res.body);
  };
  const a = await send({ model: 'gateway-glm-5.3-flash', input: 'first' });
  const b = await send({ model: 'gateway-glm-5.3-flash', input: 'second', previous_response_id: a.id });
  assert.equal(b.previous_response_id, a.id);
  assert.equal(b.kuku.session_id, a.kuku.session_id, 'upstream session must be reused');
  assert.notEqual(b.id, a.id);
  assert.notEqual(b.kuku.reply_id, a.kuku.reply_id);
});
await t('GET /v1/responses/:id returns the stored Response', async () => {
  const p = mkPool(1);
  const app = respApp(p);
  const created = mockRes();
  await app(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'fetch me' }), created);
  const id = JSON.parse(created.body).id;
  const got = mockRes();
  await app(mockReq({}, `/v1/responses/${id}`, 'GET'), got);
  assert.equal(got.statusCode, 200);
  assert.equal(JSON.parse(got.body).output_text, 'hello');
});
await t('DELETE removes it and a later GET 404s', async () => {
  const p = mkPool(1);
  const app = respApp(p);
  const created = mockRes();
  await app(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'x' }), created);
  const id = JSON.parse(created.body).id;
  const del = mockRes();
  await app({ headers: {}, url: `/v1/responses/${id}`, method: 'DELETE', async *[Symbol.asyncIterator]() {} }, del);
  assert.equal(JSON.parse(del.body).deleted, true);
  const after = mockRes();
  await app(mockReq({}, `/v1/responses/${id}`, 'GET'), after);
  assert.equal(after.statusCode, 404);
});
await t('GET /v1/responses lists newest-first behind a cursor envelope', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', ledger: createLedger(null, { max: 10 }) });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = mockRes();
    await app(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: `q${i}` }), r);
    ids.push(JSON.parse(r.body).id);
  }
  const l = mockRes();
  await app(mockReq({}, '/v1/responses?limit=2', 'GET'), l);
  const j = JSON.parse(l.body);
  assert.equal(j.object, 'list');
  assert.deepEqual(j.data.map((x) => x.id), [ids[2], ids[1]], 'newest first, created_at ties must not flip the order');
  assert.equal(j.data[0].object, 'response', 'list items are full Response objects');
  assert.equal(j.first_id, ids[2]);
  assert.equal(j.last_id, ids[1]);
  assert.equal(j.has_more, true);
  const next = mockRes();
  await app(mockReq({}, `/v1/responses?limit=2&after=${ids[1]}`, 'GET'), next);
  const j2 = JSON.parse(next.body);
  assert.deepEqual(j2.data.map((x) => x.id), [ids[0]]);
  assert.equal(j2.has_more, false);
});
await t('response list filters by session_key so the UI can open one conversation', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', ledger: createLedger(null, { max: 10 }) });
  for (const key of ['conv-a', 'conv-a', 'conv-b']) {
    await app(mockReq({ 'x-kuku-session': key }, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'x' }), mockRes());
  }
  const res = mockRes();
  await app(mockReq({}, '/v1/responses?session_key=conv-a', 'GET'), res);
  const j = JSON.parse(res.body);
  assert.equal(j.data.length, 2, 'only conv-a turns');
  assert.equal(j.has_more, false);
  const all = mockRes();
  await app(mockReq({}, '/v1/responses', 'GET'), all);
  assert.equal(JSON.parse(all.body).data.length, 3, 'unfiltered list sees every session');
});
await t('unknown after cursor is a 400 instead of a silent empty page', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], ledger: createLedger(null, { max: 10 }) });
  const r = mockRes();
  await app(mockReq({}, '/v1/responses?after=resp_does_not_exist', 'GET'), r);
  assert.equal(r.statusCode, 400);
  assert.match(JSON.parse(r.body).error.message, /after/);
});
await t('store:false turns keep chaining but stay out of the list', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], ledger: createLedger(null, { max: 10 }) });
  const created = mockRes();
  await app(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'x', store: false }), created);
  const id = JSON.parse(created.body).id;
  assert.equal(JSON.parse(created.body).store, false);
  const listed = mockRes();
  await app(mockReq({}, '/v1/responses', 'GET'), listed);
  assert.deepEqual(JSON.parse(listed.body).data, [], 'store:false must not be listable');
  // previous_response_id still resolves through the ledger, so the record itself must survive.
  const chained = mockRes();
  await app(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'y', previous_response_id: id }), chained);
  assert.equal(chained.statusCode, 200);
});
await t('stream emits the contract event sequence with monotonic sequence_number', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await respApp(p)(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'hi', stream: true }), res);
  const evts = sseEvents(res.body);
  const types = evts.map((e) => e.type);
  assert.deepEqual(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  evts.forEach((e, i) => assert.equal(e.sequence_number, i, 'sequence_number increments from 0'));
  assert.ok(types.every((t) => t !== 'response.completed' || true));
  assert.equal(evts.at(-1).response.status, 'completed');
  assert.equal(evts.at(-1).response.output_text, 'hello');
});
await t('each SSE frame carries an event: line matching its data.type', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await respApp(p)(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'hi', stream: true }), res);
  for (const blk of res.body.split('\n\n').filter(Boolean)) {
    const evLine = blk.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = blk.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(evLine, 'frame missing event: line');
    assert.equal(evLine.slice(7).trim(), JSON.parse(dataLine.slice(6)).type);
  }
});
await t('streamed deltas concatenate to exactly the final output_text', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await respApp(p)(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'hi', stream: true }), res);
  const joined = sseEvents(res.body).filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  assert.equal(joined, 'hello');
  assert.equal(joined, sseEvents(res.body).at(-1).response.output_text);
});
await t('stream failure surfaces an error event and stops', async () => {
  mode.failSendmsg = 'business';
  const p = mkPool(1);
  const res = mockRes();
  await respApp(p)(mockReq({}, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'hi', stream: true }), res);
  const evts = sseEvents(res.body);
  assert.equal(evts.at(-1).type, 'error');
  assert.ok(!res.body.includes('gxNjREZlJmU2RQ'));
});
await t('concurrent turns on one session serialize instead of interleaving', async () => {
  let inflight = 0;
  let peak = 0;
  const realChat = Object.getPrototypeOf(mkPool(1)).recordedChat;
  const p = mkPool(1);
  const wrapped = async function (opts, onDelta, signal) {
    inflight++;
    peak = Math.max(peak, inflight);
    const r = await realChat.call(this, opts, onDelta, signal);
    inflight--;
    return r;
  };
  p.recordedChat = wrapped;
  const app = respApp(p);
  const mk = () => {
    const res = mockRes();
    return { res, run: app(mockReq({ 'x-kuku-session': 'same-key' }, '/v1/responses', 'POST', { model: 'gateway-glm-5.3-flash', input: 'hi' }), res) };
  };
  const a = mk();
  const b = mk();
  await Promise.all([a.run, b.run]);
  assert.equal(peak, 1, `two turns on one session overlapped (peak=${peak})`);
});

console.log('\n== /v1/models surface ==');
await t('models come from the upstream catalog with cost ratio and think list', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await createApp({ pool: p, apiKeys: [] })(mockReq({}, '/v1/models', 'GET'), res);
  const j = JSON.parse(res.body);
  assert.equal(j.data.length, 4);
  assert.equal(j.data[1].id, 'gateway-glm-5.3-flash');
  assert.equal(j.data[1].display_name, 'GLM-5.3-Flash', 'internal id is not a label the UI can show');
  assert.equal(j.data[1].cost_ratio, '0.07x');
  assert.equal(j.data[2].owned_by, 'kuku (vip)', 'vip-only model must be marked');
  assert.equal(j.data[3].id, 'ali-minimax/minimax-m3', 'upstream ids may contain a slash');
  assert.equal(j.data[3].display_name, 'MiniMax-M3');
  assert.equal(j.think_list[0].id, '1', 'think ids come from upstream verbatim');
  assert.equal(j.default_think_id, 3, 'default think resolved from the upstream id, coerced to a number');
  assert.equal(j.default_model, 'gateway-glm-5.3-flash', 'upstream numeric default must be resolved to a usable model_name');
});
await t('x-kuku-allow-unavailable needs the admin token, not just any api key', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: ['secret'], adminToken: 'adm' });
  p.accounts[0].disabled = true;
  const body = { model: 'gateway-glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] };
  const asUser = mockRes();
  await app(mockReq({ 'x-api-key': 'secret', 'x-kuku-allow-unavailable': '1' }, '/v1/chat/completions', 'POST', body), asUser);
  assert.equal(asUser.statusCode, 409, 'an ordinary key holder must not be able to route to a disabled account');
  assert.equal(hits.sendmsg, 0, 'and it must not spend a turn either');
  const asAdmin = mockRes();
  await app(mockReq({ 'x-api-key': 'secret', 'x-admin-token': 'adm', 'x-kuku-allow-unavailable': '1' }, '/v1/chat/completions', 'POST', body), asAdmin);
  assert.equal(asAdmin.statusCode, 200, 'the documented admin probe still works');
});

await t('a passport blip on an unwrapped admin route answers 502 instead of ending the process', async () => {
  // The route wrapper is the only thing between a rejected handler and an unhandled rejection,
  // which Node turns into a process exit — and a dead proxy takes the whole pool with it.
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [], adminToken: 'adm', deviceId: 'dev-stub' });
  reset();
  const saved = process.env.PASSPORT_BASE_URL;
  process.env.PASSPORT_BASE_URL = 'http://127.0.0.1:1';
  try {
    const r = mockRes();
    await app(mockReq({ authorization: 'Bearer adm' }, '/pool/admin/login/qr', 'POST', {}), r);
    assert.equal(r.statusCode, 502, `expected a 502, got ${r.statusCode} ${r.parts.join('')}`);
  } finally {
    process.env.PASSPORT_BASE_URL = saved;
  }
});

await t('api key gate rejects anonymous when keys are configured', async () => {
  const p = mkPool(1);
  const res = mockRes();
  await createApp({ pool: p, apiKeys: ['secret'] })(mockReq({}, '/v1/models', 'GET'), res);
  assert.equal(res.statusCode, 401);
});

await t('second models call comes from cache and still carries think_list', async () => {
  const p = mkPool(1);
  const app = createApp({ pool: p, apiKeys: [] });
  const r1 = mockRes();
  await app(mockReq({}, '/v1/models'), r1);
  reset();
  const r2 = mockRes();
  await app(mockReq({}, '/v1/models'), r2);
  const j = JSON.parse(r2.body);
  assert.equal(j.data.length, 4);
  assert.equal(j.think_list.length, 4, 'cached catalog must not drop think_list');
  assert.equal(hits.modelList, 0, 'cache should have served it');
});

console.log('\n== guard: we really are hitting the stub ==');
await t('every stub endpoint was exercised', () => {
  const need = ['alloc', 'modelList', 'sendmsg', 'sse', 'probe', 'points', 'sessions', 'homenew', 'taskComplete', 'rewardClaim', 'getapi', 'seed', 'getqrcode', 'qrimg', 'unicast', 'bdusslogin', 'stoken', 'senddpass', 'login', 'captcha'];
  for (const k of need) assert.ok(totals[k] > 0, `stub endpoint ${k} never hit: ` + JSON.stringify(totals));
});
await t('stub host is the fake id space, not the real account', () => {
  assert.ok(seen.sendBodies.every((b) => b.data.device_id === 'dev-stub'));
});
await t('stub saw only fake credentials, with the genflow UA', () => {
  assert.ok(seen.cookies.every((c) => !c.includes('gxNjREZlJmU2RQ')), 'real BDUSS must never appear');
  assert.ok(seen.cookies.some((c) => c.includes(FAKE_BDUSS)));
  assert.ok(seen.userAgents.some((u) => u.startsWith('genflow;1.6.5;PC;PC-Windows')));
});
await t('base url is the loopback stub, not the real upstream', () => {
  assert.match(process.env.KUKU_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
});

console.log(`\n合计 ${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const [n, m] of failures) console.log(` - ${n}: ${m}`);
  process.exitCode = 1;
}
stub.close();
