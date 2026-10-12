import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { directEnvironment } from './start.mjs';

const environmentKeys = ['ADMIN_TOKEN', 'API_KEYS', 'DATABASE_FILE', 'LISTEN_HOST', 'CORS_ORIGIN', 'AUTO_CLAIM', 'KUKU_BASE_URL', 'PASSPORT_BASE_URL', 'TZ'];
const configPath = root => path.join(root, '.runtime/service.json');
const safePath = file => {
  try { if (lstatSync(file).isSymbolicLink()) throw new Error(`Linked service path is not supported: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
};
function privateWrite(file, contents) {
  safePath(path.dirname(file)); safePath(file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file); chmodSync(file, 0o600);
}
export function savedServiceEnvironment(root) {
  safePath(path.join(root, '.runtime')); safePath(configPath(root));
  if (!existsSync(configPath(root))) return {};
  const config = JSON.parse(readFileSync(configPath(root), 'utf8'));
  return Object.fromEntries(environmentKeys.filter(key => typeof config.env?.[key] === 'string').map(key => [key, config.env[key]]));
}
export function applySavedEnvironment(root) {
  for (const [key, value] of Object.entries(savedServiceEnvironment(root))) if (process.env[key] === undefined) process.env[key] = value;
}
export const serviceName = root => `kuku2api-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}.service`;
const systemctlPath = () => ['/usr/bin/systemctl', '/bin/systemctl'].find(existsSync);
export function systemdAvailable() {
  return process.platform === 'linux' && process.getuid?.() === 0 && existsSync('/run/systemd/system') && !!systemctlPath();
}
function control(args) {
  const result = spawnSync(systemctlPath(), args, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`systemctl ${args[0]} failed; inspect the kuku2api service journal.`);
  return result.stdout.trim();
}
const unitPath = root => path.join('/etc/systemd/system', serviceName(root));
const marker = root => `# kuku2api root: ${path.resolve(root)}`;
function ownedUnit(root, file = unitPath(root)) {
  safePath(file);
  if (!existsSync(file)) return false;
  if (!readFileSync(file, 'utf8').startsWith(marker(root) + '\n')) throw new Error('Refusing to replace an unrelated systemd unit');
  return true;
}
const unitValue = value => {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths and environment cannot contain control characters');
  return value.replaceAll('%', '%%');
};
const execArgument = value => JSON.stringify(unitValue(value).replaceAll('$', () => '$$'));
export function systemdUnit(root, executable = process.execPath) {
  return `${marker(root)}\n[Unit]\nDescription=kuku2api\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unitValue(root)}\nEnvironmentFile=${unitValue(path.join(root, '.runtime/service.env'))}\nExecStart=${execArgument(executable)} ${execArgument(path.join(root, 'src/server.mjs'))}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=130\nKillSignal=SIGTERM\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export function environmentFile(env) {
  return Object.entries(env).map(([key, value]) => {
    unitValue(value); // Reject newlines/NUL; EnvironmentFile does not expand $ or %.
    return `${key}=${JSON.stringify(value)}`;
  }).join('\n') + '\n';
}
export function managedRuntime(root, pid, { available = systemdAvailable(), run = control } = {}) {
  if (!available || !ownedUnit(root)) return false;
  return Number(run(['show', serviceName(root), '--property=MainPID', '--value'])) === pid;
}
export function stopManagedRuntime(root, pid) {
  if (!managedRuntime(root, pid)) return false;
  // Explicit stop cancels Restart=on-failure before upgrade replaces files/storage.
  control(['stop', '--no-block', serviceName(root)]);
  return true;
}

export async function launchBackground(root, state, { available = systemdAvailable(), run = control, unitDirectory = '/etc/systemd/system' } = {}) {
  const configured = savedServiceEnvironment(root);
  for (const key of environmentKeys) if (process.env[key] !== undefined) configured[key] = process.env[key];
  const env = directEnvironment({ ...process.env, ...configured, DATABASE_FILE: state.file, LISTEN_HOST: state.host,
    PORT: String(state.port), NODE_USE_ENV_PROXY: '0', KUKU_INSTALLER_QUIET: '1' });
  const persisted = Object.fromEntries([...environmentKeys, 'PORT', 'NODE_USE_ENV_PROXY', 'KUKU_INSTALLER_QUIET'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  // Persist only application settings; never copy the entire SSH/session environment.
  privateWrite(configPath(root), JSON.stringify({ env: configured }, null, 2));
  if (available) {
    const name = serviceName(root), file = path.join(unitDirectory, name);
    ownedUnit(root, file);
    privateWrite(path.join(root, '.runtime/service.env'), environmentFile(persisted));
    privateWrite(file, systemdUnit(root));
    const stop = () => {
      try { run(['stop', name]); }
      catch (error) { error.serviceStopFailed = true; throw error; }
    };
    try {
      run(['daemon-reload']); run(['enable', name]); run(['start', name]);
      return { mode: 'systemd', pid: () => Number(run(['show', name, '--property=MainPID', '--value'])),
        ended: () => ['failed', 'inactive'].includes(run(['show', name, '--property=ActiveState', '--value'])), stop };
    } catch (error) { stop(); throw error; }
  }
  const log = path.join(root, '.runtime/server.log'); safePath(log);
  const fd = openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
      cwd: root, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
    });
  } finally { closeSync(fd); }
  let ended = false;
  child.once('exit', () => { ended = true; }); child.once('error', () => { ended = true; });
  child.unref();
  return { mode: 'detached', pid: () => child.pid, ended: () => ended, stop: async () => {
    if (ended) return;
    await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
  } };
}
