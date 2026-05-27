// @ts-nocheck
/**
 * bluesky.test.js — Phase 9 AT Protocol / Bluesky cross-post.
 *
 * Coverage:
 *   - composeThread fits short title+excerpt into a single post
 *   - composeThread chains long excerpts into a numbered thread
 *   - webUrlToAtUri / atUriToWebUrl / parseAtUri roundtrip
 *   - signIn surfaces a useful error when env is unset
 *   - postThread sends the right BskyAgent payload (mocked agent)
 *   - replyToPost chains on reply.root / reply.parent
 *   - crossPostChangedPosts skips drafts, already-posted, too-old,
 *     and respects the rate cap
 *   - crossPostChangedPosts writes bluesky_uri back to front-matter
 *     on success
 *
 * Tests skip transparently when better-sqlite3 won't load (dev macOS
 * Node 26 + older binary). Mirrors the pattern in webmentions.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bluesky;
let crosspost;
let tempDir;
let postsDir;

// ── Mock BskyAgent ───────────────────────────────────────────────────
//
// We never hit the real network in CI. The factory returns an object
// shaped like the BskyAgent surface we use: `login`, `post`,
// `getPosts`, `getPostThread`, `uploadBlob`.

function makeMockAgent(overrides = {}) {
  const posted = [];
  const agent = {
    posted,
    loginCalls: [],
    async login(creds) {
      this.loginCalls.push(creds);
      if (overrides.failLogin) throw new Error(overrides.failLogin);
      return { success: true };
    },
    async post(record) {
      posted.push(record);
      const i = posted.length;
      return {
        uri: `at://did:plc:mock/app.bsky.feed.post/rkey${i}`,
        cid: `bafymock${i}`,
      };
    },
    async getPosts({ uris }) {
      return {
        data: {
          posts: uris.map((u) => ({
            uri: u,
            cid: 'bafyparentcid',
            record: {},
          })),
        },
      };
    },
    async getPostThread({ uri }) {
      return { data: { thread: { post: { uri }, replies: [] } } };
    },
    async uploadBlob() {
      return { data: { blob: { $type: 'blob', ref: 'mockblob' } } };
    },
  };
  return agent;
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-bluesky-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  postsDir = join(tempDir, 'site', 'content', 'posts');
  mkdirSync(postsDir, { recursive: true });
  process.env.SITE_DIR = join(tempDir, 'site');
  // Force a generous max-age so test fixtures with old dates still
  // cross-post (test for the inverse is below with an explicit override).
  process.env.BLUESKY_MAX_AGE_MS = String(365 * 24 * 60 * 60 * 1000);

  // Bluesky service + crosspost service are pure JS — load them
  // regardless of whether better-sqlite3 is available on this Node
  // version. The DB is only used by activity logging (fire-and-forget
  // setImmediate, won't throw if better-sqlite3 fails to load).
  bluesky = await import('../src/services/bluesky.js');
  crosspost = await import('../src/services/bluesky-crosspost.js');

  // Probe better-sqlite3 so the activity logger (fire-and-forget) has
  // somewhere to write. If it fails, we still run the pure tests; the
  // crosspost tests use temp posts on disk + a mocked agent, neither
  // of which need SQLite directly.
  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
    const { runMigrations } = await import('../src/db/migrate.js');
    runMigrations();
  } catch (err) {
    // Don't block the pure tests — activity log inserts will warn to
    // stderr but won't throw out of `setImmediate`.
    console.warn('[test] better-sqlite3 unavailable (activity log degraded):', err.message);
  }
});

after(async () => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

// ── composeThread (pure) ─────────────────────────────────────────────

test('composeThread fits short title+excerpt into a single post', () => {
  const posts = bluesky.composeThread({
    title: 'Hello, World',
    excerpt: 'A short excerpt that should fit just fine.',
    url: 'https://terminaleighty.com/hello-world/',
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].isRoot, true);
  assert.ok(posts[0].text.includes('Hello, World'));
  assert.ok(posts[0].text.includes('https://terminaleighty.com/hello-world/'));
  assert.ok(posts[0].text.length <= 300);
});

test('composeThread chains long excerpts into a numbered thread', () => {
  // 900-char excerpt → root + 2-3 continuation posts.
  const longExcerpt = 'word '.repeat(180).trim(); // ~900 chars
  const posts = bluesky.composeThread({
    title: 'Long Post',
    excerpt: longExcerpt,
    url: 'https://terminaleighty.com/long/',
  });
  assert.ok(posts.length >= 2, `expected chain, got ${posts.length}`);
  assert.equal(posts[0].isRoot, true);
  // Each post under the limit.
  for (const p of posts) {
    assert.ok(p.text.length <= 300, `post over 300 chars: ${p.text.length}`);
  }
  // Continuation posts carry the (n/N) numerator.
  for (let i = 1; i < posts.length; i++) {
    assert.match(posts[i].text, /\(\d+\/\d+\)$/, `post ${i} missing numerator`);
  }
  // Order survives: numerators are 2/N, 3/N, …
  posts.slice(1).forEach((p, i) => {
    const m = p.text.match(/\((\d+)\/(\d+)\)$/);
    assert.ok(m, 'numerator parse');
    assert.equal(Number(m[1]), i + 2);
    assert.equal(Number(m[2]), posts.length);
  });
});

test('composeThread never emits an empty or orphan continuation', () => {
  // Excerpt exactly at the boundary — no orphan single char post.
  const excerpt = 'a'.repeat(295);
  const posts = bluesky.composeThread({
    title: 'Edge',
    excerpt,
    url: 'https://x.example/e/',
  });
  for (const p of posts) {
    // No empty body posts (just numerator).
    const stripped = p.text.replace(/\(\d+\/\d+\)$/, '').trim();
    assert.ok(stripped.length > 0, 'continuation has body');
  }
});

// ── AT URI / web URL ─────────────────────────────────────────────────

test('webUrlToAtUri parses a bsky.app post URL', () => {
  const uri = bluesky.webUrlToAtUri('https://bsky.app/profile/blog.terminaleighty.com/post/3kxyz');
  assert.equal(uri, 'at://blog.terminaleighty.com/app.bsky.feed.post/3kxyz');
});

test('webUrlToAtUri rejects non-bsky hosts', () => {
  assert.equal(bluesky.webUrlToAtUri('https://example.com/profile/x/post/y'), null);
  assert.equal(bluesky.webUrlToAtUri('https://bsky.app/about'), null);
  assert.equal(bluesky.webUrlToAtUri(''), null);
  assert.equal(bluesky.webUrlToAtUri('not a url'), null);
});

test('atUriToWebUrl is the inverse of webUrlToAtUri', () => {
  const web = bluesky.atUriToWebUrl('at://did:plc:abcd/app.bsky.feed.post/3kxyz');
  assert.equal(web, 'https://bsky.app/profile/did:plc:abcd/post/3kxyz');
});

test('parseAtUri extracts repo / collection / rkey', () => {
  const parts = bluesky.parseAtUri('at://alice.bsky.social/app.bsky.feed.post/abc');
  assert.deepEqual(parts, {
    repo: 'alice.bsky.social',
    collection: 'app.bsky.feed.post',
    rkey: 'abc',
  });
  assert.equal(bluesky.parseAtUri('not at uri'), null);
});

// ── signIn (env-driven) ──────────────────────────────────────────────

test('isConfigured reflects env vars', () => {
  delete process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_APP_PASSWORD;
  assert.equal(bluesky.isConfigured(), false);
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'xxxx-xxxx-xxxx-xxxx';
  assert.equal(bluesky.isConfigured(), true);
});

test('signIn surfaces a clear error when env is unset', async () => {
  delete process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_APP_PASSWORD;
  await assert.rejects(() => bluesky.signIn(), /BLUESKY_HANDLE/);
});

test('signIn surfaces the agent login error verbatim', async () => {
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'wrong';
  bluesky.setAgentFactory(async () => makeMockAgent({ failLogin: 'AuthenticationRequired' }));
  await assert.rejects(() => bluesky.signIn(), /AuthenticationRequired/);
  bluesky.setAgentFactory(null);
});

// ── postThread + replyToPost (mocked agent) ─────────────────────────

test('postThread sends a single record for short input', async () => {
  const agent = makeMockAgent();
  const result = await bluesky.postThread(agent, {
    title: 'Hi',
    excerpt: 'short',
    url: 'https://terminaleighty.com/hi/',
  });
  assert.equal(agent.posted.length, 1);
  assert.equal(agent.posted[0].$type, 'app.bsky.feed.post');
  assert.ok(agent.posted[0].embed, 'expected link card embed');
  assert.equal(agent.posted[0].embed.external.uri, 'https://terminaleighty.com/hi/');
  assert.ok(result.rootUri.startsWith('at://'));
  assert.ok(result.rootCid);
});

test('postThread chains continuation posts with reply.root / parent', async () => {
  const agent = makeMockAgent();
  const longExcerpt = 'word '.repeat(180).trim();
  const result = await bluesky.postThread(agent, {
    title: 'Long',
    excerpt: longExcerpt,
    url: 'https://terminaleighty.com/long/',
  });
  assert.ok(agent.posted.length >= 2, 'expected continuation posts');
  // First post has no reply field.
  assert.equal(agent.posted[0].reply, undefined);
  // Subsequent posts point at the root.
  for (let i = 1; i < agent.posted.length; i++) {
    const r = agent.posted[i].reply;
    assert.ok(r, `post ${i} missing reply ref`);
    assert.equal(r.root.uri, result.rootUri);
    assert.equal(r.root.cid, result.rootCid);
    assert.ok(r.parent.uri.startsWith('at://'));
  }
});

test('replyToPost posts a reply chained on parent + root', async () => {
  const agent = makeMockAgent();
  const parentUri = 'at://did:plc:thread/app.bsky.feed.post/parentid';
  const out = await bluesky.replyToPost(agent, parentUri, 'thanks!');
  assert.equal(agent.posted.length, 1);
  const r = agent.posted[0];
  assert.equal(r.text, 'thanks!');
  assert.equal(r.reply.parent.uri, parentUri);
  assert.equal(r.reply.parent.cid, 'bafyparentcid');
  assert.ok(out.uri.startsWith('at://'));
});

test('replyToPost truncates over-long bodies', async () => {
  const agent = makeMockAgent();
  const long = 'x'.repeat(500);
  await bluesky.replyToPost(agent, 'at://x/app.bsky.feed.post/y', long);
  assert.ok(agent.posted[0].text.length <= 300);
});

// ── crossPostChangedPosts (publish hook) ─────────────────────────────

function writePost(filename, frontmatter, body = 'Body.') {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');
  writeFileSync(join(postsDir, filename), `---\n${fm}\n---\n${body}\n`, 'utf-8');
}

test('crossPostChangedPosts skips when env is unset', async () => {
  delete process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_APP_PASSWORD;
  writePost('skip-no-env.md', {
    title: 'Skip',
    draft: false,
    slug: 'skip-no-env',
    date: new Date().toISOString(),
  });
  const report = await crosspost.crossPostChangedPosts(['skip-no-env.md']);
  assert.equal(report.posted.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, 'not_configured');
});

test('crossPostChangedPosts skips drafts + already-posted + too-old', async () => {
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'xxxx-xxxx-xxxx-xxxx';
  bluesky.setAgentFactory(async () => makeMockAgent());

  writePost('draft.md', {
    title: 'Draft',
    draft: true,
    slug: 'draft',
    date: new Date().toISOString(),
  });
  writePost('already.md', {
    title: 'Already',
    draft: false,
    slug: 'already',
    date: new Date().toISOString(),
    bluesky_uri: 'at://did:plc:x/app.bsky.feed.post/abc',
  });
  // Very old post — outside the configured MAX_AGE.
  process.env.BLUESKY_MAX_AGE_MS = '1000'; // 1 second
  writePost('old.md', {
    title: 'Old',
    draft: false,
    slug: 'old',
    date: '2020-01-01T00:00:00Z',
  });

  const report = await crosspost.crossPostChangedPosts(['draft.md', 'already.md', 'old.md']);
  const reasons = Object.fromEntries(report.skipped.map((s) => [s.filename, s.reason]));
  assert.equal(reasons['draft.md'], 'draft');
  assert.equal(reasons['already.md'], 'already_posted');
  assert.equal(reasons['old.md'], 'too_old');
  assert.equal(report.posted.length, 0);

  // Reset.
  process.env.BLUESKY_MAX_AGE_MS = String(365 * 24 * 60 * 60 * 1000);
  bluesky.setAgentFactory(null);
});

test('crossPostChangedPosts writes bluesky_uri back to front-matter', async () => {
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'xxxx';
  // Reset MAX_AGE_MS from the previous test's 1-second override so
  // a fresh post passes the staleness check.
  process.env.BLUESKY_MAX_AGE_MS = String(365 * 24 * 60 * 60 * 1000);
  const mockAgent = makeMockAgent();
  bluesky.setAgentFactory(async () => mockAgent);

  writePost('fresh.md', {
    title: 'Fresh',
    draft: false,
    slug: 'fresh',
    date: new Date().toISOString(),
  });

  const report = await crosspost.crossPostChangedPosts(['fresh.md']);
  assert.equal(report.posted.length, 1);
  assert.equal(report.posted[0].filename, 'fresh.md');
  assert.ok(report.posted[0].uri.startsWith('at://'));

  // File on disk now carries the URI.
  const updated = readFileSync(join(postsDir, 'fresh.md'), 'utf-8');
  assert.match(updated, /bluesky_uri:/);
  assert.match(updated, /at:\/\//);

  // Idempotency: running again skips because of bluesky_uri.
  const second = await crosspost.crossPostChangedPosts(['fresh.md']);
  assert.equal(second.posted.length, 0);
  assert.equal(second.skipped[0].reason, 'already_posted');

  bluesky.setAgentFactory(null);
});

test('crossPostChangedPosts respects the rate cap', async () => {
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'xxxx';
  process.env.BLUESKY_MAX_AGE_MS = String(365 * 24 * 60 * 60 * 1000);
  process.env.BLUESKY_MAX_PER_RUN = '2'; // resolved per-call now
  bluesky.setAgentFactory(async () => makeMockAgent());

  const files = ['rl1.md', 'rl2.md', 'rl3.md', 'rl4.md', 'rl5.md'];
  for (const f of files) {
    writePost(f, {
      title: f,
      draft: false,
      slug: f.replace('.md', ''),
      date: new Date().toISOString(),
    });
  }
  const report = await crosspost.crossPostChangedPosts(files);
  // Cap is enforced exactly.
  assert.equal(report.posted.length, 2);
  // Remaining 3 are skipped with reason=rate_limit.
  const rateLimited = report.skipped.filter((s) => s.reason === 'rate_limit');
  assert.equal(rateLimited.length, 3);
  bluesky.setAgentFactory(null);
  delete process.env.BLUESKY_MAX_PER_RUN;
});

test('crossPostChangedPosts surfaces signIn failure as per-file error', async () => {
  process.env.BLUESKY_HANDLE = 'blog.terminaleighty.com';
  process.env.BLUESKY_APP_PASSWORD = 'wrong';
  bluesky.setAgentFactory(async () => makeMockAgent({ failLogin: 'invalid_credentials' }));
  writePost('signfail.md', {
    title: 'SignFail',
    draft: false,
    slug: 'signfail',
    date: new Date().toISOString(),
  });
  const report = await crosspost.crossPostChangedPosts(['signfail.md']);
  assert.equal(report.posted.length, 0);
  assert.ok(report.errors.length >= 1);
  assert.match(report.errors[0].error, /signin_failed/);
  bluesky.setAgentFactory(null);
});

// ── extractExcerpt (pure) ────────────────────────────────────────────

test('extractExcerpt strips code fences, headings, and links', () => {
  const md = `# Heading

Some intro **bold** with a [link](https://x) inside.

\`\`\`js
const ignored = 1;
\`\`\`

More body.`;
  const out = crosspost.extractExcerpt(md, 200);
  assert.doesNotMatch(out, /^#/);
  assert.doesNotMatch(out, /```/);
  assert.doesNotMatch(out, /\[link\]/);
  assert.match(out, /Some intro bold with a link inside/);
});

test('extractExcerpt truncates with ellipsis on word boundary', () => {
  const md = 'word '.repeat(80);
  const out = crosspost.extractExcerpt(md, 60);
  assert.ok(out.length <= 60);
  assert.match(out, /…$/);
});
