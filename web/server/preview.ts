import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { parse, serialize } from 'parse5';
import { HttpError, type ModuleContext, type Row } from './context.js';
import { projectPermissions } from './projects.js';
import { validateSourceFiles, type SourceFiles } from './build-runner.js';

export interface PreviewOptions { clock?: () => number; ttlMs?: number }
type PreviewRecord = {
  id: string; digest: string; projectId: string; buildId: string; userId: string;
  sessionId: string; expires: number; launched: boolean; revoked: boolean;
  sourceHash: string; files: SourceFiles;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const policy = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'media-src data: blob:', 'font-src data:',
  "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'",
  "object-src 'none'", "form-action 'none'", "base-uri 'none'",
  "frame-ancestors 'self'", 'sandbox allow-scripts',
].join('; ');
const allowedData = /^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|ogg|wav)|video\/(?:mp4|webm)|font\/(?:woff2?|ttf));base64,[A-Za-z0-9+/=\s]+$/i;
const unsafeElements = new Set(['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe']);
const urlAttributes = new Set(['src', 'href', 'srcset', 'poster', 'action', 'formaction', 'ping', 'data', 'background', 'xlink:href']);
const attr = (node: any, name: string): string | undefined => node.attrs?.find((a: any) => a.name === name)?.value;
const localPath = (value: string) => {
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.split(/[?#]/)[0]); } catch { return null; }
  decoded = decoded.replace(/^\.\//, '');
  return decoded.split('/').some(part => !part || part === '..' || part === '.') ? null : decoded;
};

/** Never evaluate code or extract an archive. This only serializes bounded text. */
export function assemblePreview(files: SourceFiles): string {
  validateSourceFiles(files);
  let markers = 0;
  for (const character of files['index.html']) if (character === '<' && ++markers > 10000) throw new HttpError(413, 'HTML preview vượt giới hạn độ phức tạp.');
  const document = parse(files['index.html']);
  let nodes = 0;
  const walk = (node: any, depth = 0) => {
    if (++nodes > 12000 || depth > 128) throw new HttpError(413, 'HTML preview vượt giới hạn độ sâu hoặc số phần tử.');
    if (!node.childNodes) return;
    node.childNodes = node.childNodes.flatMap((child: any) => {
      const tag = child.tagName?.toLowerCase();
      if (tag && unsafeElements.has(tag)) return [];
      if (tag === 'meta' && (attr(child, 'http-equiv') || attr(child, 'name')?.toLowerCase() === 'referrer')) return [];
      if (tag === 'link') {
        const path = localPath(attr(child, 'href') || '');
        if (attr(child, 'rel')?.toLowerCase() !== 'stylesheet') return [];
        if (!path || !path.endsWith('.css') || !Object.hasOwn(files, path)) throw new HttpError(400, 'Preview chỉ hỗ trợ stylesheet có trong bundle.');
        child.tagName = 'style'; child.nodeName = 'style'; child.attrs = [];
        child.childNodes = [{ nodeName: '#text', value: files[path].replace(/<\/style/gi, '<\\/style'), parentNode: child }];
      }
      if (tag === 'script' && attr(child, 'src')) {
        const path = localPath(attr(child, 'src')!);
        if (!path || !/\.(?:js|mjs|cjs)$/.test(path) || !Object.hasOwn(files, path)) throw new HttpError(400, 'Preview chỉ hỗ trợ script có trong bundle.');
        child.attrs = (child.attrs || []).filter((a: any) => !['src', 'integrity', 'crossorigin', 'async', 'defer'].includes(a.name));
        child.childNodes = [{ nodeName: '#text', value: files[path].replace(/<\/script/gi, '<\\/script'), parentNode: child }];
      }
      if (child.attrs) child.attrs = child.attrs.filter((a: any) => {
        if (a.name === 'target' || a.name === 'download') return false;
        if (!urlAttributes.has(a.name)) return true;
        if (a.name === 'href' && a.value.startsWith('#')) return true;
        return ['src', 'poster'].includes(a.name) && allowedData.test(a.value);
      });
      walk(child, depth + 1);
      // Template content is a separate fragment in parse5's tree.
      if (child.content) walk(child.content, depth + 1);
      return [child];
    });
  };
  walk(document);
  const result = serialize(document);
  if (Buffer.byteLength(result) > 2 * 1024 * 1024) throw new HttpError(413, 'Preview sau khi đóng gói vượt giới hạn.');
  return result;
}

export function registerPreview(ctx: ModuleContext, options: PreviewOptions = {}) {
  const { app, one, authenticated, uid, route, getProject, audit } = ctx;
  const clock = options.clock || Date.now;
  const ttl = Math.max(1000, Math.min(options.ttlMs || 15 * 60 * 1000, 30 * 60 * 1000));
  const records = new Map<string, PreviewRecord>();
  const tokens = new Map<string, string>();
  let closed = false;
  const prune = () => {
    for (const [id, record] of records) if (record.expires < clock() - ttl) { records.delete(id); tokens.delete(record.digest); }
  };
  const allowed = (record: PreviewRecord, res: Response) => {
    if (closed || record.revoked || uidIfPresent(res) !== record.userId || res.locals.session?.id !== record.sessionId) return false;
    const session = one('SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>?', record.sessionId, record.userId, new Date(clock()).toISOString());
    const project = one('SELECT p.deleted_at,m.role,p.locked FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=?', record.userId, record.projectId);
    const build = one('SELECT status,files_json FROM build_jobs WHERE id=? AND project_id=?', record.buildId, record.projectId);
    return !!session && !!project && !project.deleted_at && projectPermissions(project.role || null, !!project.locked).viewSource && build?.status === 'succeeded' && hash(build.files_json) === record.sourceHash;
  };
  const getRecord = (req: any, res: Response) => {
    const record = records.get(String(req.params.previewId));
    if (!record || record.projectId !== req.params.id || record.buildId !== req.params.buildId || record.userId !== uid(res)) throw new HttpError(404, 'Preview không tồn tại.');
    return record;
  };
  app.post('/api/projects/:id/builds/:buildId/preview', authenticated, route((req, res) => {
    prune();
    const project = getProject(String(req.params.id), res);
    if (!projectPermissions(project.role, !!project.locked).viewSource) throw new HttpError(403, 'Vai trò này không có quyền xem source preview.');
    if (!res.locals.session?.id) throw new HttpError(401, 'Phiên đăng nhập không hợp lệ.');
    const build = one('SELECT * FROM build_jobs WHERE id=? AND project_id=?', req.params.buildId, project.id);
    if (!build || build.status !== 'succeeded') throw new HttpError(409, 'Chỉ preview bundle đã build thành công.');
    if (records.size >= 256 || [...records.values()].filter(p => p.userId === uid(res) && !p.revoked && p.expires > clock()).length >= 5) throw new HttpError(429, 'Hãy đóng preview hiện tại trước khi mở thêm.');
    let files: SourceFiles;
    try { files = JSON.parse(build.files_json); } catch { throw new HttpError(409, 'Bundle của build không hợp lệ.'); }
    assemblePreview(files);
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), digest = hash(token);
    const record: PreviewRecord = { id, digest, projectId: project.id, buildId: build.id, userId: uid(res), sessionId: res.locals.session.id, expires: clock() + ttl, launched: false, revoked: false, sourceHash: hash(build.files_json), files };
    records.set(id, record); tokens.set(digest, id);
    audit(uid(res), project.id, 'build.preview_created', build.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ preview: { id, url: `/api/previews/${token}`, statusUrl: `/api/projects/${project.id}/builds/${build.id}/preview/${id}/status`, expiresAt: new Date(record.expires).toISOString(), limitations: ['Bundle tĩnh với script/CSS nội bộ; CSP chặn tài nguyên ngoài, form, popup và worker.', 'Cô lập tài khoản ứng dụng; kiểm thử cần ranh giới mạng tuyệt đối phải dùng runner Docker.', 'Đóng iframe khi hết hạn/thu hồi; nội dung đã được tải không thể thu hồi ngược.'] } });
  }));
  app.get('/api/projects/:id/builds/:buildId/preview/:previewId/status', authenticated, route((req, res) => {
    const record = getRecord(req, res), active = record.expires > clock() && allowed(record, res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ preview: { id: record.id, active, reason: record.expires <= clock() ? 'expired' : active ? 'active' : 'revoked', launched: record.launched, expiresAt: new Date(record.expires).toISOString() } });
  }));
  app.delete('/api/projects/:id/builds/:buildId/preview/:previewId', authenticated, route((req, res) => {
    getRecord(req, res).revoked = true;
    res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true });
  }));
  app.get('/api/previews/:token', route((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), clipboard-read=(), clipboard-write=()');
    if (req.headers['sec-fetch-dest'] !== 'iframe' || req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'Preview chỉ được mở trong iframe cô lập của ứng dụng.');
    const id = typeof req.params.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.params.token) ? tokens.get(hash(req.params.token)) : undefined;
    const record = id ? records.get(id) : undefined;
    if (!record || record.expires <= clock() || !allowed(record, res)) throw new HttpError(404, 'Preview đã hết hạn hoặc bị thu hồi.');
    if (record.launched) throw new HttpError(410, 'Liên kết preview đã được sử dụng. Hãy mở preview mới.');
    record.launched = true;
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.type('html').send(assemblePreview(record.files));
  }));
  return { close() { closed = true; records.clear(); tokens.clear(); } };
}

function uidIfPresent(res: Response): string | undefined { return res.locals.user?.id; }
