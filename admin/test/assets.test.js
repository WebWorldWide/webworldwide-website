// @ts-check
/**
 * assets.test.js — versionizeHtml() cache-busting rewriter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionizeHtml } from '../src/utils/assets.js';

test('appends ?v= to local js and css references', () => {
  const html = '<link href="/css/admin.css"><script src="/js/dashboard.js"></script>';
  const out = versionizeHtml(html, 'abc123');
  assert.ok(out.includes('/css/admin.css?v=abc123'));
  assert.ok(out.includes('/js/dashboard.js?v=abc123'));
});

test('leaves external and protocol-relative URLs untouched', () => {
  const html =
    '<script src="https://unpkg.com/x/bundle.js"></script><script src="//cdn/x.js"></script>';
  assert.equal(versionizeHtml(html, 'abc123'), html);
});

test('does not double-version refs that already have a query or hash', () => {
  const html = '<script src="/js/x.js?already=1"></script><link href="/css/y.css#h">';
  assert.equal(versionizeHtml(html, 'abc123'), html);
});

test('returns input unchanged when version is empty', () => {
  const html = '<script src="/js/x.js"></script>';
  assert.equal(versionizeHtml(html, ''), html);
});

test('only touches js/css, not other asset types', () => {
  const html = '<img src="/images/logo.png"><script src="/js/a.js"></script>';
  const out = versionizeHtml(html, 'v1');
  assert.ok(out.includes('/images/logo.png"'), 'image left alone');
  assert.ok(out.includes('/js/a.js?v=v1'));
});
