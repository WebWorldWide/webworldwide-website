// @ts-check
/**
 * git.js — small wrapper around simple-git for the publish flow.
 *
 * Phase 9 extends `publishChanges()` to surface the list of
 * `site/content/posts/*.md` files that were committed, so the publish
 * route can hand them to the Bluesky cross-post hook without
 * re-running the diff. We deliberately capture this from the status
 * snapshot taken BEFORE the commit (post-commit diff is empty); the
 * pre-commit status is the working-tree set we just added.
 */

import simpleGit from 'simple-git';
import { join } from 'path';

// Get repo path based on environment
const getGitInstance = () => {
  const siteDir = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
  const repoPath = join(siteDir, '..');
  const git = simpleGit(repoPath);
  return git;
};

/**
 * Stage every working-tree change, commit, and push.
 *
 * Returns:
 *   {
 *     success: true,
 *     message: string,
 *     changed: false,                 // when nothing to commit
 *     // OR
 *     changed: true,
 *     changedPosts: string[],         // filenames under site/content/posts/
 *     commitHash: string,             // SHA of the new commit
 *   }
 *
 * @returns {Promise<{ success: true, message: string, changed: boolean, changedPosts?: string[], commitHash?: string }>}
 */
export async function publishChanges() {
  const git = getGitInstance();
  try {
    console.log('Publishing changes...');
    await git.add('.');

    // Take a snapshot of what's about to be committed BEFORE we run
    // git commit — afterwards `status` would be clean and we'd lose
    // the per-file list that the cross-post hook needs.
    const status = await git.status();
    if (status.isClean()) {
      return { success: true, message: 'Nothing to commit. Site is up to date.', changed: false };
    }

    const changedPosts = extractChangedPosts(status);

    const commitMsg = `Update blog content: ${new Date().toISOString()}`;
    await git.commit(commitMsg);
    await git.push('origin', 'main');

    // Hash of the commit we just made — useful for the activity log
    // entry the publish route writes.
    let commitHash = '';
    try {
      const head = await git.log({ maxCount: 1 });
      commitHash = head.latest?.hash || '';
    } catch (_) {
      /* non-fatal */
    }

    return {
      success: true,
      message: 'Changes pushed successfully. Site is building.',
      changed: true,
      changedPosts,
      commitHash,
    };
  } catch (err) {
    console.error('Git publish error:', err);
    throw new Error(`Failed to publish: ${err.message}`);
  }
}

/**
 * Stage + commit + push an in-flight set of changes that we made
 * AFTER the main publish (e.g. front-matter updates from the Bluesky
 * cross-post hook). Returns the same shape as `publishChanges` minus
 * the changedPosts list (irrelevant on the follow-up commit).
 *
 * @param {string} message
 * @returns {Promise<{ success: boolean, message: string, commitHash?: string }>}
 */
export async function commitAndPush(message) {
  const git = getGitInstance();
  try {
    await git.add('.');
    const status = await git.status();
    if (status.isClean()) {
      return { success: true, message: 'nothing to commit' };
    }
    await git.commit(message);
    await git.push('origin', 'main');
    let commitHash = '';
    try {
      const head = await git.log({ maxCount: 1 });
      commitHash = head.latest?.hash || '';
    } catch (_) {
      /* non-fatal */
    }
    return { success: true, message: 'pushed', commitHash };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Pull the list of changed post filenames out of a simple-git status
 * snapshot. Created + modified + renamed all count; deletes are
 * deliberately ignored — we never cross-post a removal.
 *
 * Exported for unit-test reuse.
 *
 * @param {import('simple-git').StatusResult} status
 * @returns {string[]} filenames (basename only, e.g. `my-post.md`)
 */
export function extractChangedPosts(status) {
  const POSTS_PREFIX = 'site/content/posts/';
  const set = new Set();
  const add = (path) => {
    if (typeof path !== 'string') return;
    if (!path.startsWith(POSTS_PREFIX)) return;
    if (!path.endsWith('.md')) return;
    set.add(path.slice(POSTS_PREFIX.length));
  };
  for (const f of status.created || []) add(f);
  for (const f of status.modified || []) add(f);
  for (const f of status.not_added || []) add(f);
  // Renames are objects { from, to } — we only care about the `to`.
  for (const r of status.renamed || []) add(r?.to);
  return [...set];
}

export async function getGitStatus() {
  const git = getGitInstance();
  try {
    const status = await git.status();
    const lastCommit = await git.log({ maxCount: 1 });
    return {
      clean: status.isClean(),
      modified: status.modified,
      created: status.created,
      deleted: status.deleted,
      lastCommit: lastCommit.latest
        ? {
            hash: lastCommit.latest.hash,
            date: lastCommit.latest.date,
            message: lastCommit.latest.message,
          }
        : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}
