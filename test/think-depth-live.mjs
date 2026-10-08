// Explicit live diagnostic for the two requested Flash models. Costs real points.
// Run directly only when the operator authorizes it; never part of npm test.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool, getCachedCatalog } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

// Account traffic must be direct. Do not opt Node into environment proxy support at startup.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'KUKU_BASE_URL']) delete process.env[k];
if (process.env.NODE_USE_ENV_PROXY === '1') throw new Error('Start with NODE_USE_ENV_PROXY=0 for direct account traffic');

const models = ['gateway-glm-5.3-flash', 'gateway-deepseek-v4.1-flash-volcengine'];
const prompt = '五个人A、B、C、D、E夜间过桥，单独过桥分别需1、2、5、10、15分钟。只有一盏手电筒，每次最多两人，必须带手电筒，同行用较慢者的时间，手电筒必须由人带回。求全部到对岸的最短总时间，并列出过桥和返回方案。只输出结论与方案，不超过180字。';
const database = openDatabase({ root: fileURLToPath(new URL('..', import.meta.url)) });
process.once('exit', () => database.close());
const loaded = database.store('accounts').load();
const pool = new Pool(loaded.accounts, { database, sessionStore: database.store('sessions') });
for (const a of pool.accounts) a.deviceId = loaded.default_device_id ?? '';
const account = pool.pick();
if (!account) throw new Error('No available account');
await pool.refreshModelIndex(account);
const catalog = getCachedCatalog();
if (!models.every((id) => catalog?.model_list.some((m) => m.model_name === id))) throw new Error('Requested models are absent from the catalog');
if (![1, 2, 3, 4].every((mode) => catalog.think_list.some((t) => Number(t.id) === mode))) throw new Error('Expected thinking modes are absent');

const nativeFetch = globalThis.fetch;
let wire = [];
globalThis.fetch = (url, opts = {}) => {
  const pathname = new URL(url).pathname;
  if (['/wenchain/genflowpro/sendmsg', '/wenchain/genflowpro/sse/getchatcontent'].includes(pathname)) {
    const parsed = JSON.parse(opts.body);
    const data = pathname.endsWith('/sendmsg') ? parsed.data : parsed;
    wire.push({ pathname, model_name: data.model_name, think_mode: data.think_mode, think_mode_type: typeof data.think_mode });
  }
  return nativeFetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(180_000) });
};
const app = createApp({ pool }); // No disk ledger, login actions, scheduler, or key changes.
const before = (await pool.points({ only: account.id }))[0];
const report = { checked_at: new Date().toISOString(), account_id: account.id, prompt, modes: catalog.think_list, results: [], balance_before: before.balance_points };
const destination = new URL('../capture/think-depth-2026-10-06.json', import.meta.url);
const save = () => writeFileSync(destination, JSON.stringify(report, null, 2));

function responseCollector() {
  return {
    statusCode: null, headersSent: false, parts: [],
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { this.parts.push(String(chunk)); },
    end(chunk) { if (chunk) this.parts.push(String(chunk)); },
  };
}

try {
  // Interleave models and start with the extremes, then fill in intermediate depths.
  for (const mode of [1, 4, 2, 3]) for (const model of models) {
    wire = [];
    let frames = { thinking_deltas: 0, model_call_end: 0 };
    const originalSse = account.client.sse;
    account.client.sse = async function* (...args) {
      for await (const f of originalSse.apply(this, args)) {
        if (f.data?.type === 'THINKING_BLOCK_DELTA') frames.thinking_deltas++;
        if (f.data?.type === 'MODEL_CALL_END') frames.model_call_end++;
        yield f;
      }
    };
    const body = { model, messages: [{ role: 'user', content: prompt }], stream: true, think_mode: mode, stream_options: { include_usage: true }, kuku_meta: true };
    const req = { method: 'POST', url: '/v1/chat/completions', headers: { 'x-kuku-account': account.id, 'x-kuku-session': `think-check:${randomUUID()}` }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = responseCollector();
    const started = Date.now();
    try {
      await app(req, res);
      const events = res.parts.join('').split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
      const error = events.find((e) => e.error)?.error;
      const reasoning = events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? '').join('');
      const text = events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
      const usage = events.find((e) => e.usage)?.usage ?? null;
      const meta = events.find((e) => e.kuku)?.kuku;
      const wire_valid = wire.length === 2 && wire.every((w) => w.model_name === model && w.think_mode === mode && w.think_mode_type === 'number');
      const r = { model, think_mode: mode, http_status: res.statusCode, ok: res.statusCode === 200 && !error && !!text && wire_valid, elapsed_ms: Date.now() - started, wire: [...wire], wire_valid, frames, reasoning_chars: reasoning.length, reasoning_tokens: usage?.reasoning_tokens ?? null, reasoning_token_scope: 'last_MODEL_CALL_END', output_tokens: usage?.completion_tokens ?? null, consume_points: meta?.consume_points ?? null, output: text, error: error ? { type: error.type, code: error.code } : null };
      report.results.push(r);
      save();
      console.log(JSON.stringify(r));
      if (!r.ok) throw new Error('Model test failed; stopping instead of retrying paid inference');
    } finally {
      account.client.sse = originalSse;
    }
  }
  report.balance_after = (await pool.points({ only: account.id }))[0].balance_points;
  report.total_consume_points = report.results.reduce((sum, r) => sum + (r.consume_points ?? 0), 0);
  report.completed_at = new Date().toISOString();
  save();
  console.log(JSON.stringify({ completed: true, calls: report.results.length, total_consume_points: report.total_consume_points, balance_before: report.balance_before, balance_after: report.balance_after }));
} finally {
  globalThis.fetch = nativeFetch;
}
