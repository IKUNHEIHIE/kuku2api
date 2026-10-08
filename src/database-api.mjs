const bad = (message) => { const error = new Error(message); error.status = 400; throw error; };

function filters(params, allowed) {
  const out = {};
  for (const key of allowed) {
    const value = params.get(key);
    if (value == null) continue;
    if (['limit', 'offset'].includes(key)) {
      const n = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < (key === 'limit' ? 1 : 0) || n > (key === 'limit' ? 200 : 1000000)) bad(`Invalid ${key}`);
      out[key] = n;
    } else if (key === 'from' || key === 'to') {
      const date = value.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) bad(`Invalid ${key}; use ISO 8601 with timezone or YYYY-MM-DD`);
      const dateMs = Date.parse(`${date}T00:00:00Z`);
      const n = Date.parse(value);
      if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== date || !Number.isFinite(n)) bad(`Invalid ${key}`);
      out[key] = n;
    } else {
      if (!value || value.length > 256) bad(`Invalid ${key}`);
      out[key] = value;
    }
  }
  if (out.from != null && out.to != null && out.from >= out.to) bad('from must precede to (to is exclusive)');
  if (out.status && !['completed', 'failed', 'cancelled'].includes(out.status)) bad('Invalid status');
  if (out.source && !['chat', 'responses', 'claim', 'legacy_response'].includes(out.source)) bad('Invalid source');
  if (out.level && !['info', 'warn', 'error'].includes(out.level)) bad('Invalid level');
  if (out.kind && !['http', 'system', 'legacy'].includes(out.kind)) bad('Invalid kind');
  return out;
}

// Called only after the shared administrator-token guard.
export function databaseAdminRoute({ database, autoClaim, url, method, body }) {
  const detail = url.pathname.match(/^\/pool\/admin\/conversations\/([^/]+)$/);
  const names = ['/pool/admin/stats/tokens', '/pool/admin/conversations', '/pool/admin/logs', '/pool/admin/settings'];
  if (!detail && !names.includes(url.pathname)) return null;
  if (!database) return { status: 501, body: { error: { type: 'configuration_error', message: 'SQLite is not configured in this process' } } };
  try {
    if (url.pathname === '/pool/admin/settings') {
      if (method === 'PATCH') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) bad('settings must be a JSON object');
        const patch = {};
        for (const [key, value] of Object.entries(body)) {
          if (key === 'site_name') {
            if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) bad('Invalid site_name');
            patch[key] = value.trim();
          } else if (['log_retention_days', 'conversation_retention_days'].includes(key)) {
            if (!Number.isInteger(value) || value < 0 || value > 3650) bad(`Invalid ${key}; use integer 0..3650`);
            patch[key] = value;
          } else bad(`Unsupported setting: ${key}`);
        }
        database.updateSystemSettings(patch);
        database.prune();
      } else if (method !== 'GET') return { status: 405, body: { error: { message: 'Use GET or PATCH' } } };
      return { status: 200, body: { ok: true, settings: database.systemSettings(), auto_claim: autoClaim?.state ?? { configured: false, enabled: false }, storage: { engine: 'sqlite', schema_version: 1 } } };
    }
    if (method !== 'GET') return { status: 405, body: { error: { message: 'Use GET' } } };
    if (detail) {
      let id;
      try { id = decodeURIComponent(detail[1]); } catch { bad('Invalid conversation identifier'); }
      const data = database.conversation(id);
      return data ? { status: 200, body: { ok: true, data } } : { status: 404, body: { error: { message: 'conversation not found' } } };
    }
    if (url.pathname === '/pool/admin/stats/tokens') {
      const groupBy = url.searchParams.get('group_by') ?? 'day';
      if (!['day', 'model', 'account', 'source'].includes(groupBy)) bad('Invalid group_by');
      const filter = filters(url.searchParams, ['from', 'to', 'model', 'account', 'source', 'status']);
      return { status: 200, body: { ok: true, checked_at: new Date().toISOString(), ...database.tokenStats(filter, groupBy) } };
    }
    if (url.pathname === '/pool/admin/conversations') {
      const filter = filters(url.searchParams, ['from', 'to', 'model', 'account', 'source', 'status', 'session_key', 'limit', 'offset']);
      return { status: 200, body: { ok: true, ...database.conversations(filter) } };
    }
    return { status: 200, body: { ok: true, ...database.logs(filters(url.searchParams, ['from', 'to', 'level', 'kind', 'limit', 'offset'])) } };
  } catch (e) {
    if (e.status !== 400) throw e;
    return { status: 400, body: { error: { type: 'invalid_request_error', message: e.message } } };
  }
}
