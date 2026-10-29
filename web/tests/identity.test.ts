import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import test from 'node:test';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import type { IdentityMail, IdentityOptions } from '../server/identity.js';

async function fixture(identity: IdentityOptions = {}, allowFirstAdmin = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-identity-'));
  const instance = createApp({ dataDir, allowFirstAdmin, identity });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
      const multipart = body instanceof FormData;
      const response = await fetch(base + '/api' + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
      const replacement = response.headers.getSetCookie()[0];
      if (replacement) cookie = replacement.split(';')[0];
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
  }
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { ...instance, dataDir, base, client, cleanup: close };
}
const password = 'Identity-Initial-password-26!';
const registerBody = (email: string, name = 'Pixel Member') => ({ email, name, password });
function tokenFrom(mail: IdentityMail) {
  const link = mail.text.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(link, 'mail has a real action link');
  return new URLSearchParams(new URL(link).hash.split('?')[1]).get('token')!;
}

test('Phase 1: verification, reset and public identity protect accounts', async t => {
  let time = Date.now();
  const sent: IdentityMail[] = [];
  const app = await fixture({ publicOrigin: 'https://pixel.test', clock: () => time, deliverMail: async message => { sent.push(message); } });
  t.after(app.cleanup);
  const owner = app.client(), secondSession = app.client(), outsider = app.client();
  let userId = '';
  await t.test('registration exposes safe identity status but never secret fields', async () => {
    const result = await owner('/auth/register', 'POST', registerBody('owner@identity.test'));
    assert.equal(result.status, 201);
    userId = result.body.user.id;
    assert.equal(result.body.user.emailVerified, false);
    assert.equal(result.body.user.identityVersion, 1);
    assert.equal(result.body.user.password_hash, undefined);
    const profile = await outsider(`/profiles/${userId}`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.email, undefined);
    assert.equal(profile.body.profile.password_hash, undefined);
    assert.equal(profile.body.profile.permissions, undefined);
    const status = await owner('/auth/email/status');
    assert.equal(status.body.deliveryConfigured, true);
    assert.equal(status.body.mode, 'test_transport');
  });
  await t.test('verification mails use a trusted origin and store only token hashes', async () => {
    const result = await owner('/auth/verification/request', 'POST', {}, { Host: 'attacker.test' });
    assert.equal(result.status, 200);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('https://pixel.test/#auth/verify-email?token='));
    assert.ok(!sent[0].text.includes('attacker.test'));
    const token = tokenFrom(sent[0]);
    assert.ok(!JSON.stringify(result.body).includes(token));
    const row = app.db.prepare('SELECT * FROM identity_tokens WHERE user_id=?').get(userId)!;
    assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.ok(!Object.values(row).includes(token));
    assert.equal((await owner('/auth/password/reset', 'POST', { token, password: 'Another-strong-password!' })).status, 400);
    assert.equal((await outsider('/auth/verification/confirm', 'POST', { token })).status, 401, 'a recipient must sign in to the same account before verifying');
    await outsider('/auth/register', 'POST', registerBody('outsider@identity.test'));
    assert.equal((await outsider('/auth/verification/confirm', 'POST', { token })).status, 403, 'another signed-in account cannot consume this proof');
    assert.equal((await owner('/auth/verification/confirm', 'POST', { token })).status, 200);
    assert.equal((await owner('/auth/me')).body.user.emailVerified, true);
    assert.equal((await owner('/auth/verification/confirm', 'POST', { token })).status, 400);
    await owner('/auth/verification/request', 'POST', {});
    assert.equal(sent.length, 1, 'already verified accounts do not get another link');
  });
  await t.test('forgot-password responses do not disclose account existence', async () => {
    const missing = await outsider('/auth/password/forgot', 'POST', { email: 'missing@identity.test' });
    const known = await outsider('/auth/password/forgot', 'POST', { email: 'OWNER@identity.test' });
    assert.deepEqual(known, missing);
    assert.equal(known.status, 200);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].purpose, 'reset_password');
    assert.ok(!JSON.stringify(known.body).includes(tokenFrom(sent[1])));
  });
  await t.test('reset is single-use and revokes every existing session', async () => {
    assert.equal((await secondSession('/auth/login', 'POST', { email: 'owner@identity.test', password })).status, 200);
    const token = tokenFrom(sent[1]);
    const changed = 'Reset-complete-password-2026!';
    assert.equal((await outsider('/auth/password/reset', 'POST', { token, password: changed })).status, 200);
    assert.equal((await owner('/auth/me')).body.user, null);
    assert.equal((await secondSession('/auth/me')).body.user, null);
    assert.equal((await outsider('/auth/password/reset', 'POST', { token, password: changed })).status, 400);
    assert.equal((await owner('/auth/login', 'POST', { email: 'owner@identity.test', password })).status, 401);
    assert.equal((await owner('/auth/login', 'POST', { email: 'owner@identity.test', password: changed })).status, 200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(userId)!.n, 1);
  });
  await t.test('expired reset links cannot change credentials', async () => {
    await outsider('/auth/password/forgot', 'POST', { email: 'owner@identity.test' });
    const token = tokenFrom(sent.at(-1)!);
    time += 31 * 60000;
    assert.equal((await outsider('/auth/password/reset', 'POST', { token, password: 'Expired-reset-should-not-work!' })).status, 400);
  });
  await t.test('a new delivered reset invalidates previous links without changing credentials until used', async () => {
    await outsider('/auth/password/forgot', 'POST', { email: 'owner@identity.test' });
    const older = tokenFrom(sent.at(-1)!);
    await outsider('/auth/password/forgot', 'POST', { email: 'owner@identity.test' });
    const latest = tokenFrom(sent.at(-1)!);
    assert.notEqual(older, latest);
    assert.equal((await outsider('/auth/password/reset', 'POST', { token: older, password: 'Old-link-must-not-work-2026!' })).status, 400);
    assert.equal((await owner('/auth/login', 'POST', { email: 'owner@identity.test', password: 'Reset-complete-password-2026!' })).status, 200);
    assert.equal((await outsider('/auth/password/reset', 'POST', { token: latest, password: 'Latest-reset-password-2026!' })).status, 200);
  });
});

test('Phase 1: profile media and versioned system roles enforce authorization', async t => {
  const app = await fixture();
  t.after(app.cleanup);
  const admin = app.client(), member = app.client(), guest = app.client();
  const a = (await admin('/auth/register', 'POST', registerBody('admin@roles.test', 'Administrator'))).body.user;
  const m = (await member('/auth/register', 'POST', registerBody('member@roles.test', 'Ordinary Member'))).body.user;
  await t.test('members cannot enumerate users or grant themselves roles', async () => {
    assert.equal((await member('/admin/users')).status, 403);
    assert.equal((await member(`/admin/users/${m.id}/roles`, 'PATCH', { roles: ['admin'], version: 1 })).status, 403);
    const roles = await admin('/admin/roles');
    assert.equal(roles.status, 200);
    assert.ok(roles.body.roles.some((r: any) => r.role === 'moderator' && r.permissions.includes('community.moderate')));
  });
  await t.test('role changes are versioned, audited and preserve the last administrator', async () => {
    assert.equal((await admin(`/admin/users/${a.id}/roles`, 'PATCH', { roles: ['member'], version: 1 })).status, 409);
    const promote = await admin(`/admin/users/${m.id}/roles`, 'PATCH', { roles: ['member', 'moderator'], version: 1 });
    assert.equal(promote.status, 200);
    assert.equal(promote.body.user.identityVersion, 2);
    assert.equal((await admin(`/admin/users/${m.id}/roles`, 'PATCH', { roles: ['member', 'admin'], version: 1 })).status, 409);
    const me = await member('/auth/me');
    assert.ok(me.body.user.permissions.includes('community.moderate'));
    assert.ok(!me.body.user.permissions.includes('system.roles.manage'));
    assert.equal((await admin(`/admin/users/${m.id}/roles`, 'PATCH', { roles: ['root'], version: 2 })).status, 400);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action='system.roles_changed'").get()!.n, 1);
  });
  await t.test('profile edits cannot reuse a stale version or another account avatar', async () => {
    const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#aabbcc' } }).png().toBuffer();
    const upload = new FormData();
    upload.append('purpose', 'avatar'); upload.append('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'avatar.png');
    const media = await member('/media', 'POST', upload);
    assert.equal(media.status, 201);
    const edit = await member('/identity/profile', 'PATCH', { bio: 'Tôi xây những thế giới nhỏ.', avatarMediaId: media.body.media.id, version: 2 });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.profile.identityVersion, 3);
    assert.ok(edit.body.profile.avatarUrl.endsWith('/content'));
    assert.equal((await member('/identity/profile', 'PATCH', { bio: 'stale', version: 2 })).status, 409);
    assert.equal((await admin('/identity/profile', 'PATCH', { avatarMediaId: media.body.media.id, version: 1 })).status, 404);
    const profile = await guest(`/profiles/${m.id}`);
    assert.equal(profile.body.profile.bio, 'Tôi xây những thế giới nhỏ.');
    assert.equal(profile.body.profile.avatarUrl, edit.body.profile.avatarUrl);
    assert.equal(profile.body.profile.email, undefined);
    assert.equal((await guest('/identity/profile', 'PATCH', { bio: 'intrusion', version: 3 })).status, 401);
    assert.equal((await member(`/admin/users/${m.id}/roles`, 'PATCH', { roles: ['admin'], version: 3 })).status, 403, 'moderation is not user administration');
  });
});

test('Phase 1: unconfigured mail, delivery failures, rate limits and local outbox are explicit', async t => {
  const prior = Object.fromEntries(['MAIL_MODE', 'SMTP_HOST', 'SMTP_FROM', 'PUBLIC_ORIGIN', 'NODE_ENV'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(prior)) delete process.env[key];
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await t.test('missing mail configuration returns an actionable error without claiming delivery', async () => {
    const app = await fixture();
    try {
      const client = app.client();
      await client('/auth/register', 'POST', registerBody('no-mail@identity.test'));
      assert.equal((await client('/auth/email/status')).body.deliveryConfigured, false);
      assert.equal((await client('/auth/verification/request', 'POST', {})).status, 503);
      const a = await client('/auth/password/forgot', 'POST', { email: 'no-mail@identity.test' });
      const b = await client('/auth/password/forgot', 'POST', { email: 'missing@identity.test' });
      assert.deepEqual(a, b);
      assert.equal(a.status, 503);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM identity_tokens').get()!.n, 0);
    } finally { await app.cleanup(); }
  });
  await t.test('a failed transport never leaves a usable token and does not disclose reset accounts', async () => {
    const app = await fixture({ publicOrigin: 'https://pixel.test', deliverMail: async () => { throw new Error('private transport error'); } });
    try {
      const client = app.client();
      await client('/auth/register', 'POST', registerBody('failure@identity.test'));
      const response = await client('/auth/verification/request', 'POST', {});
      assert.equal(response.status, 503);
      assert.ok(!JSON.stringify(response.body).includes('private transport'));
      const a = await client('/auth/password/forgot', 'POST', { email: 'failure@identity.test' });
      const b = await client('/auth/password/forgot', 'POST', { email: 'unknown@identity.test' });
      assert.deepEqual(a, b);
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE consumed_at IS NULL AND delivery_state='delivered'").get()!.n, 0);
    } finally { await app.cleanup(); }
  });
  await t.test('mail attempts are rate limited by account as well as source', async () => {
    const app = await fixture({ publicOrigin: 'https://pixel.test', deliverMail: async () => {} });
    try {
      const client = app.client();
      for (let attempt = 0; attempt < 5; attempt++) assert.equal((await client('/auth/password/forgot', 'POST', { email: 'rate@identity.test' })).status, 200);
      assert.equal((await client('/auth/password/forgot', 'POST', { email: 'rate@identity.test' })).status, 429);
    } finally { await app.cleanup(); }
  });
  await t.test('file mail is explicit private local delivery and forbidden as production mail', async () => {
    process.env.MAIL_MODE = 'file';
    const app = await fixture({ publicOrigin: 'http://127.0.0.1:5173' });
    try {
      const client = app.client();
      await client('/auth/register', 'POST', registerBody('file@identity.test'));
      assert.equal((await client('/auth/verification/request', 'POST', {})).status, 200);
      const directory = join(app.dataDir, 'mail-outbox');
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      const file = join(directory, files[0]);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      const message: IdentityMail = JSON.parse(await readFile(file, 'utf8'));
      assert.equal((await client('/auth/verification/confirm', 'POST', { token: tokenFrom(message) })).status, 200);
    } finally { await app.cleanup(); }
    process.env.NODE_ENV = 'production';
    const production = await fixture({ publicOrigin: 'https://pixel.test' });
    try {
      const client = production.client();
      await client('/auth/register', 'POST', registerBody('production@identity.test'));
      assert.equal((await client('/auth/email/status')).body.deliveryConfigured, false);
      assert.equal((await client('/auth/verification/request', 'POST', {})).status, 503);
    } finally { await production.cleanup(); }
    delete process.env.NODE_ENV;
    delete process.env.MAIL_MODE;
  });
});

test('Phase 1: verified invitations and email changes preserve proof of ownership', async t => {
  let time = Date.now();
  const sent: IdentityMail[] = [];
  const previous = process.env.REQUIRE_VERIFIED_EMAIL;
  process.env.REQUIRE_VERIFIED_EMAIL = 'true';
  t.after(() => { if (previous === undefined) delete process.env.REQUIRE_VERIFIED_EMAIL; else process.env.REQUIRE_VERIFIED_EMAIL = previous; });
  const app = await fixture({ publicOrigin: 'https://pixel.test', clock: () => time, deliverMail: async message => { sent.push(message); } });
  t.after(app.cleanup);
  const owner = app.client(), invitee = app.client(), secondSession = app.client();
  await owner('/auth/register', 'POST', registerBody('owner@invite-proof.test'));
  await invitee('/auth/register', 'POST', registerBody('invitee@invite-proof.test'));
  const project = (await owner('/projects', 'POST', { name: 'Verified team' })).body.project;
  const invite = await owner(`/projects/${project.id}/invitations`, 'POST', { email: 'invitee@invite-proof.test', role: 'developer' });
  assert.equal(invite.status, 201);
  assert.equal((await invitee(`/invitations/${invite.body.invitation.id}/accept`, 'POST', {})).status, 403);
  await invitee('/auth/verification/request', 'POST', {});
  const firstToken = tokenFrom(sent[0]);
  time += 24 * 60 * 60000 + 1000;
  assert.equal((await invitee('/auth/verification/confirm', 'POST', { token: firstToken })).status, 400);
  await invitee('/auth/verification/request', 'POST', {});
  assert.equal((await invitee('/auth/verification/confirm', 'POST', { token: tokenFrom(sent[1]) })).status, 200);
  assert.equal((await invitee(`/invitations/${invite.body.invitation.id}/accept`, 'POST', {})).status, 200);
  await secondSession('/auth/login', 'POST', { email: 'invitee@invite-proof.test', password });
  const user = (await invitee('/auth/me')).body.user;
  assert.equal((await invitee('/identity/email', 'POST', { email: 'new@invite-proof.test', password: 'wrong', version: user.identityVersion })).status, 401);
  const change = await invitee('/identity/email', 'POST', { email: 'new@invite-proof.test', password, version: user.identityVersion });
  assert.equal(change.status, 200);
  assert.equal((await invitee('/auth/me')).body.user.emailVerified, false);
  assert.equal((await secondSession('/auth/me')).body.user, null);
  assert.equal((await invitee('/auth/verification/confirm', 'POST', { token: tokenFrom(sent[1]) })).status, 400);
});

test('Phase 1: SMTP adapter delivers over verified TLS and rejects an untrusted certificate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-smtp-tls-'));
  const keyFile = join(directory, 'server.key');
  const certFile = join(directory, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const messages: string[] = [];
  const sockets = new Set<TLSSocket>();
  const smtp = createTlsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 pixel.test SMTP fixture\r\n');
    let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5); data = false;
          socket.write('250 2.0.0 Accepted\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^EHLO /i.test(line)) socket.write('250-pixel.test\r\n250 SIZE 262144\r\n');
        else if (/^DATA$/i.test(line)) { data = true; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  // The first connection intentionally rejects this certificate before SMTP dialogue.
  smtp.on('tlsClientError', () => {});
  smtp.listen(0, '127.0.0.1');
  await once(smtp, 'listening');
  const address = smtp.address(); assert.ok(address && typeof address !== 'string');
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_CA_FILE', 'MAIL_MODE'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(address.port), SMTP_SECURE: 'true', SMTP_FROM: 'studio@pixel.test' });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => smtp.close(() => resolve()));
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  const rejected = await fixture({ publicOrigin: 'https://pixel.test' });
  try {
    const client = rejected.client();
    await client('/auth/register', 'POST', registerBody('reject@tls.test'));
    assert.equal((await client('/auth/verification/request', 'POST', {})).status, 503);
    assert.equal(messages.length, 0, 'an untrusted peer never receives the token');
  } finally { await rejected.cleanup(); }
  process.env.SMTP_CA_FILE = certFile;
  const accepted = await fixture({ publicOrigin: 'https://pixel.test' });
  try {
    const client = accepted.client();
    await client('/auth/register', 'POST', registerBody('accept@tls.test'));
    assert.equal((await client('/auth/email/status')).body.mode, 'smtp');
    assert.equal((await client('/auth/verification/request', 'POST', {})).status, 200);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('accept@tls.test'));
    assert.ok(messages[0].includes('pixel.test'));
    assert.equal(accepted.db.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE delivery_state='delivered' AND consumed_at IS NULL").get()!.n, 1);
  } finally { await accepted.cleanup(); }
});
