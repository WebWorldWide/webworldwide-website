// @ts-nocheck
/**
 * dedupe-media.test.js — content-hash dedupe of the media library.
 *
 * Fixture (temp dir): two byte-identical images (both referenced by
 * different posts), each with a `-320w` variant, plus one unique image.
 * Canonical selection prefers a referenced copy then the OLDEST file, so
 * `keep.webp` (older) wins over `dup.webp` (newer).
 *
 * Asserts: the dry-run plan, that --apply rewrites post references
 * (base + variant) and deletes the duplicate's row + files, and that a
 * second --apply is a no-op (idempotency).
 *
 * Self-skips (like media.test.js) when better-sqlite3 can't load.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let mediaRoot;
let imagesDir;
let postsDir;
let dbPath;
let dedupe;
let skipReason = false;

const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

const IMG = (name) => `/images/2025/12/${name}`;

function seedRow(db, { id, name, uploadedAt }) {
  db.prepare(
    `INSERT INTO media (
        id, filename, original_name, mime_type, size,
        width, height, duration, hash,
        conversions_json, status, uploaded_at, post_refs_json, storage_path
      ) VALUES (?, ?, ?, 'image/webp', ?, NULL, NULL, NULL, ?, '{}', 'ready', ?, '[]', ?)`,
  ).run(id, name, name, 4, `seed-${id}`, uploadedAt, `images/2025/12/${name}`);
}

/** (Re)create the on-disk fixture + DB rows from scratch. */
async function buildFixture() {
  const Database = (await import('better-sqlite3')).default;
  const { runMigrations } = await import('../src/db/migrate.js');

  // Files: keep/dup share bytes ("SAME"); each has a distinct variant;
  // unique is its own content.
  writeFileSync(join(imagesDir, 'keep.webp'), 'SAME');
  writeFileSync(join(imagesDir, 'keep-320w.webp'), 'KEEP-VARIANT');
  writeFileSync(join(imagesDir, 'dup.webp'), 'SAME');
  writeFileSync(join(imagesDir, 'dup-320w.webp'), 'DUP-VARIANT');
  writeFileSync(join(imagesDir, 'unique.webp'), 'UNIQUE-BYTES');

  // Posts: post-1 references keep (older) + unique; post-2 references dup
  // (newer) + its variant. Both keep & dup are referenced → tie-break to
  // the oldest, keep.
  writeFileSync(
    join(postsDir, 'post-1.md'),
    `---\ntitle: Post One\n---\n![keep](${IMG('keep.webp')})\n![u](${IMG('unique.webp')})\n`,
  );
  writeFileSync(
    join(postsDir, 'post-2.md'),
    `---\ntitle: Post Two\n---\n![dup](${IMG('dup.webp')})\n![v](${IMG('dup-320w.webp')})\n`,
  );

  rmSync(dbPath, { force: true });
  runMigrations(dbPath);
  const db = new Database(dbPath);
  seedRow(db, { id: 'keep1', name: 'keep.webp', uploadedAt: 1000 });
  seedRow(db, { id: 'dup1', name: 'dup.webp', uploadedAt: 2000 });
  seedRow(db, { id: 'uniq1', name: 'unique.webp', uploadedAt: 1500 });
  db.close();
}

function countRows() {
  // Lightweight read via a throwaway connection so we don't hold a handle.
  return import('better-sqlite3').then(({ default: Database }) => {
    const db = new Database(dbPath);
    const ids = db
      .prepare('SELECT id FROM media ORDER BY id')
      .all()
      .map((r) => r.id);
    db.close();
    return ids;
  });
}

before(async () => {
  process.env.NODE_ENV = 'test';
  tempDir = mkdtempSync(join(tmpdir(), 't80-dedupe-test-'));
  mediaRoot = join(tempDir, 'site', 'public');
  imagesDir = join(mediaRoot, 'images', '2025', '12');
  postsDir = join(tempDir, 'site', 'content', 'posts');
  dbPath = join(tempDir, 'auth.db');
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(postsDir, { recursive: true });

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  dedupe = await import('../scripts/dedupe-media.js');
  await buildFixture();
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const opts = (extra) => ({
  dbPath,
  mediaRoot,
  postsDir,
  quiet: true,
  ...extra,
});

test('dry-run: plans the dedupe without touching disk or DB', skipOpts(), async () => {
  const before2 = readFileSync(join(postsDir, 'post-2.md'), 'utf8');
  const res = dedupe.main(opts());

  assert.equal(res.applied, false);
  assert.equal(res.groups.length, 1, 'one duplicate group');
  const g = res.groups[0];
  assert.equal(g.canonical.url, IMG('keep.webp'), 'oldest referenced copy is canonical');
  assert.deepEqual(
    g.duplicates.map((d) => d.url),
    [IMG('dup.webp')],
  );

  // Rewrites: base + variant, both in post-2.
  const fromTo = res.rewrites.map((r) => `${r.file}:${r.from}=>${r.to}`).sort();
  assert.deepEqual(fromTo, [
    `post-2.md:${IMG('dup-320w.webp')}=>${IMG('keep-320w.webp')}`,
    `post-2.md:${IMG('dup.webp')}=>${IMG('keep.webp')}`,
  ]);

  // Deletion set: the duplicate row + its base + variant files.
  assert.equal(res.deletions.length, 1);
  assert.equal(res.deletions[0].id, 'dup1');
  assert.deepEqual(res.deletions[0].files.sort(), [IMG('dup-320w.webp'), IMG('dup.webp')]);

  // Nothing actually changed.
  assert.equal(readFileSync(join(postsDir, 'post-2.md'), 'utf8'), before2);
  assert.ok(existsSync(join(imagesDir, 'dup.webp')), 'dup file still present after dry-run');
  assert.deepEqual(await countRows(), ['dup1', 'keep1', 'uniq1']);
});

test('--apply: rewrites posts, deletes duplicate row + files', skipOpts(), async () => {
  const res = dedupe.main(opts({ apply: true }));
  assert.equal(res.applied, true);

  // post-2 now points at the canonical base + variant.
  const post2 = readFileSync(join(postsDir, 'post-2.md'), 'utf8');
  assert.ok(post2.includes(IMG('keep.webp')), 'base ref rewritten');
  assert.ok(post2.includes(IMG('keep-320w.webp')), 'variant ref rewritten');
  assert.ok(!post2.includes(IMG('dup.webp')), 'no leftover dup base ref');
  assert.ok(!post2.includes(IMG('dup-320w.webp')), 'no leftover dup variant ref');

  // Duplicate files gone; canonical + unique untouched.
  assert.ok(!existsSync(join(imagesDir, 'dup.webp')));
  assert.ok(!existsSync(join(imagesDir, 'dup-320w.webp')));
  assert.ok(existsSync(join(imagesDir, 'keep.webp')));
  assert.ok(existsSync(join(imagesDir, 'keep-320w.webp')));
  assert.ok(existsSync(join(imagesDir, 'unique.webp')));

  // Duplicate row removed.
  assert.deepEqual(await countRows(), ['keep1', 'uniq1']);
});

test('idempotency: a second --apply is a no-op', skipOpts(), async () => {
  const post2Before = readFileSync(join(postsDir, 'post-2.md'), 'utf8');
  const res = dedupe.main(opts({ apply: true }));
  assert.equal(res.applied, false, 'no groups → nothing applied');
  assert.equal(res.groups.length, 0);
  assert.equal(res.rewrites.length, 0);
  assert.equal(res.deletions.length, 0);
  assert.equal(readFileSync(join(postsDir, 'post-2.md'), 'utf8'), post2Before);
  assert.deepEqual(await countRows(), ['keep1', 'uniq1']);
});
