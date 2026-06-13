-- 011_post_snapshots.sql — local pre-save snapshots for post revision history.
--
-- Published posts have full history in git (surfaced via `git log` over the
-- post path). But DRAFTS that were never published have no git history, and
-- even for published posts you want "undo my last few saves" without a
-- publish round-trip. This table captures the on-disk content of a post
-- *before* each save overwrites it, so the editor's History panel can offer
-- a one-click restore of recent local states alongside the git versions.
--
-- Bounded two ways (see services/snapshots.js): at most ~15 rows per file,
-- and at most one new snapshot per file per minute (rapid autosaves don't
-- each spawn a row). Combined that keeps the table tiny for personal use.

CREATE TABLE IF NOT EXISTS post_snapshots (
  id TEXT PRIMARY KEY,             -- nanoid
  filename TEXT NOT NULL,          -- post filename, e.g. my-post.md
  ts INTEGER NOT NULL,             -- epoch ms the snapshot was taken
  title TEXT,                      -- denormalised for the history list label
  data_json TEXT NOT NULL,         -- frontmatter object at snapshot time
  content TEXT NOT NULL            -- body markdown at snapshot time
);

CREATE INDEX IF NOT EXISTS idx_post_snapshots_file ON post_snapshots(filename, ts DESC);
