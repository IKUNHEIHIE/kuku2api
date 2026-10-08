// Response ledger: previous_response_id must resolve back to the upstream session, so the
// mapping has to survive a restart. In-memory for lookups, debounced to disk.
export function createLedger(store, { max = 500 } = {}) {
  const map = new Map();
  let order = [];
  let timer = null;

  if (store) {
    try {
      const loaded = store.load();
      for (const rec of loaded.responses ?? []) {
        map.set(rec.id, rec);
        order.push(rec.id);
      }
    } catch {
      map.clear();
      order = [];
    }
  }

  const flush = () => {
    if (!store) return;
    store.save({ responses: [...map.values()] });
  };
  const schedule = () => {
    if (!store) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, 500);
    timer.unref?.();
  };

  return {
    get(id) {
      return map.get(id) ?? null;
    },
    put(rec) {
      map.set(rec.id, rec);
      order.push(rec.id);
      while (order.length > max) {
        const old = order.shift();
        if (old !== rec.id) map.delete(old);
      }
      schedule();
      return rec;
    },
    del(id) {
      const had = map.delete(id);
      order = order.filter((x) => x !== id);
      schedule();
      return had;
    },
    list: () => [...map.values()],
    flush,
    size: () => map.size,
  };
}
