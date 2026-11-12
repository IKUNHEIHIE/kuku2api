// SCNet login-to-add sessions: phone + SMS code -> long-lived access token -> free activity
// key -> pool. Cookies never leave this module; routes only ever hand back an account id.
import { scnetPassport } from './scnet-passport.mjs';

const SMS_TTL_MS = 10 * 60_000;
const SMS_RESEND_MS = 60_000;
const SMS_MAX_SENDS = 5;
const PW_TTL_MS = 10 * 60_000;
const PW_MAX_ATTEMPTS = 5;

export function createScnetLoginManager({ addAccount, listAccounts = () => [], passport = scnetPassport, now = Date.now, logger = null } = {}) {
  const sessions = new Map();

  const sweep = () => {
    for (const [id, s] of sessions) if (now() > s.expires_at && !s.inflight && s.state !== 'added') sessions.delete(id);
  };
  const nextAccountId = () => {
    const taken = new Set(listAccounts().map((a) => a.id));
    let n = taken.size;
    while (taken.has(`scnet-${n}`)) n += 1;
    return `scnet-${n}`;
  };
  const timing = (s) => ({
    expires_in_ms: Math.max(0, s.expires_at - now()),
    retry_after_ms: Math.max(0, s.retry_at - now()),
    sends_remaining: Math.max(0, SMS_MAX_SENDS - s.sends),
  });
  const expired = () => ({ error: '登录会话已过期，请重新发起', status: 404, code: 'login_session_expired' });

  async function start(spec = {}) {
    sweep();
    const phone = String(spec.phone ?? '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return { error: '请输入正确的11位中国大陆手机号', status: 400, code: 'invalid_phone' };
    const sent = await passport.sendPhoneCode({ phone });
    const id = `scs-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const s = { id, phone, cookies: sent.cookies, alias: spec.alias, priority: spec.priority,
      state: 'sent', created_at: now(), expires_at: now() + SMS_TTL_MS, sends: 1, retry_at: now() + SMS_RESEND_MS, inflight: null };
    sessions.set(id, s);
    return { state: 'sent', login_id: id, message: '验证码已发送到该手机号', ...timing(s) };
  }

  async function resend(id) {
    const s = sessions.get(id);
    if (!s || s.kind === 'password') return expired();
    if (s.state === 'added' || s.state === 'failed') return { error: '本次登录已结束，请重新发起', status: 409, code: 'login_session_finished' };
    if (s.inflight) return { error: '登录操作正在处理中，请稍后重试', status: 409, code: 'login_in_progress' };
    if (s.sends >= SMS_MAX_SENDS) return { error: '本会话短信发送次数已达上限，请重新发起', status: 429, code: 'sms_send_limit', ...timing(s) };
    if (now() < s.retry_at) return { error: `请等待 ${Math.ceil((s.retry_at - now()) / 1000)} 秒后重发`, status: 429, code: 'sms_cooldown', ...timing(s) };
    const sent = await passport.sendPhoneCode({ phone: s.phone });
    s.cookies = [...s.cookies, ...sent.cookies];
    s.sends += 1;
    s.retry_at = now() + SMS_RESEND_MS;
    return { state: 'sent', login_id: id, message: '验证码已重新发送', ...timing(s) };
  }

  async function verify(spec = {}) {
    const id = spec.login_id;
    const s = sessions.get(id);
    if (!s || s.kind === 'password') return expired();
    if (s.state === 'added') return { state: 'added', account_id: s.account_id, login_type: 'scnet_sms', refreshed_existing: s.refreshed_existing === true };
    if (s.state === 'failed') return s.failure;
    if (now() >= s.expires_at) { sessions.delete(id); return expired(); }
    if (s.inflight) return { error: '登录操作正在处理中，请稍后重试', status: 409, code: 'login_in_progress' };
    const code = String(spec.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return { error: '请输入6位数字短信验证码', status: 400, code: 'invalid_sms_code' };
    s.inflight = (async () => {
      const logged = await passport.loginWithPhoneCode({ code, cookies: s.cookies });
      if (!logged.user?.id) throw Object.assign(new Error('上游未返回账号身份'), { status: 502 });
      const derived = await passport.activityApiKey({ token: logged.accessToken, cookies: logged.cookies });
      const accountId = s.account_id ?? nextAccountId();
      const added = await addAccount({ platform: 'scnet', id: accountId, allocateId: nextAccountId,
        alias: s.alias || `超算新增 ${accountId}`, priority: s.priority,
        accessToken: logged.accessToken, apiKey: derived.apiKey, cookies: logged.cookies, refreshExisting: true });
      if (added.error) {
        const result = { state: 'failed', reason: added.error.message, code: added.error.code ?? added.error.status ?? null };
        if (added.error.account_id) result.account_id = added.error.account_id;
        s.state = 'failed'; s.failure = result; s.cookies = [];
        return result;
      }
      s.state = 'added';
      s.account_id = added.account.id;
      s.refreshed_existing = added.refreshed_existing === true;
      s.cookies = [];
      s.phone = '';
      return { state: 'added', account_id: s.account_id, login_type: 'scnet_sms', refreshed_existing: s.refreshed_existing };
    })().catch((e) => {
      // A wrong code is a normal refusal; never include cookies or the OTP in diagnostics.
      logger?.warn?.('scnet sms login verification:', JSON.stringify({ code: e?.code ?? null, status: e?.status ?? null }));
      const result = { state: 'failed', reason: e?.message ?? String(e), code: e?.code ?? null };
      s.state = 'failed'; s.failure = result; s.cookies = [];
      return result;
    }).finally(() => { s.inflight = null; });
    return s.inflight;
  }

  // ---- Account-password login ----
  // The plaintext password is encrypted once and never retained; only the ciphertext (which
  // only SCNet can decrypt) lives in the session, and only while a captcha challenge is open.
  const newSessionId = () => `scs-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const pwFailure = (s, e) => {
    logger?.warn?.('scnet password login:', JSON.stringify({ code: e?.code ?? null, status: e?.status ?? null }));
    const result = { state: 'failed', reason: e?.message ?? String(e), code: e?.code ?? null };
    s.state = 'failed'; s.failure = result; s.encrypted = ''; s.cookies = [];
    return result;
  };

  async function runPasswordLogin(s, { captcha = '', captchaKey = '' } = {}) {
    const logged = await passport.loginWithPassword({ username: s.username, encryptedPassword: s.encrypted, captcha, captchaKey, cookies: s.cookies });
    if (!logged.user?.id) throw Object.assign(new Error('上游未返回账号身份'), { status: 502 });
    const derived = await passport.activityApiKey({ token: logged.accessToken, cookies: logged.cookies });
    const accountId = s.account_id ?? nextAccountId();
    const added = await addAccount({ platform: 'scnet', id: accountId, allocateId: nextAccountId,
      alias: s.alias || `超算新增 ${accountId}`, priority: s.priority,
      accessToken: logged.accessToken, apiKey: derived.apiKey, cookies: logged.cookies, refreshExisting: true });
    if (added.error) {
      const result = { state: 'failed', reason: added.error.message, code: added.error.code ?? added.error.status ?? null };
      if (added.error.account_id) result.account_id = added.error.account_id;
      s.state = 'failed'; s.failure = result; s.encrypted = ''; s.cookies = [];
      return result;
    }
    s.state = 'added';
    s.account_id = added.account.id;
    s.refreshed_existing = added.refreshed_existing === true;
    s.encrypted = ''; s.cookies = []; s.username = '';
    return { state: 'added', account_id: s.account_id, login_type: 'scnet_password', refreshed_existing: s.refreshed_existing };
  }

  async function startPassword(spec = {}) {
    sweep();
    const username = String(spec.username ?? '').trim();
    const password = String(spec.password ?? '');
    if (!username) return { error: '请输入用户名或手机号', status: 400, code: 'invalid_username' };
    if (!password) return { error: '请输入登录密码', status: 400, code: 'invalid_password' };
    const id = newSessionId();
    const s = { id, kind: 'password', username, encrypted: passport.encryptPassword(password), cookies: [],
      alias: spec.alias, priority: spec.priority, state: 'pending', created_at: now(), expires_at: now() + PW_TTL_MS, attempts: 0, inflight: null };
    sessions.set(id, s);
    let check;
    try { check = await passport.captchaNeeded({}); }
    catch (e) { return pwFailure(s, e); }
    s.cookies = check.cookies;
    if (check.needed) {
      let cap;
      try { cap = await passport.getCaptcha({ cookies: s.cookies }); }
      catch (e) { return pwFailure(s, e); }
      s.cookies = cap.cookies; s.captchaKey = cap.captchaKey; s.state = 'captcha';
      return { state: 'captcha', login_id: id, captcha_image: cap.image, captcha_key: cap.captchaKey, expires_in_ms: Math.max(0, s.expires_at - now()) };
    }
    s.inflight = runPasswordLogin(s).catch((e) => pwFailure(s, e)).finally(() => { s.inflight = null; });
    return s.inflight;
  }

  async function verifyPassword(spec = {}) {
    const s = sessions.get(spec.login_id);
    if (!s || s.kind !== 'password') return expired();
    if (s.state === 'added') return { state: 'added', account_id: s.account_id, login_type: 'scnet_password', refreshed_existing: s.refreshed_existing === true };
    if (s.state === 'failed') return s.failure;
    if (now() >= s.expires_at) { sessions.delete(s.id); return expired(); }
    if (s.inflight) return { error: '登录操作正在处理中，请稍后重试', status: 409, code: 'login_in_progress' };
    if (s.state !== 'captcha') return { error: '本次登录已结束，请重新发起', status: 409, code: 'login_session_finished' };
    const captcha = String(spec.captcha ?? '').trim();
    if (!captcha) return { error: '请输入图形验证码', status: 400, code: 'invalid_captcha' };
    if (s.attempts >= PW_MAX_ATTEMPTS) return { error: '本次登录尝试次数已达上限，请重新发起', status: 429, code: 'login_attempt_limit' };
    s.attempts += 1;
    s.inflight = runPasswordLogin(s, { captcha, captchaKey: s.captchaKey }).catch((e) => pwFailure(s, e)).finally(() => { s.inflight = null; });
    return s.inflight;
  }

  return { start, resend, verify, startPassword, verifyPassword, size: () => sessions.size };
}