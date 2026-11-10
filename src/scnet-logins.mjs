// SCNet login-to-add sessions: phone + SMS code -> long-lived access token -> free activity
// key -> pool. Cookies never leave this module; routes only ever hand back an account id.
import { scnetPassport } from './scnet-passport.mjs';

const SMS_TTL_MS = 10 * 60_000;
const SMS_RESEND_MS = 60_000;
const SMS_MAX_SENDS = 5;

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
    if (!s) return expired();
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
    if (!s) return expired();
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

  return { start, resend, verify, size: () => sessions.size };
}