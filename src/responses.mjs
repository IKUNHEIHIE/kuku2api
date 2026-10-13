// OpenAI Responses API contract, verified against openai SDK 7.27.0 type definitions
// (resources/responses/responses.d.ts), not from memory.
import { makeChunk } from './gateway.mjs';
import { normalizeResponseInput } from './messages.mjs';

export const EFFORT_TO_THINK = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4 };

export function thinkFromReasoning(reasoning, fallback) {
  if (reasoning?.effort && EFFORT_TO_THINK[reasoning.effort] != null) return EFFORT_TO_THINK[reasoning.effort];
  return fallback ?? null;
}

// Both surfaces accept either knob. Our non-standard `think_mode` wins over the OpenAI
// `reasoning.effort` / `reasoning_effort` spellings, so a client that mixes them gets a
// deterministic result instead of one silently overriding the other.
// NaN means "the caller asked for something we cannot express" — the route must 400 rather
// than fall back to the default, because a silently ignored thinking request looks like a
// model that just answers worse.
export function resolveThink(body) {
  const explicit = body?.think_mode;
  if (explicit !== undefined && explicit !== null && explicit !== '') return Number(explicit);
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort;
  if (effort == null || effort === '') return null;
  return EFFORT_TO_THINK[effort] ?? Number.NaN;
}

export function normalizeInput(input) {
  return normalizeResponseInput(input);
}

export function newResponseId() {
  return `resp_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function toResponsesUsage(u, consume) {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: u?.cache_read_tokens ?? 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: u?.reasoning_tokens ?? 0 },
    // Not part of the OpenAI contract; a client that ignores unknown keys is unaffected.
    kuku_consume_points: consume ?? null,
  };
}

export function buildResponse({ id, model, created, text, thinking, usage, consume, instructions, previous_response_id, store, session_id, reply_id, tool_calls = [], status = 'completed', error = null }) {
  const output = [];
  if (thinking) {
    output.push({
      id: `rs_${id.slice(5, 25)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: thinking }],
    });
  }
  if (text || !tool_calls.length) output.push({
    id: `msg_${id.slice(5, 25)}`,
    type: 'message',
    role: 'assistant',
    status: error ? 'incomplete' : 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  for (const call of tool_calls) output.push(call.type === 'custom'
    ? { id: `ctc_${call.id.slice(5)}`, type: 'custom_tool_call', call_id: call.id, name: call.name, input: call.input, status: 'completed' }
    : { id: `fc_${call.id.slice(5)}`, type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' });
  return {
    id,
    object: 'response',
    created_at: created,
    status: error ? 'failed' : status,
    completed_at: error ? null : created,
    error: error ?? null,
    incomplete_details: null,
    instructions: instructions ?? null,
    model,
    output,
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: previous_response_id ?? null,
    store: store !== false,
    temperature: null,
    top_p: null,
    tool_choice: 'auto',
    tools: [],
    reasoning: null,
    service_tier: 'default',
    usage: toResponsesUsage(usage, consume),
    metadata: null,
    // Extension, not contract: lets the caller bind back to the upstream session.
    kuku: { account: null, session_id: session_id ?? null, reply_id: reply_id ?? null, consume_points: consume ?? null },
  };
}

// One sequence_number per event, monotonically increasing within a single response.
// Clients that reassemble a stream rely on this to detect dropped frames.
export class ResponseStream {
  constructor(res, response, { include = [] } = {}) {
    this.res = res;
    this.n = 0;
    this.include = include;
    this.response = response;
    this.item_id = response.output[response.output.length - 1]?.id ?? `msg_${Date.now()}`;
    this.output_index = Math.max(0, response.output.length - 1);
    this.next_output_index = 0;
    this.text = '';
  }

  emit(type, extra) {
    const evt = { type, sequence_number: this.n++, ...extra };
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`);
    return evt;
  }

  started() {
    const early = { ...this.response, status: 'in_progress', completed_at: null, output: [], output_text: '' };
    this.emit('response.created', { response: early });
    this.emit('response.in_progress', { response: early });
  }

  reasoningStarted() {
    this.reasoning_item_id = `rs_${this.response.id.slice(5, 25)}`;
    this.reasoning_index = this.next_output_index++;
    this.item_id = `msg_${this.response.id.slice(5, 25)}`;
    this.emit('response.output_item.added', { output_index: this.reasoning_index, item: { id: this.reasoning_item_id, type: 'reasoning', summary: [] } });
    this.emit('response.reasoning_summary_part.added', { item_id: this.reasoning_item_id, output_index: this.reasoning_index, summary_index: 0, part: { type: 'summary_text', text: '' } });
  }

  reasoningDelta(delta) {
    this.emit('response.reasoning_summary_text.delta', { item_id: this.reasoning_item_id, output_index: this.reasoning_index, summary_index: 0, delta });
  }

  reasoningDone(full) {
    this.emit('response.reasoning_summary_text.done', { item_id: this.reasoning_item_id, output_index: this.reasoning_index, summary_index: 0, text: full });
    this.emit('response.reasoning_summary_part.done', {
      item_id: this.reasoning_item_id,
      output_index: this.reasoning_index,
      summary_index: 0,
      part: { type: 'summary_text', text: full },
    });
    this.emit('response.output_item.done', {
      output_index: this.reasoning_index,
      item: { id: this.reasoning_item_id, type: 'reasoning', summary: [{ type: 'summary_text', text: full }] },
    });
  }

  messageStarted() {
    this.output_index = this.next_output_index++;
    this.emit('response.output_item.added', {
      output_index: this.output_index,
      item: { id: this.item_id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    this.emit('response.content_part.added', {
      item_id: this.item_id,
      output_index: this.output_index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  delta(chunk) {
    this.text += chunk;
    this.emit('response.output_text.delta', { item_id: this.item_id, output_index: this.output_index, content_index: 0, delta: chunk });
  }

  completed(finalResponse) {
    this.emit('response.output_text.done', { item_id: this.item_id, output_index: this.output_index, content_index: 0, text: this.text });
    this.emit('response.content_part.done', {
      item_id: this.item_id,
      output_index: this.output_index,
      content_index: 0,
      part: { type: 'output_text', text: this.text, annotations: [] },
    });
    this.emit('response.output_item.done', {
      output_index: this.output_index,
      item: { id: this.item_id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.text, annotations: [] }] },
    });
    this.emit('response.completed', { response: finalResponse });
    this.res.end();
  }

  completedAgent(finalResponse) {
    // Preserve indices already delivered, including text arriving before reasoning.
    // The server also orders before persistence so GET and completed agree.
    this.orderOutput(finalResponse);
    for (const [output_index, item] of finalResponse.output.entries()) {
      const common = { response_id: finalResponse.id, output_index, item_id: item.id };
      const streamed = item.type === 'message' ? this.messageOpen : item.type === 'reasoning' ? this.reasoningOpen : false;
      if (!streamed) this.emit('response.output_item.added', { response_id: finalResponse.id, output_index,
        item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] }
          : item.type === 'function_call' ? { arguments: '' } : item.type === 'custom_tool_call' ? { input: '' } : { summary: [] }) } });
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const custom = item.type === 'custom_tool_call', prefix = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
        const value = custom ? item.input : item.arguments;
        this.emit(`${prefix}.delta`, { ...common, delta: value });
        this.emit(`${prefix}.done`, { ...common, ...(custom ? { input: value } : { arguments: value, name: item.name }) });
      } else if (item.type === 'message') {
        const part = item.content[0];
        if (!streamed) this.emit('response.content_part.added', { ...common, content_index: 0, part: { ...part, text: '' } });
        const remaining = streamed ? part.text.slice(this.text.length) : part.text;
        if (remaining || !streamed) this.emit('response.output_text.delta', { ...common, content_index: 0, delta: remaining });
        this.emit('response.output_text.done', { ...common, content_index: 0, text: part.text });
        this.emit('response.content_part.done', { ...common, content_index: 0, part });
      } else if (item.type === 'reasoning') {
        const part = item.summary[0];
        if (!streamed) this.emit('response.reasoning_summary_part.added', { ...common, summary_index: 0, part: { ...part, text: '' } });
        const remaining = streamed ? part.text.slice((this.reasoningText ?? '').length) : part.text;
        if (remaining || !streamed) this.emit('response.reasoning_summary_text.delta', { ...common, summary_index: 0, delta: remaining });
        this.emit('response.reasoning_summary_text.done', { ...common, summary_index: 0, text: part.text });
        this.emit('response.reasoning_summary_part.done', { ...common, summary_index: 0, part });
      }
      this.emit('response.output_item.done', { response_id: finalResponse.id, output_index, item });
    }
    this.emit('response.completed', { response: finalResponse });
    this.res.end();
  }

  orderOutput(response) {
    const started = new Map();
    if (this.messageOpen) started.set(this.item_id, this.output_index);
    if (this.reasoningOpen) started.set(this.reasoning_item_id, this.reasoning_index);
    response.output.sort((a, b) => (started.get(a.id) ?? Infinity) - (started.get(b.id) ?? Infinity));
    return response;
  }

  failed(message, response = null) {
    this.emit('error', { message, code: null, param: null });
    if (response) this.emit('response.failed', { response });
    this.res.end();
  }
}
