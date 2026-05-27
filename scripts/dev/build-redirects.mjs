#!/usr/bin/env node
/**
 * build-redirects.mjs — emit static meta-refresh HTML files for every
 * entry in `site/data/redirects.json`. Run before `hugo build` so the
 * files land in `site/static/` (and therefore directly in `public/`).
 *
 * Each entry produces:
 *   site/static/<from>/index.html  →  meta-refresh + JS fallback to `to`
 *
 * Skips entries whose `from` is an absolute URL or contains `..` to
 * prevent accidental file-system escapes.
 *
 * For per-post redirects, prefer Hugo's `aliases:` front-matter field
 * — those are auto-emitted by Hugo and live alongside the post. This
 * script is for stand-alone redirects (deleted posts, vanity URLs).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SITE_DIR = process.env.SITE_DIR || join(REPO_ROOT, 'site');
const REDIRECTS_JSON = join(SITE_DIR, 'data', 'redirects.json');
const STATIC_DIR = join(SITE_DIR, 'static');
const MARKER_DIR = join(STATIC_DIR, '.t80-redirects');

if (!existsSync(REDIRECTS_JSON)) {
  process.exit(0);
}

const raw = readFileSync(REDIRECTS_JSON, 'utf-8');
/** @type {{ id: string, from: string, to: string, code?: number }[]} */
let rows;
try {
  rows = JSON.parse(raw);
  if (!Array.isArray(rows)) rows = [];
} catch (err) {
  console.error('[redirects] redirects.json parse failed:', err.message);
  process.exit(1);
}

// Clean previous run's markers so deleted redirects don't linger.
const written = new Set();
if (existsSync(MARKER_DIR)) {
  try {
    rmSync(MARKER_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
mkdirSync(MARKER_DIR, { recursive: true });

let emitted = 0;
for (const r of rows) {
  const from = String(r.from || '').trim();
  const to = String(r.to || '').trim();
  if (!from || !to) continue;
  if (!from.startsWith('/')) continue; // skip absolute URLs as source
  if (from.includes('..') || from.includes('\0')) continue;
  if (from === '/' || from === '') continue;

  const slug = from.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!slug) continue;

  const dir = join(STATIC_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Redirecting…</title>
  <link rel="canonical" href="${escapeHtml(to)}" />
  <meta http-equiv="refresh" content="0; url=${escapeHtml(to)}" />
  <meta name="robots" content="noindex" />
</head>
<body>
  <p>Redirecting to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>…</p>
  <script>window.location.replace(${JSON.stringify(to)});</script>
</body>
</html>
`;
  writeFileSync(join(dir, 'index.html'), html);
  written.add(slug);
  emitted += 1;
}

// Marker file (so a future `clean` pass can find what we wrote without
// stomping unrelated static files).
writeFileSync(
  join(MARKER_DIR, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), paths: Array.from(written) }, null, 2) +
    '\n',
);

console.log(`[redirects] emitted ${emitted} redirect page${emitted === 1 ? '' : 's'}`);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
