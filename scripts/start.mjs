import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function directEnvironment(env = process.env) {
  const result = { ...env, NODE_USE_ENV_PROXY: '0' };
  for (const key of Object.keys(result)) {
    if (/^(?:http_proxy|https_proxy|all_proxy)$/i.test(key)) delete result[key];
  }
  return result;
}

export function start(root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), { port, env = process.env } = {}) {
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
    cwd: root, env: directEnvironment(port === undefined ? env : { ...env, PORT: String(port) }), stdio: 'inherit', windowsHide: true,
  });
  child.once('error', () => { console.error('Cannot start kuku2api. Check Node.js and directory permissions.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1); });
  const forwards = ['SIGINT', 'SIGTERM'].map(signal => {
    const forward = () => child.kill(signal);
    process.once(signal, forward);
    return [signal, forward];
  });
  child.once('close', () => { for (const [signal, forward] of forwards) process.removeListener(signal, forward); });
  return child;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
