import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// The account store is the only place holding upstream login state. Losing it means every
// account has to be re-logged by hand, so writes are backup-then-rename, never truncating.
export function createFileStore(file) {
  return {
    file,
    load() {
      if (!existsSync(file)) return { accounts: [], default_device_id: '' };
      const raw = readFileSync(file, 'utf8');
      try {
        return JSON.parse(raw);
      } catch {
        // Preserve the failing file so a second start cannot mistake corruption for absence.
        // JSON.parse diagnostics can include file contents, including secrets.
        throw new Error(`${path.basename(file)} is not valid JSON; repair it or restore a verified backup`);
      }
    },
    save(data) {
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (existsSync(file)) copyFileSync(file, `${file}.bak`);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, file);
      return data;
    },
  };
}

// Serialising the pool back to disk must never emit credentials the UI invented, and must
// never print a key. Only these fields are persisted.
export function toRecords(accounts) {
  return accounts.map((a) => ({
    id: a.id,
    alias: a.alias,
    priority: a.priority,
    disabled: a.disabled,
    ...(a.upstream_user_id ? { upstream_user_id: a.upstream_user_id } : {}),
    bduss: a.client.bduss,
    stoken: a.client.stoken,
  }));
}

const KEY_PREFIX = 'sk-kuku-';

// Caller-facing API keys, manageable at runtime so a leaked key can be revoked without a
// restart. Keys are shown in full exactly once, at creation; every other read is a hint.
// Env `API_KEYS` stay valid and undeletable — an operator's own config must not be erased by
// whoever holds an admin token.
export function createKeyRing({ file = null, store: providedStore = null, envKeys = [] } = {}) {
  const store = providedStore ?? (file ? createFileStore(file) : null);
  let saved = [];
  if (store && (providedStore || existsSync(file))) {
    saved = store.load()?.keys;
    if (!Array.isArray(saved) || saved.some((k) => !k || typeof k.id !== 'string' || !k.id || typeof k.key !== 'string' || !k.key)) {
      throw new Error(`${file ? path.basename(file) : 'SQLite API keys'} has invalid keys; repair it or restore a verified backup`);
    }
  }
  const persist = (next) => {
    if (store) store.save({ keys: next });
  };
  const hint = (k) => (k.length <= 12 ? `${k.slice(0, 4)}…` : `${k.slice(0, 11)}…${k.slice(-4)}`);
  const shape = (k) => ({
    id: k.id,
    label: k.label ?? '',
    hint: hint(k.key),
    created_at: k.created_at ?? null,
    from_env: false,
  });
  return {
    count: () => envKeys.length + saved.length,
    ok(key) {
      if (!key) return false;
      return envKeys.includes(key) || saved.some((k) => k.key === key);
    },
    list() {
      return [
        ...envKeys.map((key, i) => ({ id: `env-${i}`, label: 'API_KEYS', hint: hint(key), created_at: null, from_env: true })),
        ...saved.map(shape),
      ];
    },
    add(label = '') {
      const key = KEY_PREFIX + randomBytes(16).toString('hex');
      const rec = { id: `k-${key.slice(-8)}`, key, label: String(label || '').slice(0, 60), created_at: new Date().toISOString() };
      const next = [...saved, rec];
      persist(next);
      saved = next;
      // The full value is returned here and nowhere else.
      return { ...rec, shape: shape(rec) };
    },
    remove(id) {
      const next = saved.filter((k) => k.id !== id);
      if (next.length === saved.length) return false;
      persist(next);
      saved = next;
      return true;
    },
  };
}
