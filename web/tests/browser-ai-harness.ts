/** Explicit test-only process. Never imported by server/index.ts. */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { createOpenAIProvider } from '../server/ai-providers.js';

const dataDir = resolve(process.env.DATA_DIR || '');
if (process.env.PIXEL_TEST_HARNESS !== '1' || process.env.NODE_ENV !== 'test' ||
    basename(dataDir) !== 'phase-qa-data' || !existsSync(join(dataDir, '.pixel-e2e-allow-fixtures'))) {
  throw new Error('An explicitly marked, isolated test directory is required.');
}
if (Number(process.env.PORT) === 3001) throw new Error('Normal runtime port is forbidden.');
for (const key of ['AI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_APP_PRIVATE_KEY', 'GH_WEBHOOK_SECRET', 'APP_ENCRYPTION_KEY']) {
  if (process.env[key]) throw new Error('Do not inherit live credentials into the fixture service.');
}
const files = {
  'index.html': '<!doctype html><html lang="vi"><head><meta charset="UTF-8"><title>Tool fixture garden</title></head><body><h1>Tool garden</h1><button id="grow">Grow garden</button><output id="count">0</output><script src="game.js"></script></body></html>',
  'game.js': 'let count=0;document.getElementById("grow").addEventListener("click",()=>{document.getElementById("count").textContent=String(++count)});',
  'game.test.js': 'const assert=require("node:assert/strict");assert.equal(6*7,42);console.log("TOOL-BROWSER-ACTUAL-DOCKER");',
};
const encoder = new TextEncoder();
function sse(events: unknown[]) {
  const bytes = encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
    controller.close();
  }}), {headers: {'Content-Type': 'text/event-stream'}});
}
const provider = createOpenAIProvider('fixture-only-never-a-live-key', (async (url, init) => {
  if (url !== 'https://api.openai.com/v1/chat/completions') throw new Error('Unexpected fixture destination');
  const body = JSON.parse(String(init?.body));
  const results = body.messages.filter((message: any) => message.role === 'tool');
  if(!body.messages.some((message:any)=>message.role==='user'&&message.content.includes('BROWSER_SKILL_REFERENCE')))throw new Error('Imported skill was not sent as reference context');
  if (!body.tools?.length) return sse([
    {choices: [{delta: {content: 'Explicit browser fixture text; no external provider was called.'}, finish_reason: 'stop'}]},
    {choices: [], usage: {prompt_tokens: 10, completion_tokens: 4}},
  ]);
  if (!results.length) return sse([
    {choices: [{delta: {tool_calls: [
      {index: 0, id: 'fixture_read_project', type: 'function', function: {name: 'read_project', arguments: '{}'}},
      {index: 1, id: 'fixture_read_tasks', type: 'function', function: {name: 'read_tasks', arguments: '{}'}},
    ]}, finish_reason: 'tool_calls'}]},
    {choices: [], usage: {prompt_tokens: 8, completion_tokens: 3}},
  ]);
  if (results.length === 2) return sse([
    {choices: [{delta: {tool_calls: [{index: 0, id: 'fixture_request_build', type: 'function', function: {
      name: 'request_build', arguments: JSON.stringify({version: 'tool-browser-1', files}),
    }}]}, finish_reason: 'tool_calls'}]},
    {choices: [], usage: {prompt_tokens: 24, completion_tokens: 15}},
  ]);
  return sse([
    {choices: [{delta: {content: 'Đã đọc dự án và lưu đề xuất build. Chưa chạy code; đang chờ chủ dự án phê duyệt.'}, finish_reason: 'stop'}]},
    {choices: [], usage: {prompt_tokens: 17, completion_tokens: 7}},
  ]);
}) as typeof fetch);
const instance = createApp({dataDir, allowFirstAdmin: true, skills:{fetcher:async(url,options)=>{if(url!=='https://raw.githubusercontent.com/example/skills/main/game/SKILL.md'||options?.redirect!=='error')throw new Error('Unexpected skill destination');return new Response('# Game design\nBROWSER_SKILL_REFERENCE: use small readable UI buttons.');}}, ai: {
  providers: {openai: provider, anthropic: {configured: false, generate: async () => {throw new Error('No Anthropic fixture configured');}}},
  workerEnabled: true,
}, integrations: {runnerEnabled: true}});
const server = instance.app.listen(Number(process.env.PORT || 3202), '127.0.0.1', () => console.log('Explicit browser fixture service ready.'));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  instance.stopServices();
  const timer = setTimeout(() => server.closeAllConnections(), 15000);
  timer.unref();
  server.close(() => {clearTimeout(timer);instance.close();process.exit(0);});
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
