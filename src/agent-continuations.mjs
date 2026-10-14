import { createHash, randomUUID } from 'node:crypto';
import { assistantHistory } from './agent.mjs';
import { stableToolDefinitions } from './tool-definitions.mjs';

const prefix = 'call_kuku_native_';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
export const continuationError = message => Object.assign(new Error(message), { status: 409, code: 'agent_continuation_unavailable', retryUnsafe: true });
function tail(agent) {
  let start = agent.messages.length;
  while (start && agent.messages[start - 1].role === 'tool') start--;
  return { start, results: agent.messages.slice(start) };
}
const config = ({ agent, model, think_mode }) => digest({ tools: stableToolDefinitions(agent.tools), choice: agent.choice,
  parallel: agent.parallel, instructions: agent.instructions, model: model.model_name, think_mode });

// Live connections cannot survive a process restart. Reserved call IDs fail closed
// when their owner disappears instead of silently replaying a possibly active task.
export class AgentContinuations {
  constructor({ enabled = false, idleMs = 60_000, maxSessions = 32 } = {}) {
    this.enabled = enabled; this.idleMs = idleMs; this.maxSessions = maxSessions;
    this.calls = new Map(); this.sessions = new Set(); this.stopped = false;
  }
  lookup(agent, scope) {
    if (!agent) return null;
    const ids = tail(agent).results.map(r => r.tool_call_id).filter(id => id.startsWith(prefix));
    if (!ids.length) return null;
    const state = this.calls.get(ids[0]);
    if (!state || state.scope !== scope || ids.some(id => this.calls.get(id) !== state)) {
      throw continuationError('Native tool continuation expired or belongs to another caller; start a new conversation');
    }
    return state;
  }
  async run(options, start) {
    const { agent, scope, account, signal } = options;
    const state = this.lookup(agent, scope);
    if (state) {
      const { start: boundary, results } = tail(agent);
      if (state.busy || account.id !== state.account.id || account.upstream_user_id !== state.account.upstream_user_id
          || digest([account.client.bduss, account.client.stoken]) !== state.credentials
          || config(options) !== state.config || digest(agent.messages.slice(0, boundary)) !== state.history
          || results.length !== state.ids.length || results.some(r => !state.ids.includes(r.tool_call_id) || typeof r.content !== 'string')) {
        throw continuationError('Native continuation requires the original account, history, settings and all text tool results');
      }
      if (signal?.aborted) throw continuationError('Native continuation request was cancelled');
      state.busy = true; clearTimeout(state.timer);
      state.detach(); state.output = deferred(); state.watch(signal);
      const callbacks = state.ids.map(id => ({ content: [{ type: 'text', text: results.find(r => r.tool_call_id === id).content }], isError: false }));
      state.resume.resolve({ ...options, results: callbacks });
      return state.output.promise;
    }
    // Only auto choice can safely stay in one model turn across multiple API calls.
    if (this.stopped) throw continuationError('Server is shutting down');
    if (!this.enabled || agent.choice !== 'auto' || !agent.tools.length
        || agent.messages.some(m => typeof m.content !== 'string') || this.sessions.size >= this.maxSessions) return start(null);
    const current = { account: { ...account }, credentials: digest([account.client.bduss, account.client.stoken]), scope, config: config(options), ids: [], busy: true, output: deferred(),
      abort: new AbortController(), detach() {}, watch: requestSignal => {
        const cancel = () => current.abort.abort(continuationError('Native continuation request was cancelled'));
        if (requestSignal?.aborted) cancel(); else requestSignal?.addEventListener('abort', cancel, { once: true });
        current.detach = () => requestSignal?.removeEventListener('abort', cancel);
      } };
    this.sessions.add(current); current.watch(signal);
    const bridge = { signal: current.abort.signal, exchange: async (turn, context) => {
      if (current.abort.signal.aborted) throw current.abort.signal.reason;
      for (const id of current.ids) this.calls.delete(id);
      turn.tool_calls = turn.tool_calls.map(call => ({ ...call, id: prefix + randomUUID().replaceAll('-', '') }));
      current.ids = turn.tool_calls.map(call => call.id);
      current.history = digest([...context.agent.messages, assistantHistory(turn)]);
      current.resume = deferred(); current.busy = false; current.detach();
      for (const id of current.ids) this.calls.set(id, current);
      current.timer = setTimeout(() => current.abort.abort(continuationError('Native tool continuation timed out')), this.idleMs);
      current.timer.unref?.();
      current.output.resolve(turn);
      const cancel = () => current.resume.reject(current.abort.signal.reason);
      current.abort.signal.addEventListener('abort', cancel, { once: true });
      try { return await current.resume.promise; }
      finally { current.abort.signal.removeEventListener('abort', cancel); }
    } };
    current.task = Promise.resolve().then(() => start(bridge)).then(value => current.output.resolve(value), error => current.output.reject(error)).finally(() => {
      current.abort.abort(continuationError('Native turn ended'));
      clearTimeout(current.timer); current.detach();
      for (const id of current.ids) this.calls.delete(id);
      this.sessions.delete(current);
    });
    return current.output.promise;
  }
  async close() {
    this.stopped = true;
    const states = [...this.sessions];
    for (const state of states) state.abort.abort(continuationError('Server is shutting down'));
    await Promise.allSettled(states.map(s => s.task));
  }
  async cancelTurn(turn) {
    const states = new Set((turn?.tool_calls ?? []).map(call => this.calls.get(call.id)).filter(Boolean));
    for (const state of states) state.abort.abort(continuationError('Native handoff could not be saved'));
    await Promise.allSettled([...states].map(s => s.task));
  }
}
