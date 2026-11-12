// Commenter accounts: hashing, validation, lockout, sessions, routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
let accounts: typeof import('../src/services/commenter-accounts.js');
let base = '';
let server: import('node:http').Server;
const ORIGIN = 'https://comments.example.test';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commenter-test-'));
  process.env.AUTH_DB_PATH = join(dir, 'auth.db');
  process.env.REMARK42_SECRET = 'test-secret';
  process.env.REMARK42_URL = 'http://127.0.0.1:9';
  process.env.COMMENTS_ORIGIN = ORIGIN;
  process.env.SITE_ORIGIN = 'https://site.example.test';
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  accounts = await import('../src/services/commenter-accounts.js');
  const remark42 = await import('../src/services/remark42.js');
  remark42.setFetchImpl(
    async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  const express = (await import('express')).default;
  const { publicRouter, adminRouter } = await import('../src/routes/commenter.js');
  const app = express();
  app.use('/commenter', publicRouter);
  app.use('/api/commenters', express.json(), adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as import('node:net').AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('passwords are stored only as Argon2id hashes and verify correctly', async () => {
  const h = await accounts.hashPassword('correct horse battery');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!h.includes('correct horse'));
  assert.equal(await accounts.verifyPassword('correct horse battery', h), true);
  assert.equal(await accounts.verifyPassword('correct horse batterz', h), false);
  // Same password, different salt → different hash.
  assert.notEqual(h, await accounts.hashPassword('correct horse battery'));
});

test('usernames and passwords are validated', () => {
  assert.equal(accounts.checkUsername('ab').ok, false);
  assert.equal(accounts.checkUsername('Admin').ok, false);
  assert.equal(accounts.checkUsername('<script>').ok, false);
  assert.equal(accounts.checkUsername('  Ada   Lovelace ').ok, true);
  assert.equal(accounts.checkPassword('short').ok, false);
  assert.equal(accounts.checkPassword('password123').ok, false);
  assert.equal(accounts.checkPassword('my ada secret', 'ada').ok, false);
  assert.equal(accounts.checkPassword('a long and fine phrase').ok, true);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/commenter/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
const cookies = (res: Response): Record<string, string> =>
  Object.fromEntries(
    res.headers.getSetCookie().map((c) => {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );

test('register signs in with Remark42-compatible cookies; names are unique', async () => {
  const res = await post('register', { username: 'Grace Hopper', password: 'compilers are fun' });
  assert.equal(res.status, 200);
  const set = res.headers.getSetCookie().join('\n');
  assert.match(set, /JWT=[^;]+;.*HttpOnly/);
  assert.match(set, /JWT=[^;]+;.*Secure/);
  assert.match(set, /XSRF-TOKEN=/);
  const c = cookies(res);
  const claims = JSON.parse(Buffer.from(c.JWT.split('.')[1], 'base64url').toString());
  assert.equal(claims.user.name, 'Grace Hopper');
  assert.equal(claims.aud, 'webworldwide');
  assert.equal(claims.jti, decodeURIComponent(c['XSRF-TOKEN']));
  assert.match(claims.user.id, /^anonymous_[0-9a-f]{40}$/);
  const me = await fetch(`${base}/commenter/me`, { headers: { cookie: `JWT=${c.JWT}` } });
  assert.deepEqual(await me.json(), { username: 'Grace Hopper' });
  const dup = await post('register', { username: 'grace hopper', password: 'another fine phrase' });
  assert.equal(dup.status, 409);
});

test('writes from another origin or without JSON are refused', async () => {
  const evil = await post(
    'login',
    { username: 'Grace Hopper', password: 'compilers are fun' },
    { Origin: 'https://evil.example' },
  );
  assert.equal(evil.status, 403);
  const form = await fetch(`${base}/commenter/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: 'username=x&password=y',
  });
  assert.equal(form.status, 415);
});

test('wrong passwords lock the account after 5 tries', async () => {
  await post('register', { username: 'Linus', password: 'kernel hacking 101' });
  for (let i = 0; i < 5; i++) {
    const r = await post('login', { username: 'Linus', password: 'wrong password!!' });
    assert.equal(r.status, 401);
  }
  const locked = await post('login', { username: 'Linus', password: 'kernel hacking 101' });
  assert.equal(locked.status, 429);
});

test('unknown user and wrong password look the same', async () => {
  const a = await post('login', { username: 'Nobody Here', password: 'whatever whatever' });
  const b = await post('login', { username: 'Grace Hopper', password: 'whatever whatever' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
});

test('password change requires the current password and revokes old sessions on the account page', async () => {
  const r = await post('login', { username: 'Grace Hopper', password: 'compilers are fun' });
  const old = cookies(r).JWT;
  const bad = await post(
    'password',
    { current: 'nope nope nope', next: 'brand new phrase' },
    { cookie: `JWT=${old}` },
  );
  assert.equal(bad.status, 401);
  const ok = await post(
    'password',
    { current: 'compilers are fun', next: 'brand new phrase' },
    { cookie: `JWT=${old}` },
  );
  assert.equal(ok.status, 200);
  const me = await fetch(`${base}/commenter/me`, { headers: { cookie: `JWT=${old}` } });
  assert.deepEqual(await me.json(), { username: null });
  const relog = await post('login', { username: 'Grace Hopper', password: 'brand new phrase' });
  assert.equal(relog.status, 200);
});

test('admin list never exposes password hashes; delete works', async () => {
  const list = await (await fetch(`${base}/api/commenters`)).json();
  assert.ok(list.items.length >= 2);
  assert.ok(!JSON.stringify(list).includes('argon2'));
  const grace = list.items.find((x: { username: string }) => x.username === 'Grace Hopper');
  const reset = await fetch(`${base}/api/commenters/${grace.id}/reset`, { method: 'POST' });
  assert.equal(reset.status, 404, 'no admin password reset: accounts are self-service');
  const del = await fetch(`${base}/api/commenters/${grace.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const gone = await post('login', { username: 'Grace Hopper', password: 'brand new phrase' });
  assert.equal(gone.status, 401);
});

test('the account page sends a strict CSP and no-store', async () => {
  const r = await fetch(`${base}/commenter/`);
  assert.equal(r.status, 200);
  assert.match(
    r.headers.get('content-security-policy') || '',
    /default-src 'none'.*frame-ancestors 'none'/,
  );
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(await r.text(), /data-site-origin="https:\/\/site\.example\.test"/);
});
