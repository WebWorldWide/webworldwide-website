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

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parsePost, serializePost } from '../utils/frontmatter.js';
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
      if (!opts.dryRun) {
        writeFileSync(filePath, serializePost(data, content || ''));
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
  const { default: simpleGit } = await import('simple-git');
  const siteDir = process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');
  const repoRoot = join(siteDir, '..');
  const git = simpleGit(repoRoot);
  await git.add(filenames.map((f) => `site/content/posts/${f}`));
  await git.commit(
    `Auto-publish ${filenames.length} scheduled post${filenames.length === 1 ? '' : 's'}`,
  );
  // Push is optional — failures shouldn't block local-only flows.
  try {
    await git.push('origin', 'main');
  } catch (err) {
    console.warn('[scheduler] git push failed (continuing):', err.message);
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
