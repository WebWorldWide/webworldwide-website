// @ts-check
/**
 * scheduler.js — Phase 5e scheduled-publish promoter.
 *
 * Cron entry-point (invoked by scripts/promote-scheduled.sh every 5
 * minutes on the Pi). Walks `site/content/posts/*.md`, finds rows
 * where `draft: true` AND `publish_at <= now()`, flips `draft: false`,
 * writes the file, and (optionally) commits + pushes via the git
 * helper so Hugo's next build picks them up.
 *
 * Designed to be safe to run repeatedly:
 *   - idempotent: a post that's already published (draft: false) is
 *     ignored regardless of its publish_at value
 *   - per-file: a parse error on one file logs + continues; the rest
 *     still get promoted
 *   - dry-run mode: `--dry-run` lists what would change without
 *     touching disk
 *
 * Exit codes:
 *   0  success (promoted ≥0 posts cleanly)
 *   1  fatal error (couldn't read content dir, e.g. site missing)
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parsePost, serializePost } from '../utils/frontmatter.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { logActivity } from './activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run one promotion pass. Returns the list of promoted filenames.
 *
 * @param {{ siteDir?: string, dryRun?: boolean, now?: number, commit?: (filenames: string[]) => Promise<void> }} [opts]
 * @returns {Promise<{ promoted: string[], errors: { filename: string, error: string }[], dryRun: boolean }>}
 */
export async function promoteScheduledPosts(opts = {}) {
  const now = opts.now || Date.now();
  const siteDir = opts.siteDir || process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');
  const postsDir = join(siteDir, 'content', 'posts');
  if (!existsSync(postsDir)) {
    throw new Error(`posts directory not found: ${postsDir}`);
  }

  /** @type {string[]} */ const promoted = [];
  /** @type {{ filename: string, error: string }[]} */ const errors = [];

  const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const filePath = join(postsDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { data, content } = parsePost(raw);
      if (data.draft !== true) continue;
      if (!data.publish_at) continue;
      const ts = new Date(/** @type {string} */ (data.publish_at)).getTime();
      if (Number.isNaN(ts)) {
        errors.push({ filename: file, error: 'invalid publish_at' });
        continue;
      }
      if (ts > now) continue; // not yet

      data.draft = false;
      // Keep publish_at as a historical record — Hugo ignores it; the
      // admin UI uses it to render "published on X" badges.
      const serialized = serializePost(data, content || '');
      if (!opts.dryRun) {
        // No-op guard: only write when the serialized output actually
        // differs, so we never churn the file (or leave a spurious diff in
        // the deploy's git tree) when nothing logically changed.
        if (serialized !== raw) {
          // Atomic temp+fsync+rename — a power-loss mid-promotion on the Pi
          // must never leave a half-written post (the whole reason the rest
          // of the CMS writes through this helper).
          writeFileAtomic(filePath, serialized);
        }
      }
      promoted.push(file);
    } catch (err) {
      errors.push({ filename: file, error: err.message || String(err) });
    }
  }

  if (promoted.length && !opts.dryRun) {
    logActivity({
      user: 'system',
      action: 'scheduler.promote',
      target: null,
      meta: { count: promoted.length, filenames: promoted },
    });
    if (opts.commit) {
      try {
        await opts.commit(promoted);
      } catch (err) {
        errors.push({ filename: '(git)', error: err.message || String(err) });
      }
    }
  }

  return { promoted, errors, dryRun: Boolean(opts.dryRun) };
}

/**
 * Default committer: stages the promoted post files, makes a commit
 * with a descriptive message, and pushes to origin. Imported lazily so
 * test runs that don't want a real git operation can pass a no-op
 * `commit` instead.
 *
 * @param {string[]} filenames
 */
export async function defaultCommit(filenames) {
  if (!filenames.length) return;
  // Reuse the hardened publish path instead of a bare add/commit/push. A bare
  // push is rejected as non-fast-forward whenever a code deploy or a normal
  // publish lands on origin/main between 5-min cron ticks — and because the
  // promoted post is now draft:false on disk, the next idempotent run commits
  // nothing, so the stranded commit was never retried and the scheduled post
  // silently never reached the live site. publishChanges() realigns onto the
  // freshest origin/main (so the push is always a fast-forward), pushes with
  // retry, and recaptures the on-disk promotion via `git add -A site` — so a
  // transiently-failed push self-heals on the next promotion. getGitInstance()
  // resolves the same repo (SITE_DIR/..) the scheduler targets.
  // publishChanges() resolves on success and throws on a failed push (after
  // retries) — that throw propagates to promoteScheduledPosts' commit try/catch,
  // which records it as a (git) error for the run.
  const { publishChanges } = await import('../utils/git.js');
  const result = await publishChanges();

  // Bluesky cross-post — best-effort; mirrors the manual /publish route. Without
  // it a SCHEDULED post goes live but is never syndicated to Bluesky (the manual
  // route does crossPostChangedPosts; the scheduler historically did not, and as
  // a host cron it lacked the BLUESKY_* env anyway). Now that promote-scheduled.sh
  // runs this INSIDE the cms container, isConfigured() can be true here. Wrapped
  // so a syndication hiccup NEVER fails the promotion.
  try {
    const bluesky = await import('./bluesky.js');
    if (
      result?.changed &&
      Array.isArray(result.changedPosts) &&
      result.changedPosts.length > 0 &&
      bluesky.isConfigured()
    ) {
      const { crossPostChangedPosts } = await import('./bluesky-crosspost.js');
      const report = await crossPostChangedPosts(result.changedPosts);
      if (report.posted.length > 0) {
        // Persist the bluesky_uri values written back into front-matter.
        const { commitAndPush } = await import('../utils/git.js');
        await commitAndPush(
          `Update Bluesky URIs (${report.posted.length} post${report.posted.length === 1 ? '' : 's'})`,
        );
      }
    }
  } catch (err) {
    console.warn(
      '[scheduler] Bluesky cross-post skipped:',
      err instanceof Error ? err.message : err,
    );
  }

  // Mastodon cross-post — same best-effort contract as Bluesky above.
  try {
    const mastodon = await import('./mastodon.js');
    if (
      result?.changed &&
      Array.isArray(result.changedPosts) &&
      result.changedPosts.length > 0 &&
      mastodon.isConfigured()
    ) {
      const { crossPostChangedPosts } = await import('./mastodon-crosspost.js');
      const report = await crossPostChangedPosts(result.changedPosts);
      if (report.posted.length > 0) {
        const { commitAndPush } = await import('../utils/git.js');
        await commitAndPush(
          `Update Mastodon URIs (${report.posted.length} post${report.posted.length === 1 ? '' : 's'})`,
        );
      }
    }
  } catch (err) {
    console.warn(
      '[scheduler] Mastodon cross-post skipped:',
      err instanceof Error ? err.message : err,
    );
  }
}

// CLI shim: `node admin/src/services/scheduler.js [--dry-run] [--no-commit]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const noCommit = process.argv.includes('--no-commit') || dryRun;
  (async () => {
    try {
      const result = await promoteScheduledPosts({
        dryRun,
        commit: noCommit ? undefined : defaultCommit,
      });
      const tag = dryRun ? '[scheduler:dry-run]' : '[scheduler]';
      console.log(`${tag} promoted=${result.promoted.length} errors=${result.errors.length}`);
      if (result.promoted.length) {
        console.log(`${tag} files: ${result.promoted.join(', ')}`);
      }
      for (const e of result.errors) {
        console.warn(`${tag} ERROR ${e.filename}: ${e.error}`);
      }
      process.exit(0);
    } catch (err) {
      console.error('[scheduler] fatal:', err.message || err);
      process.exit(1);
    }
  })();
}
