import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

// Only built public files are served. API routes, dotfiles and source/data never fall back to the SPA.
export function createStaticUi(directory) {
  return async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return false; }
    if (/^\/(?:v1|pool|healthz)(?:\/|$)/.test(pathname)
      || pathname.includes('\\') || pathname.includes('\0')
      || pathname.split('/').some(p => p.startsWith('.'))) return false;
    let root;
    try { root = await realpath(directory); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    let candidate = path.resolve(root, '.' + pathname);
    if (!inside(root, candidate)) return false;
    let info;
    try { info = await stat(candidate); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    if (!info?.isFile()) {
      // Missing assets must be 404 rather than HTML disguised as JavaScript.
      if (path.extname(pathname) || pathname.startsWith('/assets/')) return false;
      candidate = path.join(root, 'index.html');
      try { info = await stat(candidate); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    }
    if (!info.isFile() || !inside(root, await realpath(candidate))) return false;
    res.writeHead(200, { 'content-type': TYPES[path.extname(candidate)] ?? 'application/octet-stream',
      'content-length': info.size, 'x-content-type-options': 'nosniff',
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(candidate);
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    }
    return true;
  };
}
