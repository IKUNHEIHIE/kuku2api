import { randomUUID, createHash } from 'node:crypto';
import { frameToDelta } from './gateway.mjs';
import { UpstreamError, turnError } from './upstream.mjs';
import { renderAgent, validateAgentTurn } from './agent.mjs';
import { callerInstructions } from './messages.mjs';
import { prepareImages } from './images.mjs';
import { stableToolDefinitions } from './tool-definitions.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function failure(message, code = 'upstream_requires_client') {
  return new UpstreamError(message, { status: code === 'upstream_timeout' ? 504 : code === 'session_account_mismatch' ? 409 : 502, code });
}

// A bounded continuation bridge can keep the original turn alive and supplies
// subsequent caller tool results through callbacks; other requests close at handoff.
// No caller tools, files or commands are executed by this process.
export async function nativeAgentTurn({ client, model, agent, think_mode, observation, signal, onDelta = () => {}, ownsAccount = () => true, beforeSend = () => {}, continuation = null }) {
  let started = performance.now();
  let timing = observation.agent_timing = { think_mode, tool_count: agent.tools.length, tool_list_count: 0, tool_call_count: 0, model_ends_ms: [] };
  const mark = key => { if (timing[key] == null) timing[key] = Math.round(performance.now() - started); };
  const abort = new AbortController();
  const generationTimeoutMs = client.streamTimeoutMs ?? 180_000;
  const streamTimeoutMs = continuation?.maxMs ?? generationTimeoutMs;
  const deadline = AbortSignal.timeout(streamTimeoutMs);
  const ownerSignal = continuation?.signal ?? signal;
  const combined = AbortSignal.any([abort.signal, deadline, ...(ownerSignal ? [ownerSignal] : [])]);
  const baseId = randomUUID(), sandboxId = randomUUID(), deviceId = `kuku2api-agent-${randomUUID()}`;
  let handoff = deferred();
  const broken = deferred(), sandboxReady = deferred(), baseReady = deferred(), cancelled = deferred();
  const onAbort = () => cancelled.reject(combined.reason?.code === 'agent_continuation_unavailable' ? combined.reason : failure('Agent turn cancelled or timed out', 'upstream_timeout'));
  combined.addEventListener('abort', onAbort, { once: true });
  if (combined.aborted) onAbort();
  const calls = [], seen = new Set();
  const callbacks = [];
  let pointBase = 0, latestPoints = 0, resumed = false, handedOff = false;
  let batchTimer, connectTimer, generationTimer, ids, reply_id, args, preparation, sent = false, closed = false, complete = false, content = '', reasoning = '';
  const startGenerationTimer = () => {
    if (continuation) generationTimer = setTimeout(() => abort.abort(failure('Native generation timed out', 'upstream_timeout')), generationTimeoutMs);
    generationTimer?.unref?.();
  };
  // All promises participate in races below; suppress a late rejection during cleanup.
  for (const d of [handoff, broken, sandboxReady, baseReady, cancelled]) d.promise.catch(() => {});
  const available = agent.choice === 'none' ? [] : agent.tools.filter(tool => typeof agent.choice !== 'object' || tool.name === agent.choice.name);
  const tools = stableToolDefinitions(available.map(tool => ({ name: tool.native_name ?? tool.name, description: tool.description,
    inputSchema: tool.type === 'function' ? tool.parameters : { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } })));
  // Hash and tools/list use the same normalized definitions, including the original array order.
  const toolJson = JSON.stringify(tools);
  const fingerprint = createHash('sha256').update(toolJson).digest('hex').slice(0,24);
  timing.tool_fingerprint = fingerprint;
  timing.tool_definition_bytes = Buffer.byteLength(toolJson);
  const connector = `external_agent_${fingerprint}`;
  const listen = async (kind, payload, ready) => {
    try {
      for await (const frame of client.controlStream(kind, payload, combined, { timeoutMs: streamTimeoutMs })) {
        const envelope = frame.data;
        if (!envelope) continue;
        if (envelope.type === 'connected' || envelope.sub_type === 'connected') { ready.resolve(); continue; }
        if (envelope.type === 'error' || envelope.errno || (envelope.code != null && Number(envelope.code) !== 0)) throw new UpstreamError('Native agent control channel refused the connection', { code: Number(envelope.code ?? envelope.errno), status: 502 });
        if (kind !== 'sandbox' || envelope.type !== 'sandbox' || envelope.sub_type !== 'task') continue;
        let request = envelope.data;
        if (typeof request === 'string') { try { request = JSON.parse(request); } catch { throw failure('Invalid native task payload', 'invalid_tool_response'); } }
        const params = request?.params;
        // An account can have multiple real desktop clients. Never handle their tasks.
        if (!ids || params?.session_id !== ids.chat_id || params.device_id !== deviceId) continue;
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
        if (params.sub_method === 'tools/list') {
          mark('tool_list_ms'); timing.tool_list_count++;
          await callback({ result: { tools } }); mark('tools_ready_ms');
        }
        else if (params.sub_method === 'initialize') await callback({ result: {
          protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: connector, version: '1' },
        } });
        else if (params.sub_method === 'tools/call') {
          if (handedOff) throw failure('Native tool batch changed after handoff; no late calls were executed', 'invalid_tool_response');
          mark('tool_call_ms');
          const tool = available.find(tool => (tool.native_name ?? tool.name) === params.tool_name);
          if (!tool) throw failure('Native model selected an undefined client tool', 'invalid_tool_response');
          let arguments_ = params.arguments;
          if (typeof arguments_ === 'string') { try { arguments_ = JSON.parse(arguments_); } catch { throw failure('Invalid native tool arguments', 'invalid_tool_response'); } }
          calls.push(tool.type === 'custom' ? { name: tool.name, input: arguments_?.input } : { name: tool.name, arguments: arguments_ });
          callbacks.push(callback);
          // Validate before handing any call to the caller, including named/none/parallel.
          validateAgentTurn({ content, tool_calls: calls }, agent);
          timing.tool_call_count = calls.length;
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
  let cancelConnection;
  const close = async () => {
    if (!sent || closed || complete) return;
    mark('close_started_ms');
    await client.closeTurn({ ...args, signal: AbortSignal.timeout(10_000) });
    closed = true;
    mark('close_done_ms');
  };
  try {
    const ready = Promise.race([Promise.all([sandboxReady.promise, baseReady.promise]).then(() => mark('controls_ready_ms')), broken.promise,
      new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(failure('Native control connection timed out', 'upstream_timeout')), 15_000);
        connectTimer.unref?.();
        cancelConnection = () => reject(failure('Agent turn cancelled', 'upstream_timeout'));
        if (combined.aborted) cancelConnection();
        else combined.addEventListener('abort', cancelConnection, { once: true });
      })]).finally(() => { clearTimeout(connectTimer); combined.removeEventListener('abort', cancelConnection); });
    // Control connections, independent ID allocations and image preparation overlap.
    // Sending still waits for every prerequisite; failures cancel all sibling work.
    preparation = (async () => {
      const allocated = await Promise.all([client.allocateIds('genfp', 3, { signal: combined }), client.allocateIds('genfp', 3, { signal: combined })]);
      ids = allocated[0]; reply_id = allocated[1].query_id;
      mark('ids_ready_ms');
      Object.assign(observation, { session_id: ids.chat_id, reply_id });
      const attachments = await prepareImages(agent.messages, client, ids.chat_id, combined, ownsAccount);
      mark('images_ready_ms');
      args = { session_id: ids.chat_id, reply_id, client_session_id: baseId, device_id: deviceId,
        text: renderAgent(agent, connector) + (attachments.length ? `\nATTACHED_IMAGES: ${JSON.stringify(attachments.map(({reference,name}) => ({ reference, name })))}` : ''),
        attachments, model_name: model.model_name, model_display_name: model.display_name, think_mode,
        custom_instructions: callerInstructions(agent.messages, agent.instructions, { labelRoles: true }),
        memory_sign: false, skill_dig_sign: false,
        connector_list: tools.length ? [{ name: connector, description: 'Client tools for the caller workspace.', type: 'custom' }] : [],
        signal: combined, streamTimeoutMs };
      timing.prompt_bytes = Buffer.byteLength(args.text);
      timing.instruction_bytes = Buffer.byteLength(args.custom_instructions);
    })();
    await Promise.all([preparation, ready]);
    mark('prepared_ms');
    if (!ownsAccount()) throw failure('Account identity changed before sending the turn', 'session_account_mismatch');
    beforeSend();
    sent = true; // A lost send acknowledgement must also close, never silently retry.
    mark('send_started_ms');
    startGenerationTimer();
    await client.sendmsg(args);
    mark('send_ack_ms');
    iterator = client.sse(args)[Symbol.asyncIterator]();
    next = iterator.next();
    while (true) {
      const event = await Promise.race([next.then(value => ({ value })), handoff.promise.then(() => ({ handoff: true })), broken.promise, cancelled.promise]);
      if (event.handoff) {
        if (!ownsAccount()) throw failure('Account identity changed during the turn', 'session_account_mismatch');
        if (continuation) {
          clearTimeout(generationTimer);
          handedOff = true;
          mark('total_ms');
          const turn = { ...validateAgentTurn({ content, tool_calls: calls }, agent), reasoning,
            ...observation, tool_adapter: 'native-mcp', handoff: true };
          const resume = await Promise.race([continuation.exchange(turn, { agent }), broken.promise, cancelled.promise]);
          if (!ownsAccount()) throw failure('Account identity changed during tool continuation', 'session_account_mismatch');
          if (resume.retire) {
            await close();
            return { native_retired: true };
          }
          resume.beforeSend();
          const pending = callbacks.splice(0);
          handedOff = false;
          calls.length = 0; clearTimeout(batchTimer); batchTimer = undefined; handoff = deferred();
          handoff.promise.catch(() => {});
          agent = resume.agent; observation = resume.observation; onDelta = resume.onDelta;
          started = performance.now(); content = ''; reasoning = ''; pointBase = latestPoints; resumed = true;
          timing = observation.agent_timing = { think_mode, tool_count: agent.tools.length, tool_list_count: 0, tool_call_count: 0,
            model_ends_ms: [], resumed: true, tool_fingerprint: fingerprint, tool_definition_bytes: Buffer.byteLength(toolJson), prompt_bytes: 0, instruction_bytes: 0 };
          Object.assign(observation, { session_id: ids.chat_id, reply_id });
          startGenerationTimer();
          for (const [index, callback] of pending.entries()) await callback({ result: resume.results[index] });
          continue;
        }
        await close();
        return { ...validateAgentTurn({ content, tool_calls: calls }, agent), reasoning,
          ...observation, tool_adapter: 'native-mcp', handoff: true };
      }
      if (event.value.done) throw failure('Native conversation ended without TURN_DONE', 'upstream_incomplete');
      const frame = event.value.value, type = frame.data?.type;
      mark('first_event_ms');
      if (!ownsAccount()) throw failure('Account identity changed during the turn', 'session_account_mismatch');
      if (frame.data?.data?.reply_id != null && String(frame.data.data.reply_id) !== String(reply_id)) { next = iterator.next(); continue; }
      if (type === 'MODEL_CALL_START') resumed = false;
      if (frame.event === 'done' || ((type === 'TURN_DONE' || type === 'FINISH') && (frame.data.data?.reply_id == null || String(frame.data.data.reply_id) === String(reply_id)))) {
        complete = true;
        if (!ownsAccount()) throw failure('Account identity changed during the turn', 'session_account_mismatch');
        return { ...validateAgentTurn({ content, tool_calls: calls }, agent), reasoning, ...observation, tool_adapter: 'native-mcp', ...(calls.length ? { handoff: true } : {}) };
      }
      const delta = frameToDelta(frame);
      if (delta?.usage) {
        if (timing.model_ends_ms.length < 16) timing.model_ends_ms.push(Math.round(performance.now() - started));
        observation.usage_events.push(delta.usage);
        observation.usage_scope = 'all_model_calls';
        observation.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens', 'cache_read_tokens']
          .map(key => [key, observation.usage_events.reduce((sum, event) => sum + (event[key] ?? 0), 0)]));
      }
      if (delta?.consume_points != null) {
        latestPoints = Math.max(latestPoints, delta.consume_points);
        observation.consume_points = Math.max(0, latestPoints - pointBase);
      }
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      Object.assign(observation, { content, reasoning });
      if (Buffer.byteLength(content) + Buffer.byteLength(reasoning) > 4 * 1024 * 1024) throw failure('Native response exceeds 4 MiB', 'invalid_tool_response');
      // A registered native MCP call legitimately waits for the caller. The
      // validated batch already schedules handoff; do not treat that wait as an
      // unsupported desktop action merely because it races the batching timer.
      if (delta?.requires_client && !calls.length && !resumed) {
        // Sandbox tasks and conversation events travel over independent streams.
        // A wait frame can arrive before its validated tools/call task.
        let arrivalTimer;
        mark('waiting_before_tool_ms');
        try {
          if (!available.length) throw failure('Native model requested desktop input instead of a client tool');
          await Promise.race([handoff.promise, broken.promise, cancelled.promise,
            new Promise((_, reject) => { arrivalTimer = setTimeout(() => reject(failure('Native desktop wait had no matching client tool task')), 3000); })]);
        } finally { clearTimeout(arrivalTimer); }
      }
      if (delta?.error) throw turnError(delta.error);
      if (delta?.commercial) {
        const drained = delta.commercial.reason === 'insufficient_balance' || Number(delta.commercial.errno) === 11002;
        const refused = drained && !content && !reasoning && !calls.length && !observation.usage_events.length && !(observation.consume_points > 0);
        throw new UpstreamError('Native conversation balance or commercial restriction', {
          status: 402, code: delta.commercial.errno, insufficient_balance: drained, definitiveRefusal: refused,
        });
      }
      // Text is safe to stream independently. Structured executable calls remain
      // buffered until validation and native handoff have both completed.
      if (!combined.aborted && (delta?.content || delta?.reasoning_content)) {
        if (delta.content) mark('first_text_ms');
        if (delta.reasoning_content) mark('first_reasoning_ms');
        onDelta({ ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning_content ? { reasoning_content: delta.reasoning_content } : {}) });
      }
      next = iterator.next();
    }
  } catch (error) {
    if (sent && !error.definitiveRefusal) error.retryUnsafe = true;
    throw error;
  } finally {
    clearTimeout(batchTimer);
    clearTimeout(connectTimer);
    clearTimeout(generationTimer);
    if (cancelConnection) combined.removeEventListener('abort', cancelConnection);
    try { await close(); } catch { /* Preserve the original error; never generate another turn. */ }
    abort.abort();
    await Promise.allSettled([sandbox, base, next, preparation]);
    combined.removeEventListener('abort', onAbort);
    mark('total_ms');
  }
}
