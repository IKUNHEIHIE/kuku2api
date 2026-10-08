import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutations = [
  ['old Node accepted', 'scripts/install.mjs', 'return !!m && (Number(m[1]) > 24 || (Number(m[1]) === 24 && Number(m[2]) >= 15));', 'return true;'],
  ['proxy cleanup omitted', 'scripts/start.mjs', "if (/^(?:http_proxy|https_proxy|all_proxy)$/i.test(key)) delete result[key];", 'if (false) delete result[key];'],
  ['API paths fall back to HTML', 'src/static-ui.mjs', "/^\\/(?:v1|pool|healthz)(?:\\/|$)/.test(pathname)", 'false'],
  ['symlink boundary omitted', 'src/static-ui.mjs', '!inside(root, await realpath(candidate))', 'false'],
];
let caught = 0;
for (const [name, file, before, after] of mutations) {
  const copy = mkdtempSync(path.join(tmpdir(), 'kuku-install-mutation-'));
  try {
    for (const directory of ['src','scripts','test']) cpSync(path.join(root,directory),path.join(copy,directory),{recursive:true});
    const target = path.join(copy,file), source = readFileSync(target,'utf8');
    if (!source.includes(before)) throw new Error(`Mutation target missing: ${name}`);
    writeFileSync(target,source.replace(before,after));
    const result = spawnSync(process.execPath,['--test',path.join(copy,'test/installation.mjs')],{cwd:copy,encoding:'utf8'});
    if (result.status === 0 || !/fail [1-9]/.test(result.stdout)) throw new Error(`Mutation was not caught by an assertion: ${name}`);
    caught++; console.log(`Caught: ${name}`);
  } finally { rmSync(copy,{recursive:true,force:true}); }
}
console.log(`${caught}/${mutations.length} installation mutations caught; production files unchanged`);
