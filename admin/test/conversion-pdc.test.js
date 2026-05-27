// @ts-nocheck
/**
 * conversion-pdc.test.js — Phase 5c PDF / code / archive pipelines.
 *
 * Mirrors the Phase 5a/b test layout:
 *   - One temp directory under OS tmpdir holds both the SQLite DB and
 *     the fake `site/static/` tree. AUTH_DB_PATH and SITE_DIR are set
 *     BEFORE any module under test is imported.
 *   - Committed fixtures under `test/fixtures/` provide the inputs
 *     (tiny.pdf, sample.js, sample.py, sample.zip).
 *   - The queue is drained synchronously with `drainOnce()` so timing
 *     is deterministic.
 *
 * Self-skips when:
 *   - better-sqlite3's native binding fails to load (macOS dev hosts).
 *   - poppler-utils (pdftoppm) is not on PATH. The CI image installs
 *     it via `apk add poppler-utils`; on a dev mac, `brew install
 *     poppler` does the same.
 *
 * The code + archive tests do NOT require poppler — they're skipped
 * separately if better-sqlite3 isn't available, but otherwise run.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { imageSize } from 'image-size';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir;
let siteDir;
let filesDir;
let skipReason = false;
let pdfSkipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});
const skipPdfOpts = () => ({
  get skip() {
    return skipReason || pdfSkipReason;
  },
});

let queue;
let workerMod;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-pdc-test-'));
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

  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
  } catch (err) {
    skipReason = `better-sqlite3 native binding failed: ${err.message.split('\n')[0]}`;
    return;
  }

  // pdftoppm gate — only the PDF test depends on poppler.
  const which = spawnSync('pdftoppm', ['-v']);
  if (which.error || (which.status !== 0 && which.status !== 99)) {
    // poppler's `-v` exits 99 on some builds. We just need a binary
    // that responds at all; missing-binary => spawn error.
    pdfSkipReason = 'pdftoppm not on PATH — skipping PDF pipeline test';
    console.warn(`[conversion-pdc.test] ${pdfSkipReason}`);
  }

  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  queue = await import('../src/services/conversion/queue.js');
  workerMod = await import('../src/services/conversion/worker.js');
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
  const ts = Date.UTC(2026, 4, 15, 12, 0, 0);
  db.prepare(
    `INSERT INTO media (id, filename, original_name, mime_type, size, width, height, duration, hash, conversions_json, status, uploaded_at, post_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'processing', ?, '[]')`,
  ).run(id, filename, filename, mime, size, null, null, null, hash, ts);
  return { id, diskPath, hash };
}

test('pdf: tiny.pdf → cover JPG + thumb JPG + page_count', skipPdfOpts(), async () => {
  const { id } = seedFromFixture({
    fixture: 'tiny.pdf',
    filename: 'sample-doc.pdf',
    mime: 'application/pdf',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'pdf');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'PDF media row marked ready');
  assert.ok(row.width && row.width > 0, `width set from cover (${row.width})`);
  assert.ok(row.height && row.height > 0, `height set from cover (${row.height})`);

  const conversions = JSON.parse(row.conversions_json || '{}');
  assert.equal(conversions.page_count, 1, 'page_count probed');
  for (const key of ['cover', 'thumb']) {
    assert.ok(conversions[key], `conversion key ${key} present`);
    const filePath = join(siteDir, 'static', conversions[key].replace(/^\//, ''));
    assert.ok(existsSync(filePath), `${key} file exists on disk`);
    // image-size decodes the JPEG header — proves the file is a real
    // image, not an empty/corrupt write.
    const dims = imageSize(readFileSync(filePath));
    assert.ok(dims.width > 0 && dims.height > 0, `${key} JPEG dims sensible`);
    assert.equal(dims.type, 'jpg', `${key} is a JPEG`);
  }
});

test('code: sample.js → preview-html + preview-txt with shiki render', skipOpts(), async () => {
  const { id, diskPath } = seedFromFixture({
    fixture: 'sample.js',
    filename: 'snippet.js',
    mime: 'text/javascript',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'code');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'code media row marked ready');

  const conversions = JSON.parse(row.conversions_json || '{}');
  assert.equal(conversions.language, 'javascript');
  assert.ok(conversions.line_count > 0, 'line_count populated');
  assert.ok(conversions.char_count > 0, 'char_count populated');

  // preview-txt should round-trip the source bytes verbatim.
  const txtPath = join(siteDir, 'static', conversions['preview-txt'].replace(/^\//, ''));
  assert.ok(existsSync(txtPath));
  const txt = readFileSync(txtPath, 'utf8');
  assert.equal(txt, readFileSync(diskPath, 'utf8'), 'preview-txt matches source');

  // preview-html should contain a <pre class="shiki"...> wrapper and
  // the source identifier "function add".
  const htmlPath = join(siteDir, 'static', conversions['preview-html'].replace(/^\//, ''));
  assert.ok(existsSync(htmlPath));
  const html = readFileSync(htmlPath, 'utf8');
  assert.ok(html.includes('<pre class="shiki'), 'shiki <pre> wrapper present');
  // Shiki spans the identifier into multiple tokens, so the literal
  // substring may not appear; check for both halves.
  assert.ok(html.includes('function'), 'source token "function" present');
  assert.ok(html.includes('add'), 'source token "add" present');
});

test('code: sample.py → language=python + correct line count', skipOpts(), async () => {
  const { id, diskPath } = seedFromFixture({
    fixture: 'sample.py',
    filename: 'snippet.py',
    mime: 'text/x-python',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'code');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  const conversions = JSON.parse(row.conversions_json || '{}');
  assert.equal(conversions.language, 'python');

  // Compute the expected line count via the same wc-l-ish convention
  // the handler uses: trailing newline doesn't add an extra line.
  const raw = readFileSync(diskPath, 'utf8');
  const lf = (raw.match(/\n/g) || []).length;
  const expectedLines = raw.endsWith('\n') ? lf : lf + 1;
  assert.equal(conversions.line_count, expectedLines, 'line_count matches source');
  assert.equal(conversions.char_count, raw.length);
});

test('archive: sample.zip → tree.json with correct entries', skipOpts(), async () => {
  const { id } = seedFromFixture({
    fixture: 'sample.zip',
    filename: 'pkg.zip',
    mime: 'application/zip',
  });
  const db = queue.__internal.getDb();
  queue.enqueueJob(id, 'archive');
  await workerMod.drainOnce({ concurrency: 1 });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.status, 'ready', 'archive media row marked ready');

  const conversions = JSON.parse(row.conversions_json || '{}');
  assert.equal(conversions.total_files, 3, 'three files counted (excludes dir entry)');
  assert.equal(conversions.truncated, false);
  assert.ok(conversions.total_size > 0);

  const treePath = join(siteDir, 'static', conversions.tree.replace(/^\//, ''));
  assert.ok(existsSync(treePath));
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  assert.equal(tree.format, 'zip');
  // The 3 files we zipped were README.md, src/index.js, package.json
  // (plus a dir entry for src/).
  const fileEntries = tree.entries.filter((e) => e.type === 'file');
  const dirEntries = tree.entries.filter((e) => e.type === 'dir');
  const names = fileEntries.map((e) => e.path).sort();
  assert.deepEqual(names, ['README.md', 'package.json', 'src/index.js']);
  assert.ok(
    dirEntries.some((e) => e.path === 'src/'),
    'src/ dir entry recorded',
  );
  // Each file entry has a numeric size.
  for (const e of fileEntries) {
    assert.equal(typeof e.size, 'number');
    assert.ok(e.size > 0);
  }
});

test('code: isCodeFile extension allowlist', skipOpts(), async () => {
  const { isCodeFile } = await import('../src/services/conversion/index.js');
  assert.equal(isCodeFile('foo.js'), true);
  assert.equal(isCodeFile('FOO.PY'), true, 'case-insensitive');
  assert.equal(isCodeFile('archive.zip'), false);
  assert.equal(isCodeFile('image.png'), false);
  assert.equal(isCodeFile(''), false);
  assert.equal(isCodeFile('no-extension'), false);
});
