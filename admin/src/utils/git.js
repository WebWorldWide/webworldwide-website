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
import { statSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';

const getRepoPath = () => {
  const siteDir = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
  return join(siteDir, '..');
};

// Get repo path based on environment
const getGitInstance = () => {
  const repoPath = getRepoPath();
  // `timeout.block` kills a git child that produces no output for 30s, so a
  // stalled push (flaky Cloudflare Tunnel) can never hang the publish
  // request — and the event loop — indefinitely.
  //
  // `config: ['safe.directory=<repoPath>']` makes every command run with
  // `-c safe.directory=…`. In the cms container the image's WORKDIR (repo
  // root) is root-owned while `.git`/`site` are uid 1000 and we run as uid
  // 1000, so git otherwise aborts with "detected dubious ownership" and the
  // publish never commits. The Dockerfile also sets this via `--system`;
  // doing it here too keeps publish working regardless of the base image.
  const git = simpleGit(repoPath, {
    timeout: { block: 30_000 },
    config: [`safe.directory=${repoPath}`],
  });
  return git;
};

/**
 * Remove a stale `.git/index.lock`. A crashed/interrupted git process — e.g. the
 * CMS content auto-commit racing a manual "Publish site" — leaves the lock
 * behind, and every subsequent commit then fails with "Unable to create
 * '.git/index.lock': File exists." A real index operation holds the lock for
 * well under a second, so a lock older than five minutes is stale and safe to
 * clear. The shared operation lock below prevents our own processes from ever
 * reaching this cleanup while another managed Git operation is active.
 *
 * @param {string} repoPath
 */
function clearStaleLock(repoPath) {
  try {
    const lock = join(repoPath, '.git', 'index.lock');
    if (Date.now() - statSync(lock).mtimeMs > 5 * 60_000) unlinkSync(lock);
  } catch {
    /* no lock (statSync throws) or another cleaner won the race — both fine */
  }
}

/**
 * Acquire the same advisory lock used by the Pi's backup/deploy/cron scripts.
 * `flock` holds the lock while its child blocks on stdin; ending stdin releases
 * it. This keeps the whole multi-command Git transaction atomic across the
 * Express server, docker-exec scheduler processes, and host maintenance jobs.
 *
 * Windows development falls back to the in-process chain below. Production and
 * Linux CI have util-linux/flock explicitly installed.
 *
 * @param {string} repoPath
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireOperationLock(repoPath) {
  if (process.env.WWWIDE_OPERATION_LOCK_HELD === '1' || process.platform === 'win32') {
    return async () => {};
  }

  const configuredMs = Number(process.env.WWWIDE_OPERATION_LOCK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : 60_000;
  const timeoutSeconds = (timeoutMs / 1000).toFixed(3);
  const lockPath =
    process.env.WWWIDE_OPERATION_LOCK_FILE || join(repoPath, '.git', 'wwwide-operation.lock');
  const child = spawn(
    'flock',
    ['-x', '-w', timeoutSeconds, lockPath, 'sh', '-c', 'printf "LOCKED\\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    child.once('error', (err) => {
      fail(`Could not start the CMS operation lock: ${err.message}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('exit', (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal ?? 'unknown'}`;
        fail(`Another CMS backup, deploy, or publish operation is active (${detail}).`);
      }
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (settled || !stdout.includes('LOCKED\n')) return;
      settled = true;
      resolve(async () => {
        if (child.exitCode !== null) return;
        child.stdin.end();
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            resolve();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      });
    });
  });
}

// Serialize index-mutating Git operations both within this process and across
// the host/container boundary.
let gitChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withGitLock(fn) {
  const runLocked = async () => {
    const release = await acquireOperationLock(getRepoPath());
    try {
      // Only remove a crashed process's leftover index lock while we own the
      // cross-process operation lock. Read-only history/status requests never
      // need to touch it and must not race a long host backup or deployment.
      clearStaleLock(getRepoPath());
      return await fn();
    } finally {
      await release();
    }
  };
  const run = gitChain.then(runLocked, runLocked);
  // Keep the chain alive even if fn rejects — never poison later ops.
  gitChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Push HEAD to origin/main, retrying a few times to ride out a transient
 * tunnel/network blip (the realistic failure on the Pi). We deliberately
 * do NOT `pull --rebase` on failure: the cms container's worktree is
 * permanently "dirty" (admin/ etc. read as deleted — see SITE_PATHSPEC),
 * so a rebase would abort. A genuine non-fast-forward (someone else
 * pushed) is essentially impossible for this repo; if it ever happens the
 * push keeps failing and we throw a clear error, leaving the commit local
 * for `reconcileUnpushed` to retry on the next publish.
 *
 * @param {import('simple-git').SimpleGit} git
 * @param {number} attempts
 */
async function pushMain(git, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await git.push('origin', 'main');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[git] push attempt ${i + 1}/${attempts} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

/**
 * Count commits on local `main` that origin/main doesn't have yet. A failed
 * push leaves the commit local AND leaves the local `origin/main` ref stale,
 * so `origin/main..main` reveals it WITHOUT a network round-trip — and
 * `rev-list` ignores worktree state, so the container's dirty layout can't
 * break it. Returns 0 on any error (never block a publish on this).
 *
 * We deliberately range over `main`, NOT `HEAD`: pushMain runs
 * `git push origin main`, which moves the local `main` ref. If HEAD is ever
 * on another branch (e.g. a shared bind-mounted .git checked out elsewhere),
 * `origin/main..HEAD` would count unrelated commits and trigger a no-op push
 * that falsely reports success. `main` matches exactly what the push moves.
 *
 * @param {import('simple-git').SimpleGit} git
 * @returns {Promise<number>}
 */
async function countUnpushedCommits(git) {
  try {
    const out = await git.raw(['rev-list', '--count', 'origin/main..main']);
    return Number(String(out).trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * The publish flow may run inside the cms container, where the repo
 * worktree (/app) does NOT mirror the real repo layout — only `site/`
 * and `.git` are mounted; everything else (admin/, docker/, scripts/,
 * .github/) is absent and the container's own files (server.js, src/,
 * node_modules/, …) are untracked strays. A bare `git add .` from there
 * would stage the deletion of most of the repo and push it. Every git
 * operation here is therefore scoped to the `site/` pathspec, and
 * emptiness is computed from the STAGED set (`diff --cached`), never
 * from working-tree cleanliness (which is permanently "dirty" in the
 * container).
 */
const SITE_PATHSPEC = 'site';

/**
 * Re-base the local `main` ref + git index onto the freshest `origin/main`
 * WITHOUT touching the (permanently-dirty) container worktree, so the commit
 * we're about to make is always a fast-forward of origin — the push can never
 * be rejected as "non-fast-forward" just because a code deploy pushed to main
 * between publishes. This is the durable fix for "push rejected: branch moved
 * on".
 *
 * How it stays safe with a dirty worktree: `update-ref` moves the branch
 * pointer and `read-tree` resets the index to origin/main's tree — neither
 * checks out files, so the container's missing admin/ etc. are irrelevant.
 * The caller then runs `git add -A site`, which re-applies the on-disk site/
 * content (adds/edits/deletions) on top. Any site/ edits a prior failed
 * publish left in orphaned local commits are still on disk, so they're
 * recaptured — nothing is lost.
 *
 * Returns false (caller commits on current HEAD) when origin/main can't be
 * seen (offline / first run) or HEAD isn't `main`.
 *
 * @param {import('simple-git').SimpleGit} git
 * @returns {Promise<boolean>}
 */
async function alignToOriginMain(git) {
  let originSha;
  try {
    await git.fetch('origin', 'main');
    originSha = (await git.revparse(['origin/main'])).trim();
  } catch (err) {
    console.warn('[git] could not fetch origin/main — publishing on local state:', err.message);
    return false;
  }
  if (!originSha) return false;
  let branch;
  try {
    branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return false;
  }
  if (branch !== 'main') {
    console.warn(`[git] HEAD is "${branch}", not main — skipping origin realign.`);
    return false;
  }
  // Move main → origin/main and reset the index to match; worktree untouched.
  await git.raw(['update-ref', 'refs/heads/main', originSha]);
  await git.raw(['read-tree', originSha]);
  return true;
}

/**
 * Stage site/ changes, commit, and push.
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
  return withGitLock(publishChangesImpl);
}

/** @returns {Promise<{ success: true, message: string, changed: boolean, changedPosts?: string[], commitHash?: string }>} */
async function publishChangesImpl() {
  const git = getGitInstance();
  try {
    console.log('Publishing changes...');
    // Commit on top of the freshest origin/main so the push is always a
    // fast-forward — prevents "branch moved on" when a code deploy landed on
    // main since the last publish.
    await alignToOriginMain(git);
    // `-A` so deletions (a removed post) are staged too, not just edits/adds.
    await git.raw(['add', '-A', SITE_PATHSPEC]);

    // Snapshot the staged set BEFORE we run git commit — afterwards the
    // cached diff would be empty and we'd lose the per-file list that
    // the cross-post hook needs.
    const stagedDiff = await git.diff(['--cached', '--name-status']);
    const hasStaged = Boolean(stagedDiff.trim());

    if (hasStaged) {
      const commitMsg = `Update blog content: ${new Date().toISOString()}`;
      await git.commit(commitMsg);
    } else {
      // Nothing new to commit — but a PREVIOUS publish may have committed
      // and then failed to push (transient tunnel error), orphaning the
      // commit locally. Detect and push it so it isn't stranded forever.
      const unpushed = await countUnpushedCommits(git);
      if (unpushed === 0) {
        return { success: true, message: 'Nothing to commit. Site is up to date.', changed: false };
      }
      console.log(`[git] ${unpushed} unpushed commit(s) from a prior publish — pushing now.`);
    }

    const changedPosts = hasStaged ? extractChangedPostsFromDiff(stagedDiff) : [];

    await pushMain(git);

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
    throw new Error(`Failed to publish: ${err.message}`, { cause: err });
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
  return withGitLock(() => commitAndPushImpl(message));
}

async function commitAndPushImpl(message) {
  const git = getGitInstance();
  try {
    await alignToOriginMain(git);
    await git.raw(['add', '-A', SITE_PATHSPEC]);
    const stagedDiff = await git.diff(['--cached', '--name-status']);
    if (!stagedDiff.trim()) {
      return { success: true, message: 'nothing to commit' };
    }
    await git.commit(message);
    await pushMain(git);
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

/**
 * Same as extractChangedPosts but reads the staged set from
 * `git diff --cached --name-status` output. Lines look like:
 *   M\tsite/content/posts/foo.md
 *   A\tsite/content/posts/bar.md
 *   R100\tsite/content/posts/old.md\tsite/content/posts/new.md
 * Adds + modifies + rename targets count; deletes are ignored —
 * we never cross-post a removal.
 *
 * Exported for unit-test reuse.
 *
 * @param {string} diffText
 * @returns {string[]} filenames (basename only, e.g. `my-post.md`)
 */
export function extractChangedPostsFromDiff(diffText) {
  const POSTS_PREFIX = 'site/content/posts/';
  const set = new Set();
  for (const line of String(diffText || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] || '';
    if (code.startsWith('D')) continue;
    // Renames carry two paths; the target is the last column.
    const path = parts[parts.length - 1];
    if (typeof path !== 'string') continue;
    if (!path.startsWith(POSTS_PREFIX) || !path.endsWith('.md')) continue;
    set.add(path.slice(POSTS_PREFIX.length));
  }
  return [...set];
}

const POSTS_PATH_PREFIX = 'site/content/posts/';

/**
 * Commit history for a single post, newest first — the published-versions
 * half of the editor's revision history. Returns [] on any error (e.g. a
 * post never committed) so the UI degrades gracefully.
 *
 * @param {string} filename e.g. `my-post.md`
 * @param {number} [maxCount]
 * @returns {Promise<Array<{ hash: string, date: string, message: string, author: string }>>}
 */
export async function getPostHistory(filename, maxCount = 50) {
  const safe = String(filename || '');
  if (!safe || safe.includes('/') || safe.includes('..')) return [];
  const git = getGitInstance();
  try {
    const log = await git.log({ file: POSTS_PATH_PREFIX + safe, maxCount });
    return log.all.map((c) => ({
      hash: c.hash,
      date: c.date,
      message: c.message,
      author: c.author_name,
    }));
  } catch (err) {
    console.warn('[git] post history failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * The raw content of a post as of a specific commit — for previewing or
 * restoring a published version. The hash is validated as hex so it can
 * never inject extra git args. Returns null on any error.
 *
 * @param {string} filename e.g. `my-post.md`
 * @param {string} hash a commit SHA (7–40 hex chars)
 * @returns {Promise<string | null>}
 */
export async function getPostAtCommit(filename, hash) {
  const safe = String(filename || '');
  if (!safe || safe.includes('/') || safe.includes('..')) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(String(hash))) return null;
  const git = getGitInstance();
  try {
    return await git.show([`${hash}:${POSTS_PATH_PREFIX}${safe}`]);
  } catch {
    return null;
  }
}

/**
 * Commit history for an arbitrary repo-relative file, newest first — the
 * generic counterpart to getPostHistory for non-post files (e.g. the
 * homepage's `site/site.toml`). Returns the SAME per-commit shape as
 * getPostHistory. `relPath` is a TRUSTED server constant, not user input,
 * so there is no traversal guard. Returns [] on any error (e.g. a file
 * never committed) so the UI degrades gracefully.
 *
 * @param {string} relPath repo-relative path, e.g. `site/site.toml`
 * @param {number} [maxCount]
 * @returns {Promise<Array<{ hash: string, date: string, message: string, author: string }>>}
 */
export async function getFileHistory(relPath, maxCount = 50) {
  const git = getGitInstance();
  try {
    const log = await git.log({ file: relPath, maxCount });
    return log.all.map((c) => ({
      hash: c.hash,
      date: c.date,
      message: c.message,
      author: c.author_name,
    }));
  } catch (err) {
    console.warn('[git] file history failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * The raw content of an arbitrary repo-relative file as of a specific
 * commit — the generic counterpart to getPostAtCommit. The hash is
 * validated as hex so it can never inject extra git args; `relPath` is a
 * trusted server constant (no user path traversal). Returns null on any
 * error.
 *
 * @param {string} relPath repo-relative path, e.g. `site/site.toml`
 * @param {string} hash a commit SHA (7–40 hex chars)
 * @returns {Promise<string | null>}
 */
export async function getFileAtCommit(relPath, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(hash))) return null;
  const git = getGitInstance();
  try {
    return await git.show([`${hash}:${relPath}`]);
  } catch {
    return null;
  }
}

export async function getGitStatus() {
  const git = getGitInstance();
  try {
    // Scope to site/ — in the container the rest of the worktree is
    // permanently "dirty" (see SITE_PATHSPEC note above).
    const status = await git.status(['--', SITE_PATHSPEC]);
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
