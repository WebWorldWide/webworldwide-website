-- 014_post_trash.sql — deleted posts are kept for 30 days so a delete can be
-- undone (drafts that were never published have no git history to fall back
-- on). Pruned by services/retention.ts.

CREATE TABLE IF NOT EXISTS post_trash (
  id TEXT PRIMARY KEY,             -- nanoid
  filename TEXT NOT NULL,          -- original filename, e.g. my-post.md
  title TEXT,
  raw TEXT NOT NULL,               -- full file content (front matter + body)
  deleted_at INTEGER NOT NULL,     -- epoch ms
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_post_trash_deleted ON post_trash(deleted_at DESC);
