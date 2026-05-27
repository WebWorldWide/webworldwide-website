-- 006_webmentions.sql — Phase 8 Webmention receiver.
--
-- Bridgy Fed forwards Fediverse replies / likes / reposts to this
-- table as standard W3C Webmentions (https://www.w3.org/TR/webmention/).
-- The receiver lives in `admin/src/routes/webmentions.js`; a periodic
-- dump script (`admin/src/services/dump-webmentions.js`) groups rows
-- by post slug and writes one JSON file per post under
-- `site/data/webmentions/`. Hugo's `webmentions.html` partial reads
-- those files at build time and renders the replies inline alongside
-- Remark42 comments.
--
-- Lifecycle:
--   1. POST /webmention arrives, row inserted with status='pending'.
--   2. Background validator fetches `source`, parses microformats,
--      confirms it links back to `target`. On success → row updated
--      with status='approved' and parsed fields (author, content,
--      type). On failure → status='rejected' with reason in
--      raw_html (or a short string).
--   3. The dump script reads only status='approved' rows.
--   4. Admin can manually flip status via the /webmention/:id/approve
--      and /reject endpoints.
--
-- Schema notes:
--   - `id` is a nanoid (matches the convention in activity_log /
--     media tables — keeps URLs short, indexable, no PII).
--   - `source` + `target` are full URLs. (`source, target`) is
--     unique-ish in practice but we deliberately allow duplicates so
--     repeated pings can re-validate without 409-ing the sender.
--   - `type` defaults to `mention`; the validator promotes to
--     `reply` / `like` / `repost` / `bookmark` when the source's
--     microformats declare one of those `u-*` links pointing at
--     `target`.
--   - `raw_html` is the source HTML at fetch time, truncated to a
--     few KB. Useful for debugging + audit; never rendered raw.

CREATE TABLE IF NOT EXISTS webmentions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'mention',
  author_name TEXT,
  author_avatar TEXT,
  author_url TEXT,
  content TEXT,
  received_at INTEGER NOT NULL,
  validated_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  raw_html TEXT
);

CREATE INDEX IF NOT EXISTS idx_wm_target_status
  ON webmentions(target, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_wm_status
  ON webmentions(status);
