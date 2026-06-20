// @ts-nocheck
/**
 * redirects.test.js — Phase 5e redirects manager.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let siteDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-redir-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  siteDir = join(tempDir, 'site');
  mkdirSync(join(siteDir, 'data'), { recursive: true });
  process.env.SITE_DIR = siteDir;

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  const express = (await import('express')).default;
  const router = (await import('../src/routes/redirects.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/redirects', router);

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

test('GET returns empty array by default', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/redirects`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(list, []);
});

test('POST creates a redirect with id', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/redirects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '/old-url', to: '/new-url' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.from, '/old-url');
  assert.equal(body.to, '/new-url');
  assert.equal(body.code, 301);
});

test('POST refuses duplicate from', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/redirects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '/old-url', to: '/another' }),
  });
  assert.equal(res.status, 409);
});

test('GET returns the created rows', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/redirects`);
  const list = await res.json();
  assert.equal(list.length, 1);
});

test('DELETE removes a redirect', skipOpts(), async () => {
  const list = await (await fetch(`${baseUrl}/api/redirects`)).json();
  const id = list[0].id;
  const res = await fetch(`${baseUrl}/api/redirects/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  const after = await (await fetch(`${baseUrl}/api/redirects`)).json();
  assert.equal(after.length, 0);
});

test('POST /import bulk-upserts rows, skips invalid, collapses chains', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/redirects/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { from: '/a', to: '/b', code: 301 },
        { from: '/b', to: '/c', code: 301 }, // chains: /a should collapse to /c
        { from: '/x', to: '/x' }, // invalid self-redirect → skipped
        { from: '', to: '/y' }, // invalid → skipped
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.imported, 2);
  assert.equal(body.skipped, 2);
  const list = await (await fetch(`${baseUrl}/api/redirects`)).json();
  const a = list.find((r) => r.from === '/a');
  assert.ok(a, '/a imported');
  assert.equal(a.to, '/c', 'chain collapsed (/a → /c, not /a → /b)');
});

test('PUT rejects a non-allowlisted code instead of persisting garbage', skipOpts(), async () => {
  // Seed a fresh row to update (unique paths so no chain/loop collision).
  const created = await (
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/put-code-src', to: '/put-code-dst' }),
    })
  ).json();
  assert.ok(created.id);
  assert.equal(created.code, 301);

  // Non-numeric code → Number('abc') is NaN; must 400, not be written as null.
  const bad = await fetch(`${baseUrl}/api/redirects/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'abc' }),
  });
  assert.equal(bad.status, 400);

  // Out-of-allowlist numeric code → also rejected (not silently persisted).
  const bad2 = await fetch(`${baseUrl}/api/redirects/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 999 }),
  });
  assert.equal(bad2.status, 400);

  // The stored code is untouched — still the original 301, never NaN/null/999.
  const list = await (await fetch(`${baseUrl}/api/redirects`)).json();
  const row = list.find((r) => r.id === created.id);
  assert.equal(row.code, 301);
});

test('PUT accepts a valid allowlisted code change', skipOpts(), async () => {
  const created = await (
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/put-ok-src', to: '/put-ok-dst' }),
    })
  ).json();
  const ok = await fetch(`${baseUrl}/api/redirects/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 308 }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.code, 308);
});
