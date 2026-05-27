-- 007_blocks.sql — Phase 8.5 block list mirror.
--
-- Remark42 owns the authoritative block list (we proxy its admin API),
-- but mirroring the user-IDs locally gives us three things:
--
--   1. Fast paint of the /admin/#/comments/block-list view without a
--      round-trip to Remark42 on every page load.
--   2. A persistent audit trail (`reason`, `created_by`) of why each
--      block was applied — Remark42's own list is just user-ID+TTL.
--   3. Survivability if Remark42 is offline / being restarted; the
--      admin UI still shows what's blocked.
--
-- Reconciliation: the Remark42 proxy route refreshes this table from
-- the upstream `/api/v1/admin/blocked` endpoint whenever the admin
-- opens the block-list view, so out-of-band changes (e.g. an admin who
-- ssh'd in and used Remark42's UI directly) eventually converge.
--
-- Schema notes:
--   - `user_id` is Remark42's user identifier (e.g. `anonymous_xyz` or
--     a provider-scoped id like `github_alice`). Composite uniqueness
--     across (site_id, user_id) so a future multi-site install can
--     keep blocks separate; the single-site case treats site_id as the
--     literal string from REMARK42_SITE_ID env (default
--     `terminaleighty`).
--   - `ttl_ms` is the Remark42-side expiry in epoch-ms. NULL = forever.
--   - `created_by` records the admin username (or 'system' for blocks
--     auto-applied by the "Mark spam" flow).

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,             -- nanoid; matches other admin tables
  site_id TEXT NOT NULL,           -- Remark42 site id (e.g. 'terminaleighty')
  user_id TEXT NOT NULL,           -- Remark42 user identifier
  user_name TEXT,                  -- cached display name at block time
  reason TEXT,                     -- human-readable, surfaced in the UI
  ttl_ms INTEGER,                  -- NULL = permanent; otherwise epoch ms
  created_at INTEGER NOT NULL,     -- when we blocked, epoch ms
  created_by TEXT NOT NULL,        -- admin username, or 'system'
  UNIQUE(site_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_site_user ON blocks(site_id, user_id);
CREATE INDEX IF NOT EXISTS idx_blocks_created ON blocks(created_at DESC);
