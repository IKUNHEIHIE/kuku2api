// Pool client for SCNet (超算互联网). Implements the same surface the pool relies on
// (probe / userIdentity / modelList / vipRemain) plus a chat that speaks the upstream's
// OpenAI-compatible protocol. Only the free activity key is ever used.
import { UpstreamError } from './upstream.mjs';
import { scnetPassport, SCNET_MODEL } from './scnet-passport.mjs';

const ABORTED = 'AbortError';

const EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' };

// Upstream exposes low/high/max levels; map the OpenAI-style effort onto them.
export function reasoningEffortOf(body = {}) {
  const raw = String(body?.reasoning_effort ?? body?.reasoning?.effort ?? '').toLowerCase();
  if (raw && EFFORT_MAP[raw]) return EFFORT_MAP[raw];
  const think = String(body?.think_mode ?? '').toLowerCase();
  if (think && EFFORT_MAP[think]) return EFFORT_MAP[think];
  return null;
}

function llmError(status, data, text) {
  const message = String(data?.error?.message ?? data?.message ?? text ?? '上游推理失败').slice(0, 300);
  if (status === 401) return new UpstreamError(message, { code: '401', status: 401 });
  if (status === 402) return new UpstreamError(message, { code: '402', status: 402, insufficient_balance: true });
  return new UpstreamError(message, { code: data?.error?.code ? String(data.error.code) : undefined, status: status >= 500 ? 502 : status });
}

export async function readJsonResponse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new UpstreamError(`上游返回了非 JSON 响应 (HTTP ${res.status})`, { status: 502, body: text.slice(0, 200) });
  }
}

// Parses `data: {...}` SSE frames; stops at [DONE].
export async function* sseFrames(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    return payload === '[DONE]' ? '[DONE]' : payload;
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const payload = take(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (payload === '[DONE]') return;
      if (payload) { try { yield JSON.parse(payload); } catch { /* keep-alives and partial frames */ } }
    }
  }
  const tail = take(buffer);
  if (tail && tail !== '[DONE]') { try { yield JSON.parse(tail); } catch { /* ignore */ } }
}

function mergeToolCalls(acc, deltas) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta?.index) ? delta.index : acc.length;
    const current = (acc[index] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } });
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
  }
  return acc;
}

export class ScnetAccount {
  constructor(rec = {}, { passport = scnetPassport } = {}) {
    this.accessToken = '';
    this.apiKey = '';
    this.cookies = [];
    this.setCredential(rec);
    this.passport = passport;
  }

  get platform() { return 'scnet'; }

  setCredential({ access_token, api_key, cookies, accessToken, apiKey } = {}) {
    const nextToken = accessToken !== undefined ? accessToken : access_token !== undefined ? access_token : this.accessToken;
    const nextKey = apiKey !== undefined ? apiKey : api_key !== undefined ? api_key : this.apiKey;
    const nextCookies = cookies !== undefined ? cookies : this.cookies;
    if (typeof nextToken !== 'string' || !nextToken) throw new Error('scnet access_token required');
    if (typeof nextKey !== 'string' || !nextKey) throw new Error('scnet api_key required');
    this.accessToken = nextToken;
    this.apiKey = nextKey;
    this.cookies = Array.isArray(nextCookies) ? nextCookies.map(String).filter(Boolean) : this.cookies;
  }

  cookieHeader() { return this.cookies.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; '); }

  // Zero-cost liveness: `/models` answers 200 only for an accepted key.
  async probe(signal) {
    const res = await this.passport.models({ apiKey: this.apiKey, signal });
    if (res.status === 200) return { ok: true };
    const text = await res.text().catch(() => '');
    let data = null; try { data = JSON.parse(text); } catch { /* keep raw */ }
    throw llmError(res.status, data, text);
  }

  async userIdentity(signal) {
    const { data } = await this.passport.currentUser({ token: this.accessToken, cookies: this.cookies, signal });
    const id = String(data?.id ?? '');
    if (!/^[1-9][0-9]{0,63}$/.test(id)) throw new UpstreamError('超算互联网账号身份无效', { status: 502 });
    return id;
  }

  async clusters(signal) {
    return this.passport.clusters({ token: this.accessToken, cookies: this.cookies, signal });
  }

  async activityKey(signal) {
    const { apiKey } = await this.passport.activityApiKey({ token: this.accessToken, cookies: this.cookies, signal });
    return apiKey;
  }

  // Keep-alive + session cookies roll-over. Returns the refreshed cookie jar (may be unchanged).
  async keepAlive(signal) {
    const { cookies } = await this.passport.currentUser({ token: this.accessToken, cookies: this.cookies, refresh: true, signal });
    this.cookies = cookies;
    return cookies;
  }

  async balance(signal) {
    return this.passport.balance({ token: this.accessToken, cookies: this.cookies, signal });
  }

  // The model index is Baidu-specific; an empty list keeps the shared refresh path inert.
  async modelList() { return { model_list: [] }; }

  // Points UI is Baidu-specific too. No assets means "unknown", never "empty".
  async vipRemain() { return {}; }

  async chat({ messages, params = {}, onDelta = () => {}, signal } = {}) {
    const wantsStream = params.stream === true;
    const body = {
      model: SCNET_MODEL,
      messages,
      stream: wantsStream,
      ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
      ...(Number.isFinite(params.maxTokens) ? { max_completion_tokens: params.maxTokens } : {}),
      ...(Number.isFinite(params.temperature) ? { temperature: params.temperature } : {}),
      ...(Number.isFinite(params.topP) ? { top_p: params.topP } : {}),
      ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
      ...(Array.isArray(params.tools) && params.tools.length ? { tools: params.tools } : {}),
      ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
      ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    };
    const res = await this.passport.chat({ apiKey: this.apiKey, body, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data = null; try { data = JSON.parse(text); } catch { /* keep raw */ }
      throw llmError(res.status, data, text);
    }
    if (!wantsStream) {
      const data = await readJsonResponse(res);
      const choice = data?.choices?.[0] ?? {};
      const message = choice.message ?? {};
      return {
        id: data?.id ?? null,
        content: typeof message.content === 'string' ? message.content : '',
        reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
        usage: data?.usage ?? null,
        finish_reason: choice.finish_reason ?? 'stop',
      };
    }
    let content = '', reasoning = '', usage = null, finish = null;
    let toolCalls = [];
    for await (const frame of sseFrames(res.body)) {
      if (signal?.aborted) throw Object.assign(new Error('client disconnected'), { name: ABORTED, status: 499 });
      if (frame?.usage) usage = frame.usage;
      const choice = frame?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};
      const out = {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        out.reasoning_content = delta.reasoning_content;
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        out.content = delta.content;
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        toolCalls = mergeToolCalls(toolCalls, delta.tool_calls);
        out.tool_calls = delta.tool_calls;
      }
      if (Object.keys(out).length) onDelta(out);
    }
    return { content, reasoning, tool_calls: toolCalls.length ? toolCalls : undefined, usage, finish_reason: finish ?? 'stop' };
  }
}