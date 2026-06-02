-- 009_media_storage_path.sql — let backfilled site media coexist with uploads.
--
-- Pre-Astro, every media row was a CMS upload with a hash-prefixed,
-- globally-unique `filename`. Backfilling the site's existing images
-- (migrated from Ghost into site/public/images) breaks that assumption:
-- the same basename (e.g. `image.webp`) legitimately exists in more than
-- one month folder. So this migration:
--   * adds `storage_path` — the file's path relative to the media root
--     (e.g. `images/2025/12/image.webp`). When present it is the
--     authoritative URL + on-disk location, overriding the
--     uploaded_at + filename derivation used for ordinary uploads.
--   * drops the column-level UNIQUE on `filename` (SQLite needs a table
--     rebuild for that) and instead enforces uniqueness on `storage_path`
--     via a PARTIAL unique index, so the many NULL `storage_path` values
--     on ordinary uploads never collide.
--
-- FK note: the runner does not enable `PRAGMA foreign_keys`, so dropping
-- and recreating `media` (referenced by conversion_jobs.media_id) is safe;
-- the FK re-binds to the rebuilt table by name. The whole file runs in one
-- transaction (see migrate.js), so a failure rolls back cleanly.

DROP TABLE IF EXISTS media_new;

CREATE TABLE media_new (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration REAL,
  hash TEXT NOT NULL,
  conversions_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready',
  uploaded_at INTEGER NOT NULL,
  post_refs_json TEXT DEFAULT '[]',
  storage_path TEXT
);

INSERT INTO media_new (
  id, filename, original_name, mime_type, size,
  width, height, duration, hash,
  conversions_json, status, uploaded_at, post_refs_json, storage_path
)
SELECT
  id, filename, original_name, mime_type, size,
  width, height, duration, hash,
  conversions_json, status, uploaded_at, post_refs_json, NULL
FROM media;

DROP TABLE media;
ALTER TABLE media_new RENAME TO media;

CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
CREATE INDEX IF NOT EXISTS idx_media_mime ON media(mime_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_storage_path
  ON media(storage_path) WHERE storage_path IS NOT NULL;
