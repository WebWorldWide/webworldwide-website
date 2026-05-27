-- 004_activity_log.sql — Phase 5e CMS activity log.
--
-- Every mutation in the admin UI (post create/update/delete, media
-- upload/delete, settings edit, taxonomies, redirects, …) writes one
-- row to this table via `admin/src/services/activity.js`. The
-- dashboard surfaces the most recent N entries so a writer can audit
-- "what did I change today" without grepping git log.
--
-- The write path is intentionally fire-and-forget: callers `void
-- logActivity({...})` after the user-visible work completes, so a log
-- insert failure never blocks a successful save. The schema therefore
-- avoids hard FKs — if a referenced post or media row gets deleted
-- later the log still tells the story.

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,         -- nanoid
  ts INTEGER NOT NULL,         -- epoch ms
  user TEXT NOT NULL,          -- session.username, or 'system' for scheduler/cron writes
  action TEXT NOT NULL,        -- 'post.create' | 'post.update' | 'post.delete' | 'post.duplicate'
                               -- 'post.bulk' | 'post.preview' | 'media.upload' | 'media.delete'
                               -- 'settings.hugo' | 'settings.author' | 'taxonomy.rename'
                               -- 'taxonomy.merge' | 'taxonomy.delete' | 'redirect.create'
                               -- 'redirect.delete' | 'scheduler.promote' | 'publish'
  target TEXT,                 -- filename / id / tag-name / 'site' — caller-chosen
  meta_json TEXT               -- arbitrary JSON blob with extra context
);

CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action);
