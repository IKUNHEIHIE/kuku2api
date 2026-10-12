import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { consoleFiles } from '../scripts/prebuilt.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const gitPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const executable = path.resolve(gitPath, '../../../bin/bash.exe');
    return existsSync(executable) ? executable : null;
  } catch { return null; }
}
const runners = [['Bash', bashExecutable()], ['PowerShell', process.platform === 'win32' ? 'powershell.exe' : null]];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kuku-bootstrap-test-'));
  mkdirSync(path.join(root, 'scripts'));
  const token = 'kuku-admin-' + 'A'.repeat(43);
  const database = path.join(root, 'data/kukuai.sqlite');
  const db = openDatabase({ root, file: database });
  db.store('admin').save({ token });
  db.store('accounts').save({ accounts: [{ id: 'fixture-existing-account', bduss: 'fixture-cookie' }] });
  db.store('system').save({ site_name: 'preserved' });
  db.close();
  writeFileSync(path.join(root, 'scripts/install.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync('legacy-installer-executed', 'yes');
console.error('Unknown installer option: --lang'); process.exitCode = 1;`);
  return { root, database, token };
}
function cleanup(root) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.match(path.basename(root), /^kuku-bootstrap-test-/);
  rmSync(root, { recursive: true, force: true });
}
function invoke(name, executable, root, database) {
  const args = name === 'Bash'
    ? [path.join(ROOT, 'install.sh').replaceAll('\\', '/'), '--install', '--dir', root.replaceAll('\\', '/'), '--backend-only', '--no-start', '--port', '19777', '--lang', 'en']
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install.ps1'), '-Install', '-InstallDir', root, '-BackendOnly', '-NoStart', '-Port', '19777', '-Lang', 'en'];
  return spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, ADMIN_TOKEN: '', DATABASE_FILE: database, LISTEN_HOST: '127.0.0.1' } });
}
function updateSource(root) {
  for (const directory of ['src', 'scripts']) cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
}

for (const [name, executable] of runners) {
  test(`${name}: new entry point rejects an old installer before executing it or changing SQLite`, { skip: !executable }, () => {
    const { root, database } = fixture();
    try {
      const original = readFileSync(database);
      const result = invoke(name, executable, root, database);
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /Outdated or incomplete source directory/);
      assert.equal(output.includes('Unknown installer option'), false);
      assert.equal(existsSync(path.join(root, 'legacy-installer-executed')), false);
      assert.deepEqual(readFileSync(database), original);
      if (name === 'Bash') {
        assert.match(output, /--upgrade/);
      }
    } finally { cleanup(root); }
  });

  test(`${name}: updating complete source recovers installation and preserves accounts and the administrator token`, { skip: !executable }, () => {
    const { root, database, token } = fixture();
    try {
      updateSource(root);
      const result = invoke(name, executable, root, database);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split(/\r?\n/).length, 3);
      assert.match(result.stdout, /127\.0\.0\.1:19777/);
      assert.equal(result.stdout.includes(token), true);
      const db = openDatabase({ root, file: database });
      try {
        assert.equal(db.store('admin').load().token, token);
        assert.equal(db.store('accounts').load().accounts[0].id, 'fixture-existing-account');
        assert.equal(db.store('system').load().site_name, 'preserved');
        assert.equal(db.store('installation').load().port, 19777);
      } finally { db.close(); }
    } finally { cleanup(root); }
  });

  test(`${name}: incomplete source is rejected before a missing module error or storage changes`, { skip: !executable }, () => {
    const { root, database } = fixture();
    try {
      updateSource(root);
      rmSync(path.join(root, 'scripts/install-language.mjs'));
      const original = readFileSync(database);
      const result = invoke(name, executable, root, database);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /Outdated or incomplete source directory/);
      assert.equal((result.stdout + result.stderr).includes('ERR_MODULE_NOT_FOUND'), false);
      assert.deepEqual(readFileSync(database), original);
    } finally { cleanup(root); }
  });
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const [name, executable] of runners) {
  test(`${name}: remote entry automatically upgrades legacy source and reuses saved port without input`, { skip: !executable }, async () => {
    const { root, database, token } = fixture();
    try {
      const port = await freePort();
      const db = openDatabase({ root, file: database }); db.store('installation').save({ port }); db.close();
      const pack = path.join(root, 'fixture-pack');
      const source = path.join(pack, 'kuku2api-main'); mkdirSync(source, { recursive: true }); updateSource(source);
      const archive = path.join(root, name === 'Bash' ? 'fixture.tar.gz' : 'fixture.zip');
      const mocks = path.join(root, 'fixture-bin'); mkdirSync(mocks);
      const environment = { ...process.env, PATH: mocks + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH,
        ADMIN_TOKEN: '', DATABASE_FILE: database, LISTEN_HOST: '127.0.0.1', KUKU_TEST_ARCHIVE: archive.replaceAll('\\', '/'), KUKU_TEST_ROOT: root,
        KUKU_TEST_ENTRY: path.join(ROOT, name === 'Bash' ? 'install.sh' : 'install.ps1'), KUKU_TEST_MOCKS: mocks };
      let result;
      if (name === 'Bash') {
        execFileSync('tar', ['-czf', archive, '-C', pack, 'kuku2api-main'], { windowsHide: true });
        writeFileSync(path.join(mocks, 'curl'), '#!/usr/bin/env bash\nwhile (($#)); do if [[ "$1" == -o ]]; then output="$2"; shift 2; else shift; fi; done\ncp -- "$KUKU_TEST_ARCHIVE" "$output"\n', { mode: 0o755 });
        result = spawnSync(executable, ['-c', 'export PATH="$(cd -- "$KUKU_TEST_MOCKS" && pwd):$PATH"; bash "$KUKU_TEST_ENTRY" --dir "$KUKU_TEST_ROOT" --backend-only --no-start --lang en'],
          { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: environment });
      } else {
        const command = `Compress-Archive -LiteralPath '${source.replaceAll("'", "''")}' -DestinationPath $env:KUKU_TEST_ARCHIVE
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec); Copy-Item -LiteralPath $env:KUKU_TEST_ARCHIVE -Destination $OutFile }
& $env:KUKU_TEST_ENTRY -InstallDir $env:KUKU_TEST_ROOT -BackendOnly -NoStart -Lang en`;
        result = spawnSync(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
          { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: environment });
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split(/\r?\n/).length, 3);
      assert.equal(result.stdout.includes(token), true);
      assert.equal(existsSync(path.join(root, 'legacy-installer-executed')), false);
      assert(existsSync(path.join(root, 'scripts/manage.mjs')));
      const upgraded = openDatabase({ root, file: database });
      try {
        assert.equal(upgraded.store('installation').load().port, port);
        assert.equal(upgraded.store('admin').load().token, token);
        assert.equal(upgraded.store('accounts').load().accounts[0].id, 'fixture-existing-account');
      } finally { upgraded.close(); }
    } finally { cleanup(root); }
  });
}

test('PowerShell upgrade shortcut forwards named port, language and switches', { skip: process.platform !== 'win32' }, () => {
  const { root } = fixture();
  try {
    const bootstrap = path.join(root, 'bootstrap.ps1'), output = path.join(root, 'arguments.json');
    writeFileSync(bootstrap, `param($InstallDir, [switch]$Upgrade, $Port, $Lang, [switch]$NoStart, [switch]$BackendOnly)
@{directory=$InstallDir;upgrade=$Upgrade.IsPresent;port=$Port;lang=$Lang;noStart=$NoStart.IsPresent;backendOnly=$BackendOnly.IsPresent} | ConvertTo-Json | Set-Content -LiteralPath $env:KUKU_TEST_OUTPUT
exit 0`);
    const command = `function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec); Copy-Item -LiteralPath $env:KUKU_TEST_BOOTSTRAP -Destination $OutFile }
& $env:KUKU_TEST_ENTRY -Port 19777 -Lang zh -NoStart -BackendOnly`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, KUKU_TEST_ENTRY: path.join(ROOT, 'upgrade.ps1'), KUKU_TEST_BOOTSTRAP: bootstrap, KUKU_TEST_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, '')), { directory: path.resolve(ROOT), upgrade: true, port: 19777, lang: 'zh', noStart: true, backendOnly: true });
  } finally { cleanup(root); }
});

for (const [name, executable] of runners) {
  test(`${name}: full remote installation and upgrade consume checksummed prebuilt assets without frontend build tools`, { skip: !executable }, () => {
    const base = mkdtempSync(path.join(tmpdir(), 'kuku-bootstrap-test-'));
    try {
      const root = path.join(base, 'installed'), source = path.join(base, 'source'), mocks = path.join(base, 'bin');
      mkdirSync(source); mkdirSync(mocks); updateSource(source);
      mkdirSync(path.join(source, 'ui/dist/assets'), { recursive: true });
      writeFileSync(path.join(source, 'ui/dist/index.html'), '<!doctype html><script src="/assets/app.js"></script>');
      writeFileSync(path.join(source, 'ui/dist/assets/app.js'), 'console.log("prebuilt")');
      writeFileSync(path.join(source, 'release.json'), JSON.stringify({ format: 1, commit: 'c'.repeat(40), version: JSON.parse(readFileSync(path.join(source, 'package.json'))).version, console: consoleFiles(source) }));
      const archive = path.join(base, name === 'Bash' ? 'kuku2api.tar.gz' : 'kuku2api.zip'), checksums = path.join(base, 'SHA256SUMS');
      if (name === 'Bash') execFileSync('tar', ['-czf', archive, '-C', source, '.'], { windowsHide: true });
      else execFileSync(executable, ['-NoProfile', '-Command', `Compress-Archive -Path '${source.replaceAll("'", "''")}/*' -DestinationPath '${archive.replaceAll("'", "''")}'`], { windowsHide: true });
      const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
      writeFileSync(checksums, `${hash}  ${path.basename(archive)}\n`);
      const environment = { ...process.env, PATH: mocks + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH,
        ADMIN_TOKEN: '', DATABASE_FILE: path.join(root, 'data/kukuai.sqlite'), PORT: undefined, LISTEN_HOST: '127.0.0.1', NPM_CONFIG_OFFLINE: 'true',
        KUKU_TEST_ARCHIVE: archive.replaceAll('\\', '/'), KUKU_TEST_CHECKSUMS: checksums.replaceAll('\\', '/'), KUKU_TEST_ROOT: root,
        KUKU_TEST_ENTRY: path.join(ROOT, name === 'Bash' ? 'install.sh' : 'install.ps1'), KUKU_TEST_MOCKS: mocks };
      if (name === 'Bash') writeFileSync(path.join(mocks, 'curl'), `#!/usr/bin/env bash
while (($#)); do case "$1" in -o) output="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done
case "$url" in */SHA256SUMS) cp -- "$KUKU_TEST_CHECKSUMS" "$output";; */kuku2api.tar.gz) cp -- "$KUKU_TEST_ARCHIVE" "$output";; *) echo 'Unexpected source or dependency download' >&2; exit 77;; esac
`, { mode: 0o755 });
      const invoke = first => {
        const command = name === 'Bash'
          ? `export PATH="$(cd -- "$KUKU_TEST_MOCKS" && pwd):$PATH"; bash "$KUKU_TEST_ENTRY" --dir "$KUKU_TEST_ROOT" --no-start --lang en ${first ? '--port 19778' : ''}`
          : `function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
if ($Uri.EndsWith('/SHA256SUMS')) { Copy-Item -LiteralPath $env:KUKU_TEST_CHECKSUMS -Destination $OutFile }
elseif ($Uri.EndsWith('/kuku2api.zip')) { Copy-Item -LiteralPath $env:KUKU_TEST_ARCHIVE -Destination $OutFile }
else { throw 'Unexpected source or dependency download' } }
& $env:KUKU_TEST_ENTRY -InstallDir $env:KUKU_TEST_ROOT -NoStart -Lang en ${first ? '-Port 19778' : ''}`;
        return spawnSync(executable, name === 'Bash' ? ['-c', command] : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
          cwd: base, encoding: 'utf8', windowsHide: true, timeout: 30000, env: environment,
        });
      };
      const first = invoke(true); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /^Installation complete \(service not started\).\r?\nConsole address: http:\/\/127\.0\.0\.1:19778\r?\nAdministrator key: kuku-admin-[A-Za-z0-9_-]{43}\r?\n$/);
      const db = openDatabase({ root }); const token = db.store('admin').load().token;
      db.store('accounts').save({ accounts: [{ id: 'keep-account', bduss: 'fake-cookie' }] }); db.close();
      const repeated = invoke(false); assert.equal(repeated.status, 0, repeated.stderr); assert.equal(repeated.stdout, first.stdout);
      assert(repeated.stdout.includes(token)); assert.equal(existsSync(path.join(root, 'ui/node_modules')), false);
      const before = readFileSync(environment.DATABASE_FILE);
      writeFileSync(checksums, `${'0'.repeat(64)}  ${path.basename(archive)}\n`);
      const rejected = invoke(false); assert.notEqual(rejected.status, 0); assert.match(rejected.stdout + rejected.stderr, /checksum mismatch/);
      assert.deepEqual(readFileSync(environment.DATABASE_FILE), before);
      assert.equal(existsSync(path.join(root, 'ui/node_modules')), false);
    } finally { cleanup(base); }
  });
}
