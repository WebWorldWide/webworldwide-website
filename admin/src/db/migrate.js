// @ts-check
/**
 * migrate.js — tiny SQLite migration runner.
 *
 * Reads every `*.sql` file in `admin/src/db/migrations/` in lexical
 * order and applies any that haven't been recorded in the
 * `schema_migrations` tracking table. Each migration runs in its own
 * transaction; a failure rolls back and rethrows so the server fails
 * loud on bad DDL.
 *
 * Phase 4 introduced this runner alongside the `media` table. The
 * legacy auth tables previously created inline in `routes/auth.js` are
 * captured as migration `001_auth.sql`, so a fresh install converges on
 * the same schema regardless of whether `auth.js` or `migrate.js`
 * touches the database first.
 *
 * The runner is intentionally minimal — no `down`, no dependency graph,
 * no SQL-template engine. The hard rule is: migrations are append-only,
 * named `NNN_<slug>.sql`, and idempotent (`CREATE … IF NOT EXISTS`,
 * `INSERT … ON CONFLICT`) so re-applying never corrupts data.
 */

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Apply all pending migrations to the given DB. If `dbPath` is omitted,
 * resolves the same path `routes/auth.js` uses (AUTH_DB_PATH override
 * for tests, otherwise admin/data/auth.db).
 *
 * @param {string} [dbPath]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(dbPath) {
  const resolvedPath =
    dbPath || process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  /** @type {string[]} */
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = /** @type {string[]} */ ([]);
  const skipped = /** @type {string[]} */ ([]);

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const markApplied = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (isApplied.get(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      markApplied.run(file, Date.now());
    });
    try {
      tx();
      applied.push(file);
    } catch (err) {
      db.close();
      const wrapped = new Error(`Migration ${file} failed: ${err.message}`);
      // @ts-ignore — chain the original for callers that want it
      wrapped.cause = err;
      throw wrapped;
    }
  }

  db.close();
  return { applied, skipped };
}

// Allow `node admin/src/db/migrate.js` to run migrations manually.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runMigrations();
  console.log(`[migrate] applied=${result.applied.length} skipped=${result.skipped.length}`);
  if (result.applied.length) {
    console.log(`[migrate] applied: ${result.applied.join(', ')}`);
  }
}
