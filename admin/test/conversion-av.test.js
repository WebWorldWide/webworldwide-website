// @ts-nocheck
/**
 * conversion-av.test.js — Phase 5b ffmpeg pipelines (video / audio / GIF).
 *
 * The strategy mirrors `conversion.test.js`:
 *   - One temp directory under OS tmpdir holds both the SQLite DB and
 *     the fake `site/static/` tree. AUTH_DB_PATH and SITE_DIR are set
 *     BEFORE any module under test is imported.
 *   - Synthetic fixtures (committed under `test/fixtures/`) provide a
 *     1-second video, 1-second sine tone, and a 5-frame animated GIF.
 *   - We drain the queue with `drainOnce()` for determinism.
 *
 * Self-skips cleanly when:
 *   - better-sqlite3's native binding fails to load (macOS dev hosts).
 *   - ffmpeg/ffprobe is not on PATH (CI Linux has it; some local dev
 *     hosts may not).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir;
let siteDir;
let filesDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

// Lazily-imported modules under test.
let queue;
let workerMod;
let ffmpegHelpers;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-av-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth-test.db');
  process.env.SESSION_SECRET = 'test-secret-for-cookie-signing';
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_MAX_UPLOAD_SIZE = String(20 * 1024 * 1024);
  siteDir = join(tempDir, 'site');
  filesDir = join(siteDir, 'static', 'files', '2026', '05');
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(join(siteDir, 'content', 'posts'), { recursive: true });
  mkdirSync(join(siteDir, 'static', 'images'), { recursive: true });
  mkdirSync(join(siteDir, 'static', 'files'), { recursive: true });
  mkdirSync(filesDir, { recursive: true });
  process.env.SITE_DIR = siteDir;
  process.env.CONVERSION_WORKER = 'off';

  // Verify native binding for better-sqlite3 — same escape hatch as
  // conversion.test.js. Bail before importing anything else.
  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // Check ffmpeg availability before importing modules that load it.
  ffmpegHelpers = await import('../src/services/conversion/ffmpeg.js');
  const ok = await ffmpegHelpers.ffmpegAvailable();
  if (!ok) {
    skipReason = 'ffmpeg not found on PATH — skipping AV pipeline tests';
    console.warn(`[conversion-av.test] ${skipReason}`);
    return;
  }

  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  queue = await import('../src/services/conversion/queue.js');
  workerMod = await import('../src/services/conversion/worker.js');
  // Eager-load handlers so the registry is fully populated.
  await import('../src/services/conversion/index.js');
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
 * Insert a media row by hand pointing at a fixture file we've copied
 * into the test's file directory. Returns the row id + disk path.
 *
 * @param {{ fixture: string, filename: string, mime: string }} args
 */
function seedFromFixture({ fixture, filename, mime }) {
  const db = queue.__internal.getDb();
  const id = `media-${Math.random().toString(36).slice(2, 10)}`;
  const hash = `hash${Math.random().toString(36).slice(2, 10)}`.padEnd(16, 'a');
  const src = join(__dirname, 'fixtures', fixture);
  const diskPath = join(filesDir, filename);
  copyFileSync(src, diskPath);
  const size = readFileSync(diskPath).length;
  // Lock uploaded_at to 2026-05 so derivePathFromUploadedAt matches.
  const ts = Date.UTC(2026, 4, 15, 12, 0, 0);
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size, width, height, duration, hash, conversions_json, status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'processing', ?, '[]')`,
  ).run(id, filename, filename, mime, size, null, null, null, hash, ts);
  return { id, diskPath, hash };
}

test('video: tiny.mp4 → H.264 MP4 + VP9 WebM + poster + thumb', skipOpts(), async () => {
  const { id } = seedFromFixture({
    fixture: 'tiny.mp4',
    filename: 'sample-video.mp4',
    mime: 'video/mp4',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'video');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'video media row marked ready');
  assert.equal(row.width, 240, 'width probed');
  assert.equal(row.height, 180, 'height probed');
  assert.ok(row.duration && row.duration > 0, `duration probed (${row.duration})`);

  const conversions = JSON.parse(row.conversions_json || '{}');
  for (const key of ['h264-mp4', 'vp9-webm', 'poster', 'thumb']) {
    assert.ok(conversions[key], `conversion key ${key} present`);
    const filePath = join(siteDir, 'static', conversions[key].replace(/^\//, ''));
    assert.ok(existsSync(filePath), `${key} file exists on disk`);
  }

  // Verify codecs via ffprobe.
  const mp4Path = join(siteDir, 'static', conversions['h264-mp4'].replace(/^\//, ''));
  const webmPath = join(siteDir, 'static', conversions['vp9-webm'].replace(/^\//, ''));
  const mp4Meta = await ffmpegHelpers.ffprobe(mp4Path);
  assert.equal(mp4Meta.videoCodec, 'h264', 'MP4 uses H.264');
  const webmMeta = await ffmpegHelpers.ffprobe(webmPath);
  assert.equal(webmMeta.videoCodec, 'vp9', 'WebM uses VP9');
});

test('video: 1080p cap downscales 4K source', skipOpts(), async () => {
  // Synthesize a tiny 4K-like (3840×2160) clip on the fly so we don't
  // commit a giant binary fixture. 0.5s @ 12fps keeps the encode quick.
  const big = join(filesDir, 'big-source.mp4');
  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=3840x2160:r=12:d=0.5',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      big,
    ];
    const p = spawn('ffmpeg', args);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });

  const db = queue.__internal.getDb();
  const id = `media-${Math.random().toString(36).slice(2, 10)}`;
  const hash = `hash${Math.random().toString(36).slice(2, 10)}`.padEnd(16, 'a');
  const ts = Date.UTC(2026, 4, 15, 12, 0, 0);
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size, width, height, duration, hash, conversions_json, status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, 'video/mp4', ?, ?, ?, ?, ?, '{}', 'processing', ?, '[]')`,
  ).run(
    id,
    'big-source.mp4',
    'big-source.mp4',
    readFileSync(big).length,
    null,
    null,
    null,
    hash,
    ts,
  );

  queue.enqueueJob(id, 'video');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  const conversions = JSON.parse(row.conversions_json || '{}');
  const mp4Path = join(siteDir, 'static', conversions['h264-mp4'].replace(/^\//, ''));
  const mp4Meta = await ffmpegHelpers.ffprobe(mp4Path);
  assert.equal(mp4Meta.width, 1920, 'capped at 1920 wide');
  assert.equal(mp4Meta.height, 1080, '16:9 preserved → 1080 tall');
});

test('audio: tiny.wav → MP3 + Opus + waveform.png', skipOpts(), async () => {
  const { id } = seedFromFixture({
    fixture: 'tiny.wav',
    filename: 'sample-audio.wav',
    mime: 'audio/wav',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'audio');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'audio media row marked ready');
  assert.ok(row.duration && row.duration > 0, `duration probed (${row.duration})`);

  const conversions = JSON.parse(row.conversions_json || '{}');
  for (const key of ['mp3-128', 'opus-96', 'waveform']) {
    assert.ok(conversions[key], `conversion key ${key} present`);
    const filePath = join(siteDir, 'static', conversions[key].replace(/^\//, ''));
    assert.ok(existsSync(filePath), `${key} file exists on disk`);
  }

  // Verify codecs via ffprobe.
  const mp3Path = join(siteDir, 'static', conversions['mp3-128'].replace(/^\//, ''));
  const opusPath = join(siteDir, 'static', conversions['opus-96'].replace(/^\//, ''));
  const mp3Meta = await ffmpegHelpers.ffprobe(mp3Path);
  assert.equal(mp3Meta.audioCodec, 'mp3', 'MP3 codec match');
  const opusMeta = await ffmpegHelpers.ffprobe(opusPath);
  assert.equal(opusMeta.audioCodec, 'opus', 'Opus codec match');
});

test('audio: LUFS-normalized MP3 measures within 1 dB of -16 LUFS', skipOpts(), async () => {
  // Generate a deliberately quiet source so the normalize pass has to
  // actually do work. -36 dBFS sine for 3 seconds.
  const src = join(filesDir, 'quiet-source.wav');
  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-af',
      'volume=-20dB',
      src,
    ];
    const p = spawn('ffmpeg', args);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });

  const db = queue.__internal.getDb();
  const id = `media-${Math.random().toString(36).slice(2, 10)}`;
  const hash = `hash${Math.random().toString(36).slice(2, 10)}`.padEnd(16, 'a');
  const ts = Date.UTC(2026, 4, 15, 12, 0, 0);
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size, width, height, duration, hash, conversions_json, status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, 'audio/wav', ?, ?, ?, ?, ?, '{}', 'processing', ?, '[]')`,
  ).run(
    id,
    'quiet-source.wav',
    'quiet-source.wav',
    readFileSync(src).length,
    null,
    null,
    null,
    hash,
    ts,
  );

  queue.enqueueJob(id, 'audio');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  const conversions = JSON.parse(row.conversions_json || '{}');
  const mp3Path = join(siteDir, 'static', conversions['mp3-128'].replace(/^\//, ''));
  assert.ok(existsSync(mp3Path));

  // Re-measure the MP3's integrated loudness. We expect it within
  // ~1 dB of -16 LUFS (loudnorm two-pass aims tighter than 0.5 dB on
  // clean signals, but very short clips have measurement noise; we
  // give ourselves headroom here).
  const lufs = await measureLufs(mp3Path);
  assert.ok(Number.isFinite(lufs), `LUFS measurement returned a real number (${lufs})`);
  const distance = Math.abs(lufs - -16);
  assert.ok(
    distance <= 1.0,
    `MP3 integrated loudness ${lufs.toFixed(2)} LUFS within 1 dB of -16 (Δ=${distance.toFixed(2)})`,
  );
});

test('gif: tiny.gif → H.264 MP4 + VP9 WebM + poster JPEG', skipOpts(), async () => {
  // image/gif routes through resolveDiskContext to the `images/` tree
  // (not `files/`), so we also stage the fixture there so the handler
  // can find it. The seedFromFixture helper writes to filesDir; the
  // copy below ensures the gif resolves both ways.
  const { id } = seedFromFixture({
    fixture: 'tiny.gif',
    filename: 'sample.gif',
    mime: 'image/gif',
  });
  const imagesGifDir = join(siteDir, 'static', 'images', '2026', '05');
  mkdirSync(imagesGifDir, { recursive: true });
  copyFileSync(join(__dirname, 'fixtures', 'tiny.gif'), join(imagesGifDir, 'sample.gif'));
  const db = queue.__internal.getDb();
  // GIF job — same dispatch path the image handler would use via the
  // follow-up enqueue, just enqueued directly here so we don't have to
  // route through the image pipeline.
  queue.enqueueJob(id, 'gif');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'GIF media row marked ready');
  assert.equal(row.width, 100);
  assert.equal(row.height, 100);

  const conversions = JSON.parse(row.conversions_json || '{}');
  for (const key of ['h264-mp4', 'vp9-webm', 'poster']) {
    assert.ok(conversions[key], `conversion key ${key} present`);
    const filePath = join(siteDir, 'static', conversions[key].replace(/^\//, ''));
    assert.ok(existsSync(filePath), `${key} file exists on disk`);
  }

  // Original GIF preserved.
  assert.ok(existsSync(join(filesDir, 'sample.gif')), 'original GIF preserved');

  // Verify the MP4 is actually H.264 with a video stream (i.e. animated
  // transcode, not a stilled frame).
  const mp4Path = join(siteDir, 'static', conversions['h264-mp4'].replace(/^\//, ''));
  const mp4Meta = await ffmpegHelpers.ffprobe(mp4Path);
  assert.equal(mp4Meta.videoCodec, 'h264');
  assert.ok(mp4Meta.duration > 0, 'transcoded MP4 has nonzero duration');
});

test('ffmpeg: computeTimeoutMs respects min + cap', () => {
  // Helper math is independent of ffmpeg availability — always runs.
  const { computeTimeoutMs, __internal } = ffmpegHelpers || {};
  if (!computeTimeoutMs) return;
  assert.equal(computeTimeoutMs(0), __internal.MIN_TIMEOUT_MS, '0s source → minimum budget');
  assert.equal(computeTimeoutMs(2), 20_000, '2s source → 10x = 20s');
  assert.equal(computeTimeoutMs(10_000), __internal.HARD_CAP_MS, 'huge source → hard cap');
});

/**
 * Re-measure the integrated LUFS of an audio file. Re-runs ffmpeg
 * loudnorm in analyze mode and parses the JSON block out of stderr.
 *
 * @param {string} path
 * @returns {Promise<number>}
 */
function measureLufs(path) {
  return new Promise((resolve) => {
    /** spawn imported at top of file */
    const args = [
      '-hide_banner',
      '-i',
      path,
      '-af',
      'loudnorm=I=-16:LRA=11:TP=-1.5:print_format=json',
      '-f',
      'null',
      '-',
    ];
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    p.on('error', () => resolve(NaN));
    p.on('exit', () => {
      const start = stderr.lastIndexOf('{');
      const end = stderr.lastIndexOf('}');
      if (start < 0 || end <= start) return resolve(NaN);
      try {
        const json = JSON.parse(stderr.slice(start, end + 1));
        resolve(parseFloat(json.input_i));
      } catch {
        resolve(NaN);
      }
    });
  });
}
