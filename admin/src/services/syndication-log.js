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

// A crashed-mid-post claim (uri still NULL) is re-claimable after this, so a
// process that died between claim and post doesn't block the slug forever.
const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * ATOMICALLY claim a slug+platform for cross-posting. Returns true only if THIS
 * caller won the claim — closing the TOCTOU race where the cms publish hook and
 * the cron scheduler.js (separate processes, shared DB) both pass a hasSyndicated
 * check and both post. Claims when there's no row, or when the existing row is an
 * unposted (uri IS NULL) claim older than CLAIM_STALE_MS; never claims a row that
 * already has a uri (already posted) or a fresh in-flight claim. Fails CLOSED.
 * @param {string} slug
 * @param {string} platform
 * @returns {boolean}
 */
export function claimSyndication(slug, platform) {
  if (!slug || !platform) return false;
  try {
    const now = Date.now();
    const r = db()
      .prepare(
        `INSERT INTO syndication_log (slug, platform, uri, posted_at)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT(slug, platform) DO UPDATE SET posted_at = excluded.posted_at
           WHERE syndication_log.uri IS NULL AND syndication_log.posted_at < ?`,
      )
      .run(String(slug), String(platform), now, now - CLAIM_STALE_MS);
    return r.changes === 1;
  } catch (err) {
    console.warn('[syndication-log] claim failed:', err && err.message);
    return false; // fail closed — don't post if we couldn't atomically claim
  }
}

/**
 * Release an UNPOSTED claim (uri still NULL) so a failed post can be retried.
 * Never deletes a real (posted) record.
 * @param {string} slug
 * @param {string} platform
 */
export function releaseSyndication(slug, platform) {
  if (!slug || !platform) return;
  try {
    db()
      .prepare('DELETE FROM syndication_log WHERE slug = ? AND platform = ? AND uri IS NULL')
      .run(String(slug), String(platform));
  } catch (err) {
    console.warn('[syndication-log] release failed:', err && err.message);
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
