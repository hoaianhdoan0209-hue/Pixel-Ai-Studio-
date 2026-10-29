CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '["member"]', settings TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS posts (
 id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
 genre TEXT NOT NULL DEFAULT '', technology TEXT NOT NULL DEFAULT '', ai_tools TEXT NOT NULL DEFAULT '',
 platform TEXT NOT NULL DEFAULT 'Web', status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','draft')),
 repository_url TEXT NOT NULL DEFAULT '', play_url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_date ON posts(created_at DESC);
CREATE TABLE IF NOT EXISTS comments (
 id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id), parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
 body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id,created_at);
CREATE TABLE IF NOT EXISTS reactions (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN ('like','bookmark')), PRIMARY KEY(user_id,post_id,type)
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
 status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','development','testing','approval','completed','paused','archived')),
 locked INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','manager','developer','viewer','customer')), joined_at TEXT NOT NULL,
 PRIMARY KEY(project_id,user_id)
);
CREATE INDEX IF NOT EXISTS member_user ON project_members(user_id,project_id);
CREATE TABLE IF NOT EXISTS invitations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('manager','developer','viewer','customer')),
 inviter_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
 created_at TEXT NOT NULL, accepted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS invitation_pending ON invitations(project_id,email) WHERE status='pending';
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','bug','request')),
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
 assignee_id TEXT REFERENCES users(id), due_date TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id,created_at);
CREATE TABLE IF NOT EXISTS activity (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL, title TEXT NOT NULL, href TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at DESC);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
