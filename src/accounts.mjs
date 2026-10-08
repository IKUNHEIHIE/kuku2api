import { KukuAccount } from './upstream.mjs';
import { toRecords } from './store.mjs';
import { exchangeStoken } from './passport.mjs';

// Add and credential rotation share a queue: checking before an awaited upstream read
// would let simultaneous login sessions both insert the same user.
export function createAccountManager({ pool, store, deviceId, initializeDesktop = null }) {
  let pending = Promise.resolve();
  const serial = (fn) => {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  };
  const failure = (status, message, code, extra = {}) => ({ error: { status, message, code, ...extra } });
  const duplicate = (a) => failure(409, '该百度账号已存在于号池，请使用已有账号；如需更新登录凭据，请编辑该账号', 'account_already_exists', { account_id: a.id });
  const commit = (records) => {
    // A failed disk write must not leave a phantom account in the live pool.
    store?.save({ default_device_id: deviceId, accounts: records });
    pool.set(records);
    for (const a of pool.accounts) a.deviceId = deviceId;
  };
  async function identify(client) {
    try { return { id: await client.userIdentity() }; }
    catch { return failure(502, '无法核实百度账号身份，请稍后重试或更新已有账号的登录凭据', 'account_identity_unavailable', { type: 'upstream_error' }); }
  }
  async function findDuplicate(client, identity, exceptId = null) {
    for (const a of [...pool.accounts]) {
      if (a.id === exceptId) continue;
      if (a.client.bduss === client.bduss || (a.upstream_user_id && a.upstream_user_id === identity)) return duplicate(a);
      if (a.upstream_user_id) continue;
      const verified = await identify(a.client);
      if (verified.error) return verified; // No guessing when an old account cannot be identified.
      // DELETE may have removed the account during the upstream read.
      const current = pool.accounts.find((x) => x.id === a.id);
      if (!current) continue;
      const records = toRecords(pool.accounts);
      records.find((x) => x.id === a.id).upstream_user_id = verified.id;
      store?.save({ default_device_id: deviceId, accounts: records });
      current.upstream_user_id = verified.id;
      if (verified.id === identity) return duplicate(current);
    }
    return null;
  }
  function add(spec) {
    return serial(async () => {
      if (typeof spec?.allocateId === 'function') spec = { ...spec, id: spec.allocateId() };
      if (typeof spec?.id !== 'string' || !spec.id || !spec?.bduss) return failure(400, 'id and bduss are required');
      const sameId = pool.accounts.find((a) => a.id === spec.id);
      if (sameId) return duplicate(sameId);
      let stoken = spec.stoken;
      let minted = false;
      if (!stoken && spec.ptoken) {
        try { stoken = await exchangeStoken({ bduss: spec.bduss, ptoken: spec.ptoken }); minted = true; }
        catch { return failure(502, 'ptoken → stoken exchange refused', 'stoken_exchange_failed', { type: 'upstream_error' }); }
      }
      let client;
      try { client = new KukuAccount({ bduss: spec.bduss, stoken }); }
      catch { return failure(400, 'bduss/stoken must be non-empty'); }
      const sameCookie = pool.accounts.find((a) => a.client.bduss === client.bduss);
      if (sameCookie) return duplicate(sameCookie);
      const verified = await identify(client);
      if (verified.error) return verified;
      const conflict = await findDuplicate(client, verified.id);
      if (conflict) return conflict;
      commit(toRecords(pool.accounts).concat([{
        id: spec.id, alias: spec.alias ?? spec.id,
        priority: Number.isFinite(spec.priority) ? spec.priority : pool.accounts.length,
        disabled: !!spec.disabled, bduss: client.bduss, stoken: client.stoken,
        upstream_user_id: verified.id,
      }]));
      const account = pool.accounts.find((a) => a.id === spec.id);
      let desktop_login;
      if (initializeDesktop) {
        try { desktop_login = await initializeDesktop(account); }
        catch { desktop_login = { ok: false, status: 'verification_pending', code: 'desktop_initialization_error', message: '账号已保存，但电脑端初始化结果暂时无法确认，请手动查询状态' }; }
      }
      return { ok: true, minted, account, ...(desktop_login ? { desktop_login } : {}) };
    });
  }
  function patch(id, body) {
    return serial(async () => {
      let a = pool.accounts.find((x) => x.id === id);
      if (!a) return failure(404, 'unknown account');
      if ('priority' in body && !Number.isFinite(body.priority)) return failure(400, 'priority must be a number');
      let client;
      let identity = a.upstream_user_id;
      if ('bduss' in body || 'stoken' in body) {
        try { client = new KukuAccount({ bduss: body.bduss !== undefined ? body.bduss : a.client.bduss, stoken: body.stoken !== undefined ? body.stoken : a.client.stoken }); }
        catch { return failure(400, 'bduss/stoken must be non-empty'); }
        const verified = await identify(client);
        if (verified.error) return verified;
        identity = verified.id;
        // Existing duplicate rows may refresh the same user, but cannot change to another
        // user already represented in the pool. New additions remain blocked either way.
        const conflict = await findDuplicate(client, identity, id);
        if (conflict && !(conflict.error.code === 'account_already_exists' && a.upstream_user_id === identity)) return conflict;
      }
      a = pool.accounts.find((x) => x.id === id);
      if (!a) return failure(404, 'unknown account');
      const records = toRecords(pool.accounts);
      const record = records.find((x) => x.id === id);
      if (client) Object.assign(record, { bduss: client.bduss, stoken: client.stoken, upstream_user_id: identity });
      for (const key of ['alias', 'priority', 'disabled']) if (key in body) record[key] = key === 'disabled' ? !!body.disabled : body[key];
      commit(records);
      a = pool.accounts.find((x) => x.id === id);
      if (client) { a.auth_dead = false; a.balance_dead_until = 0; a.cooldown_until = 0; }
      return { ok: true, account: a };
    });
  }
  return { add, patch };
}
