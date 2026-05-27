// @ts-nocheck
/**
 * Vitest unit tests for admin/public/js/dashboard.js.
 *
 * dashboard.js is an IIFE that boots on /index.html and:
 *   - fetches /api/posts → renders rows
 *   - polls /api/health → renders metric bars
 *   - wires tabs, search, delete-modal, publish buttons
 *
 * Strategy:
 *   1. Build the minimal HTML the script expects (mirrors index.html).
 *   2. Stub global fetch with a posts/health fixture.
 *   3. Eval common.js first (provides window.TE), then dashboard.js.
 *   4. Wait one microtask for the async loadPosts() to resolve, then
 *      assert observable DOM state.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMON_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'common.js'), 'utf-8');
const DASHBOARD_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf-8');

const POSTS_FIXTURE = [
  {
    filename: 'a.md',
    title: 'Alpha',
    slug: 'a',
    date: '2026-01-15T00:00:00.000Z',
    draft: false,
    tags: ['tech'],
  },
  {
    filename: 'b.md',
    title: 'Beta',
    slug: 'b',
    date: '2026-02-01T00:00:00.000Z',
    draft: true,
    tags: ['draft', 'wip'],
  },
  {
    filename: 'c.md',
    title: 'Gamma',
    slug: 'c',
    date: '2099-12-31T00:00:00.000Z',
    draft: false,
    tags: [],
  },
];

const HEALTH_FIXTURE = {
  system: { cpu: { usagePercent: 12 }, memory: { usagePercent: 31 }, uptime: 4 * 3600 + 11 * 60 },
  temperature: { temp: 54.5, status: 'warning' },
  disk: { usagePercent: 9 },
  docker: [
    { name: 'caddy', healthy: true, status: 'Up 21 min' },
    { name: 'umami', healthy: false, status: 'Restarting (3)' },
  ],
};

function makeDashboardDom() {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.body.innerHTML = `
    <button id="btn-theme"><span id="btn-theme-glyph">☾</span></button>
    <div id="toast-root"></div>
    <span id="side-badge-posts"></span>
    <span id="side-pip"></span>
    <span id="side-system"></span>
    <span id="side-uptime"></span>
    <span id="side-cpu"></span>
    <span id="posts-total"></span>
    <span id="tab-count-all"></span>
    <span id="tab-count-draft"></span>
    <span id="tab-count-scheduled"></span>
    <span id="tab-count-published"></span>
    <span id="dash-sub"></span>
    <div role="tablist">
      <button class="tab" data-tab="all" aria-selected="true">All <span class="count" id="c1">—</span></button>
      <button class="tab" data-tab="draft" aria-selected="false">Draft <span class="count" id="c2">—</span></button>
      <button class="tab" data-tab="scheduled" aria-selected="false">Scheduled <span class="count" id="c3">—</span></button>
      <button class="tab" data-tab="published" aria-selected="false">Published <span class="count" id="c4">—</span></button>
    </div>
    <input id="posts-search" />
    <span id="posts-visible"></span>
    <span id="posts-foot-text"></span>
    <div id="posts-rows"></div>
    <input id="topbar-search-input" />
    <span id="health-uptime"></span>
    <div id="metric-cpu"><span id="metric-cpu-val"></span><i id="metric-cpu-bar"></i></div>
    <div id="metric-ram"><span id="metric-ram-val"></span><i id="metric-ram-bar"></i></div>
    <div id="metric-temp"><span id="metric-temp-val"></span><i id="metric-temp-bar"></i></div>
    <div id="metric-disk"><span id="metric-disk-val"></span><i id="metric-disk-bar"></i></div>
    <div id="docker-list"></div>
    <span id="backup-status"></span>
    <div class="modal" id="delete-modal"><div class="modal-card"><span id="delete-target-title"></span><button id="btn-confirm-delete">Delete</button></div></div>
    <button id="btn-publish">Publish</button>
    <button id="btn-publish-2">Publish</button>
    <button id="btn-refresh-health">Refresh</button>
  `;
}

beforeEach(() => {
  // Force pathname to /index.html so dashboard.js boots.
  // jsdom doesn't let you set location.pathname directly; navigate instead.
  window.history.replaceState({}, '', '/index.html');
  makeDashboardDom();
  delete window.TE;

  // Stub fetch with a router.
  globalThis.fetch = vi.fn(async (url) => {
    const u = typeof url === 'string' ? url : url.url;
    if (u.startsWith('/api/posts')) {
      return new Response(JSON.stringify(POSTS_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.startsWith('/api/health')) {
      return new Response(JSON.stringify(HEALTH_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  new Function(COMMON_JS)();
  new Function(DASHBOARD_JS)();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Wait for the dashboard's deferred loadPosts/loadHealth to settle. */
async function flush() {
  // Two ticks: one for the fetch promise, one for the post-then-render.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('posts table', () => {
  it('renders a row per post after the API resolves', async () => {
    await flush();
    const rows = document.querySelectorAll('#posts-rows .row-grid');
    expect(rows.length).toBe(POSTS_FIXTURE.length);
    expect(document.getElementById('posts-total')?.textContent).toMatch(/3 total/);
  });

  it('classifies posts as draft / scheduled / published correctly', async () => {
    await flush();
    expect(document.getElementById('tab-count-all')?.textContent).toBe('3');
    expect(document.getElementById('tab-count-draft')?.textContent).toBe('1');
    expect(document.getElementById('tab-count-scheduled')?.textContent).toBe('1');
    expect(document.getElementById('tab-count-published')?.textContent).toBe('1');
  });

  it('the search filter narrows visible rows', async () => {
    await flush();
    const input = /** @type {HTMLInputElement} */ (document.getElementById('posts-search'));
    input.value = 'alpha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // search has an 80ms debounce
    await new Promise((r) => setTimeout(r, 100));
    const rows = document.querySelectorAll('#posts-rows .row-grid');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.r-title')?.textContent).toBe('Alpha');
  });

  it('switching the Draft tab shows only drafts', async () => {
    await flush();
    const draftTab = /** @type {HTMLButtonElement} */ (
      document.querySelector('.tab[data-tab="draft"]')
    );
    draftTab.click();
    const rows = document.querySelectorAll('#posts-rows .row-grid');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.r-title')?.textContent).toBe('Beta');
    expect(draftTab.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowRight on the active tab moves focus and selection to the next tab', async () => {
    await flush();
    const tabs = document.querySelectorAll('.tab');
    const all = /** @type {HTMLButtonElement} */ (tabs[0]);
    all.focus();
    all.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
  });
});

describe('health polling', () => {
  it('renders CPU/RAM/DISK metric values from the API', async () => {
    await flush();
    expect(document.getElementById('metric-cpu-val')?.textContent).toBe('12%');
    expect(document.getElementById('metric-ram-val')?.textContent).toBe('31%');
    expect(document.getElementById('metric-disk-val')?.textContent).toBe('9%');
  });

  it('renders one Docker row per container with healthy/unhealthy class', async () => {
    await flush();
    const dockers = document.querySelectorAll('#docker-list .docker');
    expect(dockers.length).toBe(2);
    const dots = document.querySelectorAll('#docker-list .ddot');
    expect(dots[0].classList.contains('bad')).toBe(false);
    expect(dots[1].classList.contains('bad')).toBe(true);
  });

  it('temperature WARN raises the sidebar pip to .warn', async () => {
    await flush();
    const pip = document.getElementById('side-pip');
    // temp.status === 'warning' on the fixture, so we expect at least warn.
    expect(pip?.classList.contains('warn') || pip?.classList.contains('bad')).toBe(true);
  });
});
