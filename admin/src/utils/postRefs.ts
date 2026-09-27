// @ts-check
/**
 * postRefs.js — scan Markdown posts for `/images/...` and `/files/...`
 * references so the media library can show "this file is used in N
 * posts" and so deletes can refuse to orphan content.
 *
 * The scan is opportunistic — we read every `.md` under
 * `site/content/posts/` and pull URL-shaped tokens out via regex. We do
 * NOT try to be smart about shortcodes, attachment nodes, or HTML —
 * Phase 6 will introduce a structured attachment node and at that point
 * the canonical reference list will move into the frontmatter. For now,
 * "URL substring match" is enough to give the user a clear "this is
 * referenced in `welcome.md`, are you sure?" prompt.
 *
 * Results are cached for 60 seconds so a burst of usage/delete calls
 * doesn't re-scan dozens of files. `invalidatePostRefs()` clears the
 * cache (used after a post is saved/deleted via the posts route).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const POSTS_DIR = join(SITE_DIR, 'content', 'posts');
const CACHE_TTL_MS = 60_000;

/** @type {{ at: number, map: Map<string, string[]> } | null} */
let cache = null;

/**
 * Build (or return cached) map of `/images/...` and `/files/...` URL
 * paths → list of post filenames that reference them.
 *
 * @param {string} [postsDirOverride] tests can point at a temp directory
 * @returns {Map<string, string[]>}
 */
export function getPostRefs(postsDirOverride) {
  const dir = postsDirOverride || POSTS_DIR;
  if (!postsDirOverride && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }

  /** @type {Map<string, string[]>} */
  const map = new Map();
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    // No posts directory yet (fresh install). Nothing references
    // anything; return an empty map and don't cache the failure so a
    // freshly-created dir is picked up immediately.
    return map;
  }

  const urlRe = /\/(?:images|files)\/[A-Za-z0-9_./-]+/g;
  for (const file of files) {
    let body;
    try {
      body = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    /** @type {Set<string>} */
    const seen = new Set();
    let m;
    while ((m = urlRe.exec(body)) !== null) {
      seen.add(m[0]);
    }
    for (const url of seen) {
      const arr = map.get(url) || [];
      if (!arr.includes(file)) arr.push(file);
      map.set(url, arr);
    }
  }

  if (!postsDirOverride) {
    cache = { at: Date.now(), map };
  }
  return map;
}

/** Drop the cached scan; next read does a fresh sweep. */
export function invalidatePostRefs() {
  cache = null;
}

/**
 * Convenience: return the posts that reference a single URL path.
 *
 * @param {string} urlPath e.g. `/images/2026/05/abcd1234-logo.png`
 * @param {string} [postsDirOverride]
 * @returns {string[]}
 */
export function postsReferencing(urlPath, postsDirOverride) {
  const map = getPostRefs(postsDirOverride);
  return map.get(urlPath) || [];
}
