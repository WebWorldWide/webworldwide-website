#!/usr/bin/env node
// @ts-check
/**
 * Re-fetch Ghost-hosted post images into site/public/images/.
 *
 * The original Ghost → Markdown migration wrote 0-byte placeholder files; the
 * real images live on Ghost's CDN. This reads every `/images/...` reference in
 * site/content/posts/*.md and downloads it from the CDN, overwriting the
 * placeholder at the matching path (so the markdown needs no changes).
 *
 * Usage: node migrate/fetch-post-images.mjs
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTS = resolve(HERE, '../site/content/posts');
const PUBLIC = resolve(HERE, '../site/public');
// Ghost CDN base for this blog (from the live terminaleighty.com <img> src).
const CDN = 'https://storage.ghost.io/c/90/c0/90c0caac-db6e-46cc-862e-ad65a80066f4/content/images';

const mdFiles = (await readdir(POSTS)).filter((f) => f.endsWith('.md'));
const refs = new Set();
for (const f of mdFiles) {
  const md = await readFile(join(POSTS, f), 'utf8');
  for (const m of md.matchAll(/!\[[^\]]*\]\((\/images\/[^)\s]+)\)/g)) refs.add(m[1]);
}

let ok = 0;
let failed = 0;
for (const ref of [...refs].sort()) {
  const url = CDN + ref.replace(/^\/images/, '');
  const dest = join(PUBLIC, ref);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    console.log(`ok   ${ref}  ${(buf.length / 1024).toFixed(1)} KB`);
    ok++;
  } catch (e) {
    console.error(`FAIL ${ref}  ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}
console.log(`\n${ok} downloaded, ${failed} failed, ${refs.size} referenced.`);
if (failed) process.exit(1);
