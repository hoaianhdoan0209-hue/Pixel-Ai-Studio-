ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT 'Game';
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'game' CHECK(kind IN ('game','discussion'));
ALTER TABLE posts ADD COLUMN development_status TEXT NOT NULL DEFAULT 'development' CHECK(development_status IN ('development','released','recruiting'));
ALTER TABLE posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN hidden_at TEXT;
ALTER TABLE posts ADD COLUMN hidden_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN hidden_at TEXT;
ALTER TABLE comments ADD COLUMN hidden_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX posts_discovery ON posts(status,hidden_at,category,platform,updated_at DESC);
CREATE TABLE media (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('avatar','post','attachment')),
 kind TEXT NOT NULL CHECK(kind IN ('image','video','file')),
 mime TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0),
 storage_name TEXT NOT NULL UNIQUE,
 original_name TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX media_owner ON media(user_id,created_at DESC);
CREATE INDEX media_post ON media(post_id,created_at);
CREATE TABLE ratings (
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 5),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(post_id,user_id)
);
CREATE TABLE follows (
 follower_id TEXT NOT NULL REFERENCES users(id),
 author_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(follower_id,author_id),
 CHECK(follower_id<>author_id)
);
CREATE INDEX follows_author ON follows(author_id);
CREATE TABLE reports (
 id TEXT PRIMARY KEY,
 reporter_id TEXT NOT NULL REFERENCES users(id),
 post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
 comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
 resolution TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 resolved_at TEXT,
 resolved_by TEXT REFERENCES users(id),
 CHECK((post_id IS NOT NULL AND comment_id IS NULL) OR (comment_id IS NOT NULL AND post_id IS NULL))
);
CREATE UNIQUE INDEX report_open_post ON reports(reporter_id,post_id) WHERE status='open' AND post_id IS NOT NULL;
CREATE UNIQUE INDEX report_open_comment ON reports(reporter_id,comment_id) WHERE status='open' AND comment_id IS NOT NULL;
CREATE INDEX reports_queue ON reports(status,created_at);
CREATE TABLE moderation_actions (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES users(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('post','comment')),
 target_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('hide','restore','dismiss')),
 note TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE game_releases (
 id TEXT PRIMARY KEY,
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 version TEXT NOT NULL,
 changelog TEXT NOT NULL,
 media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(post_id,version)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
