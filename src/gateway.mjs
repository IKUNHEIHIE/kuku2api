import { KukuAccount, UpstreamError } from './upstream.mjs';

export function frameToDelta(frame) {
  const d = frame?.data;
  if (!d || typeof d !== 'object') return null;
  switch (d.type) {
    case 'TEXT_BLOCK_DELTA':
      return { content: d.data?.delta ?? '' };
    case 'THINKING_BLOCK_DELTA':
      return { reasoning_content: d.data?.delta ?? '' };
    case 'MODEL_CALL_END': {
      const u = d.data ?? {};
      return {
        usage: {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          reasoning_tokens: u.reasoning_tokens ?? 0,
          cache_read_tokens: u.cache_read_tokens ?? 0,
        },
        finish_reason: mapFinish(u),
      };
    }
    case 'ACTUAL_POINT':
      return { consume_points: d.data?.consume_points ?? null };
    case 'REQUIRE_EXTERNAL_EXECUTION':
    case 'AWAITING_INPUT':
      return { requires_client: true };
    // Measured on a drained account: instead of any text it answers COMMERCIAL_NOTICE
    // (reason/text) then COMMERCIAL (errno 11002) then TURN_DONE. Ignoring these used to hand
    // the client an HTTP 200 with empty content, which reads as "the model said nothing".
    case 'COMMERCIAL_NOTICE':
      return { commercial: { reason: d.data?.reason ?? null, text: d.data?.text ?? '', errno: null } };
    case 'COMMERCIAL':
      return { commercial: { reason: d.data?.reason ?? null, text: '', errno: d.data?.errno ?? null } };
    case 'ERROR':
    case 'STREAM_ERROR':
      return { error: d.data ?? {} };
    default:
      return null;
  }
}

function mapFinish(u) {
  const r = u.finished_reason ?? (Array.isArray(u.finish_reasons) ? u.finish_reasons[0] : undefined);
  if (!r || r === 'completed' || r === 'stop') return 'stop';
  if (r === 'length') return 'length';
  return r;
}

// freepoint/homenew nests three deep (activities -> tabs -> tasks); every caller wants the flat
// list, and `claimable_point` is the only field that says "claimable now".
export function flattenTasks(data) {
  const out = [];
  for (const activity of data?.activities ?? []) {
    for (const tab of activity?.tabs ?? []) {
      for (const t of tab?.tasks ?? []) {
        out.push({
          activity_key: activity.activity_key ?? null,
          // rewardClaim needs this exact pairing; it arrives as period_no and is sent as period_id.
          period_id: Number(activity.period_no ?? 0),
          tab_key: tab.tab_key ?? null,
          task_key: t.task_key ?? null,
          task_name: t.task_name ?? null,
          task_type: t.task_type ?? null,
          task_status: t.task_status ?? null,
          reward_point: Number(t.single_reward_point ?? 0),
          max_reward_point: Number(t.max_reward_point ?? 0),
          claimable_point: Number(t.claimable_point ?? 0),
        });
      }
    }
  }
  return out;
}

export function messagesToText(messages) {  const turns = messages
    .filter((m) => typeof m.content === 'string' && m.content.length)
    .map((m) => `${m.role}: ${m.content}`);
  return turns.join('\n\n');
}

export function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function makeChunk(id, created, model, delta, finish_reason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

export class Pool {
  constructor(accounts = [], { cooldownMs = 5 * 60_000, authCooldownMs = 60 * 60_000, balanceRetryMs = 10 * 60_000, sessionStore = null, database = null, logger = console } = {}) {
    this.database = database;
    this.logger = logger;
    this.cooldownMs = cooldownMs;
    this.authCooldownMs = authCooldownMs;
    // Measured: a freshly minted STOKEN can answer 11002 for a few minutes and then serve fine
    // (07:47 read 0 points, 07:49 turn refused, 07:57 the same credential had 648.86 and cost
    // 0.17). So "out of points" retries on a window instead of latching until someone resets it.
    this.balanceRetryMs = balanceRetryMs;
    this.queues = new Map();
    this.sessions = new Map();
    this.sessionStore = sessionStore;
    // Upstream history lives on the session_id, not in our process: without restoring the
    // key -> session map, a restart silently starts a fresh upstream session while
    // previous_response_id still resolves, so the caller sees HTTP 200 and a lobotomized answer.
    if (sessionStore) {
      try {
        for (const s of sessionStore.load().sessions ?? []) {
          if (s?.key && s?.session_id) this.sessions.set(s.key, { session_id: s.session_id, client_session_id: s.client_session_id ?? '', turn: Number(s.turn ?? 0),
            account: s.account ?? null, upstream_user_id: s.upstream_user_id ?? null, logical_key: s.logical_key ?? null });
        }
      } catch (e) {
        if (sessionStore.immediate) throw e;
        this.logger.warn('session store unreadable:', e.message);
      }
    }
    this.set(accounts);
  }

  persistSessions() {
    if (!this.sessionStore) return;
    if (this.sessionStore.immediate) {
      this.sessionStore.save({ sessions: [...this.sessions.entries()].map(([key, s]) => ({ key, ...s })) });
      return;
    }
    if (this._sessionTimer) clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => {
      this._sessionTimer = null;
      const sessions = [...this.sessions.entries()].map(([key, s]) => ({ key, ...s }));
      this.sessionStore.save({ sessions });
    }, 500);
    this._sessionTimer.unref?.();
  }

  // Rebuilding the list must not launder runtime state: adding or editing one account used to
  // clear every other account's cooldown, dead-login and out-of-points flags, which sends traffic
  // straight back at accounts upstream has already refused.
  set(accounts) {
    const prev = new Map((this.accounts ?? []).map((a) => [a.id, a]));
    this.accounts = accounts.map((a, i) => {
      const old = prev.get(a.id);
      return {
        id: a.id ?? `acct-${i}`,
        alias: a.alias ?? a.id ?? `acct-${i}`,
        priority: Number.isFinite(a.priority) ? a.priority : 9999,
        disabled: !!a.disabled,
        upstream_user_id: a.upstream_user_id ?? null,
        cooldown_until: old?.cooldown_until ?? 0,
        auth_dead: old?.auth_dead ?? false,
        balance_dead_until: old?.balance_dead_until ?? 0,
        client: new KukuAccount(a),
      };
    });
    this.accounts.sort((x, y) => x.priority - y.priority);
  }

  // Drain the lowest priority number completely before touching the next one.
  // Round-robin over the sorted list silently degrades into weighted polling.
  pick({ allowUnavailable = false, exclude = [] } = {}) {
    const now = Date.now();
    for (const a of this.accounts) {
      if (exclude.includes(a.id)) continue;
      if (!allowUnavailable && this.isUnavailable(a, now)) continue;
      return a;
    }
    return null;
  }

  isUnavailable(a, now = Date.now()) {
    return Boolean(a.disabled || a.auth_dead || a.balance_dead_until > now || a.cooldown_until > now);
  }

  cool(account, ms = this.cooldownMs) {
    account.cooldown_until = Date.now() + ms;
  }

  // A dead login state will not fix itself within a normal cooldown window.
  // Codes measured per family: /wenchain/* -> 1000004, /bizapi/* -> 200001,
  // /api/genflowpro/* -> errno -6 "未登录" (the client also treats -7/-8 as auth-class).
  isAuthFailure(err) {
    return err instanceof UpstreamError && [1000004, 200001, -6, -7, -8].includes(err.code);
  }

  markAuthDead(account) {
    account.auth_dead = true;
    account.cooldown_until = Date.now() + this.authCooldownMs;
  }

  // Measured: a drained account answers a turn with COMMERCIAL{errno:11002,
  // reason:"insufficient_balance"} and no text at all. It is not a request error and it will not
  // heal inside a cooldown window — free points refill on the upstream's own daily schedule.
  isInsufficientBalance(err) {
    return err instanceof UpstreamError && (err.insufficient_balance || Number(err.code) === 11002);
  }

  markBalanceDead(account) {
    account.balance_dead_until = Date.now() + this.balanceRetryMs;
  }

  // Client-directed account selection must not bypass the disabled/cooldown gates.
  resolve(wanted, { allowUnavailable = false } = {}) {
    const a = wanted ? (this.accounts.find(x => x.id === wanted) ?? this.accounts.find(x => x.alias === wanted)) : null;
    if (wanted && !a) throw Object.assign(new Error(`unknown account: ${wanted}`), { status: 404 });
    const acct = a ?? this.pick({ allowUnavailable });
    if (!acct) {
      // Every account excluded because upstream said "out of points": keep the 402 contract the
      // first request got, instead of degrading to a generic pool exhaustion 409.
      const drained = this.accounts.length > 0 && this.accounts.every((x) => x.balance_dead_until > Date.now());
      if (drained) throw Object.assign(new Error('积分不足，无法继续任务。'), { status: 402, insufficient_balance: true });
      throw new Error('no available account in pool');
    }
    if (!allowUnavailable && a && this.isUnavailable(a)) {
      throw Object.assign(new Error(`account ${acct.id} is unavailable`), { status: 409 });
    }
    return acct;
  }

  serialize(key, fn) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => {});
    this.queues.set(key, tail);
    return tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
      return result;
    });
  }

  // Zero-cost routine check-up: one read-only auth-checked call per account.
  async healthCheck({ only = null } = {}) {
    const targets = only ? this.accounts.filter((a) => a.id === only || a.alias === only) : this.accounts;
    const out = [];
    for (const a of targets) {
      let rec = { id: a.id, alias: a.alias, ok: false, code: null, message: '' };
      try {
        await a.client.probe();
        a.auth_dead = false;
        rec.ok = true;
      } catch (e) {
        rec.code = e.code ?? null;
        rec.message = String(e.message ?? e).slice(0, 120);
        if (this.isAuthFailure(e)) this.markAuthDead(a);
        else if (e.network) rec.unreachable = true; // link jitter must not condemn an account
      }
      out.push(rec);
    }
    return out;
  }

  // A bad request from any caller must not be able to penalise an account.
  isClientParamError(err) {
    return err instanceof UpstreamError && err.status === 400;
  }

  // Points balance. Costs nothing, but it is a real upstream call — keep it off the hot path.
  async points({ only = null } = {}) {
    const targets = only ? this.accounts.filter((a) => a.id === only || a.alias === only) : this.accounts;
    const out = [];
    for (const a of targets) {
      const rec = { id: a.id, alias: a.alias, ok: false, code: null, message: '' };
      try {
        const d = await a.client.vipRemain();
        a.auth_dead = false;
        rec.ok = true;
        rec.is_vip = !!d.isVip;
        rec.vip_type = Number(d.vipType ?? 0);
        rec.vip_end_time = Number(d.vipEndTime ?? 0) || null;
        rec.is_trial = !!d.isTrial;
        rec.assets = (d.list ?? []).map((x) => ({
          asset_type: Number(x.assetType),
          asset_name: x.assetName ?? `asset_${x.assetType}`,
          total_point: Number(x.totalPoint ?? 0),
          bonus_point: Number(x.bonusPoint ?? 0),
          vip_point: Number(x.vipPoint ?? 0),
          charge_point: Number(x.chargePoint ?? 0),
          freeze_point: Number(x.freezePoint ?? 0),
        }));
        const of = (t) => rec.assets.find((x) => x.asset_type === t)?.total_point ?? 0;
        // Inference drains `token` (fractional); the other buckets are separate quotas and
        // must never be summed into a headline balance.
        rec.balance_points = of(1);
        rec.duration_points = of(2);
        rec.scheduled_task_points = of(3);
        // Reading the balance is also the cheapest way to repair the flag: upstream refills the
        // daily free points on its own schedule, and a refilled account must rejoin rotation
        // without the operator having to clear a cooldown by hand. Condemn only on a real reading
        // of the token bucket — a success envelope with no list is "unknown", not "empty".
        const tokenBucket = rec.assets.find((x) => x.asset_type === 1);
        if (tokenBucket) a.balance_dead_until = rec.balance_points <= 0 ? Date.now() + this.balanceRetryMs : 0;
      } catch (e) {
        rec.code = e.code ?? null;
        rec.message = String(e.message ?? e).slice(0, 120);
        if (this.isAuthFailure(e)) this.markAuthDead(a);
        else if (e.network) rec.unreachable = true;
      }
      out.push(rec);
    }
    return out;
  }

  // Free-point tasks. Reading is free; `claimFreePoints` is a WRITE on the Baidu account, so it
  // is only reachable from an explicit admin route or an operator-enabled schedule.
  // Measured shape: data.activities[].tabs[].tasks[] where `claimable_point > 0` — not
  // `task_status` — is what says "this can be claimed right now".
  async freePointTasks({ only = null } = {}) {
    const targets = only ? this.accounts.filter((a) => a.id === only || a.alias === only) : this.accounts;
    const out = [];
    for (const a of targets) {
      const rec = { id: a.id, alias: a.alias, ok: false, code: null, message: '', tasks: [] };
      try {
        rec.tasks = flattenTasks(await a.client.freePointHome());
        rec.ok = true;
      } catch (e) {
        rec.code = e.code ?? null;
        rec.message = String(e.message ?? e).slice(0, 120);
        if (this.isAuthFailure(e)) this.markAuthDead(a);
        else if (e.network) rec.unreachable = true;
      }
      out.push(rec);
    }
    return out;
  }

  // Claim everything currently claimable. With `runChat`, an unclaimable CHAT task is earned
  // first by spending one low-thinking turn, then explicitly reporting its completion.
  // The official client reports CHAT on GenerateComplete. A proxied conversation alone does
  // not report progress: only this explicit earn-and-claim flow may do that write.
  async claimFreePoints({ only = null, runChat = false, chatModel = 'gateway-glm-5.3-flash', chatText = '请只回复 OK，不要调用工具或执行任何任务。' } = {}) {
    const targets = only ? this.accounts.filter((a) => a.id === only || a.alias === only) : this.accounts;
    const out = [];
    for (const a of targets) {
      // Manual and scheduled claims must re-read task state under the same account queue.
      out.push(await this.serialize(`claim:${a.id}`, async () => {
        const rec = { id: a.id, alias: a.alias, ok: false, points_earned: 0, claimed: [], reported: [], chat_turn: null, notes: [], code: null, message: '' };
        try {
          let tasks = flattenTasks(await a.client.freePointHome());
          if (runChat) {
            // The client reports its own daily login through taskComplete; mirror that so the
            // task becomes claimable. rewardClaim is what actually pays, taskComplete never does.
            const login = tasks.find((t) => t.task_type === 'LOGIN' && t.task_status !== 'FINISHED');
            if (login && Number(login.claimable_point) <= 0) {
              await a.client.claimTask({ task_type: 'LOGIN', device_id: a.deviceId });
              rec.reported.push('LOGIN');
              tasks = flattenTasks(await a.client.freePointHome());
            }
            // A CHAT task only becomes claimable after a real conversation, so earn it first.
            const chatTask = tasks.find((t) => t.task_type === 'CHAT');
            if (chatTask && chatTask.task_status !== 'FINISHED' && Number(chatTask.claimable_point) <= 0 && a.balance_dead_until <= Date.now()) {
              const turn = await this.chat({
                account: a,
                model: { id: chatModel },
                messages: [{ role: 'user', content: chatText }],
                think_mode: 1,
                source: 'claim',
                // Reward earning is one short standalone turn; old paused tool workflows must
                // never be resumed by today's claim or pollute its completion events.
                sessionKey: `claim:${a.id}:${crypto.randomUUID()}`,
              });
              rec.chat_turn = { ran: true, consume_points: turn.consume_points ?? null };
              // Report only after a successful turn; taskComplete is progress, rewardClaim pays.
              const report = await a.client.claimTask({ task_type: 'CHAT', device_id: a.deviceId });
              if (report?.complete_status === 'SUCCESS') rec.reported.push('CHAT');
              else rec.notes.push(`对话已完成，但上游对话任务上报未成功（${report?.complete_status ?? 'unknown'}）`);
              tasks = flattenTasks(await a.client.freePointHome());
              const after = tasks.find((t) => t.task_type === 'CHAT');
              if (after && Number(after.claimable_point) <= 0) {
                rec.notes.push(`已完成一轮对话并尝试上报，但上游仍未把 ${after.task_key} 计入可领；请稍后刷新任务列表，不要重复发送对话`);
              }
            }
          }
          for (const t of tasks.filter((x) => Number(x.claimable_point) > 0)) {
            const r = await a.client.claimReward({ activity_key: t.activity_key, period_id: t.period_id, task_key: t.task_key });
            if (r?.claim_status !== 'SUCCESS') throw new UpstreamError(`reward claim ${t.task_key} failed: ${r?.claim_status ?? 'unknown'}`);
            rec.claimed.push({
              task_key: t.task_key,
              task_type: t.task_type,
              claimed_point: Number(r?.claimed_point ?? 0),
              claim_status: r?.claim_status ?? null,
            });
            rec.points_earned += Number(r?.claimed_point) || 0;
          }
          rec.ok = true;
          rec.tasks_after = flattenTasks(await a.client.freePointHome().catch(() => ({})));
        } catch (e) {
          rec.code = e.code ?? null;
          rec.message = String(e.message ?? e).slice(0, 160);
          if (this.isAuthFailure(e)) this.markAuthDead(a);
          else if (this.isInsufficientBalance(e)) this.markBalanceDead(a);
          else if (e.network) rec.unreachable = true;
        }
        return rec;
      }));
    }
    return out;
  }

  // The upstream conversation list. Titles are the user's real conversation names, so this
  // stays an explicit, opt-in read — never called from the inference path.
  async sessionList({ only = null, offset = 0, size = 20 } = {}) {    const targets = only ? this.accounts.filter((a) => a.id === only || a.alias === only) : this.accounts;
    const out = [];
    for (const a of targets) {
      const rec = { id: a.id, alias: a.alias, ok: false, code: null, message: '', offset, size, total: 0, sessions: [] };
      try {
        const d = await a.client.sessionList({ offset, size });
        a.auth_dead = false;
        rec.ok = true;
        rec.total = Number(d.total ?? 0);
        rec.offset = Number(d.offset ?? offset);
        rec.size = Number(d.size ?? size);
        rec.sessions = (d.list ?? []).map((x) => ({
          session_id: x.session_id,
          title: x.title ?? '',
          status: Number(x.status ?? 0),
          session_type: Number(x.session_type ?? 0),
          is_read: Number(x.is_read ?? 0) === 1,
          ctime: Number(x.ctime ?? 0),
          mtime: Number(x.mtime ?? 0),
          // download_list carries expiring data_url values; only the count is useful here.
          artifact_count: Array.isArray(x.download_list) ? x.download_list.length : 0,
        }));
      } catch (e) {
        rec.code = e.code ?? null;
        rec.message = String(e.message ?? e).slice(0, 120);
        if (this.isAuthFailure(e)) this.markAuthDead(a);
        else if (e.network) rec.unreachable = true;
      }
      out.push(rec);
    }
    return out;
  }
  async refreshModelIndex(account, { force = false } = {}) {
    // A typo'd model id must not cost one upstream round trip per request.
    if (!force && MODEL_INDEX.size && Date.now() - lastIndexFetch < INDEX_REFRESH_MS) return;
    // The throttle above only helps once the index is populated, so a cold start with N
    // concurrent requests would otherwise fire N identical catalog fetches.
    if (indexInflight) return indexInflight;
    lastIndexFetch = Date.now();
    indexInflight = (async () => {
      const d = await account.client.modelList().catch((e) => {
        this.logger.warn('model index refresh failed:', e.message);
        return null;
      });
      // A failed fetch must not clear a working index.
      if (d?.model_list?.length) indexModels(d);
    })().finally(() => { indexInflight = null; });
    return indexInflight;
  }

  async chat(args, onDelta = () => {}, signal) {
    const logicalKey = deriveSessionKey({ sessionKey: args.sessionKey, messages: args.messages, accountId: args.account.id });
    // Every entry point (Chat, Responses, reward earning) shares this account-scoped queue.
    return this.serialize(`chat:${accountSessionKey(args.account.id, logicalKey)}`, () => this.recordedChat(args, onDelta, signal));
  }

  async recordedChat(args, onDelta, signal) {
    const started = Date.now();
    const observation = { usage_events: [] };
    let result, error;
    try { result = await this._chat(args, onDelta, signal, observation); }
    catch (e) { error = e; }
    if (this.database) {
      try {
        this.database.recordTurn({ model: args.model.id, account: args.account.id, messages: args.messages,
          session_key: deriveSessionKey({ sessionKey: args.sessionKey, messages: args.messages, accountId: args.account.id }),
          think_mode: args.think_mode, source: args.source ?? 'chat', store: args.store,
          created_at: started, duration_ms: Date.now() - started, status: error ? 'failed' : result?.cancelled ? 'cancelled' : 'completed',
          error_code: error?.code, result: result ?? observation });
      } catch {
        const failure = new Error('Database could not persist the inference record');
        failure.persistence = true; // Never spend another account's points retrying a disk failure.
        throw failure;
      }
    }
    if (error) {
      try { this.logger.warn('inference failed:', args.source ?? 'chat', args.account.id, args.model.id, error.message); }
      catch { console.error('Database inference error log could not be saved'); }
      throw error;
    }
    return result;
  }

  async _chat({ account, model, messages, sessionKey, think_mode, requiredSessionId }, onDelta = () => {}, signal, observation = { usage_events: [] }) {
    if (signal?.aborted) return { content: '', reasoning: '', usage: null, consume_points: null, usage_events: [], cancelled: true };
    const current = this.accounts.find(a => a.id === account.id);
    if (!current || current.upstream_user_id !== account.upstream_user_id) {
      throw sessionError('排队期间账号已删除或更换身份，请新建对话', 'session_account_mismatch');
    }
    account = current;
    // A cold index (startup fetch failed) would send model_name=undefined and let upstream
    // silently pick its own default, ignoring the caller's model choice.
    if (!MODEL_INDEX.has(model.id)) await this.refreshModelIndex(account);
    const cfg = MODEL_INDEX.get(model.id) ?? { model_name: model.id, display_name: model.id };
    const logicalKey = deriveSessionKey({ sessionKey, messages, accountId: account.id });
    const key = accountSessionKey(account.id, logicalKey);
    let s = this.sessions.get(key);
    if (s && (s.account !== account.id || s.logical_key !== logicalKey || (s.upstream_user_id != null && s.upstream_user_id !== account.upstream_user_id))) {
      throw sessionError('会话账号归属不匹配，请新建对话', 'session_account_mismatch');
    }
    if (!s) {
      const legacy = this.sessions.get(logicalKey);
      if (legacy) {
        // A raw legacy key is untrusted. Infer ownership only from saved account records,
        // never from a caller-controlled key prefix or whichever account asks first.
        const owners = this.database?.sessionOwners?.(legacy.session_id) ?? new Set();
        if (requiredSessionId && legacy.session_id === requiredSessionId) owners.add(account.id); // Verified ledger continuation.
        if (owners.size === 1 && owners.has(account.id) && (legacy.account == null || legacy.account === account.id)
            && (legacy.upstream_user_id == null || legacy.upstream_user_id === account.upstream_user_id)) {
          let verified;
          try { verified = await account.client.ownsSession(legacy.session_id); }
          catch { throw sessionError('历史会话归属暂时无法向上游确认，请稍后重试或新建对话', 'session_history_unavailable'); }
          if (verified) {
            s = { ...legacy, account: account.id, upstream_user_id: account.upstream_user_id ?? null, logical_key: logicalKey };
            this.sessions.set(key, s);
            try { this.persistSessions(); }
            catch (e) { this.sessions.delete(key); e.persistence = true; throw e; }
          }
        }
      }
    }
    if (requiredSessionId && (!s || s.session_id !== requiredSessionId)) {
      throw sessionError('无法确认历史会话归属或恢复原会话，请新建对话', 'session_history_unavailable');
    }
    if (!s) {
      const ids = await account.client.allocateIds('genfp', 3, { signal });
      s = {
        session_id: ids.chat_id,
        client_session_id: crypto.randomUUID(),
        turn: 0,
        account: account.id,
        upstream_user_id: account.upstream_user_id ?? null,
        logical_key: logicalKey,
      };
      this.sessions.set(key, s);
      try { this.persistSessions(); }
      catch (e) { this.sessions.delete(key); e.persistence = true; throw e; }
    }
    // Each turn gets its own reply_id; reusing one across turns rewrites the previous answer.
    const reply_id = (await account.client.allocateIds('genfp', 3, { signal })).query_id;
    Object.assign(observation, { session_id: s.session_id, reply_id });
    // The upstream session already holds history; only the newest user turn goes on the wire.
    // Re-sending the whole transcript re-bloats a ~30k system prompt and doubles point burn.
    const text = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
    const beforeSend = this.accounts.find(a => a.id === account.id);
    if (!beforeSend || beforeSend.upstream_user_id !== account.upstream_user_id) {
      throw sessionError('请求处理期间账号已删除或更换身份，请新建对话', 'session_account_mismatch');
    }
    account = beforeSend;
    await account.client.sendmsg({
      session_id: s.session_id,
      reply_id,
      client_session_id: s.client_session_id,
      device_id: account.deviceId,
      text,
      model_name: cfg.model_name,
      model_display_name: cfg.display_name,
      think_mode: think_mode ?? cfg.think_mode ?? lastCatalog?.default_think_id ?? 3,
      signal,
    });
    s.turn += 1;
    try { this.persistSessions(); }
    catch (e) { e.persistence = true; e.retryUnsafe = true; throw e; }

    let usage = null;
    let consume = null;
    let content = null;
    let reasoning = '';
    let lastEventId = null;
    let completed = false;
    for await (const frame of account.client.sse({
      text,
      session_id: s.session_id,
      reply_id,
      client_session_id: s.client_session_id,
      device_id: account.deviceId,
      model_name: cfg.model_name,
      model_display_name: cfg.display_name,
      think_mode: think_mode ?? cfg.think_mode ?? lastCatalog?.default_think_id ?? 3,
      ...(lastEventId ? { msg_id: lastEventId } : {}),
      signal,
    })) {
      if (signal?.aborted) return { ...observation, content: content ?? '', reasoning, usage, consume_points: consume, cancelled: true };
      if (frame.id) lastEventId = frame.id;
      const type = frame.data?.type;
      const frameReply = frame.data?.data?.reply_id;
      // Native streams finish with TURN_DONE/FINISH and may keep their socket open.
      // MODEL_CALL_END and REPLY_END are intermediate events, not a completed turn.
      if (frame.event === 'done' || ((type === 'TURN_DONE' || type === 'FINISH') && (frameReply == null || String(frameReply) === String(reply_id)))) {
        completed = true;
        break;
      }
      const delta = frameToDelta(frame);
      if (!delta) continue;
      if (delta.usage) { usage = delta.usage; observation.usage_events.push(delta.usage); }
      if (delta.consume_points != null) consume = delta.consume_points;
      Object.assign(observation, { usage, consume_points: consume });
      if (delta.requires_client) throw new UpstreamError('上游对话正在等待电脑客户端执行工具或补充输入，后端无法继续；请先查看任务状态，不要自动重复发送对话', {
        code: 'upstream_requires_client', status: 422, retryUnsafe: true,
      });
      if (delta.error) throw new UpstreamError(`upstream turn error`, { body: delta.error });
      if (delta.commercial) {
        const c = delta.commercial;
        const drained = c.reason === 'insufficient_balance' || Number(c.errno) === 11002;
        throw new UpstreamError(c.text || `upstream commercial notice: ${c.reason ?? c.errno ?? 'unknown'}`, {
          code: c.errno ?? null,
          body: { reason: c.reason },
          insufficient_balance: drained,
        });
      }
      if (delta.content || delta.reasoning_content) {
        if (content === null) content = '';
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        onDelta(delta);
        if (delta.content) content += delta.content;
        Object.assign(observation, { content: content ?? '', reasoning });
      }
    }
    if (!completed) throw new UpstreamError('上游对话流中断，未确认对话完成；请先刷新任务和余额，不要自动重试对话', {
      code: 'upstream_incomplete', status: 502, network: true, retryUnsafe: true,
    });
    return { content: content ?? '', reasoning, usage, consume_points: consume, session_id: s.session_id, reply_id, usage_events: observation.usage_events };
  }
}

// Two concurrent turns on one upstream session would interleave reply_ids and corrupt the
// history, so turns are serialised per session key.
export function deriveSessionKey({ sessionKey, messages, accountId }) {
  if (sessionKey) return sessionKey;
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  return `k:${accountId}:${String(firstUser).slice(0, 200)}`;
}

// Treat every external key as opaque; even a key resembling this format is encoded again.
export function accountSessionKey(accountId, logicalKey) {
  return `account-v1:${JSON.stringify([String(accountId), String(logicalKey)])}`;
}

function sessionError(message, code) {
  const error = new Error(message);
  Object.assign(error, { status: 409, code, retryUnsafe: true });
  return error;
}

export const MODEL_INDEX = new Map();
export let lastCatalog = null;
const INDEX_REFRESH_MS = 60_000;
let lastIndexFetch = 0;
let indexInflight = null;

// Fail open while the catalog endpoint is down: an empty index must not turn every
// inference request into a 400, since inference itself does not depend on model/list.
export function unknownModelId(id) {
  return MODEL_INDEX.size > 0 && !MODEL_INDEX.has(id);
}

// Measured: an out-of-range think_mode is NOT rejected by upstream — the turn runs and burns
// points on whatever the model feels like, so the caller gets a silent no-op instead of an
// error. Reject locally, with the same fail-open rule as unknownModelId (one catalog gate for
// both, so clearing the index opens both doors the way the tests expect).
export function unknownThinkMode(v) {
  if (v === null || v === undefined || v === '') return false;
  const catalog = getCachedCatalog();
  const list = catalog?.think_list ?? [];
  if (!list.length) return false;
  const n = Number(v);
  return !Number.isInteger(n) || !list.some((x) => Number(x.id) === n);
}

export function indexModels(catalog) {
  const modelList = catalog?.model_list ?? [];
  const think = catalog?.think_list ?? [];
  MODEL_INDEX.clear();
  for (const m of modelList) MODEL_INDEX.set(m.model_name, { ...m });
  // Upstream marks its defaults with internal numeric ids ("1", "3" — as strings).
  // Resolve the model default to a model_name, otherwise /v1/models can't match it to data[].id.
  const defModel = modelList.find((x) => String(x.id) === String(catalog?.default_model_id));
  const defThink =
    think.find((x) => String(x.id) === String(catalog?.default_think_id)) ??
    think.find((x) => /默认/.test(x.description ?? ''));
  lastCatalog = {
    model_list: modelList,
    think_list: think,
    default_model: defModel?.model_name ?? null,
    default_think_id: defThink ? Number(defThink.id) : null,
  };
  return MODEL_INDEX;
}

export function getCachedCatalog() {
  return MODEL_INDEX.size ? lastCatalog : null;
}
