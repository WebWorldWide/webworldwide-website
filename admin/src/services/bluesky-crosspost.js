// @ts-check
/**
 * bluesky-crosspost.js — Phase 9 publish-time orchestrator.
 *
 * Wraps the lower-level `bluesky.js` service with the business rules
 * specific to the publish hook:
 *
 *   - Read the changed post files from disk, parse front-matter.
 *   - Skip drafts.
 *   - Skip posts that already have `bluesky_uri` set (idempotency).
 *   - Skip posts whose `date` is more than `MAX_AGE_MS` in the past
 *     so re-publishing a years-old post doesn't spray a stale link
 *     into Bluesky.
 *   - Compose + post the thread.
 *   - Write the resulting `bluesky_uri` back into the post's
 *     front-matter.
 *
 * Rate-limit: at most `MAX_PER_RUN` cross-posts per publish call.
 * Bulk publishes (typically 1, sometimes a handful) are fine; this
 * caps the blast radius if someone bulk-republishes 200 old drafts.
 *
 * The whole flow is best-effort — a failed Bluesky call is logged and
 * the post is left without a `bluesky_uri` (so the NEXT publish will
 * retry naturally once it's edited).
 */

import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

import { parsePost, serializePost } from '../utils/frontmatter.js';
import * as bluesky from './bluesky.js';
import { logActivity } from './activity.js';

const SITE_DIR_DEFAULT = '..';

// Defaults — actual values are resolved per-call from env so test
// overrides take effect without re-importing the module.
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_PER_RUN = 5;

function getMaxAgeMs() {
  const v = Number(process.env.BLUESKY_MAX_AGE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_AGE_MS;
}

function getMaxPerRun() {
  const v = Number(process.env.BLUESKY_MAX_PER_RUN);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PER_RUN;
}

/**
 * Cross-post the given list of changed post filenames to Bluesky.
 * Returns a report of what happened — never throws.
 *
 * @param {string[]} changedPosts — filenames under site/content/posts/
 * @param {{ siteDir?: string, baseUrl?: string }} [opts]
 * @returns {Promise<{ posted: { filename: string, uri: string }[], skipped: { filename: string, reason: string }[], errors: { filename: string, error: string }[] }>}
 */
export async function crossPostChangedPosts(changedPosts, opts = {}) {
  const report = { posted: [], skipped: [], errors: [] };
  if (!Array.isArray(changedPosts) || changedPosts.length === 0) {
    return report;
  }
  if (!bluesky.isConfigured()) {
    for (const f of changedPosts) report.skipped.push({ filename: f, reason: 'not_configured' });
    return report;
  }

  const siteDir = opts.siteDir || process.env.SITE_DIR || SITE_DIR_DEFAULT;
  const baseUrl = opts.baseUrl || process.env.PUBLIC_BASE_URL || 'https://terminaleighty.com';
  const postsDir = join(siteDir, 'content', 'posts');

  // Authenticate once for the whole batch.
  let agent;
  try {
    agent = await bluesky.signIn();
  } catch (err) {
    for (const f of changedPosts) {
      report.errors.push({ filename: f, error: `signin_failed: ${err.message}` });
    }
    logActivity({
      user: 'system',
      action: 'bluesky.signin_failed',
      meta: { error: err.message },
    });
    return report;
  }

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

    // Drafts → skip (matches `publish` semantics in posts.js).
    if (data.draft === true) {
      report.skipped.push({ filename, reason: 'draft' });
      continue;
    }
    // Already cross-posted → skip (idempotency).
    if (data.bluesky_uri) {
      report.skipped.push({ filename, reason: 'already_posted' });
      continue;
    }
    // Stale post → skip (don't re-spam Bluesky on a content refresh
    // of an old post).
    const postDate = parseDate(data.date);
    if (postDate && Date.now() - postDate > maxAgeMs) {
      report.skipped.push({ filename, reason: 'too_old' });
      continue;
    }

    const slug = String(data.slug || filename.replace(/\.md$/, ''));
    const url = `${baseUrl.replace(/\/+$/, '')}/${slug}/`;
    const title = String(data.title || slug);
    const excerpt = String(data.description || extractExcerpt(parsed.content || '', 280));
    const coverStr = data.cover !== null && data.cover !== undefined ? String(data.cover) : '';
    const coverImageUrl = coverStr
      ? coverStr.startsWith('http')
        ? coverStr
        : `${baseUrl.replace(/\/+$/, '')}${coverStr.startsWith('/') ? '' : '/'}${coverStr}`
      : null;

    try {
      const result = await bluesky.postThread(agent, {
        title,
        excerpt,
        url,
        coverImageUrl,
      });
      // Persist the URI back to the post's front-matter so this row
      // is now idempotent.
      data.bluesky_uri = result.rootUri;
      const serialized = serializePost(data, parsed.content || '');
      writeFileSync(fullPath, serialized, 'utf-8');
      report.posted.push({ filename, uri: result.rootUri });
      logActivity({
        user: 'system',
        action: 'bluesky.crosspost',
        target: slug,
        meta: { uri: result.rootUri, url },
      });
      posted++;
    } catch (err) {
      report.errors.push({ filename, error: err.message });
      logActivity({
        user: 'system',
        action: 'bluesky.crosspost_failed',
        target: slug,
        meta: { error: err.message },
      });
    }
  }

  return report;
}

/**
 * Best-effort excerpt extractor for posts that don't define a
 * `description` front-matter field. Strips fenced code, headings,
 * markdown links, then trims to `max` chars on a word boundary.
 *
 * @param {string} markdown
 * @param {number} max
 * @returns {string}
 */
export function extractExcerpt(markdown, max) {
  let s = String(markdown || '');
  // Drop fenced code blocks before extracting prose.
  s = s.replace(/```[\s\S]*?```/g, '');
  // Drop ATX headings (so excerpts don't lead with "# Title").
  s = s.replace(/^#{1,6}\s+.*$/gm, '');
  // Collapse links to their text: [foo](https://x) → foo
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip emphasis markers, but leave the words.
  s = s.replace(/[*_~`]/g, '');
  // Normalise whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max - 1);
  return (cut > max * 0.5 ? s.slice(0, cut) : s.slice(0, max - 1)).trim() + '…';
}

/**
 * Parse a front-matter date into a UTC millisecond timestamp. Accepts
 * ISO strings, Date objects, or anything `new Date()` understands.
 * Returns null when the date is missing or unparseable.
 *
 * @param {any} d
 * @returns {number | null}
 */
function parseDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  try {
    const t = new Date(String(d)).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export const __test = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_PER_RUN,
  getMaxAgeMs,
  getMaxPerRun,
  parseDate,
  extractExcerpt,
};

export default { crossPostChangedPosts, extractExcerpt };
