// @ts-check
/**
 * health.test.js — verifies /api/health surfaces the SD-card / system-health
 * marker written by scripts/system-health.sh (storage, power, swap), and
 * degrades gracefully when the marker is missing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-health-test-'));
  // Skip the Docker socket in tests; point the health reader + site at temp.
  process.env.NODE_ENV = 'development';
  process.env.TE_HEALTH_DIR = tempDir;
  process.env.SITE_DIR = join(tempDir, 'site');

  writeFileSync(
    join(tempDir, 'system-health.json'),
    JSON.stringify({
      collected_iso: new Date().toISOString(),
      status: 'warn',
      storage: {
        device: 'mmcblk0',
        mount_ro: false,
        fs_errors: 0,
        disk_used_pct: 88,
        inode_used_pct: 4,
        write_gb_per_day: 0.42,
        status: 'warn',
      },
      power: {
        throttled_raw: '0x0',
        undervoltage_now: false,
        undervoltage_ever: false,
        throttled_now: false,
        throttled_ever: false,
        status: 'ok',
      },
      swap: { usagePercent: 2, kind: 'zram' },
    }),
  );

  const express = (await import('express')).default;
  const router = (await import('../src/routes/health.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/health', router);

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

test('GET /api/health includes storage, power, and swap from the marker', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.system, 'has system stats');
  assert.equal(body.storage.status, 'warn');
  assert.equal(body.storage.device, 'mmcblk0');
  assert.equal(body.storage.disk_used_pct, 88);
  assert.equal(body.power.status, 'ok');
  assert.equal(body.swap.usagePercent, 2);
  assert.equal(body.health_status, 'warn');
});

test('missing marker degrades to unknown without throwing', async () => {
  rmSync(join(tempDir, 'system-health.json'), { force: true });
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.health_status, 'unknown');
});
