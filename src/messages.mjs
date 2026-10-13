import { normalizeImagePart, imageName, validateImages } from './images.mjs';
// Content normalization shared by plain chat and the native client-tool adapter.
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

export function callerInstructions(messages, instructions = '') {
  return [...messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content), instructions]
    .filter(Boolean).join('\n\n');
}

export function normalizeContent(content, types = ['text'], images = false) {
  if (!Array.isArray(content) || !content.some(p => ['image_url','input_image'].includes(p?.type))) return textContent(content, types);
  if (!images) throw invalid('Images are supported in user input and tool results only', 'unsupported_content_type');
  return content.map(part => ['image_url','input_image'].includes(part?.type) ? normalizeImagePart(part)
    : { type: 'text', text: textContent([part], types) });
}
export function visibleContent(content) {
  return typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : `[Image attachment: ${imageName(part)}]`).join('');
}
export function visibleMessages(messages) {
  return messages.map(m => ({ ...m, content: visibleContent(m.content) }));
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
    return { role: message.role === 'developer' ? 'system' : message.role, content: normalizeContent(message.content, ['text'], message.role === 'user') };
  });
  if (!visibleContent(normalized.findLast(message => message.role === 'user')?.content ?? '').trim()) throw invalid('A non-empty user message is required');
  validateImages(normalized);
  return normalized;
}

export function normalizeResponseInput(input) {
  if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : [];
  if (!Array.isArray(input)) return [];
  const messages = input.map(item => {
    if (!item || (item.type != null && item.type !== 'message')) throw invalid('Only text message input items are supported; tool items cannot be forwarded', 'unsupported_input_type');
    return { ...item, content: normalizeContent(item.content, ['input_text', 'output_text', 'text'], item.role === 'user') };
  });
  return messages.length ? normalizeChatMessages(messages) : [];
}
