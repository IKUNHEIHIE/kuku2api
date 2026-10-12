import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync,
  renameSync, rmSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildConsole, installOptions, availablePort, choosePort } from './install.mjs';
import { installerLanguage } from './install-language.mjs';
import { listenPort } from '../src/listen-port.mjs';
import { installationState, runtimeAt, stopRuntime, launchVerified, samePath } from './service.mjs';
import { validatePrebuilt } from './prebuilt.mjs';
import { quietInstall, progress, installSummary } from './install-output.mjs';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = new Set(['src', 'scripts', 'test', 'docs', 'ui', '.github']);
const rootFiles = new Set(['.gitattributes', '.gitignore', '.npmrc', 'README.md', 'package.json', 'release.json', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1', 'upgrade.sh', 'upgrade.ps1']);
const forbidden = /^(?:data|capture|analysis)(?:\/|$)|^ui\/\.github(?:\/|$)|(?:^|\/)(?:node_modules|dist|coverage|__screenshots__|\.vitest-attachments|\.tanstack|\.vscode|\.idea|\.git|\.runtime|\.agents|\.codex|\.aws)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.sqlite[^/]*$|\.db(?:-[^/]*)?$|\.(?:bak|tmp|key|pem)$|(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed (exit ${result.status}); local code was not discarded.`);
  return result.stdout.trim();
};

export function publicFiles(root) {
  const files = new Map();
  function walk(relative) {
    const target = path.join(root, relative), stat = lstatSync(target);
    const name = relative.replaceAll(path.sep, '/');
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${name}`);
    if (forbidden.test(name) || /^docs\/(?:issue|frontend-update-prompt|new-user-credits-investigation|sqlite-plan)\.md$/.test(name)) {
      // Private or generated files in a distribution must never be installed.
      return;
    }
    if (stat.isDirectory()) for (const item of readdirSync(target)) walk(path.join(relative, item));
    else if (stat.isFile()) files.set(name, { hash: digest(readFileSync(target)), mode: stat.mode & 0o777 });
    else throw new Error(`Unsupported source entry: ${name}`);
  }
  for (const name of readdirSync(root)) if (roots.has(name) || rootFiles.has(name)) walk(name);
  return files;
}

function safeTarget(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') ||
      !(roots.has(relative.split('/')[0]) || rootFiles.has(relative)) || forbidden.test(relative)) throw new Error('Unsafe source path');
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to replace a linked path: ${relative}`);
  }
  return target;
}

function copyPublic(source, root, files) {
  for (const [relative, record] of files) {
    const target = safeTarget(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(source, relative), target);
    chmodSync(target, record.mode);
  }
}

async function databaseBackup(file, destination) {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try { await backup(db, destination); chmodSync(destination, 0o600); }
  finally { db.close(); }
  return true;
}

export async function manage(root, source, action, args, { build = buildConsole, launch = launchVerified, portSelection = {} } = {}) {
  root = realpathSync(root); source = realpathSync(source);
  const options = installOptions(args), language = installerLanguage(options.lang);
  const t = (zh, en) => language === 'zh' ? zh : en;
  const state = installationState(root);
  const summary = async port => {
    const current = installationState(root);
    if (quietInstall()) await installSummary({ port, token: current.token, host: current.host, language });
  };
  let port = listenPort(options.port ?? state.port);
  const incomplete = !existsSync(state.file) && !['accounts.json', 'keys.json', 'settings.json', 'admin-token.json'].some(name => existsSync(path.join(root, name)));
  const runtimeDirectory = path.join(root, '.runtime');
  if (existsSync(runtimeDirectory) && lstatSync(runtimeDirectory).isSymbolicLink()) throw new Error('Linked .runtime directory is not supported');
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(runtimeDirectory, 'maintenance.lock');
  let lockFile;
  try { lockFile = openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(t('已有安装或升级任务在运行；若上次被强制中断，请确认无任务运行后删除 .runtime/maintenance.lock。', 'Another maintenance operation is running. If a prior operation was forcibly interrupted, verify it is stopped before removing .runtime/maintenance.lock.')); throw error; }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  let backupDirectory, originalFiles, installedFiles, previousGit, nextGit, release, databaseSaved = false, changed = false, distChanged = false, oldStopped = false, previousRuntime;
  try {
    if (action === 'upgrade' && incomplete) {
      progress(t('检测到尚未完成的安装，重新选择可用端口；不会停止占用默认端口的服务。', 'An incomplete installation was detected. Selecting an available port without stopping the service on the default port.'));
      port = await choosePort({ ...options, savedPort: state.port, language, start: true, autoAvailable: true, ...portSelection });
    } else previousRuntime = await runtimeAt(root, state, t);
    if (action === 'start' && previousRuntime) {
      progress(t(`服务已经运行：http://127.0.0.1:${state.port}`, `Service is already running: http://127.0.0.1:${state.port}`)); await summary(state.port); return;
    }
    if (action !== 'upgrade') {
      if (options.port !== undefined && port !== state.port) throw new Error(t('请在安装或升级时修改端口，启动/重启沿用已保存端口。', 'Change the port during installation or upgrade; start/restart reuse the saved port.'));
      if (previousRuntime) await stopRuntime(state, previousRuntime, t);
      if (options.start) await launch(root, port, t);
      await summary(port);
      return;
    }
    if (samePath(root, source)) throw new Error('Upgrade requires a separate staging source directory');
    const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (manifest.name !== 'kuku2api') throw new Error('Invalid upgrade archive');
    release = options.ui && !options.sourceBuild && existsSync(path.join(source, 'release.json')) ? validatePrebuilt(source, t) : null;
    installedFiles = publicFiles(source);
    for (const name of ['src/server.mjs', 'scripts/install.mjs', 'scripts/manage.mjs', 'scripts/service.mjs', 'package.json']) if (!installedFiles.has(name)) throw new Error(`Incomplete upgrade archive: ${name}`);
    if (existsSync(path.join(root, '.git'))) {
      if (git(root, ['status', '--porcelain'])) throw new Error(t('Git 目录有本地修改，已保留。请先提交或另存修改后再升级。', 'The Git checkout has local changes. Commit or save them before upgrading; nothing was overwritten.'));
      if (!samePath(git(root, ['rev-parse', '--show-toplevel']), root)) throw new Error('Installation must be the Git repository root');
      previousGit = git(root, ['rev-parse', 'HEAD']);
      progress(t('正在获取 Git 更新…', 'Fetching Git updates…'));
      git(root, ['fetch', 'origin', release?.commit ?? 'main']); nextGit = git(root, ['rev-parse', 'FETCH_HEAD']);
      if (release && nextGit !== release.commit) throw new Error('Git update and release commit differ');
      git(root, ['merge-base', '--is-ancestor', previousGit, nextGit]);
      const tree = git(root, ['ls-tree', '-rz', nextGit]);
      for (const line of tree.split('\0').filter(Boolean)) {
        const match = /^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
        if (!match || !installedFiles.has(match[3])) throw new Error('Git update and downloaded archive differ; retry the upgrade');
        const bytes = readFileSync(path.join(source, match[3]));
        // GitHub archives honor this repository's *.ps1 text eol=crlf attribute;
        // the corresponding Git blobs use LF. Do not normalize binary/other files.
        const archiveHash = blobHash(bytes);
        const scriptHash = match[3].endsWith('.ps1') ? blobHash(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))) : archiveHash;
        if (archiveHash !== match[2] && scriptHash !== match[2]) throw new Error('Git update and downloaded archive differ; retry the upgrade');
      }
    }
    // Validate every destination before building, stopping, or changing any installed files.
    for (const relative of installedFiles.keys()) safeTarget(root, relative);
    originalFiles = publicFiles(root);
    for (const relative of originalFiles.keys()) safeTarget(root, relative);
    // The console build regenerates this derived file from ui/src/routes and may
    // change its ordering. Compare all inputs, but not that generated content.
    const sameSource = installedFiles.size === originalFiles.size && [...installedFiles].every(([name, record]) =>
      originalFiles.has(name) && (name === 'ui/src/routeTree.gen.ts' || originalFiles.get(name).hash === record.hash));
    let consoleReady = existsSync(path.join(root, 'ui/dist/index.html'));
    if (release) {
      try { consoleReady = validatePrebuilt(root, t).commit === release.commit; }
      catch { consoleReady = false; }
    }
    if (!incomplete && (sameSource || (previousGit && previousGit === nextGit)) && port === state.port && (!options.ui || consoleReady)) {
      progress(t('源码已是最新版本，沿用现有构建与端口。', 'Source is already current; reusing the existing build and port.'));
      if (options.start && !previousRuntime) await launch(root, port, t);
      await summary(port);
      return { port, unchanged: true };
    }
    if (port !== state.port || !previousRuntime) await availablePort(port, language);
    if (options.ui && existsSync(path.join(root, 'ui/dist')) && lstatSync(path.join(root, 'ui/dist')).isSymbolicLink()) throw new Error('Linked console build directory is not supported');
    progress(options.sourceBuild ? t('正在临时目录构建新版；现有服务暂不停止…', 'Building the update in staging; the existing service remains running…')
      : t('正在校验新版预编译控制台；现有服务暂不停止…', 'Verifying the prebuilt update; the existing service remains running…'));
    if (!options.dependencies && options.ui && options.sourceBuild) throw new Error(t('源码升级需要重新安装前端依赖，请去掉 --skip-dependencies。', 'Source upgrades require staging dependencies; omit --skip-dependencies.'));
    await build(source, options, t);
    if (previousGit && (git(root, ['status', '--porcelain']) || git(root, ['rev-parse', 'HEAD']) !== previousGit)) throw new Error('Local code changed during the build; upgrade stopped');
    if (previousRuntime) {
      const current = await runtimeAt(root, state, t);
      if (current?.instance_id !== previousRuntime.instance_id) throw new Error('Running service changed during the build');
      progress(t('正在等待现有请求完成并停止本服务…', 'Draining requests and stopping this service…'));
      await stopRuntime(state, current, t); oldStopped = true;
    }
    await availablePort(port, language);
    backupDirectory = path.join(runtimeDirectory, 'backups', `${Date.now()}-${randomUUID()}`);
    if (existsSync(path.dirname(backupDirectory)) && lstatSync(path.dirname(backupDirectory)).isSymbolicLink()) throw new Error('Linked backup directory is not supported');
    mkdirSync(path.join(backupDirectory, 'source'), { recursive: true, mode: 0o700 });
    originalFiles = publicFiles(root);
    copyPublic(root, path.join(backupDirectory, 'source'), originalFiles);
    databaseSaved = await databaseBackup(state.file, path.join(backupDirectory, 'database.sqlite'));
    writeFileSync(path.join(backupDirectory, 'upgrade.json'), JSON.stringify({ version: manifest.version, database_file: state.file, previous_git: previousGit, original_files: [...originalFiles.keys()], new_files: [...installedFiles.keys()] }, null, 2), { mode: 0o600 });
    progress(t(`备份已保存：${backupDirectory}`, `Backup saved: ${backupDirectory}`));
    changed = true;
    if (previousGit) {
      git(root, ['merge', '--ff-only', nextGit]);
      if (release) copyFileSync(path.join(source, 'release.json'), path.join(root, 'release.json'));
    }
    else {
      copyPublic(source, root, installedFiles);
      for (const relative of originalFiles.keys()) if (!installedFiles.has(relative)) unlinkSync(safeTarget(root, relative));
    }
    if (options.ui) {
      const dist = safeTarget(root, 'ui/dist-placeholder');
      const target = path.join(path.dirname(dist), 'dist');
      if (existsSync(target)) {
        if (lstatSync(target).isSymbolicLink()) throw new Error('Linked console build directory is not supported');
        renameSync(target, path.join(backupDirectory, 'console'));
      }
      distChanged = true;
      const { cpSync } = await import('node:fs');
      cpSync(path.join(source, 'ui/dist'), target, { recursive: true });
    }
    // Run the installed version's initialization so legacy JSON imports use the installed root.
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--backend-only', '--no-start', '--port', String(port), '--lang', language], {
      cwd: root, env: { ...process.env, DATABASE_FILE: state.file, KUKU_INSTALLER_SUMMARY: '0' }, stdio: 'inherit', windowsHide: true,
    });
    if (result.status !== 0) throw new Error('Updated database initialization failed');
    if (options.start) await launch(root, port, t);
    progress(t(`升级完成：http://127.0.0.1:${port}`, `Upgrade complete: http://127.0.0.1:${port}`));
    await summary(port);
    return { backupDirectory, port };
  } catch (error) {
    if (changed) {
      try {
        await availablePort(port);
        if (previousGit) {
          if (![previousGit, nextGit].includes(git(root, ['rev-parse', 'HEAD'])) || git(root, ['status', '--porcelain'])) throw new Error('Git worktree changed; restore from the backup manually');
          git(root, ['reset', '--hard', previousGit]);
          if (release) {
            const previousManifest = path.join(backupDirectory, 'source/release.json');
            if (existsSync(previousManifest)) copyFileSync(previousManifest, path.join(root, 'release.json'));
            else if (existsSync(path.join(root, 'release.json'))) unlinkSync(path.join(root, 'release.json'));
          }
        } else {
          copyPublic(path.join(backupDirectory, 'source'), root, originalFiles);
          for (const relative of installedFiles.keys()) if (!originalFiles.has(relative) && existsSync(safeTarget(root, relative))) unlinkSync(safeTarget(root, relative));
        }
        if (distChanged) {
          const target = path.resolve(root, 'ui/dist');
          safeTarget(root, 'ui/dist-placeholder');
          if (path.dirname(target) !== path.join(root, 'ui') || (existsSync(target) && lstatSync(target).isSymbolicLink())) throw new Error('Console path changed during upgrade');
          if (existsSync(target)) rmSync(target, { recursive: true, force: true });
          if (existsSync(path.join(backupDirectory, 'console'))) renameSync(path.join(backupDirectory, 'console'), target);
        }
        if (databaseSaved) {
          for (const suffix of ['-wal', '-shm']) if (existsSync(state.file + suffix)) unlinkSync(state.file + suffix);
          copyFileSync(path.join(backupDirectory, 'database.sqlite'), state.file); chmodSync(state.file, 0o600);
        } else if (existsSync(state.file)) {
          if (lstatSync(state.file).isSymbolicLink()) throw new Error('Database path changed during upgrade');
          for (const suffix of ['', '-wal', '-shm']) if (existsSync(state.file + suffix)) unlinkSync(state.file + suffix);
        }
        console.error(t('升级失败，已恢复旧版源码和数据库。', 'Upgrade failed; the old source and database were restored.'));
      } catch (rollbackError) {
        throw new Error(t(`自动恢复未完成，请保留备份 ${backupDirectory} 并手动恢复。原因：${rollbackError.message}`, `Automatic recovery could not finish; preserve ${backupDirectory} and restore manually. ${rollbackError.message}`));
      }
    }
    if (oldStopped) {
      console.log(t('正在恢复原服务…', 'Restarting the original service…'));
      await launch(root, state.port, t);
    }
    throw error;
  } finally { closeSync(lockFile); unlinkSync(lock); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), rootIndex = args.indexOf('--root');
  if (rootIndex < 0 || !args[rootIndex + 1]) throw new Error('--root is required');
  const root = args[rootIndex + 1]; args.splice(rootIndex, 2);
  const actionIndex = args.findIndex(arg => ['--upgrade', '--start', '--restart'].includes(arg));
  const action = actionIndex < 0 ? 'upgrade' : args.splice(actionIndex, 1)[0].slice(2);
  manage(root, HERE, action, args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
