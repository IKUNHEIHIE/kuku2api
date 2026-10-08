import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('publication excludes private runtime data while keeping frontend source data directories', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = mkdtempSync(path.join(tmpdir(),'kuku-publication-test-'));
  try {
    writeFileSync(path.join(fixture,'.gitignore'),readFileSync(path.join(root,'.gitignore')));
    execFileSync('git',['init','--quiet'],{cwd:fixture});
    const privatePaths = ['data/kukuai.sqlite','data/backups/example.sqlite','capture/cookie.txt','analysis/asar/package.json',
      'accounts.json.bak','keys.json','sessions.json','responses.json','admin-token.json','ui/.env','ui/dist/index.html',
      'ui/node_modules/package/index.js','ui/src/features/users/__screenshots__/test.png'];
    const publicPaths = ['ui/src/features/users/data/data.ts','ui/src/features/tasks/data/data.ts',
      'ui/src/components/layout/data/sidebar-data.ts','ui/.env.example','docs/api.md','install.sh'];
    const ignored = execFileSync('git',['check-ignore','--no-index','--stdin'],{
      cwd:fixture,input:[...privatePaths,...publicPaths].join('\n')+'\n',encoding:'utf8',
    }).trim().split(/\r?\n/);
    assert.deepEqual(new Set(ignored),new Set(privatePaths));
  } finally { rmSync(fixture,{recursive:true,force:true}); }
});
