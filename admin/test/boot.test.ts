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

test('GET /auth/status is NOT metered by the brute-force limiter', async () => {
  // The SPA pings /auth/status on every page load. If the auth limiter
  // (20 req / 15 min) counts those GETs, a normal user locks themself
  // out of the admin within minutes of ordinary clicking around —
  // it must meter credential attempts (POSTs) only.
  const { app } = await import('../server.js');
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    let last;
    for (let i = 0; i < 30; i++) {
      last = await fetch(`http://127.0.0.1:${port}/auth/status`);
    }
    assert.equal(last.status, 200, '30th status ping still answers 200');

    // POST credential attempts ARE metered: hammering login eventually
    // draws a 429 instead of an auth error.
    let sawLimit = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/auth/login/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nope', password: 'wrong-password' }),
      });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, 'repeated login POSTs hit the rate limiter');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
