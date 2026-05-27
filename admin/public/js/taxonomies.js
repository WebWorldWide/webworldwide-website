// @ts-check
/**
 * taxonomies.js — /#tags tag manager.
 *
 * Lists every tag with its post count. Each row has Rename + Delete
 * actions. Bulk-merge selects two-or-more tags via checkbox and folds
 * them into a single target name.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  /** @type {{ name: string, count: number, posts: string[] }[]} */
  let tags = [];

  function escape(s) {
    return window.TE && window.TE.escape ? window.TE.escape(s) : String(s || '');
  }

  async function load() {
    const root = document.getElementById('tags-table');
    if (!root) return;
    root.textContent = 'Loading…';
    try {
      tags = await window.TE.fetchJSON('/api/taxonomies/tags');
    } catch (err) {
      root.innerHTML = `<div class="posts-empty">Failed: ${escape(err.message)}</div>`;
      return;
    }
    const total = document.getElementById('tags-total');
    if (total) total.textContent = `${tags.length} unique`;
    if (!tags.length) {
      root.innerHTML = `<div class="posts-empty">No tags yet — add some to a post.</div>`;
      return;
    }
    root.innerHTML = `
      <div class="te-tag-row te-tag-head">
        <span class="te-tag-cell te-tag-check"></span>
        <span class="te-tag-cell te-tag-name">Tag</span>
        <span class="te-tag-cell te-tag-count">Posts</span>
        <span class="te-tag-cell te-tag-actions">Actions</span>
      </div>
      ${tags
        .map(
          (t) => `
        <div class="te-tag-row" data-tag="${escape(t.name)}">
          <span class="te-tag-cell te-tag-check">
            <input type="checkbox" class="js-merge" data-tag="${escape(t.name)}" aria-label="Select ${escape(t.name)} for merge" />
          </span>
          <span class="te-tag-cell te-tag-name">#${escape(t.name)}</span>
          <span class="te-tag-cell te-tag-count">${t.count}</span>
          <span class="te-tag-cell te-tag-actions">
            <button type="button" class="btn-mini js-rename" data-tag="${escape(t.name)}">Rename</button>
            <button type="button" class="btn-mini bad js-delete" data-tag="${escape(t.name)}">Delete</button>
          </span>
        </div>
      `,
        )
        .join('')}
      <div class="te-tag-foot">
        <button type="button" class="btn" id="btn-tag-merge" disabled>Merge selected →</button>
      </div>
    `;

    root.querySelectorAll('.js-rename').forEach((btn) => {
      btn.addEventListener('click', () => promptRename(btn.getAttribute('data-tag') || ''));
    });
    root.querySelectorAll('.js-delete').forEach((btn) => {
      btn.addEventListener('click', () => promptDelete(btn.getAttribute('data-tag') || ''));
    });

    const mergeBtn = document.getElementById('btn-tag-merge');
    root.querySelectorAll('.js-merge').forEach((cb) => {
      cb.addEventListener('change', () => {
        const sel = root.querySelectorAll('.js-merge:checked');
        if (mergeBtn) /** @type {HTMLButtonElement} */ (mergeBtn).disabled = sel.length < 2;
      });
    });
    if (mergeBtn) mergeBtn.addEventListener('click', promptMerge);
  }

  async function promptRename(from) {
    if (!from) return;
    const to = window.prompt(`Rename #${from} to:`, from);
    if (!to || to === from) return;
    try {
      await window.TE.fetchJSON('/api/taxonomies/tags/rename', {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      });
      window.TE.toast(`Renamed #${from} → #${to}.`);
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Rename failed.', 'error');
    }
  }

  async function promptDelete(name) {
    if (!name) return;
    if (!window.confirm(`Delete #${name} from every post that uses it?`)) return;
    try {
      await window.TE.fetchJSON(`/api/taxonomies/tags/${encodeURIComponent(name)}?force=true`, {
        method: 'DELETE',
      });
      window.TE.toast(`Deleted #${name}.`);
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Delete failed.', 'error');
    }
  }

  async function promptMerge() {
    const root = document.getElementById('tags-table');
    if (!root) return;
    const sel = Array.from(root.querySelectorAll('.js-merge:checked')).map((cb) =>
      cb.getAttribute('data-tag'),
    );
    if (sel.length < 2) return;
    const into = window.prompt(`Merge ${sel.join(', ')} into:`, sel[0] || '');
    if (!into) return;
    try {
      await window.TE.fetchJSON('/api/taxonomies/tags/merge', {
        method: 'POST',
        body: JSON.stringify({ from: sel, into }),
      });
      window.TE.toast(`Merged ${sel.length} tags into #${into}.`);
      load();
    } catch (err) {
      window.TE.toast(err.message || 'Merge failed.', 'error');
    }
  }

  function init() {
    load();
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.tags = init;
})();
