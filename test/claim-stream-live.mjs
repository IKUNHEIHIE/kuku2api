// Explicit real acceptance for one named account. At most one earn-and-claim request.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'KUKU_BASE_URL']) delete process.env[name];
const i = process.argv.indexOf('--account');
const account = i >= 0 ? process.argv[i + 1] : null;
assert.ok(account && process.env.ADMIN_TOKEN, 'Explicit --account and ADMIN_TOKEN required');
const headers = { 'x-admin-token': process.env.ADMIN_TOKEN, 'content-type': 'application/json' };
const root = path.resolve(import.meta.dirname, '..');
async function request(route, body) {
  const response = await fetch(`http://127.0.0.1:8787${route}`, { method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(230_000) });
  assert.equal(response.status, 200);
  return response.json();
}
const query = `?account=${encodeURIComponent(account)}`;
const balance = async () => (await request('/pool/points' + query)).accounts.find(a => a.id === account)?.balance_points;
const tasks = async () => (await request('/pool/admin/claim' + query)).accounts.find(a => a.id === account)?.tasks;
const beforeTasks = await tasks();
assert.ok(beforeTasks, 'Account not found');
const before = await balance();
assert.ok(Number.isFinite(before), 'Cannot read baseline balance');
const started = Date.now();
const result = await request('/pool/admin/claim', { id: account, chat: true, model: 'gateway-glm-5.3-flash' });
const claimed = result.accounts.find(a => a.id === account);
const afterTasks = await tasks();
const after = await balance();
const report = { checked_at: new Date().toISOString(), account, duration_ms: Date.now() - started,
  ok: claimed?.ok, code: claimed?.code ?? null, points_earned: claimed?.points_earned,
  reported: claimed?.reported, claimed: claimed?.claimed, chat_turn: claimed?.chat_turn,
  notes: claimed?.notes, message: claimed?.message,
  chat_task_before: beforeTasks.find(t => t.task_type === 'CHAT'), chat_task_after: afterTasks.find(t => t.task_type === 'CHAT'),
  balance_before: before, balance_after: after, balance_delta: Number.isFinite(after) ? Number((after - before).toFixed(6)) : null };
writeFileSync(path.join(root, 'capture', 'claim-stream-live-2026-10-07.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.equal(claimed?.ok, true);
assert.ok(claimed?.claimed.some(c => c.task_type === 'CHAT' && c.claim_status === 'SUCCESS' && c.claimed_point > 0)
  || (report.chat_task_before?.task_status === 'FINISHED' && report.chat_task_before.claimable_point === 0), 'CHAT reward not confirmed');
assert.equal(report.chat_task_after?.task_status, 'FINISHED');
