// @ts-nocheck
/**
 * posts-bulk.test.js — Phase 5e POST /api/posts/bulk + duplicate +
 * preview. Real SQLite + temp SITE_DIR per process.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let postsDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

function writePost(slug, fm, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '', body);
  writeFileSync(join(postsDir, `${slug}.md`), lines.join('\n'));
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-bulk-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret';
  process.env.SITE_SECRET = 'test-site-secret';
  process.env.NODE_ENV = 'test';
  const siteDir = join(tempDir, 'site');
  postsDir = join(siteDir, 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(join(siteDir, 'static', 'images'), { recursive: true });
  process.env.SITE_DIR = siteDir;

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Apply migrations so activity_log exists
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  const express = (await import('express')).default;
  const postsRouter = (await import('../src/routes/posts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/posts', postsRouter);

  // seed three posts
  writePost('one', { title: 'One', draft: false, tags: ['a', 'b'] }, 'first');
  writePost('two', { title: 'Two', draft: true, tags: ['b'] }, 'second');
  writePost('three', { title: 'Three', draft: false, tags: ['c'] }, 'third');

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

test('GET /api/posts returns all three', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 3);
});

test('bulk publish flips draft → false', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', filenames: ['two.md'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.ok, ['two.md']);
  const raw = readFileSync(join(postsDir, 'two.md'), 'utf-8');
  assert.match(raw, /draft: false/);
});

test('bulk add-tag pushes into tags[]', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add-tag',
      filenames: ['one.md', 'three.md'],
      payload: { tag: 'newtag' },
    }),
  });
  const body = await res.json();
  assert.equal(body.ok.length, 2);
  const one = readFileSync(join(postsDir, 'one.md'), 'utf-8');
  const three = readFileSync(join(postsDir, 'three.md'), 'utf-8');
  assert.match(one, /newtag/);
  assert.match(three, /newtag/);
});

test('bulk delete removes files', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', filenames: ['three.md'] }),
  });
  assert.equal(res.status, 200);
  assert.equal(existsSync(join(postsDir, 'three.md')), false);
});

test('unknown bulk action returns 400', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'nuke', filenames: ['one.md'] }),
  });
  assert.equal(res.status, 400);
});

test('duplicate creates a -copy clone', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/one.md/duplicate`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filename, 'one-copy.md');
  assert.equal(existsSync(join(postsDir, 'one-copy.md')), true);
  const raw = readFileSync(join(postsDir, 'one-copy.md'), 'utf-8');
  assert.match(raw, /draft: true/);
  // Second duplicate should produce -copy-2
  const res2 = await fetch(`${baseUrl}/api/posts/one.md/duplicate`, { method: 'POST' });
  const body2 = await res2.json();
  assert.equal(body2.filename, 'one-copy-2.md');
});

test('preview returns a signed JWT URL', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts/one.md/preview`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.url, /\/drafts\/one\/?\?token=/);
  // Token should have three parts
  const token = body.url.split('token=')[1];
  assert.equal(token.split('.').length, 3);
  // Should verify
  const { verifyJwtHS256 } = await import('../src/routes/posts.js');
  const payload = verifyJwtHS256(token, process.env.SITE_SECRET);
  assert.ok(payload);
  assert.equal(payload.slug, 'one');
});

test('create with past publish_at is rejected', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: { title: 'Backdated', publish_at: '2020-01-01T00:00:00Z' },
      content: 'body',
    }),
  });
  assert.equal(res.status, 400);
});
