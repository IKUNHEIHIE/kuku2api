import { UpstreamError } from './upstream.mjs';

const neutral = new Set(['agent_continuation_unavailable','invalid_tool_response','session_account_mismatch','session_history_unavailable','account_unavailable','upstream_requires_client','invalid_image','unsafe_image_url','image_too_large','image_download_failed','image_upload_failed','image_rejected']);
const reasons = { network: '上游连接暂不可用', access: '上游访问受限，未确认登录失效', model: '上游模型生成暂时失败' };
const delayFor = count => Math.min(120_000, 10_000 * 2 ** Math.min(4, count - 1));

// Process-local recovery state only; no prompts, cookies or raw upstream bodies are retained.
export function createPoolRecovery(pool, now = Date.now) {
  const shared = new Map(), probes = new Map();
  let sequence = 0;
  const live = account => pool.accounts.find(a => a.id === account.id && a.upstream_user_id === account.upstream_user_id &&
    a.client.bduss === account.client.bduss && a.client.stoken === account.client.stoken);
  const blocks = model => [...shared.values()].filter(s => s.scope === 'upstream' || s.model === model);
  const blockedError = (ms, reason) => Object.assign(new Error(`${reason}，请在 ${Math.ceil(ms / 1000)} 秒后重试`), {
    status: 503, code: 'pool_cooling_down', retry_after_ms: Math.max(1, Math.ceil(ms)),
  });
  function check(model, ownRecovery = false) {
    const at = now(), blocked = blocks(model).filter(s => s.until > at || (s.recovering && !ownRecovery));
    if (blocked.length) throw blockedError(Math.max(...blocked.map(s => Math.max(1000, s.until - at))), '上游暂时退避中');
  }
  async function confirm403(account) {
    const previous = probes.get(account.id);
    if (previous?.client === account.client && (previous.pending || now() - previous.at < 30_000)) return previous.result;
    const entry = { client: account.client, at: now(), pending: true };
    entry.result = account.client.probe().then(() => false, error => pool.isAuthFailure(error)).finally(() => { entry.pending = false; entry.at = now(); });
    probes.set(account.id, entry);
    return entry.result;
  }
  async function failure(account, error, model) {
    if (error?.poolFailureHandled) return error.poolStopRetry;
    const stop = error?.persistence || error?.retryUnsafe === true || pool.isClientParamError(error);
    Object.defineProperties(error, { poolFailureHandled: { value: true }, poolStopRetry: { value: !!stop } });
    if (error?.persistence || neutral.has(error?.code)) return !!stop;
    let current = live(error.failureAccount ?? account);
    if (!current) return !!stop;
    if (pool.isInsufficientBalance(error)) { pool.markBalanceDead(current); return !!stop; }
    if (pool.isAuthFailure(error)) { pool.markAuthDead(current, error.code); return !!stop; }
    if (pool.isClientParamError(error)) return !!stop;
    if (error?.status === 403) {
      const confirmed = await confirm403(current);
      current = live(current); // An administrator may rotate credentials during the read.
      if (!current) return !!stop;
      if (confirmed) { pool.markAuthDead(current); return !!stop; }
    }
    if (!(error instanceof UpstreamError) && !error?.network) return !!stop;
    const category = error.network ? 'network' : error.status === 403 || error.status === 429 ? 'access' : 'model';
    const at = now(), code = typeof error.code === 'number' && Number.isFinite(error.code) ? String(error.code) : category === 'network' ? 'upstream_network_error' : category === 'access' ? 'upstream_access_restricted' : 'upstream_turn_error';
    current.consecutive_failures = at - (current.last_failure_at ?? 0) <= 300_000 ? (current.consecutive_failures ?? 0) + 1 : 1;
    current.last_failure_at = at; current.last_error_code = code; current.cooldown_reason = reasons[category];
    current.last_failure_seq = ++sequence;
    current.cooldown_until = at + Math.min(pool.cooldownMs, delayFor(current.consecutive_failures));
    // Two distinct accounts with the same failure class identify a shared problem.
    // Network/access failures affect the connection; generation failures affect only this model.
    const key = category === 'model' ? `model:${model}` : `upstream:${category}`;
    for (const [k, s] of shared) if (!s.recovering && at - s.last_at > 300_000 && s.until <= at) shared.delete(k);
    if (!shared.has(key)) {
      if (shared.size >= 64) { const victim = [...shared].find(([,s]) => !s.recovering); if (victim) shared.delete(victim[0]); }
      shared.set(key, { scope: category === 'model' ? 'model' : 'upstream', model: category === 'model' ? model : null, reason: reasons[category], failures: new Map(), trips: 0, until: 0, last_at: at, recovering: false });
    }
    const state = shared.get(key);
    for (const [id, time] of state.failures) if (at - time > 30_000) state.failures.delete(id);
    state.failures.set(current.id, at); state.last_at = at;
    state.last_seq = sequence;
    if (state.failures.size >= 2) { state.trips++; state.until = at + Math.min(60_000, delayFor(state.trips)); }
    try { pool.logger.warn?.('pool recovery:', JSON.stringify({ account: current.id, model, reason: category, code, failures: current.consecutive_failures, cooldown_ms: current.cooldown_until - at, shared_cooldown_ms: Math.max(0, state.until - at) })); } catch { /* Diagnostics must not replace the upstream error. */ }
    return !!stop;
  }
  function success(account, model, started, revision) {
    const current = live(account);
    if (current && (current.last_failure_at ?? 0) <= started && (revision === undefined || (current.last_failure_seq ?? 0) <= revision)) {
      current.consecutive_failures = 0; current.last_failure_at = 0; current.last_error_code = null; current.cooldown_reason = null;
      if (!current.auth_dead) current.cooldown_until = 0;
    }
    for (const [key, state] of shared) if ((state.scope === 'upstream' || state.model === model) && state.last_at <= started && (revision === undefined || state.last_seq <= revision)) shared.delete(key);
  }
  return {
    failure, success, check, blockedError,
    get revision() { return sequence; },
    get state() { const at = now(); return [...shared.values()].filter(s => s.until > at || s.recovering).map(s => ({ scope: s.scope, model: s.model, reason: s.reason, retry_after_ms: Math.max(1000, s.until - at), recovering: s.recovering })); },
    reset() { shared.clear(); probes.clear(); },
    async run(model, work, bypass = false) {
      if (bypass) return work(false);
      check(model);
      const recovering = blocks(model).filter(s => s.trips > 0);
      for (const state of recovering) state.recovering = true;
      try { return await work(recovering.length > 0); } finally { for (const state of recovering) state.recovering = false; }
    },
  };
}
