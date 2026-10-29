export type ProviderName = 'openai' | 'anthropic';
export interface ProviderTool { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ProviderToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
};
export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}
export interface ProviderResult {
  text: string;
  toolCalls?: ProviderToolCall[];
  inputTokens?: number;
  outputTokens?: number;
}
export interface AIProvider {
  configured: boolean;
  generate: (request: ProviderRequest) => Promise<ProviderResult>;
}
export class ProviderError extends Error {
  constructor(public code: string, message: string, public retryAfterMs?: number, public rejected = false) { super(message); }
}

type Fetcher = typeof fetch;
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

async function* events(response: Response, signal: AbortSignal) {
  if (!response.body) throw new ProviderError('EMPTY_RESPONSE', 'Nhà cung cấp không trả về stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new ProviderError('RESPONSE_LIMIT', 'Phản hồi AI vượt giới hạn 2 MiB.');
      pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { yield { __streamDone: true }; continue; }
        try { yield JSON.parse(data) as Record<string, any>; }
        catch { throw new ProviderError('INVALID_STREAM', 'Nhà cung cấp trả về stream JSON không hợp lệ.'); }
      }
    }
    pending += decoder.decode();
    const data = pending.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (data === '[DONE]') yield { __streamDone: true };
    else if (data) {
      try { yield JSON.parse(data) as Record<string, any>; }
      catch { throw new ProviderError('INVALID_STREAM', 'Nhà cung cấp trả về stream JSON không hợp lệ.'); }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function accepted(response: Response) {
  if (response.ok) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) throw new ProviderError('INVALID_CONTENT_TYPE', 'Nhà cung cấp không trả về SSE.');
    return;
  }
  await response.body?.cancel().catch(() => {});
  const retry = response.headers.get('retry-after');
  const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
  if (response.status === 429) throw new ProviderError('RATE_LIMIT', 'Nhà cung cấp giới hạn lượt gọi; tác vụ sẽ chờ và thử lại có giới hạn.', Math.min(300_000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 5000)), true);
  if ([400, 401, 403, 404, 422].includes(response.status)) throw new ProviderError('PROVIDER_REJECTED', `Nhà cung cấp từ chối yêu cầu (HTTP ${response.status}). Kiểm tra model và cấu hình ở server.`, undefined, true);
  throw new ProviderError('PROVIDER_FAILURE', `Nhà cung cấp trả lỗi HTTP ${response.status}; chi phí chưa thể xác nhận.`);
}

const MAX_TOOL_CALLS = 4;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_TOOL_ID = 128;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const invalidTool = () => new ProviderError('INVALID_TOOL_CALL', 'Lời gọi công cụ AI không hợp lệ, bị cắt ngắn hoặc vượt giới hạn.');

type PartialTool = { id: string; name: string; arguments: string; initial?: unknown; stopped?: boolean };
function appendToolPart(value: string, part: unknown, limit: number) {
  if (part === undefined) return value;
  if (typeof part !== 'string') throw invalidTool();
  const next = value + part;
  if (Buffer.byteLength(next, 'utf8') > limit) throw invalidTool();
  return next;
}
function safeObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++count > 2048 || depth > 16) return false;
    if (!item || typeof item !== 'object') return true;
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    return Object.entries(item).every(([key, entry]) => !['__proto__', 'prototype', 'constructor'].includes(key) && visit(entry, depth + 1));
  }
  return visit(value, 0);
}
function toolDefinitions(tools: ProviderTool[] | undefined) {
  if (!tools?.length) return [];
  if (tools.length > MAX_TOOL_CALLS) throw invalidTool();
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name) || !safeObject(tool.inputSchema) || typeof tool.description !== 'string' || tool.description.length > 2000 || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > MAX_ARGUMENT_BYTES) throw invalidTool();
    names.add(tool.name);
  }
  return tools;
}
function completeTools(parts: Iterable<PartialTool>, declared: ProviderTool[]): ProviderToolCall[] {
  const names = new Set(declared.map(tool => tool.name)), ids = new Set<string>();
  const results: ProviderToolCall[] = [];
  for (const part of parts) {
    if (results.length >= MAX_TOOL_CALLS || !TOOL_ID.test(part.id) || ids.has(part.id) || !TOOL_NAME.test(part.name) || !names.has(part.name)) throw invalidTool();
    let args: unknown;
    if (part.arguments) {
      try { args = JSON.parse(part.arguments); } catch { throw invalidTool(); }
    } else args = part.initial;
    if (!safeObject(args) || Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) throw invalidTool();
    ids.add(part.id);
    results.push({ id: part.id, name: part.name, arguments: args });
  }
  return results;
}
function messageCalls(message: ProviderMessage, tools: ProviderTool[]) {
  if (!message.toolCalls?.length) return [];
  if (message.role !== 'assistant') throw invalidTool();
  return completeTools(message.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: '', initial: call.arguments })), tools);
}
function openAIMessages(messages: ProviderMessage[], tools: ProviderTool[]) {
  return messages.map(message => {
    if (message.role === 'tool') {
      if (!message.toolCallId || !TOOL_ID.test(message.toolCallId) || Buffer.byteLength(message.content) > 64 * 1024) throw invalidTool();
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    }
    const calls = messageCalls(message, tools);
    return { role: message.role, content: calls.length && !message.content ? null : message.content, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
  });
}
function anthropicMessages(messages: ProviderMessage[], tools: ProviderTool[]) {
  const output: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.toolCallId || !TOOL_ID.test(message.toolCallId) || Buffer.byteLength(message.content) > 64 * 1024) throw invalidTool();
      const result = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = output[output.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(block => block.type === 'tool_result')) last.content.push(result);
      else output.push({ role: 'user', content: [result] });
      continue;
    }
    const calls = messageCalls(message, tools);
    const content = calls.length ? [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
    ] : message.content;
    output.push({ role: message.role, content });
  }
  return output;
}

export function createOpenAIProvider(apiKey = process.env.AI_API_KEY || '', fetcher: Fetcher = fetch): AIProvider {
  return {
    configured: !!apiKey,
    async generate(request) {
      if (!apiKey) throw new ProviderError('NOT_CONFIGURED', 'Chưa cấu hình AI_API_KEY ở server.', undefined, true);
      const tools = toolDefinitions(request.tools);
      const response = await fetcher('https://api.openai.com/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: request.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: request.model, messages: openAIMessages(request.messages, tools), max_completion_tokens: request.maxOutputTokens, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) }),
      });
      await accepted(response);
      let text = '', inputTokens: number | undefined, outputTokens: number | undefined, finished = false, finishReason: string | null = null;
      const partials = new Map<number, PartialTool>();
      for await (const event of events(response, request.signal)) {
        if (event.__streamDone) { finished = true; break; }
        if (event.error) throw new ProviderError('PROVIDER_STREAM_ERROR', 'Nhà cung cấp báo lỗi trong stream; không tự gửi lại tác vụ không chắc chắn.');
        const choice = event.choices?.[0], delta = choice?.delta?.content, previousFinish = finishReason;
        if (previousFinish && (typeof delta === 'string' && delta.length || choice?.delta?.tool_calls !== undefined)) throw invalidTool();
        if (typeof delta === 'string') {
          text += delta;
          if (text.length > 200_000) throw new ProviderError('OUTPUT_LIMIT', 'Đầu ra AI vượt giới hạn.');
          request.onDelta(delta);
        }
        if (choice?.finish_reason != null) {
          if (typeof choice.finish_reason !== 'string') throw invalidTool();
          finishReason = choice.finish_reason;
        }
        const fragments = choice?.delta?.tool_calls;
        if (fragments !== undefined) {
          if (!Array.isArray(fragments) || !tools.length || previousFinish !== null) throw invalidTool();
          for (const fragment of fragments) {
            if (!Number.isInteger(fragment?.index) || fragment.index < 0 || fragment.index >= MAX_TOOL_CALLS || (fragment.type !== undefined && fragment.type !== 'function')) throw invalidTool();
            if (fragment.function !== undefined && (!fragment.function || typeof fragment.function !== 'object' || Array.isArray(fragment.function))) throw invalidTool();
            let part = partials.get(fragment.index);
            if (!part) { part = { id: '', name: '', arguments: '' }; partials.set(fragment.index, part); }
            part.id = appendToolPart(part.id, fragment.id, MAX_TOOL_ID);
            part.name = appendToolPart(part.name, fragment.function?.name, 64);
            part.arguments = appendToolPart(part.arguments, fragment.function?.arguments, MAX_ARGUMENT_BYTES);
          }
        }
        if (event.usage) { inputTokens = tokenCount(event.usage.prompt_tokens); outputTokens = tokenCount(event.usage.completion_tokens); }
      }
      if (!finished) throw new ProviderError('INTERRUPTED_STREAM', 'Stream AI kết thúc trước dấu hoàn thành; không ghi nhận tác vụ thành công.');
      if ((partials.size && finishReason !== 'tool_calls') || (!partials.size && finishReason === 'tool_calls')) throw invalidTool();
      const toolCalls = completeTools([...partials.entries()].sort(([a], [b]) => a - b).map(([, part]) => part), tools);
      if (!text.trim() && !toolCalls.length) throw new ProviderError('EMPTY_OUTPUT', 'Nhà cung cấp không trả về nội dung.');
      return { text, inputTokens, outputTokens, ...(toolCalls.length ? { toolCalls } : {}) };
    },
  };
}

export function createAnthropicProvider(apiKey = process.env.ANTHROPIC_API_KEY || '', fetcher: Fetcher = fetch): AIProvider {
  return {
    configured: !!apiKey,
    async generate(request) {
      if (!apiKey) throw new ProviderError('NOT_CONFIGURED', 'Chưa cấu hình ANTHROPIC_API_KEY ở server.', undefined, true);
      const tools = toolDefinitions(request.tools);
      const response = await fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error', signal: request.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: request.model, system: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'), messages: anthropicMessages(request.messages, tools), max_tokens: request.maxOutputTokens, stream: true, ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) }),
      });
      await accepted(response);
      let text = '', inputTokens: number | undefined, outputTokens: number | undefined, finished = false, stopReason: string | null = null;
      const partials = new Map<number, PartialTool>();
      for await (const event of events(response, request.signal)) {
        if (event.type === 'error') throw new ProviderError('PROVIDER_STREAM_ERROR', 'Nhà cung cấp báo lỗi trong stream; không tự gửi lại tác vụ không chắc chắn.');
        if (event.type === 'message_start') inputTokens = tokenCount(event.message?.usage?.input_tokens);
        if (event.type === 'message_stop') { finished = true; break; }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const block = event.content_block;
          if (!tools.length || partials.size >= MAX_TOOL_CALLS || !Number.isInteger(event.index) || event.index < 0 || event.index > 31 || partials.has(event.index) || typeof block.id !== 'string' || typeof block.name !== 'string') throw invalidTool();
          partials.set(event.index, { id: block.id, name: block.name, arguments: '', initial: block.input, stopped: false });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const part = partials.get(event.index);
          if (!part || part.stopped) throw invalidTool();
          part.arguments = appendToolPart(part.arguments, event.delta.partial_json, MAX_ARGUMENT_BYTES);
        }
        if (event.type === 'content_block_stop' && partials.has(event.index)) {
          const part = partials.get(event.index)!;
          if (part.stopped) throw invalidTool();
          part.stopped = true;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          text += event.delta.text;
          if (text.length > 200_000) throw new ProviderError('OUTPUT_LIMIT', 'Đầu ra AI vượt giới hạn.');
          request.onDelta(event.delta.text);
        }
        if (event.type === 'message_delta') {
          if (event.usage) outputTokens = tokenCount(event.usage.output_tokens);
          if (event.delta?.stop_reason != null) stopReason = event.delta.stop_reason;
        }
      }
      if (!finished) throw new ProviderError('INTERRUPTED_STREAM', 'Stream AI kết thúc trước message_stop; không ghi nhận tác vụ thành công.');
      if ((!partials.size && stopReason === 'tool_use') || (partials.size && (stopReason !== 'tool_use' || [...partials.values()].some(part => !part.stopped)))) throw invalidTool();
      const toolCalls = completeTools([...partials.entries()].sort(([a], [b]) => a - b).map(([, part]) => part), tools);
      if (!text.trim() && !toolCalls.length) throw new ProviderError('EMPTY_OUTPUT', 'Nhà cung cấp không trả về nội dung.');
      return { text, inputTokens, outputTokens, ...(toolCalls.length ? { toolCalls } : {}) };
    },
  };
}
