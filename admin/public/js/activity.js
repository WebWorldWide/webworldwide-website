// @ts-check
/**
 * activity.js — recent CMS activity, both as a /#activity table and as
 * the dashboard widget. Hits GET /api/activity?limit=N.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  function escape(s) {
    return window.TE && window.TE.escape ? window.TE.escape(s) : String(s || '');
  }

  function fmtTs(ms) {
    const d = new Date(ms);
    const now = Date.now();
    const delta = now - ms;
    if (delta < 60 * 1000) return 'just now';
    if (delta < 3600 * 1000) return `${Math.floor(delta / 60000)}m ago`;
    if (delta < 24 * 3600 * 1000) return `${Math.floor(delta / 3600000)}h ago`;
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  async function fetchItems(limit) {
    try {
      const data = await window.TE.fetchJSON(`/api/activity?limit=${limit}`);
      return Array.isArray(data?.items) ? data.items : [];
    } catch (_) {
      return null;
    }
  }

  function renderRows(items) {
    if (items === null) return `<div class="posts-empty">Failed to load activity.</div>`;
    if (!items.length) return `<div class="posts-empty">No activity yet.</div>`;
    return (
      `<div class="te-act-row te-act-head"><span>When</span><span>Who</span><span>Action</span><span>Target</span></div>` +
      items
        .map(
          (it) => `
        <div class="te-act-row">
          <span class="te-act-when" title="${escape(new Date(it.ts).toISOString())}">${escape(fmtTs(it.ts))}</span>
          <span class="te-act-who">${escape(it.user || 'system')}</span>
          <span class="te-act-action"><code>${escape(it.action)}</code></span>
          <span class="te-act-target">${escape(it.target || '—')}</span>
        </div>
      `,
        )
        .join('')
    );
  }

  async function loadPage() {
    const root = document.getElementById('activity-table');
    if (!root) return;
    root.textContent = 'Loading…';
    const items = await fetchItems(50);
    root.innerHTML = renderRows(items);
  }

  async function loadWidget() {
    const root = document.getElementById('activity-widget-body');
    if (!root) return;
    const items = await fetchItems(10);
    root.innerHTML = renderRows(items);
  }

  function init() {
    loadPage();
    const refresh = document.getElementById('btn-activity-refresh');
    if (refresh) refresh.addEventListener('click', loadPage);
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.activity = init;

  // Always fire the widget on dashboard boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadWidget);
  } else {
    loadWidget();
  }
})();
