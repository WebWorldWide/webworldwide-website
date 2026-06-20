// @ts-check
/**
 * syndication-log.js — durable "already cross-posted" marker (migration 013).
 *
 * The cross-post hooks also stamp the URI into the post's front-matter, but a
 * failed front-matter write AFTER a successful live post would otherwise let the
 * next publish re-post a duplicate. Both crossposters consult hasSyndicated()
 * before posting and call recordSyndication() right after the post succeeds —
 * BEFORE the (best-effort) front-matter write — so the marker survives a lost
 * write. Own DB handle (mirrors app-secrets.js) with a safety-net CREATE TABLE
 * so direct-import tests work without first running the migration runner.
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Database.Database | null} */
let dbHandle = null;
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS syndication_log (
      slug       TEXT NOT NULL,
      platform   TEXT NOT NULL,
      uri        TEXT,
      posted_at  INTEGER NOT NULL,
      PRIMARY KEY (slug, platform)
    );
  `);
  return dbHandle;
}

/**
 * Has this post already been cross-posted to this platform?
 * @param {string} slug
 * @param {string} platform  e.g. 'bluesky' | 'mastodon'
 * @returns {boolean}
 */
export function hasSyndicated(slug, platform) {
  if (!slug || !platform) return false;
  try {
    const row = db()
      .prepare('SELECT 1 AS one FROM syndication_log WHERE slug = ? AND platform = ?')
      .get(String(slug), String(platform));
    return Boolean(row);
  } catch {
    // Never let a marker-lookup failure block (or falsely skip) a cross-post.
    return false;
  }
}

/**
 * Record that this post was cross-posted to this platform (idempotent upsert).
 * @param {string} slug
 * @param {string} platform
 * @param {string} [uri]
 */
export function recordSyndication(slug, platform, uri) {
  if (!slug || !platform) return;
  try {
    db()
      .prepare(
        `INSERT INTO syndication_log (slug, platform, uri, posted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug, platform) DO UPDATE SET uri = excluded.uri, posted_at = excluded.posted_at`,
      )
      .run(String(slug), String(platform), uri ? String(uri) : null, Date.now());
  } catch (err) {
    console.warn('[syndication-log] record failed:', err && err.message);
  }
}

export const __test = {
  reset() {
    if (dbHandle) {
      try {
        dbHandle.close();
      } catch {
        /* ignore */
      }
    }
    dbHandle = null;
  },
};

export default { hasSyndicated, recordSyndication };
