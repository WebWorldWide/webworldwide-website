// @ts-nocheck
/**
 * settings.test.js — Phase 5e TOML round-trip + settings API.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

const SAMPLE_TOML = `baseURL = "https://example.com"
title = "Example"

# Pagination
[pagination]
  pagerSize = 10

# Taxonomies
[taxonomies]
  tag = "tags"
  series = "series"

# Site params
[params]
  tagline = "test"
  umamiSiteID = ""  # Fill after Umami setup
  youtubeURL = "https://youtube.com/example"
`;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-settings-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret';
  process.env.NODE_ENV = 'test';
  siteDir = join(tempDir, 'site');
  mkdirSync(join(siteDir, 'content', 'posts'), { recursive: true });
  mkdirSync(join(siteDir, 'data'), { recursive: true });
  writeFileSync(join(siteDir, 'hugo.toml'), SAMPLE_TOML);
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
  const settingsRouter = (await import('../src/routes/settings.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);

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

test('GET /api/settings returns hugo + author', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/settings`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hugo.title, 'Example');
  assert.equal(body.hugo.params.tagline, 'test');
  // author defaults
  assert.equal(typeof body.author.name, 'string');
});

test('TOML round-trip preserves comments + ordering', skipOpts(), async () => {
  // Modify one key
  const res = await fetch(`${baseUrl}/api/settings/hugo`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: { 'params.umamiSiteID': 'umami-123' } }),
  });
  assert.equal(res.status, 200);
  const updated = readFileSync(join(siteDir, 'hugo.toml'), 'utf-8');
  // Comment line "# Pagination" survives
  assert.match(updated, /# Pagination/);
  // Order preserved — pagination still before taxonomies
  const pagIdx = updated.indexOf('[pagination]');
  const taxIdx = updated.indexOf('[taxonomies]');
  assert.ok(pagIdx < taxIdx);
  // New value applied
  assert.match(updated, /umamiSiteID = "umami-123"/);
  // Inline comment preserved
  assert.match(updated, /# Fill after Umami setup/);
});

test('TOML round-trip with no changes is a no-op', skipOpts(), async () => {
  const before = readFileSync(join(siteDir, 'hugo.toml'), 'utf-8');
  const res = await fetch(`${baseUrl}/api/settings/hugo`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: {} }),
  });
  assert.equal(res.status, 200);
  const after = readFileSync(join(siteDir, 'hugo.toml'), 'utf-8');
  assert.equal(before, after);
});

test('PATCH author writes site/data/author.json', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/settings/author`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Adam', bio: 'Hi', social: { bluesky: '@x' } }),
  });
  assert.equal(res.status, 200);
  const raw = readFileSync(join(siteDir, 'data', 'author.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.name, 'Adam');
  assert.equal(parsed.social.bluesky, '@x');
});

test('helper apply directly preserves blank lines + comments', skipOpts(), async () => {
  const { apply, parse } = await import('../src/utils/toml-roundtrip.js');
  const out = apply(SAMPLE_TOML, [{ section: 'params', key: 'tagline', value: 'new' }]);
  // Blank-line layout intact (one before each [section])
  assert.equal(out.split('\n# Pagination').length, 2);
  // Re-parse round-trips cleanly
  const reparsed = parse(out);
  assert.equal(reparsed.params.tagline, 'new');
  assert.equal(reparsed.title, 'Example');
});
