-- 001_auth.sql — Auth schema baseline.
--
-- These tables were previously created inline by admin/src/routes/auth.js
-- (Phases 1–2). The Phase 4 migrations runner records them here so a
-- fresh install applies the same DDL through a single audited path. The
-- statements remain idempotent (`IF NOT EXISTS`) so existing dev/prod
-- databases that already have these tables silently no-op.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    transports TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
