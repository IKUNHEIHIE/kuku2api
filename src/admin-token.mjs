import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Explicit operator configuration wins. Otherwise a local secret survives reinstall/restart.
export function resolveAdminToken({ file = path.join(ROOT, 'admin-token.json'), store = null, envToken = process.env.ADMIN_TOKEN, logger = console } = {}) {
  if (typeof envToken === 'string' && envToken.trim()) return envToken;
  if (store) {
    const saved = store.load();
    if (saved?.token !== undefined) {
      if (!/^kuku-admin-[A-Za-z0-9_-]{43}$/.test(saved.token)) throw new Error('Database has an invalid administrator token; restore a verified backup');
      return saved.token;
    }
    const initialized = store.initialize({ token: `kuku-admin-${randomBytes(32).toString('base64url')}` });
    if (!/^kuku-admin-[A-Za-z0-9_-]{43}$/.test(initialized.value?.token ?? '')) throw new Error('Database has an invalid administrator token; restore a verified backup');
    if (initialized.created) {
      logger.log('首次初始化：已生成管理员强令牌（仅本次显示）：');
      logger.log(initialized.value.token);
      logger.log('请立即保存此令牌，并在控制台系统设置中填写管理员令牌。令牌已保存在本机 SQLite 数据库，请勿分享。');
    }
    return initialized.value.token;
  }
  const load = () => {
    let raw;
    try { raw = readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') throw e;
      throw new Error('admin-token.json cannot be read; restore the saved file before starting');
    }
    let saved;
    try { saved = JSON.parse(raw); }
    catch { throw new Error('admin-token.json is not valid JSON; restore the saved file before starting'); }
    if (!/^kuku-admin-[A-Za-z0-9_-]{43}$/.test(saved?.token ?? '')) {
      throw new Error('admin-token.json has an invalid token; restore the saved file before starting');
    }
    return saved.token;
  };
  try { return load(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  const token = `kuku-admin-${randomBytes(32).toString('base64url')}`;
  try {
    writeFileSync(file, JSON.stringify({ token }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') return load(); // Another installer created it first.
    throw new Error('admin-token.json could not be saved; administrator initialization stopped');
  }
  logger.log('首次初始化：已生成管理员强令牌（仅本次显示）：');
  logger.log(token);
  logger.log('请立即保存此令牌，并在控制台系统设置中填写管理员令牌。请勿分享或提交令牌文件。');
  return token;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { openDatabase } = await import('./database.mjs');
  const database = openDatabase({ root: ROOT });
  try { resolveAdminToken({ store: database.store('admin') }); }
  finally { database.close(); }
}
