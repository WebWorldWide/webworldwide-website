// @ts-nocheck
/**
 * scheduler.test.js — Phase 5e scheduled-publish promoter.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-sched-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.NODE_ENV = 'test';
  const siteDir = join(tempDir, 'site');
  postsDir = join(siteDir, 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
  process.env.SITE_DIR = siteDir;

  // The scheduler service itself doesn't touch sqlite at module load,
  // but it indirectly imports services/activity.js which does. The
  // import-time access is lazy (db() called only on first logActivity
  // insert), so we don't need to skip — but we still surface a clean
  // skip reason if the binding is broken so failures aren't cryptic.
  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
  }
});

after(async () => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('promotes posts whose publish_at is past', skipOpts(), async () => {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  writeFileSync(
    join(postsDir, 'past.md'),
    `---\ntitle: Past\ndraft: true\npublish_at: ${JSON.stringify(past)}\n---\nbody`,
  );
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  writeFileSync(
    join(postsDir, 'future.md'),
    `---\ntitle: Future\ndraft: true\npublish_at: ${JSON.stringify(future)}\n---\nbody`,
  );
  writeFileSync(join(postsDir, 'no-pub.md'), `---\ntitle: NoPub\ndraft: true\n---\nbody`);

  const { promoteScheduledPosts } = await import('../src/services/scheduler.js');
  const res = await promoteScheduledPosts({ commit: undefined });
  assert.deepEqual(res.promoted.sort(), ['past.md']);
  const past2 = readFileSync(join(postsDir, 'past.md'), 'utf-8');
  assert.match(past2, /draft: false/);
  const future2 = readFileSync(join(postsDir, 'future.md'), 'utf-8');
  assert.match(future2, /draft: true/);
});

test('dry-run does not write', skipOpts(), async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  writeFileSync(
    join(postsDir, 'dry.md'),
    `---\ntitle: Dry\ndraft: true\npublish_at: ${JSON.stringify(past)}\n---\nbody`,
  );
  const { promoteScheduledPosts } = await import('../src/services/scheduler.js');
  const res = await promoteScheduledPosts({ dryRun: true });
  assert.ok(res.promoted.includes('dry.md'));
  const raw = readFileSync(join(postsDir, 'dry.md'), 'utf-8');
  assert.match(raw, /draft: true/);
});

test('invokes the commit callback once when posts are promoted', skipOpts(), async () => {
  // Reset by writing a fresh post that needs promotion.
  const past = new Date(Date.now() - 1000).toISOString();
  writeFileSync(
    join(postsDir, 'commit-me.md'),
    `---\ntitle: CommitMe\ndraft: true\npublish_at: ${JSON.stringify(past)}\n---\nbody`,
  );
  let committed = null;
  const { promoteScheduledPosts } = await import('../src/services/scheduler.js');
  await promoteScheduledPosts({
    commit: async (files) => {
      committed = files;
    },
  });
  assert.ok(committed);
  assert.ok(committed.includes('commit-me.md'));
});
