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

import { simpleGit } from 'simple-git';
import { join, dirname } from 'path';
import { statSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { randomBytes } from 'crypto';

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

  return new Promise<() => Promise<void>>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    child.once('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // macOS and some minimal development environments do not ship
        // util-linux/flock. The in-process promise chain still serializes CMS
        // writes there; production images explicitly install util-linux.
        if (settled) return;
        settled = true;
        resolve(async () => {});
        return;
      }
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
        await new Promise<void>((resolve) => {
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
    const release: () => Promise<void> = await acquireOperationLock(getRepoPath());
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
 * The publish flow may run inside the cms container, where the repo
 * worktree (/app) does NOT mirror the real repo layout — only `site/`
 * and `.git` are mounted; everything else (admin/, docker/, scripts/,
 * .github/) is absent and the container's own files (server.js, src/,
 * node_modules/, …) are untracked strays. Every git operation here is
 * therefore scoped to the `site/` pathspec.
 */
const SITE_PATHSPEC = 'site';
const ORIGIN_MAIN_REF = 'refs/remotes/origin/main';
/**
 * The last commit this CMS published. After a publish the on-disk site/ equals
 * this commit's site/, but HEAD only catches up when the host's auto-update
 * syncs (≤5 min). Using it as the merge base avoids spurious conflicts when a
 * just-published file is edited again before that sync.
 */
const LAST_PUBLISH_REF = 'refs/wwwide/last-publish';

/**
 * Paths that must never be published, whatever the ignore rules say. The
 * container mounts only `site/` + `.git`, so the repo-root .gitignore is not
 * visible there; `site/.gitignore` covers these, and this list is the last
 * line of defence (a 2026-10 publish committed 26k `site/node_modules` files).
 */
const FORBIDDEN_PUBLISH_PATH =
  /^site\/(?:node_modules|dist|\.astro|\.vite|\.legacy|\.media-staging)(?:\/|$)/;

/** A publish failure the route can classify into a user-facing message. */
export class PublishError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Run a git plumbing command and return its exit code + output. simple-git's
 * `raw()` RESOLVES on a non-zero exit when stderr is empty, which silently
 * turns `merge-base --is-ancestor` → always true and a conflicted
 * `merge-tree` → success. Plumbing therefore goes through execFile directly.
 *
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, allowCodes?: number[], encoding?: 'utf8' | 'buffer' }} [opts]
 * @returns {Promise<{ code: number, stdout: any, stderr: string }>}
 */
interface GitExecOpts {
  env?: NodeJS.ProcessEnv;
  allowCodes?: number[];
  encoding?: 'utf8' | 'buffer';
}
interface GitExecResult {
  code: number;
  stdout: any;
  stderr: string;
}
function gitExec(args: string[], opts: GitExecOpts = {}): Promise<GitExecResult> {
  const repo = getRepoPath();
  const allow = opts.allowCodes || [0];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', `safe.directory=${repo}`, ...args],
      {
        cwd: repo,
        env: opts.env || process.env,
        encoding: opts.encoding === 'buffer' ? 'buffer' : 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
        if (!allow.includes(code)) {
          const e = new Error(
            `git ${args[0]} failed (exit ${code}): ${String(stderr || err?.message || '').trim()}`,
          );
          (e as any).stdout = stdout;
          return reject(e);
        }
        resolve({ code, stdout, stderr: String(stderr || '') });
      },
    );
  });
}

const out = async (args: string[], opts?: GitExecOpts): Promise<string> =>
  String((await gitExec(args, opts)).stdout).trim();

/** Absolute path of the git dir (works for normal repos and linked worktrees). */
async function gitDir() {
  return out(['rev-parse', '--absolute-git-dir']);
}

/**
 * Run `fn` with a throwaway index file so the shared repo index (also used by
 * the host checkout) is never touched by a publish.
 *
 * @template T
 * @param {(env: NodeJS.ProcessEnv) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await gitDir();
  const indexFile = join(
    dir,
    `wwwide-publish-${process.pid}-${randomBytes(4).toString('hex')}.index`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    return await fn(env);
  } finally {
    try {
      unlinkSync(indexFile);
    } catch {
      /* never created */
    }
  }
}

/** Fetch origin/main and return its SHA. Throws PublishError on failure. */
async function fetchOriginMain(git) {
  try {
    await git.fetch('origin', `+refs/heads/main:${ORIGIN_MAIN_REF}`);
  } catch (err) {
    throw new PublishError('network_error', `Could not fetch origin/main: ${err.message}`, err);
  }
  return out(['rev-parse', '--verify', ORIGIN_MAIN_REF]);
}

/** SHA of HEAD, or '' on an unborn branch. */
async function headSha() {
  const r = await gitExec(['rev-parse', '--verify', '-q', 'HEAD'], { allowCodes: [0, 1] });
  return r.code === 0 ? String(r.stdout).trim() : '';
}

async function treeOf(rev) {
  return out(['rev-parse', '--verify', `${rev}^{tree}`]);
}

async function isAncestor(a, b) {
  const r = await gitExec(['merge-base', '--is-ancestor', a, b], { allowCodes: [0, 1] });
  return r.code === 0;
}

/** `git diff-tree --name-status` between two tree-ish values, parsed. */
async function diffTrees(a: string, b: string): Promise<Array<{ status: string; path: string }>> {
  const text = await out(['diff-tree', '-r', '--no-renames', '--name-status', a, b]);
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    });
}

/**
 * Build the tree for "HEAD, with site/ replaced by what is on disk". When
 * `paths` is given, only those repo-relative paths are captured from disk —
 * the scheduler uses this so a timed promotion never ships unrelated,
 * saved-but-unpublished edits.
 *
 * @param {string} base commit the on-disk site/ was last synced to (HEAD)
 * @param {string[] | null} paths
 */
async function snapshotDiskTree(base: string, paths: string[] | null): Promise<string> {
  return withTempIndex(async (env) => {
    await gitExec(base ? ['read-tree', base] : ['read-tree', '--empty'], { env });
    const spec = paths && paths.length ? paths : [SITE_PATHSPEC];
    await gitExec(['add', '-A', '--', ...spec], { env });
    return out(['write-tree'], { env });
  });
}

/**
 * 3-way merge "HEAD + on-disk site/" with origin/main. Returns the merged tree
 * plus the snapshot tree it was built from. Throws PublishError on conflict.
 *
 * @param {string} origin
 * @param {string[] | null} paths
 */
async function computePublishTree(
  origin: string,
  paths: string[] | null,
): Promise<{ oursTree: string; mergedTree: string }> {
  const head = await headSha();
  const lp = await gitExec(['rev-parse', '--verify', '-q', `${LAST_PUBLISH_REF}^{commit}`], {
    allowCodes: [0, 1],
  });
  const lastPublish = lp.code === 0 ? String(lp.stdout).trim() : '';
  // Which commit does the on-disk site/ derive from?
  //  - HEAD behind the last publish (host hasn't synced yet) → the last publish
  //  - HEAD at/after the last publish (host synced, or local commits on top)
  //    → HEAD; any local code commits then show up and are refused below
  //  - HEAD diverged from the last publish (left on another branch, or a
  //    stranded local commit) → ambiguous; refuse rather than guess, because a
  //    wrong base silently reverts or duplicates edits.
  let base = head;
  if (lastPublish && head && lastPublish !== head) {
    if (await isAncestor(head, lastPublish)) base = lastPublish;
    else if (!(await isAncestor(lastPublish, head))) {
      throw new PublishError(
        'checkout_diverged',
        `The server checkout (HEAD ${head.slice(0, 12)}) has diverged from the last published commit ${lastPublish.slice(0, 12)}.`,
      );
    }
  } else if (lastPublish && !head) {
    base = lastPublish;
  }
  const oursTree = await snapshotDiskTree(base, paths);
  if (base && oursTree === (await treeOf(base)) && (await isAncestor(base, origin))) {
    return { oursTree, mergedTree: await treeOf(origin) };
  }
  const ours = await out([
    'commit-tree',
    oursTree,
    ...(base ? ['-p', base] : []),
    '-m',
    'cms snapshot',
  ]);
  const r = await gitExec(['merge-tree', '--write-tree', '--name-only', origin, ours], {
    allowCodes: [0, 1],
  });
  const lines = String(r.stdout).split('\n');
  if (r.code === 1) {
    const conflicted = lines
      .slice(1)
      .filter((l) => l && !/^\s/.test(l) && !/^Auto-merging|^CONFLICT/.test(l));
    throw new PublishError(
      'merge_conflict',
      `Your changes conflict with newer changes on GitHub in: ${[...new Set(conflicted)].slice(0, 10).join(', ') || 'unknown files'}`,
    );
  }
  return { oursTree, mergedTree: lines[0].trim() };
}

/**
 * After publishing a merge that pulled in upstream site/ changes the disk did
 * not have (e.g. an edit pushed from a laptop), write those files to disk so
 * the host checkout's next fast-forward sees a consistent worktree. A file is
 * only overwritten if it still holds exactly what we snapshotted — an edit the
 * author made during the publish is never clobbered.
 *
 * @param {string} oursTree tree we snapshotted from disk
 * @param {string} publishedCommit commit that reached origin
 */
async function syncUpstreamSiteChangesToDisk(oursTree, publishedCommit) {
  const repo = getRepoPath();
  const changes = (await diffTrees(oursTree, `${publishedCommit}^{tree}`)).filter((c) =>
    c.path.startsWith(`${SITE_PATHSPEC}/`),
  );
  for (const { status, path } of changes) {
    const abs = join(repo, path);
    const diskBlob = existsSync(abs) ? await out(['hash-object', '--', abs]) : null;
    const o = await gitExec(['rev-parse', '--verify', '-q', `${oursTree}:${path}`], {
      allowCodes: [0, 1],
    });
    const oursBlob = o.code === 0 ? String(o.stdout).trim() : null;
    if (diskBlob !== oursBlob) {
      console.warn(`[git] ${path} changed during publish — leaving the newer on-disk copy.`);
      continue;
    }
    if (status === 'D') {
      try {
        unlinkSync(abs);
      } catch {
        /* already gone */
      }
      continue;
    }
    const { stdout: content } = await gitExec(['cat-file', 'blob', `${publishedCommit}:${path}`], {
      encoding: 'buffer',
    });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Push `sha` to origin main; returns 'ok' | 'rejected'. Other failures throw. */
async function pushCommit(git, sha) {
  let lastErr;
  for (let i = 0; i < 3; i += 1) {
    try {
      await git.push('origin', `${sha}:refs/heads/main`);
      return 'ok';
    } catch (err) {
      lastErr = err;
      const m = String(err.message || '').toLowerCase();
      if (m.includes('non-fast-forward') || m.includes('fetch first') || m.includes('rejected')) {
        return 'rejected';
      }
      console.warn(`[git] push attempt ${i + 1}/3 failed: ${err.message}`);
    }
  }
  throw lastErr;
}

/** Confirm origin's main really is `sha` (guards against silent push no-ops). */
async function verifyRemoteMain(git, sha) {
  const listing = String(await git.raw(['ls-remote', 'origin', 'refs/heads/main']));
  const remote = listing.split(/\s+/)[0] || '';
  if (remote !== sha) {
    throw new PublishError(
      'push_unverified',
      `Push reported success but origin/main is ${remote.slice(0, 12) || 'unknown'}, not ${sha.slice(0, 12)}.`,
    );
  }
  await gitExec(['update-ref', ORIGIN_MAIN_REF, sha]);
  await gitExec(['update-ref', LAST_PUBLISH_REF, sha]);
}

/**
 * Core publish transaction. Branch-independent: it never reads or moves the
 * checked-out branch, the shared index, or local `main` — so a production
 * checkout left on a feature branch can no longer swallow publishes.
 *
 *  1. fetch origin/main (the only thing we ever publish onto)
 *  2. snapshot "HEAD + on-disk site/" into a temp index → `ours`
 *  3. 3-way merge `ours` with origin/main (`git merge-tree --write-tree`), so
 *     upstream edits the disk never pulled (code deploys, laptop edits) are
 *     preserved instead of silently reverted
 *  4. commit the merged tree on top of origin/main, push `<sha>:main`, and
 *     verify with ls-remote that origin really is at that SHA
 *
 * @param {string} message
 * @param {{ paths?: string[] | null }} [opts]
 */
async function publishImpl(message: string, opts: { paths?: string[] | null } = {}) {
  const git = getGitInstance();
  const paths = opts.paths && opts.paths.length ? opts.paths : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const origin = await fetchOriginMain(git);
    const { oursTree, mergedTree } = await computePublishTree(origin, paths);

    const changes = await diffTrees(origin, mergedTree);
    if (!changes.length) {
      return {
        success: true,
        message: 'Nothing to publish — the live site already has these changes.',
        changed: false,
        changedPosts: [],
        commitHash: origin,
        files: [],
      };
    }
    const forbidden = changes.filter((c) => FORBIDDEN_PUBLISH_PATH.test(c.path));
    if (forbidden.length) {
      throw new PublishError(
        'forbidden_paths',
        `Refusing to publish build/dependency output (${forbidden.length} files, e.g. ${forbidden[0].path}). Check site/.gitignore.`,
      );
    }
    // Only reachable if HEAD carries non-site commits origin lacks (e.g. the
    // checkout sits on a local feature branch). The CMS publishes content,
    // never code — refuse loudly rather than ship someone's WIP.
    const outside = changes.filter((c) => !c.path.startsWith(`${SITE_PATHSPEC}/`));
    if (outside.length) {
      throw new PublishError(
        'non_site_changes',
        `The server checkout has unpublished code changes outside site/ (e.g. ${outside[0].path}). Content was not published; the server needs to be realigned with main.`,
      );
    }

    const commit = await out(['commit-tree', mergedTree, '-p', origin, '-m', message]);
    const pushed = await pushCommit(git, commit);
    if (pushed === 'rejected') {
      console.warn('[git] origin moved during publish — retrying on the new origin/main.');
      continue;
    }
    await verifyRemoteMain(git, commit);
    try {
      await syncUpstreamSiteChangesToDisk(oursTree, commit);
    } catch (err) {
      console.warn('[git] could not sync upstream site changes to disk:', err.message);
    }
    const diffText = changes.map((c) => `${c.status}\t${c.path}`).join('\n');
    return {
      success: true,
      message: 'Published to GitHub. The live site is rebuilding.',
      changed: true,
      changedPosts: extractChangedPostsFromDiff(diffText),
      commitHash: commit,
      files: changes,
    };
  }
  throw new PublishError(
    'push_rejected',
    'GitHub kept moving while publishing (3 attempts). Try again in a moment.',
  );
}

/**
 * Publish everything under site/ (the editor's "Publish" button). Returns
 * `{ success, message, changed, changedPosts, commitHash, files }`; throws
 * (PublishError where classifiable) when nothing verifiably reached GitHub.
 *
 * @param {{ message?: string, paths?: string[] }} [opts]
 */
export async function publishChanges(opts: { message?: string; paths?: string[] } = {}) {
  const message = opts.message || `Update site content: ${new Date().toISOString()}`;
  return withGitLock(() => publishImpl(message, opts));
}

/**
 * Follow-up commit after the main publish (e.g. front-matter URIs written by
 * the Bluesky/Mastodon cross-post hooks). Never throws.
 *
 * @param {string} message
 * @param {string[]} [paths] repo-relative paths to capture (default: all of site/)
 * @returns {Promise<{ success: boolean, message: string, commitHash?: string }>}
 */
export async function commitAndPush(message: string, paths?: string[]) {
  try {
    const r = await withGitLock(() => publishImpl(message, { paths: paths || null }));
    return {
      success: true,
      message: r.changed ? 'pushed' : 'nothing to commit',
      commitHash: r.commitHash,
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * What a Publish would ship right now, without fetching or pushing — feeds the
 * editor's "unpublished changes" badge and the System health view.
 *
 * @returns {Promise<{ branch: string, head: string, origin: string, onMain: boolean, pending: Array<{status: string, path: string}>, error?: string }>}
 */
export async function getPublishState() {
  try {
    const r = await gitExec(['symbolic-ref', '--short', '-q', 'HEAD'], { allowCodes: [0, 1] });
    const branch = r.code === 0 ? String(r.stdout).trim() : '(detached)';
    const head = await headSha();
    const o = await gitExec(['rev-parse', '--verify', '-q', ORIGIN_MAIN_REF], {
      allowCodes: [0, 1],
    });
    const origin = o.code === 0 ? String(o.stdout).trim() : '';
    let pending: Array<{ status: string; path: string }> = [];
    let error;
    if (origin) {
      try {
        const { mergedTree } = await computePublishTree(origin, null);
        pending = await diffTrees(origin, mergedTree);
      } catch (err) {
        error = err.message;
      }
    }
    return {
      branch,
      head,
      origin,
      onMain: branch === 'main',
      pending,
      ...(error ? { error } : {}),
    };
  } catch (err) {
    return { branch: '', head: '', origin: '', onMain: false, pending: [], error: err.message };
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

/**
 * `git log` for one path on the newest known main (origin/main when present,
 * else HEAD). Publishing never moves the local branch, so logging HEAD would
 * hide versions published since the host last synced.
 */
async function logPath(relPath: string, maxCount: number) {
  const o = await gitExec(['rev-parse', '--verify', '-q', ORIGIN_MAIN_REF], { allowCodes: [0, 1] });
  const ref = o.code === 0 ? ORIGIN_MAIN_REF : 'HEAD';
  const text = await out([
    'log',
    `--max-count=${Math.max(1, Math.min(200, Number(maxCount) || 50))}`,
    '--format=%H%x1f%aI%x1f%s%x1f%an%x1e',
    ref,
    '--',
    relPath,
  ]);
  return text
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, date, message, author] = r.split('\x1f');
      return { hash, date, message, author };
    });
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
  try {
    return await logPath(POSTS_PATH_PREFIX + safe, maxCount);
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
  try {
    return await logPath(relPath, maxCount);
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
