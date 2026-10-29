import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

type Client = ReturnType<typeof client>;

test('Phase 3 migration preserves populated v2 projects, members, invitations and foreign keys', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-project-v2-migration-'));
  const original = new DatabaseSync(join(dataDir, 'pixel-world.sqlite'));
  const userId = randomUUID(), projectId = randomUUID(), invitationId = randomUUID(), taskId = randomUUID();
  const at = new Date().toISOString();
  try {
    original.exec('PRAGMA foreign_keys=ON');
    original.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    original.exec(await readFile(new URL('../migrations/002_studio_requests.sql', import.meta.url), 'utf8'));
    original.prepare('INSERT INTO users(id,email,name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(userId, 'preserved@planning.test', 'Existing owner', 'existing-hash-never-logged-in', at, at);
    original.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, userId, 'Existing populated project', at, at);
    original.prepare('INSERT INTO project_members VALUES(?,?,?,?)').run(projectId, userId, 'owner', at);
    original.prepare('INSERT INTO invitations(id,project_id,email,role,inviter_id,created_at) VALUES(?,?,?,?,?,?)').run(invitationId, projectId, 'invited@planning.test', 'developer', userId, at);
    original.prepare('INSERT INTO tasks(id,project_id,title,assignee_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(taskId, projectId, 'Existing assigned task', userId, userId, at, at);
  } finally { original.close(); }
  try {
    let migrated = openDatabase(dataDir);
    try {
      assert.equal(migrated.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, userId)!.role, 'owner');
      assert.equal(migrated.prepare('SELECT role FROM invitations WHERE id=?').get(invitationId)!.role, 'developer');
      assert.equal(migrated.prepare('SELECT assignee_id FROM tasks WHERE id=?').get(taskId)!.assignee_id, userId);
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
      migrated.prepare("UPDATE invitations SET role='reviewer' WHERE id=?").run(invitationId);
    } finally { migrated.close(); }
    migrated = openDatabase(dataDir);
    try {
      assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=5').get()!.n, 1);
      assert.equal(migrated.prepare('SELECT role FROM invitations WHERE id=?').get(invitationId)!.role, 'reviewer');
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
function client(base: () => string) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(base() + '/api' + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0];
      return { status: response.status, body: await response.json() };
    },
  };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-project-planning-'));
  const runtime = createApp({ dataDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const owner = client(() => base), developer = client(() => base), viewer = client(() => base), customer = client(() => base), reviewer = client(() => base), outsider = client(() => base);
  const users: Record<string, string> = {};
  for (const [name, api] of Object.entries({ owner, developer, viewer, customer, reviewer, outsider })) {
    const response = await api.request('/auth/register', 'POST', { name: name + ' User', email: `${name}@planning.test`, password: 'Secure-Planning-Password42!' });
    assert.equal(response.status, 201, JSON.stringify(response.body)); users[name] = response.body.user.id;
  }
  const response = await owner.request('/projects', 'POST', { name: 'Real planning project', description: 'Persistent project planning with access controls.' });
  assert.equal(response.status, 201); const projectId: string = response.body.project.id;
  async function joinMember(api: Client, role: string, name: string) {
    const invited = await owner.request(`/projects/${projectId}/invitations`, 'POST', { email: `${name}@planning.test`, role });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const accepted = await api.request(`/invitations/${invited.body.invitation.id}/accept`, 'POST', {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  }
  for (const [api, role, name] of [[developer, 'developer', 'developer'], [viewer, 'viewer', 'viewer'], [customer, 'customer', 'customer'], [reviewer, 'reviewer', 'reviewer']] as const) await joinMember(api, role, name);
  async function makeTask(title: string, api: Client = developer) {
    const result = await api.request(`/projects/${projectId}/tasks`, 'POST', { title, description: 'A real task.', type: 'task' });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.task;
  }
  async function close() {
    await runtime.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  return { dataDir, runtime, server, base, owner, developer, viewer, customer, reviewer, outsider, users, projectId, makeTask, close };
}

test('Phase 3: project planning, dependency integrity, review history and lifecycle', async t => {
  const f = await fixture(); const path = `/projects/${f.projectId}`;
  let predecessor: any, successor: any, item: any;
  try {
    await t.test('private planning is hidden, viewer cannot edit and milestone updates detect stale writes', async () => {
      assert.equal((await f.outsider.request(path + '/planning')).status, 404);
      const p = await f.viewer.request(path + '/planning'); assert.equal(p.status, 200); assert.equal(p.body.permissions.editProject, false);
      assert.equal((await f.viewer.request(path + '/milestones', 'POST', { title: 'Forbidden milestone' })).status, 403);
      assert.equal((await f.owner.request(path + '/milestones', 'POST', { title: 'Invalid date', dueDate: '2026-02-31' })).status, 400);
      const created = await f.owner.request(path + '/milestones', 'POST', { title: 'First playable version', description: 'Functional gate', dueDate: '2026-01-01' });
      assert.equal(created.status, 201);
      const m = created.body.milestone;
      assert.equal((await f.owner.request(path + `/milestones/${m.id}`, 'PATCH', { version: m.version, status: 'active' })).status, 200);
      assert.equal((await f.owner.request(path + `/milestones/${m.id}`, 'PATCH', { version: m.version, status: 'done' })).status, 409);
    });
    await t.test('dependencies reject cycles, self references, stale versions and cross-project tasks', async () => {
      predecessor = await f.makeTask('Design the world'); successor = await f.makeTask('Implement the world');
      const added = await f.developer.request(path + `/tasks/${successor.id}/dependencies`, 'POST', { dependsOnId: predecessor.id, version: successor.version });
      assert.equal(added.status, 201, JSON.stringify(added.body)); successor = added.body.task;
      assert.equal((await f.developer.request(path + `/tasks/${predecessor.id}/dependencies`, 'POST', { dependsOnId: successor.id, version: predecessor.version })).status, 409);
      assert.equal((await f.developer.request(path + `/tasks/${predecessor.id}/dependencies`, 'POST', { dependsOnId: predecessor.id, version: predecessor.version })).status, 409);
      const otherProject = (await f.owner.request('/projects', 'POST', { name: 'Different project' })).body.project;
      const otherTask = (await f.owner.request(`/projects/${otherProject.id}/tasks`, 'POST', { title: 'Different task' })).body.task;
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}/dependencies`, 'POST', { dependsOnId: otherTask.id, version: successor.version })).status, 404);
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}/dependencies/${predecessor.id}`, 'DELETE', { version: successor.version - 1 })).status, 409);
      const health = (await f.owner.request(path + '/planning')).body.health;
      assert.ok(health.blockedTaskIds.includes(successor.id));
    });
    await t.test('legacy task completion respects dependency/checklist SQL gates and cannot reopen prerequisites', async () => {
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}`, 'PATCH', { version: successor.version, status: 'done' })).status, 409);
      const ready = await f.developer.request(path + `/tasks/${predecessor.id}`, 'PATCH', { version: predecessor.version, status: 'done' });
      assert.equal(ready.status, 200); predecessor = ready.body.task;
      const checklist = await f.developer.request(path + `/tasks/${successor.id}/checklist`, 'POST', { title: 'Run meaningful tests' });
      assert.equal(checklist.status, 201); item = checklist.body.item;
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}`, 'PATCH', { version: successor.version, status: 'done' })).status, 409);
      const checked = await f.developer.request(path + `/tasks/${successor.id}/checklist/${item.id}`, 'PATCH', { version: item.version, done: true });
      assert.equal(checked.status, 200); item = checked.body.item;
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}/checklist/${item.id}`, 'PATCH', { version: item.version - 1, done: false })).status, 409);
      const done = await f.developer.request(path + `/tasks/${successor.id}`, 'PATCH', { version: successor.version, status: 'done' });
      assert.equal(done.status, 200); successor = done.body.task;
      assert.equal((await f.developer.request(path + `/tasks/${predecessor.id}`, 'PATCH', { version: predecessor.version, status: 'todo' })).status, 409);
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}/checklist/${item.id}`, 'PATCH', { version: item.version, done: false })).status, 409);
    });
    await t.test('immutable version snapshots retain history while project data changes', async () => {
      const created = await f.owner.request(path + '/versions', 'POST', { label: '0.1.0', changelog: 'First completed development slice.' });
      assert.equal(created.status, 201);
      const v = created.body.version;
      assert.equal(v.snapshot.tasks.find((x: any) => x.id === successor.id).title, 'Implement the world');
      assert.equal((await f.developer.request(path + '/versions', 'POST', { label: 'stolen', changelog: 'Forbidden.' })).status, 403);
      assert.equal((await f.owner.request(path + '/versions', 'POST', { label: '0.1.0', changelog: 'Cannot overwrite.' })).status, 409);
      assert.equal((await f.developer.request(path + `/tasks/${successor.id}`, 'PATCH', { version: successor.version, title: 'A later name' })).status, 200);
      const old = await f.owner.request(path + `/versions/${v.id}`);
      assert.equal(old.body.version.snapshot.tasks.find((x: any) => x.id === successor.id).title, 'Implement the world');
    });
    await t.test('customer revision creates a linked task and approval/rejection appends real review history', async () => {
      const created = await f.customer.request(path + '/revisions', 'POST', { title: 'Customer wants a new ending', reason: 'The ending should respect the original acceptance criteria.', sourceTaskId: successor.id, type: 'request', priority: 'high' });
      assert.equal(created.status, 201);
      let task = created.body.task;
      const patch = await f.developer.request(path + `/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'review' }); task = patch.body.task;
      const reject = await f.reviewer.request(path + '/reviews', 'POST', { taskId: task.id, version: task.version, decision: 'reject', comment: 'One acceptance criterion remains unsatisfied.' });
      assert.equal(reject.status, 201); assert.equal(reject.body.task.status, 'in_progress'); task = reject.body.task;
      const resubmit = await f.developer.request(path + `/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'review' }); task = resubmit.body.task;
      assert.equal((await f.viewer.request(path + '/reviews', 'POST', { taskId: task.id, version: task.version, decision: 'approve', comment: 'Forbidden.' })).status, 403);
      const accepted = await f.customer.request(path + '/reviews', 'POST', { taskId: task.id, version: task.version, decision: 'approve', comment: 'The revision meets my acceptance criteria.' });
      assert.equal(accepted.status, 201); assert.equal(accepted.body.task.status, 'done');
      assert.equal((await f.customer.request(path + '/reviews', 'POST', { taskId: task.id, version: accepted.body.task.version, decision: 'approve', comment: 'Cannot approve twice.' })).status, 409);
      const state = (await f.owner.request(path + '/planning')).body;
      assert.ok(state.revisions.some((r: any) => r.taskId === task.id));
      assert.equal(state.reviews.filter((r: any) => r.taskId === task.id).length, 2);
    });
    await t.test('trash is owner scoped and restore preserves milestone/version history', async () => {
      assert.equal((await f.owner.request(path, 'DELETE')).status, 200);
      assert.ok((await f.owner.request('/projects-trash')).body.projects.some((p: any) => p.id === f.projectId));
      assert.ok(!(await f.outsider.request('/projects-trash')).body.projects.some((p: any) => p.id === f.projectId));
      assert.equal((await f.owner.request(path + '/planning')).status, 404);
      assert.equal((await f.owner.request(path + '/restore', 'POST', {})).status, 200);
      const restored = (await f.owner.request(path + '/planning')).body;
      assert.equal(restored.versions.length, 1); assert.equal(restored.milestones.length, 1);
    });
    await t.test('cloning remaps the full planning graph and resets progress without copying access or history', async () => {
      const original = (await f.owner.request(path)).body;
      const sourceTask = original.tasks.find((t: any) => t.id === predecessor.id);
      assert.equal((await f.owner.request(path + `/tasks/${sourceTask.id}`, 'PATCH', { version: sourceTask.version, assigneeId: f.users.developer })).status, 200);
      const copied = await f.developer.request(path + '/duplicate', 'POST', {});
      assert.equal(copied.status, 201, JSON.stringify(copied.body));
      const clone = copied.body.project, clonePath = `/projects/${clone.id}`;
      assert.notEqual(clone.id, f.projectId); assert.equal(clone.ownerId, f.users.developer);
      assert.equal(clone.visibility, 'private'); assert.equal(clone.locked, false); assert.equal(clone.status, 'planning'); assert.equal(clone.progress, 0);
      const detail = (await f.developer.request(clonePath)).body;
      assert.equal(detail.members.length, 1); assert.equal(detail.members[0].id, f.users.developer);
      assert.equal((await f.owner.request(clonePath)).status, 404);
      assert.equal(detail.tasks.length, original.tasks.length);
      for (const item of detail.tasks) {
        assert.ok(!original.tasks.some((source: any) => source.id === item.id));
        assert.equal(item.status, 'todo'); assert.equal(item.assigneeId, null); assert.equal(item.version, 1);
      }
      const plan = (await f.developer.request(clonePath + '/planning')).body;
      const taskIds = new Set(detail.tasks.map((item: any) => item.id));
      assert.equal(plan.dependencies.length, 1);
      for (const dependency of plan.dependencies) {
        assert.ok(taskIds.has(dependency.taskId)); assert.ok(taskIds.has(dependency.dependsOnId));
      }
      assert.equal(plan.checklists.length, 1); assert.equal(plan.checklists[0].done, false);
      assert.ok(taskIds.has(plan.checklists[0].taskId));
      assert.equal(plan.milestones.length, 1); assert.equal(plan.milestones[0].status, 'planned');
      assert.equal(plan.versions.length, 0); assert.equal(plan.reviews.length, 0); assert.equal(plan.revisions.length, 0);
      assert.deepEqual(f.runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    await t.test('permanent deletion requires ownership, exact confirmation and the retention policy', async () => {
      const created = (await f.owner.request('/projects', 'POST', { name: 'Disposable project' })).body.project;
      const url = `/projects/${created.id}`;
      await f.owner.request(url + '/milestones', 'POST', { title: 'A disposable milestone' });
      await f.owner.request(url + '/tasks', 'POST', { title: 'A disposable task' });
      assert.equal((await f.owner.request(url, 'DELETE')).status, 200);
      const trashed = (await f.owner.request('/projects-trash')).body.projects.find((p: any) => p.id === created.id);
      const body = { version: trashed.version, confirmation: created.name, confirmPermanent: true };
      assert.equal((await f.outsider.request(url + '/permanent', 'DELETE', body)).status, 404);
      assert.equal((await f.owner.request(url + '/permanent', 'DELETE', { ...body, confirmation: 'Wrong name' })).status, 400);
      assert.equal((await f.owner.request(url + '/permanent', 'DELETE', body)).body.code, 'RETENTION_POLICY');
      f.runtime.db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), created.id);
      assert.equal((await f.owner.request(url + '/permanent', 'DELETE', body)).status, 200);
      assert.equal(f.runtime.db.prepare('SELECT 1 FROM projects WHERE id=?').get(created.id), undefined);
      assert.equal(f.runtime.db.prepare('SELECT 1 FROM tasks WHERE project_id=?').get(created.id), undefined);
      assert.deepEqual(f.runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.ok(f.runtime.db.prepare("SELECT 1 FROM activity WHERE action='project.permanently_deleted' AND detail=?").get(created.id));
      const request = (await f.owner.request('/studio/requests', 'POST', { name: 'Retained customer history', description: 'This real request must not be removed by project purge.', productType: 'game' })).body;
      assert.ok(request.project.id);
      await f.owner.request(`/projects/${request.project.id}`, 'DELETE');
      const retained = (await f.owner.request('/projects-trash')).body.projects.find((p: any) => p.id === request.project.id);
      f.runtime.db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), retained.id);
      const denied = await f.owner.request(`/projects/${retained.id}/permanent`, 'DELETE', { version: retained.version, confirmation: retained.name, confirmPermanent: true });
      assert.equal(denied.status, 409); assert.equal(denied.body.code, 'RETENTION_POLICY');
      assert.ok(f.runtime.db.prepare('SELECT 1 FROM customer_requests WHERE project_id=?').get(retained.id));
    });
  } finally { await f.close(); }
});

async function eventReader(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body!.getReader(); let buffer = '';
  return {
    async next(name: string) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const chunk = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
          if (chunk.includes(`event: ${name}\n`)) return JSON.parse(chunk.split('\ndata: ')[1]);
          continue;
        }
        const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE event timeout')), 6000).unref())]);
        if (result.done) throw new Error('SSE closed before expected event ' + name);
        buffer += new TextDecoder().decode(result.value);
      }
      throw new Error('SSE event not received: ' + name);
    },
    close() { return reader.cancel(); },
  };
}

test('Phase 4: member-only collaboration and authorized real-time updates', async t => {
  const f = await fixture(); const path = `/projects/${f.projectId}`;
  const item = await f.makeTask('Discuss the real implementation');
  try {
    await t.test('task comments validate mentions and notify only actual members', async () => {
      assert.equal((await f.outsider.request(path + `/tasks/${item.id}/comments`)).status, 404);
      assert.equal((await f.viewer.request(path + `/tasks/${item.id}/comments`, 'POST', { body: 'Cannot comment.' })).status, 403);
      assert.equal((await f.developer.request(path + `/tasks/${item.id}/comments`, 'POST', { body: 'Cannot mention outside project.', mentionUserIds: [f.users.outsider] })).status, 400);
      const posted = await f.developer.request(path + `/tasks/${item.id}/comments`, 'POST', { body: 'Please review the implementation.', mentionUserIds: [f.users.owner, f.users.owner] });
      assert.equal(posted.status, 201);
      assert.deepEqual(posted.body.comment.mentionUserIds, [f.users.owner]);
      assert.equal((await f.customer.request(path + `/tasks/${item.id}/comments`)).body.comments.length, 1);
      const notifications = (await f.owner.request('/notifications')).body.notifications.filter((n: any) => n.type === 'mention');
      assert.equal(notifications.length, 1);
    });
    await t.test('locks stop milestone, checklist, comments and revisions without changing visibility', async () => {
      assert.equal((await f.owner.request(path + '/lock', 'POST', { locked: true })).status, 200);
      for (const [url, body] of [
        [path + `/tasks/${item.id}/checklist`, { title: 'Forbidden checklist' }],
        [path + `/tasks/${item.id}/comments`, { body: 'Forbidden while locked.' }],
        [path + '/revisions', { title: 'Forbidden revision', reason: 'Cannot mutate a locked project.' }],
      ] as const) assert.equal((await f.developer.request(url, 'POST', body)).status, 403);
      const planning = await f.owner.request(path + '/planning'); assert.equal(planning.body.permissions.comment, true);
      assert.equal((await f.customer.request(path + '/planning')).status, 200);
      assert.equal((await f.owner.request(path + '/lock', 'POST', { locked: false })).status, 200);
    });
    await t.test('project SSE publishes changes and terminates immediately after membership revocation', async () => {
      const outsider = await fetch(f.base + '/api' + path + '/events', { headers: { Cookie: f.outsider.cookie } });
      assert.equal(outsider.status, 404);
      const project = (await f.owner.request(path)).body.project;
      assert.equal((await f.owner.request(path, 'PATCH', { version: project.version, visibility: 'public' })).status, 200);
      assert.equal((await fetch(f.base + '/api' + path + '/events', { headers: { Cookie: f.outsider.cookie } })).status, 403);
      const events = await eventReader(await fetch(f.base + '/api' + path + '/events', { headers: { Cookie: f.developer.cookie } }));
      try {
        assert.equal((await events.next('ready')).projectId, f.projectId);
        await f.owner.request(path + `/tasks/${item.id}/comments`, 'POST', { body: 'A new update through another account.' });
        const update = await events.next('change'); assert.equal(update.projectId, f.projectId); assert.equal(typeof update.revision, 'string');
        assert.equal((await f.owner.request(path + `/members/${f.users.developer}`, 'DELETE')).status, 200);
        assert.deepEqual(await events.next('revoked'), {});
        assert.equal((await f.developer.request(path + `/tasks/${item.id}/comments`)).status, 403);
      } finally { await events.close(); }
    });
    await t.test('notification SSE revokes an existing stream after logout', async () => {
      const events = await eventReader(await fetch(f.base + '/api/notifications/events', { headers: { Cookie: f.customer.cookie } }));
      try {
        await events.next('ready');
        assert.equal((await f.customer.request('/auth/logout', 'POST', {})).status, 200);
        assert.deepEqual(await events.next('revoked'), {});
      } finally { await events.close(); }
    });
    await t.test('notification SSE terminates on session expiry without waiting for a reconnect', async () => {
      const events = await eventReader(await fetch(f.base + '/api/notifications/events', { headers: { Cookie: f.viewer.cookie } }));
      try {
        await events.next('ready');
        f.runtime.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), f.users.viewer);
        assert.deepEqual(await events.next('access_revoked'), {});
        assert.equal((await f.viewer.request('/notifications')).status, 401);
      } finally { await events.close(); }
    });
  } finally { await f.close(); }
});
