function base() {
  return process.env.KUKU_BASE_URL ?? 'https://kuku.baidu.com';
}
const APP_ID = '123971023';
const CLIENT_TYPE = '401';
const VERSION = '1.6.5.130';
const UA = 'genflow;1.6.5;PC;PC-Windows;10.0.26200;GenFlowPro';
const CHANNEL = 'kuku_pc_genflowpro_v1';
const PROTOCOL_V = 'cd1755270722192e4536f605';

function logid() {
  return Buffer.from(`${Math.floor(Date.now() / 1000)},${1000 + Math.floor(Math.random() * 89999)}`).toString('base64');
}

function qs(extra = {}) {
  const p = new URLSearchParams({
    app_id: APP_ID,
    clienttype: CLIENT_TYPE,
    channel: '00000000000000000000000000000000',
    version: VERSION,
    logid: logid(),
    ...extra,
  });
  return p.toString();
}

export class UpstreamError extends Error {
  constructor(message, { code, status, body, network = false, insufficient_balance = false, retryUnsafe = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.body = body;
    this.network = network;
    this.retryUnsafe = retryUnsafe;
    // Set when upstream answered with COMMERCIAL/insufficient_balance: the account is out of
    // points, which is a pool-scheduling fact, not a request error.
    this.insufficient_balance = insufficient_balance;
  }
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkError(error, signal, retryUnsafe = false) {
  const timeout = signal.aborted && signal.reason?.name === 'TimeoutError';
  return new UpstreamError(timeout ? '上游请求超时；结果可能尚未确认，请先刷新任务和余额，不要自动重试对话' : `network: ${error.message}`, {
    network: true, code: timeout ? 'upstream_timeout' : undefined, status: timeout ? 504 : 502, retryUnsafe,
  });
}

export class KukuAccount {
  constructor(rec, { requestTimeoutMs = 30_000, streamTimeoutMs = 180_000 } = {}) {
    this.bduss = '';
    this.stoken = '';
    this.setCredential(rec);
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
  }

  setCredential({ bduss, stoken } = {}) {
    const clean = (v) => String(v ?? '').replace(/[\s;]/g, '');
    // Validate against a copy: assigning first would leave a rejected rotation having blanked
    // the working credential (partial bodies rotate only one half of the pair).
    const nextBduss = bduss !== undefined ? clean(bduss) : this.bduss;
    const nextStoken = stoken !== undefined ? clean(stoken) : this.stoken;
    if (!nextBduss || !nextStoken) throw new Error('bduss/stoken required');
    this.bduss = nextBduss;
    this.stoken = nextStoken;
  }

  headers(extra = {}) {
    return {
      Cookie: `BDUSS=${this.bduss}; STOKEN=${this.stoken}; gfprotpl=genflowpro`,
      'User-Agent': UA,
      Accept: '*/*',
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  // Business failure arrives as HTTP 200 + status.code != 0. Never trust the status code alone.
  // `form` sends an urlencoded body instead of JSON: the freepoint task endpoints are form-only.
  async json(path, { method = 'GET', body, form, query, signal } = {}) {
    const url = `${base()}${path}?${qs(query)}`;
    const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
    const headers = form ? this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }) : this.headers();
    const deadline = requestSignal(signal, this.requestTimeoutMs);
    let res, text;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: deadline });
      text = await res.text();
    } catch (e) {
      throw networkError(e, deadline, path === '/wenchain/genflowpro/sendmsg');
    }
    if (!res.ok) throw new UpstreamError(`http ${res.status}`, { status: res.status, body: text });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UpstreamError('non-json body', { status: res.status, body: text });
    }
    // Two different success envelopes live upstream: `/wenchain/*` and `/bizapi/*` answer
    // `{status:{code}}`, while `/api/genflowpro/*` answers `{errno,show_msg}` with no status
    // block at all. Treating only the first one makes a healthy errno response look like a
    // failure, which is how "these endpoints need signing" got mis-concluded earlier.
    const st = parsed.status;
    const code = st ? st.code : parsed.errno;
    if (code !== 0) {
      const msg = (st ? st.msg : parsed.show_msg ?? parsed.errmsg) ?? '';
      throw new UpstreamError(`code=${code} ${msg}`, { code, status: res.status, body: parsed });
    }
    return parsed.data ?? {};
  }

  allocateIds(channel = 'genfp', genType = 3, { signal } = {}) {
    return this.json('/wenchain/genflow/idallochstr', { method: 'POST', body: { channel, gen_type: genType }, signal });
  }

  modelList() {
    return this.json('/wenchain/genflowpro/model/list', { query: { channel: 'genfp' } });
  }

  // Read-only, costs no points, and — unlike idallochstr, which is not auth-checked —
  // answers 1000004 "not login" for a dead credential. This is the pool liveness probe.
  probe() {
    return this.json('/wenchain/genflowpro/clientmessage/list', { method: 'POST', body: {} });
  }

  // The native client uses settings/profile.uk as its stable user ID. A new login may
  // mint different cookies, so credentials and local account IDs cannot identify a user.
  async userIdentity() {
    const { uk } = await this.json('/api/genflowpro/settings/profile');
    if (typeof uk === 'number' && (!Number.isSafeInteger(uk) || uk <= 0)) throw new Error('Invalid upstream user identity');
    if (!['string', 'number'].includes(typeof uk) || !/^[1-9][0-9]{0,63}$/.test(String(uk))) throw new Error('Invalid upstream user identity');
    return String(uk);
  }

  // The real balance endpoint, on a third path family (`/bizapi/gfpro/*`) that we now know
  // needs no native signing params: cookies alone return status.code 0.
  // Envelope differs from freepoint/* — this one does carry status.code, so json() fits.
  vipRemain() {
    return this.json('/bizapi/gfpro/getgfvipremain');
  }

  // Normal desktop authentication reports activity before completing onboarding.
  // Return only the identity/new-user flag; the response also contains private session data.
  async desktopLoginReport(context) {
    const d = await this.json('/api/genflowpro/common/userreport', { query: {
      devuid: context.devuid, clienttype: context.clienttype, version: context.version,
      channel: context.channel, win64: context.win64, app_id: APP_ID,
    } });
    const isNew = d.is_new === true || d.is_new === 1 || d.is_new === '1' ? true
      : d.is_new === false || d.is_new === 0 || d.is_new === '0' ? false : null;
    return { is_new: isNew, upstream_user_id: String(d.uk ?? '') };
  }

  // The client's own conversation list. Measured: cookies only, empty body works; `{offset,size}`
  // is honoured (default size 20); a dead credential gives errno -6 "未登录".
  sessionList({ offset = 0, size = 20 } = {}) {
    return this.json('/api/genflowpro/workspace/getsessionlist', { method: 'POST', body: { offset, size } });
  }

  // Legacy local rows have no historical user identity. Confirm current credentials can
  // access that exact upstream session before attaching one to a verified account.
  async ownsSession(sessionId) {
    const d = await this.json('/api/genflowpro/workspace/getsessiondetail', {
      method: 'POST', body: { session_id: sessionId, offset: 0, size: 0 },
    });
    return d.session_id != null && String(d.session_id) === String(sessionId);
  }

  // Free-point task list. Read-only. Shape measured from the client's own capture:
  // data.activities[].tabs[].tasks[] with task_key/task_type/task_status/single_reward_point.
  freePointHome() {
    return this.json('/api/genflowpro/freepoint/homenew');
  }

  // Claiming is a WRITE on the account, so it is only ever reached from an explicit admin route
  // or an operator-enabled schedule — never from the inference path.
  // Measured contract (captured): `activity_key=…&period_id=…&task_key=…` form body, answer
  // `{claim_status:"SUCCESS", claimed_point:50}`. taskComplete is NOT the claim — it only reports
  // task progress. Its reward_point is not proof of payment; verify rewardClaim and the balance.
  claimReward({ activity_key, period_id, task_key }) {
    return this.json('/api/genflowpro/freepoint/rewardClaim', {
      method: 'POST',
      form: { activity_key, period_id: String(period_id), task_key },
    });
  }

  // Report that a task type was performed (the client also reports CHAT on GenerateComplete).
  // Body is form-encoded: `task_type=LOGIN&device_id=<the numeric id the client uses>`.
  claimTask({ task_type, device_id, auto_claim }) {
    return this.json('/api/genflowpro/freepoint/taskComplete', { method: 'POST', form: {
      task_type, device_id, ...(auto_claim === true ? { auto_claim: 'true' } : {}),
    } });
  }

  sendmsg({ session_id, reply_id, client_session_id, device_id, text, model_name, model_display_name, think_mode, project_type = 1, signal }) {
    const block = { id: 'textId', version: '1.0', type: 'text', text, data: { content: text } };
    const data = {
      project_type,
      text,
      rich_input_params: [block],
      fsid: [],
      quotes: [],
      skills: [],
      experts: [],
      model_name,
      model_display_name,
      think_mode: Number(think_mode),
      show_text: '',
      device_id,
      premake_data: {},
      custom_instructions: '',
      memory_sign: true,
      skill_dig_sign: true,
      client_added: JSON.stringify({
        client_session_id,
        permission_type: 0,
        clienttype: CLIENT_TYPE,
        version: VERSION,
        device_os: 'windows',
      }),
    };
    const envelope = {
      type: 'message',
      sub_type: 'chat_create',
      client_session_id,
      session_id,
      reply_id,
      uk: '',
      cid: 0,
      channel: CHANNEL,
      device_type: Number(CLIENT_TYPE),
      created_at: Date.now(),
      msg_type: 1,
      sync_type: 0,
      sync_id: '',
      v: PROTOCOL_V,
      data,
    };
    return this.json('/wenchain/genflowpro/sendmsg', { method: 'POST', body: envelope, signal });
  }

  // Yields parsed SSE frames. Resume semantics live upstream: msg_id carries the last seen frame id.
  async *sse({ text, session_id, reply_id, client_session_id, device_id, model_name, model_display_name, think_mode, msg_id, signal }) {
    const payload = {
      project_type: 1,
      text,
      rich_input_params: [{ id: 'textId', version: '1.0', type: 'text', text, data: { content: text } }],
      fsid: [],
      quotes: [],
      skills: [],
      experts: [],
      model_name,
      model_display_name,
      think_mode: Number(think_mode),
      show_text: '',
      device_id,
      premake_data: {},
      session_id,
      custom_instructions: '',
      memory_sign: true,
      skill_dig_sign: true,
      msg_type: 1,
      reply_id,
      client_session_id,
      traceparent: '',
      ...(msg_id ? { msg_id } : {}),
    };
    const url = `${base()}/wenchain/genflowpro/sse/getchatcontent?${qs()}`;
    const controller = new AbortController();
    const deadline = requestSignal(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, this.streamTimeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: deadline });
      if (!res.ok) throw new UpstreamError(`http ${res.status}`, { status: res.status });
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('event-stream')) {
        const body = await res.text();
        let code;
        try {
          code = JSON.parse(body).status?.code;
        } catch {}
        throw new UpstreamError(`expected event-stream, got ${ctype}`, { code, body });
      }

      let buf = '';
      const dec = new TextDecoder('utf-8');
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buf))) {
          const blk = buf.slice(0, separator.index);
          buf = buf.slice(separator.index + separator[0].length);
          const frame = parseSseBlock(blk);
          if (frame) yield frame;
        }
      }
      if (buf.trim()) {
        const frame = parseSseBlock(buf);
        if (frame) yield frame;
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw networkError(e, deadline, true);
    } finally {
      controller.abort(); // Returning at a terminal frame must also release the live upstream body.
    }
  }
}

export function parseSseBlock(block) {
  let event, id;
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  if (raw.trim() === '[DONE]') return { event: 'done', id };
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  return { event, id, data: json };
}

// Frames are ordered by "<epoch_ms>-<seq>"; lexicographic compare is wrong across digit counts.
export function cmpFrameId(a, b) {
  const [am, as] = String(a ?? '0-0').split('-').map(Number);
  const [bm, bs] = String(b ?? '0-0').split('-').map(Number);
  return am !== bm ? am - bm : (as ?? 0) - (bs ?? 0);
}
