import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExcerpt } from '../src/routes/posts.ts';

test('deriveExcerpt: first paragraph, markdown stripped', () => {
  const body = '![cover](/a.png)\n\nHello **there**, [friend](https://x.y).\n\nSecond para.';
  assert.equal(deriveExcerpt(body), 'Hello there, friend.');
});

test('deriveExcerpt: long paragraphs cut at a sentence or word boundary', () => {
  const sentence = 'This is a sentence that is long enough to count as one. ';
  const out = deriveExcerpt(sentence.repeat(6));
  assert.ok(out.length <= 180);
  assert.ok(out.endsWith('.'));
  const words = deriveExcerpt('word '.repeat(80));
  assert.ok(words.endsWith('…'));
});

test('deriveExcerpt: empty body', () => {
  assert.equal(deriveExcerpt(''), '');
});
