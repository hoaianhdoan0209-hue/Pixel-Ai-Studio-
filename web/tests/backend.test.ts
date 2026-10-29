import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app.js';

type ApiResponse = { status: number; body: any; headers: Headers };

test('persistent community and project authorization workflows', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-world-test-'));
  let runtime: ReturnType<typeof createApp>;
  let server: Server;
  let baseUrl: string;

  async function start() {
    runtime = createApp({ dataDir, allowFirstAdmin: true });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await runtime?.close();
  }

  function client() {
    let cookie = '';
    return {
      async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
        const response = await fetch(`${baseUrl}/api${path}`, {
          method,
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies[0].split(';')[0];
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
      },
    };
  }

  const owner = client(), member = client(), outsider = client(), guest = client();
  let ownerId: string, memberId: string, postId: string, projectId: string, taskId: string;
  let taskVersion: number;
  const password = 'A-real-test-password-42!';

  try {
    await start();

    await t.test('health responds and unauthenticated mutations are denied', async () => {
      const health = await guest.request('/health');
      assert.equal(health.status, 200);
      assert.equal((await guest.request('/posts', 'POST', { title: 'Unauthorized game', description: 'Cannot create without signing in.' })).status, 401);
      assert.equal((await guest.request('/auth/register', 'POST', { name: 'Invalid', email: 'not-an-email', password: 'short' })).status, 400);
    });

    await t.test('registration, password verification, sessions and duplicate identities', async () => {
      const a = await owner.request('/auth/register', 'POST', { name: 'Chủ dự án', email: 'owner@example.test', password });
      assert.equal(a.status, 201);
      ownerId = a.body.user.id;
      assert.ok(a.body.user.roles.includes('admin'));
      assert.match(a.headers.get('set-cookie') ?? '', /HttpOnly/i);
      assert.match(a.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
      assert.equal(a.body.user.password, undefined);
      assert.equal(a.body.user.passwordHash, undefined);
      const stored = runtime.db.prepare('SELECT password_hash FROM users WHERE id=?').get(ownerId) as { password_hash: string };
      assert.notEqual(stored.password_hash, password);
      assert.ok(stored.password_hash.length > 64);
      const b = await member.request('/auth/register', 'POST', { name: 'Nhà phát triển', email: 'member@example.test', password });
      assert.equal(b.status, 201);
      memberId = b.body.user.id;
      assert.ok(!b.body.user.roles.includes('admin'));
      assert.equal((await outsider.request('/auth/register', 'POST', { name: 'Người ngoài', email: 'outsider@example.test', password })).status, 201);
      assert.equal((await guest.request('/auth/register', 'POST', { name: 'Duplicate', email: 'OWNER@example.test', password })).status, 409);
      assert.equal((await guest.request('/auth/login', 'POST', { email: 'owner@example.test', password: 'incorrect-password' })).status, 401);
      assert.equal((await owner.request('/auth/me')).body.user.id, ownerId);
    });

    await t.test('hostile origins cannot mutate authenticated state', async () => {
      const result = await owner.request('/posts', 'POST', { title: 'Cross-site post', description: 'Must be rejected.' }, { Origin: 'https://attacker.invalid' });
      assert.equal(result.status, 403);
      assert.ok(result.body.error);
    });

    await t.test('community posts persist and a second account can interact', async () => {
      const created = await owner.request('/posts', 'POST', { title: 'Khu vườn Pixel', description: 'Trò chơi khám phá khu vườn do cộng đồng cùng phát triển.', genre: 'Phiêu lưu', technology: 'HTML5', platform: 'Web' });
      assert.equal(created.status, 201);
      postId = created.body.post.id;
      const listing = await guest.request('/posts');
      assert.equal(listing.status, 200);
      assert.ok(listing.body.posts.some((post: any) => post.id === postId));
      assert.equal((await member.request(`/posts/${postId}/comments`, 'POST', { body: 'Rất mong được tham gia phát triển trò chơi này!' })).status, 201);
      assert.equal((await member.request(`/posts/${postId}/like`, 'POST', {})).status, 200);
      assert.equal((await member.request(`/posts/${postId}/bookmark`, 'POST', {})).status, 200);
      const detail = await guest.request(`/posts/${postId}`);
      assert.equal(detail.body.post.title, 'Khu vườn Pixel');
      assert.ok(detail.body.comments.some((comment: any) => comment.body.includes('tham gia')));
      const notifications = await owner.request('/notifications');
      assert.equal(notifications.status, 200);
      assert.ok(notifications.body.notifications.length > 0);
    });

    await t.test('post ownership is enforced by the backend', async () => {
      const current = (await guest.request(`/posts/${postId}`)).body.post;
      assert.equal((await member.request(`/posts/${postId}`, 'PATCH', { version: current.version, title: 'Stolen ownership' })).status, 403);
      assert.equal((await member.request(`/posts/${postId}`, 'DELETE')).status, 403);
      assert.equal((await guest.request(`/posts/${postId}`)).body.post.title, 'Khu vườn Pixel');
    });

    await t.test('draft posts and reply parent IDs respect resource boundaries', async () => {
      const draft = await owner.request('/posts', 'POST', { title: 'Bản nháp riêng', description: 'Chưa được phép công khai.', status: 'draft' });
      assert.equal(draft.status, 201);
      assert.ok([403, 404].includes((await guest.request(`/posts/${draft.body.post.id}`)).status));
      assert.ok(!(await guest.request('/posts')).body.posts.some((item: any) => item.id === draft.body.post.id));
      const other = await owner.request('/posts', 'POST', { title: 'Trò chơi thứ hai', description: 'Một bài đăng khác để kiểm tra quyền tham chiếu.' });
      assert.equal(other.status, 201);
      const parent = (await guest.request(`/posts/${postId}`)).body.comments[0];
      assert.ok(parent?.id);
      assert.equal((await member.request(`/posts/${other.body.post.id}/comments`, 'POST', { body: 'Không được ghép vào bình luận ở bài khác.', parentId: parent.id })).status, 400);
    });

    await t.test('private projects are hidden until an invitation is accepted', async () => {
      const created = await owner.request('/projects', 'POST', { name: 'Thế giới thử nghiệm', description: 'Dự án riêng tư cho luồng cộng tác thực tế.', visibility: 'private' });
      assert.equal(created.status, 201);
      projectId = created.body.project.id;
      assert.ok([403, 404].includes((await outsider.request(`/projects/${projectId}`)).status));
      assert.ok(!(await outsider.request('/projects')).body.projects.some((project: any) => project.id === projectId));
      const invitation = await owner.request(`/projects/${projectId}/invitations`, 'POST', { email: 'member@example.test', role: 'developer' });
      assert.equal(invitation.status, 201);
      const invitations = await member.request('/invitations');
      assert.equal(invitations.status, 200);
      const found = invitations.body.invitations.find((item: any) => item.id === invitation.body.invitation.id);
      assert.ok(found);
      assert.ok([403, 404].includes((await outsider.request(`/invitations/${found.id}/accept`, 'POST', {})).status));
      assert.equal((await member.request(`/invitations/${found.id}/accept`, 'POST', {})).status, 200);
      const detail = await member.request(`/projects/${projectId}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.members.some((item: any) => item.userId === memberId || item.id === memberId));
    });

    await t.test('developers work on tasks and stale writes return conflicts', async () => {
      const created = await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Xây dựng màn chơi đầu tiên', description: 'Hoàn thành luồng tương tác và chạy kiểm thử.', type: 'task', priority: 'high' });
      assert.equal(created.status, 201);
      taskId = created.body.task.id;
      const version = created.body.task.version;
      assert.equal(typeof version, 'number');
      const updated = await member.request(`/projects/${projectId}/tasks/${taskId}`, 'PATCH', { version, status: 'in_progress' });
      assert.equal(updated.status, 200);
      taskVersion = updated.body.task.version;
      assert.ok(taskVersion > version);
      const conflict = await owner.request(`/projects/${projectId}/tasks/${taskId}`, 'PATCH', { version, status: 'done' });
      assert.equal(conflict.status, 409);
      const detail = await owner.request(`/projects/${projectId}`);
      assert.equal(detail.body.tasks.find((item: any) => item.id === taskId).status, 'in_progress');
      assert.ok(detail.body.activity.length >= 2);
    });

    await t.test('project locks prevent edits and owner unlock restores permissions', async () => {
      assert.equal((await member.request(`/projects/${projectId}/lock`, 'POST', { locked: true })).status, 403);
      assert.equal((await owner.request(`/projects/${projectId}/lock`, 'POST', { locked: true })).status, 200);
      assert.ok([403, 423].includes((await member.request(`/projects/${projectId}/tasks/${taskId}`, 'PATCH', { version: taskVersion, status: 'done' })).status));
      assert.ok([403, 423].includes((await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Must stay locked', type: 'bug', priority: 'normal' })).status));
      assert.equal((await owner.request(`/projects/${projectId}/lock`, 'POST', { locked: false })).status, 200);
      const updated = await member.request(`/projects/${projectId}/tasks/${taskId}`, 'PATCH', { version: taskVersion, status: 'done' });
      assert.equal(updated.status, 200);
      taskVersion = updated.body.task.version;
    });

    await t.test('changing a member to viewer removes write access', async () => {
      assert.equal((await owner.request(`/projects/${projectId}/members/${memberId}`, 'PATCH', { role: 'viewer' })).status, 200);
      assert.equal((await member.request(`/projects/${projectId}/tasks/${taskId}`, 'PATCH', { version: taskVersion, status: 'todo' })).status, 403);
      assert.equal((await member.request(`/projects/${projectId}`)).status, 200);
      assert.ok([403, 404].includes((await outsider.request(`/projects/${projectId}/members/${memberId}`, 'PATCH', { role: 'manager' })).status));
    });

    await t.test('customers can submit requests without gaining developer privileges', async () => {
      assert.equal((await owner.request(`/projects/${projectId}/members/${memberId}`, 'PATCH', { role: 'customer' })).status, 200);
      const request = await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Yêu cầu bổ sung màn hướng dẫn', description: 'Khách hàng cần một bước hướng dẫn điều khiển.', type: 'request', priority: 'high' });
      assert.equal(request.status, 201);
      assert.equal(request.body.task.type, 'request');
      assert.equal((await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Không được tạo nhiệm vụ phát triển' })).status, 403);
      assert.equal((await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Không được tự phân công người khác', type: 'request', assigneeId: ownerId })).status, 403);
      assert.equal((await member.request(`/projects/${projectId}/tasks/${request.body.task.id}`, 'PATCH', { version: request.body.task.version, status: 'done' })).status, 403);
      assert.equal((await member.request(`/projects/${projectId}/tasks/${request.body.task.id}`, 'DELETE')).status, 403);
      assert.equal((await owner.request(`/projects/${projectId}/lock`, 'POST', { locked: true })).status, 200);
      assert.equal((await member.request(`/projects/${projectId}/tasks`, 'POST', { title: 'Không được gửi khi dự án khóa', type: 'request' })).status, 403);
      assert.equal((await owner.request(`/projects/${projectId}/lock`, 'POST', { locked: false })).status, 200);
      assert.equal((await owner.request(`/projects/${projectId}/members/${memberId}`, 'PATCH', { role: 'viewer' })).status, 200);
    });

    await t.test('unconfigured services expose no fabricated AI activity', async () => {
      const integrations = await owner.request('/integrations');
      assert.equal(integrations.status, 200);
      for (const name of ['ai', 'github', 'build']) {
        assert.equal(integrations.body[name].connected, false);
        assert.equal(integrations.body[name].status, 'not_configured');
      }
      const usage = await owner.request('/usage');
      assert.equal(usage.status, 200);
      assert.equal(usage.body.jobs, 0);
      assert.equal(usage.body.inputTokens, 0);
      assert.equal(usage.body.outputTokens, 0);
      assert.equal(usage.body.estimatedCost, 0);
      assert.equal(usage.body.configured, false);
    });

    await t.test('records and authenticated sessions survive a complete server restart', async () => {
      await stop();
      await start();
      assert.equal((await owner.request('/auth/me')).body.user.id, ownerId);
      assert.equal((await guest.request(`/posts/${postId}`)).body.post.title, 'Khu vườn Pixel');
      const detail = await member.request(`/projects/${projectId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.tasks.find((item: any) => item.id === taskId).status, 'done');
      assert.ok([403, 404].includes((await outsider.request(`/projects/${projectId}`)).status));
    });

    await t.test('logout invalidates the server session and login restores access', async () => {
      assert.equal((await member.request('/auth/logout', 'POST', {})).status, 200);
      assert.equal((await member.request('/auth/me')).body.user, null);
      assert.ok([401, 404].includes((await member.request(`/projects/${projectId}`)).status));
      assert.equal((await member.request('/auth/login', 'POST', { email: 'member@example.test', password })).status, 200);
      assert.equal((await member.request(`/projects/${projectId}`)).status, 200);
    });

    await t.test('profile preferences persist without granting administrator roles', async () => {
      const saved = await member.request('/profile', 'PATCH', { name: 'Lập trình viên Pixel', settings: { theme: 'light', mode: 'dashboard', reducedMotion: true }, roles: ['admin'] });
      assert.equal(saved.status, 200);
      const current = (await member.request('/auth/me')).body.user;
      assert.equal(current.name, 'Lập trình viên Pixel');
      assert.equal(current.settings.theme, 'light');
      assert.equal(current.settings.mode, 'dashboard');
      assert.equal(current.settings.reducedMotion, true);
      assert.ok(!current.roles.includes('admin'));
      assert.equal((await member.request('/admin')).status, 403);
      assert.equal((await owner.request('/admin')).status, 200);
    });

    await t.test('session revocation and password changes invalidate other sessions', async () => {
      const otherDevice = client();
      assert.equal((await otherDevice.request('/auth/login', 'POST', { email: 'member@example.test', password })).status, 200);
      const sessions = (await member.request('/auth/sessions')).body.sessions;
      assert.equal(sessions.length, 2);
      const otherSession = sessions.find((item: any) => !item.current);
      assert.ok(otherSession?.id);
      // A different user's successful no-op cannot revoke this account's session.
      assert.equal((await outsider.request(`/auth/sessions/${otherSession.id}`, 'DELETE')).status, 200);
      assert.equal((await otherDevice.request('/auth/me')).body.user.id, memberId);
      assert.equal((await member.request(`/auth/sessions/${otherSession.id}`, 'DELETE')).status, 200);
      assert.equal((await otherDevice.request('/auth/me')).body.user, null);

      assert.equal((await otherDevice.request('/auth/login', 'POST', { email: 'member@example.test', password })).status, 200);
      const changedPassword = 'An-updated-real-password-84!';
      assert.equal((await member.request('/auth/password', 'POST', { currentPassword: 'wrong-current-password', password: changedPassword })).status, 401);
      assert.equal((await member.request('/auth/password', 'POST', { currentPassword: password, password: changedPassword })).status, 200);
      assert.equal((await otherDevice.request('/auth/me')).body.user, null);
      assert.equal((await member.request('/auth/me')).body.user.id, memberId);
      assert.equal((await otherDevice.request('/auth/login', 'POST', { email: 'member@example.test', password })).status, 401);
      assert.equal((await otherDevice.request('/auth/login', 'POST', { email: 'member@example.test', password: changedPassword })).status, 200);
    });
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
