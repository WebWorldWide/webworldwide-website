// @ts-nocheck
/**
 * atomic-write.test.js — writeFileAtomic writes correctly and never
 * leaves a torn target or a stray temp file behind.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/utils/atomicWrite.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 't80-atomic-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('writes the full contents to the target', () => {
  const p = join(dir, 'a.md');
  writeFileAtomic(p, 'hello world');
  assert.equal(readFileSync(p, 'utf-8'), 'hello world');
});

test('overwrites an existing file atomically (no torn write)', () => {
  const p = join(dir, 'b.md');
  writeFileAtomic(p, 'first');
  writeFileAtomic(p, 'second, longer content');
  assert.equal(readFileSync(p, 'utf-8'), 'second, longer content');
});

test('leaves no .tmp- siblings after a successful write', () => {
  const p = join(dir, 'c.md');
  writeFileAtomic(p, 'clean');
  const strays = readdirSync(dir).filter((f) => f.startsWith('c.md.tmp-'));
  assert.deepEqual(strays, [], 'temp file was renamed away, not left behind');
});

test('throws (and leaves the original intact) when the target dir is gone', () => {
  // Pre-create the original so we can assert it survives a failed write
  // to a now-missing directory.
  const sub = join(dir, 'sub');
  const p = join(sub, 'd.md');
  // Directory does not exist -> writeFileSync(tmp) throws ENOENT.
  assert.throws(() => writeFileAtomic(p, 'wont land'));
  // And no temp litter in the parent.
  const strays = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(strays, []);
  // Sanity: a normal file written next to it is unaffected.
  writeFileSync(join(dir, 'ok.md'), 'fine');
  assert.equal(readFileSync(join(dir, 'ok.md'), 'utf-8'), 'fine');
});
