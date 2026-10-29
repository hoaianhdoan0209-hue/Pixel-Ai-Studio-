import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { HttpError, type ModuleContext } from './context.js';
import { registerIdentity, enrichIdentity, requireVerifiedEmail, type IdentityOptions } from './identity.js';
import { registerCommunity } from './community.js';
import { registerProjects, duplicateProjectPlanning } from './projects.js';
import { registerAI, type AIOptions } from './ai.js';
import { registerIntegrations, type IntegrationOptions } from './integrations.js';
import { registerPreview, type PreviewOptions } from './preview.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const id = () => randomUUID();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const passwordHash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const verifyPassword = (password: string, stored: string) => {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  return expected?.length === 128 && timingSafeEqual(actual, Buffer.from(expected, 'hex'));
};
const name = z.string().trim().min(2).max(100);
const email = z.string().trim().email().max(254).transform(x => x.toLowerCase());
const password = z.string().min(10).max(128);
const text = z.string().trim().max(20000);
const short = z.string().trim().max(200);
const httpsUrl = z.union([z.literal(''), z.string().url().max(2000).refine(x => new URL(x).protocol === 'https:', 'HTTPS URL required')]);
const projectStatus = z.enum(['planning', 'development', 'testing', 'approval', 'completed', 'paused', 'archived']);
const taskStatus = z.enum(['todo', 'in_progress', 'review', 'done']);
const memberRole = z.enum(['manager', 'developer', 'tester', 'reviewer', 'viewer', 'customer']);
const settingsSchema = z.object({theme: z.enum(['light', 'dark', 'system']).optional(), mode: z.enum(['world', 'dashboard']).optional(), reducedMotion: z.boolean().optional()});
const postSchema = z.object({ title: name, description: text.min(1), genre: short.optional(), technology: short.optional(), aiTools: short.optional(), platform: short.optional(), status: z.enum(['published', 'draft']).optional(), repositoryUrl: httpsUrl.optional(), playUrl: httpsUrl.optional() });
const taskSchema = z.object({title: name, description: text.optional(), type: z.enum(['task', 'bug', 'request']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(), assigneeId: z.string().uuid().nullable().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()});
class ApiError extends HttpError {}

export function createApp(options: { dataDir: string; allowFirstAdmin?: boolean; publicOrigin?: string; identity?: IdentityOptions; ai?: AIOptions; integrations?: IntegrationOptions; preview?: PreviewOptions } ) {
  const db = openDatabase(options.dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'"], connectSrc: ["'self'"], frameSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({limit: '256kb', verify: (req, _res, body) => { (req as Request & {rawBody?: Buffer}).rawBody = Buffer.from(body); }}));
  const one = (sql: string, ...params: any[]): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: any[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);
  const transaction = <T,>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const userShape = (u: Row) => ({id: u.id, name: u.name, email: u.email, roles: JSON.parse(u.roles), settings: {theme: 'light', mode: 'world', reducedMotion: false, ...JSON.parse(u.settings)}, createdAt: u.created_at, ...enrichIdentity({one},u)});
  const notify = (userId: string, type: string, title: string, href: string) => run('INSERT INTO notifications(id,user_id,type,title,href,created_at) VALUES(?,?,?,?,?,?)', id(), userId, type, title, href, now());
  const audit = (actor: string, project: string | null, action: string, detail = '') => run('INSERT INTO activity(id,project_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?,?)', id(), project, actor, action, detail, now());
  const cookieOptions = (req: Request) => ({httpOnly: true, sameSite: 'lax' as const, secure: req.secure || process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 7 * 86400 * 1000});
  const setSession = (req: Request, res: Response, userId: string) => {
    const token = randomBytes(32).toString('base64url');
    run('DELETE FROM sessions WHERE expires_at < ?', now());
    run('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at,user_agent) VALUES(?,?,?,?,?,?)', id(), digest(token), userId, now(), new Date(Date.now() + 7 * 86400 * 1000).toISOString(), (req.headers['user-agent'] || '').slice(0, 200));
    res.cookie('pixel_session', token, cookieOptions(req));
  };
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/github/webhook') {
      const origin = req.headers.origin;
      const expected = options.publicOrigin || process.env.PUBLIC_ORIGIN;
      const allowed = origin && (origin === expected || (() => {try {const u = new URL(origin); return u.host === req.headers.host && ['http:', 'https:'].includes(u.protocol);} catch {return false;}})());
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !allowed)) return next(new ApiError(403, 'Yêu cầu từ nguồn không được phép.', 'CSRF'));
    }
    let token = '';
    try {token = decodeURIComponent((req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('pixel_session='))?.slice(14) || '');} catch { /* invalid cookies remain anonymous */ }
    if (token) {
      const session = one('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', digest(token), now());
      if (session) {res.locals.user = one('SELECT * FROM users WHERE id=?', session.user_id); res.locals.session = session;}
    }
    next();
  });
  const authenticated = (_req: Request, res: Response, next: NextFunction) => res.locals.user ? next() : next(new ApiError(401, 'Vui lòng đăng nhập.'));
  const uid = (res: Response) => res.locals.user.id as string;
  const route = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {try {void Promise.resolve(fn(req, res)).catch(next);} catch (e) {next(e);}};
  const limiter = new Map<string, {count: number; reset: number}>();
  const authLimit = (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown'; const t = Date.now(); let v = limiter.get(key);
    if (!v || v.reset < t) {v = {count: 0, reset: t + 15 * 60000}; limiter.set(key, v);}
    if (++v.count > 40) return next(new ApiError(429, 'Quá nhiều lần thử. Vui lòng chờ 15 phút.'));
    if (limiter.size > 10000) for (const [k, item] of limiter) if (item.reset < t) limiter.delete(k);
    next();
  };
  const mutationCounts = new Map<string, {count: number; reset: number}>();
  app.use('/api', (req, res, next) => {
    if (!['POST','PATCH','DELETE','PUT'].includes(req.method) || !res.locals.user) return next();
    const k = uid(res); const t = Date.now(); let v = mutationCounts.get(k);
    if (!v || v.reset < t) {v = {count: 0, reset: t + 60000}; mutationCounts.set(k,v);}
    if (++v.count > 120) return next(new ApiError(429,'Bạn thao tác quá nhanh. Vui lòng thử lại sau một phút.'));
    next();
  });
  app.get('/api/health', (_req, res) => res.json({status: 'ok', database: 'sqlite', schemaVersion: one('SELECT MAX(version) AS n FROM schema_migrations')?.n}));
  app.get('/api/auth/me', (_req, res) => res.json({user: res.locals.user ? userShape(res.locals.user) : null}));
  app.post('/api/auth/register', authLimit, route((req, res) => {
    const data = z.object({name, email, password}).parse(req.body);
    if (one('SELECT id FROM users WHERE email=?', data.email)) throw new ApiError(409, 'Email đã được sử dụng.');
    const userId = id();
    transaction(() => {
      const isFirst = options.allowFirstAdmin === true && one('SELECT COUNT(*) AS n FROM users')?.n === 0;
      run('INSERT INTO users(id,email,name,password_hash,roles,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', userId, data.email, data.name, passwordHash(data.password), JSON.stringify(isFirst ? ['member','admin'] : ['member']), now(), now());
      audit(userId, null, 'account.registered');
      setSession(req, res, userId);
    });
    res.status(201).json({user: userShape(one('SELECT * FROM users WHERE id=?', userId)!)});
  }));
  app.post('/api/auth/login', authLimit, route((req, res) => {
    const data = z.object({email, password: z.string().max(128)}).parse(req.body);
    const user = one('SELECT * FROM users WHERE email=?', data.email);
    // Perform a real password derivation even when the email does not exist.
    const dummy = '00000000000000000000000000000000:' + '0'.repeat(128);
    if (!verifyPassword(data.password, user?.password_hash || dummy) || !user) throw new ApiError(401, 'Email hoặc mật khẩu không đúng.');
    setSession(req, res, user.id); audit(user.id, null, 'account.login');
    res.json({user: userShape(user)});
  }));
  app.post('/api/auth/logout', route((req, res) => {if (res.locals.session) run('DELETE FROM sessions WHERE id=?', res.locals.session.id); res.clearCookie('pixel_session', {path: '/', sameSite: 'lax', httpOnly: true}); res.json({ok: true});}));
  app.patch('/api/profile', authenticated, route((req, res) => {
    const data = z.object({name: name.optional(), settings: settingsSchema.optional()}).parse(req.body);
    const user = res.locals.user;
    run('UPDATE users SET name=?,settings=?,updated_at=? WHERE id=?', data.name ?? user.name, JSON.stringify({...JSON.parse(user.settings), ...data.settings}), now(), user.id);
    res.json({user: userShape(one('SELECT * FROM users WHERE id=?', user.id)!)});
  }));
  app.post('/api/auth/password', authenticated, authLimit, route((req, res) => {
    const data = z.object({currentPassword: z.string().max(128), password}).parse(req.body);
    if (!verifyPassword(data.currentPassword, res.locals.user.password_hash)) throw new ApiError(401, 'Mật khẩu hiện tại không đúng.');
    transaction(() => {run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', passwordHash(data.password), now(), uid(res)); run('DELETE FROM sessions WHERE user_id=? AND id<>?', uid(res), res.locals.session.id); audit(uid(res), null, 'account.password_changed');});
    res.json({ok: true});
  }));
  app.get('/api/auth/sessions', authenticated, (_req, res) => res.json({sessions: all('SELECT id,created_at,expires_at,user_agent FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC', uid(res), now()).map(s => ({id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, userAgent: s.user_agent, current: s.id === res.locals.session.id}))}));
  app.delete('/api/auth/sessions/:id', authenticated, route((req,res) => {run('DELETE FROM sessions WHERE id=? AND user_id=?', req.params.id, uid(res)); if (req.params.id === res.locals.session.id) res.clearCookie('pixel_session',{path:'/'}); res.json({ok:true});}));

  const postShape = (post: Row, viewer?: string) => ({id: post.id, title: post.title, description: post.description, genre: post.genre, technology: post.technology, aiTools: post.ai_tools, platform: post.platform, status: post.status, repositoryUrl: post.repository_url, playUrl: post.play_url, author: {id:post.author_id,name:post.author_name || one('SELECT name FROM users WHERE id=?',post.author_id)?.name}, likes: one("SELECT COUNT(*) AS n FROM reactions WHERE post_id=? AND type='like'",post.id)!.n, comments: one('SELECT COUNT(*) AS n FROM comments WHERE post_id=? AND hidden_at IS NULL',post.id)!.n, liked: !!viewer && !!one("SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND type='like'",post.id,viewer), bookmarked: !!viewer && !!one("SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND type='bookmark'",post.id,viewer), version:post.version, createdAt:post.created_at, updatedAt:post.updated_at});
  const getPost = (postId: string, viewer?: Row) => {const p = one('SELECT p.*,u.name AS author_name FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?',postId); if (!p || (p.hidden_at && p.author_id!==viewer?.id && !JSON.parse(viewer?.roles || '[]').some((r:string)=>['admin','moderator'].includes(r))) || (p.status==='draft' && p.author_id!==viewer?.id && !JSON.parse(viewer?.roles || '[]').includes('admin'))) throw new ApiError(404,'Bài viết không tồn tại.'); return p;};
  const ownPost = (p: Row,res:Response) => {if(p.author_id!==uid(res) && !JSON.parse(res.locals.user.roles).includes('admin')) throw new ApiError(403,'Bạn không có quyền sửa bài viết này.');};
  const commentShape = (c:Row) => ({id:c.id,postId:c.post_id,parentId:c.parent_id,body:c.body,author:{id:c.author_id,name:c.author_name || one('SELECT name FROM users WHERE id=?',c.author_id)?.name},createdAt:c.created_at});
  app.get('/api/posts', route((req,res) => {
    const viewer = res.locals.user?.id; const q = typeof req.query.q==='string' ? req.query.q.slice(0,200) : ''; const genre = typeof req.query.genre==='string' ? req.query.genre.slice(0,200) : '';
    const filter = req.query.filter; const page = Math.max(1,Math.min(10000,Number(req.query.page)||1));
    const posts = all("SELECT p.*,u.name AS author_name FROM posts p JOIN users u ON u.id=p.author_id WHERE p.hidden_at IS NULL AND (p.status='published' OR p.author_id=?) AND (?='' OR p.title LIKE ? OR p.description LIKE ?) AND (?='' OR p.genre=?) AND (?<>'mine' OR p.author_id=?) AND (?<>'bookmarks' OR EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=? AND r.type='bookmark')) ORDER BY p.created_at DESC LIMIT 50 OFFSET ?",viewer||'',q,`%${q}%`,`%${q}%`,genre,genre,filter||'',viewer||'',filter||'',viewer||'',(page-1)*50).map(p=>postShape(p,viewer));
    res.json({posts,page,hasMore:posts.length===50});
  }));
  app.post('/api/posts', authenticated, route((req,res) => {
    const d=postSchema.parse(req.body); const postId=id();
    run('INSERT INTO posts(id,author_id,title,description,genre,technology,ai_tools,platform,status,repository_url,play_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',postId,uid(res),d.title,d.description,d.genre||'',d.technology||'',d.aiTools||'',d.platform||'Web',d.status||'published',d.repositoryUrl||'',d.playUrl||'',now(),now());
    audit(uid(res),null,'community.post_created',postId);
    res.status(201).json({post:postShape(getPost(postId,res.locals.user),uid(res))});
  }));
  app.get('/api/posts/:id', route((req,res) => {const post=getPost(String(req.params.id),res.locals.user); res.json({post:postShape(post,res.locals.user?.id),comments:all('SELECT c.*,u.name AS author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.post_id=? AND c.hidden_at IS NULL ORDER BY c.created_at LIMIT 500',post.id).map(commentShape)});}));
  app.patch('/api/posts/:id', authenticated, route((req,res) => {
    const p=getPost(String(req.params.id),res.locals.user);ownPost(p,res);
    const d=postSchema.partial().extend({version:z.number().int().positive()}).parse(req.body);
    const result=run('UPDATE posts SET title=?,description=?,genre=?,technology=?,ai_tools=?,platform=?,status=?,repository_url=?,play_url=?,version=version+1,updated_at=? WHERE id=? AND version=?',d.title??p.title,d.description??p.description,d.genre??p.genre,d.technology??p.technology,d.aiTools??p.ai_tools,d.platform??p.platform,d.status??p.status,d.repositoryUrl??p.repository_url,d.playUrl??p.play_url,now(),p.id,d.version);
    if(!result.changes)throw new ApiError(409,'Bài viết đã thay đổi. Hãy tải lại trước khi lưu.','VERSION_CONFLICT');
    res.json({post:postShape(getPost(p.id,res.locals.user),uid(res))});
  }));
  app.delete('/api/posts/:id', authenticated, route((req,res)=>{const p=getPost(String(req.params.id),res.locals.user);ownPost(p,res);run('DELETE FROM posts WHERE id=?',p.id);audit(uid(res),null,'community.post_deleted',p.id);res.json({ok:true});}));
  for(const type of ['like','bookmark']) app.post(`/api/posts/:id/${type}`,authenticated,route((req,res)=>{
    const p=getPost(String(req.params.id),res.locals.user);if(p.hidden_at)throw new ApiError(403,'Nội dung đang được kiểm duyệt.');if(p.status!=='published')throw new ApiError(400,'Chỉ tương tác với bài viết công khai.');
    transaction(()=>{const existing=one('SELECT 1 FROM reactions WHERE user_id=? AND post_id=? AND type=?',uid(res),p.id,type);if(existing)run('DELETE FROM reactions WHERE user_id=? AND post_id=? AND type=?',uid(res),p.id,type);else{run('INSERT INTO reactions VALUES(?,?,?)',uid(res),p.id,type);if(type==='like'&&p.author_id!==uid(res))notify(p.author_id,'like',`${res.locals.user.name} thích ${p.title}`,`/games/${p.id}`);}});
    res.json({post:postShape(p,uid(res))});
  }));
  app.post('/api/posts/:id/comments',authenticated,route((req,res)=>{
    const p=getPost(String(req.params.id),res.locals.user);if(p.hidden_at)throw new ApiError(403,'Nội dung đang được kiểm duyệt.');if(p.status!=='published')throw new ApiError(400,'Không thể bình luận bản nháp.');
    const d=z.object({body:text.min(1).max(5000),parentId:z.string().uuid().nullable().optional()}).parse(req.body);
    if(d.parentId&&!one('SELECT 1 FROM comments WHERE id=? AND post_id=? AND hidden_at IS NULL',d.parentId,p.id))throw new ApiError(400,'Bình luận cha không hợp lệ.');
    const commentId=id();transaction(()=>{run('INSERT INTO comments(id,post_id,author_id,parent_id,body,created_at) VALUES(?,?,?,?,?,?)',commentId,p.id,uid(res),d.parentId||null,d.body,now());if(p.author_id!==uid(res))notify(p.author_id,'comment',`${res.locals.user.name} bình luận về ${p.title}`,`/games/${p.id}`);});
    res.status(201).json({comment:commentShape(one('SELECT * FROM comments WHERE id=?',commentId)!)});
  }));

  const getProject = (projectId:string,res:Response,edit=false) => {
    const p=one('SELECT p.*,u.name AS owner_name FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=? AND p.deleted_at IS NULL',projectId);
    if(!p)throw new ApiError(404,'Dự án không tồn tại.');
    p.role=res.locals.user ? one('SELECT role FROM project_members WHERE project_id=? AND user_id=?',p.id,uid(res))?.role : null;
    if(!p.role&&p.visibility!=='public')throw new ApiError(404,'Dự án không tồn tại hoặc bạn không có quyền truy cập.');
    if(edit&&(!['owner','manager','developer'].includes(p.role)|| (p.locked&&p.role!=='owner')))throw new ApiError(403,p.locked?'Dự án đang khóa.':'Bạn không có quyền chỉnh sửa dự án.');
    return p;
  };
  const manageProject = (p:Row) => {if(!['owner','manager'].includes(p.role))throw new ApiError(403,'Cần quyền chủ dự án hoặc quản lý.');};
  const ownProject = (p:Row) => {if(p.role!=='owner')throw new ApiError(403,'Chỉ chủ dự án được thực hiện thao tác này.');};
  const projectShape=(p:Row) => {
    const counts=one("SELECT COUNT(*) AS total,SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id=?",p.id)!;
    return {id:p.id,name:p.name,description:p.description,visibility:p.visibility,status:p.status,locked:!!p.locked,ownerId:p.owner_id,owner:{id:p.owner_id,name:p.owner_name||one('SELECT name FROM users WHERE id=?',p.owner_id)?.name},role:p.role||null,taskCount:counts.total,progress:counts.total?Math.round((counts.done||0)/counts.total*100):0,version:p.version,createdAt:p.created_at,updatedAt:p.updated_at};
  };
  const taskShape=(t:Row)=>({id:t.id,projectId:t.project_id,title:t.title,description:t.description,type:t.type,status:t.status,priority:t.priority,assigneeId:t.assignee_id,dueDate:t.due_date,version:t.version,createdBy:t.created_by,createdAt:t.created_at,updatedAt:t.updated_at});
  const members=(projectId:string)=>all('SELECT m.*,u.name,u.email FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.joined_at',projectId).map(m=>({id:m.user_id,userId:m.user_id,name:m.name,email:m.email,role:m.role,joinedAt:m.joined_at}));
  const checkAssignee=(projectId:string,assignee?:string|null)=>{if(assignee&&!one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',projectId,assignee))throw new ApiError(400,'Người được giao phải là thành viên dự án.');};
  app.get('/api/projects',route((_req,res)=>{
    const projects=all("SELECT p.*,u.name AS owner_name,m.role FROM projects p JOIN users u ON u.id=p.owner_id LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.deleted_at IS NULL AND (m.role IS NOT NULL OR p.visibility='public') ORDER BY p.updated_at DESC LIMIT 200",res.locals.user?.id||'').map(projectShape);res.json({projects});
  }));
  app.post('/api/projects',authenticated,route((req,res)=>{
    const d=z.object({name,description:text.optional(),visibility:z.enum(['private','public']).optional()}).parse(req.body);const projectId=id();
    transaction(()=>{run('INSERT INTO projects(id,owner_id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',projectId,uid(res),d.name,d.description||'',d.visibility||'private',now(),now());run('INSERT INTO project_members VALUES(?,?,?,?)',projectId,uid(res),'owner',now());audit(uid(res),projectId,'project.created',d.name);});
    res.status(201).json({project:projectShape(getProject(projectId,res))});
  }));
  app.get('/api/projects/:id',route((req,res)=>{
    const p=getProject(String(req.params.id),res);
    const activity=all('SELECT a.*,u.name AS actor_name FROM activity a JOIN users u ON u.id=a.actor_id WHERE a.project_id=? ORDER BY a.created_at DESC LIMIT 100',p.id).map(a=>({id:a.id,action:a.action,detail:a.detail,actor:{id:a.actor_id,name:a.actor_name},createdAt:a.created_at}));
    // Public visitors can inspect project work but do not receive member emails.
    const ms=members(p.id).map(m=>p.role?m:({...m,email:undefined}));
    res.json({project:projectShape(p),tasks:all('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at',p.id).map(taskShape),members:ms,activity,invitations:['owner','manager'].includes(p.role)?all("SELECT id,email,role,status,created_at AS createdAt FROM invitations WHERE project_id=? AND status='pending'",p.id):[]});
  }));
  app.patch('/api/projects/:id',authenticated,route((req,res)=>{
    const p=getProject(String(req.params.id),res,true);manageProject(p);
    const d=z.object({version:z.number().int().positive(),name:name.optional(),description:text.optional(),visibility:z.enum(['private','public']).optional(),status:projectStatus.optional()}).parse(req.body);
    if(d.visibility&&d.visibility!==p.visibility)ownProject(p);
    transaction(()=>{const r=run('UPDATE projects SET name=?,description=?,visibility=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?',d.name??p.name,d.description??p.description,d.visibility??p.visibility,d.status??p.status,now(),p.id,d.version);if(!r.changes)throw new ApiError(409,'Dự án đã được cập nhật. Hãy tải lại.','VERSION_CONFLICT');audit(uid(res),p.id,'project.updated',d.status||d.name||'');});
    res.json({project:projectShape(getProject(p.id,res))});
  }));
  app.post('/api/projects/:id/lock',authenticated,route((req,res)=>{
    const p=getProject(String(req.params.id),res);ownProject(p);const d=z.object({locked:z.boolean()}).parse(req.body);
    transaction(()=>{run('UPDATE projects SET locked=?,version=version+1,updated_at=? WHERE id=?',d.locked?1:0,now(),p.id);audit(uid(res),p.id,d.locked?'project.locked':'project.unlocked');});res.json({project:projectShape(getProject(p.id,res))});
  }));
  app.delete('/api/projects/:id',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res);ownProject(p);transaction(()=>{run('UPDATE projects SET deleted_at=?,version=version+1,updated_at=? WHERE id=?',now(),now(),p.id);audit(uid(res),p.id,'project.deleted');});res.json({ok:true});}));
  app.post('/api/projects/:id/restore',authenticated,route((req,res)=>{const p=one('SELECT * FROM projects WHERE id=?',req.params.id);if(!p||p.owner_id!==uid(res))throw new ApiError(404,'Dự án không tồn tại.');transaction(()=>{run('UPDATE projects SET deleted_at=NULL,version=version+1,updated_at=? WHERE id=?',now(),p.id);audit(uid(res),p.id,'project.restored');});res.json({project:projectShape(getProject(p.id,res))});}));
  app.post('/api/projects/:id/duplicate',authenticated,route((req,res)=>{
    const source=getProject(String(req.params.id),res);
    const projectId=duplicateProjectPlanning(context,source,uid(res));
    res.status(201).json({project:projectShape(getProject(projectId,res))});
  }));
  app.post('/api/projects/:id/tasks',authenticated,route((req,res)=>{
    const p=getProject(String(req.params.id),res);const d=taskSchema.parse(req.body);
    const customerRequest=p.role==='customer'&&['bug','request'].includes(d.type||'task');
    if((!['owner','manager','developer'].includes(p.role)&&!customerRequest)||(p.locked&&p.role!=='owner'))throw new ApiError(403,p.locked?'Dự án đang khóa.':'Bạn không có quyền tạo nhiệm vụ này.');
    if(customerRequest&&d.assigneeId&&d.assigneeId!==uid(res))throw new ApiError(403,'Khách hàng không có quyền giao việc cho thành viên khác.');
    checkAssignee(p.id,d.assigneeId);const taskId=id();
    transaction(()=>{run('INSERT INTO tasks(id,project_id,title,description,type,priority,assignee_id,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',taskId,p.id,d.title,d.description||'',d.type||'task',d.priority||'normal',d.assigneeId||null,d.dueDate||null,uid(res),now(),now());audit(uid(res),p.id,'task.created',d.title);if(d.assigneeId&&d.assigneeId!==uid(res))notify(d.assigneeId,'task',`Bạn được giao: ${d.title}`,`/projects/${p.id}`);run('UPDATE projects SET updated_at=? WHERE id=?',now(),p.id);});res.status(201).json({task:taskShape(one('SELECT * FROM tasks WHERE id=?',taskId)!)});
  }));
  app.patch('/api/projects/:id/tasks/:taskId',authenticated,route((req,res)=>{
    const p=getProject(String(req.params.id),res,true);const t=one('SELECT * FROM tasks WHERE id=? AND project_id=?',req.params.taskId,p.id);if(!t)throw new ApiError(404,'Nhiệm vụ không tồn tại.');
    const d=taskSchema.partial().extend({version:z.number().int().positive(),status:taskStatus.optional()}).parse(req.body);checkAssignee(p.id,d.assigneeId);
    transaction(()=>{const result=run('UPDATE tasks SET title=?,description=?,type=?,priority=?,status=?,assignee_id=?,due_date=?,version=version+1,updated_at=? WHERE id=? AND version=?',d.title??t.title,d.description??t.description,d.type??t.type,d.priority??t.priority,d.status??t.status,d.assigneeId===undefined?t.assignee_id:d.assigneeId,d.dueDate===undefined?t.due_date:d.dueDate,now(),t.id,d.version);if(!result.changes)throw new ApiError(409,'Nhiệm vụ đã thay đổi. Hãy tải lại trước khi lưu.','VERSION_CONFLICT');audit(uid(res),p.id,'task.updated',`${d.title||t.title}: ${d.status||t.status}`);if(d.assigneeId&&d.assigneeId!==t.assignee_id&&d.assigneeId!==uid(res))notify(d.assigneeId,'task',`Bạn được giao: ${d.title||t.title}`,`/projects/${p.id}`);run('UPDATE projects SET updated_at=? WHERE id=?',now(),p.id);});res.json({task:taskShape(one('SELECT * FROM tasks WHERE id=?',t.id)!)});
  }));
  app.delete('/api/projects/:id/tasks/:taskId',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res,true);manageProject(p);const t=one('SELECT * FROM tasks WHERE id=? AND project_id=?',req.params.taskId,p.id);if(!t)throw new ApiError(404,'Nhiệm vụ không tồn tại.');if(one('SELECT 1 FROM customer_requests WHERE task_id=?',t.id)||one('SELECT 1 FROM project_revisions WHERE task_id=?',t.id)||one('SELECT 1 FROM ai_plan_tasks WHERE task_id=?',t.id))throw new ApiError(409,'Nhiệm vụ này giữ lịch sử yêu cầu Studio. Hãy đổi trạng thái hoặc lưu trữ dự án thay vì xóa.','REQUEST_HISTORY');transaction(()=>{run('DELETE FROM tasks WHERE id=?',t.id);audit(uid(res),p.id,'task.deleted',t.title);});res.json({ok:true});}));
  app.post('/api/projects/:id/invitations',authenticated,route((req,res)=>{
    const p=getProject(String(req.params.id),res,true);manageProject(p);const d=z.object({email,role:memberRole}).parse(req.body);const existing=one('SELECT id FROM users WHERE email=?',d.email);
    if(existing&&one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',p.id,existing.id))throw new ApiError(409,'Người dùng đã là thành viên.');
    if(one("SELECT 1 FROM invitations WHERE project_id=? AND email=? AND status='pending'",p.id,d.email))throw new ApiError(409,'Lời mời đang chờ phản hồi.');
    const invitationId=id();transaction(()=>{run('INSERT INTO invitations(id,project_id,email,role,inviter_id,created_at) VALUES(?,?,?,?,?,?)',invitationId,p.id,d.email,d.role,uid(res),now());audit(uid(res),p.id,'member.invited',d.email);if(existing)notify(existing.id,'invitation',`Bạn được mời tham gia ${p.name}`,'/projects');});res.status(201).json({invitation:{id:invitationId,projectId:p.id,email:d.email,role:d.role,status:'pending'}});
  }));
  app.get('/api/invitations',authenticated,(_req,res)=>res.json({invitations:all("SELECT i.*,p.name AS project_name,u.name AS inviter_name FROM invitations i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.inviter_id WHERE i.email=? AND i.status='pending' AND p.deleted_at IS NULL ORDER BY i.created_at DESC",res.locals.user.email).map(i=>({id:i.id,projectId:i.project_id,projectName:i.project_name,email:i.email,role:i.role,inviterName:i.inviter_name,createdAt:i.created_at}))}));
  app.post('/api/invitations/:id/accept',authenticated,route((req,res)=>{
    requireVerifiedEmail({one},res);
    const i=one("SELECT i.*,p.name AS project_name,p.locked,p.deleted_at FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.id=? AND i.email=? AND i.status='pending'",req.params.id,res.locals.user.email);if(!i||i.deleted_at)throw new ApiError(404,'Lời mời không tồn tại.');if(i.locked)throw new ApiError(403,'Dự án đang khóa. Chủ dự án cần mở khóa trước.');
    transaction(()=>{run('INSERT OR IGNORE INTO project_members VALUES(?,?,?,?)',i.project_id,uid(res),i.role,now());run("UPDATE invitations SET status='accepted',accepted_at=? WHERE id=?",now(),i.id);audit(uid(res),i.project_id,'member.joined',res.locals.user.name);notify(i.inviter_id,'member',`${res.locals.user.name} đã tham gia ${i.project_name}`,`/projects/${i.project_id}`);});res.json({project:projectShape(getProject(i.project_id,res))});
  }));
  app.post('/api/invitations/:id/decline',authenticated,route((req,res)=>{run("UPDATE invitations SET status='revoked' WHERE id=? AND email=? AND status='pending'",req.params.id,res.locals.user.email);res.json({ok:true});}));
  app.patch('/api/projects/:id/members/:userId',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res,true);ownProject(p);const d=z.object({role:memberRole}).parse(req.body);if(req.params.userId===p.owner_id)throw new ApiError(400,'Không thể thay đổi vai trò chủ dự án.');if(!run('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?',d.role,p.id,req.params.userId).changes)throw new ApiError(404,'Thành viên không tồn tại.');audit(uid(res),p.id,'member.role_changed',`${req.params.userId}: ${d.role}`);res.json({members:members(p.id)});}));
  app.delete('/api/projects/:id/members/:userId',authenticated,route((req,res)=>{const p=getProject(String(req.params.id),res);if(p.role!=='owner'&&req.params.userId!==uid(res))throw new ApiError(403,'Không có quyền xóa thành viên.');if(p.locked&&p.role!=='owner')throw new ApiError(403,'Dự án đang khóa.');if(req.params.userId===p.owner_id)throw new ApiError(400,'Chủ dự án không thể rời dự án.');transaction(()=>{run('UPDATE tasks SET assignee_id=NULL,version=version+1 WHERE project_id=? AND assignee_id=?',p.id,req.params.userId);run('DELETE FROM project_members WHERE project_id=? AND user_id=?',p.id,req.params.userId);audit(uid(res),p.id,'member.removed',String(req.params.userId));});res.json({ok:true});}));
  app.get('/api/notifications',authenticated,(_req,res)=>res.json({notifications:all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100',uid(res)).map(n=>({id:n.id,type:n.type,title:n.title,href:n.href,readAt:n.read_at,createdAt:n.created_at}))}));
  app.post('/api/notifications/read-all',authenticated,(_req,res)=>{run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL',now(),uid(res));res.json({ok:true});});
  app.post('/api/notifications/:id/read',authenticated,(req,res)=>{run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?',now(),req.params.id,uid(res));res.json({ok:true});});
  const requestShape=(r:Row)=>({id:r.id,projectId:r.project_id,taskId:r.task_id,name:r.name,description:r.description,productType:r.product_type,platform:r.platform,features:r.features,acceptanceCriteria:r.acceptance_criteria,priority:r.priority,status:r.status,createdAt:r.created_at});
  app.get('/api/studio/requests',authenticated,(_req,res)=>res.json({requests:all('SELECT * FROM customer_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 100',uid(res)).map(requestShape)}));
  app.post('/api/studio/requests',authenticated,route((req,res)=>{
    const d=z.object({name,description:text.min(1),productType:z.enum(['game','web','software']),platform:short.optional(),features:text.optional(),acceptanceCriteria:text.optional(),priority:z.enum(['low','normal','high']).optional()}).parse(req.body);
    const requestId=id(),projectId=id(),taskId=id(),createdAt=now();
    const priority=d.priority||'normal';
    transaction(()=>{
      run('INSERT INTO projects(id,owner_id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',projectId,uid(res),d.name,d.description,'private',createdAt,createdAt);
      run('INSERT INTO project_members VALUES(?,?,?,?)',projectId,uid(res),'owner',createdAt);
      const taskDescription=[d.description,`Loại sản phẩm: ${d.productType}`,d.platform?`Nền tảng: ${d.platform}`:'',d.features?`Tính năng:\n${d.features}`:'',d.acceptanceCriteria?`Điều kiện nghiệm thu:\n${d.acceptanceCriteria}`:'','Đã lưu yêu cầu. Chưa kết nối nhà cung cấp AI; chưa thực hiện phân tích hoặc chạy tác vụ AI.'].filter(Boolean).join('\n\n');
      run('INSERT INTO tasks(id,project_id,title,description,type,priority,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',taskId,projectId,`Yêu cầu: ${d.name}`.slice(0,100),taskDescription,'request',priority,uid(res),createdAt,createdAt);
      run('INSERT INTO customer_requests(id,user_id,project_id,task_id,name,description,product_type,platform,features,acceptance_criteria,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',requestId,uid(res),projectId,taskId,d.name,d.description,d.productType,d.platform||'',d.features||'',d.acceptanceCriteria||'',priority,createdAt);
      audit(uid(res),projectId,'studio.request_received',requestId);
      notify(uid(res),'request',`Đã lưu yêu cầu: ${d.name}`,`/projects/${projectId}`);
    });
    res.status(201).json({request:requestShape(one('SELECT * FROM customer_requests WHERE id=?',requestId)!),project:projectShape(getProject(projectId,res))});
  }));
  app.get('/api/admin',authenticated,route((_req,res)=>{if(!JSON.parse(res.locals.user.roles).includes('admin'))throw new ApiError(403,'Cần quyền quản trị viên.');res.json({users:all('SELECT id,name,email,roles,created_at FROM users ORDER BY created_at').map(u=>({id:u.id,name:u.name,email:u.email,roles:JSON.parse(u.roles),createdAt:u.created_at})),activity:all('SELECT a.id,a.action,a.detail,a.created_at AS createdAt,u.name AS actorName FROM activity a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100'),health:{database:'ok',schemaVersion:one('SELECT MAX(version) AS n FROM schema_migrations')?.n}});}));
  const context: ModuleContext = {app,db,dataDir:options.dataDir,one,all,run,transaction,authenticated,uid,route,getProject,manageProject,ownProject,notify,audit};
  const identity = registerIdentity(context, {...options.identity, publicOrigin: options.identity?.publicOrigin || options.publicOrigin});
  registerCommunity(context);
  const closeProjects = registerProjects(context);
  const ai = registerAI(context,{
    ...options.ai,
    executeApprovedAction: options.ai?.executeApprovedAction || (async (action, actorId) =>
      action.type === 'request_build'
        ? integrations.enqueueApprovedBuild(action, actorId)
        : integrations.enqueueSourceProposal(action, actorId)),
  });
  const integrations = registerIntegrations(context,options.integrations);
  const preview = registerPreview(context,options.preview);
  app.use('/api',(_req,_res,next)=>next(new ApiError(404,'API không tồn tại.')));
  const dist = fileURLToPath(new URL('../dist/',import.meta.url));
  if (process.env.NODE_ENV==='production' && existsSync(dist)) {
    app.use(express.static(dist,{index:false}));
    app.get('*',(_req,res)=>res.sendFile('index.html',{root:dist}));
  }
  app.use((err: any,_req:Request,res:Response,_next:NextFunction)=>{
    if(err instanceof ZodError) return res.status(400).json({error:'Dữ liệu không hợp lệ.',details:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
    if(err instanceof HttpError) return res.status(err.status).json({error:err.message,...(err.code?{code:err.code}:{})});
    if(err instanceof Error && ['TASK_BLOCKED','DEPENDENCY_PROJECT','DEPENDENCY_CYCLE'].some(code=>err.message.includes(code))) return res.status(409).json({error:'Nhiệm vụ còn phụ thuộc hoặc checklist chưa hoàn tất.',code:'TASK_BLOCKED'});
    if(err.type==='entity.too.large') return res.status(413).json({error:'Yêu cầu vượt quá 256 KiB.'});
    if(err instanceof SyntaxError && 'body' in err) return res.status(400).json({error:'JSON không hợp lệ.'});
    console.error('API error:',err instanceof Error?err.message:'unknown');
    return res.status(500).json({error:'Lỗi máy chủ. Vui lòng thử lại.'});
  });
  let servicesStopped = false;
  let databaseClosed = false;
  const stopServices = () => {
    if (servicesStopped) return;
    servicesStopped = true;
    preview.close();
    integrations.close();
    ai.close();
    closeProjects();
    identity.close();
  };
  return {app,db,ai,integrations,stopServices,close:()=>{
    stopServices();
    if (!databaseClosed) {databaseClosed=true;db.close();}
  }};
}
