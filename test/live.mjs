// Live acceptance against the real upstream. Costs points on purpose (one tiny turn).
// NEVER merge this into `npm test`: offline green means our logic did not regress,
// only this script can say "the upstream still accepts us today".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KukuAccount, UpstreamError } from '../src/upstream.mjs';
import { Pool } from '../src/gateway.mjs';
import { openDatabase } from '../src/database.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHEAP = 'gateway-glm-5.3-flash';

// The script must always return a verdict instead of dying on a stack trace: an unconsumed
// SSE body or a mid-run restart can throw where nobody awaits.
const stray = [];
process.on('unhandledRejection', (e) => stray.push(`unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => stray.push(`uncaughtException: ${e?.message ?? e}`));

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push([name, e?.message ?? String(e)]);
    console.log(`FAIL  ${name}\n      ${e?.message ?? e}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const database = openDatabase({ root: ROOT });
process.once('exit', () => database.close());
const store = database.store('accounts').load();
assert(store.accounts?.length, 'SQLite has no accounts');
const pool = new Pool(store.accounts, { database, sessionStore: database.store('sessions') });
for (const a of pool.accounts) a.deviceId = store.default_device_id ?? '';
const acct = pool.pick({ allowUnavailable: true });
assert(acct, 'no account to test');

console.log(`live acceptance against ${acct.id} (${acct.alias})\n`);

await t('upstream model catalog is reachable', async () => {
  const d = await acct.client.modelList();
  assert(Array.isArray(d.model_list) && d.model_list.length > 0, 'empty model_list');
  assert(d.model_list.some((m) => m.vip_type === 0), 'no free-tier model');
  assert(Array.isArray(d.think_list) && d.think_list.length > 0, 'no think_list');
  console.log(`      ${d.model_list.length} models, think ids: ${d.think_list.map((x) => x.id).join(',')}`);
});

await t('zero-cost probe reports this account as logged in', async () => {
  const d = await acct.client.probe();
  assert(d && Array.isArray(d.list), 'probe returned no list');
});

await t('a dead credential is refused by the probe, not treated as success', async () => {
  const dead = new KukuAccount({ bduss: 'x'.repeat(192), stoken: 'y'.repeat(64) });
  let err = null;
  try {
    await dead.probe();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error('bogus credential passed the probe — login-state detection is broken');
  assert(err instanceof UpstreamError && !err.network, `expected deterministic business failure, got ${err.name}`);
  assert(pool.isAuthFailure(err), `expected an auth code, got ${err.code}`);
  console.log(`      code=${err.code} msg=${err.message.slice(0, 60)}`);
});

await t('balance is readable with cookies alone — no native signing params', async () => {
  const d = await acct.client.vipRemain();
  assert(Array.isArray(d.list) && d.list.length === 4, `expected 4 asset buckets, got ${JSON.stringify(d.list?.map?.((x) => x.assetName))}`);
  const byName = Object.fromEntries(d.list.map((x) => [x.assetName, x.totalPoint]));
  assert('token' in byName && 'duration' in byName, `bucket names changed: ${Object.keys(byName)}`);
  // Fractional precision matters: the token bucket is what inference drains.
  assert(Number(byName.token) >= 0 && Number.isFinite(Number(byName.token)), `token bucket unreadable: ${byName.token}`);
  assert(typeof d.isVip === 'boolean', 'isVip missing');
  console.log(`      token=${byName.token} duration=${byName.duration} scheduled_task=${byName.scheduled_task} isVip=${d.isVip}`);
});

await t('pool.points() exposes the token bucket as the balance, not a bucket sum', async () => {
  const [r] = await pool.points({ only: acct.id });
  assert(r.ok, `points failed: ${r.code} ${r.message}`);
  assert(r.assets.length === 4, 'assets must pass through verbatim');
  const token = r.assets.find((x) => x.asset_name === 'token');
  assert(r.balance_points === token.total_point, 'balance_points must be the token bucket only');
  assert(r.duration_points === r.assets.find((x) => x.asset_name === 'duration')?.total_point, 'duration must be reported separately');
});

await t('the balance route refuses a dead credential instead of returning zeros', async () => {
  const dead = new Pool([{ id: 'dead', alias: 'dead', priority: 0, bduss: 'x'.repeat(192), stoken: 'y'.repeat(64) }]);
  const [r] = await dead.points();
  assert(!r.ok, 'bogus credential must not pass the balance call');
  assert(r.code != null, `expected a business code, got ${JSON.stringify(r)}`);
  assert(dead.accounts[0].auth_dead, 'a refused balance call should mark the login dead');
  console.log(`      refused with code=${r.code}`);
});

await t('the upstream conversation list answers with cookies alone', async () => {
  const d = await acct.client.sessionList({ offset: 0, size: 5 });
  assert(Array.isArray(d.list) && d.list.length > 0, 'empty list');
  assert(Number(d.total) > 0, 'total must come back');
  const it = d.list[0];
  for (const k of ['session_id', 'title', 'status', 'session_type', 'is_read', 'ctime', 'mtime', 'download_list']) {
    assert(k in it, `item is missing ${k}: ${Object.keys(it)}`);
  }
  assert(d.list.length <= 5, 'size must be honoured');
  // Never print titles: they are the user's real conversation names.
  console.log(`      total=${d.total} page=${d.list.length} id_len=${it.session_id.length}`);
});

await t('sessions this proxy created are visible upstream under the same id', async () => {
  const d = await acct.client.sessionList({ offset: 0, size: 50 });
  const upstream = new Set(d.list.map((x) => x.session_id));
  const ours = (JSON.parse(readFileSync(path.join(ROOT, 'responses.json'), 'utf8')).responses ?? [])
    .map((r) => r.session_id).filter(Boolean);
  if (!ours.length) { console.log('      (no ledger sessions yet)'); return; }
  const found = ours.filter((s) => upstream.has(s));
  assert(found.length > 0, 'none of our ledger session_ids appear upstream — the id mapping is wrong');
  console.log(`      ${found.length}/${new Set(ours).size} of our sessions are in the client's own list`);
});

await t('the conversation list refuses a dead credential with errno -6', async () => {
  const dead = new KukuAccount({ bduss: 'x'.repeat(192), stoken: 'y'.repeat(64) });
  let err = null;
  try {
    await dead.sessionList({ offset: 0, size: 1 });
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error('bogus credential listed sessions — auth gating is broken');
  assert(err.code === -6, `expected errno -6 (measured not-login for this family), got ${err.code}`);
  assert(pool.isAuthFailure(err), 'errno -6 must classify as a logout so the pool can retire the account');
});

await t('idallochstr is NOT an auth probe (it must accept a dead credential)', async () => {
  const dead = new KukuAccount({ bduss: 'x'.repeat(192), stoken: 'y'.repeat(64) });
  const d = await dead.allocateIds();
  assert(d.chat_id && d.query_id, 'id allocation stopped working');
  // Guard against a future engineer "fixing" the probe by pointing it at idallochstr.
  assert(!pool.isAuthFailure(new UpstreamError('x', { code: 0 })));
});

await t('one tiny inference round-trips through the pool', async () => {
  const r = await pool.chat(
    { account: acct, model: { id: CHEAP }, messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }], sessionKey: `acceptance:${Date.now()}` },
    () => {},
  );
  assert(r.content.trim().length > 0, 'empty completion');
  assert(r.usage && r.usage.completion_tokens > 0, 'upstream returned no usage');
  console.log(`      content="${r.content.trim().slice(0, 40)}" in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens} points=${r.consume_points}`);
});

await t('upstream session remembers across turns', async () => {
  const key = `memtest:${Date.now()}`;
  await pool.chat({ account: acct, model: { id: CHEAP }, messages: [{ role: 'user', content: 'Remember: the passcode is Tangerine. Reply just: noted' }], sessionKey: key }, () => {});
  const r = await pool.chat({ account: acct, model: { id: CHEAP }, messages: [{ role: 'user', content: 'What was the passcode? One word only.' }], sessionKey: key }, () => {});
  assert(/tangerine/i.test(r.content), `no memory in second turn: "${r.content.slice(0, 60)}"`);
});

// ---- Responses API contract against the real upstream ----
const atok = (cond, msg) => {
  if (!cond) throw new Error(msg ?? 'expected truthy');
};
const aeq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg ?? 'equals'}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
};
const ajson = (actual, expected, msg) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? 'deep equal'}: got ${a} want ${b}`);
};
const { createApp, handleResponses } = await import('../src/server.mjs');
const { createLedger } = await import('../src/ledger.mjs');

function respReq(body) {
  return {
    headers: {},
    url: '/v1/responses',
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}
function respRes(sink) {
  return {
    statusCode: null,
    headers: {},
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h); },
    setHeader(k, v) { this.headers[k] = v; },
    write(x) { sink.parts.push(x); },
    end(x) { if (x) sink.parts.push(x); },
  };
}

await t('Responses non-stream returns a contract-shaped object', async () => {
  const ledger = createLedger(null);
  const sink = { parts: [] };
  await handleResponses(pool, respReq(), respRes(sink), {
    model: CHEAP,
    input: 'Reply with exactly one word: alpha',
  }, ledger);
  const body = sink.parts.join('');
  const j = JSON.parse(body);
  assert(/^resp_/.test(j.id), `bad id ${j.id}`);
  aeq(j.object, 'response');
  aeq(j.status, 'completed');
  aeq(j.output.at(-1).content[0].type, 'output_text');
  aeq(j.output_text, j.output.at(-1).content[0].text);
  assert(j.usage.input_tokens > 0 && j.usage.output_tokens > 0, 'usage missing from real upstream');
  assert(typeof j.usage.input_tokens_details.cached_tokens === 'number', 'no cache detail');
  console.log(`      in=${j.usage.input_tokens} out=${j.usage.output_tokens} points=${j.kuku?.consume_points}`);
});

await t('Responses streaming event order holds against the real upstream', async () => {
  const sink = { parts: [] };
  await handleResponses(pool, respReq(), respRes(sink), { model: CHEAP, input: 'Say exactly: beta', stream: true }, createLedger(null));
  const frames = sink.parts.join('').split('\n\n').filter((b) => b.trim());
  const seq = [];
  for (const blk of frames) {
    const ev = blk.split('\n').find((l) => l.startsWith('event: '));
    const dt = blk.split('\n').find((l) => l.startsWith('data: '));
    if (!ev || !dt) throw new Error(`frame missing event: line -> ${blk.slice(0, 60)}`);
    const j = JSON.parse(dt.slice(6));
    aeq(ev.slice(7).trim(), j.type, 'event name must match data.type');
    seq.push([j.sequence_number, j.type]);
  }
  ajson(seq.map((s) => s[0]), seq.map((_, i) => i), 'sequence_number must run 0..N-1');
  aeq(seq[0][1], 'response.created');
  aeq(seq[1][1], 'response.in_progress');
  aeq(seq.at(-1)[1], 'response.completed');
  atok(seq.some((s) => s[1] === 'response.output_text.delta'), 'no text delta frames');
});

await t('previous_response_id chains a real multi-turn memory', async () => {
  const ledger = createLedger(null);
  const send = (body) => {
    const sink = { parts: [] };
    return handleResponses(pool, respReq(), respRes(sink), body, ledger).then(() => JSON.parse(sink.parts.join('')));
  };
  const a = await send({ model: CHEAP, input: 'Remember: my fruit is persimmon. Reply just: ok' });
  const b = await send({ model: CHEAP, input: 'What is my fruit? One word.', previous_response_id: a.id });
  assert(/persimmon/i.test(b.output_text), `chained memory failed: "${b.output_text.slice(0, 60)}"`);
  aeq(b.kuku.session_id, a.kuku.session_id, 'chained turn must reuse the upstream session');
});

assert(stray.length === 0, stray.join('; '));
console.log(`\n合计 ${passed} 通过，${failures.length} 失败`);
for (const [n, m] of failures) console.log(` - ${n}: ${m}`);
process.exitCode = failures.length ? 1 : 0;
