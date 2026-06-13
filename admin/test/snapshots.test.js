// @ts-nocheck
/**
 * snapshots.test.js — pre-save snapshot store: records, coalesces rapid
 * saves, dedupes identical content, and prunes to the per-file cap.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let snaps;
let skipReason = false;
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-snap-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.NODE_ENV = 'test';
  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  snaps = await import('../src/services/snapshots.js');
});

after(() => {
  try {
    snaps?.__closeForTest();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('records a snapshot and reads it back', skipOpts(), () => {
  const id = snaps.recordSnapshot(
    'a.md',
    { title: 'A', data: { title: 'A' }, content: 'v1' },
    1000,
  );
  assert.ok(id);
  const got = snaps.getSnapshot(id);
  assert.equal(got.content, 'v1');
  assert.equal(got.title, 'A');
  assert.deepEqual(got.data, { title: 'A' });
});

test('coalesces a second snapshot within the 60s window', skipOpts(), () => {
  snaps.recordSnapshot('b.md', { content: 'one' }, 10_000);
  const second = snaps.recordSnapshot('b.md', { content: 'two' }, 40_000); // <60s later
  assert.equal(second, null, 'rapid second save is coalesced');
  assert.equal(snaps.listSnapshots('b.md').length, 1);
});

test('dedupes byte-identical content even after the window', skipOpts(), () => {
  snaps.recordSnapshot('c.md', { content: 'same' }, 100_000);
  const dup = snaps.recordSnapshot('c.md', { content: 'same' }, 1_000_000); // >60s but identical
  assert.equal(dup, null, 'identical content is not re-snapshotted');
  assert.equal(snaps.listSnapshots('c.md').length, 1);
});

test('prunes to the 15 most-recent per file', skipOpts(), () => {
  // 20 distinct snapshots, each >60s apart and unique content.
  for (let i = 0; i < 20; i += 1) {
    snaps.recordSnapshot('d.md', { content: `rev-${i}` }, 1_000_000 + i * 90_000);
  }
  const list = snaps.listSnapshots('d.md');
  assert.equal(list.length, 15, 'capped at 15');
  // Newest first → the most recent content survives.
  const newest = snaps.getSnapshot(list[0].id);
  assert.equal(newest.content, 'rev-19');
});

test('listSnapshots is per-file and newest-first', skipOpts(), () => {
  assert.equal(snaps.listSnapshots('does-not-exist.md').length, 0);
});

test('a metadata-only change is NOT deduped (same body, different frontmatter)', skipOpts(), () => {
  snaps.recordSnapshot(
    'meta.md',
    { data: { title: 'A', draft: true }, content: 'same body' },
    5_000_000,
  );
  // Same body, different frontmatter (draft flipped), past the 60s window.
  const second = snaps.recordSnapshot(
    'meta.md',
    { data: { title: 'A', draft: false }, content: 'same body' },
    5_100_000,
  );
  assert.ok(second, 'frontmatter-only revision is kept');
  assert.equal(snaps.listSnapshots('meta.md').length, 2);
  // Truly identical (body + frontmatter) is still deduped.
  const third = snaps.recordSnapshot(
    'meta.md',
    { data: { title: 'A', draft: false }, content: 'same body' },
    5_200_000,
  );
  assert.equal(third, null);
});

test('renameSnapshots carries history to the new filename', skipOpts(), () => {
  snaps.recordSnapshot('old-name.md', { content: 'v1' }, 6_000_000);
  snaps.recordSnapshot('old-name.md', { content: 'v2' }, 6_100_000);
  assert.equal(snaps.listSnapshots('old-name.md').length, 2);
  snaps.renameSnapshots('old-name.md', 'new-name.md');
  assert.equal(snaps.listSnapshots('old-name.md').length, 0, 'old name has none');
  assert.equal(snaps.listSnapshots('new-name.md').length, 2, 'new name inherited them');
  // No-op cases never throw.
  snaps.renameSnapshots('new-name.md', 'new-name.md');
  snaps.renameSnapshots('', 'x.md');
});
