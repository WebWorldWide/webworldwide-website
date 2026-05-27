// @ts-nocheck
/**
 * conversion.test.js — Phase 5a image pipeline + queue tests.
 *
 * Strategy:
 *   - One temp directory under OS tmpdir holds both the SQLite DB and the
 *     fake `site/static/` tree. AUTH_DB_PATH and SITE_DIR are set BEFORE
 *     any module under test is imported so the singleton handles in
 *     routes/media.js + services/conversion/queue.js latch onto them.
 *   - Each test mints fresh image bytes via sharp (no committed binary
 *     fixtures). Sharp's HEVC encoder is patent-encumbered and missing
 *     on libheif's free build; we use AV1-encoded HEIF instead — it
 *     still reports `format='heif'`, exercising the same code path.
 *   - We drain the queue manually with `drainOnce()` rather than spinning
 *     up the polling worker, so tests are deterministic and don't have to
 *     poll wall-clock time.
 *
 * Self-skip if better-sqlite3's native binding fails to load (the same
 * escape hatch the Phase 4 media.test.js uses on macOS dev hosts).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir;
let siteDir;
let imagesDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

// Lazily-imported modules under test (we cannot `await import()` at top
// level here because Node test runner expects sync registration of test
// hooks).
let sharp;
let queue;
let workerMod;
let mediaRouter;
let express;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-conv-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth-test.db');
  process.env.SESSION_SECRET = 'test-secret-for-cookie-signing';
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_MAX_UPLOAD_SIZE = String(20 * 1024 * 1024); // 20 MB
  siteDir = join(tempDir, 'site');
  imagesDir = join(siteDir, 'static', 'images', '2026', '05');
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(join(siteDir, 'content', 'posts'), { recursive: true });
  mkdirSync(join(siteDir, 'static', 'images'), { recursive: true });
  mkdirSync(join(siteDir, 'static', 'files'), { recursive: true });
  mkdirSync(imagesDir, { recursive: true });
  process.env.SITE_DIR = siteDir;
  // Stop server.js from auto-starting a competing worker if a test
  // imports it.
  process.env.CONVERSION_WORKER = 'off';

  // Verify native binding for better-sqlite3.
  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Apply migrations.
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  sharp = (await import('sharp')).default;
  queue = await import('../src/services/conversion/queue.js');
  workerMod = await import('../src/services/conversion/worker.js');
  // image handler is exercised indirectly via the worker dispatch path;
  // we don't need a direct reference here.
  await import('../src/services/conversion/image.js');
  mediaRouter = (await import('../src/routes/media.js')).default;
  express = (await import('express')).default;
});

after(async () => {
  if (workerMod) {
    try {
      await workerMod.stopWorker();
    } catch {
      /* ignore */
    }
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Insert a media row by hand (skip the upload route's hashing layer).
 * Returns the row id and disk path.
 * @param root0
 * @param root0.filename
 * @param root0.mime
 * @param root0.contents
 * @param root0.width
 * @param root0.height
 */
function seedMedia({ filename, mime, contents, width = null, height = null }) {
  const db = queue.__internal.getDb();
  const id = `media-${Math.random().toString(36).slice(2, 10)}`;
  const hash = `hash${Math.random().toString(36).slice(2, 10)}`.padEnd(16, 'a');
  const diskPath = join(imagesDir, filename);
  writeFileSync(diskPath, contents);
  // Lock the uploaded_at to a 2026-05 date so derivePathFromUploadedAt
  // resolves to the same yyyy/mm we created above.
  const ts = Date.UTC(2026, 4, 15, 12, 0, 0); // May = month index 4
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size, width, height, duration, hash, conversions_json, status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'processing', ?, '[]')`,
  ).run(id, filename, filename, mime, contents.length, width, height, null, hash, ts);
  return { id, diskPath, hash };
}

function makeJpegWithExif(width = 200, height = 150) {
  // sharp's withMetadata() defaults to copying input EXIF; we have no
  // input EXIF here, so feed an explicit `exif` block with a known
  // marker we can grep for after stripping.
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 80, b: 120 },
    },
  })
    .withMetadata({
      exif: {
        IFD0: {
          Copyright: 'T80-FIXTURE-EXIF-MARKER',
          Software: 't80-conversion-test-suite',
        },
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

test('queue: enqueueJob flips media.status to processing', skipOpts(), async () => {
  const buf = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
  const { id } = seedMedia({ filename: 'tiny.png', mime: 'image/png', contents: buf });
  // Newly-seeded row is already 'processing' (we set it manually).
  // Reset to 'ready' first to prove enqueueJob is the one that flips it.
  const db = queue.__internal.getDb();
  db.prepare("UPDATE media SET status = 'ready' WHERE id = ?").run(id);
  queue.enqueueJob(id, 'image');
  const row = db.prepare('SELECT status FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'processing');
});

test('image: PNG generates webp + avif at 4 widths + thumbnail', skipOpts(), async () => {
  const wide = await sharp({
    create: { width: 2000, height: 1200, channels: 3, background: { r: 80, g: 160, b: 200 } },
  })
    .png()
    .toBuffer();
  const { id, diskPath } = seedMedia({
    filename: 'wide.png',
    mime: 'image/png',
    contents: wide,
  });

  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'media row marked ready');
  assert.equal(row.width, 2000);
  assert.equal(row.height, 1200);

  const conversions = JSON.parse(row.conversions_json || '{}');
  // 2000 > 1920 source check would skip 1920, but our source IS 2000
  // so all four widths fit. Check each pair.
  for (const w of [320, 640, 1024, 1920]) {
    assert.ok(conversions[`webp-${w}`], `conversion entry webp-${w}`);
    assert.ok(conversions[`avif-${w}`], `conversion entry avif-${w}`);
    const webpFile = join(siteDir, 'static', conversions[`webp-${w}`].replace(/^\//, ''));
    const avifFile = join(siteDir, 'static', conversions[`avif-${w}`].replace(/^\//, ''));
    assert.ok(existsSync(webpFile), `${webpFile} written`);
    assert.ok(existsSync(avifFile), `${avifFile} written`);
  }
  // Thumbnail.
  assert.ok(conversions.thumb, 'thumb conversion entry');
  const thumbFile = join(siteDir, 'static', conversions.thumb.replace(/^\//, ''));
  assert.ok(existsSync(thumbFile), 'thumb file on disk');
  const thumbMeta = await sharp(thumbFile).metadata();
  assert.equal(thumbMeta.width, 240, 'thumb is 240px wide');
  assert.equal(thumbMeta.format, 'webp');
  // Original preserved.
  assert.ok(existsSync(diskPath), 'original PNG preserved');
});

test('image: small source skips widths above source width', skipOpts(), async () => {
  const small = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 50, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
  const { id } = seedMedia({ filename: 'small.png', mime: 'image/png', contents: small });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  const conversions = JSON.parse(row.conversions_json || '{}');
  // 320 fits (≤ 400); 640/1024/1920 should be skipped.
  assert.ok(conversions['webp-320'], '320 generated');
  assert.ok(!conversions['webp-640'], '640 skipped (would upscale)');
  assert.ok(!conversions['webp-1024'], '1024 skipped');
  assert.ok(!conversions['webp-1920'], '1920 skipped');
});

test('image: EXIF stripped from web variants', skipOpts(), async () => {
  const jpg = await makeJpegWithExif(800, 600);
  // Sanity check: the source JPEG contains the marker.
  assert.ok(jpg.includes(Buffer.from('T80-FIXTURE-EXIF-MARKER')), 'fixture has EXIF marker');

  const { id } = seedMedia({ filename: 'photo.jpg', mime: 'image/jpeg', contents: jpg });
  queue.enqueueJob(id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });

  const db = queue.__internal.getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  const conversions = JSON.parse(row.conversions_json || '{}');
  // The 640w WebP should have NO EXIF metadata at all.
  const webpPath = join(siteDir, 'static', conversions['webp-640'].replace(/^\//, ''));
  const webpBuf = readFileSync(webpPath);
  assert.ok(
    !webpBuf.includes(Buffer.from('T80-FIXTURE-EXIF-MARKER')),
    'EXIF marker stripped from WebP variant',
  );
  // sharp metadata should report no exif on the variant.
  const variantMeta = await sharp(webpPath).metadata();
  assert.ok(!variantMeta.exif, 'no EXIF metadata block on variant');
});

test('image: SVG sanitization overwrites the on-disk file', skipOpts(), async () => {
  const unsafe = readFileSync(join(__dirname, 'fixtures', 'unsafe.svg'), 'utf8');
  assert.ok(unsafe.includes('<script'), 'fixture has script tag');
  // Write the SVG into the image dir as if it were uploaded.
  const buf = Buffer.from(unsafe, 'utf8');
  const { id, diskPath } = seedMedia({
    filename: 'unsafe.svg',
    mime: 'image/svg+xml',
    contents: buf,
  });
  queue.enqueueJob(id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });

  const cleaned = readFileSync(diskPath, 'utf8');
  assert.ok(!cleaned.includes('<script'), 'script tag removed');
  assert.ok(!cleaned.toLowerCase().includes('onload='), 'onload attribute removed');
  assert.ok(!cleaned.toLowerCase().includes('onclick='), 'onclick attribute removed');
  assert.ok(!cleaned.toLowerCase().includes('javascript:'), 'javascript: URL removed');

  // Sanity: the safe SVG round-trips with content intact.
  const safe = readFileSync(join(__dirname, 'fixtures', 'safe.svg'), 'utf8');
  const safeBuf = Buffer.from(safe, 'utf8');
  const seed2 = seedMedia({ filename: 'safe.svg', mime: 'image/svg+xml', contents: safeBuf });
  queue.enqueueJob(seed2.id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });
  const cleanedSafe = readFileSync(seed2.diskPath, 'utf8');
  assert.ok(cleanedSafe.includes('<circle'), 'circle element preserved');
});

test('image: HEIC/HEIF → JPEG fallback (libheif available)', skipOpts(), async () => {
  // sharp's bundled libheif ships without HEVC (patent), but AV1-coded
  // HEIF works and registers as format='heif' through the same code
  // path, so we exercise the fallback writer with that.
  let heif;
  try {
    heif = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 90, g: 50, b: 50 } },
    })
      .heif({ compression: 'av1' })
      .toBuffer();
  } catch (err) {
    // Skip if libheif isn't available at all (older sharp builds).
    console.warn('[test] skipping HEIC test — libheif unavailable:', err.message);
    return;
  }

  const { id } = seedMedia({ filename: 'photo.heic', mime: 'image/heic', contents: heif });
  queue.enqueueJob(id, 'image');
  await workerMod.drainOnce({ concurrency: 1 });

  const db = queue.__internal.getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  const conversions = JSON.parse(row.conversions_json || '{}');
  assert.ok(conversions['heic-converted-jpg'], 'JPEG fallback recorded');
  const jpgPath = join(siteDir, 'static', conversions['heic-converted-jpg'].replace(/^\//, ''));
  assert.ok(existsSync(jpgPath), 'JPEG fallback written to disk');
  const jpgMeta = await sharp(jpgPath).metadata();
  assert.equal(jpgMeta.format, 'jpeg');
});

test('queue: failed job marks media.status=failed after max attempts', skipOpts(), async () => {
  // Seed a job whose handler will throw. We pick a type that has no
  // registered handler, which triggers the "No handler registered for
  // type=…" failure path inside the worker — that path is what we want to
  // verify exhausts retries and flips media.status to 'failed'.
  const db = queue.__internal.getDb();
  const buf = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const { id } = seedMedia({
    filename: 'will-fail.bin',
    mime: 'application/octet-stream',
    contents: buf,
  });
  // Reduce max_attempts to 1 so we can exhaust it in one drain.
  queue.enqueueJob(id, '__unregistered__', { maxAttempts: 1 });
  await workerMod.drainOnce({ concurrency: 1 });
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'failed', 'media marked failed after max_attempts exhausted');
  const job = db
    .prepare('SELECT * FROM conversion_jobs WHERE media_id = ? ORDER BY queued_at DESC')
    .get(id);
  assert.equal(job.status, 'failed');
  assert.ok(job.error && job.error.length > 0, 'error message stored');
});

test('queue: retry resets attempt and re-runs', skipOpts(), async () => {
  const db = queue.__internal.getDb();
  // Find the failed row from the previous test and retry it. Since our
  // 'video' handler always throws, retrying just re-fails — but the
  // *attempt counter* and *status transition* are what we're verifying.
  const failed = db
    .prepare("SELECT * FROM media WHERE status = 'failed' ORDER BY uploaded_at DESC")
    .get();
  if (!failed) return; // nothing to retry — earlier test was skipped
  const job = queue.latestJobForMedia(failed.id);
  assert.ok(job, 'has a job to retry');
  queue.retryJob(job.id);
  const refreshed = db.prepare('SELECT * FROM conversion_jobs WHERE id = ?').get(job.id);
  assert.equal(refreshed.status, 'pending', 'job back to pending');
  assert.equal(refreshed.attempt, 0, 'attempt reset to 0');
  const mediaRow = db.prepare('SELECT * FROM media WHERE id = ?').get(failed.id);
  assert.equal(mediaRow.status, 'processing', 'media flipped back to processing');
});

test('queue: retry endpoint via HTTP', skipOpts(), async () => {
  // Stand up a tiny express app exposing /api/media so the retry route
  // (which is what an admin user actually hits) is exercised.
  const app = express();
  app.use('/api/media', mediaRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const db = queue.__internal.getDb();
    // Pick any media row we have.
    const row = db.prepare('SELECT * FROM media ORDER BY uploaded_at DESC').get();
    assert.ok(row, 'have a media row');

    const res = await fetch(`${baseUrl}/api/media/${row.id}/retry`, { method: 'POST' });
    assert.equal(res.status, 200, 'retry endpoint returns 200');
    const data = await res.json();
    assert.equal(data.retried, true);
    assert.ok(data.job_id, 'returns the job id');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  'queue: claimNext is atomic — second caller sees the row already gone',
  skipOpts(),
  async () => {
    const db = queue.__internal.getDb();
    // Wipe any pending jobs so we can control the test set deterministically.
    db.prepare("DELETE FROM conversion_jobs WHERE status = 'pending'").run();

    const buf = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const { id } = seedMedia({ filename: 'race.png', mime: 'image/png', contents: buf });
    queue.enqueueJob(id, 'image');
    const a = queue.claimNext();
    const b = queue.claimNext();
    assert.ok(a, 'first claim returns a row');
    assert.equal(b, null, 'second claim finds nothing (atomic dequeue)');
    // Don't actually run the handler — just mark done to clean up.
    queue.markDone(a.id, {});
  },
);
