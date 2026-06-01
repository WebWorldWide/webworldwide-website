#!/usr/bin/env node
// @ts-check
/**
 * Optimize post images for the web: cap width at a retina-friendly size and
 * convert PNG → WebP (photographic post images are far smaller as WebP), then
 * rewrite the markdown references (.png → .webp). Run AFTER
 * migrate/fetch-post-images.mjs. Uses the site's sharp.
 *
 * Usage: node site/scripts/optimize-post-images.mjs
 */
import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const PUBLIC = join(SITE, 'public');
const IMAGES = join(PUBLIC, 'images');
const POSTS = join(SITE, 'content/posts');
const MAX_W = 1600;

const toWeb = (p) => '/' + p.slice(PUBLIC.length + 1).replace(/\\/g, '/');

/** @param {string} dir */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const map = new Map();
let before = 0;
let after = 0;
for await (const file of walk(IMAGES)) {
  if (extname(file).toLowerCase() !== '.png') continue;
  const buf = await readFile(file);
  before += buf.length;
  const out = file.replace(/\.png$/i, '.webp');
  await sharp(buf)
    .resize({ width: MAX_W, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(out);
  const size = (await stat(out)).size;
  after += size;
  await rm(file);
  map.set(toWeb(file), toWeb(out));
  console.log(
    `${toWeb(file)} → ${toWeb(out)}  ${(buf.length / 1024).toFixed(0)}KB → ${(size / 1024).toFixed(0)}KB`,
  );
}

let edited = 0;
for (const f of (await readdir(POSTS)).filter((n) => n.endsWith('.md'))) {
  const path = join(POSTS, f);
  let md = await readFile(path, 'utf8');
  let changed = false;
  for (const [oldP, newP] of map) {
    if (md.includes(oldP)) {
      md = md.split(oldP).join(newP);
      changed = true;
    }
  }
  if (changed) {
    await writeFile(path, md);
    edited++;
  }
}

console.log(
  `\n${map.size} images optimized, ${edited} posts updated. ` +
    `${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB`,
);
