// @ts-check
/**
 * shortcodes.js — /#shortcodes read-only reference.
 *
 * Lists every Hugo shortcode in site/layouts/shortcodes/ along with
 * the doc + usage example extracted from the first leading Hugo
 * comment block in each template. Data comes from
 * GET /api/redirects/_shortcodes (yes, mounted under redirects router
 * — see route docstring).
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  function escape(s) {
    return window.TE && window.TE.escape ? window.TE.escape(s) : String(s || '');
  }

  async function load() {
    const root = document.getElementById('shortcodes-list');
    if (!root) return;
    root.textContent = 'Loading…';
    try {
      const items = await window.TE.fetchJSON('/api/redirects/_shortcodes');
      if (!items.length) {
        root.innerHTML = `<div class="posts-empty">No shortcodes registered.</div>`;
        return;
      }
      root.innerHTML = items
        .map(
          (it) => `
          <article class="te-sc-card">
            <header>
              <h3><code>{{&lt; ${escape(it.name)} &gt;}}</code></h3>
            </header>
            <div class="te-sc-doc">${it.doc ? `<p>${escape(it.doc).replace(/\n/g, '<br>')}</p>` : '<p class="te-sc-nodoc">No documentation block in template.</p>'}</div>
            ${it.usage ? `<pre class="te-sc-usage"><code>${escape(it.usage)}</code></pre>` : ''}
          </article>
        `,
        )
        .join('');
    } catch (err) {
      root.innerHTML = `<div class="posts-empty">Failed: ${escape(err.message)}</div>`;
    }
  }

  function init() {
    load();
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.shortcodes = init;
})();
