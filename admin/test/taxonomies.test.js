// @ts-nocheck
/**
 * taxonomies.test.js — Phase 5e tag manager: rename, merge, delete.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

function writePost(slug, tags) {
  const fm = `---\ntitle: ${JSON.stringify(slug)}\ndraft: false\ntags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]\n---\n\nbody\n`;
  writeFileSync(join(postsDir, `${slug}.md`), fm);
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-tax-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  const siteDir = join(tempDir, 'site');
  postsDir = join(siteDir, 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
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
  const router = (await import('../src/routes/taxonomies.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/taxonomies', router);

  writePost('a', ['foo', 'bar']);
  writePost('b', ['foo', 'baz']);
  writePost('c', ['qux']);

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

test('GET tags returns counts', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/taxonomies/tags`);
  const list = await res.json();
  const foo = list.find((t) => t.name === 'foo');
  assert.equal(foo.count, 2);
});

test('rename rewrites tags across posts', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/taxonomies/tags/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'foo', to: 'Foundry' }),
  });
  assert.equal(res.status, 200);
  const aRaw = readFileSync(join(postsDir, 'a.md'), 'utf-8');
  const bRaw = readFileSync(join(postsDir, 'b.md'), 'utf-8');
  assert.match(aRaw, /Foundry/);
  assert.match(bRaw, /Foundry/);
  assert.doesNotMatch(aRaw, /foo/);
});

test('merge folds multiple tags into one', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/taxonomies/tags/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: ['Foundry', 'bar'], into: 'core' }),
  });
  assert.equal(res.status, 200);
  const aRaw = readFileSync(join(postsDir, 'a.md'), 'utf-8');
  assert.match(aRaw, /core/);
  assert.doesNotMatch(aRaw, /Foundry/);
});

test('delete refuses without force when in use', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/taxonomies/tags/qux`, { method: 'DELETE' });
  assert.equal(res.status, 409);
});

test('delete with force strips the tag', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/taxonomies/tags/qux?force=true`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const cRaw = readFileSync(join(postsDir, 'c.md'), 'utf-8');
  assert.doesNotMatch(cRaw, /qux/);
});
