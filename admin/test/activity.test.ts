// @ts-nocheck
/**
 * activity.test.js — Phase 5e activity log. Verifies non-blocking
 * insert + recent-list ordering.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

let activity;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-act-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  mkdirSync(join(tempDir, 'site', 'content', 'posts'), { recursive: true });
  process.env.SITE_DIR = join(tempDir, 'site');

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  activity = await import('../src/services/activity.js');

  const express = (await import('express')).default;
  const router = (await import('../src/routes/activity.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/activity', router);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('logActivity returns synchronously (non-blocking)', skipOpts(), async () => {
  // The call should return undefined immediately and never throw.
  const start = Date.now();
  const result = activity.logActivity({ user: 'tester', action: 'post.create', target: 'a.md' });
  const elapsed = Date.now() - start;
  assert.equal(result, undefined);
  assert.ok(elapsed < 50, `expected <50ms, got ${elapsed}`);
});

test('recentActivity returns logged rows in DESC order', skipOpts(), async () => {
  activity.logActivity({ user: 'tester', action: 'post.update', target: 'b.md' });
  activity.logActivity({ user: 'tester', action: 'post.delete', target: 'c.md' });
  await activity.__test.flush();
  const items = activity.recentActivity({ limit: 10 });
  assert.ok(items.length >= 3);
  // newest first
  assert.equal(items[0].action, 'post.delete');
});

test('GET /api/activity returns recent rows', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/activity?limit=5`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
});

test('filter by action narrows results', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/activity?action=post.delete`);
  const body = await res.json();
  for (const it of body.items) assert.equal(it.action, 'post.delete');
});
