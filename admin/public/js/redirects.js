// @ts-check
/**
 * redirects.js — /#redirects table editor.
 *
 * GET /api/redirects → render rows. Inline edits + delete; "Add" pops
 * a tiny form at the top of the table. Saves go to POST/PUT/DELETE.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  function escape(s) {
    return window.TE && window.TE.escape ? window.TE.escape(s) : String(s || '');
  }

  /** @type {{ id: string, from: string, to: string, code: number }[]} */
  let rows = [];

  async function load() {
    const root = document.getElementById('redirects-table');
    if (!root) return;
    root.textContent = 'Loading…';
    try {
      rows = await window.TE.fetchJSON('/api/redirects');
    } catch (err) {
      root.innerHTML = `<div class="posts-empty">Failed: ${escape(err.message)}</div>`;
      return;
    }
    if (!rows.length) {
      root.innerHTML = `<div class="posts-empty">No redirects yet. Click "+ Add redirect" to start.</div>`;
      return;
    }
    root.innerHTML = `
      <div class="te-redir-row te-redir-head">
        <span>From</span><span>→ To</span><span>Code</span><span></span>
      </div>
      ${rows
        .map(
          (r) => `
        <div class="te-redir-row" data-id="${escape(r.id)}">
          <span class="te-redir-from"><code>${escape(r.from)}</code></span>
          <span class="te-redir-to"><code>${escape(r.to)}</code></span>
          <span class="te-redir-code">${r.code}</span>
          <span class="te-redir-actions">
            <button type="button" class="btn-mini bad js-del" data-id="${escape(r.id)}">Delete</button>
          </span>
        </div>
      `,
        )
        .join('')}
    `;
    root.querySelectorAll('.js-del').forEach((btn) => {
      btn.addEventListener('click', () => del(btn.getAttribute('data-id') || ''));
    });
  }

  async function add() {
    const from = window.prompt('Source path (e.g. /old-url/):');
    if (!from) return;
    const to = window.prompt('Destination URL or path:');
    if (!to) return;
    const codeRaw = window.prompt('Status code (301, 302, 307, 308):', '301');
    const code = Number(codeRaw || 301);
    try {
      await window.TE.fetchJSON('/api/redirects', {
        method: 'POST',
        body: JSON.stringify({ from, to, code }),
      });
      window.TE.toast('Redirect added.');
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Add failed.', 'error');
    }
  }

  async function del(id) {
    if (!id) return;
    if (!window.confirm('Delete this redirect?')) return;
    try {
      await window.TE.fetchJSON(`/api/redirects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      window.TE.toast('Redirect deleted.');
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Delete failed.', 'error');
    }
  }

  function init() {
    load();
    const btn = document.getElementById('btn-redirect-new');
    if (btn) btn.addEventListener('click', add);
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.redirects = init;
})();
