import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';

test('build authorization permits tester cancellation of own work and rejects viewer or locked writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-build-permissions-'));
  const runtime = createApp({dataDir: directory, integrations: {
    autoRun: false,
    runBuild: async () => { throw new Error('Policy test must not execute a build.'); },
  }});
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, {method, headers: {
        ...(cookie ? {Cookie: cookie} : {}),
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      }, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      const session = response.headers.getSetCookie()[0];
      if (session) cookie = session.split(';')[0];
      return {status: response.status, body: await response.json()};
    };
  }
  const owner = client(), tester = client(), viewer = client();
  try {
    await owner('/auth/register', 'POST', {name: 'Build owner', email: 'owner@example.test', password: 'Correct-password-2026!'});
    const testAccount = await tester('/auth/register', 'POST', {name: 'Build tester', email: 'tester@example.test', password: 'Correct-password-2026!'});
    await viewer('/auth/register', 'POST', {name: 'Build viewer', email: 'viewer@example.test', password: 'Correct-password-2026!'});
    const project = (await owner('/projects', 'POST', {name: 'Build permissions'})).body.project;
    for (const [role, person] of [['tester', tester], ['viewer', viewer]] as const) {
      const invitation = await owner(`/projects/${project.id}/invitations`, 'POST', {email: `${role}@example.test`, role});
      assert.equal(invitation.status, 201);
      assert.equal((await person(`/invitations/${invitation.body.invitation.id}/accept`, 'POST')).status, 200);
    }
    const source = {target: 'web', version: '1.0', files: {'index.html': '<!doctype html><title>Real source</title>'}};
    const build = await tester(`/projects/${project.id}/builds`, 'POST', source);
    assert.equal(build.status, 202);
    assert.equal(build.body.build.authorId, testAccount.body.user.id);
    assert.equal((await viewer(`/projects/${project.id}/builds/${build.body.build.id}/cancel`, 'POST')).status, 403);
    const cancelled = await tester(`/projects/${project.id}/builds/${build.body.build.id}/cancel`, 'POST');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.build.status, 'cancelled');
    const next = await tester(`/projects/${project.id}/builds`, 'POST', {...source, version: '1.1'});
    assert.equal(next.status, 202);
    await owner(`/projects/${project.id}/lock`, 'POST', {locked: true});
    assert.equal((await tester(`/projects/${project.id}/builds/${next.body.build.id}/cancel`, 'POST')).status, 403);
    assert.equal((await owner(`/projects/${project.id}/builds/${next.body.build.id}/cancel`, 'POST')).status, 200);
    assert.equal((await tester(`/projects/${project.id}/builds`, 'POST', {...source, version: '1.2'})).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
