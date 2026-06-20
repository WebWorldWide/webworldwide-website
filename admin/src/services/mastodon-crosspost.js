// @ts-check
/**
 * mastodon-crosspost.js — publish-time orchestrator for DIRECT Mastodon
 * cross-posting. Mirrors bluesky-crosspost.js exactly:
 *
 *   - read the changed post files, parse front-matter
 *   - skip drafts
 *   - skip posts that already have `mastodon_uri` set (idempotency)
 *   - skip posts whose `date` is older than MAX_AGE_MS (no back-catalog spam)
 *   - post a single status, write the resulting `mastodon_uri` back
 *
 * Best-effort: a failed call is logged and the post is left without a
 * `mastodon_uri` so the next publish retries. Never throws.
 *
 * Shares `extractExcerpt` + `parseDate` with bluesky-crosspost so the two
 * syndication paths derive identical excerpts/age-gates from the same post.
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

import { parsePost, serializePost } from '../utils/frontmatter.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import * as mastodon from './mastodon.js';
import { extractExcerpt, __test as blueskyCrosspost } from './bluesky-crosspost.js';
import { logActivity } from './activity.js';

const parseDate = blueskyCrosspost.parseDate;

const SITE_DIR_DEFAULT = '..';
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — see bluesky-crosspost
const DEFAULT_MAX_PER_RUN = 5;

function getMaxAgeMs() {
  const v = Number(process.env.MASTODON_MAX_AGE_MS || process.env.BLUESKY_MAX_AGE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_AGE_MS;
}

function getMaxPerRun() {
  const v = Number(process.env.MASTODON_MAX_PER_RUN || process.env.BLUESKY_MAX_PER_RUN);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PER_RUN;
}

/**
 * Cross-post the given changed post filenames to Mastodon. Returns a report;
 * never throws.
 *
 * @param {string[]} changedPosts — filenames under site/content/posts/
 * @param {{ siteDir?: string, baseUrl?: string }} [opts]
 * @returns {Promise<{ posted: { filename: string, uri: string }[], skipped: { filename: string, reason: string }[], errors: { filename: string, error: string }[] }>}
 */
export async function crossPostChangedPosts(changedPosts, opts = {}) {
  const report = { posted: [], skipped: [], errors: [] };
  if (!Array.isArray(changedPosts) || changedPosts.length === 0) return report;
  if (!mastodon.isConfigured()) {
    for (const f of changedPosts) report.skipped.push({ filename: f, reason: 'not_configured' });
    return report;
  }

  const siteDir = opts.siteDir || process.env.SITE_DIR || SITE_DIR_DEFAULT;
  const baseUrl = opts.baseUrl || process.env.PUBLIC_BASE_URL || 'https://webworldwide.online';
  const postsDir = join(siteDir, 'content', 'posts');
  const maxAgeMs = getMaxAgeMs();
  const maxPerRun = getMaxPerRun();

  let posted = 0;
  for (const filename of changedPosts) {
    if (posted >= maxPerRun) {
      report.skipped.push({ filename, reason: 'rate_limit' });
      continue;
    }
    const fullPath = join(postsDir, filename);
    if (!existsSync(fullPath)) {
      report.skipped.push({ filename, reason: 'not_found' });
      continue;
    }
    let raw, parsed;
    try {
      raw = readFileSync(fullPath, 'utf-8');
      parsed = parsePost(raw);
    } catch (err) {
      report.errors.push({ filename, error: `parse_failed: ${err.message}` });
      continue;
    }
    const data = parsed.data || {};

    if (data.draft === true) {
      report.skipped.push({ filename, reason: 'draft' });
      continue;
    }
    if (data.mastodon_uri) {
      report.skipped.push({ filename, reason: 'already_posted' });
      continue;
    }
    const postDate = parseDate(data.date);
    if (postDate && Date.now() - postDate > maxAgeMs) {
      report.skipped.push({ filename, reason: 'too_old' });
      continue;
    }

    const slug = String(data.slug || filename.replace(/\.md$/, ''));
    // Canonical post URL is /blog/<slug>/ (site.toml [blog] permalink); the bare
    // /<slug>/ only 302s via a redirect stub with no og tags. See bluesky-crosspost.
    const url = `${baseUrl.replace(/\/+$/, '')}/blog/${slug}/`;
    const title = String(data.title || slug);
    const excerpt = String(data.description || extractExcerpt(parsed.content || '', 480));

    try {
      const result = await mastodon.postStatus({
        title,
        excerpt,
        url,
        idempotencyKey: `wwwide:${slug}`,
      });
      data.mastodon_uri = result.url || result.uri;
      writeFileAtomic(fullPath, serializePost(data, parsed.content || ''));
      report.posted.push({ filename, uri: data.mastodon_uri });
      logActivity({
        user: 'system',
        action: 'mastodon.crosspost',
        target: slug,
        meta: { uri: data.mastodon_uri, url },
      });
      posted++;
    } catch (err) {
      report.errors.push({ filename, error: err.message });
      logActivity({
        user: 'system',
        action: 'mastodon.crosspost_failed',
        target: slug,
        meta: { error: err.message },
      });
    }
  }

  return report;
}

export default { crossPostChangedPosts };
