// @ts-nocheck
/**
 * git.test.js — publish flow safety.
 *
 * The publish flow runs inside the cms container, where the worktree at
 * /app does NOT mirror the repo: only `site/` and `.git` are mounted —
 * the rest of the repo (admin/, docker/, scripts/, .github/) is absent
 * and the container's own files (server.js, src/, node_modules/) are
 * untracked strays. These tests build that exact layout with real git
 * repos and assert publishChanges() can never stage the phantom
 * deletions or the strays — only site/** ships.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

let tempDir;
let originDir; // bare "GitHub" remote
let containerDir; // the /app-shaped worktree publishChanges runs against
let seedDir; // a full clone used to push "other" changes to origin

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

const hasFlock = (() => {
  try {
    execFileSync('flock', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Files at HEAD of the bare origin's main branch. */
const originTree = () => git(originDir, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-git-test-'));
  originDir = join(tempDir, 'origin.git');
  seedDir = join(tempDir, 'seed');
  containerDir = join(tempDir, 'app');

  // 1. Seed a repo shaped like the real one and publish it to a bare
  //    origin (stands in for GitHub).
  git(tempDir, 'init', '--bare', '-b', 'main', originDir);
  git(tempDir, 'init', '-b', 'main', seedDir);
  git(seedDir, 'config', 'user.name', 'Test');
  git(seedDir, 'config', 'user.email', 'test@example.com');
  for (const f of [
    'site/content/posts/existing.md',
    'site/public/images/pic.webp',
    'admin/server.js',
    'docker/docker-compose.yml',
    'scripts/backup.sh',
    '.github/workflows/deploy.yml',
  ]) {
    mkdirSync(join(seedDir, f, '..'), { recursive: true });
    writeFileSync(join(seedDir, f), `seed: ${f}\n`);
  }
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', originDir);
  git(seedDir, 'push', 'origin', 'main');

  // 2. Build the container-shaped worktree: same .git, but ONLY site/
  //    exists; admin/docker/scripts/.github are missing (the bind mounts
  //    don't include them) and the container's own files are strays.
  mkdirSync(containerDir, { recursive: true });
  cpSync(join(seedDir, '.git'), join(containerDir, '.git'), { recursive: true });
  cpSync(join(seedDir, 'site'), join(containerDir, 'site'), { recursive: true });
  writeFileSync(join(containerDir, 'server.js'), 'stray container file\n');
  mkdirSync(join(containerDir, 'node_modules', 'leftpad'), { recursive: true });
  writeFileSync(join(containerDir, 'node_modules', 'leftpad', 'index.js'), 'stray\n');
  git(containerDir, 'config', 'user.name', 'CMS');
  git(containerDir, 'config', 'user.email', 'cms@example.com');

  // git.js resolves the repo as dirname(SITE_DIR).
  process.env.SITE_DIR = join(containerDir, 'site');
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('publishChanges from a container-shaped worktree ships only site/**', async () => {
  const { publishChanges } = await import('../src/utils/git.js');

  // Sanity: the worktree really is "dirty" the way the container is —
  // admin/ etc. read as deleted, server.js as untracked.
  const porcelain = git(containerDir, 'status', '--porcelain');
  assert.match(porcelain, /D admin\/server\.js/);
  assert.match(porcelain, /\?\? server\.js/);

  // Make real site edits: one modified post, one new post.
  writeFileSync(join(containerDir, 'site/content/posts/existing.md'), 'edited body\n');
  writeFileSync(join(containerDir, 'site/content/posts/new-post.md'), 'brand new\n');

  const result = await publishChanges();
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedPosts.sort(), ['existing.md', 'new-post.md']);
  assert.ok(result.commitHash);

  // The pushed tree must still contain every non-site file — the
  // phantom deletions were never staged — and no container strays.
  const tree = originTree();
  assert.ok(tree.includes('admin/server.js'), 'admin/ survived the publish');
  assert.ok(tree.includes('docker/docker-compose.yml'), 'docker/ survived the publish');
  assert.ok(tree.includes('scripts/backup.sh'), 'scripts/ survived the publish');
  assert.ok(tree.includes('.github/workflows/deploy.yml'), '.github/ survived the publish');
  assert.ok(!tree.includes('server.js'), 'container stray was not committed');
  assert.ok(!tree.some((f) => f.startsWith('node_modules/')), 'node_modules was not committed');
  assert.ok(tree.includes('site/content/posts/new-post.md'), 'the new post shipped');
});

test('publishChanges reports changed:false when site/ is clean (despite the dirty container layout)', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  const before_ = git(originDir, 'rev-parse', 'main').trim();
  const result = await publishChanges();
  assert.equal(result.changed, false);
  assert.equal(git(originDir, 'rev-parse', 'main').trim(), before_, 'no commit was pushed');
});

test('publishChanges refuses to race a host backup/deploy lock', { skip: !hasFlock }, async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  const lockPath = join(containerDir, '.git', 'wwwide-operation.lock');
  const holder = spawn(
    'flock',
    ['-x', lockPath, 'sh', '-c', 'printf "LOCKED\\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  holder.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', (chunk) => {
      if (chunk.includes('LOCKED')) resolve();
      else reject(new Error(`Unexpected lock handshake: ${chunk}`));
    });
  });

  process.env.WWWIDE_OPERATION_LOCK_TIMEOUT_MS = '200';
  try {
    await assert.rejects(
      publishChanges(),
      /Another CMS backup, deploy, or publish operation is active/,
    );
  } finally {
    delete process.env.WWWIDE_OPERATION_LOCK_TIMEOUT_MS;
    holder.stdin.end();
    await once(holder, 'exit');
  }
});

test('commitAndPush is scoped to site/** too', async () => {
  const { commitAndPush } = await import('../src/utils/git.js');
  writeFileSync(join(containerDir, 'site/content/posts/existing.md'), 'crosspost frontmatter\n');
  // A fresh stray appears at the same time — it must not ship.
  writeFileSync(join(containerDir, 'stray-new.txt'), 'nope\n');
  const result = await commitAndPush('test follow-up commit');
  assert.equal(result.success, true);
  assert.ok(result.commitHash);
  const tree = originTree();
  assert.ok(!tree.includes('stray-new.txt'));
});

test('extractChangedPostsFromDiff parses add/modify/rename and ignores deletes', async () => {
  const { extractChangedPostsFromDiff } = await import('../src/utils/git.js');
  const diff = [
    'M\tsite/content/posts/a.md',
    'A\tsite/content/posts/b.md',
    'D\tsite/content/posts/gone.md',
    'R100\tsite/content/posts/old.md\tsite/content/posts/renamed.md',
    'M\tsite/public/images/pic.webp',
    'M\tsite/content/about.md',
    '',
  ].join('\n');
  assert.deepEqual(extractChangedPostsFromDiff(diff).sort(), ['a.md', 'b.md', 'renamed.md']);
  assert.deepEqual(extractChangedPostsFromDiff(''), []);
  assert.deepEqual(extractChangedPostsFromDiff(null), []);
});

test('publishChanges refuses (never guesses) when the checkout diverged from the last publish', async () => {
  const { publishChanges } = await import('../src/utils/git.js');

  // A stranded local commit (like the 2026-10 outage) on top of an old base:
  // the disk could derive from either line of history, so a merge base can't
  // be chosen safely. The publish must refuse loudly and push nothing.
  writeFileSync(join(containerDir, 'site/content/posts/orphan.md'), 'recovered post\n');
  git(containerDir, 'add', 'site');
  git(containerDir, 'commit', '-m', 'orphaned by a failed push');

  const originBefore = git(originDir, 'rev-parse', 'main').trim();
  await assert.rejects(publishChanges(), (err) => err.code === 'checkout_diverged');
  assert.equal(git(originDir, 'rev-parse', 'main').trim(), originBefore, 'nothing pushed');

  // Realign (what the host does): local main → origin/main, index to match;
  // the orphan's content is still on disk and ships on the next publish.
  git(containerDir, 'fetch', 'origin', 'main');
  git(containerDir, 'update-ref', 'refs/heads/main', 'origin/main');
  git(containerDir, 'read-tree', 'origin/main');
  const result = await publishChanges();
  assert.equal(result.changed, true);
  assert.ok(originTree().includes('site/content/posts/orphan.md'), 'orphan post shipped');
});

test('publishChanges reconciles when origin moved on (no "branch moved on")', async () => {
  const { publishChanges } = await import('../src/utils/git.js');

  // A code deploy pushes a NON-conflicting change to origin/main after our
  // last sync — origin is now ahead of the container's local main, exactly
  // the "branch moved on" setup. (Sync the seed clone first — earlier tests
  // already advanced origin.)
  git(seedDir, 'fetch', 'origin', 'main');
  git(seedDir, 'reset', '--hard', 'origin/main');
  writeFileSync(join(seedDir, 'admin/server.js'), 'seed: admin/server.js\n// deploy change\n');
  git(seedDir, 'add', 'admin/server.js');
  git(seedDir, 'commit', '-m', 'code deploy to origin');
  git(seedDir, 'push', 'origin', 'main');

  // The writer edits a post in the container and publishes.
  writeFileSync(join(containerDir, 'site/content/posts/reconcile.md'), 'reconciled\n');
  const result = await publishChanges();
  assert.equal(result.success, true, 'publish succeeded despite divergence');
  assert.equal(result.changed, true);

  // Origin ends up with BOTH the deploy's code change AND the new post — the
  // publish rebased onto the moved origin instead of being rejected.
  const tree = originTree();
  assert.ok(tree.includes('site/content/posts/reconcile.md'), 'new post shipped');
  assert.match(
    git(originDir, 'show', 'main:admin/server.js'),
    /deploy change/,
    'origin kept the code deploy change (not clobbered)',
  );
});

test('getPostHistory + getPostAtCommit surface a post’s git revisions', async () => {
  const { getPostHistory, getPostAtCommit } = await import('../src/utils/git.js');

  // existing.md has been modified across several commits by earlier tests.
  const history = await getPostHistory('existing.md');
  assert.ok(history.length >= 1, 'history has at least one commit');
  for (const c of history) {
    assert.match(c.hash, /^[0-9a-f]{7,40}$/i);
    assert.equal(typeof c.message, 'string');
  }

  // The content at the most recent commit round-trips.
  const raw = await getPostAtCommit('existing.md', history[0].hash);
  assert.equal(typeof raw, 'string');
  assert.ok(raw.length > 0);

  // Guards: a bogus hash and a traversal filename both return null/[].
  assert.equal(await getPostAtCommit('existing.md', 'zzz; rm -rf /'), null);
  assert.deepEqual(await getPostHistory('../../../etc/passwd'), []);
});

// ── 2026-11 publish hardening ────────────────────────────────────────────────

/** Sync the seed clone to origin and push a change made by `edit`. */
const pushFromSeed = (message, edit) => {
  git(seedDir, 'fetch', 'origin', 'main');
  git(seedDir, 'reset', '--hard', 'origin/main');
  edit(seedDir);
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', message);
  git(seedDir, 'push', 'origin', 'main');
};

test('publish preserves upstream site/ edits the disk never pulled (no silent revert)', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  // Someone edits site.toml on GitHub (e.g. the contact-email commit) while
  // the server's disk still has the old file.
  const toml = (email, b) =>
    `[social]\na = 1\n${email}\n[site]\nx = 1\ny = 1\nz = 1\n\n[apps]\nb = ${b}\n`;
  writeFileSync(join(containerDir, 'site/site.toml'), toml('', 1));
  await publishChanges();
  pushFromSeed('upstream toml edit', (d) =>
    writeFileSync(join(d, 'site/site.toml'), toml('email = "hi"', 1)),
  );
  // CMS edits a different section of the same file.
  writeFileSync(join(containerDir, 'site/site.toml'), toml('', 2));
  const result = await publishChanges();
  assert.equal(result.changed, true);
  const shipped = git(originDir, 'show', 'main:site/site.toml');
  assert.match(shipped, /email = "hi"/, 'upstream edit survived');
  assert.match(shipped, /b = 2/, 'CMS edit shipped');
  // …and the merged result was written back to disk so the host's next
  // fast-forward sees a consistent worktree.
  assert.equal(readFileSync(join(containerDir, 'site/site.toml'), 'utf8'), shipped);
});

test('publish surfaces a real conflict instead of clobbering upstream', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  pushFromSeed('upstream rewrite', (d) =>
    writeFileSync(
      join(d, 'site/site.toml'),
      `[social]\na = 1\nemail = "hi"\n[site]\nx = 1\ny = 1\nz = 1\n\n[apps]\nb = UPSTREAM\n`,
    ),
  );
  writeFileSync(
    join(containerDir, 'site/site.toml'),
    `[social]\na = 1\nemail = "hi"\n[site]\nx = 1\ny = 1\nz = 1\n\n[apps]\nb = CMS\n`,
  );
  const before_ = git(originDir, 'rev-parse', 'main').trim();
  await assert.rejects(publishChanges(), (err) => err.code === 'merge_conflict');
  assert.equal(git(originDir, 'rev-parse', 'main').trim(), before_, 'nothing was pushed');
  // Resolve: take upstream.
  writeFileSync(
    join(containerDir, 'site/site.toml'),
    git(originDir, 'show', 'main:site/site.toml'),
  );
});

test('publish refuses build/dependency output even without ignore rules', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  mkdirSync(join(containerDir, 'site/node_modules/pkg'), { recursive: true });
  writeFileSync(join(containerDir, 'site/node_modules/pkg/index.js'), 'x\n');
  try {
    await assert.rejects(publishChanges(), (err) => err.code === 'forbidden_paths');
  } finally {
    rmSync(join(containerDir, 'site/node_modules'), { recursive: true, force: true });
  }
});

test('publish works when the checkout is on a feature branch (the 2026-10 outage)', async () => {
  const { publishChanges, getPublishState } = await import('../src/utils/git.js');
  git(containerDir, 'checkout', '-q', '-b', 'codex/some-feature');
  try {
    writeFileSync(join(containerDir, 'site/content/posts/from-branch.md'), 'shipped\n');
    const state = await getPublishState();
    assert.equal(state.onMain, false);
    assert.ok(state.pending.some((p) => p.path === 'site/content/posts/from-branch.md'));

    const result = await publishChanges();
    assert.equal(result.changed, true);
    assert.equal(
      git(originDir, 'rev-parse', 'main').trim(),
      result.commitHash,
      'origin/main is the published commit',
    );
    assert.ok(originTree().includes('site/content/posts/from-branch.md'));
    assert.equal(
      git(containerDir, 'symbolic-ref', '--short', 'HEAD').trim(),
      'codex/some-feature',
      'HEAD/branch untouched',
    );
    const after_ = await getPublishState();
    assert.deepEqual(after_.pending, [], 'nothing left to publish');
  } finally {
    git(containerDir, 'checkout', '-q', 'main');
  }
});

test('publish refuses when local HEAD carries code commits origin lacks', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  git(containerDir, 'checkout', '-q', '-b', 'wip-code');
  try {
    // Commit a non-site change via plumbing (the container has no admin/ dir).
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: containerDir,
      input: 'wip code\n',
      encoding: 'utf8',
    }).trim();
    git(containerDir, 'update-index', '--add', '--cacheinfo', `100644,${blob},admin/wip.js`);
    git(containerDir, 'commit', '-q', '-m', 'wip code');
    writeFileSync(join(containerDir, 'site/content/posts/blocked.md'), 'x\n');
    await assert.rejects(publishChanges(), (err) =>
      ['non_site_changes', 'checkout_diverged'].includes(err.code),
    );
    assert.ok(!originTree().includes('admin/wip.js'));
  } finally {
    rmSync(join(containerDir, 'site/content/posts/blocked.md'), { force: true });
    git(containerDir, 'checkout', '-q', '-f', 'main');
  }
});

test('scoped publish (scheduler) ships only the given paths', async () => {
  const { publishChanges } = await import('../src/utils/git.js');
  writeFileSync(join(containerDir, 'site/content/posts/scheduled.md'), 'go live\n');
  writeFileSync(join(containerDir, 'site/site.toml'), 'half-finished homepage edit\n');
  const result = await publishChanges({ paths: ['site/content/posts/scheduled.md'] });
  assert.equal(result.changed, true);
  assert.ok(originTree().includes('site/content/posts/scheduled.md'));
  assert.doesNotMatch(git(originDir, 'show', 'main:site/site.toml'), /half-finished/);
  writeFileSync(
    join(containerDir, 'site/site.toml'),
    git(originDir, 'show', 'main:site/site.toml'),
  );
});
