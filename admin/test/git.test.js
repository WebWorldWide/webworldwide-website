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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let originDir; // bare "GitHub" remote
let containerDir; // the /app-shaped worktree publishChanges runs against

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Files at HEAD of the bare origin's main branch. */
const originTree = () => git(originDir, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-git-test-'));
  originDir = join(tempDir, 'origin.git');
  const seedDir = join(tempDir, 'seed');
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
