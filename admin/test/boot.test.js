// @ts-check
/**
 * boot.test.js — server boot smoke test.
 *
 * Importing server.js must build the FULL Express app (every route registers)
 * without throwing. Per-router unit tests mount routers in isolation and so
 * never exercise the whole server — which is how an Express-incompatible `*`
 * route (the Express 5 bump) crash-looped production with green CI. This test
 * closes that gap: any boot-time/route-registration error fails it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-boot-test-'));
  process.env.NODE_ENV = 'test'; // suppress app.listen()
  process.env.CONVERSION_WORKER = 'off';
  process.env.REMARK42_POLLER = 'off';
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db'); // hermetic temp DB
  process.env.SITE_DIR = join(tempDir, 'site');
  process.env.SESSION_SECRET = 'test-secret-for-boot';
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('server.js builds the full Express app without throwing', async () => {
  // The import itself runs every app.use()/app.get() registration; a bad
  // route (e.g. Express-incompatible path) throws here and fails the test.
  const mod = await import('../server.js');
  assert.ok(mod.app, 'server exports the Express app');
  assert.equal(typeof mod.app, 'function', 'app is an Express handler');
  assert.equal(typeof mod.app.use, 'function', 'app has Express methods');
});
