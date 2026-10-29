CREATE TABLE project_members_expanded (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','manager','developer','tester','reviewer','viewer','customer')),
 joined_at TEXT NOT NULL, PRIMARY KEY(project_id,user_id)
);
INSERT INTO project_members_expanded SELECT * FROM project_members;
DROP TABLE project_members;
ALTER TABLE project_members_expanded RENAME TO project_members;
CREATE INDEX member_user ON project_members(user_id,project_id);
CREATE TABLE invitations_expanded (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE,
 role TEXT NOT NULL CHECK(role IN ('manager','developer','tester','reviewer','viewer','customer')),
 inviter_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
 created_at TEXT NOT NULL, accepted_at TEXT
);
INSERT INTO invitations_expanded SELECT * FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_expanded RENAME TO invitations;
CREATE UNIQUE INDEX invitation_pending ON invitations(project_id,email) WHERE status='pending';

CREATE TABLE project_milestones (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT,
 status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','done')),
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX milestone_project ON project_milestones(project_id,created_at);
CREATE TABLE project_versions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 label TEXT NOT NULL, changelog TEXT NOT NULL, snapshot TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(project_id,label)
);
CREATE TABLE task_dependencies (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,depends_on_id), CHECK(task_id<>depends_on_id)
);
CREATE INDEX dependencies_predecessor ON task_dependencies(depends_on_id);
CREATE TABLE task_checklists (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX checklists_task ON task_checklists(task_id,created_at);
CREATE TABLE task_comments (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX task_comments_date ON task_comments(task_id,created_at);
CREATE TABLE task_comment_mentions (
 comment_id TEXT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(comment_id,user_id)
);
CREATE TABLE project_revisions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 requested_by TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE task_reviews (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 reviewer_id TEXT NOT NULL REFERENCES users(id),
 decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
 comment TEXT NOT NULL, task_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX reviews_project ON task_reviews(project_id,created_at DESC);

CREATE TRIGGER task_dependency_same_project BEFORE INSERT ON task_dependencies
WHEN (SELECT project_id FROM tasks WHERE id=NEW.task_id)<>(SELECT project_id FROM tasks WHERE id=NEW.depends_on_id)
BEGIN SELECT RAISE(ABORT,'DEPENDENCY_PROJECT'); END;
CREATE TRIGGER task_dependency_cycle BEFORE INSERT ON task_dependencies
WHEN NEW.task_id=NEW.depends_on_id OR EXISTS(
 WITH RECURSIVE ancestors(id) AS (
  SELECT depends_on_id FROM task_dependencies WHERE task_id=NEW.depends_on_id
  UNION SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
 ) SELECT 1 FROM ancestors WHERE id=NEW.task_id
)
BEGIN SELECT RAISE(ABORT,'DEPENDENCY_CYCLE'); END;
CREATE TRIGGER task_dependency_completed BEFORE INSERT ON task_dependencies
WHEN (SELECT status FROM tasks WHERE id=NEW.task_id)='done' AND (SELECT status FROM tasks WHERE id=NEW.depends_on_id)<>'done'
BEGIN SELECT RAISE(ABORT,'TASK_BLOCKED'); END;
CREATE TRIGGER task_completion_dependencies BEFORE UPDATE OF status ON tasks
WHEN NEW.status='done' AND (
 EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_id WHERE d.task_id=NEW.id AND t.status<>'done')
 OR EXISTS(SELECT 1 FROM task_checklists c WHERE c.task_id=NEW.id AND c.done=0)
)
BEGIN SELECT RAISE(ABORT,'TASK_BLOCKED'); END;
CREATE TRIGGER task_reopen_dependencies BEFORE UPDATE OF status ON tasks
WHEN OLD.status='done' AND NEW.status<>'done' AND EXISTS(
 SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on_id=NEW.id AND t.status='done'
)
BEGIN SELECT RAISE(ABORT,'TASK_BLOCKED'); END;
CREATE TRIGGER checklist_completed_insert BEFORE INSERT ON task_checklists
WHEN NEW.done=0 AND (SELECT status FROM tasks WHERE id=NEW.task_id)='done'
BEGIN SELECT RAISE(ABORT,'TASK_BLOCKED'); END;
CREATE TRIGGER checklist_completed_update BEFORE UPDATE OF done ON task_checklists
WHEN NEW.done=0 AND (SELECT status FROM tasks WHERE id=NEW.task_id)='done'
BEGIN SELECT RAISE(ABORT,'TASK_BLOCKED'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
