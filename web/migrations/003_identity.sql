ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE identity_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','delivered','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX identity_tokens_user ON identity_tokens(user_id,purpose,created_at DESC);
CREATE INDEX identity_tokens_expiry ON identity_tokens(expires_at);
INSERT INTO schema_migrations(version,applied_at) VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
