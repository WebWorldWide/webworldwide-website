// @ts-check
/**
 * snapshots.js — local pre-save snapshots backing the editor's revision
 * history (the draft/recent half; git supplies the published half).
 *
 * On each save the post route records the file's PREVIOUS on-disk content
 * here before overwriting it, so a writer can roll back recent saves —
 * including for drafts that have no git history yet. Two bounds keep the
 * table tiny: at most MAX_PER_FILE rows per post, and at most one snapshot
 * per post per MIN_INTERVAL_MS (rapid autosaves coalesce).
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PER_FILE = 15;
const MIN_INTERVAL_MS = 60_000;

/** @type {Database.Database | null} */
let dbHandle = null;

/** @returns {Database.Database} */
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  return dbHandle;
}

/**
 * Record a snapshot of a post's content, unless an identical-or-recent one
 * already exists. Returns the new id, or null when coalesced/skipped.
 *
 * @param {string} filename
 * @param {{ title?: string, data?: object, content?: string }} snap
 * @param {number} [now] epoch ms (injectable for tests)
 * @returns {string | null}
 */
export function recordSnapshot(filename, snap, now = Date.now()) {
  if (!filename) return null;
  const d = db();
  try {
    const newest = d
      .prepare('SELECT ts, content FROM post_snapshots WHERE filename = ? ORDER BY ts DESC LIMIT 1')
      .get(filename);
    const content = snap?.content ?? '';
    // Coalesce: skip if the last snapshot is recent OR byte-identical.
    if (newest && (now - newest.ts < MIN_INTERVAL_MS || newest.content === content)) {
      return null;
    }
    const id = nanoid();
    d.prepare(
      'INSERT INTO post_snapshots (id, filename, ts, title, data_json, content) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, filename, now, snap?.title || null, JSON.stringify(snap?.data || {}), content);
    // Prune to the most recent MAX_PER_FILE for this file.
    d.prepare(
      `DELETE FROM post_snapshots WHERE filename = ? AND id NOT IN (
         SELECT id FROM post_snapshots WHERE filename = ? ORDER BY ts DESC LIMIT ?
       )`,
    ).run(filename, filename, MAX_PER_FILE);
    return id;
  } catch (err) {
    // Snapshots are a safety net, never load-bearing — a failure here must
    // not break a save.
    console.warn('[snapshots] record failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * List snapshots for a post, newest first (metadata only).
 * @param {string} filename
 * @returns {Array<{ id: string, ts: number, title: string | null }>}
 */
export function listSnapshots(filename) {
  try {
    return db()
      .prepare('SELECT id, ts, title FROM post_snapshots WHERE filename = ? ORDER BY ts DESC')
      .all(filename);
  } catch {
    return [];
  }
}

/**
 * Fetch a single snapshot's full content.
 * @param {string} id
 * @returns {{ data: object, content: string, ts: number, title: string | null } | null}
 */
export function getSnapshot(id) {
  try {
    const row = db().prepare('SELECT * FROM post_snapshots WHERE id = ?').get(id);
    if (!row) return null;
    return {
      data: JSON.parse(row.data_json || '{}'),
      content: row.content || '',
      ts: row.ts,
      title: row.title,
    };
  } catch {
    return null;
  }
}

/** Test seam — close the connection so a temp DB can be cleaned up. */
export function __closeForTest() {
  if (dbHandle) {
    dbHandle.close();
    dbHandle = null;
  }
}
