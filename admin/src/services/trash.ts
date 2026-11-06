/**
 * Post trash: a deleted post's file content is kept for TRASH_DAYS so the
 * delete can be undone from the Posts view. Revision snapshots are kept too
 * (they're keyed by filename and pruned on their own schedule).
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TRASH_DAYS = 30;

let handle: Database.Database | null = null;
function db() {
  if (handle) return handle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  handle = new Database(dbPath);
  handle.exec(`CREATE TABLE IF NOT EXISTS post_trash (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, title TEXT, raw TEXT NOT NULL,
    deleted_at INTEGER NOT NULL, deleted_by TEXT)`);
  return handle;
}

export function trashPost(
  filename: string,
  raw: string,
  title: string | null,
  user: string | null,
) {
  const id = nanoid();
  db()
    .prepare(
      'INSERT INTO post_trash (id, filename, title, raw, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, filename, title, raw, Date.now(), user);
  return id;
}

export function listTrash() {
  return db()
    .prepare(
      'SELECT id, filename, title, deleted_at, deleted_by FROM post_trash ORDER BY deleted_at DESC',
    )
    .all();
}

export function getTrashed(id: string) {
  return db().prepare('SELECT * FROM post_trash WHERE id = ?').get(id) as
    { id: string; filename: string; title: string | null; raw: string } | undefined;
}

export function removeTrashed(id: string) {
  return db().prepare('DELETE FROM post_trash WHERE id = ?').run(id).changes > 0;
}

export function pruneTrash(now = Date.now()) {
  return db()
    .prepare('DELETE FROM post_trash WHERE deleted_at < ?')
    .run(now - TRASH_DAYS * 86_400_000).changes;
}

export function __closeForTest() {
  if (handle) handle.close();
  handle = null;
}
