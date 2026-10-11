import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { availablePort } from './install.mjs';
import { start } from './start.mjs';
import { listenPort } from '../src/listen-port.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export function installationState(root) {
  const file = path.resolve(root, process.env.DATABASE_FILE || 'data/kukuai.sqlite');
  let settings = {}, admin = {};
  if (existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='settings' AND type='table'").get()) {
        const get = key => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : {}; };
        settings = get('installation'); admin = get('admin');
      }
    } finally { db.close(); }
  } else if (existsSync(path.join(root, 'admin-token.json'))) {
    admin = JSON.parse(readFileSync(path.join(root, 'admin-token.json'), 'utf8'));
  }
  return { file, settings, token: process.env.ADMIN_TOKEN?.trim() ? process.env.ADMIN_TOKEN : admin.token,
    port: listenPort(process.env.PORT ?? settings.port ?? 8787) };
}

export async function runtimeAt(root, state, t = (_zh, en) => en) {
  try { await availablePort(state.port); return null; } catch {}
  let response, info;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/pool/admin/runtime`, {
      headers: { 'x-admin-token': state.token ?? '' }, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    info = await response.json();
  } catch {}
  if (!response?.ok || !info?.instance_id || !Number.isInteger(info.pid) || info.pid <= 0 ||
      info.root !== realpathSync(root) || !existsSync(state.file) || info.database_file !== realpathSync(state.file)) {
    throw new Error(t(`端口 ${state.port} 正在使用，无法确认是本安装的服务。请先停止旧版服务或检查管理员令牌；脚本不会停止其他进程。`,
      `Port ${state.port} is occupied and this installation could not be verified. Stop a legacy service first or check ADMIN_TOKEN; no other process was stopped.`));
  }
  return info;
}

export async function stopRuntime(state, info, t = (_zh, en) => en, timeout = 120000) {
  const response = await fetch(`http://127.0.0.1:${state.port}/pool/admin/shutdown`, {
    method: 'POST', headers: { 'x-admin-token': state.token, 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: info.instance_id }), signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (response.status !== 202) throw new Error(t('服务身份已变化，停止升级。', 'Service identity changed; upgrade stopped.'));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!processAlive(info.pid)) {
      try { await availablePort(state.port); return; } catch {}
    }
    await delay(300);
  }
  throw new Error(t('旧服务仍在等待请求完成，未切换源码。请稍后重试。', 'The old service is still draining requests; source was not changed. Retry later.'));
}

export async function launchVerified(root, port, t = (_zh, en) => en, timeout = 120000) {
  await availablePort(port);
  const child = start(root, { port, env: { ...process.env, DATABASE_FILE: installationState(root).file } });
  const closed = new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
  let ended = false;
  closed.then(() => { ended = true; });
  const deadline = Date.now() + timeout;
  while (!ended && Date.now() < deadline) {
    const state = installationState(root); state.port = port;
    try {
      const info = await runtimeAt(root, state);
      if (info?.pid === child.pid) return child;
    } catch {}
    await delay(300);
  }
  if (!ended) { child.kill('SIGTERM'); await closed; }
  throw new Error(t('新服务未通过启动检查。', 'The new service failed its startup check.'));
}
