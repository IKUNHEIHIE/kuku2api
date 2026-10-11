import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { listenPort, savedListenPort } from '../src/listen-port.mjs';
import { installerLanguage } from './install-language.mjs';
import { directEnvironment, start } from './start.mjs';

export const PNPM_VERSION = '10.34.0';
export function supportedNode(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!m && (Number(m[1]) > 24 || (Number(m[1]) === 24 && Number(m[2]) >= 15));
}
export function installOptions(args) {
  const allowed = new Set(['--no-start', '--backend-only', '--skip-dependencies']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '--lang') {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} requires a value / 需要指定值`);
      values[key] = args[++i];
    } else if (!allowed.has(args[i])) throw new Error(`Unknown installer option / 未知安装参数: ${args[i]}`);
  }
  if (values.port !== undefined) values.port = listenPort(values.port);
  if (values.lang !== undefined) installerLanguage(values.lang);
  return { ...values, start: !args.includes('--no-start'), ui: !args.includes('--backend-only'),
    dependencies: !args.includes('--skip-dependencies') };
}
export async function availablePort(port, language = 'en') {
  port = listenPort(port);
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(language === 'zh'
      ? `端口 ${port} 无法使用（${error.code}），请指定其他端口或先停止旧服务。`
      : `Port ${port} is in use or unavailable (${error.code}). Choose another port or stop the existing service.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function choosePort({ port, envPort = process.env.PORT, savedPort, interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
  language = 'en', check = availablePort, start: shouldStart = true, ask, warn = console.error } = {}) {
  const t = (zh, en) => language === 'zh' ? zh : en;
  const fallback = port ?? envPort ?? savedPort ?? 8787;
  if (port !== undefined || !interactive) {
    const selected = listenPort(fallback);
    if (shouldStart) await check(selected, language);
    return selected;
  }
  let rl;
  const controller = new AbortController();
  if (!ask) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once('close', () => controller.abort());
    rl.on('SIGINT', () => rl.close());
    ask = prompt => new Promise((resolve, reject) => {
      const cancelled = () => reject(new Error('Installation cancelled'));
      if (controller.signal.aborted) return cancelled();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      rl.question(prompt, { signal: controller.signal }, answer => {
        controller.signal.removeEventListener('abort', cancelled);
        // Pause synchronously, before a Windows terminal starts another blocking read.
        rl.pause();
        resolve(answer);
      });
    });
  }
  try {
    while (true) {
      const answer = await ask(t(`请输入服务端口 [${fallback}]（回车沿用）：`, `Service port [${fallback}] (Enter to keep): `));
      let selected;
      try {
        selected = listenPort(answer.trim() || fallback);
        if (shouldStart) await check(selected, language);
      } catch (error) {
        warn(error.message.startsWith('PORT') ? t('端口必须是 1 到 65535 之间的整数。', error.message) : error.message);
        continue;
      }
      return selected;
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t('已取消安装，未保存端口。', 'Installation cancelled; the port was not saved.'));
    throw error;
  } finally { rl?.close(); }
}

function run(executable, args, cwd, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: directEnvironment(), stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error(t('无法执行安装命令，请检查 Node.js/npm 和网络连接。', 'Cannot run installation command. Check Node.js/npm and network access.'))));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(t(`安装命令失败（退出码 ${code}），请修复后重新安装。`, `Installation command failed (exit ${code}). Fix the error and rerun the installer.`))));
  });
}

export async function install(root, args) {
  const options = installOptions(args);
  const language = installerLanguage(options.lang);
  const t = (zh, en) => language === 'zh' ? zh : en;
  if (!supportedNode(process.versions.node)) throw new Error(t('需要 Node.js >=24.15.0，请运行 install.sh 或 install.ps1 安装私有运行时。', 'Node.js >=24.15.0 is required. Run install.sh or install.ps1 to install a private runtime.'));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'kuku2api') throw new Error(t('当前目录不是 kuku2api 源码目录。', 'This is not a kuku2api source directory'));
  const version = manifest.version ?? t('(本地源码)', '(local source)');
  console.log(t(`正在安装 kuku2api ${version}${options.ui ? '，包含最新控制台' : '（仅后端）'}。`, `Installing kuku2api ${version}${options.ui ? ' with the console' : ' (backend only)'}.`));
  const port = await choosePort({ ...options, savedPort: savedListenPort(root), language });
  console.log(t(`服务端口：${port}；安装成功后将保存，重启自动沿用。`, `Service port: ${port}; saved after a successful install and reused on restart.`));
  // Build first: a dependency/build failure must not initialize or replace a database/token.
  if (options.ui) {
    if (options.dependencies) {
      const nodeDir = path.dirname(process.execPath);
      const npmCli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
      if (!npmCli) throw new Error(t('此 Node.js 缺少 npm，请使用官方运行时或指定 --backend-only。', 'npm is missing from this Node.js distribution; rerun with the official runtime or use --backend-only.'));
      const pnpm = [npmCli, 'exec', '--yes', `--package=pnpm@${PNPM_VERSION}`, '--', 'pnpm'];
      await run(process.execPath, [...pnpm, 'install', '--frozen-lockfile', '--prod=false'], path.join(root, 'ui'), t);
      await run(process.execPath, [...pnpm, 'run', 'build'], path.join(root, 'ui'), t);
    } else {
      // Local/offline use only, using dependencies already installed in ui/node_modules.
      await run(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '-b'], path.join(root, 'ui'), t);
      await run(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), 'build'], path.join(root, 'ui'), t);
    }
    await access(path.join(root, 'ui', 'dist', 'index.html'));
  }
  const { openDatabase } = await import('../src/database.mjs');
  const { resolveAdminToken } = await import('../src/admin-token.mjs');
  // Recheck after a potentially long build, before initializing or changing storage.
  if (options.start) await availablePort(port, language);
  const database = openDatabase({ root });
  try {
    resolveAdminToken({ store: database.store('admin'), language });
    const settings = database.store('installation');
    settings.save({ ...settings.load(), port });
  }
  finally { database.close(); }
  const url = `http://127.0.0.1:${port}`;
  console.log(t(`kuku2api ${version} 安装完成。请保存上方首次生成的管理员令牌；再次安装会复用已有数据库与令牌。`, `kuku2api ${version} installed. Save the administrator token shown on first install; reinstalling preserves the database and token.`));
  console.log(t(`控制台 / API: ${url}${options.ui ? '' : '（仅后端；未构建控制台）'}`, `Console / API: ${url}${options.ui ? '' : ' (backend only; console not built)'}`));
  if (options.ui) console.log(t(`登录页的“服务端地址配置”应填写 ${url}（不要加 /v1），管理员令牌与普通 API 密钥分别填写。`, `Set the login page server address to ${url} (without /v1). Administrator tokens and model API keys are separate.`));
  console.log(t('自动领取默认关闭。关闭终端会停止前台服务；再次运行 start.sh 或 start.ps1 启动。', 'Automatic claiming is off by default. Closing the terminal stops the service; run start.sh or start.ps1 to restart.'));
  if (options.start) start(root, { port });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  install(root, process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
