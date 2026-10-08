import { createFileStore } from './store.mjs';

function clampHour(h) {
  const n = Number(h);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Daily free-point claim. OFF unless the operator turns it on: claiming is a write on the user's
// Baidu account and it spends one real turn per account to earn the CHAT task, so it must never
// be a default background behaviour.
export function createAutoClaim({ pool, file = null, store: providedStore = null, envEnabled = false, now = () => Date.now(), logger = console } = {}) {
  const store = providedStore ?? (file ? createFileStore(file) : null);
  let saved = null;
  if (store) {
    try {
      saved = store.load()?.auto_claim ?? null;
    } catch (e) {
      if (providedStore) throw e;
      logger.warn('auto-claim settings unreadable, starting disabled:', e.message);
      saved = null;
    }
  }
  const state = {
    enabled: saved ? !!saved.enabled : !!envEnabled,
    hour: clampHour(saved?.hour ?? 9),
    last_run_at: saved?.last_run_at ?? null,
    last_result: saved?.last_result ?? null,
  };
  let timer = null;
  let running = null;

  function persist() {
    if (!store) return;
    try {
      // This file belongs to the scheduler alone: load()'s default shape is the account store's,
      // so merging it would write "accounts": [] into a settings file.
      store.save({ auto_claim: { enabled: state.enabled, hour: state.hour, last_run_at: state.last_run_at, last_result: state.last_result } });
    } catch (e) {
      if (providedStore) throw e;
      logger.warn('auto-claim settings not saved:', e.message);
    }
  }

  function nextRunAt() {
    if (!state.enabled) return null;
    const d = new Date(now());
    d.setHours(state.hour, 0, 0, 0);
    if (state.last_run_at && dayKey(state.last_run_at) === dayKey(now())) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now()) return now(); // Catch up today at the next tick.
    return d.getTime();
  }

  async function run() {
    // One job at a time: a slow upstream must not let the next tick stack a second claim.
    if (running) return running;
    running = (async () => {
      const started = now();
      const results = await pool.claimFreePoints({ runChat: true });
      state.last_run_at = started;
      state.last_result = {
        took_ms: now() - started,
        accounts: results.map((r) => ({
          id: r.id,
          ok: r.ok,
          points_earned: r.points_earned ?? 0,
          claimed: r.claimed.map((c) => c.task_type),
          chat_turn: r.chat_turn,
          reported: r.reported ?? [],
          notes: r.notes ?? [],
          message: r.message ?? '',
        })),
      };
      persist();
      logger.log(`auto-claim: ${state.last_result.accounts.map((a) => `${a.id}+${a.points_earned}`).join(' ')}`);
      return state.last_result;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function tick() {
    if (!state.enabled) return null;
    const ts = now();
    if (new Date(ts).getHours() < state.hour) return null;
    if (state.last_run_at && dayKey(state.last_run_at) === dayKey(ts)) return null;
    return run();
  }

  if (providedStore && !saved) persist();

  return {
    get state() {
      return { ...state, next_run_at: nextRunAt(), running: !!running };
    },
    configure({ enabled, hour } = {}) {
      const previous = { ...state };
      if (enabled !== undefined) state.enabled = !!enabled;
      if (hour !== undefined) state.hour = clampHour(hour);
      try { persist(); }
      catch (e) { Object.assign(state, previous); throw e; }
      return this.state;
    },
    run,
    tick,
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((e) => logger.warn('auto-claim tick failed:', e.message));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
