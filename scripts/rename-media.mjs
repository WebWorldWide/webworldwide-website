#!/usr/bin/env node
// @ts-check
/**
 * rename-media.mjs — give the Ghost-imported media meaningful names.
 *
 * The import left every image as image.webp / image-2.webp / … — useless
 * for knowing what's what. This renames each referenced image to
 * `<post-slug>[-<n>].webp` (n only when a post has multiple images), in
 * document order, and rewrites the post that references it. It prints a
 * JSON map (old→new) on stdout so the companion DB update can mirror the
 * change in the CMS media library.
 *
 * Repo-only: it touches site/public/images + site/content/posts. The CMS
 * media DB is updated separately (see --print-db-sql / the deploy step).
 *
 *   node scripts/rename-media.mjs            # dry run (prints the plan)
 *   node scripts/rename-media.mjs --apply    # rename files + rewrite posts
 *   node scripts/rename-media.mjs --apply --map /tmp/m.json   # also write map
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const POSTS_DIR = join(ROOT, 'site', 'content', 'posts');
const PUBLIC_DIR = join(ROOT, 'site', 'public');

const APPLY = process.argv.includes('--apply');
const mapFlagIdx = process.argv.indexOf('--map');
const MAP_OUT = mapFlagIdx !== -1 ? process.argv[mapFlagIdx + 1] : null;

// Image URLs in body (markdown) + the cover: frontmatter field, in order.
const bodyImgRe = /!\[[^\]]*\]\((\/images\/[^)\s]+)\)/g;
const coverRe = /^cover:\s*['"]?(\/images\/[^'"\n\s]+)/m;

/** @type {Array<{ oldUrl: string, newUrl: string, post: string }>} */
const plan = [];
/** url → newUrl (so a url referenced twice maps consistently) */
const seen = new Map();

for (const file of readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '');
  const text = readFileSync(join(POSTS_DIR, file), 'utf8');

  // Collect this post's image URLs in document order: cover first, then body.
  const urls = [];
  const cov = text.match(coverRe);
  if (cov) urls.push(cov[1]);
  let m;
  while ((m = bodyImgRe.exec(text)) !== null) urls.push(m[1]);
  // Unique, preserving order.
  const unique = [...new Set(urls)];
  if (!unique.length) continue;

  unique.forEach((url, i) => {
    if (seen.has(url)) return; // already assigned (shared/duplicate)
    const dir = url.slice(0, url.lastIndexOf('/')); // /images/2025/12
    const ext = url.slice(url.lastIndexOf('.')); // .webp
    const suffix = unique.length > 1 ? `-${i + 1}` : '';
    const newUrl = `${dir}/${slug}${suffix}${ext}`;
    if (url === newUrl) return; // already well-named
    seen.set(url, newUrl);
    plan.push({ oldUrl: url, newUrl, post: slug });
  });
}

if (!plan.length) {
  console.error('Nothing to rename — media already has good names.');
  process.exit(0);
}

// Sanity: no two old urls map to the same new url.
const collisions = new Map();
for (const { newUrl } of plan) collisions.set(newUrl, (collisions.get(newUrl) || 0) + 1);
const dupe = [...collisions].filter(([, n]) => n > 1);
if (dupe.length) {
  console.error('ABORT: name collisions:', dupe);
  process.exit(1);
}

console.error(`${APPLY ? 'Applying' : '[dry-run]'} ${plan.length} rename(s):`);
for (const { oldUrl, newUrl, post } of plan) {
  console.error(`  ${oldUrl}  →  ${newUrl}   (${post})`);
  if (!APPLY) continue;
  const oldFile = join(PUBLIC_DIR, oldUrl.replace(/^\//, ''));
  const newFile = join(PUBLIC_DIR, newUrl.replace(/^\//, ''));
  if (!existsSync(oldFile)) {
    console.error(`    WARN: file missing, skipping file move: ${oldFile}`);
  } else {
    renameSync(oldFile, newFile);
  }
}

// Rewrite post references (apply mode). Replace every occurrence of each old
// URL across ALL posts (a url could appear in body + cover).
if (APPLY) {
  for (const file of readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'))) {
    const p = join(POSTS_DIR, file);
    let text = readFileSync(p, 'utf8');
    let changed = false;
    for (const { oldUrl, newUrl } of plan) {
      if (text.includes(oldUrl)) {
        text = text.split(oldUrl).join(newUrl);
        changed = true;
      }
    }
    if (changed) writeFileSync(p, text);
  }
}

// Emit the map (old basename → new basename + urls) for the DB update.
const map = plan.map(({ oldUrl, newUrl }) => ({
  oldUrl,
  newUrl,
  oldName: oldUrl.slice(oldUrl.lastIndexOf('/') + 1),
  newName: newUrl.slice(newUrl.lastIndexOf('/') + 1),
  oldStorage: oldUrl.replace(/^\//, ''),
  newStorage: newUrl.replace(/^\//, ''),
}));
const json = JSON.stringify(map, null, 2);
if (MAP_OUT) writeFileSync(MAP_OUT, json);
console.log(json);
console.error(`\n${APPLY ? 'Done.' : 'Dry run — re-run with --apply.'} ${plan.length} item(s).`);
