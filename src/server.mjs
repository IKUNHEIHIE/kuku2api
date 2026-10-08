import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool, sseChunk, makeChunk, getCachedCatalog, unknownModelId, unknownThinkMode } from './gateway.mjs';
import { UpstreamError } from './upstream.mjs';
import { toRecords, createKeyRing } from './store.mjs';
import { normalizeInput, buildResponse, newResponseId, resolveThink, EFFORT_TO_THINK, ResponseStream } from './responses.mjs';
import { deriveSessionKey } from './gateway.mjs';
import { createAccountManager } from './accounts.mjs';
import { createLoginManager } from './logins.mjs';
import { createAutoClaim } from './scheduler.mjs';
import { resolveAdminToken } from './admin-token.mjs';
import { openDatabase, createDatabaseLogger } from './database.mjs';
import { databaseAdminRoute } from './database-api.mjs';
import { createDesktopLogin } from './desktop-login.mjs';
import { createStaticUi } from './static-ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');

function rough(s) {
  return Math.ceil(String(s ?? '').length / 2);
}

// Rough char-based figure used only when upstream gave no MODEL_CALL_END. Not a billing source.
function openAiUsage(usage, content) {
  if (usage) return usage;
  return {
    prompt_tokens: 0,
    completion_tokens: rough(content),
    total_tokens: rough(content),
  };
}

function redact(msg) {
  return String(msg).replace(/(BDUSS|STOKEN)=[^;"\s]+/g, '$1=<redacted>');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...CORS });
  res.end(body);
}

// A console running on a dev-server origin (Vite etc.) is a different origin than this
// loopback API, so preflight and credentialed-less CORS headers are required.
const CORS = {
  'access-control-allow-origin': process.env.CORS_ORIGIN ?? '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, x-admin-token, x-kuku-account, x-kuku-session, x-kuku-allow-unavailable',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function openError(res, status, message, type = 'invalid_request_error', code) {
  json(res, status, { error: code ? { message, type, code } : { message, type } });
}

const DEFAULT_MODEL = 'gateway-glm-5.3-flash';

// Rejecting locally is not pedantry: an unknown model_name reaches the upstream, its turn
// errors out, and a deterministic upstream failure cools the account for minutes.
function rejectUnknownModel(res, model) {
  openError(res, 400, `model '${model}' is not in GET /v1/models`, 'invalid_request_error', 'model_not_found');
}

// Same reasoning as above: upstream accepts a nonsense think_mode, runs the turn anyway, and
// charges for it, so the caller can never tell the knob was ignored.
function rejectThinkMode(res) {
  const ids = (getCachedCatalog()?.think_list ?? []).map((x) => Number(x.id));
  openError(
    res,
    400,
    `unusable thinking setting: think_mode must be one of [${ids.join(', ')}] (see GET /v1/models think_list) or reasoning.effort one of [${Object.keys(EFFORT_TO_THINK).join(', ')}]`,
    'invalid_request_error',
    'invalid_think_mode',
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// A 200 that carries a business code is a failure. Network jitter must not be punished the
// same way, and neither must a caller's own bad request.
function isDeterministicUpstreamFailure(err) {
  return err instanceof UpstreamError && !err.network;
}

// Account-state failures are scheduling facts, not request errors: mark the account so the next
// pick skips it, then let the caller fail over. A drained account is deliberately NOT cooled —
// its flag is cleared by the next /pool/points read once upstream refills the daily free points.
function noteAccountFailure(pool, acct, err) {
  if (err?.persistence || err?.retryUnsafe) return true;
  const paramError = pool.isClientParamError(err);
  if (pool.isInsufficientBalance(err)) pool.markBalanceDead(acct);
  else if (pool.isAuthFailure(err)) pool.markAuthDead(acct);
  else if (!paramError && isDeterministicUpstreamFailure(err)) pool.cool(acct);
  return paramError;
}

// An exhausted pool must not look like "the model answered nothing".
function failureResponse(err) {
  if (err?.insufficient_balance || Number(err?.code) === 11002) {
    return { status: 402, code: 'insufficient_balance' };
  }
  return { status: err?.status ?? (err?.network ? 502 : 500),
    code: ['upstream_timeout', 'upstream_incomplete', 'upstream_requires_client', 'session_account_mismatch', 'session_history_unavailable'].includes(err?.code) ? err.code : undefined };
}

// reqBody.kuku_meta adds a final non-standard `data: {"kuku":{...}}` frame so a console UI
// can see account/consume per streamed turn. Off by default: strict OpenAI SDKs expect
// every data line to be a chat.completion.chunk.
export async function handleChat(pool, req, res, reqBody, opts = {}) {
  const model = String(reqBody.model ?? DEFAULT_MODEL);
  if (unknownModelId(model)) return rejectUnknownModel(res, model);
  const think = resolveThink(reqBody);
  if (Number.isNaN(think) || unknownThinkMode(think)) return rejectThinkMode(res);
  const messages = reqBody.messages;
  if (!Array.isArray(messages) || !messages.length) return openError(res, 400, 'messages must be a non-empty array');
  const stream = reqBody.stream === true;

  const wanted = req.headers['x-kuku-account'];
  // Documented as an admin-only probe switch: without the admin token it must not let a caller
  // route traffic to a disabled or condemned account.
  const allowUnavailable = opts.admin === true && req.headers['x-kuku-allow-unavailable'] === '1';
  let acct;
  try {
    acct = pool.resolve(wanted, { allowUnavailable });
  } catch (e) {
    return openError(res, e.status ?? 409, redact(e.message), 'pool_error', failureResponse(e).code);
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const controller = new AbortController();
  res.once?.('close', () => { if (!res.writableFinished) controller.abort(); });
  const created = Math.floor(Date.now() / 1000);
  const tried = [];
  let content = '';
  let usage = null;
  let consume = null;
  let turn = null;
  let sentAny = false;
  let lastErr = null;
  let served = acct;

  const attempts = Math.max(1, pool.accounts.length);
  // The SSE header is written on the first real delta, not up front. Writing it before anything
  // has happened both blocks failover (the status can no longer become 402) and turns a drained
  // account into a silent `data: [DONE]`, which reads to the caller as "the model said nothing".
  let streamOpen = false;
  const openStream = (account) => {
    if (streamOpen) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-kuku-account': account.id,
      ...CORS,
    });
    res.write(sseChunk(makeChunk(id, created, model, { role: 'assistant' })));
    streamOpen = true;
  };

  for (let i = 0; i < attempts; i++) {
    tried.push(acct.id);
    try {
      const r = await pool.chat(
        { account: acct, model: { id: model }, messages, sessionKey: req.headers['x-kuku-session'], think_mode: think, source: 'chat', store: reqBody.store },
        (delta) => {
          if (!stream || controller.signal.aborted) return;
          openStream(acct);
          sentAny = true;
          res.write(sseChunk(makeChunk(id, created, model, delta)));
        },
        controller.signal,
      );
      content = r.content;
      usage = r.usage;
      consume = r.consume_points;
      turn = r;
      served = acct;
      lastErr = null;
      if (stream && !controller.signal.aborted) openStream(acct); // an empty completed turn still needs SSE
      break;
    } catch (err) {
      lastErr = err;
      const paramError = noteAccountFailure(pool, acct, err);
      if (paramError || sentAny || controller.signal.aborted) break;
      const next = pool.pick({ allowUnavailable, exclude: tried });
      if (!next) break;
      acct = next;
    }
  }

  if (controller.signal.aborted) return;
  if (lastErr && !sentAny) {
    const f = failureResponse(lastErr);
    return openError(res, f.status, redact(lastErr.message), 'upstream_error', f.code);
  }

  if (stream) {
    openStream(served);
    // A turn that dies after content already went out cannot change the status any more, so the
    // failure has to be carried in-band the way the Responses stream already does.
    if (lastErr) {
      res.write(sseChunk({ error: { message: redact(lastErr.message), type: 'upstream_error', code: failureResponse(lastErr).code ?? null } }));
      return res.end('data: [DONE]\n\n');
    }
    res.write(sseChunk(makeChunk(id, created, model, {}, 'stop')));
    if (reqBody.stream_options?.include_usage) {
      res.write(sseChunk({ ...makeChunk(id, created, model, {}), usage: openAiUsage(usage, content) }));
    }
    if (reqBody.kuku_meta) {
      res.write(sseChunk({ kuku: { account: served.id, consume_points: consume, session_id: turn?.session_id ?? null, reply_id: turn?.reply_id ?? null } }));
    }
    return res.end('data: [DONE]\n\n');
  }

  json(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: openAiUsage(usage, content),
    kuku: {
      account: served.id,
      consume_points: consume,
      session_id: turn?.session_id ?? null,
      reply_id: turn?.reply_id ?? null,
    },
  });
}

// OpenAI Responses API. Statefulness (previous_response_id) is resolved through the ledger,
// which maps a response id back to the upstream session key that produced it.
export async function handleResponses(pool, req, res, body, ledger, opts = {}) {
  const model = String(body.model ?? DEFAULT_MODEL);
  if (unknownModelId(model)) return rejectUnknownModel(res, model);
  const think = resolveThink(body);
  if (Number.isNaN(think) || unknownThinkMode(think)) return rejectThinkMode(res);
  const messages = normalizeInput(body.input);
  if (!messages.length) return openError(res, 400, 'input must be a non-empty string or item array');

  const prevId = body.previous_response_id ?? null;
  let prev = null;
  if (prevId) {
    prev = ledger?.get(prevId) ?? null;
    if (!prev) return openError(res, 404, `previous_response_id not found: ${prevId}`, 'invalid_request_error');
  }

  const wanted = req.headers['x-kuku-account'];
  // Documented as an admin-only probe switch: without the admin token it must not let a caller
  // route traffic to a disabled or condemned account.
  const allowUnavailable = opts.admin === true && req.headers['x-kuku-allow-unavailable'] === '1';
  let acct;
  try {
    if (prev) {
      if (!prev.account || !prev.session_key || !prev.session_id) return openError(res, 409, '历史回复缺少账号或会话归属，请新建对话', 'pool_error', 'response_account_unverified');
      if (!pool.accounts.some(a => a.id === prev.account)) return openError(res, 404, '历史回复所属账号已不存在，请新建对话', 'pool_error', 'response_account_not_found');
      const requested = wanted ? (pool.accounts.find(a => a.id === wanted) ?? pool.accounts.find(a => a.alias === wanted)) : null;
      if (wanted && requested?.id !== prev.account) {
        return openError(res, 409, '续聊不能切换到其他账号，请新建对话', 'pool_error', 'response_account_mismatch');
      }
      acct = pool.resolve(prev.account, { allowUnavailable });
    } else acct = pool.resolve(wanted, { allowUnavailable });
  } catch (e) {
    return openError(res, e.status ?? 409, redact(e.message), 'pool_error', prev ? 'response_account_unavailable' : failureResponse(e).code);
  }

  const id = newResponseId();
  const controller = new AbortController();
  res.once?.('close', () => { if (!res.writableFinished) controller.abort(); });
  const created = Math.floor(Date.now() / 1000);
  const sessionKey = prev?.session_key ?? req.headers['x-kuku-session'] ?? deriveSessionKey({ messages, accountId: acct.id });
  const stream = body.stream === true;
  const skeleton = buildResponse({
    id,
    model,
    created,
    text: '',
    thinking: '',
    usage: null,
    consume: null,
    instructions: body.instructions ?? null,
    previous_response_id: prevId,
    store: body.store,
    status: 'in_progress',
  });

  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
  }

  const tried = [];
  let turn = null;
  let lastErr = null;
  let sentAny = false;

  const sc = stream ? new ResponseStream(res, skeleton) : null;
  if (sc) sc.started();

  const attempts = Math.max(1, pool.accounts.length);
  for (let i = 0; i < attempts; i++) {
    tried.push(acct.id);
    try {
      turn = await pool.chat(
          { account: acct, model: { id: model }, messages, sessionKey, requiredSessionId: prev?.session_id, think_mode: think, source: 'responses', store: body.store },
          sc ? (delta) => {
            if (controller.signal.aborted) return;
            if (delta.reasoning_content) {
              if (!sc.reasoningOpen) { sc.reasoningOpen = true; sc.reasoningStarted(); }
              sc.reasoningDelta(delta.reasoning_content);
              sc.reasoningText = (sc.reasoningText ?? '') + delta.reasoning_content;
            }
            if (delta.content) {
              if (!sc.messageOpen) {
                if (sc.reasoningOpen && !sc.reasoningClosed) { sc.reasoningClosed = true; sc.reasoningDone(sc.reasoningText ?? ''); }
                sc.messageOpen = true;
                sc.messageStarted();
              }
              sentAny = true;
              sc.delta(delta.content);
            }
          } : () => {},
          controller.signal,
      );
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const paramError = noteAccountFailure(pool, acct, err);
      if (prev || paramError || sentAny || controller.signal.aborted) break;
      const next = pool.pick({ allowUnavailable, exclude: tried });
      if (!next) break;
      acct = next;
    }
  }

  if (controller.signal.aborted) return;
  if (lastErr && !sentAny) {
    const f = failureResponse(lastErr);
    if (sc) {
      sc.failed(redact(lastErr.message));
      return;
    }
    return openError(res, f.status, redact(lastErr.message), 'upstream_error', f.code);
  }

  const text = turn?.content ?? '';
  const thinking = turn?.reasoning ?? '';
  const final = buildResponse({
    id,
    model,
    created,
    text,
    thinking,
    usage: turn?.usage ?? null,
    consume: turn?.consume_points ?? null,
    instructions: body.instructions ?? null,
    previous_response_id: prevId,
    store: body.store,
    session_id: turn?.session_id ?? null,
    reply_id: turn?.reply_id ?? null,
    account: acct.id,
  });
  final.kuku.account = acct.id;

  ledger?.put({
    id,
    session_key: sessionKey,
    session_id: turn?.session_id ?? null,
    model,
    account: acct.id,
    created_at: created,
    output_text: text,
    // GET /v1/responses/:id must hand back a Response object, not the internal record.
    response: final,
  });

  if (sc) return sc.completed(final);
  json(res, 200, final);
}

export function createApp({ pool, apiKeys = [], adminToken = '', store = null, deviceId = '', ledger = null, keyRing = null, autoClaim = null, database = null, logger = console, uiDirectory = path.join(ROOT, 'ui', 'dist') }) {
  const keys = keyRing ?? createKeyRing({ envKeys: apiKeys });
  const serveUi = createStaticUi(uiDirectory);
  const authed = (req) => {
    // No keys configured at all = local single-user mode, the same rule as before key management.
    if (keys.count() === 0) return true;
    const h = req.headers.authorization ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-api-key'] ?? '';
    return keys.ok(key);
  };

  // Admin surface is separately keyed and never falls back to "no keys configured".
  const admined = (req) => {
    if (!adminToken) return false;
    const h = req.headers.authorization ?? '';
    return (h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-admin-token'] ?? '') === adminToken;
  };

  const persist = () => {
    if (!store) return;
    store.save({ default_device_id: deviceId, accounts: toRecords(pool.accounts) });
  };

  const shape = (a) => ({
    id: a.id,
    alias: a.alias,
    priority: a.priority,
    disabled: a.disabled,
    auth_dead: !!a.auth_dead,
    // Set when upstream answered a turn with COMMERCIAL/insufficient_balance (errno 11002).
    // It is a retry window, not a latch: a freshly minted STOKEN can read zero for a few minutes
    // and then serve normally. Cleared early by the next /pool/points read or reset-cooldown.
    balance_dead: (a.balance_dead_until ?? 0) > Date.now(),
    balance_retry_in_ms: Math.max(0, (a.balance_dead_until ?? 0) - Date.now()),
    cooldown_remaining_ms: Math.max(0, a.cooldown_until - Date.now()),
    // Credential material is never echoed back; the UI only ever needs to tell accounts apart.
    has_credential: Boolean(a.client?.bduss && a.client?.stoken),
  });

  // One place that turns credentials into a pooled account. The QR/SMS login flows call it with
  // what the browser-less login handed back; the manual route calls it with pasted cookies.
  // STOKEN and PTOKEN are httpOnly upstream, so a user who scraped their own browser usually has
  // only BDUSS + PTOKEN — in that case we ask passport for the STOKEN instead of failing.
  const desktopLogin = createDesktopLogin({ database, pool });
  const accountManager = createAccountManager({ pool, store, deviceId, initializeDesktop: desktopLogin.run });
  const addAccount = accountManager.add;

  // Login sessions (QR / SMS). Inert until the admin routes are called.
  const logins = createLoginManager({ addAccount, listAccounts: () => pool.accounts, deviceId });

  const route = async function (req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (url.pathname === '/healthz') return json(res, 200, { ok: true });

    if (url.pathname.startsWith('/pool/admin/')) {
      if (!admined(req)) return openError(res, 401, 'admin token required', 'authentication_error');
      const body = await readBody(req).catch(() => null);
      if (body === null) return openError(res, 400, 'invalid json body');
      const databaseRoute = databaseAdminRoute({ database, autoClaim, url, method: req.method, body });
      if (databaseRoute) return json(res, databaseRoute.status, databaseRoute.body);

      if (url.pathname === '/pool/admin/accounts' && req.method === 'POST') {
        for (const k of ['id', 'bduss']) if (!body[k]) return openError(res, 400, `${k} is required`);
        if (!body.stoken && !body.ptoken) return openError(res, 400, 'stoken is required (or send ptoken and we fetch it)');
        if (body.stoken && body.ptoken) return openError(res, 400, 'send either stoken or ptoken, not both');
        const added = await addAccount(body);
        if (added.error) {
          const e = added.error;
          return openError(res, e.status, e.message, e.type ?? 'invalid_request_error', e.code);
        }
        return json(res, 201, { ok: true, accounts: pool.accounts.map(shape), minted_stoken: added.minted === true, desktop_login: added.desktop_login });
      }

      const desktopRoute = url.pathname.match(/^\/pool\/admin\/accounts\/([^/]+)\/desktop-login$/);
      if (desktopRoute) {
        if (!['GET', 'POST'].includes(req.method)) return openError(res, 405, 'method not allowed');
        if (Object.keys(body).some((key) => key !== 'retry') || ('retry' in body && typeof body.retry !== 'boolean')) return openError(res, 400, 'only retry:boolean is accepted');
        const account = pool.accounts.find((a) => a.id === decodeURIComponent(desktopRoute[1]));
        if (!account) return openError(res, 404, 'unknown account');
        if (!account.upstream_user_id) return openError(res, 409, 'account identity must be verified first', 'invalid_request_error', 'account_identity_unavailable');
        if (req.method === 'GET') return json(res, 200, { ok: true, account_id: account.id, ...desktopLogin.state(account) });
        return json(res, 200, { account_id: account.id, ...(await desktopLogin.run(account, { retry: body.retry === true })) });
      }
      const m = url.pathname.match(/^\/pool\/admin\/accounts\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const updated = await accountManager.patch(decodeURIComponent(m[1]), body);
        if (updated.error) {
          const e = updated.error;
          return openError(res, e.status, e.message, e.type ?? 'invalid_request_error', e.code);
        }
        return json(res, 200, { ok: true, account: shape(updated.account) });
      }

      if (m && req.method === 'DELETE') {
        const id = decodeURIComponent(m[1]);
        const i = pool.accounts.findIndex((x) => x.id === id);
        if (i < 0) return openError(res, 404, `unknown account ${id}`);
        const rec = toRecords(pool.accounts);
        rec.splice(i, 1);
        pool.set(rec);
        for (const a of pool.accounts) a.deviceId = deviceId;
        persist();
        // Deleting leaves a hole in the priority sequence; the caller can close it with /resequence.
        return json(res, 200, { ok: true, accounts: pool.accounts.map(shape), gap: true });
      }

      if (url.pathname === '/pool/admin/resequence' && req.method === 'POST') {
        pool.accounts.sort((x, y) => x.priority - y.priority);
        pool.accounts.forEach((a, i) => { a.priority = i; });
        persist();
        return json(res, 200, { ok: true, accounts: pool.accounts.map(shape) });
      }

      if (url.pathname === '/pool/admin/reset-cooldown' && req.method === 'POST') {
        for (const a of pool.accounts) {
          if (body.id && a.id !== body.id) continue;
          a.cooldown_until = 0;
          a.auth_dead = false;
          a.balance_dead_until = 0;
        }
        return json(res, 200, { ok: true, accounts: pool.accounts.map(shape) });
      }

      // ---- 登录加号（扫码 / 手机号验证码）----
      // Every leg talks to passport directly; the only thing that ever leaves these routes is an
      // account id and a state, never a cookie.
      if (url.pathname === '/pool/admin/login/qr' && req.method === 'POST') {
        try {
          return json(res, 201, await logins.startQr(body));
        } catch (e) {
          return openError(res, 502, `二维码申请失败：${e.message}`, 'upstream_error', 'login_qr_failed');
        }
      }
      const qrImg = /^\/pool\/admin\/login\/qr\/([^/]+)\.png$/.exec(url.pathname);
      if (qrImg && req.method === 'GET') {
        const png = await logins.image(decodeURIComponent(qrImg[1]));
        if (!png) return openError(res, 404, 'unknown or expired login session');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', ...CORS });
        return res.end(png);
      }
      const qrPoll = /^\/pool\/admin\/login\/qr\/([^/]+)$/.exec(url.pathname);
      if (qrPoll && ['GET', 'POST'].includes(req.method)) {
        try {
          const r = await logins.pollQr(decodeURIComponent(qrPoll[1]));
          if (r.error) return openError(res, r.status ?? 400, r.error);
          return json(res, 200, r);
        } catch (e) {
          return openError(res, 502, `轮询失败：${e.message}`, 'upstream_error', 'login_poll_failed');
        }
      }
      if (url.pathname === '/pool/admin/login/sms' && req.method === 'POST') {
        try {
          return json(res, 200, await logins.startSms(body));
        } catch (e) {
          return openError(res, 502, `验证码发送失败：${e.message}`, 'upstream_error', 'login_sms_failed');
        }
      }
      if (url.pathname === '/pool/admin/login/sms/resend' && req.method === 'POST') {
        const r = await logins.resendSms(body.login_id, body.captcha ?? null);
        if (r.error) return openError(res, r.status ?? 404, r.error);
        return json(res, 200, r);
      }
      const capImg = /^\/pool\/admin\/login\/sms\/captcha\/([^/]+)$/.exec(url.pathname);
      if (capImg && req.method === 'GET') {
        const img = await logins.captcha(decodeURIComponent(capImg[1]));
        if (!img) return openError(res, 404, 'no captcha waiting for this session');
        res.writeHead(200, { 'content-type': img.content_type, 'cache-control': 'no-store', ...CORS });
        return res.end(img.buffer);
      }
      if (url.pathname === '/pool/admin/login/sms/verify' && req.method === 'POST') {
        const r = await logins.verifySms(body);
        if (r.error) return openError(res, r.status ?? 404, r.error);
        return json(res, 200, r);
      }

      if (url.pathname === '/pool/admin/keys' && req.method === 'GET') {
        return json(res, 200, { open: keys.count() === 0, keys: keys.list() });
      }

      if (url.pathname === '/pool/admin/keys' && req.method === 'POST') {
        const k = keys.add(body.label);
        // The secret appears in this response and never again anywhere else.
        return json(res, 201, { ok: true, key: { ...k.shape, secret: k.key }, warning: 'copy the secret now; it is not retrievable' });
      }

      const km = /^\/pool\/admin\/keys\/([^/]+)$/.exec(url.pathname);
      if (km && req.method === 'DELETE') {
        const id = decodeURIComponent(km[1]);
        // Env keys are the operator's own config; an admin token must not be able to erase it.
        if (id.startsWith('env-')) return openError(res, 400, `key '${id}' comes from API_KEYS and cannot be revoked here`);
        if (!keys.remove(id)) return openError(res, 404, `unknown key ${id}`);
        // Deleting the last key puts /v1/* back into "no api key required" mode — the caller has
        // to be able to see that happening, and ADMIN_TOKEN is what still guards the admin side.
        return json(res, 200, { ok: true, keys: keys.list(), api_now_unauthenticated: keys.count() === 0 });
      }

      // ---- 免费积分（读取免费，领取是对账号的写操作）----
      if (url.pathname === '/pool/admin/claim' && req.method === 'GET') {
        const only = url.searchParams.get('account');
        return json(res, 200, { accounts: await pool.freePointTasks({ only }) });
      }

      if (url.pathname === '/pool/admin/claim' && req.method === 'POST') {
        const only = body.id ?? body.account ?? null;
        // `chat` earns the CHAT task by spending one minimal turn; off unless asked for.
        const out = await pool.claimFreePoints({ only, runChat: !!body.chat, chatModel: body.model ?? undefined, chatText: body.text ?? undefined });
        logger.log('manual claim:', JSON.stringify(out.map((a) => ({ id: a.id, ok: a.ok, points_earned: a.points_earned, reported: a.reported, notes: a.notes, code: a.code }))));
        return json(res, 200, { ok: true, accounts: out, points_earned: out.reduce((n, a) => n + (a.points_earned ?? 0), 0) });
      }

      if (url.pathname === '/pool/admin/auto-claim' && req.method === 'GET') {
        if (!autoClaim) return json(res, 200, { configured: false, enabled: false });
        return json(res, 200, { configured: true, ...autoClaim.state });
      }

      if (url.pathname === '/pool/admin/auto-claim' && req.method === 'POST') {
        if (!autoClaim) return openError(res, 501, 'the scheduler is not configured in this process');
        return json(res, 200, { ok: true, auto_claim: autoClaim.configure(body) });
      }

      if (url.pathname === '/pool/admin/auto-claim/run' && req.method === 'POST') {
        if (!autoClaim) return openError(res, 501, 'the scheduler is not configured in this process');
        return json(res, 200, { ok: true, result: await autoClaim.run() });
      }

      return openError(res, 404, 'not found');
    }

    if (await serveUi(req, res)) return;
    if (!authed(req)) return openError(res, 401, 'bad api key');

    if (url.pathname === '/v1/models') {
      let d = getCachedCatalog();
      if (!d) {
        const acct = pool.pick({ allowUnavailable: true });
        if (acct) await pool.refreshModelIndex(acct);
        d = getCachedCatalog();
      }
      if (!d) return json(res, 200, { object: 'list', data: [] });
      return json(res, 200, {
        object: 'list',
        data: (d.model_list ?? []).map((m) => ({
          id: m.model_name,
          object: 'model',
          owned_by: `kuku${m.vip_type ? ' (vip)' : ''}`,
          display_name: m.display_name ?? m.model_name,
          cost_ratio: m.cost_ratio,
          description: m.description,
        })),
        think_list: d.think_list ?? [],
        default_model: d.default_model,
        default_think_id: d.default_think_id,
      });
    }

    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return openError(res, 400, 'invalid json body');
      }
      return handleResponses(pool, req, res, body, ledger, { admin: admined(req) });
    }

    // Cursor envelope matches the SDK's CursorPage: data/first_id/last_id/has_more, newest first.
    if (url.pathname === '/v1/responses' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
      const sessionKey = url.searchParams.get('session_key');
      const after = url.searchParams.get('after');
      if (ledger?.page) {
        let result;
        try { result = ledger.page({ limit, sessionKey, after }); }
        catch (e) { if (!e.cursor) throw e; return openError(res, 400, `unknown 'after' cursor: ${after}`, 'invalid_request_error', 'cursor_not_found'); }
        return json(res, 200, { object: 'list', data: result.records.map((r) => r.response ?? { id: r.id, object: 'response', created_at: r.created_at }),
          first_id: result.records[0]?.id ?? null, last_id: result.records.at(-1)?.id ?? null, has_more: result.has_more });
      }
      // Insertion order is creation order, so reversing is exact. Sorting on created_at is not:
      // it is second-granular, and same-second responses would come back oldest-first.
      // store:false turns must stay in the ledger (previous_response_id resolves through it)
      // but they are not listable.
      let recs = (ledger?.list() ?? []).filter((r) => r.response?.store !== false);
      if (sessionKey) recs = recs.filter((r) => r.session_key === sessionKey);
      recs = recs.slice().reverse();
      if (after) {
        const i = recs.findIndex((r) => r.id === after);
        // An unresolvable cursor must not look like end-of-list: that silently truncates history.
        if (i === -1) return openError(res, 400, `unknown 'after' cursor: ${after}`, 'invalid_request_error', 'cursor_not_found');
        recs = recs.slice(i + 1);
      }
      const page = recs.slice(0, limit);
      return json(res, 200, {
        object: 'list',
        data: page.map((r) => r.response ?? { id: r.id, object: 'response', created_at: r.created_at }),
        first_id: page[0]?.id ?? null,
        last_id: page.at(-1)?.id ?? null,
        has_more: recs.length > page.length,
      });
    }

    const rm = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
    if (rm && req.method === 'GET') {
      const rec = ledger?.get(decodeURIComponent(rm[1]));
      if (!rec || rec.response?.store === false) return openError(res, 404, 'response not found', 'invalid_request_error');
      return json(res, 200, rec.response ?? rec);
    }
    if (rm && req.method === 'DELETE') {
      const ok = ledger?.del(decodeURIComponent(rm[1]));
      if (!ok) return openError(res, 404, 'response not found', 'invalid_request_error');
      return json(res, 200, { id: decodeURIComponent(rm[1]), object: 'response', deleted: true });
    }

    if (url.pathname === '/v1/chat/completions') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return openError(res, 400, 'invalid json body');
      }
      return handleChat(pool, req, res, body, { admin: admined(req) });
    }

    if (url.pathname === '/pool/state') {
      return json(res, 200, {
        accounts: pool.accounts.map(shape),
        sessions: pool.sessions.size,
        admin_enabled: Boolean(adminToken),
        // The UI needs to be able to say "this server is currently unauthenticated".
        api_open: keys.count() === 0,
        api_key_count: keys.count(),
        // Scheduler state is not secret and the UI has to show whether daily claiming is on.
        auto_claim: autoClaim ? autoClaim.state : { configured: false, enabled: false },
      });
    }

    if (url.pathname === '/pool/health') {
      const only = url.searchParams.get('account');
      const results = await pool.healthCheck({ only });
      return json(res, 200, { checked_at: new Date().toISOString(), accounts: results });
    }

    if (url.pathname === '/pool/points') {
      const only = url.searchParams.get('account');
      const results = await pool.points({ only });
      return json(res, 200, {
        checked_at: new Date().toISOString(),
        // Only the token bucket is spendable on inference; report it as the pool total.
        total_balance_points: results.reduce((s, r) => s + (r.balance_points ?? 0), 0),
        accounts: results,
      });
    }

    if (url.pathname === '/pool/sessions') {
      const only = url.searchParams.get('account');
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 20, 1), 50);
      const results = await pool.sessionList({ only, offset, size });
      // Only sessions we created are continuable through this proxy (we allocate our own
      // session_id and key history by sessionKey); the rest are visible but read-only here.
      const ours = new Set([...pool.sessions.values()].map((s) => s.session_id).filter(Boolean));
      if (ledger?.sessionIds) for (const id of ledger.sessionIds()) ours.add(id);
      else for (const r of ledger?.list?.() ?? []) if (r.session_id) ours.add(r.session_id);
      for (const r of results) for (const s of r.sessions) s.created_by_this_pool = ours.has(s.session_id);
      return json(res, 200, { checked_at: new Date().toISOString(), accounts: results });
    }

    openError(res, 404, 'not found');
  };

  // A rejecting handler is an unhandled promise rejection, which by default ends the process —
  // and a proxy that dies takes the whole pool down with it. Several login routes await passport
  // calls that throw on any network blip, so this is the safety net, not decoration.
  return (req, res) => {
    const started = Date.now();
    let disconnected = false;
    res.once?.('close', () => { if (!res.writableFinished) disconnected = true; });
    return route(req, res).catch((e) => {
      const network = e?.network === true || e?.name === 'PassportError';
      try { logger.warn('route error:', req.method, new URL(req.url, 'http://localhost').pathname, e?.message ?? e); }
      catch { console.error('Database error log could not be saved'); }
      if (res.headersSent || res.writableEnded) return res.end();
      return openError(res, network ? 502 : 500, redact(String(e?.message ?? e)), 'upstream_error');
    }).finally(() => {
      if (!database) return;
      try {
        const requestPath = new URL(req.url, 'http://localhost').pathname;
        database.addLog({ kind: 'http', method: req.method, path: logger.redact ? logger.redact(requestPath) : requestPath,
          status: disconnected ? 499 : res.statusCode ?? 200, duration_ms: Date.now() - started, message: '', level: (res.statusCode ?? 200) >= 500 ? 'error' : disconnected || (res.statusCode ?? 200) >= 400 ? 'warn' : 'info' });
      } catch { console.error('Database request log could not be saved'); }
    });
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const database = openDatabase({ root: ROOT });
  const accountStore = database.store('accounts');
  const loaded = accountStore.load();
  const deviceId = loaded.default_device_id ?? '';
  const adminToken = resolveAdminToken({ store: database.store('admin') });
  const envKeys = (process.env.API_KEYS ?? '').split(',').filter(Boolean);
  const keyRing = createKeyRing({ store: database.store('keys'), envKeys });
  const logger = createDatabaseLogger(database, { secrets: () => [adminToken, ...envKeys,
    ...database.store('keys').load().keys.map((k) => k.key), ...(pool?.accounts ?? []).flatMap((a) => [a.client.bduss, a.client.stoken])] });
  const pool = new Pool(loaded.accounts, { sessionStore: database.store('sessions'), database, logger });
  for (const a of pool.accounts) a.deviceId = deviceId;
  const ledger = database.ledger;
  // Daily free-point claiming stays OFF unless the operator turned it on in SQLite or
  // explicitly asked for it at boot with AUTO_CLAIM=1. It writes to the Baidu account and spends
  // one real turn per account, so it must never be a surprise background behaviour.
  const autoClaim = createAutoClaim({ pool, store: database.store('settings'), logger, envEnabled: process.env.AUTO_CLAIM === '1' });
  const app = createApp({
    pool,
    keyRing,
    adminToken,
    store: accountStore,
    deviceId,
    ledger,
    autoClaim,
    database,
    logger,
  });
  autoClaim.start();
  database.prune();
  const pruneTimer = setInterval(() => {
    try { database.prune(); } catch { console.error('Database retention cleanup failed'); }
  }, 60 * 60_000);
  pruneTimer.unref();
  if (autoClaim.state.enabled) logger.log(`auto-claim: on, daily at ${String(autoClaim.state.hour).padStart(2, '0')}:00`);
  const acct = pool.pick({ allowUnavailable: true });
  if (acct) await pool.refreshModelIndex(acct);
  const catalog = getCachedCatalog();
  logger.log(`models: ${catalog?.model_list?.length ?? 0}`);
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer(app).listen(port, '127.0.0.1', () => logger.log(`kuku2api on http://127.0.0.1:${port}; storage=sqlite`));
  const shutdown = () => { autoClaim.stop(); clearInterval(pruneTimer); server.close(() => { database.close(); process.exit(0); }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
