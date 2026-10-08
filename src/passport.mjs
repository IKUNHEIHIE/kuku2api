// Baidu passport client for the "add an account by logging in" flow.
//
// Why this file exists: BDUSS is not enough for 库库AI — every /wenchain call needs
// (BDUSS, STOKEN), and STOKEN is minted by passport, not by kuku. Both STOKEN and PTOKEN are
// httpOnly, so a user cannot copy them out of DevTools; the only scalable way to add an
// account is to complete a real login here and take the cookies from the responses.
//
// Everything below is plain HTTP against passport.baidu.com. The QR issue step is measured;
// the scan-state poll and the SMS legs follow the widget's own call sites (see docs/API.md
// §14 for how each was verified).
import { KukuAccount } from './upstream.mjs';
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) GenFlowPro/1.6.5.130 Chrome/120.0.0.0 Electron/28.0.0.0 Safari/537.36';

export function passportBase() {
  return process.env.PASSPORT_BASE_URL ?? 'https://passport.baidu.com';
}

export class PassportError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = 'PassportError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

// One jar per login attempt: two people scanning at the same time must not share a session.
export function createJar(initial = {}) {
  const cookies = new Map(Object.entries(initial));
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (k) => cookies.get(k),
    has: (k) => cookies.has(k),
    set: (k, v) => cookies.set(k, v),
    absorb(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '' || /expired/i.test(c)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    // Only the account-scoped cookies matter downstream; BAIDUID etc. stay inside the jar.
    credentialNames: () => [...cookies.keys()].filter((k) => /^(BDUSS|PTOKEN|STOKEN|PASS_STOKEN)/.test(k)),
  };
}

async function call(url, { method = 'GET', body = null, jar, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: {
        'user-agent': UA,
        // passport hotlink-checks /v2/api/?getapi: without a Referer it answers 404 HTML rather
        // than the JSON the flow needs, which reads as "endpoint missing".
        referer: 'https://kuku.baidu.com/genflowpro/login',
        accept: raw ? 'image/png,image/*;*q=0.5' : 'application/json, text/plain, */*',
        // An empty `Cookie:` header is its own 404 trigger on some passport routes.
        ...(jar && jar.header() ? { cookie: jar.header() } : {}),
        ...headers,
      },
    });
  } catch (e) {
    throw new PassportError(`passport unreachable: ${e.message}`, { network: true });
  }
  jar?.absorb(res);
  if (raw) return { res, status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* passport answers HTML on 404 and JSONP when asked — caller decides */
  }
  return { res, status: res.status, json, text };
}

const GENERIC = { apiver: 'v3', tpl: 'genflowpro' };

// passport answers JSONP for most of these; a `callback` name is what makes it emit one.
const jsonpName = () => `bd__cbs__${Math.random().toString(36).slice(2, 9)}`;
const unwrapJsonp = (text) => {
  const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(String(text ?? ''));
  const body = m ? m[1] : text;
  try {
    return JSON.parse(body);
  } catch {
    try {
      // passport answers with *JS*, not JSON: `loginrecord:{ 'email':[] }`. The widget evals it;
      // we only normalise the single-quoted keys rather than run upstream code through a parser.
      return JSON.parse(String(body).replace(/([,{\s])'([^']+)'\s*:/g, '$1"$2":'));
    } catch {
      return null;
    }
  }
};

// passport hands out a real token only to a jar that already carries a device cookie; without
// BAIDUID the `token` field comes back containing an error string instead.
export async function seedDeviceCookie({ jar = createJar() } = {}) {
  if (jar.has('BAIDUID') || jar.has('BAIDUID_BFESS')) return jar;
  await call(`${passportBase()}/`, { jar });
  return jar;
}

/**
 * The anti-CSRF token every subsequent login call must carry (`bdstoken` on senddpass, `token`
 * on ?login). Measured: `?getapi` 404s without a Referer, and returns a fake token without a
 * device cookie — both are silent failures, so both are checked here instead of downstream.
 */
export async function getApiToken({ jar } = {}) {
  const session = jar ?? (await seedDeviceCookie({}));
  if (!session.has('BAIDUID') && !session.has('BAIDUID_BFESS')) await seedDeviceCookie({ jar: session });
  const q = new URLSearchParams({ ...GENERIC, tt: String(Date.now()), apiType: 'login', loginType: 'basicLogin', callback: jsonpName() });
  const { json, text, status } = await call(`${passportBase()}/v2/api/?getapi&${q}`, { jar: session });
  const parsed = json ?? unwrapJsonp(text);
  const token = parsed?.data?.token;
  if (!/^[0-9a-f]{32}$/.test(String(token ?? ''))) {
    throw new PassportError(`getapi gave no token (http ${status}${token ? `: ${String(token).slice(0, 40)}` : ''})`, { status, body: parsed ?? String(text).slice(0, 160) });
  }
  return token;
}

/**
 * Issue a login QR. Measured: works with no credentials at all (only device cookies come back),
 * so nothing about an existing account is touched here.
 */
export async function createQr({ jar = createJar(), token = '' } = {}) {
  const q = new URLSearchParams({ lp: 'pc', qrloginfrom: 'pc', gid: '', oauthLog: '', ...GENERIC, tt: String(Date.now()), callback: jsonpName() });
  const { json, text, status } = await call(`${passportBase()}/v2/api/getqrcode?${q}`, { jar });
  const parsed = json ?? unwrapJsonp(text);
  if (!parsed?.sign || Number(parsed.errno) !== 0) {
    throw new PassportError(`getqrcode refused (http ${status}${parsed ? ` errno=${parsed.errno}` : ''})`, {
      code: parsed?.errno,
      status,
      body: parsed ?? text.slice(0, 200),
    });
  }
  return { sign: parsed.sign, image_url: `https://${parsed.imgurl}`, prompt: parsed.prompt ?? '', token };
}

export async function qrImage({ sign, jar = createJar(), lp = 'pc' }) {
  const url = `${passportBase()}/v2/api/qrcode?sign=${encodeURIComponent(sign)}&lp=${lp}&qrloginfrom=pc`;
  // Measured twice against the real passport: the fetch taken immediately after getqrcode can
  // answer 200 with a zero-length body, and the same sign serves a real PNG seconds later.
  // Returning the empty body would render a blank box the user cannot scan.
  let buffer = Buffer.alloc(0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await call(url, { jar, raw: true });
    if (res.status !== 200) throw new PassportError(`qr image http ${res.status}`, { status: res.status });
    buffer = res.buffer;
    if (buffer.length > 0) return buffer;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new PassportError('qr image came back empty three times', { status: 200 });
}

/**
 * The graphic captcha is bound to the BAIDUID of whoever asked for it — that is this process,
 * not the operator's browser — so the image has to be fetched here and handed over. Loading it
 * from passport directly would produce a code that never matches.
 */
export async function captchaImage({ url, jar }) {
  const { buffer, status, res } = await call(url, { jar, raw: true });
  if (status !== 200) throw new PassportError(`captcha http ${status}`, { status });
  return { buffer, content_type: res.headers.get('content-type') ?? 'image/jpeg' };
}

/**
 * One poll tick of the QR. The widget does not re-read getqrcode or logincheck for this: it
 * opens a unicast channel keyed by the sign and reads `channel_v`, a *stringified* object whose
 * `status` is "0" confirmed (then `v` carries the fresh BDUSS), "1" scanned, "2" expired.
 * Measured while nothing had scanned: `{"errno":1}`.
 */
export async function pollQr({ sign, jar }) {
  const q = new URLSearchParams({ channel_id: sign, gid: '', _sdkFrom: '1', ...GENERIC, tt: String(Date.now()), callback: jsonpName() });
  const { json, text, status } = await call(`${passportBase()}/channel/unicast?${q}`, { jar });
  const parsed = json ?? unwrapJsonp(text);
  if (!parsed) throw new PassportError(`qr channel poll returned no json (http ${status})`, { status, body: text.slice(0, 160) });
  let ch = parsed.channel_v;
  if (typeof ch === 'string') {
    try {
      ch = JSON.parse(ch);
    } catch {
      ch = null;
    }
  }
  const errno = Number(parsed.errno);
  const st = ch ? String(ch.status) : null;
  if (errno === 0 && st === '0' && ch.v) return { state: 'confirmed', bduss: ch.v, target: ch.u ?? '', probe: { errno, status: st, keys: Object.keys(ch).join(',') } };
  if (errno === 0 && st === '1') return { state: 'scanned', probe: { errno, status: st } };
  if (errno === 0 && st === '2') return { state: 'expired', probe: { errno, status: st } };
  // Anything else is reported verbatim rather than guessed at — a wrong guess here is how a
  // login flow ships looking broken when it is only unfamiliar.
  return { state: 'pending', probe: { errno, status: st, keys: Object.keys(parsed).join(',') } };
}

/**
 * Materialise the phone-approved login into this jar (the widget's own JSONP step). Without it
 * passport knows the QR was scanned but never hands the session cookies to the polling client.
 */
export async function bdussLogin({ bduss, jar, u = 'https://kuku.baidu.com' }) {
  const q = new URLSearchParams({ bduss, u, qrcode: '1', ...GENERIC, tt: String(Date.now()), callback: jsonpName() });
  const { json, text, status } = await call(`${passportBase()}/v2/api/bdusslogin?${q}`, { jar });
  const parsed = json ?? unwrapJsonp(text);
  // Measured: a refusal carries errno (a fake ticket answers {"errno":-9999}), while success
  // answers {data, errInfo} with NO errno at all. Requiring errno===0 here discarded every real
  // login and left the flow holding the 32-char ticket instead of the 192-char BDUSS.
  const errno = parsed?.errno === undefined ? null : Number(parsed.errno);
  const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : 'unparsed';
  // A 404 HTML page parses to nothing: "no errno" must not be read as success, or a failed login
  // would walk on holding whatever cookies the jar happens to already have.
  if (errno === null && (!parsed || typeof parsed !== 'object')) {
    throw new PassportError(`bdusslogin returned no usable body (http ${status})`, { code: null, status });
  }
  if (errno !== null && errno !== 0) {
    throw new PassportError(`bdusslogin refused (errno ${errno}, fields: ${keys})`, { code: errno, status });
  }
  return {
    u: parsed?.data?.u ?? u,
    keys,
    data_keys: parsed?.data && typeof parsed.data === 'object' ? Object.keys(parsed.data).join(',') : '',
  };
}

/**
 * Ask passport for an SMS verification code. Field names come from the widget's own submit
 * (`lt.js:388497`); the captcha leg is reported as `errno` 18/19/21 with a fresh `vcodestr`.
 * Not exercised end to end yet — sending a code to a real phone is a real-world side effect,
 * so the first run must be the user's own number on purpose.
 */
export async function sendSmsCode({ phone, token, countrycode = '86', jar, captcha = null }) {
  if (!/^\d{6,15}$/.test(String(phone))) throw new PassportError('phone must be digits only');
  const p = {
    gid: '',
    username: String(phone),
    countrycode,
    bdstoken: token,
    flag_code: '0',
    client: '',
    mkey: '',
    moonshad: moonshad(String(phone)),
    supportdv: '1',
    dv: '',
    ...GENERIC,
    tt: String(Date.now()),
    callback: jsonpName(),
  };
  if (captcha?.vcodestr) {
    p.vcodestr = captcha.vcodestr;
    p.vcodesign = captcha.vcodesign ?? '';
    p.verifycode = captcha.code ?? '';
  }
  const { json, text } = await call(`${passportBase()}/v2/api/senddpass?${new URLSearchParams(p)}`, { jar });
  const parsed = json ?? unwrapJsonp(text) ?? {};
  const d = parsed.data ?? parsed;
  const errno = Number(parsed.errno ?? d.errno ?? -1);
  if (errno === 18 || errno === 19 || errno === 21) {
    const vc = String(d.vcodestr ?? parsed.vcodestr ?? '');
    return {
      state: 'captcha_required',
      errno,
      vcodestr: vc,
      vcodesign: String(d.vcodesign ?? parsed.vcodesign ?? ''),
      captcha_url: vc ? `${passportBase()}/cgi-bin/genimage?${vc}` : '',
      message: String(parsed.msg ?? d.msg ?? ''),
    };
  }
  if (errno === 27) return { state: 'unregistered', errno, message: String(parsed.msg ?? '') };
  if (errno !== 0) return { state: 'refused', errno, message: String(parsed.msg ?? d.msg ?? ''), raw: parsed };
  return { state: 'sent', errno, upsms: d.upsms ?? null, raw: parsed };
}

/**
 * Finish an SMS login. The widget posts the typed code as `password` (plus `smsCodeString`) to
 * `?login` with `isdpass=1`, so no RSA is involved on this path — RSA only guards typed
 * passwords, and 库库 has password login switched off.
 */
export async function smsLogin({ phone, code, token, jar, vcode = {}, u = 'https://kuku.baidu.com' }) {
  const body = new URLSearchParams({
    username: String(phone),
    password: String(code),
    smsCodeString: String(code),
    isdpass: '1',
    smsVcodestr: vcode.vcodestr ?? '',
    smsVcodesign: vcode.vcodesign ?? '',
    switchuname: '',
    subpro: '',
    idc: '',
    gid: '',
    mkey: '',
    is_voice_sms: '0',
    voice_sms_flag: '0',
    u,
    staticPage: '/m-static/genflow-login/thirdparty/pass_v3_jump.html',
    loginMerge: '1',
    memberPass: 'true',
    isPhone: '1',
    charset: 'utf8',
    token,
    ...GENERIC,
    tt: String(Date.now()),
  });
  const { json, text, status } = await call(`${passportBase()}/v2/api/?login`, {
    method: 'POST',
    body: body.toString(),
    jar,
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      origin: passportBase(),
      referer: `${passportBase()}/v2/?logintype=sms`,
    },
  });
  const parsed = json ?? unwrapJsonp(text) ?? {};
  const d = parsed.data ?? {};
  const no = Number(parsed.errInfo?.no ?? parsed.errno ?? -1);
  if (no !== 0) {
    const vc = String(d.codeString ?? d.verifyStr ?? '');
    return {
      state: vc ? 'captcha_required' : 'refused',
      code: no,
      message: String(d.msg ?? parsed.msg ?? `login refused (errInfo ${no})`),
      vcodestr: vc,
      captcha_url: vc ? `${passportBase()}/cgi-bin/genimage?${vc}` : '',
      slide: String(d.isslide ?? '') === '1',
      status,
    };
  }
  const bduss = jar.get('BDUSS') ?? jar.get('BDUSS_BFESS');
  const ptoken = jar.get('PTOKEN') ?? jar.get('PTOKEN_BFESS');
  if (!bduss) return { state: 'no_cookie', code: no, message: 'login reported success but handed back no BDUSS', jar: jar.credentialNames() };
  return { state: 'logged_in', bduss, ptoken: ptoken ?? '' };
}

// Reproduced from the widget (`lt.js:387558`): md5(phone + "Moonshadow"), then five single
// (non-global!) letter doublings. It looks like obfuscation and it is, but senddpass checks it.
function moonshad(phone) {
  const l = createHash('md5').update(`${phone}Moonshadow`).digest('hex');
  return l.replace(/o/, 'ow').replace(/d/, 'do').replace(/a/, 'ad').replace(/h/, 'ha').replace(/s/, 'sh').replace(/n/, 'ns').replace(/m/, 'mo');
}

/**
 * Turn a logged-in (BDUSS, PTOKEN) pair into the STOKEN this product needs. This is exactly
 * the client's own fallback body — the native variant signs the same two values.
 */

// The client's native engine (genflow_engine_get_login_auth_param) signs the STOKEN exchange
// with a compiled-in key; without it passport answers errno 110003 even for valid BDUSS/PTOKEN.
// Formula confirmed three ways: two synthetic inputs through the real DLL via koffi, plus the
// md5 recomputed from the captured real request matched its sig byte-for-byte.
const ENGINE_SIGN_KEY = '34868b316de55815273b2616954b0286';

// The engine's own UA, from the captured /v3/login/api/auth request. A browser UA works for the
// QR legs but the exchange leg may be fingerprinted, so use the exact client string.
const ENGINE_UA = 'genflow;1.6.5;PC;PC-Windows;10.0.26200;GenFlowPro';

export function loginAuthBody({ bduss, ptoken }) {
  const signed = `appid=1&bduss=${bduss}&ptoken=${ptoken}&return_type=1&tpl=genflowpro&tpl_list=genflowpro|netdisk&sign_key=${ENGINE_SIGN_KEY}`;
  const sig = createHash('md5').update(signed).digest('hex');
  return `appid=1&bduss=${bduss}&ptoken=${ptoken}&return_type=1&tpl=genflowpro&tpl_list=genflowpro|netdisk&sig=${sig}`;
}

export async function exchangeStoken({ bduss, ptoken, jar = createJar() }) {
  if (!bduss || !ptoken) throw new PassportError('bduss and ptoken are both required');
  const form = loginAuthBody({ bduss, ptoken });
  // The captured request also carried gfprotpl=genflowpro next to BAIDUID; plant it if the flow
  // has not picked it up yet so the jar matches the client byte-for-byte.
  if (jar.has('BAIDUID') && !jar.has('gfprotpl')) jar.set('gfprotpl', 'genflowpro');
  const { json, status, text } = await call(`${passportBase()}/v3/login/api/auth`, {
    method: 'POST',
    body: form,
    jar,
    headers: {
      'user-agent': ENGINE_UA,
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });
  const errno = json?.errno === undefined ? 0 : Number(json.errno);
  const stoken = json?.stoken_list?.genflowpro;
  if (!json || errno !== 0 || !stoken) {
    // Never quote the raw response: this message travels back to the caller as the failure
    // `reason`, and passport echoes request fragments into some of its error bodies.
    const fields = json && typeof json === 'object' ? Object.keys(json).join(',') : `unparsed(http ${status})`;
    throw new PassportError(`stoken exchange refused: ${json?.errmsg ?? json?.show_msg ?? `no stoken in response (fields: ${fields})`}`, {
      code: errno,
      status,
    });
  }
  return stoken;
}

/**
 * Prove a (BDUSS, STOKEN) pair is actually usable against 库库AI before putting it in the pool.
 * Zero cost: /wenchain/.../clientmessage/list is a read-only login probe.
 */
export async function verifyKukuLogin({ bduss, stoken }) {
  const client = new KukuAccount({ id: 'probe', bduss, stoken });
  const data = await client.probe();
  return { ok: true, data };
}
