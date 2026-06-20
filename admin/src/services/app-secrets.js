// @ts-check
/**
 * app-secrets.js — encrypted key/value store for UI-entered integration
 * credentials (e.g. the Bluesky app password), so the operator can configure
 * them in the admin Settings UI instead of editing docker/.env.
 *
 * Backed by the `app_secrets` table in the auth DB (cms_data volume — never
 * site.toml / git / the public site). Values are AES-256-GCM encrypted at rest
 * with a 32-byte key derived from SESSION_SECRET via scrypt, so the DB file or
 * a backup never holds a plaintext credential. A SESSION_SECRET change renders
 * existing values undecryptable → getSecret returns null → the operator simply
 * re-enters them; acceptable because these are revocable integration tokens.
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Database.Database | null} */
let dbHandle = null;
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  // Safety net for direct-import tests that don't run the migration runner.
  dbHandle.exec(
    'CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  return dbHandle;
}

// 32-byte AES key from SESSION_SECRET. A fixed salt is fine — the entropy is in
// the secret, and we want the same key across restarts for a given secret.
function keyBytes() {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret) throw new Error('SESSION_SECRET not set — cannot (de)crypt app secrets');
  return scryptSync(secret, 'wwwide-app-secrets-v1', 32);
}

/** @param {string} plain */
function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) | tag(16) | ciphertext, base64.
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** @param {string} stored @returns {string|null} */
function decrypt(stored) {
  try {
    const buf = Buffer.from(String(stored), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key (SESSION_SECRET changed) or a corrupt/auth-failed value.
    return null;
  }
}

/**
 * Decrypted value for a key, or null if unset/undecryptable.
 * @param {string} k
 * @returns {string|null}
 */
export function getSecret(k) {
  try {
    const row = /** @type {any} */ (
      db().prepare('SELECT value FROM app_secrets WHERE key = ?').get(k)
    );
    return row ? decrypt(row.value) : null;
  } catch {
    return null;
  }
}

/**
 * Upsert (or, when value is empty/null, delete) a secret.
 * @param {string} k
 * @param {string|null|undefined} v
 */
export function setSecret(k, v) {
  const d = db();
  if (v === null || v === undefined || v === '') {
    d.prepare('DELETE FROM app_secrets WHERE key = ?').run(k);
    return;
  }
  d.prepare(
    `INSERT INTO app_secrets (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(k, encrypt(v), Date.now());
}

/**
 * Whether a secret exists for a key (without decrypting it) — for "configured?"
 * status the UI can show without ever reading the value back.
 * @param {string} k
 * @returns {boolean}
 */
export function hasSecret(k) {
  try {
    return Boolean(db().prepare('SELECT 1 FROM app_secrets WHERE key = ?').get(k));
  } catch {
    return false;
  }
}
