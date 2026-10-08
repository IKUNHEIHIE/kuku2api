// Operator-only: read the installed official Windows client's native identity. Never
// takes account cookies or changes the native device parameters. No reward calls here.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { validDesktopContext } from '../src/desktop-login.mjs';

const root = path.resolve(import.meta.dirname, '..');
const option = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
if (process.platform !== 'win32') throw new Error('Desktop context import requires the installed official Windows client');
const clientDir = option('--client-dir');
if (!clientDir || !existsSync(path.join(clientDir, 'GenFlowPro.exe')) || !existsSync(path.join(clientDir, 'genflowengine.dll'))) throw new Error('Provide --client-dir pointing to the installed official client');
const require = createRequire(import.meta.url);
const koffi = require(path.resolve(option('--koffi-dir') || path.join(root, 'analysis', 'asar', 'node_modules', 'koffi')));
const lib = koffi.load(path.join(clientDir, 'genflowengine.dll'));
const logType = koffi.proto('void DesktopContextLog(int level,const char* message)');
const eventType = koffi.proto('void DesktopContextEvent(int event,const char* data,int length)');
const exitType = koffi.proto('void DesktopContextExit(bool success)');
const logCallback = koffi.register(() => {}, koffi.pointer(logType));
const eventCallback = koffi.register(() => {}, koffi.pointer(eventType));
const init = lib.func('genflow_engine_global_init', 'int', [koffi.pointer(logType), koffi.pointer(eventType), 'str']);
const get = lib.func('genflow_engine_get_param_by_id', 'void*', ['int', 'int*']);
const free = lib.func('genflow_engine_free', 'int', ['void*']);
const setConfig = lib.func('genflow_engine_set_config', 'int', ['int', 'str']);
const uninit = lib.func('genflow_engine_global_uninit', 'int', [koffi.pointer(exitType)]);
function read(id) {
  const count = Buffer.alloc(4);
  const pointer = get(id, count);
  try {
    const length = count.readInt32LE();
    if (!pointer || length < 1 || length > 65536) throw new Error('Native device parameter unavailable');
    return String(koffi.decode(pointer, 'char', length)).replace(/\0+$/, '');
  } finally { if (pointer) free(pointer); }
}
let initialized = false;
let success = false;
let stage = 'native_init';
try {
  if (init(logCallback, eventCallback, `"${path.join(clientDir, 'GenFlowPro.exe')}"`) !== 0) throw new Error('Official native client initialization failed');
  initialized = true;
  stage = 'native_version';
  // Engine get_version is the kernel version, not the desktop product build.
  const product = JSON.parse(readFileSync(path.join(clientDir, 'resources', 'package.json'), 'utf8'));
  const productVersion = product.win_version;
  if (!/^[0-9.]{1,32}$/.test(productVersion ?? '')) throw new Error('Invalid official client version');
  // Same desktop product config as the official shell. No setParamById(device) calls.
  stage = 'native_config';
  if (setConfig(0, JSON.stringify({ client_type: 401, app_version: productVersion })) !== 0) throw new Error('Native desktop config unavailable');
  stage = 'native_parameters';
  const common = new URLSearchParams(read(3));
  const context = { source: 'installed_native_client', imported_at: new Date().toISOString(),
    devuid: common.get('devuid'), device_id: read(7), clienttype: common.get('clienttype'),
    version: common.get('version'), channel: common.get('channel'), win64: common.get('win64') || '1' };
  stage = 'validate_context';
  if (!validDesktopContext(context)) {
    console.error(JSON.stringify({ stage, present: Object.keys(context).filter((key) => !!context[key]), clienttype: context.clienttype, version: context.version,
      devuid_format: /^BDIMXV2-[A-Za-z0-9_.-]{10,512}$/.test(context.devuid ?? ''), device_format: /^[1-9][0-9]{0,31}$/.test(context.device_id ?? '') }));
    throw new Error('Native device context is incomplete');
  }
  stage = 'save_context';
  const database = openDatabase({ root });
  try {
    const store = database.store('desktop_context');
    const previous = store.load();
    if (previous.devuid && (previous.devuid !== context.devuid || previous.device_id !== context.device_id)) throw new Error('Native device identity changed; refusing automatic replacement');
    store.save(context);
    console.log(JSON.stringify({ imported: true, same_identity_as_previous: !!previous.devuid, clienttype: context.clienttype, version: context.version, device_identity_exposed: false }));
    success = true;
  } finally { database.close(); }
} catch { console.error(JSON.stringify({ imported: false, stage, message: 'Official desktop context import failed; existing configuration was preserved' })); }
finally {
  if (initialized) {
    let exitCallback;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      exitCallback = koffi.register(() => { clearTimeout(timer); resolve(); }, koffi.pointer(exitType));
      if (uninit(exitCallback) !== 0) { clearTimeout(timer); resolve(); }
    });
    // Stop the isolated process after native shutdown. Do not run the FFI inside the API server.
  }
  process.exit(success ? 0 : 1);
}
