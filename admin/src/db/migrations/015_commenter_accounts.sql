-- Commenter accounts: username + password sign-in for the blog comments
-- (Remark42). Only an Argon2id hash of each password is stored, never the
-- password itself. Backed up nightly, age-encrypted, with the rest of this
-- database (scripts/backup.sh).
CREATE TABLE IF NOT EXISTS commenter_accounts (
  id TEXT PRIMARY KEY,
  -- Display name as typed (shown on comments).
  username TEXT NOT NULL,
  -- Lowercased, for uniqueness and lookup.
  username_key TEXT NOT NULL UNIQUE,
  -- $argon2id$v=19$m=…,t=…,p=…$<salt>$<hash> (PHC string)
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  -- Brute-force protection: consecutive failures + lock expiry (ms epoch).
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  -- Bumped on password change / admin reset: older sign-ins stop working.
  token_version INTEGER NOT NULL DEFAULT 0
);
