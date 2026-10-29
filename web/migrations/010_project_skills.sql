CREATE TABLE project_ai_skills (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, source_url TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL,
 roles_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX project_skill_source ON project_ai_skills(project_id,source_url);
ALTER TABLE ai_jobs ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
INSERT INTO schema_migrations(version,applied_at) VALUES(10,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
