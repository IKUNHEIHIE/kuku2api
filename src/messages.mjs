// These APIs bridge text chat, not the desktop client's tool execution protocol.
function invalid(message, code = 'invalid_message_content') {
  return Object.assign(new Error(message), { status: 400, code });
}

export function textContent(content, types = ['text']) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('content must be a string or an array of text parts');
  return content.map(part => {
    if (!part || !types.includes(part.type)) throw invalid(
      'Only text content is supported; images, files, audio and other content parts cannot be forwarded', 'unsupported_content_type');
    if (typeof part.text !== 'string') throw invalid('Each text part must contain a string text field');
    return part.text;
  }).join('');
}

export function validateTextOnlyTools(body) {
  for (const field of ['tools', 'functions']) {
    if (body[field] != null && !Array.isArray(body[field])) throw invalid(`${field} must be an array`, 'invalid_tools');
    const choice = field === 'tools' ? body.tool_choice : body.function_call;
    if (body[field]?.length && choice !== 'none') throw invalid(
      'Client tool calling is not supported. Disable tools for this provider and start a text-only conversation; coding agents require a provider with tool calling support',
      'unsupported_tools');
  }
  for (const choice of [body.tool_choice, body.function_call]) {
    if (choice != null && choice !== 'auto' && choice !== 'none') throw invalid('Required or named tool calls are not supported', 'unsupported_tools');
  }
}

export function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw invalid('messages must be a non-empty array');
  const normalized = messages.map(message => {
    if (!message || typeof message !== 'object') throw invalid('Each message must be an object');
    // Empty tool_calls is emitted by some text-only clients.
    if (message.role === 'tool' || message.role === 'function' || message.function_call != null || message.tool_call_id != null
        || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length))) {
      throw invalid('Tool calls and tool results are not supported', 'unsupported_tools');
    }
    if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) throw invalid('Unsupported message role');
    return { role: message.role === 'developer' ? 'system' : message.role, content: textContent(message.content) };
  });
  if (!normalized.findLast(message => message.role === 'user')?.content.trim()) throw invalid('A non-empty user text message is required');
  return normalized;
}

export function normalizeResponseInput(input) {
  if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : [];
  if (!Array.isArray(input)) return [];
  const messages = input.map(item => {
    if (!item || (item.type != null && item.type !== 'message')) throw invalid('Only text message input items are supported; tool items cannot be forwarded', 'unsupported_input_type');
    return { ...item, content: textContent(item.content, ['input_text', 'output_text', 'text']) };
  });
  return messages.length ? normalizeChatMessages(messages) : [];
}
