// Login-to-add-account sessions: QR scan and SMS code.
//
// Both flows end the same way — a (BDUSS, PTOKEN) pair that never existed in this process
// before — so both hand that pair to `finish()`, which mints the STOKEN, proves the pair works
// against 库库AI, and only then puts the account in the pool. Cookies never leave this module:
// no route here can echo them, by construction.
import {
  seedDeviceCookie,
  getApiToken,
  createQr,
  qrImage,
  captchaImage,
  pollQr,
  bdussLogin,
  exchangeStoken,
  verifyKukuLogin,
  sendSmsCode,
  smsLogin,
  PassportError,
} from './passport.mjs';

const QR_TTL_MS = 4 * 60_000;
const SMS_TTL_MS = 10 * 60_000;

export function createLoginManager({ addAccount, listAccounts = () => [], deviceId = '', onAdded = () => {} } = {}) {
  const sessions = new Map();

  const sweep = () => {
    for (const [id, s] of sessions) if (Date.now() > s.expires_at && s.state !== 'added') sessions.delete(id);
  };

  const nextAccountId = () => {
    const taken = new Set(listAccounts().map((a) => a.id));
    let n = taken.size;
    while (taken.has(`kuku-${n}`)) n += 1;
    return `kuku-${n}`;
  };

  // The single tail every login flow shares.
  async function finish(s, { bduss, ptoken, diag = null }) {
    // A failure is recorded on the session: a UI polling every second must not re-run the whole
    // passport exchange (and re-mint tickets) once per poll for the rest of the session's TTL.
    const fail = (reason, code = null) => {
      s.state = 'failed';
      s.failure = { state: 'failed', reason, code, ...(diag ? { diag } : {}) };
      return s.failure;
    };
    if (!bduss) return fail('the login did not hand back a BDUSS');
    if (!ptoken) return fail('login returned BDUSS but no PTOKEN, so the STOKEN cannot be fetched');
    let stoken;
    try {
      stoken = await exchangeStoken({ bduss, ptoken, jar: s.jar });
    } catch (e) {
      return fail(e.message, e.code ?? null);
    }
    try {
      await verifyKukuLogin({ bduss, stoken, deviceId });
    } catch (e) {
      return fail(`the pair was accepted by passport but 库库AI refused it: ${e.message}`);
    }
    const id = s.account_id ?? nextAccountId();
    const added = await addAccount({ id, allocateId: nextAccountId, alias: s.alias || (s.kind === 'qr' ? `扫码新增 ${id}` : `短信新增 ${id}`), priority: s.priority, bduss, stoken, device_id: deviceId });
    if (added.error) {
      const result = fail(added.error.message, added.error.code ?? added.error.status ?? null);
      if (added.error.account_id) result.account_id = added.error.account_id;
      s.jar = null;
      s.sign = '';
      return result;
    }
    s.state = 'added';
    s.account_id = added.account.id;
    // The pool now owns the credential; the jar that minted it (BDUSS/PTOKEN/STOKEN cookies) has
    // no reason to stay reachable in memory for the rest of the process' life.
    s.jar = null;
    s.sign = '';
    s.failure = null;
    s.desktop_login = added.desktop_login ?? null;
    onAdded(s.account_id);
    return { state: 'added', account_id: s.account_id, login_type: s.kind, ...(s.desktop_login ? { desktop_login: s.desktop_login } : {}) };
  }

  async function startQr(spec = {}) {
    sweep();
    // One device cookie jar for the whole attempt: getqrcode, the unicast channel and the final
    // bdusslogin all have to look like the same browser.
    const jar = await seedDeviceCookie({});
    const token = await getApiToken({ jar }).catch(() => '');
    const qr = await createQr({ jar, token });
    const id = `lq-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    sessions.set(id, { id, kind: 'qr', jar, sign: qr.sign, alias: spec.alias, priority: spec.priority, state: 'pending', created_at: Date.now(), expires_at: Date.now() + QR_TTL_MS, inflight: null });
    return {
      login_id: id,
      image_path: `/pool/admin/login/qr/${id}.png`,
      poll_path: `/pool/admin/login/qr/${id}`,
      prompt: qr.prompt,
      expires_in_ms: QR_TTL_MS,
      scanned_by: '百度App（库库登录页没有微信/QQ 扫码这条路径，见 §14）',
    };
  }

  async function image(id) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'qr') return null;
    return qrImage({ sign: s.sign, jar: s.jar });
  }

  async function pollQrSession(id) {
    const s = sessions.get(id);
    if (!s) return { error: 'unknown or expired login session', status: 404 };
    if (s.state === 'added') return { state: 'added', account_id: s.account_id, ...(s.desktop_login ? { desktop_login: s.desktop_login } : {}) };
    if (s.state === 'failed') return s.failure;
    if (Date.now() > s.expires_at) return { state: 'expired' };
    // A UI polling every second must not stack up upstream calls or race itself into two adds.
    if (s.inflight) return s.inflight;
    s.inflight = (async () => {
      const r = await pollQr({ sign: s.sign, jar: s.jar });
      if (r.state !== 'confirmed') return { state: r.state, probe: r.probe };
      const bl = await bdussLogin({ bduss: r.bduss, jar: s.jar }).catch((e) => ({ error: e.message }));
      // Measured: channel_v.v is a 32-char ticket, not a BDUSS. bdusslogin is what materialises
      // the real pair into this jar (BDUSS 192 / PTOKEN 32), so take the credentials from there
      // and only fall back to the ticket if bdusslogin handed nothing back.
      const bduss = s.jar.get('BDUSS') || s.jar.get('BDUSS_BFESS') || r.bduss;
      const ptoken = s.jar.get('PTOKEN') || s.jar.get('PTOKEN_BFESS') || '';
      // Lengths and field names only — never a credential value. Without this the only symptom
      // of a bad input is passport's opaque "params not correct".
      const diag = {
        unicast_fields: r.probe?.keys ?? '',
        bdusslogin: bl.error ?? `${bl.keys ?? ''}${bl.data_keys ? `|data:${bl.data_keys}` : ''}`,
        ptoken_source: s.jar.has('PTOKEN') ? 'PTOKEN' : s.jar.has('PTOKEN_BFESS') ? 'PTOKEN_BFESS' : 'none',
        cookies: s.jar.credentialNames().join(','),
        bduss_len: String(bduss).length,
        ptoken_len: String(ptoken).length,
      };
      return finish(s, { bduss, ptoken, diag });
    })()
      .catch((e) => ({ state: 'failed', reason: e instanceof PassportError ? e.message : String(e?.message ?? e) }))
      .finally(() => {
        s.inflight = null;
      });
    return s.inflight;
  }

  async function startSms(spec = {}) {
    sweep();
    const jar = await seedDeviceCookie({});
    const token = await getApiToken({ jar });
    const id = `ls-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const s = { id, kind: 'sms', jar, token, phone: String(spec.phone ?? ''), alias: spec.alias, priority: spec.priority, vcode: null, state: 'new', created_at: Date.now(), expires_at: Date.now() + SMS_TTL_MS, sends: 0 };
    sessions.set(id, s);
    return applySend(s, spec.captcha);
  }

  async function applySend(s, captcha) {
    const r = await sendSmsCode({ phone: s.phone, token: s.token, jar: s.jar, countrycode: s.countrycode, captcha });
    s.sends += 1;
    if (r.state === 'captcha_required') {
      s.vcode = { vcodestr: r.vcodestr, vcodesign: r.vcodesign };
      s.captchaUrl = r.captcha_url;
      s.state = 'captcha_required';
      // The image is served by us on purpose: passport binds it to this process's device cookie.
      return { state: 'captcha_required', login_id: s.id, captcha_path: `/pool/admin/login/sms/captcha/${s.id}`, message: r.message };
    }
    if (r.state !== 'sent') return { state: r.state, login_id: s.id, message: r.message ?? '', errno: r.errno };
    s.state = 'sent';
    return { state: 'sent', login_id: s.id, message: '验证码已发送到该手机号' };
  }

  async function resendSms(id, captcha) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'sms') return { error: 'unknown or expired login session', status: 404 };
    if (s.sends >= 5) return { error: 'too many code requests for this session', status: 429 };
    return applySend(s, captcha ?? s.vcode);
  }

  async function verifySmsSession({ login_id: id, code }) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'sms') return { error: 'unknown or expired login session', status: 404 };
    if (s.state === 'added') return { state: 'added', account_id: s.account_id, login_type: s.kind, ...(s.desktop_login ? { desktop_login: s.desktop_login } : {}) };
    if (s.state === 'failed') return s.failure;
    if (!code) return { error: 'code is required', status: 400 };
    const r = await smsLogin({ phone: s.phone, code, token: s.token, jar: s.jar, vcode: s.vcode ?? {} });
    if (r.state !== 'logged_in') {
      if (r.state !== 'captcha_required') return r;
      s.vcode = { vcodestr: r.vcodestr, vcodesign: '' };
      s.captchaUrl = r.captcha_url;
      return { state: r.state, login_id: id, captcha_path: `/pool/admin/login/sms/captcha/${id}`, message: r.message, slide: r.slide };
    }
    return finish(s, r);
  }

  function verifySms(spec) {
    const s = sessions.get(spec.login_id);
    if (!s || s.kind !== 'sms') return Promise.resolve({ error: 'unknown or expired login session', status: 404 });
    if (s.inflight) return s.inflight;
    s.inflight = verifySmsSession(spec).finally(() => { s.inflight = null; });
    return s.inflight;
  }

  async function captcha(id) {
    const s = sessions.get(id);
    if (!s?.captchaUrl) return null;
    return captchaImage({ url: s.captchaUrl, jar: s.jar });
  }

  return { startQr, image, pollQr: pollQrSession, startSms, resendSms, verifySms, captcha, size: () => sessions.size };
}
