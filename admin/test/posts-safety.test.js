// @ts-nocheck
/**
 * posts-safety.test.js — M1 data-safety guards on the post routes:
 *   - GET returns an mtime optimistic-concurrency token
 *   - PUT refuses to overwrite a DIFFERENT post via a slug rename (409)
 *   - PUT refuses to clobber a copy that changed since load (409 conflict)
 *   - PUT with a matching token (or none) saves normally
 *   - writes are atomic (temp + rename)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let postsDir;
let skipReason = false;

const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

function writePost(slug, fm, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '', body);
  writeFileSync(join(postsDir, `${slug}.md`), lines.join('\n'));
}

const api = (path, opts) =>
  fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-safety-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret';
  process.env.SITE_SECRET = 'test-site-secret';
  process.env.NODE_ENV = 'test';
  const siteDir = join(tempDir, 'site');
  postsDir = join(siteDir, 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(join(siteDir, 'public', 'images'), { recursive: true });
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
  const postsRouter = (await import('../src/routes/posts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/posts', postsRouter);

  writePost('alpha', { title: 'Alpha', date: '2024-01-01', draft: false }, 'alpha body');
  writePost('bravo', { title: 'Bravo', date: '2024-01-02', draft: false }, 'bravo body');

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

test('GET /api/posts/:file returns a numeric mtime token', skipOpts(), async () => {
  const res = await api('/api/posts/alpha.md');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.mtime, 'number');
  assert.equal(body.data.title, 'Alpha');
});

test(
  'PUT slug-rename onto an existing different post is refused (409), both survive',
  skipOpts(),
  async () => {
    // Try to rename alpha's slug to "bravo" — would overwrite the real bravo.
    const res = await api('/api/posts/alpha.md', {
      method: 'PUT',
      body: JSON.stringify({
        data: { title: 'Alpha', slug: 'bravo', date: '2024-01-01', draft: false },
        content: 'alpha trying to clobber bravo',
      }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'slug_taken');
    // Both files are intact with their ORIGINAL content.
    assert.match(readFileSync(join(postsDir, 'bravo.md'), 'utf-8'), /bravo body/);
    assert.match(readFileSync(join(postsDir, 'alpha.md'), 'utf-8'), /alpha body/);
  },
);

test('PUT with a stale baseMtime is refused (409 conflict)', skipOpts(), async () => {
  const get = await (await api('/api/posts/alpha.md')).json();
  const staleMtime = get.mtime;
  // Simulate another writer touching the file after we loaded it.
  const p = join(postsDir, 'alpha.md');
  utimesSync(p, new Date(), new Date(staleMtime + 5000));

  const res = await api('/api/posts/alpha.md', {
    method: 'PUT',
    body: JSON.stringify({
      data: { title: 'Alpha edited', slug: 'alpha', date: '2024-01-01', draft: false },
      content: 'concurrent edit',
      baseMtime: staleMtime,
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'conflict');
  // The on-disk file was NOT modified.
  assert.match(readFileSync(p, 'utf-8'), /alpha body/);
});

test('PUT with the current baseMtime saves and returns a fresh mtime', skipOpts(), async () => {
  const get = await (await api('/api/posts/alpha.md')).json();
  const res = await api('/api/posts/alpha.md', {
    method: 'PUT',
    body: JSON.stringify({
      data: { title: 'Alpha v2', slug: 'alpha', date: '2024-01-01', draft: false },
      content: 'updated alpha',
      baseMtime: get.mtime,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.mtime, 'number');
  assert.match(readFileSync(join(postsDir, 'alpha.md'), 'utf-8'), /updated alpha/);
});

test('PUT without baseMtime still works (back-compat)', skipOpts(), async () => {
  const res = await api('/api/posts/bravo.md', {
    method: 'PUT',
    body: JSON.stringify({
      data: { title: 'Bravo', slug: 'bravo', date: '2024-01-02', draft: false },
      content: 'bravo updated no token',
    }),
  });
  assert.equal(res.status, 200);
  assert.match(readFileSync(join(postsDir, 'bravo.md'), 'utf-8'), /bravo updated no token/);
});

test('a legitimate slug rename to a FREE slug moves the file', skipOpts(), async () => {
  const get = await (await api('/api/posts/alpha.md')).json();
  const res = await api('/api/posts/alpha.md', {
    method: 'PUT',
    body: JSON.stringify({
      data: { title: 'Alpha', slug: 'alpha-renamed', date: '2024-01-01', draft: false },
      content: 'renamed cleanly',
      baseMtime: get.mtime,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filename, 'alpha-renamed.md');
  assert.equal(statSyncSafe(join(postsDir, 'alpha.md')), false, 'old file removed');
  assert.match(readFileSync(join(postsDir, 'alpha-renamed.md'), 'utf-8'), /renamed cleanly/);
});

test(
  'renaming a post adds redirects and rewrites internal links (no 404s)',
  skipOpts(),
  async () => {
    writePost('gamma', { title: 'Gamma', date: '2024-03-01', draft: false }, 'gamma body');
    writePost(
      'linker',
      { title: 'Linker', date: '2024-03-02', draft: false },
      'See [Gamma](/blog/gamma/) and also [self](/blog/linker/).',
    );

    const get = await (await api('/api/posts/gamma.md')).json();
    const res = await api('/api/posts/gamma.md', {
      method: 'PUT',
      body: JSON.stringify({
        data: { title: 'Gamma Renamed', slug: 'gamma-renamed', date: '2024-03-01', draft: false },
        content: 'gamma body',
        baseMtime: get.mtime,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filename, 'gamma-renamed.md');
    assert.ok(body.rename, 'rename report present');
    assert.ok(body.rename.redirected.length >= 1, 'at least one redirect created');
    assert.equal(body.rename.linksUpdated, 1, 'one cross-link rewritten (the linker post)');

    // redirects.json holds old → new (canonical /blog/<slug>), so the old URL
    // never 404s after the slug moves.
    const redirects = JSON.parse(
      readFileSync(join(tempDir, 'site', 'data', 'redirects.json'), 'utf-8'),
    );
    const canon = redirects.find((r) => r.from === '/blog/gamma');
    assert.ok(canon, 'canonical /blog/gamma redirect exists');
    assert.equal(canon.to, '/blog/gamma-renamed');
    assert.ok(
      redirects.some((r) => r.from === '/gamma'),
      'legacy bare /gamma redirect exists',
    );

    // The cross-link was rewritten to the new slug; the self-link and the
    // post's own (now-renamed) identity are left consistent.
    const linker = readFileSync(join(postsDir, 'linker.md'), 'utf-8');
    assert.match(linker, /\/blog\/gamma-renamed\//, 'cross-link updated to new slug');
    assert.doesNotMatch(linker, /\/blog\/gamma\//, 'no stale /blog/gamma/ link remains');
    assert.match(linker, /\/blog\/linker\//, 'unrelated link left intact');
  },
);

test('a save snapshots the previous content; history + version expose it', skipOpts(), async () => {
  // bravo.md currently holds "bravo updated no token" from an earlier test.
  const before = readFileSync(join(postsDir, 'bravo.md'), 'utf-8');
  assert.match(before, /bravo updated no token/);

  // Save new content — the PRE-save body should be snapshotted.
  const get = await (await api('/api/posts/bravo.md')).json();
  await api('/api/posts/bravo.md', {
    method: 'PUT',
    body: JSON.stringify({
      data: { title: 'Bravo', slug: 'bravo', date: '2024-01-02', draft: false },
      content: 'bravo NEWEST body',
      baseMtime: get.mtime,
    }),
  });

  const hist = await (await api('/api/posts/bravo.md/history')).json();
  assert.ok(Array.isArray(hist.git), 'git history is an array (empty without a repo)');
  assert.ok(hist.snapshots.length >= 1, 'at least one local snapshot recorded');

  // The newest snapshot holds a PRE-save body, never the just-written one
  // (which post body actually survives depends on the 60s coalesce window,
  // but it must be an EARLIER revision, not "NEWEST").
  const snapId = hist.snapshots[0].id;
  const ver = await (await api(`/api/posts/bravo.md/version/snapshot/${snapId}`)).json();
  assert.match(ver.content, /bravo/, 'snapshot holds a prior bravo body');
  assert.doesNotMatch(ver.content, /NEWEST/, 'snapshot is NOT the just-saved content');

  // Unknown version → 404, not a crash.
  const miss = await api('/api/posts/bravo.md/version/snapshot/nope');
  assert.equal(miss.status, 404);
});

test(
  'PUT with baseMtime to a since-deleted post is a 409 (never silently recreated)',
  skipOpts(),
  async () => {
    writePost(
      'ephemeral',
      { title: 'Ephemeral', date: '2024-05-01', draft: false },
      'here then gone',
    );
    const get = await (await api('/api/posts/ephemeral.md')).json();
    // Another writer/tab deletes it after we loaded it.
    rmSync(join(postsDir, 'ephemeral.md'));
    const res = await api('/api/posts/ephemeral.md', {
      method: 'PUT',
      body: JSON.stringify({
        data: { title: 'Ephemeral', slug: 'ephemeral', date: '2024-05-01', draft: false },
        content: 'must not resurrect',
        baseMtime: get.mtime,
      }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'conflict');
    assert.equal(statSyncSafe(join(postsDir, 'ephemeral.md')), false, 'deleted post not recreated');
  },
);

function statSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
