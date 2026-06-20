// @ts-nocheck
/**
 * syndication-log.test.js — durable cross-post marker (migration 013).
 *
 * Skips transparently if better-sqlite3 won't load, mirroring bluesky.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let svc;
let tempDir;
let skip = false;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'synlog-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  try {
    svc = await import('../src/services/syndication-log.js');
  } catch {
    skip = true;
  }
});

after(() => {
  if (svc && svc.__test) svc.__test.reset();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('hasSyndicated flips false → true after recordSyndication; per-slug + per-platform', () => {
  if (skip) return;
  assert.equal(svc.hasSyndicated('p1', 'bluesky'), false);
  svc.recordSyndication('p1', 'bluesky', 'at://x');
  assert.equal(svc.hasSyndicated('p1', 'bluesky'), true);
  assert.equal(svc.hasSyndicated('p1', 'mastodon'), false); // platform-scoped
  assert.equal(svc.hasSyndicated('p2', 'bluesky'), false); // slug-scoped
});

test('recordSyndication is an idempotent upsert (no PK violation on repeat)', () => {
  if (skip) return;
  svc.recordSyndication('p3', 'mastodon', 'https://a');
  svc.recordSyndication('p3', 'mastodon', 'https://b');
  assert.equal(svc.hasSyndicated('p3', 'mastodon'), true);
});

test('missing slug/platform are safe no-ops', () => {
  if (skip) return;
  assert.equal(svc.hasSyndicated('', 'bluesky'), false);
  svc.recordSyndication('', 'bluesky', 'x'); // must not throw
  assert.equal(svc.hasSyndicated('p4', ''), false);
});
