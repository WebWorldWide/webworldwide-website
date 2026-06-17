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
  /** @type {any} */ let dictCache = null;

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
    // Spell-check config lives in its own store; degrade to defaults if the
    // proofreader endpoint isn't reachable (e.g. LanguageTool not deployed).
    try {
      dictCache = await window.TE.fetchJSON('/api/proofread/dictionary');
    } catch {
      dictCache = { language: 'en-US', words: [], supported: ['en-US'] };
    }
    // `hugo` is the parsed site.toml (the API field name is legacy).
    const hugo = cache.hugo || {};
    const site = hugo.site || {};
    const siteSocial = hugo.social || {};
    const author = cache.author || {};
    const social = author.social || {};

    root.innerHTML = `
      <section class="te-form-group" data-group="site">
        <h3>Site identity</h3>
        ${field('Title', 'site.title', site.title || '')}
        ${field('Description', 'site.description', site.description || '', 'textarea')}
        ${field('Base URL', 'site.url', site.url || '', 'url')}
        ${field('Copyright', 'site.copyright', site.copyright || '')}
        ${field('Tagline', 'site.tagline', site.tagline || '')}
      </section>
      <section class="te-form-group" data-group="analytics">
        <h3>Analytics</h3>
        ${field('Umami URL', 'analytics.url', (hugo.analytics && hugo.analytics.url) || '', 'url')}
        ${field('Umami site ID', 'analytics.site_id', (hugo.analytics && hugo.analytics.site_id) || '')}
        ${field('Remark42 URL', 'comments.url', (hugo.comments && hugo.comments.url) || '', 'url')}
        ${field('Remark42 site ID', 'comments.site_id', (hugo.comments && hugo.comments.site_id) || '')}
      </section>
      <section class="te-form-group" data-group="social">
        <h3>Site social</h3>
        ${field('YouTube URL', 'social.youtube', siteSocial.youtube || '', 'url')}
        ${field('YouTube handle', 'social.youtube_handle', siteSocial.youtube_handle || '')}
      </section>
      <section class="te-form-group" data-group="spellcheck">
        <h3>Spell check</h3>
        <label class="te-field"><span>Language</span>
          <select name="spell.language">
            ${((dictCache && dictCache.supported) || ['en-US'])
              .map(
                (l) =>
                  `<option value="${escape(l)}"${l === (dictCache && dictCache.language) ? ' selected' : ''}>${escape(l)}</option>`,
              )
              .join('')}
          </select>
        </label>
        ${field('Custom dictionary (one word per line)', 'spell.words', ((dictCache && dictCache.words) || []).join('\n'), 'textarea')}
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

  // Inline validation. URL/email fields are optional (empty is fine), but a
  // non-empty value must be well-formed — a typo'd analytics or comments URL
  // would silently break the live site otherwise.
  function setFieldError(input, msg) {
    const label = input.closest('.te-field');
    if (!label) return;
    let err = label.querySelector('.te-field-err');
    if (msg) {
      if (!err) {
        err = document.createElement('small');
        err.className = 'te-field-err';
        label.appendChild(err);
      }
      err.textContent = msg;
      input.setAttribute('aria-invalid', 'true');
    } else if (err) {
      err.remove();
      input.removeAttribute('aria-invalid');
    }
  }

  function validUrl(v) {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // Fields the site can't function without — the Astro build needs a title
  // and an absolute base URL, so refuse to save them blank.
  const REQUIRED = new Set(['site.title', 'site.url']);

  function validate() {
    const root = document.getElementById('settings-form');
    if (!root) return { ok: true };
    let firstBad = null;
    root.querySelectorAll('input').forEach((el) => {
      const input = /** @type {HTMLInputElement} */ (el);
      const v = input.value.trim();
      setFieldError(input, '');
      if (!v) {
        if (REQUIRED.has(input.getAttribute('name') || '')) {
          setFieldError(input, 'This field is required.');
          if (!firstBad) firstBad = input;
        }
        return; // other empty fields are optional
      }
      if (input.type === 'url' && !validUrl(v)) {
        setFieldError(input, 'Enter a full URL (https://…).');
        if (!firstBad) firstBad = input;
      } else if (input.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        setFieldError(input, 'Enter a valid email address.');
        if (!firstBad) firstBad = input;
      }
    });
    return { ok: !firstBad, firstBad };
  }

  function collect() {
    const root = document.getElementById('settings-form');
    if (!root) return { hugo: {}, author: {} };
    /** @type {Record<string, any>} */ const hugoChanges = {};
    /** @type {Record<string, any>} */ const author = { social: {} };
    /** @type {{ language?: string, words?: string[] }} */ const spell = {};
    root.querySelectorAll('input,textarea,select').forEach((el) => {
      const name = el.getAttribute('name') || '';
      const val = /** @type {HTMLInputElement} */ (el).value;
      if (name === 'spell.language') {
        spell.language = val;
      } else if (name === 'spell.words') {
        spell.words = val.split('\n');
      } else if (!name.startsWith('author.')) {
        // Dotted site.toml path ("site.title", "analytics.site_id", …) —
        // the backend's flatToChanges maps it straight onto the file.
        hugoChanges[name] = val;
      } else if (name === 'author.name') author.name = val;
      else if (name === 'author.bio') author.bio = val;
      else if (name === 'author.avatar') author.avatar = val;
      else if (name === 'author.url') author.url = val;
      else if (name.startsWith('author.social.')) {
        author.social[name.slice('author.social.'.length)] = val;
      }
    });
    return { hugoChanges, author, spell };
  }

  async function save() {
    const v = validate();
    if (!v.ok) {
      window.TE.toast('Fix the highlighted fields before saving.', 'warn');
      if (v.firstBad) v.firstBad.focus();
      return;
    }
    const btn = document.getElementById('btn-save-settings');
    if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = true;
    try {
      const { hugoChanges, author, spell } = collect();
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
      // Persist spell-check config (best-effort: only when the endpoint
      // loaded, so a missing proofreader doesn't fail the whole save).
      if (dictCache && spell && (spell.language || spell.words)) {
        await window.TE.fetchJSON('/api/proofread/dictionary', {
          method: 'PUT',
          body: JSON.stringify({
            language: spell.language || dictCache.language,
            words: spell.words || dictCache.words || [],
          }),
        });
      }
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
