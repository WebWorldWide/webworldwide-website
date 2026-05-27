-- 003_conversion_jobs.sql — Phase 5 conversion queue.
--
-- Generic SQLite-backed job queue that the conversion worker drains. Each
-- row represents one unit of post-upload work for a media asset: an image
-- variant matrix (Phase 5a), a video transcode (5b), PDF/code/archive
-- extraction (5c), etc.
--
-- The `type` column dispatches to a handler in
-- `admin/src/services/conversion/index.js`. New types only need a new
-- handler registration; the schema does not change.
--
-- Backoff: when a handler throws and `attempt < max_attempts`, the queue
-- resets the row to `pending` and pushes `queued_at` forward by an
-- exponential delay (see queue.js). The worker only claims rows whose
-- `queued_at <= now()`, so failures gently spread out.

CREATE TABLE IF NOT EXISTS conversion_jobs (
    id TEXT PRIMARY KEY,                       -- nanoid
    media_id TEXT NOT NULL,                    -- FK → media.id
    type TEXT NOT NULL,                        -- 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | 'gif'
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'running' | 'done' | 'failed'
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    queued_at INTEGER NOT NULL,                -- epoch ms; worker claims rows where queued_at <= now()
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_jobs_media ON conversion_jobs(media_id);
