import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { AI_ROLES, type ApprovedAIAction } from '../server/ai-tools.js';
import { ProviderError, type AIProvider, type ProviderRequest, type ProviderResult, type ProviderToolCall } from '../server/ai-providers.js';
import type { AIOptions } from '../server/ai.js';

const sourceFiles = { 'index.html': '<!doctype html><title>Approved source</title><script src="game.js"></script>', 'game.js': 'globalThis.score = 1;' };
const makeCall = (name: string, args: Record<string, unknown> = {}, id = randomUUID()): ProviderToolCall => ({ id, name, arguments: args });
const buildCall = () => makeCall('request_build', { version: 'tool-1.0', files: sourceFiles });
const sourceCall = () => makeCall('propose_source_change', { title: 'Safe proposed change', body: 'Review complete files before writing.', branch: 'pixel/tools-change', base: 'main', files: sourceFiles });

test('AI tools remain bounded, durable and explicitly owner approved', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-ai-tools-'));
  let runtime: ReturnType<typeof createApp>;
  let server!: Server;
  let base = '';
  let providerCalls = 0;
  let behavior: (request: ProviderRequest) => Promise<ProviderResult> = async () => ({ text: 'Completed fixture analysis.', inputTokens: 10, outputTokens: 2 });
  const executions: Array<{ action: ApprovedAIAction; actorId: string }> = [];
  let execute: AIOptions['executeApprovedAction'] = async (action, actorId) => {
    executions.push({ action, actorId });
    return { acceptedProposalId: action.id, buildId: 'trusted-fixture-callback-result' };
  };
  const provider: AIProvider = { configured: true, generate: request => { providerCalls++; return behavior(request); } };
  const options: AIOptions = {
    providers: { openai: provider, anthropic: { configured: false, generate: async () => { throw new Error('Unexpected provider.'); } } },
    workerEnabled: false, timeoutMs: 1500, retryDelayMs: 1,
    executeApprovedAction: (action, actorId) => execute!(action, actorId),
  };
  async function start() {
    runtime = createApp({ dataDir, allowFirstAdmin: true, ai: options });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api`;
  }
  async function stop() {
    runtime.stopServices();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
  }
  function client() {
    let cookie = '';
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: {
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0];
      return { status: response.status, body: await response.json() as any };
    };
    return Object.assign(request, { stream: (path: string) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) }) });
  }
  const owner = client(), developer = client(), outsider = client();
  let projectId = '', ownerId = '', developerId = '';
  let serial = 0;
  const policy = { tokenLimit: 10_000_000, costLimitUsd: 1000, jobLimit: 100, maxConcurrent: 2, maxOutputTokens: 100 };
  const submit = async (extra: Record<string, unknown> = {}, person = owner) => {
    const result = await person(`/ai/projects/${projectId}/jobs`, 'POST', { prompt: 'Analyze only this authorized project.', agent: 'developer', provider: 'openai', model: 'tools-fixture-model', toolsEnabled: true, idempotencyKey: `tool-job-${++serial}`, ...extra });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.job;
  };
  const detail = async (jobId: string) => (await owner('/ai/jobs/' + jobId)).body;
  const approve = (proposal: any, person = owner, version = proposal.version) => person('/ai/tool-proposals/' + proposal.id + '/approve', 'POST', { version });
  function twoSteps(first: ProviderToolCall[], final = 'Tools were used within the supplied project scope.') {
    let step = 0;
    behavior = async request => {
      assert.ok(request.tools?.some(tool => tool.name === 'read_project'));
      if (++step === 1) return { text: '', toolCalls: first, inputTokens: 12, outputTokens: 4 };
      assert.equal(request.messages.filter(message => message.role === 'tool').length, first.length);
      return { text: final, inputTokens: 17, outputTokens: 5 };
    };
  }
  try {
    await start();
    const account = await owner('/auth/register', 'POST', { name: 'Tool project owner', email: 'tools-owner@example.test', password: 'Fixture-password-2026!' });
    assert.equal(account.status, 201); ownerId = account.body.user.id;
    const dev = await developer('/auth/register', 'POST', { name: 'Tool project developer', email: 'tools-dev@example.test', password: 'Fixture-password-2026!' });
    assert.equal(dev.status, 201); developerId = dev.body.user.id;
    assert.equal((await outsider('/auth/register', 'POST', { name: 'Tool outsider', email: 'tools-outsider@example.test', password: 'Fixture-password-2026!' })).status, 201);
    projectId = (await owner('/projects', 'POST', { name: 'Private tool project', description: 'A real isolated project record.' })).body.project.id;
    const invitation = await owner(`/projects/${projectId}/invitations`, 'POST', { email: 'tools-dev@example.test', role: 'developer' });
    assert.equal(invitation.status, 201);
    assert.equal((await developer('/invitations/' + invitation.body.invitation.id + '/accept', 'POST', {})).status, 200);
    assert.equal((await owner('/ai/pricing', 'POST', { provider: 'openai', model: 'tools-fixture-model', inputUsdPerMillion: 2, outputUsdPerMillion: 4, effectiveAt: '2026-01-01T00:00:00Z' })).status, 201);
    assert.equal((await owner(`/ai/projects/${projectId}/budget`, 'PUT', policy)).status, 200);

    await t.test('read tools receive current project data and all provider rounds settle exactly once', async () => {
      const task = (await owner(`/projects/${projectId}/tasks`, 'POST', { title: 'Read this task', description: 'Existing saved data.' })).body.task;
      let step = 0;
      behavior = async request => {
        assert.ok(request.tools?.some(tool => tool.name === 'read_project'));
        if (++step === 1) return { text: '', toolCalls: [makeCall('read_project'), makeCall('read_tasks')], inputTokens: 12, outputTokens: 4 };
        const replies = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        assert.equal(replies[0].id, projectId);
        assert.equal(replies[0].name, 'Private tool project');
        assert.equal(replies[1].tasks[0].id, task.id);
        assert.ok(!JSON.stringify(replies).includes('password_hash'));
        return { text: 'Read real project and task data.', inputTokens: 17, outputTokens: 5 };
      };
      const before = providerCalls, job = await submit();
      assert.ok(job.reservedTokens > 100000, 'Reservation must include bounded prior tool/assistant messages.');
      assert.equal(await runtime.ai.runNext(), true);
      const result = await detail(job.id);
      assert.equal(result.job.status, 'completed');
      assert.equal(result.toolCalls.length, 2);
      assert.equal(result.toolProposals.length, 0);
      assert.equal(providerCalls - before, 2);
      assert.equal(executions.length, 0);
      const usage = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!;
      assert.equal(usage.input_tokens, 29); assert.equal(usage.output_tokens, 9);
      assert.equal(usage.charged_tokens, 38); assert.equal(usage.usage_source, 'provider');
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
      assert.equal((await outsider('/ai/jobs/' + job.id)).status, 404);
    });

    await t.test('all eight roles persist and return their actual role without breaking legacy storage', async () => {
      assert.equal((await owner('/ai/status')).body.roles.length, 8);
      for (const role of AI_ROLES) {
        assert.equal((await owner('/ai/agents/' + role, 'PUT', { provider: 'openai', model: 'tools-fixture-model' })).status, 200);
        behavior = async () => ({ text: role === 'planner' ? JSON.stringify({ summary: 'A proposed plan', tasks: [{ title: 'A proposed task', dependsOn: [] }] }) : `${role} role result.`, inputTokens: 1, outputTokens: 1 });
        const job = await submit({ agent: role, toolsEnabled: false });
        assert.equal(job.agent, role); assert.equal(job.toolsEnabled, false);
        assert.equal(await runtime.ai.runNext(), true);
        const current = await detail(job.id);
        assert.equal(current.job.agent, role);
        assert.equal(current.job.status, role === 'planner' ? 'waiting_approval' : 'completed');
        const row = runtime.db.prepare('SELECT agent,agent_role FROM ai_jobs WHERE id=?').get(job.id)!;
        assert.equal(row.agent_role, role);
        assert.ok(['planner', 'developer', 'reviewer'].includes(String(row.agent)));
      }
      assert.equal((await owner('/ai/agents')).body.agents.length, 8);
    });

    await t.test('sensitive build and source calls only persist proposals until the owner approves', async () => {
      twoSteps([buildCall(), sourceCall()]);
      const before = executions.length, job = await submit();
      await runtime.ai.runNext();
      const result = await detail(job.id);
      assert.equal(result.job.status, 'waiting_approval');
      assert.equal(result.toolProposals.length, 2);
      assert.equal(executions.length, before);
      const build = result.toolProposals.find((proposal: any) => proposal.type === 'request_build');
      const source = result.toolProposals.find((proposal: any) => proposal.type === 'propose_source_change');
      assert.equal((await approve(build, outsider)).status, 404);
      assert.equal((await approve(build, developer)).status, 403);
      assert.equal((await approve(build, owner, build.version + 1)).status, 409);
      assert.equal(executions.length, before);
      const approved = await approve(build);
      assert.equal(approved.status, 200);
      assert.equal(approved.body.proposal.status, 'approved');
      assert.equal(executions.length, before + 1);
      assert.equal(executions.at(-1)!.actorId, ownerId);
      assert.equal(executions.at(-1)!.action.id, build.id);
      assert.equal(executions.at(-1)!.action.projectId, projectId);
      assert.deepEqual(executions.at(-1)!.action.arguments.files, sourceFiles);
      assert.equal((await approve(build)).status, 409);
      const rejected = await owner('/ai/tool-proposals/' + source.id + '/reject', 'POST', { version: source.version, reason: 'Keep this source change out of the repository.' });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.proposal.status, 'rejected');
      assert.equal((await detail(job.id)).job.status, 'completed');
      assert.equal(executions.length, before + 1);
    });

    await t.test('concurrent approval invokes the trusted callback only once', async () => {
      twoSteps([buildCall()]);
      const job = await submit(); await runtime.ai.runNext();
      const proposal = (await detail(job.id)).toolProposals[0];
      const original = execute;
      let unblock: (() => void) | undefined;
      execute = async (action, actorId) => {
        executions.push({ action, actorId });
        await new Promise<void>(resolve => { unblock = resolve; });
        return { acceptedProposalId: action.id };
      };
      try {
        const first = approve(proposal);
        for (let attempt = 0; !unblock && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(unblock, 'First callback must be in progress.');
        assert.equal((await approve(proposal)).status, 409);
        unblock();
        assert.equal((await first).status, 200);
        assert.equal(executions.filter(value => value.action.id === proposal.id).length, 1);
      } finally { unblock?.(); execute = original; }
    });

    await t.test('changed payload, locked project and cancelled parent cannot execute a pending action', async () => {
      twoSteps([buildCall()]);
      const job = await submit(); await runtime.ai.runNext();
      const proposal = (await detail(job.id)).toolProposals[0], before = executions.length;
      const stored = runtime.db.prepare('SELECT arguments_json FROM ai_tool_proposals WHERE id=?').get(proposal.id)!;
      runtime.db.prepare('UPDATE ai_tool_proposals SET arguments_json=? WHERE id=?').run(JSON.stringify({ version: 'tampered', files: sourceFiles }), proposal.id);
      assert.equal((await approve(proposal)).status, 409);
      runtime.db.prepare('UPDATE ai_tool_proposals SET arguments_json=? WHERE id=?').run(stored.arguments_json!, proposal.id);
      assert.equal((await owner(`/projects/${projectId}/lock`, 'POST', { locked: true })).status, 200);
      assert.equal((await approve(proposal)).status, 403);
      assert.equal((await owner(`/projects/${projectId}/lock`, 'POST', { locked: false })).status, 200);
      assert.equal((await owner('/ai/jobs/' + job.id + '/cancel', 'POST', {})).status, 200);
      assert.equal((await approve(proposal)).status, 409);
      assert.equal(executions.length, before);
    });

    await t.test('revoking the originating developer prevents later owner approval', async () => {
      twoSteps([buildCall()]);
      const job = await submit({}, developer); await runtime.ai.runNext();
      const proposal = (await detail(job.id)).toolProposals[0], before = executions.length;
      const sourceStream = await developer.stream('/ai/jobs/' + job.id + '/events');
      assert.equal(sourceStream.status, 200);
      const reader = sourceStream.body!.getReader();
      assert.equal((await reader.read()).done, false, 'The authorized source stream must publish its initial job state.');
      assert.equal((await owner(`/projects/${projectId}/members/${developerId}`, 'PATCH', { role: 'viewer' })).status, 200);
      try {
        let ended = false;
        while (!ended) ended = (await reader.read()).done;
        assert.equal(ended, true, 'Role downgrade must terminate an already open source-bearing SSE stream.');
        assert.equal((await developer('/ai/jobs/' + job.id)).status, 404);
        assert.equal((await developer(`/ai/projects/${projectId}/jobs`)).status, 403);
        assert.equal((await developer('/ai/jobs/' + job.id + '/events')).status, 404);
        assert.equal((await approve(proposal)).status, 403);
        assert.equal((await owner(`/projects/${projectId}/members/${developerId}`, 'PATCH', { role: 'customer' })).status, 200);
        assert.equal((await developer('/ai/jobs/' + job.id)).status, 404);
        assert.equal((await developer(`/ai/projects/${projectId}/jobs`)).status, 403);
        assert.equal(executions.length, before);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        assert.equal((await owner(`/projects/${projectId}/members/${developerId}`, 'PATCH', { role: 'developer' })).status, 200);
      }
    });

    await t.test('invalid paths and tools without consent never create executable proposals', async () => {
      const invalid = makeCall('request_build', { version: 'bad', files: { '../index.html': 'no', 'index.html': '<!doctype html>' } });
      twoSteps([invalid]);
      const job = await submit(); await runtime.ai.runNext();
      const result = await detail(job.id);
      assert.equal(result.toolProposals.length, 0);
      assert.equal(result.toolCalls[0].status, 'failed');
      assert.equal(result.toolCalls[0].error, 'INVALID_TOOL_ARGUMENTS');
      behavior = async () => ({ text: '', toolCalls: [buildCall()], inputTokens: 1, outputTokens: 1 });
      const withoutConsent = await submit({ toolsEnabled: false }); await runtime.ai.runNext();
      assert.equal((await detail(withoutConsent.id)).job.status, 'failed');
      assert.equal((await detail(withoutConsent.id)).toolProposals.length, 0);
      behavior = async () => ({ text: '', toolCalls: [makeCall('run_shell', { command: 'touch /tmp/never-executed' })], inputTokens: 1, outputTokens: 1 });
      const unknown = await submit(); await runtime.ai.runNext();
      assert.equal((await detail(unknown.id)).job.errorCode, 'UNKNOWN_TOOL');
      assert.equal((await detail(unknown.id)).toolProposals.length, 0);
    });

    await t.test('reservations account for complete tool exchanges before concurrent submissions', async () => {
      const limited = (await owner('/projects', 'POST', { name: 'Concurrent tool budget' })).body.project.id;
      assert.equal((await owner(`/ai/projects/${limited}/budget`, 'PUT', { ...policy, tokenLimit: 200000 })).status, 200);
      const before = providerCalls;
      const submitted = await Promise.all(['one', 'two'].map(key => owner(`/ai/projects/${limited}/jobs`, 'POST', { prompt: 'Read the task list only.', agent: 'developer', provider: 'openai', model: 'tools-fixture-model', toolsEnabled: true, idempotencyKey: `tool-budget-${key}` })));
      assert.equal(submitted.filter(result => result.status === 201).length, 1);
      assert.equal(submitted.filter(result => result.body.code === 'BUDGET_EXCEEDED').length, 1);
      assert.equal(providerCalls, before);
      const budget = (await owner(`/ai/projects/${limited}/budget`)).body.budget;
      assert.ok(budget.reservedTokens > 100000 && budget.reservedTokens <= 200000);
      for (const result of submitted.filter(item => item.status === 201)) assert.equal((await owner('/ai/jobs/' + result.body.job.id + '/cancel', 'POST', {})).status, 200);
      assert.equal((await owner(`/ai/projects/${limited}/budget`)).body.budget.reservedTokens, 0);
    });

    await t.test('a rejected later provider round preserves already reported billable usage', async () => {
      let step = 0;
      behavior = async () => {
        if (++step === 1) return { text: '', toolCalls: [makeCall('read_project')], inputTokens: 12, outputTokens: 4 };
        throw new ProviderError('PROVIDER_REJECTED', 'Fixture second-round rejection.', undefined, true);
      };
      const job = await submit(); await runtime.ai.runNext();
      assert.equal((await detail(job.id)).job.status, 'failed');
      const usage = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!;
      assert.equal(usage.input_tokens, 12); assert.equal(usage.output_tokens, 4);
      assert.equal(usage.charged_tokens, 16); assert.equal(usage.usage_source, 'provider');
      assert.equal(usage.cost_source, 'provider_usage_estimate');
      assert.equal(step, 2); assert.equal(await runtime.ai.runNext(), false);
    });

    await t.test('uncertain later rounds conservatively settle reservations without retrying charged tools', async () => {
      let step = 0;
      behavior = async () => {
        if (++step === 1) return { text: '', toolCalls: [makeCall('read_tasks')], inputTokens: 12, outputTokens: 4 };
        throw new Error('Fixture interrupted network after a charged first round.');
      };
      const job = await submit(); await runtime.ai.runNext();
      const current = await detail(job.id);
      assert.equal(current.job.status, 'failed'); assert.equal(current.job.attempts, 1);
      const usage = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!;
      assert.equal(usage.usage_source, 'unreported'); assert.equal(usage.charged_tokens, job.reservedTokens);
      assert.equal(usage.cost_source, 'reservation_upper_bound');
      assert.equal(step, 2); assert.equal(await runtime.ai.runNext(), false);
    });

    await t.test('the third tool-only turn is refused and all known usage remains charged once', async () => {
      let rounds = 0;
      behavior = async () => { rounds++; return { text: '', toolCalls: [makeCall('read_project')], inputTokens: 12, outputTokens: 4 }; };
      const job = await submit(); await runtime.ai.runNext();
      const current = await detail(job.id);
      assert.equal(rounds, 3);
      assert.equal(current.job.status, 'failed'); assert.equal(current.job.errorCode, 'TOOL_TURN_LIMIT');
      assert.equal(current.toolCalls.length, 2, 'The final over-limit tool is never executed.');
      assert.equal(current.toolProposals.length, 0);
      const usage = runtime.db.prepare('SELECT * FROM ai_token_usage WHERE job_id=?').get(job.id)!;
      assert.equal(usage.input_tokens, 36); assert.equal(usage.output_tokens, 12);
      assert.equal(usage.charged_tokens, 48); assert.equal(usage.usage_source, 'provider');
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage WHERE job_id=?').get(job.id)!.n, 1);
      assert.equal(await runtime.ai.runNext(), false);
    });

    await t.test('failed trusted actions become uncertain and are never automatically replayed after restart', async () => {
      twoSteps([sourceCall()]);
      const job = await submit(); await runtime.ai.runNext();
      const proposal = (await detail(job.id)).toolProposals[0], original = execute;
      execute = async () => { throw new Error('Fixture external outcome unknown.'); };
      try {
        const result = await approve(proposal);
        assert.equal(result.status, 502); assert.equal(result.body.code, 'TOOL_ACTION_UNCERTAIN');
        assert.equal((await detail(job.id)).toolProposals[0].status, 'uncertain');
        const before = executions.length;
        await stop(); await start();
        assert.equal((await detail(job.id)).toolProposals[0].status, 'uncertain');
        assert.equal((await approve((await detail(job.id)).toolProposals[0])).status, 409);
        assert.equal(executions.length, before);
      } finally { execute = original; }
    });
  } finally {
    if (server?.listening) await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('migration eight preserves populated schema-seven jobs and accounting', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-ai-v7-migration-'));
  const path = join(dataDir, 'pixel-world.sqlite');
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('PRAGMA foreign_keys=ON;');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => /^00[1-7]_.*\.sql$/.test(name)).sort()) legacy.exec(await readFile(new URL(file, migrations), 'utf8'));
    const user = randomUUID(), project = randomUUID(), job = randomUUID(), created = new Date().toISOString();
    legacy.prepare('INSERT INTO users(id,email,name,password_hash,roles,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(user, 'legacy@example.test', 'Legacy user', 'not-used-for-login', '["member"]', created, created);
    legacy.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(project, user, 'Preserved project', created, created);
    legacy.prepare('INSERT INTO project_members VALUES(?,?,?,?)').run(project, user, 'owner', created);
    legacy.prepare('INSERT INTO ai_jobs(id,project_id,user_id,agent,provider,model,prompt,system_prompt,idempotency_key,status,reserved_tokens,reserved_cost_usd,max_output_tokens,input_rate,output_rate,output,settled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(job, project, user, 'developer', 'openai', 'legacy-model', 'Existing prompt', 'Existing system', 'existing-job', 'completed', 100, .01, 32, 2, 4, 'Preserved model output', 1, created, created);
    legacy.prepare('INSERT INTO ai_token_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), job, project, user, 'openai', 'legacy-model', 'developer', 12, 4, 'provider', 16, .00004, 'provider_usage_estimate', created);
    legacy.close();
    const runtime = createApp({ dataDir, ai: { workerEnabled: false } });
    try {
      const row = runtime.db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(job)!;
      assert.equal(row.output, 'Preserved model output'); assert.equal(row.status, 'completed');
      assert.equal(row.tools_enabled, 0); assert.equal(row.agent_role, null); assert.equal(row.agent, 'developer');
      assert.equal(runtime.db.prepare('SELECT charged_tokens FROM ai_token_usage WHERE job_id=?').get(job)!.charged_tokens, 16);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_tool_calls').get()!.n, 0);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM ai_tool_proposals').get()!.n, 0);
      assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(runtime.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { runtime.close(); }
  } finally {
    try { legacy.close(); } catch { /* already closed before reopening the application */ }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('default approved AI build bridge executes a real isolated Docker test and immutable artifact', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-ai-approved-docker-'));
  const files = { ...sourceFiles, 'game.test.js': "const assert = require('node:assert/strict'); assert.equal(2+2, 4); console.log('APPROVED_AI_DOCKER_TEST_OK');" };
  let rounds = 0;
  const provider: AIProvider = { configured: true, generate: async request => {
    assert.ok(request.tools?.some(tool => tool.name === 'request_build'));
    if (++rounds === 1) return { text: '', toolCalls: [makeCall('request_build', { version: 'approved-ai-1.0', files })], inputTokens: 12, outputTokens: 4 };
    return { text: 'The build has only been proposed; the project owner must approve execution.', inputTokens: 8, outputTokens: 5 };
  } };
  const runtime = createApp({ dataDir, allowFirstAdmin: true,
    ai: { providers: { openai: provider }, workerEnabled: false },
    integrations: { runnerEnabled: true },
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0];
    return { status: response.status, body: await response.json() as any };
  }
  try {
    assert.equal((await request('/auth/register', 'POST', { name: 'Actual tool build owner', email: 'actual-tool-owner@example.test', password: 'Actual-tool-build-2026!' })).status, 201);
    const project = (await request('/projects', 'POST', { name: 'Actual approved build' })).body.project;
    assert.equal((await request('/ai/pricing', 'POST', { provider: 'openai', model: 'fixture-model', inputUsdPerMillion: 1, outputUsdPerMillion: 1, effectiveAt: '2026-01-01T00:00:00Z' })).status, 201);
    assert.equal((await request(`/ai/projects/${project.id}/budget`, 'PUT', { tokenLimit: 1_000_000, costLimitUsd: 10, jobLimit: 10, maxConcurrent: 1, maxOutputTokens: 100 })).status, 200);
    const submission = await request(`/ai/projects/${project.id}/jobs`, 'POST', { prompt: 'Propose this small static bundle for approval.', agent: 'build_engineer', provider: 'openai', model: 'fixture-model', toolsEnabled: true, idempotencyKey: 'actual-approved-docker-job' });
    assert.equal(submission.status, 201);
    await runtime.ai.runNext();
    const detail = (await request('/ai/jobs/' + submission.body.job.id)).body;
    assert.equal(detail.job.status, 'waiting_approval'); assert.equal(detail.toolProposals.length, 1);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM build_jobs').get()!.n, 0, 'No execution occurs during a model proposal.');
    const proposal = detail.toolProposals[0];
    const approval = await request('/ai/tool-proposals/' + proposal.id + '/approve', 'POST', { version: proposal.version });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(approval.body.proposal.status, 'approved');
    const buildId = approval.body.proposal.result.build.id;
    let build: any;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      build = (await request(`/projects/${project.id}/builds/${buildId}`)).body.build;
      if (['succeeded', 'failed', 'cancelled'].includes(build.status)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(build.status, 'succeeded', build.logs);
    assert.equal(build.exitCode, 0);
    assert.match(build.logs, /APPROVED_AI_DOCKER_TEST_OK/);
    assert.match(build.logs, /executed 1 test file/);
    const row = runtime.db.prepare('SELECT * FROM build_jobs WHERE id=?').get(buildId)!;
    assert.equal(row.tool_action_id, proposal.id);
    assert.deepEqual(JSON.parse(String(row.files_json)), files);
    const artifact = await readFile(String(row.artifact_path));
    assert.equal(artifact.readUInt32LE(0), 0x04034b50);
    assert.equal(artifact.length, build.artifact.size);
    assert.equal(createHash('sha256').update(artifact).digest('hex'), build.artifact.sha256);
    assert.equal((await request('/ai/tool-proposals/' + proposal.id + '/approve', 'POST', { version: proposal.version })).status, 409);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM build_jobs WHERE tool_action_id=?').get(proposal.id)!.n, 1);
  } finally {
    runtime.stopServices();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
