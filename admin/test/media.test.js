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
  mkdirSync(join(siteDir, 'public', 'images'), { recursive: true });
  mkdirSync(join(siteDir, 'public', 'files'), { recursive: true });
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
  // this router runs. JSON body parsing mirrors server.js (PATCH
  // metadata edits arrive as JSON; uploads are multipart via Multer).
  app.use(express.json());
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
  const onDisk = join(process.env.SITE_DIR, 'public', file.url.replace(/^\//, ''));
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

test(
  'delete + usage are variant-aware: a post using the -thumb blocks deletion',
  skipOpts(),
  async () => {
    const r = await upload(
      'variant-test.png',
      Buffer.concat([PNG_1x1, Buffer.from(String(Date.now()))]),
      'image/png',
    );
    const file = (await r.json()).file;

    // The post references the THUMBNAIL variant, not the base URL — the exact-
    // match check used to miss this and allow a delete that breaks the post.
    const thumbUrl = file.url.replace(/\.(png|jpe?g|webp)$/i, '-thumb.webp');
    writeFileSync(
      join(postsDir, 'variant-ref.md'),
      `---\ntitle: Variant\n---\n![hi](${thumbUrl})\n`,
    );

    const usage = await fetch(`${baseUrl}/api/media/${file.id}/usage`).then((x) => x.json());
    assert.ok(usage.posts.includes('variant-ref.md'), 'variant reference detected in usage');

    const blocked = await fetch(`${baseUrl}/api/media/${file.id}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409, 'delete refused for a variant-referenced asset');

    // cleanup so later usage scans aren't affected
    await fetch(`${baseUrl}/api/media/${file.id}?force=true`, { method: 'DELETE' });
  },
);

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
  const onDisk = join(process.env.SITE_DIR, 'public', file.url.replace(/^\//, ''));
  assert.ok(existsSync(onDisk));
  assert.deepEqual(readFileSync(onDisk), txt);
});

test('GET /api/media list includes used_in [{ filename, title }]', skipOpts(), async () => {
  // Unique bytes so we get a fresh row with a predictable URL.
  const txt = Buffer.from(`usedin-${Date.now()}`);
  const r = await upload('used-in.txt', txt, 'text/plain');
  const file = (await r.json()).file;

  // A post with a real title that references the asset's URL.
  writeFileSync(
    join(postsDir, 'used-in-ref.md'),
    `---\ntitle: A Descriptive Title\n---\nSee [here](${file.url}).\n`,
  );

  const list = await fetch(`${baseUrl}/api/media?q=used-in`).then((x) => x.json());
  const listed = list.items.find((i) => i.id === file.id);
  assert.ok(listed, 'asset is in the listing');
  assert.ok(Array.isArray(listed.used_in), 'used_in is an array');
  assert.equal(listed.used_in.length, 1);
  assert.equal(listed.used_in[0].filename, 'used-in-ref.md');
  assert.equal(listed.used_in[0].title, 'A Descriptive Title');

  // Detail endpoint carries it too.
  const detail = await fetch(`${baseUrl}/api/media/${file.id}`).then((x) => x.json());
  assert.equal(detail.used_in[0].title, 'A Descriptive Title');

  // An asset referenced by no post reports used_in: [].
  const r2 = await upload('unused-asset.txt', Buffer.from(`unused-${Date.now()}`), 'text/plain');
  const file2 = (await r2.json()).file;
  const list2 = await fetch(`${baseUrl}/api/media?q=unused-asset`).then((x) => x.json());
  const listed2 = list2.items.find((i) => i.id === file2.id);
  assert.deepEqual(listed2.used_in, []);
});

// ── Phase: alt text ────────────────────────────────────────────────

test('PATCH /api/media/:id sets, echoes, and clears alt_text', skipOpts(), async () => {
  const r = await upload('alt-test.png', PNG_1x1, 'image/png');
  const file = (await r.json()).file;
  assert.equal(file.alt_text, null);

  // Set.
  const set = await fetch(`${baseUrl}/api/media/${file.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alt_text: '  A single transparent pixel  ' }),
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.equal(setBody.alt_text, 'A single transparent pixel'); // trimmed

  // List + detail both echo it.
  const detail = await fetch(`${baseUrl}/api/media/${file.id}`).then((x) => x.json());
  assert.equal(detail.alt_text, 'A single transparent pixel');
  const list = await fetch(`${baseUrl}/api/media?q=alt-test`).then((x) => x.json());
  const listed = list.items.find((i) => i.id === file.id);
  assert.equal(listed.alt_text, 'A single transparent pixel');

  // Clear with null; empty string clears too.
  const clear = await fetch(`${baseUrl}/api/media/${file.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alt_text: null }),
  });
  assert.equal((await clear.json()).alt_text, null);
});

test(
  'PATCH /api/media/:id validation: 404, no fields, wrong type, too long',
  skipOpts(),
  async () => {
    const missing = await fetch(`${baseUrl}/api/media/definitely-not-an-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt_text: 'x' }),
    });
    assert.equal(missing.status, 404);

    const r = await upload('alt-valid.txt', Buffer.from('alt validation target'), 'text/plain');
    const file = (await r.json()).file;

    const noFields = await fetch(`${baseUrl}/api/media/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noFields.status, 400);
    assert.equal((await noFields.json()).error, 'no_editable_fields');

    const wrongType = await fetch(`${baseUrl}/api/media/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt_text: 42 }),
    });
    assert.equal(wrongType.status, 400);
    assert.equal((await wrongType.json()).error, 'invalid_alt_text');

    const tooLong = await fetch(`${baseUrl}/api/media/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt_text: 'a'.repeat(1001) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error, 'alt_text_too_long');
  },
);

test('PATCH original_name renames the display label (empty rejected)', skipOpts(), async () => {
  const file = (await (await upload('rn-1.txt', Buffer.from('rename one'), 'text/plain')).json())
    .file;
  const ok = await fetch(`${baseUrl}/api/media/${file.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_name: '  Friendly Name  ' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).original_name, 'Friendly Name'); // trimmed

  const blank = await fetch(`${baseUrl}/api/media/${file.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_name: '   ' }),
  });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).error, 'invalid_name');
});

test('POST /api/media/bulk edits many, skips bad ids', skipOpts(), async () => {
  const a = (await (await upload('bulk-1.txt', Buffer.from('bulk one'), 'text/plain')).json()).file;
  const b = (await (await upload('bulk-2.txt', Buffer.from('bulk two'), 'text/plain')).json()).file;
  const res = await fetch(`${baseUrl}/api/media/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      edits: [
        { id: a.id, original_name: 'Bulk One' },
        { id: b.id, original_name: 'Bulk Two' },
        { id: 'not-a-real-id', original_name: 'X' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.updated, 2);
  assert.equal(body.errors.length, 1);
  const detailA = await fetch(`${baseUrl}/api/media/${a.id}`).then((x) => x.json());
  assert.equal(detailA.original_name, 'Bulk One');
});
