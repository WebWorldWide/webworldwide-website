-- 002_media.sql — Universal media library (Phase 4).
--
-- Tracks every uploaded asset, regardless of type. Phase 5 will populate
-- `conversions_json` once the ffmpeg/sharp conversion pipeline lands. The
-- `post_refs_json` column is a denormalised cache of which posts include
-- the file; it's refreshed by the post-refs scanner on read, so a stale
-- value never blocks a write.

CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,                    -- nanoid
    filename TEXT NOT NULL UNIQUE,          -- final on-disk name (hash-prefixed)
    original_name TEXT NOT NULL,            -- user-supplied filename
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,                  -- bytes
    width INTEGER,                          -- nullable; images/video only
    height INTEGER,
    duration REAL,                          -- nullable; video/audio (Phase 5)
    hash TEXT NOT NULL,                     -- sha256 of file bytes
    conversions_json TEXT DEFAULT '{}',     -- Phase 5 will populate
    status TEXT NOT NULL DEFAULT 'ready',   -- 'ready' | 'processing' | 'failed'
    uploaded_at INTEGER NOT NULL,
    post_refs_json TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
CREATE INDEX IF NOT EXISTS idx_media_mime ON media(mime_type);
