import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function consoleFiles(root) {
  const files = {};
  function walk(relative) {
    const target = path.join(root, relative), stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Linked console output is not supported: ${relative}`);
    if (relative.split('/').some(part => part.startsWith('.')) || /\.(?:sqlite|db|pem|key)(?:$|[-.])/.test(relative)) throw new Error(`Private console output: ${relative}`);
    if (stat.isDirectory()) for (const name of readdirSync(target).sort()) walk(`${relative}/${name}`);
    else if (stat.isFile()) files[relative] = createHash('sha256').update(readFileSync(target)).digest('hex');
    else throw new Error(`Unsupported console output: ${relative}`);
  }
  // Reject links at every parent, including an externally linked ui directory.
  for (const relative of ['ui', 'ui/dist']) if (lstatSync(path.join(root, relative)).isSymbolicLink()) throw new Error(`Linked console directory: ${relative}`);
  walk('ui/dist');
  if (!files['ui/dist/index.html']) throw new Error('Prebuilt console index.html is missing');
  return files;
}

export function validatePrebuilt(root, t = (_zh, en) => en) {
  if (!existsSync(path.join(root, 'release.json'))) throw new Error(t(
    '缺少预编译发布包。请运行最新一键安装脚本下载成品；开发者可显式使用 --build-from-source。服务器不会自动构建。',
    'Prebuilt release is missing. Run the latest installer to download it. Developers may explicitly use --build-from-source; no automatic build will run.'));
  try {
    if (lstatSync(path.join(root, 'release.json')).isSymbolicLink()) throw new Error('Linked release manifest');
    const manifest = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (manifest.format !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit) || manifest.version !== version ||
        !manifest.console || typeof manifest.console !== 'object' || Array.isArray(manifest.console)) throw new Error('Invalid release manifest');
    const actual = consoleFiles(root), expected = manifest.console;
    if (Object.keys(actual).length !== Object.keys(expected).length ||
        !Object.entries(actual).every(([name, hash]) => expected[name] === hash)) throw new Error('Console checksum mismatch');
    return manifest;
  } catch (error) {
    throw new Error(t(`预编译包校验失败，未执行构建：${error.message}`, `Prebuilt release verification failed; no build was run: ${error.message}`));
  }
}
