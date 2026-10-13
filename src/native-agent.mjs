import { randomUUID, createHash } from 'node:crypto';
import { frameToDelta } from './gateway.mjs';
import { UpstreamError } from './upstream.mjs';
import { validateAgentTurn } from './agent.mjs';
import { callerInstructions } from './messages.mjs';
import { prepareImages } from './images.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function failure(message, code = 'upstream_requires_client') {
  return new UpstreamError(message, { status: code === 'upstream_timeout' ? 504 : code === 'session_account_mismatch' ? 409 : 502, code, retryUnsafe: true });
}

// Each OpenAI round gets an isolated native session. At a client tool handoff we close
// that native turn instead of holding a desktop callback open while a caller runs a
// potentially long command. The next round carries the actual results and full history.
// No caller tools, files or commands are executed by this process.
export async function nativeAgentTurn({ client, model, agent, think_mode, observation, signal, ownsAccount = () => true }) {
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(client.streamTimeoutMs ?? 180_000);
  const combined = AbortSignal.any([abort.signal, deadline, ...(signal ? [signal] : [])]);
  const baseId = randomUUID(), sandboxId = randomUUID(), deviceId = `kuku2api-agent-${randomUUID()}`;
  const handoff = deferred(), broken = deferred(), sandboxReady = deferred(), baseReady = deferred();
  const calls = [], seen = new Set();
  let batchTimer, sent = false, closed = false, complete = false, content = '', reasoning = '';
  // All promises participate in races below; suppress a late rejection during cleanup.
  for (const d of [handoff, broken, sandboxReady, baseReady]) d.promise.catch(() => {});
  const available = agent.choice === 'none' ? [] : agent.tools.filter(tool => typeof agent.choice !== 'object' || tool.name === agent.choice.name);
  const tools = available.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: tool.type === 'function' ? tool.parameters : { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } }));
  // Stable only for identical definitions: preserve upstream prompt/tool caches without
  // allowing another request's different schema to be loaded under the same connector.
  const connector = `external_agent_${createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0,24)}`;
  const ids = await client.allocateIds('genfp', 3, { signal: combined });
  const reply_id = (await client.allocateIds('genfp', 3, { signal: combined })).query_id;
  Object.assign(observation, { session_id: ids.chat_id, reply_id });
  const attachments = await prepareImages(agent.messages, client, ids.chat_id, combined, ownsAccount);
  const args = { session_id: ids.chat_id, reply_id, client_session_id: baseId, device_id: deviceId,
    text: agent.prompt + (attachments.length ? `\nATTACHED_IMAGES: ${JSON.stringify(attachments.map(({reference,name}) => ({ reference, name })))}` : ''),
    attachments, model_name: model.model_name, model_display_name: model.display_name, think_mode,
    custom_instructions: [callerInstructions(agent.messages, agent.instructions),
      'Act only for the caller. Use the supplied external_agent connector tools; do not execute desktop tools or use other connectors. Follow the complete caller conversation.',
      attachments.length ? 'The attached image files are real input. You may inspect these attachments with the upstream image reader, then use client tools for all caller workspace actions.' : 'Do not use built-in tools.'].filter(Boolean).join('\n\n'),
    memory_sign: false, skill_dig_sign: false,
    connector_list: tools.length ? [{ name: connector, description: 'external_agent: tools executed by the caller on its own computer. Load this connector to discover the client tool definitions.', type: 'custom' }] : [],
    signal: combined };
  const listen = async (kind, payload, ready) => {
    try {
      for await (const frame of client.controlStream(kind, payload, combined)) {
        const envelope = frame.data;
        if (!envelope) continue;
        if (envelope.type === 'connected' || envelope.sub_type === 'connected') { ready.resolve(); continue; }
        if (envelope.type === 'error' || envelope.errno || (envelope.code != null && Number(envelope.code) !== 0)) throw failure('Native agent control channel refused the connection');
        if (kind !== 'sandbox' || envelope.type !== 'sandbox' || envelope.sub_type !== 'task') continue;
        let request = envelope.data;
        if (typeof request === 'string') { try { request = JSON.parse(request); } catch { throw failure('Invalid native task payload', 'invalid_tool_response'); } }
        const params = request?.params;
        // An account can have multiple real desktop clients. Never handle their tasks.
        if (params?.session_id !== ids.chat_id || params.device_id !== deviceId) continue;
        if (!ownsAccount()) throw failure('Account identity changed while processing the tool turn', 'session_account_mismatch');
        if (typeof envelope.task_id !== 'string' || !envelope.task_id) throw failure('Missing native task ID', 'invalid_tool_response');
        if (seen.has(envelope.task_id)) continue;
        seen.add(envelope.task_id);
        const callback = result => client.nativeToolResult({ task_id: envelope.task_id, device_id: deviceId,
          client_session_id: sandboxId, request_id: params.request_id, ...result, signal: combined });
        if (request.method !== 'local_connector' || params.server_name !== connector) {
          // Deny native filesystem/shell/other connector requests; never execute them.
          await callback({ errno: 2001 });
          throw failure('Model requested a built-in desktop tool; no client tools were emitted');
        }
        if (params.sub_method === 'tools/list') await callback({ result: { tools } });
        else if (params.sub_method === 'initialize') await callback({ result: {
          protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: connector, version: '1' },
        } });
        else if (params.sub_method === 'tools/call') {
          const tool = available.find(tool => tool.name === params.tool_name);
          if (!tool) throw failure('Native model selected an undefined client tool', 'invalid_tool_response');
          let arguments_ = params.arguments;
          if (typeof arguments_ === 'string') { try { arguments_ = JSON.parse(arguments_); } catch { throw failure('Invalid native tool arguments', 'invalid_tool_response'); } }
          calls.push(tool.type === 'custom' ? { name: tool.name, input: arguments_?.input } : { name: tool.name, arguments: arguments_ });
          // Validate before handing any call to the caller, including named/none/parallel.
          validateAgentTurn({ content, tool_calls: calls }, agent);
          // The model may request independent tools together; collect the same batch.
          if (!batchTimer) batchTimer = setTimeout(() => handoff.resolve(), 80);
        } else throw failure('Unsupported native connector method', 'invalid_tool_response');
      }
      if (!combined.aborted) throw failure('Native control channel ended prematurely', 'upstream_incomplete');
    } catch (error) {
      if (!combined.aborted) { ready.reject(error); broken.reject(error); }
    }
  };
  const sandbox = listen('sandbox', { client_session_id: sandboxId, device_type: 401, device_id: deviceId,
    device_name: 'kuku2api external agent', os_name: 'linux', client_version: '1.6.5.130' }, sandboxReady);
  const base = listen('base', { client_session_id: baseId, device_type: 401 }, baseReady);
  let iterator, next;
  const close = async () => {
    if (!sent || closed || complete) return;
    await client.closeTurn({ ...args, signal: AbortSignal.timeout(10_000) });
    closed = true;
  };
  try {
    await Promise.race([Promise.all([sandboxReady.promise, baseReady.promise]), broken.promise,
      new Promise((_, reject) => { const timer = setTimeout(() => reject(failure('Native control connection timed out', 'upstream_timeout')), 15_000); timer.unref?.(); combined.addEventListener('abort', () => { clearTimeout(timer); reject(failure('Agent turn cancelled', 'upstream_timeout')); }, { once: true }); })]);
    if (!ownsAccount()) throw failure('Account identity changed before sending the turn', 'session_account_mismatch');
    sent = true; // A lost send acknowledgement must also close, never silently retry.
    await client.sendmsg(args);
    iterator = client.sse(args)[Symbol.asyncIterator]();
    next = iterator.next();
    while (true) {
      const event = await Promise.race([next.then(value => ({ value })), handoff.promise.then(() => ({ handoff: true })), broken.promise]);
      if (event.handoff) {
        await close();
        if (!ownsAccount()) throw failure('Account identity changed during the turn', 'session_account_mismatch');
        return { ...validateAgentTurn({ content, tool_calls: calls }, agent), reasoning,
          ...observation, tool_adapter: 'native-mcp', handoff: true };
      }
      if (event.value.done) throw failure('Native conversation ended without TURN_DONE', 'upstream_incomplete');
      const frame = event.value.value, type = frame.data?.type;
      if (frame.event === 'done' || ((type === 'TURN_DONE' || type === 'FINISH') && (frame.data.data?.reply_id == null || String(frame.data.data.reply_id) === String(reply_id)))) {
        complete = true;
        if (!ownsAccount()) throw failure('Account identity changed during the turn', 'session_account_mismatch');
        return { ...validateAgentTurn({ content, tool_calls: calls }, agent), reasoning, ...observation, tool_adapter: 'native-mcp', ...(calls.length ? { handoff: true } : {}) };
      }
      const delta = frameToDelta(frame);
      if (delta?.usage) {
        observation.usage_events.push(delta.usage);
        observation.usage_scope = 'all_model_calls';
        observation.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens', 'cache_read_tokens']
          .map(key => [key, observation.usage_events.reduce((sum, event) => sum + (event[key] ?? 0), 0)]));
      }
      if (delta?.consume_points != null) observation.consume_points = delta.consume_points; // Cumulative per native reply.
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      Object.assign(observation, { content, reasoning });
      if (Buffer.byteLength(content) + Buffer.byteLength(reasoning) > 4 * 1024 * 1024) throw failure('Native response exceeds 4 MiB', 'invalid_tool_response');
      if (delta?.requires_client) throw failure('Native model requested desktop input instead of a client tool');
      if (delta?.error) throw failure('Native conversation returned an error');
      if (delta?.commercial) throw new UpstreamError('Native conversation balance or commercial restriction', {
        status: 402, code: delta.commercial.errno, insufficient_balance: delta.commercial.reason === 'insufficient_balance' || Number(delta.commercial.errno) === 11002, retryUnsafe: true,
      });
      next = iterator.next();
    }
  } catch (error) {
    if (sent) error.retryUnsafe = true;
    throw error;
  } finally {
    clearTimeout(batchTimer);
    try { await close(); } catch { /* Preserve the original error; never generate another turn. */ }
    abort.abort();
    await Promise.allSettled([sandbox, base, next]);
  }
}
