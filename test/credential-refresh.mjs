import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/gateway.mjs';
import { UpstreamError, KukuAccount } from '../src/upstream.mjs';
import { createAccountManager } from '../src/accounts.mjs';
import { createCredentialRefresh } from '../src/credential-refresh.mjs';
import { openDatabase } from '../src/database.mjs';
import { toRecords } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

function fixture(t, { ptoken = true, exchangeError = false, probeError = null, changedIdentity = false } = {}) {
  const db = openDatabase({ file: ':memory:' }); t.after(() => db.close());
  t.mock.method(KukuAccount.prototype, 'probe', async function () {
    if (probeError && this.stoken === 'old-secret') throw probeError;
    return {};
  });
  t.mock.method(KukuAccount.prototype, 'userIdentity', async function () {
    if (probeError && this.stoken === 'old-secret') throw probeError;
    return changedIdentity && this.stoken !== 'old-secret' ? 'different' : 'person-a';
  });
  const pool = new Pool([{ id: 'a', alias: 'keep-me', priority: 7, upstream_user_id: 'person-a', bduss: 'bduss-secret', stoken: 'old-secret', ...(ptoken ? { ptoken: 'ptoken-secret' } : {}) }]);
  const store = db.store('accounts'); store.save({ accounts: toRecords(pool.accounts) });
  const calls = [];
  const manager = createAccountManager({ pool, store, now: () => 100000, exchange: async values => {
    calls.push(values); if (exchangeError) throw new Error('PRIVATE EXCHANGE RESPONSE'); return 'new-secret';
  } });
  return { pool, manager, db, store, calls };
}

test('refresh persists a verified STOKEN and renewal data, preserves account settings and survives pool reconstruction', async t => {
  const { pool, manager, store, calls } = fixture(t);
  pool.markAuthDead(pool.accounts[0]); pool.accounts[0].balance_dead_until = 123456;
  const result = await manager.refresh('a');
  assert.equal(result.ok, true); assert.equal(result.refreshed, true); assert.equal(calls.length, 1);
  assert.equal(pool.accounts[0].auth_dead, false); assert.equal(pool.accounts[0].cooldown_until, 0);
  const restored = new Pool(store.load().accounts).accounts[0];
  assert.equal(restored.client.stoken, 'new-secret'); assert.equal(restored.ptoken, 'ptoken-secret');
  assert.equal(restored.alias, 'keep-me'); assert.equal(restored.priority, 7); assert.equal(restored.credential.refreshed_at, 100000);
  assert.equal(pool.accounts[0].balance_dead_until, 123456);
  assert(!JSON.stringify(result).includes('secret'));
});

test('old accounts without PTOKEN are checked without inventing a renewal or an expiry', async t => {
  const { pool, manager, calls } = fixture(t, { ptoken: false });
  const result = await manager.refresh('a');
  assert.equal(result.ok, true); assert.equal(result.refreshed, false); assert.equal(result.can_refresh, false);
  assert.equal(result.refreshed_at, null); assert.equal(calls.length, 0);
  assert.equal(pool.accounts[0].client.stoken, 'old-secret');
});

test('a refused renewal keeps a working old token; transient check failures do not condemn a login', async t => {
  const { pool, manager } = fixture(t, { exchangeError: true });
  const result = await manager.refresh('a');
  assert.equal(result.ok, false); assert.equal(result.status, 'refresh_failed'); assert.equal(pool.accounts[0].auth_dead, false);
  assert.equal(pool.accounts[0].client.stoken, 'old-secret'); assert(!JSON.stringify(result).includes('PRIVATE'));
  t.mock.method(KukuAccount.prototype, 'userIdentity', async () => { throw new UpstreamError('network', { network: true, status: 502 }); });
  assert.equal((await manager.refresh('a')).status, 'error'); assert.equal(pool.accounts[0].auth_dead, false);
});

test('confirmed expired credentials remain unavailable after restart without paid model calls', async t => {
  const { pool, manager, calls, store } = fixture(t, { ptoken: false, probeError: new UpstreamError('expired', { code: 200001 }) });
  const result = await manager.refresh('a');
  assert.equal(result.status, 'invalid'); assert.equal(pool.accounts[0].auth_dead, true); assert.equal(calls.length, 0);
  assert.equal(new Pool(store.load().accounts).pick(), null);
});

test('persistence failure or a different upstream identity cannot activate a candidate token', async t => {
  const { pool, manager, store } = fixture(t);
  t.mock.method(store, 'save', () => { throw new Error('disk refused'); });
  await assert.rejects(manager.refresh('a'), /disk refused/);
  assert.equal(pool.accounts[0].client.stoken, 'old-secret'); assert.equal(pool.credentialRefreshes.size, 0);
  t.mock.restoreAll();
  const other = fixture(t, { changedIdentity: true });
  const result = await other.manager.refresh('a');
  assert.equal(result.ok, false); assert.equal(result.code, 'account_identity_mismatch');
  assert.equal(other.pool.accounts[0].client.stoken, 'old-secret'); assert.equal(other.pool.accounts[0].upstream_user_id, 'person-a');
});

test('refresh skips active chat and claims; new calls wait for renewal and then use the verified new client', async t => {
  const { pool, manager, calls } = fixture(t);
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  pool.recordedChat = async args => { await gate; return { content: args.account.client.stoken }; };
  const chat = pool.chat({ account: pool.accounts[0], model: { id: 'synthetic' }, messages: [{ role: 'user', content: 'synthetic' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.refresh('a')).status, 'busy'); assert.equal(calls.length, 0);
  finish(); await chat;
  let release; const renewed = new Promise(resolve => { release = resolve; });
  const next = createAccountManager({ pool, store: null, exchange: async () => { await renewed; return 'new-secret'; } });
  const first = next.refresh('a'); assert.equal(next.refresh('a'), first);
  pool.recordedChat = async args => ({ content: args.account.client.stoken });
  const waiting = pool.chat({ account: pool.accounts[0], model: { id: 'synthetic' }, messages: [{ role: 'user', content: 'synthetic' }] });
  release(); await first;
  assert.equal((await waiting).content, 'new-secret'); assert.equal(pool.activeAccounts.size, 0);
  let claimDone; const claimGate = new Promise(resolve => { claimDone = resolve; });
  pool.accounts[0].client.freePointHome = async () => { await claimGate; return {}; };
  const claiming = pool.claimFreePoints({ only: 'a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.refresh('a')).status, 'busy'); claimDone(); await claiming;
});

test('successful re-login updates the same account, retains preferences, and preserves duplicate protection for manual adds', async t => {
  const { pool, manager, store } = fixture(t);
  const result = await manager.add({ id: 'new', bduss: 'new-cookie', stoken: 'new-secret', ptoken: 'fresh-ptoken', refreshExisting: true });
  assert.equal(result.refreshed_existing, true); assert.equal(result.account.id, 'a'); assert.equal(pool.accounts.length, 1);
  assert.equal(result.account.alias, 'keep-me'); assert.equal(result.account.priority, 7);
  assert.equal(store.load().accounts[0].ptoken, 'fresh-ptoken');
  assert.equal((await manager.add({ id: 'manual', bduss: 'another-cookie', stoken: 'new-secret' })).error.code, 'account_already_exists');
});

test('re-login fills the verified owner identity on legacy rows without an upstream user ID', async t => {
  const {pool,manager,store}=fixture(t);
  pool.accounts[0].upstream_user_id=null;
  const result=await manager.add({id:'new',bduss:'bduss-secret',stoken:'new-secret',ptoken:'fresh-ptoken',refreshExisting:true});
  assert.equal(result.refreshed_existing,true);assert.equal(result.account.id,'a');
  assert.equal(result.account.upstream_user_id,'person-a');assert.equal(store.load().accounts[0].upstream_user_id,'person-a');
});

test('automatic and simultaneous manual refresh jobs use one 15-second paced queue and configuration persists', async () => {
  let time = 100000, saved = {}, attempts = [];
  const pool = { accounts: [{ id: 'a' }, { id: 'b' }] };
  const manager = { refresh: async id => { attempts.push({ id, at: time }); time += 100; return { id, ok: true, status: 'valid' }; } };
  const options = { pool, manager, now: () => time, wait: async ms => { assert.equal(ms, 15000); time += ms; }, store: { load: () => saved, save: value => { saved = value; } }, logger: { log() {} } };
  const scheduler = createCredentialRefresh(options);
  const a = scheduler.run({ only: 'a' }), b = scheduler.run({ only: 'b' });
  assert.equal(scheduler.run({ only: 'a' }), a);
  assert.deepEqual((await a).accounts.map(r => r.id), ['a']); assert.deepEqual((await b).accounts.map(r => r.id), ['b']);
  assert.deepEqual(attempts, [{ id: 'a', at: 100000 }, { id: 'b', at: 115100 }]);
  scheduler.configure({ enabled: false, interval_hours: 12 });
  assert.equal(await scheduler.tick(), null); assert.equal(scheduler.state.next_run_at, null);
  const restored = createCredentialRefresh(options); assert.equal(restored.state.enabled, false); assert.equal(restored.state.interval_hours, 12);
  assert.throws(() => scheduler.configure({ interval_hours: 0 }), /interval_hours/);
  assert.throws(() => scheduler.configure({ enabled: 'false' }), /enabled/);
});

test('refresh endpoints require an administrator and never expose any credential material', async t => {
  const { pool, db, store } = fixture(t);
  const app = createApp({ pool, database: db, store, adminToken: 'synthetic-admin', apiKeys: ['synthetic-api'] });
  const call = async (url, method = 'GET', body = {}, admin = true) => {
    const req = { url, method, headers: admin ? { 'x-admin-token': 'synthetic-admin' } : { authorization: 'Bearer synthetic-api' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end(value) { this.value = JSON.parse(value); } };
    await app(req, res); return res;
  };
  assert.equal((await call('/pool/admin/token-refresh', 'GET', {}, false)).statusCode, 401);
  assert.equal((await call('/pool/admin/token-refresh', 'POST', { interval_hours: 0 })).statusCode, 400);
  assert.equal((await call('/pool/admin/token-refresh/run', 'POST', { id: 'missing' })).statusCode, 404);
  const state = (await call('/pool/state')).value;
  assert.equal(state.accounts[0].credential.can_refresh, true); assert.equal(state.accounts[0].credential.expires_at, null);
  const text = JSON.stringify(state); for (const secret of ['bduss-secret','old-secret','ptoken-secret']) assert(!text.includes(secret));
});

test('scheduled refresh obeys due dates, skips disabled accounts, retries transient failures and retains config when saving fails', async () => {
  let time = 100000;
  const accounts = [
    { id: 'ready', credential: { status: 'valid', attempted_at: time } },
    { id: 'failed', credential: { status: 'refresh_failed', attempted_at: time } },
    { id: 'disabled', disabled: true },
  ];
  const seen = [];
  const manager = { async refresh(id) { seen.push(id); accounts.find(a => a.id === id).credential = { status: 'valid', attempted_at: time }; return { id, ok: true }; } };
  const scheduler = createCredentialRefresh({ pool: { accounts }, manager, now: () => time, wait: async ms => { time += ms; }, logger: {} });
  assert.equal(scheduler.nextFor(accounts[0]), time + 6 * 3600000);
  assert.equal(scheduler.nextFor(accounts[2]), null);
  assert.equal(await scheduler.tick(), null);
  time += 300000;
  await scheduler.tick(); assert.deepEqual(seen, ['failed']);
  time += 6 * 3600000;
  await scheduler.tick(); assert.deepEqual(seen, ['failed', 'ready', 'failed']);
  await scheduler.stop(); assert.equal(await scheduler.tick(), null);
  const failing = createCredentialRefresh({ pool: { accounts }, manager, store: { load: () => ({}), save() { throw new Error('disk'); } } });
  assert.throws(() => failing.configure({ enabled: false, interval_hours: 12 }), /disk/);
  assert.equal(failing.state.enabled, true); assert.equal(failing.state.interval_hours, 6);
});

test('a newly minted token must pass the real login probe before replacing the old token', async t => {
  const { pool, manager } = fixture(t);
  t.mock.method(KukuAccount.prototype, 'probe', async function () {
    if (this.stoken === 'new-secret') throw new UpstreamError('rejected token', { code: 200001 });
    return {};
  });
  assert.equal((await manager.refresh('a')).status, 'refresh_failed');
  assert.equal(pool.accounts[0].client.stoken, 'old-secret'); assert.equal(pool.accounts[0].auth_dead, false);
});

test('manual refresh-all queued during a due-only job also includes accounts which are not yet due', async () => {
  let time=100000, release;
  const gate=new Promise(resolve=>{release=resolve;});
  const accounts=[{id:'due'}, {id:'not-due',credential:{status:'valid',attempted_at:time}}];
  const attempts=[];
  const scheduler=createCredentialRefresh({pool:{accounts},now:()=>time,wait:async ms=>{time+=ms;},logger:{},manager:{async refresh(id){
    attempts.push(id); if(attempts.length===1)await gate; return {id,ok:true};
  }}});
  const automatic=scheduler.tick();
  await new Promise(resolve=>setImmediate(resolve));
  const manual=scheduler.run();release();
  assert.deepEqual((await automatic).accounts.map(a=>a.id),['due']);
  assert.deepEqual((await manual).accounts.map(a=>a.id),['due','not-due']);
  assert.deepEqual(attempts,['due','due','not-due']);
});
