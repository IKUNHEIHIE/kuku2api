// Passport renewals never generate model conversations. Keep both batches and concurrent
// manual requests serialized and spaced to avoid another burst of account traffic.
export function createCredentialRefresh({ pool, manager, store = null, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), logger = console }) {
  const saved = store?.load() ?? {};
  let config = { enabled: saved.enabled !== false, interval_hours: Number.isInteger(saved.interval_hours) && saved.interval_hours >= 1 && saved.interval_hours <= 168 ? saved.interval_hours : 6 };
  let lastRun = saved.last_run_at ?? null, lastResult = saved.last_result ?? null;
  let timer = null, stopping = false, tail = Promise.resolve(), nextStart = 0;
  const jobs = new Map();
  const nextFor = account => {
    if (!config.enabled || account.disabled) return null;
    const attempted = account.credential?.attempted_at ?? account.credential?.checked_at ?? 0;
    const interval = ['error','refresh_failed'].includes(account.credential?.status) ? Math.min(5 * 60_000, config.interval_hours * 3600000) : config.interval_hours * 3600000;
    return attempted ? attempted + interval : now();
  };
  const persist = (nextConfig = config, run = lastRun, result = lastResult) => store?.save({ ...nextConfig, last_run_at: run, last_result: result });
  function run({ only = null, dueOnly = false } = {}) {
    const key = JSON.stringify([only, dueOnly]);
    if (jobs.has(key)) return jobs.get(key);
    const result = tail.then(async () => {
      const started = now(), accounts = [];
      const targets = pool.accounts.filter(a => !only || a.id === only || a.alias === only).filter(a => !dueOnly || (nextFor(a) !== null && nextFor(a) <= now())).map(a => a.id);
      for (const id of targets) {
        if (stopping) break;
        const delay = nextStart - now();
        if (delay > 0) await wait(delay);
        if (stopping) break;
        try { accounts.push(await manager.refresh(id)); }
        catch { accounts.push({ id, ok: false, status: 'error', message: '刷新结果未能安全保存，原凭据保留' }); }
        nextStart = now() + 15_000;
      }
      const summary = { accounts, took_ms: now() - started };
      const completed = now();
      persist(config, completed, summary);
      lastRun = completed; lastResult = summary;
      logger.log?.('credential refresh:', JSON.stringify(accounts.map(a => ({ id: a.id, ok: a.ok, status: a.status, refreshed: a.refreshed === true }))));
      return summary;
    });
    tail = result.catch(() => {}); jobs.set(key, result);
    const done = () => { if (jobs.get(key) === result) jobs.delete(key); };
    result.then(done, done);
    return result;
  }
  const api = {
    nextFor,
    get state() {
      const dates = pool.accounts.map(nextFor).filter(t => t !== null);
      return { ...config, running: jobs.size > 0, last_run_at: lastRun, last_result: lastResult, next_run_at: dates.length ? Math.min(...dates) : null };
    },
    configure(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['enabled','interval_hours'].includes(k)) ||
        (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.interval_hours !== undefined && (!Number.isInteger(body.interval_hours) || body.interval_hours < 1 || body.interval_hours > 168))) {
        throw Object.assign(new Error('enabled must be boolean; interval_hours must be an integer from 1 to 168'), { status: 400 });
      }
      const next = { ...config, ...body }; persist(next); config = next;
      return api.state;
    },
    run,
    async tick() {
      if (stopping || !config.enabled || jobs.size) return null;
      if (!pool.accounts.some(a => nextFor(a) !== null && nextFor(a) <= now())) return null;
      return run({ dueOnly: true });
    },
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => { api.tick().catch(() => logger.warn?.('credential refresh scheduling failed')); }, 60_000);
      timer.unref?.();
    },
    stop() { stopping = true; if (timer) clearInterval(timer); timer = null; return tail; },
  };
  return api;
}
