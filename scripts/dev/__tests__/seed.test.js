// @ts-nocheck
/**
 * scripts/dev/__tests__/seed.test.js — Phase 5d.
 *
 * Drives the seed module against an isolated temp-file SQLite DB. Same
 * pattern as admin/test/auth.test.js — never mock better-sqlite3, never
 * touch the developer's real auth.db.
 *
 * Vitest's `pool: forks` isolation makes AUTH_DB_PATH safe to set per
 * file (the env var doesn't leak between workers).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Resolve bcrypt + better-sqlite3 from admin/node_modules so the tests
// don't need duplicate root deps. Matches the strategy in
// scripts/dev/seed.mjs.
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRequire = createRequire(resolve(__dirname, '..', '..', '..', 'admin', 'package.json'));

let tempDir;
let dbPath;
let nativeBindingAvailable = true;
let bindingError = '';

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-seed-test-'));
  dbPath = join(tempDir, 'auth-dev.db');
  process.env.AUTH_DB_PATH = dbPath;

  // Probe better-sqlite3 — if it can't load (ABI mismatch on macOS dev
  // hosts with newer Node), skip rather than fail the whole suite.
  try {
    const Database = adminRequire('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    nativeBindingAvailable = false;
    bindingError = err.message.split('\n')[0];
  }
});

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('seed.mjs', () => {
  it('creates the dev admin user on first run', async () => {
    if (!nativeBindingAvailable) {
      console.warn(`skipping: ${bindingError}`);
      return;
    }
    const { runSeed, DEV_ADMIN } = await import('../seed.mjs');
    const result = await runSeed();
    expect(result.user.created).toBe(true);
    expect(result.user.id).toMatch(/^[a-f0-9]{32}$/);

    const Database = adminRequire('better-sqlite3');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT username FROM users').get();
    db.close();
    expect(row.username).toBe(DEV_ADMIN.username);
  });

  it('is idempotent — second run skips the user', async () => {
    if (!nativeBindingAvailable) return;
    const { runSeed } = await import('../seed.mjs');
    const result = await runSeed();
    expect(result.user.created).toBe(false);
  });

  it('seeds five media fixtures, skips on re-run', async () => {
    if (!nativeBindingAvailable) return;
    const { runSeed, SAMPLE_MEDIA } = await import('../seed.mjs');
    // First call already ran in earlier test — re-run should skip all.
    const result = await runSeed();
    expect(result.media.inserted).toBe(0);
    expect(result.media.skipped).toBe(SAMPLE_MEDIA.length);

    const Database = adminRequire('better-sqlite3');
    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as n FROM media').get();
    db.close();
    expect(count.n).toBe(SAMPLE_MEDIA.length);
  });

  it('the seeded user can be authenticated with bcrypt', async () => {
    if (!nativeBindingAvailable) return;
    const bcrypt = adminRequire('bcrypt');
    const Database = adminRequire('better-sqlite3');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
    db.close();
    expect(row).toBeTruthy();
    const ok = await bcrypt.compare('password', row.password_hash);
    expect(ok).toBe(true);
  });

  it('writes the DB to AUTH_DB_PATH', () => {
    if (!nativeBindingAvailable) return;
    expect(existsSync(dbPath)).toBe(true);
  });
});
