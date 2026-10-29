CREATE TABLE github_connections (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), installation_id TEXT NOT NULL,
 account_login TEXT NOT NULL, encrypted_token TEXT, token_expires_at TEXT,
 created_at TEXT NOT NULL, UNIQUE(user_id,installation_id)
);
CREATE TABLE repository_links (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), connection_id TEXT NOT NULL REFERENCES github_connections(id),
 owner TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE github_proposals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), author_id TEXT NOT NULL REFERENCES users(id),
 branch TEXT NOT NULL, base TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 files_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
 pull_url TEXT, error TEXT, created_at TEXT NOT NULL, approved_by TEXT REFERENCES users(id), approved_at TEXT
);
CREATE INDEX github_proposals_project ON github_proposals(project_id,created_at DESC);
CREATE TABLE github_webhooks (
 delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, installation_id TEXT, received_at TEXT NOT NULL,
 payload_hash TEXT NOT NULL
);
CREATE TABLE build_jobs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), author_id TEXT NOT NULL REFERENCES users(id),
 target TEXT NOT NULL CHECK(target='web'), version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','preparing','building','testing','succeeded','failed','cancelled')),
 files_json TEXT NOT NULL, logs TEXT NOT NULL DEFAULT '', exit_code INTEGER,
 artifact_path TEXT, artifact_hash TEXT, artifact_size INTEGER,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX builds_project ON build_jobs(project_id,created_at DESC);
CREATE TABLE build_releases (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), build_id TEXT NOT NULL REFERENCES build_jobs(id),
 version TEXT NOT NULL, changelog TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
 approved_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(project_id,version)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(7,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
