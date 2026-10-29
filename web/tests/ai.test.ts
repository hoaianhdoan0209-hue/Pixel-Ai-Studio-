import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { createOpenAIProvider, createAnthropicProvider, ProviderError, type AIProvider, type ProviderRequest } from '../server/ai-providers.js';
import { getAIStatus, type AIOptions } from '../server/ai.js';

const encoder = new TextEncoder();
function sse(data: string) {
  const bytes = encoder.encode(data);
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
test('provider adapters preserve HTTPS destinations, streaming Unicode, usage and explicit failures', async t => {
  await t.test('OpenAI consumes streamed content and final provider usage, without accepting redirects', async () => {
    let delta = '';
    const adapter = createOpenAIProvider('test-token-only', (async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions'); assert.equal(init!.redirect, 'error');
      assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-token-only');
      const body = JSON.parse(init!.body as string); assert.equal(body.max_completion_tokens, 120); assert.equal(body.stream_options.include_usage, true);
      return sse('data: {"choices":[{"delta":{"content":"Xin chào 🌿"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":41,"completion_tokens":9}}\r\n\r\ndata: [DONE]\r\n\r\n');
    }) as typeof fetch);
    const result = await adapter.generate({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 120, signal: new AbortController().signal, onDelta: text => delta += text });
    assert.deepEqual(result, { text: 'Xin chào 🌿', inputTokens: 41, outputTokens: 9 }); assert.equal(delta, result.text);
  });
  await t.test('Anthropic separates system instructions and records message usage', async () => {
    const adapter = createAnthropicProvider('test-token-only', (async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(init!.redirect, 'error');
      const body = JSON.parse(init!.body as string); assert.equal(body.system, 'system'); assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
      return sse('data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0}}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Đã đọc"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: {"type":"message_stop"}\n\n');
    }) as typeof fetch);
    assert.deepEqual(await adapter.generate({ model: 'test-model', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }], maxOutputTokens: 32, signal: new AbortController().signal, onDelta() {} }), { text: 'Đã đọc', inputTokens: 8, outputTokens: 3 });
  });
  await t.test('429 is bounded, missing keys are explicit and invalid SSE fails', async () => {
    const request = { model: 'model', messages: [{ role: 'user' as const, content: 'hello' }], maxOutputTokens: 32, signal: new AbortController().signal, onDelta() {} };
    await assert.rejects(createOpenAIProvider('').generate(request), (error: unknown) => error instanceof ProviderError && error.code === 'NOT_CONFIGURED');
    await assert.rejects(createOpenAIProvider('key', (async () => new Response('', { status: 429, headers: { 'retry-after': '99999999' } })) as typeof fetch).generate(request), (error: unknown) => error instanceof ProviderError && error.retryAfterMs === 300000 && error.rejected);
    await assert.rejects(createAnthropicProvider('key', (async () => sse('data: not-json\n\n')) as typeof fetch).generate(request), (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_STREAM');
    await assert.rejects(createOpenAIProvider('key', (async () => sse('data: {"choices":[{"delta":{"content":"Incomplete"}}]}\n\n')) as typeof fetch).generate(request), (error: unknown) => error instanceof ProviderError && error.code === 'INTERRUPTED_STREAM');
    assert.ok(!JSON.stringify(getAIStatus({ providers: { openai: { configured: true, generate: async () => ({ text: '' }) } } })).includes('test-token-only'));
  });
});

test('persistent AI queue, plan approval and budget ledger enforce project permissions', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-ai-test-'));
  let runtime: ReturnType<typeof createApp> & { ai: { runNext: () => Promise<boolean>; close: () => void } };
  let server: Server; let base = ''; let time = Date.parse('2026-10-27T00:00:00Z');
  let behavior: (request: ProviderRequest) => Promise<any> = async request => { const text = JSON.stringify({ summary: 'A real proposed plan, awaiting review', tasks: [{ title: 'Create the garden', description: 'Implement state', dependsOn: [] }, { title: 'Test the garden', description: 'Exercise saved state', dependsOn: [0] }] }); request.onDelta(text); return { text, inputTokens: 100, outputTokens: 20 }; };
  let calls = 0;
  const provider: AIProvider = { configured: true, generate: request => { calls++; return behavior(request); } };
  const aiOptions: AIOptions = { providers: { openai: provider, anthropic: { configured: false, generate: async () => { throw new Error('must not call'); } } }, workerEnabled: false, clock: () => time, timeoutMs: 5000, retryDelayMs: 1 };
  async function start() {
    runtime = createApp({ dataDir, allowFirstAdmin: true, ai: aiOptions } as Parameters<typeof createApp>[0] & { ai: AIOptions }) as typeof runtime;
    server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { await new Promise<void>(resolve => server.close(() => resolve())); runtime.close(); }
  function client() {
    let cookie = '';
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + '/api' + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0];
      return { status: response.status, body: await response.json() as any };
    };
    return Object.assign(request, { stream: (path: string) => fetch(base + '/api' + path, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) }) });
  }
  const owner = client(), outsider = client(), guest = client(); let projectId = '', ownerId = '', jobId = '';
  const policy = { tokenLimit: 100000, costLimitUsd: 10, jobLimit: 50, maxConcurrent: 1, maxOutputTokens: 100 };
  const submit = (key: string, agent = 'planner') => owner(`/ai/projects/${projectId}/jobs`, 'POST', { prompt: 'Build and test a small pixel garden', agent, provider: 'openai', model: 'fixture-model', idempotencyKey: key });
  try {
    await start();
    const registration = await owner('/auth/register', 'POST', { name: 'AI Owner', email: 'ai-owner@example.test', password: 'secure-test-password-123' }); assert.equal(registration.status, 201); ownerId = registration.body.user.id;
    assert.equal((await outsider('/auth/register', 'POST', { name: 'Other user', email: 'ai-other@example.test', password: 'secure-test-password-123' })).status, 201);
    projectId = (await owner('/projects', 'POST', { name: 'AI Garden', visibility: 'private' })).body.project.id;
    await t.test('configuration, pricing, owner policy and authentication are required before spending', async () => {
      assert.equal((await guest('/ai/projects/' + projectId + '/jobs', 'POST', {})).status, 401);
      assert.equal((await outsider('/ai/projects/' + projectId + '/budget')).status, 404);
      assert.equal((await submit('missing-price')).body.code, 'PRICE_REQUIRED');
      assert.equal((await outsider('/ai/pricing', 'POST', { provider: 'openai', model: 'fixture-model', inputUsdPerMillion: 2, outputUsdPerMillion: 4, effectiveAt: '2026-01-01T00:00:00Z' })).status, 403);
      assert.equal((await owner('/ai/pricing', 'POST', { provider: 'openai', model: 'fixture-model', inputUsdPerMillion: 2, outputUsdPerMillion: 4, effectiveAt: '2026-01-01T00:00:00Z' })).status, 201);
      assert.equal((await submit('missing-budget')).body.code, 'BUDGET_REQUIRED');
      assert.equal((await owner('/ai/projects/' + projectId + '/budget', 'PUT', policy)).status, 200);
      assert.equal((await owner('/ai/projects/' + projectId + '/jobs', 'POST', { prompt: 'No key', agent: 'planner', provider: 'anthropic', model: 'fixture', idempotencyKey: 'no-key-present' })).status, 503);
      assert.equal(calls, 0);
    });
    await t.test('enqueue reserves atomically, idempotency prevents duplicate calls and only approval creates tasks', async () => {
      const first = await submit('first-planner'); assert.equal(first.status, 201); jobId = first.body.job.id;
      assert.equal((await submit('first-planner')).body.job.id, jobId); assert.equal((await submit('first-planner')).status, 200);
      assert.equal((await owner(`/ai/projects/${projectId}/jobs`, 'POST', { prompt: 'Build and test a small pixel garden', agent: 'planner', provider: 'openai', model: 'different-model', idempotencyKey: 'first-planner' })).status, 409);
      const before = runtime.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id=?').get(projectId)!.n;
      assert.equal(await runtime.ai.runNext(), true);
      const detail = await owner('/ai/jobs/' + jobId); assert.equal(detail.body.job.status, 'waiting_approval'); assert.equal(detail.body.messages.length, 3);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id=?').get(projectId)!.n, before);
      assert.equal((await outsider('/ai/jobs/' + jobId)).status, 404);
      const approved = await owner('/ai/jobs/' + jobId + '/approve', 'POST', {}); assert.equal(approved.status, 200); assert.equal(approved.body.taskIds.length, 2);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id=?').get(approved.body.taskIds[1])!.n, 1);
      assert.equal((await owner('/ai/jobs/' + jobId + '/approve', 'POST', {})).status, 409);
      assert.equal(calls, 1);
    });
    await t.test('provider usage is settled once and estimated cost is distinguishable from billing', async () => {
      const usage = (await owner('/usage')).body; assert.equal(usage.inputTokens, 100); assert.equal(usage.outputTokens, 20); assert.equal(usage.entries[0].usageSource, 'provider'); assert.equal(usage.entries[0].costSource, 'provider_usage_estimate'); assert.ok(Math.abs(usage.estimatedCost - .00028) < 1e-12);
      assert.equal((await outsider('/usage')).body.entries.length, 0);
      const budget = (await owner('/ai/projects/' + projectId + '/budget')).body.budget; assert.equal(budget.reservedTokens, 0); assert.equal(budget.spentTokens, 120);
      assert.equal((await owner('/ai/projects/' + projectId + '/budget', 'PUT', { ...policy, version: 999 })).status, 409);
    });
    await t.test('budget reservations include queued work and reject concurrent oversubscription', async () => {
      const otherProject = (await owner('/projects', 'POST', { name: 'Limited budget' })).body.project.id;
      assert.equal((await owner('/ai/projects/' + otherProject + '/budget', 'PUT', { ...policy, tokenLimit: 3000 })).status, 200);
      const results = await Promise.all(['reserved-one', 'reserved-two', 'reserved-three'].map(idempotencyKey => owner('/ai/projects/' + otherProject + '/jobs', 'POST', { prompt: 'x'.repeat(900), agent: 'planner', provider: 'openai', model: 'fixture-model', idempotencyKey })));
      assert.ok(results.some(result => result.status === 201)); assert.ok(results.some(result => result.body.code === 'BUDGET_EXCEEDED'));
      const reserved = (await owner('/ai/projects/' + otherProject + '/budget')).body.budget; assert.ok(reserved.reservedTokens <= 3000);
      for (const result of results.filter(result => result.status === 201)) assert.equal((await owner('/ai/jobs/' + result.body.job.id + '/cancel', 'POST', {})).status, 200);
      assert.equal((await owner('/ai/projects/' + otherProject + '/budget')).body.budget.reservedTokens, 0);
    });
    await t.test('429 retries are bounded and explicit provider rejections do not invent charged usage', async () => {
      behavior = async () => { throw new ProviderError('RATE_LIMIT', '429 fixture', 1, true); };
      const job = (await submit('rate-limited-job', 'developer')).body.job;
      for (let attempt = 0; attempt < 3; attempt++) { await runtime.ai.runNext(); time += 2; }
      const detail = (await owner('/ai/jobs/' + job.id)).body.job; assert.equal(detail.status, 'failed'); assert.equal(detail.attempts, 3);
      const entry = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!; assert.equal(entry.usage_source, 'rejected'); assert.equal(entry.charged_tokens, 0);
    });
    await t.test('unreported and uncertain calls preserve conservative reservations rather than false zero cost', async () => {
      behavior = async request => { request.onDelta('Unreported actual response'); return { text: 'Unreported actual response' }; };
      const job = (await submit('unreported-usage', 'developer')).body.job; await runtime.ai.runNext();
      const entry = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!; assert.equal(entry.usage_source, 'unreported'); assert.equal(entry.cost_source, 'reservation_upper_bound'); assert.equal(entry.charged_tokens, job.reservedTokens);
      behavior = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      aiOptions.timeoutMs = 15;
      const timeout = (await submit('timeout-uncertain', 'reviewer')).body.job; await runtime.ai.runNext();
      aiOptions.timeoutMs = 5000;
      assert.equal((await owner('/ai/jobs/' + timeout.id)).body.job.errorCode, 'TIMEOUT');
      assert.equal(runtime.db.prepare('SELECT cost_source FROM ai_token_usage WHERE job_id=?').get(timeout.id)!.cost_source, 'reservation_upper_bound');
    });
    await t.test('invalid AI plans fail honestly while reported usage is retained', async () => {
      behavior = async () => ({ text: JSON.stringify({ summary: 'Invalid graph', tasks: [{ title: 'Circular plan', dependsOn: [0] }] }), inputTokens: 20, outputTokens: 10 });
      const job = (await submit('invalid-plan-json')).body.job; await runtime.ai.runNext();
      assert.equal((await owner('/ai/jobs/' + job.id)).body.job.status, 'failed'); assert.equal((await owner('/ai/jobs/' + job.id + '/approve', 'POST', {})).status, 409);
      assert.equal(runtime.db.prepare('SELECT input_tokens FROM ai_token_usage WHERE job_id=?').get(job.id)!.input_tokens, 20);
    });
    await t.test('project concurrency limits hold a second queued call until the active call ends', async () => {
      const completions: Array<() => void> = [];
      behavior = request => new Promise(resolve => { completions.push(() => resolve({ text: 'Controlled completion', inputTokens: 3, outputTokens: 2 })); request.signal.addEventListener('abort', () => resolve({ text: 'Aborted', inputTokens: 0, outputTokens: 0 }), { once: true }); });
      const first = (await submit('concurrency-first', 'developer')).body.job;
      const second = (await submit('concurrency-second', 'developer')).body.job;
      const firstCall = runtime.ai.runNext(); assert.equal(completions.length, 1);
      assert.equal(await runtime.ai.runNext(), false); assert.equal((await owner('/ai/jobs/' + second.id)).body.job.status, 'pending');
      completions[0](); await firstCall;
      assert.equal((await owner('/ai/jobs/' + first.id)).body.job.status, 'completed');
      const secondCall = runtime.ai.runNext(); assert.equal(completions.length, 2); completions[1](); await secondCall;
      assert.equal((await owner('/ai/jobs/' + second.id)).body.job.status, 'completed');
    });
    await t.test('cancelling an active call aborts it and settles uncertain usage once', async () => {
      behavior = request => new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); });
      const job = (await submit('cancel-active-job', 'developer')).body.job;
      const pending = runtime.ai.runNext();
      assert.equal((await owner('/ai/jobs/' + job.id + '/cancel', 'POST', {})).body.job.status, 'cancelled');
      await pending;
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
      assert.equal(runtime.db.prepare('SELECT cost_source FROM ai_token_usage WHERE job_id=?').get(job.id)!.cost_source, 'reservation_upper_bound');
    });
    await t.test('server shutdown aborts running calls before closing SQLite and does not issue a late write', async () => {
      behavior = request => new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); });
      const job = (await submit('shutdown-active-job', 'developer')).body.job;
      const pending = runtime.ai.runNext();
      await stop(); await assert.doesNotReject(pending); await start();
      assert.equal((await owner('/ai/jobs/' + job.id)).body.job.errorCode, 'INTERRUPTED');
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
    });
    await t.test('pause/resume/cancel preserves accounting and pending data survives a server restart', async () => {
      const job = (await submit('paused-job', 'developer')).body.job;
      assert.equal((await owner('/ai/jobs/' + job.id + '/pause', 'POST', {})).body.job.status, 'paused');
      assert.equal((await owner('/ai/jobs/' + job.id + '/resume', 'POST', {})).body.job.status, 'pending');
      await stop(); await start();
      assert.equal((await owner('/ai/jobs/' + job.id)).body.job.status, 'pending');
      assert.equal((await owner('/ai/jobs/' + job.id + '/cancel', 'POST', {})).body.job.status, 'cancelled');
      assert.equal(runtime.db.prepare('SELECT charged_tokens FROM ai_token_usage WHERE job_id=?').get(job.id)!.charged_tokens, 0);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
    });
    await t.test('restart marks uncertain running calls failed, accounts once and never automatically reissues them', async () => {
      const job = (await submit('interrupted-job', 'developer')).body.job;
      runtime.db.prepare("UPDATE ai_jobs SET status='running',attempts=1 WHERE id=?").run(job.id);
      const before = calls; await stop(); await start();
      const result = (await owner('/ai/jobs/' + job.id)).body.job; assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'INTERRUPTED'); assert.equal(calls, before);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
      assert.equal(runtime.db.prepare('SELECT cost_source FROM ai_token_usage WHERE job_id=?').get(job.id)!.cost_source, 'reservation_upper_bound');
    });
    await t.test('job SSE streams reject outsiders and close immediately after membership revocation', async () => {
      const job = (await submit('stream-access-job', 'developer')).body.job;
      assert.equal((await outsider.stream('/ai/jobs/' + job.id + '/events')).status, 404);
      const response = await owner.stream('/ai/jobs/' + job.id + '/events'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body!.getReader(); const initial = await reader.read(); assert.match(new TextDecoder().decode(initial.value), /event: job/);
      runtime.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, ownerId);
      assert.equal((await reader.read()).done, true);
      runtime.db.prepare('INSERT INTO project_members VALUES(?,?,?,?)').run(projectId, ownerId, 'owner', new Date(time).toISOString());
      assert.equal((await owner('/ai/jobs/' + job.id + '/cancel', 'POST', {})).status, 200);
    });
    await t.test('queued work loses provider access when project membership is revoked', async () => {
      const job = (await submit('revoked-job', 'developer')).body.job;
      runtime.db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(projectId, ownerId);
      const before = calls; await runtime.ai.runNext(); assert.equal(calls, before);
      assert.equal(runtime.db.prepare('SELECT status,error_code FROM ai_jobs WHERE id=?').get(job.id)!.error_code, 'ACCESS_REVOKED');
      runtime.db.prepare("UPDATE project_members SET role='owner' WHERE project_id=? AND user_id=?").run(projectId, ownerId);
    });
  } finally { if (server!?.listening) await stop(); await rm(dataDir, { recursive: true, force: true }); }
});
