// @ts-nocheck
/**
 * scripts/dev/__tests__/reset.test.js — Phase 5d.
 *
 * Exercises the purge helpers and the full runReset flow against a
 * temp-file DB. Confirm prompt is bypassed by injecting a `confirmFn`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRequire = createRequire(resolve(__dirname, '..', '..', '..', 'admin', 'package.json'));

let tempDir;
let dbPath;
let imagesDir;
let nativeBindingAvailable = true;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-reset-test-'));
  dbPath = join(tempDir, 'auth-dev.db');
  imagesDir = join(tempDir, 'site', 'static', 'images');
  mkdirSync(imagesDir, { recursive: true });
  process.env.AUTH_DB_PATH = dbPath;

  try {
    const Database = adminRequire('better-sqlite3');
    new Database(':memory:').close();
  } catch {
    nativeBindingAvailable = false;
  }
});

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('reset.mjs purge helpers', () => {
  beforeEach(() => {
    // Re-create a stub DB + sidecars for each test.
    for (const f of ['', '-wal', '-shm']) {
      writeFileSync(`${dbPath}${f}`, 'stub');
    }
  });

  it('purgeDb removes the .db and WAL/SHM siblings', async () => {
    const { purgeDb } = await import('../reset.mjs');
    const removed = purgeDb(dbPath);
    expect(removed.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it('purgeDevUploads only deletes fixture- and *-dev-* files', async () => {
    const { purgeDevUploads } = await import('../reset.mjs');
    writeFileSync(join(imagesDir, 'fixture-foo.png'), 'x');
    writeFileSync(join(imagesDir, 'real-photo-dev-meta.png'), 'x');
    writeFileSync(join(imagesDir, 'committed-hero.png'), 'x'); // must NOT be touched
    const removed = purgeDevUploads(imagesDir);
    expect(removed.length).toBe(2);
    expect(existsSync(join(imagesDir, 'committed-hero.png'))).toBe(true);
    expect(existsSync(join(imagesDir, 'fixture-foo.png'))).toBe(false);
  });

  it('purgeDevUploads is a no-op for non-existent directory', async () => {
    const { purgeDevUploads } = await import('../reset.mjs');
    const removed = purgeDevUploads(join(tempDir, 'nope', 'images'));
    expect(removed).toEqual([]);
  });
});

describe('reset.mjs runReset', () => {
  it('aborts cleanly when confirm returns false', async () => {
    if (!nativeBindingAvailable) return;
    const { runReset } = await import('../reset.mjs');
    const out = await runReset({ confirmFn: async () => false, dbPath });
    expect(out.db).toEqual([]);
    expect(out.seeded).toBe(null);
  });

  it('runs full reset → reseed when confirmed', async () => {
    if (!nativeBindingAvailable) return;
    // The purge-helpers describe block leaves stub bytes at dbPath via its
    // own beforeEach — clear them so runSeed can open a real SQLite file.
    for (const f of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${f}`, { force: true });
      } catch {
        /* swallow: best-effort cleanup */
      }
    }
    // Pre-seed a real DB so reset has something to wipe.
    const { runSeed } = await import('../seed.mjs');
    process.env.AUTH_DB_PATH = dbPath;
    await runSeed();
    expect(existsSync(dbPath)).toBe(true);

    const { runReset } = await import('../reset.mjs');
    const out = await runReset({ confirmFn: async () => true, dbPath });
    // The seed re-ran, so the user should be created again.
    expect(out.seeded).toBeTruthy();
    expect(out.seeded.user.created).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });
});
