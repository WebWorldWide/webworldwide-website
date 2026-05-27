// @ts-check
/**
 * posts-bulk.js — adds multi-select + bulk actions to the dashboard
 * posts table without modifying dashboard.js. Listens to DOM changes
 * via MutationObserver on #posts-rows so it survives every re-render.
 *
 * Actions: publish, unpublish, add-tag, delete. The bulk action bar
 * (#posts-bulk-bar) is declared in index.html; this module shows/hides
 * it based on selection size and fires POST /api/posts/bulk.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  /** @type {Set<string>} */ const selected = new Set();

  function bar() {
    return /** @type {HTMLElement | null} */ (document.getElementById('posts-bulk-bar'));
  }

  function renderSelectionUI() {
    const b = bar();
    const count = document.getElementById('posts-bulk-count');
    if (count) count.textContent = String(selected.size);
    if (b) b.hidden = selected.size === 0;
  }

  function injectCheckboxes() {
    const rows = document.querySelectorAll('#posts-rows .row-grid[data-filename]');
    rows.forEach((row) => {
      if (row.querySelector('.js-post-pick')) return;
      const fn = row.getAttribute('data-filename') || '';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'js-post-pick';
      cb.setAttribute('data-filename', fn);
      cb.setAttribute('aria-label', `Select ${fn}`);
      // Place it as the first child of the .r-actions cell to avoid
      // disturbing the click-target anchor in .r-link.
      const actions = row.querySelector('.r-actions');
      if (actions) actions.insertBefore(cb, actions.firstChild);
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (cb.checked) selected.add(fn);
        else selected.delete(fn);
        renderSelectionUI();
      });
    });
  }

  async function runBulk(action, payload) {
    if (!selected.size) return;
    if (action === 'delete') {
      if (!window.confirm(`Delete ${selected.size} post${selected.size === 1 ? '' : 's'}?`)) return;
    }
    try {
      const filenames = Array.from(selected);
      const res = await window.TE.fetchJSON('/api/posts/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, filenames, payload }),
      });
      const okN = (res.ok || []).length;
      const errN = (res.errors || []).length;
      window.TE.toast(
        `${action}: ${okN} succeeded${errN ? `, ${errN} failed` : ''}.`,
        errN ? 'warn' : 'info',
      );
      selected.clear();
      renderSelectionUI();
      // Ask the dashboard to refresh by faking a tab click (cheap).
      const tab = document.querySelector('.tab[aria-selected="true"]');
      if (tab) /** @type {HTMLElement} */ (tab).click();
      // Or call dashboard.loadPosts if exposed (it isn't yet; tab-click is good enough).
      window.location.reload();
    } catch (err) {
      window.TE.toast(err.message || 'Bulk failed.', 'error');
    }
  }

  function init() {
    // Master select-all
    const all = document.getElementById('posts-select-all');
    if (all) {
      all.addEventListener('change', (e) => {
        const checked = /** @type {HTMLInputElement} */ (e.target).checked;
        document.querySelectorAll('.js-post-pick').forEach((cb) => {
          /** @type {HTMLInputElement} */ (cb).checked = checked;
          const fn = cb.getAttribute('data-filename') || '';
          if (checked) selected.add(fn);
          else selected.delete(fn);
        });
        renderSelectionUI();
      });
    }

    // Bulk-action buttons
    document.querySelectorAll('[data-bulk-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-bulk-action') || '';
        runBulk(action);
      });
    });
    const addTag = document.getElementById('btn-bulk-add-tag');
    if (addTag) {
      addTag.addEventListener('click', () => {
        const tag = window.prompt('Tag to add to selected posts:');
        if (tag) runBulk('add-tag', { tag });
      });
    }
    const clear = document.getElementById('btn-bulk-clear');
    if (clear) {
      clear.addEventListener('click', () => {
        selected.clear();
        document
          .querySelectorAll('.js-post-pick')
          .forEach((cb) => /** @type {HTMLInputElement} */ (cb.checked = false));
        renderSelectionUI();
      });
    }

    // Observe re-renders
    const rowsHost = document.getElementById('posts-rows');
    if (rowsHost) {
      const obs = new MutationObserver(() => {
        // Drop stale selections that no longer have a row
        const present = new Set();
        document.querySelectorAll('#posts-rows .row-grid[data-filename]').forEach((r) => {
          present.add(r.getAttribute('data-filename'));
        });
        for (const fn of Array.from(selected)) if (!present.has(fn)) selected.delete(fn);
        injectCheckboxes();
        renderSelectionUI();
      });
      obs.observe(rowsHost, { childList: true, subtree: true });
    }

    // First pass (rows might already be rendered)
    injectCheckboxes();
    renderSelectionUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
