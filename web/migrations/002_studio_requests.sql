CREATE TABLE customer_requests (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 name TEXT NOT NULL,
 description TEXT NOT NULL,
 product_type TEXT NOT NULL CHECK(product_type IN ('game','web','software')),
 platform TEXT NOT NULL DEFAULT '',
 features TEXT NOT NULL DEFAULT '',
 acceptance_criteria TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
 status TEXT NOT NULL DEFAULT 'awaiting_provider' CHECK(status IN ('awaiting_provider')),
 created_at TEXT NOT NULL
);
CREATE INDEX customer_requests_user ON customer_requests(user_id,created_at DESC);
INSERT INTO schema_migrations(version,applied_at) VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
