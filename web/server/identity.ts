import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import nodemailer from 'nodemailer';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { HttpError, type ModuleContext, type Row } from './context.js';

export interface IdentityMail {
  to: string;
  subject: string;
  text: string;
  purpose: 'verify_email' | 'reset_password';
}
export interface IdentityOptions {
  /** Injection belongs to trusted server/test configuration, never request JSON. */
  deliverMail?: (message: IdentityMail) => Promise<void>;
  clock?: () => number;
  publicOrigin?: string;
}

export const SYSTEM_ROLES = ['member', 'customer', 'developer', 'manager', 'moderator', 'admin'] as const;
export const ROLE_PERMISSIONS: Record<typeof SYSTEM_ROLES[number], readonly string[]> = {
  member: ['profile.edit', 'community.publish', 'community.interact', 'community.report', 'project.create'],
  customer: ['request.submit', 'request.review'],
  developer: ['development.participate'],
  manager: ['project.coordinate'],
  moderator: ['community.moderate', 'report.review'],
  admin: ['system.users.read', 'system.roles.manage', 'system.audit.read', 'system.configure', 'community.moderate', 'report.review'],
};

const emailSchema = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const newPassword = z.string().min(10).max(128);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encodePassword = (value: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
};
const matchesPassword = (value: string, stored: string) => {
  const [salt, encoded] = stored.split(':');
  return typeof encoded === 'string' && encoded.length === 128 && timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(encoded, 'hex'));
};

export function identityPermissions(roles: readonly string[]) {
  if (roles.includes('admin')) return [...new Set(Object.values(ROLE_PERMISSIONS).flat())];
  return [...new Set(roles.flatMap(role => ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] || []))];
}

export function enrichIdentity(ctx: Pick<ModuleContext, 'one'>, user: Row) {
  const avatar = user.avatar_media_id ? ctx.one("SELECT id FROM media WHERE id=? AND user_id=? AND purpose='avatar' AND kind='image'", user.avatar_media_id, user.id) : undefined;
  return {
    emailVerified: !!user.email_verified_at,
    emailVerifiedAt: user.email_verified_at || null,
    bio: user.bio || '',
    avatarMediaId: avatar?.id || null,
    avatarUrl: avatar ? `/api/media/${avatar.id}/content` : null,
    identityVersion: user.identity_version || 1,
    permissions: identityPermissions(JSON.parse(user.roles)),
  };
}

/** Project membership is still required. System roles never grant access to a private project. */
export function requireVerifiedEmail(ctx: Pick<ModuleContext, 'one'>, res: Response, required = process.env.REQUIRE_VERIFIED_EMAIL === 'true' || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_VERIFIED_EMAIL !== 'false')) {
  if (required && !ctx.one('SELECT email_verified_at FROM users WHERE id=?', res.locals.user?.id)?.email_verified_at) {
    throw new HttpError(403, 'Hãy xác minh email trước khi tham gia dự án qua lời mời.', 'EMAIL_VERIFICATION_REQUIRED');
  }
}

function trustedOrigin(options: IdentityOptions): string | null {
  const input = options.publicOrigin || process.env.PUBLIC_ORIGIN;
  if (!input) return null;
  try {
    const url = new URL(input);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && process.env.NODE_ENV !== 'production')) return null;
    return url.origin;
  } catch { return null; }
}

export function registerIdentity(ctx: ModuleContext, options: IdentityOptions = {}) {
  const { app, one, all, run, authenticated, uid, route, transaction, audit } = ctx;
  const clock = options.clock || Date.now;
  const iso = () => new Date(clock()).toISOString();
  const publicOrigin = trustedOrigin(options);
  const fileMode = process.env.MAIL_MODE === 'file' && process.env.NODE_ENV !== 'production';
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  let extraCa: string | undefined;
  let trustReady = true;
  if (process.env.SMTP_CA_FILE) {
    try { extraCa = readFileSync(process.env.SMTP_CA_FILE, 'utf8'); } catch { trustReady = false; }
  }
  const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
  const smtpReady = trustReady && !!process.env.SMTP_HOST && !!process.env.SMTP_FROM && emailSchema.safeParse(process.env.SMTP_FROM).success && Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 && (!!process.env.SMTP_USER === !!process.env.SMTP_PASS);
  const mode = options.deliverMail ? 'test_transport' : fileMode ? 'file' : smtpReady ? 'smtp' : 'unconfigured';
  const configured = !!publicOrigin && mode !== 'unconfigured';
  const smtp = smtpReady ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: smtpPort, secure: smtpSecure, requireTLS: !smtpSecure,
    connectionTimeout: 10000, socketTimeout: 15000,
    ...(extraCa ? { tls: { ca: [...rootCertificates, extraCa], rejectUnauthorized: true } } : {}),
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}),
  }) : null;

  const deliver = async (message: IdentityMail) => {
    if (options.deliverMail) return options.deliverMail(message);
    if (fileMode) {
      const folder = join(ctx.dataDir, 'mail-outbox');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, `${randomUUID()}.json`), JSON.stringify(message), { flag: 'wx', mode: 0o600 });
      return;
    }
    if (!smtp) throw new HttpError(503, 'Chưa cấu hình dịch vụ gửi email.', 'EMAIL_UNCONFIGURED');
    await smtp.sendMail({ from: process.env.SMTP_FROM, to: message.to, subject: message.subject, text: message.text });
  };

  const rateBuckets = new Map<string, { count: number; reset: number }>();
  const consumeRate = (key: string, limit: number) => {
    const time = clock();
    let bucket = rateBuckets.get(key);
    if (!bucket && rateBuckets.size >= 20000) {
      for (const [item, value] of rateBuckets) if (value.reset <= time) rateBuckets.delete(item);
      if (rateBuckets.size >= 20000) throw new HttpError(429, 'Dịch vụ email đang bận. Vui lòng thử lại sau.');
    }
    if (!bucket || bucket.reset <= time) bucket = { count: 0, reset: time + 15 * 60 * 1000 };
    if (++bucket.count > limit) throw new HttpError(429, 'Quá nhiều yêu cầu email. Vui lòng thử lại sau 15 phút.', 'EMAIL_RATE_LIMIT');
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 10000) for (const [item, value] of rateBuckets) if (value.reset <= time) rateBuckets.delete(item);
  };
  const emailRate = (req: Request, email: string) => {
    consumeRate(`ip:${req.ip || 'unknown'}`, 20);
    consumeRate(`email:${hash(email)}`, 5);
  };
  const requireDelivery = () => {
    if (!configured) throw new HttpError(503, 'Chưa cấu hình gửi email và PUBLIC_ORIGIN tin cậy. Liên hệ quản trị viên.', 'EMAIL_UNCONFIGURED');
  };
  const pendingDeliveries = new Set<string>();
  const issueToken = async (user: Row, purpose: IdentityMail['purpose']) => {
    const pendingKey = `${user.id}:${purpose}`;
    if (pendingDeliveries.has(pendingKey)) throw new HttpError(429, 'Yêu cầu email đang được xử lý.');
    pendingDeliveries.add(pendingKey);
    const token = randomBytes(32).toString('base64url');
    const tokenId = randomUUID();
    const expiry = new Date(clock() + (purpose === 'verify_email' ? 24 * 60 : 30) * 60000).toISOString();
    const createdAt = iso();
    const action = purpose === 'verify_email' ? 'verify-email' : 'reset-password';
    const link = `${publicOrigin}/#auth/${action}?token=${encodeURIComponent(token)}`;
    try {
      run('DELETE FROM identity_tokens WHERE expires_at<?', new Date(clock() - 7 * 86400000).toISOString());
      run('INSERT INTO identity_tokens(id,user_id,purpose,token_hash,expires_at,delivery_state,created_at) VALUES(?,?,?,?,?,?,?)', tokenId, user.id, purpose, hash(token), expiry, 'pending', createdAt);
      await deliver({ to: user.email, purpose, subject: purpose === 'verify_email' ? 'Xác minh email Pixel AI World' : 'Đặt lại mật khẩu Pixel AI World', text: `${purpose === 'verify_email' ? 'Xác minh địa chỉ email' : 'Đặt lại mật khẩu'} bằng liên kết một lần:\n${link}\n\nLiên kết hết hạn lúc ${expiry}. Nếu không yêu cầu, hãy bỏ qua email này.` });
      transaction(() => {
        run('UPDATE identity_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND id<>? AND created_at<=? AND consumed_at IS NULL', iso(), user.id, purpose, tokenId, createdAt);
        run("UPDATE identity_tokens SET delivery_state='delivered' WHERE id=?", tokenId);
        audit(user.id, null, purpose === 'verify_email' ? 'account.verification_requested' : 'account.password_reset_requested');
      });
    } catch (error) {
      run("UPDATE identity_tokens SET delivery_state='failed',consumed_at=? WHERE id=?", iso(), tokenId);
      throw error;
    } finally { pendingDeliveries.delete(pendingKey); }
  };
  const validToken = (token: string, purpose: IdentityMail['purpose']) => {
    const record = one("SELECT * FROM identity_tokens WHERE token_hash=? AND purpose=? AND consumed_at IS NULL AND delivery_state='delivered' AND expires_at>?", hash(token), purpose, iso());
    if (!record) throw new HttpError(400, 'Liên kết không hợp lệ, đã được sử dụng hoặc đã hết hạn.', 'INVALID_IDENTITY_TOKEN');
    return record;
  };

  app.get('/api/auth/email/status', authenticated, route((_req, res) => {
    const user = one('SELECT * FROM users WHERE id=?', uid(res))!;
    res.json({ emailVerified: !!user.email_verified_at, deliveryConfigured: configured, mode, requiresVerifiedInvitations: process.env.REQUIRE_VERIFIED_EMAIL === 'true' || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_VERIFIED_EMAIL !== 'false') });
  }));
  app.post('/api/auth/verification/request', authenticated, route(async (req, res) => {
    const user = one('SELECT * FROM users WHERE id=?', uid(res))!;
    emailRate(req, user.email);
    if (user.email_verified_at) return res.json({ ok: true, message: 'Email đã được xác minh.' });
    requireDelivery();
    try { await issueToken(user, 'verify_email'); }
    catch { throw new HttpError(503, 'Chưa gửi được email xác minh. Vui lòng thử lại sau.', 'EMAIL_DELIVERY_FAILED'); }
    res.json({ ok: true, message: 'Yêu cầu xác minh đã được gửi qua kênh email được cấu hình.' });
  }));
  app.post('/api/auth/verification/confirm', authenticated, route((req, res) => {
    const { token } = z.object({ token: tokenSchema }).parse(req.body);
    consumeRate(`confirm:${req.ip || 'unknown'}`, 40);
    transaction(() => {
      const record = validToken(token, 'verify_email');
      if (record.user_id !== uid(res)) throw new HttpError(403, 'Hãy đăng nhập đúng tài khoản đã yêu cầu xác minh email.', 'IDENTITY_MISMATCH');
      run('UPDATE users SET email_verified_at=?,identity_version=identity_version+1,updated_at=? WHERE id=?', iso(), iso(), record.user_id);
      run("UPDATE identity_tokens SET consumed_at=? WHERE user_id=? AND purpose='verify_email' AND consumed_at IS NULL", iso(), record.user_id);
      audit(record.user_id, null, 'account.email_verified');
    });
    res.json({ ok: true, message: 'Email đã được xác minh.' });
  }));
  app.post('/api/auth/password/forgot', route(async (req, res) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    emailRate(req, email);
    requireDelivery();
    const user = one('SELECT * FROM users WHERE email=?', email);
    if (user) {
      // Never expose account existence or delivery failures to an unauthenticated caller.
      try { await issueToken(user, 'reset_password'); } catch { /* failed tokens are invalidated by issueToken */ }
    }
    res.json({ ok: true, message: 'Nếu tài khoản tồn tại, hướng dẫn đặt lại mật khẩu sẽ được gửi qua email.' });
  }));
  app.post('/api/auth/password/reset', route((req, res) => {
    const data = z.object({ token: tokenSchema, password: newPassword }).parse(req.body);
    consumeRate(`reset:${req.ip || 'unknown'}`, 20);
    const encoded = encodePassword(data.password);
    transaction(() => {
      const record = validToken(data.token, 'reset_password');
      run('UPDATE users SET password_hash=?,identity_version=identity_version+1,updated_at=? WHERE id=?', encoded, iso(), record.user_id);
      run("UPDATE identity_tokens SET consumed_at=? WHERE user_id=? AND purpose='reset_password' AND consumed_at IS NULL", iso(), record.user_id);
      run('DELETE FROM sessions WHERE user_id=?', record.user_id);
      audit(record.user_id, null, 'account.password_reset');
    });
    res.clearCookie('pixel_session', { path: '/', sameSite: 'lax', httpOnly: true });
    res.json({ ok: true, message: 'Đã đặt lại mật khẩu. Vui lòng đăng nhập lại.' });
  }));

  app.get('/api/profiles/:id', route((req, res) => {
    const user = one('SELECT * FROM users WHERE id=?', req.params.id);
    if (!user) throw new HttpError(404, 'Hồ sơ không tồn tại.');
    const identity = enrichIdentity(ctx, user);
    const hasHiddenPosts = !!one("SELECT 1 FROM pragma_table_info('posts') WHERE name='hidden_at'");
    const followersReady = !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='follows'");
    res.json({ profile: { id: user.id, name: user.name, bio: identity.bio, avatarUrl: identity.avatarUrl, createdAt: user.created_at, roles: JSON.parse(user.roles), postCount: one(`SELECT COUNT(*) AS n FROM posts WHERE author_id=? AND status='published'${hasHiddenPosts ? ' AND hidden_at IS NULL' : ''}`, user.id)!.n, followers: followersReady ? one('SELECT COUNT(*) AS n FROM follows WHERE author_id=?', user.id)!.n : 0, following: followersReady ? one('SELECT COUNT(*) AS n FROM follows WHERE follower_id=?', user.id)!.n : 0 } });
  }));
  app.get('/api/identity/permissions', authenticated, route((_req, res) => res.json({ roles: JSON.parse(res.locals.user.roles), permissions: identityPermissions(JSON.parse(res.locals.user.roles)), projectMembershipRequired: true })));
  app.patch('/api/identity/profile', authenticated, route((req, res) => {
    const data = z.object({ bio: z.string().trim().max(2000).optional(), avatarMediaId: z.string().uuid().nullable().optional(), version: z.number().int().positive() }).refine(value => value.bio !== undefined || value.avatarMediaId !== undefined).parse(req.body);
    const user = one('SELECT * FROM users WHERE id=?', uid(res))!;
    if (data.avatarMediaId && !one("SELECT id FROM media WHERE id=? AND user_id=? AND purpose='avatar' AND kind='image'", data.avatarMediaId, uid(res))) throw new HttpError(404, 'Avatar không tồn tại hoặc không thuộc tài khoản của bạn.');
    transaction(() => {
      const result = run('UPDATE users SET bio=?,avatar_media_id=?,identity_version=identity_version+1,updated_at=? WHERE id=? AND identity_version=?', data.bio ?? user.bio, data.avatarMediaId === undefined ? user.avatar_media_id : data.avatarMediaId, iso(), uid(res), data.version);
      if (!result.changes) throw new HttpError(409, 'Hồ sơ đã được cập nhật. Hãy tải lại trước khi lưu.', 'VERSION_CONFLICT');
      audit(uid(res), null, 'profile.updated');
    });
    const updated = one('SELECT * FROM users WHERE id=?', uid(res))!;
    res.json({ profile: { id: updated.id, name: updated.name, ...enrichIdentity(ctx, updated) } });
  }));
  app.post('/api/identity/email', authenticated, route((req, res) => {
    const data = z.object({ email: emailSchema, password: z.string().max(128), version: z.number().int().positive() }).parse(req.body);
    const user = one('SELECT * FROM users WHERE id=?', uid(res))!;
    consumeRate(`email-change:${user.id}`, 5);
    if (!matchesPassword(data.password, user.password_hash)) throw new HttpError(401, 'Mật khẩu hiện tại không đúng.');
    if (one('SELECT id FROM users WHERE email=? AND id<>?', data.email, user.id)) throw new HttpError(409, 'Địa chỉ email không khả dụng.');
    transaction(() => {
      const result = run('UPDATE users SET email=?,email_verified_at=NULL,identity_version=identity_version+1,updated_at=? WHERE id=? AND identity_version=?', data.email, iso(), user.id, data.version);
      if (!result.changes) throw new HttpError(409, 'Tài khoản đã thay đổi. Hãy tải lại.', 'VERSION_CONFLICT');
      run('UPDATE identity_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL', iso(), user.id);
      run('DELETE FROM sessions WHERE user_id=? AND id<>?', user.id, res.locals.session?.id || '');
      audit(user.id, null, 'account.email_changed');
    });
    res.json({ ok: true, emailVerified: false, identityVersion: data.version + 1 });
  }));

  const admin = (_req: Request, res: Response, next: NextFunction) => JSON.parse(res.locals.user.roles).includes('admin') ? next() : next(new HttpError(403, 'Cần quyền quản trị viên.'));
  app.get('/api/admin/roles', authenticated, admin, route((_req, res) => res.json({ roles: SYSTEM_ROLES.map(role => ({ role, permissions: identityPermissions([role]) })), projectMembershipRequired: true })));
  app.get('/api/admin/users', authenticated, admin, route((_req, res) => res.json({ users: all('SELECT * FROM users ORDER BY created_at LIMIT 500').map(user => ({ id: user.id, name: user.name, email: user.email, roles: JSON.parse(user.roles), emailVerified: !!user.email_verified_at, identityVersion: user.identity_version, createdAt: user.created_at })) })));
  app.patch('/api/admin/users/:id/roles', authenticated, admin, route((req, res) => {
    const data = z.object({ roles: z.array(z.enum(SYSTEM_ROLES)).min(1).max(SYSTEM_ROLES.length), version: z.number().int().positive() }).parse(req.body);
    const roles = [...new Set(data.roles)];
    const target = one('SELECT * FROM users WHERE id=?', req.params.id);
    if (!target) throw new HttpError(404, 'Tài khoản không tồn tại.');
    transaction(() => {
      if (JSON.parse(target.roles).includes('admin') && !roles.includes('admin')) {
        const admins = Number(one("SELECT COUNT(*) AS n FROM users u WHERE EXISTS(SELECT 1 FROM json_each(u.roles) WHERE value='admin')")!.n);
        if (admins <= 1) throw new HttpError(409, 'Không thể thu hồi quản trị viên cuối cùng.', 'LAST_ADMIN');
      }
      const result = run('UPDATE users SET roles=?,identity_version=identity_version+1,updated_at=? WHERE id=? AND identity_version=?', JSON.stringify(roles), iso(), target.id, data.version);
      if (!result.changes) throw new HttpError(409, 'Vai trò đã thay đổi. Hãy tải lại.', 'VERSION_CONFLICT');
      audit(uid(res), null, 'system.roles_changed', `${target.id}: ${roles.join(',')}`);
      ctx.notify(target.id, 'account', 'Vai trò tài khoản của bạn đã được cập nhật.', '/settings');
    });
    res.json({ user: { id: target.id, roles, identityVersion: data.version + 1 } });
  }));
  return { configured, mode, close: () => smtp?.close() };
}
