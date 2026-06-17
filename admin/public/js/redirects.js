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
    root.innerHTML = '<div class="te-loading"><span class="te-spinner"></span> Loading…</div>';
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

  // Normalize a path the same way the server does, so "Test URL" matches
  // what the live redirect table will actually do.
  function normPath(p) {
    let s = String(p || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
    if (!s.startsWith('/')) s = '/' + s;
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s;
  }

  // ── Export / Import (CSV) ──────────────────────────────────
  function csvField(v) {
    return `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  }
  function exportCsv() {
    if (!rows.length) {
      window.TE.toast('No redirects to export.', 'warn');
      return;
    }
    const lines = ['from,to,code'];
    rows.forEach((r) => lines.push([r.from, r.to, r.code].map(csvField).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redirects-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Minimal CSV parse for our own from,to,code shape (handles quotes + an
  // optional header row). Good enough to round-trip exported files.
  function parseCsv(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const cells = [];
      const re = /(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^,]*))/g;
      let m;
      while ((m = re.exec(line))) {
        cells.push((m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] || '').trim());
        if (re.lastIndex >= line.length) break;
      }
      if (cells[0]?.toLowerCase() === 'from') continue; // header
      const [from, to, code] = cells;
      if (from && to) out.push({ from, to, code: Number(code) || 301 });
    }
    return out;
  }

  async function importCsv(file) {
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      window.TE.toast('Could not read the file.', 'error');
      return;
    }
    const parsed = parseCsv(text);
    if (!parsed.length) {
      window.TE.toast('No valid rows found (expected from,to,code).', 'warn');
      return;
    }
    try {
      const res = await window.TE.fetchJSON('/api/redirects/import', {
        method: 'POST',
        body: JSON.stringify({ rows: parsed }),
      });
      window.TE.toast(
        `Imported ${res.imported} redirect${res.imported === 1 ? '' : 's'}` +
          (res.skipped ? ` (${res.skipped} skipped)` : '') +
          '.',
      );
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Import failed.', 'error');
    }
  }

  // ── Test URL (resolve a path through the table, following chains) ──
  function resolvePath(input) {
    const start = normPath(input);
    if (!start) return { ok: false, msg: 'Enter a path to test.' };
    const chain = [start];
    let cur = start;
    for (let i = 0; i < 10; i += 1) {
      const hit = rows.find((r) => r.from === cur);
      if (!hit) break;
      if (chain.includes(hit.to)) {
        return { ok: false, msg: `Loop detected: ${chain.join(' → ')} → ${hit.to}` };
      }
      chain.push(`${hit.to} (${hit.code})`);
      cur = normPath(hit.to);
    }
    if (chain.length === 1) {
      return { ok: true, msg: `No redirect — ${start} is served directly.` };
    }
    return { ok: true, msg: chain.join('  →  ') };
  }

  function openTestForm() {
    const host = document.getElementById('redirect-form-host');
    if (!host) return;
    host.innerHTML = `
      <form class="te-redir-form" novalidate>
        <div class="te-redir-form-grid">
          <label class="te-field"><span>Test a path</span>
            <input name="path" placeholder="/old-url/" autocomplete="off" /></label>
        </div>
        <div class="te-redir-test-result" aria-live="polite"></div>
        <div class="te-redir-form-actions">
          <button type="button" class="btn ghost js-cancel">Close</button>
          <button type="submit" class="btn solid">Resolve</button>
        </div>
      </form>`;
    const form = host.querySelector('.te-redir-form');
    const out = host.querySelector('.te-redir-test-result');
    host.querySelector('[name="path"]')?.focus();
    host.querySelector('.js-cancel')?.addEventListener('click', () => {
      host.innerHTML = '';
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = resolvePath(form.path.value);
      out.textContent = r.msg;
      out.className = 'te-redir-test-result' + (r.ok ? ' ok' : ' err');
    });
  }

  function init() {
    load();
    const btn = document.getElementById('btn-redirect-new');
    if (btn) btn.addEventListener('click', openAddForm);
    const test = document.getElementById('btn-redirect-test');
    if (test) test.addEventListener('click', openTestForm);
    const exportBtn = document.getElementById('btn-redirect-export');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    const importBtn = document.getElementById('btn-redirect-import');
    const importFile = /** @type {HTMLInputElement | null} */ (
      document.getElementById('redirect-import-file')
    );
    if (importBtn && importFile) {
      importBtn.addEventListener('click', () => importFile.click());
      importFile.addEventListener('change', () => {
        if (importFile.files && importFile.files[0]) importCsv(importFile.files[0]);
        importFile.value = ''; // allow re-importing the same file
      });
    }
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.redirects = init;
})();
