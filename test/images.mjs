import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { normalizeChatMessages, normalizeResponseInput, visibleMessages } from '../src/messages.mjs';
import { prepareAgent } from '../src/agent.mjs';
import { normalizeImagePart, imageBytes, prepareImages, publicImageAddress, downloadImage } from '../src/images.mjs';
import { KukuAccount } from '../src/upstream.mjs';
import { Pool, MODEL_INDEX } from '../src/gateway.mjs';
import { createApp } from '../src/server.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW4kAAAAASUVORK5CYII=','base64');
const url = `data:image/png;base64,${png.toString('base64')}`;
const image = { type: 'image_url', image_url: { url } };
const message = { role: 'user', content: [{ type: 'text', text: 'Inspect ' }, image] };

test('Chat, Responses and tool results keep image bytes without putting base64 into model prose', () => {
  const chat = normalizeChatMessages([message]); assert.equal(chat[0].content[1].image_url.url, url);
  const responses = normalizeResponseInput([{ role: 'user', content: [{ type: 'input_image', image_url: url }] }]);
  assert.equal(responses[0].content[0].image_url.url,url); assert(!JSON.stringify(visibleMessages(chat)).includes('base64'));
  const agent = prepareAgent({ messages: [message], tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }] }, 'chat');
  assert(!agent.prompt.includes(png.toString('base64'))); assert(agent.prompt.includes('Image attachment: image_'));
});
test('invalid images, unsupported schemes, private literals and file references fail locally', () => {
  for (const value of ['file:///etc/passwd','ftp://example.com/a.png','http://127.1/a','http://[::1]/a','http://169.254.169.254/a','http://user:password@example.com/a','data:image/png;base64,Zm9v','data:image/svg+xml;base64,PHN2Zz4=']) {
    assert.throws(() => normalizeImagePart({ type: 'image_url', image_url: { url: value } }));
  }
  assert.throws(() => normalizeImagePart({ type: 'input_image', file_id: 'file_other_provider' }));
  assert.throws(() => imageBytes(png,'image/jpeg'));
  assert.throws(() => normalizeChatMessages([{ role: 'system', content: [image] }, { role: 'user', content: 'hi' }]));
  assert.throws(() => normalizeChatMessages([{ role:'user',content:Array(11).fill(image) }]));
});
test('upload caches are bounded by client credentials and every conversation gets its own association', async () => {
  let uploads=0;const associations=[];
  const client={ bduss:'one',stoken:'token',async uploadImage(input){assert(input.bytes.equals(png));return{fsId:String(++uploads),name:'image.png'};},async attachImages(ids,session){associations.push({ids,session});} };
  const messages=normalizeChatMessages([message]);
  assert.equal((await prepareImages(messages,client,'session-1'))[0].fsId,'1');
  assert.equal((await prepareImages(messages,client,'session-2'))[0].fsId,'1');assert.equal(uploads,1);
  client.stoken='rotated';assert.equal((await prepareImages(messages,client,'session-3'))[0].fsId,'2');
  const other={...client};assert.equal((await prepareImages(messages,other,'session-4'))[0].fsId,'3');
  assert.deepEqual(associations.map(a=>a.session),['session-1','session-2','session-3','session-4']);
  await assert.rejects(prepareImages(messages,client,'never',undefined,()=>false),e=>e.code==='session_account_mismatch');
  assert.equal(associations.length,4);
});
test('remote image DNS, rebinding, redirects and header isolation are checked', async () => {
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::'])assert.equal(publicImageAddress(address),false,address);
  assert(publicImageAddress('8.8.8.8'));assert(publicImageAddress('2606:4700::1111'));
  let requests=0,lookups=0;
  const transport={get(address,options,callback){requests++;assert(!options.headers.cookie);assert(!options.headers.authorization);options.lookup('example.test',{},(error,ip)=>{assert.equal(ip,'8.8.8.8');});const req=new EventEmitter();queueMicrotask(()=>{const res=Readable.from([png]);res.statusCode=200;res.headers={};callback(res);});return req;}};
  const deps={lookup:async()=>{lookups++;return[{address:'8.8.8.8',family:4}];},transports:{'https:':transport}};
  assert((await downloadImage('https://example.test/a.png',undefined,deps)).bytes.equals(png));assert.equal(lookups,1);assert.equal(requests,1);
  await assert.rejects(downloadImage('https://example.test/a.png',undefined,{...deps,lookup:async()=>[{address:'127.0.0.1',family:4}]}),e=>e.code==='unsafe_image_url');assert.equal(requests,1);
  const redirect={get(address,options,callback){requests++;const req=new EventEmitter();queueMicrotask(()=>{const res=Readable.from([]);res.statusCode=302;res.headers={location:'http://127.0.0.1/private'};callback(res);});return req;}};
  await assert.rejects(downloadImage('https://example.test/a.png',undefined,{...deps,transports:{'https:':redirect}}),e=>e.code==='unsafe_image_url');assert.equal(requests,2);
});
test('native image fields use string fsid and association uses cfsPathType=1', async () => {
  const client=new KukuAccount({bduss:'fake',stoken:'fake'}),seen=[];
  client.json=async(route,options)=>{seen.push({route,...options});return{info:[{fsid:123,errno:0}]};};
  const attachments=[{fsId:'123',name:'image.png'}];await client.sendmsg({text:'look',attachments});
  assert.deepEqual(seen[0].body.data.fsid,['123']);assert.deepEqual(seen[0].body.data.rich_input_params[1].data,{fsId:'123',name:'image.png'});
  client.stream=async function*(route,payload){seen.push({route,payload});};for await(const frame of client.sse({text:'look',attachments})){}
  assert.deepEqual(seen[1].payload.fsid,['123']);await client.attachImages(['123'],'session');
  assert.deepEqual(seen[2].body,{fsids:[123],session_id:'session',cfsPathType:1});
});

test('remote DNS failures and cancellation are bounded image errors', async () => {
  const deps={lookup:async()=>{throw Object.assign(new Error('unresolved'),{code:'ENOTFOUND'});}};
  await assert.rejects(downloadImage('https://example.invalid/a.png',undefined,deps),e=>e.code==='image_download_failed'&&e.status===502&&e.retryUnsafe);
  const controller=new AbortController();const pending=downloadImage('https://example.invalid/a.png',controller.signal,{lookup:()=>new Promise(()=>{})});
  controller.abort();await assert.rejects(pending,e=>e.code==='image_download_failed');
});

test('ordinary image-only Chat and Responses send the same attachments to both upstream requests', async t => {
  const model='synthetic-image';MODEL_INDEX.set(model,{model_name:model,display_name:model});t.after(()=>MODEL_INDEX.delete(model));
  const pool=new Pool([{id:'image-test',bduss:'fake',stoken:'fake'}],{logger:{warn(){}}}),seen=[];
  const client=pool.accounts[0].client;client.allocateIds=async()=>({chat_id:'image-session',query_id:'image-reply'});
  client.uploadImage=async input=>{assert(input.bytes.equals(png));return{fsId:'123',name:'fixture.png'};};client.attachImages=async(ids,session)=>assert.equal(session,'image-session');
  client.sendmsg=async args=>seen.push(args);client.sse=async function*(args){seen.push(args);yield{data:{type:'TEXT_BLOCK_DELTA',data:{delta:'image seen'}}};yield{data:{type:'TURN_DONE'}};};
  const app=createApp({pool});
  for(const route of ['/v1/chat/completions','/v1/responses']){
    const body=route.endsWith('responses')?{model,input:[{role:'user',content:[{type:'input_image',image_url:url}]}]}:{model,messages:[{role:'user',content:[image]}]};
    const req={method:'POST',url:route,headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
    const res={status:0,writeHead(s){this.status=s;},end(s){this.body=s;}};await app(req,res);assert.equal(res.status,200,res.body);
  }
  assert.equal(seen.length,4);assert(seen.every(args=>args.attachments[0].fsId==='123'&&args.text.includes('Image attachment')&&!args.text.includes('base64')));
});

test('model routes reject oversized JSON bodies with 413 before account selection', async () => {
  const app=createApp({pool:{accounts:[],sessions:new Map(),pick(){throw Error('Must not select account');}}});
  for(const route of ['/v1/chat/completions','/v1/responses']){
    const req={method:'POST',url:route,headers:{},async *[Symbol.asyncIterator](){yield Buffer.alloc(32*1024*1024+1);}};
    const res={writeHead(s){this.status=s;},end(s){this.body=s;}};await app(req,res);assert.equal(res.status,413,res.body);assert.equal(JSON.parse(res.body).error.code,'request_too_large');
  }
});
