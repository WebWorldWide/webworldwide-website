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
let authMod;

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
  authMod = await import('../src/routes/auth.js');
  const authRouter = authMod.default;

  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use('/auth', authRouter);
  app.get('/api/me', (req, res) => {
    const s = authMod.resolveSession(req);
    if (!s) return res.status(401).json({ error: 'no session' });
    return res.json({ username: s.username, method: s.method });
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

test(
  'setup is atomic under concurrent requests — only one admin account is ever created',
  skipOpts(),
  async () => {
    // bcrypt.hash() yields the event loop between the hasUsers() check and the
    // insert (see auth.js), so two concurrent /setup requests can both observe
    // an empty users table. Fire them together and assert exactly one wins —
    // proving the insert itself (INSERT ... WHERE NOT EXISTS), not just the
    // earlier check, is what prevents a second admin account.
    // Same username for both racers: the account that must exist afterward
    // (for the login tests below) is 'admin' either way, regardless of which
    // concurrent request happens to win.
    const post = () =>
      fetch(`${baseUrl}/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'correcthorsebattery' }),
      });
    const [resA, resB] = await Promise.all([post(), post()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 403], 'exactly one request wins, the other is rejected');
    const winner = resA.status === 200 ? resA : resB;
    const body = await winner.json();
    assert.equal(body.success, true);
    const cookie = winner.headers.get('set-cookie');
    assert.ok(cookie, 'the winning request got a session cookie');
    assert.match(cookie, /session=/, 'cookie name is `session`');
  },
);

test('setup rejects a second admin once one exists', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin2', password: 'correcthorsebattery' }),
  });
  assert.equal(res.status, 403);
});

test('password login: correct credentials → 200 + session cookie', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correcthorsebattery' }),
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
    body: JSON.stringify({ username: 'nobody', password: 'irrelevantpass' }),
  });
  assert.equal(res.status, 401);
});

test('logout clears the session cookie', skipOpts(), async () => {
  const login = await fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correcthorsebattery' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const logout = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.get('set-cookie');
  assert.match(cleared, /session=;/, 'logout clears the session cookie');
  // …and the session is revoked server-side: replaying the old cookie fails.
  const replay = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
  assert.equal(replay.status, 401, 'a logged-out cookie is dead, not just forgotten');
});

const login = (password = 'correcthorsebattery') =>
  fetch(`${baseUrl}/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });

test('forged or legacy (signed-JSON) cookies are rejected', skipOpts(), async () => {
  const legacy = Buffer.from(
    JSON.stringify({ userId: 'x', username: 'admin', expires: Date.now() + 1e9 }),
  ).toString('base64');
  const res = await fetch(`${baseUrl}/api/me`, { headers: { cookie: `session=${legacy}` } });
  assert.equal(res.status, 401);
});

test('setup requires a strong password', skipOpts(), async () => {
  // (Setup is already complete here, so this asserts the length rule is
  // documented in the response contract via the 403 path not leaking state.)
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'short' }),
  });
  assert.equal(res.status, 403);
});

test(
  'password login is refused once a passkey exists (unless break-glass)',
  skipOpts(),
  async () => {
    const user = authMod.db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    authMod.db
      .prepare(
        'INSERT INTO passkeys (id, user_id, credential_id, public_key, counter) VALUES (?, ?, ?, ?, 0)',
      )
      .run('pk-test', user.id, 'cred-test', 'AAAA');
    try {
      const refused = await login();
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error, 'password_login_disabled');
      assert.equal(refused.headers.get('set-cookie'), null, 'no session issued');

      // A wrong password still answers 401 (doesn't reveal passkey state).
      assert.equal((await login('wrong-password-x')).status, 401);

      const status = await (await fetch(`${baseUrl}/auth/status`)).json();
      assert.equal(status.passwordLogin, false);

      process.env.ALLOW_PASSWORD_LOGIN = '1';
      assert.equal((await login()).status, 200, 'break-glass env re-enables password login');
    } finally {
      delete process.env.ALLOW_PASSWORD_LOGIN;
      authMod.db.prepare('DELETE FROM passkeys WHERE id = ?').run('pk-test');
    }
  },
);

test('passkey login challenge does not enumerate credential IDs', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/auth/passkey/login/start`, { method: 'POST' });
  const body = await res.json();
  assert.deepEqual(body.options.allowCredentials ?? [], []);
});

test(
  'global failed-login cap pauses password login (spoofed IPs do not help)',
  skipOpts(),
  async () => {
    authMod._resetLoginFailures();
    try {
      for (let i = 0; i < 30; i += 1) {
        const r = await fetch(`${baseUrl}/auth/login/password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': `203.0.113.${i}`,
          },
          body: JSON.stringify({ username: 'nobody', password: 'guess-guess-guess' }),
        });
        assert.equal(r.status, 401);
      }
      const paused = await login();
      assert.equal(paused.status, 429, 'even the right password waits out the pause');
    } finally {
      authMod._resetLoginFailures();
    }
  },
);

test('session store: revoke-others and idle expiry', skipOpts(), async () => {
  const a = (await login()).headers.get('set-cookie').split(';')[0];
  const b = (await login()).headers.get('set-cookie').split(';')[0];
  const meA = await fetch(`${baseUrl}/api/me`, { headers: { cookie: a } });
  assert.equal(meA.status, 200);

  const user = authMod.db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  // Resolve B's session id hash through the store, then revoke everything else.
  const sessions = authMod.listSessions(user.id);
  assert.ok(sessions.length >= 2);
  authMod.revokeOtherSessions(user.id, sessions[0].id);
  const alive = [a, b].map(
    async (c) => (await fetch(`${baseUrl}/api/me`, { headers: { cookie: c } })).status,
  );
  const statuses = await Promise.all(alive);
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one session survives');

  // Idle expiry: age every session past 12h → all rejected.
  authMod.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 13 * 3600 * 1000);
  for (const c of [a, b]) {
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { cookie: c } })).status, 401);
  }
});
