import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { HttpError, type ModuleContext, type Row } from './context.js';

const title = z.string().trim().min(2).max(200);
const description = z.string().trim().max(20000);
const version = z.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Ngày không hợp lệ.');
const now = () => new Date().toISOString();

/** Copy planning content without copying access grants, progress or historical outcomes. */
export function duplicateProjectPlanning(ctx: ModuleContext, sourceProject: Row, actorId: string): string {
  const { all, one, run, transaction, audit } = ctx;
  if (!one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', sourceProject.id, actorId))
    throw new HttpError(403, 'Chỉ thành viên được sao chép dự án.');
  const projectId = randomUUID(), createdAt = now();
  transaction(() => {
    run('INSERT INTO projects(id,owner_id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', projectId, actorId, `${sourceProject.name} (bản sao)`.slice(0, 100), sourceProject.description, 'private', createdAt, createdAt);
    run('INSERT INTO project_members VALUES(?,?,?,?)', projectId, actorId, 'owner', createdAt);
    const taskIds = new Map<string, string>();
    for (const task of all('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id', sourceProject.id)) {
      const taskId = randomUUID(); taskIds.set(task.id, taskId);
      run('INSERT INTO tasks(id,project_id,title,description,type,priority,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', taskId, projectId, task.title, task.description, task.type, task.priority, task.due_date, actorId, createdAt, createdAt);
    }
    for (const d of all('SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', sourceProject.id)) {
      const taskId = taskIds.get(d.task_id), dependsOnId = taskIds.get(d.depends_on_id);
      if (!taskId || !dependsOnId) throw new HttpError(409, 'Phụ thuộc của dự án nguồn không hợp lệ.');
      run('INSERT INTO task_dependencies VALUES(?,?,?,?)', taskId, dependsOnId, actorId, createdAt);
    }
    for (const c of all('SELECT c.* FROM task_checklists c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=?', sourceProject.id)) {
      run('INSERT INTO task_checklists(id,task_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)', randomUUID(), taskIds.get(c.task_id)!, c.title, actorId, createdAt, createdAt);
    }
    for (const m of all('SELECT * FROM project_milestones WHERE project_id=?', sourceProject.id)) {
      run('INSERT INTO project_milestones(id,project_id,title,description,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), projectId, m.title, m.description, m.due_date, actorId, createdAt, createdAt);
    }
    audit(actorId, projectId, 'project.duplicated', sourceProject.id);
  });
  return projectId;
}

/** Project roles grant capabilities, independently of system administrator roles. */
export function projectPermissions(role: string | null, locked: boolean) {
  const write = !locked || role === 'owner';
  return {
    view: !!role,
    editProject: write && ['owner', 'manager'].includes(role || ''),
    editTasks: write && ['owner', 'manager', 'developer', 'tester'].includes(role || ''),
    editTaskDetails: write && ['owner', 'manager', 'developer'].includes(role || ''),
    createTasks: write && ['owner', 'manager', 'developer'].includes(role || ''),
    reportBugs: write && !!role && role !== 'viewer',
    manageTasks: write && ['owner', 'manager'].includes(role || ''),
    reviewTasks: write && ['owner', 'manager', 'reviewer', 'tester'].includes(role || ''),
    submitRequest: write && !!role && role !== 'viewer',
    comment: write && !!role && role !== 'viewer',
    manageMembers: write && role === 'owner',
    inviteMembers: write && ['owner', 'manager'].includes(role || ''),
    manageVersions: write && ['owner', 'manager'].includes(role || ''),
    changeVisibility: role === 'owner',
    lockProject: role === 'owner',
    deleteProject: role === 'owner',
    viewSource: ['owner', 'manager', 'developer', 'tester', 'reviewer'].includes(role || ''),
    editSource: write && ['owner', 'manager', 'developer'].includes(role || ''),
    connectRepository: write && role === 'owner',
    runBuild: write && ['owner', 'manager', 'developer', 'tester'].includes(role || ''),
    downloadArtifact: ['owner', 'manager', 'developer', 'tester', 'reviewer'].includes(role || ''),
    publishRelease: write && role === 'owner',
  };
}

export function registerProjects(ctx: ModuleContext) {
  const { app, db, one, all, run, transaction, authenticated, uid, route, getProject, audit, notify } = ctx;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const streams = new Set<Response>();
  const streamCounts = new Map<string, number>();
  const permissions = (p: Row) => projectPermissions(p.role, !!p.locked);
  const requireCapability = (p: Row, capability: keyof ReturnType<typeof projectPermissions>) => {
    if (!permissions(p)[capability]) throw new HttpError(403, p.locked ? 'Dự án đang khóa.' : 'Vai trò của bạn không có quyền thực hiện thao tác này.');
  };
  const task = (projectId: string, taskId: string) => {
    const item = one('SELECT * FROM tasks WHERE id=? AND project_id=?', taskId, projectId);
    if (!item) throw new HttpError(404, 'Nhiệm vụ không tồn tại trong dự án.');
    return item;
  };
  const bumpTask = (taskId: string, expected: number) => {
    if (!run('UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?', now(), taskId, expected).changes)
      throw new HttpError(409, 'Nhiệm vụ đã thay đổi. Hãy tải lại trước khi lưu.', 'VERSION_CONFLICT');
  };
  const taskShape = (t: Row) => ({ id: t.id, projectId: t.project_id, title: t.title, description: t.description, type: t.type, status: t.status, priority: t.priority, assigneeId: t.assignee_id, dueDate: t.due_date, version: t.version, createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at });
  const milestoneShape = (m: Row) => ({ id: m.id, projectId: m.project_id, title: m.title, description: m.description, dueDate: m.due_date, status: m.status, version: m.version, createdAt: m.created_at, updatedAt: m.updated_at });
  const checklistShape = (c: Row) => ({ id: c.id, taskId: c.task_id, title: c.title, done: !!c.done, version: c.version, createdAt: c.created_at, updatedAt: c.updated_at });
  const versionShape = (v: Row, includeSnapshot = false) => ({ id: v.id, projectId: v.project_id, label: v.label, changelog: v.changelog, createdBy: v.created_by, createdAt: v.created_at, ...(includeSnapshot ? { snapshot: JSON.parse(v.snapshot) } : {}) });
  const reviewShape = (r: Row) => ({ id: r.id, taskId: r.task_id, reviewerId: r.reviewer_id, decision: r.decision, comment: r.comment, taskVersion: r.task_version, createdAt: r.created_at });
  const dependencies = (projectId: string) => all('SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', projectId)
    .map(d => ({ taskId: d.task_id, dependsOnId: d.depends_on_id, createdAt: d.created_at }));
  const checklists = (projectId: string) => all('SELECT c.* FROM task_checklists c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=? ORDER BY c.created_at,c.id', projectId).map(checklistShape);
  const health = (projectId: string) => {
    const today = now().slice(0, 10);
    const tasks = all('SELECT * FROM tasks WHERE project_id=?', projectId);
    const blocked = all("SELECT DISTINCT t.id FROM tasks t JOIN task_dependencies d ON d.task_id=t.id JOIN tasks p ON p.id=d.depends_on_id WHERE t.project_id=? AND t.status<>'done' AND p.status<>'done'", projectId).map(r => r.id);
    const overdue = tasks.filter(t => t.status !== 'done' && t.due_date && t.due_date < today).map(t => t.id);
    const unassigned = tasks.filter(t => t.status !== 'done' && !t.assignee_id).map(t => t.id);
    const done = tasks.filter(t => t.status === 'done').length;
    return { taskCount: tasks.length, doneCount: done, progress: tasks.length ? Math.round(done / tasks.length * 100) : 0, blockedTaskIds: blocked, overdueTaskIds: overdue, unassignedTaskIds: unassigned, empty: !tasks.length, status: !tasks.length ? 'empty' : overdue.length ? 'at_risk' : blocked.length ? 'blocked' : done === tasks.length ? 'completed' : 'on_track' };
  };

  app.get('/api/projects-trash', authenticated, route((_req, res) => {
    res.json({ projects: all('SELECT id,name,description,visibility,status,deleted_at,version FROM projects WHERE owner_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200', uid(res)).map(p => ({ id: p.id, name: p.name, description: p.description, visibility: p.visibility, status: p.status, deletedAt: p.deleted_at, version: p.version })), purgePolicy: { retentionDays: 7, confirmationRequired: true, retainedRecords: 'Studio requests, AI usage and build history prevent permanent deletion.' } });
  }));
  app.delete('/api/projects/:id/permanent', authenticated, route((req, res) => {
    const d = z.object({ version, confirmation: title, confirmPermanent: z.literal(true) }).parse(req.body);
    const p = one('SELECT * FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NOT NULL', req.params.id, uid(res));
    if (!p) throw new HttpError(404, 'Chỉ chủ dự án được xóa vĩnh viễn một dự án trong thùng rác.');
    if (d.confirmation !== p.name) throw new HttpError(400, 'Nhập chính xác tên dự án để xác nhận xóa vĩnh viễn.');
    if (p.version !== d.version) throw new HttpError(409, 'Dự án đã thay đổi. Hãy tải lại.', 'VERSION_CONFLICT');
    if (Date.now() - new Date(p.deleted_at).valueOf() < 7 * 86400000) throw new HttpError(409, 'Dự án phải ở trong thùng rác ít nhất 7 ngày trước khi xóa vĩnh viễn.', 'RETENTION_POLICY');
    const retained = ['customer_requests', 'ai_jobs', 'build_jobs', 'repository_links', 'github_proposals', 'source_workspaces'].filter(table => one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table));
    for (const table of retained) {
      if (one(`SELECT 1 FROM ${table} WHERE project_id=? LIMIT 1`, p.id)) throw new HttpError(409, 'Dự án có lịch sử tích hợp hoặc yêu cầu cần lưu giữ. Hãy lưu trữ dự án.', 'RETENTION_POLICY');
    }
    try {
      transaction(() => {
        run('DELETE FROM projects WHERE id=? AND owner_id=? AND version=?', p.id, uid(res), d.version);
        audit(uid(res), null, 'project.permanently_deleted', p.id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('FOREIGN KEY')) throw new HttpError(409, 'Dự án có lịch sử liên kết cần lưu giữ. Hãy lưu trữ dự án.', 'RETENTION_POLICY');
      throw error;
    }
    res.json({ ok: true, permanentlyDeleted: true });
  }));
  app.get('/api/projects/:id/planning', route((req, res) => {
    const p = getProject(String(req.params.id), res);
    res.json({
      milestones: all('SELECT * FROM project_milestones WHERE project_id=? ORDER BY due_date IS NULL,due_date,created_at', p.id).map(milestoneShape),
      versions: all('SELECT * FROM project_versions WHERE project_id=? ORDER BY created_at DESC LIMIT 100', p.id).map(v => versionShape(v)),
      dependencies: dependencies(p.id), checklists: checklists(p.id),
      reviews: all('SELECT * FROM task_reviews WHERE project_id=? ORDER BY created_at DESC LIMIT 200', p.id).map(reviewShape),
      revisions: all('SELECT id,source_task_id AS sourceTaskId,task_id AS taskId,requested_by AS requestedBy,reason,created_at AS createdAt FROM project_revisions WHERE project_id=? ORDER BY created_at DESC LIMIT 200', p.id),
      permissions: permissions(p), health: health(p.id),
    });
  }));
  app.post('/api/projects/:id/milestones', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editProject');
    const d = z.object({ title, description: description.optional(), dueDate: date.nullable().optional() }).parse(req.body);
    const milestoneId = randomUUID(), createdAt = now();
    transaction(() => {
      run('INSERT INTO project_milestones(id,project_id,title,description,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', milestoneId, p.id, d.title, d.description || '', d.dueDate || null, uid(res), createdAt, createdAt);
      audit(uid(res), p.id, 'milestone.created', d.title);
    });
    res.status(201).json({ milestone: milestoneShape(one('SELECT * FROM project_milestones WHERE id=?', milestoneId)!) });
  }));
  app.patch('/api/projects/:id/milestones/:milestoneId', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editProject');
    const d = z.object({ version, title: title.optional(), description: description.optional(), dueDate: date.nullable().optional(), status: z.enum(['planned', 'active', 'done']).optional() }).parse(req.body);
    const m = one('SELECT * FROM project_milestones WHERE id=? AND project_id=?', req.params.milestoneId, p.id);
    if (!m) throw new HttpError(404, 'Mốc dự án không tồn tại.');
    transaction(() => {
      if (!run('UPDATE project_milestones SET title=?,description=?,due_date=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?', d.title ?? m.title, d.description ?? m.description, d.dueDate === undefined ? m.due_date : d.dueDate, d.status ?? m.status, now(), m.id, d.version).changes) throw new HttpError(409, 'Mốc dự án đã thay đổi.', 'VERSION_CONFLICT');
      audit(uid(res), p.id, 'milestone.updated', m.id);
    });
    res.json({ milestone: milestoneShape(one('SELECT * FROM project_milestones WHERE id=?', m.id)!) });
  }));
  app.post('/api/projects/:id/versions', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'manageVersions');
    const d = z.object({ label: z.string().trim().min(1).max(80), changelog: description.min(1) }).parse(req.body);
    if (one('SELECT 1 FROM project_versions WHERE project_id=? AND label=?', p.id, d.label)) throw new HttpError(409, 'Nhãn phiên bản đã tồn tại.');
    const versionId = randomUUID();
    transaction(() => {
      const snapshot = { project: { name: p.name, description: p.description, status: p.status, version: p.version }, tasks: all('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id', p.id).map(taskShape), milestones: all('SELECT * FROM project_milestones WHERE project_id=?', p.id).map(milestoneShape), dependencies: dependencies(p.id), checklists: checklists(p.id) };
      run('INSERT INTO project_versions VALUES(?,?,?,?,?,?,?)', versionId, p.id, d.label, d.changelog, JSON.stringify(snapshot), uid(res), now());
      audit(uid(res), p.id, 'project.version_created', d.label);
    });
    res.status(201).json({ version: versionShape(one('SELECT * FROM project_versions WHERE id=?', versionId)!, true) });
  }));
  app.get('/api/projects/:id/versions/:versionId', route((req, res) => {
    const p = getProject(String(req.params.id), res);
    const v = one('SELECT * FROM project_versions WHERE id=? AND project_id=?', req.params.versionId, p.id);
    if (!v) throw new HttpError(404, 'Phiên bản không tồn tại.');
    res.json({ version: versionShape(v, true) });
  }));
  app.post('/api/projects/:id/tasks/:taskId/dependencies', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editTasks');
    const t = task(p.id, String(req.params.taskId));
    const d = z.object({ dependsOnId: z.string().uuid(), version }).parse(req.body);
    task(p.id, d.dependsOnId);
    if (t.id === d.dependsOnId) throw new HttpError(409, 'Nhiệm vụ không thể phụ thuộc chính nó.', 'DEPENDENCY_CYCLE');
    if (one('SELECT 1 FROM task_dependencies WHERE task_id=? AND depends_on_id=?', t.id, d.dependsOnId)) throw new HttpError(409, 'Phụ thuộc đã tồn tại.');
    transaction(() => {
      bumpTask(t.id, d.version);
      run('INSERT INTO task_dependencies VALUES(?,?,?,?)', t.id, d.dependsOnId, uid(res), now());
      audit(uid(res), p.id, 'task.dependency_added', `${t.id}:${d.dependsOnId}`);
    });
    res.status(201).json({ task: taskShape(task(p.id, t.id)), dependencies: dependencies(p.id) });
  }));
  app.delete('/api/projects/:id/tasks/:taskId/dependencies/:dependsOnId', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editTasks');
    const t = task(p.id, String(req.params.taskId)); const d = z.object({ version }).parse(req.body);
    transaction(() => {
      bumpTask(t.id, d.version);
      if (!run('DELETE FROM task_dependencies WHERE task_id=? AND depends_on_id=?', t.id, req.params.dependsOnId).changes) throw new HttpError(404, 'Phụ thuộc không tồn tại.');
      audit(uid(res), p.id, 'task.dependency_removed', `${t.id}:${req.params.dependsOnId}`);
    });
    res.json({ task: taskShape(task(p.id, t.id)), dependencies: dependencies(p.id) });
  }));
  app.post('/api/projects/:id/tasks/:taskId/checklist', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editTasks');
    const t = task(p.id, String(req.params.taskId)); const d = z.object({ title }).parse(req.body);
    if (one('SELECT COUNT(*) AS n FROM task_checklists WHERE task_id=?', t.id)!.n >= 100) throw new HttpError(409, 'Mỗi nhiệm vụ tối đa 100 mục kiểm tra.');
    const checklistId = randomUUID(), createdAt = now();
    transaction(() => {
      run('INSERT INTO task_checklists(id,task_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)', checklistId, t.id, d.title, uid(res), createdAt, createdAt);
      audit(uid(res), p.id, 'task.checklist_created', t.id);
    });
    res.status(201).json({ item: checklistShape(one('SELECT * FROM task_checklists WHERE id=?', checklistId)!) });
  }));
  app.patch('/api/projects/:id/tasks/:taskId/checklist/:itemId', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editTasks'); task(p.id, String(req.params.taskId));
    const d = z.object({ version, title: title.optional(), done: z.boolean().optional() }).parse(req.body);
    const item = one('SELECT * FROM task_checklists WHERE id=? AND task_id=?', req.params.itemId, req.params.taskId);
    if (!item) throw new HttpError(404, 'Mục kiểm tra không tồn tại.');
    transaction(() => {
      if (!run('UPDATE task_checklists SET title=?,done=?,version=version+1,updated_at=? WHERE id=? AND version=?', d.title ?? item.title, d.done === undefined ? item.done : Number(d.done), now(), item.id, d.version).changes) throw new HttpError(409, 'Mục kiểm tra đã thay đổi.', 'VERSION_CONFLICT');
      audit(uid(res), p.id, 'task.checklist_updated', item.task_id);
    });
    res.json({ item: checklistShape(one('SELECT * FROM task_checklists WHERE id=?', item.id)!) });
  }));
  app.delete('/api/projects/:id/tasks/:taskId/checklist/:itemId', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'editTasks'); task(p.id, String(req.params.taskId));
    const d = z.object({ version }).parse(req.body);
    const item = one('SELECT * FROM task_checklists WHERE id=? AND task_id=?', req.params.itemId, req.params.taskId);
    if (!item) throw new HttpError(404, 'Mục kiểm tra không tồn tại.');
    transaction(() => {
      if (!run('DELETE FROM task_checklists WHERE id=? AND version=?', item.id, d.version).changes) throw new HttpError(409, 'Mục kiểm tra đã thay đổi.', 'VERSION_CONFLICT');
      audit(uid(res), p.id, 'task.checklist_deleted', item.task_id);
    });
    res.json({ ok: true });
  }));
  const commentShape = (c: Row) => ({ id: c.id, taskId: c.task_id, body: c.body, author: { id: c.author_id, name: c.author_name }, mentionUserIds: all('SELECT user_id FROM task_comment_mentions WHERE comment_id=?', c.id).map(m => m.user_id), createdAt: c.created_at });
  const comments = (taskId: string, page = 1) => all('SELECT c.*,u.name AS author_name FROM task_comments c JOIN users u ON u.id=c.author_id WHERE c.task_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 200 OFFSET ?', taskId, (page - 1) * 200).reverse().map(commentShape);
  app.get('/api/projects/:id/tasks/:taskId/comments', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res);
    if (!p.role) throw new HttpError(403, 'Bình luận nhiệm vụ chỉ dành cho thành viên dự án.');
    const t = task(p.id, String(req.params.taskId));
    const page = z.coerce.number().int().min(1).max(10000).parse(req.query.page || 1);
    const total = one('SELECT COUNT(*) AS n FROM task_comments WHERE task_id=?', t.id)!.n;
    res.json({ comments: comments(t.id, page), page, hasMore: page * 200 < total, total });
  }));
  app.post('/api/projects/:id/tasks/:taskId/comments', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'comment');
    const t = task(p.id, String(req.params.taskId));
    const d = z.object({ body: description.min(1).max(5000), mentionUserIds: z.array(z.string().uuid()).max(20).optional() }).parse(req.body);
    const mentioned = [...new Set(d.mentionUserIds || [])];
    for (const userId of mentioned) if (!one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', p.id, userId)) throw new HttpError(400, 'Chỉ nhắc đến thành viên trong dự án.');
    const commentId = randomUUID();
    transaction(() => {
      run('INSERT INTO task_comments VALUES(?,?,?,?,?)', commentId, t.id, uid(res), d.body, now());
      for (const userId of mentioned) {
        run('INSERT INTO task_comment_mentions VALUES(?,?)', commentId, userId);
        if (userId !== uid(res)) notify(userId, 'mention', `${res.locals.user.name} nhắc đến bạn trong ${t.title}`, `/projects/${p.id}`);
      }
      audit(uid(res), p.id, 'task.comment_created', t.id);
    });
    res.status(201).json({ comment: commentShape(one('SELECT c.*,u.name AS author_name FROM task_comments c JOIN users u ON u.id=c.author_id WHERE c.id=?', commentId)!) });
  }));
  app.post('/api/projects/:id/revisions', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res); requireCapability(p, 'submitRequest');
    const d = z.object({ title, reason: description.min(1), sourceTaskId: z.string().uuid().optional(), type: z.enum(['request', 'bug']).optional(), priority: z.enum(['low', 'normal', 'high']).optional() }).parse(req.body);
    if (d.sourceTaskId) task(p.id, d.sourceTaskId);
    const taskId = randomUUID(), revisionId = randomUUID(), createdAt = now();
    transaction(() => {
      run('INSERT INTO tasks(id,project_id,title,description,type,priority,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, p.id, d.title, d.reason, d.type || 'request', d.priority || 'normal', uid(res), createdAt, createdAt);
      run('INSERT INTO project_revisions VALUES(?,?,?,?,?,?,?)', revisionId, p.id, d.sourceTaskId || null, taskId, uid(res), d.reason, createdAt);
      audit(uid(res), p.id, 'project.revision_requested', revisionId);
      if (p.owner_id !== uid(res)) notify(p.owner_id, 'revision', `${res.locals.user.name} yêu cầu chỉnh sửa: ${d.title}`, `/projects/${p.id}`);
    });
    res.status(201).json({ revision: { id: revisionId, sourceTaskId: d.sourceTaskId || null, taskId, requestedBy: uid(res), reason: d.reason, createdAt }, task: taskShape(task(p.id, taskId)) });
  }));
  app.post('/api/projects/:id/reviews', authenticated, route((req, res) => {
    const p = getProject(String(req.params.id), res);
    const d = z.object({ taskId: z.string().uuid(), version, decision: z.enum(['approve', 'reject']), comment: description.min(1).max(5000) }).parse(req.body);
    const t = task(p.id, d.taskId);
    const ownCustomerRequest = p.role === 'customer' && t.created_by === uid(res) && ['request', 'bug'].includes(t.type) && !p.locked;
    if (!permissions(p).reviewTasks && !ownCustomerRequest) throw new HttpError(403, p.locked ? 'Dự án đang khóa.' : 'Bạn không có quyền duyệt nhiệm vụ này.');
    if (t.status !== 'review') throw new HttpError(409, 'Chỉ duyệt nhiệm vụ đang chờ kiểm tra.', 'REVIEW_STATE');
    const reviewId = randomUUID();
    transaction(() => {
      if (!run('UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?', d.decision === 'approve' ? 'done' : 'in_progress', now(), t.id, d.version).changes) throw new HttpError(409, 'Nhiệm vụ đã thay đổi.', 'VERSION_CONFLICT');
      run('INSERT INTO task_reviews VALUES(?,?,?,?,?,?,?,?)', reviewId, p.id, t.id, uid(res), d.decision, d.comment, d.version + 1, now());
      audit(uid(res), p.id, d.decision === 'approve' ? 'task.approved' : 'task.revision_required', t.id);
      const recipients = new Set<string>([t.created_by, t.assignee_id].filter(Boolean));
      for (const userId of recipients) if (userId !== uid(res)) notify(userId, 'review', `${t.title}: ${d.decision === 'approve' ? 'đã được duyệt' : 'cần chỉnh sửa'}`, `/projects/${p.id}`);
    });
    res.status(201).json({ review: reviewShape(one('SELECT * FROM task_reviews WHERE id=?', reviewId)!), task: taskShape(task(p.id, t.id)) });
  }));

  // Each stream rechecks its session and membership; role revocation does not wait for reconnect.
  function stream(req: Request, res: Response, projectId?: string) {
    if (projectId && !getProject(projectId, res).role) throw new HttpError(403, 'Luồng cập nhật chỉ dành cho thành viên.');
    const userId = uid(res), sessionId = res.locals.session?.id;
    if ((streamCounts.get(userId) || 0) >= 5) throw new HttpError(429, 'Tối đa 5 luồng cập nhật cho mỗi tài khoản.');
    streamCounts.set(userId, (streamCounts.get(userId) || 0) + 1);
    const started = Date.now();
    let previous = '', ticks = 0, closed = false;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const cleanup = () => {
      if (closed) return; closed = true; clearInterval(interval); intervals.delete(interval); streams.delete(res);
      const count = (streamCounts.get(userId) || 1) - 1;
      if (count) streamCounts.set(userId, count); else streamCounts.delete(userId);
    };
    const tick = () => {
      try {
        if (Date.now() - started > 30 * 60000 || res.writableLength > 65536) { res.end(); cleanup(); return; }
        const validSession = sessionId && one('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?', sessionId, userId, now());
        const current = projectId ? one('SELECT p.deleted_at,m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.user_id=?', projectId, userId) : null;
        if (!validSession || (projectId && (!current || current.deleted_at))) { send('access_revoked', {}); send('revoked', {}); res.end(); cleanup(); return; }
        const fingerprint = projectId
          ? { project: one('SELECT version,locked,status,updated_at FROM projects WHERE id=?', projectId), role: current!.role, activity: one('SELECT COUNT(*) AS n,MAX(created_at) AS last FROM activity WHERE project_id=?', projectId) }
          : one('SELECT COUNT(*) AS n,SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,MAX(created_at) AS last FROM notifications WHERE user_id=?', userId);
        const revision = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
        if (revision !== previous) { send(previous ? 'change' : 'ready', { ...(projectId ? { projectId } : {}), revision }); previous = revision; }
        else if (++ticks % 15 === 0) res.write(': keep-alive\n\n');
      } catch { res.end(); cleanup(); }
    };
    const interval = setInterval(tick, 1000); interval.unref(); intervals.add(interval); streams.add(res);
    res.on('close', cleanup); req.on('aborted', cleanup); tick();
  }
  app.get('/api/projects/:id/events', authenticated, route((req, res) => stream(req, res, String(req.params.id))));
  app.get('/api/notifications/events', authenticated, route((req, res) => stream(req, res)));

  return () => { for (const interval of intervals) clearInterval(interval); intervals.clear(); for (const response of streams) response.end(); streams.clear(); streamCounts.clear(); };
}
