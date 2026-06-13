// @ts-nocheck
/**
 * retention.test.js — the M2 retention sweep prunes only stale rows and
 * never throws on a fresh/missing-table DB.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let seed; // a direct connection used to seed + assert
let skipReason = false;
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

const DAY = 86_400_000;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-retention-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.NODE_ENV = 'test';
  process.env.ACTIVITY_RETENTION_DAYS = '90';

  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }

  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  seed = new Database(process.env.AUTH_DB_PATH);
});

after(async () => {
  try {
    const { __closeForTest } = await import('../src/services/retention.js');
    __closeForTest();
  } catch {
    /* ignore */
  }
  if (seed) seed.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test(
  'runRetention prunes old activity + expired embeds, keeps fresh rows',
  skipOpts(),
  async () => {
    const now = 1_700_000_000_000;
    const insAct = seed.prepare(
      'INSERT INTO activity_log (id, ts, user, action, target, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insAct.run('old', now - 100 * DAY, 'admin', 'post.update', 'a.md', null); // > 90d → pruned
    insAct.run('new', now - 10 * DAY, 'admin', 'post.update', 'b.md', null); // < 90d → kept

    const insEmbed = seed.prepare(
      'INSERT INTO embed_cache (url, provider, shortcode, payload_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insEmbed.run('https://expired.example/', 'og', '', '{}', now - 2 * DAY, now - DAY); // expired → pruned
    insEmbed.run('https://fresh.example/', 'og', '', '{}', now, now + DAY); // fresh → kept

    const { runRetention } = await import('../src/services/retention.js');
    const result = runRetention(now);

    assert.equal(result.activity, 1, 'one stale activity row pruned');
    assert.equal(result.embeds, 1, 'one expired embed pruned');

    const actIds = seed
      .prepare('SELECT id FROM activity_log ORDER BY id')
      .all()
      .map((r) => r.id);
    assert.deepEqual(actIds, ['new'], 'only the fresh activity row survives');

    const embedUrls = seed
      .prepare('SELECT url FROM embed_cache ORDER BY url')
      .all()
      .map((r) => r.url);
    assert.deepEqual(embedUrls, ['https://fresh.example/'], 'only the fresh embed survives');
  },
);

test(
  'runRetention on a DB without the tables returns zeros, never throws',
  skipOpts(),
  async () => {
    // A fresh temp DB with no migrations applied: both DELETEs hit a
    // missing table and must be swallowed.
    const bareDir = mkdtempSync(join(tmpdir(), 't80-retention-bare-'));
    const prev = process.env.AUTH_DB_PATH;
    process.env.AUTH_DB_PATH = join(bareDir, 'bare.db');
    try {
      const mod = await import('../src/services/retention.js?bare=1');
      const result = mod.runRetention(1_700_000_000_000);
      assert.deepEqual(result, { activity: 0, embeds: 0 });
      mod.__closeForTest?.();
    } finally {
      process.env.AUTH_DB_PATH = prev;
      rmSync(bareDir, { recursive: true, force: true });
    }
  },
);
