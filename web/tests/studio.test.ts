import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';

test('Studio requests create durable, private project work atomically', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-studio-test-'));
  let runtime: ReturnType<typeof createApp>;
  let server: Server;
  let baseUrl = '';
  let databaseOpen = false;

  async function start() {
    runtime = createApp({ dataDir });
    databaseOpen = true;
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (databaseOpen) {
      runtime.close();
      databaseOpen = false;
    }
  }

  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0];
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
  }

  function counts() {
    return Object.fromEntries(['projects', 'project_members', 'tasks', 'customer_requests', 'activity'].map((table) => [table, runtime.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));
  }

  const owner = client(), other = client(), guest = client();
  let ownerId = '', requestId = '', projectId = '', taskId = '';
  const questionnaire = {
    name: 'Khu vườn của những giấc mơ',
    description: 'Một trò chơi khám phá và chăm sóc khu vườn Pixel dành cho cộng đồng.',
    productType: 'game',
    platform: 'Web và Android',
    features: 'Trồng cây, lưu tiến độ, giao tiếp với nhân vật trong làng.',
    acceptanceCriteria: 'Có thể trồng cây, tải lại và nhìn thấy tiến độ đã được lưu.',
    priority: 'high',
  };

  try {
    await start();
    const account = await owner('/auth/register', 'POST', { name: 'Khách hàng Pixel', email: 'studio-owner@example.test', password: 'Studio-owner-password-42!' });
    assert.equal(account.status, 201);
    ownerId = account.body.user.id;
    assert.equal((await other('/auth/register', 'POST', { name: 'Khách hàng khác', email: 'studio-other@example.test', password: 'Studio-other-password-42!' })).status, 201);

    await t.test('sign-in is required to submit or list Studio requests', async () => {
      const before = counts();
      assert.equal((await guest('/studio/requests', 'POST', questionnaire)).status, 401);
      assert.equal((await guest('/studio/requests')).status, 401);
      assert.deepEqual(counts(), before);
    });

    await t.test('invalid questionnaires cannot create partial project data', async () => {
      const before = counts();
      const result = await owner('/studio/requests', 'POST', { ...questionnaire, name: '', productType: 'unsupported-executable' });
      assert.equal(result.status, 400);
      assert.ok(result.body.error);
      assert.deepEqual(counts(), before);
      assert.deepEqual((await owner('/studio/requests')).body.requests, []);
    });

    await t.test('submission connects the complete questionnaire, owner, project and request task', async () => {
      const before = counts();
      const result = await owner('/studio/requests', 'POST', questionnaire);
      assert.equal(result.status, 201);
      const request = result.body.request;
      requestId = request.id;
      projectId = request.projectId;
      taskId = request.taskId;
      assert.ok(requestId && projectId && taskId);
      for (const [field, value] of Object.entries(questionnaire)) assert.equal(request[field], value);
      assert.equal(request.status, 'awaiting_provider');
      assert.ok(!Number.isNaN(Date.parse(request.createdAt)));
      assert.equal(result.body.project.id, projectId);
      assert.equal(result.body.project.visibility, 'private');
      assert.equal(result.body.project.status, 'planning');
      const detail = await owner(`/projects/${projectId}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.members.some((member: any) => member.userId === ownerId && member.role === 'owner'));
      const task = detail.body.tasks.find((item: any) => item.id === taskId);
      assert.ok(task);
      assert.equal(task.type, 'request');
      assert.equal(task.status, 'todo');
      assert.equal(task.priority, 'high');
      assert.equal(task.createdBy, ownerId);
      const after = counts();
      assert.equal(Number(after.projects), Number(before.projects) + 1);
      assert.equal(Number(after.project_members), Number(before.project_members) + 1);
      assert.equal(Number(after.tasks), Number(before.tasks) + 1);
      assert.equal(Number(after.customer_requests), Number(before.customer_requests) + 1);
      const remove = await owner(`/projects/${projectId}/tasks/${taskId}`, 'DELETE');
      assert.equal(remove.status, 409);
      assert.equal(remove.body.code, 'REQUEST_HISTORY');
      assert.ok((await owner(`/projects/${projectId}`)).body.tasks.some((item: any) => item.id === taskId));
    });

    await t.test('another account cannot list requests or read the resulting private project', async () => {
      const ownRequests = await owner('/studio/requests');
      assert.equal(ownRequests.status, 200);
      assert.equal(ownRequests.body.requests.length, 1);
      assert.equal(ownRequests.body.requests[0].id, requestId);
      assert.deepEqual((await other('/studio/requests')).body.requests, []);
      assert.equal((await other(`/projects/${projectId}`)).status, 404);
      assert.ok(!(await other('/projects')).body.projects.some((project: any) => project.id === projectId));
    });

    await t.test('a failed task insertion rolls back every part of request submission', async () => {
      const before = counts();
      runtime.db.exec("CREATE TRIGGER reject_test_studio_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END;");
      try {
        const result = await owner('/studio/requests', 'POST', { ...questionnaire, name: 'Yêu cầu phải được rollback' });
        assert.equal(result.status, 500);
        assert.ok(result.body.error);
        assert.deepEqual(counts(), before);
        assert.equal((await owner('/studio/requests')).body.requests.length, 1);
      } finally {
        runtime.db.exec('DROP TRIGGER IF EXISTS reject_test_studio_task;');
      }
    });

    await t.test('questionnaire and relations survive restart without recording fictional AI jobs', async () => {
      const before = counts();
      await stop();
      await start();
      assert.deepEqual(counts(), before);
      const requests = await owner('/studio/requests');
      assert.equal(requests.status, 200);
      const request = requests.body.requests.find((item: any) => item.id === requestId);
      assert.ok(request);
      for (const [field, value] of Object.entries(questionnaire)) assert.equal(request[field], value);
      assert.equal(request.projectId, projectId);
      assert.equal(request.taskId, taskId);
      assert.equal(request.status, 'awaiting_provider');
      const detail = await owner(`/projects/${projectId}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.tasks.some((task: any) => task.id === taskId));
      assert.equal((await other(`/projects/${projectId}`)).status, 404);
      const usage = (await owner('/usage')).body;
      assert.equal(usage.jobs, 0);
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.outputTokens, 0);
      assert.equal(usage.estimatedCost, 0);
      assert.equal((await owner('/integrations')).body.ai.connected, false);
    });
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
