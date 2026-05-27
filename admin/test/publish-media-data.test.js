// @ts-nocheck
/**
 * publish-media-data.test.js — Phase 6 media data builder.
 *
 * Verifies that buildMediaData/writeMediaData correctly:
 *   - serialise every media row with the expected shape
 *   - parse conversions_json into a real object
 *   - skip rows whose original file doesn't exist on disk
 *     (Phase 5d's dev-seeded fixtures must not pollute media.json)
 *   - write valid JSON to site/data/media.json
 *
 * Same skip-on-binding-failure pattern as the other admin tests.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let dbPath;
let siteDir;
let staticDir;
let dataDir;
let skipReason = false;
let Database;
let publishMediaData;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-publish-media-test-'));
  dbPath = join(tempDir, 'auth-test.db');
  siteDir = join(tempDir, 'site');
  staticDir = join(siteDir, 'static');
  dataDir = join(siteDir, 'data');
  mkdirSync(staticDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Verify better-sqlite3 native binding (same escape hatch as
  // media.test.js for macOS Node ABI mismatches).
  try {
    Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Apply migrations against the temp DB.
  process.env.AUTH_DB_PATH = dbPath;
  process.env.SITE_DIR = siteDir;
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  publishMediaData = await import('../src/services/publish-media-data.js');
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Seed a media row + (optionally) a fake file on disk so the builder
 * either includes or skips it.
 * @param opts
 */
function seedRow(opts) {
  const db = new Database(dbPath);
  const uploadedAt = opts.uploadedAt || Date.UTC(2026, 4, 16); // 2026-05-16
  const d = new Date(uploadedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const category = opts.mime.startsWith('image/') ? 'images' : 'files';
  const dirOnDisk = join(staticDir, category, String(yyyy), mm);
  if (opts.writeFile) {
    mkdirSync(dirOnDisk, { recursive: true });
    writeFileSync(join(dirOnDisk, opts.filename), 'fake bytes');
  }
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size,
                        width, height, duration, hash, conversions_json,
                        status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, '[]')`,
  ).run(
    opts.id,
    opts.filename,
    opts.originalName,
    opts.mime,
    opts.size || 100,
    opts.width ?? null,
    opts.height ?? null,
    opts.duration ?? null,
    opts.hash,
    JSON.stringify(opts.conversions || {}),
    uploadedAt,
  );
  db.close();
}

test('buildMediaData skips rows whose file is missing', skipOpts(), () => {
  // Two rows: one with a real file on disk, one without.
  seedRow({
    id: 'real-1',
    filename: 'aaaaaaaa-hello.png',
    originalName: 'hello.png',
    mime: 'image/png',
    hash: 'a'.repeat(64),
    writeFile: true,
    width: 100,
    height: 50,
    conversions: { 'webp-640': '/images/2026/05/aaaaaaaa-hello.webp' },
  });
  seedRow({
    id: 'ghost-1',
    filename: 'bbbbbbbb-ghost.png',
    originalName: 'ghost.png',
    mime: 'image/png',
    hash: 'b'.repeat(64),
    writeFile: false,
  });

  const result = publishMediaData.buildMediaData({ dbPath, siteDir });
  assert.equal(result.total, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.map['real-1'], 'real row is present');
  assert.equal(result.map['ghost-1'], undefined, 'ghost row is skipped');
});

test('shapeMediaForData includes the expected fields', skipOpts(), () => {
  const result = publishMediaData.buildMediaData({ dbPath, siteDir });
  const entry = result.map['real-1'];
  assert.equal(entry.filename, 'aaaaaaaa-hello.png');
  assert.equal(entry.original_filename, 'hello.png');
  assert.equal(entry.mime_type, 'image/png');
  assert.equal(entry.type, 'image');
  assert.equal(entry.width, 100);
  assert.equal(entry.height, 50);
  assert.equal(entry.original_url, '/images/2026/05/aaaaaaaa-hello.png');
  // conversions_json must be parsed back into a real object, not a string.
  assert.deepEqual(entry.conversions, { 'webp-640': '/images/2026/05/aaaaaaaa-hello.webp' });
});

test('writeMediaData writes valid JSON to site/data/media.json', skipOpts(), () => {
  const result = publishMediaData.writeMediaData({ dbPath, siteDir });
  assert.equal(result.path, join(dataDir, 'media.json'));
  assert.equal(result.count, 1, 'one entry (ghost skipped)');
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 2);
  assert.ok(existsSync(result.path));
  const parsed = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.ok(parsed['real-1']);
  assert.equal(parsed['real-1'].mime_type, 'image/png');
});

test('includeMissing:true emits ghosts too', skipOpts(), () => {
  const result = publishMediaData.buildMediaData({ dbPath, siteDir, includeMissing: true });
  assert.equal(result.total, 2);
  assert.equal(result.skipped, 0);
  assert.ok(result.map['ghost-1'], 'ghost row included when includeMissing is true');
});

test('builder copes with a missing database (returns empty map)', skipOpts(), () => {
  const result = publishMediaData.buildMediaData({
    dbPath: join(tempDir, 'does-not-exist.db'),
    siteDir,
  });
  assert.deepEqual(result, { map: {}, total: 0, skipped: 0 });
});
