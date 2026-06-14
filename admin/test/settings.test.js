// @ts-nocheck
/**
 * settings.test.js — Phase 5e TOML round-trip + settings API.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let siteDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

const SAMPLE_TOML = `baseURL = "https://example.com"
title = "Example"

# Pagination
[pagination]
  pagerSize = 10

# Taxonomies
[taxonomies]
  tag = "tags"
  series = "series"

# Site params
[params]
  tagline = "test"
  umamiSiteID = ""  # Fill after Umami setup
  youtubeURL = "https://youtube.com/example"
`;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-settings-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret';
  process.env.NODE_ENV = 'test';
  siteDir = join(tempDir, 'site');
  mkdirSync(join(siteDir, 'content', 'posts'), { recursive: true });
  mkdirSync(join(siteDir, 'data'), { recursive: true });
  writeFileSync(join(siteDir, 'site.toml'), SAMPLE_TOML);
  process.env.SITE_DIR = siteDir;

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }

  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  const express = (await import('express')).default;
  const settingsRouter = (await import('../src/routes/settings.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('GET /api/settings returns hugo + author', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/settings`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hugo.title, 'Example');
  assert.equal(body.hugo.params.tagline, 'test');
  // author defaults
  assert.equal(typeof body.author.name, 'string');
});

test('TOML round-trip preserves comments + ordering', skipOpts(), async () => {
  // Modify one key
  const res = await fetch(`${baseUrl}/api/settings/hugo`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: { 'params.umamiSiteID': 'umami-123' } }),
  });
  assert.equal(res.status, 200);
  const updated = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  // Comment line "# Pagination" survives
  assert.match(updated, /# Pagination/);
  // Order preserved — pagination still before taxonomies
  const pagIdx = updated.indexOf('[pagination]');
  const taxIdx = updated.indexOf('[taxonomies]');
  assert.ok(pagIdx < taxIdx);
  // New value applied
  assert.match(updated, /umamiSiteID = "umami-123"/);
  // Inline comment preserved
  assert.match(updated, /# Fill after Umami setup/);
});

test('TOML round-trip with no changes is a no-op', skipOpts(), async () => {
  const before = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  const res = await fetch(`${baseUrl}/api/settings/hugo`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: {} }),
  });
  assert.equal(res.status, 200);
  const after = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  assert.equal(before, after);
});

test('PATCH author writes site/data/author.json', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/settings/author`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Adam', bio: 'Hi', social: { bluesky: '@x' } }),
  });
  assert.equal(res.status, 200);
  const raw = readFileSync(join(siteDir, 'data', 'author.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.name, 'Adam');
  assert.equal(parsed.social.bluesky, '@x');
});

test('helper apply directly preserves blank lines + comments', skipOpts(), async () => {
  const { apply, parse } = await import('../src/utils/toml-roundtrip.js');
  const out = apply(SAMPLE_TOML, [{ section: 'params', key: 'tagline', value: 'new' }]);
  // Blank-line layout intact (one before each [section])
  assert.equal(out.split('\n# Pagination').length, 2);
  // Re-parse round-trips cleanly
  const reparsed = parse(out);
  assert.equal(reparsed.params.tagline, 'new');
  assert.equal(reparsed.title, 'Example');
});

/* ------------------------------------------------------------------ *
 * Homepage editor — GET/PATCH /api/settings/homepage                  *
 * ------------------------------------------------------------------ */

const DEFAULT_MODEL = {
  hero: { words: ['Web', 'World', 'Wide'], tagline: 'W · W · W', subtitle: '' },
  apps: {
    items: [
      { name: 'FileID', status: 'live', link: '', icon: '/assets/fileid.png' },
      { name: 'Document Finder', status: 'soon', link: '', icon: '/assets/doc-finder.png' },
      // Mirrors site/src/lib/site-config.ts normalizeHomepage exactly —
      // see the comment in settings.js where these defaults live.
      { name: 'Untitled', status: 'lab', link: '', icon: '' },
      { name: 'Untitled', status: 'lab', link: '', icon: '' },
    ],
  },
  videos: { episode: 'EP. 001', film_title: 'First video — coming soon' },
  socials: {
    order: [
      'youtube',
      'github',
      'twitter',
      'bluesky',
      'mastodon',
      'reddit',
      'instagram',
      'threads',
    ],
    hidden: [],
  },
  blog_cta: {
    kicker: 'Latest',
    title: 'The Web World Wide',
    title_accent: 'Blog',
    url: '/blog/',
    description: '',
  },
  sections: { hero: true, apps: true, videos: true, socials: true, blog_cta: true },
  section_order: ['hero', 'apps', 'videos', 'socials', 'blog_cta'],
};

// Fully-populated fixture with non-default values + a canary comment that
// PATCH writes must never eat.
const FULL_HOMEPAGE_TOML = `baseURL = "https://example.com"

[site]
tagline = "My World on the Web"

[apps]
fileid = "https://example.com/fileid"
doc_finder = ""

# canary: hand-written comment — must survive PATCH writes
[homepage]
section_order = ["videos", "hero", "apps", "socials", "blog_cta"]

[homepage.sections]
hero = true
apps = true
videos = false
socials = true
blog_cta = true

[homepage.hero]
words = ["Hello", "Wide", "Web"]
tagline = "Testing tagline"

[homepage.apps]
items = [ { name = "FileID", status = "live", link = "https://example.com/fileid", icon = "/assets/fileid.png" }, { name = "Lab Thing", status = "lab", link = "/lab/", icon = "" } ]

[homepage.videos]
episode = "EP. 042"
film_title = "Some film"

[homepage.socials]
order = ["github", "youtube"]
hidden = ["twitter", "email"]

[homepage.blog_cta]
kicker = "Fresh"
title = "Read the"
title_accent = "Blog"
url = "https://example.com/blog/"
`;

test('GET /homepage returns complete defaults on a minimal site.toml', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), SAMPLE_TOML); // no [site]/[apps]/[homepage]
  const res = await fetch(`${baseUrl}/api/settings/homepage`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), DEFAULT_MODEL);
});

test('GET /homepage derives defaults from legacy [site]/[apps] keys', skipOpts(), async () => {
  const legacy = `${SAMPLE_TOML}
[site]
tagline = "My World on the Web"

[apps]
fileid = "https://example.com/fileid"
doc_finder = ""
`;
  writeFileSync(join(siteDir, 'site.toml'), legacy);
  const res = await fetch(`${baseUrl}/api/settings/homepage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hero.tagline, 'My World on the Web');
  assert.equal(body.apps.items[0].link, 'https://example.com/fileid');
  assert.equal(body.apps.items[0].name, 'FileID');
  assert.equal(body.apps.items[1].status, 'soon');
  assert.deepEqual(body.section_order, DEFAULT_MODEL.section_order);
});

test('GET /homepage reflects a fully-populated toml', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
  const res = await fetch(`${baseUrl}/api/settings/homepage`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    hero: { words: ['Hello', 'Wide', 'Web'], tagline: 'Testing tagline', subtitle: '' },
    apps: {
      items: [
        {
          name: 'FileID',
          status: 'live',
          link: 'https://example.com/fileid',
          icon: '/assets/fileid.png',
        },
        { name: 'Lab Thing', status: 'lab', link: '/lab/', icon: '' },
      ],
    },
    videos: { episode: 'EP. 042', film_title: 'Some film' },
    socials: { order: ['github', 'youtube'], hidden: ['twitter', 'email'] },
    blog_cta: {
      kicker: 'Fresh',
      title: 'Read the',
      title_accent: 'Blog',
      url: 'https://example.com/blog/',
      description: '',
    },
    sections: { hero: true, apps: true, videos: false, socials: true, blog_cta: true },
    section_order: ['videos', 'hero', 'apps', 'socials', 'blog_cta'],
  });
});

test('PATCH /homepage round-trips edits and re-GET matches', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
  const patch = {
    hero: { words: ['Brand', 'New'], tagline: 'Patched tagline', subtitle: '' },
    apps: {
      items: [
        {
          name: 'FileID Renamed',
          status: 'live',
          link: 'https://example.com/fileid',
          icon: '/assets/fileid.png',
        },
        { name: 'Lab Thing', status: 'lab', link: '/lab/', icon: '' },
      ],
    },
    sections: { videos: true, socials: false },
    section_order: ['blog_cta', 'socials', 'videos', 'apps', 'hero'],
  };
  const res = await fetch(`${baseUrl}/api/settings/homepage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.deepEqual(updated.hero, patch.hero);
  assert.deepEqual(updated.apps.items, patch.apps.items);
  assert.equal(updated.sections.videos, true);
  assert.equal(updated.sections.socials, false);
  assert.deepEqual(updated.section_order, patch.section_order);
  // Untouched fields keep their fixture values.
  assert.equal(updated.videos.episode, 'EP. 042');
  assert.deepEqual(updated.socials.hidden, ['twitter', 'email']);
  // Re-GET returns exactly the PATCH response.
  const res2 = await fetch(`${baseUrl}/api/settings/homepage`);
  assert.deepEqual(await res2.json(), updated);
});

test('PATCH /homepage rejects invalid payloads with 400', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
  const cases = [
    {
      label: 'bad app status',
      body: { apps: { items: [{ name: 'X', status: 'beta', link: '', icon: '' }] } },
      match: /status/,
    },
    {
      label: 'too many apps',
      body: {
        apps: {
          items: Array.from({ length: 9 }, (_, i) => ({
            name: `App ${i}`,
            status: 'soon',
            link: '',
            icon: '',
          })),
        },
      },
      match: /at most 8/,
    },
    {
      label: 'junk section id',
      body: { sections: { junk: true } },
      match: /junk/,
    },
    {
      label: 'non-permutation section_order',
      body: { section_order: ['hero', 'apps', 'videos', 'socials'] },
      match: /permutation/,
    },
    {
      label: 'duplicate section_order entries',
      body: { section_order: ['hero', 'hero', 'videos', 'socials', 'blog_cta'] },
      match: /permutation/,
    },
    {
      label: 'bad blog_cta url',
      body: { blog_cta: { url: 'example.com/blog' } },
      match: /blog_cta\.url/,
    },
    {
      label: 'bad app link scheme',
      body: { apps: { items: [{ name: 'X', status: 'live', link: 'ftp://nope', icon: '' }] } },
      match: /link/,
    },
    {
      label: 'too many hero words',
      body: { hero: { words: ['a', 'b', 'c', 'd', 'e', 'f'] } },
      match: /hero\.words/,
    },
    {
      label: 'hero.subtitle too long',
      body: { hero: { subtitle: 'x'.repeat(121) } },
      match: /hero\.subtitle/,
    },
    {
      label: 'blog_cta.description too long',
      body: { blog_cta: { description: 'x'.repeat(161) } },
      match: /blog_cta\.description/,
    },
    {
      label: 'unknown social key',
      body: { socials: { hidden: ['myspace'] } },
      match: /myspace/,
    },
    {
      label: 'unknown top-level field',
      body: { bogus: { a: 1 } },
      match: /unknown field/,
    },
  ];
  const before = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  for (const c of cases) {
    const res = await fetch(`${baseUrl}/api/settings/homepage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c.body),
    });
    assert.equal(res.status, 400, `${c.label} → 400`);
    const body = await res.json();
    assert.match(String(body.message), c.match, `${c.label} message`);
  }
  // No invalid payload may touch the file.
  assert.equal(readFileSync(join(siteDir, 'site.toml'), 'utf-8'), before);
});

test(
  'PATCH /homepage preserves unrelated comments and the file still parses',
  skipOpts(),
  async () => {
    writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
    const res = await fetch(`${baseUrl}/api/settings/homepage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: { episode: 'EP. 043' } }),
    });
    assert.equal(res.status, 200);
    const onDisk = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
    // Canary comment survives the write.
    assert.match(onDisk, /# canary: hand-written comment — must survive PATCH writes/);
    // Untouched lines stay byte-identical.
    assert.match(onDisk, /episode = "EP\. 043"/);
    assert.match(onDisk, /film_title = "Some film"/);
    // The file still parses and reflects the edit.
    const { parse } = await import('../src/utils/toml-roundtrip.js');
    const parsed = parse(onDisk);
    assert.equal(parsed.homepage.videos.episode, 'EP. 043');
    assert.equal(parsed.site.tagline, 'My World on the Web');
  },
);

test('PATCH /homepage creates [homepage.*] sections in an old toml', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), SAMPLE_TOML); // pre-homepage toml
  const res = await fetch(`${baseUrl}/api/settings/homepage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hero: { tagline: 'Created from scratch' },
      sections: { videos: false },
    }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.hero.tagline, 'Created from scratch');
  assert.equal(updated.sections.videos, false);
  const onDisk = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  assert.match(onDisk, /\[homepage\.hero\]/);
  assert.match(onDisk, /# Pagination/); // pre-existing comment intact
});

test('PATCH /homepage round-trips hero.subtitle + blog_cta.description', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
  const res = await fetch(`${baseUrl}/api/settings/homepage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hero: { subtitle: 'A calmer supporting line' },
      blog_cta: { description: 'Field notes from building the small web.' },
    }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.hero.subtitle, 'A calmer supporting line');
  assert.equal(updated.blog_cta.description, 'Field notes from building the small web.');
  const onDisk = readFileSync(join(siteDir, 'site.toml'), 'utf-8');
  assert.match(onDisk, /subtitle = "A calmer supporting line"/);
  assert.match(onDisk, /description = "Field notes from building the small web\."/);
  const reread = await (await fetch(`${baseUrl}/api/settings/homepage`)).json();
  assert.equal(reread.hero.subtitle, 'A calmer supporting line');
  assert.equal(reread.blog_cta.description, 'Field notes from building the small web.');
});

test('GET /homepage/history returns git + snapshots arrays', skipOpts(), async () => {
  writeFileSync(join(siteDir, 'site.toml'), FULL_HOMEPAGE_TOML);
  const res = await fetch(`${baseUrl}/api/settings/homepage/history`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.git), 'git is an array');
  assert.ok(Array.isArray(body.snapshots), 'snapshots is an array');
});

test('normalizeHomepage fills a complete model from an empty parse', skipOpts(), async () => {
  const { normalizeHomepage } = await import('../src/routes/settings.js');
  assert.deepEqual(normalizeHomepage({}), DEFAULT_MODEL);
});
