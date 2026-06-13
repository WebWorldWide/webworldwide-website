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

  // Inline add form (replaces three stacked window.prompt dialogs). Renders
  // into #redirect-form-host above the table with proper fields + validation.
  function openAddForm() {
    const host = document.getElementById('redirect-form-host');
    if (!host) return;
    if (host.querySelector('.te-redir-form')) {
      host.querySelector('[name="from"]')?.focus();
      return;
    }
    host.innerHTML = `
      <form class="te-redir-form" novalidate>
        <div class="te-redir-form-grid">
          <label class="te-field"><span>From (path)</span>
            <input name="from" placeholder="/old-url/" autocomplete="off" required /></label>
          <label class="te-field"><span>To (URL or path)</span>
            <input name="to" placeholder="/blog/new-url/" autocomplete="off" required /></label>
          <label class="te-field te-redir-code-field"><span>Code</span>
            <select name="code">
              <option value="301">301 — permanent</option>
              <option value="302">302 — temporary</option>
              <option value="307">307 — temporary (keep method)</option>
              <option value="308">308 — permanent (keep method)</option>
            </select></label>
        </div>
        <div class="te-redir-form-err" aria-live="polite"></div>
        <div class="te-redir-form-actions">
          <button type="button" class="btn ghost js-cancel">Cancel</button>
          <button type="submit" class="btn solid">Add redirect</button>
        </div>
      </form>
    `;
    const form = host.querySelector('.te-redir-form');
    const errEl = host.querySelector('.te-redir-form-err');
    host.querySelector('[name="from"]')?.focus();
    host.querySelector('.js-cancel')?.addEventListener('click', () => {
      host.innerHTML = '';
    });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const from = String(form.from.value || '').trim();
      const to = String(form.to.value || '').trim();
      const code = Number(form.code.value || 301);
      if (!from.startsWith('/')) {
        errEl.textContent = 'From must be a path starting with “/”.';
        return;
      }
      if (!to) {
        errEl.textContent = 'Enter a destination.';
        return;
      }
      errEl.textContent = '';
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        await window.TE.fetchJSON('/api/redirects', {
          method: 'POST',
          body: JSON.stringify({ from, to, code }),
        });
        window.TE.toast('Redirect added.');
        host.innerHTML = '';
        load();
      } catch (err) {
        errEl.textContent = err.message || 'Add failed.';
        if (submitBtn) submitBtn.disabled = false;
      }
    });
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
    if (btn) btn.addEventListener('click', openAddForm);
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.redirects = init;
})();
