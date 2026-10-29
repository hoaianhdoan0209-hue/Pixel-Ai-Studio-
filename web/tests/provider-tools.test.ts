import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAIProvider, createAnthropicProvider, ProviderError, type ProviderRequest, type ProviderTool, type ProviderToolCall } from '../server/ai-providers.js';

const tools: ProviderTool[] = [
  { name: 'read_project', description: 'Read the already authorized project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_tasks', description: 'Read task metadata.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
];
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'fixture-model', messages: [{ role: 'user', content: 'Read this project.' }],
  maxOutputTokens: 128, tools, signal: new AbortController().signal, onDelta() {}, ...overrides,
});
function sse(events: Array<unknown | '[DONE]'>) {
  const text = events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
    controller.close();
  }}), { headers: { 'Content-Type': 'text/event-stream' } });
}
function openAI(events: unknown[], inspect?: (body: any) => void) {
  return createOpenAIProvider('fixture-key-only', (async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    inspect?.(JSON.parse(String(init?.body)));
    return sse(events);
  }) as typeof fetch);
}
function anthropic(events: unknown[], inspect?: (body: any) => void) {
  return createAnthropicProvider('fixture-key-only', (async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init?.redirect, 'error');
    inspect?.(JSON.parse(String(init?.body)));
    return sse(events);
  }) as typeof fetch);
}
const fragment = (index: number, part: unknown, finish: string | null = null) => ({ choices: [{ delta: { tool_calls: [{ index, ...part as object }] }, finish_reason: finish }] });
const finish = (reason = 'tool_calls') => ({ choices: [{ delta: {}, finish_reason: reason }] });
const callPart = (args = '{}', id = 'call_a', name = 'read_project') => ({ id, type: 'function', function: { name, arguments: args } });
const invalid = (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_TOOL_CALL';
const toolStream = (args = '{}', name = 'read_project', id = 'tool_a') => [
  { type: 'message_start', message: { usage: { input_tokens: 23, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
];

test('OpenAI native tool streams assemble interleaved fragments and preserve usage without inventing text', async () => {
  const result = await openAI([
    fragment(0, { id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"name":"' } }),
    fragment(1, callPart('{"limit":', 'call_tasks', 'read_tasks')),
    fragment(0, { id: 'project', function: { name: 'project', arguments: 'Làng xanh 🌿"}' } }),
    fragment(1, { function: { arguments: '5}' } }, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 44, completion_tokens: 19 } },
    '[DONE]',
  ], body => {
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['read_project', 'read_tasks']);
    assert.deepEqual(body.tools[0].function.parameters, tools[0].inputSchema);
    assert.equal(body.stream_options.include_usage, true);
  }).generate(request());
  assert.deepEqual(result, { text: '', inputTokens: 44, outputTokens: 19, toolCalls: [
    { id: 'call_project', name: 'read_project', arguments: { name: 'Làng xanh 🌿' } },
    { id: 'call_tasks', name: 'read_tasks', arguments: { limit: 5 } },
  ] });
});

test('OpenAI serializes assistant tool calls and tool results for the next bounded turn', async () => {
  const toolCalls: ProviderToolCall[] = [{ id: 'call_a', name: 'read_project', arguments: {} }];
  const result = await openAI([
    { choices: [{ delta: { content: 'Read authorized context.' }, finish_reason: 'stop' }] }, '[DONE]',
  ], body => {
    assert.deepEqual(body.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_project', arguments: '{}' } }] });
    assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call_a', content: '{"name":"Garden"}' });
  }).generate(request({ messages: [{ role: 'user', content: 'Read it.' }, { role: 'assistant', content: '', toolCalls }, { role: 'tool', toolCallId: 'call_a', content: '{"name":"Garden"}' }] }));
  assert.equal(result.text, 'Read authorized context.');
  assert.ok(!('toolCalls' in result));
});

test('OpenAI rejects malformed, unknown, duplicate, oversized or unfinished tool calls', async t => {
  const cases: Array<[string, unknown[]]> = [
    ['unknown tool', [fragment(0, callPart('{}', 'call_a', 'host_exec')), finish(), '[DONE]']],
    ['invalid arguments', [fragment(0, callPart('{bad')), finish(), '[DONE]']],
    ['array root', [fragment(0, callPart('[]')), finish(), '[DONE]']],
    ['prototype key', [fragment(0, callPart('{"nested":{"__proto__":{"polluted":true}}}')), finish(), '[DONE]']],
    ['oversized arguments', [fragment(0, callPart(JSON.stringify({ text: 'x'.repeat(17000) }))), finish(), '[DONE]']],
    ['fifth tool index', [fragment(4, callPart()), finish(), '[DONE]']],
    ['duplicate IDs', [fragment(0, callPart()), fragment(1, callPart('{}', 'call_a', 'read_tasks')), finish(), '[DONE]']],
    ['missing arguments', [fragment(0, { id: 'call_a', function: { name: 'read_project' } }), finish(), '[DONE]']],
    ['truncated arguments', [fragment(0, callPart('{"a":')), finish(), '[DONE]']],
    ['length finish', [fragment(0, callPart()), finish('length'), '[DONE]']],
    ['missing tool finish', [fragment(0, callPart()), '[DONE]']],
    ['empty tool finish', [finish(), '[DONE]']],
    ['content after finish', [fragment(0, callPart()), finish(), { choices: [{ delta: { content: 'late' } }] }, '[DONE]']],
  ];
  for (const [label, events] of cases) await t.test(label, async () => assert.rejects(openAI(events).generate(request()), invalid));
  await t.test('no completion marker', async () => assert.rejects(openAI([fragment(0, callPart()), finish()]).generate(request()), error => error instanceof ProviderError && error.code === 'INTERRUPTED_STREAM'));
  await t.test('unsolicited calls when tools are not enabled', async () => assert.rejects(openAI([fragment(0, callPart()), finish(), '[DONE]']).generate(request({ tools: undefined })), invalid));
  assert.equal(({} as any).polluted, undefined);
});

test('Anthropic native tool blocks assemble JSON deltas and close before message_stop', async () => {
  const result = await anthropic([
    { type: 'message_start', message: { usage: { input_tokens: 23, output_tokens: 0 } } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_a', name: 'read_tasks', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"limit":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '3}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ], body => {
    assert.equal(body.tools[1].name, 'read_tasks');
    assert.deepEqual(body.tools[1].input_schema, tools[1].inputSchema);
  }).generate(request());
  assert.deepEqual(result, { text: '', inputTokens: 23, outputTokens: 7, toolCalls: [{ id: 'tool_a', name: 'read_tasks', arguments: { limit: 3 } }] });
});

test('Anthropic serializes assistant tool_use and grouped user tool_result blocks', async () => {
  const toolCalls: ProviderToolCall[] = [{ id: 'tool_a', name: 'read_project', arguments: {} }, { id: 'tool_b', name: 'read_tasks', arguments: { limit: 2 } }];
  const result = await anthropic([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Tools completed.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
  ], body => {
    assert.equal(body.system, 'First\n\nSecond');
    assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tool_a', name: 'read_project', input: {} }, { type: 'tool_use', id: 'tool_b', name: 'read_tasks', input: { limit: 2 } }] });
    assert.deepEqual(body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_a', content: '{"project":{}}' }, { type: 'tool_result', tool_use_id: 'tool_b', content: '{"tasks":[]}' }] });
  }).generate(request({ messages: [
    { role: 'system', content: 'First' }, { role: 'system', content: 'Second' },
    { role: 'user', content: 'Read it.' }, { role: 'assistant', content: 'Reading.', toolCalls },
    { role: 'tool', toolCallId: 'tool_a', content: '{"project":{}}' }, { role: 'tool', toolCallId: 'tool_b', content: '{"tasks":[]}' },
  ] }));
  assert.equal(result.text, 'Tools completed.');
});

test('Anthropic rejects incomplete blocks, invalid JSON, undeclared tools and duplicate IDs', async t => {
  const cases: Array<[string, unknown[]]> = [
    ['invalid JSON', toolStream('{bad')],
    ['array arguments', toolStream('[]')],
    ['prototype key', toolStream('{"constructor":{"prototype":{"polluted":true}}}')],
    ['unknown tool', toolStream('{}', 'host_exec')],
    ['oversized arguments', toolStream(JSON.stringify({ text: 'x'.repeat(17000) }))],
    ['missing block stop', toolStream().filter((event: any) => event.type !== 'content_block_stop')],
    ['wrong stop reason', toolStream().map((event: any) => event.type === 'message_delta' ? { ...event, delta: { stop_reason: 'max_tokens' } } : event)],
    ['duplicate block index', [toolStream()[1], toolStream()[1], ...toolStream().slice(2)]],
    ['duplicate tool IDs', [toolStream()[1], { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_a', name: 'read_tasks', input: {} } }, { type: 'content_block_stop', index: 1 }, ...toolStream().slice(4)]],
    ['orphan argument fragment', [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }, ...toolStream().slice(4)]],
  ];
  for (const [label, events] of cases) await t.test(label, async () => assert.rejects(anthropic(events).generate(request()), invalid));
  await t.test('missing message stop', async () => assert.rejects(anthropic(toolStream().filter((event: any) => event.type !== 'message_stop')).generate(request()), error => error instanceof ProviderError && error.code === 'INTERRUPTED_STREAM'));
});
