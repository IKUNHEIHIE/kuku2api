import { KukuAccount } from './upstream.mjs';
import { ScnetAccount } from './scnet-upstream.mjs';
import { toRecords } from './store.mjs';
import { exchangeStoken } from './passport.mjs';

// Add and credential rotation share a queue: checking before an awaited upstream read
// would let simultaneous login sessions both insert the same user.
export function createAccountManager({ pool, store, deviceId, initializeDesktop = null, exchange = exchangeStoken, now = Date.now, makeClient = record => new KukuAccount(record) }) {
  let pending = Promise.resolve();
  const serial = (fn) => {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  };
  const failure = (status, message, code, extra = {}) => ({ error: { status, message, code, ...extra } });
  const duplicate = (a) => failure(409, '该百度账号已存在于号池，请使用已有账号；如需更新登录凭据，请编辑该账号', 'account_already_exists', { account_id: a.id });
  const cleanPtoken = value => {
    if (typeof value !== 'string' || !value.replace(/[\s;]/g, '')) throw new Error('PTOKEN must be non-empty');
    return value.replace(/[\s;]/g, '');
  };
  const commit = (records) => {
    // A failed disk write must not leave a phantom account in the live pool.
    store?.save({ default_device_id: deviceId, accounts: records });
    pool.set(records);
    for (const a of pool.accounts) a.deviceId = deviceId;
  };
  async function identify(client) {
    try { return { id: await client.userIdentity() }; }
    catch { return failure(502, '无法核实账号身份，请稍后重试或更新已有账号的登录凭据', 'account_identity_unavailable', { type: 'upstream_error' }); }
  }
  async function findDuplicate(client, identity, exceptId = null) {
    const clientPlatform = client.platform ?? 'baidu';
    const sameLogin = (a) => clientPlatform === 'scnet'
      ? a.client.accessToken === client.accessToken
      : a.client.bduss === client.bduss;
    for (const a of [...pool.accounts]) {
      if (a.id === exceptId) continue;
      if ((a.platform ?? 'baidu') !== clientPlatform) continue;
      if (sameLogin(a) || (a.upstream_user_id && a.upstream_user_id === identity)) return duplicate(a);
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
  async function addScnet(spec) {
    if (typeof spec?.id !== 'string' || !spec.id) return failure(400, 'id is required');
    if (typeof spec?.accessToken !== 'string' || !spec.accessToken) return failure(400, 'accessToken is required');
    if (typeof spec?.apiKey !== 'string' || !spec.apiKey) return failure(400, 'apiKey is required');
    const sameId = pool.accounts.find((a) => a.id === spec.id);
    if (sameId) return duplicate(sameId);
    let client;
    try {
      client = new ScnetAccount({ access_token: spec.accessToken, api_key: spec.apiKey, cookies: Array.isArray(spec.cookies) ? spec.cookies : [] });
    } catch { return failure(400, 'accessToken/apiKey must be non-empty'); }
    const sameLogin = pool.accounts.find((a) => a.platform === 'scnet' && a.client.accessToken === client.accessToken);
    if (sameLogin && !spec.refreshExisting) return duplicate(sameLogin);
    const verified = await identify(client);
    if (verified.error) return verified;
    const conflict = await findDuplicate(client, verified.id);
    if (conflict && !(spec.refreshExisting && conflict.error?.code === 'account_already_exists')) return conflict;
    // Activation of a freshly issued activity key can lag a few minutes; keep the account, let
    // the refresher prove it later instead of making the user redo the SMS login.
    let keyStatus = { status: 'valid', message: '' };
    try { await client.probe(); }
    catch (e) { keyStatus = { status: e?.status === 401 ? 'refresh_failed' : 'error', message: '活动 Key 正在生效，系统将自动重试校验' }; }
    const credential = { ...keyStatus, checked_at: now(), refreshed_at: now(), attempted_at: now() };
    const scnetRecord = {
      platform: 'scnet', access_token: client.accessToken, api_key: client.apiKey, cookies: [...client.cookies], upstream_user_id: verified.id,
    };
    const existing = conflict ? pool.accounts.find((a) => a.id === conflict.error.account_id) : null;
    if (existing) {
      if (existing.upstream_user_id && existing.upstream_user_id !== verified.id) return failure(409, '账号身份已变化，拒绝覆盖已有账号', 'account_identity_mismatch');
      const records = toRecords(pool.accounts), record = records.find((a) => a.id === existing.id);
      Object.assign(record, scnetRecord, { credential });
      commit(records);
      const account = pool.accounts.find((a) => a.id === existing.id);
      account.auth_dead = false; account.cooldown_until = 0; account.balance_dead_until = 0;
      return { ok: true, account, refreshed_existing: true };
    }
    commit(toRecords(pool.accounts).concat([{
      id: spec.id, alias: spec.alias ?? spec.id,
      priority: Number.isFinite(spec.priority) ? spec.priority : pool.accounts.length,
      disabled: !!spec.disabled, ...scnetRecord, credential,
    }]));
    return { ok: true, account: pool.accounts.find((a) => a.id === spec.id) };
  }
  function add(spec) {
    return serial(async () => {
      if (typeof spec?.allocateId === 'function') spec = { ...spec, id: spec.allocateId() };
      if (spec?.ptoken !== undefined) {
        try { spec = { ...spec, ptoken: cleanPtoken(spec.ptoken) }; }
        catch { return failure(400, 'PTOKEN must be non-empty'); }
      }
      if (spec?.platform === 'scnet') return addScnet(spec);
      if (typeof spec?.id !== 'string' || !spec.id || !spec?.bduss) return failure(400, 'id and bduss are required');
      const sameId = pool.accounts.find((a) => a.id === spec.id);
      if (sameId) return duplicate(sameId);
      let stoken = spec.stoken;
      let minted = false;
      if (!stoken && spec.ptoken) {
        try { stoken = await exchange({ bduss: spec.bduss, ptoken: spec.ptoken }); minted = true; }
        catch { return failure(502, 'ptoken → stoken exchange refused', 'stoken_exchange_failed', { type: 'upstream_error' }); }
      }
      let client;
      try { client = new KukuAccount({ bduss: spec.bduss, stoken }); }
      catch { return failure(400, 'bduss/stoken must be non-empty'); }
      const sameCookie = pool.accounts.find((a) => a.client.bduss === client.bduss);
      if (sameCookie && !spec.refreshExisting) return duplicate(sameCookie);
      const verified = await identify(client);
      if (verified.error) return verified;
      const conflict = await findDuplicate(client, verified.id);
      if (conflict && !(spec.refreshExisting && conflict.error?.code === 'account_already_exists')) return conflict;
      const existing = conflict ? pool.accounts.find(a => a.id === conflict.error.account_id) : null;
      if (existing) {
        if (existing.upstream_user_id && existing.upstream_user_id !== verified.id) return failure(409, '账号身份已变化，拒绝覆盖已有账号', 'account_identity_mismatch');
        const records = toRecords(pool.accounts), record = records.find(a => a.id === existing.id);
        Object.assign(record, { bduss: client.bduss, stoken: client.stoken, upstream_user_id: verified.id, ptoken: spec.ptoken ? cleanPtoken(spec.ptoken) : '',
          credential: { status: 'valid', checked_at: now(), refreshed_at: spec.ptoken ? now() : null, attempted_at: now(), message: '' } });
        commit(records);
        const account = pool.accounts.find(a => a.id === existing.id);
        account.auth_dead = false; account.cooldown_until = 0;
        return { ok: true, minted, account, refreshed_existing: true };
      }
      commit(toRecords(pool.accounts).concat([{
        id: spec.id, alias: spec.alias ?? spec.id,
        priority: Number.isFinite(spec.priority) ? spec.priority : pool.accounts.length,
        disabled: !!spec.disabled, bduss: client.bduss, stoken: client.stoken,
        upstream_user_id: verified.id,
        ...(spec.ptoken ? { ptoken: cleanPtoken(spec.ptoken) } : {}),
        credential: { status: 'valid', checked_at: now(), refreshed_at: spec.ptoken ? now() : null, attempted_at: now(), message: '' },
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
  async function patchScnet(a, body) {
    if ('priority' in body && !Number.isFinite(body.priority)) return failure(400, 'priority must be a number');
    if (['bduss', 'stoken', 'ptoken'].some((k) => k in body)) return failure(400, 'scnet accounts do not use Baidu credentials');
    let client = a.client, rotated = false;
    if (body.accessToken !== undefined || body.apiKey !== undefined) {
      try {
        client = new ScnetAccount({ access_token: body.accessToken ?? a.client.accessToken, api_key: body.apiKey ?? a.client.apiKey, cookies: a.client.cookies });
      } catch { return failure(400, 'accessToken/apiKey must be non-empty'); }
      const verified = await identify(client);
      if (verified.error) return verified;
      const conflict = await findDuplicate(client, verified.id, a.id);
      if (conflict) return conflict;
      rotated = true;
    }
    const records = toRecords(pool.accounts), record = records.find((x) => x.id === a.id);
    record.platform = 'scnet';
    if (rotated) Object.assign(record, { access_token: client.accessToken, api_key: client.apiKey, cookies: [...client.cookies],
      credential: { status: 'valid', checked_at: now(), refreshed_at: now(), attempted_at: now(), message: '' } });
    for (const key of ['alias', 'priority', 'disabled']) if (key in body) record[key] = key === 'disabled' ? !!body.disabled : body[key];
    commit(records);
    const updated = pool.accounts.find((x) => x.id === a.id);
    if (rotated) { updated.auth_dead = false; updated.balance_dead_until = 0; updated.cooldown_until = 0; }
    return { ok: true, account: updated };
  }
  function patch(id, body) {
    return serial(async () => {
      let a = pool.accounts.find((x) => x.id === id);
      if (!a) return failure(404, 'unknown account');
      if (a.platform === 'scnet') return patchScnet(a, body);
      if ('priority' in body && !Number.isFinite(body.priority)) return failure(400, 'priority must be a number');
      let client;
      let identity = a.upstream_user_id;
      if (body.stoken !== undefined && body.ptoken !== undefined) return failure(400, 'send either stoken or ptoken, not both');
      let nextPtoken;
      if ('ptoken' in body) {
        try { nextPtoken = cleanPtoken(body.ptoken); }
        catch { return failure(400, 'PTOKEN must be non-empty'); }
      }
      if ('bduss' in body || 'stoken' in body || 'ptoken' in body) {
        let stoken = body.stoken !== undefined ? body.stoken : a.client.stoken;
        if (nextPtoken) {
          try { stoken = await exchange({ bduss: body.bduss ?? a.client.bduss, ptoken: nextPtoken }); }
          catch { return failure(502, 'PTOKEN 换取 STOKEN 失败，原凭据保留', 'stoken_exchange_failed'); }
        }
        try { client = new KukuAccount({ bduss: body.bduss !== undefined ? body.bduss : a.client.bduss, stoken }); }
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
      if (client) Object.assign(record, { bduss: client.bduss, stoken: client.stoken, upstream_user_id: identity,
        ptoken: nextPtoken ?? (client.bduss === a.client.bduss ? a.ptoken : ''),
        credential: { status: 'valid', checked_at: now(), refreshed_at: nextPtoken ? now() : null, attempted_at: now(), message: '' } });
      for (const key of ['alias', 'priority', 'disabled']) if (key in body) record[key] = key === 'disabled' ? !!body.disabled : body[key];
      commit(records);
      a = pool.accounts.find((x) => x.id === id);
      if (client) { a.auth_dead = false; a.balance_dead_until = 0; a.cooldown_until = 0; }
      return { ok: true, account: a };
    });
  }
  function remove(id) {
    return serial(() => {
      if (!pool.accounts.some(a => a.id === id)) return failure(404, `unknown account ${id}`);
      commit(toRecords(pool.accounts).filter(a => a.id !== id));
      return { ok: true };
    });
  }
  function resequence() {
    return serial(() => {
      const records = toRecords(pool.accounts).sort((a, b) => a.priority - b.priority);
      records.forEach((a, i) => { a.priority = i; });
      commit(records);
      return { ok: true };
    });
  }
  async function refreshScnet(account) {
    const id = account.id;
    const original = { accessToken: account.client.accessToken, apiKey: account.client.apiKey, cookies: [...account.client.cookies], identity: account.upstream_user_id };
    let apiKey = original.apiKey, cookies = original.cookies, refreshed = false, valid = false, invalidLogin = false, drained = false, message = '', errorCode = null;
    let client = new ScnetAccount({ access_token: original.accessToken, api_key: original.apiKey, cookies });
    try {
      await client.probe();
      valid = true;
    } catch (e) {
      errorCode = e.code ?? null;
      if (e?.status === 401) {
        // A rotated activity key is recoverable with the still-valid management token.
        try {
          const next = await client.activityKey();
          client = new ScnetAccount({ access_token: original.accessToken, api_key: next, cookies });
          await client.probe();
          apiKey = next; refreshed = true; valid = true; errorCode = null;
          message = '已重新获取活动 Key';
        } catch (e2) {
          errorCode = e2.code ?? errorCode;
          invalidLogin = e2?.status === 401;
          message = invalidLogin ? '登录或活动 Key 已失效，请重新短信登录' : '上游暂不可用，已保留原凭据，将定时重试';
        }
      } else if (e?.status === 402) {
        // Free-quota exhaustion is a retry window, not a dead login.
        drained = true;
        message = '活动 Key 免费额度已用尽或受限，将在稍后重试';
      } else {
        message = '上游暂不可用，已保留原凭据，将定时重试';
      }
    }
    if (valid) {
      // The management JWT is long-lived; rolling the session keeps the SMS re-login rare.
      try { await client.keepAlive(); cookies = [...client.cookies]; }
      catch { if (!message) message = '会话续期暂时失败，推理不受影响'; }
    }
    const current = pool.accounts.find((a) => a.id === id);
    if (!current || current.client.accessToken !== original.accessToken || current.client.apiKey !== original.apiKey) {
      return { id, ok: false, status: 'changed', message: '账号凭据已变更，本次刷新结果已丢弃' };
    }
    const credential = { ...(account.credential ?? {}), status: valid ? (message ? 'refresh_failed' : 'valid') : invalidLogin ? 'invalid' : 'error',
      checked_at: now(), attempted_at: now(), refreshed_at: refreshed ? now() : account.credential?.refreshed_at ?? null, message, error_code: errorCode };
    const records = toRecords(pool.accounts), record = records.find((a) => a.id === id);
    Object.assign(record, valid
      ? { access_token: original.accessToken, api_key: apiKey, cookies, credential }
      : { credential });
    commit(records);
    const updated = pool.accounts.find((a) => a.id === id);
    if (valid) { updated.auth_dead = false; if (updated.cooldown_until) updated.cooldown_until = 0; }
    else if (invalidLogin) pool.markAuthDead(updated);
    else if (drained) pool.markBalanceDead(updated);
    return { id, ok: valid && !message, refreshed, status: credential.status, can_refresh: true,
      checked_at: credential.checked_at, refreshed_at: credential.refreshed_at, message, code: errorCode };
  }
  function refresh(id) {
    if (pool.credentialRefreshes.has(id)) return pool.credentialRefreshes.get(id);
    const result = serial(async () => {
      const account = pool.accounts.find(a => a.id === id);
      if (!account) return { id, ok: false, status: 'missing', message: '账号已不存在' };
      if (account.disabled) return { id, ok: false, skipped: true, status: 'disabled', message: '账号已停用' };
      if (pool.activeAccounts.has(id)) return { id, ok: false, skipped: true, status: 'busy', message: '账号正在处理请求，稍后自动再试' };
      if (account.platform === 'scnet') return refreshScnet(account);
      const original = { bduss: account.client.bduss, stoken: account.client.stoken, identity: account.upstream_user_id };
      let client = account.client, identity = original.identity, refreshed = false, valid = false, failed = false, invalidLogin = false, errorCode = null, message = '';
      try {
        if (account.ptoken) {
          const stoken = await exchange({ bduss: original.bduss, ptoken: account.ptoken });
          client = makeClient({ bduss: original.bduss, stoken });
          refreshed = true;
        }
        await client.probe();
        identity = await client.userIdentity();
        if (original.identity && identity !== original.identity) throw Object.assign(new Error('identity changed'), { code: 'account_identity_mismatch' });
        valid = true;
        if (!account.ptoken) message = '当前登录有效；缺少 PTOKEN，请重新扫码或短信登录以启用自动续期';
      } catch (error) {
        failed = true;
        errorCode = error.code ?? null;
        refreshed = false; client = account.client; identity = original.identity;
        try { await client.probe(); const actual = await client.userIdentity(); valid = !identity || actual === identity; identity = actual; }
        catch (probeError) { valid = false; invalidLogin = pool.isAuthFailure(probeError); }
        message = valid ? '续期暂未成功，原登录仍有效，将定时重试' : invalidLogin ? '登录已失效，请重新扫码或短信登录' : '上游暂不可用，已保留原凭据，将定时重试';
      }
      const current = pool.accounts.find(a => a.id === id);
      if (!current || current.client.bduss !== original.bduss || current.client.stoken !== original.stoken || current.upstream_user_id !== original.identity) {
        return { id, ok: false, status: 'changed', message: '账号凭据已变更，本次刷新结果已丢弃' };
      }
      const credential = { ...account.credential, status: valid ? (failed ? 'refresh_failed' : 'valid') : invalidLogin ? 'invalid' : 'error',
        checked_at: now(), attempted_at: now(), refreshed_at: refreshed ? now() : account.credential.refreshed_at ?? null, message, error_code: errorCode };
      const records = toRecords(pool.accounts), record = records.find(a => a.id === id);
      Object.assign(record, { credential, ...(valid ? { upstream_user_id: identity } : {}), ...(refreshed ? { stoken: client.stoken } : {}) });
      commit(records);
      const updated = pool.accounts.find(a => a.id === id);
      if (valid) { if (updated.auth_dead) updated.cooldown_until = 0; updated.auth_dead = false; }
      else if (invalidLogin) pool.markAuthDead(updated);
      return { id, ok: valid && !failed, refreshed, status: credential.status, can_refresh: !!updated.ptoken,
        checked_at: credential.checked_at, refreshed_at: credential.refreshed_at, message, code: errorCode };
    });
    pool.credentialRefreshes.set(id, result);
    const done = () => { if (pool.credentialRefreshes.get(id) === result) pool.credentialRefreshes.delete(id); };
    result.then(done, done);
    return result;
  }
  return { add, patch, remove, resequence, refresh };
}
