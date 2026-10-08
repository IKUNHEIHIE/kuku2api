import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const parent = path.resolve(import.meta.dirname);
const root = path.resolve(parent, '..');
const scratch = mkdtempSync(path.join(parent, '.claim-stream-mutations-'));
const gateway = readFileSync(path.join(root, 'src/gateway.mjs'), 'utf8');
const upstream = readFileSync(path.join(root, 'src/upstream.mjs'), 'utf8');
const server = readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
try {
  mkdirSync(path.join(scratch, 'src')); mkdirSync(path.join(scratch, 'test'));
  for (const file of readdirSync(path.join(root, 'src'))) if (file.endsWith('.mjs')) copyFileSync(path.join(root, 'src', file), path.join(scratch, 'src', file));
  copyFileSync(path.join(parent, 'claim-stream.mjs'), path.join(scratch, 'test', 'claim-stream.mjs'));
  const variants = [
    ['ignore-native-terminal', 'gateway.mjs', gateway.replace("(type === 'TURN_DONE' || type === 'FINISH')", 'false'), 'TURN_DONE finishes'],
    ['accept-incomplete-eof', 'gateway.mjs', gateway.replace('if (!completed) throw', 'if (false) throw'), 'socket EOF'],
    ['omit-json-body-timeout', 'upstream.mjs', upstream.replace('body: payload, signal: deadline', 'body: payload'), 'JSON deadline'],
    ['repeat-ambiguous-paid-turn', 'server.mjs', server.replace('err?.persistence || err?.retryUnsafe', 'err?.persistence'), 'ambiguous paid turn'],
    ['omit-client-wait-failure', 'gateway.mjs', gateway.replace('if (delta.requires_client)', 'if (false)'), 'REQUIRE_EXTERNAL_EXECUTION immediately'],
    ['reuse-paused-claim-session', 'gateway.mjs', gateway.replace('sessionKey: `claim:${a.id}:${crypto.randomUUID()}`', "sessionKey: 'fake:old'"), 'isolated session'],
    ['restore-ambiguous-default-prompt', 'gateway.mjs', gateway.replace('请只回复 OK，不要调用工具或执行任何任务。', '签到'), 'actual admin claim path'],
  ];
  for (const [name, file, source, pattern] of variants) {
    for (const [f, original] of [['gateway.mjs', gateway], ['upstream.mjs', upstream], ['server.mjs', server]]) writeFileSync(path.join(scratch, 'src', f), original);
    assert.notEqual(source, readFileSync(path.join(scratch, 'src', file), 'utf8'));
    writeFileSync(path.join(scratch, 'src', file), source);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, path.join(scratch, 'test', 'claim-stream.mjs')], { encoding: 'utf8', timeout: 6000 });
    assert.ok(result.status !== 0 && /AssertionError|test timed out|Error \[UpstreamError\]/.test(result.stdout), `${name} mutation escaped: ${result.stdout}`);
    console.log(JSON.stringify({ mutation: name, detected: true }));
  }
  for (const [f, original] of [['gateway.mjs', gateway], ['upstream.mjs', upstream], ['server.mjs', server]]) assert.equal(readFileSync(path.join(root, 'src', f), 'utf8'), original);
} finally {
  assert.equal(path.dirname(scratch), parent); assert.ok(path.basename(scratch).startsWith('.claim-stream-mutations-'));
  rmSync(scratch, { recursive: true, force: true });
}
