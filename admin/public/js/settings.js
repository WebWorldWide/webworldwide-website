// @ts-check
/**
 * settings.js — /#settings page wiring.
 *
 * Loads GET /api/settings, renders a grouped form (Site / Social /
 * Analytics / Author), patches back on Save. Hugo-toml fields go to
 * PATCH /api/settings/hugo as a flat `{ "params.umamiSiteID": "..." }`
 * change-map; author fields go to PATCH /api/settings/author.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  /** @type {any} */ let cache = null;

  function escape(s) {
    return (window.TE && window.TE.escape ? window.TE.escape : (x) => String(x || ''))(s);
  }

  function field(label, name, value, type) {
    const t = type || 'text';
    const v = escape(value);
    if (t === 'textarea') {
      return `<label class="te-field"><span>${escape(label)}</span><textarea name="${escape(name)}" rows="3">${v}</textarea></label>`;
    }
    return `<label class="te-field"><span>${escape(label)}</span><input type="${t}" name="${escape(name)}" value="${v}" /></label>`;
  }

  async function render() {
    const root = document.getElementById('settings-form');
    if (!root) return;
    try {
      cache = await window.TE.fetchJSON('/api/settings');
    } catch (err) {
      root.innerHTML = `<div class="posts-empty">Failed to load settings: ${escape(err.message)}</div>`;
      return;
    }
    const hugo = cache.hugo || {};
    const params = hugo.params || {};
    const author = cache.author || {};
    const social = author.social || {};

    root.innerHTML = `
      <section class="te-form-group" data-group="site">
        <h3>Site identity</h3>
        ${field('Title', 'site.title', hugo.title || '')}
        ${field('Description', 'site.description', hugo.description || '', 'textarea')}
        ${field('Base URL', 'site.baseURL', hugo.baseURL || '', 'url')}
        ${field('Copyright', 'site.copyright', hugo.copyright || '')}
        ${field('Tagline', 'params.tagline', params.tagline || '')}
      </section>
      <section class="te-form-group" data-group="analytics">
        <h3>Analytics</h3>
        ${field('Umami URL', 'params.umamiURL', params.umamiURL || '', 'url')}
        ${field('Umami site ID', 'params.umamiSiteID', params.umamiSiteID || '')}
        ${field('Remark42 URL', 'params.remark42URL', params.remark42URL || '', 'url')}
        ${field('Remark42 site ID', 'params.remark42SiteID', params.remark42SiteID || '')}
      </section>
      <section class="te-form-group" data-group="social">
        <h3>Site social</h3>
        ${field('YouTube URL', 'params.youtubeURL', params.youtubeURL || '', 'url')}
        ${field('RSS URL', 'params.rssURL', params.rssURL || '')}
      </section>
      <section class="te-form-group" data-group="author">
        <h3>Author profile</h3>
        ${field('Name', 'author.name', author.name || '')}
        ${field('Bio', 'author.bio', author.bio || '', 'textarea')}
        ${field('Avatar URL', 'author.avatar', author.avatar || '', 'url')}
        ${field('Homepage', 'author.url', author.url || '', 'url')}
        ${field('Bluesky', 'author.social.bluesky', social.bluesky || '', 'url')}
        ${field('Mastodon', 'author.social.mastodon', social.mastodon || '', 'url')}
        ${field('GitHub', 'author.social.github', social.github || '', 'url')}
        ${field('YouTube', 'author.social.youtube', social.youtube || '', 'url')}
        ${field('Email', 'author.social.email', social.email || '', 'email')}
      </section>
    `;
  }

  function collect() {
    const root = document.getElementById('settings-form');
    if (!root) return { hugo: {}, author: {} };
    /** @type {Record<string, any>} */ const hugoChanges = {};
    /** @type {Record<string, any>} */ const author = { social: {} };
    root.querySelectorAll('input,textarea').forEach((el) => {
      const name = el.getAttribute('name') || '';
      const val = /** @type {HTMLInputElement} */ (el).value;
      if (name.startsWith('site.')) {
        // Top-level hugo.toml key (title, baseURL, etc.)
        hugoChanges[name.slice('site.'.length)] = val;
      } else if (name.startsWith('params.')) {
        hugoChanges[name] = val;
      } else if (name === 'author.name') author.name = val;
      else if (name === 'author.bio') author.bio = val;
      else if (name === 'author.avatar') author.avatar = val;
      else if (name === 'author.url') author.url = val;
      else if (name.startsWith('author.social.')) {
        author.social[name.slice('author.social.'.length)] = val;
      }
    });
    return { hugoChanges, author };
  }

  async function save() {
    const btn = document.getElementById('btn-save-settings');
    if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = true;
    try {
      const { hugoChanges, author } = collect();
      if (Object.keys(hugoChanges).length) {
        await window.TE.fetchJSON('/api/settings/hugo', {
          method: 'PATCH',
          body: JSON.stringify({ changes: hugoChanges }),
        });
      }
      await window.TE.fetchJSON('/api/settings/author', {
        method: 'PATCH',
        body: JSON.stringify(author),
      });
      window.TE.toast('Settings saved.');
      cache = null;
      render();
    } catch (err) {
      window.TE.toast(err.message || 'Save failed.', 'error');
    } finally {
      if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = false;
    }
  }

  function init() {
    render();
    const btn = document.getElementById('btn-save-settings');
    if (btn) btn.addEventListener('click', save);
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.settings = init;
})();
