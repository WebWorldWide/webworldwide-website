#!/usr/bin/env node
// @ts-check
/**
 * rename-media-db.js — mirror the file/post media rename
 * (../../scripts/rename-media.mjs) into the CMS media library (auth.db
 * `media` table). Lives under admin/ so it resolves better-sqlite3.
 *
 * rename-media.mjs renamed the Ghost-imported images on disk
 * (site/public/images/**) and rewrote the posts that reference them, then
 * emitted scripts/media-rename-map.json. But the CMS `media` rows still point
 * `storage_path` at the OLD path and show the OLD name, so the library would
 * display `image-17.webp` next to a now-missing file. This applies the same
 * map to the DB so the library stays consistent.
 *
 * For each map entry it updates the row whose `storage_path` = oldStorage:
 *   - storage_path → newStorage  (fixes the served URL; matches the moved file)
 *   - filename     → newName
 *   - original_name→ newName     (this is the field the library DISPLAYS —
 *                                 admin/public/js/media.js: `original_name || filename`)
 *
 * Safe by construction:
 *   - DRY RUN by default; only --apply writes (in a single transaction).
 *   - Idempotent: a row already at newStorage is reported "already applied"
 *     and skipped, so re-running matches 0 new rows and changes nothing.
 *   - Refuses to run if any newStorage would collide with a DIFFERENT existing
 *     row (the partial-unique index on storage_path would otherwise throw).
 *
 *   node admin/scripts/rename-media-db.js --db /path/to/auth.db            # dry run
 *   node admin/scripts/rename-media-db.js --db /path/to/auth.db --apply    # write
 *
 * ALWAYS back up auth.db (+ its -wal/-shm sidecars) first — scripts/backup.sh.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The map is emitted next to its companion file-renamer at repo-root scripts/.
const DEFAULT_MAP = join(HERE, '..', '..', 'scripts', 'media-rename-map.json');

function argval(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APPLY = process.argv.includes('--apply');
const DB_PATH = argval('--db', process.env.AUTH_DB_PATH);
const MAP_PATH = argval('--map', DEFAULT_MAP);

if (!DB_PATH) {
  console.error('ERROR: pass --db <path to auth.db> (or set AUTH_DB_PATH).');
  process.exit(2);
}

/** @type {Array<{oldStorage:string,newStorage:string,newName:string,oldName:string}>} */
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));

// Map-level sanity: no duplicate oldStorage, no newStorage that is also an
// oldStorage (would make order matter). rename-media.mjs already guarantees
// this, but verify before touching a production DB.
const olds = new Set(map.map((e) => e.oldStorage));
const news = new Set(map.map((e) => e.newStorage));
if (olds.size !== map.length) {
  console.error('ABORT: duplicate oldStorage entries in map.');
  process.exit(1);
}
const ambiguous = [...news].filter((n) => olds.has(n));
if (ambiguous.length) {
  console.error('ABORT: a newStorage is also an oldStorage (order-dependent):', ambiguous);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: !APPLY });
const byPath = db.prepare(
  'SELECT id, filename, original_name, storage_path FROM media WHERE storage_path = ?',
);

const willUpdate = [];
const alreadyApplied = [];
const missing = [];
const collisions = [];

for (const e of map) {
  const row = byPath.get(e.oldStorage);
  if (row) {
    // Guard: newStorage must not already belong to a DIFFERENT row.
    const clash = byPath.get(e.newStorage);
    if (clash && clash.id !== row.id) {
      collisions.push({ ...e, clashId: clash.id });
      continue;
    }
    willUpdate.push({ ...e, id: row.id, from: row.original_name || row.filename });
  } else if (byPath.get(e.newStorage)) {
    alreadyApplied.push(e);
  } else {
    missing.push(e);
  }
}

console.error(`${APPLY ? 'APPLY' : '[dry-run]'} media-library rename — DB: ${DB_PATH}`);
console.error(
  `  to update: ${willUpdate.length}   already applied: ${alreadyApplied.length}   ` +
    `missing: ${missing.length}   collisions: ${collisions.length}`,
);
for (const u of willUpdate) {
  console.error(`  • ${u.oldStorage}  →  ${u.newStorage}   ("${u.from}" → "${u.newName}")`);
}
if (missing.length) {
  console.error('  MISSING (no media row at oldStorage — nothing to rename):');
  for (const m of missing) console.error(`    - ${m.oldStorage}`);
}
if (collisions.length) {
  console.error('  ABORT: newStorage already used by a different row:');
  for (const c of collisions) console.error(`    - ${c.newStorage} (held by ${c.clashId})`);
  db.close();
  process.exit(1);
}

if (!APPLY) {
  console.error('\nDry run — re-run with --apply to write. (Back up auth.db first.)');
  db.close();
  process.exit(0);
}

if (!willUpdate.length) {
  console.error('\nNothing to update (already applied or no matching rows). No write performed.');
  db.close();
  process.exit(0);
}

const update = db.prepare(
  'UPDATE media SET storage_path = ?, filename = ?, original_name = ? WHERE id = ? AND storage_path = ?',
);
const tx = db.transaction((items) => {
  let n = 0;
  for (const u of items) {
    const res = update.run(u.newStorage, u.newName, u.newName, u.id, u.oldStorage);
    n += res.changes;
  }
  return n;
});
const changed = tx(willUpdate);
db.close();
console.error(`\nDone. ${changed} media row(s) renamed.`);
