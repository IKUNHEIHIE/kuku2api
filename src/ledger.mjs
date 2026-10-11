// Response ledger: previous_response_id must resolve back to the upstream session, so the
// mapping has to survive a restart. In-memory for lookups, debounced to disk.
export function responseRecordForStorage(rec) {
  if (rec.response?.store !== false) return rec;
  const response = { store: false, instructions: null, output: [], output_text: '' };
  for (const key of ['id', 'object', 'created_at', 'status', 'completed_at', 'model', 'previous_response_id', 'usage']) {
    if (rec.response[key] !== undefined) response[key] = rec.response[key];
  }
  response.kuku = {};
  for (const key of ['account', 'session_id', 'reply_id', 'consume_points']) {
    if (rec.response.kuku?.[key] !== undefined) response.kuku[key] = rec.response.kuku[key];
  }
  const saved = { response, output_text: '' };
  for (const key of ['id', 'session_key', 'session_id', 'model', 'account', 'created_at']) {
    if (rec[key] !== undefined) saved[key] = rec[key];
  }
  return saved;
}

export function createLedger(store, { max = 500 } = {}) {
  const map = new Map();
  let order = [];
  let timer = null;

  if (store) {
    try {
      const loaded = store.load();
      for (const rec of loaded.responses ?? []) {
        map.set(rec.id, responseRecordForStorage(rec));
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
      map.set(rec.id, responseRecordForStorage(rec));
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
