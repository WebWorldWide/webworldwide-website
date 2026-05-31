// Prebuild — runs before `astro build`. Two jobs:
//   1. Generate `scripts/legacy-redirects.json` from posts in content/posts/.
//      astro.config.mjs imports this to wire 301s from old `/<slug>/` URLs
//      to new `/blog/<slug>/` URLs.
//   2. Render `public/.well-known/webfinger` from its `.template` by
//      substituting `__SITE_HOST__` with the value from site.toml.
//      GitHub Pages serves static files; this is the cleanest way to keep
//      the IANA-required no-extension webfinger path working.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = dirname(here);

// ---- Read site.toml ----
const siteTomlPath = join(siteRoot, 'site.toml');
const siteToml = TOML.parse(await readFile(siteTomlPath, 'utf-8'));
const siteUrl = siteToml.site.url; // e.g. "https://webworldwide.online"
const siteHost = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
const fediverseUser = siteToml.fediverse?.handle_user ?? 'blog';

// ---- 1. Generate legacy redirects from posts/ ----
const postsDir = join(siteRoot, 'content', 'posts');
const files = (await readdir(postsDir)).filter((f) => f.endsWith('.md'));

const redirects = [];
const seen = new Set();
const slugRe = /^slug:\s*["']?([^"'\r\n]+?)["']?\s*$/m;
for (const file of files) {
  const fullPath = join(postsDir, file);
  // Normalize CRLF -> LF so frontmatter parsing is platform-independent.
  const raw = (await readFile(fullPath, 'utf-8')).replace(/\r\n/g, '\n');
  const fmMatch = raw.match(/^---\n([\s\S]+?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];
  const slugLine = fm.match(slugRe);
  const slug = slugLine ? slugLine[1].trim() : file.replace(/\.md$/, '');
  const from = `/${slug}/`;
  if (seen.has(from)) continue;
  seen.add(from);
  redirects.push({ from, to: `/blog/${slug}/` });
}

// Merge admin-managed vanity redirects from site/data/redirects.json (if any).
// This file is written by the admin's redirects route — preserve its entries.
const vanityPath = join(siteRoot, 'data', 'redirects.json');
let vanityCount = 0;
if (existsSync(vanityPath)) {
  try {
    const vanity = JSON.parse(await readFile(vanityPath, 'utf-8'));
    if (Array.isArray(vanity)) {
      for (const r of vanity) {
        if (!r?.from || !r?.to) continue;
        if (seen.has(r.from)) continue;
        seen.add(r.from);
        redirects.push({ from: r.from, to: r.to });
        vanityCount++;
      }
    }
  } catch (err) {
    console.warn(`[prebuild] failed to parse vanity redirects: ${err.message}`);
  }
}

await writeFile(
  join(siteRoot, 'scripts', 'legacy-redirects.json'),
  JSON.stringify(redirects, null, 2) + '\n',
);
console.log(
  `[prebuild] wrote ${redirects.length} redirects (` +
    `${redirects.length - vanityCount} legacy post + ${vanityCount} vanity).`,
);

// ---- 2. Render webfinger from template ----
const webfingerTemplate = join(siteRoot, 'public', '.well-known', 'webfinger.template');
const webfingerOut = join(siteRoot, 'public', '.well-known', 'webfinger');
if (existsSync(webfingerTemplate)) {
  let tmpl = await readFile(webfingerTemplate, 'utf-8');
  tmpl = tmpl
    .replace(/__SITE_HOST__/g, siteHost)
    .replace(/__SITE_URL__/g, siteUrl)
    .replace(/__FEDIVERSE_USER__/g, fediverseUser);
  await writeFile(webfingerOut, tmpl);
  console.log(`[prebuild] rendered webfinger for ${siteHost}.`);
} else {
  console.warn(`[prebuild] webfinger template missing: ${webfingerTemplate}`);
}
