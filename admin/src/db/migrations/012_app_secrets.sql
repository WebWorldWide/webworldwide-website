-- 012_app_secrets.sql — UI-entered integration secrets.
--
-- A tiny key->value store for credentials the operator enters through the admin
-- UI (e.g. the Bluesky app password) instead of docker/.env. It lives ONLY in
-- the cms_data volume — NEVER in site.toml / git / the public site. Values are
-- AES-256-GCM encrypted at rest by services/app-secrets.js with a key derived
-- from SESSION_SECRET, so a leaked DB file (or backup) doesn't expose the
-- plaintext without the server secret. Append-only + idempotent per the runner.

CREATE TABLE IF NOT EXISTS app_secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
