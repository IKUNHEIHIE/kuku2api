import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/gateway.mjs';
import { createPoolRecovery } from '../src/pool-recovery.mjs';
import { UpstreamError, turnError } from '../src/upstream.mjs';
import { createApp } from '../src/server.mjs';

function fixture() {
  let time = 100000;
  const pool = new Pool(['a','b','c'].map(id => ({id,bduss:`synthetic-${id}`,stoken:'synthetic',upstream_user_id:id})),{logger:{warn(){}}});
  pool.recovery = createPoolRecovery(pool,()=>time);
  return {pool,advance:ms=>{time+=ms;},now:()=>time};
}
const fail = () => new UpstreamError('synthetic failure',{status:502,retryUnsafe:true});

test('isolated transient failures back off from 10 seconds to 120 seconds and success resets the counter',async()=>{
  const {pool,advance,now}=fixture(),a=pool.accounts[0];
  for(const delay of [10000,20000,40000,80000,120000,120000]){
    await pool.recovery.failure(a,fail(),'m');assert.equal(a.cooldown_until-now(),delay);advance(delay);
  }
  pool.recovery.success(a,'m',now());assert.equal(a.consecutive_failures,0);assert.equal(a.cooldown_until,0);
  await pool.recovery.failure(a,fail(),'m');assert.equal(a.cooldown_until-now(),10000);
  advance(300001);await pool.recovery.failure(a,fail(),'m');assert.equal(a.consecutive_failures,1);
});

test('two different accounts failing one model pause that model and preserve other models',async()=>{
  const {pool,advance}=fixture();
  await pool.recovery.failure(pool.accounts[0],fail(),'m');
  assert.doesNotThrow(()=>pool.recovery.check('m'));
  await pool.recovery.failure(pool.accounts[1],fail(),'m');
  assert.throws(()=>pool.recovery.check('m'),e=>e.status===503&&e.code==='pool_cooling_down'&&e.retry_after_ms===10000);
  assert.doesNotThrow(()=>pool.recovery.check('other'));
  advance(10001);assert.doesNotThrow(()=>pool.recovery.check('m'));
});

test('public connection errors across accounts pause all models; one recovering request is admitted',async()=>{
  const {pool,advance,now}=fixture();
  for(const a of pool.accounts.slice(0,2))await pool.recovery.failure(a,new UpstreamError('network',{network:true}),'m');
  assert.throws(()=>pool.recovery.check('other'),e=>e.status===503);
  advance(10001);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const recovering=pool.recovery.run('m',async owns=>{assert.equal(owns,true);pool.recovery.check('m',owns);await gate;});
  await assert.rejects(pool.recovery.run('other',async()=>assert.fail('must be held')),e=>e.status===503);
  release();await recovering;
  pool.recovery.success(pool.accounts[0],'m',now());assert.equal(pool.recovery.state.length,0);
});

test('a repeated failure from only one account does not classify the outage as shared',async()=>{
  const {pool}=fixture();
  await pool.recovery.failure(pool.accounts[0],fail(),'m');await pool.recovery.failure(pool.accounts[0],fail(),'m');
  assert.equal(pool.recovery.state.length,0);
});

test('HTTP 403 triggers one deduplicated read-only login probe and does not condemn a working login',async()=>{
  const {pool}=fixture(),a=pool.accounts[0];let probes=0;
  a.client.probe=async()=>{probes++;};
  await Promise.all([pool.recovery.failure(a,new UpstreamError('403',{status:403}),'m'),pool.recovery.failure(a,new UpstreamError('403',{status:403}),'m')]);
  assert.equal(a.auth_dead,false);assert.equal(probes,1);assert.equal(a.consecutive_failures,2);
});

test('explicit expired credentials or a confirmed 403 probe mark only the corresponding account dead',async()=>{
  const {pool}=fixture();
  pool.accounts[0].client.probe=async()=>{throw new UpstreamError('not login',{code:200001});};
  await pool.recovery.failure(pool.accounts[0],new UpstreamError('403',{status:403}),'m');
  await pool.recovery.failure(pool.accounts[1],new UpstreamError('expired',{code:-6}),'m');
  assert.equal(pool.accounts[0].auth_dead,true);assert.equal(pool.accounts[1].auth_dead,true);
  assert.equal(pool.accounts[2].auth_dead,false);assert.equal(pool.recovery.state.length,0);
});

test('a transient 403 probe failure preserves credentials, and credential rotation during the probe discards stale conclusions',async()=>{
  const {pool}=fixture(),a=pool.accounts[0];
  a.client.probe=async()=>{throw new UpstreamError('network',{network:true});};
  await pool.recovery.failure(a,new UpstreamError('403',{status:403}),'m');assert.equal(a.auth_dead,false);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  pool.accounts[1].client.probe=async()=>{await gate;throw new UpstreamError('expired',{code:200001});};
  const pending=pool.recovery.failure(pool.accounts[1],new UpstreamError('403',{status:403}),'m');
  pool.accounts[1]={...pool.accounts[1],client:{bduss:'rotated',stoken:'rotated'}};release();await pending;
  assert.equal(pool.accounts[1].auth_dead,false);
});

test('caller errors, ambiguous tool waits, persistence failure and balance exhaustion do not trip shared protection',async()=>{
  const {pool}=fixture(),a=pool.accounts[0];
  for(const error of [new UpstreamError('param',{status:400}),new UpstreamError('tools',{code:'invalid_tool_response',status:502,retryUnsafe:true}),Object.assign(new Error('disk'),{persistence:true})])await pool.recovery.failure(a,error,'m');
  assert.equal(a.consecutive_failures,0);assert.equal(a.cooldown_until,0);
  await pool.recovery.failure(a,new UpstreamError('empty',{code:11002}),'m');assert(a.balance_dead_until>Date.now());
  assert.equal(pool.recovery.state.length,0);
});

test('the same error is counted once; late successes cannot erase newer failures',async()=>{
  const {pool,advance,now}=fixture(),a=pool.accounts[0],error=fail(),started=now();
  advance(1);await pool.recovery.failure(a,error,'m');await pool.recovery.failure(a,error,'m');
  pool.recovery.success(a,'m',started);assert.equal(a.consecutive_failures,1);assert(a.cooldown_until>now());
});

test('failures at the same millisecond as an older request start survive its late success',async()=>{
  const {pool,now}=fixture(),a=pool.accounts[0],revision=pool.recovery.revision,started=now();
  await pool.recovery.failure(a,fail(),'m');
  pool.recovery.success(a,'m',started,revision);assert.equal(a.consecutive_failures,1);
});

test('saving unrelated accounts preserves failure counters; changing credentials resets their transient history',async()=>{
  const {pool}=fixture(),a=pool.accounts[0];
  await pool.recovery.failure(a,fail(),'m');
  const records=pool.accounts.map(a=>({id:a.id,upstream_user_id:a.upstream_user_id,bduss:a.client.bduss,stoken:a.client.stoken}));
  pool.set(records);assert.equal(pool.accounts[0].consecutive_failures,1);
  records[0].stoken='rotated';pool.set(records);assert.equal(pool.accounts[0].consecutive_failures,0);
});

test('stream errors retain only a numeric diagnostic code, never upstream content, and forbid replay',()=>{
  const error=turnError({code:200001,message:'PRIVATE',prompt:'PRIVATE'});
  assert.equal(error.code,200001);assert.equal(error.retryUnsafe,true);assert(!JSON.stringify(error).includes('PRIVATE'));
  assert.equal(turnError({code:'PRIVATE'}).code,'upstream_turn_error');
});

for(const route of ['/v1/chat/completions','/v1/responses'])test(`${route} returns structured 503 and Retry-After before any paid request`,async()=>{
  const pool=new Pool([{id:'a',bduss:'synthetic',stoken:'synthetic'}],{logger:{warn(){}}});
  pool.accounts[0].cooldown_until=Date.now()+10000;
  const app=createApp({pool});
  const req={url:route,method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({model:'test',input:'test',messages:[{role:'user',content:'test'}]}));}};
  const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.json=JSON.parse(body);}};
  await app(req,res);assert.equal(res.status,503);assert.equal(res.json.error.code,'pool_cooling_down');
  assert(res.json.error.retry_after_ms>0);assert(Number(res.headers['retry-after'])>0);
});
