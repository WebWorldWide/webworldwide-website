#!/usr/bin/env node
// @ts-check
/**
 * Image hygiene over the built HTML (replaces the old rehypeLazyImages
 * config plugin — post-processing dist/ dodges Vite's markdown-module
 * cache and also covers raw-HTML images like the editor's aligned
 * <figure> wrappers):
 *
 *   1. Stamp every locally-hosted <img> with its intrinsic width/height
 *      so the browser reserves the right box before the bytes arrive —
 *      without dimensions every post image is a layout shift (CLS ~0.13
 *      on a typical post page, enough to fail the Lighthouse budget).
 *   2. Default loading="lazy" + decoding="async" so below-the-fold
 *      images never block the initial paint.
 *
 * Usage: node scripts/postbuild-image-dimensions.mjs   (cwd: site/)
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist');
const PUBLIC = resolve(HERE, '..', 'public');

// Astro/Vite drops the `.well-known` dot-directory when copying public/ -> dist/,
// which 404s the IANA webfinger path (no extension) that Bridgy Fed / Mastodon
// query to resolve the @domain@domain fediverse handle. Copy it back so the
// federation handshake works. (Confirmed: /.well-known/webfinger was 404 live.)
if (existsSync(join(PUBLIC, '.well-known'))) {
  cpSync(join(PUBLIC, '.well-known'), join(DIST, '.well-known'), { recursive: true });
}
// GitHub Pages applies Jekyll, which OMITS dot-directories (like .well-known)
// from what it serves — so the copied webfinger 404s without this marker.
// `.nojekyll` disables that processing so the whole dist/ is served verbatim.
writeFileSync(join(DIST, '.nojekyll'), '');

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.html')) yield p;
  }
}

/** @type {Map<string, Promise<{ width: number, height: number } | null>>} */
const sizeCache = new Map();

/** @param {string} src site-absolute path, e.g. /images/2025/12/a.webp */
function measure(src) {
  let cached = sizeCache.get(src);
  if (!cached) {
    cached = sharp(join(DIST, decodeURIComponent(src)))
      .metadata()
      .then(({ width, height }) => (width && height ? { width, height } : null))
      .catch(() => null); // SVG without intrinsic size, missing file, …
    sizeCache.set(src, cached);
  }
  return cached;
}

const IMG_TAG = /<img\s[^>]*>/g;

let htmlFiles = 0;
let stamped = 0;

for await (const file of walk(DIST)) {
  const html = await readFile(file, 'utf-8');
  const tags = html.match(IMG_TAG);
  if (!tags) continue;
  htmlFiles += 1;

  /** @type {Map<string, string>} */
  const replacements = new Map();
  // The FIRST local image in document order is the likely LCP element (esp. an
  // image-led blog post whose lead image is the first <img> in the body). Load
  // it eagerly with a high fetch priority — lazy-loading the LCP image is the
  // documented Web-Vitals anti-pattern. Every later image stays lazy.
  let firstStamped = false;
  for (const tag of new Set(tags)) {
    const src = tag.match(/\bsrc="([^"]+)"/)?.[1];
    if (!src || !src.startsWith('/')) continue;
    let next = tag;
    if (!/\bloading\s*=/.test(next)) {
      next = next.replace(
        />$/,
        firstStamped ? ' loading="lazy">' : ' loading="eager" fetchpriority="high">',
      );
      firstStamped = true;
    }
    if (!/\bdecoding\s*=/.test(next)) next = next.replace(/>$/, ' decoding="async">');
    if (!/\b(?:width|height)\s*=/.test(next)) {
      const size = await measure(src);
      if (size) next = next.replace(/>$/, ` width="${size.width}" height="${size.height}">`);
    }
    if (next !== tag) replacements.set(tag, next);
  }
  if (!replacements.size) continue;

  let out = html;
  for (const [from, to] of replacements) out = out.replaceAll(from, to);
  await writeFile(file, out);
  stamped += replacements.size;
}

console.log(
  `[postbuild-image-dimensions] stamped ${stamped} image tag(s) across ${htmlFiles} HTML file(s)`,
);
