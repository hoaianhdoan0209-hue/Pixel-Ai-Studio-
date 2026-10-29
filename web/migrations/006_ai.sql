CREATE TABLE ai_agent_settings (
 role TEXT PRIMARY KEY CHECK(role IN ('planner','developer','reviewer')),
 provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')),
 model TEXT NOT NULL,
 updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE TABLE ai_model_pricing (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')),
 model TEXT NOT NULL, input_usd_per_million REAL NOT NULL CHECK(input_usd_per_million>=0),
 output_usd_per_million REAL NOT NULL CHECK(output_usd_per_million>=0),
 effective_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(provider,model,effective_at)
);
CREATE TABLE ai_budget_policies (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 token_limit INTEGER NOT NULL CHECK(token_limit>0), cost_limit_usd REAL NOT NULL CHECK(cost_limit_usd>0),
 job_limit INTEGER NOT NULL CHECK(job_limit>0), max_concurrent INTEGER NOT NULL CHECK(max_concurrent BETWEEN 1 AND 5),
 max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 32 AND 8192),
 reserved_tokens INTEGER NOT NULL DEFAULT 0, spent_tokens INTEGER NOT NULL DEFAULT 0,
 reserved_cost_usd REAL NOT NULL DEFAULT 0, spent_cost_usd REAL NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE ai_jobs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT REFERENCES customer_requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), agent TEXT NOT NULL CHECK(agent IN ('planner','developer','reviewer')),
 provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')), model TEXT NOT NULL,
 prompt TEXT NOT NULL, system_prompt TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','planning','running','waiting_approval','reviewing','completed','failed','paused','cancelled')),
 reserved_tokens INTEGER NOT NULL, reserved_cost_usd REAL NOT NULL, max_output_tokens INTEGER NOT NULL,
 input_rate REAL NOT NULL, output_rate REAL NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, started_at TEXT, finished_at TEXT,
 output TEXT NOT NULL DEFAULT '', plan_json TEXT, error_code TEXT, error_message TEXT,
 settled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE INDEX ai_jobs_queue ON ai_jobs(status,retry_at,created_at);
CREATE INDEX ai_jobs_project ON ai_jobs(project_id,created_at DESC);
CREATE TABLE ai_messages (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('system','user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ai_messages_job ON ai_messages(job_id,created_at);
CREATE TABLE ai_token_usage (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES ai_jobs(id), project_id TEXT NOT NULL REFERENCES projects(id),
 user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, model TEXT NOT NULL, agent TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, usage_source TEXT NOT NULL CHECK(usage_source IN ('provider','unreported','rejected')),
 charged_tokens INTEGER NOT NULL, estimated_cost_usd REAL NOT NULL,
 cost_source TEXT NOT NULL CHECK(cost_source IN ('provider_usage_estimate','reservation_upper_bound','rejected')),
 created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_project_date ON ai_token_usage(project_id,created_at);
CREATE TABLE ai_budget_alerts (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), threshold INTEGER NOT NULL CHECK(threshold IN (50,80,100)),
 policy_version INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,threshold,policy_version)
);
CREATE TABLE ai_plan_tasks (
 job_id TEXT NOT NULL REFERENCES ai_jobs(id), task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(job_id,task_id)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
