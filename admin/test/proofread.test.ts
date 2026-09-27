// @ts-nocheck
/**
 * proofread.test.js — the /api/proofread proxy + custom dictionary.
 *
 * LanguageTool is mocked at the global-fetch layer: requests to the LT host
 * return canned data; everything else (the test's own calls to the express
 * server) delegates to the real fetch.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let realFetch;

// Mutable knobs the mock reads.
let ltResponse = { matches: [] };
let ltOk = true;
let ltStatus = 200;
let ltThrow = false;

const api = (path, opts) =>
  realFetch(`${baseUrl}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'proofread-test-'));
  process.env.SITE_DIR = tempDir; // dictionary-store writes <SITE_DIR>/data/dictionary.json
  process.env.LANGUAGETOOL_URL = 'http://lt.test/v2';

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('lt.test')) {
      if (ltThrow) throw new Error('connect ECONNREFUSED');
      return { ok: ltOk, status: ltStatus, json: async () => ltResponse };
    }
    return realFetch(url, opts);
  };

  const express = (await import('express')).default;
  const router = (await import('../src/routes/proofread.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/proofread', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  ltThrow = false;
  ltOk = true;
  ltStatus = 200;
  ltResponse = { matches: [] };
});

test('normalizes matches and buckets them by kind', async () => {
  ltResponse = {
    language: { code: 'en-US' },
    matches: [
      {
        offset: 0,
        length: 3,
        message: 'Possible spelling mistake',
        rule: { id: 'MORFOLOGIK', issueType: 'misspelling', category: { id: 'TYPOS' } },
        replacements: [{ value: 'The' }, { value: 'Ten' }, { value: 'Tea' }],
      },
      {
        offset: 4,
        length: 5,
        message: 'Grammar issue',
        rule: { id: 'GRMR', issueType: 'grammar', category: { id: 'GRAMMAR' } },
        replacements: [],
      },
      {
        offset: 10,
        length: 4,
        message: 'Wordy',
        rule: { id: 'STY', issueType: 'style', category: { id: 'STYLE' } },
        replacements: [],
      },
    ],
  };
  const res = await api('/api/proofread', {
    method: 'POST',
    body: JSON.stringify({ text: 'teh quick brown fox jumps' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.matches.length, 3);
  assert.deepEqual(
    body.matches.map((m) => m.kind),
    ['spelling', 'grammar', 'style'],
  );
  assert.deepEqual(body.matches[0].replacements, ['The', 'Ten', 'Tea']);
});

test('empty text short-circuits without calling LanguageTool', async () => {
  ltThrow = true; // would error if the route actually called LT
  const res = await api('/api/proofread', {
    method: 'POST',
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).matches, []);
});

test('oversized text is rejected with 413', async () => {
  const res = await api('/api/proofread', {
    method: 'POST',
    body: JSON.stringify({ text: 'x'.repeat(60_001) }),
  });
  assert.equal(res.status, 413);
});

test('unreachable LanguageTool degrades to 503 (never throws)', async () => {
  ltThrow = true;
  const res = await api('/api/proofread', {
    method: 'POST',
    body: JSON.stringify({ text: 'some real text here' }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'proofreader_unavailable');
});

test('custom dictionary drops spelling matches for accepted words', async () => {
  // Accept "teh" as a word.
  const put = await api('/api/proofread/dictionary', {
    method: 'PUT',
    body: JSON.stringify({ language: 'en-US', words: ['teh'] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).words, ['teh']);

  // LT flags "teh" (offset 0, len 3) as a misspelling — it must be filtered.
  ltResponse = {
    language: { code: 'en-US' },
    matches: [
      {
        offset: 0,
        length: 3,
        message: 'Spelling',
        rule: { id: 'MORFOLOGIK', issueType: 'misspelling', category: { id: 'TYPOS' } },
        replacements: [{ value: 'the' }],
      },
    ],
  };
  const res = await api('/api/proofread', {
    method: 'POST',
    body: JSON.stringify({ text: 'teh cat' }),
  });
  const body = await res.json();
  assert.equal(body.matches.length, 0, 'accepted word is not flagged');
});

test('GET/POST dictionary round-trips and exposes supported languages', async () => {
  await api('/api/proofread/dictionary', {
    method: 'PUT',
    body: JSON.stringify({ language: 'en-GB', words: ['foo'] }),
  });
  const add = await api('/api/proofread/dictionary', {
    method: 'POST',
    body: JSON.stringify({ word: 'Bar' }),
  });
  assert.equal(add.status, 200);
  const get = await (await api('/api/proofread/dictionary')).json();
  assert.equal(get.language, 'en-GB');
  assert.ok(get.words.includes('foo'));
  assert.ok(get.words.includes('bar'), 'words are normalized to lowercase');
  assert.ok(Array.isArray(get.supported) && get.supported.includes('en-US'));
});
