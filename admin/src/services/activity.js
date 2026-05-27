// @ts-check
/**
 * activity.js — Phase 5e CMS activity logger.
 *
 * One small, non-blocking insert per mutation. Callers do
 * `logActivity({ user, action, target, meta })` (or pass `req` to let
 * us grab the user from the session) WITHOUT awaiting the result —
 * even if the DB hiccups, the user-visible save has already returned.
 *
 * Schema lives in migrations/004_activity_log.sql. The runner applies
 * it at server boot; this module also calls `CREATE TABLE IF NOT
 * EXISTS` for the benefit of tests that import the service directly
 * without going through the migration runner.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Database.Database | null} */
let dbHandle = null;

/**
 * Resolve the DB lazily so tests can swap AUTH_DB_PATH before first
 * use. Also makes a fresh import always reflect the current env.
 *
 * @returns {Database.Database}
 */
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      user TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action);
  `);
  return dbHandle;
}

/**
 * Best-effort log insert. Synchronous on the SQLite side (better-sqlite3
 * is sync), but wrapped in `setImmediate` so the caller's response is
 * already on the wire by the time we touch the DB.
 *
 * @param {{ user?: string, action: string, target?: string | null, meta?: any, req?: any }} entry
 */
export function logActivity(entry) {
  const user = entry.user || (entry.req && entry.req.user && entry.req.user.username) || 'system';
  const action = String(entry.action || 'unknown');
  const target = entry.target === null || entry.target === undefined ? null : String(entry.target);
  let metaJson = null;
  if (entry.meta !== undefined && entry.meta !== null) {
    try {
      metaJson = JSON.stringify(entry.meta);
    } catch {
      metaJson = null; // tolerate circular refs etc.
    }
  }

  setImmediate(() => {
    try {
      db()
        .prepare(
          `INSERT INTO activity_log (id, ts, user, action, target, meta_json) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(nanoid(), Date.now(), user, action, target, metaJson);
    } catch (err) {
      // Never throw out of a fire-and-forget log call. Surface to stderr.
      console.warn('[activity] log failed:', err && /** @type {Error} */ (err).message);
    }
  });
}

/**
 * Read the most recent entries (default 50, max 500). Returns the
 * shaped rows in descending ts order. `meta_json` is parsed back to an
 * object on the way out so consumers don't have to.
 *
 * @param {{ limit?: number, action?: string, since?: number }} [opts]
 * @returns {{ id: string, ts: number, user: string, action: string, target: string | null, meta: any }[]}
 */
export function recentActivity(opts) {
  const limit = Math.max(1, Math.min(500, Number(opts?.limit) || 50));
  const where = [];
  const args = [];
  if (opts?.action) {
    where.push('action = ?');
    args.push(String(opts.action));
  }
  if (opts?.since) {
    where.push('ts >= ?');
    args.push(Number(opts.since));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db()
    .prepare(
      // rowid DESC tiebreaker because flushes may write multiple rows in
      // the same millisecond and our public id is a random nanoid (not
      // monotonic). SQLite's implicit rowid IS monotonic — newest row
      // always has the highest rowid.
      `SELECT id, ts, user, action, target, meta_json FROM activity_log ${whereSql} ORDER BY ts DESC, rowid DESC LIMIT ?`,
    )
    .all(...args, limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    user: r.user,
    action: r.action,
    target: r.target,
    meta: safeParse(r.meta_json),
  }));
}

/**
 * @param {string | null} s
 * @returns {any}
 */
function safeParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Test seam: `__test.flush` lets tests drain the setImmediate queue
// synchronously by awaiting a no-op resolve, then poke for results.
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
  async flush() {
    // Two ticks: setImmediate runs after current microtasks; await
    // resolves to flush microtasks, then a final setImmediate to clear
    // anything queued by the first one.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  },
};

export default { logActivity, recentActivity };
