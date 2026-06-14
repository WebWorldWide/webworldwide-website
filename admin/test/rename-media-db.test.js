// @ts-check
/**
 * rename-media-db.test.js — scripts/rename-media-db.mjs applies the media
 * rename map to the CMS `media` table correctly, completely (incl. the
 * displayed `original_name`), and idempotently, and refuses collisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rename-media-db.js');

function makeDb(dir) {
  const dbPath = join(dir, 'auth.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE media (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      storage_path TEXT
    );
    CREATE UNIQUE INDEX idx_media_storage_path ON media(storage_path) WHERE storage_path IS NOT NULL;
  `);
  return { db, dbPath };
}

const MAP = [
  {
    oldStorage: 'images/2025/12/image-17.webp',
    newStorage: 'images/2025/12/bye-bye-dji.webp',
    oldName: 'image-17.webp',
    newName: 'bye-bye-dji.webp',
  },
];

function run(dbPath, mapPath, apply) {
  const res = spawnSync(
    'node',
    [SCRIPT, '--db', dbPath, '--map', mapPath, ...(apply ? ['--apply'] : [])],
    { encoding: 'utf8' },
  );
  // The script logs progress to stderr; combine for assertions.
  return { out: `${res.stdout}${res.stderr}`, status: res.status };
}

test('renames storage_path, filename AND original_name; leaves others untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mediadb-'));
  try {
    const { db, dbPath } = makeDb(dir);
    db.prepare('INSERT INTO media VALUES (?,?,?,?)').run(
      'a',
      'image-17.webp',
      'image-17.webp',
      'images/2025/12/image-17.webp',
    );
    // An unrelated row that must NOT change.
    db.prepare('INSERT INTO media VALUES (?,?,?,?)').run(
      'b',
      'keep.webp',
      'keep.webp',
      'images/keep.webp',
    );
    db.close();
    const mapPath = join(dir, 'map.json');
    writeFileSync(mapPath, JSON.stringify(MAP));

    run(dbPath, mapPath, true);

    const check = new Database(dbPath, { readonly: true });
    const a = check.prepare('SELECT * FROM media WHERE id = ?').get('a');
    assert.equal(a.storage_path, 'images/2025/12/bye-bye-dji.webp');
    assert.equal(a.filename, 'bye-bye-dji.webp');
    assert.equal(a.original_name, 'bye-bye-dji.webp', 'displayed name must update too');
    const b = check.prepare('SELECT * FROM media WHERE id = ?').get('b');
    assert.equal(b.storage_path, 'images/keep.webp', 'unrelated row untouched');
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('is idempotent — second --apply run changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mediadb-'));
  try {
    const { db, dbPath } = makeDb(dir);
    db.prepare('INSERT INTO media VALUES (?,?,?,?)').run(
      'a',
      'image-17.webp',
      'image-17.webp',
      'images/2025/12/image-17.webp',
    );
    db.close();
    const mapPath = join(dir, 'map.json');
    writeFileSync(mapPath, JSON.stringify(MAP));

    assert.equal(run(dbPath, mapPath, true).status, 0);
    const out2 = run(dbPath, mapPath, true); // re-run
    assert.equal(out2.status, 0);
    assert.match(out2.out, /already applied: 1/);
    assert.match(out2.out, /No write performed|0 media row/);

    const check = new Database(dbPath, { readonly: true });
    const a = check.prepare('SELECT * FROM media WHERE id = ?').get('a');
    assert.equal(a.storage_path, 'images/2025/12/bye-bye-dji.webp');
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aborts (exit 1) when newStorage already belongs to a different row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mediadb-'));
  try {
    const { db, dbPath } = makeDb(dir);
    db.prepare('INSERT INTO media VALUES (?,?,?,?)').run(
      'a',
      'image-17.webp',
      'image-17.webp',
      'images/2025/12/image-17.webp',
    );
    // A DIFFERENT row already sitting at the target path → collision.
    db.prepare('INSERT INTO media VALUES (?,?,?,?)').run(
      'c',
      'bye-bye-dji.webp',
      'bye-bye-dji.webp',
      'images/2025/12/bye-bye-dji.webp',
    );
    db.close();
    const mapPath = join(dir, 'map.json');
    writeFileSync(mapPath, JSON.stringify(MAP));

    const res = run(dbPath, mapPath, true);
    assert.equal(res.status, 1, 'collision must exit non-zero');
    assert.match(res.out, /ABORT|collision/i);

    // Original row unchanged (transaction never ran).
    const check = new Database(dbPath, { readonly: true });
    const a = check.prepare('SELECT * FROM media WHERE id = ?').get('a');
    assert.equal(a.storage_path, 'images/2025/12/image-17.webp', 'no partial write on abort');
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
