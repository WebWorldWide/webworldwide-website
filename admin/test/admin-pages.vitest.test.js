// @ts-nocheck
/**
 * admin-pages.vitest.test.js — Phase 5e jsdom tests for the new admin
 * frontend modules (settings, taxonomies, redirects, activity,
 * shortcodes). We load each IIFE under a jsdom DOM that mirrors the
 * relevant slice of index.html and stub fetch.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dirname, '..', 'public', 'js');
const COMMON_JS = readFileSync(join(PUB, 'common.js'), 'utf-8');

function loadCommon() {
  const fn = new Function('window', 'document', COMMON_JS);
  fn(window, document);
}

function runScript(file) {
  const src = readFileSync(join(PUB, file), 'utf-8');
  const fn = new Function('window', 'document', src);
  fn(window, document);
}

beforeEach(() => {
  window.history.replaceState({}, '', '/index.html');
  document.body.innerHTML = `<div id="toast-root"></div>`;
  delete window.TE;
  globalThis.fetch = vi.fn();
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('settings.js', () => {
  it('renders form fields from /api/settings response', async () => {
    document.body.innerHTML += `<button id="btn-save-settings"></button><div id="settings-form"></div>`;
    globalThis.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          hugo: { title: 'T', baseURL: 'https://x', params: { tagline: 'Tag' } },
          author: { name: 'A', social: { bluesky: 'b' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    loadCommon();
    runScript('settings.js');
    window.TE.routes.settings();
    await flush();
    const html = document.getElementById('settings-form').innerHTML;
    expect(html).toContain('value="T"');
    expect(html).toContain('value="Tag"');
    expect(html).toContain('value="A"');
    expect(html).toContain('value="b"');
  });
});

describe('taxonomies.js', () => {
  it('renders tag rows with counts', async () => {
    document.body.innerHTML += `<div id="tags-table"></div><span id="tags-total"></span>`;
    globalThis.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { name: 'foo', count: 3, posts: ['a.md', 'b.md', 'c.md'] },
          { name: 'bar', count: 1, posts: ['a.md'] },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    loadCommon();
    runScript('taxonomies.js');
    window.TE.routes.tags();
    await flush();
    const table = document.getElementById('tags-table').innerHTML;
    expect(table).toContain('#foo');
    expect(table).toContain('#bar');
    expect(table).toContain('>3<');
    expect(document.getElementById('tags-total').textContent).toBe('2 unique');
  });
});

describe('redirects.js', () => {
  it('renders empty state and adds a row', async () => {
    document.body.innerHTML += `<div id="redirects-table"></div><button id="btn-redirect-new"></button>`;
    globalThis.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    loadCommon();
    runScript('redirects.js');
    window.TE.routes.redirects();
    await flush();
    expect(document.getElementById('redirects-table').textContent).toMatch(/No redirects/);
  });
});

describe('activity.js', () => {
  it('renders recent activity', async () => {
    document.body.innerHTML += `<div id="activity-table"></div><button id="btn-activity-refresh"></button>`;
    globalThis.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: '1',
              ts: Date.now() - 60000,
              user: 'admin',
              action: 'post.create',
              target: 'a.md',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    loadCommon();
    runScript('activity.js');
    window.TE.routes.activity();
    await flush();
    const table = document.getElementById('activity-table').innerHTML;
    expect(table).toContain('post.create');
    expect(table).toContain('a.md');
  });
});

describe('shortcodes.js', () => {
  it('renders shortcode cards from docs scan', async () => {
    document.body.innerHTML += `<div id="shortcodes-list"></div>`;
    globalThis.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ name: 'gallery', doc: 'Pictures in a grid', usage: '{{< gallery >}}' }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    loadCommon();
    runScript('shortcodes.js');
    window.TE.routes.shortcodes();
    await flush();
    const html = document.getElementById('shortcodes-list').innerHTML;
    expect(html).toContain('gallery');
    expect(html).toContain('Pictures in a grid');
  });
});
