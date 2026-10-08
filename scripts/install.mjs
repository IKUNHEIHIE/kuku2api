import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { directEnvironment, start } from './start.mjs';

export const PNPM_VERSION = '10.34.0';
export function supportedNode(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!m && (Number(m[1]) > 24 || (Number(m[1]) === 24 && Number(m[2]) >= 15));
}
export function installOptions(args) {
  const allowed = new Set(['--no-start', '--backend-only', '--skip-dependencies']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown installer option: ${arg}`);
  return { start: !args.includes('--no-start'), ui: !args.includes('--backend-only'),
    dependencies: !args.includes('--skip-dependencies') };
}
export async function availablePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is in use. Stop the existing service or set PORT to another port.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: directEnvironment(), stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('Cannot run installation command. Check Node.js/npm and network access.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installation command failed (exit ${code}). No service was started; fix the error and rerun the installer.`)));
  });
}

export async function install(root, args) {
  const options = installOptions(args);
  if (!supportedNode(process.versions.node)) throw new Error('Node.js >=24.15.0 is required. Run install.sh or install.ps1 to install a private runtime.');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'kuku2api') throw new Error('This is not a kuku2api source directory');
  if (options.start) await availablePort(Number(process.env.PORT ?? 8787));
  // Build first: a dependency/build failure must not initialize or replace a database/token.
  if (options.ui) {
    if (options.dependencies) {
      const nodeDir = path.dirname(process.execPath);
      const npmCli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
      if (!npmCli) throw new Error('npm is missing from this Node.js distribution; rerun with the official runtime or use --backend-only.');
      const pnpm = [npmCli, 'exec', '--yes', `--package=pnpm@${PNPM_VERSION}`, '--', 'pnpm'];
      await run(process.execPath, [...pnpm, 'install', '--frozen-lockfile', '--prod=false'], path.join(root, 'ui'));
      await run(process.execPath, [...pnpm, 'run', 'build'], path.join(root, 'ui'));
    } else {
      // Local/offline use only, using dependencies already installed in ui/node_modules.
      await run(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '-b'], path.join(root, 'ui'));
      await run(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), 'build'], path.join(root, 'ui'));
    }
    await access(path.join(root, 'ui', 'dist', 'index.html'));
  }
  const { openDatabase } = await import('../src/database.mjs');
  const { resolveAdminToken } = await import('../src/admin-token.mjs');
  const database = openDatabase({ root });
  try { resolveAdminToken({ store: database.store('admin') }); }
  finally { database.close(); }
  console.log('安装完成。请保存上方首次生成的管理员令牌；再次安装会复用已有数据库与令牌。');
  console.log(`控制台 / API: http://127.0.0.1:${process.env.PORT ?? 8787}${options.ui ? '' : ' (仅后端；未构建控制台)'}`);
  console.log('自动领取默认关闭。关闭终端会停止前台服务；再次运行 start.sh 或 start.ps1 启动。');
  if (options.start) start(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  install(root, process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
