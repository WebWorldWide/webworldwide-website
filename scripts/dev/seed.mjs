#!/usr/bin/env node
// @ts-check
/**
 * scripts/dev/seed.mjs — Phase 5d.
 *
 * Idempotent local-dev seeder:
 *   1. Loads docker/.env.dev (falls back to .env.dev.example).
 *   2. Runs the admin migration runner against AUTH_DB_PATH so the
 *      users / passkeys / media / conversion_jobs tables exist.
 *   3. Creates the dev admin user (`admin` / `password`). Skips silently
 *      if the user already exists.
 *   4. Inserts five sample media rows so the library UI has something to
 *      paint on first boot. The rows reference fake filenames; no real
 *      files are written.
 *
 * Re-running is safe — every insert uses UNIQUE/PRIMARY KEY guards.
 *
 * Usage:
 *   node scripts/dev/seed.mjs           # seed
 *   node scripts/dev/seed.mjs --quiet   # only print errors
 */

import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevEnv, repoPath, makeLogger, c, hasFlag } from './_lib.mjs';
import { runMigrations } from '../../admin/src/db/migrate.js';

// bcrypt and better-sqlite3 live in admin/node_modules (tracked, so the
// Pi can deploy via `git clone` with no `npm install` step). Resolve
// from that directory so the dev scripts don't require a duplicate copy
// at the repo root.
const adminRequire = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'admin', 'package.json'),
);
const bcrypt = adminRequire('bcrypt');
const Database = adminRequire('better-sqlite3');

const log = makeLogger('seed', c.green);
const quiet = hasFlag('--quiet', '-q');

/**
 * The dev admin credentials. Public on purpose — these only exist on a
 * developer laptop with `WEBAUTHN_RP_ID=localhost`.
 */
export const DEV_ADMIN = Object.freeze({
  username: 'admin',
  password: 'password',
});

/** Five sample media fixtures. Mime types span the conversion handlers. */
export const SAMPLE_MEDIA = Object.freeze([
  {
    filename: 'fixture-hello-world.png',
    original: 'hello-world.png',
    mime: 'image/png',
    size: 4096,
    width: 800,
    height: 600,
  },
  {
    filename: 'fixture-clip.mp4',
    original: 'clip.mp4',
    mime: 'video/mp4',
    size: 1_048_576,
    width: 1280,
    height: 720,
    duration: 12.5,
  },
  {
    filename: 'fixture-podcast.mp3',
    original: 'podcast.mp3',
    mime: 'audio/mpeg',
    size: 524_288,
    duration: 60,
  },
  {
    filename: 'fixture-spec.pdf',
    original: 'spec.pdf',
    mime: 'application/pdf',
    size: 32_768,
  },
  {
    filename: 'fixture-snippet.zip',
    original: 'snippet.zip',
    mime: 'application/zip',
    size: 8_192,
  },
]);

/**
 * Open the dev SQLite DB after running migrations. Returns the handle —
 * the caller is responsible for closing.
 *
 * @returns {Database.Database}
 */
function openDevDb() {
  loadDevEnv();
  const dbPath = process.env.AUTH_DB_PATH
    ? repoPath(process.env.AUTH_DB_PATH)
    : repoPath('admin/data/auth-dev.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  runMigrations(dbPath);
  if (!quiet) log.info(`migrations OK → ${c.dim(dbPath)}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Seed the dev admin user. Returns the user id (newly minted or
 * pre-existing).
 *
 * @param {Database.Database} db
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function seedAdminUser(db) {
  const existing = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(DEV_ADMIN.username);
  if (existing) {
    if (!quiet) log.info(`user "${DEV_ADMIN.username}" already exists — skipping`);
    return { id: /** @type {{id: string}} */ (existing).id, created: false };
  }
  const id = randomBytes(16).toString('hex');
  const hash = await bcrypt.hash(DEV_ADMIN.password, 12);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
    id,
    DEV_ADMIN.username,
    hash,
  );
  if (!quiet) {
    log.info(
      `created user ${c.bold(DEV_ADMIN.username)} / ${c.bold(DEV_ADMIN.password)} ${c.gray('(dev only!)')}`,
    );
  }
  return { id, created: true };
}

/**
 * Insert the five sample media rows. Idempotent — `INSERT OR IGNORE`
 * on the `filename` unique key.
 *
 * @param {Database.Database} db
 * @returns {{ inserted: number, skipped: number }}
 */
export function seedSampleMedia(db) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO media
       (id, filename, original_name, mime_type, size, width, height, duration, hash, status, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  for (const m of SAMPLE_MEDIA) {
    const id = createHash('sha1').update(m.filename).digest('hex').slice(0, 12);
    const hash = createHash('sha256').update(m.filename).digest('hex');
    const result = insert.run(
      id,
      m.filename,
      m.original,
      m.mime,
      m.size,
      m.width ?? null,
      m.height ?? null,
      m.duration ?? null,
      hash,
      now,
    );
    if (result.changes > 0) inserted++;
    else skipped++;
  }
  if (!quiet) {
    log.info(
      `media fixtures: ${c.bold(String(inserted))} inserted, ${c.gray(`${skipped} skipped`)}`,
    );
  }
  return { inserted, skipped };
}

/**
 * Entrypoint. Exported as `runSeed` so tests can drive it directly
 * against a temp DB without spawning node.
 *
 * @returns {Promise<{ user: { id: string, created: boolean }, media: { inserted: number, skipped: number } }>}
 */
export async function runSeed() {
  const db = openDevDb();
  try {
    const user = await seedAdminUser(db);
    const media = seedSampleMedia(db);
    if (!quiet) log.info(c.green('seed complete'));
    return { user, media };
  } finally {
    db.close();
  }
}

// CLI entrypoint guard. ESM equivalent of `if __name__ == '__main__'`.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runSeed().catch((err) => {
    log.error(err.stack || err.message);
    process.exit(1);
  });
}
