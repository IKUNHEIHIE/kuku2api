// SCNet (超算互联网) client protocol. Only the free model SCNet-Max is supported:
// the credential is the account's "activity" API key (the same one the desktop client
// derives), never a paid platform key created through /llm/api-key/create.
//
// Auth chain: SMS code OR account password -> access token (JWT, ~7 days) ->
// createActivityApiKey -> sk-... key used as `Authorization: Bearer` against the
// OpenAI-compatible LLM gateway.
import crypto from 'node:crypto';
import { UpstreamError } from './upstream.mjs';

export const SCNET_MODEL = 'SCNet-Max';
export const SCNET_WEB = 'https://www.scnet.cn';
export const SCNET_LLM = 'https://api.scnet.cn/api/llm/v1';
const CLIENT_VERSION = '4.1.2';
const APP_HEADERS = { source: 'Electron', version: CLIENT_VERSION };

// The desktop client's fixed 512-bit RSA public key; the password is encrypted with
// PKCS1 before it ever leaves the machine. Only SCNet holds the matching private key.
const SCNET_RSA_PUBLIC_KEY = 'MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALaXEnbjI6fjy+t9W9AiO/KS0q+b/OZFS+7ykinLbiriUx9P8BcuuHnVbXNiZp5jW70eVGBtX4DhGUPzJa1YT/8CAwEAAQ==';

function encryptPassword(password) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${SCNET_RSA_PUBLIC_KEY}\n-----END PUBLIC KEY-----`;
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(password), 'utf8')).toString('base64');
}

// SMS and password logins return the same platform envelope; normalise both into one shape.
function loginPayload(data, cookies) {
  const user = data?.data ?? {};
  if (!user.token) throw new UpstreamError('登录成功但未返回访问令牌', { status: 502 });
  return {
    accessToken: String(user.token),
    refreshToken: typeof user['X-Jwt-Refresh-Token'] === 'string' ? user['X-Jwt-Refresh-Token'] : '',
    cookies,
    user: {
      id: String(user.id ?? ''),
      userName: String(user.userName ?? ''),
      fullName: String(user.fullName ?? ''),
      phone: String(user.mobilephoneNum ?? ''),
    },
  };
}

const authError = (message, data, status = 401) =>
  new UpstreamError(message, { code: String(data?.code ?? data?.error?.code ?? '401'), status, body: data });

function platformError(data, status) {
  const message = String(data?.msg ?? data?.error?.message ?? '超算互联网请求失败').slice(0, 300);
  const code = String(data?.code ?? data?.error?.code ?? '');
  if (status === 401 || code === '401' || code === '1015') return authError(message, data, 401);
  return new UpstreamError(message, { code: code || undefined, status: status >= 400 ? status : 400, body: data });
}

function networkError(error) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return new UpstreamError(timeout ? '超算互联网请求超时' : `network: ${error?.message ?? error}`, {
    network: true, code: timeout ? 'upstream_timeout' : undefined, status: timeout ? 504 : 502,
  });
}

function cookieHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : []).map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookies(existing, setCookies) {
  const jar = new Map();
  for (const pair of [...(existing ?? []), ...(setCookies ?? [])]) {
    const pairText = String(pair).split(';')[0].trim();
    const i = pairText.indexOf('=');
    if (i > 0) jar.set(pairText.slice(0, i), pairText.slice(i + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`);
}

export function createScnetPassport({ fetchImpl } = {}) {
  // Resolve lazily so tests (and future transports) can replace global fetch after import.
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  async function request(url, { method = 'GET', form, json, headers = {}, cookies, token, signal, timeoutMs = 20_000 } = {}) {
    const h = { Accept: 'application/json', ...APP_HEADERS, ...headers };
    const cookie = cookieHeader(cookies);
    if (cookie) h.Cookie = cookie;
    if (token) h.Token = token;
    let body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    try { res = await doFetch(url, { method, headers: h, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch (e) { throw networkError(e); }
    return res;
  }

  async function platformJson(res) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new UpstreamError(`超算互联网返回了非 JSON 响应 (HTTP ${res.status})`, { status: 502, body: text.slice(0, 200) });
    }
    if (String(data?.code ?? '') !== '0') throw platformError(data, res.status);
    return data;
  }

  const setCookiesOf = (res) => res.headers.getSetCookie?.() ?? [];

  return {
    encryptPassword,
    async sendPhoneCode({ phone, signal } = {}) {
      const res = await request(`${SCNET_WEB}/ac/api/auth/sendDesktopClientPhoneCode.action`, {
        method: 'POST', form: { phoneNum: String(phone) }, signal,
      });
      const data = await platformJson(res);
      return { message: data?.msg ?? '', cookies: mergeCookies([], setCookiesOf(res)) };
    },

    async loginWithPhoneCode({ code, cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/ac/api/auth/loginDesktopClientByPhoneCode.action`, {
        method: 'POST', form: { messageCode: String(code), isSevenDaysValidity: 'true' }, cookies, signal,
      });
      const data = await platformJson(res);
      return loginPayload(data, mergeCookies(cookies, setCookiesOf(res)));
    },

    // Account-password login. The password is RSA-encrypted (PKCS1) exactly as the desktop
    // client does; pass `encryptedPassword` to reuse a ciphertext across a captcha retry so
    // the plaintext never has to be retained. A fresh session normally needs no captcha.
    async loginWithPassword({ username, password, encryptedPassword, captcha = '', captchaKey = '', cookies, signal } = {}) {
      const enc = encryptedPassword ?? encryptPassword(password);
      const res = await request(`${SCNET_WEB}/ac/api/auth/loginDesktopClient.action`, {
        method: 'POST',
        form: { username: String(username), password: enc, encrypted: 'true', isSevenDaysValidity: 'true', captcha: String(captcha), captchaKey: String(captchaKey) },
        cookies, signal,
      });
      let data;
      try { data = await platformJson(res); }
      catch (e) {
        if (e?.code === '1014') throw authError('用户名或密码错误', { code: '1014' }, 401);
        throw e;
      }
      return loginPayload(data, mergeCookies(cookies, setCookiesOf(res)));
    },

    // Whether this session must solve a graphic captcha before logging in (endpoint name
    // keeps upstream's "Cpatcha" typo). Returns the session cookies so the check and the
    // subsequent login share one jsessionid.
    async captchaNeeded({ cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/ac/api/auth/isNeedCpatcha.action`, { cookies, signal });
      const data = await platformJson(res);
      return { needed: data?.data === true, cookies: mergeCookies(cookies, setCookiesOf(res)) };
    },

    async getCaptcha({ cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/ac/api/auth/getClientCaptcha.action`, {
        method: 'POST', form: { ph: '1' }, cookies, signal,
      });
      const data = await platformJson(res);
      const image = typeof data?.data === 'string' ? data.data : '';
      const captchaKey = String(data?.captchaKey ?? '');
      if (!image || !captchaKey) throw new UpstreamError('图形验证码不可用', { status: 502 });
      return { image, captchaKey, cookies: mergeCookies(cookies, setCookiesOf(res)) };
    },

    // Session hand-off: the long-lived access token stays the management credential; this
    // endpoint only mints a fresh short-lived session (and new cookies).
    async loginWithToken({ token, signal } = {}) {
      const res = await request(`${SCNET_WEB}/ac/api/auth/loginDesktopClientByToken.action`, {
        method: 'POST', form: { desktopToken: String(token) }, signal,
      });
      const data = await platformJson(res);
      return { cookies: mergeCookies([], setCookiesOf(res)), data: data?.data ?? {} };
    },

    async currentUser({ token, cookies, refresh = false, signal } = {}) {
      const query = refresh ? '?includeToken=true&refresh=true' : '';
      const res = await request(`${SCNET_WEB}/acx/user/users/current-user-info${query}`, { token, cookies, signal });
      const data = await platformJson(res);
      return { data: data?.data ?? {}, cookies: mergeCookies(cookies, setCookiesOf(res)) };
    },

    async clusters({ token, cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/acx/user/users/cluster-user-detail`, { token, cookies, signal });
      const data = await platformJson(res);
      return Array.isArray(data?.data) ? data.data : [];
    },

    // The free credential: same call the official client makes. Returns a key bound to the
    // account's activity (SCNet-Max free tier); it cannot serve paid models.
    async activityApiKey({ token, cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/acx/llm/api-key/createActivityApiKey`, {
        method: 'POST', json: {}, token, cookies, signal,
      });
      const data = await platformJson(res);
      const key = data?.data?.apiKey;
      if (typeof key !== 'string' || !key) throw new UpstreamError('活动 Key 不可用', { status: 502 });
      return { apiKey: key, baseUrl: data?.data?.baseUrl ?? SCNET_LLM, model: data?.data?.model ?? null };
    },

    async balance({ token, cookies, signal } = {}) {
      const res = await request(`${SCNET_WEB}/acx/charge/flow/current-user-balance`, {
        method: 'POST', json: {}, token, cookies, signal,
      });
      const data = await platformJson(res);
      return data?.data ?? {};
    },

    // Zero-cost credential probe: 200 with a usable key, 401 with a dead one.
    async models({ apiKey, signal, timeoutMs = 20_000 } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await doFetch(`${SCNET_LLM}/models`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) { throw networkError(e); }
    },

    // Raw LLM gateway call; the caller owns streaming/parsing. Never throws on HTTP status.
    async chat({ apiKey, body, signal, timeoutMs = 300_000 } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await doFetch(`${SCNET_LLM}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) { throw networkError(e); }
    },
  };
}

export const scnetPassport = createScnetPassport();

export async function readPlatformJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new UpstreamError(`超算互联网返回了非 JSON 响应 (HTTP ${res.status})`, { status: 502, body: text.slice(0, 200) });
  }
}