-- 013_syndication_log.sql — durable "already cross-posted" marker.
--
-- The cross-post hooks normally stamp bluesky_uri / mastodon_uri into the post's
-- front-matter for idempotency. But if that atomic file write fails AFTER the
-- live post succeeds (e.g. a full/erroring SD card — the Pi's stated failure
-- mode), no marker persists and the next re-edit-and-republish re-posts a
-- duplicate. This table is the DURABLE source of truth both crossposters consult
-- before posting and write to immediately AFTER the post succeeds (before the
-- best-effort front-matter write), so a lost write can never cause a re-post.
-- Append-only + idempotent per the migration runner.

CREATE TABLE IF NOT EXISTS syndication_log (
  slug       TEXT NOT NULL,
  platform   TEXT NOT NULL,
  uri        TEXT,
  posted_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, platform)
);
