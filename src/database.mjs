import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, chmodSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const SYSTEM_DEFAULTS = { site_name: 'kuku2api', log_retention_days: 30, conversation_retention_days: 0 };
const parse = (s) => {
  try { return JSON.parse(s); }
  catch { throw new Error('Stored database record is invalid JSON; restore a verified backup'); }
};
const encode = (v) => JSON.stringify(v);
const count = (n) => Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;

export function openDatabase({ root, file = process.env.DATABASE_FILE || path.join(root, 'data', 'kukuai.sqlite'), migrate = true } = {}) {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(file, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    chmodSync(file, 0o600);
  }
  const sql = new DatabaseSync(file);
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = sql.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { sql.close(); throw new Error('Database schema is newer than this backend'); }
  if (version === 1) {
    for (const table of ['metadata', 'settings', 'accounts', 'api_keys', 'sessions', 'responses', 'usage_records', 'conversation_turns', 'logs']) {
      if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        sql.close(); throw new Error('Database schema is incomplete; restore a verified backup');
      }
    }
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS responses (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      account TEXT NOT NULL, status TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
      usage_known INTEGER NOT NULL, usage_scope TEXT NOT NULL, model_call_count INTEGER NOT NULL,
      consume_points REAL, duration_ms INTEGER NOT NULL, error_code TEXT, usage_events TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_time ON usage_records(created_at);
    CREATE INDEX IF NOT EXISTS usage_model_time ON usage_records(model, created_at);
    CREATE INDEX IF NOT EXISTS usage_account_time ON usage_records(account, created_at);
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL, account TEXT NOT NULL,
      session_key TEXT, session_id TEXT, reply_id TEXT, think_mode INTEGER, status TEXT NOT NULL,
      messages TEXT, output_text TEXT, reasoning_text TEXT, content_stored INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_time ON conversation_turns(created_at);
    CREATE INDEX IF NOT EXISTS conversation_session ON conversation_turns(session_key, created_at);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
      method TEXT, path TEXT, status INTEGER, duration_ms INTEGER, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS log_time ON logs(created_at);
    PRAGMA user_version=1;
  `);
  let inTransaction = false;
  const transaction = (fn) => {
    if (inTransaction) return fn();
    sql.exec('BEGIN IMMEDIATE'); inTransaction = true;
    try { const out = fn(); sql.exec('COMMIT'); return out; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
    finally { inTransaction = false; }
  };
  const getSetting = (key, fallback = null) => {
    const rec = sql.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return rec ? parse(rec.value) : fallback;
  };
  const setSetting = (key, value) => sql.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encode(value));
  const stores = {
    accounts: { table: 'accounts', field: 'accounts', key: 'id' },
    keys: { table: 'api_keys', field: 'keys', key: 'id' },
    sessions: { table: 'sessions', field: 'sessions', key: 'key' },
  };
  const store = (name) => {
    const cfg = stores[name];
    return {
      immediate: true,
      load() {
        if (!cfg) return getSetting(name, name === 'admin' ? {} : {});
        const list = sql.prepare(`SELECT data FROM ${cfg.table} ORDER BY rowid`).all().map((r) => parse(r.data));
        return { [cfg.field]: list, ...(name === 'accounts' ? { default_device_id: getSetting('default_device_id', '') } : {}) };
      },
      save(data) {
        return transaction(() => {
          if (!cfg) { setSetting(name, data); return data; }
          if (!Array.isArray(data?.[cfg.field])) throw new Error(`Invalid ${name} records`);
          sql.prepare(`DELETE FROM ${cfg.table}`).run();
          const insert = sql.prepare(`INSERT INTO ${cfg.table}(${cfg.key},data) VALUES (?,?)`);
          for (const rec of data[cfg.field]) {
            if (typeof rec?.[cfg.key] !== 'string' || !rec[cfg.key]) throw new Error(`Invalid ${name} record identifier`);
            insert.run(rec[cfg.key], encode(rec));
          }
          if (name === 'accounts') setSetting('default_device_id', data.default_device_id ?? '');
          return data;
        });
      },
      initialize(data) {
        return transaction(() => {
          const current = getSetting(name);
          if (current) return { value: current, created: false };
          setSetting(name, data); return { value: data, created: true };
        });
      },
    };
  };
  const ledger = {
    get(id) { const r = sql.prepare('SELECT data FROM responses WHERE id=?').get(id); return r ? parse(r.data) : null; },
    put(rec) {
      const saved = rec.response?.store === false ? { ...rec, output_text: '', response: { ...rec.response, output: [], output_text: '' } } : rec;
      sql.prepare('INSERT INTO responses(id,created_at,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(saved.id, saved.created_at ?? 0, encode(saved)); return rec;
    },
    del(id) {
      return transaction(() => {
        const rec = ledger.get(id);
        if (!rec) return false;
        sql.prepare('DELETE FROM conversation_turns WHERE id=? OR (source=? AND account=? AND session_id=? AND reply_id=?)').run(
          `legacy-${id}`, 'responses', rec.account ?? '', rec.session_id ?? null, rec.response?.kuku?.reply_id ?? null);
        return sql.prepare('DELETE FROM responses WHERE id=?').run(id).changes > 0;
      });
    },
    list() { return sql.prepare('SELECT data FROM responses ORDER BY seq').all().map((r) => parse(r.data)); },
    size() { return sql.prepare('SELECT COUNT(*) AS n FROM responses').get().n; },
    sessionIds() { return sql.prepare("SELECT DISTINCT json_extract(data,'$.session_id') AS id FROM responses").all().map((r) => r.id).filter(Boolean); },
    page({ limit = 20, sessionKey = null, after = null } = {}) {
      let where = " WHERE json_extract(data,'$.response.store') IS NOT 0";
      const args = [];
      if (sessionKey) { where += " AND json_extract(data,'$.session_key')=?"; args.push(sessionKey); }
      if (after) {
        const cursor = sql.prepare(`SELECT seq FROM responses${where} AND id=?`).get(...args, after);
        if (!cursor) { const e = new Error('Unknown response cursor'); e.cursor = true; throw e; }
        where += ' AND seq<?'; args.push(cursor.seq);
      }
      const rows = sql.prepare(`SELECT data FROM responses${where} ORDER BY seq DESC LIMIT ?`).all(...args, limit + 1);
      return { records: rows.slice(0, limit).map((r) => parse(r.data)), has_more: rows.length > limit };
    },
    flush() {},
  };
  function sessionOwners(sessionId) {
    const rows = sql.prepare(`SELECT account FROM conversation_turns WHERE session_id=?
      UNION SELECT json_extract(data,'$.account') AS account FROM responses WHERE json_extract(data,'$.session_id')=?`).all(sessionId, sessionId);
    return new Set(rows.map(r => r.account).filter(a => typeof a === 'string' && a));
  }
  function recordTurn(rec) {
    const result = rec.result ?? {};
    const usage = result.usage;
    const known = !!usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].some((k) => Number.isFinite(usage[k]));
    const events = result.usage_events ?? [];
    const id = rec.id ?? `turn-${randomUUID()}`;
    const timestamp = rec.created_at ?? Date.now();
    const status = rec.status ?? 'completed';
    const contentStored = rec.store !== false;
    transaction(() => {
      sql.prepare(`INSERT INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, timestamp, rec.source ?? 'chat', rec.model ?? '', rec.account ?? '', status,
        count(usage?.prompt_tokens), count(usage?.completion_tokens), count(usage?.total_tokens),
        count(usage?.reasoning_tokens), count(usage?.cache_read_tokens), Number(known),
        events.length > 1 ? 'last_model_call' : events.length === 1 ? 'single_model_call' : known ? 'reported' : 'unknown',
        events.length, Number.isFinite(result.consume_points) ? result.consume_points : null,
        count(rec.duration_ms), rec.error_code == null ? null : String(rec.error_code), encode(events),
      );
      sql.prepare('INSERT INTO conversation_turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, timestamp, rec.source ?? 'chat', rec.model ?? '', rec.account ?? '', rec.session_key ?? null,
        result.session_id ?? null, result.reply_id ?? null, Number.isFinite(rec.think_mode) ? rec.think_mode : null,
        status, contentStored && rec.messages ? encode(rec.messages) : null,
        contentStored ? result.content ?? '' : null, contentStored ? result.reasoning ?? '' : null, Number(contentStored),
      );
    });
    return id;
  }
  function migrateLegacy() {
    transaction(() => {
      if (sql.prepare("SELECT 1 FROM metadata WHERE key='legacy_json_v1'").get()) return;
      const imported = {};
      for (const [name, filename] of Object.entries({ accounts: 'accounts.json', keys: 'keys.json', sessions: 'sessions.json', settings: 'settings.json', admin: 'admin-token.json', responses: 'responses.json' })) {
        const legacyFile = path.join(root, filename);
        if (!existsSync(legacyFile)) continue;
        let data;
        try { data = parse(readFileSync(legacyFile, 'utf8')); } catch { throw new Error(`${filename} cannot be migrated; restore a verified JSON backup`); }
        if (name === 'responses') {
          if (!Array.isArray(data?.responses)) throw new Error('Invalid legacy responses');
          for (const rec of data.responses) {
            if (typeof rec?.id !== 'string' || !rec.id) throw new Error('Invalid legacy response identifier');
            ledger.put(rec);
            const r = rec.response;
            const u = r?.usage;
            recordTurn({ id: `legacy-${rec.id}`, created_at: (rec.created_at ?? 0) * 1000, source: 'legacy_response', model: rec.model, account: rec.account,
              session_key: rec.session_key, store: r?.store !== false, status: r?.status ?? 'completed',
              result: { session_id: rec.session_id, reply_id: r?.kuku?.reply_id, content: rec.output_text ?? r?.output_text ?? '',
                usage: u ? { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.total_tokens, reasoning_tokens: u.output_tokens_details?.reasoning_tokens, cache_read_tokens: u.input_tokens_details?.cached_tokens } : null,
                consume_points: r?.kuku?.consume_points ?? u?.kuku_consume_points } });
          }
          imported.responses = data.responses.length;
        } else {
          if (name === 'accounts' && data.accounts?.some((a) => !a?.bduss || !a?.stoken)) throw new Error('Invalid legacy account credentials');
          if (name === 'keys' && data.keys?.some((k) => typeof k?.key !== 'string' || !k.key)) throw new Error('Invalid legacy API keys');
          if (name === 'admin' && !/^kuku-admin-[A-Za-z0-9_-]{43}$/.test(data?.token ?? '')) throw new Error('Invalid legacy administrator token');
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Invalid legacy ${name}`);
          store(name).save(data); imported[name] = stores[name] ? data[stores[name].field].length : 1;
        }
      }
      const secrets = [process.env.ADMIN_TOKEN, ...(process.env.API_KEYS ?? '').split(','),
        ...store('accounts').load().accounts.flatMap((a) => [a.bduss, a.stoken]), ...store('keys').load().keys.map((k) => k.key), store('admin').load().token];
      imported.logs = 0;
      for (const filename of ['server.log', 'backend-current.log', 'backend-current-error.log']) {
        const legacyFile = path.join(root, 'capture', filename);
        if (!existsSync(legacyFile)) continue;
        const info = statSync(legacyFile);
        if (info.size > 4 * 1024 * 1024) throw new Error(`Legacy ${filename} exceeds migration limit; archive it before migration`);
        for (const line of readFileSync(legacyFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
          database.addLog({ created_at: Math.floor(info.mtimeMs), kind: 'legacy', message: redactLogMessage(line, secrets) });
          imported.logs++;
        }
      }
      sql.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('legacy_json_v1', encode({ imported_at: new Date().toISOString(), imported }));
    });
  }
  function conditions(filters, alias = '') {
    const p = alias ? alias + '.' : '';
    const terms = [], args = [];
    for (const key of ['model', 'account', 'source', 'status', 'session_key', 'level', 'kind']) {
      if (filters[key] != null) { terms.push(`${p}${key}=?`); args.push(filters[key]); }
    }
    if (filters.from != null) { terms.push(`${p}created_at>=?`); args.push(filters.from); }
    if (filters.to != null) { terms.push(`${p}created_at<?`); args.push(filters.to); }
    return { where: terms.length ? ' WHERE ' + terms.join(' AND ') : '', args };
  }
  function page(table, filters, columns, order, alias = '') {
    const { where, args } = conditions(filters, alias);
    const total = sql.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get(...args).n;
    const data = sql.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, filters.limit ?? 50, filters.offset ?? 0);
    return { data, total, limit: filters.limit ?? 50, offset: filters.offset ?? 0 };
  }
  const database = {
    file, sql, transaction, store, ledger, recordTurn, sessionOwners,
    systemSettings: () => ({ ...SYSTEM_DEFAULTS, ...getSetting('system', {}) }),
    updateSystemSettings(patch) { const next = { ...this.systemSettings(), ...patch }; setSetting('system', next); return next; },
    tokenStats(filters = {}, groupBy = 'day') {
      const { where, args } = conditions(filters);
      const fields = `COUNT(*) AS attempts, SUM(status='completed') AS completed, SUM(status='failed') AS failed,
        SUM(status='cancelled') AS cancelled, SUM(usage_known) AS usage_known_attempts,
        COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens,
        COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(consume_points),0) AS consume_points,
        SUM(consume_points IS NOT NULL) AS points_known_attempts, SUM(usage_scope='last_model_call') AS partial_usage_attempts`;
      const summary = sql.prepare(`SELECT ${fields} FROM usage_records${where}`).get(...args);
      for (const key of Object.keys(summary)) if (summary[key] == null) summary[key] = 0;
      const group = { day: "strftime('%Y-%m-%d',created_at/1000.0,'unixepoch')", model: 'model', account: 'account', source: 'source' }[groupBy];
      if (!group) throw new Error('Invalid statistics group');
      const groups = sql.prepare(`SELECT ${group} AS bucket, ${fields} FROM usage_records${where} GROUP BY ${group} ORDER BY bucket LIMIT 1001`).all(...args);
      return { summary, group_by: groupBy, groups: groups.slice(0, 1000), groups_truncated: groups.length > 1000,
        token_scope: 'reported_per_attempt; multi-call turns use last MODEL_CALL_END', timezone: 'UTC', historical_coverage: 'legacy Responses only; earlier Chat Completions were not saved' };
    },
    conversations(filters = {}) {
      return page('conversation_turns c LEFT JOIN usage_records u ON c.id=u.id', filters,
        'c.id,c.created_at,c.source,c.model,c.account,c.session_key,c.session_id,c.status,c.content_stored,u.prompt_tokens,u.completion_tokens,u.total_tokens,u.consume_points,u.usage_scope,u.duration_ms', 'c.created_at DESC,c.rowid DESC', 'c');
    },
    conversation(id) {
      const r = sql.prepare('SELECT c.*,u.prompt_tokens,u.completion_tokens,u.total_tokens,u.reasoning_tokens,u.cache_read_tokens,u.consume_points,u.usage_scope,u.model_call_count,u.usage_events,u.duration_ms,u.error_code FROM conversation_turns c LEFT JOIN usage_records u ON c.id=u.id WHERE c.id=?').get(id);
      return r ? { ...r, messages: r.messages ? parse(r.messages) : null, usage_events: r.usage_events ? parse(r.usage_events) : [] } : null;
    },
    addLog(rec) { sql.prepare('INSERT INTO logs(created_at,level,kind,method,path,status,duration_ms,message) VALUES (?,?,?,?,?,?,?,?)').run(rec.created_at ?? Date.now(), rec.level ?? 'info', rec.kind ?? 'system', rec.method ?? null, rec.path ?? null, rec.status ?? null, rec.duration_ms ?? null, rec.message ?? ''); },
    logs: (filters = {}) => page('logs', filters, '*', 'created_at DESC,id DESC'),
    prune(now = Date.now()) {
      const settings = this.systemSettings();
      transaction(() => {
        if (settings.log_retention_days > 0) sql.prepare('DELETE FROM logs WHERE created_at<?').run(now - settings.log_retention_days * 86400000);
        if (settings.conversation_retention_days > 0) {
          const cutoff = now - settings.conversation_retention_days * 86400000;
          sql.prepare('DELETE FROM conversation_turns WHERE created_at<?').run(cutoff);
          sql.prepare('DELETE FROM responses WHERE created_at<?').run(Math.floor(cutoff / 1000));
        }
      });
    },
    close() { sql.close(); },
  };
  try {
    if (migrate && root) migrateLegacy();
    store('system').initialize(SYSTEM_DEFAULTS);
  }
  catch (e) { sql.close(); throw e; }
  return database;
}

// Request bodies/headers never enter operational logs. Known secret values are also removed.
export function createDatabaseLogger(database, { secrets = () => [], consoleOutput = console } = {}) {
  const redact = (input) => redactLogMessage(input, secrets());
  const write = (level, values) => {
    const message = redact(values.map((v) => v instanceof Error ? v.message : String(v)).join(' '));
    database.addLog({ level, message });
    consoleOutput[level === 'info' ? 'log' : level]?.(message);
  };
  return { redact, log: (...v) => write('info', v), warn: (...v) => write('warn', v), error: (...v) => write('error', v) };
}

export function redactLogMessage(input, secrets = []) {
  let message = String(input)
    .replace(/Bearer\s+[^\s;,"'}]+/gi, 'Bearer <redacted>')
    .replace(/((?:BDUSS|PTOKEN|STOKEN|authorization|x-admin-token|api[_-]?key|token)["']?\s*[=:]\s*["']?)[^\s;,"'}]+/gi, '$1<redacted>')
    .replace(/kuku-admin-[A-Za-z0-9_-]{43}|sk-kuku-[a-f0-9]{32}/g, '<redacted>');
  for (const secret of secrets) if (typeof secret === 'string' && secret) message = message.split(secret).join('<redacted>');
  return message.slice(0, 2000);
}
