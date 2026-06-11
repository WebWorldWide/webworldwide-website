// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import TOML from '@iarna/toml';

// site.toml holds user-editable params (analytics, social, tagline). Read here
// so it lives in one place — the admin's settings UI writes to the same file.
const here = dirname(fileURLToPath(import.meta.url));
const siteToml = /** @type {{ site: { url: string } }} */ (
  /** @type {unknown} */ (TOML.parse(readFileSync(join(here, 'site.toml'), 'utf-8')))
);

// Build the redirects map from old Hugo `/<slug>/` URLs to new `/blog/<slug>/`.
// Astro emits meta-refresh + canonical-link HTML files at the old paths so
// search engines and Bluesky cross-post `bluesky_uri` references keep working.
// The map is generated at build time by scripts/prebuild.mjs and imported here.
import legacyRedirects from './scripts/legacy-redirects.json' with { type: 'json' };

// NOTE: markdown image hygiene (loading=lazy / decoding=async) is an Astro 6
// default, and intrinsic width/height stamping happens in
// scripts/postbuild-image-dimensions.mjs over the built dist/ — Astro 6 no
// longer applies config-level `markdown.rehypePlugins` to
// import.meta.glob-loaded markdown, so a rehype plugin here is dead code.

export default defineConfig({
  site: siteToml.site.url,
  trailingSlash: 'always',

  // 301 (meta-refresh) every old `/<slug>/` URL to `/blog/<slug>/`.
  redirects: Object.fromEntries(
    legacyRedirects.map(({ from, to }) => [from, { status: 301, destination: to }]),
  ),

  integrations: [react(), sitemap({ changefreq: 'weekly', priority: 0.7 })],

  image: {
    service: { entrypoint: 'astro/assets/services/sharp' },
  },

  build: {
    format: 'directory',
    // Inline small (<4KB) stylesheets so the first paint never blocks on a
    // separate CSS request. Larger sheets stay external for caching.
    inlineStylesheets: 'auto',
    assets: '_assets',
  },
});
