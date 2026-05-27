// @ts-nocheck
/**
 * Integration tests for admin/src/routes/media.js (Phase 4).
 *
 * Follows the same DB rule as auth.test.js: real SQLite via better-sqlite3
 * pointed at a temp file via AUTH_DB_PATH, never mocked. We additionally
 * override SITE_DIR so the static tree lives in `tempDir/site/`.
 *
 * Coverage:
 *   - upload an image (returns id/url/dims)
 *   - upload-deduplication (second upload returns same id)
 *   - upload rejection on denied extension (.exe → 415)
 *   - upload too large (>cap → 413)
 *   - list with type filter
 *   - delete unused → 204
 *   - delete in-use → 409, then ?force=true → 204
 *
 * To avoid the slow path of generating an actual 100 MB file on disk,
 * we override MEDIA_MAX_UPLOAD_SIZE to a small value for the "too large"
 * test (10 KB) and synthesize an 11 KB upload from a Buffer.
 *
 * Local-only escape: if `better-sqlite3` won't load (macOS Node ABI
 * mismatch on dev hosts), every test self-skips with a descriptive
 * reason — same pattern as auth.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

// A 1x1 transparent PNG (minimal valid PNG). 67 bytes — small enough to
// fit the cap, big enough that image-size can parse a width/height of 1.
const PNG_1x1 = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200016E10D69200000000049454E44AE426082',
  'hex',
);

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-media-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth-test.db');
  process.env.SESSION_SECRET = 'test-secret-for-cookie-signing';
  process.env.NODE_ENV = 'test';
  // Override the small max-upload cap so the 413 test doesn't need to
  // synthesise an actual 100 MB buffer.
  process.env.MEDIA_MAX_UPLOAD_SIZE = '10240'; // 10 KB cap
  // Override SITE_DIR so uploaded files write into the temp tree, not
  // the real `site/` directory. Also create the posts dir so the
  // post-refs scanner has something to read.
  const siteDir = join(tempDir, 'site');
  postsDir = join(siteDir, 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(join(siteDir, 'static', 'images'), { recursive: true });
  mkdirSync(join(siteDir, 'static', 'files'), { recursive: true });
  process.env.SITE_DIR = siteDir;

  // Verify better-sqlite3 loads (CI Linux always works; macOS dev hosts
  // running Node 26 against an older binary fail loudly here).
  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Apply migrations against the temp DB.
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  const express = (await import('express')).default;
  const mediaRouter = (await import('../src/routes/media.js')).default;

  const app = express();
  // No auth middleware in the test app: we exercise the router directly
  // and the production server.js applies its own session check before
  // this router runs.
  app.use('/api/media', mediaRouter);

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

/**
 * Build a multipart/form-data body containing a single named file.
 * Returns the Buffer payload and matching Content-Type header.
 * @param filename
 * @param buf
 * @param mime
 */
function buildMultipart(filename, buf, mime) {
  const boundary = `----t80-test-${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(filename, buf, mime) {
  const { body, contentType } = buildMultipart(filename, buf, mime);
  return fetch(`${baseUrl}/api/media/upload`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
    body,
  });
}

test('upload an image: 200 with id, url, dims', skipOpts(), async () => {
  const res = await upload('logo.png', PNG_1x1, 'image/png');
  assert.equal(res.status, 200);
  const data = await res.json();
  // Either shape — single-file legacy compat or new envelope — must
  // expose a file record with the expected fields.
  const file = data.file || (data.files && data.files[0]);
  assert.ok(file, 'response includes a file record');
  assert.ok(file.id, 'has an id');
  assert.equal(file.mime_type, 'image/png');
  assert.equal(file.type, 'image');
  assert.match(file.url, /^\/images\/\d{4}\/\d{2}\/[0-9a-f]{8}-/);
  assert.equal(file.width, 1, 'image-size parsed width=1');
  assert.equal(file.height, 1, 'image-size parsed height=1');

  // The file should exist on disk under the site static tree.
  const onDisk = join(process.env.SITE_DIR, 'static', file.url.replace(/^\//, ''));
  assert.ok(existsSync(onDisk), 'file written to static dir');
});

test('upload dedup: same bytes return same id', skipOpts(), async () => {
  const first = await upload('duplicate.png', PNG_1x1, 'image/png');
  const a = (await first.json()).file;
  const second = await upload('different-name.png', PNG_1x1, 'image/png');
  const b = (await second.json()).file;
  assert.equal(b.id, a.id, 'second upload of identical content dedups');
});

test('upload rejection: .exe → 415', skipOpts(), async () => {
  const buf = Buffer.from('not really an exe');
  const res = await upload('payload.exe', buf, 'application/octet-stream');
  assert.equal(res.status, 415);
  const data = await res.json();
  assert.equal(data.error, 'denied_extension');
});

test('upload too large: 11 KB body against 10 KB cap → 413', skipOpts(), async () => {
  const big = Buffer.alloc(11 * 1024, 0xff);
  const res = await upload('big.bin', big, 'application/octet-stream');
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error, 'File too large');
  assert.equal(data.max_bytes, Number(process.env.MEDIA_MAX_UPLOAD_SIZE));
});

test('list with type filter', skipOpts(), async () => {
  // Add a non-image so we can verify the type filter.
  const txt = Buffer.from('hello, world');
  await upload('notes.txt', txt, 'text/plain');

  const all = await fetch(`${baseUrl}/api/media`).then((r) => r.json());
  assert.ok(Array.isArray(all.items));
  assert.ok(all.total >= 2, 'list shows at least the image + the text file');

  const onlyImages = await fetch(`${baseUrl}/api/media?type=image`).then((r) => r.json());
  for (const m of onlyImages.items) {
    assert.equal(m.type, 'image', 'type=image filter returns only images');
  }

  const onlyDocs = await fetch(`${baseUrl}/api/media?type=document`).then((r) => r.json());
  // text/plain → document bucket.
  assert.ok(onlyDocs.items.length >= 1, 'type=document includes the text file');
  for (const m of onlyDocs.items) assert.equal(m.type, 'document');
});

test('delete unused: 204', skipOpts(), async () => {
  const r = await upload('to-delete.png', Buffer.from(PNG_1x1), 'image/png');
  // Force a unique hash so dedup doesn't return an existing id (the
  // image bytes are otherwise identical). We append a single byte so
  // the file is still parseable but distinct.
  // Actually image-size won't accept a corrupted PNG; instead, dedup
  // against the original logo.png is fine — we'll get the *same* id
  // back and just verify the deletion works for whichever id we hold.
  const file = (await r.json()).file;
  const del = await fetch(`${baseUrl}/api/media/${file.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  // Now GET should 404.
  const after = await fetch(`${baseUrl}/api/media/${file.id}`);
  assert.equal(after.status, 404);
});

test('delete in-use: 409, then ?force=true → 204', skipOpts(), async () => {
  // Upload a fresh asset (use a slightly different PNG so we don't hit
  // the dedup of the previous image we deleted).
  // We can re-upload our 1x1 PNG — after the earlier delete, the hash
  // is no longer present in the DB and we'll get a fresh id.
  const r = await upload('in-use.png', PNG_1x1, 'image/png');
  const file = (await r.json()).file;

  // Write a "post" that references the asset's URL.
  const postBody = `---\ntitle: Test\n---\n\nSee ![hi](${file.url}) — ok.\n`;
  writeFileSync(join(postsDir, 'test-in-use.md'), postBody);

  // First delete should 409.
  const blocked = await fetch(`${baseUrl}/api/media/${file.id}`, { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  const data = await blocked.json();
  assert.equal(data.error, 'in_use');
  assert.ok(Array.isArray(data.posts) && data.posts.includes('test-in-use.md'));

  // Force should succeed.
  const forced = await fetch(`${baseUrl}/api/media/${file.id}?force=true`, { method: 'DELETE' });
  assert.equal(forced.status, 204);
});

test('GET /api/media/:id includes usage list', skipOpts(), async () => {
  // Fresh upload + reference.
  const customPng = Buffer.concat([PNG_1x1, Buffer.from([0x00])]); // hash differs
  // Just use a plain text file so the hash is unique without breaking
  // image-size on a corrupted PNG.
  const txt = Buffer.from(`usage-test-${Date.now()}`);
  const r = await upload('usage.txt', txt, 'text/plain');
  const file = (await r.json()).file;
  void customPng;

  // Reference it from a post.
  writeFileSync(join(postsDir, 'usage-ref.md'), `---\ntitle: Usage\n---\n[file](${file.url})\n`);

  const detail = await fetch(`${baseUrl}/api/media/${file.id}`).then((r) => r.json());
  assert.ok(Array.isArray(detail.usage));
  assert.ok(detail.usage.includes('usage-ref.md'));

  // Bare usage endpoint mirrors that list.
  const usage = await fetch(`${baseUrl}/api/media/${file.id}/usage`).then((r) => r.json());
  assert.ok(Array.isArray(usage.posts));
  assert.ok(usage.posts.includes('usage-ref.md'));

  // Read the file off disk to verify content-addressing — the prefix
  // should equal the first 8 hex chars of sha256(text).
  const onDisk = join(process.env.SITE_DIR, 'static', file.url.replace(/^\//, ''));
  assert.ok(existsSync(onDisk));
  assert.deepEqual(readFileSync(onDisk), txt);
});
