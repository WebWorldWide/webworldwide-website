// @ts-nocheck
/**
 * toml-roundtrip.test.js — Phase 5e. Pure-JS, no sqlite, so runs on
 * macOS dev hosts that can't load better-sqlite3 too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, apply, flatToChanges } from '../src/utils/toml-roundtrip.js';

const SRC = `baseURL = "https://example.com"
title = "Old title"

# Pagination
[pagination]
  pagerSize = 10

# Params
[params]
  tagline = "old"
  umamiSiteID = ""  # placeholder
`;

test('parse returns expected structure', () => {
  const obj = parse(SRC);
  assert.equal(obj.title, 'Old title');
  assert.equal(obj.params.tagline, 'old');
  assert.equal(obj.pagination.pagerSize, 10);
});

test('apply updates a top-level key while preserving comments', () => {
  const out = apply(SRC, [{ section: '', key: 'title', value: 'New title' }]);
  assert.match(out, /title = "New title"/);
  assert.match(out, /# Pagination/);
  assert.match(out, /# Params/);
});

test('apply updates a section key without losing inline comment', () => {
  const out = apply(SRC, [{ section: 'params', key: 'umamiSiteID', value: 'abc-123' }]);
  assert.match(out, /umamiSiteID = "abc-123"\s*# placeholder/);
});

test('no-op call returns identical source', () => {
  assert.equal(apply(SRC, []), SRC);
});

test('inserts missing key into existing section', () => {
  const out = apply(SRC, [{ section: 'params', key: 'newKey', value: 'val' }]);
  assert.match(out, /newKey = "val"/);
  // Existing tagline still present in same section
  assert.match(out, /tagline = "old"/);
});

test('creates a new section when absent', () => {
  const out = apply(SRC, [{ section: 'newSection', key: 'k', value: 1 }]);
  assert.match(out, /\[newSection\]/);
  assert.match(out, /k = 1/);
});

test('flatToChanges splits dotted keys', () => {
  const flat = { 'params.tagline': 'x', title: 'T' };
  const changes = flatToChanges(flat);
  assert.deepEqual(
    changes.sort((a, b) => (a.key > b.key ? 1 : -1)),
    [
      { section: '', key: 'title', value: 'T' },
      { section: 'params', key: 'tagline', value: 'x' },
    ].sort((a, b) => (a.key > b.key ? 1 : -1)),
  );
});

test('serializes booleans, numbers, and arrays', () => {
  const src = `[s]\nk = 0\n`;
  const out = apply(src, [{ section: 's', key: 'k', value: true }]);
  assert.match(out, /k = true/);
  const out2 = apply(src, [{ section: 's', key: 'k', value: ['a', 'b'] }]);
  assert.match(out2, /k = \["a", "b"\]/);
});

// --- Homepage-editor capabilities (proof tests) -----------------------
// The homepage editor writes inline-table ARRAYS (apps.items) and
// creates dotted [homepage.*] sections in tomls that predate them.

test('writes an inline-table array on one line and re-parses it identically', () => {
  const items = [
    { name: 'FileID', status: 'live', link: 'https://example.com/a', icon: '/assets/fileid.png' },
    { name: 'Document Finder', status: 'soon', link: '', icon: '' },
  ];
  const src = `# header comment\n[homepage.apps]\nitems = []\n`;
  const out = apply(src, [{ section: 'homepage.apps', key: 'items', value: items }]);
  // Single line: `items = [{ … }, { … }]`
  const line = out.split('\n').find((l) => l.startsWith('items ='));
  assert.ok(line, 'items line exists');
  assert.match(line, /^items = \[\{ name = "FileID".*\}\]$/);
  // Comment above the section survives.
  assert.match(out, /# header comment/);
  // Parse round-trip yields the exact same objects.
  assert.deepEqual(parse(out).homepage.apps.items, items);
});

test('updates an existing inline-table array in place, preserving neighbors', () => {
  const src = `[homepage.apps]
# tiles below
items = [ { name = "Old", status = "soon", link = "", icon = "" } ]
other = "untouched"
`;
  const next = [{ name: 'New', status: 'live', link: '/x', icon: '' }];
  const out = apply(src, [{ section: 'homepage.apps', key: 'items', value: next }]);
  assert.deepEqual(parse(out).homepage.apps.items, next);
  assert.match(out, /# tiles below/);
  assert.match(out, /other = "untouched"/);
});

test('creates missing dotted sections and keys for an old toml', () => {
  const src = `[site]\ntitle = "x"\n`;
  let out = apply(src, [
    { section: 'homepage', key: 'section_order', value: ['hero', 'apps'] },
    { section: 'homepage.sections', key: 'hero', value: true },
    { section: 'homepage.hero', key: 'words', value: ['Web', 'World', 'Wide'] },
    { section: 'homepage.hero', key: 'tagline', value: 'W · W · W' },
  ]);
  const parsed = parse(out);
  assert.deepEqual(parsed.homepage.section_order, ['hero', 'apps']);
  assert.equal(parsed.homepage.sections.hero, true);
  assert.deepEqual(parsed.homepage.hero.words, ['Web', 'World', 'Wide']);
  assert.equal(parsed.homepage.hero.tagline, 'W · W · W');
  assert.equal(parsed.site.title, 'x'); // existing content untouched
  // A second pass edits the keys it just created (idempotent shape).
  out = apply(out, [{ section: 'homepage.hero', key: 'tagline', value: 'updated' }]);
  assert.equal(parse(out).homepage.hero.tagline, 'updated');
});
