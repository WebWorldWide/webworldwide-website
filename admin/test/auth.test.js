// @ts-nocheck
/**
 * Integration tests for admin/src/routes/auth.js.
 *
 * DB rule: real SQLite, never mocked. We point AUTH_DB_PATH at a fresh
 * temp-file DB per process so tests are hermetic and cannot touch the
 * production admin/data/auth.db.
 *
 * Strategy:
 *   1. Set AUTH_DB_PATH to a temp file BEFORE importing the auth route
 *      (the route's `new Database(dbPath)` runs at module-load time).
 *   2. Dynamic-import the router, mount it on a fresh Express app,
 *      start the server on port 0 to get a random ephemeral port.
 *   3. Exercise via Node's built-in fetch.
 *   4. Clean up the temp DB on `after`.
 *
 * Local-only escape hatch: if better-sqlite3's native binding fails to
 * load (ABI mismatch on macOS dev hosts with newer Node), all tests
 * mark themselves skipped with a descriptive reason. CI runs Node 20
 * on Linux where the prebuilt binary always matches.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-auth-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth-test.db');
  process.env.SESSION_SECRET = 'test-secret-for-cookie-signing';
  process.env.NODE_ENV = 'test';

  // Verify the native sqlite binding loads on this host before pulling in
  // the route module. On macOS dev hosts running Node 26 with the older
  // better-sqlite3 11 binary, this throws — we degrade to skipping rather
  // than failing the whole suite. CI installs a matching Linux prebuilt.
  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const authRouter = (await import('../src/routes/auth.js')).default;

  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use('/auth', authRouter);
  app.get('/api/me', (req, res) => {
    const session = req.signedCookies?.session;
    if (!session) return res.status(401).json({ error: 'no session' });
    try {
      const data = JSON.parse(Buffer.from(session, 'base64').toString());
      if (data.expires < Date.now()) return res.status(401).json({ error: 'expired' });
      return res.json({ username: data.username });
    } catch {
      return res.status(401).json({ error: 'bad session' });
    }
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('initial status: setup not complete', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.setupComplete, false);
  assert.equal(body.authenticated, false);
});

test('setup creates the first admin user and returns a session cookie', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correcthorse' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'session cookie was set');
  assert.match(cookie, /session=/, 'cookie name is `session`');
});

test('setup rejects a second admin once one exists', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin2', password: 'correcthorse' }),
  });
  assert.equal(res.status, 403);
});

test('password login: correct credentials → 200 + session cookie', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correcthorse' }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie?.includes('session='), 'session cookie issued');

  const me = await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: cookie.split(';')[0] },
  });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.username, 'admin');
});

test('password login: wrong password → 401', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrongpassword' }),
  });
  assert.equal(res.status, 401);
});

test('password login: unknown user → 401', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'irrelevant' }),
  });
  assert.equal(res.status, 401);
});

test('logout clears the session cookie', skipOpts(), async () => {
  const login = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correcthorse' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const logout = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.get('set-cookie');
  assert.match(cleared, /session=;/, 'logout clears the session cookie');
});
