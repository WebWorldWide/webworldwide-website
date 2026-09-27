// @ts-nocheck
/**
 * backfill-alt-text.test.js — seeds media.alt_text from post markdown.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let postsDir;
let dbPath;
let skipReason = false;

const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-altfill-test-'));
  dbPath = join(tempDir, 'auth.db');
  process.env.NODE_ENV = 'test';
  postsDir = join(tempDir, 'site', 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });

  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Posts: one good alt, one filename-ish alt, one cover pair, and a
  // second reference to the first image with a LONGER alt (longest wins).
  writeFileSync(
    join(postsDir, 'one.md'),
    [
      '---',
      'title: One',
      'cover: /images/2025/12/cover.webp',
      'cover_alt: A sunrise over the test fixtures',
      '---',
      '![Back of a big laptop](/images/2025/12/laptop.webp)',
      '![image-19.webp](/images/2025/12/ignored.webp)',
    ].join('\n'),
  );
  writeFileSync(
    join(postsDir, 'two.md'),
    '![Back of a big gaming laptop on a desk](/images/2025/12/laptop.webp)\n',
  );
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Insert a minimal media row.
 * @param db
 * @param root0
 * @param root0.id
 * @param root0.filename
 * @param root0.storagePath
 * @param root0.alt
 * @param root0.mime
 */
function seedRow(db, { id, filename, storagePath, alt = null, mime = 'image/webp' }) {
  db.prepare(
    `INSERT INTO media (
        id, filename, original_name, mime_type, size, hash,
        conversions_json, status, uploaded_at, post_refs_json, storage_path, alt_text
      ) VALUES (?, ?, ?, ?, 1, ?, '{}', 'ready', ?, '[]', ?, ?)`,
  ).run(id, filename, filename, mime, `hash-${id}`, Date.UTC(2025, 11, 1), storagePath, alt);
}

test(
  'collectAltMap extracts body + cover alts, ignores filename-ish, longest wins',
  skipOpts(),
  async () => {
    const { collectAltMap } = await import('../scripts/backfill-alt-text.js');
    const map = collectAltMap(postsDir);
    assert.equal(map.get('/images/2025/12/laptop.webp'), 'Back of a big gaming laptop on a desk');
    assert.equal(map.get('/images/2025/12/cover.webp'), 'A sunrise over the test fixtures');
    assert.equal(map.has('/images/2025/12/ignored.webp'), false);
  },
);

test('isFilenameLikeAlt catches filenames and row-name echoes', skipOpts(), async () => {
  const { isFilenameLikeAlt } = await import('../scripts/backfill-alt-text.js');
  assert.equal(isFilenameLikeAlt('image-19.webp'), true);
  assert.equal(isFilenameLikeAlt(''), true);
  assert.equal(isFilenameLikeAlt('  '), true);
  assert.equal(isFilenameLikeAlt('My photo (edited).JPG'), true);
  assert.equal(isFilenameLikeAlt('A laptop on a desk'), false);
  assert.equal(isFilenameLikeAlt('anything', { filename: 'anything' }), true);
});

test(
  'main fills empty alt_text, preserves existing, is idempotent, honors dry-run',
  skipOpts(),
  async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    process.env.AUTH_DB_PATH = dbPath;
    runMigrations(dbPath);

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    seedRow(db, {
      id: 'laptop',
      filename: 'laptop.webp',
      storagePath: 'images/2025/12/laptop.webp',
    });
    seedRow(db, {
      id: 'cover',
      filename: 'cover.webp',
      storagePath: 'images/2025/12/cover.webp',
      alt: 'Hand-written alt that must survive',
    });
    seedRow(db, {
      id: 'orphan',
      filename: 'orphan.webp',
      storagePath: 'images/2025/12/orphan.webp',
    });
    db.close();

    const { main } = await import('../scripts/backfill-alt-text.js');

    // Dry run: counts but no writes.
    const dry = main({ dryRun: true, dbPath, postsDir });
    assert.equal(dry.updated, 1);
    let check = new Database(dbPath);
    assert.equal(
      check.prepare('SELECT alt_text FROM media WHERE id = ?').get('laptop').alt_text,
      null,
    );
    check.close();

    // Real run.
    const real = main({ dryRun: false, dbPath, postsDir });
    assert.equal(real.updated, 1);
    assert.equal(real.skippedHasAlt, 1);
    assert.equal(real.skippedNoMatch, 1);

    check = new Database(dbPath);
    assert.equal(
      check.prepare('SELECT alt_text FROM media WHERE id = ?').get('laptop').alt_text,
      'Back of a big gaming laptop on a desk',
    );
    assert.equal(
      check.prepare('SELECT alt_text FROM media WHERE id = ?').get('cover').alt_text,
      'Hand-written alt that must survive',
    );
    check.close();

    // Idempotent: a second run updates nothing.
    const again = main({ dryRun: false, dbPath, postsDir });
    assert.equal(again.updated, 0);
    assert.equal(again.skippedHasAlt, 2);
  },
);
