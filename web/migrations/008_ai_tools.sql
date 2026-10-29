ALTER TABLE ai_jobs ADD COLUMN agent_role TEXT CHECK(agent_role IN ('planner','game_designer','ui_designer','developer','tester','reviewer','build_engineer','coordinator'));
ALTER TABLE ai_jobs ADD COLUMN tools_enabled INTEGER NOT NULL DEFAULT 0 CHECK(tools_enabled IN (0,1));
CREATE TABLE ai_extended_agent_settings (
 role TEXT PRIMARY KEY CHECK(role IN ('game_designer','ui_designer','tester','build_engineer','coordinator')),
 provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')), model TEXT NOT NULL,
 updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE TABLE ai_tool_calls (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ai_jobs(id), call_id TEXT NOT NULL,
 name TEXT NOT NULL, arguments_json TEXT NOT NULL, result_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('completed','failed')), error TEXT,
 created_at TEXT NOT NULL, UNIQUE(job_id,call_id)
);
CREATE INDEX ai_tools_job ON ai_tool_calls(job_id,created_at);
CREATE TABLE ai_tool_proposals (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ai_jobs(id),
 project_id TEXT NOT NULL REFERENCES projects(id), call_id TEXT NOT NULL REFERENCES ai_tool_calls(id),
 type TEXT NOT NULL CHECK(type IN ('request_build','propose_source_change')),
 arguments_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','approved','rejected','uncertain')),
 version INTEGER NOT NULL DEFAULT 1, result_json TEXT, error TEXT,
 reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL,
 UNIQUE(job_id,call_id)
);
CREATE INDEX ai_tool_proposals_project ON ai_tool_proposals(project_id,status,created_at);
INSERT INTO schema_migrations(version,applied_at) VALUES(8,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
