// @ts-check
/**
 * retention.js — bound the append-only tables so a blog used daily for
 * years never accumulates an unbounded DB.
 *
 *   - activity_log: audit rows older than ACTIVITY_RETENTION_DAYS (90).
 *   - embed_cache:  rows past their own `expires_at`.
 *
 * Both tables are indexed on the swept column (idx_activity_ts /
 * idx_embed_cache_expires) so each DELETE is a cheap ranged scan. A
 * sweep runs once at boot and every 24h thereafter. Best-effort: a
 * missing table (fresh install / a test that didn't run migrations) is
 * ignored, never fatal.
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ACTIVITY_RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS) || 90;
const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = DAY_MS;

/** @type {Database.Database | null} */
let dbHandle = null;

/** Lazily open (so tests can set AUTH_DB_PATH first). @returns {Database.Database} */
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  return dbHandle;
}

/**
 * Run one retention sweep.
 *
 * @param {number} [now] epoch ms (injectable for tests)
 * @returns {{ activity: number, embeds: number }} rows pruned per table
 */
export function runRetention(now = Date.now()) {
  const d = db();
  let activity = 0;
  let embeds = 0;
  try {
    const cutoff = now - ACTIVITY_RETENTION_DAYS * DAY_MS;
    activity = d.prepare('DELETE FROM activity_log WHERE ts < ?').run(cutoff).changes;
  } catch {
    /* activity_log may not exist yet */
  }
  try {
    embeds = d.prepare('DELETE FROM embed_cache WHERE expires_at < ?').run(now).changes;
  } catch {
    /* embed_cache may not exist yet */
  }
  return { activity, embeds };
}

/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * Sweep now and every 24h. The interval is `unref`-ed so it never keeps
 * the process alive on its own.
 *
 * @returns {() => void} stop function
 */
export function startRetention() {
  const sweep = () => {
    try {
      const { activity, embeds } = runRetention();
      if (activity || embeds) {
        console.log(`[retention] pruned ${activity} activity row(s), ${embeds} embed(s)`);
      }
    } catch (err) {
      console.warn('[retention] sweep failed:', err instanceof Error ? err.message : err);
    }
  };
  sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** Test seam — close the connection so a temp DB can be cleaned up. */
export function __closeForTest() {
  if (dbHandle) {
    dbHandle.close();
    dbHandle = null;
  }
}
