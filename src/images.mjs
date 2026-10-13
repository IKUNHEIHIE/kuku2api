import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024, MAX_IMAGES = 10;
function invalid(message, code = 'invalid_image', status = 400) {
  return Object.assign(new Error(message), { status, code, retryUnsafe: true });
}
export function imageName(part) {
  return `image_${createHash('sha256').update(part.image_url.url).digest('hex').slice(0,24)}`;
}
export function publicImageAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      && !(a === 203 && b === 0 && c === 113) && !(a === 192 && b === 88 && c === 99);
  }
  // Only globally routable IPv6 unicast; reject mapped IPv4 and transition networks.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [first,second] = address.split(':').map(p=>parseInt(p || '0',16));
  return first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && !(first === 0x3fff && second <= 0xfff);
}
function remoteUrl(value) {
  let url; try { url = new URL(value); } catch { throw invalid('Invalid image URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host
      || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')
      || (isIP(host) && !publicImageAddress(host))) throw invalid('Image URL must use a public HTTP(S) address', 'unsafe_image_url');
  return url;
}
export function imageBytes(bytes, declaredType) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw invalid('Each image must contain 1 byte to 10 MiB', 'image_too_large');
  const mime = bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16) === 'IHDR' ? 'image/png'
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.length >= 13 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) ? 'image/gif'
    : bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null;
  if (!mime || (declaredType && declaredType !== mime)) throw invalid('Image bytes must match PNG, JPEG, GIF or WebP content', 'invalid_image');
  return { bytes, mime };
}
function dataImage(url) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4) throw invalid('Invalid base64 image data URL');
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES/3)*4) throw invalid('Image exceeds 10 MiB', 'image_too_large');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw invalid('Image base64 is not canonical');
  return imageBytes(bytes, match[1]);
}
export function normalizeImagePart(part) {
  if (part.file_id != null) throw invalid('Image file_id is unavailable; send image_url or a base64 data URL', 'unsupported_image_reference');
  const spec = part.type === 'image_url' ? part.image_url : { url: part.image_url, detail: part.detail };
  if (!spec || typeof spec !== 'object' || typeof spec.url !== 'string') throw invalid('Image URL must be a string');
  const detail = spec.detail ?? 'auto';
  if (!['auto','low','high','original'].includes(detail)) throw invalid('Invalid image detail');
  if (spec.url.startsWith('data:')) dataImage(spec.url); else remoteUrl(spec.url);
  return { type: 'image_url', image_url: { url: spec.url, detail } };
}

// Pin an already checked DNS result to the socket. Redirects are checked independently;
// no upstream cookies or caller authorization headers enter the download request.
export async function downloadImage(value, signal, dependencies = {}) {
  const resolve = dependencies.lookup ?? lookup, transports = dependencies.transports ?? { 'http:': http, 'https:': https };
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  async function resolveWithinDeadline(hostname) {
    if (deadline.aborted) throw invalid('Image download was cancelled', 'image_download_failed', 502);
    let interrupted;
    const cancelled = new Promise((_,reject) => {
      interrupted = () => reject(invalid('Image DNS lookup was cancelled or timed out', 'image_download_failed', 502));
      deadline.addEventListener('abort', interrupted, { once: true });
    });
    try { return await Promise.race([resolve(hostname, { all: true, verbatim: true }), cancelled]); }
    catch (error) { if (error.code === 'image_download_failed') throw error; throw invalid('Image DNS lookup failed', 'image_download_failed', 502); }
    finally { deadline.removeEventListener('abort', interrupted); }
  }
  async function get(value, redirects = 0) {
    const url = remoteUrl(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveWithinDeadline(hostname);
    if (!addresses.length || addresses.some(a => !publicImageAddress(a.address))) throw invalid('Image URL resolved to a private or reserved address', 'unsafe_image_url');
    const address = addresses.find(a => a.family === 4) ?? addresses[0];
    return new Promise((resolve, reject) => {
      const req = transports[url.protocol].get(url, { signal: deadline, agent: false,
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'user-agent': 'kuku2api-image-fetch' },
        lookup: (host, options, callback) => callback(null, options?.all ? [address] : address.address, address.family),
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          res.resume();
          if (!res.headers.location || redirects >= 3) return reject(invalid('Image redirect limit exceeded', 'image_download_failed', 502));
          let next; try { next = new URL(res.headers.location, url).href; } catch { return reject(invalid('Invalid image redirect')); }
          get(next, redirects + 1).then(resolve, reject); return;
        }
        if (res.statusCode !== 200) { res.resume(); return reject(invalid('Image download returned a non-success status', 'image_download_failed', 502)); }
        if (Number(res.headers['content-length']) > MAX_IMAGE_BYTES) { res.destroy(); return reject(invalid('Image exceeds 10 MiB', 'image_too_large')); }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > MAX_IMAGE_BYTES) { reject(invalid('Image exceeds 10 MiB', 'image_too_large')); res.destroy(); } else chunks.push(chunk); });
        res.on('end', () => { try { resolve(imageBytes(Buffer.concat(chunks))); } catch(e) { reject(e); } });
        res.on('error', () => reject(invalid('Image response was interrupted', 'image_download_failed', 502)));
      });
      req.on('error', () => reject(invalid('Image download failed or timed out', 'image_download_failed', 502)));
    });
  }
  return get(value);
}
export function imageParts(messages) {
  return messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
}
export function validateImages(messages) {
  const parts = imageParts(messages);
  if (parts.length > MAX_IMAGES) throw invalid('At most 10 images may be supplied', 'image_too_large');
  let size = 0;
  for (const part of parts) if (part.image_url.url.startsWith('data:')) size += dataImage(part.image_url.url).bytes.length;
  if (size > MAX_TOTAL) throw invalid('Combined images exceed 20 MiB', 'image_too_large');
}
const cache = new WeakMap();
export async function prepareImages(messages, client, sessionId, signal, ownsAccount = () => true) {
  const parts = imageParts(messages); validateImages(messages);
  if (!parts.length) return [];
  const identity = createHash('sha256').update(`${client.bduss}\0${client.stoken}`).digest('hex');
  let stored = cache.get(client);
  if (stored?.identity !== identity) { stored = { identity, files: new Map() }; cache.set(client, stored); }
  let size = 0; const files = [];
  for (const part of parts) {
    const source = part.image_url.url;
    const image = source.startsWith('data:') ? dataImage(source) : await downloadImage(source, signal);
    size += image.bytes.length;
    if (size > MAX_TOTAL) throw invalid('Combined images exceed 20 MiB', 'image_too_large');
    if (!ownsAccount()) throw invalid('Account identity changed before image upload', 'session_account_mismatch', 409);
    const key = createHash('sha256').update(image.bytes).digest('hex');
    let file = stored.files.get(key);
    if (!file || file.expires < Date.now()) {
      file = { ...await client.uploadImage(image, signal), expires: Date.now() + 60*60*1000 };
      stored.files.set(key, file);
      while (stored.files.size > 64) stored.files.delete(stored.files.keys().next().value);
    }
    files.push({ fsId: String(file.fsId), name: file.name, reference: imageName(part) });
  }
  if (!ownsAccount()) throw invalid('Account identity changed before image association', 'session_account_mismatch', 409);
  try { await client.attachImages([...new Set(files.map(f => f.fsId))], sessionId, signal); }
  catch (error) { stored.files.clear(); error.retryUnsafe = true; throw error; }
  return files;
}
