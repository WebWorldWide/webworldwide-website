-- 008_webmention_bluesky.sql — Phase 9 Bluesky cross-post.
--
-- Tracks the at:// URI on webmention rows that originated from a
-- bsky.app source URL. The receiver in `routes/webmentions.js`
-- detects `bsky.app/profile/<handle>/post/<rkey>` in the source URL
-- on insert and populates this column; the comments-reply handler in
-- `routes/comments.js` reads it to mirror an admin reply back to the
-- Bluesky thread.
--
-- Rationale:
--   - We store the AT URI rather than re-deriving it from `source` so
--     a Bluesky handle change (`alice.bsky.social` → `alice.example`)
--     doesn't strand existing rows. The URI we capture at receive
--     time always works — Bluesky's URI resolver follows DID handles.
--   - NULL is the common case (most webmentions arrive via Bridgy Fed
--     from Mastodon); the comments-reply handler treats NULL as
--     "no Bluesky mirror, just leave the 409 in place".

ALTER TABLE webmentions ADD COLUMN bluesky_uri TEXT;

CREATE INDEX IF NOT EXISTS idx_wm_bluesky_uri
  ON webmentions(bluesky_uri)
  WHERE bluesky_uri IS NOT NULL;
