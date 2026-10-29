CREATE TABLE source_workspaces (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 created_by TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL CHECK(source IN ('github','local')),
 repository_owner TEXT, repository_name TEXT, base_branch TEXT, base_commit TEXT,
 files_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, file_count INTEGER NOT NULL,
 total_bytes INTEGER NOT NULL, static_supported INTEGER NOT NULL CHECK(static_supported IN (0,1)),
 excluded_paths_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL
);
CREATE INDEX source_workspaces_project ON source_workspaces(project_id,created_at DESC);
ALTER TABLE github_proposals ADD COLUMN workspace_id TEXT REFERENCES source_workspaces(id);
ALTER TABLE github_proposals ADD COLUMN source_base_commit TEXT;
ALTER TABLE github_proposals ADD COLUMN validation_build_id TEXT REFERENCES build_jobs(id);
ALTER TABLE github_proposals ADD COLUMN validation_hash TEXT;
ALTER TABLE github_proposals ADD COLUMN tool_action_id TEXT;
ALTER TABLE github_proposals ADD COLUMN tool_action_hash TEXT;
CREATE UNIQUE INDEX source_proposal_tool_action ON github_proposals(tool_action_id) WHERE tool_action_id IS NOT NULL;
ALTER TABLE build_jobs ADD COLUMN tool_action_id TEXT;
ALTER TABLE build_jobs ADD COLUMN workspace_id TEXT REFERENCES source_workspaces(id);
ALTER TABLE build_jobs ADD COLUMN source_hash TEXT;
CREATE UNIQUE INDEX build_tool_action ON build_jobs(tool_action_id) WHERE tool_action_id IS NOT NULL;
INSERT INTO schema_migrations(version,applied_at) VALUES(9,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
