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

  // The full-page view fetches a wide window once, then filters in the
  // browser (action / time-range / free-text) so the controls feel instant.
  /** @type {any[] | null} */ let pageItems = null;

  function applyFilters(items) {
    const action = (document.getElementById('act-filter-action') || {}).value || '';
    const range = Number((document.getElementById('act-filter-range') || {}).value || 0);
    const q = ((document.getElementById('act-filter-q') || {}).value || '').trim().toLowerCase();
    const cutoff = range ? Date.now() - range : 0;
    return items.filter((it) => {
      if (action && it.action !== action) return false;
      if (cutoff && Number(it.ts) < cutoff) return false;
      if (q) {
        const hay = `${it.target || ''} ${it.user || ''} ${it.action || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function populateActionFilter(items) {
    const sel = document.getElementById('act-filter-action');
    if (!sel) return;
    const current = sel.value;
    const actions = [...new Set(items.map((it) => it.action).filter(Boolean))].sort();
    sel.innerHTML =
      '<option value="">All actions</option>' +
      actions.map((a) => `<option value="${escape(a)}">${escape(a)}</option>`).join('');
    sel.value = actions.includes(current) ? current : '';
  }

  function renderFiltered() {
    const root = document.getElementById('activity-table');
    if (!root) return;
    root.innerHTML = renderRows(pageItems === null ? null : applyFilters(pageItems));
  }

  function toCsv(items) {
    const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['timestamp_ms,iso,user,action,target'];
    items.forEach((it) =>
      lines.push(
        [
          it.ts,
          new Date(it.ts).toISOString(),
          it.user || 'system',
          it.action || '',
          it.target || '',
        ]
          .map(esc)
          .join(','),
      ),
    );
    return lines.join('\n');
  }

  function exportCsv() {
    if (!pageItems || !pageItems.length) {
      if (window.TE && window.TE.toast) window.TE.toast('No activity to export.', 'warn');
      return;
    }
    const rows = applyFilters(pageItems);
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderRows(items) {
    if (items === null) return `<div class="posts-empty">Failed to load activity.</div>`;
    if (!items.length)
      return `<div class="posts-empty">Nothing here yet — as you write, edit, and publish posts your actions will show up here.</div>`;
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
    pageItems = await fetchItems(500);
    const filters = document.getElementById('activity-filters');
    if (filters) filters.hidden = pageItems === null || pageItems.length === 0;
    if (pageItems) populateActionFilter(pageItems);
    renderFiltered();
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
    const exportBtn = document.getElementById('btn-activity-export');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    ['act-filter-action', 'act-filter-range', 'act-filter-q'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', renderFiltered);
    });
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
